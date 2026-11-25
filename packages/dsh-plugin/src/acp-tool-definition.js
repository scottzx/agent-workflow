/** The conversation Definition that publishes remote ACP Tool calls. */
import { foldObservations, toolBlock } from './acp-tools.js';

const ASSISTANT_EVENTS = new Set(['assistant/live-chunk', 'assistant/message', 'assistant/attempt']);

/** The key this Definition owns in the Turn's Location data. */
export const ACP_TOOL_KEY = 'oneagents-acp-tools';

/**
 * The Location of one Definition Context.
 * @param {any} context - the assembled Context.
 * @returns {any} the resolved Location.
 */
function locationOf(context) {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' };
}

/**
 * The closing boundary of the Turn that owns a Context.
 * @param {any} location - the resolved Location.
 * @returns {{ time: number } | undefined} the boundary, when the Turn already closed.
 */
function closedBoundary(location) {
  if (location.kind === 'turn' && location.turn.status === 'closed') {
    return { time: location.turn.end?.time ?? location.turn.start?.time ?? 0 };
  }
  if (location.kind === 'step' && location.step.status === 'closed') {
    return { time: location.step.end?.time ?? location.step.start?.time ?? 0 };
  }
  return undefined;
}

/**
 * The render position of one Step's remote cards. The Step's own start keeps
 * the cards ahead of that Step's Assistant row, the way a native Tool row
 * precedes the reply it produced.
 * @param {any} context - the assembled Context.
 * @param {any} location - the resolved Location.
 * @returns {number} the anchor seq.
 */
function anchorOf(context, location) {
  if (location.kind === 'step' && location.step.start !== undefined) return location.step.start.seq;
  if (location.kind === 'turn' && location.turn.start !== undefined) return location.turn.start.seq;
  return context.matches[0]?.event.seq ?? 0;
}

/**
 * The folded state rebuilt from the remaining matches when the start is gone.
 * @param {any} context - the assembled Context.
 * @returns {any} the folded state.
 */
function fallbackState(context) {
  let state;
  for (const match of context.matches) state = foldObservations(state, match.event);
  return state;
}

/**
 * The Steps of one Turn that recorded remote calls, ordered by their first call.
 * @param {any} state - the folded state.
 * @returns {{ step: string; tools: any[]; visible: boolean }[]} the Steps with remote calls.
 */
function stepsOf(state) {
  const steps = [];
  for (const [step, value] of state.steps) {
    if (value.tools.size === 0) continue;
    steps.push({
      step,
      visible: value.visible,
      tools: [...value.tools.values()].sort((left, right) => left.index - right.index),
    });
  }
  return steps;
}

/**
 * Remote ACP Tool calls, folded from the Assistant stream of a Turn and
 * published to the host's chat target as ordinary Tool rows.
 */
export const acpToolDefinition = {
  kind: ACP_TOOL_KEY,
  target: 'chat',
  match: event => {
    if (!ASSISTANT_EVENTS.has(event.type)) return null;
    const turn = event.data?.turn;
    if (typeof turn !== 'number') return null;
    return { id: String(turn), role: 'start' };
  },
  start: (_context, match) => foldObservations(undefined, match.event),
  update: (context, match) => foldObservations(context.state, match.event),
  publication: match => (match.event.type === 'assistant/live-chunk' ? 'animation-frame' : 'immediate'),
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn') return null;
    const state = context.state ?? fallbackState(context);
    if (state === undefined) return null;
    const steps = stepsOf(state);
    if (steps.length === 0) return null;
    const closed = closedBoundary(locationOf(context));
    const value = { steps, ...(closed === undefined ? {} : { closed }) };
    const signature = JSON.stringify(value);
    if (previous?.value?.signature === signature) return previous;
    return { kind: 'turn', turn: state.turn, key: ACP_TOOL_KEY, value: { ...value, signature } };
  },
  buildViewNode: context => {
    const state = context.state ?? fallbackState(context);
    const current = context.current?.get('chat');
    if (state === undefined) return current == null ? null : { ...current, visibility: 'hidden' };
    // A Step whose own Assistant row shows nothing would hide its cards too,
    // so those Steps publish their own row instead.
    const hidden = stepsOf(state).filter(step => !step.visible);
    if (hidden.length === 0) {
      return current == null ? null : { ...current, visibility: 'hidden' };
    }
    const location = locationOf(context);
    const closed = closedBoundary(location);
    const tools = hidden.flatMap(step => step.tools.map(observation => toolBlock(observation, { closed })));
    const signature = JSON.stringify(tools);
    const data = current?.data?.signature === signature ? current.data : { tools, signature };
    return {
      key: context.key,
      kind: 'acp-tool-calls',
      id: context.id,
      target: 'chat',
      anchorSeq: anchorOf(context, location),
      location,
      visibility: 'visible',
      data,
    };
  },
};
