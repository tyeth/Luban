/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import { jobManager } from '../jobs';
import { McpToolError, ToolRegistry } from '../registry';
import {
    describePlanAsGcode,
    getToolSetterConfig,
    planToolSetterRun,
    runToolSetterProcedure,
    setToolSetterConfig,
} from '../toolSetter';
import { validateGcode } from '../validator';

export function registerToolSetterTools(registry: ToolRegistry, getConfirmBaseUrl: () => string): void {
    registry.register({
        name: 'set_tool_setter_config',
        description: 'Store the tool setter reference: its centre in MACHINE coordinates, the machine '
            + 'Z at which a known bit triggers it, that bit\'s length, and the longest bit in use. All '
            + 'values come from the OPERATOR (or a store_as_reference run) - never from visual '
            + 'estimation. The expected trigger Z for any bit follows as '
            + 'triggerZ + (bit length - reference length).',
        inputSchema: {
            type: 'object',
            properties: {
                center_x: { type: 'number', description: 'Machine X of the setter centre.' },
                center_y: { type: 'number', description: 'Machine Y of the setter centre.' },
                trigger_z: { type: 'number', description: 'Machine Z at trigger with the reference bit.' },
                reference_bit_length_mm: { type: 'number', description: 'Protrusion of the reference bit, mm.' },
                longest_bit_length_mm: { type: 'number', description: 'Longest bit in use, mm - sets the safe start height.' },
                floor_margin_mm: { type: 'number', description: 'Allowed descent below the expected trigger Z, default 3.' },
                notes: { type: 'string' },
            },
            required: ['center_x', 'center_y', 'trigger_z', 'reference_bit_length_mm', 'longest_bit_length_mm'],
            additionalProperties: false,
        },
        handler: async (args: {
            center_x?: number;
            center_y?: number;
            trigger_z?: number;
            reference_bit_length_mm?: number;
            longest_bit_length_mm?: number;
            floor_margin_mm?: number;
            notes?: string;
        }) => {
            const numbers = {
                centerX: Number(args.center_x),
                centerY: Number(args.center_y),
                triggerZ: Number(args.trigger_z),
                referenceBitLengthMm: Number(args.reference_bit_length_mm),
                longestBitLengthMm: Number(args.longest_bit_length_mm),
            };
            if (Object.values(numbers).some((v) => !Number.isFinite(v))) {
                throw new McpToolError('All coordinates and lengths must be finite numbers.');
            }
            if (numbers.referenceBitLengthMm <= 0 || numbers.longestBitLengthMm < numbers.referenceBitLengthMm - 0.001) {
                throw new McpToolError('Bit lengths must be positive and longest >= reference.');
            }
            const floorMarginMm = args.floor_margin_mm !== undefined ? Number(args.floor_margin_mm) : 3;
            if (!Number.isFinite(floorMarginMm) || floorMarginMm < 0.5 || floorMarginMm > 20) {
                throw new McpToolError('floor_margin_mm must be 0.5-20.');
            }
            setToolSetterConfig({
                ...numbers,
                floorMarginMm,
                notes: args.notes ? String(args.notes) : null,
            });
            return { config: getToolSetterConfig() };
        },
    });

    registry.register({
        name: 'get_tool_setter_config',
        description: 'The stored tool setter reference (centre, trigger Z, bit lengths). Read-only.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => ({ config: getToolSetterConfig() }),
    });

    registry.register({
        name: 'run_tool_setter',
        description: 'Stage a tool height measurement against the tool setter for human confirmation. '
            + 'The declared bit_length_mm comes from the OPERATOR. Preconditions: machine homed and '
            + 'idle, probe feed connected (overtravel tripwire armed), toolsetter sensor readable and '
            + 'not triggered. The confirm page shows the full motion envelope; after approval one '
            + 'start_gcode_job call runs the whole server-driven routine: XY to the centre, Z travel '
            + 'to the safe start height, 1 mm sensor-gated descent to a slow zone, 0.1 mm approach to '
            + 'contact, then repeated quick lift-and-retest confirm cycles - retreats and reports the '
            + 'median trigger Z, the per-pass contacts and spread, and the derived bit length. '
            + 'A hard floor and the overtravel tripwire bound it (~1-2 minutes).',
        inputSchema: {
            type: 'object',
            properties: {
                bit_length_mm: {
                    type: 'number',
                    description: 'Approximate protrusion of the FITTED bit in mm, as stated by the operator.',
                },
                coarse_step_mm: { type: 'number', description: 'Coarse descent step, default 1 (0.2-2).' },
                fine_step_mm: { type: 'number', description: 'Fine step, default 0.1 (0.02-0.5).' },
                backoff_mm: { type: 'number', description: 'Backoff before the confirm pass, default 0.3.' },
                sensor_delay_ms: { type: 'number', description: 'Wait for the sensor report after each step, default 200.' },
                confirm_passes: {
                    type: 'number',
                    description: 'Quick lift-and-retest cycles after first fine contact; the result is '
                        + 'their median and the spread is reported. Default 3 (1-10).',
                },
                start_clearance_mm: { type: 'number', description: 'Clearance above the longest-bit trigger height, default 30 (10-150).' },
                slow_zone_mm: {
                    type: 'number',
                    description: 'The coarse ladder stops this far above the expected trigger and fine '
                        + 'steps take over, capping the press into the setter at one fine step. Default 1.',
                },
                store_as_reference: {
                    type: 'boolean',
                    description: 'After a successful run, store the measured trigger Z and this bit '
                        + 'length as the new reference (locks in the setter height).',
                },
                reason: { type: 'string', description: 'Shown to the operator: why this measurement is needed.' },
            },
            required: ['bit_length_mm', 'reason'],
            additionalProperties: false,
        },
        handler: async (args: { bit_length_mm?: number; reason?: string; [key: string]: unknown }) => {
            if (!String(args.reason || '').trim()) {
                throw new McpToolError('reason is required; it is shown to the operator.');
            }
            const plan = planToolSetterRun(args);
            const envelope = describePlanAsGcode(plan);
            const validation = validateGcode(envelope);
            const job = jobManager.submit(
                envelope,
                `tool-setter bit ${plan.bitLengthMm}mm - ${String(args.reason).slice(0, 40)}`,
                'cnc',
                validation,
                'procedure'
            );
            job.runner = async () => runToolSetterProcedure(plan);

            return {
                job: jobManager.describe(job),
                plan: {
                    center: { x: plan.config.centerX, y: plan.config.centerY },
                    expected_trigger_z: plan.expectedTriggerZ,
                    start_z: plan.startZ,
                    floor_z: plan.floorZ,
                    coarse_floor_z: plan.coarseFloorZ,
                    slow_zone_mm: plan.slowZoneMm,
                    coarse_step_mm: plan.coarseStepMm,
                    fine_step_mm: plan.fineStepMm,
                    backoff_mm: plan.backoffMm,
                    sensor_delay_ms: plan.sensorDelayMs,
                    confirm_passes: plan.confirmPasses,
                    store_as_reference: plan.storeAsReference,
                },
                confirm_url: `${getConfirmBaseUrl()}/confirm/${job.id}`,
                next_step: 'Ask the operator to open confirm_url, review the SERVER-DRIVEN PROCEDURE '
                    + 'banner and the motion envelope, and approve. Their one-time code passed to '
                    + 'start_gcode_job runs the whole routine; it returns the measurement when done '
                    + '(several minutes - the confirm pass is deliberately slow).',
            };
        },
    });
}
