import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionNotification, SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { normalizeAgentCommandInput } from "../../acp/client-process.js";
import { AcpClient } from "../../acp/client.js";
import { safeErrorRejection, toSafeError } from "../../acp/error-normalization.js";
import { extractAcpError, isAcpResourceNotFoundError } from "../../acp/error-shapes.js";
import { resolveRequestedConfigOption, resolveRequestedModelId } from "../../acp/model-support.js";
import {
  assertControlAuthority,
  TimeoutError,
  withTimeout,
  type AcpControlAuthority,
} from "../../async-control.js";
import { emitRuntimeTiming } from "../../perf-metrics.js";
import type { PromptInput } from "../../prompt-content.js";
import {
  applyConfigOptionsToRecord,
  applyConfigOptionSelection,
  applyModelSelection,
  applyInitialModelSelection,
} from "../../session/config-options.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  recordClientOperation,
  recordPromptSubmission,
  recordSessionUpdate,
} from "../../session/conversation-model.js";
import { defaultSessionEventLog } from "../../session/event-log.js";
import { LiveSessionCheckpoint } from "../../session/live-checkpoint.js";
import { setDesiredModeId } from "../../session/mode-preference.js";
import { applyRequestedModelIfAdvertised } from "../../session/model-application.js";
import { advertisedModelState } from "../../session/model-state.js";
import type { ClientOperation, SessionRecord, SessionResumePolicy } from "../../types.js";
import type {
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeSessionContext,
  AcpRuntimeStatus,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "../public/contract.js";
import { AcpRuntimeError } from "../public/errors.js";
import { runtimeEventFromMessage } from "../public/events.js";
import { probeRuntime, type RuntimeHealthReport } from "../public/probe.js";
import { withConnectedSession } from "./connected-session.js";
import { resolveSupportedConfigOptionId } from "./controls.js";
import {
  applyConversation,
  applyLifecycleSnapshotToRecord,
  createInitialSessionRecord,
  reconcileAgentSessionId,
} from "./lifecycle.js";
import { runPromptTurn } from "./prompt-turn.js";
import {
  connectAndLoadSession,
  type ConnectAndLoadSessionOptions,
  type ConnectAndLoadSessionResult,
} from "./reconnect.js";
import { shouldReuseExistingRecord } from "./reuse-policy.js";
import {
  normalizeSessionOptionShape,
  persistSessionOptions,
  sessionOptionsFromRecord,
  type SessionAgentOptions,
} from "./session-options.js";
import { runtimeStatusFromRecord } from "./status.js";
import {
  AsyncEventQueue,
  createDeferred,
  toPromptInput,
  legacyTerminalEventFromTurnResult,
  type Deferred,
} from "./turn.js";

export type AcpRuntimeManagerDeps = {
  clientFactory?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
};

type ActiveSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string, authority?: AcpControlAuthority) => Promise<void>;
  setSessionModel: (
    modelId: string,
    authority?: AcpControlAuthority,
  ) => ReturnType<AcpClient["setSessionModel"]>;
  setSessionConfigOption: (
    configId: string,
    value: string,
    authority?: AcpControlAuthority,
  ) => ReturnType<AcpClient["setSessionConfigOption"]>;
  setResolvedSessionConfigOption: (
    configId: string,
    value: string,
    authority?: AcpControlAuthority,
  ) => Promise<{
    configId: string;
    response: Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>;
  }>;
};

type SettledAttempt<T> = { ok: true; value: T } | { ok: false; error: unknown };
type FailedAttempt = Extract<SettledAttempt<unknown>, { ok: false }>;

async function settleAttempt<T>(run: () => T | Promise<T>): Promise<SettledAttempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function firstFailedAttempt(
  attempts: readonly SettledAttempt<unknown>[],
): FailedAttempt | undefined {
  return attempts.find((attempt): attempt is FailedAttempt => !attempt.ok);
}

function isoNow(): string {
  return new Date().toISOString();
}

function isUnsupportedSessionCloseError(error: unknown): boolean {
  const acp = extractAcpError(error);
  if (!acp) {
    return false;
  }
  if (acp.code === -32601 || acp.code === -32602) {
    return true;
  }
  if (acp.code !== -32603 || !acp.data || typeof acp.data !== "object") {
    return false;
  }
  const details = (acp.data as { details?: unknown }).details;
  return typeof details === "string" && details.toLowerCase().includes("invalid params");
}

function createRecordId(sessionKey: string, mode: "persistent" | "oneshot"): string {
  if (mode === "persistent") {
    return sessionKey;
  }
  return `${sessionKey}:oneshot:${randomUUID()}`;
}

function resumePolicyForSessionMode(mode: "persistent" | "oneshot"): SessionResumePolicy {
  return mode === "persistent" ? "same-session-only" : "allow-new";
}

// A peer that never answers `initialize` (for example a one-shot runner waiting for a prompt on
// stdin) must not leave session creation pending. The caller's teardown closes the client, which
// stops the agent together with the descendants it has forked.
async function startRuntimeClient(
  client: AcpClient,
  agent: { agentCommand: string; agentArgv?: string[] },
  timeoutMs: number | undefined,
): Promise<void> {
  try {
    await withTimeout(client.start(), timeoutMs);
  } catch (error) {
    if (!(error instanceof TimeoutError)) {
      throw error;
    }
    // Name only the executable: configured arguments can carry credentials.
    const executable = path.basename(agent.agentArgv?.[0] ?? agent.agentCommand.split(/\s+/)[0]);
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      `ACP agent ${executable} did not complete ACP initialization within ${timeoutMs}ms. Check that the configured command starts an ACP server.`,
      { cause: error },
    );
  }
}

type CreatedRuntimeSession = {
  sessionId: string;
  agentSessionId: string | undefined;
  sessionResult:
    | Awaited<ReturnType<AcpClient["createSession"]>>
    | Awaited<ReturnType<AcpClient["loadSession"]>>;
};

type RuntimeEnsureInput = {
  sessionKey: string;
  agent: string;
  mode: "persistent" | "oneshot";
  cwd?: string;
  resumeSessionId?: string;
  sessionOptions?: SessionAgentOptions;
  agentArgv?: string[];
  authCredentials?: Record<string, string>;
};

type ResolvedRuntimeAgent = {
  cwd: string;
  agentCommand: string;
  agentArgv?: string[];
};

type ExistingRuntimeSession = {
  record: SessionRecord;
  owner?: RuntimeSessionOwner;
};

type RuntimeTurnTaskState = {
  pendingCancel: boolean;
  promptWritten: boolean;
  authorityFailure?: { error: unknown };
  turnActive: boolean;
  activeController: ActiveSessionController | null;
};

type RuntimeSessionTask = {
  completion: Promise<void>;
  cancel?: () => Promise<boolean>;
};

type RuntimeTurnTask = {
  input: AcpRuntimeTurnInput & { sessionMode: "persistent" | "oneshot" };
  promptInput: PromptInput | string;
  queue: AsyncEventQueue;
  promptStarted: Deferred<void>;
  sessionReady: Deferred<void>;
  state: RuntimeTurnTaskState;
  settleResult: (next: AcpRuntimeTurnResult) => void;
  abortHandler: () => void;
};

function observeTurnAuthority(
  input: RuntimeTurnTask["input"],
  state: RuntimeTurnTaskState,
): RuntimeTurnTask["input"] {
  if (!input.assertActive) {
    return input;
  }
  return {
    ...input,
    assertActive: () => {
      try {
        input.assertActive?.();
      } catch (error) {
        state.authorityFailure = { error };
        throw error;
      }
    },
  };
}

function runtimeFailureRejection(
  task: RuntimeTurnTask,
  error: unknown,
  safe: ReturnType<typeof toSafeError>,
): unknown {
  if (task.state.authorityFailure && task.state.authorityFailure.error === error) {
    // Host-owned admission callbacks preserve their in-process exception contract.
    if (error instanceof Error) {
      safe.message = error.message;
    }
    return error;
  }
  return safeErrorRejection(safe);
}

type RunningRuntimeTurn = {
  record: SessionRecord;
  conversation: ReturnType<typeof cloneSessionConversation>;
  acpxState: ReturnType<typeof cloneSessionAcpxState>;
  client: AcpClient;
  owner: RuntimeSessionOwner;
  connected: boolean;
  promptMessageId: string | undefined;
  activeSessionId: string;
};

type RuntimeSessionProjection = {
  record: SessionRecord;
  conversation: ReturnType<typeof cloneSessionConversation>;
};

type RuntimeControlSession = {
  record: SessionRecord;
  checkpoint: LiveSessionCheckpoint;
};

type RuntimeSessionOwner = {
  client: AcpClient;
  checkpoint: LiveSessionCheckpoint;
  retirement?: Promise<void>;
  pendingResetRecord?: SessionRecord;
  sessionKey: string;
  mode: "persistent" | "oneshot";
  recordId?: string;
  projection?: RuntimeSessionProjection;
  activeTurn?: {
    task: RuntimeTurnTask;
    turn: RunningRuntimeTurn;
  };
  bufferSessionUpdates: boolean;
  pendingSessionUpdates: SessionNotification[];
  /** Fired once the idle checkpoint persists buffered out-of-turn updates. */
  pendingOutOfTurnNotice?: () => void;
};

type PreparedRuntimeTurnState = {
  record: SessionRecord;
  retainedOwner?: RuntimeSessionOwner;
  conversation: ReturnType<typeof cloneSessionConversation>;
  acpxState: ReturnType<typeof cloneSessionAcpxState>;
  promptMessageId: string | undefined;
};

async function withSessionSetupTimeout<T>(
  method: string,
  request: Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  try {
    return await withTimeout(request, timeoutMs);
  } catch (error) {
    if (!(error instanceof TimeoutError)) {
      throw error;
    }
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      `ACP ${method} did not complete within ${timeoutMs}ms. Retry session setup and check that the configured ACP agent is responding.`,
      { cause: error },
    );
  }
}

async function createOrLoadRuntimeSession(
  client: AcpClient,
  resumeSessionId: string | undefined,
  cwd: string,
  timeoutMs: number | undefined,
): Promise<CreatedRuntimeSession> {
  if (resumeSessionId) {
    if (client.supportsResumeSession()) {
      const resumed = await withSessionSetupTimeout(
        "session/resume",
        client.resumeSession(resumeSessionId, cwd),
        timeoutMs,
      );
      return {
        sessionId: resumeSessionId,
        agentSessionId: resumed.agentSessionId,
        sessionResult: resumed,
      };
    }
    if (!client.supportsLoadSession()) {
      throw new Error(
        `Agent does not support session/resume or session/load; cannot resume session ${resumeSessionId}`,
      );
    }
    const loaded = await withSessionSetupTimeout(
      "session/load",
      client.loadSession(resumeSessionId, cwd),
      timeoutMs,
    );
    return {
      sessionId: resumeSessionId,
      agentSessionId: loaded.agentSessionId,
      sessionResult: loaded,
    };
  }

  const created = await withSessionSetupTimeout(
    "session/new",
    client.createSession(cwd),
    timeoutMs,
  );
  return {
    sessionId: created.sessionId,
    agentSessionId: created.agentSessionId,
    sessionResult: created,
  };
}

export class AcpRuntimeManager {
  private readonly exactSessionRecordIds = new Set<string>();
  private readonly activeControllers = new Map<string, ActiveSessionController>();
  private readonly controlSessionRecords = new Map<string, RuntimeControlSession>();
  private readonly retainedSessionOwners = new Map<string, RuntimeSessionOwner>();
  private readonly retiringSessionOwners = new Set<RuntimeSessionOwner>();
  private readonly pendingOneShotRecordIds = new Map<string, string>();
  private readonly ensureSessionLocks = new Map<string, Promise<void>>();
  private readonly runtimeOperationLocks = new Map<string, Promise<void>>();
  private readonly sessionTasks = new Map<string, Set<RuntimeSessionTask>>();
  private readonly closingActiveRecords = new Set<string>();
  // Refreshed on every ensure and deliberately excluded from SessionRecord.
  private readonly transientCredentials = new Map<string, Record<string, string>>();
  private readonly liveClients = new Set<AcpClient>();
  private readonly pendingTasks = new Set<Promise<unknown>>();
  private shuttingDown = false;
  private shutdownTask?: Promise<void>;
  private readonly observeAcpMessage: NonNullable<AcpRuntimeOptions["onAcpMessage"]> = (
    direction,
    message,
  ) => {
    try {
      void Promise.resolve(this.options.onAcpMessage?.(direction, message)).catch(() => {});
    } catch {
      // Observations must not interrupt protocol processing or transport writes.
    }
  };

  constructor(
    private readonly options: AcpRuntimeOptions,
    private readonly deps: AcpRuntimeManagerDeps = {},
  ) {}

  private setTransientCredentials(recordId: string, credentials?: Record<string, string>): void {
    if (!credentials || Object.keys(credentials).length === 0) {
      this.transientCredentials.delete(recordId);
      return;
    }
    this.transientCredentials.set(recordId, { ...credentials });
  }

  private createClient(options: ConstructorParameters<typeof AcpClient>[0]): AcpClient {
    this.assertOpen();
    const clientOptions: ConstructorParameters<typeof AcpClient>[0] = {
      ...options,
      onAcpMessage:
        options.processLaunchScope?.kind === "runtime-session" ? this.observeAcpMessage : undefined,
      agentProcessEnv: this.options.agentProcessEnv,
      agentProcessEnvAllow: this.options.agentProcessEnvAllow,
      agentProcessEnvBlock: this.options.agentProcessEnvBlock,
      processLifecycle: {
        ...options.processLifecycle,
        onBeforeSpawn: async (launch) => {
          this.assertOpen();
          await options.processLifecycle?.onBeforeSpawn?.(launch);
          this.assertOpen();
        },
        onSpawned: async (process) => {
          this.assertOpen();
          await options.processLifecycle?.onSpawned?.(process);
          this.assertOpen();
        },
      },
    };
    const client = this.deps.clientFactory?.(clientOptions) ?? new AcpClient(clientOptions);
    this.liveClients.add(client);
    return client;
  }

  async probe(): Promise<RuntimeHealthReport> {
    let client: AcpClient | undefined;
    try {
      return await probeRuntime(this.options, {
        clientFactory: (options) => (client = this.createClient(options)),
      });
    } finally {
      if (client) {
        this.liveClients.delete(client);
      }
    }
  }

  private assertOpen(): void {
    if (this.shuttingDown) {
      throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime is shut down.");
    }
  }

  shutdown(): Promise<void> {
    if (!this.shutdownTask) {
      this.shuttingDown = true;
      this.shutdownTask = this.shutdownOwnedClients();
    }
    return this.shutdownTask;
  }

  private async shutdownOwnedClients(): Promise<void> {
    const closed = await Promise.allSettled(
      [...this.liveClients].map(async (client) => {
        void client.requestCancelActivePrompt().catch(() => {});
        await this.closeClient(client);
      }),
    );
    await Promise.allSettled([
      ...this.ensureSessionLocks.values(),
      ...this.runtimeOperationLocks.values(),
      ...this.pendingTasks,
    ]);
    const owners = new Set([...this.retainedSessionOwners.values(), ...this.retiringSessionOwners]);
    const stopped = await Promise.allSettled(
      [...owners].map(async (owner) => {
        this.removeRetainedSessionOwner(owner);
        const retirement = owner.retirement;
        if (retirement) {
          await retirement;
        } else {
          const failure = await this.stopSessionOwner(owner);
          if (failure) {
            throw failure.error;
          }
        }
        this.retiringSessionOwners.delete(owner);
      }),
    );
    const errors: unknown[] = [];
    for (const result of [...closed, ...stopped]) {
      if (result.status === "rejected") {
        errors.push(result.reason);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "ACP runtime shutdown failed.");
    }
  }

  private trackTask<T>(task: Promise<T>): Promise<T> {
    this.pendingTasks.add(task);
    const remove = () => {
      this.pendingTasks.delete(task);
    };
    void task.then(remove, remove);
    return task;
  }

  private queueSessionTask<T>(
    recordId: string,
    run: () => Promise<T>,
    cancel?: () => Promise<boolean>,
  ): Promise<T> {
    const tasks = this.sessionTasks.get(recordId) ?? new Set<RuntimeSessionTask>();
    this.sessionTasks.set(recordId, tasks);
    const previous = [...tasks].at(-1)?.completion;
    const result = (async () => {
      await previous?.catch(() => {});
      return await run();
    })();
    const task = { completion: result.then(() => {}), cancel };
    void task.completion.catch(() => {});
    tasks.add(task);
    const remove = () => {
      tasks.delete(task);
      if (tasks.size === 0) {
        this.sessionTasks.delete(recordId);
      }
    };
    void result.then(remove, remove);
    return this.trackTask(result);
  }

  private async cancelSessionTasks(recordId: string): Promise<RuntimeSessionTask[]> {
    const tasks = [...(this.sessionTasks.get(recordId) ?? [])];
    await Promise.all(tasks.flatMap((task) => (task.cancel ? [task.cancel()] : [])));
    return tasks;
  }

  private async closeClient(client: AcpClient): Promise<void> {
    await client.close();
    this.liveClients.delete(client);
  }

  private createSessionOwner(input: {
    client: AcpClient;
    sessionKey: string;
    mode: "persistent" | "oneshot";
  }): RuntimeSessionOwner {
    const owner: RuntimeSessionOwner = {
      ...input,
      checkpoint: new LiveSessionCheckpoint({
        save: async () => this.saveSessionOwner(owner),
        onPersisted: () => {
          const notice = owner.pendingOutOfTurnNotice;
          owner.pendingOutOfTurnNotice = undefined;
          notice?.();
        },
      }),
      bufferSessionUpdates: false,
      pendingSessionUpdates: [],
    };
    this.installActiveOwnerEventHandlers(owner);
    return owner;
  }

  private installActiveOwnerEventHandlers(owner: RuntimeSessionOwner): void {
    owner.client.setEventHandlers({
      onAcpMessage: this.observeAcpMessage,
      onSessionUpdate: (notification) => this.routeOwnedSessionUpdate(owner, notification),
      onClientOperation: (operation) => this.routeOwnedClientOperation(owner, operation),
    });
  }

  private installIdleOwnerEventHandlers(owner: RuntimeSessionOwner): void {
    // Drop turn-scoped client operations while the owner is pooled. Clearing
    // first lets the client buffer updates that arrive during the transition;
    // setEventHandlers then flushes them onto the idle session-update path.
    // A failing clear must not break pooling; the next close still cleans up.
    try {
      owner.client.clearEventHandlers();
    } catch {
      // Keep going: idle pooling is best-effort handler rewiring.
    }
    owner.client.setEventHandlers({
      onSessionUpdate: (notification) => this.routeOwnedSessionUpdate(owner, notification),
    });
  }

  private async saveSessionOwner(owner: RuntimeSessionOwner): Promise<void> {
    // Initialization owns publication until the record has been admitted.
    if (!owner.recordId || owner.pendingResetRecord) {
      return;
    }
    const active = owner.activeTurn?.turn;
    const target = active ?? owner.projection;
    if (!target) {
      return;
    }
    const { record, conversation } = target;
    if (active?.connected) {
      record.acpx = active.acpxState;
    }
    record.lastUsedAt = isoNow();
    applyConversation(record, conversation);
    applyLifecycleSnapshotToRecord(record, owner.client.getAgentLifecycleSnapshot());
    await this.refreshClosedState(record);
    await this.options.sessionStore.save(record);
  }

  private routeOwnedSessionUpdate(
    owner: RuntimeSessionOwner,
    notification: SessionNotification,
  ): void {
    const active = owner.activeTurn;
    if (active) {
      const { task, turn } = active;
      if (turn.connected) {
        turn.acpxState = recordSessionUpdate(turn.conversation, turn.acpxState, notification);
        owner.checkpoint.request();
      } else {
        // Reconnect setters and their notifications share the record so an older
        // notification cannot overwrite a later acknowledgement after replay.
        turn.record.acpx = recordSessionUpdate(turn.conversation, turn.record.acpx, notification);
      }
      this.emitRuntimeTurnEvent(task, {
        jsonrpc: "2.0",
        method: "session/update",
        params: notification,
      });
      return;
    }

    if (owner.bufferSessionUpdates) {
      owner.pendingSessionUpdates.push(notification);
      return;
    }

    const projection = owner.projection;
    if (!projection) {
      owner.pendingSessionUpdates.push(notification);
      return;
    }
    projection.record.acpx = recordSessionUpdate(
      projection.conversation,
      projection.record.acpx,
      notification,
    );
    const updateTag = notification.update.sessionUpdate;
    // Debounced persist; once it lands, notify hosts that history is current.
    owner.pendingOutOfTurnNotice = () => {
      this.options.onOutOfTurnSessionUpdate?.(
        owner.recordId ?? owner.sessionKey,
        updateTag,
        notification,
      );
    };
    owner.checkpoint.request();
  }

  private routeOwnedClientOperation(owner: RuntimeSessionOwner, operation: ClientOperation): void {
    const active = owner.activeTurn;
    if (!active) {
      return;
    }
    const { task, turn } = active;
    if (turn.connected) {
      turn.acpxState = recordClientOperation(turn.conversation, turn.acpxState, operation);
      owner.checkpoint.request();
    } else {
      turn.record.acpx = recordClientOperation(turn.conversation, turn.record.acpx, operation);
    }
    this.emitRuntimeTurnEvent(task, {
      type: "client_operation",
      ...operation,
    });
  }

  private attachIdleProjection(
    owner: RuntimeSessionOwner,
    record: SessionRecord,
    conversation = cloneSessionConversation(record),
    acpxState = record.acpx,
  ): void {
    record.acpx = acpxState;
    owner.projection = { record, conversation };
    owner.activeTurn = undefined;
    this.drainPendingSessionUpdates(owner);
  }

  private drainPendingSessionUpdates(owner: RuntimeSessionOwner): void {
    for (const notification of owner.pendingSessionUpdates.splice(0)) {
      this.routeOwnedSessionUpdate(owner, notification);
    }
  }

  private async flushSessionOwner(owner: RuntimeSessionOwner): Promise<void> {
    await owner.client.waitForSessionUpdatesIdle?.().catch(() => {});
    await owner.checkpoint.flush();
  }

  private removeRetainedSessionOwner(owner: RuntimeSessionOwner): void {
    if (owner.recordId && this.retainedSessionOwners.get(owner.recordId) === owner) {
      this.retainedSessionOwners.delete(owner.recordId);
    }
    if (
      owner.mode === "oneshot" &&
      owner.recordId &&
      this.pendingOneShotRecordIds.get(owner.sessionKey) === owner.recordId
    ) {
      this.pendingOneShotRecordIds.delete(owner.sessionKey);
    }
  }

  private async readRetainedSessionOwner(
    record: SessionRecord,
    options: { consume: boolean },
  ): Promise<RuntimeSessionOwner | undefined> {
    const owner = this.retainedSessionOwners.get(record.acpxRecordId);
    if (!owner) {
      return undefined;
    }
    await this.flushSessionOwner(owner);
    const projectedRecord = owner.projection?.record;
    if (projectedRecord && projectedRecord !== record) {
      Object.assign(record, structuredClone(projectedRecord));
    }
    if (!owner.client.hasReusableSession(record.acpSessionId)) {
      this.removeRetainedSessionOwner(owner);
      await this.stopSessionOwner(owner);
      return undefined;
    }
    if (options.consume) {
      this.removeRetainedSessionOwner(owner);
    }
    return owner;
  }

  private async closeRetainedSessionOwner(recordId: string): Promise<void> {
    const owner = this.retainedSessionOwners.get(recordId);
    if (!owner) {
      return;
    }
    this.removeRetainedSessionOwner(owner);
    await this.stopSessionOwner(owner);
  }

  private async stopSessionOwner(owner: RuntimeSessionOwner): Promise<FailedAttempt | undefined> {
    const flushAttempt = await settleAttempt(async () => this.flushSessionOwner(owner));
    const closeAttempt = await settleAttempt(async () => this.closeClient(owner.client));
    if (!closeAttempt.ok) {
      this.retiringSessionOwners.add(owner);
    }
    const finalFlushAttempt = await settleAttempt(async () => owner.checkpoint.flush());
    const clearAttempt = await settleAttempt(() => owner.client.clearEventHandlers());
    const settleRecordAttempt = await settleAttempt(async () => {
      if (closeAttempt.ok) {
        await this.settleRetiredSessionRecord(owner);
      }
    });
    if (!settleRecordAttempt.ok) {
      this.retiringSessionOwners.add(owner);
    }
    // Shutdown reports failures; predecessor stops must not fail after publishing a successor.
    return firstFailedAttempt([
      flushAttempt,
      closeAttempt,
      finalFlushAttempt,
      clearAttempt,
      settleRecordAttempt,
    ]);
  }

  private async retrySessionCleanup(recordId: string): Promise<void> {
    for (const owner of this.retiringSessionOwners) {
      if (owner.recordId === recordId) {
        owner.retirement ??= this.finalizeSessionConnection({ client: owner.client, owner })
          .then(async () => {
            await this.settleRetiredSessionRecord(owner);
            this.retiringSessionOwners.delete(owner);
          })
          .finally(() => {
            owner.retirement = undefined;
          });
        await owner.retirement;
      }
    }
  }

  private async refreshClosedState(record: SessionRecord): Promise<boolean> {
    if (!this.closingActiveRecords.has(record.acpxRecordId)) {
      return record.closed === true;
    }
    const latest = await this.options.sessionStore.load(record.acpxRecordId).catch(() => undefined);
    record.closed = true;
    record.closedAt = latest?.closedAt ?? record.closedAt ?? isoNow();
    if (latest?.acpx?.reset_on_next_ensure === true) {
      // Close owns its markers; the current owner owns accepted state and updates.
      record.acpx = {
        ...record.acpx,
        reset_on_next_ensure: true,
      };
    }
    return true;
  }

  private async retainPersistentSessionOwnerAfterTurn(input: {
    record: SessionRecord;
    owner: RuntimeSessionOwner;
  }): Promise<boolean> {
    const { record, owner } = input;
    if (!this.canRetainPersistentSessionOwner(owner, record)) {
      return false;
    }
    const previousOwner = this.retainedSessionOwners.get(record.acpxRecordId);
    this.retainedSessionOwners.set(record.acpxRecordId, owner);
    if (previousOwner && previousOwner !== owner) {
      this.removeRetainedSessionOwner(previousOwner);
      await this.stopSessionOwner(previousOwner);
    }
    this.installIdleOwnerEventHandlers(owner);
    return true;
  }

  private canRetainPersistentSessionOwner(
    owner: RuntimeSessionOwner,
    record: SessionRecord,
  ): boolean {
    return (
      !this.shuttingDown &&
      owner.mode === "persistent" &&
      !record.closed &&
      !(owner.client.hasUnresolvedPrompt?.() ?? false) &&
      owner.client.hasReusableSession(record.acpSessionId)
    );
  }

  private resolveMcpServers(session: AcpRuntimeSessionContext) {
    const servers = this.options.mcpServers;
    const { sessionKey, cwd, agentCommand, agentArgv } = session;
    return [
      ...(typeof servers === "function"
        ? servers({
            sessionKey,
            cwd,
            agentCommand,
            agentArgv: agentArgv ? [...agentArgv] : undefined,
          })
        : (servers ?? [])),
    ];
  }

  private resolveSessionPermissions(session: AcpRuntimeSessionContext) {
    const { sessionKey, cwd, agentCommand, agentArgv } = session;
    const {
      permissionMode = this.options.permissionMode,
      nonInteractivePermissions = this.options.nonInteractivePermissions,
      permissionPolicy = this.options.permissionPolicy,
      onPermissionRequest = this.options.onPermissionRequest,
    } = this.options.sessionPermissions?.({
      sessionKey,
      cwd,
      agentCommand,
      agentArgv: agentArgv ? [...agentArgv] : undefined,
    }) ?? {};
    return { permissionMode, nonInteractivePermissions, permissionPolicy, onPermissionRequest };
  }

  private resolveClientCapabilities() {
    return {
      fs: this.options.fs,
      terminal: this.options.terminal,
    };
  }

  private isColdControlClientReusable(client: AcpClient, sessionId: string): boolean {
    if (client.hasUnresolvedPrompt?.()) {
      return false;
    }
    return client.hasReusableSession(sessionId);
  }

  private shouldRetainColdControlClient(
    retainClient: boolean,
    wasClosed: boolean,
    sessionMode: "persistent" | "oneshot",
    client: AcpClient,
    record: SessionRecord,
    sessionId: string,
  ): boolean {
    if (!retainClient || wasClosed || this.shuttingDown) {
      return false;
    }
    if (sessionMode !== "persistent" || record.closed) {
      return false;
    }
    if (this.closingActiveRecords.has(record.acpxRecordId)) {
      return false;
    }
    return this.isColdControlClientReusable(client, sessionId);
  }

  private async retainColdControlClient(
    client: AcpClient,
    record: SessionRecord,
  ): Promise<boolean> {
    const newOwner = this.createSessionOwner({
      client,
      sessionKey: record.name ?? record.acpxRecordId,
      mode: "persistent",
    });
    newOwner.recordId = record.acpxRecordId;
    this.attachIdleProjection(newOwner, record);
    const retained = await this.retainPersistentSessionOwnerAfterTurn({
      record,
      owner: newOwner,
    });
    if (!retained) {
      await this.stopSessionOwner(newOwner);
      return false;
    }
    return true;
  }

  private async withRuntimeControlSession<T>(
    record: SessionRecord,
    sessionMode: "persistent" | "oneshot",
    run: (context: { client: AcpClient; sessionId: string; record: SessionRecord }) => Promise<T>,
    replayOptions?: Pick<ConnectAndLoadSessionOptions, "replacingMode" | "replacingConfigOption"> & {
      retainClient?: boolean;
    },
    authority?: AcpControlAuthority,
  ): Promise<T> {
    await this.retrySessionCleanup(record.acpxRecordId);
    assertControlAuthority(authority);
    const owner = await this.readRetainedSessionOwner(record, { consume: false });
    assertControlAuthority(authority);
    if (owner) {
      return await this.runRetainedControlSession(owner, record, run);
    }
    return await this.runColdControlSession(record, sessionMode, run, replayOptions, authority);
  }

  private async runRetainedControlSession<T>(
    owner: RuntimeSessionOwner,
    record: SessionRecord,
    run: (context: { client: AcpClient; sessionId: string; record: SessionRecord }) => Promise<T>,
  ): Promise<T> {
    const tControl = performance.now();
    const ownedRecord = owner.projection?.record ?? record;
    try {
      const value = await run({
        client: owner.client,
        sessionId: ownedRecord.acpSessionId,
        record: ownedRecord,
      });
      this.refreshOwnedRecordLifecycle(owner, ownedRecord);
      await owner.checkpoint.checkpoint();
      emitRuntimeTiming("runtime.control_session", {
        session: record.acpxRecordId,
        path: "retained_owner",
        total_ms: performance.now() - tControl,
      });
      return value;
    } finally {
      await this.flushSessionOwner(owner);
    }
  }

  private async runColdControlSession<T>(
    record: SessionRecord,
    sessionMode: "persistent" | "oneshot",
    run: (context: { client: AcpClient; sessionId: string; record: SessionRecord }) => Promise<T>,
    replayOptions?: Pick<ConnectAndLoadSessionOptions, "replacingMode" | "replacingConfigOption"> & {
      retainClient?: boolean;
    },
    authority?: AcpControlAuthority,
  ): Promise<T> {
    const tColdControl = performance.now();
    const allowRetain = replayOptions?.retainClient !== false;
    const wasClosed = record.closed === true;
    let controlClient: AcpClient | undefined;
    let retainedControlClient = false;
    let controlledRecord = record;
    // Callback-driven ensure can reopen this record before the control replies.
    // Serialize that save with the accepted response and cleanup.
    const checkpoint = new LiveSessionCheckpoint({
      save: async () => this.options.sessionStore.save(controlledRecord),
    });
    try {
      const result = await settleAttempt(async () =>
        withConnectedSession({
          sessionRecordId: record.acpxRecordId,
          loadRecord: async (sessionRecordId) => {
            controlledRecord = await this.requireRecord(sessionRecordId);
            this.controlSessionRecords.set(sessionRecordId, {
              record: controlledRecord,
              checkpoint,
            });
            return controlledRecord;
          },
          saveRecord: async () => checkpoint.checkpoint(),
          createClient: (options) =>
            (controlClient = this.createClient({
              ...options,
              processLifecycle: this.options.processLifecycle,
              processLaunchScope: {
                kind: "runtime-session",
                sessionKey: record.name ?? record.acpxRecordId,
              },
            })),
          mcpServers: this.resolveMcpServers({
            ...record,
            sessionKey: record.name ?? record.acpxRecordId,
          }),
          ...this.resolveSessionPermissions({
            ...record,
            sessionKey: record.name ?? record.acpxRecordId,
          }),
          ...this.resolveClientCapabilities(),
          elicitationModes: this.options.elicitationModes,
          verbose: this.options.verbose,
          timeoutMs: this.options.timeoutMs,
          resumePolicy: resumePolicyForSessionMode(sessionMode),
          strictResume: this.exactSessionRecordIds.has(record.acpxRecordId),
          replacingMode: replayOptions?.replacingMode,
          replacingConfigOption: replayOptions?.replacingConfigOption,
          authority,
          shouldRetainClient: ({ client, record: connectedRecord, sessionId }) =>
            this.shouldRetainColdControlClient(
              allowRetain,
              wasClosed,
              sessionMode,
              client,
              connectedRecord,
              sessionId,
            ),
          run,
          onAskUserQuestion: this.options.onAskUserQuestion,
          onExitPlanMode: this.options.onExitPlanMode,
          authCredentials: this.transientCredentials.get(record.acpxRecordId),
        }),
      );
      this.controlSessionRecords.delete(record.acpxRecordId);
      const flushed = await settleAttempt(async () => checkpoint.flush());
      if (!result.ok) {
        throw result.error;
      }
      retainedControlClient = await this.settleColdControlRetention(
        result.value.retainedClient,
        result.value.record,
        flushed,
      );
      emitRuntimeTiming("runtime.control_session", {
        session: record.acpxRecordId,
        path: "cold_control_client",
        retained: retainedControlClient,
        total_ms: performance.now() - tColdControl,
      });
      return result.value.value;
    } finally {
      this.controlSessionRecords.delete(record.acpxRecordId);
      if (controlClient && !retainedControlClient) {
        this.liveClients.delete(controlClient);
      }
    }
  }

  private async settleColdControlRetention(
    retainedClient: AcpClient | undefined,
    record: SessionRecord,
    flushed: SettledAttempt<void>,
  ): Promise<boolean> {
    if (!flushed.ok) {
      if (retainedClient) {
        await settleAttempt(async () => this.closeClient(retainedClient));
      }
      throw flushed.error;
    }
    if (!retainedClient) {
      return false;
    }
    return await this.retainColdControlClient(retainedClient, record);
  }

  private refreshOwnedRecordLifecycle(owner: RuntimeSessionOwner, record: SessionRecord): void {
    record.lastUsedAt = isoNow();
    record.closed = false;
    record.closedAt = undefined;
    record.protocolVersion = owner.client.initializeResult?.protocolVersion;
    record.agentCapabilities = owner.client.initializeResult?.agentCapabilities;
    applyLifecycleSnapshotToRecord(record, owner.client.getAgentLifecycleSnapshot());
  }

  async ensureSession(input: RuntimeEnsureInput): Promise<SessionRecord> {
    return await this.withEnsureSessionLock(input, async () => {
      const record = await this.ensureSessionWithOwnership(input);
      if (input.resumeSessionId && !this.exactSessionRecordIds.has(record.acpxRecordId)) {
        // Compatible ensures bypass operation locks; an earlier alias may
        // already have committed to fresh fallback while awaiting its reply.
        this.assertRuntimeSessionIdle(record.acpxRecordId);
        this.exactSessionRecordIds.add(record.acpxRecordId);
      }
      return record;
    });
  }

  private async withEnsureSessionLock<T>(
    input: RuntimeEnsureInput,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = `${input.mode}\0${input.sessionKey}`;
    return await this.withManagerLock(this.ensureSessionLocks, key, run);
  }

  private async withManagerLock<T>(
    locks: Map<string, Promise<void>>,
    key: string,
    run: () => Promise<T>,
    authority?: AcpControlAuthority,
  ): Promise<T> {
    this.assertOpen();
    assertControlAuthority(authority);
    return await this.serializeManagerOperation(locks, key, async () => {
      this.assertOpen();
      assertControlAuthority(authority);
      return await run();
    });
  }

  private async serializeManagerOperation<T>(
    locks: Map<string, Promise<void>>,
    key: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    locks.set(key, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (locks.get(key) === tail) {
        locks.delete(key);
      }
    }
  }

  private async ensureSessionWithOwnership(input: RuntimeEnsureInput): Promise<SessionRecord> {
    const cwd = path.resolve(input.cwd?.trim() || this.options.cwd);
    const { agentCommand, agentArgv: defaultAgentArgv } = normalizeAgentCommandInput(
      this.options.agentRegistry.resolve(input.agent),
    );
    const agentArgv = input.agentArgv ?? defaultAgentArgv;
    const agent = { cwd, agentCommand, agentArgv };
    if (input.mode !== "persistent") {
      return await this.acquireRuntimeSession(input, agent);
    }
    const tCompat = performance.now();
    const compatible = await this.reuseCompatiblePersistentSession(input, agent);
    if (compatible) {
      emitRuntimeTiming("runtime.ensure_session", {
        session: input.sessionKey,
        agent: input.agent,
        path: "compatible_reuse",
        has_owner: this.retainedSessionOwners.has(compatible.acpxRecordId),
        resume: Boolean(input.resumeSessionId),
        total_ms: performance.now() - tCompat,
      });
      return compatible;
    }
    this.assertRuntimeSessionIdle(input.sessionKey);
    return await this.withManagerLock(this.runtimeOperationLocks, input.sessionKey, async () =>
      this.acquireRuntimeSession(input, agent),
    );
  }

  private async reuseCompatiblePersistentSession(
    input: RuntimeEnsureInput,
    agent: ResolvedRuntimeAgent,
  ): Promise<SessionRecord | undefined> {
    await this.retrySessionCleanup(input.sessionKey);
    const controlled = this.controlSessionRecords.get(input.sessionKey);
    const record = controlled ? controlled.record : await this.findSession(input.sessionKey);
    if (
      !record ||
      this.closingActiveRecords.has(input.sessionKey) ||
      !shouldReuseExistingRecord(record, { ...agent, resumeSessionId: input.resumeSessionId })
    ) {
      return undefined;
    }
    if (!record.closed) {
      return record;
    }
    if (!controlled || this.sessionTasks.has(input.sessionKey)) {
      return undefined;
    }
    // Native control callbacks may ensure this identity before replying. Reuse
    // the control owner's record rather than waiting for that same reply.
    return await this.reuseRuntimeSession({ record }, controlled.checkpoint);
  }

  private async acquireRuntimeSession(
    input: RuntimeEnsureInput,
    agent: ResolvedRuntimeAgent,
  ): Promise<SessionRecord> {
    const startedAt = performance.now();
    const existing = await this.loadExistingRuntimeSession(input);
    if (existing && this.canReuseRuntimeSession(input, agent, existing)) {
      const reused = await this.reuseRuntimeSession(existing);
      emitRuntimeTiming("runtime.ensure_session", {
        session: input.sessionKey,
        agent: input.agent,
        path: "reuse_record",
        has_owner: Boolean(existing.owner),
        resume: Boolean(input.resumeSessionId),
        total_ms: performance.now() - startedAt,
      });
      return reused;
    }
    await this.closeConflictingPersistentSession(input, existing?.owner);
    return await this.createOwnedRuntimeSession(input, agent);
  }

  private async loadExistingRuntimeSession(
    input: RuntimeEnsureInput,
  ): Promise<ExistingRuntimeSession | undefined> {
    const existingRecordId =
      input.mode === "persistent"
        ? input.sessionKey
        : this.pendingOneShotRecordIds.get(input.sessionKey);
    if (!existingRecordId) {
      return undefined;
    }
    await this.retrySessionCleanup(existingRecordId);
    let record = await this.findSession(existingRecordId);
    if (!record) {
      return undefined;
    }
    const owner = this.retainedSessionOwners.get(record.acpxRecordId);
    if (owner) {
      await this.flushSessionOwner(owner);
      record = owner.projection?.record ?? record;
    }
    return { record, owner };
  }

  async findSession(sessionKey: string): Promise<SessionRecord | undefined> {
    return await this.options.sessionStore.load(sessionKey);
  }

  private canReuseRuntimeSession(
    input: RuntimeEnsureInput,
    agent: ResolvedRuntimeAgent,
    existing: ExistingRuntimeSession,
  ): boolean {
    if (
      !shouldReuseExistingRecord(existing.record, {
        cwd: agent.cwd,
        agentCommand: agent.agentCommand,
        agentArgv: agent.agentArgv,
        resumeSessionId: input.resumeSessionId,
      })
    ) {
      return false;
    }
    if (input.mode === "persistent") {
      return true;
    }
    return Boolean(
      existing.owner &&
      !existing.record.closed &&
      this.pendingOneShotRecordIds.get(input.sessionKey) === existing.record.acpxRecordId &&
      this.retainedSessionOwners.get(existing.record.acpxRecordId) === existing.owner &&
      isDeepStrictEqual(
        sessionOptionsFromRecord(existing.record),
        normalizeSessionOptionShape(input.sessionOptions),
      ),
    );
  }

  private assertRuntimeSessionIdle(recordId: string): void {
    if (this.sessionTasks.has(recordId) || this.runtimeOperationLocks.has(recordId)) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `Cannot ensure session ${recordId} with incompatible or closing state while its work is unfinished. Wait for existing work to finish or use a different session key.`,
      );
    }
  }

  private async reuseRuntimeSession(
    { record, owner }: ExistingRuntimeSession,
    checkpoint = owner?.checkpoint,
  ): Promise<SessionRecord> {
    // sessionOptions on a reused persistent record are intentionally ignored:
    // system prompts are fixed at newSession time. Pending one-shot records are
    // reused only when their options still match.
    if (!record.closed && !this.closingActiveRecords.has(record.acpxRecordId)) {
      return record;
    }
    record.closed = false;
    record.closedAt = undefined;
    this.closingActiveRecords.delete(record.acpxRecordId);
    if (checkpoint) {
      await checkpoint.checkpoint();
    } else {
      await this.options.sessionStore.save(record);
    }
    return record;
  }

  private async closeConflictingPersistentSession(
    input: RuntimeEnsureInput,
    owner: RuntimeSessionOwner | undefined,
  ): Promise<void> {
    if (input.mode === "persistent" && owner?.recordId) {
      this.removeRetainedSessionOwner(owner);
      this.retiringSessionOwners.add(owner);
      await this.retrySessionCleanup(owner.recordId);
    }
  }

  private async createOwnedRuntimeSession(
    input: RuntimeEnsureInput,
    agent: ResolvedRuntimeAgent,
  ): Promise<SessionRecord> {
    const startedAt = performance.now();
    const { cwd, agentCommand, agentArgv } = agent;
    const client = this.createClient({
      agentCommand,
      agentArgv,
      cwd,
      mcpServers: this.resolveMcpServers({ ...agent, sessionKey: input.sessionKey }),
      ...this.resolveSessionPermissions({ ...agent, sessionKey: input.sessionKey }),
      ...this.resolveClientCapabilities(),
      onAskUserQuestion: this.options.onAskUserQuestion,
      onExitPlanMode: this.options.onExitPlanMode,
      authCredentials: input.authCredentials,
      elicitationModes: this.options.elicitationModes,
      processLifecycle: this.options.processLifecycle,
      processLaunchScope: { kind: "runtime-session", sessionKey: input.sessionKey },
      verbose: this.options.verbose,
      sessionOptions: input.sessionOptions,
    });
    const owner = this.createSessionOwner({
      client,
      sessionKey: input.sessionKey,
      mode: input.mode,
    });
    try {
      const tStart = performance.now();
      await startRuntimeClient(client, agent, this.options.timeoutMs);
      const startMs = performance.now() - tStart;
      this.assertOpen();
      const tSession = performance.now();
      const session = await createOrLoadRuntimeSession(
        client,
        input.resumeSessionId,
        cwd,
        this.options.timeoutMs,
      );
      const sessionRpcMs = performance.now() - tSession;
      const tPrepare = performance.now();
      const record = await this.prepareInitialRuntimeRecord({
        input,
        client,
        owner,
        agentCommand,
        agentArgv,
        cwd,
        session,
      });
      const prepareRecordMs = performance.now() - tPrepare;
      this.setTransientCredentials(record.acpxRecordId, input.authCredentials);
      const tRetain = performance.now();
      await this.retainInitializedSessionOwner(owner, record);
      const checkpointSaveMs = performance.now() - tRetain;
      if (!input.resumeSessionId) {
        this.exactSessionRecordIds.delete(record.acpxRecordId);
      }
      emitRuntimeTiming("runtime.ensure_session", {
        session: input.sessionKey,
        agent: input.agent,
        path: "create_owned",
        resume: Boolean(input.resumeSessionId),
        total_ms: performance.now() - startedAt,
        start_ms: startMs,
        session_rpc_ms: sessionRpcMs,
        prepare_record_ms: prepareRecordMs,
        checkpoint_save_ms: checkpointSaveMs,
      });
      return record;
    } catch (error) {
      await settleAttempt(async () => this.abandonInitializingSessionOwner(owner));
      throw error;
    }
  }

  private async abandonInitializingSessionOwner(owner: RuntimeSessionOwner): Promise<void> {
    const record = owner.recordId ? owner.projection?.record : undefined;
    owner.pendingResetRecord = record;
    await settleAttempt(() => owner.client.clearEventHandlers());
    const closeAttempt = await settleAttempt(async () => this.closeClient(owner.client));
    if (!record) {
      return;
    }
    this.retiringSessionOwners.add(owner);
    if (closeAttempt.ok) {
      await this.settleRetiredSessionRecord(owner);
      this.retiringSessionOwners.delete(owner);
    }
  }

  private async settleRetiredSessionRecord(owner: RuntimeSessionOwner): Promise<void> {
    const record = owner.pendingResetRecord;
    if (!record) {
      return;
    }
    // Only successful connection cleanup permits publishing a pending reset.
    applyLifecycleSnapshotToRecord(record, owner.client.getAgentLifecycleSnapshot());
    await this.saveClosedRuntimeRecord(record, true);
    owner.pendingResetRecord = undefined;
    owner.recordId = undefined;
  }

  private async prepareInitialRuntimeRecord(params: {
    input: {
      sessionKey: string;
      mode: "persistent" | "oneshot";
      sessionOptions?: SessionAgentOptions;
      resumeSessionId?: string;
    };
    client: AcpClient;
    owner: RuntimeSessionOwner;
    agentCommand: string;
    agentArgv?: string[];
    cwd: string;
    session: CreatedRuntimeSession;
  }): Promise<SessionRecord> {
    const { input, client, owner, agentCommand, agentArgv, cwd, session } = params;
    const record = createInitialSessionRecord({
      recordId: createRecordId(input.sessionKey, input.mode),
      name: input.sessionKey,
      sessionId: session.sessionId,
      sessionOrigin: input.resumeSessionId ? "resume" : "new",
      agentCommand,
      agentArgv,
      cwd,
      agentSessionId: session.agentSessionId,
    });
    this.closingActiveRecords.delete(record.acpxRecordId);
    record.protocolVersion = client.initializeResult?.protocolVersion;
    record.agentCapabilities = client.initializeResult?.agentCapabilities;
    // Fold pre-response notifications first; later controls and their updates
    // then share this record and retain wire order through acknowledgement.
    this.attachIdleProjection(owner, record);
    applyConfigOptionsToRecord(record, session.sessionResult);
    const modelApplication = await applyRequestedModelIfAdvertised({
      client,
      sessionId: session.sessionId,
      requestedModel: input.sessionOptions?.model,
      models: session.sessionResult.models,
      agentCommand,
      timeoutMs: this.options.timeoutMs,
    });
    applyInitialModelSelection(record, session.sessionResult.models, modelApplication);
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    persistSessionOptions(record, input.sessionOptions);
    return record;
  }

  private async retainInitializedSessionOwner(
    owner: RuntimeSessionOwner,
    record: SessionRecord,
  ): Promise<void> {
    owner.recordId = record.acpxRecordId;
    // The checkpoint loop also persists notifications arriving during the
    // initial async save before this owner becomes available for reuse.
    await owner.checkpoint.checkpoint();
    this.assertOpen();
    const previousOwner = this.retainedSessionOwners.get(record.acpxRecordId);
    this.retainedSessionOwners.set(record.acpxRecordId, owner);
    if (owner.mode === "oneshot") {
      this.pendingOneShotRecordIds.set(owner.sessionKey, record.acpxRecordId);
    }
    if (previousOwner && previousOwner !== owner) {
      this.removeRetainedSessionOwner(previousOwner);
      await this.stopSessionOwner(previousOwner);
    }
  }

  startTurn(input: RuntimeTurnTask["input"]): AcpRuntimeTurn {
    this.assertOpen();
    let promptInput: PromptInput | string;
    try {
      promptInput = toPromptInput(input.text, input.attachments);
    } catch (error) {
      void this.trackTask(this.closeRetainedOneShotHandle(input.handle).catch(() => {}));
      throw error;
    }
    const queue = new AsyncEventQueue();
    const result = createDeferred<AcpRuntimeTurnResult>();
    const promptStarted = createDeferred<void>();
    void promptStarted.promise.catch(() => {});
    const sessionReady = createDeferred<void>();
    void sessionReady.promise.catch(() => {});
    let resultSettled = false;
    const state: RuntimeTurnTaskState = {
      pendingCancel: false,
      promptWritten: false,
      turnActive: true,
      activeController: null,
    };
    let streamClosed = false;

    const settleResult = (next: AcpRuntimeTurnResult): void => {
      if (resultSettled) {
        return;
      }
      resultSettled = true;
      result.resolve(next);
    };

    const closeStream = (): void => {
      if (streamClosed) {
        return;
      }
      streamClosed = true;
      queue.clear();
      queue.close();
    };

    const requestCancel = async (): Promise<boolean> => {
      if (state.activeController) {
        return await state.activeController.requestCancelActivePrompt();
      }
      if (!state.turnActive) {
        return false;
      }
      state.pendingCancel = true;
      return true;
    };

    const abortHandler = () => {
      void requestCancel().catch(() => {});
    };
    if (input.signal && !input.signal.aborted) {
      input.signal.addEventListener("abort", abortHandler, { once: true });
    }

    void this.queueSessionTask(
      input.handle.acpxRecordId ?? input.handle.sessionKey,
      async () =>
        this.runRuntimeTurnTask({
          input: observeTurnAuthority(input, state),
          promptInput,
          queue,
          promptStarted,
          sessionReady,
          state,
          settleResult,
          abortHandler,
        }),
      requestCancel,
    );

    return {
      requestId: input.requestId,
      promptStarted: promptStarted.promise,
      events: queue.iterate(),
      result: result.promise,
      cancel: async () => {
        await requestCancel();
      },
      closeStream: async () => {
        closeStream();
      },
    };
  }

  private async closeRetainedOneShotHandle(handle: AcpRuntimeHandle): Promise<void> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    await this.serializeManagerOperation(this.runtimeOperationLocks, recordId, async () => {
      const owner = this.retainedSessionOwners.get(recordId);
      if (owner?.mode === "oneshot") {
        await this.closeRetainedSessionOwner(recordId);
      }
    });
  }

  private async runRuntimeTurnTask(task: RuntimeTurnTask): Promise<void> {
    let turn: RunningRuntimeTurn | undefined;
    let terminalResult: AcpRuntimeTurnResult;
    try {
      if (this.cancelRuntimeTurnBeforePrompt(task)) {
        await this.closeRetainedOneShotHandle(task.input.handle);
        terminalResult = { status: "cancelled", stopReason: "cancelled" };
      } else {
        turn = await this.prepareRuntimeTurn(task);
        const { sessionId } = await this.connectRuntimeTurn(task, turn);
        this.assertOpen();
        await this.resolveRuntimeTurnReady(task, turn);
        if (this.cancelRuntimeTurnBeforePrompt(task)) {
          terminalResult = { status: "cancelled", stopReason: "cancelled" };
        } else {
          const response = await this.runRuntimePrompt(task, turn, sessionId);
          this.updateCompletedRuntimeTurn(turn);
          terminalResult = this.completedRuntimeTurnResult(
            task,
            turn,
            response,
            response.stopReason === "cancelled" ? "cancelled" : "completed",
          );
        }
      }
    } catch (error) {
      terminalResult = await this.handleRuntimeTurnFailure(task, turn, error);
    }
    const finalization = await settleAttempt(async () =>
      this.serializeManagerOperation(
        this.runtimeOperationLocks,
        task.input.handle.acpxRecordId ?? task.input.handle.sessionKey,
        async () => this.finalizeRuntimeTurn(task, turn),
      ),
    );
    if (!finalization.ok) {
      task.settleResult(this.finalizationFailureResult(task, finalization.error));
      throw finalization.error;
    }
    task.settleResult(terminalResult);
  }

  /**
   * Finalization itself failed (e.g. checkpoint ENOSPC); skip the terminal
   * turn-results snapshot because that save would fail too.
   */
  private finalizationFailureResult(task: RuntimeTurnTask, error: unknown): AcpRuntimeTurnResult {
    const normalized = toSafeError(error, { origin: "runtime", operationId: task.input.requestId });
    const rejection = runtimeFailureRejection(task, error, normalized);
    task.promptStarted.reject(rejection);
    task.sessionReady.reject(rejection);
    return {
      status: "failed",
      error: { code: "RUNTIME", ...normalized },
    };
  }

  private completedRuntimeTurnResult(
    _task: RuntimeTurnTask,
    _turn: RunningRuntimeTurn,
    response: Awaited<ReturnType<typeof runPromptTurn>>,
    status: "cancelled" | "completed",
  ): AcpRuntimeTurnResult {
    return {
      status,
      ...(response.stopReason ? { stopReason: response.stopReason } : {}),
      ...(response._meta === undefined ? {} : { _meta: response._meta }),
    };
  }

  private async runRuntimePrompt(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
    sessionId: string,
  ): ReturnType<typeof runPromptTurn> {
    return await runPromptTurn({
      client: turn.client,
      sessionId,
      prompt: task.promptInput,
      timeoutMs: task.input.timeoutMs ?? this.options.timeoutMs,
      conversation: turn.conversation,
      promptMessageId: turn.promptMessageId,
      onPromptRequestWritten: () => {
        task.state.promptWritten = true;
        task.promptStarted.resolve();
      },
      onElicitation: task.input.onElicitation,
      onPermissionRequest: task.input.onPermissionRequest,
      authority: task.input,
    });
  }

  private async prepareRuntimeTurn(task: RuntimeTurnTask): Promise<RunningRuntimeTurn> {
    const recordId = task.input.handle.acpxRecordId ?? task.input.handle.sessionKey;
    return await this.withManagerLock(this.runtimeOperationLocks, recordId, async () => {
      await this.retrySessionCleanup(recordId);
      return await this.prepareRuntimeTurnWithOwnership(task);
    });
  }

  private async prepareRuntimeTurnWithOwnership(
    task: RuntimeTurnTask,
  ): Promise<RunningRuntimeTurn> {
    const prepared = await this.prepareRuntimeTurnState(task);
    const { record, retainedOwner, conversation, acpxState, promptMessageId } = prepared;
    try {
      const client = retainedOwner?.client ?? this.createTurnClient(record);
      const owner = this.resolveRuntimeTurnOwner(task, record, client, retainedOwner);
      const turn = this.createRunningRuntimeTurn({
        record,
        conversation,
        acpxState,
        client,
        owner,
        connected: retainedOwner !== undefined,
        promptMessageId,
      });
      this.activateRuntimeTurn(task, turn);
      return turn;
    } catch (error) {
      this.restoreBufferedSessionOwner(retainedOwner);
      throw error;
    }
  }

  private async prepareRuntimeTurnState(task: RuntimeTurnTask): Promise<PreparedRuntimeTurnState> {
    const acquired = await this.acquireRuntimeTurnState(task);
    const { record, retainedOwner } = acquired;
    const conversation = cloneSessionConversation(record);
    const acpxState = cloneSessionAcpxState(record.acpx);
    try {
      const promptStartedAt = isoNow();
      const promptMessageId = recordPromptSubmission(
        conversation,
        task.promptInput,
        promptStartedAt,
        task.input.requestId,
      );
      const nextAcpxState = cloneSessionAcpxState(acpxState) ?? {};
      nextAcpxState.turn_results = {
        ...nextAcpxState.turn_results,
        [task.input.requestId]: {
          status: "running",
          prompt_message_id: promptMessageId ?? task.input.requestId,
          started_at: promptStartedAt,
        },
      };
      record.lastRequestId = task.input.requestId;
      record.lastPromptAt = promptStartedAt;
      record.lastUsedAt = promptStartedAt;
      record.acpx = nextAcpxState;
      applyConversation(record, conversation);
      await this.options.sessionStore.save(record);
      return { record, retainedOwner, conversation, acpxState: nextAcpxState, promptMessageId };
    } catch (error) {
      this.restoreBufferedSessionOwner(retainedOwner);
      throw error;
    }
  }

  private async acquireRuntimeTurnState(task: RuntimeTurnTask): Promise<{
    record: SessionRecord;
    retainedOwner?: RuntimeSessionOwner;
  }> {
    const recordId = task.input.handle.acpxRecordId ?? task.input.handle.sessionKey;
    let record = await this.requireRecord(recordId);
    const retainedOwner = await this.readRetainedSessionOwner(record, { consume: false });
    if (!retainedOwner) {
      return { record };
    }
    retainedOwner.bufferSessionUpdates = true;
    try {
      await retainedOwner.checkpoint.flush();
      const projection = retainedOwner.projection;
      if (projection) {
        record = structuredClone(projection.record);
      }
      return { record, retainedOwner };
    } catch (error) {
      this.restoreBufferedSessionOwner(retainedOwner);
      throw error;
    }
  }

  private restoreBufferedSessionOwner(owner: RuntimeSessionOwner | undefined): void {
    if (!owner) {
      return;
    }
    owner.bufferSessionUpdates = false;
    this.drainPendingSessionUpdates(owner);
  }

  private resolveRuntimeTurnOwner(
    task: RuntimeTurnTask,
    record: SessionRecord,
    client: AcpClient,
    retainedOwner: RuntimeSessionOwner | undefined,
  ): RuntimeSessionOwner {
    return (
      retainedOwner ??
      this.createSessionOwner({
        client,
        sessionKey: record.name ?? task.input.handle.sessionKey,
        mode: task.input.sessionMode,
      })
    );
  }

  private createRunningRuntimeTurn(input: {
    record: SessionRecord;
    conversation: ReturnType<typeof cloneSessionConversation>;
    acpxState: ReturnType<typeof cloneSessionAcpxState>;
    client: AcpClient;
    owner: RuntimeSessionOwner;
    connected: boolean;
    promptMessageId: string | undefined;
  }): RunningRuntimeTurn {
    const { record, conversation, acpxState, client, owner, connected, promptMessageId } = input;
    const turn: RunningRuntimeTurn = {
      record,
      conversation,
      acpxState,
      client,
      owner,
      connected,
      promptMessageId,
      activeSessionId: record.acpSessionId,
    };
    return turn;
  }

  private activateRuntimeTurn(task: RuntimeTurnTask, turn: RunningRuntimeTurn): void {
    const { owner, record } = turn;
    this.removeRetainedSessionOwner(owner);
    owner.recordId = record.acpxRecordId;
    task.state.activeController = this.buildRuntimeTurnController(task, turn);
    this.activeControllers.set(record.acpxRecordId, task.state.activeController);
    owner.projection = undefined;
    owner.activeTurn = { task, turn };
    this.installActiveOwnerEventHandlers(owner);
    owner.bufferSessionUpdates = false;
    this.drainPendingSessionUpdates(owner);
  }

  private createTurnClient(record: SessionRecord): AcpClient {
    return this.createClient({
      agentCommand: record.agentCommand,
      agentArgv: record.agentArgv,
      cwd: record.cwd,
      mcpServers: this.resolveMcpServers({
        ...record,
        sessionKey: record.name ?? record.acpxRecordId,
      }),
      ...this.resolveSessionPermissions({
        ...record,
        sessionKey: record.name ?? record.acpxRecordId,
      }),
      ...this.resolveClientCapabilities(),
      elicitationModes: this.options.elicitationModes,
      processLifecycle: this.options.processLifecycle,
      processLaunchScope: {
        kind: "runtime-session",
        sessionKey: record.name ?? record.acpxRecordId,
      },
      verbose: this.options.verbose,
      sessionOptions: sessionOptionsFromRecord(record),
    });
  }

  private buildRuntimeTurnController(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): ActiveSessionController {
    return {
      hasActivePrompt: () => turn.client.hasActivePrompt(),
      requestCancelActivePrompt: async () => await this.requestRuntimeTurnCancel(task, turn),
      setSessionMode: async (modeId: string, authority) => {
        await this.waitForRuntimeControlSession(task, turn);
        await turn.client.setSessionMode(turn.activeSessionId, modeId, authority);
        const nextState = cloneSessionAcpxState(turn.acpxState) ?? {};
        nextState.desired_mode_id = modeId;
        turn.acpxState = nextState;
        await turn.owner.checkpoint.checkpoint();
      },
      setSessionModel: async (modelId: string, authority) => {
        await this.waitForRuntimeControlSession(task, turn);
        const models = advertisedModelState(turn.acpxState);
        const resolvedModelId = resolveRequestedModelId({
          requestedModel: modelId,
          models,
          agentCommand: turn.record.agentCommand,
        });
        const response = await turn.client.setSessionModel(
          turn.activeSessionId,
          modelId,
          models,
          authority,
        );
        turn.acpxState = applyModelSelection(turn.acpxState, modelId, response, resolvedModelId);
        await turn.owner.checkpoint.checkpoint();
        return response;
      },
      setSessionConfigOption: async (configId: string, value: string, authority) => {
        const result = await task.state.activeController!.setResolvedSessionConfigOption(
          configId,
          value,
          authority,
        );
        return result.response;
      },
      setResolvedSessionConfigOption: async (configId: string, value: string, authority) =>
        await this.setRuntimeResolvedSessionConfigOption(task, turn, configId, value, authority),
    };
  }

  private async waitForRuntimeControlSession(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): Promise<void> {
    if (turn.client.hasActivePrompt()) {
      return;
    }
    await task.sessionReady.promise;
  }

  private async requestRuntimeTurnCancel(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): Promise<boolean> {
    if (!task.state.turnActive) {
      return false;
    }
    if (turn.client.hasActivePrompt()) {
      return await turn.client.requestCancelActivePrompt();
    }
    task.state.pendingCancel = true;
    return true;
  }

  private async setRuntimeResolvedSessionConfigOption(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
    configId: string,
    value: string,
    authority?: AcpControlAuthority,
  ): Promise<{
    configId: string;
    response: Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>;
  }> {
    await this.waitForRuntimeControlSession(task, turn);
    const resolvedConfigId = resolveSupportedConfigOptionId(
      {
        ...turn.record,
        acpx: turn.acpxState ?? undefined,
      },
      configId,
    );
    // Notifications can remove the model control before the setter resolves.
    const models = advertisedModelState(turn.acpxState);
    const { modelConfigId, resolvedValue } = resolveRequestedConfigOption({
      configId: resolvedConfigId,
      value,
      models,
      agentCommand: turn.record.agentCommand,
    });
    const response = await turn.client.setSessionConfigOption(
      turn.activeSessionId,
      resolvedConfigId,
      value,
      models,
      authority,
    );
    turn.acpxState = applyConfigOptionSelection(
      turn.acpxState,
      resolvedConfigId,
      value,
      response,
      modelConfigId,
      resolvedValue,
    );
    await turn.owner.checkpoint.checkpoint();
    return { configId: resolvedConfigId, response };
  }

  private emitRuntimeTurnEvent(task: RuntimeTurnTask, payload: Record<string, unknown>): void {
    const parsed = runtimeEventFromMessage(payload);
    if (!parsed) {
      return;
    }
    task.queue.push(parsed);
  }

  private async connectRuntimeTurn(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): Promise<ConnectAndLoadSessionResult> {
    if (turn.connected) {
      return {
        sessionId: turn.record.acpSessionId,
        resumed: false,
        loadError: undefined,
        reusingLoadedSession: true,
      };
    }
    const loaded = await this.connectRuntimeTurnClient(task, turn);
    turn.acpxState = cloneSessionAcpxState(turn.record.acpx);
    turn.connected = true;
    return loaded;
  }

  private async connectRuntimeTurnClient(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): Promise<ConnectAndLoadSessionResult> {
    return await connectAndLoadSession({
      client: turn.client,
      record: turn.record,
      resumePolicy: resumePolicyForSessionMode(task.input.sessionMode),
      strictResume: this.exactSessionRecordIds.has(turn.record.acpxRecordId),
      timeoutMs: this.options.timeoutMs,
      promptRecorded: true,
      activeController: task.state.activeController!,
      onClientAvailable: () => this.publishRuntimeTurnController(task, turn),
      onConnectedRecord: (connectedRecord) => {
        connectedRecord.lastPromptAt = isoNow();
      },
      onSessionIdResolved: (sessionIdValue) => {
        turn.activeSessionId = sessionIdValue;
      },
    });
  }

  private publishRuntimeTurnController(task: RuntimeTurnTask, turn: RunningRuntimeTurn): void {
    const controller = task.state.activeController;
    if (controller) {
      this.activeControllers.set(turn.record.acpxRecordId, controller);
    }
  }

  private async resolveRuntimeTurnReady(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): Promise<void> {
    task.sessionReady.resolve();
    turn.record.lastRequestId = task.input.requestId;
    turn.record.lastPromptAt = isoNow();
    turn.record.closed = false;
    turn.record.closedAt = undefined;
    turn.record.lastUsedAt = isoNow();
    await turn.owner.checkpoint.checkpoint();
  }

  private cancelRuntimeTurnBeforePrompt(task: RuntimeTurnTask): boolean {
    if (!task.state.pendingCancel && !task.input.signal?.aborted) {
      return false;
    }
    task.state.pendingCancel = false;
    task.promptStarted.reject(new Error("ACP turn cancelled before prompt submission."));
    return true;
  }

  private updateCompletedRuntimeTurn(turn: RunningRuntimeTurn): void {
    turn.record.acpSessionId = turn.activeSessionId;
    reconcileAgentSessionId(turn.record, turn.record.agentSessionId);
    turn.record.protocolVersion = turn.client.initializeResult?.protocolVersion;
    turn.record.agentCapabilities = turn.client.initializeResult?.agentCapabilities;
  }

  private async handleRuntimeTurnFailure(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn | undefined,
    error: unknown,
  ): Promise<AcpRuntimeTurnResult> {
    if (!task.input.signal?.aborted || error !== task.input.signal.reason) {
      return await this.failRuntimeTurn(task, turn, error);
    }
    task.promptStarted.reject(error);
    task.sessionReady.reject(error);
    return { status: "cancelled", stopReason: "cancelled" };
  }

  private async saveCompletedRuntimeTurn(turn: RunningRuntimeTurn): Promise<void> {
    turn.record.acpSessionId = turn.activeSessionId;
    reconcileAgentSessionId(turn.record, turn.record.agentSessionId);
    turn.record.protocolVersion = turn.client.initializeResult?.protocolVersion;
    turn.record.agentCapabilities = turn.client.initializeResult?.agentCapabilities;
    turn.record.acpx = turn.acpxState;
    applyConversation(turn.record, turn.conversation);
    applyLifecycleSnapshotToRecord(turn.record, turn.client.getAgentLifecycleSnapshot());
    await this.options.sessionStore.save(turn.record);
  }

  private async saveTerminalRuntimeTurn(
    turn: RunningRuntimeTurn,
    status: "completed" | "failed" | "cancelled",
    stopReason: string | undefined,
    errorCode?: string,
  ): Promise<void> {
    const completedAt = isoNow();
    applyTerminalTurnSnapshot(turn, status, stopReason, errorCode, completedAt);
    await this.saveCompletedRuntimeTurn(turn);
  }

  private async failRuntimeTurn(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn | undefined,
    error: unknown,
  ): Promise<AcpRuntimeTurnResult> {
    const normalized = toSafeError(error, {
      origin: "runtime",
      operationId: task.input.requestId,
      outcomeUnknown: task.state.promptWritten && !extractAcpError(error),
    });
    const rejection = runtimeFailureRejection(task, error, normalized);
    task.promptStarted.reject(rejection);
    task.sessionReady.reject(rejection);
    if (turn) {
      await this.saveTerminalRuntimeTurn(
        turn,
        "failed",
        "runtime_error",
        normalized.code ?? normalized.detailCode,
      ).catch(() => {});
    }
    return {
      status: "failed",
      error: { code: "RUNTIME", ...normalized },
    };
  }

  private async finalizeRuntimeTurn(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn | undefined,
  ): Promise<void> {
    task.state.turnActive = false;
    const abortHandlerAttempt = await settleAttempt(() =>
      task.input.signal?.removeEventListener("abort", task.abortHandler),
    );
    const recordAttempt = await settleAttempt(async () =>
      turn ? await this.finalizeRuntimeTurnRecord(turn) : false,
    );
    let failure = firstFailedAttempt([abortHandlerAttempt, recordAttempt]);
    let pooled = recordAttempt.ok ? recordAttempt.value : false;
    if (failure) {
      this.discardRetainedRuntimeTurnOwner(turn);
      pooled = false;
    }
    const closeAttempt = await settleAttempt(async () => this.closeRuntimeTurnClient(turn, pooled));
    this.cleanupRuntimeTurn(task, turn);
    failure ??= firstFailedAttempt([closeAttempt]);
    if (failure) {
      throw failure.error;
    }
  }

  private discardRetainedRuntimeTurnOwner(turn: RunningRuntimeTurn | undefined): void {
    if (turn) {
      this.removeRetainedSessionOwner(turn.owner);
      this.attachFinalRuntimeProjection(turn);
    }
  }

  private attachFinalRuntimeProjection(turn: RunningRuntimeTurn): void {
    const current = turn.connected ? turn.acpxState : turn.record.acpx;
    const state =
      turn.record.acpx?.reset_on_next_ensure === true
        ? { ...current, reset_on_next_ensure: true }
        : current;
    this.attachIdleProjection(turn.owner, turn.record, turn.conversation, state);
  }

  private async closeRuntimeTurnClient(
    turn: RunningRuntimeTurn | undefined,
    pooled: boolean,
  ): Promise<void> {
    if (!turn || pooled) {
      return;
    }
    const clearAttempt = await settleAttempt(() => turn.client.clearEventHandlers());
    const closeAttempt = await settleAttempt(async () => this.closeClient(turn.client));
    const flushAttempt = await settleAttempt(async () => this.flushSessionOwner(turn.owner));
    const failure = firstFailedAttempt([clearAttempt, closeAttempt, flushAttempt]);
    if (failure) {
      this.retiringSessionOwners.add(turn.owner);
      throw failure.error;
    }
  }

  private cleanupRuntimeTurn(task: RuntimeTurnTask, turn: RunningRuntimeTurn | undefined): void {
    if (turn) {
      this.activeControllers.delete(turn.record.acpxRecordId);
      this.closingActiveRecords.delete(turn.record.acpxRecordId);
    }
    task.queue.close();
  }

  private async finalizeRuntimeTurnRecord(turn: RunningRuntimeTurn): Promise<boolean> {
    if (!turn.connected) {
      turn.acpxState = cloneSessionAcpxState(turn.record.acpx);
    }
    await turn.owner.checkpoint.checkpoint();
    this.attachFinalRuntimeProjection(turn);
    // A loaded transport is not reusable until preference reconciliation succeeds.
    if (turn.record.closed || !turn.connected) {
      return false;
    }
    return await this.retainPersistentSessionOwnerAfterTurn({
      record: turn.record,
      owner: turn.owner,
    });
  }

  async *runTurn(input: RuntimeTurnTask["input"]): AsyncIterable<AcpRuntimeEvent> {
    const turn = this.startTurn(input);
    yield* turn.events;
    const result = await turn.result;
    yield result.status === "failed"
      ? { type: "error", ...result.error }
      : legacyTerminalEventFromTurnResult(result);
  }

  getStatus(handle: AcpRuntimeHandle): Promise<AcpRuntimeStatus> {
    this.assertOpen();
    return this.trackTask(this.readStatus(handle));
  }

  private async readStatus(handle: AcpRuntimeHandle): Promise<AcpRuntimeStatus> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    const owner = this.retainedSessionOwners.get(recordId);
    if (owner) {
      await this.flushSessionOwner(owner);
    }
    const record = await this.requireRecord(recordId);
    return runtimeStatusFromRecord(record);
  }

  async setMode(
    handle: AcpRuntimeHandle,
    mode: string,
    sessionMode: "persistent" | "oneshot" = "persistent",
    authority?: AcpControlAuthority,
  ): Promise<void> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    await this.withManagerLock(
      this.runtimeOperationLocks,
      recordId,
      async () => this.setModeWithOwnership(handle, mode, sessionMode, authority),
      authority,
    );
  }

  private async setModeWithOwnership(
    handle: AcpRuntimeHandle,
    mode: string,
    sessionMode: "persistent" | "oneshot",
    authority?: AcpControlAuthority,
  ): Promise<void> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    assertControlAuthority(authority);
    const controller = this.activeControllers.get(record.acpxRecordId);
    if (controller) {
      await controller.setSessionMode(mode, authority);
      return;
    }
    await this.withRuntimeControlSession(
      record,
      sessionMode,
      async ({ client, sessionId, record: connectedRecord }) => {
        await client.setSessionMode(sessionId, mode, authority);
        setDesiredModeId(connectedRecord, mode);
      },
      { replacingMode: true },
      authority,
    );
  }

  async setModel(
    handle: AcpRuntimeHandle,
    model: string,
    sessionMode: "persistent" | "oneshot" = "persistent",
    authority?: AcpControlAuthority,
  ): Promise<void> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    await this.withManagerLock(
      this.runtimeOperationLocks,
      recordId,
      async () => this.setModelWithOwnership(handle, model, sessionMode, authority),
      authority,
    );
  }

  private async setModelWithOwnership(
    handle: AcpRuntimeHandle,
    model: string,
    sessionMode: "persistent" | "oneshot",
    authority?: AcpControlAuthority,
  ): Promise<void> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    assertControlAuthority(authority);
    const controller = this.activeControllers.get(record.acpxRecordId);
    if (controller) {
      await controller.setSessionModel(model, authority);
      return;
    }
    await this.withRuntimeControlSession(
      record,
      sessionMode,
      async ({ client, sessionId, record: connectedRecord }) => {
        const models = advertisedModelState(connectedRecord.acpx);
        const resolvedModelId = resolveRequestedModelId({
          requestedModel: model,
          models,
          agentCommand: connectedRecord.agentCommand,
        });
        const response = await client.setSessionModel(sessionId, model, models, authority);
        connectedRecord.acpx = applyModelSelection(
          connectedRecord.acpx,
          model,
          response,
          resolvedModelId,
        );
      },
      { replacingConfigOption: { key: "model" } },
      authority,
    );
  }

  async setConfigOption(
    handle: AcpRuntimeHandle,
    key: string,
    value: string,
    sessionMode: "persistent" | "oneshot" = "persistent",
    authority?: AcpControlAuthority,
  ): Promise<SetSessionConfigOptionResponse> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    return await this.withManagerLock(
      this.runtimeOperationLocks,
      recordId,
      async () => this.setConfigOptionWithOwnership(handle, key, value, sessionMode, authority),
      authority,
    );
  }

  private async setConfigOptionWithOwnership(
    handle: AcpRuntimeHandle,
    key: string,
    value: string,
    sessionMode: "persistent" | "oneshot",
    authority?: AcpControlAuthority,
  ): Promise<SetSessionConfigOptionResponse> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    assertControlAuthority(authority);
    const controller = this.activeControllers.get(record.acpxRecordId);
    if (controller) {
      const { response } = await controller.setResolvedSessionConfigOption(key, value, authority);
      return response;
    }

    return await this.withRuntimeControlSession(
      record,
      sessionMode,
      async ({ client, sessionId, record: connectedRecord }) => {
        const configId = resolveSupportedConfigOptionId(connectedRecord, key);
        const models = advertisedModelState(connectedRecord.acpx);
        const { modelConfigId, resolvedValue } = resolveRequestedConfigOption({
          configId,
          value,
          models,
          agentCommand: connectedRecord.agentCommand,
        });
        const response = await client.setSessionConfigOption(
          sessionId,
          configId,
          value,
          models,
          authority,
        );
        connectedRecord.acpx = applyConfigOptionSelection(
          connectedRecord.acpx,
          configId,
          value,
          response,
          modelConfigId,
          resolvedValue,
        );
        return response;
      },
      {
        replacingConfigOption: {
          key,
          resolve: (connectedRecord) => resolveSupportedConfigOptionId(connectedRecord, key),
        },
      },
      authority,
    );
  }

  async logoutSession(input: { handle: AcpRuntimeHandle }): Promise<void> {
    const record = await this.requireRecord(input.handle.acpxRecordId ?? input.handle.sessionKey);
    await this.withRuntimeControlSession(
      record,
      "persistent",
      async ({ client }) => {
        await client.logout();
      },
      { retainClient: false },
    );
  }

  async authenticateSession(input: {
    handle: AcpRuntimeHandle;
    methodId: string;
    credentials?: Record<string, string>;
  }): Promise<void> {
    const record = await this.requireRecord(input.handle.acpxRecordId ?? input.handle.sessionKey);
    await this.withRuntimeControlSession(record, "persistent", async ({ client }) => {
      await client.authenticate(input.methodId, input.credentials);
    });
  }

  async forkSession(input: {
    handle: AcpRuntimeHandle;
    cwd?: string;
  }): Promise<{ sessionId: string; agentSessionId?: string }> {
    const record = await this.requireRecord(input.handle.acpxRecordId ?? input.handle.sessionKey);
    if (!record.agentCapabilities?.sessionCapabilities?.fork) {
      throw new Error("capability_unsupported");
    }
    const result = await this.withRuntimeControlSession(
      record,
      "persistent",
      async ({ client }) => {
        return await client.forkSession({ sessionId: record.acpSessionId, cwd: input.cwd });
      },
    );

    const newRecord: SessionRecord = {
      ...record,
      acpxRecordId: result.sessionId,
      acpSessionId: result.agentSessionId || result.sessionId,
      agentSessionId: result.agentSessionId,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      messages: [...record.messages],
      name: `${record.name || record.acpxRecordId} (Fork)`,
    };
    await this.options.sessionStore.save(newRecord);
    return result;
  }

  async deleteSession(input: { handle: AcpRuntimeHandle; sessionId: string }): Promise<void> {
    const record = await this.requireRecord(input.handle.acpxRecordId ?? input.handle.sessionKey);
    if (!record.agentCapabilities?.sessionCapabilities?.delete) {
      throw new Error("capability_unsupported");
    }
    await this.withRuntimeControlSession(
      record,
      "persistent",
      async ({ client }) => {
        await client.deleteSession(record.acpSessionId);
      },
      { retainClient: false },
    );
    record.closed = true;
    record.closedAt = new Date().toISOString();
    await this.options.sessionStore.save(record);
  }

  async cancel(handle: AcpRuntimeHandle): Promise<void> {
    const controller = this.activeControllers.get(handle.acpxRecordId ?? handle.sessionKey);
    await controller?.requestCancelActivePrompt();
  }

  prepareFreshSession(handle: AcpRuntimeHandle): Promise<void> {
    this.assertOpen();
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    const cancelled = this.cancelSessionTasks(recordId);
    void cancelled.catch(() => {});
    return this.queueSessionTask(recordId, async () => {
      const tasks = await cancelled;
      await Promise.all(tasks.map((task) => task.completion));
      return await this.withManagerLock(this.runtimeOperationLocks, recordId, async () =>
        this.closeRuntimeSession(handle, "prepare-fresh"),
      );
    });
  }

  close(
    handle: AcpRuntimeHandle,
    options: { discardPersistentState?: boolean } = {},
  ): Promise<void> {
    this.assertOpen();
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    return this.trackTask(
      this.withManagerLock(this.runtimeOperationLocks, recordId, async () => {
        return await this.closeRuntimeSession(
          handle,
          options.discardPersistentState === true ? "discard" : "release",
        );
      }),
    );
  }

  private async closeRuntimeSession(
    handle: AcpRuntimeHandle,
    intent: "release" | "prepare-fresh" | "discard",
  ): Promise<void> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    await this.retrySessionCleanup(recordId);
    const record = await this.resolveRuntimeRecordForClose(recordId);
    this.markActiveRuntimeRecordClosing(record);
    if (intent !== "prepare-fresh") {
      await this.cancelSessionTasks(recordId);
    }
    const closeFailure = await this.closeRuntimeRecordOwnership(record, intent);
    if (intent === "discard") {
      if (closeFailure) {
        throw closeFailure.error;
      }
      return;
    }
    const saveAttempt = await settleAttempt(async () =>
      this.saveClosedRuntimeRecord(record, intent !== "release"),
    );
    const failure = closeFailure ?? firstFailedAttempt([saveAttempt]);
    if (failure) {
      throw failure.error;
    }
  }

  private async saveClosedRuntimeRecord(record: SessionRecord, reset: boolean): Promise<void> {
    record.closed = true;
    record.closedAt = isoNow();
    if (reset) {
      record.acpx = { ...record.acpx, reset_on_next_ensure: true };
    }
    await this.options.sessionStore.save(record);
    this.transientCredentials.delete(record.acpxRecordId);
  }

  async adoptSession(input: {
    handle: AcpRuntimeHandle;
    sessionKey: string;
  }): Promise<SessionRecord> {
    const sourceRecordId = input.handle.acpxRecordId ?? input.handle.sessionKey;
    const targetRecordId = input.sessionKey.trim();
    const sourceRecord = await this.requireRecord(sourceRecordId);
    if (sourceRecordId === targetRecordId) {
      return sourceRecord;
    }

    const rebind = this.requireSessionStoreRebind();
    this.assertAdoptableSessionSource(sourceRecordId, targetRecordId);
    await this.assertAdoptionTargetAvailable(targetRecordId);

    const owner = this.retainedSessionOwners.get(sourceRecordId);
    if (owner) {
      await this.flushSessionOwner(owner);
    }

    try {
      await this.assertAdoptionTargetAvailable(targetRecordId);
      const now = isoNow();
      const adoptedRecord: SessionRecord = {
        ...sourceRecord,
        acpxRecordId: targetRecordId,
        name: targetRecordId,
        lastUsedAt: now,
        updated_at: now,
        eventLog: {
          ...sourceRecord.eventLog,
          active_path: defaultSessionEventLog(targetRecordId).active_path,
        },
      };
      await rebind(sourceRecordId, adoptedRecord);
      this.moveAdoptedManagerState(sourceRecordId, targetRecordId, owner);
      return adoptedRecord;
    } catch (error) {
      throw error instanceof AcpRuntimeError
        ? error
        : new AcpRuntimeError(
            "ACP_SESSION_INIT_FAILED",
            `Failed to adopt ACP session ${sourceRecordId} as ${targetRecordId}.`,
            { cause: error },
          );
    }
  }

  private requireSessionStoreRebind(): NonNullable<AcpRuntimeOptions["sessionStore"]["rebind"]> {
    if (!this.options.sessionStore.rebind) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "The configured ACP session store does not support session adoption.",
      );
    }
    return async (sourceSessionId, record) => {
      await this.options.sessionStore.rebind!(sourceSessionId, record);
    };
  }

  private assertAdoptableSessionSource(sourceRecordId: string, targetRecordId: string): void {
    if (!targetRecordId) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    if (sourceRecordId.includes(":oneshot:")) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `Cannot adopt one-shot ACP session ${sourceRecordId}.`,
      );
    }
  }

  private async assertAdoptionTargetAvailable(targetRecordId: string): Promise<void> {
    const existing = await this.options.sessionStore.load(targetRecordId);
    if (existing && !existing.closed) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `ACP session already exists: ${targetRecordId}`,
      );
    }
  }

  private moveAdoptedManagerState(
    sourceRecordId: string,
    targetRecordId: string,
    owner: RuntimeSessionOwner | undefined,
  ): void {
    if (owner) {
      owner.sessionKey = targetRecordId;
      owner.recordId = targetRecordId;
      if (owner.projection) {
        owner.projection.record.acpxRecordId = targetRecordId;
        owner.projection.record.name = targetRecordId;
      }
      this.retainedSessionOwners.delete(sourceRecordId);
      this.retainedSessionOwners.set(targetRecordId, owner);
    }
    const creds = this.transientCredentials.get(sourceRecordId);
    if (creds) {
      this.transientCredentials.delete(sourceRecordId);
      this.transientCredentials.set(targetRecordId, creds);
    }
  }

  private async resolveRuntimeRecordForClose(recordId: string): Promise<SessionRecord> {
    const retainedOwner = this.retainedSessionOwners.get(recordId);
    if (retainedOwner) {
      await this.flushSessionOwner(retainedOwner);
    }
    return retainedOwner?.projection?.record ?? (await this.requireRecord(recordId));
  }

  private markActiveRuntimeRecordClosing(record: SessionRecord): void {
    if (this.activeControllers.has(record.acpxRecordId)) {
      this.closingActiveRecords.add(record.acpxRecordId);
    }
  }

  private async closeRuntimeRecordOwnership(
    record: SessionRecord,
    intent: "release" | "prepare-fresh" | "discard",
  ): Promise<FailedAttempt | undefined> {
    if (intent === "discard") {
      return await this.closeBackendSession(record);
    } else if (intent === "prepare-fresh") {
      const owner = this.retainedSessionOwners.get(record.acpxRecordId);
      if (owner) {
        this.removeRetainedSessionOwner(owner);
        this.retiringSessionOwners.add(owner);
      }
      await this.retrySessionCleanup(record.acpxRecordId);
    } else {
      await this.closeRetainedSessionOwner(record.acpxRecordId);
    }
    return undefined;
  }

  private async closeBackendSession(record: SessionRecord): Promise<FailedAttempt | undefined> {
    const connection = await this.acquireBackendCloseConnection(record);
    const requestAttempt = await settleAttempt(async () => {
      try {
        await this.requestBackendSessionClose(record, connection);
      } catch (error) {
        this.handleBackendSessionCloseError(record, error);
      }
    });
    const owner =
      connection.owner ??
      this.createSessionOwner({
        client: connection.client,
        sessionKey: record.acpxRecordId,
        mode: "persistent",
      });
    owner.recordId = record.acpxRecordId;
    const finalizeAttempt = await settleAttempt(async () =>
      this.finalizeSessionConnection(connection),
    );
    owner.pendingResetRecord = record;
    this.retiringSessionOwners.add(owner);
    if (!finalizeAttempt.ok) {
      throw finalizeAttempt.error;
    }
    const saveAttempt = await settleAttempt(async () => this.settleRetiredSessionRecord(owner));
    if (saveAttempt.ok) {
      this.retiringSessionOwners.delete(owner);
    }
    return firstFailedAttempt([requestAttempt, saveAttempt]);
  }

  private async finalizeSessionConnection(connection: {
    client: AcpClient;
    owner?: RuntimeSessionOwner;
  }): Promise<void> {
    const flushAttempt = await settleAttempt(async () => {
      if (connection.owner) {
        await this.flushSessionOwner(connection.owner);
      }
    });
    const clearAttempt = await settleAttempt(() => connection.owner?.client.clearEventHandlers());
    const closeAttempt = await settleAttempt(async () => this.closeClient(connection.client));
    const finalFlushAttempt = await settleAttempt(async () => connection.owner?.checkpoint.flush());
    const failure = firstFailedAttempt([
      flushAttempt,
      clearAttempt,
      closeAttempt,
      finalFlushAttempt,
    ]);
    if (failure) {
      throw failure.error;
    }
  }

  private async acquireBackendCloseConnection(record: SessionRecord): Promise<{
    client: AcpClient;
    owner?: RuntimeSessionOwner;
  }> {
    const owner = await this.readRetainedSessionOwner(record, { consume: true });
    if (owner) {
      return { client: owner.client, owner };
    }
    return {
      client: this.createTurnClient(record),
    };
  }

  private async requestBackendSessionClose(
    record: SessionRecord,
    connection: { client: AcpClient; owner?: RuntimeSessionOwner },
  ): Promise<void> {
    if (!connection.owner) {
      await withTimeout(connection.client.start(), this.options.timeoutMs);
    }
    if (!connection.client.supportsCloseSession()) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNSUPPORTED_CONTROL",
        `Agent does not support session/close for ${record.acpxRecordId}.`,
      );
    }
    await withTimeout(connection.client.closeSession(record.acpSessionId), this.options.timeoutMs);
  }

  private handleBackendSessionCloseError(record: SessionRecord, error: unknown): void {
    if (isAcpResourceNotFoundError(error)) {
      return;
    }
    if (isUnsupportedSessionCloseError(error)) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNSUPPORTED_CONTROL",
        `Agent does not support session/close for ${record.acpxRecordId}.`,
        { cause: error },
      );
    }
    throw error;
  }

  private async requireRecord(sessionId: string): Promise<SessionRecord> {
    const record = await this.options.sessionStore.load(sessionId);
    if (!record) {
      throw new Error(`ACP session not found: ${sessionId}`);
    }
    return record;
  }
}

function terminalPromptMessageId(turn: RunningRuntimeTurn, requestId: string): string {
  return turn.promptMessageId ?? requestId;
}

function terminalStartedAt(
  turn: RunningRuntimeTurn,
  existing: NonNullable<NonNullable<SessionRecord["acpx"]>["turn_results"]>[string] | undefined,
  completedAt: string,
): string {
  return existing?.started_at ?? turn.record.lastPromptAt ?? completedAt;
}

function assignTerminalDetails(
  snapshot: NonNullable<NonNullable<SessionRecord["acpx"]>["turn_results"]>[string],
  stopReason: string | undefined,
  errorCode: string | undefined,
): void {
  if (stopReason) {
    snapshot.stop_reason = stopReason;
  }
  if (errorCode) {
    snapshot.error_code = errorCode;
  }
}

function applyTerminalTurnSnapshot(
  turn: RunningRuntimeTurn,
  status: "completed" | "failed" | "cancelled",
  stopReason: string | undefined,
  errorCode: string | undefined,
  completedAt: string,
): void {
  const requestId = turn.record.lastRequestId;
  if (!requestId) {
    return;
  }
  const nextState = cloneSessionAcpxState(turn.acpxState) ?? {};
  const existing = nextState.turn_results?.[requestId];
  const snapshot: NonNullable<NonNullable<typeof nextState.turn_results>[string]> = {
    status,
    prompt_message_id: terminalPromptMessageId(turn, requestId),
    started_at: terminalStartedAt(turn, existing, completedAt),
    completed_at: completedAt,
  };
  assignTerminalDetails(snapshot, stopReason, errorCode);
  nextState.turn_results = { ...nextState.turn_results, [requestId]: snapshot };
  turn.acpxState = nextState;
}
