import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  ACCOUNT_METADATA_KEY,
  SYSTEM_ACCOUNT_ID,
  accountIdFromMetadata,
  isAntigravityProvider,
  type FallbackEvent,
} from "../shared/contracts";
import type { AccountService } from "./accounts";
import { sessionEnv } from "./agy";
import { conversationIdFrom } from "./context";
import type { PaseoApi } from "./types";

/** Agents that switch account once their running turn ends, plus in-flight manual switches. */
export class PendingSwitches {
  private readonly pending = new Map<string, string>();
  private readonly manualSwitching = new Set<string>();
  private readonly skippingRedirect = new Set<string>();
  private readonly sessionAccounts = new Map<string, string>();
  private readonly switching = new Map<string, Promise<unknown>>();

  set(agentId: string, accountId: string): void {
    this.pending.set(agentId, accountId);
  }

  has(agentId: string): boolean {
    return this.pending.has(agentId);
  }

  run<T>(agentId: string, change: () => Promise<T>): Promise<T> {
    const previous = this.switching.get(agentId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(change);
    this.switching.set(agentId, operation);
    return operation.finally(() => {
      if (this.switching.get(agentId) === operation) this.switching.delete(agentId);
    });
  }

  take(agentId: string): string | undefined {
    const value = this.pending.get(agentId);
    this.pending.delete(agentId);
    return value;
  }

  delete(agentId: string): void {
    this.pending.delete(agentId);
  }

  /** Drops any queued after-turn switches targeting an account that was signed out or removed. */
  cancelTarget(accountId: string): void {
    for (const [agentId, target] of this.pending.entries()) {
      if (target === accountId) this.pending.delete(agentId);
    }
  }

  beginManual(agentId: string): void {
    this.manualSwitching.add(agentId);
  }

  endManual(agentId: string): void {
    this.manualSwitching.delete(agentId);
  }

  isManual(agentId: string): boolean {
    return this.manualSwitching.has(agentId);
  }

  beginSkipRedirect(agentId: string): void {
    this.skippingRedirect.add(agentId);
  }

  endSkipRedirect(agentId: string): void {
    this.skippingRedirect.delete(agentId);
  }

  isSkippingRedirect(agentId: string): boolean {
    return this.manualSwitching.has(agentId) || this.skippingRedirect.has(agentId);
  }

  setSessionAccount(agentId: string, accountId: string): void {
    this.sessionAccounts.set(agentId, accountId);
  }

  sessionAccountOf(agentId: string): string | undefined {
    return this.sessionAccounts.get(agentId);
  }

  clearSessionAccount(agentId: string): void {
    this.sessionAccounts.delete(agentId);
  }
}

export interface SwitchInput {
  agentId: string;
  accountId: string;
  when: "now" | "after-turn";
  /** True when the user explicitly chose the account (bypasses automatic open redirect & fallback). */
  manual?: boolean;
  /** True when the caller already selected this exact account (bypasses automatic open redirect). */
  skipOpenRedirect?: boolean;
}

export interface SwitchOutcome {
  result: "switched" | "scheduled" | "unchanged";
  accountLabel: string;
}

/** Moves an agent to another account. The conversation stays because the store is shared. */
export function switchAgentAccount(
  paseo: PaseoApi,
  service: AccountService,
  pending: PendingSwitches,
  input: SwitchInput,
): Promise<SwitchOutcome> {
  return pending.run(input.agentId, () => applyAccountSwitch(paseo, service, pending, input));
}

async function applyAccountSwitch(
  paseo: PaseoApi,
  service: AccountService,
  pending: PendingSwitches,
  input: SwitchInput,
): Promise<SwitchOutcome> {
  const target = service.requireAccount(input.accountId);
  if (target?.unsafeDetail) throw new Error(target.unsafeDetail);
  const accountLabel = service.labelOf(input.accountId);
  if (target) {
    // Moving an agent onto an account that cannot run would strand it there.
    const status = await service.quotaFor(input.accountId, 5 * 60_000);
    if (status.status === "signed-out" || !(await service.hasSignInFile(input.accountId))) {
      throw new Error(`Sign in to "${accountLabel}" in Antigravity accounts before moving an agent to it.`);
    }
  }
  const handle = paseo.agents.ref(input.agentId);
  const refreshed = await handle.refresh();
  if (!refreshed) throw new Error("That agent no longer exists.");
  const agent = refreshed.agent;
  if (!isAntigravityProvider(agent.provider)) {
    throw new Error("Only Antigravity agents can switch Google accounts.");
  }
  if (agent.archivedAt) throw new Error("That agent is archived.");
  const current = accountIdFromMetadata(agent.metadata);
  if (current === input.accountId) {
    pending.delete(input.agentId);
    return { result: "unchanged", accountLabel };
  }
  const running = agent.status === "running" || agent.status === "initializing";
  if (input.when === "after-turn" && running) {
    pending.set(input.agentId, input.accountId);
    return { result: "scheduled", accountLabel };
  }
  pending.delete(input.agentId);
  const previousMetadata = agent.metadata?.[ACCOUNT_METADATA_KEY] ?? null;
  // An explicit "default" keeps the system choice even when another account is the default.
  await handle.setMetadata({ [ACCOUNT_METADATA_KEY]: input.accountId });
  pending.clearSessionAccount(input.agentId);
  if (input.manual) pending.beginManual(input.agentId);
  if (input.skipOpenRedirect) pending.beginSkipRedirect(input.agentId);
  try {
    const reopened = await handle.reload();
    if (!reopened || reopened.agent.status === "error") throw new Error("The provider session did not reopen.");
  } catch (error) {
    // Put the agent back where it worked, then report why the new account failed.
    const reason = error instanceof Error ? error.message : String(error);
    pending.clearSessionAccount(input.agentId);
    const restored = await handle
      .setMetadata({ [ACCOUNT_METADATA_KEY]: previousMetadata })
      .then(() => handle.reload())
      .then((result) => Boolean(result && result.agent.status !== "error"), () => false);
    if (!restored) pending.clearSessionAccount(input.agentId);
    throw new Error(
      `"${accountLabel}" could not open this agent: ${reason}` +
        (restored ? ` The agent stays on "${service.labelOf(current)}".` : ""),
    );
  } finally {
    if (input.skipOpenRedirect) pending.endSkipRedirect(input.agentId);
    if (input.manual) pending.endManual(input.agentId);
  }
  return { result: "switched", accountLabel };
}

export interface MigrateInput {
  fromAccountId: string;
  toAccountId: string;
  mode: "idle-only" | "after-turn" | "now";
}

export interface MigrateOutcome {
  switched: number;
  scheduled: number;
  skipped: number;
  failed: Array<{ agentId: string; title: string | null; error: string }>;
  targetLabel: string;
}

/** Moves all matching Antigravity agents from one account onto another. */
export async function migrateAccountAgents(
  paseo: PaseoApi,
  service: AccountService,
  pending: PendingSwitches,
  input: MigrateInput,
  onAgentMigrated?: (agentId: string) => void,
): Promise<MigrateOutcome> {
  if (input.fromAccountId === input.toAccountId) {
    throw new Error("Choose a different target account.");
  }
  service.requireAccount(input.fromAccountId);
  const target = service.requireAccount(input.toAccountId);
  if (target?.unsafeDetail) throw new Error(target.unsafeDetail);
  const targetLabel = service.labelOf(input.toAccountId);
  if (target) {
    const status = await service.quotaFor(input.toAccountId, 5 * 60_000);
    if (status.status === "signed-out" || !(await service.hasSignInFile(input.toAccountId))) {
      throw new Error(`Sign in to "${targetLabel}" before migrating agents to it.`);
    }
  }
  const { entries } = await paseo.agents.list();
  let switched = 0;
  let scheduled = 0;
  let skipped = 0;
  const failed: MigrateOutcome["failed"] = [];

  for (const { agent } of entries) {
    if (agent.archivedAt || !isAntigravityProvider(agent.provider)) continue;
    if (accountIdFromMetadata(agent.metadata) !== input.fromAccountId) continue;
    const running = agent.status === "running" || agent.status === "initializing";
    if (running && input.mode === "idle-only") {
      skipped += 1;
      continue;
    }
    try {
      onAgentMigrated?.(agent.id);
      const outcome = await switchAgentAccount(paseo, service, pending, {
        agentId: agent.id,
        accountId: input.toAccountId,
        when: input.mode === "now" ? "now" : "after-turn",
        manual: true,
      });
      if (outcome.result === "switched") switched += 1;
      else if (outcome.result === "scheduled") scheduled += 1;
      else skipped += 1;
    } catch (error) {
      failed.push({
        agentId: agent.id,
        title: agent.title ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { switched, scheduled, skipped, failed, targetLabel };
}

/** The fallback controller's part of the session-open path; kept as an interface to avoid an import cycle. */
export interface OpenFallback {
  healthOf(accountId: string, model?: string | null): Promise<FallbackEvent["reason"] | null>;
  redirectForOpen(
    paseo: PaseoApi,
    agentId: string,
    accountId: string,
    reason: FallbackEvent["reason"],
    record: boolean,
    model?: string | null,
  ): Promise<string | null>;
  pickNext(current: string, tried: ReadonlySet<string>, model?: string | null): Promise<string | null>;
}

export interface HookObservers {
  onConversationTurnStart?: (agentId: string, conversationId: string, accountId: string, startedAt: number) => void;
  onConversationTurnEnd?: (agentId: string) => void;
  onConversationTurn?: (conversationId: string, accountId: string, startedAt: number, endedAt: number) => Promise<void>;
  onAgentArchived?: (agentId: string) => void;
}

export function registerHooks(
  server: PluginServerContext,
  service: AccountService,
  pending: PendingSwitches,
  fallback?: OpenFallback,
  observers?: HookObservers,
): Array<() => void> {
  const removers: Array<() => void> = [];
  const activeTurns = new Map<string, { turnId: string | null; accountId: string; startedAt: number }>();
  const agentConversations = new Map<string, string>();

  async function resolveConversationId(paseo: PaseoApi, agentId: string): Promise<string | null> {
    const cached = agentConversations.get(agentId);
    if (cached) return cached;
    const snapshot = await paseo.agents.ref(agentId).refresh().catch(() => null);
    const conversationId = conversationIdFrom(snapshot?.agent.persistence);
    if (conversationId) agentConversations.set(agentId, conversationId);
    return conversationId;
  }

  // New Antigravity agents get the default account (or best fallback when configured & default is unavailable).
  removers.push(
    server.addHook("agent.create.before", async ({ request }) => {
      if (!isAntigravityProvider(request.config.provider)) return undefined;
      await service.init();
      const metadata = request.metadata ?? {};
      if (typeof metadata[ACCOUNT_METADATA_KEY] === "string") return undefined;
      const state = await service.state();
      const model = request.config.model ?? null;
      let chosen = state.defaultAccountId;
      const fallbackSettings = service.fallbackSettings();
      if (fallbackSettings.enabled && fallback) {
        const problem = await fallback.healthOf(chosen, model);
        if (problem) {
          const better = await fallback.pickNext(chosen, new Set([chosen]), model);
          if (better) chosen = better;
        }
      }
      if (chosen === SYSTEM_ACCOUNT_ID) return undefined;
      const account = service.store.get(chosen);
      if (
        !account ||
        account.unsafeDetail ||
        service.knownStatus(account.id) === "signed-out" ||
        !(await service.hasSignInFile(account.id))
      ) {
        // A default that cannot run would make every new agent fail; leave it on the system sign-in.
        console.warn(
          `antigravity-accounts: default account ${chosen} cannot run; new agent stays on the system sign-in`,
        );
        return undefined;
      }
      return {
        ...request,
        metadata: { ...metadata, [ACCOUNT_METADATA_KEY]: chosen },
      };
    }),
  );

  // Every launch of an Antigravity session gets the environment of its account.
  removers.push(
    server.addHook("agent.open.before", async ({ request }, { paseo }) => {
      if (!isAntigravityProvider(request.provider)) return undefined;
      await service.init();
      let accountId = accountIdFromMetadata(request.metadata);
      let verifiedSignInFile = false;
      // Fallback: an account known to be unable to serve gives way to the next one that can,
      // unless the user or fallback controller explicitly selected this account right now.
      if (service.fallbackSettings().enabled && fallback && !pending.isSkippingRedirect(request.agentId)) {
        const snapshot = await paseo.agents
          .ref(request.agentId)
          .refresh()
          .catch(() => null);
        const model = snapshot?.agent.model ?? null;
        const reason = await fallback.healthOf(accountId, model);
        if (reason) {
          const next = await fallback.redirectForOpen(
            paseo,
            request.agentId,
            accountId,
            reason,
            request.purpose === "interactive",
            model,
          );
          if (next) {
            accountId = next;
            verifiedSignInFile = true;
          }
        } else {
          verifiedSignInFile = true;
        }
      }
      const account = accountId === SYSTEM_ACCOUNT_ID ? null : service.store.get(accountId);
      if (accountId !== SYSTEM_ACCOUNT_ID) {
        const problem = !account
          ? "The Antigravity account this agent was using has been removed."
          : account.unsafeDetail ??
            (!verifiedSignInFile && !(await service.hasSignInFile(accountId))
              ? "This Antigravity account has no independent sign-in."
              : null);
        if (problem) {
          // Reading history is harmless on the system sign-in; running a turn is not.
          if (request.purpose === "history") accountId = SYSTEM_ACCOUNT_ID;
          else {
            throw new Error(
              `${problem} Switch the agent to another account with the account pill above the composer.`,
            );
          }
        }
      }
      if (accountId !== SYSTEM_ACCOUNT_ID) await service.ensureAccountProfile(accountId);
      if (request.purpose === "interactive") pending.setSessionAccount(request.agentId, accountId);
      return {
        ...request,
        env: { ...request.env, ...sessionEnv(accountId, request.env) },
      };
    }),
  );

  removers.push(
    server.addHook("agent.turn.before", async ({ agent, turnId }, { paseo }) => {
      if (!isAntigravityProvider(agent.provider)) return;
      const accountId = pending.sessionAccountOf(agent.id) ?? accountIdFromMetadata(agent.metadata);
      const startedAt = Date.now();
      const entry = { turnId, accountId, startedAt };
      activeTurns.set(agent.id, entry);
      if (observers?.onConversationTurnStart) {
        const conversationId = await resolveConversationId(paseo, agent.id);
        if (conversationId && activeTurns.get(agent.id) === entry) {
          observers.onConversationTurnStart(agent.id, conversationId, accountId, startedAt);
        }
      }
    }),
  );

  // Attribute only the observed turn, using the account selected when its provider session opened.
  const quotaRefresh = new Map<string, NodeJS.Timeout>();
  removers.push(
    server.addHook("agent.turn.after", async ({ agent, turnId }, { paseo }) => {
      if (!isAntigravityProvider(agent.provider)) return;
      const endedAt = Date.now();
      const active = activeTurns.get(agent.id);
      const turn =
        active && (active.turnId === turnId || active.turnId === null || turnId === null) ? active : undefined;
      if (turn) {
        activeTurns.delete(agent.id);
        observers?.onConversationTurnEnd?.(agent.id);
      }
      const accountId = turn?.accountId ?? pending.sessionAccountOf(agent.id) ?? accountIdFromMetadata(agent.metadata);
      await service.init();
      clearTimeout(quotaRefresh.get(accountId));
      quotaRefresh.set(
        accountId,
        setTimeout(() => {
          quotaRefresh.delete(accountId);
          void service.refreshOne(accountId).catch(() => undefined);
        }, 15_000),
      );
      if (turn && observers?.onConversationTurn) {
        const conversationId = await resolveConversationId(paseo, agent.id);
        if (conversationId) {
          await observers.onConversationTurn(conversationId, accountId, turn.startedAt, endedAt);
        }
      }
    }),
  );
  removers.push(() => {
    for (const timer of quotaRefresh.values()) clearTimeout(timer);
    quotaRefresh.clear();
    agentConversations.clear();
  });

  // Deferred switches run as soon as the agent's turn ends.
  removers.push(
    server.addHook("agent.turn.after", async ({ agent }, { paseo }) => {
      if (!pending.has(agent.id)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await pending.run(agent.id, async () => {
        const target = pending.take(agent.id);
        if (!target) return;
        try {
          // Recheck the state: a new turn may already be running, or the target may have signed out.
          await applyAccountSwitch(paseo, service, pending, {
            agentId: agent.id, accountId: target, when: "after-turn", manual: true,
          });
        } catch (error) {
          console.error(`antigravity-accounts: deferred switch of ${agent.id} failed`, error);
        }
      });
    }),
  );

  removers.push(
    server.addHook("agent.close.after", async ({ agent }, { paseo }) => {
      if (!isAntigravityProvider(agent.provider)) return;
      pending.clearSessionAccount(agent.id);
      const active = activeTurns.get(agent.id);
      if (active) {
        const endedAt = Date.now();
        activeTurns.delete(agent.id);
        observers?.onConversationTurnEnd?.(agent.id);
        if (observers?.onConversationTurn) {
          const conversationId = await resolveConversationId(paseo, agent.id);
          if (conversationId) {
            await observers.onConversationTurn(conversationId, active.accountId, active.startedAt, endedAt);
          }
        }
      }
      agentConversations.delete(agent.id);
    }),
  );

  removers.push(
    server.addHook("agent.archive.after", async ({ agent }) => {
      pending.delete(agent.id);
      pending.clearSessionAccount(agent.id);
      activeTurns.delete(agent.id);
      agentConversations.delete(agent.id);
      observers?.onConversationTurnEnd?.(agent.id);
      observers?.onAgentArchived?.(agent.id);
    }),
  );

  return removers;
}
