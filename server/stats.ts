import fs from "node:fs/promises";
import path from "node:path";
import {
  DAILY_HISTORY_DAYS,
  UNATTRIBUTED_ACCOUNT_ID,
  accountIdSchema,
  type StatsRange,
  type StatsScope,
  type UsageDaily,
  type UsageStats,
  type UsageTotals,
} from "../shared/contracts";
import {
  estimateRequestCost,
  resolveEffectiveRates,
  resolvePricingKey,
  type ModelRates,
} from "../shared/pricing";
import { REAL_CLI_DIR, SHARED_CLI_DIRS, dataDir } from "./paths";
import { decode, int, message, seconds, text } from "./protobuf";

/**
 * Aggregates model calls from agy's conversation databases. Each generation record
 * (`gen_metadata`) carries usage (1.4: 2 input, 3 output, 5 cache reads, 7 response id),
 * time to first token (1.11) and streaming time (1.12) as Durations, the model id (1.19),
 * and the display label (1.21). The step that issued the call (`steps.metadata`,
 * 9.7 = response id) carries its start time (1).
 */

interface Generation {
  responseId: string | null;
  modelId: string | null;
  label: string;
  pricingKey: string;
  input: number;
  cached: number;
  output: number;
  firstToken: number;
  generation: number;
}

interface CallRecord extends Generation {
  at: number;
  conversationId: string;
  isSubagent: boolean;
  accountId: string | null;
}

interface FileCache {
  conversationId: string;
  signature: string;
  lastGenIndex: number;
  generations: Generation[];
  started: Map<string, number>;
  fallback: number;
}

interface BinWindow {
  start: number;
  end: number;
}

const RANGES: Record<StatsRange, { binMs: number; bins: number }> = {
  "24h": { binMs: 3_600_000, bins: 24 },
  "7d": { binMs: 6 * 3_600_000, bins: 28 },
  "30d": { binMs: 86_400_000, bins: 30 },
};

const SUBAGENT_MARKER = /sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const attributionFile = () => path.join(dataDir(), "conversation-turn-accounts.json");

interface TurnAccount {
  startedAt: number;
  endedAt: number;
  accountId: string;
}

function isTurnAccount(value: unknown): value is TurnAccount {
  if (typeof value !== "object" || value === null) return false;
  const { startedAt, endedAt, accountId } = value as Partial<TurnAccount>;
  return typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0 &&
    typeof endedAt === "number" && Number.isFinite(endedAt) && endedAt >= startedAt &&
    accountIdSchema.safeParse(accountId).success;
}

/** Allows for slight IPC dispatch delay on `agent.turn.before` (`waits: false`) vs SQLite step timestamps. */
const TURN_START_SKEW_MS = 2000;

function accountForGeneration(turns: readonly TurnAccount[], startedAt: number): string | null {
  let exact: string | null = null;
  for (const turn of turns) {
    if (turn.startedAt > startedAt) break;
    if (turn.endedAt < startedAt) continue;
    if (exact !== null && exact !== turn.accountId) return null;
    exact = turn.accountId;
  }
  if (exact !== null) return exact;
  let skewed: string | null = null;
  for (const turn of turns) {
    if (turn.startedAt - TURN_START_SKEW_MS > startedAt) break;
    if (turn.endedAt < startedAt) continue;
    if (skewed !== null && skewed !== turn.accountId) return null;
    skewed = turn.accountId;
  }
  return skewed;
}

type SqliteModule = typeof import("node:sqlite");
let sqlite: Promise<SqliteModule | null> | null = null;

function loadSqlite(): Promise<SqliteModule | null> {
  sqlite ??= import("node:sqlite").catch(() => null);
  return sqlite;
}

function parseGeneration(data: Uint8Array): Generation | null {
  const root = decode(data);
  const request = message(root, [1]);
  const usage = message(request, [4]);
  if (!usage) return null;
  const input = int(usage, 2);
  const output = int(usage, 3);
  const cached = int(usage, 5);
  if (input + output + cached === 0) return null;
  const modelId = text(request, 19)?.trim() || text(message(root, [3]), 28)?.trim() || null;
  const rawLabel =
    text(request, 21) ?? text(message(root, [3]), 28) ?? text(request, 19) ?? "Unknown model";
  const label = rawLabel.trim() || "Unknown model";
  return {
    responseId: text(usage, 7),
    modelId,
    label,
    pricingKey: resolvePricingKey(modelId, label),
    input,
    cached,
    output,
    firstToken: seconds(message(request, [11])),
    generation: seconds(message(request, [12])),
  };
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    input: 0,
    cached: 0,
    output: 0,
    generationSeconds: 0,
    firstTokenSeconds: 0,
    cost: 0,
    pricedRequests: 0,
  };
}

function add(totals: UsageTotals, record: CallRecord, requestCost: number | null): void {
  totals.requests += 1;
  totals.input += record.input;
  totals.cached += record.cached;
  totals.output += record.output;
  totals.generationSeconds += record.generation;
  totals.firstTokenSeconds += record.firstToken;
  if (requestCost !== null) {
    totals.cost += requestCost;
    totals.pricedRequests += 1;
  }
}

/**
 * Builds local-calendar-aligned bins so daylight-saving transitions never shift midnight/6-hour
 * boundaries to 01:00 or 23:00 (which otherwise breaks day labels and hides X-axis ticks).
 */
export function buildCalendarBins(now: number, range: StatsRange): BinWindow[] {
  const { binMs, bins: count } = RANGES[range];
  const anchor = new Date(now);
  if (range === "30d") {
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    const day = anchor.getDate();
    return Array.from({ length: count }, (_, index) => {
      const offset = index - (count - 1);
      const start = new Date(year, month, day + offset, 0, 0, 0, 0).getTime();
      const end = new Date(year, month, day + offset + 1, 0, 0, 0, 0).getTime();
      return { start, end };
    });
  }
  if (range === "7d") {
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    const day = anchor.getDate();
    const slot = Math.floor(anchor.getHours() / 6);
    const currentIndex = day * 4 + slot;
    return Array.from({ length: count }, (_, index) => {
      const target = currentIndex - (count - 1 - index);
      const targetDay = Math.floor(target / 4);
      const targetSlot = ((target % 4) + 4) % 4;
      const next = target + 1;
      const nextDay = Math.floor(next / 4);
      const nextSlot = ((next % 4) + 4) % 4;
      const start = new Date(year, month, targetDay, targetSlot * 6, 0, 0, 0).getTime();
      const end = new Date(year, month, nextDay, nextSlot * 6, 0, 0, 0).getTime();
      return { start, end };
    });
  }
  // 24h: walk back 24 real hours from the current hour start so spring/fall DST hours stay monotonic.
  const currentHour = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), anchor.getHours(), 0, 0, 0).getTime();
  return Array.from({ length: count }, (_, index) => {
    const start = currentHour - (count - 1 - index) * binMs;
    return { start, end: start + binMs };
  });
}

/** "2026-11-23" in the daemon's local calendar. */
function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function findBinIndex(bins: readonly BinWindow[], at: number): number {
  let lo = 0;
  let hi = bins.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bin = bins[mid]!;
    if (at < bin.start) hi = mid - 1;
    else if (at >= bin.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Reads the first 4 KB of a conversation's transcript to find its parent conversation id when it is a subagent. */
async function detectParentConversation(conversationId: string): Promise<string | null> {
  const file = path.join(REAL_CLI_DIR, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) return null;
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const firstLine = head.split("\n", 1)[0] ?? "";
    return SUBAGENT_MARKER.exec(firstLine)?.[1] ?? null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface StatsFilter {
  range: StatsRange;
  scope?: StatsScope;
  accountId?: string;
  model?: string;
}

export class UsageStatsReader {
  private readonly files = new Map<string, FileCache>();
  private readonly parentConversations = new Map<string, string | null>();
  private readonly turnAccounts = new Map<string, TurnAccount[]>();
  private readonly liveTurns = new Map<string, { conversationId: string; accountId: string; startedAt: number }>();
  private running: Promise<CallRecord[]> | null = null;
  private loadedAttribution: Promise<void> | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private saveSeq = 0;
  private closing = false;
  private writing: Promise<void> = Promise.resolve();

  private loadAttribution(): Promise<void> {
    this.loadedAttribution ??= (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(attributionFile(), "utf8")) as Record<string, unknown>;
        const cutoff = Date.now() - DAILY_HISTORY_DAYS * 86_400_000;
        for (const [conversationId, value] of Object.entries(raw)) {
          if (!Array.isArray(value)) continue;
          const turns = value.filter(isTurnAccount).filter((turn) => turn.endedAt >= cutoff);
          if (turns.length) this.turnAccounts.set(conversationId, turns.sort((a, b) => a.startedAt - b.startedAt));
        }
      } catch {
        // No usable per-turn attribution yet. The legacy per-conversation file is kept separately.
      }
    })();
    return this.loadedAttribution;
  }

  /** Tracks an in-progress turn in memory so live usage attributes to its account immediately. */
  beginConversationTurn(agentId: string, conversationId: string, accountId: string, startedAt: number): void {
    if (this.closing || !accountIdSchema.safeParse(accountId).success) return;
    if (!Number.isFinite(startedAt) || startedAt <= 0) return;
    this.liveTurns.set(agentId, { conversationId, accountId, startedAt });
  }

  endConversationTurn(agentId: string): void {
    this.liveTurns.delete(agentId);
  }

  /** Record the observed time bounds instead of assigning a conversation's history to its last account. */
  async recordConversationTurn(conversationId: string, accountId: string, startedAt: number, endedAt: number): Promise<void> {
    const turn = { accountId, startedAt, endedAt };
    if (!isTurnAccount(turn)) return;
    await this.loadAttribution();
    if (this.closing) return;
    const turns = this.turnAccounts.get(conversationId) ?? [];
    const cutoff = Date.now() - DAILY_HISTORY_DAYS * 86_400_000;
    const current = turns.filter((entry) => entry.endedAt >= cutoff);
    if (!current.some((entry) => entry.startedAt === startedAt && entry.endedAt === endedAt && entry.accountId === accountId)) {
      current.push(turn);
      current.sort((a, b) => a.startedAt - b.startedAt);
    }
    this.turnAccounts.set(conversationId, current);
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.saveAttribution(), 2000);
  }

  private saveAttribution(): void {
    clearTimeout(this.saveTimer ?? undefined);
    this.saveTimer = null;
    const body = JSON.stringify(Object.fromEntries(this.turnAccounts));
    const file = attributionFile();
    const temp = `${file}.${process.pid}.${Date.now()}.${++this.saveSeq}.tmp`;
    this.writing = this.writing
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(temp, body, { mode: 0o600 });
        await fs.rename(temp, file);
      })
      .catch(async (error: unknown) => {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        console.error("antigravity-accounts: could not save conversation attribution", error);
      });
  }

  private async parentOf(conversationId: string): Promise<string | null> {
    if (this.parentConversations.has(conversationId)) {
      return this.parentConversations.get(conversationId) ?? null;
    }
    const parent = await detectParentConversation(conversationId);
    this.parentConversations.set(conversationId, parent);
    return parent;
  }

  private combinedTurns(conversationId: string, now: number): TurnAccount[] {
    const persisted = this.turnAccounts.get(conversationId) ?? [];
    const active: TurnAccount[] = [];
    for (const live of this.liveTurns.values()) {
      if (live.conversationId === conversationId) {
        active.push({ accountId: live.accountId, startedAt: live.startedAt, endedAt: Math.max(live.startedAt, now + 60_000) });
      }
    }
    if (!active.length) return persisted;
    return [...persisted, ...active].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Finds observed turn bounds for a conversation, walking up subagent senders to the root conversation. */
  private async turnsForConversation(conversationId: string, now = Date.now()): Promise<readonly TurnAccount[]> {
    const own = this.combinedTurns(conversationId, now);
    if (own.length) return own;
    const visited = new Set<string>([conversationId]);
    let current = await this.parentOf(conversationId);
    for (let depth = 0; depth < 5 && current && !visited.has(current); depth += 1) {
      visited.add(current);
      const turns = this.combinedTurns(current, now);
      if (turns.length) return turns;
      current = await this.parentOf(current);
    }
    return [];
  }

  private async readFile(
    file: string,
    conversationId: string,
    signature: string,
    birth: number,
  ): Promise<FileCache | null> {
    const module = await loadSqlite();
    if (!module) return null;
    const previous = this.files.get(file);
    // Work on a copy so a mid-read error (e.g. SQLITE_BUSY on `steps`) never corrupts `previous`.
    const nextGenerations = previous ? [...previous.generations] : [];
    let nextLastGenIndex = previous ? previous.lastGenIndex : -1;
    let db: InstanceType<SqliteModule["DatabaseSync"]> | null = null;
    try {
      db = new module.DatabaseSync(file, { timeout: 1000 });
      db.exec("PRAGMA query_only = ON");
      // Generation records are written once per call, so only new rows need reading.
      const rows = db
        .prepare("SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx")
        .all(nextLastGenIndex) as Array<{ idx: number; data: Uint8Array | null }>;
      for (const row of rows) {
        nextLastGenIndex = Math.max(nextLastGenIndex, row.idx);
        if (!row.data) continue;
        const generation = parseGeneration(new Uint8Array(row.data));
        if (generation) nextGenerations.push(generation);
      }
      // Steps change state while they run; their metadata is small, so re-read it all.
      const steps = db.prepare("SELECT metadata FROM steps WHERE metadata IS NOT NULL").all() as Array<{
        metadata: Uint8Array | null;
      }>;
      const started = new Map<string, number>();
      for (const step of steps) {
        const meta = decode(step.metadata ? new Uint8Array(step.metadata) : null);
        const responseId = text(message(meta, [9]), 7);
        if (!responseId) continue;
        const at = seconds(message(meta, [1]));
        if (at > 0) started.set(responseId, at * 1000);
      }
      const next: FileCache = {
        conversationId,
        signature,
        lastGenIndex: nextLastGenIndex,
        generations: nextGenerations,
        started,
        fallback: previous?.fallback ?? birth,
      };
      this.files.set(file, next);
      return next;
    } catch (error) {
      console.error(`antigravity-accounts: could not read usage from ${path.basename(file)}`, error);
      return previous ?? null;
    } finally {
      try {
        db?.close();
      } catch {
        // Already closed.
      }
    }
  }

  private async collect(): Promise<CallRecord[]> {
    await this.loadAttribution();
    const dir = path.join(REAL_CLI_DIR, SHARED_CLI_DIRS[0]);
    let names: string[] = [];
    try {
      names = (await fs.readdir(dir)).filter((name) => /^[0-9a-f-]{36}\.db$/i.test(name));
    } catch {
      return [];
    }
    const records: CallRecord[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const conversationId = name.slice(0, -3);
      const file = path.join(dir, name);
      seen.add(file);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) continue;
      const wal = await fs.stat(`${file}-wal`).catch(() => null);
      const signature = `${stat.mtimeMs}:${stat.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`;
      let cache = this.files.get(file);
      if (!cache || cache.signature !== signature) {
        cache = (await this.readFile(file, conversationId, signature, stat.birthtimeMs || stat.mtimeMs)) ?? undefined;
      }
      if (!cache) continue;
      const parentId = await this.parentOf(conversationId);
      const isSubagent = parentId !== null;
      const turns = await this.turnsForConversation(conversationId);
      // Earliest step timestamp for a subagent (when its parent spawned it), used when an async
      // subagent call finishes after its parent's turn ended while still running in the same process.
      let subagentSpawnAt: number | undefined;
      if (isSubagent && cache.started.size > 0) {
        let earliest = Infinity;
        for (const ts of cache.started.values()) {
          if (ts < earliest) earliest = ts;
        }
        if (Number.isFinite(earliest)) subagentSpawnAt = earliest;
      }
      // Estimate a missing timestamp for overall totals only. Account attribution requires an actual timestamp.
      let last = cache.fallback;
      for (const generation of cache.generations) {
        const startedAt = generation.responseId ? cache.started.get(generation.responseId) : undefined;
        const at = startedAt ?? last;
        last = at;
        const accountId =
          startedAt === undefined
            ? null
            : (accountForGeneration(turns, startedAt) ??
              (isSubagent && subagentSpawnAt !== undefined ? accountForGeneration(turns, subagentSpawnAt) : null));
        records.push({ ...generation, at, conversationId, isSubagent, accountId });
      }
    }
    for (const file of this.files.keys()) {
      if (!seen.has(file)) {
        const removed = this.files.get(file);
        if (removed) this.parentConversations.delete(removed.conversationId);
        this.files.delete(file);
      }
    }
    return records;
  }

  private records(): Promise<CallRecord[]> {
    // Concurrent requests share one scan.
    this.running ??= this.collect().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Map of pricingKey → display label for models observed in local conversation databases. */
  async seenPricingModels(): Promise<Map<string, string>> {
    const records = await this.records();
    const seen = new Map<string, string>();
    for (const record of records) {
      if (!seen.has(record.pricingKey)) {
        seen.set(record.pricingKey, record.label.replace(/\s*\([^()]+\)\s*$/, "").trim() || record.label);
      }
    }
    return seen;
  }

  async summary(
    filter: StatsFilter,
    labelOf: (accountId: string) => string = (id) => id,
    customPricing: Readonly<Record<string, ModelRates>> = {},
  ): Promise<UsageStats> {
    const { range, scope = "all", accountId, model } = filter;
    const { binMs } = RANGES[range];
    const now = Date.now();
    const windows = buildCalendarBins(now, range);
    const firstStart = windows[0]!.start;
    const lastEnd = Math.max(windows[windows.length - 1]!.end, now + 60_000);
    const bins = windows.map((window) => ({ start: window.start, end: window.end, ...emptyTotals() }));
    const totals = emptyTotals();
    const breakdown = { main: emptyTotals(), subagent: emptyTotals() };
    const models = new Map<string, { totals: UsageTotals; pricingKey: string }>();
    const accounts = new Map<string, { totals: UsageTotals; conversations: Set<string> }>();
    const conversationSet = new Set<string>();

    const records = await this.records();
    for (const record of records) {
      if (record.at < firstStart || record.at > lastEnd) continue;

      // Estimate this request's API cost using its exact token counts, prompt tier, and timestamp.
      const rates = resolveEffectiveRates(record.pricingKey, record.at, customPricing);
      const cost = rates ? estimateRequestCost(record, rates) : null;

      // Track per-account totals across the time range (before account/model filters so selectors stay complete).
      if (scope === "all" || (scope === "subagent") === record.isSubagent) {
        const bucketId = record.accountId ?? UNATTRIBUTED_ACCOUNT_ID;
        let entry = accounts.get(bucketId);
        if (!entry) {
          entry = { totals: emptyTotals(), conversations: new Set() };
          accounts.set(bucketId, entry);
        }
        add(entry.totals, record, cost);
        entry.conversations.add(record.conversationId);
      }

      if (accountId) {
        const matchesAccount =
          accountId === UNATTRIBUTED_ACCOUNT_ID ? record.accountId === null : record.accountId === accountId;
        if (!matchesAccount) continue;
      }

      // Track main vs subagent split within the selected range & account.
      add(record.isSubagent ? breakdown.subagent : breakdown.main, record, cost);

      if (scope === "main" && record.isSubagent) continue;
      if (scope === "subagent" && !record.isSubagent) continue;

      // Keep full per-model table within range/account/scope so clicking a model row can toggle filtering.
      let modelEntry = models.get(record.label);
      if (!modelEntry) {
        modelEntry = { totals: emptyTotals(), pricingKey: record.pricingKey };
        models.set(record.label, modelEntry);
      }
      add(modelEntry.totals, record, cost);

      if (model && record.label !== model) continue;

      const index = findBinIndex(windows, record.at);
      if (index >= 0) add(bins[index]!, record, cost);
      else if (record.at >= windows[windows.length - 1]!.start) add(bins[bins.length - 1]!, record, cost);
      add(totals, record, cost);
      conversationSet.add(record.conversationId);
    }

    return {
      range,
      binMs,
      bins,
      totals,
      breakdown,
      models: [...models.entries()]
        .map(([label, entry]) => ({ label, pricingKey: entry.pricingKey, ...entry.totals }))
        .sort((left, right) => right.requests - left.requests),
      accounts: [...accounts.entries()]
        .map(([id, value]) => ({
          accountId: id,
          label: id === UNATTRIBUTED_ACCOUNT_ID ? UNATTRIBUTED_ACCOUNT_ID : labelOf(id),
          conversations: value.conversations.size,
          ...value.totals,
        }))
        .sort((left, right) => {
          if (left.accountId === UNATTRIBUTED_ACCOUNT_ID) return 1;
          if (right.accountId === UNATTRIBUTED_ACCOUNT_ID) return -1;
          return right.requests - left.requests;
        }),
      conversations: conversationSet.size,
      hasCustomPricing: Object.keys(customPricing).length > 0,
      generatedAt: new Date(now).toISOString(),
    };
  }

  /** Per-day totals over the last DAILY_HISTORY_DAYS local days, for the activity calendar. */
  async daily(
    filter: Omit<StatsFilter, "range">,
    customPricing: Readonly<Record<string, ModelRates>> = {},
  ): Promise<UsageDaily> {
    const { scope = "all", accountId, model } = filter;
    const now = Date.now();
    const anchor = new Date(now);
    const firstStart = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() - (DAILY_HISTORY_DAYS - 1),
    ).getTime();
    const tomorrowStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 1).getTime();
    // The same upper bound summary() uses for its daily range, so both views count the same calls.
    const lastEnd = Math.max(tomorrowStart, now + 60_000);
    const days = new Map<string, UsageTotals>();

    for (const record of await this.records()) {
      if (record.at < firstStart || record.at > lastEnd) continue;
      if (accountId) {
        const matchesAccount =
          accountId === UNATTRIBUTED_ACCOUNT_ID ? record.accountId === null : record.accountId === accountId;
        if (!matchesAccount) continue;
      }
      if (scope === "main" && record.isSubagent) continue;
      if (scope === "subagent" && !record.isSubagent) continue;
      if (model && record.label !== model) continue;
      const rates = resolveEffectiveRates(record.pricingKey, record.at, customPricing);
      const cost = rates ? estimateRequestCost(record, rates) : null;
      // A call stamped a little ahead of the clock still belongs to today.
      const key = dayKey(Math.min(record.at, tomorrowStart - 1));
      let totals = days.get(key);
      if (!totals) {
        totals = emptyTotals();
        days.set(key, totals);
      }
      add(totals, record, cost);
    }

    return {
      today: dayKey(now),
      days: [...days.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([date, totals]) => ({ date, ...totals })),
      generatedAt: new Date(now).toISOString(),
    };
  }

  async dispose(): Promise<void> {
    this.closing = true;
    const now = Date.now();
    let flushedLive = false;
    if (this.liveTurns.size > 0) {
      await this.loadAttribution();
      const cutoff = now - DAILY_HISTORY_DAYS * 86_400_000;
      for (const live of this.liveTurns.values()) {
        const turn = { accountId: live.accountId, startedAt: live.startedAt, endedAt: Math.max(live.startedAt, now) };
        if (!isTurnAccount(turn)) continue;
        const current = (this.turnAccounts.get(live.conversationId) ?? []).filter((entry) => entry.endedAt >= cutoff);
        current.push(turn);
        current.sort((a, b) => a.startedAt - b.startedAt);
        this.turnAccounts.set(live.conversationId, current);
        flushedLive = true;
      }
      this.liveTurns.clear();
    }
    if (this.saveTimer || flushedLive) this.saveAttribution();
    await this.writing;
  }
}
