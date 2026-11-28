import type { PluginHookAgent, PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ACCOUNT_METADATA_KEY,
  AUTO_ACCOUNT_ID,
  CREATED_AUTO_METADATA_KEY,
  CREATED_MODEL_METADATA_KEY,
  CREATED_REDIRECT_METADATA_KEY,
  PENDING_ACCOUNT_METADATA_KEY,
  RUNTIME_ACCOUNT_METADATA_KEY,
  SYSTEM_ACCOUNT_ID,
  accountIdFromMetadata,
  accountIdSchema,
  configuredAccountIdFromMetadata,
  createdRedirectFromMetadata,
  defaultAccountIdSchema,
  failureReasonSchema,
  isAntigravityProvider,
  isAutoAccountId,
  isUnsupportedBackgroundFilterError,
  pendingAccountIdFromMetadata,
  pendingSwitchFromMetadata,
  runtimeAccountFromMetadata,
  type FallbackEvent,
  type PendingSwitchRecord,
} from "../shared/contracts";
import { AccountWaitTimeout, checkSignal, waitForSignal, type AccountService, type QuotaProbeOptions } from "./accounts";
import { sessionEnv } from "./agy";
import { conversationIdFrom } from "./context";
import { dataDir } from "./paths";
import type { PickForNewAgentOptions } from "./router";
import type { PaseoApi } from "./types";

type Metadata = Parameters<typeof accountIdFromMetadata>[0];
type AgentSnapshot = NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"];

function turnInProgress(agent: AgentSnapshot) {
  return Boolean(agent.activeTurn) || agent.status === "running" || agent.status === "initializing";
}

const identifier = z.string().trim().min(1);
const CREATE_REDIRECT_SCOPE = "agent.create.before";
const transientCodes = new Set(["EAGAIN", "EWOULDBLOCK", "EBUSY", "EMFILE", "ENFILE", "ETIMEDOUT", "EINTR"]);
const closeTimeoutRe = /timed out closing previous session/i;
const transientMessageRe = new RegExp(`timed out closing previous session|\\b(?:${[...transientCodes].join("|")})\\b`, "i");
function isCloseTimeoutError(error: unknown): boolean {
  if (typeof error === "string") return closeTimeoutRe.test(error);
  if (!error || typeof error !== "object") return false;
  const e = error as { message?: unknown; cause?: { message?: unknown } };
  return (
    (typeof e.message === "string" && closeTimeoutRe.test(e.message)) ||
    (typeof e.cause?.message === "string" && closeTimeoutRe.test(e.cause.message))
  );
}
function isRetryableOpenError(error: unknown): boolean {
  if (error instanceof AccountWaitTimeout) return true;
  if (!error || typeof error !== "object") return false;
  const e = error as NodeJS.ErrnoException & { retryable?: boolean; signal?: AbortSignal; cause?: NodeJS.ErrnoException };
  return (
    e.retryable === true ||
    e.name === "AbortError" ||
    e.signal?.aborted === true ||
    transientCodes.has(e.code ?? "") ||
    transientCodes.has(e.cause?.code ?? "") ||
    transientMessageRe.test(e.message) ||
    transientMessageRe.test(e.cause?.message ?? "")
  );
}

const openIntentSchema = z.object({
  agentId: identifier,
  gen: z.number().int(),
  openedAt: z.number().finite(),
  confirmed: z.boolean(),
  persistedToHost: z.boolean().default(false),
  model: z.string().nullable().optional(),
  accountId: accountIdSchema,
  forAccount: defaultAccountIdSchema,
  expectedEffective: defaultAccountIdSchema.optional(),
  consumedRequestId: z.string().nullable(),
  redirectFrom: accountIdSchema.optional(),
  supersededRequestIds: z.array(identifier).optional(),
  reason: failureReasonSchema.optional(),
  preStatus: z.string().nullable().optional(),
  openReason: z.enum(["create", "resume", "refresh", "import"]).optional(),
  preAlive: z.boolean().optional(),
  sawClosedPhase: z.boolean().default(false),
  preUpdatedAt: z.string().nullable().optional(),
  createdRedirect: z.boolean().optional(),
  creationRegistered: z.boolean().optional(),
  previousAccount: defaultAccountIdSchema.optional(),
  pendingAttributions: z.array(z.object({ convId: identifier, at: z.number().finite() })).optional(),
  sawInitializingPhase: z.boolean().optional(),
  skipCycles: z.number().int().nonnegative().optional(),
  sawPriorRefresh: z.boolean().optional(),
  createdAuto: z.boolean().optional(),
  preSessionId: z.string().nullable().optional(),
  preTurnId: z.string().nullable().optional(),
});
type OpenIntent = z.infer<typeof openIntentSchema> & { persistent: boolean; recovered?: boolean; probesExhausted?: boolean };
const confirmedAccountSchema = openIntentSchema
  .pick({
    accountId: true,
    forAccount: true,
    consumedRequestId: true,
    supersededRequestIds: true,
    persistedToHost: true,
  })
  .extend({ confirmedAt: z.number().finite() });
type ConfirmedAccountRecord = z.infer<typeof confirmedAccountSchema>;

function changedPhase(intent: OpenIntent, status: string, updatedAt: string | null | undefined, changedSession: boolean) {
  return (
    intent.preStatus !== status ||
    intent.sawInitializingPhase ||
    changedSession ||
    !!(updatedAt && intent.preUpdatedAt && updatedAt !== intent.preUpdatedAt)
  );
}
type RequestState = "queued" | "consuming" | "consumed" | "cancelled" | "revoked";
interface ReloadAttempt {
  requestId: string;
  gen?: number;
  intent?: OpenIntent;
}

class AgentQueue {
  private readonly chains = new Map<string, Promise<void>>();

  async run<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(agentId) ?? Promise.resolve()).then(operation);
    const done = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(agentId, done);
    try {
      return await result;
    } finally {
      if (this.chains.get(agentId) === done) this.chains.delete(agentId);
    }
  }
}

const probeDelays = [1500, 2500, 4000, 6000];

export class PendingSwitches {
  readonly switches = new AgentQueue();
  // Publish the newest selection even while the host serializes an older metadata write behind open.
  readonly selections = new AgentQueue();
  readonly metadata = new AgentQueue();
  private readonly sessions = new Map<string, OpenIntent>();
  private readonly openIntents = new Map<string, OpenIntent>();
  private readonly unseenRefreshes = new Map<string, Set<number>>();
  private readonly orphanedCreateAccounts = new Map<
    string,
    { accountId: string; forAccount: string; model: string | null; expiresAt: number }
  >();
  private readonly lastConfirmed = new Map<string, ConfirmedAccountRecord>();
  private readonly successors = new WeakMap<OpenIntent, OpenIntent>();
  private readonly pendingFailures = new WeakMap<OpenIntent, Array<(accountId: string, historical: boolean) => void>>();
  private readonly pendingCreateRedirects = new Map<string, { accountId: string; model: string | null; expiresAt: number }>();
  private readonly generations = new Map<string, number>();
  private readonly probes = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Map<string, () => void>();
  private readonly feeds = new Map<PaseoApi["agents"], { users: number; ready: Promise<() => Promise<void>> }>();
  private failedRedirects: Array<{ agentId: string; model: string; accountId: string; until: number }> = [];
  private readonly reloading = new Map<string, ReloadAttempt>();
  private readonly retryableFailedRequests = new Set<string>();
  private readonly latestPending = new Map<string, PendingSwitchRecord | null>();
  private readonly publishing = new Map<string, PendingSwitchRecord | null>();
  private readonly requestStates = new Map<string, RequestState>();
  private readonly revokedRuntime = new Map<string, number>();
  private readonly revokedRequests = new Set<string>();
  private readonly clearingRuntime = new Set<string>();
  private readonly diagnostics = new Set<string>();
  private readonly recoveryAccount = new Map<string, string>();
  private sequence = 0;
  private loaded = false;
  disposed = false;

  constructor(private readonly canPersist = () => false, private readonly file = path.join(dataDir(), "open-intents.json")) {}
  noteOpen?: OpenFallback["noteOpen"];
  onConversationAccount?: HookObservers["onConversationAccount"];

  problems() {
    return [...this.diagnostics];
  }

  noteRetryableFailure(agentId: string, requestId?: string) {
    const attempt = this.reloading.get(agentId);
    if (attempt && (!requestId || attempt.requestId === requestId)) this.retryableFailedRequests.add(attempt.requestId);
  }

  consumeRetryableFailure(requestId: string) {
    return this.retryableFailedRequests.delete(requestId);
  }

  private report(problem: string) {
    if (this.diagnostics.has(problem)) return;
    console.warn("antigravity-accounts:", problem);
    if (this.diagnostics.size >= 32) this.diagnostics.delete(this.diagnostics.values().next().value!);
    this.diagnostics.add(problem);
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") throw new Error("Expected a recovery journal");
      let entries: unknown[];
      if (Array.isArray(raw)) entries = raw;
      else if ("version" in raw) {
        if (raw.version !== 1) throw new Error("Unknown recovery journal version");
        entries = "intents" in raw && Array.isArray(raw.intents) ? raw.intents : [];
        if (!("intents" in raw) || !Array.isArray(raw.intents)) this.report("Invalid open-intents.json intents list.");
        const watermarks = "revokedRuntimes" in raw && raw.revokedRuntimes;
        if ("lastConfirmed" in raw && raw.lastConfirmed && typeof raw.lastConfirmed === "object") {
          for (const [id, value] of Object.entries(raw.lastConfirmed)) {
            const result = confirmedAccountSchema.safeParse(value);
            if (result.success) this.lastConfirmed.set(id, result.data);
            else this.report(`Skipped invalid confirmed account for "${id}".`);
          }
        }
        if (watermarks && typeof watermarks === "object" && !Array.isArray(watermarks)) {
          for (const [id, at] of Object.entries(watermarks)) {
            if (id.trim() && typeof at === "number" && Number.isFinite(at) && at >= 0) this.revokedRuntime.set(id, at);
            else this.report(`Skipped invalid open-intents.json revokedRuntimes entry for "${id}".`);
          }
        } else this.report("Invalid open-intents.json revokedRuntimes map.");
        if ("revokedRequests" in raw) {
          if (Array.isArray(raw.revokedRequests)) {
            for (const key of raw.revokedRequests) {
              try {
                const [agentId, requestId] = z.tuple([identifier, identifier]).parse(JSON.parse(key));
                this.revokedRequests.add(JSON.stringify([agentId, requestId]));
              } catch {
                this.report("Skipped invalid open-intents.json revokedRequests entry.");
              }
            }
          } else this.report("Invalid open-intents.json revokedRequests list.");
        }
      } else {
        entries = Object.entries(raw).map(([agentId, intent]) =>
          intent && typeof intent === "object" && !Array.isArray(intent) ? { agentId, ...intent } : intent,
        );
      }
      for (const [index, entry] of entries.entries()) {
        const parsed = openIntentSchema.safeParse(entry);
        if (!parsed.success) {
          this.report(
            `Skipped invalid open-intents.json entry ${index + 1} (${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}).`,
          );
          continue;
        }
        const intent = {
          ...parsed.data,
          persistent: true,
          recovered: true,
          preAlive: parsed.data.preAlive ?? !["closed", "error"].includes(parsed.data.preStatus ?? "unknown"),
        };
        if (intent.persistedToHost) continue;
        if (intent.consumedRequestId) {
          this.setRequestState(intent.agentId, intent.consumedRequestId, intent.confirmed ? "consumed" : "consuming");
        }
        this.openIntents.set(intent.agentId, intent);
        this.sessions.set(intent.agentId, intent);
        if (intent.confirmed && !this.lastConfirmed.has(intent.agentId)) this.rememberConfirmed(intent);
        this.trackCreateRedirect(intent, intent.openedAt);
        this.sequence = Math.max(this.sequence, intent.gen);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.report(`Could not load open-intents.json: ${error instanceof SyntaxError ? "invalid JSON" : String(error)}`);
      }
    }
  }

  private save() {
    if (this.disposed || !this.canPersist()) return;
    const tmp = this.file + "." + randomUUID();
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(
        tmp,
        JSON.stringify({
          version: 1,
          intents: [...this.openIntents.values()].filter((i) => i.persistent),
          lastConfirmed: Object.fromEntries([...this.lastConfirmed].filter(([, record]) => !record.persistedToHost)),
          revokedRuntimes: Object.fromEntries(this.revokedRuntime),
          revokedRequests: [...this.revokedRequests],
        }),
        { mode: 0o600 },
      );
      renameSync(tmp, this.file);
    } catch (error) {
      this.report(`Could not save open-intents.json (${(error as NodeJS.ErrnoException).code ?? "unknown error"}).`);
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* Recovery is best effort. */
      }
    }
  }

  beginOpen(agentId: string, metadata: Metadata) {
    this.load();
    const gen = ++this.sequence;
    this.generations.set(agentId, gen);
    const reload = this.reloading.get(agentId);
    if (reload && reload.gen === undefined && pendingSwitchFromMetadata(metadata)?.requestId === reload.requestId) {
      reload.gen = gen;
    }
    return gen;
  }

  inflightIntent(agentId: string) {
    const intent = this.openIntents.get(agentId);
    return intent?.confirmed ? undefined : intent;
  }

  openedAccount(agentId: string) {
    const intent = this.sessions.get(agentId);
    return intent?.confirmed ? intent.accountId : this.lastConfirmed.get(agentId)?.accountId;
  }

  private rememberConfirmed(intent: OpenIntent) {
    const { accountId, forAccount, consumedRequestId, supersededRequestIds, persistedToHost } = intent;
    const confirmedAt = Math.max(Date.now(), (this.revokedRuntime.get(intent.agentId) ?? -Infinity) + 1);
    this.lastConfirmed.set(intent.agentId, {
      accountId,
      forAccount,
      consumedRequestId,
      supersededRequestIds,
      persistedToHost: persistedToHost || !intent.persistent,
      confirmedAt,
    });
  }

  metadataAccount(agentId: string, metadata: Metadata, paseo?: PaseoApi) {
    this.load();
    const configured = configuredAccountIdFromMetadata(metadata);
    const runtime = runtimeAccountFromMetadata(metadata);
    const confirmed = this.lastConfirmed.get(agentId);
    const acknowledged =
      confirmed &&
      !confirmed.persistedToHost &&
      runtime?.forAccount === configured &&
      runtime.accountId === confirmed.accountId &&
      runtime.confirmedAt >= confirmed.confirmedAt &&
      runtime.consumedRequestId === confirmed.consumedRequestId;
    if (acknowledged) confirmed.persistedToHost = true;
    const overridden =
      confirmed &&
      (confirmed.forAccount !== configured ||
        (runtime?.forAccount === configured &&
          runtime.confirmedAt > confirmed.confirmedAt &&
          runtime.accountId !== confirmed.accountId));
    if (overridden) this.lastConfirmed.delete(agentId);
    const intent = this.sessions.get(agentId);
    const drop = intent && (intent.forAccount !== configured || (overridden && intent.confirmed));
    const revoke =
      runtime && runtime.forAccount !== configured && runtime.confirmedAt > (this.revokedRuntime.get(agentId) ?? -Infinity);
    if (drop) {
      this.dropOpen(agentId, false);
      if (intent.consumedRequestId && !intent.persistedToHost) this.revokeRequest(agentId, intent.consumedRequestId);
    }
    if (revoke) this.revokedRuntime.set(agentId, runtime.confirmedAt);
    if (acknowledged || overridden || revoke || (drop && intent.persistent)) this.save();
    const revokedAt = this.revokedRuntime.get(agentId);
    if (revokedAt !== undefined && paseo && !this.clearingRuntime.has(agentId)) {
      this.clearingRuntime.add(agentId);
      void this.metadata
        .run(agentId, async () => {
          const handle = paseo.agents.ref(agentId);
          const snapshot = await handle.refresh();
          if (this.disposed || !snapshot || this.revokedRuntime.get(agentId) !== revokedAt) return;
          const latest = runtimeAccountFromMetadata(snapshot.agent.metadata);
          if (latest && latest.confirmedAt <= revokedAt) await handle.setMetadata({ [RUNTIME_ACCOUNT_METADATA_KEY]: null });
          if (!this.disposed && this.revokedRuntime.get(agentId) === revokedAt) {
            this.revokedRuntime.delete(agentId);
            this.save();
          }
        })
        .catch((error) => this.report(`Could not clear a revoked runtime account: ${error}`))
        .finally(() => this.clearingRuntime.delete(agentId));
    }
    return runtime && runtime.confirmedAt > (revokedAt ?? -Infinity) ? runtime.accountId : configured;
  }

  effectiveAccountId(agentId: string, metadata: Metadata, paseo?: PaseoApi) {
    const account = this.metadataAccount(agentId, metadata, paseo);
    return this.openedAccount(agentId) ?? account;
  }

  requestState(agentId: string, requestId: string) {
    const key = JSON.stringify([agentId, requestId]);
    return this.revokedRequests.has(key) ? "revoked" : this.requestStates.get(key);
  }

  setRequestState(agentId: string, requestId: string, state: RequestState) {
    const key = JSON.stringify([agentId, requestId]);
    this.requestStates.delete(key);
    this.requestStates.set(key, state);
    if (this.requestStates.size > 512) this.requestStates.delete(this.requestStates.keys().next().value!);
  }

  queued(agentId: string, metadata: Metadata, freshSnapshot = true) {
    const stored = pendingSwitchFromMetadata(metadata);
    const latest = this.latestPending.get(agentId);
    if (latest === undefined) return stored;
    if (this.publishing.has(agentId) || !freshSnapshot || (stored && this.isRequestInvalid(agentId, stored.requestId))) {
      return latest;
    }
    // Respect an external update once the host can supply a fresh snapshot.
    if (stored?.requestId !== latest?.requestId) {
      this.latestPending.delete(agentId);
      const replay = this.replayIntent(agentId, metadata);
      if (latest && !this.isRequestInvalid(agentId, latest.requestId) && replay?.consumedRequestId !== latest.requestId) {
        this.setRequestState(agentId, latest.requestId, "cancelled");
      }
    }
    return stored;
  }

  async writeRequest(
    agentId: string,
    record: PendingSwitchRecord | null,
    previous: PendingSwitchRecord | null,
    write: () => Promise<unknown>,
  ) {
    const priorState = previous && this.requestState(agentId, previous.requestId);
    if (previous && priorState !== "consuming" && priorState !== "consumed") {
      this.setRequestState(agentId, previous.requestId, "cancelled");
    }
    this.latestPending.set(agentId, record);
    this.publishing.set(agentId, record);
    if (record) this.setRequestState(agentId, record.requestId, "queued");
    try {
      await this.metadata.run(agentId, write);
    } catch (error) {
      const state = record && this.requestState(agentId, record.requestId);
      if (
        record &&
        (state === "consuming" || state === "consumed" || this.inflightIntent(agentId)?.consumedRequestId === record.requestId)
      ) {
        return;
      }
      if (this.latestPending.get(agentId) === record) {
        if (record && this.requestState(agentId, record.requestId) !== "consumed") {
          this.setRequestState(agentId, record.requestId, "revoked");
        }
        if (previous) this.setRequestState(agentId, previous.requestId, priorState ?? "queued");
        this.latestPending.delete(agentId);
      }
      throw error;
    } finally {
      if (this.publishing.get(agentId) === record) this.publishing.delete(agentId);
    }
  }

  queuedForOpen(agentId: string, metadata: Metadata, freshSnapshot: boolean) {
    const queued = this.queued(agentId, metadata, freshSnapshot);
    const recovered = this.replayIntent(agentId, metadata);
    if (
      !recovered?.consumedRequestId ||
      this.publishing.has(agentId) ||
      this.latestPending.get(agentId) === null ||
      this.invalidForOpen(agentId, metadata, recovered.consumedRequestId)
    ) {
      return queued;
    }
    if (
      queued &&
      queued.requestId !== recovered.consumedRequestId &&
      !recovered.supersededRequestIds?.includes(queued.requestId)
    ) {
      return queued;
    }
    return { accountId: recovered.accountId, requestId: recovered.consumedRequestId };
  }

  replayIntent(agentId: string, metadata: Metadata) {
    const intent = this.openIntents.get(agentId);
    if (!intent?.persistent || intent.persistedToHost || intent.forAccount !== configuredAccountIdFromMetadata(metadata)) {
      return;
    }
    const runtime = runtimeAccountFromMetadata(metadata);
    if (
      runtime?.accountId === intent.accountId &&
      runtime.forAccount === intent.forAccount &&
      runtime.consumedRequestId === intent.consumedRequestId
    ) {
      return;
    }
    return intent;
  }

  invalidForOpen(agentId: string, metadata: Metadata, requestId: string) {
    if (
      this.requestState(agentId, requestId) === "consumed" &&
      this.replayIntent(agentId, metadata)?.consumedRequestId === requestId
    ) {
      return false;
    }
    return this.isRequestInvalid(agentId, requestId);
  }

  revokeRequest(agentId: string, requestId: string, recoverOn?: string) {
    this.rejectSelection(agentId, new Set([requestId]), recoverOn);
  }

  rejectSelection(agentId: string, requestIds: ReadonlySet<string>, recoverOn?: string) {
    const inflight = this.openIntents.get(agentId);
    for (const id of requestIds) {
      this.setRequestState(agentId, id, "revoked");
      this.revokedRequests.add(JSON.stringify([agentId, id]));
    }
    if (inflight?.consumedRequestId && requestIds.has(inflight.consumedRequestId)) this.dropOpen(agentId, false);
    if (recoverOn) this.recoveryAccount.set(agentId, recoverOn);
    this.save();
  }

  sawClose(agentId: string) {
    const intent = this.inflightIntent(agentId);
    if (!intent || intent.sawClosedPhase) return;
    intent.sawClosedPhase = true;
    if (intent.persistent) this.save();
  }

  checkPreviousOpen(paseo: PaseoApi, agentId: string, agent: AgentSnapshot | null) {
    const intent = this.inflightIntent(agentId);
    if (!intent || !agent || this.stalePhase(intent, agent.updatedAt)) return;
    const session = agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId;
    const changedSession = !!(intent.preSessionId && session && session !== intent.preSessionId);
    if (
      (agent.status === "error" && (intent.sawClosedPhase || changedPhase(intent, "error", agent.updatedAt, changedSession))) ||
      (agent.status === "closed" && intent.sawClosedPhase)
    ) {
      this.failOpen(paseo, intent);
    }
  }

  markRedirectFailed(agentId: string, model: string | null | undefined, accountId: string) {
    this.failedRedirects = this.failedRedirects.filter(
      (failure) =>
        failure.until > Date.now() &&
        !(failure.agentId === agentId && failure.model === (model ?? "") && failure.accountId === accountId),
    );
    this.failedRedirects.push({ agentId, model: model ?? "", accountId, until: Date.now() + 5 * 60_000 });
  }

  confirmedFailedRedirects(agentId: string, model: string | null | undefined) {
    this.failedRedirects = this.failedRedirects.filter((failure) => failure.until > Date.now());
    return new Set(
      this.failedRedirects
        .filter((failure) => failure.agentId === agentId && failure.model === (model ?? ""))
        .map((failure) => failure.accountId),
    );
  }

  pendingCreateAccounts(model: string | null, openingId?: string) {
    const targets = new Set<string>();
    for (const [id, entry] of this.pendingCreateRedirects) {
      if (entry.expiresAt <= Date.now()) this.pendingCreateRedirects.delete(id);
      else if (id !== openingId && entry.model === model) targets.add(entry.accountId);
    }
    return targets;
  }

  private trackCreateRedirect(intent: OpenIntent, deliveredAt: number) {
    const expiresAt = deliveredAt + 5 * 60_000;
    if (
      (intent.createdRedirect || intent.createdAuto) &&
      intent.openReason === "create" &&
      !intent.confirmed &&
      !intent.creationRegistered &&
      expiresAt > Date.now()
    ) {
      this.pendingCreateRedirects.set(intent.agentId, { accountId: intent.accountId, model: intent.model ?? null, expiresAt });
    }
  }

  created(agentId: string) {
    this.pendingCreateRedirects.delete(agentId);
    const orphan = this.orphanedCreateAccounts.get(agentId);
    this.orphanedCreateAccounts.delete(agentId);
    if (orphan && orphan.expiresAt > Date.now() && !this.openIntents.has(agentId)) {
      const { accountId, forAccount, model } = orphan;
      const intent: OpenIntent = {
        agentId,
        accountId,
        forAccount,
        model,
        gen: ++this.sequence,
        openedAt: Date.now(),
        confirmed: true,
        persistedToHost: false,
        persistent: true,
        consumedRequestId: null,
        sawClosedPhase: false,
        creationRegistered: true,
        openReason: "create",
      };
      this.rememberConfirmed(intent);
      this.openIntents.set(agentId, intent);
      this.clearAgentFailure(CREATE_REDIRECT_SCOPE, model, accountId);
      this.clearAgentFailure(agentId, model, accountId);
      this.save();
    }
    const intent = this.openIntents.get(agentId);
    if (intent?.openReason === "create" && !intent.creationRegistered) {
      intent.creationRegistered = true;
      if (intent.persistent) this.save();
    }
  }

  clearFailedRedirects(accountId?: string) {
    const count = this.failedRedirects.length;
    this.failedRedirects = this.failedRedirects.filter((failure) => accountId !== undefined && failure.accountId !== accountId);
    return count !== this.failedRedirects.length;
  }

  clearAgentFailure(agentId: string, model: string | null | undefined, accountId: string) {
    this.failedRedirects = this.failedRedirects.filter(
      (failure) => failure.agentId !== agentId || failure.model !== (model ?? "") || failure.accountId !== accountId,
    );
  }

  discardReplay(intent: OpenIntent) {
    if (this.openIntents.get(intent.agentId) === intent) this.dropOpen(intent.agentId);
  }

  private addUnseenRefresh(agentId: string, gen: number) {
    let gens = this.unseenRefreshes.get(agentId);
    if (!gens) {
      gens = new Set();
      this.unseenRefreshes.set(agentId, gens);
    }
    gens.add(gen);
  }

  private consumeOldestRefresh(agentId: string) {
    const gens = this.unseenRefreshes.get(agentId);
    if (!gens) return;
    const oldest = gens.values().next().value;
    if (oldest !== undefined) gens.delete(oldest);
    if (!gens.size) this.unseenRefreshes.delete(agentId);
  }

  private removeUnseenRefresh(agentId: string, gen: number) {
    const gens = this.unseenRefreshes.get(agentId);
    if (!gens) return;
    gens.delete(gen);
    if (!gens.size) this.unseenRefreshes.delete(agentId);
  }

  private failOpen(paseo: PaseoApi, intent: OpenIntent) {
    const { agentId, consumedRequestId } = intent;
    if (this.reloading.has(agentId)) return;
    if (!intent.confirmed) this.removeUnseenRefresh(agentId, intent.gen);
    if (!consumedRequestId && (intent.redirectFrom || intent.createdAuto)) {
      this.markRedirectFailed(agentId, intent.model, intent.accountId);
      if (intent.createdRedirect || intent.createdAuto) {
        this.markRedirectFailed(CREATE_REDIRECT_SCOPE, intent.model, intent.accountId);
      }
    }
    if (consumedRequestId) {
      this.revokeRequest(agentId, consumedRequestId, intent.expectedEffective);
      for (const id of [consumedRequestId, ...(intent.supersededRequestIds ?? [])]) {
        void this.clearRequest(paseo, agentId, id).catch((error) => this.report(`Could not clear failed switch: ${error}`));
      }
    } else this.dropOpen(agentId);
  }

  recoveringOn(agentId: string, accountId: string) {
    return this.recoveryAccount.get(agentId) === accountId;
  }

  isRequestInvalid(agentId: string, requestId: string) {
    const state = this.requestState(agentId, requestId);
    return state === "cancelled" || state === "revoked" || state === "consumed";
  }

  clearRequest(paseo: PaseoApi, agentId: string, requestId: string) {
    return this.metadata.run(agentId, async () => {
      const handle = paseo.agents.ref(agentId);
      const snapshot = await handle.refresh();
      if (!this.disposed && pendingSwitchFromMetadata(snapshot?.agent.metadata)?.requestId === requestId) {
        await handle.setMetadata({ [PENDING_ACCOUNT_METADATA_KEY]: null });
        if (this.latestPending.get(agentId)?.requestId === requestId) this.latestPending.delete(agentId);
      }
    });
  }

  assertCurrentOpen(agentId: string, generation: number) {
    if (this.disposed || this.generations.get(agentId) !== generation) {
      throw new Error("This session open was superseded.");
    }
  }

  // Handle listeners are local to a Paseo API instance. list({ subscribe }) feeds them.
  acquireFeed(paseo: PaseoApi) {
    const agents = paseo.agents;
    if (typeof agents.list !== "function") return;
    let feed = this.feeds.get(agents);
    if (!feed) {
      const subscribe = async () => {
        const options = { subscribe: {}, page: { limit: 1 } };
        try {
          return await agents.list({ ...options, filter: { includeBackground: true } });
        } catch (error) {
          if (!isUnsupportedBackgroundFilterError(error)) throw error;
          return agents.list(options);
        }
      };
      const ready = subscribe().then(
        ({ subscription }) => async () => {
          await subscription?.release();
        },
        (error) => {
          this.report(`Could not subscribe to agent updates: ${error}`);
          return async () => {};
        },
      );
      feed = { users: 0, ready };
      this.feeds.set(agents, feed);
    }
    feed.users++;
    let released = false;
    return {
      ready: feed.ready,
      [Symbol.dispose]: () => {
        if (released) return;
        released = true;
        if (--feed.users) return;
        this.feeds.delete(agents);
        void feed.ready
          .then((release) => release())
          .catch((error) => this.report(`Could not manage agent subscription: ${error}`));
      },
    };
  }

  private watchOpen(paseo: PaseoApi, intent: OpenIntent, subscribeFeed: boolean) {
    const id = intent.agentId;
    const handle = paseo.agents.ref(id);
    if (typeof handle.subscribe !== "function") return;
    let armed = false;
    const stop = handle.subscribe((update) => {
      if (!armed || this.sessions.get(id) !== intent || this.disposed) return;
      if (update.kind === "remove") {
        void handle
          .refresh()
          .then((snapshot) => {
            if (
              !this.disposed &&
              this.sessions.get(id) === intent &&
              (snapshot?.agent.archivedAt || (snapshot === null && intent.openReason !== "create"))
            ) {
              this.forget(id);
            }
          })
          .catch((error) => this.report(`Could not verify removed agent: ${error}`));
        return;
      }
      const { status, updatedAt, runtimeInfo, persistence } = update.agent;
      if (this.stalePhase(intent, updatedAt)) return;
      const session = runtimeInfo?.sessionId ?? persistence?.sessionId;
      const changedSession = !!(intent.preSessionId && session && session !== intent.preSessionId);
      if (status === "closed" && changedPhase(intent, status, updatedAt, changedSession)) this.sawClose(id);
      else if (status === "initializing" && changedPhase(intent, status, updatedAt, changedSession) && !intent.sawInitializingPhase) {
        intent.sawInitializingPhase = true;
        if (intent.persistent) this.save();
      } else if (
        !intent.confirmed &&
        status === "error" &&
        (intent.sawClosedPhase || changedPhase(intent, status, updatedAt, changedSession))
      ) {
        this.failOpen(paseo, intent);
      } else if (
        (!intent.preAlive || intent.sawClosedPhase || intent.sawInitializingPhase || changedSession) &&
        (status === "idle" || status === "running")
      ) {
        if (intent.sawInitializingPhase) {
          this.consumeOldestRefresh(id);
          if (intent.skipCycles) {
            intent.skipCycles--;
            intent.sawPriorRefresh = true;
            intent.sawInitializingPhase = false;
            intent.sawClosedPhase = false;
            // Subsequent snapshots of this older refresh carry its new session id too.
            intent.preSessionId = session ?? intent.preSessionId;
            intent.preUpdatedAt = updatedAt ?? intent.preUpdatedAt;
            intent.preStatus = status;
            intent.preAlive = true;
            if (intent.persistent) this.save();
            return;
          }
        }
        if (intent.skipCycles) return;
        if (intent.confirmed) {
          if (!this.unseenRefreshes.has(id)) this.listeners.get(id)?.();
          if (!intent.persistedToHost) {
            void this.confirmOpen(paseo, id, intent).catch((error) => this.report(`Could not confirm session open: ${error}`));
          }
          return;
        }
        void this.confirmOpen(paseo, id, intent).catch((error) => this.report(`Could not confirm session open: ${error}`));
      }
    });
    const feed = subscribeFeed ? this.acquireFeed(paseo) : undefined;
    // The shared feed is ready before commit. Ignore the handle's synchronous snapshot.
    armed = true;
    const release = () => {
      stop();
      feed?.[Symbol.dispose]();
      this.listeners.delete(id);
    };
    if (this.sessions.get(id) !== intent) release();
    else this.listeners.set(id, release);
  }

  commitOpenAccount(paseo: PaseoApi, intent: OpenIntent, subscribeFeed = true) {
    const { agentId } = intent;
    this.assertCurrentOpen(agentId, intent.gen);
    // Replacement becomes authoritative only once its environment can be delivered.
    const previous = this.openIntents.get(agentId);
    this.orphanedCreateAccounts.delete(agentId);
    intent.skipCycles = this.unseenRefreshes.get(agentId)?.size ?? 0;
    if (intent.skipCycles && this.sessions.get(agentId)?.sawInitializingPhase) intent.sawInitializingPhase = true;
    if (intent.openReason === "refresh") this.addUnseenRefresh(agentId, intent.gen);
    if (previous && !previous.confirmed) intent.persistent ||= previous.persistent;
    if (previous && !previous.confirmed && previous.accountId === intent.accountId) {
      intent.pendingAttributions = previous.pendingAttributions?.splice(0);
      this.successors.set(previous, intent);
      const failures = this.pendingFailures.get(previous);
      if (failures) {
        this.pendingFailures.set(intent, failures);
        this.pendingFailures.delete(previous);
      }
    }
    const confirmed = this.lastConfirmed.get(agentId);
    if (confirmed?.accountId === intent.accountId && confirmed.forAccount === intent.forAccount && !confirmed.persistedToHost) {
      intent.confirmed = true;
      intent.persistent = true;
      intent.consumedRequestId ??= confirmed.consumedRequestId;
      const superseded = new Set([...(confirmed.supersededRequestIds ?? []), ...(intent.supersededRequestIds ?? [])]);
      if (confirmed.consumedRequestId && confirmed.consumedRequestId !== intent.consumedRequestId) {
        superseded.add(confirmed.consumedRequestId);
      }
      intent.supersededRequestIds = [...superseded];
      this.lastConfirmed.set(agentId, {
        ...confirmed,
        consumedRequestId: intent.consumedRequestId,
        supersededRequestIds: [...superseded],
      });
    }
    this.dropOpen(agentId, false, true);
    if (intent.consumedRequestId) {
      this.setRequestState(agentId, intent.consumedRequestId, intent.confirmed ? "consumed" : "consuming");
    }
    for (const id of intent.supersededRequestIds ?? []) {
      this.revokedRequests.add(JSON.stringify([agentId, id]));
      this.setRequestState(agentId, id, "revoked");
    }
    this.sessions.set(agentId, intent);
    this.openIntents.set(agentId, intent);
    this.trackCreateRedirect(intent, Date.now());
    if (intent.confirmed) this.settleAttributions(intent, intent.accountId);
    if (intent.persistent || previous?.persistent) this.save();
    if (intent.openReason === "refresh" || (intent.persistent && !intent.persistedToHost)) {
      try {
        this.watchOpen(paseo, intent, subscribeFeed);
      } catch (error) {
        this.report(`Could not watch session open: ${error}`);
      }
    }
    const reload = this.reloading.get(agentId);
    if (reload?.gen === intent.gen) reload.intent = intent;
    else this.probe(paseo, intent, 0);
    this.recoveryAccount.delete(agentId);
  }

  private stalePhase(intent: OpenIntent, updatedAt?: string | null) {
    return !!updatedAt && !!intent.preUpdatedAt && Date.parse(updatedAt) < Date.parse(intent.preUpdatedAt);
  }

  private probe(paseo: PaseoApi, intent: OpenIntent, attempt: number, priorStatus = intent.preStatus) {
    const delay = probeDelays[attempt];
    if (this.disposed || this.openIntents.get(intent.agentId) !== intent) return;
    const id = intent.agentId;
    if (!delay) {
      intent.probesExhausted = true;
      if (intent.openReason === "create" && !intent.creationRegistered && !intent.confirmed) {
        const { accountId, forAccount, model } = intent;
        const now = Date.now();
        for (const [key, entry] of this.orphanedCreateAccounts) {
          if (entry.expiresAt <= now) this.orphanedCreateAccounts.delete(key);
        }
        if (this.orphanedCreateAccounts.size >= 64) {
          this.orphanedCreateAccounts.delete(this.orphanedCreateAccounts.keys().next().value!);
        }
        this.orphanedCreateAccounts.set(id, { accountId, forAccount, model: model ?? null, expiresAt: now + 300_000 });
        this.failOpen(paseo, intent);
      } else if (this.pendingFailures.has(intent)) {
        this.settleFailures(intent, intent.previousAccount ?? intent.expectedEffective ?? intent.forAccount, true);
      }
      return;
    }
    clearTimeout(this.probes.get(id));
    this.probes.set(
      id,
      setTimeout(async () => {
        this.probes.delete(id);
        try {
          const closedBeforeRead = intent.sawClosedPhase;
          const snapshot = await paseo.agents.ref(id).refresh();
          if (this.disposed || this.openIntents.get(id) !== intent) return;
          const agent = snapshot?.agent;
          if (agent) this.metadataAccount(id, agent.metadata, paseo);
          if (this.openIntents.get(id) !== intent) return;
          if (agent?.archivedAt) {
            this.forget(id);
            return;
          }
          const session = agent?.runtimeInfo?.sessionId ?? agent?.persistence?.sessionId;
          const changedSession = !!(intent.preSessionId && session && session !== intent.preSessionId);
          const stale = agent && this.stalePhase(intent, agent.updatedAt);
          if (
            !stale &&
            !intent.confirmed &&
            agent?.status === "error" &&
            (closedBeforeRead || priorStatus !== "error" || changedPhase(intent, "error", agent.updatedAt, changedSession))
          ) {
            this.failOpen(paseo, intent);
            return;
          }
          if (!stale && agent?.status === "closed" && changedPhase(intent, "closed", agent.updatedAt, changedSession)) {
            this.sawClose(id);
          }
          const fresh = !intent.preAlive || closedBeforeRead || intent.sawInitializingPhase || changedSession;
          priorStatus = agent?.status ?? priorStatus;
          if (
            agent &&
            (intent.confirmed ||
              (!intent.skipCycles && !stale && fresh && (agent.status === "running" || agent.status === "idle")))
          ) {
            await this.confirmOpen(paseo, id, intent);
          }
        } catch (error) {
          if (!isRetryableOpenError(error)) console.warn("antigravity-accounts: open confirmation probe failed", error);
        }
        this.probe(paseo, intent, attempt + 1, priorStatus);
      }, delay),
    );
  }

  async accountForTurn(
    paseo: PaseoApi,
    agentId: string,
    metadata: Metadata,
    turnId: string | null,
    before: boolean,
    ready: Promise<unknown>,
    read = () => paseo.agents.ref(agentId).refresh(),
  ) {
    const atTurn = this.openIntents.get(agentId);
    const skippedAtTurn = atTurn?.skipCycles;
    const closedBeforeTurn = atTurn?.sawClosedPhase || atTurn?.sawInitializingPhase;
    await ready;
    const previous = this.effectiveAccountId(agentId, metadata, paseo);
    const intent = this.openIntents.get(agentId);
    if (!intent) return previous;
    if (intent !== atTurn) return intent.previousAccount ?? previous;
    if (!intent.confirmed && (skippedAtTurn || intent.skipCycles)) return previous;
    const newTurn = before && (!turnId || turnId !== intent.preTurnId);
    if (intent.recovered && !intent.probesExhausted && !this.probes.has(agentId)) this.probe(paseo, intent, 0);
    let changedSession = false;
    if (!intent.confirmed && intent.preAlive && !closedBeforeTurn) {
      const snapshot = await read().catch(() => null);
      if (this.openIntents.get(agentId) !== intent) return this.openedAccount(agentId) ?? previous;
      const agent = snapshot?.agent;
      if (!intent.confirmed && agent && !this.stalePhase(intent, agent.updatedAt)) {
        if (agent.status === "closed") this.sawClose(agentId);
        if (agent.status === "error") {
          this.failOpen(paseo, intent);
          return previous;
        }
      }
      const session = snapshot?.agent.runtimeInfo?.sessionId ?? snapshot?.agent.persistence?.sessionId;
      changedSession = !!(
        session &&
        intent.preSessionId &&
        session !== intent.preSessionId &&
        (snapshot?.agent.status === "running" || snapshot?.agent.status === "idle")
      );
      if (!intent.confirmed && !changedSession) return previous;
    }
    if (!intent.confirmed && !newTurn && !changedSession) return previous;
    await this.confirmOpen(paseo, agentId, intent);
    return intent.accountId;
  }

  attributeTurn(intent: OpenIntent | undefined, convId: string, accountId: string, at: number) {
    while (intent && this.successors.has(intent)) intent = this.successors.get(intent);
    if (intent?.persistent && !intent.confirmed) {
      if (this.openIntents.get(intent.agentId) === intent) {
        const entries = (intent.pendingAttributions ??= []);
        entries.push({ convId, at });
        this.save();
        return;
      }
      accountId = intent.previousAccount ?? intent.expectedEffective ?? intent.forAccount;
    } else if (intent?.confirmed) accountId = intent.accountId;
    if (!isAutoAccountId(accountId)) this.onConversationAccount?.(convId, accountId, at);
  }

  private settleAttributions(intent: OpenIntent, accountId: string, historical = false) {
    this.settleFailures(intent, accountId, historical);
    for (const { convId, at } of intent.pendingAttributions?.splice(0) ?? []) {
      if (!isAutoAccountId(accountId)) {
        try {
          this.onConversationAccount?.(convId, accountId, at);
        } catch (error) {
          this.report(`Could not record turn account: ${error}`);
        }
      }
    }
  }

  private settleFailures(intent: OpenIntent, accountId: string, historical: boolean) {
    const failures = this.pendingFailures.get(intent);
    this.pendingFailures.delete(intent);
    for (const callback of failures ?? []) callback(accountId, historical);
  }

  deferFailure(agentId: string, callback: (accountId: string, historical: boolean) => void) {
    const intent = this.inflightIntent(agentId);
    if (!intent || intent.accountId === (intent.previousAccount ?? intent.expectedEffective ?? intent.forAccount)) {
      return false;
    }
    if (intent.probesExhausted || intent.skipCycles || intent.sawPriorRefresh) {
      callback(intent.previousAccount ?? intent.expectedEffective ?? intent.forAccount, true);
      return true;
    }
    const failures = this.pendingFailures.get(intent) ?? [];
    failures.push(callback);
    this.pendingFailures.set(intent, failures);
    return true;
  }

  private async confirmOpen(paseo: PaseoApi, agentId: string, intent: OpenIntent) {
    if (!intent || this.disposed || this.openIntents.get(agentId) !== intent) return;
    if (!intent.confirmed) {
      intent.confirmed = true;
      this.pendingCreateRedirects.delete(agentId);
      this.rememberConfirmed(intent);
      this.settleAttributions(intent, intent.accountId);
      if (!this.unseenRefreshes.has(agentId)) this.listeners.get(agentId)?.();
      if (intent.consumedRequestId) this.setRequestState(agentId, intent.consumedRequestId, "consumed");
      if (intent.persistent) this.save();
    }
    await this.flushOpen(paseo, agentId, intent);
  }

  private flushOpen(paseo: PaseoApi, agentId: string, intent: OpenIntent) {
    return this.metadata.run(agentId, async () => {
      const active = () => !this.disposed && this.openIntents.get(agentId) === intent;
      if (!active()) return;
      const handle = paseo.agents.ref(agentId);
      const latest = await handle.refresh();
      if (!active() || !latest) return;
      const metadata = latest.agent.metadata;
      this.metadataAccount(agentId, metadata, paseo);
      if (!active()) return;
      if (latest.agent.archivedAt) {
        this.forget(agentId);
        return;
      }
      const runtime = runtimeAccountFromMetadata(metadata);
      const storedId = pendingSwitchFromMetadata(metadata)?.requestId;
      const consume = !!storedId && (storedId === intent.consumedRequestId || intent.supersededRequestIds?.includes(storedId));
      const clearCreated = !!createdRedirectFromMetadata(metadata);
      const clearAuto = metadata?.[CREATED_AUTO_METADATA_KEY] === true;
      if (intent.persistent && (intent.accountId !== intent.forAccount || runtime || consume || clearCreated || clearAuto)) {
        await handle.setMetadata({
          [RUNTIME_ACCOUNT_METADATA_KEY]:
            intent.accountId === intent.forAccount
              ? null
              : {
                  accountId: intent.accountId,
                  forAccount: intent.forAccount,
                  confirmedAt: this.lastConfirmed.get(agentId)?.confirmedAt ?? Date.now(),
                  consumedRequestId: intent.consumedRequestId,
                },
          ...(consume ? { [PENDING_ACCOUNT_METADATA_KEY]: null } : {}),
          ...(clearCreated ? { [CREATED_REDIRECT_METADATA_KEY]: null } : {}),
          ...(clearAuto ? { [CREATED_AUTO_METADATA_KEY]: null } : {}),
        });
      }
      if (!active()) return;
      intent.persistedToHost = true;
      const confirmed = this.lastConfirmed.get(agentId);
      if (confirmed) confirmed.persistedToHost = true;
      if (this.latestPending.get(agentId)?.requestId === intent.consumedRequestId) this.latestPending.delete(agentId);
      for (const id of intent.supersededRequestIds ?? []) this.revokedRequests.delete(JSON.stringify([agentId, id]));
      this.openIntents.delete(agentId);
      if (!this.unseenRefreshes.has(agentId)) this.listeners.get(agentId)?.();
      if (intent.persistent) this.save();
      const conversationId = conversationIdFrom(latest.agent.persistence);
      if (conversationId) {
        try {
          this.onConversationAccount?.(conversationId, intent.accountId, intent.openedAt);
        } catch (error) {
          console.warn("antigravity-accounts: could not record account attribution", error);
        }
      }
      if (intent.redirectFrom && intent.reason) {
        await this.noteOpen?.(paseo, agentId, intent.redirectFrom, intent.accountId, intent.reason);
      }
    });
  }

  async reload(paseo: PaseoApi, agentId: string, requestId: string) {
    const attempt: ReloadAttempt = { requestId };
    this.reloading.set(agentId, attempt);
    try {
      await paseo.agents.ref(agentId).reload();
    } catch (error) {
      this.reloading.delete(agentId);
      const opened = !!attempt.intent && this.sessions.get(agentId) === attempt.intent;
      if (opened && attempt.intent && !attempt.intent.confirmed) {
        if (isCloseTimeoutError(error)) this.removeUnseenRefresh(agentId, attempt.intent.gen);
        if (isRetryableOpenError(error) || this.retryableFailedRequests.has(requestId)) this.dropOpen(agentId);
        else this.failOpen(paseo, attempt.intent);
      }
      return { error, opened };
    } finally {
      this.reloading.delete(agentId);
    }
    this.consumeRetryableFailure(requestId);
    if (attempt.intent) {
      await this.confirmOpen(paseo, agentId, attempt.intent);
      this.probe(paseo, attempt.intent, 0);
    }
    return null;
  }

  private dropOpen(agentId: string, save = true, historical = false) {
    this.pendingCreateRedirects.delete(agentId);
    this.listeners.get(agentId)?.();
    clearTimeout(this.probes.get(agentId));
    this.probes.delete(agentId);
    this.sessions.delete(agentId);
    const intent = this.openIntents.get(agentId);
    this.openIntents.delete(agentId);
    if (intent && !intent.confirmed) {
      this.settleAttributions(
        intent,
        intent.previousAccount ?? intent.expectedEffective ?? intent.forAccount,
        historical || intent.probesExhausted,
      );
    }
    if (intent?.consumedRequestId && this.requestState(agentId, intent.consumedRequestId) === "consuming") {
      this.setRequestState(agentId, intent.consumedRequestId, "queued");
    }
    if (intent?.persistent && save) this.save();
  }

  forget(agentId: string) {
    this.unseenRefreshes.delete(agentId);
    this.orphanedCreateAccounts.delete(agentId);
    this.failedRedirects = this.failedRedirects.filter((failure) => failure.agentId !== agentId);
    this.load();
    const hadConfirmed = this.lastConfirmed.delete(agentId);
    const intent = this.openIntents.get(agentId);
    if (intent) this.pendingFailures.delete(intent);
    this.dropOpen(agentId);
    if (hadConfirmed) this.save();
    this.generations.delete(agentId);
    this.latestPending.delete(agentId);
    this.publishing.delete(agentId);
    this.recoveryAccount.delete(agentId);
  }

  dispose() {
    this.disposed = true;
    this.unseenRefreshes.clear();
    this.orphanedCreateAccounts.clear();
    this.retryableFailedRequests.clear();
    for (const stop of this.listeners.values()) stop();
    this.failedRedirects = [];
    for (const timer of this.probes.values()) clearTimeout(timer);
    this.probes.clear();
  }
}

export interface SwitchInput {
  agentId: string;
  accountId: string;
  source?: "user" | "fallback";
  when: "now" | "after-turn" | "idle-only";
  onReloadStart?: (requestId: string) => void;
  /** Optional cancellation probe checked before mutating metadata or reloading. */
  shouldAbort?: () => boolean;
  requireNotRunning?: boolean;
  expectedFrom?: string;
  expectedModel?: string | null;
}

export interface SwitchOutcome {
  result: "switched" | "scheduled" | "unchanged" | "busy";
  accountLabel: string;
}

class InvalidSwitchTarget extends Error {}

function switchTarget(service: AccountService, id: string) {
  try {
    service.assertAccountOpenable(id);
    const account = service.requireAccount(id);
    if (account?.unsafeDetail) throw new Error(account.unsafeDetail);
    return account;
  } catch (error) {
    if (isRetryableOpenError(error)) throw error;
    throw new InvalidSwitchTarget(error instanceof Error ? error.message : String(error));
  }
}

/** A queued destination must pass the same checks again when its session opens. */
async function validateSwitchTarget(service: AccountService, id: string, options?: QuotaProbeOptions) {
  checkSignal(options?.signal);
  const account = switchTarget(service, id);
  if (!account) return;
  const quota = await service.quotaFor(id, 5 * 60_000, { skipPlan: true, ...options });
  checkSignal(options?.signal);
  if (quota.timedOut) throw new AccountWaitTimeout();
  const signedIn = quota.status !== "signed-out" && (await service.hasSignInFile(id));
  checkSignal(options?.signal);
  if (!signedIn) {
    throw new InvalidSwitchTarget(`Sign in to "${service.labelOf(id)}" before moving an agent to it.`);
  }
  switchTarget(service, id);
}

/** Moves an agent to another account. The conversation stays because the store is shared. */
export async function switchAgentAccount(
  paseo: PaseoApi,
  service: AccountService,
  pending: PendingSwitches,
  input: SwitchInput,
): Promise<SwitchOutcome> {
  await service.init();
  const accountLabel = service.labelOf(input.accountId);
  const agentId = input.agentId;
  const targetId = input.accountId;
  const busy = { result: "busy", accountLabel } as const;
  const aborted = () => pending.disposed || input.shouldAbort?.() === true;
  if (aborted()) return busy;
  const handle = paseo.agents.ref(agentId);
  service.assertAccountOpenable(targetId);
  type Prepared = (
    | SwitchOutcome
    | {
        current: string;
        inflightAccount?: string;
        forAccount: string;
        requestId: string;
        reused: boolean;
      }
  ) & { written?: Promise<void> };
  const prepare = await pending.selections.run<Prepared>(agentId, async () => {
    const snapshot = await handle.refresh();
    if (!snapshot) throw new Error("That agent no longer exists.");
    const agent = snapshot.agent;
    if (!isAntigravityProvider(agent.provider)) throw new Error("Only Antigravity agents can switch Google accounts.");
    if (agent.archivedAt) throw new Error("That agent is archived.");
    const current = pending.effectiveAccountId(agentId, agent.metadata, paseo);
    if (
      aborted() ||
      (input.expectedFrom !== undefined && current !== input.expectedFrom) ||
      (input.expectedModel !== undefined && (agent.model ?? null) !== input.expectedModel) ||
      (input.when === "idle-only" && (agent.status !== "closed" || agent.activeTurn)) ||
      (input.requireNotRunning && turnInProgress(agent))
    ) {
      return busy;
    }
    const inflight = pending.inflightIntent(agentId);
    if (input.source !== "fallback") pending.clearAgentFailure(agentId, agent.model, targetId);
    if (current === targetId && (!inflight || inflight.accountId === targetId)) {
      const queued = pending.queued(agentId, agent.metadata);
      const written = queued
        ? pending.writeRequest(agentId, null, queued, () => handle.setMetadata({ [PENDING_ACCOUNT_METADATA_KEY]: null }))
        : undefined;
      return { result: "unchanged", accountLabel, written };
    }
    await validateSwitchTarget(service, targetId);
    if (aborted()) return busy;
    service.assertAccountOpenable(targetId);
    const existing = pending.queued(agentId, agent.metadata);
    const keep =
      input.source === "fallback" &&
      existing?.source === "user" &&
      existing.accountId === targetId &&
      !pending.isRequestInvalid(agentId, existing.requestId);
    const record = keep ? existing : { accountId: targetId, requestId: randomUUID(), source: input.source ?? "user" };
    const written = keep
      ? undefined
      : pending.writeRequest(agentId, record, existing, () =>
          handle.setMetadata({ [PENDING_ACCOUNT_METADATA_KEY]: { ...record } }),
        );
    return {
      current,
      inflightAccount: inflight?.accountId,
      forAccount: configuredAccountIdFromMetadata(agent.metadata),
      requestId: record.requestId,
      reused: keep,
      written,
    };
  });
  await prepare.written;
  if ("result" in prepare) return { result: prepare.result, accountLabel };
  const { current, requestId } = prepare;
  const state = pending.requestState(agentId, requestId);
  if (state === "consumed") return { result: "switched", accountLabel };
  if (state === "consuming") return { result: "scheduled", accountLabel };
  const clearPending = () => (prepare.reused ? Promise.resolve() : pending.clearRequest(paseo, agentId, requestId));
  if (aborted() && input.when !== "idle-only") {
    await clearPending();
    return busy;
  }
  if (input.when === "after-turn") return { result: "scheduled", accountLabel };
  // Serialize host reloads, but let newer user intents reach an open hook
  // while it is still preparing the previous reload's profile.
  return pending.switches.run(agentId, async (): Promise<SwitchOutcome> => {
    const latest = await handle.refresh();
    const effective = latest && pending.effectiveAccountId(agentId, latest.agent.metadata, paseo);
    if (latest && !latest.agent.archivedAt) {
      const state = pending.requestState(agentId, requestId);
      const runtime = runtimeAccountFromMetadata(latest.agent.metadata);
      if (state === "consuming" || state === "consumed" || (runtime?.consumedRequestId === requestId && effective === targetId)) {
        return { result: effective === targetId ? "switched" : "scheduled", accountLabel };
      }
      if (state === "revoked" || state === "cancelled") return busy;
    }
    if (
      aborted() ||
      !latest ||
      latest.agent.archivedAt ||
      (input.when === "idle-only" && (latest.agent.status !== "closed" || latest.agent.activeTurn)) ||
      (input.requireNotRunning && turnInProgress(latest.agent)) ||
      (input.expectedModel !== undefined && (latest.agent.model ?? null) !== input.expectedModel)
    ) {
      if (!prepare.reused) pending.revokeRequest(agentId, requestId);
      await clearPending();
      return busy;
    }
    if (input.when === "idle-only") return { result: "scheduled", accountLabel };
    const inflightConfirmed =
      input.expectedFrom === undefined &&
      effective === prepare.inflightAccount &&
      configuredAccountIdFromMetadata(latest.agent.metadata) === prepare.forAccount;
    if (pendingSwitchFromMetadata(latest.agent.metadata)?.requestId !== requestId || (effective !== current && !inflightConfirmed)) {
      await clearPending();
      return busy;
    }
    input.onReloadStart?.(requestId);
    const restoreAccount = effective ?? current;
    const failure = await pending.reload(paseo, agentId, requestId);
    if (failure) {
      const { error } = failure;
      if (pending.consumeRetryableFailure(requestId) || isRetryableOpenError(error)) throw error;
      pending.revokeRequest(agentId, requestId);
      await pending.clearRequest(paseo, agentId, requestId);
      if (input.source !== "fallback" && !aborted() && failure.opened) {
        const restoreId = randomUUID();
        const restore = await pending.selections.run(agentId, async () => {
          const latest = await handle.refresh();
          if (
            aborted() ||
            !latest ||
            latest.agent.archivedAt ||
            turnInProgress(latest.agent) ||
            pending.effectiveAccountId(agentId, latest.agent.metadata, paseo) !== restoreAccount ||
            pending.queued(agentId, latest.agent.metadata)
          ) {
            return null;
          }
          const record = { accountId: restoreAccount, requestId: restoreId, source: "fallback" } as const;
          return {
            written: pending.writeRequest(agentId, record, null, () =>
              handle.setMetadata({ [PENDING_ACCOUNT_METADATA_KEY]: record }),
            ),
          };
        });
        await restore?.written;
        const check = restore ? await handle.refresh() : null;
        if (
          !aborted() &&
          check &&
          !check.agent.archivedAt &&
          !turnInProgress(check.agent) &&
          pendingSwitchFromMetadata(check.agent.metadata)?.requestId === restoreId
        ) {
          await pending.reload(paseo, agentId, restoreId);
          pending.consumeRetryableFailure(restoreId);
        }
      }
      throw new Error(`"${accountLabel}" could not open this agent: ${error instanceof Error ? error.message : String(error)}`);
    }
    const reopened = await handle.refresh();
    if (
      reopened &&
      !reopened.agent.archivedAt &&
      pending.openedAccount(agentId) === targetId &&
      pending.effectiveAccountId(agentId, reopened.agent.metadata, paseo) === targetId
    ) {
      return { result: "switched", accountLabel };
    }
    return reopened && !reopened.agent.archivedAt && pendingAccountIdFromMetadata(reopened.agent.metadata) === targetId
      ? { result: "scheduled", accountLabel }
      : busy;
  });
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
  onBeforeSwitch?: (agentId: string) => void,
): Promise<MigrateOutcome> {
  if (input.fromAccountId === input.toAccountId) {
    throw new Error("Choose a different target account.");
  }
  await service.init();
  service.requireAccount(input.fromAccountId);
  await validateSwitchTarget(service, input.toAccountId);
  const targetLabel = service.labelOf(input.toAccountId);
  const entries: Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let includeBackground = true;
  for (;;) {
    const page = cursor ? { limit: 200, cursor } : { limit: 200 };
    let res;
    try {
      res = await paseo.agents.list({ page, ...(includeBackground ? { filter: { includeBackground: true } } : {}) });
    } catch (error) {
      if (!includeBackground || !isUnsupportedBackgroundFilterError(error)) throw error;
      includeBackground = false;
      continue;
    }
    entries.push(...res.entries);
    if (!res.pageInfo?.hasMore || !res.pageInfo.nextCursor) break;
    cursor = res.pageInfo.nextCursor;
    if (seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
  }
  let switched = 0;
  let scheduled = 0;
  let skipped = 0;
  const failed: MigrateOutcome["failed"] = [];

  for (const { agent } of entries) {
    if (agent.archivedAt || !isAntigravityProvider(agent.provider)) continue;
    if (pending.effectiveAccountId(agent.id, agent.metadata, paseo) !== input.fromAccountId) continue;
    if (input.mode === "idle-only" && (agent.status !== "closed" || agent.activeTurn)) {
      skipped += 1;
      continue;
    }
    try {
      onBeforeSwitch?.(agent.id);
      const outcome = await switchAgentAccount(paseo, service, pending, {
        agentId: agent.id,
        accountId: input.toAccountId,
        when: input.mode,
        expectedFrom: input.fromAccountId,
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

/** Tracks currently running Antigravity turns per account for concurrency-aware load balancing. */
export class ActiveLoadTracker {
  private readonly agentAccounts = new Map<string, string>();
  private readonly counts = new Map<string, number>();

  begin(agentId: string, accountId: string): void {
    const previous = this.agentAccounts.get(agentId);
    if (previous === accountId) return;
    if (previous) this.decrement(previous);
    this.agentAccounts.set(agentId, accountId);
    this.counts.set(accountId, (this.counts.get(accountId) ?? 0) + 1);
  }

  end(agentId: string): void {
    const previous = this.agentAccounts.get(agentId);
    if (!previous) return;
    this.agentAccounts.delete(agentId);
    this.decrement(previous);
  }

  countFor(accountId: string): number {
    return this.counts.get(accountId) ?? 0;
  }

  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.counts);
  }

  clear(): void {
    this.agentAccounts.clear();
    this.counts.clear();
  }

  private decrement(accountId: string): void {
    const next = (this.counts.get(accountId) ?? 0) - 1;
    if (next > 0) this.counts.set(accountId, next);
    else this.counts.delete(accountId);
  }
}

export interface NewAgentRouter {
  pickForNewAgent(model?: string | null, options?: PickForNewAgentOptions): Promise<string | null>;
}

/** The fallback controller's part of the session-open path; kept as an interface to avoid an import cycle. */
export interface OpenFallback {
  remainingQuota(accountId: string, model?: string | null): number;
  lowQuotaTarget(accountId: string, model?: string | null, excluded?: ReadonlySet<string>): Promise<string | null>;
  supportsModel?(accountId: string, model?: string | null): boolean;
  isEligible(accountId: string, model?: string | null): boolean;
  healthOf(accountId: string, model?: string | null): Promise<FallbackEvent["reason"] | null>;
  pickHealthyNext(current: string, tried: ReadonlySet<string>, model?: string | null): Promise<string | null>;
  pickHealthyBest(model?: string | null, excluded?: ReadonlySet<string>): Promise<string | null>;
  noteOpen(paseo: PaseoApi, agentId: string, from: string, to: string, reason: FallbackEvent["reason"]): Promise<void>;
}

export interface HookObservers {
  onConversationAccount?: (conversationId: string, accountId: string, at?: number) => void;
  onAgentArchived?: (agentId: string) => void;
}

export function registerHooks(
  server: PluginServerContext,
  service: AccountService,
  pending: PendingSwitches,
  fallback?: OpenFallback,
  observers?: HookObservers,
  router?: NewAgentRouter,
  activeLoad?: ActiveLoadTracker,
): Array<() => void> {
  const removers: Array<() => void> = [];
  pending.load();
  pending.noteOpen = fallback?.noteOpen.bind(fallback);
  pending.onConversationAccount = observers?.onConversationAccount;
  let disposed = false;
  removers.push(() => {
    disposed = true;
    pending.dispose();
    activeLoad?.clear();
  });

  // New Antigravity agents get a weighted load-balanced account (when auto or routing is active),
  // or the default account (+ fallback / preemptive low-quota redirect).
  // Once assigned into metadata, the session stays strictly sticky to that account unless fallback triggers.
  removers.push(
    server.addHook("agent.create.before", async ({ request }) => {
      if (!isAntigravityProvider(request.config.provider)) return undefined;
      await service.init();
      const model = request.config.model?.trim() || null;
      const metadata = { ...request.metadata, ...(model ? { [CREATED_MODEL_METADATA_KEY]: model } : {}) };
      const original = model ? { ...request, metadata } : undefined;
      const selected = request.metadata?.[ACCOUNT_METADATA_KEY];
      const explicit = typeof selected === "string" && selected.length > 0 ? selected : null;
      const explicitAuto = isAutoAccountId(explicit);
      if (explicit && !explicitAuto) return original;
      const state = await service.state();
      const routing = service.routingSettings();
      const autoRequested = explicitAuto || state.defaultAccountId === AUTO_ACCOUNT_ID;
      if (autoRequested || routing.mode !== "default") {
        const excluded = pending.confirmedFailedRedirects(CREATE_REDIRECT_SCOPE, model);
        let picked: string | null = null;
        if (router) {
          picked = await router.pickForNewAgent(model, { excluded, forceAuto: true }).catch((error: unknown) => {
            console.error("antigravity-accounts: load-balanced routing failed", error);
            return null;
          });
        }
        if (!picked && autoRequested) {
          picked = (await fallback?.pickHealthyBest(model, excluded)) ?? null;
        }
        if (picked) {
          return {
            ...request,
            metadata: { ...metadata, [ACCOUNT_METADATA_KEY]: picked, [CREATED_AUTO_METADATA_KEY]: true },
          };
        }
        if (autoRequested) {
          throw new Error("Auto account routing found no eligible account for this model. Select a signed-in account.");
        }
      }
      const chosen = state.defaultAccountId === AUTO_ACCOUNT_ID ? SYSTEM_ACCOUNT_ID : state.defaultAccountId;
      if (service.fallbackSettings().enabled && fallback) {
        const failed = pending.confirmedFailedRedirects(CREATE_REDIRECT_SCOPE, model);
        failed.add(chosen);
        const excluded = new Set([...failed, ...pending.pendingCreateAccounts(model)]);
        const healthProblem = await fallback.healthOf(chosen, model);
        const unsupported = Boolean(model && fallback.supportsModel?.(chosen, model) === false);
        const problem = healthProblem ?? (unsupported ? ("error" as const) : null);
        let next = problem
          ? await fallback.pickHealthyNext(chosen, excluded, model)
          : model
            ? await fallback.lowQuotaTarget(chosen, model, excluded)
            : null;
        if (!next && problem && excluded.size > failed.size) next = await fallback.pickHealthyNext(chosen, failed, model);
        if (!next && healthProblem) {
          throw new Error("No healthy account is available for this model. Retry after account availability changes.");
        }
        if (next) {
          return {
            ...request,
            metadata: {
              ...metadata,
              [ACCOUNT_METADATA_KEY]: chosen,
              [CREATED_REDIRECT_METADATA_KEY]: { from: chosen, to: next, reason: problem ?? "low-quota" },
            },
          };
        }
      }
      if (chosen === SYSTEM_ACCOUNT_ID) {
        return original;
      }
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
        return original;
      }
      return {
        ...request,
        metadata: { ...metadata, [ACCOUNT_METADATA_KEY]: chosen },
      };
    }),
  );

  removers.push(
    server.addHook("agent.create.after", async ({ agent }) => {
      pending.created(agent.id);
    }),
  );

  // Every launch of an Antigravity session gets the environment of its account.
  removers.push(
    server.addHook("agent.open.before", async ({ request }, { paseo, signal }) => {
      if (!isAntigravityProvider(request.provider)) return undefined;
      try {
        const openedAt = Date.now();
        const deadline = openedAt + 12_000;
        const check = () => {
          checkSignal(signal);
          if (Date.now() >= deadline) throw new AccountWaitTimeout();
        };
        const wait = <T>(task: Promise<T>) => waitForSignal(task, signal, deadline - Date.now());
        check();
        const history = request.purpose === "history";
        await wait(service.init());
        check();
        if (history && !service.store.isWritable()) {
          return { ...request, env: { ...request.env, ...sessionEnv(SYSTEM_ACCOUNT_ID, request.env) } };
        }
        const agentId = request.agentId;
        const opening = history ? null : pending.beginOpen(agentId, request.metadata);
        const handle = paseo.agents.ref(agentId);
        let snapshot: AgentSnapshot | null = null;
        let snapshotFailed = false;
        try {
          snapshot = (await wait(handle.refresh()))?.agent ?? null;
        } catch (error) {
          if (error instanceof AccountWaitTimeout) throw error;
          snapshotFailed = true;
        }
        check();
        if (opening !== null) {
          pending.assertCurrentOpen(agentId, opening);
          pending.metadataAccount(agentId, snapshot?.metadata ?? request.metadata, paseo);
          pending.checkPreviousOpen(paseo, agentId, snapshot);
        }
        const createdModel = request.metadata?.[CREATED_MODEL_METADATA_KEY];
        const isInitialCreate = request.reason === "create" && !snapshotFailed;
        const model = snapshot ? (snapshot.model ?? null) : isInitialCreate && typeof createdModel === "string" ? createdModel : null;
        const preStatus = snapshot?.status ?? (isInitialCreate ? null : "unknown");
        const baseline = {
          preStatus,
          openReason: request.reason,
          sawClosedPhase: false,
          preAlive:
            preStatus === "idle" ||
            preStatus === "running" ||
            (!isInitialCreate && preStatus === "initializing") ||
            preStatus === "unknown",
          preUpdatedAt: snapshot?.updatedAt ?? null,
          preSessionId: snapshot?.runtimeInfo?.sessionId ?? snapshot?.persistence?.sessionId ?? null,
          preTurnId: snapshot?.activeTurn?.turnId ?? null,
        };
        let metadata: Metadata = snapshot?.metadata ?? request.metadata;
        let superseded = false;
        const preparedIds = new Set<string>();
        const unavailable = new Set<string>();
        let fallbackOrigin: string | undefined;
        let preparingRequest: string | undefined;
        for (let selection = 0; selection < 5; selection++) {
          check();
          const expectedEffective = pending.metadataAccount(agentId, metadata, paseo);
          const previousAccount = pending.openedAccount(agentId) ?? expectedEffective;
          const queued = history ? null : pending.queuedForOpen(agentId, metadata, !!snapshot);
          const ignored =
            queued &&
            (pending.invalidForOpen(agentId, metadata, queued.requestId) ||
              runtimeAccountFromMetadata(metadata)?.consumedRequestId === queued.requestId);
          const clear = (id: string) =>
            void pending
              .clearRequest(paseo, agentId, id)
              .catch((error) => console.warn("antigravity-accounts: could not clear pending switch", error));
          if (ignored) clear(queued.requestId);
          const consumed = ignored ? null : queued;
          if (consumed) {
            const recovered = pending.replayIntent(agentId, metadata);
            if (recovered?.consumedRequestId) {
              preparedIds.add(recovered.consumedRequestId);
              for (const id of recovered.supersededRequestIds ?? []) preparedIds.add(id);
            }
            preparingRequest = consumed.requestId;
            preparedIds.add(consumed.requestId);
            const stored = pendingSwitchFromMetadata(metadata);
            if (stored && stored.requestId !== consumed.requestId) preparedIds.add(stored.requestId);
          }
          const replay = history ? undefined : pending.replayIntent(agentId, metadata);
          const replayRedirect = !queued && replay && !replay.consumedRequestId ? replay : undefined;
          const excluded = pending.confirmedFailedRedirects(agentId, model);
          for (const id of unavailable) excluded.add(id);
          const marker = createdRedirectFromMetadata(metadata);
          const creation = isInitialCreate && !history && !queued ? marker : null;
          const createScope = isInitialCreate || replayRedirect?.createdRedirect;
          if (createScope) {
            for (const id of pending.confirmedFailedRedirects(CREATE_REDIRECT_SCOPE, model)) excluded.add(id);
          }
          const excludedReplay = replayRedirect && excluded.has(replayRedirect.accountId);
          const rawAutomaticOrigin = !queued
            ? (fallbackOrigin ?? (!replayRedirect?.confirmed || excludedReplay ? (replayRedirect?.redirectFrom ?? creation?.from) : undefined))
            : undefined;
          const automaticOrigin = rawAutomaticOrigin && !isAutoAccountId(rawAutomaticOrigin) ? rawAutomaticOrigin : undefined;
          const redirect = automaticOrigin || excludedReplay ? undefined : replayRedirect;
          const origin =
            automaticOrigin ?? (excludedReplay || excluded.has(previousAccount) ? expectedEffective : previousAccount);
          let accountId = consumed?.accountId ?? redirect?.accountId ?? origin;
          const createdAuto = !history && request.reason === "create" && !consumed && metadata?.[CREATED_AUTO_METADATA_KEY] === true;
          const auto = createdAuto || isAutoAccountId(expectedEffective);
          const routingActive = service.routingSettings().mode !== "default";
          if (!consumed && auto) {
            const needsRepick =
              excluded.has(accountId) ||
              (createdAuto &&
                fallback &&
                ((!routingActive && !fallback.isEligible(accountId, model)) ||
                  (model?.trim() && fallback.supportsModel?.(accountId, model) === false) ||
                  Boolean(await wait(fallback.healthOf(accountId, model)))));
            if (needsRepick) accountId = AUTO_ACCOUNT_ID;
          }
          if (isAutoAccountId(accountId)) {
            let picked: string | null = null;
            if (router) {
              picked = await wait(router.pickForNewAgent(model, { excluded, forceAuto: true })).catch(() => null);
            }
            if (!picked && fallback) {
              picked = await wait(fallback.pickHealthyBest(model, excluded));
            }
            check();
            if (!picked && !history) {
              throw new Error("Auto account routing found no eligible account for this agent. Select a signed-in account.");
            }
            accountId = picked ?? SYSTEM_ACCOUNT_ID;
          }
          let redirectFrom = redirect?.redirectFrom;
          let reason: FallbackEvent["reason"] | null = redirect?.reason ?? null;
          const confirmedReplay = Boolean(redirect?.confirmed && redirect.accountId === accountId);
          const cancelled = preparingRequest && pending.requestState(agentId, preparingRequest) === "cancelled";
          const chooseRedirect = async (from: string) => {
            if (!fallback || !service.fallbackSettings().enabled) return null;
            const healthProblem = await wait(fallback.healthOf(from, model));
            const unsupported = Boolean(!history && model?.trim() && fallback.supportsModel?.(from, model) === false);
            const problem = healthProblem ?? (unsupported ? ("error" as const) : null);
            check();
            const checkQuota =
              !history &&
              (automaticOrigin || snapshot) &&
              model &&
              !ignored &&
              (automaticOrigin || !superseded) &&
              !pending.recoveringOn(agentId, from);
            const tried = new Set([from, ...excluded]);
            const avoid = createScope ? new Set([...tried, ...pending.pendingCreateAccounts(model, agentId)]) : tried;
            let next = problem
              ? await wait(fallback.pickHealthyNext(from, avoid, model))
              : checkQuota
                ? await wait(fallback.lowQuotaTarget(from, model, avoid))
                : null;
            if (!next && problem && avoid.size > tried.size) next = await wait(fallback.pickHealthyNext(from, tried, model));
            check();
            if (!next && healthProblem && !history) {
              throw new Error("No healthy account is available for this agent. Retry after account availability changes.");
            }
            return next && service.fallbackSettings().enabled ? { accountId: next, reason: problem ?? ("low-quota" as const) } : null;
          };
          if (!consumed && !cancelled && !redirect && !(auto && routingActive)) {
            const next = await chooseRedirect(accountId);
            if (next) {
              redirectFrom = accountId;
              accountId = next.accountId;
              reason = next.reason;
            }
          }
          try {
            if (consumed) {
              await wait(
                validateSwitchTarget(service, accountId, {
                  skipPlan: true,
                  timeoutMs: Math.min(8000, deadline - Date.now()),
                  signal,
                }),
              );
              check();
              if (pending.invalidForOpen(agentId, metadata, consumed.requestId)) {
                superseded = true;
                if (snapshot) metadata = (await wait(handle.refresh()))?.agent.metadata ?? metadata;
                check();
                continue;
              }
            }
            if (accountId !== SYSTEM_ACCOUNT_ID) {
              const account = service.store.get(accountId);
              const problem = account ? account.unsafeDetail : "The Antigravity account this agent was using has been removed.";
              if (problem && !history) throw new InvalidSwitchTarget(problem + " Switch the agent to another account.");
              if (problem) accountId = SYSTEM_ACCOUNT_ID;
              else {
                await wait(service.ensureAccountProfile(accountId));
                check();
                switchTarget(service, accountId);
              }
            }
          } catch (error) {
            if (consumed && (signal?.aborted || Date.now() >= deadline || isRetryableOpenError(error))) {
              pending.noteRetryableFailure(agentId, consumed.requestId);
            }
            check();
            if (opening !== null) pending.assertCurrentOpen(agentId, opening);
            if (!consumed) {
              const recoveryOrigin =
                redirectFrom && !isAutoAccountId(redirectFrom)
                  ? redirectFrom
                  : replayRedirect?.accountId === accountId &&
                      expectedEffective !== accountId &&
                      !isAutoAccountId(expectedEffective)
                    ? expectedEffective
                    : undefined;
              if (!history && !isRetryableOpenError(error) && (auto || recoveryOrigin)) {
                unavailable.add(accountId);
                pending.markRedirectFailed(agentId, model, accountId);
                if (createScope) pending.markRedirectFailed(CREATE_REDIRECT_SCOPE, model, accountId);
                if (recoveryOrigin) fallbackOrigin ??= recoveryOrigin;
                continue;
              }
              throw error;
            }
            if (isRetryableOpenError(error)) throw error;
            const wasCancelled = pending.requestState(agentId, consumed.requestId) === "cancelled";
            pending.rejectSelection(agentId, preparedIds, expectedEffective);
            for (const id of preparedIds) clear(id);
            // Revoke before another host read can time out, but honor a newer selection in this open.
            const latest: Metadata = snapshot ? ((await wait(handle.refresh()))?.agent.metadata ?? metadata) : metadata;
            const next = pending.queuedForOpen(agentId, latest, !!snapshot);
            if (
              wasCancelled ||
              (next && !pending.isRequestInvalid(agentId, next.requestId)) ||
              configuredAccountIdFromMetadata(latest) !== configuredAccountIdFromMetadata(metadata)
            ) {
              metadata = latest;
              superseded = true;
              continue;
            }
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(
              `Could not switch to "${accountId}" (${detail}). The pending switch was cancelled and the agent remains on "${expectedEffective}". Reopen or send a message to continue on "${expectedEffective}".`,
            );
          }
          check();
          const configured = configuredAccountIdFromMetadata(metadata);
          const needsIntentPersistence = Boolean(
            consumed ||
              redirectFrom ||
              replay ||
              isAutoAccountId(configured) ||
              accountId !== expectedEffective ||
              accountId !== previousAccount ||
              redirect ||
              marker ||
              createdAuto,
          );
          const watchDelivery = needsIntentPersistence || request.reason === "refresh";
          using feed = !history && watchDelivery && typeof handle.subscribe === "function" ? pending.acquireFeed(paseo) : undefined;
          let subscribeFeed = true;
          if (feed) {
            try {
              await waitForSignal(feed.ready, signal, Math.min(300, Math.max(0, deadline - Date.now())));
            } catch {
              checkSignal(signal);
              feed[Symbol.dispose]();
              subscribeFeed = false;
            }
          }
          check();
          if (!history && snapshot) {
            const latest = await wait(handle.refresh());
            check();
            if (!latest || latest.agent.archivedAt) throw new Error("This agent is no longer available.");
            const nextMetadata = latest.agent.metadata;
            if (
              pending.queuedForOpen(agentId, nextMetadata, true)?.requestId !== queued?.requestId ||
              pending.metadataAccount(agentId, nextMetadata, paseo) !== expectedEffective ||
              (pending.openedAccount(agentId) ?? expectedEffective) !== previousAccount ||
              configuredAccountIdFromMetadata(nextMetadata) !== configuredAccountIdFromMetadata(metadata)
            ) {
              metadata = nextMetadata;
              superseded = true;
              continue;
            }
            metadata = nextMetadata;
          }
          // Profile preparation and subscription setup may both yield to settings or quota changes.
          const recheckOrigin =
            automaticOrigin || (!confirmedReplay && redirectFrom && !isAutoAccountId(redirectFrom) ? redirectFrom : undefined);
          if (recheckOrigin && !history && !consumed) {
            const latest = await chooseRedirect(recheckOrigin);
            if ((latest?.accountId ?? recheckOrigin) !== accountId) continue;
            reason = latest?.reason ?? null;
          }
          if (fallback && !history && !consumed && (auto || redirectFrom || confirmedReplay)) {
            const revBefore = service.currentRevision();
            const settingsBefore = { ...service.fallbackSettings() };
            const problem = await wait(fallback.healthOf(accountId, model));
            check();
            if (redirectFrom && !confirmedReplay) {
              const latest = service.fallbackSettings();
              if (
                !latest.enabled ||
                latest.preemptiveThreshold !== settingsBefore.preemptiveThreshold ||
                latest.strategy !== settingsBefore.strategy ||
                service.currentRevision() !== revBefore
              ) {
                continue;
              }
              if (reason === "low-quota") {
                const originQuota = fallback.remainingQuota(redirectFrom, model);
                if (
                  originQuota < 0 ||
                  latest.preemptiveThreshold <= 0 ||
                  originQuota > latest.preemptiveThreshold ||
                  fallback.remainingQuota(accountId, model) <= originQuota + 0.05
                ) {
                  continue;
                }
              }
            }
            const unsupportedModel = Boolean(model?.trim() && fallback.supportsModel?.(accountId, model) === false);
            const ineligible = !confirmedReplay && !(auto && routingActive) && !fallback.isEligible(accountId, model);
            if (problem || unsupportedModel || ineligible) {
              if (auto || automaticOrigin || redirect) {
                unavailable.add(accountId);
                continue;
              }
              throw new Error("The selected account became unavailable while the session was opening.");
            }
          }
          if (
            !history &&
            (pending.queuedForOpen(agentId, metadata, !!snapshot)?.requestId !== queued?.requestId ||
              (consumed && pending.invalidForOpen(agentId, metadata, consumed.requestId)))
          ) {
            superseded = true;
            continue;
          }
          const env = { ...request.env, ...sessionEnv(accountId, request.env) };
          check();
          if (opening !== null) {
            const supersededRequestIds = consumed ? [...preparedIds].filter((id) => id !== consumed.requestId) : [];
            // If the host still has the older request, the journal owns this selection until confirmation.
            const needsReplay = !!consumed && pendingSwitchFromMetadata(metadata)?.requestId !== consumed.requestId;
            pending.commitOpenAccount(
              paseo,
              {
                agentId,
                gen: opening,
                forAccount: configured,
                accountId,
                previousAccount,
                createdRedirect: Boolean(redirectFrom && createScope),
                createdAuto: createdAuto || (isInitialCreate && isAutoAccountId(configured)),
                expectedEffective,
                consumedRequestId: consumed?.requestId ?? null,
                redirectFrom,
                reason: reason ?? undefined,
                supersededRequestIds,
                confirmed: confirmedReplay,
                persistedToHost: false,
                model,
                openedAt,
                ...baseline,
                persistent: needsIntentPersistence,
                recovered: needsReplay,
              },
              subscribeFeed,
            );
          }
          return { ...request, env };
        }
        throw new Error("The account selection kept changing during launch. Reopen the agent to use the latest selection.");
      } catch (error) {
        if (request.purpose !== "history" && (signal?.aborted || isRetryableOpenError(error))) {
          pending.noteRetryableFailure(request.agentId, pendingSwitchFromMetadata(request.metadata)?.requestId);
        }
        throw error;
      }
    }),
  );

  // Record account attribution right as a turn starts so switches split ranges accurately by timestamp.
  removers.push(
    server.addHook("agent.close.after", async ({ agent }) => {
      if (!isAntigravityProvider(agent.provider)) return;
      activeLoad?.end(agent.id);
      pending.sawClose(agent.id);
    }),
  );
  async function recordTurn(paseo: PaseoApi, agent: PluginHookAgent, turnId: string | null, before: boolean) {
    const at = Date.now();
    const intent = pending.inflightIntent(agent.id);
    const handle = paseo.agents.ref(agent.id);
    let snapshot: ReturnType<typeof handle.refresh> | undefined;
    const read = () => (snapshot ??= handle.refresh());
    const account = pending.accountForTurn(paseo, agent.id, agent.metadata, turnId, before, service.init(), read);
    if (observers?.onConversationAccount) {
      const knownId = conversationIdFrom("persistence" in agent ? agent.persistence : null);
      const conversation = knownId ?? read().then((s) => conversationIdFrom(s?.agent.persistence));
      // Buffer as soon as the conversation is known, even if metadata writeback is blocked.
      // An overlapping refresh can still be running the older session. Attribute this turn
      // to the account resolved at its boundary instead of transferring it on a later confirmation.
      const attributionIntent = intent?.skipCycles || intent?.sawPriorRefresh ? undefined : intent;
      const observedAccount =
        attributionIntent?.preAlive && attributionIntent.persistent
          ? (attributionIntent.previousAccount ?? attributionIntent.forAccount)
          : account;
      void Promise.all([conversation, observedAccount])
        .then(([convId, accountId]) => {
          if (!disposed && convId) pending.attributeTurn(attributionIntent, convId, accountId, at);
        })
        .catch(() => undefined);
    }
    return account;
  }
  removers.push(
    server.addHook("agent.turn.before", async ({ agent, turnId }, { paseo }) => {
      if (!isAntigravityProvider(agent.provider)) return;
      const accountId = await recordTurn(paseo, agent, turnId, true);
      if (!disposed && !isAutoAccountId(accountId)) activeLoad?.begin(agent.id, accountId);
    }),
  );

  // A finished turn used quota: re-read that account's quota shortly after and record attribution.
  const quotaRefresh = new Map<string, NodeJS.Timeout>();
  removers.push(
    server.addHook("agent.turn.after", async ({ agent, turnId }, { paseo }) => {
      if (!isAntigravityProvider(agent.provider)) return;
      activeLoad?.end(agent.id);
      const accountId = await recordTurn(paseo, agent, turnId, false);
      if (disposed) return;
      if (isAutoAccountId(accountId)) return;
      clearTimeout(quotaRefresh.get(accountId));
      quotaRefresh.set(
        accountId,
        setTimeout(() => {
          quotaRefresh.delete(accountId);
          void service.refreshOne(accountId).catch(() => undefined);
        }, 15_000),
      );
    }),
  );
  removers.push(() => {
    for (const timer of quotaRefresh.values()) clearTimeout(timer);
    quotaRefresh.clear();
  });

  removers.push(
    server.addHook("agent.archive.after", async ({ agent }) => {
      activeLoad?.end(agent.id);
      await service.init();
      pending.forget(agent.id);
      observers?.onAgentArchived?.(agent.id);
    }),
  );

  return removers;
}
