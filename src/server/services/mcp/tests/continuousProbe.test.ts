import assert from 'assert';
import {
    ContinuousCoarseProbe, ContinuousProbeState, ProbeProgressTracker, continuousProbeHealthy, isProbeSynchronizationLost,
} from '../continuousProbe';

function fixture() {
    let now = 1000;
    const progress = new ProbeProgressTracker();
    let sequence = 0;
    let generation = 1;
    let count = 0;
    let triggered = false;
    let live = true;
    let stopped = false;
    const moves: number[] = [];
    const sensed: boolean[] = [];
    const pulse = () => { progress.note(++sequence, now, now, 10); };
    pulse();
    const read = (): ContinuousProbeState | null => (live ? {
        generation, progress: progress.snapshot()!, contactCount: count, triggered, value: triggered ? '0' : '1', receivedAt: 1,
    } : null);
    let duringMove: () => void = () => undefined;
    const gate = new ContinuousCoarseProbe({
        read,
        now: () => now,
        checkStop: () => { if (stopped) { throw new Error('stop requested'); } },
        move: async (s) => {
            moves.push(s);
            // A 1 mm move at F100: the existing controller completion cost.
            for (let i = 0; i < 6; i++) { now += 100; pulse(); }
            duringMove();
        },
        sensed: (contact) => sensed.push(contact),
    }, read()!);
    return {
        gate,
        moves,
        sensed,
        read,
        progress,
        now: () => now,
        onMove: (fn: () => void) => { duringMove = fn; },
        touch: () => { count++; },
        trigger: () => { triggered = true; },
        disconnect: () => { live = false; },
        reconnect: () => { generation++; },
        gap: () => { now += 400; pulse(); },
        stale: () => { now += 301; },
        advanceClock: (ms: number) => { now += ms; },
        stop: () => { stopped = true; },
    };
}

export const tests: Array<[string, () => void | Promise<void>]> = [
    ['25 mm coarse search adds no sensor dwell to 25 completed 1 mm USB segments', async () => {
        const f = fixture();
        const result = await f.gate.advance(328, 303);
        assert.strictEqual(result.segments, 25);
        assert.strictEqual(result.sensed.contact, false);
        assert.strictEqual(f.now() - 1000, 25 * 600, 'only simulated controller motion; no 25 x 300 ms wait');
        assert.deepStrictEqual(f.moves, Array.from({ length: 25 }, (_, i) => 327 - i));
        assert.strictEqual(f.read()!.receivedAt, 1, 'unchanged level may be old: progress proves the monitor remains alive');
    }],
    ['a progress pulse predating completion is sufficient; no per-move unchanged sample is required', async () => {
        const f = fixture();
        f.onMove(() => { f.advanceClock(50); });
        assert.strictEqual((await f.gate.advance(0, 1)).sensed.contact, false);
    }],
    ['touch-and-release within one segment stops before any next segment', async () => {
        const f = fixture();
        f.onMove(() => { if (f.moves.length === 3) { f.touch(); } });
        const result = await f.gate.advance(0, 25);
        assert.strictEqual(result.s, 3);
        assert.strictEqual(result.sensed.contact, true);
        assert.strictEqual(f.read()!.triggered, false);
        assert.deepStrictEqual(f.moves, [1, 2, 3]);
        assert.strictEqual('contactMachine' in result, false, 'counter supplies a bracket, never a measured coordinate');
    }],
    ['an edge between logical coarse calls is not lost when the per-call baseline would reset', async () => {
        const f = fixture();
        await f.gate.advance(0, 1);
        f.touch();
        const result = await f.gate.advance(1, 2);
        assert.strictEqual(result.sensed.contact, true);
        assert.strictEqual(result.segments, 0);
        assert.deepStrictEqual(f.moves, [1]);
    }],
    ['current level also stops even if the event count has not increased', async () => {
        const f = fixture();
        f.onMove(f.trigger);
        assert.strictEqual((await f.gate.advance(0, 25)).sensed.contact, true);
        assert.deepStrictEqual(f.moves, [1]);
    }],
    ['feed loss, reconnect, stale health and a recovered gap hold after the current segment', async () => {
        for (const failure of ['disconnect', 'reconnect', 'stale', 'gap'] as const) {
            const f = fixture();
            f.onMove(f[failure]);
            await assert.rejects(f.gate.advance(0, 25), isProbeSynchronizationLost, failure);
            assert.deepStrictEqual(f.moves, [1], failure);
        }
    }],
    ['missing USB completion/position proof holds without a second move or retreat', async () => {
        const f = fixture();
        f.onMove(() => { throw new Error('M114 target mismatch'); });
        await assert.rejects(f.gate.advance(0, 25), /Holding position/);
        assert.deepStrictEqual(f.moves, [1]);
    }],
    ['unhealthy GPIO cannot enable the fast path; clock/sequence gaps remain visible after recovery', () => {
        const f = fixture();
        assert.strictEqual(continuousProbeHealthy(null, f.now()), false);
        assert.strictEqual(continuousProbeHealthy({ ...f.read()!, progress: { ...f.read()!.progress, pollMs: 1000 } }, f.now()), false);
        const p = new ProbeProgressTracker();
        p.note(1, 1000, 1000, 10);
        p.note(2, 1100, 1500, 10);
        p.note(3, 1600, 1600, 10);
        assert.ok(p.snapshot()!.discontinuities > 0, 'late pipe data cannot be hidden by a later fresh pulse');
        p.note(4, NaN, 1700, 10);
        assert.strictEqual(p.snapshot(), null);
    }],
];
