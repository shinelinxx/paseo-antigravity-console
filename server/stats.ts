import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  DAILY_HISTORY_DAYS,
  accountIdSchema,
  isAntigravityProvider,
  type StatsRange,
  type StatsScope,
  type TopConversation,
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
import { conversationIdFrom, openSqliteReadOnly, readStepTimestamps } from "./context";
import { REAL_CLI_DIR, SHARED_CLI_DIRS, dataDir } from "./paths";
import { decode, int, message, seconds, text } from "./protobuf";
import { readTranscriptHead } from "./transcriptHead";
import type { PaseoApi } from "./types";

/**
 * Aggregates model calls from agy's conversation databases. Each generation record
 * (`gen_metadata`) carries usage (1.4: 2 input, 3 output, 5 cache reads, 7 response id),
 * time to first token (1.11) and streaming time (1.12) as Durations, the model id (1.19),
 * and the display label (1.21). The step that issued the call (`steps.metadata`,
 * 9.7 = response id) carries its start time (1).
 *
 * Unattributed records (without a verified step timestamp or attributed account) are strictly
 * excluded from totals, charts, breakdowns, and leaderboards.
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
  source: Generation;
  at: number;
  conversationId: string;
  isSubagent: boolean;
  accountId: string;
}

interface FileCache {
  ino: number;
  size: number;
  conversationId: string;
  signature: string;
  lastGenIndex: number;
  generations: Generation[];
  started: Map<string, number>;
  subagentSpawnAt: number | undefined;
  fallback: number;
}

interface TranscriptHeadCache {
  ino: number;
  size: number;
  mtimeMs: number;
  complete: boolean;
  isSubagent: boolean;
  sender: string | null;
}

const COLLECT_CACHE_TTL_MS = 5000;
const STAT_CONCURRENCY = 16;

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
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

const turnAttributionFile = () => path.join(dataDir(), "conversation-turn-accounts.json");
const spanAttributionFile = () => path.join(dataDir(), "conversation-accounts.json");

interface TurnAccount {
  startedAt: number;
  endedAt: number;
  accountId: string;
}

interface AccountSpan {
  accountId: string;
  since: number;
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

function accountForSpan(spans: readonly AccountSpan[], at: number): string | null {
  let chosen: string | null = null;
  for (const span of spans) {
    if (span.since <= at) chosen = span.accountId;
    else break;
  }
  return chosen || null;
}

type SqliteModule = typeof import("node:sqlite");
let sqlite: Promise<SqliteModule | null> | null = null;

function loadSqlite(): Promise<SqliteModule | null> {
  sqlite ??= import("node:sqlite").catch(() => null);
  return sqlite;
}

export interface ConversationMeta {
  title: string | null;
  workspaceName: string | null;
  parentId: string | null;
}

interface SummariesCache {
  signature: string;
  fullLoaded: boolean;
  entries: Map<string, ConversationMeta>;
}

let summariesCache: SummariesCache | null = null;
let summariesBackoffUntil = 0;

function parseWorkspaceName(rawUris: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawUris);
    const first = Array.isArray(parsed)
      ? parsed.find((item): item is string => typeof item === "string" && item.length > 0)
      : null;
    if (!first) return null;
    const decoded = decodeURIComponent(first.replace(/^file:\/\//i, "")).replace(/\/+$/, "");
    const base = path.basename(decoded);
    return base || null;
  } catch {
    return null;
  }
}

/**
 * Reads conversation titles & workspace names from agy's `conversation_summaries.db`.
 * Detects available columns dynamically (degrading gracefully if optional columns are missing),
 * queries only requested IDs when provided, uses read-only connections first, and backs off on SQLITE_BUSY.
 */
export async function readConversationMeta(
  ids?: Iterable<string>,
): Promise<ReadonlyMap<string, ConversationMeta>> {
  const requested = ids ? [...new Set(ids)].filter(Boolean) : null;
  if (requested && requested.length === 0) return new Map();

  const file = path.join(REAL_CLI_DIR, "conversation_summaries.db");
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return new Map();
  const wal = await fs.stat(`${file}-wal`).catch(() => null);
  const signature = `${stat.ino}:${stat.mtimeMs}:${stat.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`;

  if (summariesCache && summariesCache.signature === signature) {
    if (!requested && summariesCache.fullLoaded) return summariesCache.entries;
    if (requested && requested.every((id) => summariesCache!.entries.has(id))) {
      return summariesCache.entries;
    }
  } else {
    summariesCache = { signature, fullLoaded: false, entries: new Map() };
  }

  if (Date.now() < summariesBackoffUntil) {
    return summariesCache.entries;
  }

  const module = await loadSqlite();
  if (!module) return summariesCache.entries;
  let db: InstanceType<SqliteModule["DatabaseSync"]> | null = null;
  try {
    db = openSqliteReadOnly(module, file);
    const colRows = db.prepare("PRAGMA table_info(conversation_summaries)").all() as Array<{ name?: unknown }>;
    const cols = new Set(colRows.map((c) => (typeof c.name === "string" ? c.name : "")));
    if (!cols.has("conversation_id")) return summariesCache.entries;

    const selectCols = ["conversation_id"];
    if (cols.has("title")) selectCols.push("title");
    if (cols.has("workspace_uris")) selectCols.push("workspace_uris");
    if (cols.has("parent_conversation_id")) selectCols.push("parent_conversation_id");

    const rows: Array<{
      conversation_id?: unknown;
      title?: unknown;
      workspace_uris?: unknown;
      parent_conversation_id?: unknown;
    }> = [];

    if (requested) {
      const missing = requested.filter((id) => !summariesCache!.entries.has(id));
      for (let i = 0; i < missing.length; i += 200) {
        const batch = missing.slice(i, i + 200);
        const placeholders = batch.map(() => "?").join(", ");
        const found = db
          .prepare(`SELECT ${selectCols.join(", ")} FROM conversation_summaries WHERE conversation_id IN (${placeholders})`)
          .all(...batch) as typeof rows;
        rows.push(...found);
        for (const id of batch) {
          if (!summariesCache.entries.has(id)) {
            summariesCache.entries.set(id, { title: null, workspaceName: null, parentId: null });
          }
        }
      }
    } else {
      const allRows = db.prepare(`SELECT ${selectCols.join(", ")} FROM conversation_summaries`).all() as typeof rows;
      rows.push(...allRows);
      summariesCache.fullLoaded = true;
    }

    for (const row of rows) {
      if (typeof row.conversation_id !== "string" || !row.conversation_id) continue;
      const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : null;
      const workspaceName = typeof row.workspace_uris === "string" ? parseWorkspaceName(row.workspace_uris) : null;
      const parentId =
        typeof row.parent_conversation_id === "string" && row.parent_conversation_id.trim()
          ? row.parent_conversation_id.trim()
          : null;
      summariesCache.entries.set(row.conversation_id, { title, workspaceName, parentId });
    }
    return summariesCache.entries;
  } catch {
    summariesBackoffUntil = Date.now() + 10_000;
    return summariesCache.entries;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
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

export interface StatsFilter {
  range: StatsRange;
  scope?: StatsScope;
  accountId?: string;
  model?: string;
}

export class UsageStatsReader {
  private readonly files = new Map<string, FileCache>();
  private readonly transcriptHeads = new Map<string, TranscriptHeadCache>();
  private readonly costs = new WeakMap<Generation, { signature: string; at: number; cost: number | null }>();
  private readonly turnAccounts = new Map<string, TurnAccount[]>();
  private readonly liveTurns = new Map<string, { conversationId: string; accountId: string; startedAt: number }>();
  /** Raw timestamped account observations (upstream v0.3.0 attribution), compacted outside the reorder window. */
  private readonly conversationAccounts = new Map<string, { spans: AccountSpan[]; watermark: number }>();
  private running: Promise<CallRecord[]> | null = null;
  private cachedRecords: { at: number; records: CallRecord[] } | null = null;
  private cacheVersion = 0;
  private loadedTurnAttribution: Promise<void> | null = null;
  private loadedSpanAttribution = false;
  private saveTurnTimer: NodeJS.Timeout | null = null;
  private saveSpanTimer: NodeJS.Timeout | null = null;
  private saveSeq = 0;
  private saveSpanSeq = 0;
  private savingSpan = false;
  private closing = false;
  private writing: Promise<void> = Promise.resolve();

  private invalidateCache(): void {
    this.cacheVersion += 1;
    this.cachedRecords = null;
  }

  private loadTurnAttribution(): Promise<void> {
    this.loadedTurnAttribution ??= (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(turnAttributionFile(), "utf8")) as Record<string, unknown>;
        const cutoff = Date.now() - DAILY_HISTORY_DAYS * 86_400_000;
        for (const [conversationId, value] of Object.entries(raw)) {
          if (!Array.isArray(value)) continue;
          const turns = value.filter(isTurnAccount).filter((turn) => turn.endedAt >= cutoff);
          if (turns.length) this.turnAccounts.set(conversationId, turns.sort((a, b) => a.startedAt - b.startedAt));
        }
      } catch {
        // No usable per-turn attribution yet.
      }
    })();
    return this.loadedTurnAttribution;
  }

  private loadSpanAttribution(): void {
    if (this.loadedSpanAttribution) return;
    this.loadedSpanAttribution = true;
    try {
      const raw = JSON.parse(fsSync.readFileSync(spanAttributionFile(), "utf8")) as Record<string, unknown>;
      for (const [conversationId, value] of Object.entries(raw)) {
        if (typeof value === "string" && accountIdSchema.safeParse(value).success) {
          this.conversationAccounts.set(conversationId, { spans: [{ accountId: value, since: 0 }], watermark: -1 });
        } else {
          const history = value as { spans?: unknown; watermark?: unknown } | null;
          const entries = Array.isArray(value) ? value : history?.spans;
          if (!Array.isArray(entries)) continue;
          const watermark = history?.watermark;
          const spans = entries.filter((span): span is AccountSpan =>
            Boolean(span) &&
            typeof span.accountId === "string" &&
            ((span.accountId === "" && span.since === 0) || accountIdSchema.safeParse(span.accountId).success) &&
            Number.isFinite(span.since),
          );
          if (spans.length) {
            spans.sort((a, b) => a.since - b.since);
            this.conversationAccounts.set(conversationId, {
              spans,
              watermark: typeof watermark === "number" && Number.isFinite(watermark) ? watermark : -1,
            });
          }
        }
      }
    } catch {
      // No span attribution file yet.
    }
  }

  /** Tracks an in-progress turn in memory so live usage attributes to its account immediately. */
  beginConversationTurn(agentId: string, conversationId: string, accountId: string, startedAt: number): void {
    if (this.closing || !accountIdSchema.safeParse(accountId).success) return;
    if (!Number.isFinite(startedAt) || startedAt <= 0) return;
    this.liveTurns.set(agentId, { conversationId, accountId, startedAt });
    this.invalidateCache();
  }

  endConversationTurn(agentId: string): void {
    if (this.liveTurns.delete(agentId)) {
      this.invalidateCache();
    }
  }

  /** Record the observed time bounds instead of assigning a conversation's history to its last account. */
  async recordConversationTurn(conversationId: string, accountId: string, startedAt: number, endedAt: number): Promise<void> {
    const turn = { accountId, startedAt, endedAt };
    if (!isTurnAccount(turn)) return;
    await this.loadTurnAttribution();
    if (this.closing) return;
    const turns = this.turnAccounts.get(conversationId) ?? [];
    const cutoff = Date.now() - DAILY_HISTORY_DAYS * 86_400_000;
    const current = turns.filter((entry) => entry.endedAt >= cutoff);
    if (!current.some((entry) => entry.startedAt === startedAt && entry.endedAt === endedAt && entry.accountId === accountId)) {
      current.push(turn);
      current.sort((a, b) => a.startedAt - b.startedAt);
    }
    this.turnAccounts.set(conversationId, current);
    this.invalidateCache();
    if (!this.saveTurnTimer) this.saveTurnTimer = setTimeout(() => this.saveTurnAttribution(), 2000);
  }

  /** Records the account running a conversation from `at` onward without rewriting earlier turns. */
  recordConversationAccount(conversationId: string, accountId: string, at = Date.now()): void {
    if (this.closing || !conversationId || !accountIdSchema.safeParse(accountId).success || !Number.isFinite(at) || at < 0) {
      return;
    }
    this.loadSpanAttribution();
    const history = this.conversationAccounts.get(conversationId);
    let watermark = history?.watermark ?? -1;
    if (at <= watermark) return;
    const observations = history?.spans ?? [];
    // Earlier transitions were discarded, so a late observation cannot establish their extent.
    if (observations[0]?.accountId === "" && observations[1] && at < observations[1].since) return;
    const next = observations.findIndex((point) => point.since >= at);
    const index = next < 0 ? observations.length : next;
    const replace = observations[index]?.since === at;
    if (replace && observations[index]?.accountId === accountId) return;
    observations.splice(index, replace ? 1 : 0, { accountId, since: at });
    // A delayed batch may be replaying older event times. Keep its reorder window too.
    const cutoff = Math.min(at, Date.now()) - 10 * 60_000;
    const retained = observations.filter((point, i) => {
      if (point.since >= cutoff || observations[i - 1]?.accountId !== point.accountId) return true;
      watermark = Math.max(watermark, point.since);
      return false;
    });
    if (retained.length > 200) {
      const dropped = retained.splice(0, retained.length - 199, { accountId: "", since: 0 });
      watermark = Math.max(watermark, dropped[dropped.length - 1]!.since);
    }
    this.conversationAccounts.set(conversationId, { spans: retained, watermark });
    if (this.conversationAccounts.size > 2000) {
      const oldest = this.conversationAccounts.keys().next().value;
      if (oldest) this.conversationAccounts.delete(oldest);
    }
    this.invalidateCache();
    this.scheduleSaveSpanAttribution();
  }

  private saveTurnAttribution(): void {
    clearTimeout(this.saveTurnTimer ?? undefined);
    this.saveTurnTimer = null;
    const body = JSON.stringify(Object.fromEntries(this.turnAccounts));
    const file = turnAttributionFile();
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

  private scheduleSaveSpanAttribution(): void {
    if (this.saveSpanTimer) return;
    this.saveSpanTimer = setTimeout(() => {
      this.saveSpanTimer = null;
      void this.saveSpanAttribution();
    }, 2000);
  }

  private async saveSpanAttribution(sync = false): Promise<void> {
    const file = spanAttributionFile();
    const seq = ++this.saveSpanSeq;
    const temp = `${file}.${process.pid}.${Date.now()}.${seq}.tmp`;
    this.savingSpan = true;
    try {
      const body = JSON.stringify(Object.fromEntries(this.conversationAccounts));
      if (sync) {
        fsSync.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fsSync.writeFileSync(temp, body, { mode: 0o600 });
      } else {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(temp, body, { mode: 0o600 });
        // A newer timer or dispose() may already have published a later snapshot.
        if (seq !== this.saveSpanSeq) {
          await fs.rm(temp, { force: true });
          return;
        }
      }
      fsSync.renameSync(temp, file);
    } catch (error) {
      console.error("antigravity-accounts: could not save conversation attribution", error);
      await fs.rm(temp, { force: true }).catch(() => undefined);
    } finally {
      if (seq === this.saveSpanSeq) this.savingSpan = false;
    }
  }

  private async transcriptHead(conversationId: string): Promise<{ isSubagent: boolean; sender: string | null }> {
    const file = path.join(REAL_CLI_DIR, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) {
      this.transcriptHeads.delete(conversationId);
      return { isSubagent: false, sender: null };
    }
    const cached = this.transcriptHeads.get(conversationId);
    if (cached?.ino === stat.ino) {
      if (cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return { isSubagent: cached.isSubagent, sender: cached.sender };
      }
      if (cached.complete && stat.size > cached.size) {
        cached.size = stat.size;
        cached.mtimeMs = stat.mtimeMs;
        return { isSubagent: cached.isSubagent, sender: cached.sender };
      }
    }
    const { complete, isSubagent, sender } = await readTranscriptHead(file);
    this.transcriptHeads.set(conversationId, {
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      complete,
      isSubagent,
      sender,
    });
    return { isSubagent, sender };
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

  /** Finds observed turn bounds or account spans for a conversation, walking up subagent senders to the root conversation. */
  private async attributionForConversation(
    conversationId: string,
    directParentId: string | null,
    now: number,
  ): Promise<{ turns: readonly TurnAccount[]; spans: readonly AccountSpan[] } | null> {
    const ownTurns = this.combinedTurns(conversationId, now);
    const ownSpans = this.conversationAccounts.get(conversationId)?.spans ?? [];
    if (ownTurns.length > 0 || ownSpans.length > 0) {
      return { turns: ownTurns, spans: ownSpans };
    }
    const visited = new Set<string>([conversationId]);
    let current = directParentId;
    for (let depth = 0; depth < 5 && current && !visited.has(current); depth += 1) {
      visited.add(current);
      const turns = this.combinedTurns(current, now);
      const spans = this.conversationAccounts.get(current)?.spans ?? [];
      if (turns.length > 0 || spans.length > 0) {
        return { turns, spans };
      }
      current = (await this.transcriptHead(current)).sender;
    }
    return null;
  }

  private async readFile(
    file: string,
    conversationId: string,
    signature: string,
    stat: fsSync.Stats,
  ): Promise<FileCache | null> {
    const module = await loadSqlite();
    if (!module) return null;
    let previous = this.files.get(file);
    if (previous && (previous.ino !== stat.ino || stat.size < previous.size)) previous = undefined;
    let db: InstanceType<SqliteModule["DatabaseSync"]> | null = null;
    try {
      db = openSqliteReadOnly(module, file);
      db.exec("BEGIN");
      if (previous) {
        const max = db.prepare("SELECT MAX(idx) AS maxIdx FROM gen_metadata").get() as { maxIdx?: number | null } | undefined;
        if (Number(max?.maxIdx ?? -1) < previous.lastGenIndex) previous = undefined;
      }
      // Work on a copy so a mid-read error never corrupts `previous`.
      const nextGenerations = previous ? [...previous.generations] : [];
      let nextLastGenIndex = previous?.lastGenIndex ?? -1;
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
      // Steps change state while they run; their metadata is small, so re-read it when the DB signature changed.
      const started = readStepTimestamps(db);
      let earliest = Infinity;
      for (const ts of started.values()) {
        if (ts < earliest) earliest = ts;
      }
      const subagentSpawnAt = Number.isFinite(earliest) ? earliest : undefined;
      const next: FileCache = {
        ino: stat.ino,
        size: stat.size,
        conversationId,
        signature,
        lastGenIndex: nextLastGenIndex,
        generations: nextGenerations,
        started,
        subagentSpawnAt,
        fallback: previous?.fallback ?? (stat.birthtimeMs || stat.mtimeMs),
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
    await this.loadTurnAttribution();
    this.loadSpanAttribution();
    const dir = path.join(REAL_CLI_DIR, SHARED_CLI_DIRS[0]);
    let names: string[] = [];
    try {
      names = (await fs.readdir(dir)).filter((name) => /^[0-9a-f-]{36}\.db$/i.test(name));
    } catch {
      return [];
    }
    const statEntries = await mapConcurrent(names, STAT_CONCURRENCY, async (name) => {
      const conversationId = name.slice(0, -3);
      const file = path.join(dir, name);
      const [stat, wal] = await Promise.all([
        fs.stat(file).catch(() => null),
        fs.stat(`${file}-wal`).catch(() => null),
      ]);
      if (!stat) return null;
      return {
        conversationId,
        file,
        stat,
        signature: `${stat.ino}:${stat.mtimeMs}:${stat.size}:${wal?.ino ?? 0}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`,
      };
    });
    const now = Date.now();
    const records: CallRecord[] = [];
    const seen = new Set<string>();
    const presentConversations = new Set<string>();
    let dbReads = 0;
    for (const entry of statEntries) {
      if (!entry) continue;
      const { conversationId, file, stat, signature } = entry;
      presentConversations.add(conversationId);
      const head = await this.transcriptHead(conversationId);
      const isSubagent = head.isSubagent;
      const attribution = await this.attributionForConversation(conversationId, head.sender, now);
      if (!attribution) continue;
      seen.add(file);
      let cache = this.files.get(file);
      if (!cache || cache.signature !== signature) {
        if (dbReads > 0) await new Promise<void>((resolve) => setImmediate(resolve));
        dbReads += 1;
        cache = (await this.readFile(file, conversationId, signature, stat)) ?? undefined;
      }
      if (!cache) continue;
      // Earliest step timestamp for a subagent (when its parent spawned it), used when an async
      // subagent call finishes after its parent's turn ended while still running in the same process.
      const subagentSpawnAt = isSubagent ? cache.subagentSpawnAt : undefined;
      for (const generation of cache.generations) {
        const startedAt = generation.responseId ? cache.started.get(generation.responseId) : undefined;
        if (startedAt === undefined) continue;
        let accountId: string | null = null;
        if (attribution.turns.length > 0) {
          accountId =
            accountForGeneration(attribution.turns, startedAt) ??
            (isSubagent && subagentSpawnAt !== undefined
              ? accountForGeneration(attribution.turns, subagentSpawnAt)
              : null);
        }
        if (!accountId && attribution.spans.length > 0) {
          accountId =
            accountForSpan(attribution.spans, startedAt) ??
            (isSubagent && subagentSpawnAt !== undefined
              ? accountForSpan(attribution.spans, subagentSpawnAt)
              : null);
        }
        if (!accountId) continue;
        records.push({ ...generation, source: generation, at: startedAt, conversationId, isSubagent, accountId });
      }
    }
    for (const file of this.files.keys()) {
      if (!seen.has(file)) {
        this.files.delete(file);
      }
    }
    for (const conversationId of this.transcriptHeads.keys()) {
      if (!presentConversations.has(conversationId)) {
        this.transcriptHeads.delete(conversationId);
      }
    }
    return records;
  }

  private records(): Promise<CallRecord[]> {
    if (this.cachedRecords && Date.now() - this.cachedRecords.at < COLLECT_CACHE_TTL_MS) {
      return Promise.resolve(this.cachedRecords.records);
    }
    // Concurrent requests share one scan.
    if (!this.running) {
      const version = this.cacheVersion;
      const task = this.collect()
        .then((records) => {
          if (this.cacheVersion === version) {
            this.cachedRecords = { at: Date.now(), records };
          }
          return records;
        })
        .finally(() => {
          if (this.running === task) this.running = null;
        });
      this.running = task;
    }
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

  private requestCost(record: CallRecord, signature: string, pricing: Readonly<Record<string, ModelRates>>): number | null {
    const cached = this.costs.get(record.source);
    if (cached?.signature === signature && cached.at === record.at) return cached.cost;
    const rates = resolveEffectiveRates(record.pricingKey, record.at, pricing);
    const cost = rates ? estimateRequestCost(record, rates) : null;
    this.costs.set(record.source, { signature, at: record.at, cost });
    return cost;
  }

  async summary(
    filter: StatsFilter,
    labelOf: (accountId: string) => string = (id) => id,
    customPricing: Readonly<Record<string, ModelRates>> = {},
    paseo?: PaseoApi,
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
    const conversations = new Map<
      string,
      {
        totals: UsageTotals;
        isSubagent: boolean;
        accountIds: Set<string>;
        lastAt: number;
        modelCounts: Map<string, number>;
      }
    >();

    const records = await this.records();
    const signature = JSON.stringify(customPricing);
    for (const record of records) {
      if (record.at < firstStart || record.at > lastEnd) continue;

      // Estimate this request's API cost using its exact token counts, prompt tier, and timestamp.
      const cost = this.requestCost(record, signature, customPricing);

      // Track per-account totals across the time range (before account/model filters so selectors stay complete).
      if (scope === "all" || (scope === "subagent") === record.isSubagent) {
        const bucketId = record.accountId;
        let entry = accounts.get(bucketId);
        if (!entry) {
          entry = { totals: emptyTotals(), conversations: new Set() };
          accounts.set(bucketId, entry);
        }
        add(entry.totals, record, cost);
        entry.conversations.add(record.conversationId);
      }

      if (accountId && record.accountId !== accountId) continue;

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

      let conv = conversations.get(record.conversationId);
      if (!conv) {
        conv = {
          totals: emptyTotals(),
          isSubagent: record.isSubagent,
          accountIds: new Set(),
          lastAt: record.at,
          modelCounts: new Map(),
        };
        conversations.set(record.conversationId, conv);
      }
      add(conv.totals, record, cost);
      if (record.at > conv.lastAt) conv.lastAt = record.at;
      conv.accountIds.add(record.accountId);
      conv.modelCounts.set(record.label, (conv.modelCounts.get(record.label) ?? 0) + 1);
    }

    // Select top 15 across each ranking metric (cost, tokens, requests) and merge their union so
    // switching sort tabs in the UI always shows the true top 15 across the entire filtered set.
    const allConvEntries = [...conversations.entries()];
    const topIds = new Set<string>();
    const totalTokensOf = (t: UsageTotals) => t.input + t.cached + t.output;
    for (const cmp of [
      (a: (typeof allConvEntries)[number], b: (typeof allConvEntries)[number]) =>
        b[1].totals.cost - a[1].totals.cost || totalTokensOf(b[1].totals) - totalTokensOf(a[1].totals) || b[1].totals.requests - a[1].totals.requests,
      (a: (typeof allConvEntries)[number], b: (typeof allConvEntries)[number]) =>
        totalTokensOf(b[1].totals) - totalTokensOf(a[1].totals) || b[1].totals.cost - a[1].totals.cost || b[1].totals.requests - a[1].totals.requests,
      (a: (typeof allConvEntries)[number], b: (typeof allConvEntries)[number]) =>
        b[1].totals.requests - a[1].totals.requests || b[1].totals.cost - a[1].totals.cost || totalTokensOf(b[1].totals) - totalTokensOf(a[1].totals),
    ]) {
      for (const [id] of [...allConvEntries].sort(cmp).slice(0, 15)) topIds.add(id);
    }

    const fetchLiveAgents = async () => {
      const map = new Map<string, { agentId: string; title: string | null; running: boolean; activityAt: number }>();
      if (!paseo || topIds.size === 0) return map;
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      while (true) {
        const res = await paseo.agents
          .list({ page: cursor ? { limit: 200, cursor } : { limit: 200 } })
          .catch(() => null);
        if (!res) break;
        for (const { agent } of res.entries) {
          if (agent.archivedAt || !isAntigravityProvider(agent.provider)) continue;
          const convId = conversationIdFrom(agent.persistence);
          if (!convId || !topIds.has(convId)) continue;
          const running = agent.status === "running" || agent.status === "initializing";
          const activityAt = Math.max(
            Date.parse(agent.updatedAt ?? "") || 0,
            Date.parse(agent.lastUserMessageAt ?? "") || 0,
            Date.parse(agent.createdAt ?? "") || 0,
          );
          const prev = map.get(convId);
          if (!prev || (running && !prev.running) || (running === prev.running && activityAt >= prev.activityAt)) {
            map.set(convId, { agentId: agent.id, title: agent.title?.trim() || null, running, activityAt });
          }
        }
        const nextCursor = res.pageInfo?.nextCursor ?? null;
        if (!nextCursor || !res.pageInfo?.hasMore || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      return map;
    };

    const [metaByConv, liveByConv] = await Promise.all([
      topIds.size > 0 ? readConversationMeta(topIds) : Promise.resolve(new Map<string, ConversationMeta>()),
      fetchLiveAgents(),
    ]);

    const topConversations: TopConversation[] = [...topIds]
      .map((conversationId) => {
        const entry = conversations.get(conversationId)!;
        const meta = metaByConv.get(conversationId);
        const live = liveByConv.get(conversationId);
        let primaryModel: string | null = null;
        let maxCount = 0;
        for (const [label, count] of entry.modelCounts) {
          if (count > maxCount) {
            maxCount = count;
            primaryModel = label;
          }
        }
        const mixedAccounts = entry.accountIds.size > 1;
        const singleAccount = entry.accountIds.size === 1 ? [...entry.accountIds][0]! : null;
        return {
          conversationId,
          title: live?.title ?? meta?.title ?? null,
          workspaceName: meta?.workspaceName ?? null,
          agentId: live?.agentId ?? null,
          accountId: mixedAccounts ? null : singleAccount,
          accountLabel: mixedAccounts ? null : singleAccount ? labelOf(singleAccount) : null,
          mixedAccounts: mixedAccounts || undefined,
          isSubagent: entry.isSubagent,
          primaryModel,
          lastAt: new Date(entry.lastAt).toISOString(),
          ...entry.totals,
        };
      })
      .sort(
        (left, right) =>
          right.cost - left.cost ||
          right.input + right.cached + right.output - (left.input + left.cached + left.output) ||
          right.requests - left.requests,
      );

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
          label: labelOf(id),
          conversations: value.conversations.size,
          ...value.totals,
        }))
        .sort((left, right) => right.requests - left.requests),
      topConversations,
      conversations: conversations.size,
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

    const records = await this.records();
    const signature = JSON.stringify(customPricing);
    for (const record of records) {
      if (record.at < firstStart || record.at > lastEnd) continue;
      if (accountId && record.accountId !== accountId) continue;
      if (scope === "main" && record.isSubagent) continue;
      if (scope === "subagent" && !record.isSubagent) continue;
      if (model && record.label !== model) continue;
      const cost = this.requestCost(record, signature, customPricing);
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
      await this.loadTurnAttribution();
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
    if (this.saveTurnTimer || flushedLive) this.saveTurnAttribution();
    if (this.saveSpanTimer || this.savingSpan) {
      if (this.saveSpanTimer) clearTimeout(this.saveSpanTimer);
      this.saveSpanTimer = null;
      await this.saveSpanAttribution(true);
    }
    await this.writing;
  }
}
