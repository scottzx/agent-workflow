import { text } from './ui';
import type { AcpTicketSummary } from './types';
import { ticketLights, type TicketLightState } from './ticket-lights';

const stateClass: Record<TicketLightState, string> = {
    ok: 'is-ok',
    wait: 'is-wait',
    bad: 'is-bad',
    warn: 'is-warn',
    unknown: 'is-unknown',
};

/** Three lights for the list and the mobile card: self-check, program check, QA disagreements. */
export function TicketLights({ summary }: { summary?: AcpTicketSummary }) {
    if (!summary) return null;
    const lights = ticketLights(summary);
    return (
        <span class="acp-ticket-lights" title={text('自检 / 机检 / QA', 'Self / program / QA')}>
            <span class="acp-nums">{lights.round}</span>
            <span class={stateClass[lights.selfState]}>{lights.self}</span>
            <span class={stateClass[lights.programState]}>{lights.program}</span>
            <span class={stateClass[lights.qaState]}>{lights.qa}</span>
        </span>
    );
}
