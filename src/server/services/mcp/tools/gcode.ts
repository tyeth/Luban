/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import * as fs from 'fs-extra';

import logger from '../../../lib/logger';
import { connectionManager } from '../../machine/ConnectionManager';
import { McpJob, jobManager } from '../jobs';
import { probeFeedService } from '../probeFeed';
import { McpToolError, ToolRegistry } from '../registry';
import { validateGcode } from '../validator';
import { GcodeChannel, sendGcodeVisible } from './camera';
import { PositionSnapshot, assertFreshHeartbeat, getMachineSizeByIdentifier, getPositionSnapshot } from './machine';

// Motion policy (#23): compound motion leaves this process only as a G-code
// file submitted through the same prepare/start path as "Start on Luban",
// so the controller's job state machine and the enclosure door interlock
// apply. Starting requires a one-time code that only the human approval
// page mints (see jobs.ts).

const HEAD_TYPES = ['cnc', 'laser', 'printing'];

interface JobChannel {
    executeGcode?: (gcode: string) => Promise<{ result: number; text?: string }>;
    uploadGcodeFile?: (filePath: string, type: string, renderName: string, callback: (msg: unknown, data?: unknown) => void) => void;
    startGcodeJob?: () => Promise<{ ok: boolean; code?: number; text?: string }>;
    stopGcodeJob?: () => Promise<{ ok: boolean; code?: number; text?: string }>;
}

function getJobChannel(): JobChannel {
    const channel = connectionManager.getCurrentChannel() as unknown as JobChannel;
    if (!channel) {
        throw new McpToolError('No machine connected.');
    }
    if (typeof channel.uploadGcodeFile !== 'function' || typeof channel.startGcodeJob !== 'function') {
        throw new McpToolError('The connected channel does not support file job submission.');
    }
    return channel;
}

/**
 * Wait until the heartbeat is settled AND, when the executed gcode names an
 * absolute Z target, until the reported Z actually matches it. Two identical
 * post-issue beats alone are not enough: the heartbeat lags the controller
 * by ~1s, so both can be pre-motion beats showing the old position (observed
 * live: a -95 move "completed" while still reporting -85). Every returned
 * position is either verified or flagged as not.
 */
async function waitForStableHeartbeat(
    issuedAt: number,
    expect?: { frame: 'work' | 'machine'; z: number }
): Promise<{ position: PositionSnapshot | null; verified: boolean; warning?: string }> {
    const deadline = issuedAt + 45000;
    let previous: string | null = null;
    let last: PositionSnapshot | null = null;
    while (Date.now() < deadline) {
        await new Promise((resolve) => {
            setTimeout(resolve, 500);
        });
        let now: PositionSnapshot;
        try {
            now = getPositionSnapshot();
        } catch (err) {
            continue;
        }
        last = now;
        const reportTime = Date.now() - now.reportAgeMs;
        const fingerprint = JSON.stringify([now.work, now.originOffset]);
        const stable = fingerprint === previous;
        previous = fingerprint;
        if (reportTime <= issuedAt || !stable || now.machineStatus !== 'idle') {
            continue;
        }
        if (expect) {
            const reportedZ = expect.frame === 'work' ? now.work.z : now.machine.z;
            if (reportedZ === null || Math.abs(reportedZ - expect.z) > 0.15) {
                continue; // settled, but not AT the target yet - keep waiting
            }
        }
        return { position: now, verified: true };
    }
    return {
        position: last,
        verified: false,
        warning: expect
            ? `Timed out waiting for the heartbeat to report ${expect.frame} Z ${expect.z}; the position `
                + 'shown is the last read and may be stale - verify with query_firmware_position.'
            : 'Timed out waiting for a settled heartbeat; the position shown may be stale - verify with '
                + 'query_firmware_position.',
    };
}

/**
 * Absolute Z target of a direct-move gcode, for settle verification.
 * G53-wrapped moves are machine-frame; plain ones are work-frame.
 */
function parseZTarget(gcode: string): { frame: 'work' | 'machine'; z: number } | undefined {
    const match = gcode.match(/G0*1[^;\n]*?Z(-?\d+(?:\.\d+)?)/i);
    if (!match) {
        return undefined;
    }
    return { frame: gcode.includes('G53') ? 'machine' : 'work', z: Number(match[1]) };
}

function machineStatus(): string | null {
    const state = connectionManager.getLatestMachineState();
    return state ? ((state as { status?: string }).status || null) : null;
}

const log = logger('service:mcp:gcode-jobs');

// File jobs run on the machine's own interpreter, which reports progress only
// through the heartbeat - nothing calls back when the job ends, so a started
// file job previously stayed "started" forever (observed 2026-09-02, job
// b3f4ef467a93: a 10s job, heartbeat back to idle, state never moved). Watch
// the heartbeat: once the job has been seen active, a debounced return to
// idle is completion. A job too short to ever show as active is completed
// after the heartbeat holds idle for a longer fallback window.
const sleep = async (ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
});

const FILE_JOB_POLL_MS = 1000;
const FILE_JOB_IDLE_DEBOUNCE_POLLS = 3;
const FILE_JOB_NEVER_SEEN_ACTIVE_IDLE_POLLS = 20;
const FILE_JOB_UNREADABLE_POLLS_GIVE_UP = 120;
const FILE_JOB_ACTIVE_STATUSES = ['running', 'paused', 'pausing', 'stopping', 'resuming'];

function watchFileJobCompletion(job: McpJob): void {
    let sawActive = false;
    let idleStreak = 0;
    let unreadableStreak = 0;
    let lastProgress = -1;
    const release = () => {
        if (jobManager.getActive() === job) {
            jobManager.setActive(null);
        }
    };
    const timer = setInterval(() => {
        if (job.state !== 'started') {
            // Stopped (or otherwise finalised) through another path.
            clearInterval(timer);
            release();
            return;
        }
        const status = machineStatus();
        if (status === null) {
            unreadableStreak += 1;
            idleStreak = 0;
            if (unreadableStreak >= FILE_JOB_UNREADABLE_POLLS_GIVE_UP) {
                clearInterval(timer);
                job.error = 'Completion unverified: machine state became unreadable after the job '
                    + 'started (connection lost?). The job may still be running on the machine.';
                jobManager.appendEvent(job, 'completion_unverified', { note: job.error });
                log.warn(`MCP file job ${job.id}: ${job.error}`);
                release();
            }
            return;
        }
        unreadableStreak = 0;
        if (FILE_JOB_ACTIVE_STATUSES.includes(status)) {
            sawActive = true;
            idleStreak = 0;
            // Progress from the heartbeat, recorded every 5 % so the event
            // log shows the job advancing without a reader having to poll.
            const state = connectionManager.getLatestMachineState() as { gcodePrintingInfo?: { progress?: number } } | null;
            const raw = state && state.gcodePrintingInfo ? Number(state.gcodePrintingInfo.progress) : NaN;
            if (Number.isFinite(raw)) {
                const percent = Math.round((raw <= 1 ? raw * 100 : raw));
                if (percent >= lastProgress + 5) {
                    lastProgress = percent;
                    jobManager.appendEvent(job, 'progress', { percent, machineStatus: status });
                }
            }
            return;
        }
        if (status === 'idle') {
            idleStreak += 1;
            const needed = sawActive ? FILE_JOB_IDLE_DEBOUNCE_POLLS : FILE_JOB_NEVER_SEEN_ACTIVE_IDLE_POLLS;
            if (idleStreak >= needed) {
                clearInterval(timer);
                job.state = 'completed';
                job.endedAt = Date.now();
                jobManager.appendEvent(job, 'completed', {
                    note: `heartbeat idle for ${idleStreak}s${sawActive ? '' : ' (job too short for an active heartbeat to be observed)'}`,
                });
                log.info(`MCP file job ${job.id} completed: heartbeat idle for ${idleStreak}s`
                    + `${sawActive ? '' : ' (job too short for an active heartbeat to be observed)'}`);
                release();
            }
            return;
        }
        // Unknown status string: treat as activity of some kind, keep waiting.
        idleStreak = 0;
    }, FILE_JOB_POLL_MS);
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
}

export function registerGcodeTools(registry: ToolRegistry, getConfirmBaseUrl: () => string): void {
    registry.register({
        name: 'validate_gcode',
        description: 'Statically inspect G-code: motion extents, feeds, spindle commands and '
            + 'warnings. Sends nothing to the machine.',
        inputSchema: {
            type: 'object',
            properties: {
                gcode: { type: 'string', description: 'Complete G-code text.' },
            },
            required: ['gcode'],
            additionalProperties: false,
        },
        handler: async (args: { gcode?: string }) => {
            if (typeof args.gcode !== 'string' || !args.gcode.trim()) {
                throw new McpToolError('gcode must be a non-empty string.');
            }
            return validateGcode(args.gcode) as unknown as object;
        },
    });

    registry.register({
        name: 'submit_gcode_job',
        description: 'Stage a G-code job for human confirmation. Returns a validation report and '
            + 'a confirm_url the OPERATOR must open in a browser; approving there mints a one-time '
            + 'code the operator gives you for start_gcode_job. Nothing is sent to the machine yet.',
        inputSchema: {
            type: 'object',
            properties: {
                gcode: { type: 'string', description: 'Complete G-code text.' },
                name: { type: 'string', description: 'Short job name shown to the operator.' },
                head_type: { type: 'string', enum: HEAD_TYPES, description: 'Toolhead kind. Default cnc.' },
            },
            required: ['gcode', 'name'],
            additionalProperties: false,
        },
        handler: async (args: { gcode?: string; name?: string; head_type?: string }) => {
            if (typeof args.gcode !== 'string' || !args.gcode.trim()) {
                throw new McpToolError('gcode must be a non-empty string.');
            }
            if (typeof args.name !== 'string' || !args.name.trim()) {
                throw new McpToolError('name must be a non-empty string.');
            }
            const headType = args.head_type || 'cnc';
            if (!HEAD_TYPES.includes(headType)) {
                throw new McpToolError(`head_type must be one of: ${HEAD_TYPES.join(', ')}`);
            }

            const validation = validateGcode(args.gcode);
            const job = jobManager.submit(args.gcode, args.name, headType, validation);

            return {
                job: jobManager.describe(job),
                confirm_url: `${getConfirmBaseUrl()}/confirm/${job.id}`,
                next_step: 'Ask the operator to open confirm_url in a browser, review, and approve. '
                    + 'They will receive a one-time code to give you for start_gcode_job.',
            };
        },
    });

    registry.register({
        name: 'start_gcode_job',
        description: 'Start an approved job: uploads the file to the machine through the same '
            + 'prepare/start path as "Start on Luban" (door interlock applies) and starts it. '
            + 'Requires the one-time code the operator received when approving.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string' },
                confirm_token: { type: 'string', description: 'One-time code from the operator.' },
                wait_until_moved: {
                    type: 'boolean',
                    description: 'Direct jobs only. Default true: block until the heartbeat verifiably '
                        + 'reports the move done. false returns immediately after the controller accepts '
                        + 'the command, with position_verified: false - poll get_position afterwards.',
                },
            },
            required: ['job_id', 'confirm_token'],
            additionalProperties: false,
        },
        handler: async (args: { job_id?: string; confirm_token?: string; wait_until_moved?: boolean }) => {
            probeFeedService.assertNoOvertravel();
            const job = jobManager.get(String(args.job_id || ''));
            if (!job) {
                throw new McpToolError('Unknown job_id.');
            }

            // Connectivity, heartbeat freshness and idleness are checked
            // before the token is consumed, so an offline attempt does not
            // waste an approval.
            assertFreshHeartbeat('starting a job');
            const channel = getJobChannel();
            const status = machineStatus();
            if (status !== 'idle') {
                throw new McpToolError(`Machine is ${status || 'in an unknown state'}, not idle.`);
            }

            // Consumed from here on, success or not - a failed start needs a
            // fresh human approval, not a retry loop.
            const verdict = jobManager.consumeToken(job, String(args.confirm_token || ''));
            if (!verdict.ok) {
                throw new McpToolError(verdict.reason || 'Confirmation failed.');
            }

            if (job.kind === 'procedure') {
                // Server-driven measurement routine (e.g. run_tool_setter):
                // the operator approved the envelope; the runner steps within
                // it against live sensor feedback and returns the result.
                if (typeof job.runner !== 'function') {
                    throw new McpToolError('Procedure job has no runner (was the server restarted since '
                        + 'submission?). Submit it again.');
                }
                job.state = 'started';
                job.startedAt = Date.now();
                jobManager.appendEvent(job, 'started', { note: 'procedure runner started' });
                jobManager.setActive(job);
                try {
                    const outcome = await job.runner();
                    // On the record first: a client that timed out waiting here
                    // still finds the result in get_gcode_job_status.
                    job.result = outcome;
                    job.state = 'completed';
                    job.endedAt = Date.now();
                    jobManager.appendEvent(job, 'completed', { note: 'procedure finished; result stored on the job' });
                    return {
                        job: jobManager.describe(job),
                        result: outcome,
                    };
                } catch (err) {
                    job.state = 'start_failed';
                    job.error = err.message;
                    job.endedAt = Date.now();
                    jobManager.appendEvent(job, 'failed', { note: err.message });
                    throw err;
                } finally {
                    jobManager.setActive(null);
                }
            }

            if (job.kind === 'direct') {
                // Direct moves execute over the realtime path so position
                // PERSISTS - the machine interpreter raises Z to top at the
                // finish position when a file job completes, so a file job
                // cannot hold a working Z (XY holds). The
                // operator approved exactly this gcode on the confirm page.
                // For a batch, each call executes ONE approved step; the
                // token stays valid for the remaining steps (within its TTL).
                job.state = 'starting';
                const issuedAt = Date.now();
                job.startedAt = job.startedAt || issuedAt;
                const isBatch = Array.isArray(job.steps) && job.steps.length > 0;
                const gcodeText = isBatch
                    ? job.steps[job.nextStep]
                    : fs.readFileSync(job.filePath, 'utf8');
                // The staged text carries a human-facing comment header for
                // the confirm page; the realtime execute path must get pure
                // commands - the controller never replied to a payload led by
                // comment lines (hung live, 2026-09-02, job e34b19a913ff).
                const executable = gcodeText
                    .split(/\r?\n/)
                    .filter((line) => {
                        const trimmed = line.trim();
                        return trimmed.length > 0 && !trimmed.startsWith(';');
                    })
                    .join('\n');
                jobManager.appendEvent(job, 'started', { note: isBatch ? `direct step ${job.nextStep + 1}/${job.steps.length}` : 'direct move' });
                jobManager.setActive(job);
                let settle;
                try {
                    const executed = await sendGcodeVisible(channel as GcodeChannel, `direct:${job.name}`, executable);
                    if (executed.result !== 0) {
                        job.state = 'start_failed';
                        job.error = `Controller rejected the move: ${executed.text || executed.result}`;
                        job.endedAt = Date.now();
                        jobManager.appendEvent(job, 'failed', { note: job.error });
                        throw new McpToolError(job.error);
                    }
                    const shouldWait = args.wait_until_moved !== undefined
                        ? args.wait_until_moved !== false
                        : job.waitUntilMoved !== false;
                    settle = !shouldWait
                        ? {
                            position: null,
                            verified: false,
                            warning: 'wait_until_moved was false: the move was accepted but not awaited - '
                                + 'poll get_position (or query_firmware_position) before relying on position.',
                        }
                        : await waitForStableHeartbeat(issuedAt, parseZTarget(executable));
                    jobManager.appendEvent(job, 'settled', { position: settle.position, verified: settle.verified });
                } finally {
                    jobManager.setActive(null);
                }
                if (isBatch) {
                    job.nextStep += 1;
                    if (job.nextStep < job.steps.length) {
                        // Same operator-approved list; keep the token usable
                        // for the remaining steps.
                        job.tokenUsed = false;
                        job.state = 'started';
                        return {
                            job: jobManager.describe(job),
                            position: settle.position,
                            position_verified: settle.verified,
                            warning: settle.warning,
                            remaining_steps: job.steps.length - job.nextStep,
                            note: 'Step executed and settled. Call start_gcode_job again with the same '
                                + 'job_id and code for the next approved step; positions persist.',
                        };
                    }
                }
                job.state = 'completed';
                job.endedAt = Date.now();
                jobManager.appendEvent(job, 'completed', { note: 'direct move(s) done' });
                return {
                    job: jobManager.describe(job),
                    position: settle.position,
                    position_verified: settle.verified,
                    warning: settle.warning,
                    note: 'Direct move executed; the position persists (no end-of-job park).',
                };
            }

            job.state = 'starting';
            const uploadError = await new Promise<string | null>((resolve) => {
                channel.uploadGcodeFile(job.filePath, job.headType, `${job.name}.nc`, (msg) => {
                    resolve(msg ? String(msg) : null);
                });
            });
            if (uploadError) {
                job.state = 'start_failed';
                job.error = `Upload failed: ${uploadError}`;
                job.endedAt = Date.now();
                jobManager.appendEvent(job, 'failed', { note: job.error });
                throw new McpToolError(job.error);
            }
            jobManager.appendEvent(job, 'uploaded', { note: `${job.name}.nc uploaded to the machine` });

            const started = await channel.startGcodeJob();
            if (!started.ok) {
                job.state = 'start_failed';
                job.error = `Start failed: ${started.text || started.code || 'unknown error'}`;
                job.endedAt = Date.now();
                jobManager.appendEvent(job, 'failed', { note: job.error });
                throw new McpToolError(job.error);
            }

            job.state = 'started';
            job.startedAt = Date.now();
            jobManager.appendEvent(job, 'started', { note: 'machine interpreter running the file (door interlock applies)' });
            jobManager.setActive(job);
            watchFileJobCompletion(job);
            return {
                job: jobManager.describe(job),
                note: 'Job started. Poll get_gcode_job_status with wait_ms to long-poll for progress '
                    + 'events and completion (no need to read server logs); the controller, its door '
                    + 'interlock and the machine UI remain in control. The job is marked completed when '
                    + 'the heartbeat settles back to idle.',
            };
        },
    });

    registry.register({
        name: 'move_z',
        description: 'Request absolute Z motion, executed on the direct path so positions PERSIST '
            + '(the machine interpreter raises Z to top at the finish position when a file job '
            + 'completes, so a file job cannot hold a working Z - firmware behaviour). '
            + 'Either one target (z) or an ordered list (z_targets, max 20) for a methodical search: '
            + 'the operator approves the EXACT list once, and each start_gcode_job call then executes '
            + 'one step, so you can capture between steps and abandon the series at any point. The '
            + 'confirm page shows current Z, every target, deltas and feed; only the operator one-time '
            + 'code executes anything. NOT door-interlocked - the operator supervises. Spindle must be '
            + 'off; the toolhead always carries a tool.',
        inputSchema: {
            type: 'object',
            properties: {
                z: { type: 'number', description: 'Absolute target Z (single move).' },
                z_targets: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 1,
                    maxItems: 20,
                    description: 'Ordered absolute Z targets; one approval covers the exact list, '
                        + 'one start_gcode_job call per step. Mutually exclusive with z.',
                },
                coordinate_system: {
                    type: 'string',
                    enum: ['work', 'machine'],
                    description: 'Which frame z is in. Default work.',
                },
                feed_rate: { type: 'number', description: 'mm/min, default 300, max 600.' },
                reason: { type: 'string', description: 'Shown to the operator: why this Z motion is needed.' },
                wait_until_moved: {
                    type: 'boolean',
                    description: 'Staged default for execution (start_gcode_job can override per call). '
                        + 'Default true: each step blocks until the heartbeat verifiably reports the '
                        + 'target Z. false: steps return on controller accept with '
                        + 'position_verified: false - poll get_position.',
                },
            },
            required: ['reason'],
            additionalProperties: false,
        },
        handler: async (args: {
            z?: number;
            z_targets?: number[];
            coordinate_system?: string;
            feed_rate?: number;
            reason?: string;
            wait_until_moved?: boolean;
        }) => {
            probeFeedService.assertNoOvertravel();
            if ((args.z === undefined) === (args.z_targets === undefined)) {
                throw new McpToolError('Provide exactly one of z or z_targets.');
            }
            const targets = args.z_targets !== undefined
                ? args.z_targets.map(Number)
                : [Number(args.z)];
            if (!targets.length || targets.length > 20 || targets.some((t) => !Number.isFinite(t))) {
                throw new McpToolError('Targets must be 1-20 finite numbers.');
            }
            const targetZ = targets[targets.length - 1];
            const coordinateSystem = args.coordinate_system || 'work';
            if (!['work', 'machine'].includes(coordinateSystem)) {
                throw new McpToolError('coordinate_system must be "work" or "machine".');
            }
            const feedRate = Math.min(Math.max(Number(args.feed_rate) || 300, 50), 600);

            assertFreshHeartbeat('staging a Z move');
            const position = getPositionSnapshot();
            if (position.machineStatus !== 'idle') {
                throw new McpToolError(`Machine is ${position.machineStatus || 'in an unknown state'}, not idle.`);
            }
            if (position.isHomed !== true) {
                throw new McpToolError('Machine does not report homed; home before any Z positioning.');
            }
            const state = connectionManager.getLatestMachineState() as { headStatus?: unknown; headPower?: unknown } | null;
            const headPower = Number(state && state.headPower);
            if ((Number.isFinite(headPower) && headPower > 0) || (state && (state.headStatus === true || state.headStatus === 'on'))) {
                throw new McpToolError('Toolhead appears to be on; refusing to move Z.');
            }

            const currentZ = coordinateSystem === 'work' ? position.work.z : position.machine.z;
            if (currentZ === null) {
                throw new McpToolError('Current Z unknown; cannot describe the move to the operator.');
            }
            const size = getMachineSizeByIdentifier(connectionManager.getConnectionStatus().machineIdentifier);
            for (const t of targets) {
                const machineT = coordinateSystem === 'machine' ? t : t - position.originOffset.z;
                if (size && (machineT < -1 || machineT > size.z + 40)) {
                    throw new McpToolError(`Target ${coordinateSystem} Z ${t} (machine Z ${machineT.toFixed(1)}) `
                        + `is outside the 0..${size.z} travel.`);
                }
            }

            const stepGcode = (t: number) => (coordinateSystem === 'machine'
                ? `G90\nG53;\nG1 Z${t.toFixed(3)} F${feedRate};\nG54;`
                : `G90\nG1 Z${t.toFixed(3)} F${feedRate}`);
            const steps = targets.map(stepGcode);
            const isBatch = targets.length > 1;
            const delta = targetZ - currentZ;
            // The gcode preview must let the operator validate the numbers
            // without trusting chat: state the reason, the frame, where the
            // machine is now and the delta of every step (operator request
            // 2026-09-02). Sensors: no contact is expected during a Z move.
            const wrapText = (text: string, width: number): string[] => {
                const words = String(text).split(/\s+/);
                const rows: string[] = [];
                let row = '';
                for (const word of words) {
                    if (row && (row.length + word.length + 1) > width) {
                        rows.push(row);
                        row = word;
                    } else {
                        row = row ? `${row} ${word}` : word;
                    }
                }
                if (row) {
                    rows.push(row);
                }
                return rows;
            };
            const header = [
                ...wrapText(`reason: ${args.reason}`, 90).map((row) => `; ${row}`),
                `; frame: ${coordinateSystem} coords; current ${coordinateSystem} Z ${currentZ.toFixed(3)}`,
                ...targets.map((t, i) => {
                    const from = i === 0 ? currentZ : targets[i - 1];
                    const d = t - from;
                    return `; step ${i + 1}: Z ${from.toFixed(3)} -> ${t.toFixed(3)} (${d >= 0 ? '+' : ''}${d.toFixed(3)} mm) F${feedRate}`;
                }),
                '; sensors: NO contact expected during these moves - a probe/toolsetter trigger',
                '; while moving latches the CRASH alarm (probe feed must be armed).',
            ].join('\n');
            const reviewText = `${header}\n${steps.join('\n; --- next approved step ---\n')}`;
            const name = isBatch
                ? `z-series ${coordinateSystem} [${targets.map((t) => t.toFixed(1)).join(', ')}] - ${String(args.reason).slice(0, 40)}`
                : `z-move ${coordinateSystem} Z${targetZ.toFixed(1)} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}mm) - ${String(args.reason).slice(0, 40)}`;

            const validation = validateGcode(reviewText);
            const job = jobManager.submit(reviewText, name, 'cnc', validation, 'direct', isBatch ? steps : undefined);
            job.waitUntilMoved = args.wait_until_moved !== false;

            return {
                job: jobManager.describe(job),
                current_z: currentZ,
                targets,
                final_delta_mm: delta,
                feed_rate: feedRate,
                coordinate_system: coordinateSystem,
                confirm_url: `${getConfirmBaseUrl()}/confirm/${job.id}`,
                next_step: isBatch
                    ? 'Ask the operator to open confirm_url, review the DIRECT-move banner and the full '
                        + 'target list, and approve once. Then call start_gcode_job with the code once PER '
                        + 'STEP - each call executes the next approved target and settles; capture between '
                        + 'steps as needed. The series can be abandoned at any point.'
                    : 'Ask the operator to open confirm_url, review the DIRECT-move banner '
                        + '(current Z, target, delta, feed), and approve. Their one-time code passed to '
                        + 'start_gcode_job executes the move; the position then persists.',
            };
        },
    });

    registry.register({
        name: 'get_gcode_job_status',
        description: 'Job record, its event log (state changes, runner phases, gcode traffic while '
            + 'active, file-job progress), the stored procedure result, and live machine progress. '
            + 'LONG-POLL: pass wait_ms (up to 120000) and it returns as soon as the job reaches a '
            + 'terminal state or new events arrive past since_event - use this instead of tight '
            + 'polling or reading server logs. Read-only.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string' },
                wait_ms: {
                    type: 'number',
                    description: 'Block up to this long (0-120000) for a terminal state or new events. Default 0 = return now.',
                },
                since_event: {
                    type: 'number',
                    description: 'Return only events at index >= this (the previous response\'s next_event_index); '
                        + 'new events past it also end a wait early. Default 0 = all events.',
                },
            },
            required: ['job_id'],
            additionalProperties: false,
        },
        handler: async (args: { job_id?: string; wait_ms?: number; since_event?: number }) => {
            const job = jobManager.get(String(args.job_id || ''));
            if (!job) {
                throw new McpToolError('Unknown job_id.');
            }
            const waitMs = Math.min(Math.max(Number(args.wait_ms) || 0, 0), 120000);
            const since = Math.max(0, Math.floor(Number(args.since_event) || 0));
            const startedWaiting = Date.now();
            let timedOut = false;
            while (!jobManager.isTerminal(job) && job.events.length <= since) {
                if (Date.now() - startedWaiting >= waitMs) {
                    timedOut = waitMs > 0;
                    break;
                }
                await sleep(Math.min(250, waitMs - (Date.now() - startedWaiting)));
            }
            const state = connectionManager.getLatestMachineState();
            return {
                job: jobManager.describe(job),
                result: job.result,
                events: job.events.slice(since),
                next_event_index: job.events.length,
                waited_ms: Date.now() - startedWaiting,
                timed_out: timedOut,
                machineStatus: machineStatus(),
                printingInfo: state ? ((state as { gcodePrintingInfo?: object }).gcodePrintingInfo || null) : null,
                reportAgeMs: state ? Date.now() - state.timestamp : null,
            };
        },
    });

    registry.register({
        name: 'stop_gcode_job',
        description: 'Stop the running job on the machine. Stopping needs no confirmation.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'Job to mark stopped; the machine stop is global.' },
            },
            required: ['job_id'],
            additionalProperties: false,
        },
        handler: async (args: { job_id?: string }) => {
            const job = jobManager.get(String(args.job_id || ''));
            if (!job) {
                throw new McpToolError('Unknown job_id.');
            }
            const channel = getJobChannel();
            if (typeof channel.stopGcodeJob !== 'function') {
                throw new McpToolError('The connected channel does not support stopping jobs.');
            }
            const stopped = await channel.stopGcodeJob();
            if (stopped.ok) {
                job.state = 'stopped';
                job.endedAt = Date.now();
                jobManager.appendEvent(job, 'stopped', { note: `stop sent by the agent${stopped.text ? `: ${stopped.text}` : ''}` });
                if (jobManager.getActive() === job) {
                    jobManager.setActive(null);
                }
            }
            return {
                ok: stopped.ok,
                text: stopped.text || null,
                job: jobManager.describe(job),
            };
        },
    });
}
