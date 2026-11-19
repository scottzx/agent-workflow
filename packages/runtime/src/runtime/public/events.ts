import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import type {
  AcpRuntimeAvailableCommand,
  AcpRuntimeBackgroundTask,
  AcpRuntimeEvent,
  AcpRuntimePlanEntry,
  AcpRuntimeUsageBreakdown,
  AcpRuntimeUsageCost,
  AcpSessionUpdateTag,
  AcpTextDeltaOriginMeta,
} from "./contract.js";
import { asOptionalString, asString, asTrimmedString, isRecord } from "./shared.js";

const TOOL_OUTPUT_SUMMARY_MAX_CHARS = 500;

function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveStatusTextForTag(params: {
  tag: AcpSessionUpdateTag;
  payload: Record<string, unknown>;
}): string | null {
  const resolver = STATUS_TEXT_RESOLVERS[params.tag];
  return resolver ? resolver(params.payload) : null;
}

type StatusTextResolver = (payload: Record<string, unknown>) => string | null;

const STATUS_TEXT_RESOLVERS: Partial<Record<AcpSessionUpdateTag, StatusTextResolver>> = {
  available_commands_update: availableCommandsStatusText,
  current_mode_update: currentModeStatusText,
  config_option_update: configOptionStatusText,
  session_info_update: sessionInfoStatusText,
  plan: planStatusText,
  background_task: backgroundTaskStatusText,
};

function availableCommandsStatusText(payload: Record<string, unknown>): string {
  const commands = Array.isArray(payload.availableCommands) ? payload.availableCommands : [];
  return commands.length > 0
    ? `available commands updated (${commands.length})`
    : "available commands updated";
}

function currentModeStatusText(payload: Record<string, unknown>): string {
  const mode =
    asTrimmedString(payload.currentModeId) ||
    asTrimmedString(payload.modeId) ||
    asTrimmedString(payload.mode);
  return mode ? `mode updated: ${mode}` : "mode updated";
}

function configOptionStatusText(payload: Record<string, unknown>): string {
  const id = asTrimmedString(payload.id) || asTrimmedString(payload.configOptionId);
  const value =
    asTrimmedString(payload.currentValue) ||
    asTrimmedString(payload.value) ||
    asTrimmedString(payload.optionValue);
  if (id && value) {
    return `config updated: ${id}=${value}`;
  }
  return id ? `config updated: ${id}` : "config updated";
}

function sessionInfoStatusText(payload: Record<string, unknown>): string {
  return asTrimmedString(payload.summary) || asTrimmedString(payload.message) || "session updated";
}

function planStatusText(payload: Record<string, unknown>): string | null {
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const first = entries.find((entry) => isRecord(entry));
  const content = asTrimmedString(first?.content);
  return content ? `plan: ${content}` : null;
}

function backgroundTaskStatusText(payload: Record<string, unknown>): string | null {
  const tasks = Array.isArray(payload.tasks) ? payload.tasks.filter(isRecord) : [];
  const running = tasks.filter((t) => t.status === "running").length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const failed = tasks.filter(
    (t) => t.status === "failed" || t.status === "cancelled" || t.status === "killed",
  ).length;
  const total = tasks.length;
  if (total === 0) {
    return null;
  }
  return `background tasks: ${completed}/${total} (${running} running, ${failed} failed)`;
}

function isPlanEntryStatus(value: string): value is AcpRuntimePlanEntry["status"] {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function isPlanEntryPriority(value: string): value is NonNullable<AcpRuntimePlanEntry["priority"]> {
  return value === "high" || value === "medium" || value === "low";
}

function planUpdateEvent(payload: Record<string, unknown>): AcpRuntimeEvent | null {
  const raw = payload.entries;
  const entries = normalizePlanEntries(raw);
  if (Array.isArray(raw) && raw.length === 0) {
    // An explicit empty snapshot clears the host's previous plan.
    return { type: "status", text: "plan updated", tag: "plan", entries: [] };
  }
  // Preserve legacy summaries, including entries without a valid status.
  const text =
    planStatusText(payload) ?? (entries.length > 0 ? `plan: ${entries[0]?.content}` : null);
  if (!text) {
    return null;
  }
  return {
    type: "status",
    text,
    tag: "plan",
    ...(entries.length > 0 ? { entries } : {}),
  };
}

function normalizePlanEntries(value: unknown): AcpRuntimePlanEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: AcpRuntimePlanEntry[] = [];
  for (const entry of value) {
    const normalized = normalizePlanEntry(entry);
    if (normalized) {
      entries.push(normalized);
    }
  }
  return entries;
}

function normalizePlanEntry(value: unknown): AcpRuntimePlanEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const content = asTrimmedString(value.content);
  const status = asTrimmedString(value.status);
  if (!content || !isPlanEntryStatus(status)) {
    return undefined;
  }
  const priority = asTrimmedString(value.priority);
  return {
    content,
    status,
    ...(isPlanEntryPriority(priority) ? { priority } : {}),
  };
}

/**
 * Documented allowlist for text_delta.meta origin fields.
 * Only these keys may be copied from ACP update `_meta`.
 * Unknown keys (including secret-like producer-controlled names) are dropped.
 */
const ORIGIN_META_KEYS = [
  "origin",
  "kind",
  "source",
] as const satisfies readonly (keyof AcpTextDeltaOriginMeta)[];

/**
 * Preserve a fail-closed subset of ACP update origin fields for text_delta
 * consumers. Empty or unusable values are omitted rather than inferred.
 */
function extractTextDeltaOrigin(payload: Record<string, unknown>): {
  messageId?: string;
  messagePhase?: "commentary" | "final_answer";
  meta?: AcpTextDeltaOriginMeta;
} {
  const messageId = asOptionalString(payload.messageId);
  const phase =
    isRecord(payload._meta) && isRecord(payload._meta.codex)
      ? payload._meta.codex.phase
      : undefined;
  const meta = sanitizeOriginMeta(payload._meta);
  return {
    ...(messageId ? { messageId } : {}),
    ...(phase === "commentary" || phase === "final_answer" ? { messagePhase: phase } : {}),
    ...(meta ? { meta } : {}),
  };
}

/**
 * Copy only allowlisted string origin keys from wire `_meta`.
 * Nested objects, arrays, non-strings, and unknown keys are dropped.
 */
function sanitizeOriginMeta(value: unknown): AcpTextDeltaOriginMeta | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: AcpTextDeltaOriginMeta = {};
  for (const key of ORIGIN_META_KEYS) {
    const entry = value[key];
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    out[key] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function resolveTextChunk(params: {
  payload: Record<string, unknown>;
  stream: "output" | "thought";
  tag: AcpSessionUpdateTag;
  meta?: Record<string, unknown>;
}): AcpRuntimeEvent | null {
  const origin = extractTextDeltaOrigin(params.payload);
  const contentRaw = params.payload.content;
  if (isRecord(contentRaw)) {
    const contentType = asTrimmedString(contentRaw.type);
    if (contentType && contentType !== "text") {
      return null;
    }
    const text = asString(contentRaw.text);
    if (text && text.length > 0) {
      return {
        type: "text_delta",
        text,
        stream: params.stream,
        tag: params.tag,
        ...readAgentTurnId(params.meta),
        ...origin,
      };
    }
  }
  const text = asString(params.payload.text);
  if (!text || text.length === 0) {
    return null;
  }
  return {
    type: "text_delta",
    text,
    stream: params.stream,
    tag: params.tag,
    ...readAgentTurnId(params.meta),
    ...origin,
  };
}

// grok stamps the outer `_meta.promptId` on every chunk; each ACP prompt
// (main agent turn, each spawned subagent turn) gets its own id, so this is
// the boundary marker the frontend needs to isolate subagent content.
function readAgentTurnId(meta: Record<string, unknown> | undefined): {
  agentTurnId?: string;
} {
  const promptId = asOptionalString(meta?.promptId);
  return promptId && promptId.length > 0 ? { agentTurnId: promptId } : {};
}

function readFirstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = asOptionalString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readFirstStringArray(
  record: Record<string, unknown>,
  keys: readonly string[],
): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const entries = value
      .map((entry) => asOptionalString(entry))
      .filter((entry): entry is string => entry !== undefined);
    if (entries.length > 0) {
      return entries;
    }
  }
  return undefined;
}

function summarizeToolInput(rawInput: unknown): string | undefined {
  if (rawInput == null) {
    return undefined;
  }
  if (
    typeof rawInput === "string" ||
    typeof rawInput === "number" ||
    typeof rawInput === "boolean"
  ) {
    return String(rawInput);
  }
  if (!isRecord(rawInput)) {
    return undefined;
  }

  const command = readFirstString(rawInput, ["command", "cmd", "program"]);
  const args = readFirstStringArray(rawInput, ["args", "arguments"]);
  if (command) {
    return [command, ...(args ?? [])].join(" ");
  }

  return readFirstString(rawInput, [
    "path",
    "file",
    "filePath",
    "filepath",
    "target",
    "uri",
    "url",
    "query",
    "pattern",
    "text",
    "search",
  ]);
}

function truncateToolSummary(value: string): string {
  if (value.length <= TOOL_OUTPUT_SUMMARY_MAX_CHARS) {
    return value;
  }
  return `${value.slice(0, TOOL_OUTPUT_SUMMARY_MAX_CHARS - 1)}…`;
}

function readToolContentText(value: unknown): string | undefined {
  const record = isRecord(value) ? value : undefined;
  if (!record) {
    return undefined;
  }
  if (record.type === "content") {
    return readToolContentText(record.content);
  }
  const reader = toolContentTextReader(String(record.type));
  return reader?.(record);
}

type ToolContentTextReader = (record: Record<string, unknown>) => string | undefined;

const TOOL_CONTENT_TEXT_READERS: Record<string, ToolContentTextReader> = {
  text: (record) => asString(record.text),
  audio: (record) => `[audio] ${asOptionalString(record.mimeType) || "audio"}`,
  resource_link: (record) =>
    asOptionalString(record.title) || asOptionalString(record.name) || asOptionalString(record.uri),
  resource: (record) => {
    const resource = isRecord(record.resource) ? record.resource : undefined;
    return asString(resource?.text) || asOptionalString(resource?.uri);
  },
  diff: (record) => `diff ${asOptionalString(record.path) || "file"}`,
  terminal: (record) => {
    const terminalId = asOptionalString(record.terminalId) || asOptionalString(record.id);
    return terminalId ? `[terminal] ${terminalId}` : "[terminal]";
  },
};

function toolContentTextReader(type: string): ToolContentTextReader | undefined {
  return Object.hasOwn(TOOL_CONTENT_TEXT_READERS, type)
    ? TOOL_CONTENT_TEXT_READERS[type]
    : undefined;
}

function summarizeToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const fragments = content
    .map((entry) => readToolContentText(entry)?.trim())
    .filter((entry): entry is string => Boolean(entry));
  if (fragments.length === 0) {
    return undefined;
  }
  return truncateToolSummary([...new Set(fragments)].join("\n"));
}

function summarizeToolOutput(rawOutput: unknown): string | undefined {
  if (rawOutput == null) {
    return undefined;
  }
  if (isScalarToolOutput(rawOutput)) {
    return truncateToolSummary(String(rawOutput));
  }
  const record = isRecord(rawOutput) ? rawOutput : undefined;
  if (!record) {
    return undefined;
  }
  return (
    truncateToolSummary(
      readFirstString(record, ["text", "message", "error", "stdout", "stderr", "content"]) ?? "",
    ) || undefined
  );
}

function isScalarToolOutput(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function readToolKind(value: unknown): ToolKind | undefined {
  const kind = asOptionalString(value);
  return kind && TOOL_KINDS.has(kind) ? (kind as ToolKind) : undefined;
}

const TOOL_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "fetch",
  "think",
  "switch_mode",
  "other",
]);

function readClaudeCodeToolName(meta: unknown): string | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }
  const claudeCode = meta.claudeCode;
  if (!isRecord(claudeCode)) {
    return undefined;
  }
  const nameVal = claudeCode.toolName;
  if (typeof nameVal !== "string") {
    return undefined;
  }
  const trimmed = nameVal.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Some claude-code finalization paths (e.g. a permission-denied tool_call
// update) carry the id under `_meta.claudeCode.toolCallId` instead of (or
// in addition to) the top-level field. Mirror `readClaudeCodeToolName` so
// the wire event surfaces the same id the conversation model persisted.
function readClaudeCodeToolCallId(meta: unknown): string | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }
  const claudeCode = meta.claudeCode;
  if (!isRecord(claudeCode)) {
    return undefined;
  }
  const idVal = claudeCode.toolCallId;
  if (typeof idVal !== "string") {
    return undefined;
  }
  const trimmed = idVal.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function selectToolCallDetailSummary(params: {
  tag: AcpSessionUpdateTag;
  inputSummary: string | undefined;
  outputSummary: string | undefined;
}): string | undefined {
  return params.tag === "tool_call_update"
    ? (params.outputSummary ?? params.inputSummary)
    : (params.inputSummary ?? params.outputSummary);
}

function createToolCallEvent(params: {
  payload: Record<string, unknown>;
  tag: AcpSessionUpdateTag;
  meta?: Record<string, unknown>;
}): AcpRuntimeEvent {
  const title = asTrimmedString(params.payload.title) || "tool call";
  const status = asTrimmedString(params.payload.status);
  const inputSummary = summarizeToolInput(params.payload.rawInput);
  const outputSummary =
    summarizeToolContent(params.payload.content) ?? summarizeToolOutput(params.payload.rawOutput);
  const toolCallId =
    asOptionalString(params.payload.toolCallId) ?? readClaudeCodeToolCallId(params.payload._meta);
  const kind = readToolKind(params.payload.kind);
  const summaryText = status ? `${title} (${status})` : title;
  const detailSummary = selectToolCallDetailSummary({
    tag: params.tag,
    inputSummary,
    outputSummary,
  });
  const toolName = readClaudeCodeToolName(params.payload._meta);

  const event: AcpRuntimeEvent = {
    type: "tool_call",
    text: detailSummary ? `${summaryText}: ${detailSummary}` : summaryText,
    tag: params.tag,
    title,
    ...readAgentTurnId(params.meta),
  };
  assignToolCallEventMetadata(event, params.payload, { toolCallId, status, kind, toolName });
  return event;
}

function assignToolCallEventMetadata(
  event: AcpRuntimeEvent,
  payload: Record<string, unknown>,
  values: { toolCallId?: string; status?: string; kind?: ToolKind; toolName?: string },
): void {
  if (event.type !== "tool_call") {
    return;
  }
  // Always carry the id through when the agent sent one, even an empty
  // string — the conversation model keys off `update.toolCallId` without
  // any truthiness gate, so dropping it here would desync the wire event
  // from the persisted record. An empty string still indicates a known
  // (if degenerate) id; only `undefined` (no id at all) is left unset.
  if (typeof values.toolCallId === "string") {
    event.toolCallId = values.toolCallId;
  }
  if (values.status) {
    event.status = values.status;
  }
  if (values.kind) {
    event.kind = values.kind;
  }
  if (values.toolName) {
    event.toolName = values.toolName;
  }
  assignForwardedToolPayload(event, payload);
}

function assignForwardedToolPayload(
  event: Extract<AcpRuntimeEvent, { type: "tool_call" }>,
  payload: Record<string, unknown>,
): void {
  // Tool payloads remain detached JSON snapshots, including omission of undefined fields.
  const snapshot = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  if (Array.isArray(snapshot.locations)) {
    event.locations = snapshot.locations as ToolCallLocation[];
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "rawInput")) {
    event.rawInput = snapshot.rawInput;
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "rawOutput")) {
    event.rawOutput = snapshot.rawOutput;
  }
  if (Array.isArray(snapshot.content)) {
    event.content = snapshot.content as ToolCallContent[];
  }
}

export function runtimeEventFromMessage(message: unknown): AcpRuntimeEvent | null {
  if (!isRecord(message)) {
    return null;
  }
  if (asTrimmedString(message.method) !== "session/update") {
    return message.type === "client_operation" ? clientOperationEvent(message) : null;
  }
  // grok stamps per-turn markers (`promptId` / `turnStartMs`) on the outer
  // `_meta`, which the inner update payload never sees. Pass it through so
  // text/tool parsers can surface `agentTurnId` alongside the payload.
  const params = message.params;
  if (!isRecord(params) || !isRecord(params.update)) {
    return null;
  }
  const payload = params.update;
  const meta = isRecord(params._meta) ? params._meta : undefined;
  const parser = promptEventParser(asTrimmedString(payload.sessionUpdate));
  return parser ? parser(payload, meta) : null;
}

type PromptEventParser = (
  payload: Record<string, unknown>,
  meta?: Record<string, unknown>,
) => AcpRuntimeEvent | null;

const PROMPT_EVENT_PARSERS: Record<string, PromptEventParser> = {
  tool_call: (payload, meta) => createToolCallEvent({ payload, tag: "tool_call", meta }),
  tool_call_update: (payload, meta) =>
    createToolCallEvent({ payload, tag: "tool_call_update", meta }),
  agent_message_chunk: (payload, meta) =>
    resolveTextChunk({ payload, stream: "output", tag: "agent_message_chunk", meta }),
  agent_thought_chunk: (payload, meta) =>
    resolveTextChunk({ payload, stream: "thought", tag: "agent_thought_chunk", meta }),
  usage_update: usageUpdateEvent,
  available_commands_update: availableCommandsUpdateEvent,
  current_mode_update: currentModeUpdateEvent,
  config_option_update: (payload) => statusUpdateEvent("config_option_update", payload),
  session_info_update: (payload) => statusUpdateEvent("session_info_update", payload),
  plan: planUpdateEvent,
  background_task: backgroundTaskUpdateEvent,
};

function promptEventParser(type: string): PromptEventParser | undefined {
  return Object.hasOwn(PROMPT_EVENT_PARSERS, type) ? PROMPT_EVENT_PARSERS[type] : undefined;
}

function usageUpdateEvent(payload: Record<string, unknown>): AcpRuntimeEvent {
  const used = asOptionalFiniteNumber(payload.used);
  const size = asOptionalFiniteNumber(payload.size);
  const meta = isRecord(payload._meta) ? payload._meta : undefined;
  return buildUsageUpdateEvent({
    used,
    size,
    cost: normalizeUsageCost(payload.cost),
    breakdown: normalizeUsageBreakdown(meta?.usage),
  });
}

function buildUsageUpdateEvent(parts: {
  used: number | undefined;
  size: number | undefined;
  cost: AcpRuntimeUsageCost | undefined;
  breakdown: AcpRuntimeUsageBreakdown | undefined;
}): AcpRuntimeEvent {
  const { used, size, cost, breakdown } = parts;
  const text = used != null && size != null ? `usage updated: ${used}/${size}` : "usage updated";
  return {
    type: "status",
    text,
    tag: "usage_update",
    ...(used != null ? { used } : {}),
    ...(size != null ? { size } : {}),
    ...(cost ? { cost } : {}),
    ...(breakdown ? { breakdown } : {}),
  };
}

// Structured variant of the generic status text: keeps `currentModeId` on the
// event so hosts can mirror live mode switches (e.g. ExitPlanMode → default)
// instead of parsing the display text. Falls back to the text-only status
// event when the payload carries no mode id.
function currentModeUpdateEvent(payload: Record<string, unknown>): AcpRuntimeEvent | null {
  // Same alias chain as currentModeStatusText so wire variants stay covered.
  const currentModeId =
    asTrimmedString(payload.currentModeId) ||
    asTrimmedString(payload.modeId) ||
    asTrimmedString(payload.mode);
  if (!currentModeId) {
    return statusUpdateEvent("current_mode_update", payload);
  }
  return {
    type: "status",
    text: `mode updated: ${currentModeId}`,
    tag: "current_mode_update",
    currentModeId,
  };
}

function backgroundTaskUpdateEvent(payload: Record<string, unknown>): AcpRuntimeEvent | null {
  const tasks = normalizeBackgroundTasks(payload.tasks);
  if (!tasks) {
    return statusUpdateEvent("background_task", payload);
  }
  return {
    type: "background_task",
    tasks,
  };
}

const BACKGROUND_TASK_STATUSES: ReadonlySet<AcpRuntimeBackgroundTask["status"]> = new Set([
  "running",
  "completed",
  "failed",
  "cancelled",
  "killed",
]);

function normalizeBackgroundTaskStatus(value: unknown): AcpRuntimeBackgroundTask["status"] {
  const raw = asTrimmedString(value) as AcpRuntimeBackgroundTask["status"];
  return BACKGROUND_TASK_STATUSES.has(raw) ? raw : "running";
}

function normalizeBackgroundTask(entry: unknown): AcpRuntimeBackgroundTask | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const id = asOptionalString(entry.id);
  const command = asOptionalString(entry.command);
  if (!id || !command) {
    return undefined;
  }
  const duration = asOptionalString(entry.duration);
  const output = asOptionalString(entry.output);
  const exitCode = typeof entry.exitCode === "number" ? entry.exitCode : undefined;
  return {
    id,
    status: normalizeBackgroundTaskStatus(entry.status),
    command,
    ...(duration ? { duration } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(output ? { output } : {}),
  };
}

function normalizeBackgroundTasks(value: unknown): AcpRuntimeBackgroundTask[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tasks: AcpRuntimeBackgroundTask[] = [];
  for (const entry of value) {
    const normalized = normalizeBackgroundTask(entry);
    if (normalized) {
      tasks.push(normalized);
    }
  }
  return tasks.length > 0 ? tasks : undefined;
}

function availableCommandsUpdateEvent(payload: Record<string, unknown>): AcpRuntimeEvent | null {
  const raw = Array.isArray(payload.availableCommands) ? payload.availableCommands : [];
  const availableCommands: AcpRuntimeAvailableCommand[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = asTrimmedString(entry.name);
    if (!name) {
      continue;
    }
    const description = asTrimmedString(entry.description);
    availableCommands.push({
      name,
      ...(description ? { description } : {}),
      hasInput: entry.input != null,
    });
  }
  const text =
    availableCommands.length > 0
      ? `available commands updated (${availableCommands.length})`
      : "available commands updated";
  return {
    type: "status",
    text,
    tag: "available_commands_update",
    availableCommands,
  };
}

function normalizeUsageCost(value: unknown): AcpRuntimeUsageCost | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const amount = asOptionalFiniteNumber(value.amount);
  const currency = asTrimmedString(value.currency);
  if (amount == null && !currency) {
    return undefined;
  }
  return {
    ...(amount != null ? { amount } : {}),
    ...(currency ? { currency } : {}),
  };
}

const USAGE_BREAKDOWN_FIELDS: ReadonlyArray<readonly [keyof AcpRuntimeUsageBreakdown, string[]]> = [
  ["inputTokens", ["inputTokens", "input_tokens"]],
  ["outputTokens", ["outputTokens", "output_tokens"]],
  ["cachedReadTokens", ["cachedReadTokens", "cacheReadInputTokens", "cache_read_input_tokens"]],
  [
    "cachedWriteTokens",
    ["cachedWriteTokens", "cacheCreationInputTokens", "cache_creation_input_tokens"],
  ],
  ["thoughtTokens", ["thoughtTokens", "thought_tokens"]],
  ["totalTokens", ["totalTokens", "total_tokens"]],
];

function normalizeUsageBreakdown(value: unknown): AcpRuntimeUsageBreakdown | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const breakdown: AcpRuntimeUsageBreakdown = {};
  for (const [key, aliases] of USAGE_BREAKDOWN_FIELDS) {
    const v = firstFiniteNumber(value, aliases);
    if (v != null) {
      breakdown[key] = v;
    }
  }
  return Object.keys(breakdown).length > 0 ? breakdown : undefined;
}

function firstFiniteNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = asOptionalFiniteNumber(record[key]);
    if (value != null) {
      return value;
    }
  }
  return undefined;
}

function statusUpdateEvent(
  tag: AcpSessionUpdateTag,
  payload: Record<string, unknown>,
): AcpRuntimeEvent | null {
  const text = resolveStatusTextForTag({ tag, payload });
  if (!text) {
    return null;
  }
  return { type: "status", text, tag };
}

function clientOperationEvent(payload: Record<string, unknown>): AcpRuntimeEvent {
  const method = asTrimmedString(payload.method) || "operation";
  const status = asTrimmedString(payload.status);
  const summary = asTrimmedString(payload.summary);
  return { type: "status", text: [method, status, summary].filter(Boolean).join(" ") };
}
