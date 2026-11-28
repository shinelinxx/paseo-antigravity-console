import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RECOVERY_FOLDER_NAME } from "../shared/contracts";

/** The daemon user's real home. agy keeps the system sign-in's data in `<home>/.gemini`. */
export const REAL_HOME = os.homedir();
export const REAL_GEMINI = path.join(REAL_HOME, ".gemini");
/** agy's default app-data directory (`--app-data-dir antigravity-cli`). */
export const REAL_CLI_DIR = path.join(REAL_GEMINI, "antigravity-cli");
/** agy's settings: default model, Orchestrator planner and executor, trusted folders and more. */
export const REAL_SETTINGS_FILE = path.join(REAL_CLI_DIR, "settings.json");

/**
 * Directories under antigravity-cli that hold conversation state. Every profile links these to the
 * real ones, so a conversation started on one account can be reopened on another.
 */
export const SHARED_CLI_DIRS = ["conversations", "brain", "implicit"] as const;

/** Files agents saved in a removed account's HOME are moved here, one folder per account. */
export const RECOVERY_DIR = path.join(REAL_HOME, RECOVERY_FOLDER_NAME);

/** A path for people to read: inside the real home it starts with `~`. */
export function displayPath(file: string): string {
  return file === REAL_HOME || file.startsWith(REAL_HOME + path.sep)
    ? "~" + file.slice(REAL_HOME.length)
    : file;
}

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(REAL_HOME, ".paseo");
}

export function dataDir(): string {
  return path.join(paseoHome(), "plugin-data", "antigravity-accounts");
}

export function storeFile(): string {
  return path.join(dataDir(), "accounts.json");
}

export function profileRoot(accountId: string): string {
  return path.join(dataDir(), "profiles", accountId);
}

/** The HOME an account's agy processes run with. */
export function profileHome(accountId: string): string {
  return path.join(profileRoot(accountId), "home");
}

export function profileCliDir(accountId: string): string {
  return path.join(profileHome(accountId), ".gemini", "antigravity-cli");
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    await fs.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The command Paseo itself launches for the built-in provider, when config.json overrides it. */
async function configuredAgyCommand(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(paseoHome(), "config.json"), "utf8");
    const config = JSON.parse(raw) as {
      agents?: { providers?: Record<string, { command?: unknown }> };
    };
    const command = config.agents?.providers?.antigravity?.command;
    if (Array.isArray(command) && typeof command[0] === "string" && command[0].trim()) {
      return command[0].trim();
    }
  } catch {
    // No config or unreadable config: fall back to PATH lookup.
  }
  return null;
}

const IS_WINDOWS = process.platform === "win32";

function winExecutableExtensions(): string[] {
  const raw = process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  const exts = raw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
  return exts.length ? exts : [".exe", ".cmd", ".bat", ".com"];
}

function expandExecutableCandidates(base: string): string[] {
  if (!IS_WINDOWS) return [base];
  const ext = path.extname(base).toLowerCase();
  const exts = winExecutableExtensions();
  if (ext && exts.includes(ext)) return [base];
  return [...exts.map((suffix) => `${base}${suffix}`), base];
}

/** Finds the agy executable the same way a user would expect: config override, PATH, usual installs. */
export async function resolveAgy(): Promise<string | null> {
  const candidates: string[] = [];
  const configured = await configuredAgyCommand();
  const configuredHasSep = Boolean(configured && (configured.includes("/") || (IS_WINDOWS && configured.includes("\\"))));
  if (configured) {
    if (path.isAbsolute(configured)) candidates.push(...expandExecutableCandidates(configured));
    else if (configuredHasSep) candidates.push(...expandExecutableCandidates(path.resolve(REAL_HOME, configured)));
  }
  const name = configured && !configuredHasSep ? configured : "agy";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(...expandExecutableCandidates(path.join(dir, name)));
  }
  if (IS_WINDOWS) {
    const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(REAL_HOME, "AppData", "Local");
    candidates.push(
      path.join(localAppData, "agy", "bin", "agy.exe"),
      path.join(REAL_HOME, ".local", "bin", "agy.exe"),
      path.join(REAL_HOME, ".local", "bin", "agy.cmd"),
    );
  } else {
    candidates.push(
      path.join(REAL_HOME, ".local", "bin", "agy"),
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy",
    );
  }
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}
