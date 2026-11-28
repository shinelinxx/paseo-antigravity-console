import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  agentTasksRpc,
  cancelSignInRpc,
  clearCooldownRpc,
  contextUsageRpc,
  createAccountRpc,
  getOrchestratorRpc,
  getPricingRpc,
  listAccountsRpc,
  listAgentArtifactsRpc,
  listSubagentsRpc,
  migrateAccountAgentsRpc,
  moveAccountRpc,
  readAgentArtifactRpc,
  recoverSavedFilesRpc,
  refreshAccountsRpc,
  removeAccountRpc,
  renameAccountRpc,
  savedFilesRpc,
  searchArtifactsAttachmentRpc,
  setAccountOptionsRpc,
  setDefaultAccountRpc,
  setFallbackRpc,
  setOrchestratorRpc,
  setPricingRpc,
  setRoutingRpc,
  setRoutingWeightsRpc,
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
import { ArtifactReader } from "./server/artifacts";
import { ContextReader } from "./server/context";
import { FallbackController } from "./server/fallback";
import { ActiveLoadTracker, PendingSwitches, migrateAccountAgents, registerHooks, switchAgentAccount } from "./server/hooks";
import { OrchestratorSettings } from "./server/orchestrator";
import { PricingStore } from "./server/pricing";
import { AccountRouter } from "./server/router";
import { UsageStatsReader } from "./server/stats";
import { SubagentReader } from "./server/subagents";
import { createUsageSource } from "./server/usage";

export default function contribute(server: PluginServerContext) {
  const service = new AccountService();
  const pending = new PendingSwitches(() => service.store.isWritable());
  const accountState = async () => {
    const state = await service.state();
    return { ...state, problems: [...state.problems, ...pending.problems()] };
  };
  const context = new ContextReader();
  const stats = new UsageStatsReader();
  const pricing = new PricingStore();
  const subagents = new SubagentReader(context);
  const artifacts = new ArtifactReader(context, subagents);
  const orchestrator = new OrchestratorSettings(service);
  const ready = Promise.all([service.init(), pricing.load()]).then(() => undefined);

  // Learn every account's state and model catalog once in the background so pickers and router can use them.
  const warmup = setTimeout(() => {
    void ready
      .then(async () => {
        await service.refreshAll();
        await orchestrator.state(false).catch(() => undefined);
      })
      .catch((error: unknown) => {
        console.error("antigravity-accounts: initial refresh failed", error);
      });
  }, 3000);

  // Keep quota fresh for the sidebar and clear past reset windows promptly.
  let quotaRunning = false;
  const quotaTimer = setInterval(() => {
    if (quotaRunning) return;
    quotaRunning = true;
    void ready
      .then(async () => {
        const state = await service.state();
        const now = Date.now();
        const due = new Set<string>();
        if (state.resolvedDefaultAccountId) due.add(state.resolvedDefaultAccountId);
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
      .catch(() => undefined)
      .finally(() => {
        quotaRunning = false;
      });
  }, 3 * 60_000);
  quotaTimer.unref?.();

  let sweepRunning = false;
  const sweepTimer = setInterval(() => {
    if (sweepRunning) return;
    sweepRunning = true;
    void ready
      .then(() => service.refreshAll())
      .catch(() => undefined)
      .finally(() => {
        sweepRunning = false;
      });
  }, 15 * 60_000);
  sweepTimer.unref?.();

  const activeLoad = new ActiveLoadTracker();
  service.setRunningCountProvider(() => activeLoad.snapshot());
  const fallback = new FallbackController(service, pending, orchestrator);
  const router = new AccountRouter(service, fallback, orchestrator, (accountId) => activeLoad.countFor(accountId));
  const removers = [
    fallback.register(server, () =>
      registerHooks(
        server,
        service,
        pending,
        fallback,
        {
          onConversationAccount: (conversationId, accountId, at) => stats.recordConversationAccount(conversationId, accountId, at),
          onAgentArchived: (agentId) => {
            context.forget(agentId);
            subagents.forget(agentId);
          },
        },
        router,
        activeLoad,
      ),
    ),
  ];
  removers.push(...orchestrator.register(server));
  server.registerUsageSource(createUsageSource(service));

  server.handle(listAccountsRpc, async ({ refresh }) => {
    await ready;
    if (refresh) await service.refreshAll({ forcePlan: true });
    return accountState();
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
    return accountState();
  });

  server.handle(createAccountRpc, async ({ label }) => {
    await ready;
    const account = await service.create(label);
    return { account, state: await accountState() };
  });

  server.handle(renameAccountRpc, async ({ accountId, label }) => {
    await ready;
    await service.rename(accountId, label);
    return accountState();
  });

  server.handle(moveAccountRpc, async ({ accountId, direction }) => {
    await ready;
    await service.move(accountId, direction);
    return accountState();
  });

  server.handle(setAccountOptionsRpc, async ({ accountId, fallbackEnabled, weight, note, orchestratorOverride }) => {
    await ready;
    await service.setAccountOptions(accountId, { fallbackEnabled, weight, note, orchestratorOverride });
    if (weight !== undefined) router.reset();
    return accountState();
  });

  server.handle(clearCooldownRpc, async ({ accountId }) => {
    await ready;
    if (accountId) service.requireAccount(accountId);
    fallback.clearCooldown(accountId);
    return accountState();
  });

  server.handle(setFallbackRpc, async (patch) => {
    await ready;
    await service.setFallback(patch);
    if (patch.enabled === false) fallback.cancelAllRetries();
    return accountState();
  });

  server.handle(setRoutingRpc, async (patch) => {
    await ready;
    await service.setRouting(patch);
    router.reset();
    return accountState();
  });

  server.handle(setRoutingWeightsRpc, async ({ entries, mode }) => {
    await ready;
    await service.setRoutingWeights(entries, mode);
    router.reset();
    return accountState();
  });

  server.handle(setDefaultAccountRpc, async ({ accountId }) => {
    await ready;
    await service.setDefault(accountId);
    return accountState();
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
    orchestrator.invalidateAccount(accountId);
    const moved = await service.remove(accountId);
    fallback.clearCooldown(accountId);
    return { state: await accountState(), moved };
  });

  server.handle(signOutAccountRpc, async ({ accountId }) => {
    await ready;
    orchestrator.invalidateAccount(accountId);
    await service.signOut(accountId);
    fallback.clearCooldown(accountId);
    return accountState();
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
    return accountState();
  });

  server.handle(cancelSignInRpc, async ({ loginId }) => {
    service.cancelSignIn(loginId);
    return {};
  });

  server.handle(switchAgentAccountRpc, async (input, { paseo }) => {
    await ready;
    fallback.invalidatePreemptive(input.agentId);
    fallback.clearCooldown(input.accountId, false);
    return switchAgentAccount(paseo, service, pending, input);
  });

  server.handle(migrateAccountAgentsRpc, async (input, { paseo }) => {
    await ready;
    fallback.clearCooldown(input.toAccountId, false);
    const outcome = await migrateAccountAgents(paseo, service, pending, input, (agentId) =>
      fallback.invalidatePreemptive(agentId),
    );
    return outcome;
  });

  server.handle(usageStatsRpc, async (filter, { paseo }) => {
    await ready;
    return stats.summary(filter, (id) => service.labelOf(id), pricing.snapshot(), paseo);
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

  server.handle(contextUsageRpc, async ({ agentIds }, { paseo }) => {
    await ready;
    return context.usage(paseo, agentIds, pricing.snapshot());
  });

  server.handle(listSubagentsRpc, async ({ agentId }, { paseo }) => subagents.list(paseo, agentId));

  server.handle(subagentCountsRpc, async ({ agentIds }, { paseo }) => ({
    counts: await subagents.counts(paseo, agentIds),
  }));

  server.handle(agentTasksRpc, async ({ agentIds }, { paseo }) => subagents.latestTasks(paseo, agentIds));

  server.handle(subagentDetailRpc, async ({ agentId, subagentId }, { paseo }) =>
    subagents.detail(paseo, agentId, subagentId),
  );

  server.handle(subagentArtifactRpc, async ({ agentId, subagentId, path: artifactPath }, { paseo }) =>
    subagents.artifact(paseo, agentId, subagentId, artifactPath),
  );

  server.handle(listAgentArtifactsRpc, async ({ agentId }, { paseo }) => artifacts.list(paseo, agentId));

  server.handle(readAgentArtifactRpc, async ({ agentId, conversationId, path: artifactPath }, { paseo }) =>
    artifacts.read(paseo, agentId, conversationId, artifactPath),
  );

  server.handle(searchArtifactsAttachmentRpc, async ({ query }) => artifacts.searchAttachments(query));

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
    subagents.dispose();
    await Promise.all([service.dispose(), Promise.resolve(stats.dispose())]);
  };
}
