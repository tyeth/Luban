/* eslint-disable import/no-dynamic-require */
import { strict as assert } from 'assert';
import Module from 'module';

import { planProbeCapture } from '../probeCapture';
import { finishProgramAbort, probeAbortHeld } from '../programAbort';
import { ProcedureAbort } from '../procedureAbort';

// Exercise the real runners with motion/camera IO replaced; never load the server.
function mocked(file: string, mocks: { [key: string]: unknown }): any {
    const target = require.resolve(file);
    const loader = Module as unknown as { _load: (id: string, parent: { filename: string }, main: boolean) => unknown };
    const old = loader._load;
    delete require.cache[target];
    loader._load = (id, parent, main) => (parent?.filename === target && Object.prototype.hasOwnProperty.call(mocks, id)
        ? mocks[id] : old(id, parent, main));
    try { return require(target); } finally { loader._load = old; delete require.cache[target]; }
}

export const tests: Array<[string, () => void | Promise<void>]> = [
    ['probe capture rejects movement, invalid selections and excessive waits before motion', () => {
        assert.equal(planProbeCapture(undefined), null);
        assert.deepEqual(planProbeCapture({ label: 'rim' }), { settleMs: 500, label: 'rim' });
        for (const raw of [{ x: 5 }, { settle_ms: Infinity }, { settle_ms: -1 }, { settle_ms: 5001 }, false]) {
            assert.throws(() => planProbeCapture(raw));
        }
        for (const stations of [[], [0], [4], [1, 1], [1.5], ['1']]) {
            assert.throws(() => planProbeCapture({ stations }, 3));
        }
        assert.deepEqual(planProbeCapture({ stations: [1, 3], settle_ms: 0 }, 3)?.stations, [1, 3]);
    }],
    ['nested held abort stays held after sensor releases; outer recovery never raises', async () => {
        const held = probeAbortHeld({ phases: [{ phase: 'abort-held', note: 'probe triggered' }] });
        assert.ok(held);
        let moves = 0;
        const tail = await finishProgramAbort(held, false, async () => { moves++; return { action: 'raised', note: '' }; });
        assert.equal(moves, 0);
        assert.match(tail, /held/);
    }],
    ['outer abort reports failed, unknown or held recovery truthfully', async () => {
        assert.match(await finishProgramAbort(false, false, async () => { throw new Error('position unknown'); }), /not verified/);
        assert.match(await finishProgramAbort(false, false, async () => ({ action: 'held', note: 'probe triggered' })), /probe triggered/);
        let moves = 0;
        await finishProgramAbort(false, true, async () => { moves++; return { action: 'raised', note: '' }; });
        assert.equal(moves, 0);
    }],
    ['capture runtime waits for a fresh frame, saves actual pose and propagates stops', async () => {
        let frames = 0;
        let saved = 0;
        let stopped = false;
        const runtime = mocked('../probeCaptureRuntime', {
            './camera': { captureFrame: async () => ({ capturedAt: ++frames === 1 ? 0 : Date.now() + 1, imageBase64: 'eA==', frameId: 'f', source: 'stream' }) },
            fs: { writeFileSync: () => { saved++; } },
            './programFrames': { programFramePath: () => '/fake/spot.jpg' },
            './probeFeed': { probeFeedService: { assertNoOvertravel: () => undefined } },
            './probing': { awaitMachineSettled: async () => undefined, sleep: async () => undefined, checkProcedureStop: () => { if (stopped) { throw new ProcedureAbort('stop'); } }, isProcedureAbort: (e: unknown) => e instanceof ProcedureAbort },
            './tools/machine': { getPositionSnapshot: () => ({ machine: { x: 1, y: 2, z: 3 }, b: 90, reliability: 'verified' }) },
        });
        const frame = await runtime.captureProbeSpot({ settleMs: 0, label: 'rim' }, 'scan', 's1');
        assert.equal(frames, 2);
        assert.equal(saved, 1);
        assert.deepEqual(frame.machine, { x: 1, y: 2, z: 3 });
        assert.equal(frame.b, 90);
        stopped = true;
        await assert.rejects(() => runtime.captureProbeSpot({ settleMs: 0 }, 'scan', 's2'), /stop/);
        assert.equal(saved, 1);
    }],
    ['capture runtime records camera failure for normal retraction', async () => {
        const runtime = mocked('../probeCaptureRuntime', {
            './camera': { captureFrame: async () => { throw new Error('camera unplugged'); } },
            './programFrames': {},
            './probeFeed': { probeFeedService: { assertNoOvertravel: () => undefined } },
            './probing': { awaitMachineSettled: async () => undefined, sleep: async () => undefined, checkProcedureStop: () => undefined, isProcedureAbort: () => false },
            './tools/machine': {},
        });
        const outcome = await runtime.captureProbeSpot({ settleMs: 0 }, 'scan', 's1');
        assert.equal(outcome.status, 'failed');
        assert.match(outcome.error, /unplugged/);
    }],
];

for (const kind of ['sequence', 'surface']) {
    for (const cameraFailed of [false, true]) {
        tests.push([`${kind} runner captures contact before retract and still finishes after camera ${cameraFailed ? 'failure' : 'success'}`, async () => {
            let position = { x: 0, y: 0, z: 203 };
            const events: string[] = [];
            let expected = false;
            const contact = () => ({ contact: position.z <= 200 });
            const move = async (tag: string, words: object) => { events.push(tag); position = { ...position, ...words }; };
            const mocks = {
                './index': { mcpBroadcast: () => undefined },
                './clearanceContext': {},
                './landmarks': {},
                './registry': { McpToolError: Error },
                './probeFeed': { probeFeedService: { setExpectedContact: () => { expected = true; }, clearExpectedContact: () => { expected = false; }, getTrip: () => null } },
                './probing': {
                    ProcedureAbort,
                    assertChannelReady: () => undefined,
                    assertMachineReadyForProcedure: () => undefined,
                    expectMachinePosition: async () => ({ note: null }),
                    knownMachinePosition: () => ({ position, source: 'test' }),
                    moveMachineSettled: move,
                    descendInSegments: async (tag: string, from: number, z: number) => move(tag, { z }),
                    marchInSegments: async (fn: (s: number) => Promise<void>, from: number, to: number) => {
                        await fn(to);
                        return { s: to, sensed: contact() };
                    },
                    senseAfter: async () => contact(),
                    senseReleaseAfter: async () => contact(),
                    isProcedureAbort: (e: unknown) => e instanceof ProcedureAbort,
                    isProcedureStopped: () => false,
                    abortRaiseToTop: async () => { throw new Error('unexpected abort'); },
                    MAX_RETREAT_MM: 5,
                    COARSE_FEED: 100,
                    FINE_FEED: 60,
                    TRAVEL_FEED: 600,
                    RECHECK_TOLERANCE_MM: 0.5,
                    DESCENT_SEGMENT_MM: 5,
                },
                './tools/machine': { getPositionSnapshot: () => ({ machine: position }) },
                './probeCaptureRuntime': { captureProbeSpot: async () => {
                    events.push('PHOTO');
                    assert.equal(position.z, 200, 'still at final contact, not raised');
                    assert.equal(expected, true, 'contact remains expected during stationary capture');
                    return { status: cameraFailed ? 'failed' : 'captured' };
                } },
                './march': {},
                './rotaryGeometry': { probeGeometry: () => null },
                ...(kind === 'surface' ? { './probeSequence': { DESCENT_GUARD_MM: 20 } } : {}),
            };
            const runner = mocked(kind === 'sequence' ? '../probeSequence' : '../probeSurface', mocks);
            const common = { staged: { ...position }, hopZ: 328, coarseStepMm: 1, fineStepMm: 0.1, backoffMm: 1, sensorDelayMs: 50, confirmPasses: 1 };
            let result: any;
            if (kind === 'sequence') {
                result = await runner.runProbeSequenceProcedure({ ...common, steps: [{ kind: 'probe', name: 'rim', start: { ...position }, unit: { x: 0, y: 0, z: -1 }, maxTravelMm: 5, onMiss: 'abort', capture: { settleMs: 0, label: null } }] });
                assert.equal(result.results[0].capture.status, cameraFailed ? 'failed' : 'captured');
            } else {
                result = await runner.runProbeSurfaceProcedure({ ...common, kind: 'path', path: { start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, unit: { x: 1, y: 0 }, lengthMm: 0, spacingMm: 0 }, tool: 'probe_surface_path', stations: [{ index: 1, label: 's1', x: 0, y: 0, s: 0, hopFromPreviousMm: 0 }], startZMachine: 203, absoluteFloorZ: 198, zSafeDeltaMm: 2, maxDropMm: 5, maxHopMm: 60, worstHopMm: 0, slowZoneMm: 1, expectedZMachine: 200, floorExplicit: true, profile: null, hopMode: 'stepped', hopLiftMm: 2, capture: { stations: [1], settleMs: 0 }, hopBackoffMm: 1.25 });
                assert.equal(result.stations[0].capture.status, cameraFailed ? 'failed' : 'captured');
            }
            assert.equal(position.z, 328);
            assert.equal(events.filter((e) => e === 'PHOTO').length, 1);
            assert.ok(events.slice(events.indexOf('PHOTO') + 1).some((e) => /retreat|retract/.test(e)));
        }]);
    }
}

tests.push(['machine adapter remembers a brief lift touch that released before the command reply', async () => {
    let position = { x: 0, y: 0, z: 10 };
    let triggers = 0;
    const moves: string[] = [];
    const march = mocked('../march', {
        './index': { mcpBroadcast: () => undefined },
        './probeFeed': { probeFeedService: { contactCount: () => triggers, setExpectedContact: () => undefined, clearExpectedContact: () => undefined } },
        './probing': {
            moveMachineSettled: async (tag: string, words: object) => {
                position = { ...position, ...words };
                moves.push(tag);
                if (tag.includes('hop-lift')) { triggers++; }
            },
            senseAfter: async () => ({ contact: position.x >= 0.5 && position.z < 12 }),
            senseReleaseAfter: async () => ({ contact: false }),
            TRAVEL_FEED: 600,
        },
    });
    await assert.rejects(() => march.steppedTraverseZ('scan', 's2', { x: 0, y: 0 }, { x: 0.5, y: 0 }, 10,
        { liftMm: 2, maxZ: 328, sensorDelayMs: 50 }, () => undefined), /contact during lift/);
    assert.ok(moves[moves.length - 1].includes('hop-lift'));
}]);
