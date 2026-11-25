import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { commandEnv } from "./agy";
import { profileCliDir, profileHome } from "./paths";

const URL_PATTERN = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/;
const CALLBACK_ORIGIN = "https://antigravity.google";
const FILE_STORAGE_LOG =
  /Using file-based token storage because (?:AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set|SSH session detected)/;
const PENDING_TTL_MS = 10 * 60 * 1000;
const URL_WAIT_MS = 45_000;
const SUBMIT_WAIT_MS = 90_000;

/** Prefix used when pasted input is rejected locally so the client knows the sign-in session is still alive. */
export const RETRYABLE_INPUT_PREFIX = "Invalid input: ";

interface PendingSignIn {
  loginId: string;
  accountId: string;
  child: ChildProcessWithoutNullStreams;
  output: string;
  url: string;
  state: string | null;
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
  exited: Promise<number | null>;
  submitting: boolean;
}

export interface SubmitOutcome {
  /** True when agy exited 0 after the code; false when it is still running and was stopped. */
  exitedCleanly: boolean;
  /** Milliseconds since epoch just before the code was sent, for the credential scan. */
  submittedAt: number;
}

function redact(text: string): string {
  return text
    .replace(/https:\/\/\S+/g, "<url>")
    .replace(/\b[\w./~-]{40,}\b/g, "<redacted>")
    .trim();
}

function tail(text: string, lines = 6): string {
  return redact(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
}

function inputError(message: string): Error {
  return new Error(`${RETRYABLE_INPUT_PREFIX}${message}`);
}

/**
 * Validates what the user pasted: the code Google's page shows, or the full URL of that page.
 * Rejects anything with line breaks so nothing else can be typed into agy.
 */
export function normalizeSignInResponse(pending: { state: string | null }, raw: string): string {
  const value = raw.trim();
  if (/[\r\n]/.test(value)) throw inputError("Paste a single line: the code or the page URL.");
  // Raw OAuth codes may carry `/`, `+`, `=`, `-`, `_`, `~`, `.` or percent-encoded characters like `%2F`.
  if (/^[\w./~+%=-]{1,2048}$/.test(value) && !/^https?:/i.test(value)) {
    if (value.includes("%")) {
      try {
        const decoded = decodeURIComponent(value);
        if (!/[\r\n]/.test(decoded) && /^[\w./~+=-]{1,2048}$/.test(decoded)) return decoded;
      } catch {
        // Leave as-is if not valid percent-encoding.
      }
    }
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw inputError("That is neither a sign-in code nor the URL of the Antigravity page.");
  }
  if (url.origin !== CALLBACK_ORIGIN) {
    throw inputError("Paste the URL of the antigravity.google page Google sent you to.");
  }
  if (!url.searchParams.get("code")) throw inputError("That URL carries no code.");
  const state = url.searchParams.get("state");
  if (pending.state && state && state !== pending.state) {
    throw new Error("That URL belongs to a different sign-in. Start again.");
  }
  return value;
}

const FILE_STORAGE_LOG_WAIT_MS = 1000;
const FILE_STORAGE_LOG_POLL_MS = 50;

async function confirmFileStorageLog(logFile: string): Promise<boolean> {
  const deadline = Date.now() + FILE_STORAGE_LOG_WAIT_MS;
  while (true) {
    const startupLog = await fs.readFile(logFile, "utf8").catch(() => "");
    if (FILE_STORAGE_LOG.test(startupLog)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, FILE_STORAGE_LOG_POLL_MS));
  }
}

/** Runs `agy acp --login` per profile and relays the code the user pastes. */
export class SignInManager {
  private readonly pending = new Map<string, PendingSignIn>();

  async start(agyPath: string, accountId: string): Promise<{ loginId: string; url: string; expiresAt: string }> {
    for (const existing of this.pending.values()) {
      if (existing.accountId === accountId) this.cancel(existing.loginId);
    }
    const loginId = randomUUID();
    const logDir = path.join(profileCliDir(accountId), "log");
    await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(logDir, `acp-login-${loginId}.log`);
    const child = spawn(agyPath, ["acp", "--disable-telemetry", "--login", "--log-file", logFile], {
      cwd: profileHome(accountId),
      env: commandEnv(accountId),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // An exited or cancelled process can close its pipe while a code is being written.
    child.stdin.on("error", () => child.kill("SIGTERM"));
    let output = "";
    const exited = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });
    const url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        child.off("error", onError);
      };
      const done = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const timer = setTimeout(() => {
        done(() => {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
          reject(new Error(`agy did not print a sign-in link within ${URL_WAIT_MS / 1000} seconds. ${tail(output)}`));
        });
      }, URL_WAIT_MS);
      const onData = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > 64 * 1024) output = output.slice(-32 * 1024);
        const match = URL_PATTERN.exec(output);
        if (match) done(() => resolve(match[0]));
      };
      const onError = (error: Error) => {
        done(() => reject(new Error(`Could not start agy: ${error.message}`)));
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", onError);
      void exited.then((code) => {
        done(() =>
          reject(new Error(`agy exited (code ${String(code)}) before printing a sign-in link. ${tail(output)}`)),
        );
      });
    });
    // agy logs its choice before requesting the code. Do not open an OAuth flow against the keyring.
    if (!(await confirmFileStorageLog(logFile))) {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
      throw new Error("agy did not confirm file-backed sign-in. The authorization was stopped before accepting a code.");
    }
    let state: string | null = null;
    try {
      state = new URL(url).searchParams.get("state");
    } catch {
      state = null;
    }
    const expiresAt = Date.now() + PENDING_TTL_MS;
    const entry: PendingSignIn = {
      loginId,
      accountId,
      child,
      output,
      url,
      state,
      expiresAt,
      expiryTimer: setTimeout(() => this.cancel(loginId), PENDING_TTL_MS),
      exited,
      submitting: false,
    };
    entry.expiryTimer.unref?.();
    const keep = (chunk: Buffer) => {
      entry.output += chunk.toString("utf8");
      if (entry.output.length > 64 * 1024) entry.output = entry.output.slice(-32 * 1024);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    void exited.then(() => {
      if (!entry.submitting) this.drop(loginId);
    });
    this.pending.set(loginId, entry);
    return { loginId, url, expiresAt: new Date(expiresAt).toISOString() };
  }

  accountOf(loginId: string): string | undefined {
    return this.pending.get(loginId)?.accountId;
  }

  /**
   * Sends the code. Resolves when agy exits 0, or after SUBMIT_WAIT_MS with exitedCleanly=false so
   * the caller can check the sign-in itself. Rejects with agy's message when it exits non-zero.
   */
  async submit(loginId: string, raw: string): Promise<SubmitOutcome> {
    const entry = this.pending.get(loginId);
    if (!entry) throw new Error("This sign-in expired or was cancelled. Start again.");
    if (entry.submitting) throw new Error("This sign-in is already being completed.");
    // Local validation throws before touching the child process so the user can fix a bad paste.
    const response = normalizeSignInResponse(entry, raw);
    entry.submitting = true;
    const before = entry.output.length;
    const submittedAt = Date.now() - 5000;
    let timer: NodeJS.Timeout | undefined;
    try {
      entry.child.stdin.write(`${response}\n`);
      const code = await Promise.race([
        entry.exited,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), SUBMIT_WAIT_MS);
        }),
      ]);
      if (code === "timeout") {
        entry.child.kill("SIGTERM");
        const kill = setTimeout(() => entry.child.kill("SIGKILL"), 2000);
        await entry.exited;
        clearTimeout(kill);
        return { exitedCleanly: false, submittedAt };
      }
      if (code !== 0) {
        const message = tail(entry.output.slice(before)) || `agy exited with code ${String(code)}`;
        throw new Error(`Sign-in failed: ${message}`);
      }
      return { exitedCleanly: true, submittedAt };
    } finally {
      clearTimeout(timer);
      this.drop(loginId);
    }
  }

  cancel(loginId: string): void {
    const entry = this.pending.get(loginId);
    if (!entry) return;
    entry.child.kill("SIGTERM");
    setTimeout(() => entry.child.kill("SIGKILL"), 2000).unref?.();
    this.drop(loginId);
  }

  cancelForAccount(accountId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.accountId === accountId) this.cancel(entry.loginId);
    }
  }

  cancelAll(): void {
    for (const loginId of [...this.pending.keys()]) this.cancel(loginId);
  }

  private drop(loginId: string): void {
    const entry = this.pending.get(loginId);
    if (!entry) return;
    clearTimeout(entry.expiryTimer);
    this.pending.delete(loginId);
  }
}
