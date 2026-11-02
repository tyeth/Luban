import assert from 'assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';
import * as continuous from '../continuousProbe';
import * as abort from '../procedureAbort';
import * as limits from '../procedureLimits';
import * as position from '../positionOfRecord';
import type * as probingModule from '../probing';

/** Actual motion engine and fast-path adapter, with no controller, timers or GPIO. */
function fixture(reply = 'X:0 Y:0 Z:4') {
    position.clearPositionOfRecord();
    abort.clearProcedureStop();
    let sequence = 0;
    let connection = 1;
    let sends = 0;
    let health = true;
    let usb = true;
    let interference = false;
    let replaceConnection = false;
    const channel = { executeGcode: async () => undefined };
    const snapshot = () => ({
        machine: { x: 0, y: 0, z: 4 }, work: { x: 0, y: 0, z: 4 }, originOffset: { x: 0, y: 0, z: 0 },
    });
    const dependencies: Record<string, unknown> = {
        './index': { mcpBroadcast: () => undefined },
        './positionOfRecord': position,
        './continuousProbe': continuous,
        './procedureAbort': abort,
        './procedureLimits': limits,
        '../machine/ConnectionManager': { connectionManager: {
            getConnectionStatus: () => ({ connected: true, channelName: usb ? 'text-serial' : 'http' }),
            getConnectionGeneration: () => connection,
            getCurrentChannel: () => channel,
        } },
        './probeFeed': { probeFeedService: {
            assertNoOvertravel: () => undefined,
            motionBegin: () => undefined,
            motionEnd: () => undefined,
            getContinuousState: () => (health ? {
                generation: 1,
                progress: { sequence: 1, sampledAt: 950, receivedAt: 950, discontinuities: 0, pollMs: 10 },
                contactCount: 0,
                triggered: false,
                value: '1',
                receivedAt: 1,
            } : null),
        } },
        './tools/machine': { getPositionSnapshot: snapshot },
        './tools/camera': {
            currentGcodeSequence: () => sequence,
            sendGcodeVisible: async () => {
                sends++;
                sequence += interference ? 2 : 1;
                if (replaceConnection) { connection++; }
                return { result: 0, text: reply, sequence };
            },
        },
    };
    const source = fs.readFileSync(path.join(__dirname, '../probing.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true,
    } }).outputText;
    const exports: Partial<typeof probingModule> = {};
    vm.runInNewContext(compiled, {
        exports,
        Date: { now: () => 1000 },
        require: (name: string) => dependencies[name] || {},
        setTimeout: () => { throw new Error('USB fast path must not wait for a sensor sample or heartbeat'); },
    });
    const probing = exports as typeof probingModule;
    const create = () => probing.createUsbContinuousCoarseProbe(async (z) => {
        await probing.moveMachineSettled('test', { z }, 100, { requireUsbCompletion: true });
    });
    return {
        create,
        sends: () => sends,
        ineligible: (kind: 'health' | 'channel') => { if (kind === 'health') { health = false; } else { usb = false; } },
        interfere: () => { interference = true; },
        replace: () => { replaceConnection = true; },
    };
}

export const tests: Array<[string, () => void | Promise<void>]> = [
    ['verified USB target plus existing continuous health releases a segment without a timer', async () => {
        const f = fixture();
        const gate = f.create();
        assert.ok(gate);
        assert.strictEqual((await gate.advance(5, 4)).segments, 1);
        assert.strictEqual(f.sends(), 1);
        assert.strictEqual(position.getPositionOfRecord(1)?.source, 'echo');
    }],
    ['bare ACK or mismatching USB position cannot fall back to a matching heartbeat', async () => {
        for (const reply of ['ok', 'X:0 Y:0 Z:5']) {
            const f = fixture(reply);
            const gate = f.create();
            assert.ok(gate);
            await assert.rejects(gate.advance(5, 4), continuous.isProbeSynchronizationLost);
            assert.strictEqual(f.sends(), 1);
            assert.strictEqual(position.getPositionOfRecord(1), null);
        }
    }],
    ['changed USB generation or intervening command invalidates even a matching echo', async () => {
        for (const fault of ['replace', 'interfere'] as const) {
            const f = fixture();
            const gate = f.create();
            assert.ok(gate);
            f[fault]();
            await assert.rejects(gate.advance(5, 4), continuous.isProbeSynchronizationLost);
            assert.strictEqual(f.sends(), 1);
        }
    }],
    ['ineligible feed or channel leaves the standard sensor-window path selected', () => {
        for (const kind of ['health', 'channel'] as const) {
            const f = fixture();
            f.ineligible(kind);
            assert.strictEqual(f.create(), null);
            assert.strictEqual(f.sends(), 0);
        }
    }],
];
