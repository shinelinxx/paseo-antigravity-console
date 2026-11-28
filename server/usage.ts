import type { UsageSourceRegistration, UsageWindow } from "@getpaseo/plugin/server";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageScope,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { SYSTEM_ACCOUNT_ID, accountIdSchema, type QuotaGroup } from "../shared/contracts";
import type { AccountService } from "./accounts";
import { REAL_CLI_DIR, profileCliDir } from "./paths";
import { orderedAccountIds } from "./store";

const input = z.object({ accountId: accountIdSchema }).strict();

/** A hash of the account's antigravity-cli directory, the identity Paseo's own reader uses too. */
function accountKey(accountId: string): string {
  return hashAccountKey(accountId === SYSTEM_ACCOUNT_ID ? REAL_CLI_DIR : profileCliDir(accountId));
}

/** Lengths of the periods agy names, so Paseo can tell whether a quota lasts until its reset. */
const WINDOW_SECONDS: Readonly<Record<string, number>> = {
  "5h": 5 * 3600,
  daily: 86_400,
  weekly: 7 * 86_400,
  monthly: 30 * 86_400,
};

function shortWindow(window: string): string {
  const normalized = window.trim().toLowerCase();
  if (normalized === "weekly") return "wk";
  if (normalized === "daily") return "1d";
  if (normalized === "monthly") return "mo";
  return window.trim();
}

/** Matches Paseo's built-in Antigravity Usage labels (e.g. "Gemini · Weekly", "Claude and GPT · 5h"). */
function displayWindow(window: string, bucketName: string, sameWindowCount: number): string {
  const normalized = window.trim().toLowerCase();
  let base: string;
  if (normalized === "weekly") base = "Weekly";
  else if (normalized === "5h") base = "5h";
  else if (normalized === "daily") base = "Daily";
  else if (normalized === "monthly") base = "Monthly";
  else base = window.trim() || bucketName.replace(/\s*limit\s*remaining$/i, "").trim();
  if (sameWindowCount > 1) {
    const cleaned = bucketName.replace(/\s*limit\s*remaining$/i, "").trim();
    if (cleaned && cleaned.toLowerCase() !== base.toLowerCase()) return `${base} · ${cleaned}`;
  }
  return base;
}

function shortGroup(name: string): string {
  return name.trim().replace(/\s+models$/i, "").trim();
}

export function quotaWindows(groups: readonly QuotaGroup[]): UsageWindow[] {
  const includeGroup = groups.length > 1;
  return groups.flatMap((group) => {
    const groupLabel = shortGroup(group.name) || group.name.trim();
    return group.buckets.flatMap((bucket) => {
      if (!bucket.disabled && bucket.remainingFraction === null) return [];
      const used = bucket.disabled || bucket.remainingFraction === null ? null : (1 - bucket.remainingFraction) * 100;
      const normalizedWindow = bucket.window.trim().toLowerCase();
      const sameCount = group.buckets.filter((other) => other.window.trim().toLowerCase() === normalizedWindow).length;
      const period = shortWindow(bucket.window);
      const windowLabel = displayWindow(bucket.window, bucket.name, sameCount);
      return [
        windowFromUsedPct({
          id: bucket.id,
          label: `${groupLabel} · ${windowLabel}`,
          shortLabel: includeGroup ? `${groupLabel} ${period}`.trim() : period,
          summary: !bucket.disabled && normalizedWindow === "weekly",
          utilizationPct: used,
          durationSeconds: WINDOW_SECONDS[normalizedWindow],
          resetsAt: bucket.disabled ? null : bucket.resetTime,
          tone: used === null ? "default" : toneFromUsedPct(used),
        }),
      ];
    });
  });
}

/**
 * Reports all configured Antigravity accounts (including the system sign-in) on the host-wide
 * Usage screen with consistent provider naming, account labels, and Google AI plan badges.
 * Users can hide Paseo's built-in Antigravity card in Usage settings if they prefer only these
 * enriched cards.
 */
export function createUsageSource(service: AccountService): UsageSourceRegistration {
  return {
    id: "antigravity-accounts",
    label: "Antigravity",
    icon: "icon.svg",
    input,
    async discover(scope: UsageScope) {
      if (scope.kind !== "global") return [];
      await service.init();
      const snapshot = service.store.snapshot();
      const byId = new Map(snapshot.accounts.map((account) => [account.id, account]));
      return orderedAccountIds(snapshot).map((id) => ({
        key: accountKey(id),
        label: id === SYSTEM_ACCOUNT_ID ? snapshot.systemLabel : (byId.get(id)?.label ?? id),
        harness: "Antigravity",
        input: { accountId: id },
      }));
    },
    async fetch(value: unknown) {
      await service.init();
      const { accountId } = input.parse(value);
      const account = accountId === SYSTEM_ACCOUNT_ID ? null : service.store.get(accountId);
      if (accountId !== SYSTEM_ACCOUNT_ID && !account) {
        throw new Error("This Antigravity account was removed.");
      }
      if (account?.unsafeDetail) {
        return { status: "error", error: account.unsafeDetail };
      }
      const status = await service.quotaFor(accountId, 5 * 60_000);
      if (status.status === "signed-in" && status.quota) {
        const windows = quotaWindows(status.quota);
        if (windows.length === 0) {
          return unavailable({ kind: "no_quota", detail: "agy reported no quota for this account" });
        }
        return {
          status: "available",
          ...(status.plan ? { planLabel: status.plan.name } : {}),
          ...(status.checkedAt ? { observedAt: status.checkedAt } : {}),
          windows,
        };
      }
      if (status.status === "signed-out") {
        return unavailable({
          kind: "no_quota",
          detail: "Not signed in. Open Antigravity accounts to sign in.",
        });
      }
      return { status: "error", error: status.statusDetail ?? "Could not read Antigravity quota" };
    },
  };
}
