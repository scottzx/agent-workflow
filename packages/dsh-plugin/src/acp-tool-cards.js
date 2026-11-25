/** Draw remote ACP Tool calls inside the host's own Assistant row. */
import { Fragment, createElement as h } from 'react';
import { toolBlock } from './acp-tools.js';
import { ACP_TOOL_KEY } from './acp-tool-definition.js';

/**
 * The host's child slots reach their own content through these factories. The
 * native Assistant row owns both children; a plugin may not declare them a
 * second time, so the row draws them through the same factories the host uses.
 */
const assistantContentFactories = {
  'conversation.chat.reasoning.body': 'conversation.chat.reasoning.content',
  'conversation.chat.message.images': 'conversation.images.content',
};

/**
 * The native Assistant row, with its child slots reached through their factories.
 * @param {any} native - the host's Assistant row registration.
 * @param {any} props - the props of this occurrence.
 * @returns {any} the rendered row.
 */
function renderNative(native, props) {
  return h(native.component, {
    ...props,
    renderSlot: (key, owner) => props.renderFactorySlot(assistantContentFactories[key] ?? key, owner),
  });
}

/**
 * One remote call drawn with a host Tool row, or with the plugin's own row
 * when the host has no view for that kind of work.
 * @param {any} ctx - the client context.
 * @param {any} block - the host Tool block of one remote call.
 * @param {any} props - the props of the owning Assistant row.
 * @returns {any} the rendered row.
 */
function renderTool(ctx, block, props) {
  const name = block.call?.name ?? block.name ?? '';
  const entries = ctx.slots.entries('tool.call.toolview');
  // An entry that owns child slots needs the host's own seat; an atomic row
  // is complete on its own and can be drawn here.
  const entry = [...entries].reverse().find(candidate => candidate.options.key === name && !candidate.children);
  if (entry === undefined) return h(GenericToolRow, { block });
  return h(entry.component, {
    ...props,
    key: block.callId,
    callId: block.callId,
    toolName: name,
    phase: block.kind ? 'result' : 'start',
    block,
    home: ctx.remote.$host?.home,
    inspect: undefined,
    t: ctx.locale.bind('conversation'),
  });
}

/**
 * The plugin's own row for a remote call no host Tool view claims.
 * @param {{ block: any }} props - the remote call.
 * @returns {any} the rendered row.
 */
function GenericToolRow({ block }) {
  const name = block.call?.name ?? block.name ?? 'Tool';
  const summary = typeof block.call?.argsRaw === 'string' && block.call.argsRaw !== '{}' ? block.call.argsRaw : '';
  return h('div', {
    'data-oneagents-acp-tool': '',
    style: { display: 'flex', gap: '8px', alignItems: 'baseline', margin: '4px 0', fontSize: '13px', opacity: block.isError ? 1 : 0.85 },
  },
  h('span', { style: { fontWeight: 600 } }, name),
  summary === '' ? null : h('span', { style: { opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, summary));
}

/**
 * The host's blocks and the remote calls of one Step, in the order the Agent
 * produced them. The remote calls carry the index of the empty block that
 * recorded them, so they land between the prose around them.
 * @param {readonly any[]} blocks - the host's Assistant blocks.
 * @param {readonly any[]} observations - the Step's remote observations.
 * @returns {any[]} the ordered parts.
 */
function interleave(blocks, observations) {
  const byIndex = new Map(observations.map(observation => [observation.index, observation]));
  const parts = [];
  const placed = new Set();
  for (let index = 0; index < blocks.length; index++) {
    const observation = byIndex.get(index);
    if (observation !== undefined) {
      parts.push({ kind: 'tool', observation });
      placed.add(index);
      continue;
    }
    const block = blocks[index];
    if (block === undefined) continue;
    // The empty text blocks that recorded a remote call, and the terminal
    // answer record, carry no prose of their own.
    if (block.kind === 'text' && block.text.trim() === '') continue;
    parts.push({ kind: 'block', block });
  }
  for (const observation of observations) {
    if (!placed.has(observation.index)) parts.push({ kind: 'tool', observation });
  }
  return parts;
}

/**
 * The row each part belongs to. The host splits one Assistant row into its
 * reasoning row and its reply row; a remote call belongs to the row of the
 * prose it followed, so the order the Agent produced stays the order shown.
 * @param {any[]} parts - the ordered parts.
 * @returns {string[]} the row of each part.
 */
function assignRows(parts) {
  const rows = new Array(parts.length).fill(null);
  let current = null;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.kind === 'block') {
      current = part.block.kind === 'reasoning' ? 'reasoning' : 'response';
      rows[index] = current;
      continue;
    }
    rows[index] = current;
  }
  let following = null;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part.kind === 'block') {
      following = part.block.kind === 'reasoning' ? 'reasoning' : 'response';
      continue;
    }
    if (rows[index] === null) rows[index] = following ?? 'response';
  }
  return rows;
}

/**
 * The Assistant row with the remote Tool calls of its Step drawn in place.
 * @param {any} props - the props of the Assistant row.
 * @returns {any} the rendered row.
 */
function AcpAssistant({ ctx, native, ...props }) {
  const turnData = props.useTurnData?.(ACP_TOOL_KEY);
  const step = String(props.node?.data?.step ?? '');
  const observations = turnData?.steps?.find(entry => entry.step === step)?.tools ?? [];
  if (observations.length === 0) return renderNative(native, props);
  const parts = interleave(props.node?.data?.blocks ?? [], observations);
  const rows = assignRows(parts);
  const groupPart = props.groupPart;
  const segments = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (groupPart !== undefined && rows[index] !== groupPart) continue;
    if (part.kind === 'tool') {
      segments.push({ kind: 'tool', observation: part.observation });
      continue;
    }
    const last = segments.at(-1);
    if (last?.kind === 'blocks' && last.row === rows[index]) last.blocks.push(part.block);
    else segments.push({ kind: 'blocks', row: rows[index], blocks: [part.block] });
  }
  return h(Fragment, null, segments.map((segment, index) => {
    if (segment.kind === 'tool') {
      const block = toolBlock(segment.observation, { closed: turnData?.closed });
      return h(Fragment, { key: segment.observation.data.tool.toolCallId ?? index },
        renderTool(ctx, block, props));
    }
    const node = { ...props.node, data: { ...props.node.data, blocks: segment.blocks } };
    return h(Fragment, { key: `blocks-${index}` }, renderNative(native, { ...props, node }));
  }));
}

/**
 * The row that owns the remote Tool calls of a Step whose own Assistant row
 * shows nothing.
 * @param {any} props - the props of the row.
 * @returns {any} the rendered rows.
 */
function AcpToolCards({ ctx, ...props }) {
  const tools = props.node?.data?.tools ?? [];
  if (tools.length === 0) return null;
  return h('div', { 'data-oneagents-acp-tools': '' },
    tools.map(block => h(Fragment, { key: block.callId }, renderTool(ctx, block, props))));
}

/**
 * Register the Assistant row that draws remote ACP Tool calls in place, and
 * the row that carries the calls of a Step with no prose of its own.
 * @param {any} ctx - the client context.
 */
export function installAcpToolCards(ctx) {
  ctx.slots.inject('conversation.chat.node', () => {
    const native = [...ctx.slots.entries('conversation.chat.node')].reverse()
      .find(entry => entry.options.key === 'assistant-step');
    if (!native) throw new Error('DSH native assistant renderer is unavailable');
    // A smaller priority wins the cell, so this row replaces the native one.
    const disposeAssistant = ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'assistant-step',
      priority: (native.options.priority ?? 0) - 1,
      locale: native.locale,
      inject: native.inject,
    }, props => h(AcpAssistant, { ctx, native, ...props }));
    const disposeCards = ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'acp-tool-calls',
    }, props => h(AcpToolCards, { ctx, ...props }));
    return () => {
      disposeAssistant();
      disposeCards();
    };
  });
}
