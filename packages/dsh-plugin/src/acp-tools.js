/** Remote ACP tool observations projected onto DSH's own Tool cards. */

/**
 * The host Tool view that draws each remote kind. The names are the host's
 * keyed `tool.call.toolview` entries, so a remote call reuses the row the
 * host already draws for the same kind of work.
 */
const TOOL_VIEWS = {
  execute: 'bash',
  read: 'read',
  edit: 'edit',
  write: 'write',
  search: 'grep',
  fetch: 'web_fetch',
};

/**
 * The host Tool name that draws this remote call.
 * @param {any} tool - the remote tool snapshot.
 * @returns {string} the host Tool name, or an empty string when no host view claims it.
 */
export function toolName(tool) {
  return TOOL_VIEWS[tool?.kind ?? ''] ?? '';
}

/**
 * The visible label of a remote call no host view claims.
 * @param {any} tool - the remote tool snapshot.
 * @returns {string} the Agent's own title, else its kind, else a generic name.
 */
export function toolLabel(tool) {
  const title = typeof tool?.title === 'string' ? tool.title.trim() : '';
  if (title !== '') return title;
  if (typeof tool?.name === 'string' && tool.name !== '' && tool.name !== 'Tool') return tool.name;
  return typeof tool?.kind === 'string' && tool.kind !== '' ? tool.kind : 'Tool';
}

/**
 * The remote arguments in the shape the host's Tool views read. The bridge
 * sends its own field names; the host's rows read the ordinary DSH ones.
 * @param {any} tool - the remote tool snapshot.
 * @returns {Record<string, unknown>} the arguments as a plain object.
 */
export function toolArguments(tool) {
  const input = tool?.rawInput;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return typeof input === 'string' ? { description: input } : {};
  }
  if (typeof input.CommandLine === 'string') {
    return {
      command: input.CommandLine,
      ...(typeof input.Cwd === 'string' ? { cwd: input.Cwd } : {}),
    };
  }
  if (typeof input.Path === 'string') {
    return {
      file_path: input.Path,
      ...(typeof input.Pattern === 'string' ? { pattern: input.Pattern } : {}),
      ...(typeof input.Content === 'string' ? { content: input.Content } : {}),
    };
  }
  if (typeof input.Url === 'string') return { url: input.Url };
  if (typeof input.Query === 'string') return { query: input.Query };
  return { ...input };
}

/**
 * A sealed argument view over one complete remote argument object. The host's
 * rows read arguments through this small surface; a remote call always has
 * its complete arguments, so the view never grows.
 * @param {Record<string, unknown>} values - the remote arguments.
 * @returns {object} the sealed argument view.
 */
export function sealedArguments(values) {
  const text = key => {
    const value = values[key];
    return typeof value === 'string' ? value : undefined;
  };
  return {
    isSealed: true,
    complete: key => Object.hasOwn(values, key) && values[key] !== undefined,
    text,
    textPrefix: (key, limit) => {
      const value = text(key);
      return value === undefined ? undefined : value.slice(0, Math.max(1, limit));
    },
    value: key => values[key],
    stringLength: key => {
      const value = text(key);
      return value === undefined ? undefined : value.length;
    },
  };
}

/**
 * The settled output of a remote call, in the host's content block shape.
 * @param {any} tool - the remote tool snapshot.
 * @returns {{ type: 'text'; text: string }[]} the result content blocks.
 */
export function toolContent(tool) {
  const content = Array.isArray(tool?.content) ? tool.content : [];
  const blocks = [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item;
    if (entry.type === 'content' && typeof entry.content === 'object' && entry.content !== null) {
      const inner = entry.content;
      if (inner.type === 'text' && typeof inner.text === 'string') blocks.push({ type: 'text', text: inner.text });
      continue;
    }
    if (entry.type === 'diff' && typeof entry.path === 'string') {
      blocks.push({
        type: 'text',
        text: `${entry.path}\n---\n${typeof entry.oldText === 'string' ? entry.oldText : ''}\n+++\n${typeof entry.newText === 'string' ? entry.newText : ''}`,
      });
    }
  }
  if (blocks.length > 0 || tool?.rawOutput === undefined || tool?.rawOutput === null) return blocks;
  const output = tool.rawOutput;
  return [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }];
}

/**
 * The chunk records of one Assistant event, in stream order.
 * @param {any} event - the Assistant event.
 * @returns {{ chunk: any; time: number }[]} the chunk records.
 */
function chunkRecords(event) {
  if (event.type === 'assistant/live-chunk') return [{ chunk: event.data?.chunk, time: event.time }];
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    const stream = event.data?.stream;
    const records = Array.isArray(stream) ? stream.filter(record => record?.type === 'chunk') : [];
    // The durable message carries its blocks twice: the streamed records and
    // the settled content. Both are read, so a message whose stream is
    // incomplete still reports the prose and the calls it settled.
    const content = event.data?.message?.content;
    if (Array.isArray(content)) {
      records.push(...content.map((block, index) => ({
        chunk: { type: 'block-end', index, block },
        time: event.time,
      })));
    }
    return records;
  }
  return [];
}

/**
 * Whether one chunk carries prose the host would show on its own.
 * @param {any} chunk - the stream chunk.
 * @returns {boolean} true when the chunk carries visible text or reasoning.
 */
function carriesProse(chunk) {
  if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') return chunk.text?.trim() !== '';
  if (chunk?.type !== 'block-end') return false;
  const block = chunk.block;
  if (block?.type !== 'text' && block?.type !== 'reasoning') return false;
  return typeof block.text === 'string' && block.text.trim() !== '';
}

/**
 * One Step's folded remote calls.
 * @typedef {{ tools: Map<string, any>, visible: boolean }} StepObservations
 */

/**
 * Fold one Assistant event into the remote calls of every Step of its Turn.
 * The durable message replaces the live prefix of its own Step, so a replayed
 * turn keeps one card per call.
 * @param {any} state - the folded state so far, or undefined for the first event.
 * @param {any} event - the Assistant event.
 * @returns {any} the next folded state.
 */
export function foldObservations(state, event) {
  const turn = event.data?.turn;
  const step = event.data?.step;
  const replay = event.type !== 'assistant/live-chunk';
  const steps = new Map(state?.steps ?? []);
  const key = String(step);
  const previous = steps.get(key);
  const tools = replay ? new Map() : new Map(previous?.tools ?? []);
  let visible = replay ? false : (previous?.visible ?? false);
  for (const { chunk, time } of chunkRecords(event)) {
    if (carriesProse(chunk)) visible = true;
    if (chunk?.type !== 'block-end') continue;
    const projection = chunk.block?.acpTool;
    if (typeof projection !== 'object' || projection === null) continue;
    const tool = projection.tool;
    const callId = tool?.toolCallId;
    if (typeof callId !== 'string' || callId === '') continue;
    const sequence = typeof projection.sequence === 'number' ? projection.sequence : 0;
    const seen = tools.get(callId);
    if (seen !== undefined && seen.data.sequence >= sequence) continue;
    tools.set(callId, {
      data: { ...projection, tool },
      index: seen?.index ?? (typeof chunk.index === 'number' ? chunk.index : 0),
      seq: seen?.seq ?? (typeof event.seq === 'number' ? event.seq : 0),
      time: seen?.time ?? time,
      updatedAt: time,
    });
  }
  steps.set(key, { tools, visible });
  return {
    turn: typeof turn === 'number' ? turn : (state?.turn ?? 0),
    steps,
  };
}

/**
 * The host Tool block for one remote observation. A settled call carries its
 * own result; an unfinished one closes as interrupted when its step ends.
 * @param {any} observation - the folded remote observation.
 * @param {{ closed?: { time: number } }} options - the step's closing boundary, when it already closed.
 * @returns {any} the host Tool block.
 */
export function toolBlock(observation, options = {}) {
  const { data, seq, time, updatedAt } = observation;
  const tool = data.tool;
  const name = toolName(tool) || toolLabel(tool);
  const args = toolArguments(tool);
  const argsRaw = JSON.stringify(args);
  const callId = `${data.requestId ?? ''}:${tool.toolCallId}`;
  const settled = tool.status === 'completed' || tool.status === 'failed';
  const head = { callId, name, argsRaw, args: sealedArguments(args), turn: data.turn, step: data.step, time, subCalls: [] };
  if (!settled && options.closed === undefined) return { ...head, phase: 'start' };
  return {
    kind: 'tool-result',
    seq,
    time: settled ? updatedAt : options.closed.time,
    callId,
    name,
    args: sealedArguments(args),
    call: { name, argsRaw },
    callTime: time,
    content: toolContent(tool),
    isError: tool.status === 'failed' || !settled,
    ...(settled ? {} : { error: { name: 'Interrupted', code: 'interrupted' } }),
    meta: { acp: tool },
    subCalls: [],
  };
}
