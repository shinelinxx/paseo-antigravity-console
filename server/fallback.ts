import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  FALLBACK_TIMELINE_KIND,
  SYSTEM_ACCOUNT_ID,
  isAntigravityProvider,
  pendingSwitchFromMetadata,
  quotaPoolForModel,
  runtimeAccountFromMetadata,
  type AccountCooldown,
  type AccountSummary,
  type FallbackEvent,
  type FallbackStrategy,
  type QuotaGroup,
  type QuotaPool,
} from "../shared/contracts";
import type { AccountService } from "./accounts";
import { switchAgentAccount, type PendingSwitches } from "./hooks";
import { computeEffectiveWeight, evaluatePoolQuota } from "./router";
import { orderedAccountIds } from "./store";
import type { PaseoApi } from "./types";

export type FailureKind = FallbackEvent["reason"];

async function awaitWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, ms, undefined);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The prompt that resumes an agent after a retry or an account switch; the conversation carries the task. */
const RESUME_PROMPT = "Continue.";

const QUOTA = /resource.?exhausted|\b429\b|quota|usage limit|rate.?limit|limit (reached|exceeded)|exhausted|too many requests/i;
const AUTH = /authenticat|sign.?in|log.?in|unauthori[sz]ed|\b401\b|\b403\b|permission.?denied|invalid.?grant|credentials/i;
const TRANSIENT =
  /\b5\d\d\b|unavailable|deadline|timed? ?out|timeout|econn|etimedout|socket|network|overloaded|capacity|internal|temporar|did not initialize|exited/i;

export function classify(message: string, code?: string): FailureKind {
  const text = `${code ?? ""} ${message}`;
  if (QUOTA.test(text)) return "quota";
  if (AUTH.test(text)) return "auth";
  if (TRANSIENT.test(text)) return "transient";
  return "error";
}

interface Chain {
  /** Retries spent on the current account. */
  attempts: number;
  /** Accounts this failure chain already ran on. */
  tried: Set<string>;
}

interface CooldownEntry {
  until: number;
  reason: FailureKind;
  baseline?: ReturnType<typeof quotaSnapshot>;
}

function quotaSnapshot(groups: QuotaGroup[] | null) {
  const buckets = new Map<string, { fraction: number | null; reset: number }>();
  for (const group of groups ?? []) {
    for (const bucket of group.buckets) {
      if (bucket.disabled) continue;
      buckets.set(JSON.stringify([group.name, bucket.id, bucket.window]), {
        fraction: bucket.remainingFraction,
        reset: Date.parse(bucket.resetTime ?? ""),
      });
    }
  }
  return buckets;
}

type AccountCooldownState = Partial<Record<QuotaPool, CooldownEntry>>;

export interface ModelSupport {
  supportsModel(accountId: string, model: string | null | undefined): boolean | null;
  ensureModelSupport?(accountId: string, model: string | null | undefined): Promise<boolean | null>;
}

/** Picks the QuotaGroup matching a model pool (`gemini` vs `third-party`). */
export function groupForPool(
  groups: readonly QuotaGroup[] | null,
  pool: "gemini" | "third-party",
): QuotaGroup | null {
  if (!groups?.length) return null;
  if (pool === "third-party") {
    return (
      groups.find((group) => /claude|gpt|3p|third/i.test(group.name)) ??
      groups.find((group) => !/gemini/i.test(group.name)) ??
      null
    );
  }
  return (
    groups.find((group) => /gemini/i.test(group.name) && !/argon/i.test(group.name)) ??
    groups.find((group) => !/claude|gpt|3p|third/i.test(group.name)) ??
    null
  );
}

/** Earliest future reset among exhausted buckets in the target pool, else null. */
export function resetOfExhausted(
  groups: readonly QuotaGroup[] | null,
  pool: "gemini" | "third-party",
  now = Date.now(),
): number | null {
  const group = groupForPool(groups, pool);
  let earliest: number | null = null;
  for (const bucket of group?.buckets ?? []) {
    if (bucket.disabled || bucket.remainingFraction === null || bucket.remainingFraction > 0.001) continue;
    const at = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
    if (Number.isFinite(at) && at > now && (earliest === null || at < earliest)) earliest = at;
  }
  return earliest;
}

/** True when a known quota says the account cannot serve the next request for `pool`. */
export function exhausted(
  groups: readonly QuotaGroup[] | null,
  pool: "gemini" | "third-party",
  now = Date.now(),
): boolean {
  const group = groupForPool(groups, pool);
  return (group?.buckets ?? []).some((bucket) => {
    if (bucket.disabled || bucket.remainingFraction === null || bucket.remainingFraction > 0.001) return false;
    // A bucket whose reset time has already passed is stale, not still exhausted.
    const resetAt = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
    if (Number.isFinite(resetAt) && resetAt <= now) return false;
    return true;
  });
}

/** Minimum remaining fraction (0..1) across active buckets of `pool`, or -1 when unknown. */
function poolRemainingScore(
  groups: readonly QuotaGroup[] | null,
  pool: "gemini" | "third-party" | null,
  now = Date.now(),
): number {
  if (!pool) return Math.max(poolRemainingScore(groups, "gemini", now), poolRemainingScore(groups, "third-party", now));
  const group = groupForPool(groups, pool);
  const fractions = (group?.buckets ?? [])
    .filter((bucket) => !bucket.disabled && bucket.remainingFraction !== null)
    .map((bucket) => {
      const resetAt = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
      return Number.isFinite(resetAt) && resetAt <= now ? 1 : bucket.remainingFraction!;
    });
  if (!fractions.length) return -1;
  return Math.min(...fractions);
}

/** Earliest future reset timestamp among active non-empty buckets of `pool`, or Infinity when unknown. */
function poolSoonestReset(
  groups: readonly QuotaGroup[] | null,
  pool: "gemini" | "third-party" | null,
  now = Date.now(),
): number {
  if (!pool) return Math.min(poolSoonestReset(groups, "gemini", now), poolSoonestReset(groups, "third-party", now));
  const group = groupForPool(groups, pool);
  let soonest = Infinity;
  for (const bucket of group?.buckets ?? []) {
    if (bucket.disabled || !bucket.resetTime) continue;
    const at = Date.parse(bucket.resetTime);
    if (Number.isFinite(at) && at > now && at < soonest) soonest = at;
  }
  return soonest;
}

/** Effective weighted quota score (`effectiveWeight * remainingFraction^alpha * urgency`) for fallback sorting. */
function weightedPoolScore(
  groups: readonly QuotaGroup[] | null,
  effectiveWeight: number,
  pool: "gemini" | "third-party" | null,
  now = Date.now(),
): number {
  const baseWeight = effectiveWeight > 0 ? effectiveWeight : 0.01;
  if (!pool) {
    return Math.max(
      computeEffectiveWeight({ baseWeight, metrics: evaluatePoolQuota(groups, "gemini", now) }),
      computeEffectiveWeight({ baseWeight, metrics: evaluatePoolQuota(groups, "third-party", now) }),
    );
  }
  return computeEffectiveWeight({ baseWeight, metrics: evaluatePoolQuota(groups, pool, now) });
}

export class FallbackController {
  private readonly chains = new Map<string, Chain>();
  /** Account id → active cooldowns (whole account or per quota pool). */
  private readonly cooldowns = new Map<string, AccountCooldownState>();
  /** Per-agent pending retry timer, canceled when a new turn starts or completes. */
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly latestTurn = new Map<string, string>();
  private readonly turnGen = new Map<string, number>();
  // The matching open belongs to this chain and must not cancel its next candidate.
  private readonly onReloadOpen = new Map<string, string>();
  private sequence = 0;
  private disposed = false;
  private noteSeq = 0;

  constructor(
    private readonly service: AccountService,
    private readonly pending: PendingSwitches,
    private readonly models?: ModelSupport,
  ) {
    this.service.setCooldownProvider((accountId) => this.cooldownsOf(accountId));
    this.service.setDefaultResolver((accounts, strategy) => this.pickBestSync(accounts, null, strategy));
  }

  /** Active (non-expired) cooldown entries for an account. */
  cooldownsOf(accountId: string): AccountCooldown[] {
    const entry = this.cooldowns.get(accountId);
    if (!entry) return [];
    const now = Date.now();
    const active: AccountCooldown[] = [];
    for (const pool of ["all", "unknown", "gemini", "third-party"] as const) {
      const item = entry[pool];
      if (!item) continue;
      if (item.until <= now) {
        delete entry[pool];
        continue;
      }
      active.push({ pool, reason: item.reason, until: new Date(item.until).toISOString() });
    }
    if (!active.length) this.cooldowns.delete(accountId);
    return active;
  }

  /** True when the account is currently cooling down for `pool` (or globally). */
  isCooling(accountId: string, pool: "gemini" | "third-party" | null): boolean {
    return this.activeCooldown(accountId, pool) !== null;
  }

  private activeCooldown(accountId: string, pool: QuotaPool | null): CooldownEntry | null {
    pool ??= "unknown";
    const entry = this.cooldowns.get(accountId);
    if (!entry) return null;
    const now = Date.now();
    if (entry.all) {
      if (entry.all.until > now) return entry.all;
      delete entry.all;
    }
    const pooled = entry[pool];
    if (pooled) {
      if (pooled.until > now) return pooled;
      delete entry[pool];
    }
    if (!Object.keys(entry).length) this.cooldowns.delete(accountId);
    return null;
  }

  private setCooldown(accountId: string, pool: QuotaPool, until: number, reason: FailureKind): void {
    const entry = this.cooldowns.get(accountId) ?? {};
    entry[pool] = {
      until,
      reason,
      baseline: pool === "unknown" && reason === "quota" ? quotaSnapshot(this.service.knownQuota(accountId)) : undefined,
    };
    this.cooldowns.set(accountId, entry);
    this.service.notifyChange();
  }

  /** Clears active cooldowns for one account (or all accounts when omitted). */
  clearCooldown(accountId?: string, clearRedirects = true): boolean {
    const clearedRedirect = clearRedirects && this.pending.clearFailedRedirects(accountId);
    if (!accountId) {
      if (!this.cooldowns.size && !clearedRedirect) return false;
      this.cooldowns.clear();
      this.service.notifyChange();
      return true;
    }
    const removed = this.cooldowns.delete(accountId) || clearedRedirect;
    if (removed) this.service.notifyChange();
    return removed;
  }

  /** Automatically clears cooldowns that fresh account status proves have resolved. */
  reconcileStatus(
    accountId: string,
    status: AccountSummary["status"],
    quota: QuotaGroup[] | null,
    identityChanged = false,
  ): void {
    if (identityChanged || status === "signed-out") this.pending.clearFailedRedirects(accountId);
    const entry = this.cooldowns.get(accountId) ?? {};
    let changed = false;
    if (entry.unknown) {
      const baseline = entry.unknown.baseline;
      const reset =
        status === "signed-in" &&
        baseline &&
        [...quotaSnapshot(quota)].some(([key, now]) => {
          const old = baseline.get(key);
          return (
            old &&
            ((Date.now() >= old.reset && now.reset > old.reset + 60_000) ||
              (old.fraction !== null && now.fraction !== null && now.fraction >= old.fraction + 0.05 - Number.EPSILON))
          );
        });
      if (status === "signed-out" || identityChanged || reset) {
        delete entry.unknown;
        changed = true;
      }
    }
    if (status === "signed-in" && entry.all?.reason === "auth") {
      delete entry.all;
      changed = true;
    }
    for (const pool of ["gemini", "third-party"] as const) {
      if (
        status === "signed-in" &&
        entry[pool]?.reason === "quota" &&
        !exhausted(quota, pool) &&
        poolRemainingScore(quota, pool) > 0.01
      ) {
        delete entry[pool];
        changed = true;
      }
    }
    if (!Object.keys(entry).length) this.cooldowns.delete(accountId);
    if (changed) this.service.notifyChange();
  }

  /** Cancels any pending automatic retry and resets the failure chain for an agent. */
  cancelAgent(agentId: string): void {
    this.invalidatePreemptive(agentId);
    this.chains.delete(agentId);
  }

  /** Cancels all pending automatic retries and clears active failure chains (e.g. fallback turned off). */
  cancelAllRetries(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.chains.clear();
  }

  private cancelRetry(agentId: string): void {
    const timer = this.retryTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(agentId);
    }
  }

  invalidatePreemptive(agentId: string): void {
    this.onReloadOpen.delete(agentId);
    this.turnGen.set(agentId, ++this.sequence);
    this.cancelRetry(agentId);
  }

  private cancellation(agentId: string) {
    // Reserve an identity even for an agent first observed at turn.after.
    if (!this.turnGen.has(agentId)) this.turnGen.set(agentId, ++this.sequence);
    const gen = this.turnGen.get(agentId);
    return () => this.disposed || this.turnGen.get(agentId) !== gen;
  }

  register(server: PluginServerContext, registerSessionHooks?: () => Array<() => void>): () => void {
    const removers = [
      this.service.onStatusUpdated(({ accountId, status, quota, identityChanged }) => {
        this.reconcileStatus(accountId, status, quota, identityChanged);
      }),
      server.addHook("agent.open.before", async ({ request }) => {
        if (request.purpose === "history" || !isAntigravityProvider(request.provider)) return;
        const own = this.onReloadOpen.get(request.agentId);
        if (own && own === pendingSwitchFromMetadata(request.metadata)?.requestId) {
          this.onReloadOpen.delete(request.agentId);
          return;
        }
        this.invalidatePreemptive(request.agentId);
      }),
      server.addHook("agent.turn.before", async ({ agent, turnId }) => {
        if (!isAntigravityProvider(agent.provider)) return;
        this.invalidatePreemptive(agent.id);
        if (turnId) this.latestTurn.set(agent.id, turnId);
        else this.latestTurn.delete(agent.id);
      }),
      server.addHook("agent.archive.after", async ({ agent }) => {
        this.cancelRetry(agent.id);
        this.onReloadOpen.delete(agent.id);
        this.turnGen.delete(agent.id);
        this.latestTurn.delete(agent.id);
        this.chains.delete(agent.id);
      }),
      // Invalidate old work on entry; confirm and attribute the finished turn
      // before its failure handler can open another provider session.
      ...(registerSessionHooks?.() ?? []),
      server.addHook("agent.turn.after", async ({ agent, turnId, outcome }, { paseo }) => {
        if (!isAntigravityProvider(agent.provider)) return;
        const latestTurn = this.latestTurn.get(agent.id);
        if (turnId && latestTurn && turnId !== latestTurn) return;
        this.invalidatePreemptive(agent.id);
        if (turnId) this.latestTurn.set(agent.id, turnId);
        const failedTurnStale = this.cancellation(agent.id);
        const failedTurnId = turnId ?? this.latestTurn.get(agent.id) ?? null;
        const current = this.pending.effectiveAccountId(agent.id, agent.metadata, paseo);
        if (outcome.kind !== "failed") {
          // A finished or canceled turn ends the failure chain.
          this.chains.delete(agent.id);
          return;
        }
        const snapshotAtFailure = paseo.agents.ref(agent.id).refresh().catch(() => null);
        const processFailure = async (accountId: string, deferred: boolean, historical = false) => {
          await this.service.init();
          const settings = this.service.fallbackSettings();
          if (!settings.enabled || this.disposed || (!deferred && failedTurnStale())) return;
          const snapshot = await snapshotAtFailure;
          if (this.disposed || (!deferred && failedTurnStale())) return;
          const model = snapshot?.agent.model ?? ("model" in agent && typeof agent.model === "string" ? agent.model : null);
          const metadata = snapshot?.agent.metadata ?? agent.metadata;
          const queued = pendingSwitchFromMetadata(metadata);
          await this.handleFailure(
            paseo,
            agent.id,
            accountId,
            model,
            outcome.error,
            settings.retries,
            settings.strategy,
            queued?.requestId === runtimeAccountFromMetadata(metadata)?.consumedRequestId ? null : queued,
            snapshot?.agent.model ?? null,
            failedTurnStale,
            failedTurnId,
            deferred,
            historical,
          );
        };
        const report = (error: unknown) => {
          console.error(`antigravity-accounts: fallback for ${agent.id} failed`, error);
        };
        if (
          this.pending.deferFailure(agent.id, (id, historical) => {
            void processFailure(id, true, historical).catch(report);
          })
        ) {
          return;
        }
        await processFailure(current, false).catch(report);
      }),
    ];
    return () => {
      for (const remove of removers) remove();
    };
  }

  /** Chooses a higher-quota account while creating or opening a session. */
  async lowQuotaTarget(
    accountId: string,
    model?: string | null,
    excluded: ReadonlySet<string> = new Set(),
  ): Promise<string | null> {
    if (!model?.trim()) return null;
    const deadline = Date.now() + 1500;
    const order = () => JSON.stringify(orderedAccountIds(this.service.store.readonlyData()));
    const remaining = (id: string) => this.remainingQuota(id, model);
    for (let attempt = 0; attempt < 2; attempt++) {
      const settings = this.service.fallbackSettings();
      const score = remaining(accountId);
      if (!settings.enabled || settings.preemptiveThreshold <= 0 || score < 0 || score > settings.preemptiveThreshold) {
        return null;
      }
      const orderBefore = order();
      const next = await this.pickHealthyNext(accountId, new Set([accountId, ...excluded]), model, settings.strategy, {
        minScore: score + 0.05,
        requireKnownQuota: true,
        budgetMs: deadline - Date.now(),
      });
      const latest = this.service.fallbackSettings();
      if (latest.strategy !== settings.strategy || order() !== orderBefore) continue;
      const current = remaining(accountId);
      if (
        !next ||
        !latest.enabled ||
        latest.preemptiveThreshold <= 0 ||
        current < 0 ||
        current > latest.preemptiveThreshold ||
        remaining(next) <= current + 0.05 ||
        !this.isEligible(next, model)
      ) {
        return null;
      }
      return next;
    }
    return null;
  }

  remainingQuota(accountId: string, model?: string | null) {
    return poolRemainingScore(this.service.knownQuota(accountId), quotaPoolForModel(model));
  }

  supportsModel(accountId: string, model?: string | null): boolean {
    return !model?.trim() || this.models?.supportsModel(accountId, model) !== false;
  }

  isEligible(accountId: string, model?: string | null): boolean {
    const account = this.service.store.get(accountId);
    const enabled =
      accountId === SYSTEM_ACCOUNT_ID
        ? this.service.store.readonlyData().systemFallbackEnabled
        : account?.unsafeDetail === null && account.fallbackEnabled;
    const pool = quotaPoolForModel(model);
    const hasModel = Boolean(model && model.trim());
    return (
      enabled === true &&
      this.service.knownStatus(accountId) !== "signed-out" &&
      !this.activeCooldown(accountId, hasModel ? pool : null) &&
      (!hasModel || (!exhausted(this.service.knownQuota(accountId), pool) && this.models?.supportsModel(accountId, model) !== false))
    );
  }

  private async handleFailure(
    paseo: PaseoApi,
    agentId: string,
    current: string,
    model: string | null,
    error: { message: string; code?: string },
    retries: number,
    strategy: FallbackStrategy,
    userPending: ReturnType<typeof pendingSwitchFromMetadata>,
    expectedModel: string | null,
    failedTurnStale: () => boolean,
    failedTurnId: string | null,
    deferred: boolean,
    historical: boolean,
  ): Promise<void> {
    const stale = () =>
      historical || failedTurnStale() || (failedTurnId !== null && this.latestTurn.get(agentId) !== failedTurnId);
    const reason = classify(error.message, error.code);
    const pool = quotaPoolForModel(model);
    const fromLabel = this.service.labelOf(current);
    const message = error.message.slice(0, 400);
    // The failure may have changed the quota; the sidebar and the next choice should see it.
    await this.service.refreshOne(current).catch(() => undefined);
    if (this.disposed || (stale() && (!deferred || reason === "transient"))) return;
    const chain = this.chains.get(agentId) ?? { attempts: 0, tried: new Set<string>() };
    if (!stale()) {
      this.chains.set(agentId, chain);
      chain.tried.add(current);
    }

    if (!stale() && (reason === "transient" || reason === "error") && chain.attempts < retries) {
      chain.attempts += 1;
      const attempt = chain.attempts;
      await this.note(paseo, agentId, { event: "retry", reason, from: fromLabel, to: null, attempt, retries, message });
      if (stale()) return;
      this.scheduleRetry(agentId, attempt * 5000, () => this.resume(paseo, agentId, stale));
      return;
    }

    const cooldownPool: QuotaPool = reason === "auth" ? "all" : model?.trim() ? pool : "unknown";
    const until =
      reason === "quota"
        ? ((model?.trim() ? resetOfExhausted(this.service.knownQuota(current), pool) : null) ?? Date.now() + 30 * 60_000)
        : reason === "auth"
          ? Date.now() + 6 * 3_600_000
          : Date.now() + 10 * 60_000;
    this.setCooldown(current, cooldownPool, until, reason);
    if (stale()) return;

    // Keep trying candidates when one fails to open (e.g. an account that lacks the agent's model).
    let preferred: string | null = null;
    if (
      userPending?.source === "user" &&
      userPending.accountId !== current &&
      !this.pending.isRequestInvalid(agentId, userPending.requestId)
    ) {
      const id = userPending.accountId;
      if (!(await this.healthOf(id, model)) && (!model?.trim() || this.models?.supportsModel(id, model) !== false)) {
        preferred = id;
      } else {
        chain.tried.add(id);
        console.warn(`antigravity-accounts: queued account ${id} is unavailable for ${agentId}; trying fallback candidates`);
      }
    }
    for (;;) {
      const next: string | null = preferred ?? (await this.pickHealthyNext(current, chain.tried, model, strategy));
      preferred = null;
      if (stale()) return;
      if (!next) {
        this.chains.delete(agentId);
        await this.note(paseo, agentId, {
          event: "exhausted",
          reason,
          from: fromLabel,
          to: null,
          attempt: chain.attempts,
          retries,
          message,
        });
        return;
      }
      chain.tried.add(next);
      const continueOn = async (obsolete: () => boolean) => {
        if (obsolete()) return;
        chain.attempts = 0;
        await this.note(paseo, agentId, {
          event: "switch",
          reason,
          from: fromLabel,
          to: this.service.labelOf(next),
          attempt: 0,
          retries,
          message,
        });
        if (!obsolete()) await this.resume(paseo, agentId, obsolete);
      };
      let own: string | undefined;
      try {
        const outcome = await switchAgentAccount(paseo, this.service, this.pending, {
          agentId,
          accountId: next,
          source: "fallback",
          when: "now",
          expectedFrom: current,
          expectedModel,
          shouldAbort: stale,
          requireNotRunning: true,
          onReloadStart: (requestId) => {
            own = requestId;
            this.onReloadOpen.set(agentId, requestId);
          },
        });
        if (stale() || outcome.result !== "switched") return;
      } catch (switchError) {
        if (stale()) return;
        console.warn(
          `antigravity-accounts: fallback candidate ${next} could not take ${agentId}:`,
          switchError instanceof Error ? switchError.message : String(switchError),
        );
        continue;
      } finally {
        if (this.onReloadOpen.get(agentId) === own) this.onReloadOpen.delete(agentId);
      }
      await continueOn(stale);
      return;
    }
  }

  /**
   * Synchronous best-account pick from already-loaded account state (used for UI default preview).
   */
  pickBestSync(
    accounts: readonly AccountSummary[],
    model?: string | null,
    strategy: FallbackStrategy = this.service.fallbackSettings().strategy,
  ): string | null {
    const hasModel = Boolean(model && model.trim());
    const pool = hasModel ? quotaPoolForModel(model) : null;
    const now = Date.now();
    const candidates: Array<{
      id: string;
      orderIndex: number;
      score: number;
      weightedScore: number;
      soonestReset: number;
    }> = [];
    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index]!;
      if (!account.usable || !account.fallbackEnabled || account.status === "signed-out") continue;
      if (this.activeCooldown(account.id, pool)) continue;
      if (pool && (this.models?.supportsModel(account.id, model) === false || exhausted(account.quota, pool, now))) {
        continue;
      }
      candidates.push({
        id: account.id,
        orderIndex: index,
        score: poolRemainingScore(account.quota, pool, now),
        weightedScore: weightedPoolScore(account.quota, account.effectiveWeight, pool, now),
        soonestReset: poolSoonestReset(account.quota, pool, now),
      });
    }
    if (!candidates.length) return null;
    if (strategy === "quota") {
      candidates.sort((a, b) => b.score - a.score || a.orderIndex - b.orderIndex);
    } else if (strategy === "weighted") {
      candidates.sort((a, b) => b.weightedScore - a.weightedScore || b.score - a.score || a.orderIndex - b.orderIndex);
    } else if (strategy === "reset") {
      candidates.sort((a, b) => a.soonestReset - b.soonestReset || b.score - a.score || a.orderIndex - b.orderIndex);
    }
    return candidates[0]!.id;
  }

  /**
   * Picks the best eligible account from an ordered list using shared eligibility rules,
   * short bounded probes for unknown profiles (never risking hook timeouts), and optional score bounds.
   */
  private async selectFromOrdered(
    ordered: readonly AccountSummary[],
    tried: ReadonlySet<string>,
    model: string | null | undefined,
    strategy: FallbackStrategy,
    options?: { minScore?: number; requireKnownQuota?: boolean; budgetMs?: number },
    initialRevision?: number,
  ): Promise<string | null> {
    const hasModel = Boolean(model && model.trim());
    const pool = hasModel ? quotaPoolForModel(model) : null;
    const minScore = options?.minScore;
    const requireKnownQuota = options?.requireKnownQuota === true;
    const deadline = Date.now() + (options?.budgetMs ?? 8000);
    let lastAccounts = ordered;
    let lastRevision = initialRevision;
    const freshAccounts = async () => {
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        const fresh = await awaitWithin(this.service.state(), remaining);
        if (fresh) {
          lastAccounts = fresh.accounts;
          lastRevision = fresh.revision;
          return lastAccounts;
        }
      }
      // At the deadline, reuse a still-current snapshot without starting more I/O.
      if (lastRevision !== undefined && this.service.currentRevision() === lastRevision) return lastAccounts;
      return null;
    };
    const probe = async (accountId: string, remaining: number) => {
      const timeoutMs = Math.min(5000, remaining);
      const request = this.service.refreshOne(accountId, { skipPlan: true, timeoutMs });
      await awaitWithin(request, timeoutMs).catch(() => undefined);
    };

    const eligibleBeforeProbe = ordered.filter((account) => {
      if (tried.has(account.id)) return false;
      if (!account.fallbackEnabled || !account.usable || account.status === "signed-out") return false;
      if (this.activeCooldown(account.id, pool)) return false;
      if (hasModel && this.models?.supportsModel(account.id, model) === false) return false;
      return true;
    });
    if (!eligibleBeforeProbe.length) return null;

    const evaluate = (account: AccountSummary, orderIndex: number, now: number) => {
      if (!account.fallbackEnabled || !account.usable || account.status === "signed-out") return null;
      if (this.activeCooldown(account.id, pool)) return null;
      if (hasModel && this.models?.supportsModel(account.id, model) === false) return null;
      const known = this.service.knownQuota(account.id);
      if (pool && exhausted(known, pool, now)) return null;
      const score = poolRemainingScore(known, pool, now);
      if (requireKnownQuota && score < 0) return null;
      if (minScore !== undefined && (score < 0 || score <= minScore)) return null;
      return {
        id: account.id,
        orderIndex,
        score,
        weightedScore: weightedPoolScore(known, account.effectiveWeight, pool, now),
        soonestReset: poolSoonestReset(known, pool, now),
      };
    };

    // Priority order can short-circuit as soon as the first eligible candidate checks out.
    if (strategy === "order") {
      for (let index = 0; index < eligibleBeforeProbe.length; index += 1) {
        const account = eligibleBeforeProbe[index]!;
        const needsProbe = account.status === "unknown" && (account.id !== SYSTEM_ACCOUNT_ID || requireKnownQuota);
        if (needsProbe) {
          const remaining = deadline - Date.now();
          if (remaining > 0) await probe(account.id, remaining);
        }
        const accounts = await freshAccounts();
        if (!accounts) return null;
        const fresh = accounts.find((entry) => entry.id === account.id);
        if (!fresh) continue;
        const picked = evaluate(fresh, index, Date.now());
        if (picked) return picked.id;
      }
      return null;
    }

    // For quota/weighted/reset strategies, probe unknown profiles with bounded concurrency and shared time budget.
    const toProbe = eligibleBeforeProbe.filter(
      (account) => account.status === "unknown" && (account.id !== SYSTEM_ACCOUNT_ID || requireKnownQuota),
    );
    if (toProbe.length > 0) {
      let cursor = 0;
      const worker = async () => {
        while (cursor < toProbe.length) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const next = toProbe[cursor++]!;
          await probe(next.id, remaining);
        }
      };
      const concurrency = Math.min(3, toProbe.length);
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    }

    const accounts = await freshAccounts();
    if (!accounts) return null;
    const now = Date.now();
    const freshById = new Map(accounts.map((entry) => [entry.id, entry]));
    const candidates: Array<{
      id: string;
      orderIndex: number;
      score: number;
      weightedScore: number;
      soonestReset: number;
    }> = [];
    for (let index = 0; index < eligibleBeforeProbe.length; index += 1) {
      const fresh = freshById.get(eligibleBeforeProbe[index]!.id);
      if (!fresh) continue;
      const evaluated = evaluate(fresh, index, now);
      if (evaluated) candidates.push(evaluated);
    }

    if (!candidates.length) return null;
    if (strategy === "quota") {
      candidates.sort((a, b) => b.score - a.score || a.orderIndex - b.orderIndex);
    } else if (strategy === "weighted") {
      candidates.sort((a, b) => b.weightedScore - a.weightedScore || b.score - a.score || a.orderIndex - b.orderIndex);
    } else if (strategy === "reset") {
      candidates.sort((a, b) => a.soonestReset - b.soonestReset || b.score - a.score || a.orderIndex - b.orderIndex);
    }
    return candidates[0]!.id;
  }

  /**
   * Picks the best eligible account across all accounts for a new agent (Auto routing mode).
   */
  async pickBest(
    model?: string | null,
    strategy: FallbackStrategy = this.service.fallbackSettings().strategy,
    options?: { budgetMs?: number; tried?: ReadonlySet<string> },
  ): Promise<string | null> {
    const budget = options?.budgetMs ?? 8000;
    const deadline = Date.now() + budget;
    const state = await awaitWithin(this.service.state(), budget);
    if (!state) return null;
    return this.selectFromOrdered(
      state.accounts,
      options?.tried ?? new Set(),
      model,
      strategy,
      { budgetMs: Math.max(0, deadline - Date.now()) },
      state.revision,
    );
  }

  /**
   * The next account after `current` that can take work for `model`, respecting `fallbackEnabled`,
   * cooldowns for the model's quota pool, model support, and the configured selection strategy.
   */
  async pickNext(
    current: string,
    tried: ReadonlySet<string>,
    model?: string | null,
    strategy: FallbackStrategy = this.service.fallbackSettings().strategy,
    options?: { minScore?: number; requireKnownQuota?: boolean; budgetMs?: number },
  ): Promise<string | null> {
    const budget = options?.budgetMs ?? 8000;
    const deadline = Date.now() + budget;
    const state = await awaitWithin(this.service.state(), budget);
    if (!state) return null;
    const index = state.accounts.findIndex((account) => account.id === current);
    const ordered = index < 0 ? state.accounts : [...state.accounts.slice(index + 1), ...state.accounts.slice(0, index)];
    return this.selectFromOrdered(
      ordered,
      tried,
      model,
      strategy,
      { ...options, budgetMs: Math.max(0, deadline - Date.now()) },
      state.revision,
    );
  }

  private async pickHealthy(
    model: string | null | undefined,
    tried: ReadonlySet<string>,
    budgetMs: number,
    pick: (rejected: ReadonlySet<string>, remaining: number) => Promise<string | null>,
  ): Promise<string | null> {
    const deadline = Date.now() + budgetMs;
    const rejected = new Set(tried);
    while (Date.now() < deadline) {
      const id = await pick(rejected, deadline - Date.now());
      if (!id || rejected.has(id) || Date.now() >= deadline) break;
      rejected.add(id);
      try {
        this.service.assertAccountOpenable(id);
      } catch {
        continue;
      }
      const reason = await awaitWithin(this.healthOf(id, model), deadline - Date.now());
      if (reason === null && this.isEligible(id, model)) return id;
    }
    return null;
  }

  pickHealthyBest(model?: string | null, tried: ReadonlySet<string> = new Set(), options?: { budgetMs?: number }) {
    return this.pickHealthy(model, tried, options?.budgetMs ?? 8000, (rejected, budgetMs) =>
      this.pickBest(model, undefined, { tried: rejected, budgetMs }),
    );
  }

  pickHealthyNext(
    current: string,
    tried: ReadonlySet<string>,
    model?: string | null,
    strategy?: FallbackStrategy,
    options?: { minScore?: number; requireKnownQuota?: boolean; budgetMs?: number },
  ) {
    return this.pickHealthy(model, tried, options?.budgetMs ?? 8000, (rejected, budgetMs) =>
      this.pickNext(current, rejected, model, strategy, { ...options, budgetMs }),
    );
  }

  /**
   * Why an account cannot take a session right now, or null. Uses only what is already known:
   * a missing sign-in file, a signed-out or unsafe account, an exhausted quota, or a cooldown.
   */
  async healthOf(accountId: string, model?: string | null): Promise<FailureKind | null> {
    const pool = model?.trim() ? quotaPoolForModel(model) : null;
    const cooling = this.activeCooldown(accountId, pool);
    if (cooling) return cooling.reason;
    const state = await this.service.state();
    const account = state.accounts.find((entry) => entry.id === accountId);
    if (!account || !account.usable || account.status === "signed-out") return "auth";
    if (account.kind === "profile" && !(await this.service.hasSignInFile(accountId))) return "auth";
    if (pool && exhausted(this.service.knownQuota(accountId), pool)) return "quota";
    return null;
  }

  noteOpen(paseo: PaseoApi, agentId: string, from: string, to: string, reason: FailureKind) {
    return this.note(paseo, agentId, {
      event: "switch",
      reason,
      from: this.service.labelOf(from),
      to: this.service.labelOf(to),
      attempt: 0,
      retries: this.service.fallbackSettings().retries,
      message: "",
    });
  }

  /** Sends the resume prompt unless the agent is already busy, archived, or fallback was turned off. */
  private async resume(paseo: PaseoApi, agentId: string, stale: () => boolean): Promise<void> {
    if (stale()) return;
    if (!this.service.fallbackSettings().enabled) {
      this.chains.delete(agentId);
      return;
    }
    const handle = paseo.agents.ref(agentId);
    const snapshot = await handle.refresh().catch(() => null);
    if (stale()) return;
    if (!snapshot || snapshot.agent.archivedAt) {
      this.chains.delete(agentId);
      return;
    }
    if (snapshot.agent.activeTurn || snapshot.agent.status === "running" || snapshot.agent.status === "initializing") return;
    await handle.send(RESUME_PROMPT);
  }

  private async note(paseo: PaseoApi, agentId: string, event: FallbackEvent): Promise<void> {
    await paseo.agents
      .ref(agentId)
      .timeline.append({
        type: "plugin",
        id: `fallback-${Date.now()}-${++this.noteSeq}`,
        kind: FALLBACK_TIMELINE_KIND,
        version: 1,
        data: event,
      })
      .catch((error: unknown) => console.error("antigravity-accounts: could not add the fallback note", error));
  }

  private scheduleRetry(agentId: string, ms: number, task: () => Promise<void>): void {
    this.cancelRetry(agentId);
    const timer = setTimeout(() => {
      this.retryTimers.delete(agentId);
      void task().catch((error: unknown) => console.error("antigravity-accounts: retry failed", error));
    }, ms);
    this.retryTimers.set(agentId, timer);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.turnGen.clear();
    this.latestTurn.clear();
    this.onReloadOpen.clear();
    this.chains.clear();
  }
}
