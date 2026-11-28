import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SYSTEM_ACCOUNT_ID, type QuotaGroup } from "../shared/contracts";
import { REAL_CLI_DIR, profileCliDir, profileHome } from "./paths";

/** Older agy builds select file-backed sign-in in an SSH session. */
export const FAKE_SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0";

const IS_WINDOWS = process.platform === "win32";

/**
 * Profile accounts use their own data directory and explicitly select file-backed sign-in.
 * SSH_CONNECTION also supports older agy builds that select file storage in SSH sessions.
 * On Windows, agy uses USERPROFILE rather than HOME to locate `.gemini/antigravity-cli`.
 * ANTIGRAVITY_HOME is ignored by agy, but Paseo's built-in usage source reads it to show the quota
 * of the account the agent runs on.
 */
export function sessionEnv(accountId: string, current: Readonly<Record<string, string>>): Record<string, string> {
  if (accountId === SYSTEM_ACCOUNT_ID) return {};
  const home = profileHome(accountId);
  return {
    HOME: home,
    ...(IS_WINDOWS ? { USERPROFILE: home } : {}),
    SSH_CONNECTION: current.SSH_CONNECTION || FAKE_SSH_CONNECTION,
    AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
    ANTIGRAVITY_HOME: profileCliDir(accountId),
  };
}

/** Full environment for the plugin's own agy calls (probes and sign-in). */
export function commandEnv(accountId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) base[key] = value;
  Object.assign(env, sessionEnv(accountId, base));
  // Never let a probe or sign-in open a browser on the daemon host or update the CLI.
  env.BROWSER = IS_WINDOWS ? "cmd /c exit 1" : "/usr/bin/false";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  return env;
}

export function accountHome(accountId: string): string {
  return accountId === SYSTEM_ACCOUNT_ID ? os.homedir() : profileHome(accountId);
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when `stopWhen` matched and the process was stopped early. */
  stopped: boolean;
}

/** Runs agy with stdin closed, a byte cap, and a hard timeout. */
export function runAgy(
  agyPath: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; stopWhen?: RegExp },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(agyPath, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stopped = false;
    let killTimer: NodeJS.Timeout | undefined;
    const cap = 4 * 1024 * 1024;
    const terminate = () => {
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
        killTimer.unref();
      }
    };
    const check = () => {
      if (stopped || !options.stopWhen) return;
      if (options.stopWhen.test(stdout) || options.stopWhen.test(stderr)) {
        stopped = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString("utf8");
      check();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString("utf8");
      check();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut, stopped });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut, stopped });
    });
  });
}

export async function agyVersion(agyPath: string): Promise<string | null> {
  const result = await runAgy(agyPath, ["--version"], {
    env: commandEnv(SYSTEM_ACCOUNT_ID),
    cwd: os.tmpdir(),
    timeoutMs: 8000,
  });
  return /\b\d+\.\d+\.\d+\S*/.exec(result.stdout)?.[0] ?? null;
}

const usageResponse = z.object({
  status: z.string(),
  error: z.string().optional(),
  response: z.string().optional(),
  command: z
    .object({
      name: z.string(),
      data: z.object({
        groups: z.array(
          z.object({
            name: z.string(),
            buckets: z.array(
              z.object({
                id: z.string().min(1),
                name: z.string(),
                window: z.string(),
                remaining_fraction: z.number().min(0).max(1).nullish(),
                reset_time: z.string().nullish(),
                disabled: z.boolean().optional(),
              }),
            ),
          }),
        ),
      }),
    })
    .optional(),
});

export type ProbeResult =
  | { kind: "signed-in"; quota: QuotaGroup[] }
  | { kind: "signed-out"; detail: string }
  | { kind: "error"; detail: string };

const SIGN_IN_TEXT = /(authentication required|authentication failed|not signed in|sign in|log in|login)/i;
/** agy prints this and then waits up to 60 s for a code; there is no point waiting. */
export const NEEDS_SIGN_IN = /Authentication required|paste the authorization code/i;

function firstMeaningfulLine(text: string): string {
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0 && !value.startsWith("https://"));
  return (line ?? "").slice(0, 300);
}

/** Reads an account's quota with `agy -p /usage`, which also tells whether it is signed in. */
export async function probeAccount(agyPath: string, accountId: string, timeoutMs = 25_000): Promise<ProbeResult> {
  const result = await runAgy(agyPath, ["-p", "/usage", "--output-format", "json"], {
    env: commandEnv(accountId),
    cwd: accountId === SYSTEM_ACCOUNT_ID ? os.tmpdir() : profileHome(accountId),
    timeoutMs,
    stopWhen: NEEDS_SIGN_IN,
  });
  if (result.stopped) return { kind: "signed-out", detail: "Not signed in" };
  const stdout = result.stdout.trim();
  const jsonStart = stdout.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = usageResponse.parse(JSON.parse(stdout.slice(jsonStart)));
      if (parsed.status === "SUCCESS" && parsed.command?.name === "usage") {
        return {
          kind: "signed-in",
          quota: parsed.command.data.groups.map((group) => ({
            name: group.name,
            buckets: group.buckets.map((bucket) => ({
              id: bucket.id,
              name: bucket.name,
              window: bucket.window,
              remainingFraction: bucket.remaining_fraction ?? null,
              // Unused buckets report the Unix epoch instead of a reset time.
              resetTime: bucket.reset_time && !bucket.reset_time.startsWith("1970-01-01") ? bucket.reset_time : null,
              disabled: bucket.disabled === true,
            })),
          })),
        };
      }
      const detail = parsed.error || parsed.response || `agy reported ${parsed.status}`;
      if (SIGN_IN_TEXT.test(detail)) return { kind: "signed-out", detail: firstMeaningfulLine(detail) };
      return { kind: "error", detail: firstMeaningfulLine(detail) };
    } catch {
      // Fall through to the text checks below.
    }
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (SIGN_IN_TEXT.test(combined)) {
    return { kind: "signed-out", detail: "Not signed in" };
  }
  if (result.timedOut) return { kind: "error", detail: `agy did not answer within ${Math.ceil(timeoutMs / 1000)} seconds` };
  return {
    kind: "error",
    detail: firstMeaningfulLine(combined) || `agy exited with code ${String(result.code)}`,
  };
}

export interface AccountPlan {
  /** agy's tier id, for example "g1-pro-tier". */
  id: string;
  /** The plan's name, for example "Google AI Pro". */
  name: string;
}

const PLAN_TIMEOUT_MS = 15_000;
/** The consumer Google sign-in, the one agy uses for Google AI plans. */
const PERSONAL_SIGN_IN = "oauth-personal";

const acpInitialize = z.object({
  agentCapabilities: z.object({
    _meta: z.object({ antigravity: z.object({ tier: z.literal(true) }) }),
  }),
  authMethods: z.array(z.object({ id: z.string() })),
});

const acpAuthenticate = z.object({
  _meta: z.object({
    antigravity: z.object({ tier: z.object({ id: z.string(), name: z.string().trim().min(1) }) }),
  }),
});

/**
 * The Google AI plan of a signed-in account, for example "Google AI Ultra". `/usage` does not
 * report it. agy's ACP server advertises `_meta.antigravity.tier` and answers `authenticate` with
 * the account's tier, reusing the stored sign-in. For a signed-out account `authenticate` would
 * start a sign-in instead, so call this only after the quota probe found the account signed in.
 * Returns null when agy does not report a plan.
 */
export function readPlan(agyPath: string, accountId: string): Promise<AccountPlan | null> {
  return new Promise((resolve) => {
    const child = spawn(agyPath, ["acp", "--disable-telemetry"], {
      cwd: accountId === SYSTEM_ACCOUNT_ID ? os.tmpdir() : profileHome(accountId),
      env: commandEnv(accountId),
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    let settled = false;
    let exited = false;
    let stdout = "";
    let stderr = "";
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => finish(null), PLAN_TIMEOUT_MS);
    function finish(plan: AccountPlan | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      if (!exited) {
        child.kill("SIGTERM");
        if (!killTimer) {
          killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
          killTimer.unref();
        }
      }
      resolve(plan);
    }
    function send(id: number, method: string, params: unknown) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    }
    function answer(message: { id?: unknown; result?: unknown }) {
      if (message.id === 1) {
        const init = acpInitialize.safeParse(message.result);
        if (!init.success || !init.data.authMethods.some((method) => method.id === PERSONAL_SIGN_IN)) {
          finish(null);
          return;
        }
        send(2, "authenticate", { methodId: PERSONAL_SIGN_IN });
      } else if (message.id === 2) {
        const auth = acpAuthenticate.safeParse(message.result);
        finish(auth.success ? auth.data._meta.antigravity.tier : null);
      }
    }
    child.on("error", () => {
      exited = true;
      clearTimeout(killTimer);
      finish(null);
    });
    child.on("close", () => {
      exited = true;
      clearTimeout(killTimer);
      finish(null);
    });
    child.stdin.on("error", () => finish(null));
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
      if (NEEDS_SIGN_IN.test(stderr)) finish(null);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      let newline = stdout.indexOf("\n");
      while (newline >= 0 && !settled) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
        if (!line.startsWith("{")) continue;
        try {
          answer(JSON.parse(line) as { id?: unknown; result?: unknown });
        } catch {
          // Not a JSON-RPC message.
        }
      }
      if (stdout.length > 1024 * 1024) finish(null);
    });
    send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
  });
}

const EMAIL_LINE = /authenticated successfully as (\S+@\S+)/g;
const LOG_CHUNK_BYTES = 64 * 1024;

/** Reads small logs in full, or the head and tail of large logs so memory stays bounded. */
async function readLogSample(filePath: string, size: number): Promise<string> {
  if (size <= LOG_CHUNK_BYTES * 2) return fs.readFile(filePath, "utf8");
  const handle = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(LOG_CHUNK_BYTES);
    const tail = Buffer.alloc(LOG_CHUNK_BYTES);
    const [headRead, tailRead] = await Promise.all([
      handle.read(head, 0, LOG_CHUNK_BYTES, 0),
      handle.read(tail, 0, LOG_CHUNK_BYTES, Math.max(0, size - LOG_CHUNK_BYTES)),
    ]);
    return `${head.toString("utf8", 0, headRead.bytesRead)}\n${tail.toString("utf8", 0, tailRead.bytesRead)}`;
  } finally {
    await handle.close();
  }
}

const emailCache = new Map<
  string,
  { newestFile: string; newestMtime: number; newestSize: number; email: string | null }
>();

/** The Google account agy last reported for this account, from its own logs. */
export async function readAccountEmail(accountId: string): Promise<string | null> {
  const logDir = path.join(
    accountId === SYSTEM_ACCOUNT_ID ? REAL_CLI_DIR : profileCliDir(accountId),
    "log",
  );
  let names: string[];
  try {
    names = await fs.readdir(logDir);
  } catch {
    emailCache.delete(logDir);
    return null;
  }
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".log"))
      .map(async (name) => {
        const full = path.join(logDir, name);
        const stat = await fs.stat(full).catch(() => null);
        return stat?.isFile() ? { full, mtime: stat.mtimeMs, size: stat.size } : null;
      }),
  );
  const recent = files
    .filter((file): file is { full: string; mtime: number; size: number } => file !== null)
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, 25);
  const newest = recent[0];
  if (!newest) {
    emailCache.delete(logDir);
    return null;
  }
  const cached = emailCache.get(logDir);
  if (
    cached &&
    cached.newestFile === newest.full &&
    cached.newestMtime === newest.mtime &&
    cached.newestSize === newest.size
  ) {
    return cached.email;
  }
  let email: string | null = null;
  for (const file of recent) {
    const text = await readLogSample(file.full, file.size).catch(() => "");
    let last: string | null = null;
    for (const match of text.matchAll(EMAIL_LINE)) last = match[1] ?? null;
    if (last) {
      email = last.replace(/[.,;)]+$/, "");
      break;
    }
  }
  emailCache.set(logDir, {
    newestFile: newest.full,
    newestMtime: newest.mtime,
    newestSize: newest.size,
    email,
  });
  return email;
}
