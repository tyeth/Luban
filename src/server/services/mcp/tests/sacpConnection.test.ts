// A SACP channel (the Ray over SACP-UDP, #260) publishes the heartbeat and
// coordinate subscriptions it already runs for the Luban UI as
// getLatestMachineState(), ConnectionManager hands that to the MCP, and the
// connection diagnostics see a worker and beats. Inert: fake transport and
// SACP client, captured timers, nothing reaches a machine.
import assert from 'assert';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';
import * as rayBoundary from '../../../../shared/lib/rayBoundary';
import { ConnectionDiagnosticState } from '../../machine/connectionDiagnosticState';
import * as sacpMachineState from '../../machine/channels/sacpMachineState';
import { GcodeLease } from '../../machine/gcodeLease';
import * as positionOfRecord from '../positionOfRecord';

type Exports = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MACHINE_DIR = path.join(__dirname, '../../machine');

function stubImports(source: string): Record<string, unknown> {
    const dependencies: Record<string, unknown> = {};
    const pattern = /from ['"]([^'"]+)['"]/g;
    for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
        dependencies[match[1]] = {};
    }
    return dependencies;
}

interface Timers { pending: Array<{ fn: () => void; ms: number }> }

function load(file: string, overrides: Record<string, unknown>, timers: Timers): Exports {
    const source = fs.readFileSync(path.join(MACHINE_DIR, file), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true,
    } });
    const dependencies = { ...stubImports(source), ...overrides };
    const exports = {} as Exports;
    vm.runInNewContext(compiled.outputText, {
        exports,
        Date,
        Promise,
        Buffer,
        setTimeout: (fn: () => void, ms: number) => { timers.pending.push({ fn, ms }); return timers.pending.length; },
        clearTimeout: () => undefined,
        setInterval: () => 0,
        clearInterval: () => undefined,
        process: { env: { NODE_ENV: 'test' } },
        require: (name: string) => {
            if (!(name in dependencies)) { throw new Error(`Unstubbed dependency: ${name}`); }
            return dependencies[name];
        },
    });
    return exports;
}

const logger = () => ({ info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined });
const events = { Connecting: 'connecting', Connected: 'connected', Ready: 'ready', Disconnected: 'disconnected', ErrorReport: 'error-report' };

class Channel extends EventEmitter {
    public socket = new EventEmitter();

    public getLatestMachineState() { return null; }
}

/** The subscriptions startHeartbeatLegacy opens, with the two the test drives captured. */
class FakeSacpClient {
    public static heartbeat: ((data: object) => void) | null = null;

    public static coordinates: ((data: object) => void) | null = null;

    public static homeRequests = 0;

    public static homeResult = 0;

    /** MachineInfo.masterControlSerialNumber; undefined = a controller that reports none. */
    public static serialNumber: unknown = undefined;

    public read(): void { /* parsed, never a session change */ }

    public dispose(): void { /* nothing to free */ }

    public setLogger(): void { /* silent */ }

    /** 0x01 0x21's data after the result byte, for the channel's own parse; null = the SDK model only. */
    public static machineInfoData: Buffer | null = null;

    /** MachineInfo.type (5 = the Ray in the harness's SACP_TYPE_SERIES_MAP; 0 = unmapped). */
    public static machineType = 0;

    public async getMachineInfo() {
        const data = FakeSacpClient.machineInfoData;
        return {
            data: { type: FakeSacpClient.machineType, masterControlSerialNumber: FakeSacpClient.serialNumber },
            packet: data ? { payload: Buffer.concat([Buffer.from([0]), data]) } : undefined,
        };
    }

    public async getModuleInfo() { return { data: [] }; }

    public async logFeedbackLevel() { return { response: { result: 1 } }; } // never subscribes the log

    public setHandler(): void { /* homed notification handler kept by the channel */ }

    public async ack() { return undefined; }

    public async subscribeHeartbeat(_opts: object, callback: (data: object) => void) {
        FakeSacpClient.heartbeat = callback;
        return { code: 0 };
    }

    public async unsubscribeHeartbeat() { return { code: 0 }; }

    public async subscribeCurrentCoordinateInfo(_opts: object, callback: (data: object) => void) {
        FakeSacpClient.coordinates = callback;
        return { response: { result: 0 } };
    }

    public async subscribeHotBedTemperature() { return 0; }

    public async subscribeNozzleInfo() { return 0; }

    public async subscribeCncSpeedState() { return 0; }

    public async subscribeLaserPowerState() { return 0; }

    public async subscribeGetPrintingTime() { return 0; }

    public async subscribeEnclosureInfo() { return { response: { result: 0 } }; }

    public async subscribeEnclosureLightInfo() { return { response: { result: 0 } }; }

    public async subscribePurifierInfo() { return { response: { result: 0 } }; }

    public async requestHome() {
        FakeSacpClient.homeRequests += 1;
        return { response: { result: FakeSacpClient.homeResult } };
    }

    // ---- MCP file jobs (#328) ----

    /** Each compressed upload the channel asked for, and the result the test chose (null = never resolves). */
    public static uploads: Array<{ filePath: string; renderName?: string; options: { onProgress?: (p: number) => void; onFailed?: (r: string) => void } }> = [];

    public static uploadResult: boolean | null = true;

    public static uploadFailure: string | null = null;

    public static stopRequests = 0;

    public static stopResult = 0;

    public static lineNumber: ((data: object) => void) | null = null;

    public static printingFileInfo = { filename: '/ray.nc', totalLine: 84, estimatedTime: 10 };

    public async uploadFileCompressed(filePath: string,
        options: { renderName?: string; onProgress?: (p: number) => void; onFailed?: (r: string) => void } = {}) {
        FakeSacpClient.uploads.push({ filePath, renderName: options.renderName, options });
        if (FakeSacpClient.uploadResult === null) {
            return new Promise<boolean>(() => undefined);
        }
        if (!FakeSacpClient.uploadResult && FakeSacpClient.uploadFailure && options.onFailed) {
            options.onFailed(FakeSacpClient.uploadFailure);
        }
        return FakeSacpClient.uploadResult;
    }

    public async stopPrint() {
        FakeSacpClient.stopRequests += 1;
        return { response: { result: FakeSacpClient.stopResult } };
    }

    public async getPrintingFileInfo() {
        return { response: { result: 0 }, data: { ...FakeSacpClient.printingFileInfo } };
    }

    public async subscribeGetPrintCurrentLineNumber(_opts: object, callback: (data: object) => void) {
        FakeSacpClient.lineNumber = callback;
        return { code: 0 };
    }
}

class FakeUdpSocket extends EventEmitter {
    public bind(): void { /* no port is bound */ }
}

/** The SDK's GcodeCurrentLine as the channel uses it: the test hands `{ currentLine }` as `response.data`. */
class FakeGcodeCurrentLine {
    public currentLine = 0;

    public fromBuffer(data: { currentLine: number }) {
        this.currentLine = data.currentLine;
        return this;
    }
}

/** The SDK model as the channel uses it: the test hands the report object itself as `response.data`. */
class FakeCoordinateSystemInfo {
    public homed = 1;

    public coordinates: Array<{ key: number; value: number }> = [];

    public originOffset: Array<{ key: number; value: number }> = [];

    public fromBuffer(report: { homed: number; coordinates: unknown[]; originOffset: unknown[] }) {
        Object.assign(this, report);
        return this;
    }
}

export function diagnostics() {
    return new ConnectionDiagnosticState({ instanceId: 'test', pid: 1, startedAt: 0, version: 'test', build: 'test' }, () => undefined);
}

/** Where the channel writes an MCP job's frame (DataStorage.tmpDir); a fresh scratch directory per test run. */
export const UDP_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'luban-ray-boundary-'));

function udpChannel(diag: ConnectionDiagnosticState) {
    const timers: Timers = { pending: [] };
    const base = load('channels/SacpChannel.ts', {
        '@snapmaker/luban-platform': { WorkflowStatus: { Idle: 'idle', Unknown: 'unknown', Starting: 'starting', Running: 'running', Paused: 'paused' } },
        '@snapmaker/snapmaker-sacp-sdk/dist/helper': {
            readUint8: (buffer: Buffer, index: number) => buffer[index], readString: () => ({ result: '' }), readUint16: () => 0, readUint32: () => 0,
        },
        '@snapmaker/snapmaker-sacp-sdk/dist/models': { CoordinateSystemInfo: FakeCoordinateSystemInfo, GcodeCurrentLine: FakeGcodeCurrentLine },
        '../../../../app/constants': { WORKFLOW_STATUS_MAP: { 0: 'idle', 1: 'running' }, HEAD_PRINTING: 'printing', HEAD_LASER: 'laser', HEAD_CNC: 'cnc' },
        '../../../../app/constants/machines': { MODULEID_MAP: {}, MODULEID_TOOLHEAD_MAP: { 0: 'extruder' } },
        lodash: { includes: (items: unknown[], value: unknown) => items.includes(value), find: () => undefined },
        '../../../lib/logger': logger,
        '../sacp/SacpClient': FakeSacpClient,
        '../connectionDiagnostics': { connectionDiagnostics: diag },
        './sacpMachineState': sacpMachineState,
        './Channel': Channel,
        './ChannelEvent': { ChannelEvent: events },
    }, timers);
    const module = load('channels/SacpUdpChannel.ts', {
        dgram: { createSocket: () => new FakeUdpSocket() },
        '../../../lib/logger': logger,
        '../sacp/SacpClient': FakeSacpClient,
        './ChannelEvent': { ChannelEvent: events },
        './SacpChannel': base,
        './Channel': {},
        '../../../../app/constants/machines': { SACP_TYPE_SERIES_MAP: { 5: 'Ray' } },
        '../gcodeLease': { gcodeLease: new GcodeLease() },
        // The job frame (boundary.nc): real file I/O and hashing in a scratch dir, Luban's real frame G-code.
        crypto,
        fs,
        path,
        '../../../../shared/lib/rayBoundary': rayBoundary,
        '../../../DataStorage': { tmpDir: UDP_TMP_DIR },
    }, timers);
    const UdpChannel = module.default;
    const channel = new UdpChannel();
    channel.socket = new EventEmitter();
    return { channel, timers };
}

export function connectionManager(channel: object, diag: ConnectionDiagnosticState, extra: Record<string, unknown> = {}, timers: Timers = { pending: [] }) {
    const module = load('ConnectionManager.ts', {
        '../../lib/logger': logger,
        lodash: { includes: (items: unknown[], value: unknown) => items.includes(value) },
        './gcodeLease': { gcodeLease: new GcodeLease() },
        '../mcp/positionOfRecord': positionOfRecord,
        './connectionDiagnostics': { connectionDiagnostics: diag, diagnosticId: () => 'diagnostic-id' },
        '../../constants': { HEAD_CNC: 'cnc', HEAD_LASER: 'laser', HEAD_PRINTING: 'printing' },
        './ProtocolDetector': { NetworkProtocol: { HTTP: 'HTTP', SacpOverTCP: 'SACP-TCP', SacpOverUDP: 'SACP-UDP', Unknown: 'Unknown' },
            SerialPortProtocol: { SacpOverSerialPort: 'SACP-Serial', PlainText: 'text' } },
        './types': { ConnectionType: { WiFi: 'wifi', Serial: 'serial' } },
        './adaptor/Octo': { octo: { onStart: () => undefined, onStop: () => undefined } },
        './channels/ChannelEvent': { ChannelEvent: events },
        '../../../app/machines': {
            SnapmakerA150Machine: { identifier: 'A150' },
            SnapmakerA250Machine: { identifier: 'A250' },
            SnapmakerA350Machine: { identifier: 'A350' },
            SnapmakerArtisanMachine: { identifier: 'Artisan' },
            SnapmakerJ1Machine: { identifier: 'J1' },
            SnapmakerRayMachine: { identifier: 'Ray' },
        },
        ...extra,
    }, timers);
    const cm = module.connectionManager;
    cm.channel = channel;
    cm.protocol = 'SACP-UDP';
    cm.connectionType = 'wifi';
    return cm;
}

const X = sacpMachineState.SACP_AXIS_KEY.x;
const Y = sacpMachineState.SACP_AXIS_KEY.y;

/** A Ray coordinate report: X/Y only, work origin at machine zero, homed. */
function rayReport(x: number, y: number, homed = 0) {
    const coordinates = [{ key: X, value: x }, { key: Y, value: y }];
    const originOffset = [{ key: X, value: 0 }, { key: Y, value: 0 }];
    return { response: { data: { homed, coordinates, originOffset } } };
}

const beat = (status: number) => ({ response: { data: Buffer.from([status]) } });

export const tests: Array<[string, () => void | Promise<void>]> = [
    ['SACP-UDP (Ray, firmware > 1.6.8): the legacy heartbeat + coordinate subscriptions become getLatestMachineState()', async () => {
        const diag = diagnostics();
        const { channel } = udpChannel(diag);
        await channel.connectionOpen({ address: '192.0.2.9' });
        assert.strictEqual(channel.getLatestMachineState(), null, 'nothing before the first beat');
        assert.strictEqual(diag.snapshot().heartbeat.polling, false);

        await channel.startHeartbeatLegacy(channel.sacpClient, undefined, 'ray-id');
        assert.strictEqual(diag.snapshot().heartbeat.polling, true, 'subscribing is the worker starting');
        assert.ok(diag.snapshot().recent.some((e) => e.event === 'heartbeat_worker_started'));
        assert.ok(FakeSacpClient.heartbeat && FakeSacpClient.coordinates, 'both subscriptions opened');

        const before = Date.now();
        (FakeSacpClient.heartbeat as (d: object) => void)(beat(0));
        const afterBeat = channel.getLatestMachineState();
        assert.ok(afterBeat, 'a heartbeat alone publishes state');
        assert.strictEqual(afterBeat.status, 'idle');
        assert.ok(afterBeat.timestamp >= before);
        assert.strictEqual(afterBeat.pos, undefined, 'no position until the coordinate report');
        assert.ok(diag.snapshot().recent.some((e) => e.event === 'first_heartbeat'), 'the beat is counted as an accepted report');
        assert.strictEqual(diag.snapshot().heartbeat.lastReportAt !== null, true);

        (FakeSacpClient.coordinates as (d: object) => void)(rayReport(-1, 399));
        const state = channel.getLatestMachineState();
        assert.deepStrictEqual(state.pos, { x: -1, y: 399, z: 0, b: null, isFourAxis: false });
        assert.deepStrictEqual(state.originOffset, { x: 0, y: 0, z: 0, b: null });
        assert.strictEqual(state.isHomed, true);
        assert.strictEqual(state.status, 'idle');
        assert.deepStrictEqual(state.reportedAxes, ['x', 'y']);

        (FakeSacpClient.heartbeat as (d: object) => void)(beat(1));
        assert.strictEqual(channel.getLatestMachineState().status, 'running');
        assert.deepStrictEqual(channel.getLatestMachineState().pos, state.pos, 'the heartbeat keeps the position');

        await channel.stopHeartbeat('ray-id');
        assert.strictEqual(channel.getLatestMachineState(), null, 'stop clears the state');
        assert.strictEqual(diag.snapshot().heartbeat.polling, false);
        assert.ok(diag.snapshot().recent.some((e) => e.event === 'heartbeat_worker_stopped' && e.reason === 'heartbeat_stop'));
    }],

    ['a lost heartbeat or a new transport session clears the state, so the MCP reads null again', async () => {
        const diag = diagnostics();
        const { channel, timers } = udpChannel(diag);
        await channel.connectionOpen({ address: '192.0.2.9' });
        await channel.startHeartbeatLegacy(channel.sacpClient, undefined, 'ray-id');
        timers.pending.length = 0;
        (FakeSacpClient.heartbeat as (d: object) => void)(beat(0));
        (FakeSacpClient.coordinates as (d: object) => void)(rayReport(-1, 399));
        assert.ok(channel.getLatestMachineState());
        const watchdog = timers.pending.filter((timer) => timer.ms === 10000).pop();
        assert.ok(watchdog, 'the beat armed the 10 s watchdog');
        watchdog.fn();
        assert.strictEqual(channel.getLatestMachineState(), null, 'heartbeat loss');
        assert.ok(diag.snapshot().recent.some((e) => e.event === 'heartbeat_worker_stopped' && e.reason === 'heartbeat_lost'));

        (FakeSacpClient.heartbeat as (d: object) => void)(beat(0));
        assert.ok(channel.getLatestMachineState(), 'a late beat is state again (the session object is the same)');
        await channel.connectionOpen({ address: '192.0.2.9' }); // a new SACP session on the same singleton
        assert.strictEqual(channel.getLatestMachineState(), null, 'a new session starts with no state');
    }],

    ['the pre-1.6.8 startHeartbeat path publishes status only and registers with diagnostics', async () => {
        const diag = diagnostics();
        const { channel } = udpChannel(diag);
        await channel.connectionOpen({ address: '192.0.2.9' });
        await channel.startHeartbeat();
        assert.strictEqual(diag.snapshot().heartbeat.polling, true);
        (FakeSacpClient.heartbeat as (d: object) => void)(beat(0));
        const state = channel.getLatestMachineState();
        assert.strictEqual(state.status, 'idle');
        assert.strictEqual(state.pos, undefined, 'no coordinate subscription on this path: position honestly unknown');
    }],

    ['ConnectionManager hands the SACP state to the MCP unchanged and knows the channel speaks SACP', async () => {
        const diag = diagnostics();
        const { channel } = udpChannel(diag);
        await channel.connectionOpen({ address: '192.0.2.9' });
        const cm = connectionManager(channel, diag);
        assert.strictEqual(cm.getLatestMachineState(), null);
        assert.strictEqual(cm.isSacpChannel(), true);
        await channel.startHeartbeatLegacy(channel.sacpClient, undefined, 'ray-id');
        (FakeSacpClient.heartbeat as (d: object) => void)(beat(0));
        (FakeSacpClient.coordinates as (d: object) => void)(rayReport(-1, 399));
        const state = cm.getLatestMachineState();
        assert.strictEqual(state, channel.getLatestMachineState(), 'the very object the channel keeps');
        assert.deepStrictEqual(state.pos, { x: -1, y: 399, z: 0, b: null, isFourAxis: false });
        assert.strictEqual(typeof state.timestamp, 'number');
        // The HTTP-only recovery says why it refuses here.
        await assert.rejects(cm.recoverMachineConnection(), /speaks SACP.*reconnect the machine through Luban/);
        cm.protocol = 'HTTP';
        assert.strictEqual(cm.isSacpChannel(), false);
        cm.channel = null;
        assert.strictEqual(cm.getLatestMachineState(), null);
        assert.strictEqual(cm.isSacpChannel(), false);
    }],

    ['Ray connect: the channel keeps 0x01 0x21\'s version and efuse SN (no extra request), the manager adopts the SN, the level result is recorded', async () => {
        const head = Buffer.from([4, 1, 0x66, 0x66, 0x66, 0x66]);
        const str = (text: string) => Buffer.concat([Buffer.from([text.length, 0]), Buffer.from(text, 'latin1')]);
        FakeSacpClient.serialNumber = 0x66666666;
        FakeSacpClient.machineType = 5;
        FakeSacpClient.machineInfoData = Buffer.concat([head, str('V1.7.4'), str('RAY20AB1234567890123')]);
        try {
            const diag = diagnostics();
            const { channel } = udpChannel(diag);
            class RayStub {
                public setChannel(): void { /* the harness channel */ }

                public setSocket(): void { /* no UI */ }

                public async onPrepare(): Promise<void> { /* prepared */ }
            }
            const cm = connectionManager(channel, diag, { './channels/sacpMachineState': sacpMachineState, './instances': { RayMachineInstance: RayStub } });
            cm.bindChannelEvents();
            await channel.connectionOpen({ address: '192.0.2.9' });
            const info = channel.getMachineInfoRecord();
            assert.strictEqual(info.firmwareVersion, 'V1.7.4');
            assert.strictEqual(info.productSn, 'RAY20AB1234567890123');
            assert.strictEqual(typeof info.readAt, 'number');
            const status = cm.getConnectionStatus();
            assert.strictEqual(status.deviceSerial, 'RAY20AB1234567890123', 'the dummy u32 is dropped, the efuse SN adopted at Ready');
            assert.strictEqual(status.deviceSerialSource, 'sacp-product-sn');
            assert.strictEqual(cm.getMachineInfoRecord().firmwareVersion, 'V1.7.4');
            assert.strictEqual(channel.getLogLevelRequest(), null, 'no level request before the legacy heartbeat');
            await channel.startHeartbeatLegacy(channel.sacpClient, undefined, 'ray-id');
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(cm.getLogLevelRequest().result, 1, 'what the controller answered Luban\'s 0x01 0x10, recorded only');
            // A new session forgets both (generation-bound, in memory only).
            channel.bumpConnectionGeneration('test: new session');
            assert.strictEqual(channel.getMachineInfoRecord(), null);
            assert.strictEqual(channel.getLogLevelRequest(), null);
            // An unprogrammed efuse is no identity; a real u32 serial is never replaced.
            FakeSacpClient.machineInfoData = Buffer.concat([head, str('V1.7.4'), str('6'.repeat(20))]);
            await channel.connectionOpen({ address: '192.0.2.9' });
            assert.strictEqual(cm.getConnectionStatus().deviceSerial, null);
            assert.strictEqual(channel.getMachineInfoRecord().productSnRaw, '6'.repeat(20));
            FakeSacpClient.serialNumber = 20481234;
            FakeSacpClient.machineInfoData = Buffer.concat([head, str('V1.7.4'), str('RAY20AB1234567890123')]);
            await channel.connectionOpen({ address: '192.0.2.9' });
            assert.strictEqual(cm.getConnectionStatus().deviceSerial, '20481234');
            assert.strictEqual(cm.getConnectionStatus().deviceSerialSource, 'sacp-machine-info');
            // Only the Ray: another machine's trailing bytes are never adopted as its identity.
            FakeSacpClient.serialNumber = 0x66666666;
            FakeSacpClient.machineType = 0;
            await channel.connectionOpen({ address: '192.0.2.9' });
            assert.strictEqual(cm.getConnectionStatus().deviceSerial, null);
        } finally {
            FakeSacpClient.machineType = 0;
            FakeSacpClient.serialNumber = undefined;
            FakeSacpClient.machineInfoData = null;
        }
    }],

    // ---- MCP file jobs over SACP-UDP (#328) ----
    ['#328 the UDP channel declares the Ray\'s operator-switch file transport and uploads the job as ray.nc by the compressed transfer', async () => {
        const diag = diagnostics();
        const { channel, timers } = udpChannel(diag);
        await channel.connectionOpen({ address: '192.0.2.9' });
        const transport = channel.fileJobTransport();
        assert.deepStrictEqual({ start: transport.start, target: transport.target, stop: transport.stop },
            { start: 'operator-switch', target: 'ray.nc', stop: 'file-print-only' });
        assert.match(transport.instruction, /Press and hold the work switch/);
        assert.match(transport.instruction, /SHORT press runs the controller boundary\.nc/);
        FakeSacpClient.uploads = [];
        FakeSacpClient.uploadResult = true;
        timers.pending.length = 0;
        const result = await new Promise<{ msg: string | null; outcome: { target?: string } }>((resolve) => {
            channel.uploadGcodeFile('/jobs/8595d76f9e33_ladder.nc', 'laser', 'ladder.nc', (msg: string | null, outcome: { target?: string }) => resolve({ msg, outcome }));
        });
        assert.strictEqual(result.msg, null);
        assert.deepEqual(result.outcome, { target: 'ray.nc' }); // vm-context object: loose equality
        assert.strictEqual(FakeSacpClient.uploads.length, 1);
        assert.strictEqual(FakeSacpClient.uploads[0].filePath, '/jobs/8595d76f9e33_ladder.nc');
        assert.strictEqual(FakeSacpClient.uploads[0].renderName, 'ray.nc', 'the only file the work switch starts, whatever the job is called');
        assert.ok(timers.pending.some((timer) => timer.ms === 30000), 'the inactivity watchdog was armed');
    }],

    ['#328 an upload the controller refuses is a definite rejection; one that never answers is uncertain after 30 s of silence', async () => {
        const diag = diagnostics();
        const { channel, timers } = udpChannel(diag);
        await channel.connectionOpen({ address: '192.0.2.9' });
        FakeSacpClient.uploads = [];
        FakeSacpClient.uploadResult = false;
        FakeSacpClient.uploadFailure = 'SD card unavailable.';
        const refused = await new Promise<{ msg: string | null; outcome: object }>((resolve) => {
            channel.uploadGcodeFile('/jobs/x.nc', 'laser', 'x.nc', (msg: string | null, outcome: object) => resolve({ msg, outcome }));
        });
        assert.strictEqual(refused.msg, 'SD card unavailable.');
        assert.deepEqual(refused.outcome, { rejected: true });
        FakeSacpClient.uploadFailure = null;
        FakeSacpClient.uploadResult = null; // the 0xB0 0x02 result never arrives
        timers.pending.length = 0;
        let silent: { msg: string | null; outcome: object } | null = null;
        channel.uploadGcodeFile('/jobs/y.nc', 'laser', 'y.nc', (msg: string | null, outcome: object) => { silent = { msg, outcome }; });
        assert.strictEqual(silent, null, 'nothing yet');
        const watchdog = timers.pending.filter((timer) => timer.ms === 30000).pop();
        assert.ok(watchdog, 'the watchdog is armed');
        // Progress re-arms it (a long file is not a silent one)...
        FakeSacpClient.uploads[FakeSacpClient.uploads.length - 1].options.onProgress?.(0.5);
        assert.ok(timers.pending.filter((timer) => timer.ms === 30000).length >= 2, 're-armed on progress');
        // ...and when it fires, the outcome is uncertain: the controller may hold the file.
        watchdog.fn();
        assert.ok(silent, 'the watchdog ended the wait');
        assert.match((silent as unknown as { msg: string }).msg, /no reply from the controller for 30 s/);
        assert.deepEqual((silent as unknown as { outcome: object }).outcome, { uncertain: true });
        FakeSacpClient.uploadResult = true;
    }],

    ['Ray frame: boundary.nc is sent only when this connection has not already put the same bytes there; ray.nc always goes', async () => {
        const diag = diagnostics();
        const { channel } = udpChannel(diag);
        await channel.connectionOpen({ address: '192.0.2.9' });
        FakeSacpClient.uploads = []; FakeSacpClient.uploadResult = true; FakeSacpClient.uploadFailure = null;
        const write = (name: string, text: string) => { const file = path.join(UDP_TMP_DIR, name); fs.writeFileSync(file, text); return file; };
        const a = write('frame-a.nc', 'G90\nG1 S0 X1 Y1 F6000\n;End');
        const aCopy = write('frame-a-copy.nc', 'G90\nG1 S0 X1 Y1 F6000\n;End');
        const b = write('frame-b.nc', 'G90\nG1 S0 X2 Y2 F6000\n;End');
        const send = (filePath: string, targetFilename = 'boundary.nc') => channel.compressUploadFile({ filePath, targetFilename });
        assert.strictEqual(await send(a), true);
        assert.strictEqual(FakeSacpClient.uploads.length, 1);
        assert.strictEqual(FakeSacpClient.uploads[0].renderName, 'boundary.nc');
        assert.strictEqual(await send(aCopy), true, 'the same bytes under another local name: success, nothing sent');
        assert.strictEqual(FakeSacpClient.uploads.length, 1);
        assert.strictEqual(await send(b), true);
        assert.strictEqual(await send(a), true, 'back to the first frame: it is no longer what the controller holds');
        assert.strictEqual(FakeSacpClient.uploads.length, 3);
        // The job itself is never deduplicated.
        await send(a, 'ray.nc'); await send(a, 'ray.nc');
        assert.strictEqual(FakeSacpClient.uploads.length, 5);
        // A reconnect forgets what was sent: the controller may have changed meanwhile.
        await channel.connectionClose();
        await channel.connectionOpen({ address: '192.0.2.9' });
        assert.strictEqual(await send(a), true);
        assert.strictEqual(FakeSacpClient.uploads.length, 6, 'a new connection re-sends');
        // A refused transfer leaves it unknown: the next identical frame is sent, and the refusal is reported.
        FakeSacpClient.uploadResult = false; FakeSacpClient.uploadFailure = 'SD card unavailable.';
        const failures: string[] = [];
        assert.strictEqual(await channel.compressUploadFile({ filePath: b, targetFilename: 'boundary.nc', onFailed: (r: string) => failures.push(r) }), false);
        assert.deepStrictEqual(failures, ['SD card unavailable.']);
        FakeSacpClient.uploadResult = true; FakeSacpClient.uploadFailure = null;
        assert.strictEqual(await send(b), true);
        assert.strictEqual(FakeSacpClient.uploads.length, 8);
        assert.strictEqual(await send(b), true);
        assert.strictEqual(FakeSacpClient.uploads.length, 8, 'now current again');
    }],

    ['Ray frame: Luban\'s Upload Job / Run Boundary socket path gets the dedupe too, and still reports success', async () => {
        const diag = diagnostics();
        const { channel } = udpChannel(diag);
        await channel.connectionOpen({ address: '192.0.2.9' });
        const cm = connectionManager(channel, diag, {
            path,
            fs,
            '../../DataStorage': { tmpDir: UDP_TMP_DIR },
            '../../../app/communication/socket-events': { __esModule: true, default: { CompressUploadFile: 'connection:compress-upload-file' } },
        });
        FakeSacpClient.uploads = []; FakeSacpClient.uploadResult = true; FakeSacpClient.uploadFailure = null;
        const file = path.join(UDP_TMP_DIR, 'ui-boundary.nc');
        fs.writeFileSync(file, 'G90\nG1 S0 X5 Y5 F6000\n;End');
        const emitted: Array<[string, unknown]> = [];
        const socket = { emit: (event: string, data?: unknown) => { emitted.push([event, data]); } };
        await cm.compressUploadFile(socket, { filePath: file, targetFilename: 'boundary.nc' });
        await cm.compressUploadFile(socket, { filePath: file, targetFilename: 'boundary.nc' });
        assert.strictEqual(FakeSacpClient.uploads.length, 1, 'the second identical frame is not transferred');
        const results = emitted.filter(([event]) => event === 'connection:compress-upload-file');
        assert.strictEqual(results.length, 2, `two results reported: ${JSON.stringify(emitted)}`);
        for (const [, data] of results) {
            assert.strictEqual((data as { err: unknown }).err, null, 'both report success to the renderer');
        }
    }],

    ['Ray frame: an MCP job is framed from its Luban header with Luban\'s Run Boundary G-code (control-panel form), once', async () => {
        const diag = diagnostics();
        const { channel } = udpChannel(diag);
        await channel.connectionOpen({ address: '192.0.2.9' });
        FakeSacpClient.uploads = []; FakeSacpClient.uploadResult = true; FakeSacpClient.uploadFailure = null;
        const job = path.join(UDP_TMP_DIR, 'job-header.nc');
        fs.writeFileSync(job, [';Header Start', ';header_type: laser', ';machine: Ray', ';is_rotate: false', ';max_x(mm): 110.77699999999999',
            ';max_y(mm): 54.291000000000004', ';max_b(mm): 0', ';min_x(mm): 1', ';min_y(mm): 0.9990000000000023', ';min_b(mm): 0',
            'M2003', 'M2004', ';Header End', 'G90', 'G1 X1 Y1 S1000', 'M5'].join('\n'));
        const sentFrames: string[] = [];
        const realUpload = FakeSacpClient.prototype.uploadFileCompressed;
        FakeSacpClient.prototype.uploadFileCompressed = async function capture(filePath: string, options: object) {
            sentFrames.push(fs.readFileSync(filePath, 'utf8'));
            return realUpload.call(this, filePath, options);
        };
        try {
            const first = await channel.uploadJobBoundary(job, { x: { min: 0, max: 1 }, y: { min: 0, max: 1 } });
            assert.strictEqual(first.status, 'uploaded', JSON.stringify(first));
            assert.strictEqual(first.target, 'boundary.nc');
            assert.strictEqual(first.basis, 'header', 'the header wins over the validator extents, as the renderer frames it');
            assert.deepEqual(first.frame,
                { min_x: 1, max_x: 110.77699999999999, min_y: 0.9990000000000023, max_y: 54.291000000000004, axis: 'x', mode: 'crosshair' });
            assert.strictEqual(FakeSacpClient.uploads[0].renderName, 'boundary.nc');
            const box = { min: { x: 1, y: 0.9990000000000023, b: 0 }, max: { x: 110.77699999999999, y: 54.291000000000004, b: 0 } };
            const expected = rayBoundary.getRunBoundaryCode(box, 'Crosshair', false, 'control-panel');
            assert.strictEqual(sentFrames[0], expected);
            assert.ok(sentFrames[0].startsWith(';motor_mode: 3\nM2000 L13 P1\nG90\nG1 S0 X1 Y0.9990000000000023 F6000'), sentFrames[0]);
            const again = await channel.uploadJobBoundary(job, null);
            assert.strictEqual(again.status, 'unchanged');
            assert.strictEqual(FakeSacpClient.uploads.length, 1, 'the same job again sends nothing');
            // A file with no Luban header falls back to the validator's work-frame extents (Crosshair, the Ray default).
            const bare = path.join(UDP_TMP_DIR, 'job-bare.nc');
            fs.writeFileSync(bare, 'G90\nG1 X10 Y20 S500\nG1 X30 Y40\nM5');
            const fallback = await channel.uploadJobBoundary(bare, { x: { min: 10, max: 30 }, y: { min: 20, max: 40 } });
            assert.strictEqual(fallback.status, 'uploaded');
            assert.strictEqual(fallback.basis, 'extents');
            assert.match(sentFrames[1],
                /G1 S0 X10 Y20 F6000\nG1 S0 X30 Y20 F6000\nG1 S0 X30 Y40 F6000\nG1 S0 X10 Y40 F6000\nG1 S0 X10 Y20 F6000\nG1 S0 X20 Y30 F6000/);
            const none = await channel.uploadJobBoundary(bare, null);
            assert.strictEqual(none.status, 'not-framed');
            const missing = await channel.uploadJobBoundary(path.join(UDP_TMP_DIR, 'no-such-job.nc'), null);
            assert.strictEqual(missing.status, 'failed');
            assert.match(missing.reason, /cannot read the job file/);
            FakeSacpClient.uploadResult = false; FakeSacpClient.uploadFailure = 'SD card unavailable.';
            const refused = await channel.uploadJobBoundary(job, null);
            assert.strictEqual(refused.status, 'failed', 'the controller refused: reported, with its reason');
            assert.strictEqual(refused.reason, 'SD card unavailable.');
        } finally {
            FakeSacpClient.prototype.uploadFileCompressed = realUpload;
            FakeSacpClient.uploadResult = true; FakeSacpClient.uploadFailure = null;
        }
    }],

    ['#328 stopGcodeJob is the SACP job stop (0xAC 0x06) Luban\'s own Stop sends, reported as ok/refused', async () => {
        const diag = diagnostics();
        const { channel } = udpChannel(diag);
        await channel.connectionOpen({ address: '192.0.2.9' });
        FakeSacpClient.stopRequests = 0;
        FakeSacpClient.stopResult = 0;
        const ok = await channel.stopGcodeJob();
        assert.strictEqual(ok.ok, true);
        assert.match(ok.text, /0xAC 0x06/);
        FakeSacpClient.stopResult = 9;
        const refused = await channel.stopGcodeJob();
        assert.strictEqual(refused.ok, false);
        assert.strictEqual(FakeSacpClient.stopRequests, 2);
        FakeSacpClient.stopResult = 0;
    }],

    ['#328 the job-progress subscription fills gcodePrintingInfo (name from 0xAC 0x1A, line from 0xAC 0xA0) in the MCP\'s state', async () => {
        const diag = diagnostics();
        const { channel } = udpChannel(diag);
        await channel.connectionOpen({ address: '192.0.2.9' });
        await channel.startHeartbeatLegacy(channel.sacpClient, undefined, 'ray-id');
        FakeSacpClient.lineNumber = null;
        await channel.subscribeGetPrintCurrentLineNumber();
        assert.ok(FakeSacpClient.lineNumber, 'subscribed to the current line');
        (FakeSacpClient.heartbeat as (d: object) => void)(beat(0));
        assert.strictEqual(channel.getLatestMachineState().gcodePrintingInfo, undefined, 'nothing before a progress report');
        // The run starts: the heartbeat's idle -> running edge re-reads the file info (name, total lines).
        (FakeSacpClient.heartbeat as (d: object) => void)(beat(1));
        await new Promise((resolve) => setImmediate(resolve));
        (FakeSacpClient.lineNumber as (d: object) => void)({ response: { data: { currentLine: 21 } } });
        const state = channel.getLatestMachineState();
        assert.deepStrictEqual(state.gcodePrintingInfo, { name: '/ray.nc', sent: 21, total: 84, progress: 0.25 });
        assert.strictEqual(state.status, 'running');
        // The progress report does not move the beat clock; the next heartbeat keeps the info.
        const stamped = state.timestamp;
        (FakeSacpClient.heartbeat as (d: object) => void)(beat(1));
        assert.ok(channel.getLatestMachineState().timestamp >= stamped);
        assert.deepStrictEqual(channel.getLatestMachineState().gcodePrintingInfo, { name: '/ray.nc', sent: 21, total: 84, progress: 0.25 });
        await channel.stopHeartbeat('ray-id');
        assert.strictEqual(channel.getLatestMachineState(), null, 'cleared with the rest of the state');
    }],

    ['the UDP channel\'s own home reports the controller\'s acceptance', async () => {
        const diag = diagnostics();
        const { channel } = udpChannel(diag);
        await channel.connectionOpen({ address: '192.0.2.9' });
        FakeSacpClient.homeRequests = 0;
        FakeSacpClient.homeResult = 0;
        assert.strictEqual(await channel.goHome(), true);
        FakeSacpClient.homeResult = 2;
        assert.strictEqual(await channel.goHome(), false);
        assert.strictEqual(FakeSacpClient.homeRequests, 2);
    }],

    ['device identity: the SACP serial number reaches getConnectionStatus().deviceSerial (host null), cleared on close and on loss', async () => {
        assert.strictEqual(sacpMachineState.sacpDeviceSerial({ masterControlSerialNumber: 0 }), null, '0 is no serial');
        assert.strictEqual(sacpMachineState.sacpDeviceSerial({}), null);
        assert.strictEqual(sacpMachineState.sacpDeviceSerial(null), null);
        assert.strictEqual(sacpMachineState.sacpDeviceSerial({ masterControlSerialNumber: Number.NaN }), null);
        const diag = diagnostics();
        const { channel } = udpChannel(diag);
        const cm = connectionManager(channel, diag);
        cm.bindChannelEvents();
        const ready: Array<{ deviceSerial?: unknown }> = [];
        channel.on(events.Ready, (data: { deviceSerial?: unknown }) => ready.push(data));
        FakeSacpClient.serialNumber = 20481234;
        try {
            assert.strictEqual(cm.getConnectionStatus().deviceSerial, null, 'nothing before Ready');
            await channel.connectionOpen({ address: '192.0.2.9' });
            assert.strictEqual(ready[0].deviceSerial, '20481234', 'a string in the Ready payload');
            let status = cm.getConnectionStatus();
            assert.strictEqual(status.deviceSerial, '20481234');
            assert.strictEqual(status.host, null, 'SACP has no SSTP host');
            assert.ok(!JSON.stringify(status).includes('token'), 'no token in the status');

            // A Ready without a serial (text serial, or a controller reporting 0) replaces it, never inherits.
            channel.emit(events.Ready, { machineIdentifier: 'Original' });
            assert.strictEqual(cm.getConnectionStatus().deviceSerial, null);
            channel.emit(events.Ready, { machineIdentifier: 'no instance', deviceSerial: '20481234' });
            assert.strictEqual(cm.getConnectionStatus().deviceSerial, '20481234');

            // The position judge's view of the connection (machinePosition.ts JudgeConnectionContext).
            assert.deepStrictEqual({ ...cm.getJudgeConnectionContext() }, { session: cm.getConnectionGeneration(), positionFrame: null });
            const logicalChannel = { getLatestMachineState: () => ({ timestamp: 1, positionFrame: 'logical' }) };
            cm.channel = logicalChannel;
            assert.strictEqual(cm.getJudgeConnectionContext().positionFrame, 'logical', 'text serial reports the logical frame');
            cm.channel = null;
            assert.deepStrictEqual({ ...cm.getJudgeConnectionContext() }, { session: null, positionFrame: null });
            cm.channel = channel;

            // A transport loss clears it with machineIdentifier.
            channel.emit(events.Disconnected);
            status = cm.getConnectionStatus();
            assert.strictEqual(status.connected, false);
            assert.strictEqual(status.deviceSerial, null);
            assert.strictEqual(status.host, null);
            assert.strictEqual(status.machineIdentifier, null);

            // So does an explicit close.
            cm.channel = channel;
            cm.bindChannelEvents();
            channel.emit(events.Ready, { machineIdentifier: 'no instance', deviceSerial: '20481234' });
            assert.strictEqual(cm.getConnectionStatus().deviceSerial, '20481234');
            await cm.connectionClose({ emit: () => undefined }, {});
            assert.strictEqual(cm.getConnectionStatus().deviceSerial, null, 'cleared on close');
        } finally {
            FakeSacpClient.serialNumber = undefined;
        }
    }],
];
