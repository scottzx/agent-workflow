/**
 * Pure workbench logic: hash routing, the approvals filter/empty state, the RSI fallback copy and the ticket
 * lights. None of it needs a DOM, so the same functions the page imports stay checkable in node.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalsEmptyText, filterApprovalQueue, sortApprovalQueue, type ApprovalQueueEntry } from '../workbench-ui/src/approvals-queue.js';
import { hashForModule, moduleFromHash, modules } from '../workbench-ui/src/routing.js';
import { roleRsiNotice } from '../workbench-ui/src/rsi-notice.js';
import { ticketLights } from '../workbench-ui/src/ticket-lights.js';

interface QueueItem extends ApprovalQueueEntry {
    id: string;
}

const queue: QueueItem[] = [
    { id: 'proposal-1', kind: 'proposal', channel: 'formal', createdAt: '2026-11-26T04:00:00.000Z' },
    { id: 'proposal-2', kind: 'proposal', channel: 'trial', createdAt: '2026-11-26T05:00:00.000Z' },
    { id: 'review-1', kind: 'review', channel: 'formal', createdAt: '2026-11-26T03:00:00.000Z' },
];
const now = Date.parse('2026-11-26T06:00:00.000Z');

test('a module hash names its tab, including detail and drawer hashes', () => {
    assert.equal(moduleFromHash('#acp/approvals'), 'approvals');
    assert.equal(moduleFromHash('#acp/cases'), 'cases');
    assert.equal(moduleFromHash('#acp/tasks'), 'tasks');
    assert.equal(moduleFromHash('#acp/agents'), 'agents');
    // A task or case detail belongs to its module: opening one must not change the pressed tab.
    assert.equal(moduleFromHash('#acp/tasks/job-1?mode=drawer'), 'tasks');
    assert.equal(moduleFromHash('#acp/tasks/job-1?review=rev-1'), 'tasks');
    assert.equal(moduleFromHash('#acp/cases/case-1?origin=session-1'), 'cases');
    // Unknown, empty and look-alike hashes keep the current tab instead of guessing.
    assert.equal(moduleFromHash(''), undefined);
    assert.equal(moduleFromHash('#'), undefined);
    assert.equal(moduleFromHash('#acp/approvals-old'), undefined);
    assert.equal(moduleFromHash('#other/approvals'), undefined);
});

test('every module round-trips through the hash a tab click writes', () => {
    for (const module of modules) {
        const hash = hashForModule(module);
        assert.equal(hash, `#acp/${module}`);
        assert.equal(moduleFromHash(hash), module);
    }
});

test('the approval queue filters by kind and channel before it decides what to show', () => {
    assert.deepEqual(filterApprovalQueue(queue, 'process_request', 'all', now), []);
    assert.deepEqual(
        filterApprovalQueue(queue, 'all', 'trial', now).map(item => item.id),
        ['proposal-2']
    );
    // Process requests lead, then the longest wait.
    const withRequest: QueueItem[] = [
        ...queue,
        { id: 'request-1', kind: 'process_request', channel: 'formal', createdAt: '2026-11-26T05:30:00.000Z' },
    ];
    assert.deepEqual(
        sortApprovalQueue(withRequest, now).map(item => item.id),
        ['request-1', 'review-1', 'proposal-1', 'proposal-2']
    );
});

test('an empty filtered queue keeps the filter bar and says so instead of going blank', () => {
    const filtered = filterApprovalQueue(queue, 'process_request', 'all', now);
    assert.equal(filtered.length, 0);
    const filteredText = approvalsEmptyText(queue.length, 'zh-CN');
    assert.match(filteredText, /当前筛选/);
    assert.match(filteredText, /没有待审批的事项/);
    // A genuinely empty inbox uses the plain wording; the English page gets its own strings.
    assert.match(approvalsEmptyText(0, 'zh-CN'), /^没有待审批的事项。$/);
    assert.match(approvalsEmptyText(3, 'en'), /No approvals match this filter/);
    assert.match(approvalsEmptyText(0, 'en'), /Nothing is waiting for a decision/);
});

test('a role the project never registered reads as an empty state, never as the backend error', () => {
    const missing = roleRsiNotice(404, 'not_found', 'ppt-maker');
    assert.equal(missing.kind, 'missing-role');
    assert.match(missing.title, /还没有 RSI 标准/);
    assert.match(missing.description, /ppt-maker/);
    assert.match(missing.description, /\.1agents\/roles\//);
    assert.doesNotMatch(`${missing.title}${missing.description}`, /Role not found|not_found|404/);

    // A role id the route cannot use as one path segment is called out separately.
    const invalid = roleRsiNotice(400, 'invalid_role', 'a:b');
    assert.equal(invalid.kind, 'invalid-role');
    assert.match(invalid.description, /a:b/);

    // Everything else is a temporary read failure with a retry, not a red raw message.
    const unavailable = roleRsiNotice(503, undefined, 'ppt-maker');
    assert.equal(unavailable.kind, 'unavailable');
    assert.doesNotMatch(`${unavailable.title}${unavailable.description}`, /503|Role not found/);

    assert.match(roleRsiNotice(404, undefined, 'ppt-maker', 'en').title, /no RSI standard/i);
    assert.match(roleRsiNotice(undefined, undefined, 'ppt-maker', 'en').title, /unavailable/i);
});

test('ticket lights show a placeholder for counts the ledger never recorded', () => {
    const unrecorded = ticketLights({ round: 2, selfCheckDone: 0, selfCheckTotal: 0, openMust: 0, openProposals: 0, mismatches: 0 });
    assert.equal(unrecorded.round, 'R2');
    assert.equal(unrecorded.self, '自检 —');
    assert.equal(unrecorded.selfState, 'unknown');
    assert.equal(unrecorded.program, '机检 0');
    assert.equal(unrecorded.programState, 'ok');
    assert.equal(unrecorded.qa, 'QA 0');
    assert.equal(unrecorded.qaState, 'ok');

    const absent = ticketLights({});
    assert.equal(absent.round, 'R—');
    assert.equal(absent.selfState, 'unknown');
    assert.equal(absent.program, '机检 —');
    assert.equal(absent.qa, 'QA —');

    const running = ticketLights({ round: 3, selfCheckDone: 2, selfCheckTotal: 4, openMust: 1, mismatches: 2 });
    assert.equal(running.self, '2/4');
    assert.equal(running.selfState, 'wait');
    assert.equal(running.programState, 'bad');
    assert.equal(running.qaState, 'warn');
    assert.equal(ticketLights({ round: 1, selfCheckDone: 2, selfCheckTotal: 2 }).selfState, 'ok');
});
