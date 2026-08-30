/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import * as fs from 'fs-extra';

import { connectionManager } from '../../machine/ConnectionManager';
import { jobManager } from '../jobs';
import { McpToolError, ToolRegistry } from '../registry';
import { validateGcode } from '../validator';
import { GcodeChannel, sendGcodeVisible } from './camera';
import { PositionSnapshot, getMachineSizeByIdentifier, getPositionSnapshot } from './machine';

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
 * Wait for two consecutive identical heartbeats fresher than issuedAt, so a
 * direct move's returned position is settled firmware truth.
 */
async function waitForStableHeartbeat(issuedAt: number): Promise<PositionSnapshot | null> {
    const deadline = issuedAt + 30000;
    let previous: string | null = null;
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
        const reportTime = Date.now() - now.reportAgeMs;
        const fingerprint = JSON.stringify([now.work, now.originOffset]);
        const stable = fingerprint === previous;
        previous = fingerprint;
        if (reportTime > issuedAt && stable && now.machineStatus === 'idle') {
            return now;
        }
    }
    return null;
}

function machineStatus(): string | null {
    const state = connectionManager.getLatestMachineState();
    return state ? ((state as { status?: string }).status || null) : null;
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
            },
            required: ['job_id', 'confirm_token'],
            additionalProperties: false,
        },
        handler: async (args: { job_id?: string; confirm_token?: string }) => {
            const job = jobManager.get(String(args.job_id || ''));
            if (!job) {
                throw new McpToolError('Unknown job_id.');
            }

            // Connectivity and idleness are checked before the token is
            // consumed, so an offline attempt does not waste an approval.
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

            if (job.kind === 'direct') {
                // Direct moves execute over the realtime path so position
                // PERSISTS - the firmware parks back at the work origin when
                // a file job completes, so a file job cannot hold a Z. The
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
                const executed = await sendGcodeVisible(channel as GcodeChannel, `direct:${job.name}`, gcodeText);
                if (executed.result !== 0) {
                    job.state = 'start_failed';
                    job.error = `Controller rejected the move: ${executed.text || executed.result}`;
                    throw new McpToolError(job.error);
                }
                const position = await waitForStableHeartbeat(issuedAt);
                if (isBatch) {
                    job.nextStep += 1;
                    if (job.nextStep < job.steps.length) {
                        // Same operator-approved list; keep the token usable
                        // for the remaining steps.
                        job.tokenUsed = false;
                        job.state = 'started';
                        return {
                            job: jobManager.describe(job),
                            position,
                            remaining_steps: job.steps.length - job.nextStep,
                            note: 'Step executed and settled. Call start_gcode_job again with the same '
                                + 'job_id and code for the next approved step; positions persist.',
                        };
                    }
                }
                job.state = 'completed';
                return {
                    job: jobManager.describe(job),
                    position,
                    note: 'Direct move executed and settled; the position persists (no end-of-job park).',
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
                throw new McpToolError(job.error);
            }

            const started = await channel.startGcodeJob();
            if (!started.ok) {
                job.state = 'start_failed';
                job.error = `Start failed: ${started.text || started.code || 'unknown error'}`;
                throw new McpToolError(job.error);
            }

            job.state = 'started';
            job.startedAt = Date.now();
            return {
                job: jobManager.describe(job),
                note: 'Job started. Poll get_gcode_job_status; the controller, its door interlock '
                    + 'and the machine UI remain in control.',
            };
        },
    });

    registry.register({
        name: 'move_z',
        description: 'Request absolute Z motion, executed on the direct path so positions PERSIST '
            + '(file jobs park back at the work origin when they complete - firmware behaviour). '
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
        }) => {
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
            const reviewText = steps.join('\n; --- next approved step ---\n');
            const delta = targetZ - currentZ;
            const name = isBatch
                ? `z-series ${coordinateSystem} [${targets.map((t) => t.toFixed(1)).join(', ')}] - ${String(args.reason).slice(0, 40)}`
                : `z-move ${coordinateSystem} Z${targetZ.toFixed(1)} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}mm) - ${String(args.reason).slice(0, 40)}`;

            const validation = validateGcode(reviewText);
            const job = jobManager.submit(reviewText, name, 'cnc', validation, 'direct', isBatch ? steps : undefined);

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
        description: 'Job record plus live progress from the machine heartbeat. Read-only.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string' },
            },
            required: ['job_id'],
            additionalProperties: false,
        },
        handler: async (args: { job_id?: string }) => {
            const job = jobManager.get(String(args.job_id || ''));
            if (!job) {
                throw new McpToolError('Unknown job_id.');
            }
            const state = connectionManager.getLatestMachineState();
            return {
                job: jobManager.describe(job),
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
            }
            return {
                ok: stopped.ok,
                text: stopped.text || null,
                job: jobManager.describe(job),
            };
        },
    });
}
