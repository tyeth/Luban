/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import { CalibrationEntry, calibrationStore } from '../calibration';
import { McpToolError, ToolRegistry } from '../registry';
import { executeBoundedMoveAndCapture } from './camera';
import { getPositionSnapshot } from './machine';

// visual_servo executes ONE correction step per call - the agent supplies
// the pixel error, the stored calibration turns it into a machine XY move,
// and the loop lives in the agent, not here. Each step goes through the
// same guarded single-move path as move_and_capture (#23).

const DEFAULT_STEP_LIMIT_MM = 5;
const MAX_STEP_LIMIT_MM = 20;
const DEFAULT_Y_TOLERANCE_MM = 2;

function isMatrix(value: unknown): value is [[number, number], [number, number]] {
    return Array.isArray(value) && value.length === 2
        && value.every((row) => Array.isArray(row) && row.length === 2
            && row.every((cell) => Number.isFinite(Number(cell))));
}

function describeEntry(entry: CalibrationEntry): object {
    return entry;
}

export function registerCalibrationTools(registry: ToolRegistry): void {
    registry.register({
        name: 'set_camera_calibration',
        description: 'Persist a pixel-to-machine calibration, keyed by the machine Y it was '
            + 'derived at (the SM2 platform travels in Y, so a mapping is only valid at that Y). '
            + 'matrix maps a pixel delta [du, dv] to the machine XY move [dx, dy] in mm that '
            + 'cancels it. Survives restarts.',
        inputSchema: {
            type: 'object',
            properties: {
                valid_at_y: { type: 'number', description: 'Machine Y the calibration frame was captured at.' },
                z: { type: 'number', description: 'Machine Z the calibration frame was captured at.' },
                matrix: {
                    type: 'array',
                    description: '2x2 row-major: [[m00, m01], [m10, m11]]; [dx, dy] = M . [du, dv].',
                    items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
                    minItems: 2,
                    maxItems: 2,
                },
                notes: { type: 'string', description: 'Free-form provenance: grid used, residuals, tilt.' },
            },
            required: ['valid_at_y', 'z', 'matrix'],
            additionalProperties: false,
        },
        handler: async (args: { valid_at_y?: number; z?: number; matrix?: unknown; notes?: string }) => {
            const validAtY = Number(args.valid_at_y);
            const z = Number(args.z);
            if (!Number.isFinite(validAtY) || !Number.isFinite(z)) {
                throw new McpToolError('valid_at_y and z must be finite numbers.');
            }
            if (!isMatrix(args.matrix)) {
                throw new McpToolError('matrix must be a 2x2 array of numbers.');
            }
            const entry = calibrationStore.add({
                validAtY,
                z,
                matrix: args.matrix,
                notes: args.notes ? String(args.notes) : null,
            });
            return { entry: describeEntry(entry) };
        },
    });

    registry.register({
        name: 'get_camera_calibration',
        description: 'Fetch calibrations: by id, nearest to a machine Y (within tolerance), or all. '
            + 'Read-only.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                y: { type: 'number', description: 'Machine Y to match against valid_at_y.' },
                tolerance_mm: { type: 'number', description: `Match tolerance for y, default ${DEFAULT_Y_TOLERANCE_MM}.` },
            },
            additionalProperties: false,
        },
        handler: async (args: { id?: string; y?: number; tolerance_mm?: number }) => {
            if (args.id) {
                const entry = calibrationStore.get(String(args.id));
                if (!entry) {
                    throw new McpToolError('Unknown calibration id.');
                }
                return { entry: describeEntry(entry) };
            }
            if (args.y !== undefined) {
                const tolerance = Number(args.tolerance_mm) || DEFAULT_Y_TOLERANCE_MM;
                const match = calibrationStore.findNearest(Number(args.y), tolerance);
                return {
                    entry: match ? describeEntry(match.entry) : null,
                    distance_mm: match ? match.distance : null,
                    all: calibrationStore.list().map((e) => ({ id: e.id, validAtY: e.validAtY, z: e.z })),
                };
            }
            return { entries: calibrationStore.list().map(describeEntry) };
        },
    });

    registry.register({
        name: 'delete_camera_calibration',
        description: 'Delete one stored calibration by id.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
        },
        handler: async (args: { id?: string }) => {
            const removed = calibrationStore.remove(String(args.id || ''));
            if (!removed) {
                throw new McpToolError('Unknown calibration id.');
            }
            return { removed: true };
        },
    });

    registry.register({
        name: 'visual_servo',
        description: 'One visual-servo correction step: turns a pixel error (target_pixel - '
            + 'feature_pixel) into a machine XY move using a stored calibration, executes it '
            + 'through the same guarded single-move path as move_and_capture, and returns the '
            + 'new frame. The iteration loop belongs to the caller. Step size is clamped '
            + `(max_step_mm, default ${DEFAULT_STEP_LIMIT_MM}, cap ${MAX_STEP_LIMIT_MM}).`,
        inputSchema: {
            type: 'object',
            properties: {
                feature_pixel: {
                    type: 'object',
                    properties: { u: { type: 'number' }, v: { type: 'number' } },
                    required: ['u', 'v'],
                    description: 'Where the feature currently images.',
                },
                target_pixel: {
                    type: 'object',
                    properties: { u: { type: 'number' }, v: { type: 'number' } },
                    required: ['u', 'v'],
                    description: 'Where the feature should image.',
                },
                calibration_id: { type: 'string', description: 'Omit to auto-select nearest to the current machine Y.' },
                max_step_mm: { type: 'number' },
                feed_rate: { type: 'number' },
                operator_confirmed_clearance: {
                    type: 'boolean',
                    description: 'Set true ONLY when the human operator has explicitly confirmed the '
                        + 'current Z and an obstacle-free path at this Z; skips the homed-first requirement.',
                },
            },
            required: ['feature_pixel', 'target_pixel'],
            additionalProperties: false,
        },
        handler: async (args: {
            feature_pixel?: { u?: number; v?: number };
            target_pixel?: { u?: number; v?: number };
            calibration_id?: string;
            max_step_mm?: number;
            feed_rate?: number;
            operator_confirmed_clearance?: boolean;
        }) => {
            const du = Number(args.target_pixel?.u) - Number(args.feature_pixel?.u);
            const dv = Number(args.target_pixel?.v) - Number(args.feature_pixel?.v);
            if (!Number.isFinite(du) || !Number.isFinite(dv)) {
                throw new McpToolError('feature_pixel and target_pixel must have numeric u and v.');
            }

            const position = getPositionSnapshot();
            if (position.machine.x === null || position.machine.y === null) {
                throw new McpToolError('Current machine position unknown.');
            }

            let entry: CalibrationEntry | null = null;
            let entryDistance: number | null = null;
            if (args.calibration_id) {
                entry = calibrationStore.get(String(args.calibration_id));
                if (!entry) {
                    throw new McpToolError('Unknown calibration id.');
                }
                entryDistance = Math.abs(entry.validAtY - position.machine.y);
            } else {
                const match = calibrationStore.findNearest(position.machine.y, DEFAULT_Y_TOLERANCE_MM);
                if (!match) {
                    throw new McpToolError(`No calibration within ${DEFAULT_Y_TOLERANCE_MM} mm of machine Y `
                        + `${position.machine.y.toFixed(1)}. Store one with set_camera_calibration, or pass calibration_id.`);
                }
                entry = match.entry;
                entryDistance = match.distance;
            }

            const [[m00, m01], [m10, m11]] = entry.matrix;
            let dx = m00 * du + m01 * dv;
            let dy = m10 * du + m11 * dv;

            const stepLimit = Math.min(Number(args.max_step_mm) || DEFAULT_STEP_LIMIT_MM, MAX_STEP_LIMIT_MM);
            const magnitude = Math.hypot(dx, dy);
            const clamped = magnitude > stepLimit;
            if (clamped && magnitude > 0) {
                dx *= stepLimit / magnitude;
                dy *= stepLimit / magnitude;
            }

            const warnings: string[] = [];
            if (entryDistance !== null && entryDistance > DEFAULT_Y_TOLERANCE_MM) {
                warnings.push(`Calibration ${entry.id} is ${entryDistance.toFixed(1)} mm from the current Y; scale may be off.`);
            }
            if (Math.abs(dy) > DEFAULT_Y_TOLERANCE_MM) {
                warnings.push('This step moves Y; the calibration is keyed to Y, so re-derive or re-select after the move.');
            }

            const result = await executeBoundedMoveAndCapture({
                x: position.machine.x + dx,
                y: position.machine.y + dy,
                coordinate_system: 'machine',
                feed_rate: args.feed_rate,
                operator_confirmed_clearance: args.operator_confirmed_clearance,
            }) as { mcpContent: object[] };

            // Splice servo metadata into the text part of the frame result.
            const servoMeta = {
                pixel_error: { du, dv },
                applied_mm: { dx, dy },
                clamped,
                calibration: { id: entry.id, validAtY: entry.validAtY, z: entry.z, distance_mm: entryDistance },
                warnings,
            };
            return {
                mcpContent: [
                    ...result.mcpContent,
                    { type: 'text', text: JSON.stringify({ visual_servo: servoMeta }) },
                ],
            };
        },
    });
}
