// Procedure abort signalling, kept pure so it can be unit-tested.
//
// Why a marker instead of instanceof (hardware, 2026-09-14, job 885cb85b5f32):
// a 60-station surface scan was stopped with stop_gcode_job; the runner's
// abort path tested `err instanceof ProcedureAbort`, the test was FALSE for the
// ProcedureStopped that checkProcedureStop() had thrown, the partial result
// (52 measured stations) was never attached, and the job surfaced the raw stop
// message with `result: null`. Subclassing Error under a down-levelled build
// loses the prototype chain, so instanceof cannot be trusted across the app.
// Every abort now carries a marker property and the runners test THAT.

export class ProcedureAbort extends Error {
    /** Partial result (completed stations / ops) so an abort never loses what was measured. */
    public partial?: object;

    /** Marker for isProcedureAbort(): survives a lost prototype chain. */
    public readonly procedureAbort: true = true;

    public procedureStopped = false;

    public constructor(message: string, partial?: object) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = 'ProcedureAbort';
        this.partial = partial;
    }
}

/** Thrown at the first step boundary after requestProcedureStop(): a graceful, operator/agent-initiated stop. */
export class ProcedureStopped extends ProcedureAbort {
    public constructor(message: string, partial?: object) {
        super(message, partial);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = 'ProcedureStopped';
        this.procedureStopped = true;
    }
}

export function isProcedureAbort(err: unknown): err is ProcedureAbort {
    return !!err && typeof err === 'object' && (err as { procedureAbort?: unknown }).procedureAbort === true;
}

export function isProcedureStopped(err: unknown): err is ProcedureStopped {
    return isProcedureAbort(err) && (err as { procedureStopped?: unknown }).procedureStopped === true;
}
