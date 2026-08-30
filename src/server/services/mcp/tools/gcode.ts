/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import { connectionManager } from '../../machine/ConnectionManager';
import { jobManager } from '../jobs';
import { McpToolError, ToolRegistry } from '../registry';
import { validateGcode } from '../validator';

// Motion policy (#23): compound motion leaves this process only as a G-code
// file submitted through the same prepare/start path as "Start on Luban",
// so the controller's job state machine and the enclosure door interlock
// apply. Starting requires a one-time code that only the human approval
// page mints (see jobs.ts).

const HEAD_TYPES = ['cnc', 'laser', 'printing'];

interface JobChannel {
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
