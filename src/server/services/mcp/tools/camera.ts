/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import config from '../../configstore';
import { connectionManager } from '../../machine/ConnectionManager';
import { CapturedFrame, captureFrame, listCameras } from '../camera';
import { McpToolError, ToolRegistry } from '../registry';
import { PositionSnapshot, getMachineSizeByIdentifier, getPositionSnapshot } from './machine';

// Motion policy (#23, refined): the direct move path is for the odd single
// action only. move_and_capture performs ONE bounded XY move at the current
// Z - there is deliberately no Z parameter; Z changes and any compound
// motion go through submit_gcode_job so the controller's job state machine
// and door interlock stay in charge.

const DEFAULT_MAX_TRAVEL_MM = 100;
const DEFAULT_FEED_RATE = 1500;
const SETTLE_TOLERANCE_MM = 0.1;
const SETTLE_TIMEOUT_MS = 30000;
const SETTLE_POLL_MS = 250;
const POST_SETTLE_DWELL_MS = 300;
const HOME_TIMEOUT_MS = 120000;
const HOME_POLL_MS = 1000;

interface GcodeChannel {
    executeGcode?: (gcode: string) => Promise<{ result: number; text?: string }>;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function frameContent(frame: CapturedFrame, meta: object): object {
    return {
        mcpContent: [
            { type: 'image', data: frame.imageBase64, mimeType: frame.mimeType },
            {
                type: 'text',
                text: JSON.stringify({
                    ...meta,
                    camera: {
                        provider: frame.provider,
                        device: frame.device,
                        capturedAt: frame.capturedAt,
                    },
                }),
            },
        ],
    };
}

function positionOrNull(): PositionSnapshot | null {
    try {
        return getPositionSnapshot();
    } catch (err) {
        return null;
    }
}

function assertSafeToMove(position: PositionSnapshot, operatorConfirmedClearance: boolean): void {
    if (position.machineStatus !== 'idle') {
        throw new McpToolError(`Machine is ${position.machineStatus || 'in an unknown state'}, not idle.`);
    }
    const state = connectionManager.getLatestMachineState() as { headStatus?: unknown; headPower?: unknown } | null;
    const headPower = Number(state?.headPower);
    if ((Number.isFinite(headPower) && headPower > 0) || state?.headStatus === true || state?.headStatus === 'on') {
        throw new McpToolError('Toolhead appears to be on (headStatus/headPower); refusing to move.');
    }
    // Homing raises Z first and is the only cure for a stale position state
    // after a reconnect, so it is the default precondition. The override is
    // for when the OPERATOR has confirmed the Z height and a clear path at
    // this Z - never pass it on the model's own judgment.
    if (position.isHomed !== true && !operatorConfirmedClearance) {
        throw new McpToolError('Machine does not report homed. Call the home tool first (Z raises before '
            + 'XY), or - only after the operator has explicitly confirmed the current Z and an '
            + 'obstacle-free path at this Z - retry with operator_confirmed_clearance: true.');
    }
}


export interface BoundedMoveArgs {
    x?: number;
    y?: number;
    coordinate_system?: string;
    feed_rate?: number;
    operator_confirmed_clearance?: boolean;
    // Internal (not exposed in any tool schema): lifts the per-call travel
    // limit for fixed, operator-set destinations like the work origin.
    unbounded_travel?: boolean;
}

/**
 * The single bounded XY move + settle + capture behind move_and_capture,
 * shared with visual_servo. Enforces every guard.
 */
export async function executeBoundedMoveAndCapture(args: BoundedMoveArgs): Promise<object> {
    if (args.x === undefined && args.y === undefined) {
        throw new McpToolError('Provide x and/or y.');
    }
    const coordinateSystem = args.coordinate_system || 'work';
    if (!['work', 'machine'].includes(coordinateSystem)) {
        throw new McpToolError('coordinate_system must be "work" or "machine".');
    }
    const feedRate = Math.min(Math.max(Number(args.feed_rate) || DEFAULT_FEED_RATE, 100), 3000);

    const before = getPositionSnapshot();
    assertSafeToMove(before, args.operator_confirmed_clearance === true);

    const current = coordinateSystem === 'work' ? before.work : before.machine;
    if (current.x === null || current.y === null) {
        throw new McpToolError('Current position unknown; cannot bound the move.');
    }
    const target = {
        x: args.x !== undefined ? Number(args.x) : current.x,
        y: args.y !== undefined ? Number(args.y) : current.y,
    };
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
        throw new McpToolError('x/y must be finite numbers.');
    }

    const travel = Math.hypot(target.x - current.x, target.y - current.y);
    const maxTravel = Number(config.get('mcpMaxJogDistance')) || DEFAULT_MAX_TRAVEL_MM;
    if (!args.unbounded_travel && travel > maxTravel) {
        throw new McpToolError(`Requested travel ${travel.toFixed(1)} mm exceeds the ${maxTravel} mm `
                    + 'per-call limit. Split the approach, or submit a gcode job.');
    }

    // Envelope check in machine coordinates when the build volume is known.
    const size = getMachineSizeByIdentifier(connectionManager.getConnectionStatus().machineIdentifier);
    const machineTarget = coordinateSystem === 'machine' ? target : {
        x: target.x - before.originOffset.x,
        y: target.y - before.originOffset.y,
    };
    if (size) {
        if (machineTarget.x < -0.5 || machineTarget.x > size.x + 0.5
                    || machineTarget.y < -0.5 || machineTarget.y > size.y + 0.5) {
            throw new McpToolError(`Target (machine ${machineTarget.x.toFixed(1)}, ${machineTarget.y.toFixed(1)}) `
                        + `is outside the ${size.x}x${size.y} build area.`);
        }
    }

    const channel = connectionManager.getCurrentChannel() as unknown as GcodeChannel;
    if (!channel || typeof channel.executeGcode !== 'function') {
        throw new McpToolError('The connected channel does not support direct moves.');
    }

    const move = `G0 X${target.x.toFixed(3)} Y${target.y.toFixed(3)} F${feedRate}`;
    const gcode = coordinateSystem === 'machine' ? `G53;\n${move};\nG54;` : move;
    const issuedAt = Date.now();
    const executed = await channel.executeGcode(gcode);
    if (executed.result !== 0) {
        throw new McpToolError(`Move rejected by controller: ${executed.text || executed.result}`);
    }

    // Wait for a post-move heartbeat that reports the target, twice,
    // so the returned position is what the firmware says, not what
    // was commanded (#11).
    let settled: PositionSnapshot | null = null;
    let stableReports = 0;
    let lastTimestamp = 0;
    const deadline = issuedAt + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await sleep(SETTLE_POLL_MS);
        const now = getPositionSnapshot();
        const reportTime = Date.now() - now.reportAgeMs;
        if (reportTime <= issuedAt || reportTime === lastTimestamp) {
            continue; // not a fresh post-move report
        }
        lastTimestamp = reportTime;
        const reported = coordinateSystem === 'work' ? now.work : now.machine;
        if (reported.x !== null && reported.y !== null
                    && Math.abs(reported.x - target.x) <= SETTLE_TOLERANCE_MM
                    && Math.abs(reported.y - target.y) <= SETTLE_TOLERANCE_MM) {
            stableReports += 1;
            if (stableReports >= 2) {
                settled = now;
                break;
            }
        } else {
            stableReports = 0;
        }
    }
    if (!settled) {
        const last = positionOrNull();
        throw new McpToolError('Move did not settle at the target within '
                    + `${SETTLE_TIMEOUT_MS / 1000}s. Last reported position: ${JSON.stringify(last && {
                        work: last.work, machine: last.machine,
                    })}`);
    }

    await sleep(POST_SETTLE_DWELL_MS);
    const frame = await captureFrame();
    const after = getPositionSnapshot();

    return frameContent(frame, {
        commanded: { ...target, coordinate_system: coordinateSystem, feed_rate: feedRate },
        position: after,
        note: 'position is firmware-reported after settling, not the commanded target',
    });
}

export function registerCameraTools(registry: ToolRegistry): void {
    registry.register({
        name: 'list_cameras',
        description: 'List available capture sources: the configured snapshot URL, or DirectShow '
            + 'video devices found by ffmpeg. Read-only.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => listCameras() as unknown as object,
    });

    registry.register({
        name: 'capture_frame',
        description: 'Capture one frame from the workshop camera (configstore: mcpCameraUrl for an '
            + 'HTTP snapshot source, else ffmpeg with mcpCameraDevice/mcpFfmpegPath). The frame is '
            + 'stamped with the firmware-reported position it was taken at, when a machine is '
            + 'connected. No motion.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
            const frame = await captureFrame();
            return frameContent(frame, { position: positionOrNull() });
        },
    });

    registry.register({
        name: 'home',
        description: 'MACHINE home (G28): drives every axis to its limit switches - this is NOT the '
            + 'work origin; moving to work X0 Y0 is the separate goto_work_origin operation. Z rises '
            + 'first, making this the default first move after (re)connecting: it also clears any '
            + 'stale position state between Luban and the machine. Requires an idle machine with the '
            + 'toolhead off. Waits for the firmware to report homed.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
            const before = getPositionSnapshot();
            if (before.machineStatus !== 'idle') {
                throw new McpToolError(`Machine is ${before.machineStatus || 'in an unknown state'}, not idle.`);
            }
            const state = connectionManager.getLatestMachineState() as { headStatus?: unknown; headPower?: unknown } | null;
            const headPower = Number(state?.headPower);
            if ((Number.isFinite(headPower) && headPower > 0) || state?.headStatus === true || state?.headStatus === 'on') {
                throw new McpToolError('Toolhead appears to be on (headStatus/headPower); refusing to home.');
            }

            const channel = connectionManager.getCurrentChannel() as unknown as GcodeChannel;
            if (!channel || typeof channel.executeGcode !== 'function') {
                throw new McpToolError('The connected channel does not support direct commands.');
            }

            const issuedAt = Date.now();
            const executed = await channel.executeGcode('G28');
            if (executed.result !== 0) {
                throw new McpToolError(`Homing rejected by controller: ${executed.text || executed.result}`);
            }

            // Homing on the A350 takes tens of seconds; wait for a fresh
            // post-command heartbeat that reports homed and idle again.
            const deadline = issuedAt + HOME_TIMEOUT_MS;
            while (Date.now() < deadline) {
                await sleep(HOME_POLL_MS);
                const now = positionOrNull();
                if (!now) {
                    continue;
                }
                const reportTime = Date.now() - now.reportAgeMs;
                if (reportTime > issuedAt && now.isHomed === true && now.machineStatus === 'idle') {
                    return {
                        homed: true,
                        position: now,
                        note: 'Work origins are user-set per workspace and persist across homing. '
                            + 'Check position.warnings, and if coordinates look wrong verify the frame '
                            + 'with query_firmware_position before trusting work coordinates.',
                    };
                }
            }
            const last = positionOrNull();
            throw new McpToolError(`Machine did not report homed within ${HOME_TIMEOUT_MS / 1000}s. `
                + `Last state: ${JSON.stringify(last && { isHomed: last.isHomed, machineStatus: last.machineStatus })}`);
        },
    });

    registry.register({
        name: 'goto_work_origin',
        description: 'Go to the WORK origin: one bounded XY move to work X0 Y0 at the CURRENT Z - '
            + 'semantically distinct from home, which drives to the machine limit switches. Z is '
            + 'deliberately not touched; position Z via submit_gcode_job first if needed. Same '
            + 'guards as move_and_capture (idle, toolhead off, homed-first unless the operator '
            + 'has confirmed clearance), and a frame is captured on arrival.',
        inputSchema: {
            type: 'object',
            properties: {
                feed_rate: { type: 'number', description: `mm/min, default ${DEFAULT_FEED_RATE}, max 3000.` },
                operator_confirmed_clearance: {
                    type: 'boolean',
                    description: 'Set true ONLY when the human operator has explicitly confirmed the '
                        + 'current Z and an obstacle-free path at this Z; skips the homed-first requirement.',
                },
            },
            additionalProperties: false,
        },
        handler: async (args: { feed_rate?: number; operator_confirmed_clearance?: boolean }) => {
            // The work origin is a fixed, operator-set destination, so the
            // per-call travel limit (meant to bound the blast radius of a
            // wrong coordinate) does not apply; every other guard does.
            return executeBoundedMoveAndCapture({
                x: 0,
                y: 0,
                coordinate_system: 'work',
                feed_rate: args.feed_rate,
                operator_confirmed_clearance: args.operator_confirmed_clearance,
                unbounded_travel: true,
            });
        },
    });

    registry.register({
        name: 'move_and_capture',
        description: 'ONE bounded XY move at the current Z via the direct path, wait for the '
            + 'firmware-reported position to settle, then capture a frame stamped with that '
            + 'position. No Z parameter by design: Z changes and compound motion must go through '
            + 'submit_gcode_job (door interlock). Requires an idle machine with the toolhead off. '
            + `Travel per call is limited (configstore mcpMaxJogDistance, default ${DEFAULT_MAX_TRAVEL_MM} mm).`,
        inputSchema: {
            type: 'object',
            properties: {
                x: { type: 'number', description: 'Target X. Omit to keep current X.' },
                y: { type: 'number', description: 'Target Y. Omit to keep current Y.' },
                coordinate_system: {
                    type: 'string',
                    enum: ['work', 'machine'],
                    description: 'Which coordinates x/y are in. Default work.',
                },
                feed_rate: { type: 'number', description: `mm/min, default ${DEFAULT_FEED_RATE}, max 3000.` },
                operator_confirmed_clearance: {
                    type: 'boolean',
                    description: 'Set true ONLY when the human operator has explicitly confirmed the '
                        + 'current Z and an obstacle-free path at this Z; skips the homed-first requirement.',
                },
            },
            additionalProperties: false,
        },
        handler: async (args: BoundedMoveArgs) => executeBoundedMoveAndCapture(args),
    });
}
