export type DiffLine = { type: 'ctx' | 'add' | 'del'; text: string };

/** Prefix/suffix-trimmed line diff; good for typical single-region edits without a diff library. */
export function lineDiff(oldText: string | undefined, newText: string, context = 3): DiffLine[] {
    const a = oldText === undefined || oldText === '' ? [] : oldText.split('\n');
    const b = newText.split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const head = a.slice(Math.max(0, start - context), start).map(text => ({ type: 'ctx' as const, text }));
    const tail = a.slice(endA, endA + context).map(text => ({ type: 'ctx' as const, text }));
    return [
        ...head,
        ...a.slice(start, endA).map(text => ({ type: 'del' as const, text })),
        ...b.slice(start, endB).map(text => ({ type: 'add' as const, text })),
        ...tail,
    ];
}
