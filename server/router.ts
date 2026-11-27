import {
  SYSTEM_ACCOUNT_ID,
  quotaPoolForModel,
  type AccountSummary,
  type QuotaGroup,
  type RoutingMode,
} from "../shared/contracts";
import type { AccountService } from "./accounts";
import { exhausted, groupForPool, type ModelSupport } from "./fallback";

/** Quota water-level exponent: lower remaining fractions get progressively steeper de-weighting. */
const WATER_LEVEL_ALPHA = 1.5;
/** Concurrency & burst-dispatch damping factor (scaled by account weight). */
const CONCURRENCY_BETA = 0.5;
/** Half-life for recent dispatch timestamps so rapid parallel bursts spread across accounts. */
const DISPATCH_HALF_LIFE_MS = 3 * 60_000;
/** Prune dispatch history older than this window. */
const DISPATCH_RETENTION_MS = 15 * 60_000;
/** Weekly reset urgency window: boost slightly when >40% weekly quota is still unused near reset. */
const URGENCY_WINDOW_MS = 24 * 3_600_000;
const URGENCY_MIN_REMAINING = 0.4;
const URGENCY_MAX_BOOST = 0.25;

export interface PoolQuotaMetrics {
  /** Blended remaining fraction (0..1) combining 5h and weekly windows. */
  blendedRemaining: number;
  /** Minimum active remaining fraction across buckets in the pool, or null if unknown. */
  minRemaining: number | null;
  /** Reset urgency boost multiplier (1.0 .. 1.25). */
  urgency: number;
}

/** Evaluates remaining quota health and reset urgency for a single account + quota pool. */
export function evaluatePoolQuota(
  groups: readonly QuotaGroup[] | null,
  pool: "gemini" | "third-party",
  now = Date.now(),
): PoolQuotaMetrics {
  const group = groupForPool(groups, pool);
  if (!group) return { blendedRemaining: 1, minRemaining: null, urgency: 1 };

  const activeValues: number[] = [];
  let fiveHour: number | null = null;
  let weekly: number | null = null;
  let weeklyResetAt: number | null = null;

  for (const bucket of group.buckets) {
    if (bucket.disabled || bucket.remainingFraction === null) continue;
    const resetAt = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
    const expired = Number.isFinite(resetAt) && resetAt <= now;
    const fraction = expired ? 1 : bucket.remainingFraction;
    activeValues.push(fraction);
    const window = bucket.window.trim().toLowerCase();
    if (window === "5h") {
      fiveHour = fiveHour === null ? fraction : Math.min(fiveHour, fraction);
    } else if (window === "weekly") {
      weekly = weekly === null ? fraction : Math.min(weekly, fraction);
      if (!expired && Number.isFinite(resetAt) && resetAt > now) {
        weeklyResetAt = weeklyResetAt === null ? resetAt : Math.min(weeklyResetAt, resetAt);
      }
    }
  }

  if (activeValues.length === 0) return { blendedRemaining: 1, minRemaining: null, urgency: 1 };

  const minRemaining = Math.min(...activeValues);
  const blendedRemaining =
    fiveHour !== null && weekly !== null
      ? 0.7 * Math.min(fiveHour, weekly) + 0.3 * ((fiveHour + weekly) / 2)
      : minRemaining;

  let urgency = 1;
  if (weekly !== null && weekly > URGENCY_MIN_REMAINING && weeklyResetAt !== null) {
    const remainingMs = weeklyResetAt - now;
    if (remainingMs > 0 && remainingMs <= URGENCY_WINDOW_MS) {
      urgency = 1 + URGENCY_MAX_BOOST * (1 - remainingMs / URGENCY_WINDOW_MS);
    }
  }

  return { blendedRemaining, minRemaining, urgency };
}

/** Computes effective dynamic weight combining tier weight, remaining quota, reset urgency, and active load. */
export function computeEffectiveWeight(params: {
  baseWeight: number;
  metrics: PoolQuotaMetrics;
  runningCount?: number;
  recentDispatches?: number;
}): number {
  const { baseWeight, metrics, runningCount = 0, recentDispatches = 0 } = params;
  if (!Number.isFinite(baseWeight) || baseWeight <= 0) return 0;
  if (metrics.blendedRemaining <= 0.001) return 0;
  const capacityBase = Math.max(baseWeight, 0.25);
  const pressure = (Math.max(0, runningCount) + 0.5 * Math.max(0, recentDispatches)) / capacityBase;
  return (baseWeight * Math.pow(metrics.blendedRemaining, WATER_LEVEL_ALPHA) * metrics.urgency) / (1 + CONCURRENCY_BETA * pressure);
}

/** Exponentially decayed count of recent dispatches for an account. */
export function decayedDispatchCount(timestamps: readonly number[] | undefined, now = Date.now()): number {
  if (!timestamps?.length) return 0;
  let total = 0;
  for (const ts of timestamps) {
    const age = now - ts;
    if (age < 0 || age > DISPATCH_RETENTION_MS) continue;
    total += Math.pow(0.5, age / DISPATCH_HALF_LIFE_MS);
  }
  return total;
}

export interface RoutingCandidate {
  id: string;
  orderIndex: number;
  baseWeight: number;
  effectiveWeight: number;
  minRemaining: number | null;
}

/** Filters candidates to those above `reserveFraction` when at least one qualifies. */
export function applyReserveFloor(
  candidates: readonly RoutingCandidate[],
  reservePercent: number,
): RoutingCandidate[] {
  const positive = candidates.filter((candidate) => candidate.effectiveWeight > 0);
  if (positive.length === 0) return [];
  const floor = Math.max(0, Math.min(50, reservePercent)) / 100;
  if (floor <= 0) return positive;
  const healthy = positive.filter(
    (candidate) => candidate.minRemaining === null || candidate.minRemaining > floor,
  );
  return healthy.length > 0 ? healthy : positive;
}

/**
 * Pure dynamic Smooth Weighted Round-Robin (Nginx SWRR) step.
 * Mutates `currentWeights` in place so consecutive calls smoothly interleave across weighted accounts.
 */
export function pickSmoothWeighted(
  candidates: readonly RoutingCandidate[],
  currentWeights: Map<string, number>,
): RoutingCandidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const only = candidates[0]!;
    currentWeights.clear();
    currentWeights.set(only.id, 0);
    return only;
  }

  const activeIds = new Set(candidates.map((candidate) => candidate.id));
  for (const id of [...currentWeights.keys()]) {
    if (!activeIds.has(id)) currentWeights.delete(id);
  }

  let totalWeight = 0;
  let best: RoutingCandidate | null = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    totalWeight += candidate.effectiveWeight;
    const next = (currentWeights.get(candidate.id) ?? 0) + candidate.effectiveWeight;
    currentWeights.set(candidate.id, next);
    if (
      !best ||
      next > bestScore + 1e-9 ||
      (Math.abs(next - bestScore) <= 1e-9 &&
        (candidate.effectiveWeight > best.effectiveWeight + 1e-9 ||
          (Math.abs(candidate.effectiveWeight - best.effectiveWeight) <= 1e-9 &&
            candidate.orderIndex < best.orderIndex)))
    ) {
      best = candidate;
      bestScore = next;
    }
  }

  if (best) {
    currentWeights.set(best.id, bestScore - totalWeight);
  }
  return best;
}

/** Deterministic capacity-first pick: highest effective dynamic weight, tie-broken by order. */
export function pickCapacityFirst(candidates: readonly RoutingCandidate[]): RoutingCandidate | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (
      candidate.effectiveWeight > best.effectiveWeight + 1e-9 ||
      (Math.abs(candidate.effectiveWeight - best.effectiveWeight) <= 1e-9 &&
        candidate.orderIndex < best.orderIndex)
    ) {
      best = candidate;
    }
  }
  return best;
}

/** Computes normalized routing shares (0..1) for display on account cards. */
export function computeRoutingShares(
  accounts: readonly Pick<AccountSummary, "id" | "usable" | "status" | "quota" | "effectiveWeight" | "cooldowns">[],
  mode: RoutingMode,
  reservePercent: number,
  pool: "gemini" | "third-party" = "gemini",
  runningCounts?: ReadonlyMap<string, number>,
  now = Date.now(),
): Map<string, number> {
  const shares = new Map<string, number>();
  if (mode === "default") return shares;

  const candidates: RoutingCandidate[] = [];
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index]!;
    if (!account.usable || account.status === "signed-out") continue;
    if (account.effectiveWeight <= 0) continue;
    const cooling = account.cooldowns.some(
      (entry) => (entry.pool === "all" || entry.pool === pool) && Date.parse(entry.until) > now,
    );
    if (cooling) continue;
    if (exhausted(account.quota, pool, now)) continue;
    const metrics = evaluatePoolQuota(account.quota, pool, now);
    const effectiveWeight = computeEffectiveWeight({
      baseWeight: account.effectiveWeight,
      metrics,
      runningCount: runningCounts?.get(account.id) ?? 0,
    });
    if (effectiveWeight <= 0) continue;
    candidates.push({
      id: account.id,
      orderIndex: index,
      baseWeight: account.effectiveWeight,
      effectiveWeight,
      minRemaining: metrics.minRemaining,
    });
  }

  const eligible = applyReserveFloor(candidates, reservePercent);
  if (eligible.length === 0) return shares;

  if (mode === "capacity") {
    const winner = pickCapacityFirst(eligible);
    if (winner) shares.set(winner.id, 1);
    for (const candidate of eligible) {
      if (!shares.has(candidate.id)) shares.set(candidate.id, 0);
    }
    return shares;
  }

  const total = eligible.reduce((sum, item) => sum + item.effectiveWeight, 0);
  if (total <= 0) return shares;
  for (const candidate of eligible) {
    shares.set(candidate.id, candidate.effectiveWeight / total);
  }
  return shares;
}

export interface CooldownChecker {
  isCooling(accountId: string, pool: "gemini" | "third-party"): boolean;
}

/**
 * Session-level load balancer for newly created Antigravity agents.
 * Assigns an account once on creation so active sessions remain strictly sticky unless fallback triggers.
 */
export class AccountRouter {
  private readonly swrrByPool: Record<"gemini" | "third-party", Map<string, number>> = {
    gemini: new Map(),
    "third-party": new Map(),
  };
  private readonly dispatches = new Map<string, number[]>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly service: AccountService,
    private readonly cooldowns: CooldownChecker,
    private readonly models?: ModelSupport,
    private readonly runningCountOf: (accountId: string) => number = () => 0,
  ) {}

  /** Records a new session assignment so rapid parallel bursts don't pile onto one account. */
  recordDispatch(accountId: string, now = Date.now()): void {
    const existing = this.dispatches.get(accountId) ?? [];
    const kept = existing.filter((ts) => now - ts <= DISPATCH_RETENTION_MS);
    kept.push(now);
    this.dispatches.set(accountId, kept);
  }

  /** Resets SWRR accumulators (e.g. after weights or routing mode change). */
  reset(): void {
    this.swrrByPool.gemini.clear();
    this.swrrByPool["third-party"].clear();
  }

  /** Serializes concurrent `agent.create.before` picks so parallel spawns spread atomically. */
  pickForNewAgent(model?: string | null): Promise<string | null> {
    const task = this.queue.catch(() => undefined).then(() => this.selectAccount(model));
    this.queue = task;
    return task;
  }

  private async selectAccount(model?: string | null): Promise<string | null> {
    const routing = this.service.routingSettings();
    if (routing.mode === "default") return null;

    const pool = quotaPoolForModel(model);
    const state = await this.service.state();
    const now = Date.now();
    const candidates: RoutingCandidate[] = [];

    for (let index = 0; index < state.accounts.length; index += 1) {
      const account = state.accounts[index]!;
      const id = account.id;
      if (!account.usable || account.status === "signed-out") continue;
      if (account.effectiveWeight <= 0) continue;
      if (this.cooldowns.isCooling(id, pool)) continue;
      if (this.models?.supportsModel(id, model) === false) continue;

      let quota = this.service.knownQuota(id);
      if (account.status === "unknown") {
        await this.service.refreshOne(id).catch(() => undefined);
        quota = this.service.knownQuota(id);
        const freshStatus = this.service.knownStatus(id);
        if (freshStatus === "signed-out") continue;
      }
      if (exhausted(quota, pool, now)) continue;
      if (id !== SYSTEM_ACCOUNT_ID && !(await this.service.hasSignInFile(id))) continue;

      const supported = this.models?.ensureModelSupport
        ? await this.models.ensureModelSupport(id, model).catch(() => this.models?.supportsModel(id, model) ?? null)
        : (this.models?.supportsModel(id, model) ?? null);
      if (supported === false) continue;

      const metrics = evaluatePoolQuota(quota, pool, now);
      const effectiveWeight = computeEffectiveWeight({
        baseWeight: account.effectiveWeight,
        metrics,
        runningCount: this.runningCountOf(id),
        recentDispatches: decayedDispatchCount(this.dispatches.get(id), now),
      });
      if (effectiveWeight <= 0) continue;

      candidates.push({
        id,
        orderIndex: index,
        baseWeight: account.effectiveWeight,
        effectiveWeight,
        minRemaining: metrics.minRemaining,
      });
    }

    const eligible = applyReserveFloor(candidates, routing.reservePercent);
    if (eligible.length === 0) return null;

    const picked =
      routing.mode === "capacity"
        ? pickCapacityFirst(eligible)
        : pickSmoothWeighted(eligible, this.swrrByPool[pool]);
    if (!picked) return null;

    this.recordDispatch(picked.id, now);
    return picked.id;
  }
}
