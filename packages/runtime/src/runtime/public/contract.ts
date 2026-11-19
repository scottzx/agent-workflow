import type { AcpAgentRegistry } from "../../agent-registry.js";
import type { AcpControlAuthority } from "../../async-control.js";
export type { AcpAgentRegistry } from "../../agent-registry.js";
import type {
  SetSessionConfigOptionResponse,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { AcpRuntimeConfigOption } from "../../acp/config-option-support.js";
import type {
  GrokAskUserAnswers,
  GrokAskUserQuestionRequest,
  GrokAskUserQuestionResponse,
} from "../../acp/grok-ask-user.js";
import type {
  GrokExitPlanModeRequest,
  GrokExitPlanModeResponse,
  GrokExitPlanOutcome,
} from "../../acp/grok-exit-plan.js";
import type { AcpRuntimeSessionModes } from "../../acp/mode-support.js";
import type { SessionWatchEvent } from "../../session/journal.js";
import type {
  AcpJsonRpcMessage,
  AcpMessageDirection,
  AcpElicitationHandler,
  AcpElicitationMode,
  AcpPermissionHandler,
  AcpProcessLifecycle,
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PermissionPolicy,
  SessionRecord,
  SafeError,
} from "../../types.js";
import type { SessionAgentOptions } from "../engine/session-options.js";

export type { SessionAgentOptions, SystemPromptOption } from "../engine/session-options.js";

export type {
  AcpJsonRpcMessage,
  AcpMessageDirection,
  AcpElicitationHandler,
  AcpElicitationMode,
  AcpElicitationContext,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpPermissionDecision,
  AcpPermissionHandler,
  AcpPermissionRequest,
  AcpProcessExit,
  AcpProcessLaunch,
  AcpProcessLaunchScope,
  AcpProcessLifecycle,
  AcpProcessSpawnFailure,
  AcpProcessStarted,
  PermissionPolicy,
} from "../../types.js";
export type {
  AcpRuntimeConfigOption,
  AcpRuntimeConfigOptionChoice,
} from "../../acp/config-option-support.js";
export type { AcpRuntimeSessionModeInfo, AcpRuntimeSessionModes } from "../../acp/mode-support.js";

/**
 * ACP has no mid-turn steering request. In-process runtimes admit a "steer"
 * turn like "prompt": it waits behind any active turn on the same session and
 * does not change that turn. Shared runtimes reject "steer".
 */
export type AcpRuntimePromptMode = "prompt" | "steer";

export type AcpRuntimeSessionMode = "persistent" | "oneshot";

export type AcpSessionUpdateTag =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "tool_call"
  | "tool_call_update"
  | "usage_update"
  | "available_commands_update"
  | "current_mode_update"
  | "config_option_update"
  | "session_info_update"
  | "plan"
  | (string & {});

export type AcpRuntimeControl =
  | "session/set_mode"
  | "session/set_model"
  | "session/set_config_option"
  | "session/status";

export type AcpRuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
};

export type AcpRuntimeEnsureInput = {
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  /**
   * Resume this exact ACP session. The in-process runtime keeps matching local
   * history and saved configuration, and later prompt/control reconnects refuse
   * replacement if this target cannot load. Same-record aliases cannot relax
   * this constraint. Adding the constraint requires an idle arrangement;
   * explicit lifecycle reset remains separate. Supply the
   * target again when attaching through another runtime instance.
   */
  resumeSessionId?: string;
  cwd?: string;
  /**
   * Per-session agent options applied when a fresh ACP session is created.
   * Threaded into `_meta.systemPrompt` (and `_meta.claudeCode.options.*`)
   * on the underlying `session/new` request, and persisted onto the new
   * record. Ignored when an existing persistent session is reused — system
   * prompts are fixed at `newSession` time, so changing them requires a
   * different sessionKey or prepareFreshSession on the prior record first.
   */
  sessionOptions?: SessionAgentOptions;
  /** Host-resolved argv. Never sourced from a persisted user profile. */
  agentArgv?: string[];
  /** Credentials for this process lifetime only; never persisted. */
  authCredentials?: Record<string, string>;
};

export type AcpRuntimeTurnAttachment = {
  /**
   * Media type for binary prompt attachments. The runtime currently maps
   * image/* and audio/* attachments to ACP prompt content blocks.
   */
  mediaType: string;
  data: string;
};

/**
 * In-process turns check synchronous host authority before prompt dispatch.
 * A throwing assertActive rejects admission without aborting the signal.
 */
export type AcpRuntimeTurnInput = AcpControlAuthority & {
  handle: AcpRuntimeHandle;
  text: string;
  attachments?: AcpRuntimeTurnAttachment[];
  mode: AcpRuntimePromptMode;
  requestId: string;
  timeoutMs?: number;
  /**
   * Overrides the client's default callback for this prompt turn. Throwing or
   * returning undefined falls through to configured permission policy, not the
   * default callback.
   */
  onPermissionRequest?: AcpPermissionHandler;
  /** Handles ACP elicitation requests owned by this prompt turn. */
  onElicitation?: AcpElicitationHandler;
};

/** Caller-owned snapshot; local mutations do not change runtime capabilities. */
export type AcpRuntimeCapabilities = {
  controls: AcpRuntimeControl[];
  configOptionKeys?: string[];
};

export type AcpRuntimeSessionModels = {
  currentModelId?: string;
  availableModelIds: string[];
  /** Native display names, when retained by the session snapshot. */
  availableModels?: Array<{ modelId: string; name: string }>;
};

/**
 * One session mode the agent advertised (ACP `SessionMode`). `name` is the
 * agent-facing display label; ids differ across agents (Claude Code:
 * default/acceptEdits/plan/..., Codex: read-only/agent/...), so consumers
 * must render data-driven rather than assume a fixed id set.
 */
/**
 * Cumulative session cost as reported by the agent. Mirrors ACP's
 * `Cost`, but both fields are optional here because not every adapter
 * populates them on every event.
 */
export type AcpRuntimeUsageCost = {
  amount?: number;
  currency?: string;
};

/**
 * Per-turn token breakdown. Sourced from final prompt response usage or
 * `UsageUpdate._meta.usage` on adapters that populate it. All fields optional —
 * consumers should treat missing fields as "unknown", not "zero".
 */
export type AcpRuntimeUsageBreakdown = {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
};

/**
 * A normalized ACP session config option (a `select` — model, reasoning
 * effort, etc.). `category` echoes the agent's grouping ("model" / "effort" /
 * "mode" / …) when present; the "mode" option is surfaced separately via
 * `modes`, so config-option consumers should skip it. Model option groups are
 * flattened into a single `options` list.
 */
export type AcpRuntimePlanEntryStatus = "pending" | "in_progress" | "completed";

/**
 * One entry of the agent's execution plan (ACP `PlanEntry`, emitted by
 * Claude Code's TodoWrite and Codex's plan updates). The agent re-sends the
 * FULL list on every update — consumers replace their plan wholesale, never
 * merge.
 */
export type AcpRuntimePlanEntry = {
  content: string;
  status: AcpRuntimePlanEntryStatus;
  priority?: "high" | "medium" | "low";
};

/**
 * Background task snapshot from Grok Build runtime (emitted as `background_task` event).
 * Treated as top-level panel in chat UI (similar to plan checklist).
 */
export type AcpRuntimeBackgroundTask = {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled" | "killed";
  command: string;
  duration?: string;
  exitCode?: number;
  output?: string;
};

/**
 * Agent-advertised slash command. The runtime only surfaces enough to
 * drive a picker UI ("does the agent advertise /compact?"). The full
 * `AvailableCommandInput` schema from ACP is intentionally not plumbed
 * through.
 */
export type AcpRuntimeAvailableCommand = {
  name: string;
  description?: string;
  /** True/false when ACP advertised whether this command has an input schema. */
  hasInput?: boolean;
};

/**
 * Session-level usage roll-up surfaced through `getStatus()`. The
 * reducer persists the breakdowns onto the session record; this type
 * exposes them on the runtime contract.
 */
export type AcpRuntimeSessionUsage = {
  cumulative?: AcpRuntimeUsageBreakdown;
  /** Cumulative session cost when the agent reported it. */
  cost?: AcpRuntimeUsageCost;
  /** Keyed by user-message id, matching the persisted reducer state. */
  perRequest?: Record<string, AcpRuntimeUsageBreakdown>;
};

export type AcpRuntimeStatus = {
  /** Whether the connected agent advertised ACP session fork support. */
  forkSupported?: boolean;
  /** Most recent host request id admitted for a prompt on this session. */
  lastRequestId?: string;
  summary?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
  models?: AcpRuntimeSessionModels;
  /**
   * Session modes the agent advertised, plus the current one. Parsed from
   * the persisted record's config options / current_mode_id; absent when
   * the agent never advertised a mode select (mode-less agents).
   */
  modes?: AcpRuntimeSessionModes;
  /**
   * Normalized session config options the agent advertised (model, reasoning
   * effort, …). The "mode" select is surfaced via `modes` instead and omitted
   * here. Absent when the agent advertised no non-mode config options.
   */
  configOptions?: AcpRuntimeConfigOption[];
  /** Token usage and cost from the persisted session record. */
  usage?: AcpRuntimeSessionUsage;
  /**
   * Commands the agent advertised via `available_commands_update`.
   * Sourced from the persisted record — older session files only
   * preserve `name`, so `description` and `hasInput` may be undefined
   * even when a more recent live event would have carried both.
   */
  availableCommands?: AcpRuntimeAvailableCommand[];
  details?: Record<string, unknown>;
};

export type AcpRuntimeDoctorReport = {
  ok: boolean;
  code?: string;
  message: string;
  installCommand?: string;
  details?: string[];
};

/**
 * Fail-closed origin metadata on `text_delta` events.
 * Only these optional string fields are preserved from ACP wire `_meta`.
 */
export type AcpTextDeltaOriginMeta = {
  origin?: string;
  kind?: string;
  source?: string;
};

export type AcpRuntimeEvent =
  | {
      type: "text_delta";
      text: string;
      stream?: "output" | "thought";
      tag?: AcpSessionUpdateTag;
      /**
       * The adapter's per-turn id (grok's `_meta.promptId`). Main-agent and
       * subagent turns carry different ids, so consumers can isolate
       * subagent text from the main feed.
       */
      agentTurnId?: string;
      /**
       * Present when the originating ACP session update carried a non-empty
       * `messageId`. Absent when the wire payload had no id.
       * Opaque producer-supplied routing hint only: ACPX does not authenticate
       * this value. Do not treat it as proof of authorship or as an
       * authorization boundary. Useful for correlating chunks from the same
       * producer message when the adapter includes an id.
       */
      messageId?: string;
      /**
       * Recognized assistant-message phase from ACP update `_meta.codex.phase`.
       * Omitted for absent or unknown values. This producer-supplied hint lets
       * consumers separate progress commentary from the final answer without
       * discarding either from the event stream; it is not an authorization
       * or authenticated provenance boundary.
       */
      messagePhase?: "commentary" | "final_answer";
      /**
       * Allowlisted origin fields from the ACP update `_meta`.
       * Only the documented string keys `origin`, `kind`, and `source` are
       * preserved. All other keys (including nested objects and secret-like
       * producer-controlled names) are dropped. Omitted when none remain.
       * These values are opaque producer-supplied routing hints, not
       * authenticated authorship or provenance. Consumers must not use them
       * as an authorization boundary.
       */
      meta?: AcpTextDeltaOriginMeta;
    }
  | {
      type: "status";
      text: string;
      tag?: AcpSessionUpdateTag;
      used?: number;
      size?: number;
      /** Populated on `usage_update` events when the agent reported a cost. */
      cost?: AcpRuntimeUsageCost;
      /**
       * Populated on `usage_update` events when the agent attached a
       * per-turn breakdown via `_meta.usage` (Claude Code does this; not
       * every adapter does).
       */
      breakdown?: AcpRuntimeUsageBreakdown;
      /**
       * Populated on `available_commands_update` events. The list is a
       * normalized view of the wire payload — names, descriptions, and
       * a `hasInput` flag derived from whether the agent advertised a
       * non-null `input` schema.
       */
      availableCommands?: AcpRuntimeAvailableCommand[];
      /**
       * Populated on `current_mode_update` events: the mode the agent
       * switched to (e.g. plan → default after ExitPlanMode). Consumers
       * that mirror mode state should treat this as authoritative.
       */
      currentModeId?: string;
      /**
       * Normalized entries on `plan` events; malformed entries are skipped.
       * Replace the displayed plan when present, including clearing it for [].
       */
      entries?: AcpRuntimePlanEntry[];
      /** Compatibility alias for entries */
      planEntries?: AcpRuntimePlanEntry[];
    }
  | {
      type: "background_task";
      tasks?: AcpRuntimeBackgroundTask[];
    }
  | {
      type: "tool_call";
      text: string;
      tag?: AcpSessionUpdateTag;
      toolCallId?: string;
      status?: string;
      title?: string;
      kind?: ToolKind;
      locations?: ToolCallLocation[];
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: ToolCallContent[];
      toolName?: string;
      /**
       * The adapter's per-turn id (grok's `_meta.promptId`). Subagent tool
       * calls carry the subagent turn's id, letting consumers fold them into
       * the subagent's card instead of the main assistant message.
       */
      agentTurnId?: string;
    }
  /**
   * Compatibility terminal event emitted by runTurn(...). startTurn(...).events
   * does not emit terminal events; use AcpRuntimeTurn.result instead.
   */
  | {
      type: "done";
      stopReason?: string;
      _meta?: Record<string, unknown> | null;
    }
  /**
   * Compatibility failure event emitted by runTurn(...). startTurn(...).events
   * does not emit terminal events; use AcpRuntimeTurn.result instead.
   */
  | ({ type: "error" } & AcpRuntimeTurnResultError);

export type AcpRuntimeTurnResultError = Pick<SafeError, "message"> &
  Partial<Omit<SafeError, "message">>;

export type AcpRuntimeTurnResult =
  | {
      status: "completed";
      stopReason?: string;
      finalAnswer?: string;
      promptMessageId?: string;
      runtimeRequestId?: string;
      _meta?: Record<string, unknown> | null;
    }
  | {
      status: "cancelled";
      stopReason?: string;
      finalAnswer?: string;
      promptMessageId?: string;
      runtimeRequestId?: string;
      _meta?: Record<string, unknown> | null;
    }
  | {
      status: "failed";
      error: AcpRuntimeTurnResultError;
      promptMessageId?: string;
      runtimeRequestId?: string;
    };

export interface AcpRuntimeTurn {
  readonly requestId: string;
  /** Resolves after the underlying writable transport accepts the prompt request. */
  readonly promptStarted: Promise<void>;
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  /**
   * Canonical completion signal for the turn. Resolves only after final record
   * checkpoint/persistence and runtime client pooling or close cleanup attempts
   * have settled.
   */
  readonly result: Promise<AcpRuntimeTurnResult>;
  cancel(input?: { reason?: string }): Promise<void>;
  closeStream(input?: { reason?: string }): Promise<void>;
}

export interface AcpRuntime {
  /** Passively replays and follows recorded turns when the backend supports a shared journal. */
  watchSession?(input: {
    handle: AcpRuntimeHandle;
    cursor?: string;
    signal?: AbortSignal;
  }): AsyncIterable<SessionWatchEvent>;
  /** Stops owned connections and joins admitted work; stored sessions remain resumable. */
  shutdown?(): Promise<void>;
  /** Finds a persistent session handle without starting or reconnecting an agent. */
  findSession?(input: { sessionKey: string; agent: string }): Promise<AcpRuntimeHandle | undefined>;
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  /**
   * Rebind a persistent runtime session to its final host-owned session key.
   * Intended for sessions created under a temporary pre-warm key before the
   * host session id exists.
   */
  adoptSession?(input: { handle: AcpRuntimeHandle; sessionKey: string }): Promise<AcpRuntimeHandle>;
  logoutSession?(input: { handle: AcpRuntimeHandle }): Promise<void>;
  authenticateSession?(input: {
    handle: AcpRuntimeHandle;
    methodId: string;
    credentials?: Record<string, string>;
  }): Promise<void>;
  forkSession?(input: {
    handle: AcpRuntimeHandle;
    cwd?: string;
  }): Promise<{ sessionId: string; agentSessionId?: string }>;
  deleteSession?(input: { handle: AcpRuntimeHandle; sessionId: string }): Promise<void>;
  startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn;
  /**
   * Compatibility adapter for consumers that expect terminal status in the
   * event stream. Prefer startTurn(...), which separates live events from the
   * terminal result.
   */
  runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;
  getCapabilities?(input: {
    handle?: AcpRuntimeHandle;
  }): Promise<AcpRuntimeCapabilities> | AcpRuntimeCapabilities;
  getStatus?(input: { handle: AcpRuntimeHandle; signal?: AbortSignal }): Promise<AcpRuntimeStatus>;
  /** Authority gates dispatch; an issued control still settles its response and saved state. */
  setMode?(input: AcpControlAuthority & { handle: AcpRuntimeHandle; mode: string }): Promise<void>;
  setModel?(
    input: AcpControlAuthority & { handle: AcpRuntimeHandle; model: string },
  ): Promise<void>;
  setConfigOption?(
    input: AcpControlAuthority & {
      handle: AcpRuntimeHandle;
      key: string;
      value: string;
    },
  ): Promise<SetSessionConfigOptionResponse | void>;
  doctor?(): Promise<AcpRuntimeDoctorReport>;
  cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void>;
  /** Locally closes the session and persists fresh creation on the next ensure without resumeSessionId. */
  prepareFreshSession?(input: { handle: AcpRuntimeHandle }): Promise<void>;
  close(input: {
    handle: AcpRuntimeHandle;
    reason: string;
    discardPersistentState?: boolean;
  }): Promise<void>;
}

export type AcpSessionRecord = SessionRecord;

export interface AcpSessionStore {
  load(sessionId: string): Promise<AcpSessionRecord | undefined>;
  save(record: AcpSessionRecord): Promise<void>;
  /**
   * Persist `record` under its new acpxRecordId without overwriting an
   * existing target, then remove the source record.
   */
  rebind?(sourceSessionId: string, record: AcpSessionRecord): Promise<void>;
}

export type AcpRuntimeSessionContext = {
  sessionKey: string;
  cwd: string;
  agentCommand: string;
  agentArgv?: string[];
};

export type AcpRuntimeSessionPermissions = Partial<
  Pick<
    AcpRuntimeOptions,
    "permissionMode" | "nonInteractivePermissions" | "permissionPolicy" | "onPermissionRequest"
  >
>;

export type AcpRuntimeOptions = {
  cwd: string;
  /** Trusted child-only environment, snapshotted at construction and never persisted. */
  agentProcessEnv?: Record<string, string>;
  /**
   * Opt-in allowlist for agent children, command probes and ACP terminals: when set, they
   * inherit only process essentials, these parent names and `ACPX_AUTH_*` grants.
   * Snapshotted at construction. Explicit grants and overlays still apply.
   */
  agentProcessEnvAllow?: readonly string[];
  /**
   * Parent environment names withheld from agent children, command probes and ACP
   * terminals, applied after `agentProcessEnvAllow` and snapshotted at construction.
   * Explicit grants and overlays still apply.
   */
  agentProcessEnvBlock?: readonly string[];
  sessionStore: AcpSessionStore;
  agentRegistry: AcpAgentRegistry;
  /**
   * Servers for new and reconnected session clients. A resolver runs at connection
   * creation with the session's stored identity; its result is never persisted.
   * Retained connections keep their original servers. Initialization-only health
   * probes do not call the resolver.
   */
  mcpServers?: McpServer[] | ((session: AcpRuntimeSessionContext) => McpServer[]);
  /**
   * Client permissions for new and reconnected sessions, resolved from stored
   * identity. Unspecified fields inherit runtime defaults. Retained clients keep
   * their original policy; health probes do not call this resolver. Neither the
   * policy nor its callback is persisted.
   */
  sessionPermissions?: (
    session: AcpRuntimeSessionContext,
  ) => AcpRuntimeSessionPermissions | undefined;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  timeoutMs?: number;
  probeAgent?: string;
  verbose?: boolean;
  /** ACP elicitation modes the embedding host can render for prompt turns. */
  elicitationModes?: readonly AcpElicitationMode[];
  /**
   * Best-effort wire observation for owned session clients, including setup and
   * reconnects. Elicitation payloads and suppressed replay updates are omitted.
   * Outbound observations precede transport writes; they are not delivery receipts.
   * Callback failures are ignored. Treat observed messages as read-only.
   */
  onAcpMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  /** Optional lifecycle observer for ACP agent processes owned by this runtime. */
  processLifecycle?: AcpProcessLifecycle;
  onPermissionRequest?: AcpPermissionHandler;
  /**
   * Host-driven handler for Grok Build's `_x.ai/ask_user_question` extension.
   * Used by bridge-server to surface the questionnaire over WebSocket.
   */
  onAskUserQuestion?: (
    req: GrokAskUserQuestionRequest,
    ctx: { signal: AbortSignal },
  ) => Promise<GrokAskUserQuestionResponse | GrokAskUserAnswers | undefined>;
  /**
   * Host-driven handler for Grok Build's `_x.ai/exit_plan_mode` extension.
   * Used by bridge-server to surface plan approval over WebSocket.
   */
  onExitPlanMode?: (
    req: GrokExitPlanModeRequest,
    ctx: { signal: AbortSignal },
  ) => Promise<GrokExitPlanModeResponse | GrokExitPlanOutcome | undefined>;
  /**
   * Fired after an OUT-OF-TURN session notification (one received while no
   * runtime turn is active) has been folded into the persisted record. Lets a
   * host refresh history or capabilities without waiting for the next
   * turn/reconnect.
   * `sessionKey` is the ensureSession key (the persistent record id).
   * `update` carries the full session/update payload when the host needs the
   * data itself (e.g. live background-task snapshots), not just the tag.
   */
  onOutOfTurnSessionUpdate?: (
    sessionKey: string,
    updateTag: AcpSessionUpdateTag,
    update?: Record<string, unknown>,
  ) => void;
  /**
   * ACP filesystem callback capability for new and reconnected session clients.
   * Omitted defaults to enabled, matching `AcpClientOptions`. Retained clients
   * keep their original capability. Health probes disable filesystem callbacks
   * and ignore this option. Disabling is a protocol callback policy, not an OS
   * sandbox for the agent's own filesystem access. The setting is not persisted.
   */
  fs?: boolean;
  /**
   * ACP terminal callback capability for new and reconnected session clients.
   * Omitted defaults to enabled, matching `AcpClientOptions`. Retained clients
   * keep their original capability. Health probes disable terminal callbacks
   * and ignore this option. Disabling is a protocol callback policy, not an OS
   * sandbox for the agent's own process access. The setting is not persisted.
   */
  terminal?: boolean;
};

export type AcpFileSessionStoreOptions = {
  stateDir: string;
};
