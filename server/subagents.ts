import fs from "node:fs/promises";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import { promisify } from "node:util";
import { deflateRaw, inflateRaw } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import {
  parseUpdateStepsInput,
  type SubagentArtifactInfo,
  type SubagentDetail,
  type SubagentList,
  type SubagentState,
  type SubagentSummary,
  type TaskSnapshot,
  type TranscriptEntry,
} from "../shared/contracts";
import { decodeTextPrefix, readSafeRelativeFile, scanBrainFiles, spend, splitArtifactPath, withSafeRelativeFile, type ScanBudget } from "./artifacts";
import { readTranscriptHeadFromHandle } from "./transcriptHead";
import type { ContextReader } from "./context";
import { REAL_CLI_DIR } from "./paths";
import type { PaseoApi } from "./types";

/**
 * agy runs subagents as conversations of their own. Every conversation keeps a JSON-lines log at
 * `brain/<id>/.system_generated/logs/transcript.jsonl` (agy hands the same path to the parent model).
 * A parent's log holds each `invoke_subagent` call and the id of the conversation it created; a
 * child reports back with `send_message`, which lands in the parent's `messages/` folder.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREATED_ID = /Created the following subagent:[\s\S]*?"conversationId"\s*:\s*"([0-9a-f-]{36})"/i;
const TIME_HEADER = /^(?:(?:Created|Completed) At: [^\n]*\n)+/;
/** A child with no new step for this long is no longer running, whatever its last step says. */
const STALE_MS = 12 * 60_000;
const MAX_DEPTH = 3;
const MAX_ENTRIES = 300;
const MAX_LOG_CACHE = 120;
const MAX_LIST_CACHE = 250;
const FILE_CACHE_BYTES = 512 * 1024;
const TOTAL_CACHE_BYTES = 2 * 1024 * 1024;
const pack = promisify(deflateRaw);
const unpack = promisify(inflateRaw);
const MAX_ARTIFACT_BYTES = 256 * 1024;
/** Step states agy may still rewrite in place. */
const UNFINISHED = new Set(["RUNNING", "PENDING", "GENERATING", "WAITING", "QUEUED"]);
/** How far back an unfinished step is looked for when resuming a read. */
const RESUME_WINDOW = 64;

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface Row {
  step_index: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
}

interface Child {
  id: string;
  role: string | null;
  type: string | null;
  task: string;
  /** Set when the parent stopped it with `manage_subagents` (`kill` or `kill_all`). */
  killedAt: string | null;
}

interface CachedLog {
  ino: number;
  dev: number;
  size: number;
  mtimeMs: number;
  rows: Row[];
  /** Byte offset where each row's line starts. */
  starts: number[];
}

type FileStamp = Pick<CachedLog, "ino" | "dev" | "size" | "mtimeMs">;
type PackedLog = FileStamp & { payload: Buffer; compressed: boolean; estimatedBytes: number };
type LightStep = Pick<Row, "step_index" | "type" | "status"> & {
  lineStart: number;
  // An appended revision can cross a future rewind point. Keep the earlier projection to restore its slot.
  previousVersion?: LightStep;
  // Preserve argument positions so each checklist pairs with its own tool result.
  updateStepsCalls?: (TaskSnapshot["steps"] | null | undefined)[];
};
type TaskCursor = { offset: number; anchorStart: number; anchorBytes: Buffer };
type TaskLog = TaskCursor & {
  file: string; ino: number; dev: number; mtimeMs: number;
  earliestMutableOffset: number | null;
  steps: Map<number, LightStep>;
  latest: TaskSnapshot | null; cleared: boolean;
  unavailable: boolean;
};

const ANCHOR_BYTES = 128;

async function matchesAnchor(handle: fs.FileHandle, cursor: TaskCursor) {
  if (!cursor.offset) return true;
  const bytes = Buffer.alloc(cursor.anchorBytes.length);
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, cursor.anchorStart);
  return bytesRead === bytes.length && bytes.equals(cursor.anchorBytes);
}

function brainDir(conversationId: string): string {
  return path.join(REAL_CLI_DIR, "brain", conversationId);
}

function logPath(conversationId: string): string {
  return path.join(brainDir(conversationId), ".system_generated", "logs", "transcript.jsonl");
}

function inboxDir(conversationId: string): string {
  return path.join(brainDir(conversationId), ".system_generated", "messages");
}

/**
 * Tool arguments are JSON-encoded strings in the log (`"Role": "\"Auditor\""`). Long values are
 * cut short by agy, which leaves an unterminated JSON string; those are decoded leniently.
 */
function argValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || !/^["[{]|^(true|false|null|-?\d)/.test(text)) return value;
  try {
    return JSON.parse(text);
  } catch {
    if (!text.startsWith('"')) return value;
    const body = text.slice(1).replace(/\\$/, "");
    try {
      return JSON.parse(`"${body}"`);
    } catch {
      return body.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
}

function argText(call: ToolCall, key: string): string | null {
  const value = argValue(call.args?.[key]);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function oneLine(text: string, max = 140): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const SUMMARY_KEYS = [
  "toolSummary",
  "CommandLine",
  "Path",
  "AbsolutePath",
  "TargetFile",
  "File",
  "DirectoryPath",
  "SearchPath",
  "Query",
  "Pattern",
  "Url",
  "Role",
  "Action",
];

const PATH_LIKE = new Set(["Path", "AbsolutePath", "TargetFile", "File", "DirectoryPath", "SearchPath"]);

export function describeCall(call: ToolCall): string {
  for (const key of SUMMARY_KEYS) {
    const value = argText(call, key);
    if (!value) continue;
    if (PATH_LIKE.has(key)) {
      const start = argText(call, "StartLine");
      const end = argText(call, "EndLine");
      const range = start && end ? ` ${start}–${end}` : "";
      return oneLine(`${path.basename(value)}${range}`);
    }
    return oneLine(value);
  }
  for (const value of Object.values(call.args ?? {})) {
    const parsed = argValue(value);
    if (typeof parsed === "string" && parsed.trim()) return oneLine(parsed);
  }
  return "";
}

function stripTimes(text: string): string {
  return text.replace(TIME_HEADER, "").trim();
}

function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** The text of a message, without agy's `<SYSTEM_MESSAGE>` or `<USER_REQUEST>` wrapper. */
function messageBody(content: string): string {
  if (content.includes("<SYSTEM_MESSAGE>")) {
    const inner = /content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/.exec(content)?.[1];
    if (inner !== undefined) return inner.trim();
  }
  const request = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/.exec(content)?.[1];
  return (request ?? content).trim();
}

/** Roles and types `manage_subagents` listed, by conversation id. */
function listedRoles(content: string): Map<string, { role: string | null; type: string | null }> {
  const result = new Map<string, { role: string | null; type: string | null }>();
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start < 0 || end <= start) return result;
  try {
    const entries: unknown = JSON.parse(content.slice(start, end + 1));
    for (const entry of Array.isArray(entries) ? entries : []) {
      const record = entry as { conversationId?: unknown; role?: unknown; type?: unknown };
      if (typeof record.conversationId !== "string") continue;
      result.set(record.conversationId, {
        role: typeof record.role === "string" ? record.role : null,
        type: typeof record.type === "string" ? record.type : null,
      });
    }
  } catch {
    // Not a list.
  }
  return result;
}

function parseTime(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return Date.parse(iso);
}

/** Lists user-facing artifact files saved directly under a subagent's brain directory. */
async function listArtifacts(conversationId: string): Promise<SubagentArtifactInfo[]> {
  const files = await scanBrainFiles(conversationId, "subagent", null, 40);
  return files.map(({ path, name, size, updatedAt, kind }) => ({
    path, name, size, updatedAt, isMarkdown: kind === "markdown",
  }));
}

export class SubagentReader {
  private readonly logs = new Map<string, PackedLog>();
  private readonly listCache = new Map<string, { at: number; value: SubagentList }>();
  private disposed = false;
  private readonly agentGen = new Map<string, number>();
  private readonly inFlightCount = new Map<string, number>();
  private readonly taskLogs = new Map<string, TaskLog>();
  private readonly taskSeq = new Map<string, number>();
  private readonly appliedTaskSeq = new Map<string, number>();
  private readonly latestRoot = new Map<string, { seq: number; file: string }>();

  constructor(private readonly agents: ContextReader) {}

  private rememberList(agentId: string, entry: { at: number; value: SubagentList }): void {
    this.listCache.delete(agentId);
    this.listCache.set(agentId, entry);
    if (this.listCache.size > MAX_LIST_CACHE) {
      const oldest = this.listCache.keys().next().value;
      if (oldest) this.listCache.delete(oldest);
    }
  }

  private async rememberLog(file: string, log: CachedLog, isCurrent?: () => boolean): Promise<void> {
    const { rows, starts, ...stamp } = log;
    let payload = serialize({ rows, starts });
    const overhead = 256 + 2 * file.length;
    const compressed = payload.length + overhead > FILE_CACHE_BYTES;
    if (compressed) payload = await pack(payload);
    if (this.disposed || isCurrent?.() === false) return;
    const estimatedBytes = overhead + payload.length;
    this.logs.delete(file);
    if (estimatedBytes > FILE_CACHE_BYTES) return;
    // Copy out of any pooled slab or partially used compression output chunk.
    const owned = Buffer.allocUnsafeSlow(payload.length);
    payload.copy(owned);
    this.logs.set(file, { ...stamp, compressed, estimatedBytes, payload: owned });
    let bytes = 0;
    for (const entry of this.logs.values()) bytes += entry.estimatedBytes;
    for (const [key, entry] of this.logs) {
      if (this.logs.size <= MAX_LOG_CACHE && bytes <= TOTAL_CACHE_BYTES) break;
      this.logs.delete(key);
      bytes -= entry.estimatedBytes;
    }
  }

  /**
   * Reads a conversation log incrementally. agy appends a line per step and rewrites a step's line
   * while it runs, so reading resumes at the earliest step that may still change.
   */
  private async rows(conversationId: string, parentId?: string, isCurrent?: () => boolean): Promise<{ rows: Row[]; mtimeMs: number } | null> {
    return withSafeRelativeFile(brainDir(conversationId), [".system_generated", "logs", "transcript.jsonl"], true,
      (handle) => this.readLog(handle, conversationId, parentId, isCurrent)).catch(() => null);
  }

  private async readLog(handle: fs.FileHandle, conversationId: string, parentId?: string, isCurrent?: () => boolean) {
    const file = logPath(conversationId);
    const stat = await handle.stat();
    if (this.disposed || isCurrent?.() === false) return null;
    if (parentId && !await hasParentHeader(handle, parentId)) return null;
    const previous = this.logs.get(file);
    let cached: CachedLog | undefined;
    if (previous?.dev === stat.dev && previous.ino === stat.ino) {
      const data = deserialize(previous.compressed ? await unpack(previous.payload) : previous.payload) as Pick<CachedLog, "rows" | "starts">;
      cached = { dev: stat.dev, ino: stat.ino, size: previous.size, mtimeMs: previous.mtimeMs, ...data };
    }
    if (cached && previous && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      if (this.logs.get(file) === previous) {
        this.logs.delete(file);
        this.logs.set(file, previous);
      }
      return { rows: cached.rows, mtimeMs: stat.mtimeMs };
    }
    let keep = 0;
    if (cached?.rows.length) {
      keep = cached.rows.length - 1;
      for (let index = Math.max(0, cached.rows.length - RESUME_WINDOW); index < cached.rows.length; index += 1) {
        if (UNFINISHED.has(cached.rows[index]!.status ?? "")) {
          keep = index;
          break;
        }
      }
    }
    const offset = cached?.rows.length ? cached.starts[keep]! : 0;
    const parsed = await readRows(handle, offset, stat.size);
    // The first line read must be the step it resumes at; anything else means the file was rewritten.
    const aligned = !cached?.rows.length || parsed.rows[0]?.step_index === cached.rows[keep]!.step_index;
    const next: CachedLog = {
      dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
      ...(aligned ? {
        rows: [...(cached?.rows.slice(0, keep) ?? []), ...parsed.rows],
        starts: [...(cached?.starts.slice(0, keep) ?? []), ...parsed.starts],
      } : await readRows(handle, 0, stat.size)),
    };
    dedupe(next);
    if (this.disposed || isCurrent?.() === false) return null;
    await this.rememberLog(file, next, isCurrent);
    return { rows: next.rows, mtimeMs: stat.mtimeMs };
  }

  /**
   * The children a conversation created, with the role and task it gave each. Each tool call of a
   * response gets one result line, in call order, before the next response; an `invoke_subagent`
   * result names the conversation it created.
   */
  private async children(conversationId: string, parentId?: string, isCurrent?: () => boolean, knownLog?: { rows: Row[] }): Promise<Child[]> {
    const log = knownLog ?? await this.rows(conversationId, parentId, isCurrent);
    if (!log) return [];
    const found: Child[] = [];
    const seenIds = new Set<string>();
    const killed = new Map<string, string>();
    const listed = new Map<string, { role: string | null; type: string | null }>();
    let queue: ToolCall[] = [];
    for (const row of log.rows) {
      if (row.type === "PLANNER_RESPONSE") {
        // A result that never arrived must not shift the next response's pairing.
        queue = [...(row.tool_calls ?? [])];
        for (const call of queue) {
          if (call.name !== "manage_subagents") continue;
          const action = argText(call, "Action");
          const at = row.created_at ?? "";
          if (action === "kill") {
            const ids = argValue(call.args?.ConversationIds);
            for (const id of Array.isArray(ids) ? ids : []) {
              if (typeof id === "string") killed.set(id, at);
            }
          } else if (action === "kill_all") {
            // Every subagent spawned before this `kill_all` call was terminated.
            for (const child of found) {
              if (!killed.has(child.id)) killed.set(child.id, at);
            }
          }
        }
        continue;
      }
      if (row.type !== "GENERIC") continue;
      const call = queue.shift();
      if (!call || !row.content) continue;
      if (call.name === "manage_subagents") {
        for (const [id, entry] of listedRoles(row.content)) listed.set(id, entry);
        continue;
      }
      if (call.name !== "invoke_subagent") continue;
      const id = CREATED_ID.exec(row.content)?.[1];
      if (!id || !UUID.test(id) || seenIds.has(id)) continue;
      seenIds.add(id);
      found.push({
        id,
        role: argText(call, "Role"),
        type: argText(call, "TypeName"),
        task: argText(call, "Prompt") ?? "",
        killedAt: null,
      });
    }
    for (const child of found) {
      if (killed.has(child.id)) child.killedAt = killed.get(child.id) ?? "";
      const entry = listed.get(child.id);
      child.role ??= entry?.role ?? null;
      child.type ??= entry?.type ?? null;
    }
    return found;
  }

  /** Messages a conversation received, by sender. */
  private async reports(conversationId: string, budget?: ScanBudget): Promise<Map<string, { at: string | null; content: string }>> {
    const result = new Map<string, { at: string | null; content: string }>();
    const dir = inboxDir(conversationId);
    if (budget && !spend(budget, "dirsLeft")) return result;
    const entries = await fs.opendir(dir).catch(() => null);
    if (!entries) return result;
    let reads = 0;
    for await (const { name } of entries) {
      if (budget && (!spend(budget, "entriesLeft") || reads >= 2 || budget.lstatsLeft < 80)) break;
      if (!name.endsWith(".json") || name === "read.json") continue;
      if (budget && !spend(budget, "lstatsLeft", 12)) break;
      reads++;
      try {
        const raw = await readSafeRelativeFile(brainDir(conversationId), [".system_generated", "messages", name],
          MAX_ARTIFACT_BYTES, { allowDotSegments: true, rejectIfTooLarge: true });
        if (raw.tooLarge) continue;
        const message = JSON.parse(raw.buffer.toString("utf8")) as {
          sender?: unknown;
          timestamp?: unknown;
          content?: unknown;
        };
        if (typeof message.sender !== "string" || typeof message.content !== "string") continue;
        const at = typeof message.timestamp === "string" ? message.timestamp : null;
        const previous = result.get(message.sender);
        if (!previous || (at && (!previous.at || at > previous.at))) {
          result.set(message.sender, { at, content: message.content });
        }
      } catch {
        // Not a message file.
      }
    }
    return result;
  }

  private async summarize(
    child: Child,
    parentId: string,
    depth: number,
    reported: { at: string | null; content: string } | undefined,
    parentClosed: boolean,
    log: { rows: Row[]; mtimeMs: number },
  ): Promise<SubagentSummary> {
    const rows = log?.rows ?? [];
    let tools = 0;
    let input = 0;
    let output = 0;
    let cached = 0;
    let model: string | null = null;
    let lastCall: ToolCall | null = null;
    let lastInputTime = NaN;
    for (const row of rows) {
      tools += row.tool_calls?.length ?? 0;
      input += row.input_tokens ?? 0;
      output += row.output_tokens ?? 0;
      cached += row.cache_read_tokens ?? 0;
      if (row.model) model = row.model;
      if (row.type === "SYSTEM_MESSAGE" || row.type === "USER_INPUT") {
        const at = parseTime(row.created_at);
        if (Number.isFinite(at)) lastInputTime = at;
      }
      const calls = row.tool_calls ?? [];
      if (calls.length) lastCall = calls[calls.length - 1]!;
    }
    const last = rows[rows.length - 1];
    const dbStat = await fs
      .stat(path.join(REAL_CLI_DIR, "conversations", `${child.id}.db-wal`))
      .catch(() => fs.stat(path.join(REAL_CLI_DIR, "conversations", `${child.id}.db`)).catch(() => null));
    const touched = Math.max(log?.mtimeMs ?? 0, dbStat?.mtimeMs ?? 0);
    const finalAnswer = last?.type === "PLANNER_RESPONSE" && last.status === "DONE" && !(last.tool_calls?.length);
    // A report only covers the latest turn if it was sent after (or alongside) the latest input to the subagent.
    const reportedMs = parseTime(reported?.at);
    const reportedCurrentTurn = Boolean(
      reported && (!Number.isFinite(lastInputTime) || !Number.isFinite(reportedMs) || reportedMs >= lastInputTime - 2000),
    );
    // A tool error is routine; an error in the model's own step ends the run.
    const failed = Boolean(last && (last.type?.includes("ERROR") || (last.status === "ERROR" && last.type !== "GENERIC")));
    let state: SubagentState;
    let phase: "thinking" | "tool" | null = null;
    if (child.killedAt !== null && !(finalAnswer && reportedCurrentTurn)) state = "stopped";
    else if (!last) state = parentClosed ? "stopped" : "running";
    else if (last.status === "CANCELED" || last.status === "INTERRUPTED") state = "stopped";
    else if (failed) state = "failed";
    else if (finalAnswer) state = reportedCurrentTurn ? "done" : parentClosed ? "stopped" : "idle";
    else {
      state = "running";
      phase = last.type === "PLANNER_RESPONSE" && last.tool_calls?.length && last.status === "DONE" ? "tool" : "thinking";
      if (last.type === "GENERIC" && last.status === "RUNNING") phase = "tool";
    }
    if (state === "running" && (parentClosed || Date.now() - touched > STALE_MS)) {
      state = "stopped";
      phase = null;
    }
    let activity: string | null = null;
    if (!(state === "running" && phase === "thinking") && lastCall) {
      const desc = describeCall(lastCall);
      activity = desc ? `${lastCall.name} · ${desc}` : lastCall.name;
    }
    const updatedAt = last?.created_at ?? (touched ? new Date(touched).toISOString() : null);
    return {
      id: child.id,
      parentId,
      depth,
      role: child.role,
      type: child.type,
      // The child's own first message holds the whole task; the parent's call may be cut short.
      task: oneLine(messageBody(rows.find((row) => row.type === "SYSTEM_MESSAGE")?.content ?? "") || child.task, 600),
      state,
      phase,
      activity,
      steps: rows.length,
      tools,
      model,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      startedAt: rows[0]?.created_at ?? null,
      updatedAt,
      reportedAt: reportedCurrentTurn ? (reported?.at ?? null) : null,
    };
  }

  private async collect(
    conversationId: string,
    depth: number,
    parentClosed: boolean,
    out: SubagentSummary[],
    parentId: string | undefined,
    isCurrent: () => boolean,
    budget?: ScanBudget,
    knownLog?: { rows: Row[]; mtimeMs: number },
  ): Promise<void> {
    if (depth > MAX_DEPTH || !isCurrent()) return;
    if (!knownLog && budget && !spend(budget, "lstatsLeft", 12)) return;
    const children = await this.children(conversationId, parentId, isCurrent, knownLog);
    if (!children.length) return;
    const inbox = await this.reports(conversationId, budget);
    for (const child of children) {
      // Only a conversation whose first message came from this parent is its child.
      if (!isCurrent()) return;
      // Keep enough budget for verifying ownership and walking the actual artifacts.
      if (budget && (budget.lstatsLeft < 80 || !spend(budget, "lstatsLeft", 14))) break;
      const own = await this.rows(child.id, conversationId, isCurrent);
      if (!own) continue;
      const summary = await this.summarize(child, conversationId, depth, inbox.get(child.id), parentClosed, own);
      out.push(summary);
      await this.collect(child.id, depth + 1, parentClosed || summary.state === "stopped", out, conversationId, isCurrent, budget, own);
    }
  }

  async list(paseo: PaseoApi, agentId: string,
    options?: ScanBudget | { budget?: ScanBudget; expectedConversationId?: string }): Promise<SubagentList> {
    if (this.disposed) return { conversationId: null, subagents: [] };
    const { budget, expectedConversationId } = options && "dirsLeft" in options ? { budget: options } : options ?? {};
    const gen = this.begin(agentId);
    try {
      const info = await this.agents.conversationOf(paseo, agentId, { fresh: true });
      const conversationId = info?.conversationId ?? null;
      if (this.disposed || this.agentGen.get(agentId) !== gen ||
          (expectedConversationId && expectedConversationId !== conversationId)) {
        return { conversationId, subagents: [] };
      }
      const cached = this.listCache.get(agentId);
      if (cached && cached.value.conversationId === conversationId && Date.now() - cached.at < 1500) {
        this.rememberList(agentId, cached);
        return cached.value;
      }
      if (cached) this.listCache.delete(agentId);
      const value: SubagentList = { conversationId, subagents: [] };
      if (conversationId && info) {
        await this.collect(conversationId, 1, info.closed, value.subagents, undefined,
          () => !this.disposed && this.agentGen.get(agentId) === gen, budget);
        const latest = await this.agents.conversationOf(paseo, agentId, { fresh: true });
        if (latest?.conversationId !== conversationId) return { conversationId: latest?.conversationId ?? null, subagents: [] };
      }
      if (this.disposed || this.agentGen.get(agentId) !== gen) return { conversationId: null, subagents: [] };
      if (!budget) this.rememberList(agentId, { at: Date.now(), value });
      return value;
    } finally {
      this.end(agentId);
    }
  }

  private begin(agentId: string): number {
    const gen = this.agentGen.get(agentId) ?? 0;
    this.agentGen.set(agentId, gen);
    this.inFlightCount.set(agentId, (this.inFlightCount.get(agentId) ?? 0) + 1);
    return gen;
  }

  private end(agentId: string): void {
    const count = this.inFlightCount.get(agentId) ?? 0;
    if (count > 1) this.inFlightCount.set(agentId, count - 1);
    else {
      this.inFlightCount.delete(agentId);
      this.agentGen.delete(agentId);
    }
  }

  async counts(paseo: PaseoApi, agentIds: readonly string[]): Promise<Record<string, { total: number; running: number }>> {
    const result: Record<string, { total: number; running: number }> = {};
    await Promise.all(
      [...new Set(agentIds)].map(async (agentId) => {
        const list = await this.list(paseo, agentId).catch(() => null);
        if (!list) return;
        result[agentId] = {
          total: list.subagents.length,
          running: list.subagents.filter((subagent) => subagent.state === "running").length,
        };
      }),
    );
    return result;
  }

  /**
   * Verifies that `childId` belongs to `agentId`'s subagent tree AND that every link from `childId`
   * back to the root conversation is cryptographically/explicitly confirmed by `sender=<parentId>`
   * in each child's own transcript (refusing unverified ownership).
   */
  async isVerifiedChild(paseo: PaseoApi, agentId: string, childId: string, budget?: ScanBudget,
    expectedRootId?: string, knownList?: SubagentList): Promise<boolean> {
    const rootId = (await this.agents.conversationOf(paseo, agentId, { fresh: true }))?.conversationId;
    if (!rootId || childId === rootId || (expectedRootId && expectedRootId !== rootId)) return false;
    const list = knownList ?? await this.list(paseo, agentId, { budget, expectedConversationId: rootId });
    if (list.conversationId !== rootId) return false;
    const byId = new Map(list.subagents.map((sub) => [sub.id, sub]));
    let cursor = childId;
    const chain: SubagentSummary[] = [];
    while (cursor !== rootId) {
      if (chain.length >= MAX_DEPTH) return false;
      const entry = byId.get(cursor);
      if (!entry) return false;
      chain.push(entry);
      cursor = entry.parentId;
    }
    for (const entry of chain.reverse()) {
      if (budget && !spend(budget, "lstatsLeft", 12)) return false;
      const verified = await withSafeRelativeFile(brainDir(entry.id), [".system_generated", "logs", "transcript.jsonl"],
        true, (handle) => hasParentHeader(handle, entry.parentId)).catch(() => false);
      if (!verified) return false;
    }
    return (await this.agents.conversationOf(paseo, agentId, { fresh: true }))?.conversationId === rootId;
  }

  private async latestTask(paseo: PaseoApi, agentId: string): Promise<TaskSnapshot | null | undefined> {
    if (this.disposed) return undefined;
    const seq = (this.taskSeq.get(agentId) ?? 0) + 1;
    this.taskSeq.set(agentId, seq);
    const gen = this.begin(agentId);
    const current = () => !this.disposed && this.agentGen.get(agentId) === gen;
    const atStart = this.taskLogs.get(agentId);
    const canApply = (targetFile?: string) => {
      if (seq < (this.appliedTaskSeq.get(agentId) ?? 0)) return false;
      const root = this.latestRoot.get(agentId);
      return !root || root.seq <= seq || root.file === targetFile;
    };
    try {
      const info = await this.agents.conversationOf(paseo, agentId, { fresh: true });
      if (!current() || !info) return undefined;
      if (!info.conversationId) {
        const previous = canApply() ? this.taskLogs.get(agentId) : atStart;
        return previous ? undefined : null;
      }
      const file = logPath(info.conversationId);
      if (seq >= (this.latestRoot.get(agentId)?.seq ?? 0)) this.latestRoot.set(agentId, { seq, file });
      const previous = canApply(file) ? this.taskLogs.get(agentId) : atStart;
      const sameConversation = previous?.file === file;
      const prior = sameConversation ? previous : undefined;
      try {
        return await withSafeRelativeFile(brainDir(info.conversationId), [".system_generated", "logs", "transcript.jsonl"], true,
          async (handle) => {
            const before = await handle.stat();
            if (!current()) return undefined;
            const sameFile = prior && prior.ino === before.ino && prior.dev === before.dev;
            if (sameFile && prior.offset === before.size && prior.mtimeMs === before.mtimeMs &&
                (!canApply(file) || this.taskLogs.get(agentId) === prior)) {
              // A cache hit also confirms this session ahead of any slower requests.
              if (canApply(file)) this.appliedTaskSeq.set(agentId, seq);
              return prior.unavailable ? undefined : prior.latest;
            }
            const resume = sameFile && before.size >= prior.offset &&
              (before.size > prior.offset || prior.earliestMutableOffset !== null) && await matchesAnchor(handle, prior);
            const scanFrom = resume ? prior.earliestMutableOffset ?? prior.offset : 0;
            const steps = new Map(resume ? prior.steps : undefined);
            if (resume && scanFrom < prior.offset) {
              for (const [index, latest] of steps) {
                let step: LightStep | undefined = latest;
                while (step && step.lineStart >= scanFrom) step = step.previousVersion;
                if (!step) steps.delete(index);
                else if (step !== latest) steps.set(index, step);
              }
            }
            const cursor: TaskCursor = resume && scanFrom === prior.offset
              ? { offset: scanFrom, anchorStart: prior.anchorStart, anchorBytes: prior.anchorBytes }
              : { offset: scanFrom, anchorStart: scanFrom, anchorBytes: Buffer.alloc(0) };
            const finishTail = await scanRows(handle, scanFrom, before.size, (row, lineStart) => {
              const updateStepsCalls = row.tool_calls?.map(call =>
                call.name === "update_steps" ? parseUpdateStepsInput(call.args) : undefined);
              steps.set(row.step_index, { step_index: row.step_index, type: row.type, status: row.status,
                lineStart, updateStepsCalls, previousVersion: steps.get(row.step_index) });
            }, cursor);
            const after = await handle.stat();
            if (before.ino !== after.ino || before.dev !== after.dev || after.size < cursor.offset) return undefined;
            if (after.size === before.size && after.mtimeMs === before.mtimeMs) finishTail?.();
            if (!await matchesAnchor(handle, cursor)) return undefined;
            // fstat follows the open inode even after the transcript path is replaced.
            const linked = await fs.lstat(file).catch(() => null);
            if (!linked || linked.ino !== after.ino || linked.dev !== after.dev || linked.size < cursor.offset ||
                !current()) return undefined;
            const { result, earliestMutableOffset } = inspectTaskSteps([...steps.values()]);
            const committed = canApply(file) ? this.taskLogs.get(agentId) : undefined;
            const baseline = committed?.file === file ? committed : prior;
            const cleared = result.kind === "cleared" || (result.kind === "none" && baseline?.cleared === true);
            const latest = result.kind === "snapshot" ? result.snapshot : cleared ? null : baseline?.latest ?? null;
            const unavailable = result.kind === "none" && latest !== null;
            if (canApply(file)) {
              this.appliedTaskSeq.set(agentId, seq);
              this.taskLogs.set(agentId, { ...cursor, file, ino: before.ino, dev: before.dev,
                mtimeMs: before.mtimeMs, steps, earliestMutableOffset, latest, cleared, unavailable });
            }
            return unavailable ? undefined : latest;
          });
      } catch (error) {
        if (!current()) return undefined;
        const baseline = canApply(file) ? this.taskLogs.get(agentId) : previous;
        if (baseline?.file !== file && (baseline || (error as NodeJS.ErrnoException)?.code === "ENOENT")) {
          if (canApply(file)) {
            this.appliedTaskSeq.set(agentId, seq);
            this.taskLogs.delete(agentId);
          }
          return null;
        }
        return undefined;
      }
    } finally {
      this.end(agentId);
    }
  }

  async latestTasks(paseo: PaseoApi, agentIds: readonly string[]) {
    const tasks: Record<string, TaskSnapshot | null> = Object.create(null);
    const unavailable: string[] = [];
    await Promise.all([...new Set(agentIds)].map(async id => {
      const snapshot = await this.latestTask(paseo, id).catch(() => undefined);
      if (snapshot === undefined) unavailable.push(id);
      else tasks[id] = snapshot;
    }));
    return { tasks, unavailable };
  }

  async detail(paseo: PaseoApi, agentId: string, subagentId: string): Promise<SubagentDetail> {
    const list = await this.list(paseo, agentId);
    const summary = list.subagents.find((subagent) => subagent.id === subagentId) ?? null;
    // Only conversations this agent created can be read through it.
    if (!summary || !list.conversationId || !await this.isVerifiedChild(paseo, agentId, subagentId, undefined, list.conversationId, list)) {
      return { summary: null, entries: [], report: null, artifacts: [], truncated: false };
    }
    const [log, inbox, artifacts] = await Promise.all([
      this.rows(subagentId, summary.parentId),
      this.reports(summary.parentId),
      listArtifacts(subagentId),
    ]);
    if ((await this.agents.conversationOf(paseo, agentId, { fresh: true }))?.conversationId !== list.conversationId) {
      return { summary: null, entries: [], report: null, artifacts: [], truncated: false };
    }
    const rows = log?.rows ?? [];
    const entries: TranscriptEntry[] = [];
    const open: TranscriptEntry["tools"] = [];
    let report: string | null = null;
    for (const row of rows) {
      if (row.type === "SYSTEM_MESSAGE" || row.type === "USER_INPUT") {
        entries.push({
          index: row.step_index,
          kind: entries.length === 0 ? "task" : "message",
          at: row.created_at ?? null,
          text: clip(messageBody(row.content ?? ""), 4000),
          thinking: null,
          tools: [],
          model: null,
        });
        continue;
      }
      if (row.type === "PLANNER_RESPONSE") {
        const tools = (row.tool_calls ?? []).map((call) => {
          const recipient = argText(call, "Recipient");
          if (call.name === "send_message" && (!recipient || recipient === summary.parentId)) {
            report = argText(call, "Message") ?? report;
          }
          return { name: call.name, summary: describeCall(call), output: null, failed: false };
        });
        // Results of an interrupted response never arrive; they must not shift this one's.
        open.length = 0;
        open.push(...tools);
        entries.push({
          index: row.step_index,
          kind: row.status === "ERROR" ? "error" : "response",
          at: row.created_at ?? null,
          text: clip(row.content, 4000),
          thinking: clip(row.thinking, 1500),
          tools,
          model: row.model ?? null,
        });
        continue;
      }
      if (row.type === "GENERIC") {
        const tool = open.shift();
        if (tool) {
          tool.output = clip(stripTimes(row.content ?? ""), 1200);
          tool.failed = row.status === "ERROR";
        }
        continue;
      }
      if (row.type?.includes("ERROR") || row.status === "ERROR") {
        entries.push({
          index: row.step_index,
          kind: "error",
          at: row.created_at ?? null,
          text: clip(row.content, 1200),
          thinking: null,
          tools: [],
          model: null,
        });
      }
    }
    const full = inbox.get(subagentId)?.content ?? null;
    const truncated = entries.length > MAX_ENTRIES;
    const task = entries[0]?.kind === "task" ? entries[0] : null;
    return {
      summary,
      // Keep the task when only the latest steps fit.
      entries: truncated ? [...(task ? [task] : []), ...entries.slice(-(MAX_ENTRIES - 1))] : entries,
      report: full ?? report,
      artifacts,
      truncated,
    };
  }

  /** Reads a text artifact written by a subagent inside its own brain folder (never follows symlinks). */
  async artifact(
    paseo: PaseoApi,
    agentId: string,
    subagentId: string,
    relativePath: string,
  ): Promise<{ path: string; content: string; truncated: boolean; isMarkdown: boolean }> {
    if (!UUID.test(subagentId)) throw new Error("Invalid subagent id.");
    const root = (await this.agents.conversationOf(paseo, agentId, { fresh: true }))?.conversationId;
    const verified = root && await this.isVerifiedChild(paseo, agentId, subagentId, undefined, root);
    if (!verified) {
      throw new Error("That subagent does not belong to this agent.");
    }
    const { cleaned, segments } = splitArtifactPath(relativePath);
    const result = await readSafeRelativeFile(brainDir(subagentId), segments, MAX_ARTIFACT_BYTES);
    if ((await this.agents.conversationOf(paseo, agentId, { fresh: true }))?.conversationId !== root) {
      throw new Error("That subagent does not belong to this agent.");
    }
    return {
      path: cleaned,
      content: decodeTextPrefix(result),
      truncated: result.truncated,
      isMarkdown: /\.(md|markdown)$/i.test(cleaned),
    };
  }

  forget(agentId: string): void {
    if (this.inFlightCount.has(agentId)) this.agentGen.set(agentId, (this.agentGen.get(agentId) ?? 0) + 1);
    const file = this.taskLogs.get(agentId);
    if (file) this.logs.delete(file.file);
    this.taskLogs.delete(agentId);
    this.taskSeq.delete(agentId);
    this.appliedTaskSeq.delete(agentId);
    this.latestRoot.delete(agentId);
    const cached = this.listCache.get(agentId);
    if (cached) {
      if (cached.value.conversationId) this.logs.delete(logPath(cached.value.conversationId));
      for (const subagent of cached.value.subagents) this.logs.delete(logPath(subagent.id));
    }
    this.listCache.delete(agentId);
  }

  dispose(): void {
    this.disposed = true;
    this.agentGen.clear();
    this.inFlightCount.clear();
    this.taskLogs.clear();
    this.taskSeq.clear();
    this.appliedTaskSeq.clear();
    this.latestRoot.clear();
    this.logs.clear();
    this.listCache.clear();
  }
}

const CHUNK_BYTES = 64 * 1024;
const LINE_BYTES = 128 * 1024;
const PREVIEW_CHARS = 4096;
const ROW_FIELDS = new Set([
  "step_index", "type", "status", "created_at", "source", "model",
  "input_tokens", "output_tokens", "cache_read_tokens", "tool_calls",
  "tool_call_id", "name", "args", "result", "content", "thinking",
]);

/** Project a large JSON object one top-level member at a time, in any field order. */
class LargeRowParser {
  private readonly fields: Record<string, unknown> = {};
  private phase: "start" | "key" | "colon" | "value" | "done" = "start";
  private key = "";
  private parts: string[] = [];
  private length = 0;
  private limit = 0;
  private nested = 0;
  private quoted = false;
  private escaped = false;
  private clipped = false;
  private valueStarted = false;

  private append(text: string) {
    const take = Math.min(text.length, this.limit - this.length);
    if (take > 0) this.parts.push(text.slice(0, take));
    this.length += take;
    if (take < text.length) this.clipped = true;
  }

  private finishValue() {
    if (this.limit) {
      let raw = this.parts.join("");
      if (this.clipped) {
        // Only content/thinking strings are clipped. Stop at a complete JSON escape.
        const prefix = /^"((?:[^"\\]|\\(?:u[\da-fA-F]{4}|["\\/bfnrt]))*)/.exec(raw);
        if (!prefix) throw Error("Invalid transcript string");
        raw = '"' + prefix[1] + '…"';
      }
      this.fields[this.key] = JSON.parse(raw);
    }
    this.parts = [];
    this.length = 0;
    this.clipped = false;
    this.valueStarted = false;
  }

  feed(text: string) {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (this.phase === "value") {
        if (!this.valueStarted) {
          if (/\s/.test(c)) { start = i + 1; continue; }
          this.valueStarted = true;
          if (c === '"' && (this.key === "content" || this.key === "thinking")) this.limit = PREVIEW_CHARS;
        }
        if (!this.quoted && this.nested === 0 && (c === "," || c === "}")) {
          this.append(text.slice(start, i));
          this.finishValue();
          this.phase = c === "," ? "key" : "done";
        } else if (this.quoted) {
          if (this.escaped) this.escaped = false;
          else if (c === "\\") this.escaped = true;
          else if (c === '"') this.quoted = false;
        } else if (c === '"') this.quoted = true;
        else if (c === "[" || c === "{") this.nested++;
        else if (c === "]" || c === "}") this.nested--;
        continue;
      }
      if (this.phase === "key" && this.quoted) {
        if (this.key.length < 128) this.key += c;
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') {
          this.key = this.key.length < 128 ? JSON.parse(this.key) as string : "";
          this.quoted = false;
          this.phase = "colon";
        }
        continue;
      }
      if (/\s/.test(c)) continue;
      if (this.phase === "start" && c === "{") this.phase = "key";
      else if (this.phase === "key" && c === '"') { this.key = '"'; this.quoted = true; }
      else if (this.phase === "colon" && c === ":") {
        this.phase = "value";
        this.limit = ROW_FIELDS.has(this.key) ? Infinity : 0;
        start = i + 1;
      } else throw Error("Invalid transcript object");
    }
    if (this.phase === "value") this.append(text.slice(start));
  }

  finish(): Row {
    if (this.phase !== "done") throw Error("Incomplete transcript object");
    return this.fields as unknown as Row;
  }
}

async function hasParentHeader(handle: fs.FileHandle, parentId: string) {
  const head = await readTranscriptHeadFromHandle(handle);
  return head.complete && head.sender === parentId.toLowerCase();
}

/** Reuse a single positional read buffer. Promote only oversized lines to the projection parser. */
async function scanRows(handle: fs.FileHandle, from: number, to: number,
  visit: (row: Row, start: number) => void, cursor?: TaskCursor) {
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  let parts: string[] = [];
  let parser: LargeRowParser | undefined;
  let invalid = false;
  let start = from;
  let tail: Buffer = cursor?.anchorBytes ?? Buffer.alloc(0);
  function rememberBytes(bytes: Buffer) {
    if (!bytes.length) return;
    tail = bytes.length >= ANCHOR_BYTES
      ? Buffer.from(bytes.subarray(-ANCHOR_BYTES))
      : Buffer.concat([tail.subarray(Math.max(0, tail.length + bytes.length - ANCHOR_BYTES)), bytes]);
  }
  function checkpoint(end: number) {
    if (!cursor) return;
    cursor.offset = end;
    cursor.anchorBytes = tail;
    cursor.anchorStart = end - tail.length;
  }
  function feed(text: string, length: number) {
    if (invalid) return;
    try {
      if (!parser && length > LINE_BYTES) {
        parser = new LargeRowParser();
        for (const part of parts) parser.feed(part);
        parts = [];
      }
      if (parser) parser.feed(text);
      else parts.push(text);
    } catch {
      invalid = true;
    }
  }
  function finish(strict = false) {
    try {
      if (invalid) throw Error("Invalid transcript object");
      const text = parser ? "" : parts.join("");
      if (!parser && !text.trim()) return;
      const row = parser ? parser.finish() : JSON.parse(text) as Row;
      if (row && typeof row.step_index === "number") visit(row, start);
      return true;
    } catch (error) {
      if (strict) throw error;
    } finally {
      parser = undefined;
      parts = [];
      invalid = false;
    }
  }
  for (let offset = from; offset < to;) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, to - offset), offset);
    if (!bytesRead) {
      // Keep completed lines eligible for anchor verification after a concurrent truncation.
      if (cursor) return;
      throw Error("Transcript changed during read");
    }
    const view = chunk.subarray(0, bytesRead);
    if (cursor) {
      const end = view.lastIndexOf(10) + 1;
      if (end) {
        rememberBytes(view.subarray(0, end));
        checkpoint(offset + end);
      }
      rememberBytes(view.subarray(end));
    }
    let pos = 0;
    while (pos < bytesRead) {
      const nl = view.indexOf(10, pos);
      const end = nl < 0 ? bytesRead : nl;
      feed(decoder.write(view.subarray(pos, end)), offset + end - start);
      if (nl < 0) break;
      feed(decoder.end(), offset + end - start);
      finish(!!cursor);
      pos = nl + 1;
      start = offset + pos;
    }
    offset += bytesRead;
  }
  if (start < to) {
    feed(decoder.end(), to - start);
    if (cursor) return () => { if (finish()) checkpoint(to); };
    finish();
  }
}

function preview(value: string, maxBytes = 4096): string {
  const prefix = value.slice(0, maxBytes);
  if (prefix.length === value.length && Buffer.byteLength(prefix) <= maxBytes) return value;
  const bytes = Buffer.from(prefix).subarray(0, maxBytes - 3);
  return new TextDecoder().decode(bytes, { stream: true }) + "…";
}

function detailRow(row: Row): Row {
  const { step_index, input_tokens, output_tokens, cache_read_tokens } = row;
  return {
    step_index, input_tokens, output_tokens, cache_read_tokens,
    type: row.type && preview(row.type),
    status: row.status && preview(row.status),
    created_at: row.created_at && preview(row.created_at),
    model: row.model && preview(row.model),
    content: typeof row.content === "string" ? preview(row.content, row.type === "GENERIC" ? 2048 : 4096) : undefined,
    thinking: typeof row.thinking === "string" ? preview(row.thinking, 2048) : undefined,
    tool_calls: row.tool_calls?.map(call => ({
      name: preview(call.name),
      args: Object.fromEntries(Object.entries(call.args ?? {}).map(([key, value]) => {
        if (typeof value === "string") return [key, preview(value)];
        const json = JSON.stringify(value);
        return [key, json && Buffer.byteLength(json) > 4096 ? preview(json) : value];
      })),
    })),
  };
}

async function readRows(handle: fs.FileHandle, from: number, to: number) {
  const rows: Row[] = [];
  const starts: number[] = [];
  await scanRows(handle, from, to, (row, start) => {
    rows.push(detailRow(row));
    starts.push(start);
  });
  return { rows, starts };
}

/** Keeps the newest line of a step that agy wrote more than once. */
function dedupe(log: CachedLog): void {
  const seen = new Set<number>();
  let duplicate = false;
  for (const row of log.rows) {
    if (seen.has(row.step_index)) duplicate = true;
    seen.add(row.step_index);
  }
  if (!duplicate) return;
  // An appended status rewrite still belongs to the original planner call. Preserve the
  // first position (and its resume offset) while keeping the latest version of that step.
  const rows: Row[] = [];
  const starts: number[] = [];
  const slots = new Map<number, number>();
  for (const [index, row] of log.rows.entries()) {
    const slot = slots.get(row.step_index);
    if (slot !== undefined) rows[slot] = row;
    else {
      slots.set(row.step_index, rows.length);
      rows.push(row);
      starts.push(log.starts[index]!);
    }
  }
  log.rows = rows;
  log.starts = starts;
}

/** Pair result rows with their planner calls in order, starting with the newest response. */
type ConfirmedTask = { kind: "snapshot"; snapshot: TaskSnapshot } | { kind: "cleared" } | { kind: "none" };

const TERMINAL_TASK_RESULTS = new Set(["DONE", "ERROR", "CANCELED", "CANCELLED", "FAILED"]);

function inspectTaskSteps(rows: LightStep[]) {
  let result: ConfirmedTask = { kind: "none" };
  let earliestMutableOffset: number | null = null;
  let results: LightStep[] = [];
  let activeTurnFloor = -1;
  rows.sort((a, b) => a.step_index - b.step_index);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.type === "GENERIC" || row.type === "TOOL_RESULT") results.push(row);
    if (row.type === "USER_INPUT" || row.type === "SYSTEM_MESSAGE") {
      activeTurnFloor = Math.max(activeTurnFloor, row.step_index);
      results = [];
    }
    if (row.type !== "PLANNER_RESPONSE") continue;
    const calls = row.updateStepsCalls ?? [];
    // An older planner can gain arguments after its result is already on disk.
    // Use the same positional result segment as the confirmation loop below.
    if (TERMINAL_TASK_RESULTS.has(row.status ?? "")) {
      activeTurnFloor = Math.max(activeTurnFloor, row.step_index);
    } else {
      let start = row.step_index >= activeTurnFloor || calls.some(steps => steps !== undefined)
        ? row.lineStart : Infinity;
      for (const candidate of results) {
        if (candidate.status === "DONE") start = Math.min(start, row.lineStart);
        else if (!TERMINAL_TASK_RESULTS.has(candidate.status ?? "")) {
          start = Math.min(start, row.lineStart, candidate.lineStart);
        }
      }
      if (Number.isFinite(start)) earliestMutableOffset = Math.min(earliestMutableOffset ?? start, start);
    }
    for (let j = calls.length - 1; j >= 0; j--) {
      const steps = calls[j];
      if (steps === undefined) continue;
      const paired = results[results.length - 1 - j];
      if (!TERMINAL_TASK_RESULTS.has(paired?.status ?? "")) {
        const start = Math.min(row.lineStart, paired?.lineStart ?? row.lineStart);
        earliestMutableOffset = Math.min(earliestMutableOffset ?? start, start);
      }
      if (!steps || paired?.status !== "DONE" || result.kind !== "none") continue;
      const revision = row.step_index * 1000 + j;
      result = steps.length ? { kind: "snapshot", snapshot: { planId: "steps-" + revision, revision, steps } }
        : { kind: "cleared" };
    }
    // Earlier planners cannot supersede a confirmed checklist, including a confirmed clear.
    if (result.kind !== "none") return { result, earliestMutableOffset };
    results = [];
  }
  return { result, earliestMutableOffset };
}
