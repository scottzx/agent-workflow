/** RFC 4180 style parser: quoted fields, doubled quotes, CRLF. Stops after maxRows to keep huge files cheap. */
export function parseDelimited(source: string, delimiter = ',', maxRows = 2000): { rows: string[][]; truncated: boolean } {
    const rows: string[][] = [];
    let row: string[] = [], field = '', quoted = false;
    const endRow = () => { row.push(field); field = ''; rows.push(row); row = []; };
    for (let i = 0; i < source.length; i++) {
        const ch = source[i]!;
        if (quoted) {
            if (ch === '"') {
                if (source[i + 1] === '"') { field += '"'; i++; } else quoted = false;
            } else field += ch;
        } else if (ch === '"' && field === '') quoted = true;
        else if (ch === delimiter) { row.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && source[i + 1] === '\n') i++;
            endRow();
            if (rows.length >= maxRows) return { rows, truncated: i < source.length - 1 };
        } else field += ch;
    }
    if (field !== '' || row.length) endRow();
    return { rows, truncated: false };
}
