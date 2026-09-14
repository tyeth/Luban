// Machine position of record: ONE judged machine-frame position with a
// reliability state, derived from the heartbeat by rules an agent can read
// back, so no consumer ever does `work - offset` on a single beat by hand.
//
// Why (operator law 2026-09-14): the HTTP channel sends a move as `G90` /
// `G53;` / `G1 ...` / `G54;` - four requests - and the 2 s status poll can
// land inside that window. Such a beat may carry machine coordinates with the
// offset still populated (subtracting produced Z 555 / Z 656), the offset
// zeroed, or no offset at all. getPositionSnapshot used to flag the result in
// a `warnings` string that no code read and return the bad number anyway, so
// a Z 555 artefact passed the traverse-height guard and every landmark
// clearance check. The Luban console printed its own unguarded copy of the
// subtraction - the ">500" line the operator complains about.
//
// The operator's rules, verbatim in effect:
//   - the machine sometimes reports work-origin-based coordinates; those beats
//     are to be IGNORED, never reinterpreted - the next coherent sync rectifies;
//   - any coordinate more than 50 mm outside machine bounds is a MISTAKE, a
//     bug and never a position;
//   - the controller's own echo of a commanded move (positionOfRecord) outranks
//     any beat.
//
// Pure module: no server imports, unit-tested in tests/machinePosition.test.ts.
import { AXES, Axis, NullableXyz, OffsetJudgement, Xyz, judgeOffsetReport, ZERO_OFFSET_ACCEPT_BEATS } from './positionOfRecord';

export type Reliability = 'verified' | 'heartbeat' | 'cached-offset' | 'awaiting-resync' | 'stale';
export type FrameJudgement = 'machine-frame' | 'work-frame' | 'undetermined';
export type RejectReason = 'out-of-bounds' | 'frame-flip' | 'no-offset-yet';

/** A derived machine coordinate this far outside the travel is a bug, not a position (operator, 2026-09-14). */
export const BOUNDS_MARGIN_MM = 50;

export interface MachineBounds {
    min: Xyz;
    max: Xyz;
}

export interface AcceptedPosition {
    machine: Xyz;
    reportedAt: number;
}

export interface BeatInput {
    /** Raw x/y/z fields of the status report. */
    raw: NullableXyz;
    /** offsetX/Y/Z as the report carried them (null = absent). */
    offsetReported: NullableXyz;
    /** Last complete offset believed on this connection. */
    cachedOffset: Xyz | null;
    /** Distinct consecutive quiet beats that reported an all-zero offset (positionOfRecord.judgeOffsetReport). */
    zeroStreak: number;
    /** Raw fields of the previous ACCEPTED beat, for the frame-flip signature. */
    previousRaw: Xyz | null;
    bounds: MachineBounds | null;
    reportedAt: number;
    now: number;
    staleMs: number;
    lastAccepted: AcceptedPosition | null;
    /** Controller-echo position of record still valid for the current gcode sequence, if any. */
    verified: Xyz | null;
}

export interface BeatJudgement {
    /** The judged machine position: derived when the beat is accepted, the last accepted position when it is not. */
    machine: NullableXyz;
    /** Beat timestamp the judged position comes from (the held position's own time when rejected). */
    machineReportedAt: number | null;
    frame: FrameJudgement;
    reliability: Reliability;
    accepted: boolean;
    rejectedReason: RejectReason | null;
    offset: OffsetJudgement;
    /** raw - offset, always, for diagnostics - NOT for motion. */
    derived: NullableXyz;
    /** Axes on which `derived` sits more than BOUNDS_MARGIN_MM outside the travel. */
    outsideAxes: Axis[];
    reasons: string[];
    /** What the caller should hold as lastAccepted after this beat. */
    nextAccepted: AcceptedPosition | null;
}

function complete(v: NullableXyz): v is Xyz {
    return v.x !== null && v.y !== null && v.z !== null;
}

/** Axes on which a machine coordinate lies more than `margin` outside [min, max]. */
export function outsideBounds(machine: NullableXyz, bounds: MachineBounds | null, margin: number = BOUNDS_MARGIN_MM): Axis[] {
    if (!bounds) {
        return [];
    }
    return AXES.filter((axis) => {
        const v = machine[axis];
        return v !== null && (v < bounds.min[axis] - margin || v > bounds.max[axis] + margin);
    });
}

/**
 * The frame-flip signature (moved here from diagnostics.ts): a report in the
 * other frame differs from the previous one by exactly the offset on every
 * axis the offset is non-zero on. No real move does that on all axes at once.
 */
export function isFrameFlip(raw: Xyz, previousRaw: Xyz, offset: Xyz, toleranceMm: number = 0.5): boolean {
    const axes = AXES.filter((axis) => Math.abs(offset[axis]) > toleranceMm);
    if (!axes.length) {
        return false;
    }
    const delta = { x: raw.x - previousRaw.x, y: raw.y - previousRaw.y, z: raw.z - previousRaw.z };
    return axes.every((axis) => Math.abs(delta[axis] + offset[axis]) <= toleranceMm)
        || axes.every((axis) => Math.abs(delta[axis] - offset[axis]) <= toleranceMm);
}

const NULLS: NullableXyz = { x: null, y: null, z: null };

/** Judge one status report. Pure. */
export function judgeBeat(input: BeatInput): BeatJudgement {
    const offset = judgeOffsetReport(input.offsetReported, input.cachedOffset, input.zeroStreak);
    const derived: NullableXyz = {
        x: input.raw.x === null ? null : input.raw.x - offset.offset.x,
        y: input.raw.y === null ? null : input.raw.y - offset.offset.y,
        z: input.raw.z === null ? null : input.raw.z - offset.offset.z,
    };
    const reasons: string[] = [];
    let rejectedReason: RejectReason | null = null;

    if (offset.source === 'assumed-zero') {
        rejectedReason = 'no-offset-yet';
        reasons.push('No work-origin offset has been reported on this connection yet; a machine position cannot be derived '
            + 'without assuming one, and nothing is assumed.');
    }
    if (!rejectedReason && complete(input.raw) && input.previousRaw && complete(input.offsetReported)
        && isFrameFlip(input.raw, input.previousRaw, input.offsetReported)) {
        rejectedReason = 'frame-flip';
        reasons.push(`Status report jumped by exactly the origin offset: raw (${input.raw.x}, ${input.raw.y}, ${input.raw.z}) after `
            + `(${input.previousRaw.x}, ${input.previousRaw.y}, ${input.previousRaw.z}) with offset (${input.offsetReported.x}, `
            + `${input.offsetReported.y}, ${input.offsetReported.z}) - a poll inside a G53 window, or the return from one. Ignored.`);
    }
    const outsideAxes = rejectedReason ? [] : outsideBounds(derived, input.bounds);
    if (!rejectedReason && outsideAxes.length) {
        rejectedReason = 'out-of-bounds';
        reasons.push(`Derived machine ${outsideAxes.join('/')} (${outsideAxes.map((a) => `${a}=${(derived[a] as number).toFixed(1)}`).join(', ')}) `
            + `is more than ${BOUNDS_MARGIN_MM} mm outside the travel - a mistake, not a position (the controller reported `
            + 'work-origin-based or workspace-less coordinates). Ignored; the next coherent report rectifies it.');
    }
    if (offset.transientZero) {
        reasons.push(`The report carried a zero work-origin offset while this connection has seen (${offset.offset.x}, `
            + `${offset.offset.y}, ${offset.offset.z}) - a G53-window transient; the last complete offset is used (a zero is `
            + `believed after ${ZERO_OFFSET_ACCEPT_BEATS} consecutive quiet beats).`);
    } else if (offset.source === 'cached') {
        reasons.push(`The report carried no work-origin offset; the last complete offset (${offset.offset.x}, ${offset.offset.y}, `
            + `${offset.offset.z}) is used. Re-read before trusting a position CHECK.`);
    }

    const stale = input.now - input.reportedAt > input.staleMs;
    const accepted = rejectedReason === null && complete(derived);

    let reliability: Reliability;
    let machine: NullableXyz;
    let machineReportedAt: number | null;
    let frame: FrameJudgement;

    if (input.verified) {
        machine = { ...input.verified };
        machineReportedAt = input.reportedAt;
        frame = 'machine-frame';
        reliability = 'verified';
        if (rejectedReason) {
            reasons.push('The controller\'s own echo of the last commanded move outranks this beat.');
        }
    } else if (accepted) {
        machine = derived;
        machineReportedAt = input.reportedAt;
        frame = 'work-frame';
        reliability = offset.source === 'heartbeat' ? 'heartbeat' : 'cached-offset';
    } else {
        machine = input.lastAccepted ? { ...input.lastAccepted.machine } : { ...NULLS };
        machineReportedAt = input.lastAccepted ? input.lastAccepted.reportedAt : null;
        frame = 'undetermined';
        reliability = 'awaiting-resync';
        reasons.push(input.lastAccepted
            ? `Holding the last accepted machine position (${input.lastAccepted.machine.x}, ${input.lastAccepted.machine.y}, `
                + `${input.lastAccepted.machine.z}) from ${((input.now - input.lastAccepted.reportedAt) / 1000).toFixed(1)}s ago until a `
                + 'coherent report arrives. Motion and staging are refused meanwhile.'
            : 'No accepted machine position yet on this connection. Motion and staging are refused until a coherent report arrives.');
    }
    if (stale) {
        reliability = 'stale';
        reasons.push(`STALE: the last status report is ${((input.now - input.reportedAt) / 1000).toFixed(0)}s old (poll period 2 s) - the `
            + 'machine connection has likely dropped without the server noticing (observed live 2026-09-02). Do NOT trust this '
            + 'position; reconnect and re-verify before any motion.');
    }

    return {
        machine,
        machineReportedAt,
        frame,
        reliability,
        accepted,
        rejectedReason,
        offset,
        derived,
        outsideAxes,
        reasons,
        nextAccepted: accepted && !stale && complete(derived)
            ? { machine: { x: derived.x, y: derived.y, z: derived.z }, reportedAt: input.reportedAt }
            : input.lastAccepted,
    };
}

/** True when the judgement allows motion to be staged or started on its machine position. */
export function reliableForMotion(reliability: Reliability): boolean {
    return reliability === 'verified' || reliability === 'heartbeat' || reliability === 'cached-offset';
}

// ---------------------------------------------------------------------------
// Stateful wrapper: one instance per server, reset on every (re)connection.

export interface RawBeat {
    raw: NullableXyz;
    offsetReported: NullableXyz;
    reportedAt: number;
}

export interface JudgeContext {
    now: number;
    staleMs: number;
    bounds: MachineBounds | null;
    verified: Xyz | null;
    /** No direct gcode in flight or recently replied - only such beats count toward believing a zero offset. */
    directGcodeQuiet: boolean;
}

export interface MachinePositionState {
    cachedOffset: (Xyz & { at: number }) | null;
    zeroStreak: number;
    zeroSeenAt: number | null;
    zeroTransients: number;
    previousRaw: Xyz | null;
    lastAccepted: AcceptedPosition | null;
    lastBeatAt: number | null;
    /** Inputs of the last distinct beat, so repeated reads of the same beat re-judge (staleness moves) without mutating. */
    lastInput: Omit<BeatInput, 'now' | 'verified'> | null;
    lastJudgement: BeatJudgement | null;
    rejected: { outOfBounds: number; frameFlip: number; noOffsetYet: number };
    /** Rejected -> accepted transitions ("rectified on the next sync"). */
    resyncs: number;
    disconnects: number;
    resetAt: number | null;
}

export function createMachinePositionState(): MachinePositionState {
    return {
        cachedOffset: null,
        zeroStreak: 0,
        zeroSeenAt: null,
        zeroTransients: 0,
        previousRaw: null,
        lastAccepted: null,
        lastBeatAt: null,
        lastInput: null,
        lastJudgement: null,
        rejected: { outOfBounds: 0, frameFlip: 0, noOffsetYet: 0 },
        resyncs: 0,
        disconnects: 0,
        resetAt: null,
    };
}

/** Forget everything learnt on the previous connection (work origins die on a machine reboot). */
export function resetMachinePositionState(state: MachinePositionState, now: number): void {
    const keep = { disconnects: state.disconnects, resyncs: state.resyncs, rejected: state.rejected, zeroTransients: state.zeroTransients };
    Object.assign(state, createMachinePositionState(), keep, { resetAt: now });
}

export function noteDisconnected(state: MachinePositionState, now: number): void {
    if (state.lastBeatAt !== null || state.cachedOffset !== null) {
        state.disconnects += 1;
        resetMachinePositionState(state, now);
    }
}

/**
 * Judge the latest beat, updating the state once per DISTINCT beat (by its
 * timestamp). Re-reading the same beat re-evaluates staleness and the
 * verified record but never advances streaks or the previous-raw memory.
 */
export function judgeBeatStateful(state: MachinePositionState, beat: RawBeat, ctx: JudgeContext): BeatJudgement {
    const isNewBeat = beat.reportedAt !== state.lastBeatAt;
    if (isNewBeat) {
        const reportedAllZero = complete(beat.offsetReported)
            && beat.offsetReported.x === 0 && beat.offsetReported.y === 0 && beat.offsetReported.z === 0;
        if (reportedAllZero) {
            if (state.zeroSeenAt !== beat.reportedAt) {
                state.zeroSeenAt = beat.reportedAt;
                state.zeroStreak = ctx.directGcodeQuiet ? state.zeroStreak + 1 : 0;
            }
        } else {
            state.zeroStreak = 0;
            state.zeroSeenAt = null;
        }
        state.lastInput = {
            raw: beat.raw,
            offsetReported: beat.offsetReported,
            cachedOffset: state.cachedOffset ? { x: state.cachedOffset.x, y: state.cachedOffset.y, z: state.cachedOffset.z } : null,
            zeroStreak: state.zeroStreak,
            previousRaw: state.previousRaw,
            bounds: ctx.bounds,
            reportedAt: beat.reportedAt,
            staleMs: ctx.staleMs,
            lastAccepted: state.lastAccepted,
        };
    }
    const input: BeatInput = { ...(state.lastInput as Omit<BeatInput, 'now' | 'verified'>), now: ctx.now, verified: ctx.verified, bounds: ctx.bounds, staleMs: ctx.staleMs };
    const judgement = judgeBeat(input);

    if (isNewBeat) {
        if (judgement.offset.source === 'heartbeat' && judgement.offset.cache) {
            state.cachedOffset = { ...judgement.offset.cache, at: beat.reportedAt };
        }
        if (judgement.offset.transientZero) {
            state.zeroTransients += 1;
        }
        if (judgement.rejectedReason === 'out-of-bounds') state.rejected.outOfBounds += 1;
        if (judgement.rejectedReason === 'frame-flip') state.rejected.frameFlip += 1;
        if (judgement.rejectedReason === 'no-offset-yet') state.rejected.noOffsetYet += 1;
        if (judgement.accepted && state.lastJudgement && !state.lastJudgement.accepted) {
            state.resyncs += 1;
        }
        // The flip test compares against the last ACCEPTED raw: after a
        // machine-frame artefact the next correct beat differs from it by
        // exactly the offset (the return from the G53 window) and would be
        // mistaken for a flip itself, costing a second beat.
        if (judgement.accepted && complete(beat.raw)) {
            state.previousRaw = { x: beat.raw.x, y: beat.raw.y, z: beat.raw.z };
        }
        state.lastAccepted = judgement.nextAccepted;
        state.lastBeatAt = beat.reportedAt;
        state.lastJudgement = judgement;
    }
    return judgement;
}
