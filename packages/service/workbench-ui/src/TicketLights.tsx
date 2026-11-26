import type { AcpTicketSummary } from './types';
import { text } from './ui';

/** Three lights for the list and the mobile card: self-check, program check, QA disagreements. */
export function TicketLights({ summary }: { summary?: AcpTicketSummary }) {
    if (!summary) return null;
    const selfWait = summary.selfCheckTotal > 0 && summary.selfCheckDone < summary.selfCheckTotal;
    const qaBad = summary.mismatches > 0;
    return (
        <span class="acp-ticket-lights" title={text('自检 / 机检 / QA', 'Self / program / QA')}>
            <span class="acp-nums">R{summary.round}</span>
            <span class={selfWait ? 'is-wait' : 'is-ok'}>
                {text('自检', 'Self')} <span class="acp-nums">{summary.selfCheckDone}/{summary.selfCheckTotal}</span>
            </span>
            <span class={summary.openMust > 0 ? 'is-bad' : 'is-ok'}>
                {summary.openMust > 0
                    ? text(`机检 ${summary.openMust}`, `Checks ${summary.openMust}`)
                    : text('机检', 'Checks')}
            </span>
            <span class={qaBad ? 'is-warn' : 'is-ok'}>
                {qaBad ? text(`QA ${summary.mismatches}`, `QA ${summary.mismatches}`) : 'QA'}
            </span>
        </span>
    );
}
