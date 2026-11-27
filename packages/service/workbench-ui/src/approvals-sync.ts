import type { AcpApprovalCounts, AcpApprovalItem } from './types';

const SEEN = '1agents:approvals-seen';

/** A row stays unread until this key is stored. The id already includes the job for proposals. */
export function approvalKey(item: Pick<AcpApprovalItem, 'id' | 'updatedAt' | 'createdAt'>): string {
    return `${item.id}:${item.updatedAt || item.createdAt}`;
}

export function readSeen(): Set<string> {
    try {
        const raw = localStorage.getItem(SEEN);
        const list = raw ? (JSON.parse(raw) as unknown) : [];
        return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []);
    } catch {
        return new Set();
    }
}

export function rememberSeen(key: string): void {
    const seen = readSeen();
    if (seen.has(key)) return;
    localStorage.setItem(SEEN, JSON.stringify([...seen, key].slice(-500)));
}

export function countUnread(items: readonly Pick<AcpApprovalItem, 'id' | 'updatedAt' | 'createdAt'>[]): number {
    const seen = readSeen();
    return items.filter(item => !seen.has(approvalKey(item))).length;
}

/** Tell the DSH sidebar the queue changed. A top-level page has no parent to notify. */
export function postApprovalsState(pendingCount: number, unreadCount: number, byKind: AcpApprovalCounts): void {
    if (window.parent === window) return;
    window.parent.postMessage({ type: '1agents:approvals-state', pendingCount, unreadCount, byKind }, location.origin);
}
