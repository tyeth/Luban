import { strict as assert } from 'assert';

import {
    BOUNDS_MARGIN_MM,
    JudgeContext,
    RawBeat,
    createMachinePositionState,
    isFrameFlip,
    judgeBeatStateful,
    noteDisconnected,
    outsideBounds,
    reliableForMotion,
} from '../machinePosition';

// The A350 as the position of record sees it: travel 320 x 340 x 330, home at (-19, 342, 328).
const BOUNDS = { min: { x: 0, y: 0, z: 0 }, max: { x: 320, y: 340, z: 330 } };
// This rig's work origin on 2026-09-12: machine (51, 122, 328).
const OFFSET = { x: -51, y: -122, z: -328 };
const T0 = 1_000_000;

function ctx(now: number, over: Partial<JudgeContext> = {}): JudgeContext {
    return { now, staleMs: 10000, bounds: BOUNDS, verified: null, directGcodeQuiet: true, ...over };
}

/** A coherent work-frame beat for machine (170, 199, 240). */
function workBeat(at: number, machine = { x: 170, y: 199, z: 240 }): RawBeat {
    return {
        raw: { x: machine.x + OFFSET.x, y: machine.y + OFFSET.y, z: machine.z + OFFSET.z },
        offsetReported: { ...OFFSET },
        reportedAt: at,
    };
}

export const tests: Array<[string, () => void]> = [
    ['a coherent beat with its own offset is accepted as heartbeat', () => {
        const state = createMachinePositionState();
        const j = judgeBeatStateful(state, workBeat(T0), ctx(T0 + 100));
        assert.equal(j.reliability, 'heartbeat');
        assert.equal(j.accepted, true);
        assert.deepEqual(j.machine, { x: 170, y: 199, z: 240 });
        assert.equal(j.frame, 'work-frame');
        assert.ok(reliableForMotion(j.reliability));
    }],

    ['a G53-window beat carrying machine coords with the offset still populated is REJECTED and the last position held', () => {
        const state = createMachinePositionState();
        judgeBeatStateful(state, workBeat(T0), ctx(T0 + 100));
        // job 1db4902a4cd6: raw (170, 207.571, 227.7) machine-frame with the offset populated
        // -> the old code produced (221, 329.6, 555.7).
        const bad: RawBeat = { raw: { x: 170, y: 207.571, z: 227.7 }, offsetReported: { ...OFFSET }, reportedAt: T0 + 2000 };
        const j = judgeBeatStateful(state, bad, ctx(T0 + 2100));
        assert.equal(j.accepted, false);
        assert.equal(j.reliability, 'awaiting-resync');
        assert.ok(j.rejectedReason === 'out-of-bounds' || j.rejectedReason === 'frame-flip', j.rejectedReason || 'none');
        assert.deepEqual(j.machine, { x: 170, y: 199, z: 240 }, 'held at the last accepted position');
        assert.equal(j.machineReportedAt, T0);
        assert.equal(j.derived.z, 555.7, 'the artefact is exposed as derived, never as machine');
        assert.ok(!reliableForMotion(j.reliability));
    }],

    ['the next coherent beat rectifies it (resync counted)', () => {
        const state = createMachinePositionState();
        judgeBeatStateful(state, workBeat(T0), ctx(T0 + 100));
        judgeBeatStateful(state, { raw: { x: 170, y: 207.571, z: 227.7 }, offsetReported: { ...OFFSET }, reportedAt: T0 + 2000 }, ctx(T0 + 2100));
        const j = judgeBeatStateful(state, workBeat(T0 + 4000, { x: 170, y: 207.571, z: 227.7 }), ctx(T0 + 4100));
        assert.equal(j.reliability, 'heartbeat');
        assert.deepEqual(j.machine, { x: 170, y: 207.571, z: 227.7 });
        assert.equal(state.resyncs, 1);
        assert.equal(state.rejected.outOfBounds + state.rejected.frameFlip, 1);
    }],

    ['a beat more than 50 mm outside the travel is a bug, never a position (Z 656 after a bare G28)', () => {
        const state = createMachinePositionState();
        judgeBeatStateful(state, workBeat(T0), ctx(T0 + 100));
        const j = judgeBeatStateful(state, { raw: { x: 100, y: 200, z: 328 }, offsetReported: { ...OFFSET }, reportedAt: T0 + 2000 }, ctx(T0 + 2100));
        // derived z = 328 + 328 = 656
        assert.equal(j.rejectedReason, 'out-of-bounds');
        assert.deepEqual(j.outsideAxes, ['z']);
        assert.equal(j.machine.z, 240, 'held');
        assert.ok(j.reasons.some((r) => r.includes(`more than ${BOUNDS_MARGIN_MM} mm outside`)));
    }],

    ['within the 50 mm margin is accepted (home X-19, Y342 are real positions)', () => {
        const state = createMachinePositionState();
        const j = judgeBeatStateful(state, workBeat(T0, { x: -19, y: 342, z: 328 }), ctx(T0 + 100));
        assert.equal(j.accepted, true);
        assert.deepEqual(outsideBounds({ x: -19, y: 342, z: 328 }, BOUNDS), []);
        assert.deepEqual(outsideBounds({ x: -51, y: 0, z: 0 }, BOUNDS), ['x']);
    }],

    ['the frame-flip signature is recognised in both directions', () => {
        const prev = { x: 119, y: 77, z: -88 };
        assert.equal(isFrameFlip({ x: 170, y: 199, z: 240 }, prev, OFFSET), true);
        assert.equal(isFrameFlip(prev, { x: 170, y: 199, z: 240 }, OFFSET), true);
        assert.equal(isFrameFlip({ x: 120, y: 77, z: -88 }, prev, OFFSET), false, 'a 1 mm move is not a flip');
        assert.equal(isFrameFlip({ x: 170, y: 199, z: 240 }, prev, { x: 0, y: 0, z: 0 }), false, 'no offset, no flip');
    }],

    ['a zero-offset G53-window beat during direct gcode reuses the cached offset (cached-offset), and a real re-zero is believed after 3 quiet beats', () => {
        const state = createMachinePositionState();
        judgeBeatStateful(state, workBeat(T0), ctx(T0 + 100));
        // in flight: pos in machine coords, offset 0,0,0 (job 70b2b8c675a6)
        const busy = ctx(T0 + 2100, { directGcodeQuiet: false });
        const j1 = judgeBeatStateful(
            state, { raw: { x: 170, y: 199, z: 240 }, offsetReported: { x: 0, y: 0, z: 0 }, reportedAt: T0 + 2000 }, busy
        );
        assert.equal(j1.offset.transientZero, true);
        assert.equal(j1.offset.source, 'cached');
        // raw 170,199,240 minus the cached offset = 221, 321, 568 -> out of bounds -> rejected, not believed
        assert.equal(j1.accepted, false);
        assert.deepEqual(j1.machine, { x: 170, y: 199, z: 240 }, 'held');
        assert.equal(state.zeroStreak, 0, 'busy beats never count toward believing a zero');
        // machine idle, the operator zeroed the work origin at machine zero: three quiet beats
        let j = j1;
        for (let i = 1; i <= 3; i += 1) {
            const at = T0 + 2000 + i * 2000;
            j = judgeBeatStateful(state, { raw: { x: 100, y: 100, z: 300 }, offsetReported: { x: 0, y: 0, z: 0 }, reportedAt: at }, ctx(at + 100));
        }
        assert.equal(j.offset.source, 'heartbeat', 'zero believed after ZERO_OFFSET_ACCEPT_BEATS quiet beats');
        assert.deepEqual(j.machine, { x: 100, y: 100, z: 300 });
    }],

    ['no offset ever reported: nothing is assumed, motion refused', () => {
        const state = createMachinePositionState();
        const j = judgeBeatStateful(
            state, { raw: { x: 10, y: 10, z: 300 }, offsetReported: { x: null, y: null, z: null }, reportedAt: T0 }, ctx(T0 + 100)
        );
        assert.equal(j.rejectedReason, 'no-offset-yet');
        assert.equal(j.reliability, 'awaiting-resync');
        assert.deepEqual(j.machine, { x: null, y: null, z: null });
    }],

    ['a missing offset after a complete one reuses it (cached-offset)', () => {
        const state = createMachinePositionState();
        judgeBeatStateful(state, workBeat(T0), ctx(T0 + 100));
        const j = judgeBeatStateful(
            state, { raw: { x: 119, y: 77, z: -88 }, offsetReported: { x: null, y: null, z: null }, reportedAt: T0 + 2000 }, ctx(T0 + 2100)
        );
        assert.equal(j.reliability, 'cached-offset');
        assert.deepEqual(j.machine, { x: 170, y: 199, z: 240 });
    }],

    ['the controller echo (position of record) outranks a rejected beat', () => {
        const state = createMachinePositionState();
        judgeBeatStateful(state, workBeat(T0), ctx(T0 + 100));
        const j = judgeBeatStateful(
            state, { raw: { x: 100, y: 200, z: 328 }, offsetReported: { ...OFFSET }, reportedAt: T0 + 2000 },
            ctx(T0 + 2100, { verified: { x: 170, y: 199, z: 320 } })
        );
        assert.equal(j.reliability, 'verified');
        assert.deepEqual(j.machine, { x: 170, y: 199, z: 320 });
        assert.equal(j.frame, 'machine-frame');
        assert.equal(j.accepted, false, 'the beat itself is still recorded as rejected');
    }],

    ['stale wins over everything, including a verified record', () => {
        const state = createMachinePositionState();
        const j = judgeBeatStateful(state, workBeat(T0), ctx(T0 + 20000, { verified: { x: 1, y: 2, z: 3 } }));
        assert.equal(j.reliability, 'stale');
        assert.ok(!reliableForMotion('stale'));
    }],

    ['re-reading the same beat re-judges staleness without advancing state', () => {
        const state = createMachinePositionState();
        const a = judgeBeatStateful(state, workBeat(T0), ctx(T0 + 100));
        assert.equal(a.reliability, 'heartbeat');
        const b = judgeBeatStateful(state, workBeat(T0), ctx(T0 + 100));
        assert.equal(b.reliability, 'heartbeat');
        assert.equal(state.lastBeatAt, T0);
        const c = judgeBeatStateful(state, workBeat(T0), ctx(T0 + 15000));
        assert.equal(c.reliability, 'stale');
        assert.deepEqual(state.previousRaw, workBeat(T0).raw, 'previousRaw only advances on a distinct beat');
    }],

    ['a disconnect forgets the previous connection\'s offset and position', () => {
        const state = createMachinePositionState();
        judgeBeatStateful(state, workBeat(T0), ctx(T0 + 100));
        assert.ok(state.cachedOffset);
        noteDisconnected(state, T0 + 5000);
        assert.equal(state.cachedOffset, null);
        assert.equal(state.lastAccepted, null);
        assert.equal(state.disconnects, 1);
        // a new connection with a NEW work origin (machine reboot) starts clean
        const j = judgeBeatStateful(
            state, { raw: { x: 0, y: 0, z: 0 }, offsetReported: { x: -100, y: -100, z: -300 }, reportedAt: T0 + 9000 }, ctx(T0 + 9100)
        );
        assert.equal(j.reliability, 'heartbeat');
        assert.deepEqual(j.machine, { x: 100, y: 100, z: 300 });
    }],
];
