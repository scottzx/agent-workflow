/**
 * Approval queue ordering and the empty-state wording. Plain data in, plain data out: the filter bar and the
 * empty state must be verifiable without rendering the module.
 */
export type ApprovalKind = 'process_request' | 'review' | 'handoff' | 'proposal';

const KIND_ORDER: Record<ApprovalKind, number> = { process_request: 0, review: 1, handoff: 2, proposal: 3 };

/** What the queue needs from one approval: its kind, its channel and how long it has waited. */
export interface ApprovalQueueEntry {
    kind: ApprovalKind;
    channel?: string;
    createdAt: string;
}

export function waitingMs(item: ApprovalQueueEntry, now: number): number {
    const start = Date.parse(item.createdAt);
    return Number.isFinite(start) ? Math.max(0, now - start) : 0;
}

/** Process requests lead, then the longest wait. */
export function sortApprovalQueue<T extends ApprovalQueueEntry>(items: readonly T[], now: number): T[] {
    return [...items].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || waitingMs(b, now) - waitingMs(a, now));
}

export function filterApprovalQueue<T extends ApprovalQueueEntry>(
    items: readonly T[],
    kind: ApprovalKind | 'all',
    channel: 'all' | 'formal' | 'trial',
    now: number
): T[] {
    return sortApprovalQueue(
        items.filter(item => (kind === 'all' || item.kind === kind) && (channel === 'all' || item.channel === channel)),
        now
    );
}

/**
 * A filtered-to-zero queue is not the same as an empty inbox: say which one it is, and keep the filter bar
 * visible either way.
 */
export function approvalsEmptyText(totalItems: number, language = 'zh-CN'): string {
    if (totalItems > 0) {
        return language === 'zh-CN' ? '当前筛选没有待审批的事项。' : 'No approvals match this filter.';
    }
    return language === 'zh-CN' ? '没有待审批的事项。' : 'Nothing is waiting for a decision.';
}
