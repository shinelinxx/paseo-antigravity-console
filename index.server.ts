import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelSignInRpc,
  clearCooldownRpc,
  contextUsageRpc,
  createAccountRpc,
  getOrchestratorRpc,
  getPricingRpc,
  listAccountsRpc,
  listSubagentsRpc,
  migrateAccountAgentsRpc,
  moveAccountRpc,
  recoverSavedFilesRpc,
  refreshAccountsRpc,
  removeAccountRpc,
  renameAccountRpc,
  savedFilesRpc,
  setAccountOptionsRpc,
  setDefaultAccountRpc,
  setFallbackRpc,
  setOrchestratorRpc,
  setPricingRpc,
  signOutAccountRpc,
  startSignInRpc,
  subagentArtifactRpc,
  subagentCountsRpc,
  subagentDetailRpc,
  submitSignInRpc,
  switchAgentAccountRpc,
  usageDailyRpc,
  usageStatsRpc,
  watchAccountsSubscription,
} from "./shared/contracts";
import { AccountService } from "./server/accounts";
import { ContextReader } from "./server/context";
import { FallbackController } from "./server/fallback";
import { PendingSwitches, migrateAccountAgents, registerHooks, switchAgentAccount } from "./server/hooks";
import { OrchestratorSettings } from "./server/orchestrator";
import { PricingStore } from "./server/pricing";
import { UsageStatsReader } from "./server/stats";
import { SubagentReader } from "./server/subagents";
import { createUsageSource } from "./server/usage";

export default function contribute(server: PluginServerContext) {
  const service = new AccountService();
  const pending = new PendingSwitches();
  const context = new ContextReader();
  const stats = new UsageStatsReader();
  const pricing = new PricingStore();
  const subagents = new SubagentReader(context);
  const orchestrator = new OrchestratorSettings(service);
  const ready = Promise.all([service.init(), pricing.load()]).then(() => undefined);

  // Learn every account's state once in the background so the composer can show it.
  const warmup = setTimeout(() => {
    void ready.then(() => service.refreshAll()).catch((error: unknown) => {
      console.error("antigravity-accounts: initial refresh failed", error);
    });
  }, 3000);

  // Keep quota fresh for the sidebar and clear past reset windows promptly.
  const quotaTimer = setInterval(() => {
    void ready
      .then(async () => {
        const state = await service.state();
        const now = Date.now();
        const due = new Set<string>([state.defaultAccountId]);
        for (const account of state.accounts) {
          if (!account.usable || account.status !== "signed-in" || !account.quota) continue;
          const expired = account.quota.some((group) =>
            group.buckets.some((bucket) => {
              if (bucket.disabled || !bucket.resetTime) return false;
              const resetAt = Date.parse(bucket.resetTime);
              return Number.isFinite(resetAt) && resetAt <= now;
            }),
          );
          if (expired) due.add(account.id);
        }
        await Promise.all([...due].map((id) => service.refreshOne(id)));
      })
      .catch(() => undefined);
  }, 3 * 60_000);
  const sweepTimer = setInterval(() => {
    void ready.then(() => service.refreshAll()).catch(() => undefined);
  }, 15 * 60_000);

  const fallback = new FallbackController(service, pending, orchestrator);
  const removers = registerHooks(server, service, pending, fallback, {
    onConversationTurnStart: (agentId, conversationId, accountId, startedAt) =>
      stats.beginConversationTurn(agentId, conversationId, accountId, startedAt),
    onConversationTurnEnd: (agentId) => stats.endConversationTurn(agentId),
    onConversationTurn: (conversationId, accountId, startedAt, endedAt) =>
      stats.recordConversationTurn(conversationId, accountId, startedAt, endedAt),
    onAgentArchived: (agentId) => {
      context.forget(agentId);
      subagents.forget(agentId);
    },
  });
  removers.push(fallback.register(server));
  removers.push(...orchestrator.register(server));
  server.registerUsageSource(createUsageSource(service));

  server.handle(listAccountsRpc, async ({ refresh }) => {
    await ready;
    if (refresh) await service.refreshAll({ forcePlan: true });
    return service.state();
  });

  server.handle(refreshAccountsRpc, async ({ accountId }) => {
    await ready;
    if (accountId) {
      service.requireAccount(accountId);
      await service.refreshOne(accountId, { forcePlan: true });
      orchestrator.invalidateAccount(accountId);
    } else {
      await service.refreshAll({ forcePlan: true });
    }
    return service.state();
  });

  server.handle(createAccountRpc, async ({ label }) => {
    await ready;
    const account = await service.create(label);
    return { account, state: await service.state() };
  });

  server.handle(renameAccountRpc, async ({ accountId, label }) => {
    await ready;
    await service.rename(accountId, label);
    return service.state();
  });

  server.handle(moveAccountRpc, async ({ accountId, direction }) => {
    await ready;
    await service.move(accountId, direction);
    return service.state();
  });

  server.handle(setAccountOptionsRpc, async ({ accountId, fallbackEnabled, orchestratorOverride }) => {
    await ready;
    await service.setAccountOptions(accountId, { fallbackEnabled, orchestratorOverride });
    return service.state();
  });

  server.handle(clearCooldownRpc, async ({ accountId }) => {
    await ready;
    if (accountId) service.requireAccount(accountId);
    fallback.clearCooldown(accountId);
    return service.state();
  });

  server.handle(setFallbackRpc, async (patch) => {
    await ready;
    await service.setFallback(patch);
    if (patch.enabled === false) fallback.cancelAllRetries();
    return service.state();
  });

  server.handle(setDefaultAccountRpc, async ({ accountId }) => {
    await ready;
    await service.setDefault(accountId);
    return service.state();
  });

  server.handle(savedFilesRpc, async ({ accountId }) => {
    await ready;
    return service.savedFiles(accountId);
  });

  server.handle(recoverSavedFilesRpc, async ({ accountId }) => {
    await ready;
    const moved = await service.recoverSavedFiles(accountId);
    return { moved };
  });

  server.handle(removeAccountRpc, async ({ accountId }) => {
    await ready;
    pending.cancelTarget(accountId);
    const moved = await service.remove(accountId);
    fallback.clearCooldown(accountId);
    orchestrator.invalidateAccount(accountId);
    return { state: await service.state(), moved };
  });

  server.handle(signOutAccountRpc, async ({ accountId }) => {
    await ready;
    pending.cancelTarget(accountId);
    await service.signOut(accountId);
    fallback.clearCooldown(accountId);
    orchestrator.invalidateAccount(accountId);
    return service.state();
  });

  server.handle(startSignInRpc, async ({ accountId }) => {
    await ready;
    return service.startSignIn(accountId);
  });

  server.handle(submitSignInRpc, async ({ loginId, code }) => {
    await ready;
    const accountId = service.signIns.accountOf(loginId);
    await service.submitSignIn(loginId, code);
    if (accountId) {
      fallback.clearCooldown(accountId);
      orchestrator.invalidateAccount(accountId);
    }
    return service.state();
  });

  server.handle(cancelSignInRpc, async ({ loginId }) => {
    service.cancelSignIn(loginId);
    return {};
  });

  server.handle(switchAgentAccountRpc, async (input, { paseo }) => {
    await ready;
    fallback.cancelAgent(input.agentId);
    const outcome = await switchAgentAccount(paseo, service, pending, { ...input, manual: true });
    if (outcome.result !== "unchanged") fallback.clearCooldown(input.accountId);
    return outcome;
  });

  server.handle(migrateAccountAgentsRpc, async (input, { paseo }) => {
    await ready;
    const outcome = await migrateAccountAgents(paseo, service, pending, input, (agentId) => fallback.cancelAgent(agentId));
    if (outcome.switched > 0 || outcome.scheduled > 0) fallback.clearCooldown(input.toAccountId);
    return outcome;
  });

  server.handle(usageStatsRpc, async (filter) => {
    await ready;
    return stats.summary(filter, (id) => service.labelOf(id), pricing.snapshot());
  });

  server.handle(usageDailyRpc, async (filter) => {
    await ready;
    return stats.daily(filter, pricing.snapshot());
  });

  server.handle(getPricingRpc, async () => {
    await ready;
    const seen = await stats.seenPricingModels().catch(() => new Map<string, string>());
    return pricing.state(seen);
  });

  server.handle(setPricingRpc, async (input) => {
    await ready;
    await pricing.update(input);
    const seen = await stats.seenPricingModels().catch(() => new Map<string, string>());
    return pricing.state(seen);
  });

  server.handle(contextUsageRpc, async ({ agentIds }, { paseo }) => context.usage(paseo, agentIds));

  server.handle(listSubagentsRpc, async ({ agentId }, { paseo }) => subagents.list(paseo, agentId));

  server.handle(subagentCountsRpc, async ({ agentIds }, { paseo }) => ({
    counts: await subagents.counts(paseo, agentIds),
  }));

  server.handle(subagentDetailRpc, async ({ agentId, subagentId }, { paseo }) =>
    subagents.detail(paseo, agentId, subagentId),
  );

  server.handle(subagentArtifactRpc, async ({ agentId, subagentId, path: artifactPath }, { paseo }) =>
    subagents.artifact(paseo, agentId, subagentId, artifactPath),
  );

  server.handle(getOrchestratorRpc, async ({ refresh }) => {
    await ready;
    return orchestrator.state(refresh ?? false);
  });

  server.handle(setOrchestratorRpc, async ({ planner, executor, accountId, inheritGlobal, applyTo }, { paseo }) => {
    await ready;
    const state = await orchestrator.save({ planner, executor, accountId, inheritGlobal });
    const applied = applyTo ? await orchestrator.apply(paseo, applyTo) : "none";
    return { state, applied };
  });

  // Must return synchronously: a returned promise closes the subscription when it settles.
  server.handle(watchAccountsSubscription, (_input, { push, signal }) => {
    const stop = service.onChange((revision) => {
      void push({ revision }).catch(() => undefined);
    });
    signal.addEventListener("abort", stop, { once: true });
    void ready.then(() => push({ revision: service.currentRevision() })).catch(() => undefined);
  });

  return async () => {
    clearTimeout(warmup);
    clearInterval(quotaTimer);
    clearInterval(sweepTimer);
    for (const remove of removers) remove();
    fallback.dispose();
    await Promise.all([service.dispose(), stats.dispose()]);
  };
}
