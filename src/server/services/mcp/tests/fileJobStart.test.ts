/* eslint-disable camelcase */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import * as fileStart from '../fileJobStart';
import * as jobEnding from '../jobEnding';
import type { McpJob } from '../jobs';
import { frameRestoreJobRefusal } from '../frameRecovery';
import { McpToolError } from '../registry';
import { DialectId, dialectById } from '../gcodeDialect';
import { toolheadStubs } from './fixtures/toolheadStubs';
import { isolatedModule } from './jobDashboard.test';
import { managerFixture } from './jobModalRecovery.test';

// Exercise the registered tool with the real job manager and a fake clock,
// channel and heartbeat. No machine/server/network access.
// Channel shapes: 'file+direct' is the A350 over Wi-Fi (SstpHttpChannel: file
// upload/start AND executeGcode); 'direct-only' is the Original (TextSerialChannel)
// or the Ray over USB: executeGcode, no file-job path; 'ray-switch' is the Ray
// over Wi-Fi since #328 (SacpUdpChannel: executeGcode, a compressed upload to
// ray.nc, a file-print-only stop and an operator-switch start - no start command).
type ChannelShape = 'file+direct' | 'direct-only' | 'ray-switch' | 'none';

/** The Ray's transport exactly as SacpUdpChannel.fileJobTransport declares it. */
const RAY_TRANSPORT: fileStart.FileJobTransport = {
    start: 'operator-switch',
    target: 'ray.nc',
    instruction: 'Press and hold the work switch for about 3 seconds. A SHORT press runs the controller boundary.nc.',
    holdInstruction: 'Press and hold the work switch for about 3 seconds.',
    stop: 'file-print-only',
};

type BoundaryUpload = (filePath: string, extents: unknown) => Promise<fileStart.BoundaryRefresh>;

/** `machine` 'ray' loads the Ray's dialect row, whose motor-power mode is read through `readMotorPowerMode` (#321). */
/**
 * The judged position getPositionSnapshot reports (#323: a direct job records it
 * at staging and a relative-steps start compares it); setPosition moves it.
 */
export interface FixturePosition {
    machine: { x: number | null; y: number | null; z: number | null };
    reliability: string;
    isHomed: boolean | null;
    connectedMachine: { hasZ: boolean };
}

export function fixture(shape: ChannelShape = 'file+direct',
    machine: { dialect?: DialectId; readMotorPowerMode?: () => Promise<unknown>; uploadJobBoundary?: BoundaryUpload } = {}) {
    const dialect = dialectById(machine.dialect || 'sm2-marlin');
    let position: FixturePosition = {
        machine: { x: 1, y: 399, z: 0 }, reliability: 'heartbeat', isHomed: true, connectedMachine: { hasZ: dialect.id !== 'ray-grbl' },
    };
    const files = new Map<string, string>();
    const manager = managerFixture(files);
    let now = Date.now();
    let tick: (() => void) | null = null;
    let onSleep = () => undefined;
    let report: fileStart.FileStartReport | null = { status: 'idle', timestamp: now };
    let otherChannel = false;
    let generation = '1.0';
    let uploads = 0;
    let starts = 0;
    let telemetry = 0;
    let vibrations = 0;
    let stops = 0;
    let start: () => Promise<{ ok: boolean; text?: string; notSent?: boolean }> = async () => ({ ok: true });
    let upload: (callback: (msg: unknown, outcome?: fileStart.FileJobUploadOutcome) => void) => void = (callback) => callback(null);
    const executed: string[] = [];
    /** What each uploadGcodeFile call was asked for (the Ray channel renames to ray.nc itself; the MCP must still pass the job's name). */
    const uploadRequests: Array<{ path: string; head: string; name: string }> = [];
    const fileApi = {
        uploadGcodeFile: (filePath: string, head: string, name: string, callback: (msg: unknown, outcome?: fileStart.FileJobUploadOutcome) => void) => {
            uploads++; uploadRequests.push({ path: filePath, head, name }); upload(callback);
        },
        startGcodeJob: async () => { starts++; return start(); },
        stopGcodeJob: async () => { stops++; return { ok: true }; },
    };
    // The Ray over SACP-UDP: upload and stop, NO startGcodeJob, and the transport that says why.
    const rayApi = {
        uploadGcodeFile: fileApi.uploadGcodeFile,
        stopGcodeJob: fileApi.stopGcodeJob,
        fileJobTransport: () => RAY_TRANSPORT,
        // The channel's job frame (SacpUdpChannel.uploadJobBoundary), only when the test supplies one.
        ...(machine.uploadJobBoundary ? { uploadJobBoundary: machine.uploadJobBoundary } : {}),
    };
    // Runs while a direct step's send is in flight (a stop pressed mid-step, #320).
    let onExecute: () => Promise<void> = async () => undefined;
    const executeGcode = async (gcode: string) => { executed.push(gcode); await onExecute(); return { result: 0, text: 'ok' }; };
    const channel = { 'file+direct': { ...fileApi, executeGcode }, 'direct-only': { executeGcode }, 'ray-switch': { ...rayApi, executeGcode }, none: {} }[shape];
    const dependencies: Record<string, unknown> = {};
    const source = fs.readFileSync(path.join(__dirname, '../tools/gcode.ts'), 'utf8');
    for (const match of source.matchAll(/from '([^']+)'/g)) dependencies[match[1]] = {};
    Object.assign(dependencies, {
        'fs-extra': { readFileSync: (name: string) => files.get(name) },
        '../../../lib/logger': () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
        '../../machine/ConnectionManager': { connectionManager: {
            getCurrentChannel: () => (otherChannel ? {} : channel),
            getLatestMachineState: () => report,
            getConnectionGeneration: () => generation,
        } },
        '../jobs': { jobManager: manager, TERMINAL_JOB_STATES: jobEnding.TERMINAL_JOB_STATES, approvalHandoff: () => 'agent' },
        '../jobEnding': jobEnding,
        '../fileJobStart': fileStart,
        '../registry': { McpToolError },
        '../procedureLimits': { MAX_WAIT_MS: 120000 },
        '../probeFeed': { probeFeedService: { assertNoOvertravel: () => undefined } },
        '../spindleTelemetry': { spindleTelemetryService: { startForJob: () => { telemetry++; } } },
        '../vibrationCaptures': { vibrationCaptureService: { startForJob: () => { vibrations++; } } },
        './machine': { assertFreshHeartbeat: () => undefined, getPositionSnapshot: () => position },
        '../startPosition': require('../startPosition'),
        // WP4a: pure modules, the real ones.
        '../logicalFrame': require('../logicalFrame'),
        '../gcodeForms': require('../gcodeForms'),
        '../gcodeDialect': require('../gcodeDialect'),
        '../toolheadState': require('../toolheadState'),
        '../connectedMachine': {
            ...toolheadStubs(() => report as never, dialect, McpToolError, machine.readMotorPowerMode || null),
            connectedDialect: () => dialect,
            connectedMachineTag: () => `(machine: ${shape})`,
        },
        // The direct-step path (executeDirectStep): the send goes straight to the channel.
        './camera': {
            GcodeNotSentError: class GcodeNotSentError extends Error {},
            sendGcodeVisible: async (target: { executeGcode: typeof executeGcode }, _tool: string, payload: string) => target.executeGcode(payload),
        },
        '../traversePlan': { parseSettleComment: () => null },
    });
    const loaded = isolatedModule('tools/gcode.ts', dependencies, {
        Date: { now: () => now },
        setTimeout: (fn: () => void, ms: number) => { now += ms; onSleep(); fn(); },
        setInterval: (fn: () => void) => { tick = fn; return 1; },
        clearInterval: () => { tick = null; },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers: Record<string, (args: object) => Promise<any>> = {};
    loaded.registerGcodeTools({ register: (tool: { name: string; handler: typeof handlers[string] }) => { handlers[tool.name] = tool.handler; } }, () => 'http://localhost');
    const createJob = () => {
        const validation = { warnings: [], extents: {}, spindle: {}, motionLineCount: 1 } as unknown as McpJob['validation'];
        const job = manager.submit('G54\nG90\nG1 X1 F100\nM5', 'drill', 'cnc', validation);
        job.state = 'approved'; job.confirmToken = 'human'; job.approvedAt = Date.now();
        return job;
    };
    // An approved direct job as traverse_xy / goto_work_origin stage it on the Ray (M5 leads the step).
    const createDirectJob = (kind: 'direct' | 'procedure' = 'direct') => {
        const validation = { warnings: [], extents: {}, spindle: {}, motionLineCount: 1 } as unknown as McpJob['validation'];
        const job = manager.submit('; direct move\nM5\nG91\nG0 X10 Y0\nG90', 'traverse', 'cnc', validation, kind);
        job.state = 'approved'; job.confirmToken = 'human'; job.approvedAt = Date.now();
        return job;
    };
    // An approved direct BATCH (traverse_xy on the Ray): each step names its endpoint in a settle line.
    const createDirectBatch = (steps: string[]) => {
        const validation = { warnings: [], extents: {}, spindle: {}, motionLineCount: steps.length } as unknown as McpJob['validation'];
        const job = manager.submit(steps.join('\n; --- next approved step ---\n'), 'traverse', 'cnc', validation, 'direct', steps);
        job.state = 'approved'; job.confirmToken = 'human'; job.approvedAt = Date.now();
        return job;
    };
    return {
        manager,
        /** The loaded tools/gcode.ts (runPolicyApprovedDirectJob for the on-the-call paths, #326). */
        loaded,
        createJob,
        createDirectJob,
        createDirectBatch,
        setPosition: (change: Partial<FixturePosition> & { at?: Partial<FixturePosition['machine']> }) => {
            const { at, ...rest } = change;
            position = { ...position, ...rest, machine: { ...position.machine, ...(at || {}) } };
        },
        executed,
        uploadRequests,
        startDirect: async (job: McpJob) => handlers.start_gcode_job({ job_id: job.id, confirm_token: 'human', wait_until_moved: false }),
        submit: async (args: object) => handlers.submit_gcode_job(args),
        handlers,
        setStart: (fn: typeof start) => { start = fn; },
        setUpload: (fn: typeof upload) => { upload = fn; },
        setOnSleep: (fn: () => undefined) => { onSleep = fn; },
        setOnExecute: (fn: () => Promise<void>) => { onExecute = fn; },
        setReport: (status: string, name = 'drill.nc', timestamp?: number) => {
            now += 1000;
            report = { status, timestamp: timestamp ?? now, gcodePrintingInfo: { name, sent: 2, total: 5, progress: 0.4 } };
        },
        disconnect: () => { report = null; },
        reconnect: () => { otherChannel = true; },
        changeGeneration: () => { generation = '1.1'; },
        tick: () => { tick?.(); },
        counts: () => ({ uploads, starts, telemetry, vibrations, stops }),
        call: async (job: McpJob) => handlers.start_gcode_job({ job_id: job.id, confirm_token: 'human' }),
        stop: (job: McpJob) => loaded.stopGcodeJob({ job_id: job.id }),
    };
}

export const tests: Array<[string, () => void | Promise<void>]> = [
    ['lost response plus fresh running heartbeat adopts the run, tracks progress and completes once', async () => {
        const f = fixture(); const job = f.createJob();
        f.setStart(async () => { f.setReport('running'); return { ok: false, text: 'read ECONNRESET' }; });
        const result = await f.call(job);
        assert.equal(result.ok, true); assert.equal(result.retry_safe, false);
        assert.equal(job.state, 'started'); assert.ok(job.startedAt);
        assert.equal(job.startAttempt?.error, 'read ECONNRESET');
        assert.equal(job.modalTrack?.lastLine, 2);
        assert.ok(job.events.some((event) => event.phase === 'progress'));
        f.setReport('paused'); f.tick();
        assert.ok(job.events.some((event) => event.phase === 'paused'));
        f.setReport('idle'); f.tick(); f.tick(); f.tick();
        assert.equal(job.state, 'started', 'one cached idle report is not three reports');
        f.setReport('idle'); f.tick(); f.setReport('idle'); f.tick();
        assert.equal(job.state, 'completed'); assert.equal(f.manager.getActive(), null);
        assert.equal((await f.call(job)).retry_safe, false);
        assert.deepEqual(f.counts(), { uploads: 1, starts: 1, telemetry: 1, vibrations: 1, stops: 0 });
    }],
    ['delayed running heartbeat reconciles within the bounded wait', async () => {
        const f = fixture(); const job = f.createJob();
        f.setStart(async () => ({ ok: false, text: 'timeout' }));
        f.setOnSleep(() => { f.setReport('running'); return undefined; });
        assert.equal((await f.call(job)).ok, true);
        assert.equal(job.state, 'started');
        assert.equal(f.counts().starts, 1);
    }],
    ['idle alone remains unverified, blocks retries and competing jobs, and still allows stop', async () => {
        const f = fixture(); const job = f.createJob();
        f.setStart(async () => { f.setReport('idle'); throw new Error('socket hang up'); });
        const result = await f.call(job);
        assert.equal(result.ok, false); assert.equal(result.retry_safe, false);
        assert.equal(result.machine_status_after, 'idle');
        assert.equal(job.state, 'start_unverified'); assert.equal(job.startedAt, null); assert.equal(job.endedAt, null);
        assert.equal(f.manager.getActive(), job);
        assert.equal((await f.call(job)).retry_safe, false);
        await assert.rejects(f.call(f.createJob()), /still active/);
        assert.match(frameRestoreJobRefusal(job) || '', /start_unverified/);
        assert.equal(jobEnding.planJobStop('file', 'start_unverified').action, 'machine-stop');
        await f.stop(job);
        assert.equal(job.state, 'stopped'); assert.equal(f.manager.getActive(), null);
        assert.equal(f.counts().starts, 1); assert.equal(f.counts().stops, 1);
    }],
    ['late heartbeat after reconciliation timeout still adopts the run', async () => {
        const f = fixture(); const job = f.createJob();
        f.setStart(async () => { f.disconnect(); return { ok: false, text: 'ECONNRESET' }; });
        await f.call(job); assert.equal(job.state, 'start_unverified');
        f.setReport('running'); f.tick(); assert.equal(job.state, 'started');
        assert.equal(f.counts().telemetry, 1);
    }],
    ['a complete short run during a pending HTTP reply is tracked and never resurrected', async () => {
        const f = fixture(); const job = f.createJob();
        f.setStart(async () => {
            f.setReport('running'); f.tick();
            for (let i = 0; i < 3; i++) { f.setReport('idle'); f.tick(); }
            assert.equal(job.state, 'completed');
            return { ok: false, text: 'timeout' };
        });
        assert.equal((await f.call(job)).ok, true);
        assert.equal(job.state, 'completed'); assert.equal(f.manager.getActive(), null);
        assert.equal(f.counts().starts, 1);
    }],
    ['stale, different-file and reconnected reports never confirm an uncertain start', async () => {
        for (const mode of ['stale', 'different-file', 'reconnected', 'new-session']) {
            const f = fixture(); const job = f.createJob();
            f.setStart(async () => {
                f.setReport('running', mode === 'different-file' ? 'another.nc' : 'drill.nc', mode === 'stale' ? 1 : undefined);
                if (mode === 'reconnected') f.reconnect();
                if (mode === 'new-session') f.changeGeneration();
                return { ok: false, text: 'ECONNRESET' };
            });
            await f.call(job);
            assert.equal(job.state, 'start_unverified', mode);
            assert.equal(f.counts().telemetry, 0, mode);
        }
    }],
    ['known pre-send refusal is failed and safe to restage only with new approval', async () => {
        const f = fixture(); const job = f.createJob();
        f.setStart(async () => ({ ok: false, text: 'lease held', notSent: true }));
        assert.equal((await f.call(job)).retry_safe, true);
        assert.equal(job.state, 'start_failed'); assert.equal(f.manager.getActive(), null);
        assert.equal((await f.call(job)).retry_safe, false, 'same job never replays');
        assert.equal(f.counts().starts, 1);
    }],
    ['stop during upload prevents start; stop during pending start is never resurrected', async () => {
        for (const phase of ['upload', 'start']) {
            const f = fixture(); const job = f.createJob();
            if (phase === 'upload') {
                f.setUpload((callback) => { f.stop(job).then(() => callback(null)); });
            } else {
                f.setStart(async () => { await f.stop(job); return { ok: true }; });
            }
            await f.call(job);
            assert.equal(job.state, 'stopped'); assert.equal(f.manager.getActive(), null);
            assert.equal(f.counts().starts, phase === 'upload' ? 0 : 1);
            assert.equal(f.counts().telemetry, 0);
        }
    }],
    ['ordinary acknowledged start attaches telemetry once and completes', async () => {
        const f = fixture(); const job = f.createJob();
        assert.equal((await f.call(job)).ok, true);
        assert.equal(job.state, 'started'); assert.equal(job.startAttempt?.acknowledged, true);
        f.setReport('running'); f.tick();
        for (let i = 0; i < 3; i++) { f.setReport('idle'); f.tick(); }
        assert.equal(job.state, 'completed'); assert.equal(f.counts().telemetry, 1);
    }],
    ['classification rejects pre-request, future and expired reports', () => {
        for (const timestamp of [100, 20000, -10000]) {
            assert.equal(fileStart.fileStartEvidence({ status: 'running', timestamp }, 100, 1000, true, 'drill.nc'), 'unknown');
        }
        assert.equal(fileStart.fileStartEvidence({ status: 'running', timestamp: 200 }, 100, 1000, true, 'drill.nc'), 'active');
        const report = { status: 'running', timestamp: 200, gcodePrintingInfo: { total: 208 } };
        assert.equal(fileStart.fileStartEvidence(report, 100, 1000, true, 'drill.nc', 208), 'active');
        assert.equal(fileStart.fileStartEvidence(report, 100, 1000, true, 'drill.nc', 500), 'unknown');
    }],
    // Live 2026-10-19 on the Ray (jobs 36fa11c67b4e, 7a19f87b186a): every approved
    // direct job was refused at start by the file-upload check.
    ['executeGcode-only channel (Ray, Original): an approved direct job runs through the direct-step path', async () => {
        const f = fixture('direct-only'); const job = f.createDirectJob();
        const result = await f.startDirect(job);
        assert.equal(job.state, 'completed', JSON.stringify(result));
        assert.equal(f.executed.length, 1);
        assert.match(f.executed[0], /^M5\n/, 'the staged M5 still leads the step');
        assert.ok(!/^;/m.test(f.executed[0]), 'comment lines are not sent');
        assert.equal(f.counts().uploads, 0); assert.equal(f.counts().starts, 0);
    }],
    ['executeGcode-only channel still refuses a FILE job, before the approval is consumed, naming the channel and machine', async () => {
        const f = fixture('direct-only'); const job = f.createJob();
        await assert.rejects(f.call(job),
            /File jobs cannot be started over the connected channel \(unnamed channel\) \(machine: direct-only\): it has no MCP file upload/);
        assert.equal(job.state, 'approved'); assert.equal(job.confirmToken, 'human'); assert.ok(!job.tokenUsed);
        assert.equal(f.executed.length, 0); assert.equal(f.counts().uploads, 0);
    }],
    // #328: live 2026-10-20 (job 8595d76f9e33) a Ray laser job was staged, validated and
    // approved, and only start_gcode_job refused it. The refusal now comes at staging.
    ['#328: submit_gcode_job REFUSES at staging on a channel that cannot start file jobs, so no approval is ever asked for', async () => {
        for (const shape of ['direct-only', 'none'] as const) {
            const f = fixture(shape);
            const before = f.manager.dashboardJobs().length;
            await assert.rejects(f.submit({ gcode: 'G54\nG90\nG1 X1 F100\nM5', name: 'ladder', frame: 'work', head_type: 'laser' }),
                /submit_gcode_job refused: File jobs cannot be started over the connected channel \(unnamed channel\) \(machine: .*\)/, shape);
            assert.equal(f.manager.dashboardJobs().length, before, `${shape}: nothing staged`);
        }
    }],
    ['#328 Ray: start uploads to the controller (the job\'s own name requested; the channel renames to ray.nc), sends no start, and the job is ARMED', async () => {
        const f = fixture('ray-switch', { dialect: 'ray-grbl', readMotorPowerMode: async () => 3 }); const job = f.createJob();
        const result = await f.call(job);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.armed, true);
        assert.equal(result.retry_safe, false);
        assert.equal(result.operator_start.target, 'ray.nc');
        assert.match(result.note, /ARMED; nothing was started/);
        assert.equal(job.state, 'armed'); assert.equal(job.startedAt, null);
        assert.deepEqual(f.counts(), { uploads: 1, starts: 0, telemetry: 0, vibrations: 0, stops: 0 });
        assert.deepEqual(f.uploadRequests, [{ path: job.filePath, head: 'cnc', name: 'drill.nc' }]);
        assert.equal(job.startAttempt?.acknowledged, false);
        assert.equal(job.startAttempt?.operatorStart?.target, 'ray.nc');
        assert.ok(job.events.some((e) => e.phase === 'uploaded') && job.events.some((e) => e.phase === 'armed'));
        assert.equal(f.manager.getActive(), job, 'an armed job holds the machine');
        // Idle beats NEVER complete an armed job (the A350 path completes a never-seen-active job after 20 idle polls).
        for (let i = 0; i < 30; i++) { f.setReport('idle', '/ray.nc'); f.tick(); }
        assert.equal(job.state, 'armed');
        // A second start sends nothing and says it is armed; another job cannot start meanwhile.
        const again = await f.call(job);
        assert.equal(again.ok, false); assert.equal(again.armed, true); assert.equal(f.counts().uploads, 1);
        await assert.rejects(f.call(f.createJob()), /is armed on the controller/);
        // The operator presses the switch: SYSTEM_STATUS_STARTING, then running for /ray.nc (the SD path the firmware reports).
        f.setReport('starting', '/ray.nc'); f.tick();
        assert.equal(job.state, 'started', 'a fresh starting beat for ray.nc adopts the run');
        assert.ok(job.startedAt);
        assert.match(String(job.events.find((e) => e.phase === 'started')?.note), /operator started it at the machine/);
        f.setReport('running', '/ray.nc'); f.tick();
        assert.ok(job.events.some((e) => e.phase === 'progress'));
        assert.equal(job.modalTrack?.lastLine, 2);
        for (let i = 0; i < 3; i++) { f.setReport('idle', '/ray.nc'); f.tick(); }
        assert.equal(job.state, 'completed'); assert.equal(f.manager.getActive(), null);
        assert.equal(f.counts().telemetry, 1);
    }],
    ['Ray frame: after ray.nc the start uploads the job\'s frame and says a short press runs it', async () => {
        const calls: Array<{ filePath: string; extents: unknown }> = [];
        const frame = { min_x: 1, max_x: 110.8, min_y: 1, max_y: 54.3, axis: 'x' as const, mode: 'crosshair' };
        const f = fixture('ray-switch', { dialect: 'ray-grbl',
            readMotorPowerMode: async () => 3,
            uploadJobBoundary: async (filePath, extents) => {
                calls.push({ filePath, extents });
                return { status: 'uploaded', target: 'boundary.nc', reason: null, basis: 'header', frame };
            } });
        const job = f.createJob();
        job.validation.extents = { x: { min: 1, max: 110.8 }, y: { min: 1, max: 54.3 }, z: null, b: null };
        const result = await f.call(job);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.armed, true); assert.equal(job.state, 'armed');
        assert.deepEqual(calls, [{ filePath: job.filePath, extents: { x: { min: 1, max: 110.8 }, y: { min: 1, max: 54.3 } } }]);
        assert.equal(result.boundary.status, 'uploaded');
        assert.equal(result.operator_start.boundary.status, 'uploaded');
        assert.match(result.operator_start.instruction,
            /^Press and hold the work switch for about 3 seconds\. A SHORT press runs this job's frame \(X 1\.\.110\.8, Y 1\.\.54\.3/);
        assert.match(result.note, /A SHORT press runs this job's frame/);
        const phases = job.events.map((e) => e.phase);
        assert.ok(phases.indexOf('uploaded') < phases.indexOf('boundary') && phases.indexOf('boundary') < phases.indexOf('armed'), phases.join(','));
        assert.equal(f.counts().uploads, 1, 'the job went up once; the frame is the channel\'s own transfer');
    }],
    ['Ray frame: an unchanged frame is reported as current; a failed or uncomputable one never fails the start', async () => {
        const unchanged = fixture('ray-switch', { dialect: 'ray-grbl',
            readMotorPowerMode: async () => 3,
            uploadJobBoundary: async () => ({ status: 'unchanged', target: 'boundary.nc', reason: null, basis: 'header', frame: null }) });
        const u = await unchanged.call(unchanged.createJob());
        assert.equal(u.ok, true); assert.equal(u.boundary.status, 'unchanged');
        assert.match(u.operator_start.instruction, /already matched it \(uploaded earlier on this connection\)/);
        for (const outcome of [
            async (): Promise<fileStart.BoundaryRefresh> => ({ status: 'failed', target: 'boundary.nc', reason: 'SD card unavailable.', basis: 'header', frame: null }),
            async (): Promise<fileStart.BoundaryRefresh> => ({ status: 'not-framed', target: 'boundary.nc', reason: 'no X/Y extents', basis: null, frame: null }),
            async (): Promise<fileStart.BoundaryRefresh> => { throw new Error('socket closed'); },
        ]) {
            const f = fixture('ray-switch', { dialect: 'ray-grbl', readMotorPowerMode: async () => 3, uploadJobBoundary: outcome });
            const job = f.createJob();
            const result = await f.call(job);
            assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.armed, true);
            assert.equal(job.state, 'armed', 'the job stays armed');
            assert.ok(['failed', 'not-framed'].includes(result.boundary.status));
            assert.match(result.operator_start.instruction, /A SHORT press runs the controller boundary\.nc, which (could NOT be updated|was not updated)/);
            assert.match(result.operator_start.instruction, /LAST boundary uploaded, not this job's frame - frame this job with laser_frame instead/);
            const event = job.events.find((e) => e.phase === 'boundary_failed');
            assert.ok(event, 'reported on the job');
            assert.match(String(event?.note), /NOT updated for this job: (SD card unavailable\.|no X\/Y extents|socket closed)/);
        }
    }],
    ['Ray frame: a stop while the frame is uploading withdraws the armed job and the start reports it', async () => {
        let f: ReturnType<typeof fixture> | null = null;
        let job: McpJob | null = null;
        f = fixture('ray-switch', { dialect: 'ray-grbl',
            readMotorPowerMode: async () => 3,
            uploadJobBoundary: async () => {
                await f!.stop(job!);
                return { status: 'uploaded', target: 'boundary.nc', reason: null, basis: 'header', frame: null };
            } });
        job = f.createJob();
        const result = await f.call(job);
        assert.equal(result.ok, false); assert.equal(result.armed, undefined);
        assert.equal(job.state, 'stopped'); assert.equal(job.ending?.kind, 'withdrawn');
        assert.equal(result.boundary.status, 'uploaded');
        assert.ok(!job.events.some((e) => e.phase === 'armed'), 'no armed event after the withdrawal');
    }],
    ['#328 Ray: a run of ANOTHER file never adopts an armed job', async () => {
        const f = fixture('ray-switch', { dialect: 'ray-grbl', readMotorPowerMode: async () => 3 }); const job = f.createJob();
        await f.call(job);
        f.setReport('running', '/boundary.nc'); f.tick();
        assert.equal(job.state, 'armed', 'the boundary run (a short press) is not this job');
        f.setReport('idle', '/boundary.nc'); f.tick(); f.setReport('idle', '/boundary.nc'); f.tick(); f.setReport('idle', '/boundary.nc'); f.tick();
        assert.equal(job.state, 'armed');
    }],
    ['#328 Ray: stop while armed WITHDRAWS without a firmware stop and says the file remains on the controller', async () => {
        const f = fixture('ray-switch', { dialect: 'ray-grbl', readMotorPowerMode: async () => 3 }); const job = f.createJob();
        await f.call(job);
        const result = await f.stop(job);
        assert.equal(result.withdrawn, true); assert.equal(result.stopped, true);
        assert.match(result.note, /REMAINS on the controller/);
        assert.equal(job.state, 'stopped'); assert.equal(job.ending?.kind, 'withdrawn');
        assert.match(job.ending?.reason || '', /ray\.nc remains on the controller/);
        assert.equal(job.confirmToken, null);
        assert.equal(f.counts().stops, 0, 'the Ray alarms on a job stop outside a file print: none sent');
        assert.equal(f.manager.getActive(), null);
        f.setReport('running', '/ray.nc'); f.tick();
        assert.equal(job.state, 'stopped', 'a withdrawn job is never resurrected');
    }],
    ['#328 Ray: stop while running sends the SACP job stop; stop while the machine reads idle sends nothing', async () => {
        const f = fixture('ray-switch', { dialect: 'ray-grbl', readMotorPowerMode: async () => 3 }); const job = f.createJob();
        await f.call(job);
        f.setReport('running', '/ray.nc'); f.tick();
        assert.equal(job.state, 'started');
        const stopped = await f.stop(job);
        assert.equal(stopped.stopped, true); assert.equal(f.counts().stops, 1);
        assert.equal(job.state, 'stopped'); assert.equal(job.ending?.kind, 'machine-stopped');
        // A started job whose machine already reads idle: no 0xAC 0x06 to an idle Ray.
        const g = fixture('ray-switch', { dialect: 'ray-grbl', readMotorPowerMode: async () => 3 }); const other = g.createJob();
        await g.call(other);
        g.setReport('running', '/ray.nc'); g.tick();
        g.setReport('idle', '/ray.nc'); g.tick();
        assert.equal(other.state, 'started', 'one idle beat is not completion yet');
        const idle = await g.stop(other);
        assert.equal(idle.stopped, false); assert.match(idle.note, /machine reads idle, so no job stop was sent/);
        assert.equal(g.counts().stops, 0);
        assert.equal(other.state, 'started');
        g.setReport('idle', '/ray.nc'); g.tick(); g.setReport('idle', '/ray.nc'); g.tick();
        assert.equal(other.state, 'completed', 'the watcher still ends it from the heartbeat');
    }],
    ['#328 Ray: an upload whose result was lost is start_unverified (the controller may hold the file), never retried, adopted if it runs', async () => {
        const f = fixture('ray-switch', { dialect: 'ray-grbl', readMotorPowerMode: async () => 3 }); const job = f.createJob();
        f.setUpload((callback) => callback('no reply from the controller for 30 s during the upload', { uncertain: true }));
        const result = await f.call(job);
        assert.equal(result.ok, false); assert.equal(result.retry_safe, false);
        assert.equal(job.state, 'start_unverified');
        assert.match(job.error || '', /Upload unverified: no reply.*may hold ray\.nc/);
        assert.equal(f.manager.getActive(), job);
        assert.equal((await f.call(job)).retry_safe, false, 'no blind retry');
        assert.equal(f.counts().uploads, 1);
        await assert.rejects(f.call(f.createJob()), /still active/);
        // It runs after all (the operator pressed the switch): adopted from the heartbeat.
        f.setReport('running', '/ray.nc'); f.tick();
        assert.equal(job.state, 'started'); assert.equal(f.counts().telemetry, 1);
        // The same with the machine idle: a stop withdraws it without a firmware stop.
        const g = fixture('ray-switch', { dialect: 'ray-grbl', readMotorPowerMode: async () => 3 }); const other = g.createJob();
        g.setUpload((callback) => callback('upload request failed: timeout', { uncertain: true }));
        await g.call(other);
        g.setReport('idle', '/ray.nc'); g.tick();
        const stop = await g.stop(other);
        assert.equal(stop.withdrawn, true); assert.equal(g.counts().stops, 0);
        assert.equal(other.state, 'stopped'); assert.match(other.ending?.reason || '', /may be on the controller/);
    }],
    ['#328 Ray: a definite upload refusal fails the job (nothing usable on the controller); a lease refusal is not_sent', async () => {
        const f = fixture('ray-switch', { dialect: 'ray-grbl', readMotorPowerMode: async () => 3 }); const job = f.createJob();
        f.setUpload((callback) => callback('SD card unavailable.', { rejected: true }));
        await assert.rejects(f.call(job), /Upload failed: SD card unavailable/);
        assert.equal(job.state, 'start_failed'); assert.equal(f.manager.getActive(), null);
        const g = fixture('ray-switch', { dialect: 'ray-grbl', readMotorPowerMode: async () => 3 }); const other = g.createJob();
        g.setUpload((callback) => callback('lease held', { notSent: true }));
        await assert.rejects(g.call(other), /Upload failed: lease held/);
        assert.equal(other.events.find((e) => e.phase === 'failed')?.not_sent, true);
    }],
    ['#328 Ray: the Manual-Mode refusal still comes before the upload for a file job', async () => {
        const f = fixture('ray-switch', { dialect: 'ray-grbl', readMotorPowerMode: async () => 1 }); const job = f.createJob();
        await assert.rejects(f.call(job), /Manual Mode|SHUTAll/);
        assert.equal(job.state, 'approved'); assert.equal(f.counts().uploads, 0);
    }],
    ['#328 Ray: the file-print-only stop is NO stop for a direct step - #320 semantics hold although stopGcodeJob exists', async () => {
        const f = fixture('ray-switch', { dialect: 'ray-grbl', readMotorPowerMode: async () => 3 }); const job = f.createDirectJob();
        job.state = 'started';
        await assert.rejects(f.stop(job), /cannot be stopped by firmware command over this transport/);
        assert.equal(f.counts().stops, 0);
    }],
    ['#328: fileStartEvidence treats the Ray\'s /ray.nc as ray.nc and SYSTEM_STATUS_STARTING as active', () => {
        assert.equal(fileStart.fileStartEvidence({ status: 'starting', timestamp: 200, gcodePrintingInfo: { name: '/ray.nc' } }, 100, 1000, true, 'ray.nc'), 'active');
        assert.equal(fileStart.fileStartEvidence({ status: 'running', timestamp: 200, gcodePrintingInfo: { name: '/boundary.nc' } }, 100, 1000, true, 'ray.nc'), 'unknown');
        assert.equal(fileStart.fileJobTarget(RAY_TRANSPORT, 'drill'), 'ray.nc');
        assert.equal(fileStart.fileJobTarget(fileStart.COMMAND_FILE_JOB_TRANSPORT, 'drill'), 'drill.nc');
    }],
    ['a channel without executeGcode refuses direct jobs and procedures by name, before the approval is consumed', async () => {
        const f = fixture('none');
        const direct = f.createDirectJob();
        await assert.rejects(f.startDirect(direct), /does not support direct moves\. \(machine: none\)/);
        assert.equal(direct.state, 'approved'); assert.ok(!direct.tokenUsed);
        const procedure = f.createDirectJob('procedure');
        let ran = false;
        procedure.runner = async () => { ran = true; return {}; };
        await assert.rejects(f.call(procedure), /cannot run a server-driven procedure/);
        assert.equal(procedure.state, 'approved'); assert.ok(!procedure.tokenUsed); assert.equal(ran, false);
    }],
    ['both-capability channel (A350): a direct job runs over executeGcode and never uploads', async () => {
        const f = fixture(); const job = f.createDirectJob();
        await f.startDirect(job);
        assert.equal(job.state, 'completed');
        assert.equal(f.executed.length, 1);
        assert.equal(f.counts().uploads, 0); assert.equal(f.counts().starts, 0);
    }],
    ['stopping a handed-over direct job on an executeGcode-only channel names the missing stop, not file submission', async () => {
        const f = fixture('direct-only'); const job = f.createDirectJob();
        job.state = 'started';
        // #320: and says honestly that a running step cannot be stopped by firmware command over this transport.
        await assert.rejects(f.stop(job), /cannot be stopped by firmware command over this transport/);
    }],
];
