/**
 * The three ticket lights as labels and states. A ticket that never recorded self-check items must read as
 * “not recorded” (`—`), not as a green `0/0`; the projection omits fields the ledger has no counts for.
 */
export interface TicketSummaryLike {
    status?: string;
    round?: number;
    selfCheckDone?: number;
    selfCheckTotal?: number;
    openMust?: number;
    openProposals?: number;
    mismatches?: number;
}

export type TicketLightState = 'ok' | 'wait' | 'bad' | 'warn' | 'unknown';

export interface TicketLightView {
    round: string;
    self: string;
    selfState: TicketLightState;
    program: string;
    programState: TicketLightState;
    qa: string;
    qaState: TicketLightState;
}

const known = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

export function ticketLights(summary: TicketSummaryLike, language = 'zh-CN'): TicketLightView {
    const chinese = language === 'zh-CN';
    const missing = '—';
    const selfCheckLabel = chinese ? '自检' : 'Self';
    const programLabel = chinese ? '机检' : 'Checks';
    const total = summary.selfCheckTotal;
    const done = summary.selfCheckDone;
    const selfRecorded = known(total) && total > 0;
    return {
        round: known(summary.round) ? `R${summary.round}` : `R${missing}`,
        self: selfRecorded ? `${known(done) ? done : 0}/${total}` : `${selfCheckLabel} ${missing}`,
        selfState: selfRecorded ? (known(done) && done < total ? 'wait' : 'ok') : 'unknown',
        program: known(summary.openMust) ? `${programLabel} ${summary.openMust}` : `${programLabel} ${missing}`,
        programState: known(summary.openMust) ? (summary.openMust > 0 ? 'bad' : 'ok') : 'unknown',
        qa: known(summary.mismatches) ? `QA ${summary.mismatches}` : `QA ${missing}`,
        qaState: known(summary.mismatches) ? (summary.mismatches > 0 ? 'warn' : 'ok') : 'unknown',
    };
}
