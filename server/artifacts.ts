import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentArtifactInfo, ArtifactKind } from "../shared/contracts";
import type { ContextReader } from "./context";
import { REAL_CLI_DIR, displayPath } from "./paths";
import { readConversationMeta } from "./stats";
import type { SubagentReader } from "./subagents";
import type { PaseoApi } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT_BYTES = 48 * 1024;
const MAX_SEARCH_BRAINS = 60;
const MAX_SEARCH_RESULTS = 20;
const MAX_LIST_ITEMS = 120;
const MAX_REL_PATH_LEN = 1024;
const SEARCH_CONCURRENCY = 6;
const SEARCH_INDEX_TTL_MS = 15_000;

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".swift",
  ".java", ".kt", ".c", ".cc", ".cpp", ".h", ".hpp", ".sh", ".zsh", ".bash",
  ".sql", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css",
  ".scss", ".less", ".diff", ".patch", ".rb", ".php", ".lua", ".r", ".dockerfile",
]);

const TEXT_EXTS = new Set([
  ".txt", ".csv", ".tsv", ".log", ".ini", ".cfg", ".conf", ".env", ".pbtxt", ".jsonl",
]);

const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function brainDir(conversationId: string): string {
  return path.join(REAL_CLI_DIR, "brain", conversationId);
}

export function classifyArtifactKind(name: string): ArtifactKind {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext in IMAGE_MIME) return "image";
  if (CODE_EXTS.has(ext)) return "code";
  if (TEXT_EXTS.has(ext)) return "text";
  return "binary";
}

function isIgnoredArtifactName(name: string): boolean {
  return (
    name.startsWith(".") ||
    name === "node_modules" ||
    name.includes("\\") ||
    name.includes("/") ||
    name.endsWith(".metadata.json") ||
    name.endsWith(".resolved")
  );
}

/** Truncates a string to at most `maxBytes` UTF-8 bytes without splitting multi-byte characters. */
function truncateUtf8Bytes(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(input, "utf8");
  if (buf.length <= maxBytes) return { text: input, truncated: false };
  let end = maxBytes;
  // If `buf[end]` is a UTF-8 continuation byte (10xxxxxx), back up to the lead byte of the split character.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export interface SafeReadResult {
  buffer: Buffer;
  size: number;
  truncated: boolean;
  tooLarge: boolean;
  realPath: string;
}

export function decodeTextPrefix(raw: SafeReadResult): string {
  return new TextDecoder().decode(raw.buffer, { stream: raw.truncated });
}

/**
 * Opens and reads a file strictly anchored inside `rootDir` without following symlinks,
 * verifying path segments, `O_NOFOLLOW`, `dev/ino` identity, and `realpath` containment
 * on the same file descriptor to prevent symlink escapes and TOCTOU swaps.
 */
export async function readSafeRelativeFile(
  rootDir: string,
  segments: readonly string[],
  maxBytes: number,
  options?: { allowDotSegments?: boolean; rejectIfTooLarge?: boolean },
): Promise<SafeReadResult> {
  return withSafeRelativeFile(rootDir, segments, options?.allowDotSegments === true, async (handle, realPath) => {
    const { size } = await handle.stat();
    if (options?.rejectIfTooLarge && size > maxBytes) {
      return { buffer: Buffer.alloc(0), size, truncated: false, tooLarge: true, realPath };
    }
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    return { buffer: buffer.subarray(0, filled), size, truncated: size > maxBytes, tooLarge: false, realPath };
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message.startsWith("[ARTIFACT_")) throw error;
    throw new Error("[ARTIFACT_UNREADABLE] Artifact could not be read.", { cause: error });
  });
}

export async function withSafeRelativeFile<T>(
  rootDir: string,
  segments: readonly string[],
  allowDot: boolean,
  read: (handle: fs.FileHandle, realPath: string) => Promise<T>,
): Promise<T> {
  if (segments.length === 0) throw new Error("[ARTIFACT_INVALID_PATH] Invalid artifact path.");
  for (const seg of segments) {
    if (
      !seg ||
      seg === "." ||
      seg === ".." ||
      seg.includes("/") ||
      seg.includes("\\") ||
      seg.includes("\0") ||
      (!allowDot && seg.startsWith("."))
    ) {
      throw new Error("[ARTIFACT_INVALID_PATH] Invalid artifact path.");
    }
  }
  const rootLstat = await fs.lstat(rootDir, { bigint: true });
  if (!rootLstat?.isDirectory() || rootLstat.isSymbolicLink()) {
    throw new Error("[ARTIFACT_UNREADABLE] Artifact could not be read.");
  }
  const realRoot = await fs.realpath(rootDir).catch(() => null);
  if (!realRoot) throw new Error("[ARTIFACT_UNREADABLE] Artifact could not be read.");
  const chain = [{ location: rootDir, expected: realRoot, stat: rootLstat }];

  let current = realRoot;
  let leafLstat: BigIntStats | null = null;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]!);
    const stat = await fs.lstat(current, { bigint: true });
    if (!stat || stat.isSymbolicLink()) throw new Error("[ARTIFACT_UNREADABLE] Artifact could not be read.");
    chain.push({ location: current, expected: current, stat });
    if (i < segments.length - 1) {
      if (!stat.isDirectory()) throw new Error("[ARTIFACT_UNREADABLE] Artifact could not be read.");
    } else {
      if (!stat.isFile()) throw new Error("[ARTIFACT_UNREADABLE] Artifact is not a file.");
      leafLstat = stat;
    }
  }
  if (!leafLstat) throw new Error("[ARTIFACT_UNREADABLE] Artifact could not be read.");

  async function verifyChain() {
    for (const { location, expected, stat } of chain) {
      const actual = await fs.lstat(location, { bigint: true });
      if (actual.isSymbolicLink() || actual.dev !== stat.dev || actual.ino !== stat.ino ||
          await fs.realpath(location) !== expected) throw new Error("[ARTIFACT_UNREADABLE] Artifact could not be read.");
    }
  }
  await verifyChain();
  const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  const handle = await fs.open(current, flags);
  try {
    const fstat = await handle.stat({ bigint: true });
    if (!fstat.isFile() || fstat.dev !== leafLstat.dev || fstat.ino !== leafLstat.ino) {
      throw new Error("[ARTIFACT_UNREADABLE] Artifact could not be read.");
    }
    await verifyChain();
    return await read(handle, current);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Splits and validates a relative POSIX artifact path into strict segments (rejecting backslashes). */
export function splitArtifactPath(relativePath: string): { cleaned: string; segments: string[] } {
  if (relativePath.length > MAX_REL_PATH_LEN || relativePath.includes("\\") || relativePath.includes("\0")) {
    throw new Error("[ARTIFACT_INVALID_PATH] Invalid artifact path.");
  }
  const cleaned = relativePath.replace(/^\/+/, "");
  if (!cleaned || cleaned.length > MAX_REL_PATH_LEN) {
    throw new Error("[ARTIFACT_INVALID_PATH] Invalid artifact path.");
  }
  const segments = cleaned.split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("[ARTIFACT_INVALID_PATH] Invalid artifact path.");
  }
  return { cleaned, segments };
}

export interface ScanBudget {
  dirsLeft: number;
  entriesLeft: number;
  lstatsLeft: number;
}

/** Reserve synchronously, before yielding to another worker. */
export function spend(budget: ScanBudget, key: keyof ScanBudget, count = 1): boolean {
  if (budget[key] < count) return false;
  budget[key] -= count;
  return true;
}

/** Walks up to depth 3 inside a conversation's brain dir with strict lstat and result caps. */
export async function scanBrainFiles(
  conversationId: string,
  owner: "main" | "subagent",
  ownerLabel: string | null,
  limit = 60,
  budget: ScanBudget = { dirsLeft: 24, entriesLeft: 300, lstatsLeft: 100 },
): Promise<AgentArtifactInfo[]> {
  const root = brainDir(conversationId);
  if (!budget.dirsLeft || !spend(budget, "lstatsLeft")) return [];
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return [];
  const found: AgentArtifactInfo[] = [];
  const realRoot = await fs.realpath(root).catch(() => null);
  if (!realRoot) return [];
  const maxCollect = Math.min(limit * 2, 100);

  async function walk(dir: string, depth: number): Promise<void> {
    if (!budget.entriesLeft || !budget.lstatsLeft || found.length >= maxCollect || !spend(budget, "dirsLeft")) return;
    const expected = path.join(realRoot!, path.relative(root, dir));
    if (await fs.realpath(dir).catch(() => null) !== expected) return;
    if (dir !== root && !spend(budget, "lstatsLeft")) return;
    const before = dir === root ? rootStat : await fs.lstat(dir).catch(() => null);
    if (!before?.isDirectory() || !spend(budget, "lstatsLeft")) return;
    const entries = await fs.opendir(dir).catch(() => null);
    if (!entries) return;
    try {
      const after = await fs.lstat(dir).catch(() => null);
      if (!after?.isDirectory() || after.dev !== before.dev || after.ino !== before.ino ||
          await fs.realpath(dir).catch(() => null) !== expected) return;
      while (budget.lstatsLeft && found.length < maxCollect && spend(budget, "entriesLeft")) {
        const entry = await entries.read();
        if (!entry) break;
        if (entry.isSymbolicLink() || isIgnoredArtifactName(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (rel.length > MAX_REL_PATH_LEN) continue;
        if (entry.isDirectory()) {
          if (depth < 3) await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!spend(budget, "lstatsLeft")) break;
        const stat = await fs.lstat(full).catch(() => null);
        if (!stat?.isFile() || await fs.realpath(full).catch(() => null) !== path.join(expected, entry.name)) continue;
        found.push({
          conversationId,
          owner,
          ownerLabel,
          path: rel,
          name: entry.name,
          size: stat.size,
          updatedAt: new Date(stat.mtimeMs).toISOString(),
          kind: classifyArtifactKind(entry.name),
          displayPath: displayPath(full),
        });
      }
    } finally {
      await entries.close();
    }
  }

  await walk(root, 0);
  return found.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, limit);
}

/** Index only string fields present in the prefix, including an unfinished content string. */
function reportPreview(prefix: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Skip nested objects, including generated render details. Stop a partial value
  // at the last complete JSON escape, so a split \uXXXX does not spoil the title.
  let depth = 0;
  const tokens = /[{}[\]]|"((?:[^"\\]|\\(?:u[\da-fA-F]{4}|["\\/bfnrt]))*)("?)/g;
  for (const match of prefix.matchAll(tokens)) {
    const token = match[0];
    if (token === "{" || token === "[") depth++;
    else if (token === "}" || token === "]") depth--;
    else if (depth === 1 && (match[1] === "content" || match[1] === "sender" || match[1] === "timestamp")) {
      const value = /^\s*:\s*"((?:[^"\\]|\\(?:u[\da-fA-F]{4}|["\\/bfnrt]))*)/.exec(prefix.slice(match.index + token.length));
      if (value) fields[match[1]] = JSON.parse('"' + value[1] + '"') as string;
    }
  }
  return fields;
}

interface IndexedHit {
  id: string;
  identifier: string;
  title: string;
  subtitle: string;
  conversationId: string;
  segments: string[];
  allowDotSegments: boolean;
  absPath: string;
  resourceType: "artifact" | "subagent-report";
  mtimeMs: number;
  searchText: string;
}

/** Runs async tasks with bounded concurrency. */
async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export class ArtifactReader {
  private searchIndexCache: { at: number; rootMtime: number; hits: IndexedHit[] } | null = null;
  private buildingIndex: Promise<{ hits: IndexedHit[]; readStats: number }> | null = null;
  private readonly directoryTimes = new Map<string, number>();
  private refreshCursor = 0;
  private moreDirectories = false;

  constructor(
    private readonly context: ContextReader,
    private readonly subagents: SubagentReader,
  ) {}

  /** Lists artifacts for an Antigravity agent (main conversation + all of its subagents). */
  async list(paseo: PaseoApi, agentId: string): Promise<{ conversationId: string | null; items: AgentArtifactInfo[] }> {
    const info = await this.context.conversationOf(paseo, agentId, { fresh: true });
    const conversationId = info?.conversationId;
    if (!conversationId) return { conversationId: null, items: [] };
    const budget = { dirsLeft: 32, entriesLeft: 600, lstatsLeft: 200 };
    const subList = await this.subagents.list(paseo, agentId, { budget, expectedConversationId: conversationId })
      .catch(() => ({ conversationId, subagents: [] }));
    if (subList.conversationId !== conversationId) return { conversationId: subList.conversationId, items: [] };
    const conversations = [null, ...subList.subagents];
    const groups = await mapConcurrent(conversations, 4, async (sub) => {
      if (!sub) return scanBrainFiles(conversationId, "main", null, 80, budget);
      if (!budget.dirsLeft || !budget.entriesLeft || !budget.lstatsLeft) return [];
      if (!await this.subagents.isVerifiedChild(paseo, agentId, sub.id, budget, conversationId, subList)) return [];
      return scanBrainFiles(sub.id, "subagent", sub.role ?? sub.type ?? sub.id.slice(0, 8), 30, budget);
    });
    const items = groups
      .flat()
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, MAX_LIST_ITEMS);
    const latest = await this.context.conversationOf(paseo, agentId, { fresh: true });
    if (latest?.conversationId !== conversationId) return { conversationId: latest?.conversationId ?? null, items: [] };
    return { conversationId, items };
  }

  /** Reads an artifact belonging to the agent's main conversation or one of its verified subagents. */
  async read(
    paseo: PaseoApi,
    agentId: string,
    conversationId: string,
    relativePath: string,
  ): Promise<{
    path: string;
    displayPath: string;
    kind: ArtifactKind;
    size: number;
    content: string | null;
    dataUri: string | null;
    truncated: boolean;
    tooLarge: boolean;
  }> {
    if (!UUID.test(conversationId)) throw new Error("[ARTIFACT_INVALID_PATH] Invalid conversation id.");
    const info = await this.context.conversationOf(paseo, agentId, { fresh: true });
    if (!info?.conversationId) throw new Error("[ARTIFACT_NO_CONVERSATION] No conversation found for this agent.");
    if (conversationId !== info.conversationId) {
      const verified = await this.subagents.isVerifiedChild(paseo, agentId, conversationId, undefined, info.conversationId);
      if (!verified) {
        throw new Error("[ARTIFACT_NOT_OWNED] That artifact does not belong to this agent.");
      }
    }
    const { cleaned, segments } = splitArtifactPath(relativePath);
    const root = brainDir(conversationId);
    const kind = classifyArtifactKind(cleaned);
    const limit = kind === "image" ? MAX_IMAGE_BYTES : kind === "binary" ? 0 : MAX_TEXT_BYTES;
    const result = await readSafeRelativeFile(root, segments, limit, { rejectIfTooLarge: kind === "image" });
    const latest = await this.context.conversationOf(paseo, agentId, { fresh: true });
    if (latest?.conversationId !== info.conversationId) {
      throw new Error("[ARTIFACT_NOT_OWNED] That artifact does not belong to this agent.");
    }

    if (kind === "image") {
      const shownPath = displayPath(result.realPath);
      if (result.tooLarge) {
        return {
          path: cleaned,
          displayPath: shownPath,
          kind,
          size: result.size,
          content: null,
          dataUri: null,
          truncated: false,
          tooLarge: true,
        };
      }
      const mime = IMAGE_MIME[path.extname(cleaned).toLowerCase()] ?? "image/png";
      return {
        path: cleaned,
        displayPath: shownPath,
        kind,
        size: result.size,
        content: null,
        dataUri: `data:${mime};base64,${result.buffer.toString("base64")}`,
        truncated: false,
        tooLarge: false,
      };
    }

    if (kind === "binary") {
      return {
        path: cleaned,
        displayPath: displayPath(result.realPath),
        kind,
        size: result.size,
        content: null,
        dataUri: null,
        truncated: false,
        tooLarge: false,
      };
    }

    return {
      path: cleaned,
      displayPath: displayPath(result.realPath),
      kind,
      size: result.size,
      content: decodeTextPrefix(result),
      dataUri: null,
      truncated: result.truncated,
      tooLarge: false,
    };
  }

  private async getSearchIndex() {
    const rootMtime = (await fs.stat(path.join(REAL_CLI_DIR, "brain")).catch(() => null))?.mtimeMs ?? 0;
    if (!this.moreDirectories && this.searchIndexCache?.rootMtime === rootMtime &&
        Date.now() - this.searchIndexCache.at < SEARCH_INDEX_TTL_MS) {
      return { hits: this.searchIndexCache.hits, readStats: MAX_SEARCH_RESULTS * 15 };
    }
    this.buildingIndex ??= this.buildSearchIndex()
      .then((result) => {
        this.searchIndexCache = { at: Date.now(), rootMtime, hits: result.hits };
        return result;
      })
      .finally(() => {
        this.buildingIndex = null;
      });
    return this.buildingIndex;
  }

  private async buildSearchIndex() {
    const root = path.join(REAL_CLI_DIR, "brain");
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const ids = entries.filter(e => e.isDirectory() && UUID.test(e.name)).map(e => e.name);
    const present = new Set(ids);
    for (const id of this.directoryTimes.keys()) {
      if (!present.has(id)) this.directoryTimes.delete(id);
    }

    // New directories come first. Rotate through known ones so changes to an old
    // directory can move it into the recent set without opening its contents.
    const unknown = ids.filter(id => !this.directoryTimes.has(id));
    const known = ids.filter(id => this.directoryTimes.has(id));
    const cursor = this.refreshCursor % (known.length || 1);
    const probe = [...unknown, ...known.slice(cursor), ...known.slice(0, cursor)].slice(0, 500);
    await mapConcurrent(probe, SEARCH_CONCURRENCY, async id => {
      const stat = await fs.lstat(path.join(root, id)).catch(() => null);
      if (stat?.isDirectory()) this.directoryTimes.set(id, stat.mtimeMs);
      else this.directoryTimes.delete(id);
    });
    this.refreshCursor = cursor + Math.max(0, probe.length - unknown.length);
    this.moreDirectories = unknown.length > probe.length;
    const recent = [...this.directoryTimes].sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SEARCH_BRAINS).map(([id]) => ({ id }));
    // Reserve space for actual attachment reads even after a 500-directory cold probe.
    const scanStats = Math.min(220, 600 - probe.length - 30);
    const budget = { dirsLeft: 19, entriesLeft: 3000, lstatsLeft: scanStats };
    const metaByConv = await readConversationMeta(recent.map((c) => c.id));

    let reportBytesLeft = 512 * 1024;
    const groups = await mapConcurrent(recent, SEARCH_CONCURRENCY, async ({ id }) => {
      const perConv: IndexedHit[] = [];
      const root = brainDir(id);
      const meta = metaByConv.get(id);
      const convTitle = meta?.title ?? meta?.workspaceName ?? id.slice(0, 8);
      const files = await scanBrainFiles(id, "main", null, 40, budget);
      for (const file of files) {
        if (file.kind === "binary" || file.kind === "image" || file.size === 0 || file.size > 512 * 1024) continue;
        const segments = file.path.split("/");
        const absPath = path.join(root, ...segments);
        const subtitle = [convTitle, file.path !== file.name ? file.path : null].filter(Boolean).join(" · ");
        perConv.push({
          id: `artifact:${id}:${file.path}`,
          identifier: file.name,
          title: file.name,
          subtitle,
          conversationId: id,
          segments,
          allowDotSegments: false,
          absPath,
          resourceType: "artifact",
          mtimeMs: Date.parse(file.updatedAt) || 0,
          searchText: `${file.name} ${file.path} ${convTitle} ${meta?.workspaceName ?? ""} ${id}`.toLowerCase(),
        });
      }

      // Collect the 8 newest subagent report files by mtime AFTER filtering out read.json and symlinks.
      const msgDir = path.join(root, ".system_generated", "messages");
      if (!budget.dirsLeft || !spend(budget, "lstatsLeft")) return perConv;
      const msgDirStat = await fs.lstat(msgDir).catch(() => null);
      if (msgDirStat?.isDirectory() && spend(budget, "dirsLeft")) {
        const msgEntries = await fs.opendir(msgDir).catch(() => null);
        const msgFiles: Array<{ name: string; mtimeMs: number; size: number }> = [];
        if (!msgEntries) return perConv;
        for await (const entry of msgEntries) {
          if (!spend(budget, "entriesLeft") || !budget.lstatsLeft) break;
          if (entry.isSymbolicLink() || !entry.isFile()) continue;
          if (!entry.name.endsWith(".json") || entry.name === "read.json") continue;
          if (!spend(budget, "lstatsLeft")) break;
          const stat = await fs.lstat(path.join(msgDir, entry.name)).catch(() => null);
          if (stat?.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 256 * 1024) {
            // Reserve verification reads as soon as a preview slot is filled. Other
            // workers can exhaust the directory scan budget before this inbox closes.
            if (msgFiles.length < 8 && !spend(budget, "lstatsLeft", 12)) break;
            msgFiles.push({ name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size });
            msgFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
            if (msgFiles.length > 8) msgFiles.pop();
          }
        }
        for (const { name: msgName, mtimeMs, size } of msgFiles) {
          const segments = [".system_generated", "messages", msgName];
          try {
            // Read only a small prefix for metadata indexing; full text is loaded only for matched winners.
            const allowance = Math.min(4096, size, reportBytesLeft);
            if (!allowance) break;
            reportBytesLeft -= allowance;
            const raw = await readSafeRelativeFile(root, segments, allowance, { allowDotSegments: true });
            const parsed = reportPreview(decodeTextPrefix(raw));
            const content = parsed.content?.trim() ?? "";
            if (content.length < 40) continue;
            const sender = typeof parsed?.sender === "string" ? parsed.sender : msgName.replace(/\.json$/, "");
            const firstLine =
              content
                .split(/\r?\n/)
                .map((line) => line.replace(/^#+\s*/, "").trim())
                .find((line) => line.length > 0)
                ?.slice(0, 80) ?? sender.slice(0, 8);
            const parsedTime = typeof parsed?.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
            perConv.push({
              id: `report:${id}:${msgName}`,
              identifier: `report-${sender.slice(0, 8)}`,
              title: firstLine,
              subtitle: `${convTitle} · ${sender.slice(0, 8)}`,
              conversationId: id,
              segments,
              allowDotSegments: true,
              absPath: raw.realPath,
              resourceType: "subagent-report",
              mtimeMs: Number.isFinite(parsedTime) ? parsedTime : mtimeMs,
              searchText: `${firstLine} report subagent ${convTitle} ${meta?.workspaceName ?? ""} ${content.slice(0, 300)}`.toLowerCase(),
            });
          } catch {
            // Skip malformed or unreadable report files.
          }
        }
      }

      return perConv;
    });

    return { hits: groups.flat(), readStats: 600 - probe.length - (scanStats - budget.lstatsLeft) };
  }

  /**
   * Searches recent Antigravity brain artifacts and subagent reports for the composer attachment picker.
   */
  async searchAttachments(query: string): Promise<{
    items: Array<{
      id: string;
      identifier: string;
      title: string;
      subtitle?: string;
      url: string;
      text: string;
      resourceType: string;
    }>;
  }> {
    const { hits, readStats } = await this.getSearchIndex();
    const terms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const matched = hits
      .filter((hit) => terms.every((term) => hit.searchText.includes(term)))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_SEARCH_RESULTS);

    let statsLeft = readStats;
    const loaded = await mapConcurrent(matched, SEARCH_CONCURRENCY, async (hit) => {
      const cost = 3 * (hit.segments.length + 1);
      if (statsLeft < cost) return null;
      statsLeft -= cost;
      const root = brainDir(hit.conversationId);
      try {
        let body = "";
        let truncated = false;
        let realPath = hit.absPath;
        if (hit.resourceType === "subagent-report") {
          const raw = await readSafeRelativeFile(root, hit.segments, 256 * 1024, { allowDotSegments: true });
          if (raw.truncated) return null;
          const parsed = JSON.parse(raw.buffer.toString("utf8")) as { content?: unknown };
          const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
          if (!content) return null;
          body = content;
          realPath = raw.realPath;
        } else {
          const raw = await readSafeRelativeFile(root, hit.segments, MAX_ATTACHMENT_TEXT_BYTES, {
            allowDotSegments: false,
          });
          body = new TextDecoder("utf-8", { fatal: true }).decode(raw.buffer, { stream: raw.truncated });
          truncated = raw.truncated;
          realPath = raw.realPath;
          if (!body.trim()) return null;
        }
        const header = `[${hit.title} · ${displayPath(realPath)}]\n\n`;
        const marker = "\n\n[…]";
        const available = MAX_ATTACHMENT_TEXT_BYTES - Buffer.byteLength(header);
        if (available <= Buffer.byteLength(marker)) return null;
        truncated ||= Buffer.byteLength(body) > available;
        const text = header + truncateUtf8Bytes(body, available - (truncated ? Buffer.byteLength(marker) : 0)).text
          + (truncated ? marker : "");
        return {
          id: hit.id,
          identifier: hit.identifier,
          title: hit.title,
          subtitle: hit.subtitle,
          url: pathToFileURL(realPath).href,
          text,
          resourceType: hit.resourceType,
        };
      } catch {
        return null;
      }
    });

    return {
      items: loaded.filter((item): item is NonNullable<typeof item> => item !== null),
    };
  }
}
