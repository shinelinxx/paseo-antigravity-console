import {
  accountSupportsModel,
  quotaPoolForModel,
  type AccountCooldown,
  type AccountSummary,
  type FallbackStrategy,
  type QuotaBucket,
  type QuotaGroup,
} from "../shared/contracts";
export { accountSupportsModel };
import { percent } from "./format";

/** Picks the primary QuotaGroup matching a model pool (`gemini` vs `third-party`). */
export function groupForPool(
  groups: readonly QuotaGroup[] | null | undefined,
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
  return groups.find((group) => /gemini/i.test(group.name) && !/argon/i.test(group.name)) ?? groups[0] ?? null;
}

/**
 * Finds the most constrained active bucket for a named window ("5h", "weekly", "daily", "monthly"),
 * matching the server router's minimum-remaining aggregation so summaries never contradict routing.
 */
export function bucketForWindow(group: QuotaGroup | null | undefined, window: string): QuotaBucket | null {
  if (!group) return null;
  let chosen: QuotaBucket | null = null;
  for (const bucket of group.buckets) {
    if (bucket.disabled || bucket.window.trim().toLowerCase() !== window) continue;
    if (!chosen) {
      chosen = bucket;
      continue;
    }
    if (bucket.remainingFraction !== null) {
      if (chosen.remainingFraction === null || bucket.remainingFraction < chosen.remainingFraction) {
        chosen = bucket;
      }
    }
  }
  return chosen;
}

/** Minimum remaining fraction (0..1) across all active buckets of `pool`, or -1 when unknown. */
export function poolRemainingFraction(
  groups: readonly QuotaGroup[] | null | undefined,
  pool: "gemini" | "third-party" | null,
): number {
  if (!pool) return Math.max(poolRemainingFraction(groups, "gemini"), poolRemainingFraction(groups, "third-party"));
  const group = groupForPool(groups, pool);
  if (!group) return -1;
  let min = Infinity;
  for (const bucket of group.buckets) {
    if (bucket.disabled || bucket.remainingFraction === null) continue;
    if (bucket.remainingFraction < min) min = bucket.remainingFraction;
  }
  return Number.isFinite(min) ? min : -1;
}

/** Earliest reset timestamp among active buckets of `pool`, or Infinity when unknown. */
function poolSoonestReset(groups: readonly QuotaGroup[] | null | undefined, pool: "gemini" | "third-party" | null): number {
  if (!pool) return Math.min(poolSoonestReset(groups, "gemini"), poolSoonestReset(groups, "third-party"));
  const group = groupForPool(groups, pool);
  let soonest = Infinity;
  for (const bucket of group?.buckets ?? []) {
    if (bucket.disabled || !bucket.resetTime) continue;
    const at = Date.parse(bucket.resetTime);
    if (Number.isFinite(at) && at < soonest) soonest = at;
  }
  return soonest;
}

/** Compact "5H 82% / 7D 64%" readout for an account's quota pool matching `model`. */
export function compactQuotaSummary(
  account: AccountSummary,
  model: string | null | undefined,
  locale: string,
): string | null {
  if (account.status !== "signed-in" || !account.quota?.length) return null;
  const pool = quotaPoolForModel(model);
  const group = groupForPool(account.quota, pool);
  if (!group) return null;
  const fiveHour = bucketForWindow(group, "5h");
  const weekly = bucketForWindow(group, "weekly");
  const parts: string[] = [];
  if (fiveHour?.remainingFraction !== null && fiveHour?.remainingFraction !== undefined) {
    parts.push(`5H ${percent(fiveHour.remainingFraction, locale)}`);
  }
  if (weekly?.remainingFraction !== null && weekly?.remainingFraction !== undefined) {
    parts.push(`7D ${percent(weekly.remainingFraction, locale)}`);
  }
  if (parts.length === 0) {
    let minBucket: QuotaBucket | null = null;
    for (const bucket of group.buckets) {
      if (bucket.disabled || bucket.remainingFraction === null) continue;
      if (!minBucket || bucket.remainingFraction < (minBucket.remainingFraction ?? Infinity)) {
        minBucket = bucket;
      }
    }
    if (minBucket && minBucket.remainingFraction !== null) {
      parts.push(`${minBucket.window.toUpperCase()} ${percent(minBucket.remainingFraction, locale)}`);
    }
  }
  return parts.length > 0 ? parts.join(" / ") : null;
}

/** Active cooldown affecting `model`'s quota pool on `account`, or null. */
export function activeCooldownForModel(
  account: AccountSummary,
  model: string | null | undefined,
  now = Date.now(),
): AccountCooldown | null {
  const pool = model?.trim() ? quotaPoolForModel(model) : "unknown";
  for (const entry of account.cooldowns) {
    if (Date.parse(entry.until) <= now) continue;
    if (entry.pool === "all" || entry.pool === pool) return entry;
  }
  return null;
}

/**
 * Client-side preview matching the server's `pickBestSync` eligibility & strategy rules
 * so draft composers reflect the exact account Auto routing will pick for `model`.
 */
export function pickBestLocal(
  accounts: readonly AccountSummary[],
  model: string | null | undefined,
  strategy: FallbackStrategy,
  now = Date.now(),
): AccountSummary | null {
  const hasModel = Boolean(model && model.trim());
  const pool = hasModel ? quotaPoolForModel(model) : null;
  const candidates: Array<{
    account: AccountSummary;
    orderIndex: number;
    score: number;
    weightedScore: number;
    soonestReset: number;
  }> = [];
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index]!;
    if (!account.usable || !account.fallbackEnabled || account.status === "signed-out") continue;
    if (activeCooldownForModel(account, model, now)) continue;
    if (hasModel && accountSupportsModel(account, model) === false) continue;
    const score = poolRemainingFraction(account.quota, pool);
    if (hasModel && score >= 0 && score <= 0.001) continue;
    const baseWeight = account.effectiveWeight > 0 ? account.effectiveWeight : 0.01;
    candidates.push({
      account,
      orderIndex: index,
      score,
      weightedScore: baseWeight * (score >= 0 ? score : 0.5),
      soonestReset: poolSoonestReset(account.quota, pool),
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
  return candidates[0]!.account;
}
