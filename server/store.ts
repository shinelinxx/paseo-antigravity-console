import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  SYSTEM_ACCOUNT_ID,
  accountWeightSchema,
  fallbackStrategySchema,
  orchestratorChoiceSchema,
  routingModeSchema,
} from "../shared/contracts";
import { storeFile } from "./paths";

const storedAccountSchema = z.object({
  id: z.string().regex(/^a[0-9a-f]{8}$/),
  label: z.string(),
  createdAt: z.string(),
  email: z.string().nullable().default(null),
  /** Sign-in files found in the profile after the last sign-in, relative to the profile HOME. */
  credentialFiles: z.array(z.string()).default([]),
  /** Set when a sign-in landed outside the profile; the account is not launched while set. */
  unsafeDetail: z.string().nullable().default(null),
  /** Whether automatic fallback may switch turns onto this account. */
  fallbackEnabled: z.boolean().default(true),
  /** Custom load-balancing weight; null infers from the Google AI plan (Ultra=20, Pro=1). */
  weight: accountWeightSchema.nullable().default(null),
  /** Per-account Orchestrator override; null inherits the global settings.json choice. */
  orchestrator: orchestratorChoiceSchema.nullable().default(null),
  /** Optional short note/tag for this account. */
  note: z.string().nullable().default(null),
});

const storeSchema = z.object({
  version: z.literal(1).default(1),
  defaultAccountId: z.string().default(SYSTEM_ACCOUNT_ID),
  systemLabel: z.string().default("System sign-in"),
  systemEmail: z.string().nullable().default(null),
  systemFallbackEnabled: z.boolean().default(true),
  systemWeight: accountWeightSchema.nullable().default(null),
  systemNote: z.string().nullable().default(null),
  /** Explicit display & fallback priority order of account ids (including "default"). */
  order: z.array(z.string()).default([]),
  accounts: z.array(storedAccountSchema).default([]),
  fallback: z
    .object({
      enabled: z.boolean().default(true),
      retries: z.number().int().min(0).max(3).default(2),
      strategy: fallbackStrategySchema.default("order"),
      preemptiveThreshold: z.number().min(0).max(0.5).default(0),
    })
    .default({ enabled: true, retries: 2, strategy: "order", preemptiveThreshold: 0 }),
  routing: z
    .object({
      mode: routingModeSchema.default("default"),
      reservePercent: z.number().int().min(0).max(50).default(10),
    })
    .default({ mode: "default", reservePercent: 10 }),
});

export type StoredAccount = z.infer<typeof storedAccountSchema>;
export type StoreData = z.infer<typeof storeSchema>;

/** Normalizes the priority order so every existing account id appears once. */
export function orderedAccountIds(data: Readonly<StoreData>): string[] {
  const valid = new Set<string>([SYSTEM_ACCOUNT_ID, ...data.accounts.map((account) => account.id)]);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of data.order) {
    if (valid.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  if (!seen.has(SYSTEM_ACCOUNT_ID)) {
    seen.add(SYSTEM_ACCOUNT_ID);
    result.push(SYSTEM_ACCOUNT_ID);
  }
  for (const account of data.accounts) {
    if (!seen.has(account.id)) {
      seen.add(account.id);
      result.push(account.id);
    }
  }
  return result;
}

/** Sanitizes parsed disk JSON field-by-field so one invalid optional field never discards the whole account list. */
function migrateLoadedStore(raw: unknown): { data: StoreData; unknownVersionError: Error | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("accounts.json root must be a JSON object");
  }
  const src = raw as Record<string, unknown>;
  const unknownVersionError = src.version !== undefined && src.version !== 1
    ? new Error("Unsupported accounts.json version. Accounts are read-only until the plugin is upgraded.")
    : null;
  const warnings: string[] = [];

  const sanitizeNote = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      warnings.push(`${field} was not a string and was reset`);
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > 80) {
      warnings.push(`${field} exceeded 80 chars and was truncated`);
      return trimmed.slice(0, 80);
    }
    return trimmed;
  };

  const accounts: StoredAccount[] = [];
  if (Array.isArray(src.accounts)) {
    for (let i = 0; i < src.accounts.length; i += 1) {
      const entry = src.accounts[i];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        warnings.push(`accounts[${i}] was malformed and skipped`);
        continue;
      }
      const item = entry as Record<string, unknown>;
      const orch = orchestratorChoiceSchema.nullable().safeParse(item.orchestrator ?? null);
      if (!orch.success) warnings.push(`accounts[${i}].orchestrator was invalid and reset`);
      const sanitized = {
        id: item.id,
        label: typeof item.label === "string" && item.label.trim() ? item.label : "Account",
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
        email: typeof item.email === "string" ? item.email : null,
        credentialFiles: Array.isArray(item.credentialFiles)
          ? item.credentialFiles.filter((file): file is string => typeof file === "string")
          : [],
        unsafeDetail: item.unsafeDetail == null || typeof item.unsafeDetail === "string"
          ? item.unsafeDetail ?? null
          : "Account disabled: corrupted safety metadata in accounts.json",
        fallbackEnabled: item.fallbackEnabled === undefined || item.fallbackEnabled === true,
        weight: accountWeightSchema.nullable().safeParse(item.weight ?? null).success ? (item.weight ?? null) : null,
        orchestrator: orch.success ? orch.data : null,
        note: sanitizeNote(item.note, `accounts[${i}].note`),
      };
      const parsed = storedAccountSchema.safeParse(sanitized);
      if (parsed.success) accounts.push(parsed.data);
      else warnings.push(`accounts[${i}] had an invalid id and was skipped`);
    }
  } else if (src.accounts !== undefined) {
    warnings.push("accounts was not an array and was reset");
  }

  const fbRaw =
    src.fallback && typeof src.fallback === "object" && !Array.isArray(src.fallback)
      ? (src.fallback as Record<string, unknown>)
      : { enabled: src.fallback === undefined };
  const enabled = fbRaw.enabled === undefined || fbRaw.enabled === true;
  if (fbRaw.enabled !== undefined && typeof fbRaw.enabled !== "boolean") {
    warnings.push("fallback.enabled was invalid and reset");
  }
  const retries =
    typeof fbRaw.retries === "number" && Number.isInteger(fbRaw.retries) && fbRaw.retries >= 0 && fbRaw.retries <= 3
      ? fbRaw.retries
      : 2;
  if (fbRaw.retries !== undefined && retries !== fbRaw.retries) {
    warnings.push("fallback.retries was out of range and reset");
  }
  const strategyResult = fallbackStrategySchema.safeParse(fbRaw.strategy);
  if (fbRaw.strategy !== undefined && !strategyResult.success) {
    warnings.push("fallback.strategy was invalid and reset");
  }
  const preemptiveThreshold =
    typeof fbRaw.preemptiveThreshold === "number" &&
    Number.isFinite(fbRaw.preemptiveThreshold) &&
    fbRaw.preemptiveThreshold >= 0 &&
    fbRaw.preemptiveThreshold <= 0.5
      ? fbRaw.preemptiveThreshold
      : 0;
  if (fbRaw.preemptiveThreshold !== undefined && preemptiveThreshold !== fbRaw.preemptiveThreshold) {
    warnings.push("fallback.preemptiveThreshold was out of range and reset");
  }

  const rtRaw =
    src.routing && typeof src.routing === "object" && !Array.isArray(src.routing)
      ? (src.routing as Record<string, unknown>)
      : {};
  const routingModeRes = routingModeSchema.safeParse(rtRaw.mode);
  const reservePercent =
    typeof rtRaw.reservePercent === "number" &&
    Number.isInteger(rtRaw.reservePercent) &&
    rtRaw.reservePercent >= 0 &&
    rtRaw.reservePercent <= 50
      ? rtRaw.reservePercent
      : 10;
  const sysWeightRes = accountWeightSchema.nullable().safeParse(src.systemWeight ?? null);

  const normalized = storeSchema.parse({
    defaultAccountId: typeof src.defaultAccountId === "string" && src.defaultAccountId ? src.defaultAccountId : SYSTEM_ACCOUNT_ID,
    systemLabel: typeof src.systemLabel === "string" && src.systemLabel.trim() ? src.systemLabel : "System sign-in",
    systemEmail: typeof src.systemEmail === "string" ? src.systemEmail : null,
    systemFallbackEnabled: src.systemFallbackEnabled === undefined || src.systemFallbackEnabled === true,
    systemWeight: sysWeightRes.success ? sysWeightRes.data : null,
    systemNote: sanitizeNote(src.systemNote, "systemNote"),
    order: Array.isArray(src.order) ? src.order.filter((id): id is string => typeof id === "string") : [],
    accounts,
    fallback: {
      enabled,
      retries,
      strategy: strategyResult.success ? strategyResult.data : "order",
      preemptiveThreshold,
    },
    routing: {
      mode: routingModeRes.success ? routingModeRes.data : "default",
      reservePercent,
    },
  });

  if (warnings.length > 0) {
    console.warn(`antigravity-accounts: sanitized accounts.json (${warnings.join("; ")})`);
  }
  return { data: normalized, unknownVersionError };
}

/** Persists the account list (never credentials) in the plugin's data directory. */
export class AccountStore {
  private data: StoreData = storeSchema.parse({});
  private loaded: Promise<void> | null = null;
  private loadComplete = false;
  private unknownVersionError: Error | null = null;
  private writing: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  async load(): Promise<StoreData> {
    this.loaded ??= (async () => {
      try {
        const raw = await fs.readFile(storeFile(), "utf8");
        const migrated = migrateLoadedStore(JSON.parse(raw));
        this.data = migrated.data;
        this.unknownVersionError = migrated.unknownVersionError;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "ENOENT") {
          // Keep the unreadable file for inspection and start from defaults.
          const backup = `${storeFile()}.unreadable-${Date.now()}`;
          await fs.rename(storeFile(), backup).catch(() => undefined);
          console.error(`antigravity-accounts: could not read accounts.json, moved it to ${backup}`, error);
        }
        this.data = storeSchema.parse({});
      }
      this.loadComplete = true;
    })();
    await this.loaded;
    return this.data;
  }

  assertWritable(): void {
    if (this.unknownVersionError) throw this.unknownVersionError;
  }

  readOnlyReason(): string | null {
    return this.unknownVersionError?.message ?? null;
  }

  isWritable(): boolean {
    return this.loadComplete && this.unknownVersionError === null;
  }

  readonlyData(): Readonly<StoreData> {
    return this.data;
  }

  snapshot(): StoreData {
    return structuredClone(this.data);
  }

  get(accountId: string): StoredAccount | undefined {
    return this.data.accounts.find((account) => account.id === accountId);
  }

  /** Applies a change and writes the file atomically. Changes are serialized. */
  async update<T>(change: (data: StoreData) => T): Promise<T> {
    await this.load();
    this.assertWritable();
    const run = this.writing.then(async () => {
      const draft = structuredClone(this.data);
      const result = change(draft);
      const next = storeSchema.parse(draft);
      const file = storeFile();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.${Date.now()}.${++this.writeSeq}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, file);
      this.data = next;
      return result;
    });
    this.writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  newAccountId(): string {
    for (;;) {
      const id = `a${randomBytes(4).toString("hex")}`;
      if (!this.get(id)) return id;
    }
  }
}
