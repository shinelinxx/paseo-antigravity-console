import type {
  PluginButton,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
  PluginText,
} from "@getpaseo/plugin/client";
import { useToast, type ToastApi } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import {
  SYSTEM_ACCOUNT_ID,
  accountIdFromMetadata,
  contextUsageRpc,
  getOrchestratorRpc,
  isAntigravityProvider,
  isOrchestratorModel,
  listAccountsRpc,
  quotaPoolForModel,
  setOrchestratorRpc,
  subagentCountsRpc,
  switchAgentAccountRpc,
  watchAccountsSubscription,
  type AccountsState,
  type AccountSummary,
  type ContextUsage,
  type ModelFamily,
  type OrchestratorState,
  type QuotaGroup,
} from "../shared/contracts";
import { ContextPopover, contextStore } from "./context";
import { percent, tokens } from "./format";
import { displayLabel, shortPlan } from "./labels";
import { errorMessage, messages } from "./messages";
import { resolvePresets, shortModelLabel } from "./orchestrator";

type AgentRow = {
  id: string;
  workspaceId?: string | null;
  archivedAt?: unknown;
  metadata?: Readonly<Record<string, unknown>> | null;
  provider: string;
  model?: string | null;
  title?: string | null;
  status: string;
};

export interface ObservedAgent {
  id: string;
  workspace: string | null;
  account: string;
  running: boolean;
  model: string | null;
  title: string | null;
}

type OpenSubagents = (agentId: string, workspaceId: string | null | undefined, subagentId?: string) => void;

/** An empty icon that keeps menu labels aligned with the checked one. */
const BLANK_ICON = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M0 0h24v24H0z" fill="none"/></svg>',
};

type Counts = ReadonlyMap<string, number>;
type WorkspaceSubagents = ReadonlyMap<string, number>;
type Timer = ReturnType<typeof setTimeout>;

const CONTEXT_POLL_MS = 5000;
const IDLE_POLL_MS = 30_000;
const POLL_BATCH_SIZE = 100;

export interface PoolQuotaSummary {
  fiveHour: number | null;
  weekly: number | null;
  /** Minimum active remaining fraction across all buckets in the model's pool. */
  minRemaining: number | null;
}

/** Remaining quota summary for the model's pool (5h, weekly, and overall minimum). */
export function poolQuotaInfo(
  quota: readonly QuotaGroup[] | null | undefined,
  model: string | null | undefined,
  now = Date.now(),
): PoolQuotaSummary {
  if (!quota?.length) return { fiveHour: null, weekly: null, minRemaining: null };
  const pool = quotaPoolForModel(model);
  const group =
    pool === "third-party"
      ? (quota.find((g) => /claude|gpt|3p|third/i.test(g.name)) ?? quota.find((g) => !/gemini/i.test(g.name)) ?? null)
      : (quota.find((g) => /gemini/i.test(g.name) && !/argon/i.test(g.name)) ?? quota[0] ?? null);
  if (!group) return { fiveHour: null, weekly: null, minRemaining: null };
  const enabled = group.buckets.filter((b) => !b.disabled && b.remainingFraction !== null);
  const pickWindow = (name: string) =>
    enabled.find((b) => b.window.trim().toLowerCase() === name)?.remainingFraction ?? null;
  const values = enabled.map((b) => {
    const resetAt = b.resetTime ? Date.parse(b.resetTime) : NaN;
    return Number.isFinite(resetAt) && resetAt <= now ? 1 : b.remainingFraction!;
  });
  return {
    fiveHour: pickWindow("5h"),
    weekly: pickWindow("weekly"),
    minRemaining: values.length ? Math.min(...values) : null,
  };
}

/** Compact 5h & weekly quota label (e.g. "5h 91% · 7d 91%") for pills and pickers. */
export function formatPoolQuota(info: PoolQuotaSummary, locale: string): string | null {
  const parts: string[] = [];
  if (info.fiveHour !== null) parts.push(`5h ${percent(info.fiveHour, locale)}`);
  if (info.weekly !== null) parts.push(`7d ${percent(info.weekly, locale)}`);
  if (parts.length > 0) return parts.join(" · ");
  return info.minRemaining !== null ? percent(info.minRemaining, locale) : null;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export function observeAgents(client: PluginClientContext, openSubagents: OpenSubagents) {
  const lifetime = new AbortController();
  const agents = new Map<string, ObservedAgent>();
  const accountPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const contextPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const subagentPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const orchestratorPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const accountPillSigs = new Map<string, string>();
  const contextPillSigs = new Map<string, string>();
  const subagentPillSigs = new Map<string, string>();
  const orchestratorPillSigs = new Map<string, string>();
  const subagentCounts = new Map<string, { total: number; running: number }>();
  const scheduledSwitches = new Map<string, string>();
  const lastPolledAt = new Map<string, number>();
  let orchestrator: OrchestratorState | undefined;
  const nativeContext = new Set<string>();
  const listeners = new Set<() => void>();
  const presenters = new Map<symbol, ToastApi>();
  let pendingNotice: string | undefined;
  let counts: Counts | null = null;
  let memberSnapshot: readonly ObservedAgent[] = [];
  let workspaceSubagents: WorkspaceSubagents = new Map();
  let accounts: AccountsState | undefined;
  let accountSignature = "";

  // Commands have no toast API of their own; mounted plugin surfaces lend theirs.
  function notify(message: string) {
    if (lifetime.signal.aborted) return;
    const presenter = presenters.values().next().value;
    if (presenter) presenter.show(message, { durationMs: 5000 });
    else pendingNotice = message;
  }

  function useNotifications() {
    const toast = useToast();
    useEffect(() => {
      const key = Symbol();
      presenters.set(key, toast);
      if (pendingNotice) {
        notify(pendingNotice);
        pendingNotice = undefined;
      }
      return () => {
        presenters.delete(key);
      };
    }, [toast]);
  }

  const nameOf = (label: string, kind?: AccountSummary["kind"]) =>
    displayLabel(label, (key) => client.i18n.t(messages, key), kind);

  function emit() {
    listeners.forEach((listener) => listener());
  }

  function publishWorkspaceSubagents(shouldEmit = true) {
    const next = new Map<string, number>();
    for (const agent of agents.values()) {
      if (!agent.workspace) continue;
      const running = subagentCounts.get(agent.id)?.running ?? 0;
      if (running > 0) next.set(agent.workspace, (next.get(agent.workspace) ?? 0) + running);
    }
    if (
      workspaceSubagents.size === next.size &&
      [...next].every(([ws, n]) => workspaceSubagents.get(ws) === n)
    ) {
      return;
    }
    workspaceSubagents = next;
    if (shouldEmit) emit();
  }

  async function switchTo(agentId: string, account: AccountSummary, when: "now" | "after-turn") {
    const result = await client.rpc(switchAgentAccountRpc, { agentId, accountId: account.id, when });
    if (result.result === "scheduled") scheduledSwitches.set(agentId, account.id);
    else scheduledSwitches.delete(agentId);
    const tracked = agents.get(agentId);
    if (tracked) renderAccountPill(tracked);
    notify(client.i18n.t(messages, result.result, { label: nameOf(result.accountLabel, account.kind) }));
  }

  // ---- Account pill -------------------------------------------------------------------------

  function renderAccountPill(agent: ObservedAgent) {
    if (!agent.workspace) return;
    const current = accounts?.accounts.find((account) => account.id === agent.account);
    const healthy = !current || (current.usable && current.status !== "signed-out");
    const scheduledTarget = agent.running ? scheduledSwitches.get(agent.id) : undefined;
    const now = Date.now();
    const pool = quotaPoolForModel(agent.model);
    const choices: PluginButtonMenuEntry<PluginText>[] = (accounts?.accounts ?? []).map((account) => {
      const selected = account.id === agent.account;
      const queuedHere = scheduledTarget === account.id;
      const unavailable = !account.usable || account.status === "signed-out";
      const label = nameOf(account.label, account.kind);
      const planTag = shortPlan(account.plan, label);
      const quotaInfo = !unavailable ? poolQuotaInfo(account.quota, agent.model, now) : null;
      const quotaText = quotaInfo ? formatPoolQuota(quotaInfo, client.i18n.locale) : null;
      const cooling = account.cooldowns.some(
        (c) => (c.pool === "all" || c.pool === pool) && Date.parse(c.until) > now,
      );
      const stateTag = unavailable
        ? client.i18n.t(messages, `status.${account.status}`)
        : quotaText;
      const action = (when: "now" | "after-turn") => ({
        kind: "action" as const,
        onPress: () => switchTo(agent.id, account, when),
      });
      return {
        kind: "item",
        id: account.id,
        title: [label, planTag, stateTag, cooling ? client.i18n.t(messages, "pillCooling") : null]
          .filter(Boolean)
          .join(" · "),
        icon: selected
          ? "Check"
          : queuedHere
            ? "Clock"
            : unavailable
              ? "UserX"
              : quotaInfo && quotaInfo.minRemaining !== null && quotaInfo.minRemaining <= 0.001
                ? "AlertTriangle"
                : "UserRound",
        disabled: (selected && !scheduledTarget) || unavailable,
        behavior:
          agent.running && !selected
            ? {
                kind: "menu",
                items: [
                  { kind: "item", id: "now", title: messages.message("now"), icon: "Zap", behavior: action("now") },
                  { kind: "item", id: "after", title: messages.message("after"), icon: "Clock", behavior: action("after-turn") },
                ],
              }
            : action("now"),
      };
    });
    if (choices.length) choices.push({ kind: "separator", id: "separator" });
    choices.push({
      kind: "item",
      id: "manage",
      title: messages.message("manage"),
      icon: "Settings2",
      behavior: { kind: "action", onPress: () => client.openScreen({ screenId: "accounts" }) },
    });
    const currentLabel = current ? nameOf(current.label, current.kind) : agent.account;
    const currentQuota =
      current && healthy ? formatPoolQuota(poolQuotaInfo(current.quota, agent.model, now), client.i18n.locale) : null;
    const label = currentQuota ? `${currentLabel} · ${currentQuota}` : currentLabel;
    const choiceSig = choices
      .map((entry) =>
        entry.kind === "separator"
          ? "-"
          : `${entry.id}:${typeof entry.title === "string" ? entry.title : ""}:${typeof entry.icon === "string" ? entry.icon : ""}:${entry.disabled ? 1 : 0}`,
      )
      .join("|");
    const sig = `${agent.workspace}|${healthy ? 1 : 0}|${agent.running ? 1 : 0}|${label}|${client.i18n.locale}|${choiceSig}`;
    const pill = accountPills.get(agent.id);
    if (pill && accountPillSigs.get(agent.id) === sig) return;
    accountPillSigs.set(agent.id, sig);
    const button: PluginButton<PluginText> = {
      icon: healthy ? "UserRound" : "UserX",
      title: healthy ? messages.message("pill") : messages.message("pillSignedOut"),
      label,
      behavior: { kind: "menu", items: choices },
    };
    if (pill) pill.update(button);
    else {
      accountPills.set(
        agent.id,
        client.addComposerPill({ id: "account", agentId: agent.id, workspaceId: agent.workspace, button }),
      );
    }
  }

  // ---- Context pill -------------------------------------------------------------------------

  function contextLabel(usage: ContextUsage | null | undefined): PluginText {
    if (!usage) return messages.message("context.labelEmpty");
    if (!usage.size) return messages.message("context.labelNoSize", { used: tokens(usage.used) });
    return messages.message("context.label", {
      used: tokens(usage.used),
      size: tokens(usage.size),
      pct: percent(usage.used / usage.size, client.i18n.locale),
    });
  }

  function renderContextPill(agent: ObservedAgent) {
    if (!agent.workspace || nativeContext.has(agent.id)) {
      contextPills.get(agent.id)?.remove();
      contextPills.delete(agent.id);
      contextPillSigs.delete(agent.id);
      return;
    }
    const usage = contextStore.get(agent.id);
    const sig = usage
      ? `${agent.workspace}|${usage.used}|${usage.size ?? ""}|${client.i18n.locale}`
      : `${agent.workspace}|empty|${client.i18n.locale}`;
    const pill = contextPills.get(agent.id);
    if (pill && contextPillSigs.get(agent.id) === sig) return;
    contextPillSigs.set(agent.id, sig);
    const label = contextLabel(usage);
    if (pill) pill.update({ label });
    else {
      const button: PluginButton<PluginText> = {
        icon: "Gauge",
        title: messages.message("context.title"),
        label,
        behavior: { kind: "popover", Content: ContextPopover },
      };
      contextPills.set(
        agent.id,
        client.addComposerPill({ id: "context", agentId: agent.id, workspaceId: agent.workspace, button }),
      );
    }
  }

  // ---- Subagent pill ------------------------------------------------------------------------

  function renderSubagentPill(agent: ObservedAgent) {
    const count = subagentCounts.get(agent.id);
    if (!agent.workspace || !count?.total) {
      subagentPills.get(agent.id)?.remove();
      subagentPills.delete(agent.id);
      subagentPillSigs.delete(agent.id);
      return;
    }
    const sig = `${agent.workspace}|${count.running}|${count.total}`;
    const pill = subagentPills.get(agent.id);
    if (pill && subagentPillSigs.get(agent.id) === sig) return;
    subagentPillSigs.set(agent.id, sig);
    const label = count.running
      ? messages.message("subagents.pillLabel", { running: count.running, total: count.total })
      : messages.message("subagents.pillLabelIdle", { total: count.total });
    if (pill) {
      pill.update({ label });
      return;
    }
    const workspace = agent.workspace;
    subagentPills.set(
      agent.id,
      client.addComposerPill({
        id: "subagents",
        agentId: agent.id,
        workspaceId: workspace,
        button: {
          icon: "Bot",
          title: messages.message("subagents.pill"),
          label,
          behavior: { kind: "action", onPress: () => openSubagents(agent.id, workspace) },
        },
      }),
    );
  }

  // ---- Orchestrator pill --------------------------------------------------------------------

  function effectiveOrchestrator(agent: ObservedAgent, state: OrchestratorState) {
    const override = agent.account !== SYSTEM_ACCOUNT_ID ? state.overrides[agent.account] : undefined;
    const savedPlanner = override ? override.planner : state.planner;
    const savedExecutor = override ? override.executor : state.executor;
    const plannerFamily = state.planners.find((family) => family.variants.some((variant) => variant.label === savedPlanner));
    const executorFamily = state.executors.find((family) => family.variants.some((variant) => variant.label === savedExecutor));
    return {
      isOverride: Boolean(override),
      savedPlanner,
      savedExecutor,
      effectivePlanner: plannerFamily && plannerFamily.accounts.includes(agent.account) ? savedPlanner : null,
      effectiveExecutor: executorFamily && executorFamily.accounts.includes(agent.account) ? savedExecutor : null,
    };
  }

  async function chooseOrchestrator(
    agent: ObservedAgent,
    patch: { planner?: string | null; executor?: string | null; accountId?: string; inheritGlobal?: boolean },
  ) {
    try {
      const { state, applied } = await client.rpc(setOrchestratorRpc, { ...patch, applyTo: agent.id });
      orchestrator = state;
      agents.forEach(renderOrchestratorPill);
      notify(client.i18n.t(messages, `orchestrator.applied.${applied}`));
    } catch (error) {
      notify(errorMessage(error));
    }
  }

  function roleMenu(
    agent: ObservedAgent,
    role: "planner" | "executor",
    families: readonly ModelFamily[],
    saved: string | null,
    overrideAccountId?: string,
  ): PluginButtonMenuEntry<PluginText>[] {
    const scope = overrideAccountId ? { accountId: overrideAccountId } : {};
    const entries: PluginButtonMenuEntry<PluginText>[] = families.map((family) => {
      const choose = (label: string) => ({
        kind: "action" as const,
        onPress: () => chooseOrchestrator(agent, { ...scope, [role]: label }),
      });
      const chosen = family.variants.some((variant) => variant.label === saved);
      const missing = !family.accounts.includes(agent.account);
      if (family.variants.length === 1) {
        const only = family.variants[0]!;
        return {
          kind: "item",
          id: family.id,
          title: only.label,
          icon: chosen ? "Check" : BLANK_ICON,
          disabled: missing,
          behavior: choose(only.label),
        };
      }
      return {
        kind: "item",
        id: family.id,
        title: family.label,
        icon: chosen ? "Check" : BLANK_ICON,
        disabled: missing,
        behavior: {
          kind: "menu",
          items: family.variants.map((variant) => ({
            kind: "item" as const,
            id: variant.id,
            title: variant.effort || variant.label,
            icon: variant.label === saved ? "Check" : BLANK_ICON,
            behavior: choose(variant.label),
          })),
        },
      };
    });
    entries.push({ kind: "separator", id: `${role}-separator` });
    entries.push({
      kind: "item",
      id: `${role}-default`,
      title: messages.message("orchestrator.default"),
      icon: saved ? BLANK_ICON : "Check",
      behavior: { kind: "action", onPress: () => chooseOrchestrator(agent, { ...scope, [role]: null }) },
    });
    return entries;
  }

  function renderOrchestratorPill(agent: ObservedAgent) {
    if (!agent.workspace || !isOrchestratorModel(agent.model) || !orchestrator) {
      orchestratorPills.get(agent.id)?.remove();
      orchestratorPills.delete(agent.id);
      orchestratorPillSigs.delete(agent.id);
      return;
    }
    const state = orchestrator;
    const { isOverride, savedPlanner, savedExecutor, effectivePlanner, effectiveExecutor } = effectiveOrchestrator(agent, state);
    const overrideAccountId = isOverride ? agent.account : undefined;
    let label: PluginText;
    if (effectivePlanner && effectiveExecutor) {
      label = `${shortModelLabel(effectivePlanner)} / ${shortModelLabel(effectiveExecutor)}`;
    } else if (effectivePlanner) {
      label = shortModelLabel(effectivePlanner);
    } else if (effectiveExecutor) {
      label = `${client.i18n.t(messages, "orchestrator.pillDefault")} / ${shortModelLabel(effectiveExecutor)}`;
    } else {
      label = messages.message("orchestrator.pillDefault");
    }

    const familiesSig = (families: readonly ModelFamily[]) =>
      families
        .map((f) => `${f.id}:${f.accounts.includes(agent.account) ? 1 : 0}:${f.variants.map((v) => v.id).join(",")}`)
        .join(";");
    const sig = `${agent.workspace}|${agent.account}|${isOverride ? 1 : 0}|${savedPlanner ?? ""}|${savedExecutor ?? ""}|${effectivePlanner ?? ""}|${effectiveExecutor ?? ""}|${client.i18n.locale}|${familiesSig(state.planners)}|${familiesSig(state.executors)}`;
    const pill = orchestratorPills.get(agent.id);
    if (pill && orchestratorPillSigs.get(agent.id) === sig) return;
    orchestratorPillSigs.set(agent.id, sig);

    const menuItems: PluginButtonMenuEntry<PluginText>[] = [
      {
        kind: "item",
        id: "planner",
        title: messages.message("orchestrator.planner"),
        icon: "Sparkles",
        behavior: { kind: "menu", items: roleMenu(agent, "planner", state.planners, savedPlanner, overrideAccountId) },
      },
      {
        kind: "item",
        id: "executor",
        title: messages.message("orchestrator.executor"),
        icon: "Cpu",
        behavior: { kind: "menu", items: roleMenu(agent, "executor", state.executors, savedExecutor, overrideAccountId) },
      },
      { kind: "separator", id: "separator" },
      {
        kind: "item",
        id: "manage",
        title: messages.message("orchestrator.manage"),
        icon: "Settings2",
        behavior: { kind: "action", onPress: () => client.openScreen({ screenId: "accounts" }) },
      },
    ];

    const button: PluginButton<PluginText> = {
      icon: "Workflow",
      title: isOverride ? messages.message("orchestrator.pillOverride") : messages.message("orchestrator.pillTitle"),
      label,
      behavior: { kind: "menu", items: menuItems },
    };
    if (pill) pill.update(button);
    else {
      orchestratorPills.set(
        agent.id,
        client.addComposerPill({ id: "orchestrator", agentId: agent.id, workspaceId: agent.workspace, button }),
      );
    }
  }

  async function readOrchestrator(refresh = false) {
    try {
      orchestrator = await client.rpc(getOrchestratorRpc, { refresh });
      agents.forEach(renderOrchestratorPill);
    } catch (error) {
      if (!lifetime.signal.aborted) console.warn("[antigravity-accounts] orchestrator settings unavailable", error);
    }
  }
  void readOrchestrator();
  const orchestratorTimer = setInterval(() => void readOrchestrator(), 10 * 60_000);

  let polling = false;
  async function pollContext(forceAll = false) {
    const now = Date.now();
    const due: string[] = [];
    for (const agent of agents.values()) {
      if (!agent.workspace) continue;
      const prev = lastPolledAt.get(agent.id) ?? 0;
      const hasRunningSubagents = (subagentCounts.get(agent.id)?.running ?? 0) > 0;
      if (forceAll || agent.running || hasRunningSubagents || prev === 0 || now - prev >= IDLE_POLL_MS) {
        due.push(agent.id);
      }
    }
    if (polling || lifetime.signal.aborted || due.length === 0) return;
    polling = true;
    try {
      for (const batch of chunk(due, POLL_BATCH_SIZE)) {
        if (lifetime.signal.aborted) break;
        const [contextRes, subagentRes] = await Promise.all([
          client.rpc(contextUsageRpc, { agentIds: batch }),
          client.rpc(subagentCountsRpc, { agentIds: batch }).catch(() => null),
        ]);
        const nativeSet = new Set(contextRes.native);
        for (const id of batch) {
          lastPolledAt.set(id, Date.now());
          const prevNative = nativeContext.has(id);
          const nextNative = nativeSet.has(id);
          const nativeChanged = prevNative !== nextNative;
          if (nextNative) nativeContext.add(id);
          else nativeContext.delete(id);

          const prevUsage = contextStore.get(id) ?? null;
          const nextUsage = contextRes.usage[id] ?? null;
          const usageChanged =
            (prevUsage === null) !== (nextUsage === null) ||
            (prevUsage !== null &&
              nextUsage !== null &&
              (prevUsage.used !== nextUsage.used ||
                prevUsage.size !== nextUsage.size ||
                prevUsage.input !== nextUsage.input ||
                prevUsage.cached !== nextUsage.cached ||
                prevUsage.output !== nextUsage.output ||
                prevUsage.sizeSource !== nextUsage.sizeSource ||
                prevUsage.updatedAt !== nextUsage.updatedAt ||
                prevUsage.model !== nextUsage.model));
          if (usageChanged) {
            contextStore.set(id, nextUsage);
          }

          // Only overwrite subagent counts when the RPC succeeded, avoiding flicker on transient failures.
          let subagentChanged = false;
          if (subagentRes) {
            const prevCount = subagentCounts.get(id);
            const found = subagentRes.counts[id];
            if (found) {
              if (!prevCount || prevCount.total !== found.total || prevCount.running !== found.running) {
                subagentCounts.set(id, found);
                subagentChanged = true;
              }
            } else if (prevCount) {
              subagentCounts.delete(id);
              subagentChanged = true;
            }
          }
          const agent = agents.get(id);
          if (agent) {
            if (nativeChanged || usageChanged || (!nextNative && !contextPills.has(id))) {
              renderContextPill(agent);
            }
            if (subagentChanged) {
              renderSubagentPill(agent);
            }
          }
        }
      }
      publishWorkspaceSubagents();
    } catch (error) {
      if (!lifetime.signal.aborted) console.warn("[antigravity-accounts] context refresh failed", error);
    } finally {
      polling = false;
    }
  }

  let soon: Timer | undefined;
  function pollSoon(forceAll = false) {
    clearTimeout(soon);
    soon = setTimeout(() => void pollContext(forceAll), 800);
  }
  const contextTimer = setInterval(() => void pollContext(), CONTEXT_POLL_MS);

  // ---- Accounts -----------------------------------------------------------------------------

  let cooldownTimer: Timer | undefined;
  function scheduleCooldownRefresh() {
    clearTimeout(cooldownTimer);
    if (lifetime.signal.aborted || !accounts) return;
    const now = Date.now();
    let earliest = Infinity;
    for (const account of accounts.accounts) {
      for (const cooldown of account.cooldowns) {
        const until = Date.parse(cooldown.until);
        if (Number.isFinite(until) && until > now && until < earliest) earliest = until;
      }
    }
    if (!Number.isFinite(earliest)) return;
    const waitMs = Math.min(2_147_483_647, Math.max(250, earliest - now + 250));
    cooldownTimer = setTimeout(() => {
      if (lifetime.signal.aborted) return;
      agents.forEach(renderAccountPill);
      scheduleCooldownRefresh();
    }, waitMs);
  }

  function applyAccounts(next: AccountsState) {
    if (lifetime.signal.aborted || (accounts && accounts.revision > next.revision)) return;
    accounts = next;
    for (const [agentId, targetId] of scheduledSwitches.entries()) {
      const target = next.accounts.find((entry) => entry.id === targetId);
      if (!target || !target.usable || target.status === "signed-out") scheduledSwitches.delete(agentId);
    }
    agents.forEach(renderAccountPill);
    scheduleCooldownRefresh();
    // Refresh Orchestrator model lists whenever account membership, sign-in state, or overrides change.
    const nextSignature = next.accounts
      .map((a) => `${a.id}:${a.status}:${a.email ?? ""}:${JSON.stringify(a.orchestratorOverride)}`)
      .join("|");
    if (accountSignature && nextSignature !== accountSignature) {
      void readOrchestrator(true);
    }
    accountSignature = nextSignature;
  }

  let retry: Timer | undefined;
  async function readAccounts() {
    try {
      applyAccounts(await client.rpc(listAccountsRpc, {}));
    } catch (error) {
      if (lifetime.signal.aborted) return;
      console.warn("[antigravity-accounts] account list unavailable", error);
      clearTimeout(retry);
      retry = setTimeout(readAccounts, 5000);
    }
  }

  const watch = client.subscribe(
    watchAccountsSubscription,
    {},
    ({ revision }) => {
      if (revision > (accounts?.revision ?? -1)) void readAccounts();
    },
    { signal: lifetime.signal },
  );
  void watch.ready.catch((error: unknown) => {
    if (!lifetime.signal.aborted) console.warn("[antigravity-accounts] account watch unavailable", error);
  });
  void readAccounts();

  // ---- Agents -------------------------------------------------------------------------------

  function publishAgents() {
    const nextCounts = new Map<string, number>();
    const nextMembers: ObservedAgent[] = [];
    for (const member of agents.values()) {
      nextMembers.push(member);
      nextCounts.set(member.account, (nextCounts.get(member.account) ?? 0) + 1);
    }
    counts = nextCounts;
    memberSnapshot = nextMembers;
    publishWorkspaceSubagents(false);
    emit();
  }

  function remove(id: string): boolean {
    const had = agents.delete(id);
    accountPills.get(id)?.remove();
    accountPills.delete(id);
    accountPillSigs.delete(id);
    contextPills.get(id)?.remove();
    contextPills.delete(id);
    contextPillSigs.delete(id);
    subagentPills.get(id)?.remove();
    subagentPills.delete(id);
    subagentPillSigs.delete(id);
    orchestratorPills.get(id)?.remove();
    orchestratorPills.delete(id);
    orchestratorPillSigs.delete(id);
    subagentCounts.delete(id);
    scheduledSwitches.delete(id);
    lastPolledAt.delete(id);
    nativeContext.delete(id);
    contextStore.delete(id);
    return had;
  }

  function upsert(row: AgentRow): boolean {
    if (row.archivedAt || !isAntigravityProvider(row.provider)) return remove(row.id);
    const member: ObservedAgent = {
      id: row.id,
      workspace: row.workspaceId ?? null,
      account: accountIdFromMetadata(row.metadata),
      running: row.status === "running" || row.status === "initializing",
      model: row.model ?? null,
      title: row.title ?? null,
    };
    const old = agents.get(row.id);
    if (!member.running || (old && old.account !== member.account)) {
      scheduledSwitches.delete(row.id);
    }
    // A status change usually means a turn started or ended: context changes then.
    if (!old || old.running !== member.running) {
      lastPolledAt.delete(row.id);
      pollSoon();
    }
    if (
      old &&
      old.workspace === member.workspace &&
      old.account === member.account &&
      old.running === member.running &&
      old.model === member.model &&
      old.title === member.title
    ) {
      return false;
    }
    if (old && old.workspace !== member.workspace) remove(row.id);
    agents.set(row.id, member);
    renderAccountPill(member);
    renderContextPill(member);
    renderSubagentPill(member);
    renderOrchestratorPill(member);
    return true;
  }

  let reconnect: Timer | undefined;
  async function observe() {
    try {
      const { subscription } = await client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal });
      if (lifetime.signal.aborted) return;
      subscription.subscribe({
        snapshot({ entries }) {
          if (lifetime.signal.aborted) return;
          let changed = false;
          const ids = new Set(entries.map(({ agent }) => agent.id));
          for (const id of agents.keys()) {
            if (!ids.has(id) && remove(id)) changed = true;
          }
          for (const { agent } of entries) {
            if (upsert(agent)) changed = true;
          }
          if (changed || counts === null) publishAgents();
        },
        update(message) {
          if (lifetime.signal.aborted || message.type !== "agent_update") return;
          const update = message.payload;
          const changed = update.kind === "remove" ? remove(update.agentId) : upsert(update.agent);
          if (changed) publishAgents();
        },
      });
    } catch (error) {
      if (lifetime.signal.aborted) return;
      console.warn("[antigravity-accounts] agent observation unavailable", error);
      reconnect = setTimeout(observe, 5000);
    }
  }
  void observe();

  // ---- /account & /orchestrator -------------------------------------------------------------

  const slashAccount = client.addSlashCommand({
    name: "account",
    context: "agent",
    description: messages.message("slash"),
    argumentHint: messages.message("hint"),
    async onSubmit({ agent, args }) {
      if (!isAntigravityProvider(agent.provider)) return notify(client.i18n.t(messages, "only"));
      const state = await client.rpc(listAccountsRpc, {});
      applyAccounts(state);
      const list = state.accounts;
      const current = accountIdFromMetadata(agent.metadata);
      const input = args.trim().toLowerCase();
      if (!input) {
        const curAccount = list.find((account) => account.id === current);
        const now = Date.now();
        return notify(
          client.i18n.t(messages, "choices", {
            label: curAccount ? nameOf(curAccount.label, curAccount.kind) : current,
            list: list
              .map((account, index) => {
                const label = nameOf(account.label, account.kind);
                const unavailable = !account.usable || account.status === "signed-out";
                const quotaText = !unavailable
                  ? formatPoolQuota(poolQuotaInfo(account.quota, agent.model, now), client.i18n.locale)
                  : null;
                const suffix = unavailable
                  ? ` (${client.i18n.t(messages, `status.${account.status}`)})`
                  : quotaText
                    ? ` (${quotaText})`
                    : "";
                return `${index + 1}. ${label}${suffix}`;
              })
              .join("\n"),
          }),
        );
      }
      const named = (account: AccountSummary) => nameOf(account.label, account.kind).toLowerCase();
      let matches = list.filter((account) => named(account) === input || account.label.toLowerCase() === input);
      if (/^\d+$/.test(input)) matches = list.slice(Number(input) - 1, Number(input));
      else if (!matches.length) matches = list.filter((account) => named(account).startsWith(input));
      if (matches.length !== 1) return notify(client.i18n.t(messages, matches.length ? "ambiguous" : "noMatch"));
      const target = matches[0]!;
      if (!target.usable || target.status === "signed-out") {
        return notify(target.statusDetail || client.i18n.t(messages, "unusable"));
      }
      const busy = agent.status === "running" || agent.status === "initializing";
      await switchTo(agent.id, target, busy ? "after-turn" : "now");
    },
  });

  const slashOrchestrator = client.addSlashCommand({
    name: "orchestrator",
    context: "agent",
    description: messages.message("orchestrator.slash"),
    argumentHint: messages.message("orchestrator.slashHint"),
    async onSubmit({ agent, args }) {
      if (!isAntigravityProvider(agent.provider)) return notify(client.i18n.t(messages, "only"));
      const state = await client.rpc(getOrchestratorRpc, {});
      orchestrator = state;
      const member = agents.get(agent.id) ?? {
        id: agent.id,
        workspace: agent.workspaceId ?? null,
        account: accountIdFromMetadata(agent.metadata),
        running: agent.status === "running" || agent.status === "initializing",
        model: agent.model ?? null,
        title: agent.title ?? null,
      };
      const input = args.trim();
      const eff = effectiveOrchestrator(member, state);
      const scope = eff.isOverride ? { accountId: member.account } : {};
      if (!input) {
        return notify(
          client.i18n.t(messages, "orchestrator.slashCurrent", {
            planner: eff.savedPlanner ?? client.i18n.t(messages, "orchestrator.default"),
            executor: eff.savedExecutor ?? client.i18n.t(messages, "orchestrator.default"),
          }),
        );
      }
      const lower = input.toLowerCase();
      const presets = resolvePresets(state);
      const preset = presets.find((p) => p.id === lower);
      if (preset) {
        await chooseOrchestrator(member, { ...scope, planner: preset.planner, executor: preset.executor });
        return;
      }
      const [first, ...rest] = input.split(/\s+/);
      const role = first?.toLowerCase() === "planner" || first?.toLowerCase() === "executor" ? (first.toLowerCase() as "planner" | "executor") : null;
      const query = (role ? rest.join(" ") : input).trim().toLowerCase();
      const findVariant = (families: readonly ModelFamily[]) => {
        if (query === "default" || query === "reset") return null;
        for (const family of families) {
          for (const variant of family.variants) {
            if (
              variant.label.toLowerCase() === query ||
              variant.id.toLowerCase() === query ||
              shortModelLabel(variant.label).toLowerCase() === query
            ) {
              return variant.label;
            }
          }
        }
        for (const family of families) {
          for (const variant of family.variants) {
            if (variant.label.toLowerCase().includes(query) || variant.id.toLowerCase().includes(query)) {
              return variant.label;
            }
          }
        }
        return undefined;
      };
      if (role) {
        const picked = findVariant(role === "planner" ? state.planners : state.executors);
        if (picked === undefined) return notify(client.i18n.t(messages, "orchestrator.slashNoMatch"));
        await chooseOrchestrator(member, { ...scope, [role]: picked });
        return;
      }
      const asPlanner = findVariant(state.planners);
      if (asPlanner !== undefined) {
        await chooseOrchestrator(member, { ...scope, planner: asPlanner });
        return;
      }
      const asExecutor = findVariant(state.executors);
      if (asExecutor !== undefined) {
        await chooseOrchestrator(member, { ...scope, executor: asExecutor });
        return;
      }
      notify(client.i18n.t(messages, "orchestrator.slashNoMatch"));
    },
  });

  return {
    useNotifications,
    notify,
    counts: () => counts,
    members: () => memberSnapshot,
    workspaceRunningSubagents: () => workspaceSubagents,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refreshContext: () => pollContext(true),
    /** Settings changed elsewhere (the console screen): redraw the Orchestrator pills. */
    setOrchestrator(state: OrchestratorState) {
      orchestrator = state;
      agents.forEach(renderOrchestratorPill);
    },
    stop() {
      lifetime.abort();
      clearTimeout(retry);
      clearTimeout(reconnect);
      clearTimeout(soon);
      clearTimeout(cooldownTimer);
      clearInterval(contextTimer);
      clearInterval(orchestratorTimer);
      slashAccount();
      slashOrchestrator();
      accountPills.forEach((pill) => pill.remove());
      contextPills.forEach((pill) => pill.remove());
      subagentPills.forEach((pill) => pill.remove());
      orchestratorPills.forEach((pill) => pill.remove());
      accountPills.clear();
      contextPills.clear();
      subagentPills.clear();
      orchestratorPills.clear();
      accountPillSigs.clear();
      contextPillSigs.clear();
      subagentPillSigs.clear();
      orchestratorPillSigs.clear();
      subagentCounts.clear();
      scheduledSwitches.clear();
      lastPolledAt.clear();
      agents.clear();
      listeners.clear();
      presenters.clear();
      contextStore.clear();
      pendingNotice = undefined;
    },
  };
}

export type AgentObservation = ReturnType<typeof observeAgents>;
