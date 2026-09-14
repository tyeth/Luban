// Why a job ended, as a structured record on the job (operator request
// 2026-09-14: a stopped run must keep its results AND say why it stopped -
// finished, stopped by the agent, door/pause, alarm, failure in operation).
// Pure: unit-tested in tests/jobEnding.test.ts.

export type JobEndingKind =
    | 'completed'
    | 'stopped-by-agent'
    | 'stopped-by-operator'
    | 'withdrawn'
    | 'rejected-by-operator'
    | 'crash-alarm'
    | 'overtravel-alarm'
    | 'unexpected-contact'
    | 'controller-rejected'
    | 'timeout'
    | 'operation-failure'
    | 'machine-stopped'
    | 'completion-unverified';

export interface JobEnding {
    kind: JobEndingKind;
    /** Human-readable cause, e.g. the abort message or "operator rejected on the confirm page". */
    reason: string;
    at: number;
    /** Set for procedures: how many stations / contacts / ops were measured before the end. */
    measured?: number;
    /** The sensor channel that tripped an alarm. */
    channel?: string;
}

export interface ProcedureEndingInput {
    message: string;
    /** Reason of a pending stop request (requestProcedureStop), or null. */
    stopReason: string | null;
    /** A latched safety trip, or null. */
    trip: { kind: 'overtravel' | 'crash'; channel?: string } | null;
    at: number;
    measured?: number;
}

/** Classify how a procedure ended from its abort message and the guard state. */
export function classifyProcedureEnding(input: ProcedureEndingInput): JobEnding {
    const base = { reason: input.message, at: input.at, measured: input.measured };
    if (input.trip) {
        return { ...base, kind: input.trip.kind === 'crash' ? 'crash-alarm' : 'overtravel-alarm', channel: input.trip.channel };
    }
    if (input.stopReason) {
        const byAgent = /agent/i.test(input.stopReason);
        return { ...base, kind: byAgent ? 'stopped-by-agent' : 'stopped-by-operator', reason: `${input.stopReason}: ${input.message}` };
    }
    if (/UNEXPECTED CONTACT/i.test(input.message)) {
        return { ...base, kind: 'unexpected-contact' };
    }
    if (/controller rejected/i.test(input.message)) {
        return { ...base, kind: 'controller-rejected' };
    }
    if (/timed out|not confirmed within/i.test(input.message)) {
        return { ...base, kind: 'timeout' };
    }
    return { ...base, kind: 'operation-failure' };
}

/** Count what a partial/complete procedure result measured, for the ending record. */
export function countMeasured(result: unknown): number | undefined {
    if (!result || typeof result !== 'object') {
        return undefined;
    }
    const r = result as { stations?: unknown; results?: unknown; ops?: unknown; contacts?: unknown };
    const list = [r.stations, r.results, r.ops, r.contacts].find((v) => Array.isArray(v)) as unknown[] | undefined;
    if (!list) {
        return undefined;
    }
    return list.filter((item) => {
        if (!item || typeof item !== 'object') {
            return false;
        }
        const it = item as { status?: unknown; z?: unknown; contactMachine?: unknown };
        if (it.status !== undefined) {
            return it.status === 'contact' || it.status === 'completed' || it.status === 'ok';
        }
        return it.z !== undefined || it.contactMachine !== undefined;
    }).length;
}
