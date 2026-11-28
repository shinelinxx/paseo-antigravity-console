import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PaseoApi } from "./types";
import { isAntigravityProvider, type ContextUsage, type SessionUsage } from "../shared/contracts";
import { estimateRequestCost, resolveEffectiveRates, resolvePricingKey, type ModelRates } from "../shared/pricing";
import { REAL_CLI_DIR, SHARED_CLI_DIRS } from "./paths";
import { decode, int as number, message, seconds, text } from "./protobuf";

/**
 * Reads context usage and cumulative session totals from agy's conversation database incrementally.
 * Every model call stores a generation record (table `gen_metadata`, protobuf). Field 1.4 holds
 * token usage (2 = new input, 3 = output, 5 = cache-read, 7 = response id), field 3.13.2.22 holds
 * the context window, and `steps.metadata` (9.7 = response id, 1 = start time) supplies the exact
 * call timestamp so historical API cost matches the rate effective when each request ran.
 */

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DB_CACHE = 250;
const MAX_AGENTS_CACHE = 500;

interface GenerationUsage {
  idx: number;
  responseId: string | null;
  input: number;
  output: number;
  cached: number;
  window: number | null;
  pricingKey: string;
}

interface IncrementalDbCache {
  signature: string;
  ino: number;
  size: number;
  lastGenIndex: number;
  generations: GenerationUsage[];
  started: Map<string, number>;
  pricingSig?: string;
  prefixes: Array<{ totals: SessionUsage; lastAt: number; window: number | null }>;
  result?: { pricingSig: string; model: string | null; usage: ContextUsage | null };
  fallbackAt: number;
  updatedAtMs: number;
}

function parseGeneration(idx: number, data: Uint8Array): GenerationUsage | null {
  const root = decode(data);
  const request = message(root, [1]);
  const usage = message(request, [4]);
  if (!usage) return null;
  const input = number(usage, 2);
  const output = number(usage, 3);
  const cached = number(usage, 5);
  if (input + output + cached === 0) return null;
  const window = number(message(root, [3, 13, 2]), 22) || null;
  const modelId = text(request, 19)?.trim() || text(message(root, [3]), 28)?.trim() || null;
  const rawLabel = text(request, 21) ?? text(message(root, [3]), 28) ?? text(request, 19) ?? "";
  return {
    idx,
    responseId: text(usage, 7),
    input,
    output,
    cached,
    window,
    pricingKey: resolvePricingKey(modelId, rawLabel.trim()),
  };
}

type SqliteModule = typeof import("node:sqlite");
let sqlite: Promise<SqliteModule | null> | null = null;

function loadSqlite(): Promise<SqliteModule | null> {
  sqlite ??= import("node:sqlite").catch((error: unknown) => {
    console.error("antigravity-accounts: node:sqlite is unavailable; context usage is disabled", error);
    return null;
  });
  return sqlite;
}

/** Opens a SQLite DB read-only first to avoid WAL/lock side effects; falls back when WAL lacks -shm. */
export function openSqliteReadOnly(
  module: SqliteModule,
  file: string,
): InstanceType<SqliteModule["DatabaseSync"]> {
  let reader: InstanceType<SqliteModule["DatabaseSync"]> | undefined;
  try {
    reader = new module.DatabaseSync(file, { readOnly: true, timeout: 1000 });
    // SQLite can defer WAL initialization until the first read.
    reader.prepare("PRAGMA schema_version").get();
    return reader;
  } catch (error) {
    reader?.close();
    const sqliteError = error as NodeJS.ErrnoException & { errcode?: number };
    // SQLITE_READONLY_RECOVERY, SQLITE_READONLY_CANTLOCK and SQLITE_READONLY_CANTINIT
    // specifically describe WAL recovery or initialization of shared memory.
    const walReadOnly = sqliteError.errcode === 264 || sqliteError.errcode === 520 || sqliteError.errcode === 1288 ||
      (sqliteError.errcode === 8 && (existsSync(file + "-wal") || existsSync(file + "-shm")));
    if (sqliteError.code === "ENOENT" || !walReadOnly || !existsSync(file)) throw error;
    // mode=rw also prevents creation if the file disappears after existsSync.
    const uri = pathToFileURL(file);
    uri.search = "mode=rw";
    const db = new module.DatabaseSync(uri.href, { timeout: 1000 });
    try {
      db.exec("PRAGMA query_only = ON");
      return db;
    } catch (pragmaError) {
      db.close();
      throw pragmaError;
    }
  }
}

/** Guesses the window when agy did not record it. Gemini models in Antigravity use 1M tokens. */
function windowForModel(model: string | null): number | null {
  const name = (model ?? "").toLowerCase().replace(/^antigravity\//, "");
  if (name.startsWith("gemini") || name.includes("orchestrator")) return 1_048_576;
  if (name.startsWith("claude")) return 200_000;
  if (name.startsWith("gpt-oss")) return 131_072;
  return null;
}

const dbCache = new Map<string, IncrementalDbCache>();

function rememberDb(key: string, entry: IncrementalDbCache) {
  dbCache.delete(key);
  dbCache.set(key, entry);
  if (dbCache.size > MAX_DB_CACHE) {
    const oldest = dbCache.keys().next().value;
    if (oldest) dbCache.delete(oldest);
  }
}

function buildUsageFromCache(
  entry: IncrementalDbCache,
  model: string | null,
  customPricing: Readonly<Record<string, ModelRates>>,
): ContextUsage | null {
  const pricingSig = JSON.stringify(customPricing);
  if (entry.result?.pricingSig === pricingSig && entry.result.model === model) return entry.result.usage;
  if (entry.generations.length === 0) return null;
  if (entry.pricingSig !== pricingSig) {
    entry.prefixes.length = 0;
    entry.pricingSig = pricingSig;
  }
  const prefix = entry.prefixes.at(-1);
  let lastAt = prefix?.lastAt ?? entry.fallbackAt;
  let window = prefix?.window ?? null;
  const session = prefix ? { ...prefix.totals } :
    { requests: 0, input: 0, cached: 0, output: 0, cost: 0, pricedRequests: 0 };
  for (let i = entry.prefixes.length; i < entry.generations.length; i++) {
    const gen = entry.generations[i]!;
    lastAt = (gen.responseId && entry.started.get(gen.responseId)) || lastAt;
    if (gen.window) window = gen.window;
    session.requests += 1;
    session.input += gen.input;
    session.cached += gen.cached;
    session.output += gen.output;
    const rates = resolveEffectiveRates(gen.pricingKey, lastAt, customPricing);
    if (rates) {
      session.cost += estimateRequestCost(gen, rates);
      session.pricedRequests += 1;
    }
    entry.prefixes.push({ totals: { ...session }, lastAt, window });
  }
  const latest = entry.generations[entry.generations.length - 1]!;
  const guessed = windowForModel(model);
  const size = window ?? guessed;
  const usage: ContextUsage = {
    used: latest.input + latest.cached + latest.output,
    size,
    input: latest.input,
    cached: latest.cached,
    output: latest.output,
    sizeSource: window ? "agy" : guessed ? "model" : null,
    updatedAt: new Date(entry.updatedAtMs).toISOString(),
    model,
    session: { ...session },
  };
  entry.result = { pricingSig, model, usage };
  return usage;
}

/** Steps can be updated or removed after their generation has already been priced. */
export function readStepTimestamps(db: InstanceType<SqliteModule["DatabaseSync"]>): Map<string, number> {
  const started = new Map<string, number>();
  try {
    for (const step of db.prepare("SELECT metadata FROM steps WHERE metadata IS NOT NULL").iterate()) {
      const meta = decode(step.metadata as Uint8Array);
      const id = text(message(meta, [9]), 7);
      const at = seconds(message(meta, [1]));
      if (id && at > 0) started.set(id, at * 1000);
    }
  } catch (error) {
    if (!(error instanceof Error && /no such table: steps/i.test(error.message))) throw error;
  }
  return started;
}

export async function readConversationUsage(
  conversationId: string,
  model: string | null,
  customPricing: Readonly<Record<string, ModelRates>> = {},
): Promise<ContextUsage | null> {
  if (!CONVERSATION_ID.test(conversationId)) return null;
  const conversations = path.join(REAL_CLI_DIR, SHARED_CLI_DIRS[0]);
  const file = path.join(conversations, `${conversationId}.db`);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) {
    dbCache.delete(conversationId);
    return null;
  }
  const walStat = await fs.stat(`${file}-wal`).catch(() => null);
  const signature = `${stat.ino}:${stat.mtimeMs}:${stat.size}:${walStat?.ino ?? 0}:${walStat?.mtimeMs ?? 0}:${walStat?.size ?? 0}`;
  const updatedAtMs = Math.max(stat.mtimeMs, walStat?.mtimeMs ?? 0);
  const module = await loadSqlite();
  const cached = dbCache.get(conversationId);

  // When only pricing or model label changed, recompute in memory without touching SQLite.
  if (cached && cached.signature === signature) {
    rememberDb(conversationId, cached);
    return buildUsageFromCache(cached, model, customPricing);
  }

  if (!module) return cached ? buildUsageFromCache(cached, model, customPricing) : null;

  let previous = cached && cached.ino === stat.ino && stat.size >= cached.size ? cached : undefined;
  let nextLastGenIndex = previous?.lastGenIndex ?? -1;

  let db: InstanceType<SqliteModule["DatabaseSync"]> | null = null;
  try {
    db = openSqliteReadOnly(module, file);
    db.exec("BEGIN");
    if (previous && nextLastGenIndex >= 0) {
      const maxRow = db.prepare("SELECT MAX(idx) AS maxIdx FROM gen_metadata").get() as { maxIdx?: number | null } | undefined;
      const maxIdx = typeof maxRow?.maxIdx === "number" ? maxRow.maxIdx : -1;
      if (maxIdx < nextLastGenIndex) {
        // Table was truncated or rewritten: rebuild cleanly from scratch.
        nextLastGenIndex = -1;
        previous = undefined;
      }
    }
    const rows = db
      .prepare("SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx")
      .all(nextLastGenIndex) as Array<{ idx: number; data: Uint8Array | null }>;
    const started = readStepTimestamps(db);
    const appended: GenerationUsage[] = [];
    for (const row of rows) {
      nextLastGenIndex = Math.max(nextLastGenIndex, row.idx);
      if (!row.data) continue;
      const parsed = parseGeneration(row.idx, new Uint8Array(row.data));
      if (!parsed) continue;
      appended.push(parsed);
    }

    const prefixes = previous?.prefixes ?? [];
    if (previous) {
      const oldTimes = previous.started;
      const changed = previous.generations.findIndex(({ responseId }) =>
        responseId !== null && oldTimes.get(responseId) !== started.get(responseId));
      if (changed >= 0 && changed < prefixes.length) prefixes.length = changed;
    }
    const generations = previous?.generations ?? [];
    for (const gen of appended) generations.push(gen);
    const entry: IncrementalDbCache = {
      signature,
      ino: stat.ino,
      size: stat.size,
      lastGenIndex: nextLastGenIndex,
      generations,
      started,
      prefixes,
      pricingSig: previous?.pricingSig,
      fallbackAt: previous?.fallbackAt ?? (stat.birthtimeMs || stat.mtimeMs),
      updatedAtMs,
    };
    rememberDb(conversationId, entry);
    return buildUsageFromCache(entry, model, customPricing);
  } catch (error) {
    console.error(`antigravity-accounts: could not read context usage of ${conversationId}`, error);
    return previous ? buildUsageFromCache(previous, model, customPricing) : null;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
}

interface AgentInfo {
  conversationId: string | null;
  model: string | null;
  /** The provider process is not running (closed or failed). */
  closed: boolean;
  archived: boolean;
  native: boolean;
  antigravity: boolean;
  fetchedAt: number;
}

function firstUuid(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && CONVERSATION_ID.test(value)) return value;
  }
  return null;
}

function providerConversationId(handle: unknown): string | null {
  if (!handle || typeof handle !== "object" || !("data" in handle)) return null;
  const data = handle.data;
  if (!data || typeof data !== "object") return null;
  const fields = data as Record<string, unknown>;
  return firstUuid(fields.sessionId, fields.conversationId);
}

/** Extracts an explicit Antigravity conversation UUID from Paseo persistence metadata. */
export function conversationIdFrom(persistence: unknown): string | null {
  if (!persistence) return null;
  if (typeof persistence === "string") return firstUuid(persistence);
  if (typeof persistence !== "object") return null;
  const record = persistence as {
    conversationId?: unknown;
    nativeHandle?: unknown;
    sessionId?: unknown;
    metadata?: unknown;
  };
  const meta = record.metadata as Record<string, unknown> | undefined;
  const structured = providerConversationId(meta?.pluginProviderPersistence);
  if (structured) return structured;
  for (const handle of [record.sessionId, record.nativeHandle]) {
    if (typeof handle !== "string" || !handle.startsWith("plugin:")) continue;
    try {
      const id = providerConversationId(JSON.parse(handle.slice("plugin:".length)));
      if (id) return id;
    } catch {
      // Another handle or a legacy field may still identify the session.
    }
  }
  return firstUuid(record.conversationId, record.nativeHandle, record.sessionId,
    meta?.conversationId, meta?.nativeHandle, meta?.sessionId);
}

type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;

function agentInfo(agent: NonNullable<ReturnType<AgentHandle["current"]>>): AgentInfo {
  return {
    conversationId: conversationIdFrom(agent.persistence),
    model: agent.model ?? null,
    closed: agent.status === "closed" || agent.status === "error",
    archived: Boolean(agent.archivedAt),
    native: typeof agent.lastUsage?.contextWindowMaxTokens === "number",
    antigravity: isAntigravityProvider(agent.provider),
    fetchedAt: Date.now(),
  };
}

interface AgentCache {
  info: AgentInfo | null;
  appliedSeq: number;
  forgotten?: boolean;
  refreshing?: Promise<AgentInfo | null>;
  freshBatch?: Promise<AgentInfo | null>;
}

/** Maps agents to their agy conversations using the host's live snapshot when available. */
export class ContextReader {
  private readonly agents = new Map<string, AgentCache>();
  private refreshSeq = 0;

  private touchAgent(agentId: string, entry: AgentCache): void {
    this.agents.delete(agentId);
    this.agents.set(agentId, entry);
    if (this.agents.size > MAX_AGENTS_CACHE) {
      for (const [key, candidate] of this.agents) {
        if (this.agents.size <= MAX_AGENTS_CACHE) break;
        if (!candidate.refreshing) this.agents.delete(key);
      }
    }
  }

  private async info(paseo: PaseoApi, agentId: string, fresh = false): Promise<AgentInfo | null> {
    let entry = this.agents.get(agentId);
    if (!entry) {
      entry = { info: null, appliedSeq: 0 };
      this.touchAgent(agentId, entry);
    }
    const cached = entry.info;
    const handle = paseo.agents.ref(agentId);
    const live = !fresh && typeof handle.current === "function" ? handle.current() : null;
    if (live && (!cached || conversationIdFrom(live.persistence) !== cached.conversationId ||
        Boolean(live.archivedAt) !== cached.archived)) {
      const info = agentInfo(live);
      entry.appliedSeq = ++this.refreshSeq;
      entry.refreshing = undefined;
      entry.info = info;
      this.touchAgent(agentId, entry);
      return info;
    }
    const pending = fresh ? entry.freshBatch : entry.refreshing;
    if (pending) return pending;
    const ttlMs = cached && (!cached.antigravity || cached.conversationId !== null) ? 5 * 60_000 : 30_000;
    if (!fresh && cached && Date.now() - cached.fetchedAt < ttlMs) {
      this.touchAgent(agentId, entry);
      return cached;
    }
    const seq = ++this.refreshSeq;
    const refresh = Promise.resolve().then(async () => {
      if (entry.freshBatch === refresh) entry.freshBatch = undefined;
      if (entry.forgotten) return null;
      try {
        const snapshot = await handle.refresh().catch(() => null);
        if (entry.forgotten) return null;
        const info = snapshot ? agentInfo(snapshot.agent) : null;
        // Each batch returns its own snapshot. Only cache writes are ordered.
        if (seq >= entry.appliedSeq) {
          entry.appliedSeq = seq;
          entry.info = info;
          if (info && this.agents.get(agentId) === entry) this.touchAgent(agentId, entry);
        }
        return info;
      } finally {
        if (entry.refreshing === refresh) entry.refreshing = undefined;
        if (!entry.refreshing && !entry.info && this.agents.get(agentId) === entry) this.agents.delete(agentId);
      }
    });
    entry.refreshing = refresh;
    if (fresh) entry.freshBatch = refresh;
    return refresh;
  }

  async usage(
    paseo: PaseoApi,
    agentIds: readonly string[],
    customPricing: Readonly<Record<string, ModelRates>> = {},
  ): Promise<{ usage: Record<string, ContextUsage | null>; native: string[] }> {
    const usage: Record<string, ContextUsage | null> = {};
    const native: string[] = [];
    await Promise.all(
      [...new Set(agentIds)].map(async (agentId) => {
        const info = await this.info(paseo, agentId);
        if (!info?.antigravity) {
          usage[agentId] = null;
          return;
        }
        if (info.native) {
          native.push(agentId);
        }
        // Always read incremental usage so cumulative session stats remain available even with native context meters.
        usage[agentId] = info.conversationId
          ? await readConversationUsage(info.conversationId, info.model, customPricing)
          : null;
      }),
    );
    return { usage, native };
  }

  /** The agy conversation an Antigravity agent runs, or null for other agents. */
  async conversationOf(
    paseo: PaseoApi,
    agentId: string,
    options?: { fresh?: boolean },
  ): Promise<{ conversationId: string | null; closed: boolean; model: string | null } | null> {
    const info = await this.info(paseo, agentId, options?.fresh);
    if (!info?.antigravity) return null;
    return { conversationId: info.conversationId, closed: info.closed, model: info.model };
  }

  forget(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    entry.forgotten = true;
    const cached = entry.info;
    if (cached?.conversationId) dbCache.delete(cached.conversationId);
    this.agents.delete(agentId);
  }
}
