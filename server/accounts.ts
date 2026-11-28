import fs from "node:fs/promises";
import path from "node:path";
import {
  AUTO_ACCOUNT_ID,
  SYSTEM_ACCOUNT_ID,
  inferPlanWeight,
  isAutoAccountId,
  type AccountCooldown,
  type AccountSummary,
  type AccountsState,
  type DefaultAccountId,
  type FallbackSettings,
  type FallbackStrategy,
  type OrchestratorChoice,
  type QuotaGroup,
  type RoutingSettings,
  type SavedFiles,
} from "../shared/contracts";
import { agyVersion, probeAccount, readAccountEmail, readPlan, type AccountPlan } from "./agy";
import { dataDir, displayPath, resolveAgy } from "./paths";
import {
  deleteSignIn,
  ensureProfile,
  profileSignInFingerprint,
  recoverSavedFiles,
  recoveryFolder,
  removeProfile,
  savedFiles,
  scanAfterSignIn,
} from "./profile";
import { computeRoutingShares } from "./router";
import { SignInManager } from "./signin";
import { AccountStore, orderedAccountIds, type StoredAccount } from "./store";

const statusFile = () => path.join(dataDir(), "status.json");

export interface QuotaProbeOptions {
  skipPlan?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class AccountWaitTimeout extends Error {
  readonly retryable = true;
  constructor() {
    super("Account selection timed out during launch.");
  }
}

function abortError(signal: AbortSignal) {
  const reason = "reason" in signal ? signal.reason : undefined;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error("Account selection was aborted."), { name: "AbortError" });
}

export function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal);
}

/** Stop waiting without cancelling a shared operation needed by other callers. */
export async function waitForSignal<T>(task: Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  if (!signal && timeoutMs === undefined) return task;
  let timer: NodeJS.Timeout | undefined;
  let aborted: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    if (signal) {
      aborted = () => reject(abortError(signal));
      if (signal.aborted) aborted();
      else signal.addEventListener("abort", aborted, { once: true });
    }
    if (timeoutMs !== undefined) timer = setTimeout(() => reject(new AccountWaitTimeout()), timeoutMs);
  });
  try {
    const value = await Promise.race([stop, task]);
    checkSignal(signal);
    return value;
  } finally {
    clearTimeout(timer);
    if (aborted) signal?.removeEventListener("abort", aborted);
  }
}

interface RuntimeStatus {
  status: AccountSummary["status"];
  statusDetail: string | null;
  checkedAt: string | null;
  quota: QuotaGroup[] | null;
  /** The plan agy reported, and when it was last asked. */
  plan: AccountPlan | null;
  planCheckedAt: string | null;
}

function usageTimedOut(status: RuntimeStatus | undefined) {
  return status?.status === "error" && /did not answer within|timed? ?out/i.test(status.statusDetail ?? "");
}

const UNKNOWN: RuntimeStatus = {
  status: "unknown",
  statusDetail: null,
  checkedAt: null,
  quota: null,
  plan: null,
  planCheckedAt: null,
};

/** Plans rarely change: ask again after this long, or sooner while none is known. */
const PLAN_MAX_AGE_MS = 6 * 60 * 60_000;
const PLAN_RETRY_MS = 30 * 60_000;
const REFRESH_CONCURRENCY = 3;
const CHANGE_DEBOUNCE_MS = 100;

async function runPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index]!);
    }
  });
  await Promise.all(workers);
}

export interface StatusUpdateEvent {
  accountId: string;
  status: AccountSummary["status"];
  quota: QuotaGroup[] | null;
  signedInChanged: boolean;
  emailChanged?: boolean;
  identityChanged?: boolean;
}

/** Owns the account list, sign-in state, and change notifications. */
export class AccountService {
  readonly store = new AccountStore();
  readonly signIns = new SignInManager();
  private readonly runtime = new Map<string, RuntimeStatus>();
  private readonly probing = new Map<string, { epoch: number; task: Promise<void>; usageReady: Promise<void> }>();
  private readonly epochs = new Map<string, number>();
  private readonly probeSeq = new Map<string, number>();
  private readonly appliedProbeSeq = new Map<string, number>();
  private readonly statusWaiters = new Map<string, Set<() => void>>();
  private readonly emailWrites = new Map<string, Promise<void>>();
  private readonly authOperations = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly statusListeners = new Set<(event: StatusUpdateEvent) => void>();
  private cooldownProvider: (accountId: string) => AccountCooldown[] = () => [];
  private modelProvider: (accountId: string) => string[] | null = () => null;
  private defaultResolver: (accounts: readonly AccountSummary[], strategy: FallbackStrategy) => string | null = () => null;
  private runningCountProvider: () => ReadonlyMap<string, number> = () => new Map();
  /** Starts from the clock so it keeps increasing across daemon and plugin restarts. */
  private revision = Date.now();
  private agyPath: string | null = null;
  private agyVersionValue: string | null = null;
  private agyChecked = false;

  private initialized: Promise<void> | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private statusDirty = false;
  private notifyTimer: NodeJS.Timeout | null = null;
  private batchDepth = 0;
  private pendingNotify = false;
  private statusWriting: Promise<void> = Promise.resolve();
  private statusWriteSeq = 0;

  /** Loads the account list and the last known statuses, so a restart shows quota at once. */
  init(): Promise<void> {
    this.initialized ??= (async () => {
      await this.store.load();
      try {
        const raw = JSON.parse(await fs.readFile(statusFile(), "utf8")) as Record<string, RuntimeStatus>;
        for (const [id, status] of Object.entries(raw)) {
          // Older caches have no plan fields.
          if (id === SYSTEM_ACCOUNT_ID || this.store.get(id)) this.runtime.set(id, { ...UNKNOWN, ...status });
        }
      } catch {
        // No cache yet.
      }
    })();
    return this.initialized;
  }

  private bumpEpoch(accountId: string): number {
    const next = (this.epochs.get(accountId) ?? 0) + 1;
    this.epochs.set(accountId, next);
    return next;
  }

  private epochOf(accountId: string): number {
    return this.epochs.get(accountId) ?? 0;
  }

  private exists(accountId: string): boolean {
    return accountId === SYSTEM_ACCOUNT_ID || Boolean(this.store.get(accountId));
  }

  /** Serialize authorization and removal, including authorizations opened by another client. */
  private changeProfileAuth<T>(accountId: string, change: () => Promise<T>): Promise<T> {
    const previous = this.authOperations.get(accountId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      // A quota probe can refresh a token on disk. Finish any existing probe before changing it.
      await this.probing.get(accountId)?.task;
      return change();
    });
    this.authOperations.set(accountId, operation);
    return operation.finally(() => {
      if (this.authOperations.get(accountId) === operation) this.authOperations.delete(accountId);
    });
  }

  private setRuntime(accountId: string, status: RuntimeStatus): void {
    this.runtime.set(accountId, status);
    this.statusDirty = true;
  }

  private deleteRuntime(accountId: string): void {
    if (this.runtime.delete(accountId)) {
      this.statusDirty = true;
    }
  }

  private saveStatuses(): void {
    if (this.store.readOnlyReason() || !this.statusDirty || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.flushStatuses();
    }, 1000);
  }

  private flushStatuses(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.store.readOnlyReason() || !this.statusDirty) return;
    this.statusDirty = false;
    const body = JSON.stringify(Object.fromEntries(this.runtime), null, 1);
    const file = statusFile();
    const seq = ++this.statusWriteSeq;
    const temp = `${file}.${process.pid}.${Date.now()}.${seq}.tmp`;
    this.statusWriting = this.statusWriting
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(temp, body, { mode: 0o600 });
        await fs.rename(temp, file);
      })
      .catch(async (error: unknown) => {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        console.error("antigravity-accounts: could not save statuses", error);
      });
  }

  setCooldownProvider(provider: (accountId: string) => AccountCooldown[]): void {
    this.cooldownProvider = provider;
  }

  setModelProvider(provider: (accountId: string) => string[] | null): void {
    this.modelProvider = provider;
  }

  setDefaultResolver(resolver: (accounts: readonly AccountSummary[], strategy: FallbackStrategy) => string | null): void {
    this.defaultResolver = resolver;
  }

  setRunningCountProvider(provider: () => ReadonlyMap<string, number>): void {
    this.runningCountProvider = provider;
  }

  onChange(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatusUpdated(listener: (event: StatusUpdateEvent) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  currentRevision(): number {
    return this.revision;
  }

  /** Publishes a revision bump (e.g. when a cooldown is set or cleared). */
  notifyChange(): void {
    this.changed();
  }

  private emitRevision(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.pendingNotify = false;
    for (const listener of this.listeners) {
      try {
        listener(this.revision);
      } catch (error) {
        console.error("antigravity-accounts: change listener failed", error);
      }
    }
  }

  private changed(): void {
    this.revision += 1;
    this.saveStatuses();
    if (this.batchDepth > 0) {
      this.pendingNotify = true;
      return;
    }
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.emitRevision();
    }, CHANGE_DEBOUNCE_MS);
  }

  private emitStatus(event: StatusUpdateEvent): void {
    for (const listener of this.statusListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("antigravity-accounts: status listener failed", error);
      }
    }
  }

  async agy(force = false): Promise<string | null> {
    if (!this.agyChecked || force || !this.agyPath) {
      const previous = this.agyPath;
      this.agyPath = await resolveAgy();
      this.agyChecked = true;
      if (this.agyPath && (this.agyPath !== previous || !this.agyVersionValue)) {
        this.agyVersionValue = await agyVersion(this.agyPath).catch(() => null);
      }
    }
    return this.agyPath;
  }

  async requireAgy(): Promise<string> {
    const agy = await this.agy();
    if (!agy) throw new Error("agy was not found on this host. Install the Antigravity CLI first.");
    return agy;
  }

  /** Throws unless the id names an existing account. */
  requireAccount(accountId: string): StoredAccount | null {
    if (accountId === SYSTEM_ACCOUNT_ID) return null;
    const account = this.store.get(accountId);
    if (!account) throw new Error("That Antigravity account no longer exists.");
    return account;
  }

  requireProfileAccount(accountId: string): StoredAccount {
    const account = this.requireAccount(accountId);
    if (!account) throw new Error("The system sign-in is managed by agy itself.");
    return account;
  }

  labelOf(accountId: string): string {
    if (accountId === SYSTEM_ACCOUNT_ID) return this.store.readonlyData().systemLabel;
    return this.store.get(accountId)?.label ?? accountId;
  }

  assertAccountOpenable(accountId: string): void {
    if (accountId !== SYSTEM_ACCOUNT_ID) this.store.assertWritable();
  }

  /** Ensures a profile account's HOME and settings.json (with any per-account Orchestrator override). */
  async ensureAccountProfile(accountId: string): Promise<string | null> {
    if (accountId === SYSTEM_ACCOUNT_ID) return null;
    await this.store.load();
    this.assertAccountOpenable(accountId);
    const account = this.store.get(accountId);
    if (!account) return null;
    return ensureProfile(accountId, account.orchestrator);
  }

  /** Re-syncs settings.json into every existing profile (e.g. after global Orchestrator settings change). */
  async syncAllProfiles(): Promise<void> {
    await this.store.load();
    this.store.assertWritable();
    const accounts = this.store.readonlyData().accounts;
    await Promise.all(
      accounts.map((account) =>
        ensureProfile(account.id, account.orchestrator).catch((error: unknown) => {
          console.error(`antigravity-accounts: could not sync settings for ${account.id}`, error);
        }),
      ),
    );
  }

  /** Re-checks sign-in and quota for one account. Concurrent calls of the same epoch share one probe. */
  refreshOne(accountId: string, options?: { forcePlan?: boolean; skipPlan?: boolean; timeoutMs?: number }): Promise<void> {
    const auth = this.authOperations.get(accountId);
    return auth
      ? auth.catch(() => undefined).then(() => this.refreshOne(accountId, options))
      : this.probeOne(accountId, options);
  }

  private probeOne(
    accountId: string,
    options?: { forcePlan?: boolean; skipPlan?: boolean; timeoutMs?: number },
  ): Promise<void> {
    const epoch = this.epochOf(accountId);
    const running = this.probing.get(accountId);
    if (running && running.epoch === epoch && !options?.forcePlan) {
      return running.task;
    }
    const seq = (this.probeSeq.get(accountId) ?? 0) + 1;
    this.probeSeq.set(accountId, seq);
    const current = () =>
      this.exists(accountId) &&
      this.epochOf(accountId) === epoch &&
      this.probeSeq.get(accountId) === seq &&
      seq >= (this.appliedProbeSeq.get(accountId) ?? 0);
    const apply = (status: RuntimeStatus) => {
      this.appliedProbeSeq.set(accountId, seq);
      this.setRuntime(accountId, status);
      if (status.status === "signed-in" || status.status === "signed-out") {
        for (const wake of this.statusWaiters.get(accountId) ?? []) wake();
      }
      mutated = true;
    };
    let finishUsage!: () => void;
    const usageReady = new Promise<void>((resolve) => {
      finishUsage = resolve;
    });
    let mutated = false;
    const task = (async () => {
      await this.store.load();
      if (this.store.readOnlyReason()) return;
      if (!this.exists(accountId)) return;
      const agy = await this.agy();
      const checkedAt = new Date().toISOString();
      const previous = this.runtime.get(accountId) ?? UNKNOWN;
      if (!agy) {
        if (!current()) return;
        apply({
          ...previous,
          status: "error",
          statusDetail: "agy was not found on this host",
          checkedAt,
          quota: null,
        });
        return;
      }
      if (accountId !== SYSTEM_ACCOUNT_ID) {
        if (!current()) return;
        await this.ensureAccountProfile(accountId);
      }
      const result =
        accountId !== SYSTEM_ACCOUNT_ID && !(await this.hasSignInFile(accountId))
          ? ({ kind: "signed-out", detail: "No independent sign-in was found for this account." } as const)
          : await probeAccount(agy, accountId, options?.timeoutMs);
      if (!current()) return;
      const nextStatus: RuntimeStatus = {
        ...previous,
        status: result.kind,
        statusDetail: result.kind === "signed-in" ? null : result.detail,
        checkedAt: new Date().toISOString(),
        quota: result.kind === "signed-in" ? result.quota : null,
      };
      apply(nextStatus);
      finishUsage();
      const email = result.kind === "signed-in" ? await readAccountEmail(accountId) : null;
      // A prior probe may already be inside the store's atomic rename.
      // Compare with the committed email before deciding this probe has nothing to update.
      await this.emailWrites.get(accountId)?.catch(() => undefined);
      if (!current()) return;
      const knownEmail =
        accountId === SYSTEM_ACCOUNT_ID ? this.store.readonlyData().systemEmail : (this.store.get(accountId)?.email ?? null);
      let { plan, planCheckedAt } = previous;
      if (result.kind === "signed-out") {
        plan = null;
        planCheckedAt = null;
      } else if (result.kind === "signed-in" && !options?.skipPlan) {
        // Another Google account signed in here: the old plan no longer applies.
        const otherAccount = email !== null && knownEmail !== null && email !== knownEmail;
        const age = planCheckedAt ? Date.now() - Date.parse(planCheckedAt) : Infinity;
        const shouldCheckPlan =
          otherAccount ||
          Boolean(options?.forcePlan) ||
          age > (plan ? PLAN_MAX_AGE_MS : PLAN_RETRY_MS);
        if (shouldCheckPlan) {
          const read = await readPlan(agy, accountId).catch(() => null);
          if (!current()) return;
          if (read) {
            plan = read;
            planCheckedAt = new Date().toISOString();
          } else {
            plan = otherAccount ? null : plan;
            // When the user explicitly refreshed and plan is still missing, do not lock out another manual retry.
            planCheckedAt = options?.forcePlan && !plan ? null : new Date().toISOString();
          }
        }
      }
      if (!current()) return;
      if (this.runtime.get(accountId) !== nextStatus) return;
      apply({ ...nextStatus, plan, planCheckedAt });
      if (
        (result.kind === "signed-in" && email && email !== knownEmail) ||
        (result.kind === "signed-out" && accountId !== SYSTEM_ACCOUNT_ID && knownEmail !== null)
      ) {
        const write = this.store.update((data) => {
          if (!current()) return;
          if (accountId === SYSTEM_ACCOUNT_ID) data.systemEmail = email;
          else {
            const account = data.accounts.find((entry) => entry.id === accountId);
            if (account) account.email = email;
          }
        });
        this.emailWrites.set(accountId, write);
        try {
          await write;
        } finally {
          if (this.emailWrites.get(accountId) === write) this.emailWrites.delete(accountId);
        }
      }
      if (!current()) return;
      const emailChanged = result.kind === "signed-in" && email !== null && email !== knownEmail;
      const identityChanged = email !== null && knownEmail !== null && email !== knownEmail;
      this.emitStatus({
        accountId,
        status: result.kind,
        quota: nextStatus.quota,
        signedInChanged: previous.status !== result.kind,
        emailChanged,
        identityChanged,
      });
    })()
      .catch((error: unknown) => {
        if (!current()) return;
        apply({
          ...(this.runtime.get(accountId) ?? UNKNOWN),
          status: "error",
          statusDetail: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
          quota: null,
        });
      })
      .finally(() => {
        finishUsage();
        if (this.probing.get(accountId)?.task === task) this.probing.delete(accountId);
        if (mutated && current() && !this.store.readOnlyReason()) this.changed();
      });
    this.probing.set(accountId, { epoch, task, usageReady });
    return task;
  }

  async refreshAll(options?: { forcePlan?: boolean }): Promise<void> {
    await this.agy(true);
    const ids = orderedAccountIds(this.store.readonlyData());
    this.batchDepth += 1;
    try {
      await runPool(ids, REFRESH_CONCURRENCY, (id) => this.refreshOne(id, options));
    } finally {
      this.batchDepth = Math.max(0, this.batchDepth - 1);
      if (this.batchDepth === 0 && this.pendingNotify) {
        this.emitRevision();
      }
    }
  }

  /** Last known status without probing. */
  knownStatus(accountId: string): AccountSummary["status"] {
    return this.runtime.get(accountId)?.status ?? "unknown";
  }

  /** Last known quota, probing first when nothing is known yet or stale. */
  async quotaFor(
    accountId: string,
    maxAgeMs: number,
    options?: QuotaProbeOptions,
  ): Promise<RuntimeStatus & { timedOut?: boolean }> {
    checkSignal(options?.signal);
    const current = this.runtime.get(accountId);
    const age = current?.checkedAt ? Date.now() - Date.parse(current.checkedAt) : Infinity;
    if (this.probing.has(accountId) || !current || age > maxAgeMs || usageTimedOut(current)) {
      const { skipPlan, timeoutMs, signal } = options ?? {};
      const startedAt = Date.now();
      const startAppliedSeq = this.appliedProbeSeq.get(accountId) ?? 0;
      const freshAuth = () => {
        const latest = this.runtime.get(accountId);
        return latest &&
          (latest.status === "signed-in" || latest.status === "signed-out") &&
          ((this.appliedProbeSeq.get(accountId) ?? 0) > startAppliedSeq ||
            (latest !== current && Date.parse(latest.checkedAt ?? "") >= startedAt))
          ? latest
          : undefined;
      };
      let wake!: () => void;
      const updated = new Promise<void>((resolve) => {
        wake = () => {
          if (freshAuth()) resolve();
        };
      });
      const waiters = this.statusWaiters.get(accountId) ?? new Set();
      this.statusWaiters.set(accountId, waiters);
      waiters.add(wake);
      try {
        const task = this.refreshOne(accountId, { skipPlan, timeoutMs });
        let probe = this.probing.get(accountId);
        const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
        do {
          const ready = (skipPlan ? probe?.usageReady : probe?.task) ?? task;
          await waitForSignal(
            Promise.race([ready, updated]),
            signal,
            deadline === undefined ? undefined : deadline - Date.now(),
          );
          if (freshAuth()) break;
          const latest = this.probing.get(accountId);
          if (latest === probe) break;
          probe = latest;
        } while (probe);
      } catch (error) {
        checkSignal(signal);
        if (!(error instanceof AccountWaitTimeout)) throw error;
        const latest = freshAuth();
        if (latest) return latest;
        return { ...(this.runtime.get(accountId) ?? UNKNOWN), timedOut: true };
      } finally {
        waiters.delete(wake);
        if (!waiters.size) this.statusWaiters.delete(accountId);
      }
    }
    checkSignal(options?.signal);
    const result = this.runtime.get(accountId) ?? UNKNOWN;
    return usageTimedOut(result) ? { ...result, timedOut: true } : result;
  }

  async state(): Promise<AccountsState> {
    await this.init();
    const agy = await this.agy();
    const data = this.store.readonlyData();
    const problems: string[] = [];
    const readOnly = this.store.readOnlyReason();
    if (readOnly) problems.push(readOnly);
    if (!agy) problems.push("agy was not found on this host. Install the Antigravity CLI, then refresh.");
    const normalizedDefault = isAutoAccountId(data.defaultAccountId) ? AUTO_ACCOUNT_ID : data.defaultAccountId;
    const defaultExists =
      normalizedDefault === AUTO_ACCOUNT_ID ||
      normalizedDefault === SYSTEM_ACCOUNT_ID ||
      data.accounts.some((account) => account.id === normalizedDefault);
    const defaultAccountId: DefaultAccountId = defaultExists
      ? (normalizedDefault as DefaultAccountId)
      : SYSTEM_ACCOUNT_ID;
    const byId = new Map<string, AccountSummary>();

    const system = this.runtime.get(SYSTEM_ACCOUNT_ID) ?? UNKNOWN;
    byId.set(SYSTEM_ACCOUNT_ID, {
      id: SYSTEM_ACCOUNT_ID,
      label: data.systemLabel,
      kind: "system",
      isDefaultForNewAgents: defaultAccountId === SYSTEM_ACCOUNT_ID,
      status: system.status,
      email: data.systemEmail,
      plan: system.plan?.name ?? null,
      statusDetail: system.statusDetail,
      checkedAt: system.checkedAt,
      quota: system.quota,
      createdAt: null,
      usable: true,
      fallbackEnabled: data.systemFallbackEnabled,
      weight: data.systemWeight,
      effectiveWeight: data.systemWeight ?? inferPlanWeight(system.plan?.name, system.plan?.id),
      routingShare: null,
      cooldowns: this.cooldownProvider(SYSTEM_ACCOUNT_ID),
      orchestratorOverride: null,
      note: data.systemNote,
      supportedModels: this.modelProvider(SYSTEM_ACCOUNT_ID),
    });

    for (const account of data.accounts) {
      const status = this.runtime.get(account.id) ?? UNKNOWN;
      byId.set(account.id, {
        id: account.id,
        label: account.label,
        kind: "profile",
        isDefaultForNewAgents: defaultAccountId === account.id,
        status: status.status,
        email: status.status === "signed-out" ? null : account.email,
        plan: status.plan?.name ?? null,
        statusDetail: account.unsafeDetail ?? status.statusDetail,
        checkedAt: status.checkedAt,
        quota: status.quota,
        createdAt: account.createdAt,
        usable: account.unsafeDetail === null,
        fallbackEnabled: account.fallbackEnabled,
        weight: account.weight,
        effectiveWeight: account.weight ?? inferPlanWeight(status.plan?.name, status.plan?.id),
        routingShare: null,
        cooldowns: this.cooldownProvider(account.id),
        orchestratorOverride: account.orchestrator,
        note: account.note,
        supportedModels: this.modelProvider(account.id),
      });
    }

    const accounts = orderedAccountIds(data)
      .map((id) => byId.get(id))
      .filter((entry): entry is AccountSummary => Boolean(entry));

    const effectiveShareMode =
      data.routing.mode !== "default"
        ? data.routing.mode
        : defaultAccountId === AUTO_ACCOUNT_ID
          ? "balanced"
          : "default";
    if (effectiveShareMode !== "default") {
      const shares = computeRoutingShares(
        accounts,
        effectiveShareMode,
        data.routing.reservePercent,
        "gemini",
        this.runningCountProvider(),
        Date.now(),
        data.fallback.preemptiveThreshold,
      );
      for (const account of accounts) {
        account.routingShare = shares.get(account.id) ?? null;
      }
    }

    const resolvedDefaultAccountId =
      defaultAccountId === AUTO_ACCOUNT_ID
        ? this.defaultResolver(accounts, data.fallback.strategy)
        : defaultAccountId;

    return {
      accounts,
      defaultAccountId,
      resolvedDefaultAccountId,
      agyPath: agy,
      agyVersion: this.agyVersionValue,
      problems,
      fallback: { ...data.fallback },
      routing: { ...data.routing },
      revision: this.revision,
    };
  }

  fallbackSettings(): FallbackSettings {
    return { ...this.store.readonlyData().fallback };
  }

  async setFallback(patch: Partial<FallbackSettings>): Promise<void> {
    await this.store.load();
    this.store.assertWritable();
    await this.store.update((data) => {
      data.fallback = { ...data.fallback, ...patch };
    });
    this.changed();
  }

  routingSettings(): RoutingSettings {
    return { ...this.store.readonlyData().routing };
  }

  async setRouting(patch: Partial<RoutingSettings>): Promise<void> {
    await this.store.load();
    this.store.assertWritable();
    await this.store.update((data) => {
      data.routing = { ...data.routing, ...patch };
    });
    this.changed();
  }

  /** A profile must have its own real OAuth credential before it can be used. */
  async hasSignInFile(accountId: string): Promise<boolean> {
    return (await profileSignInFingerprint(accountId)) !== null;
  }

  /** Last known quota groups, without probing. */
  knownQuota(accountId: string): QuotaGroup[] | null {
    return this.runtime.get(accountId)?.quota ?? null;
  }

  async create(label: string): Promise<AccountSummary> {
    await this.store.load();
    this.store.assertWritable();
    const id = this.store.newAccountId();
    await this.store.update((data) => {
      data.accounts.push({
        id,
        label,
        createdAt: new Date().toISOString(),
        email: null,
        credentialFiles: [],
        unsafeDetail: null,
        fallbackEnabled: true,
        weight: null,
        orchestrator: null,
        note: null,
      });
      const order = orderedAccountIds(data);
      if (!order.includes(id)) order.push(id);
      data.order = order;
    });
    await this.ensureAccountProfile(id);
    this.setRuntime(id, { ...UNKNOWN, status: "signed-out", statusDetail: "Not signed in yet" });
    this.changed();
    const created = (await this.state()).accounts.find((account) => account.id === id);
    if (!created) throw new Error("The new account could not be read back.");
    return created;
  }

  async rename(accountId: string, label: string): Promise<void> {
    await this.store.load();
    this.store.assertWritable();
    this.requireAccount(accountId);
    await this.store.update((data) => {
      if (accountId === SYSTEM_ACCOUNT_ID) data.systemLabel = label;
      else {
        const account = data.accounts.find((entry) => entry.id === accountId);
        if (account) account.label = label;
      }
    });
    this.changed();
  }

  async move(accountId: string, direction: "up" | "down"): Promise<void> {
    await this.store.load();
    this.store.assertWritable();
    this.requireAccount(accountId);
    await this.store.update((data) => {
      const order = orderedAccountIds(data);
      const index = order.indexOf(accountId);
      if (index < 0) return;
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= order.length) return;
      const swapped = order[target]!;
      order[target] = order[index]!;
      order[index] = swapped;
      data.order = order;
    });
    this.changed();
  }

  async setAccountOptions(
    accountId: string,
    patch: {
      fallbackEnabled?: boolean;
      weight?: number | null;
      note?: string | null;
      orchestratorOverride?: OrchestratorChoice | null;
    },
  ): Promise<void> {
    await this.store.load();
    this.store.assertWritable();
    this.requireAccount(accountId);
    if (accountId === SYSTEM_ACCOUNT_ID && patch.orchestratorOverride !== undefined) {
      throw new Error("The system account uses the global Orchestrator setting.");
    }
    const normalizedNote =
      patch.note === undefined ? undefined : patch.note && patch.note.trim().length > 0 ? patch.note.trim() : null;
    await this.store.update((data) => {
      if (accountId === SYSTEM_ACCOUNT_ID) {
        if (patch.fallbackEnabled !== undefined) data.systemFallbackEnabled = patch.fallbackEnabled;
        if (patch.weight !== undefined) data.systemWeight = patch.weight;
        if (normalizedNote !== undefined) data.systemNote = normalizedNote;
        return;
      }
      const entry = data.accounts.find((candidate) => candidate.id === accountId);
      if (!entry) return;
      if (patch.fallbackEnabled !== undefined) entry.fallbackEnabled = patch.fallbackEnabled;
      if (patch.weight !== undefined) entry.weight = patch.weight;
      if (normalizedNote !== undefined) entry.note = normalizedNote;
      if (patch.orchestratorOverride !== undefined) entry.orchestrator = patch.orchestratorOverride;
    });
    if (accountId !== SYSTEM_ACCOUNT_ID && patch.orchestratorOverride !== undefined) {
      await this.ensureAccountProfile(accountId);
    }
    this.changed();
  }

  async setDefault(accountId: DefaultAccountId): Promise<void> {
    await this.store.load();
    this.store.assertWritable();
    if (accountId !== AUTO_ACCOUNT_ID) {
      const account = this.requireAccount(accountId);
      if (account?.unsafeDetail) throw new Error(account.unsafeDetail);
    }
    await this.store.update((data) => {
      data.defaultAccountId = accountId;
    });
    this.changed();
  }

  /** What removing or recovering a profile account would move out of its home folder, and to where. */
  async savedFiles(accountId: string): Promise<SavedFiles> {
    const account = this.requireProfileAccount(accountId);
    return {
      items: await savedFiles(accountId),
      folder: displayPath(await recoveryFolder(account.label)),
    };
  }

  /** Recovers files agents saved in a profile HOME into ~/Antigravity Console without deleting the account. */
  async recoverSavedFiles(accountId: string): Promise<SavedFiles | null> {
    await this.store.load();
    this.store.assertWritable();
    const account = this.requireProfileAccount(accountId);
    const preserved = await recoverSavedFiles(accountId, account.label);
    return preserved
      ? {
          items: preserved.items,
          folder: displayPath(preserved.folder),
          ...(preserved.copied.length ? { copied: preserved.copied } : {}),
        }
      : null;
  }

  /** Removes a profile account. Returns where its saved files went, or null when it had none. */
  remove(accountId: string): Promise<SavedFiles | null> {
    return this.changeProfileAuth(accountId, async () => {
      await this.store.load();
      this.store.assertWritable();
      const account = this.requireProfileAccount(accountId);
      this.bumpEpoch(accountId);
      this.probing.delete(accountId);
      this.signIns.cancelForAccount(accountId);
      const preserved = await removeProfile(accountId, account.label);
      await this.store.update((data) => {
        data.accounts = data.accounts.filter((entry) => entry.id !== accountId);
        data.order = data.order.filter((id) => id !== accountId);
        if (data.defaultAccountId === accountId) data.defaultAccountId = SYSTEM_ACCOUNT_ID;
      });
      this.deleteRuntime(accountId);
      this.changed();
      return preserved ? { items: preserved.items, folder: displayPath(preserved.folder) } : null;
    });
  }

  signOut(accountId: string): Promise<void> {
    return this.changeProfileAuth(accountId, async () => {
      await this.store.load();
      this.store.assertWritable();
      const account = this.requireProfileAccount(accountId);
      this.bumpEpoch(accountId);
      this.probing.delete(accountId);
      this.signIns.cancelForAccount(accountId);
      await deleteSignIn(accountId, account.credentialFiles);
      await this.store.update((data) => {
        const entry = data.accounts.find((candidate) => candidate.id === accountId);
        if (entry) {
          entry.credentialFiles = [];
          entry.email = null;
          entry.unsafeDetail = null;
        }
      });
      this.setRuntime(accountId, { ...UNKNOWN, status: "signed-out", statusDetail: "Signed out" });
      this.emitStatus({ accountId, status: "signed-out", quota: null, signedInChanged: true });
      this.changed();
    });
  }

  startSignIn(accountId: string): Promise<{ loginId: string; url: string; expiresAt: string }> {
    return this.changeProfileAuth(accountId, async () => {
      await this.store.load();
      this.store.assertWritable();
      this.requireProfileAccount(accountId);
      const agy = await this.requireAgy();
      await this.ensureAccountProfile(accountId);
      return this.signIns.start(agy, accountId);
    });
  }

  /** Completes a sign-in only after agy has written a new independent credential. */
  async submitSignIn(loginId: string, code: string): Promise<void> {
    await this.store.load();
    this.store.assertWritable();
    const accountId = this.signIns.accountOf(loginId);
    if (!accountId) throw new Error("This sign-in expired or was cancelled. Start again.");
    return this.changeProfileAuth(accountId, async () => {
      this.requireProfileAccount(accountId);
      const systemEmailBefore = this.store.readonlyData().systemEmail;
      const tokenBefore = await profileSignInFingerprint(accountId);
      const outcome = await this.signIns.submit(loginId, code);
      const tokenAfter = await profileSignInFingerprint(accountId);
      const scan = await scanAfterSignIn(accountId, outcome.submittedAt);
      this.bumpEpoch(accountId);
      this.probing.delete(accountId);

      let unsafeDetail: string | null = null;
      if (scan.leaked.length > 0) {
        unsafeDetail = "agy wrote sign-in data outside the account’s profile. Check the system sign-in before trying again.";
        console.error(`antigravity-accounts: sign-in for ${accountId} wrote ${scan.leaked.join(", ")}`);
      } else if (!tokenAfter || tokenAfter === tokenBefore) {
        unsafeDetail = "agy did not write a new independent credential. The account cannot be used.";
      } else {
        await this.probeOne(accountId, { forcePlan: true });
      }

      const status = this.runtime.get(accountId);
      if (systemEmailBefore) {
        await this.refreshOne(SYSTEM_ACCOUNT_ID);
        const systemEmailAfter = this.store.readonlyData().systemEmail;
        if (systemEmailAfter && systemEmailAfter !== systemEmailBefore) {
          unsafeDetail = "The system sign-in changed while this account was signing in. Check the system sign-in before trying again.";
        }
      }
      await this.store.update((data) => {
        const entry = data.accounts.find((candidate) => candidate.id === accountId);
        if (!entry) return;
        if (scan.own.length > 0) entry.credentialFiles = scan.own;
        entry.unsafeDetail = unsafeDetail;
        if (unsafeDetail && data.defaultAccountId === accountId) {
          data.defaultAccountId = SYSTEM_ACCOUNT_ID;
        }
      });
      this.changed();
      if (unsafeDetail) throw new Error(unsafeDetail);
      if (status?.status !== "signed-in") {
        const detail = status?.statusDetail ?? "agy did not confirm the sign-in";
        throw new Error(
          outcome.exitedCleanly
            ? `agy accepted the code but the account still is not signed in: ${detail}`
            : `agy did not finish the sign-in: ${detail}`,
        );
      }
    });
  }

  cancelSignIn(loginId: string): void {
    this.store.assertWritable();
    this.signIns.cancel(loginId);
  }

  async dispose(): Promise<void> {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.pendingNotify = false;
    if (this.saveTimer || this.statusDirty) this.flushStatuses();
    this.signIns.cancelAll();
    this.listeners.clear();
    this.statusListeners.clear();
    await this.statusWriting;
  }
}
