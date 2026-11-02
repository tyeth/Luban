import assert from 'assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';
import * as continuous from '../continuousProbe';
import * as abort from '../procedureAbort';
import * as limits from '../procedureLimits';

/** Real point runner and continuous gate, fake settled machine and feed. No timers or hardware. */
function fixture(failure?: 'feed' | 'position') {
    let now = 1000;
    let z = 5;
    let count = 0;
    let triggered = false;
    let healthy = true;
    const moves: Array<{ tag: string; z: number; strict: boolean }> = [];
    const waits: string[] = [];
    const read = () => (healthy ? {
        generation: 1,
        progress: { sequence: now, sampledAt: now, receivedAt: now, discontinuities: 0, pollMs: 10 },
        contactCount: count,
        triggered,
        value: triggered ? '0' : '1',
        receivedAt: 1,
    } : null);
    const sensed = () => ({ contact: triggered, reading: { value: triggered ? '0' : '1', receivedAt: now } });
    const probing = {
        ...abort,
        ...limits,
        MAX_RETREAT_MM: 5,
        assertChannelReady: () => undefined,
        assertMachineReadyForProcedure: () => undefined,
        knownMachinePosition: () => ({ position: { x: 0, y: 0, z } }),
        moveMachineSettled: async (tag: string, target: { z: number }, feed: number, options?: { requireUsbCompletion?: boolean }) => {
            moves.push({ tag, z: target.z, strict: !!options?.requireUsbCompletion });
            z = target.z;
            now += 100;
            const contact = z <= 2.80001;
            if (contact && !triggered) { count++; }
            triggered = contact;
            if (moves.length === 2 && failure === 'feed') { healthy = false; }
            if (moves.length === 2 && failure === 'position') { throw new Error('USB target mismatch'); }
        },
        createUsbContinuousCoarseProbe: (move: (s: number) => Promise<void>) => new continuous.ContinuousCoarseProbe({
            move, read, now: () => now, checkStop: () => undefined, sensed: () => undefined,
        }, read()!),
        marchInSegments: () => { throw new Error('healthy USB coarse search must not use fixed windows'); },
        senseAfter: async (channel: string, issued: number, delay: number) => {
            waits.push(moves[moves.length - 1].tag);
            assert.strictEqual(delay, 300, 'fine/confirm retain the configured window');
            now += delay;
            return sensed();
        },
        senseReleaseAfter: async () => sensed(),
        abortRaiseToTop: async () => { throw new Error('unexpected automatic retreat'); },
    };
    const dependencies: Record<string, unknown> = {
        './index': { mcpBroadcast: () => undefined },
        './probing': probing,
        './continuousProbe': continuous,
        './procedureAbort': abort,
        './probeFeed': { probeFeedService: { setExpectedContact: () => undefined, clearExpectedContact: () => undefined, getTrip: () => null } },
        './registry': { McpToolError: Error },
        './procedureLimits': limits,
        './toolDatumState': { getProbeTipCalibration: () => null },
        './toolDatum': { projectToolTipZ: () => ({}) },
        './tools/machine': { getPositionSnapshot: () => ({ machine: { x: 0, y: 0, z }, originOffset: { x: 0, y: 0, z: 0 } }), safeTraverseZ: () => 5 },
    };
    const source = fs.readFileSync(path.join(__dirname, '../probeTool.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true,
    } }).outputText;
    const exports: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    vm.runInNewContext(compiled, { exports, Date: { now: () => now }, require: (name: string) => dependencies[name] || {} });
    const run = () => exports.runProbePointProcedure({
        axis: 'z',
        direction: -1,
        start: { x: 0, y: 0, z: 5 },
        maxTravelMm: 5,
        limitCoord: 0,
        coarseStepMm: 1,
        fineStepMm: 0.1,
        backoffMm: 0.2,
        sensorDelayMs: 300,
        confirmPasses: 3,
    });
    return { run, moves, waits };
}

export const tests: Array<[string, () => Promise<void>]> = [
    ['coarse endpoint is remeasured: retreat, fine and three confirmation passes determine final Z', async () => {
        const f = fixture();
        const result = await f.run();
        assert.strictEqual(result.phases.find((p: { phase: string }) => p.phase === 'coarse-contact').coord, 2);
        assert.strictEqual(result.contactMachine.z, 2.8);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(result.confirmPassContacts)), [2.8, 2.8, 2.8]);
        assert.ok(f.moves.some((m) => m.tag === 'probe:release'));
        assert.ok(f.waits.length > 3);
        assert.ok(f.waits.every((tag) => tag === 'probe:fine' || tag === 'probe:confirm'));
        assert.ok(f.moves.every((m) => m.strict), 'a fast-path run never falls back to estimated/heartbeat completion');
        assert.strictEqual(f.moves[f.moves.length - 1].tag, 'probe:retreat');
    }],
    ['feed or position synchronization loss holds without retreat and without inventing a contact or held coordinate', async () => {
        for (const failure of ['feed', 'position'] as const) {
            const f = fixture(failure);
            await assert.rejects(f.run(), (err: unknown) => {
                assert.ok(continuous.isProbeSynchronizationLost(err));
                const partial = err.partial as { contactMachine: unknown; phases: Array<{ phase: string; coord: unknown }> };
                assert.strictEqual(partial.contactMachine, null);
                assert.strictEqual(partial.phases[partial.phases.length - 1].phase, 'abort-held');
                assert.strictEqual(partial.phases[partial.phases.length - 1].coord, null);
                return true;
            });
            assert.strictEqual(f.moves.length, 2, failure);
            assert.ok(f.moves.every((m) => m.tag === 'probe:coarse'));
            assert.strictEqual(f.waits.length, 0);
        }
    }],
];
