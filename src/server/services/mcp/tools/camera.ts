/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import logger from '../../../lib/logger';
import config from '../../configstore';
import { mcpBroadcast } from '../index';
import { connectionManager } from '../../machine/ConnectionManager';
import { CapturedFrame, captureFrame, getCachedFrame, getCachedFrameIds, listCameras } from '../camera';
import { decodeToGray, trackFeature } from '../tracking';
import { McpToolError, ToolRegistry } from '../registry';
import { landmarkStore } from '../landmarks';
import { probeFeedService } from '../probeFeed';
import { PositionSnapshot, getMachineSizeByIdentifier, getPositionSnapshot, safeTraverseZ } from './machine';

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

export interface GcodeChannel {
    executeGcode?: (gcode: string) => Promise<{ result: number; text?: string }>;
}

const gcodeLog = logger('service:mcp:gcode');

/**
 * Send gcode on the direct path AND mirror exactly what was sent (plus the
 * controller's reply) to the UI console AND the server log - the console
 * broadcast is invisible to anyone reading the process log, and a headless
 * session debugging "controller said ok but nothing moved" needs the reply.
 */
export async function sendGcodeVisible(channel: GcodeChannel, tool: string, gcode: string): Promise<{ result: number; text?: string }> {
    mcpBroadcast('mcp:gcode', { tool, gcode });
    gcodeLog.info(`[${tool}] > ${gcode.replace(/\r?\n/g, ' | ')}`);
    // Crash-guard bracket: the HTTP channel executes synchronously, so the
    // await spans the motion window - a contact-sensor trigger inside it
    // that no procedure expects is treated as a collision (probeFeed).
    probeFeedService.motionBegin();
    let executed;
    try {
        executed = await channel.executeGcode(gcode);
    } finally {
        probeFeedService.motionEnd();
    }
    const response = executed.text || (executed.result === 0 ? 'ok' : `result=${executed.result}`);
    mcpBroadcast('mcp:gcode', { tool, response });
    gcodeLog.info(`[${tool}] < ${String(response).replace(/\r?\n/g, ' | ')}`);
    return executed;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * The camera-to-spindle offset is fixed hardware geometry, so where the
 * endmill images is a constant of the rig, not something to re-discover by
 * vision each frame. The operator records it once in configstore
 * mcpToolRegion (fractional box {u0,v0,u1,v1}, optional note) and every
 * frame carries it - turning tool identification into a lookup.
 */
function expectedToolRegion(): object | null {
    const raw = config.get('mcpToolRegion');
    if (!raw) {
        return null;
    }
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : (raw as object);
    } catch (err) {
        return null;
    }
}

function positionOrNull(): PositionSnapshot | null {
    try {
        return getPositionSnapshot();
    } catch (err) {
        return null;
    }
}

/**
 * Landmarks near the current machine XY (#50): identities the operator has
 * stated once, surfaced on every capture so they are never re-guessed.
 */
function nearbyLandmarks(): object[] {
    const position = positionOrNull();
    const x = position?.machine.x;
    const y = position?.machine.y;
    if (x === null || x === undefined || y === null || y === undefined) {
        return [];
    }
    return landmarkStore.near(x, y, 120);
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
                        frameId: frame.frameId,
                        provider: frame.provider,
                        device: frame.device,
                        capturedAt: frame.capturedAt,
                        expectedToolRegion: expectedToolRegion(),
                        nearbyLandmarks: nearbyLandmarks(),
                    },
                }),
            },
        ],
    };
}

function assertSafeToMove(position: PositionSnapshot, operatorConfirmedClearance: boolean): void {
    probeFeedService.assertNoOvertravel();
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
    wait_until_moved?: boolean;
    capture?: boolean;
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

    // OPERATOR LAW (2026-09-01, after the probe crash): X/Y traverses happen
    // at top gantry height. An XY move below the safe traverse Z, or one
    // whose path crosses an obstacle landmark below its clearance height, is
    // refused unless the operator has EXPLICITLY confirmed this corridor -
    // never on the model's own judgment, never derived from assumptions
    // about what is on the bed.
    const machineZ = before.machine.z;
    if (args.operator_confirmed_clearance !== true && machineZ !== null) {
        const traverseFloor = safeTraverseZ();
        if (machineZ < traverseFloor) {
            throw new McpToolError(`XY move refused: machine Z ${machineZ.toFixed(1)} is below the safe `
                + `traverse height ${traverseFloor} (top gantry). Retreat Z first (move_z, operator-`
                + 'confirmed), then traverse, then descend at the destination. Only the operator\'s '
                + 'explicit word (operator_confirmed_clearance: true) authorises a lower corridor.');
        }
        const machineFrom = { x: before.machine.x, y: before.machine.y };
        if (machineFrom.x !== null && machineFrom.y !== null) {
            const obstacles = landmarkStore.obstaclesOnPath(
                machineFrom.x, machineFrom.y, machineTarget.x, machineTarget.y, machineZ
            );
            if (obstacles.length) {
                throw new McpToolError('XY move refused: the path crosses obstacle landmark(s) '
                    + `${obstacles.map((l) => `"${l.name}" (clearance Z ${l.clearanceZ})`).join(', ')} `
                    + `while at machine Z ${machineZ.toFixed(1)}. Raise Z above the clearance, or get the `
                    + 'operator\'s explicit confirmation for this corridor.');
            }
        }
    }
    if (size) {
        // Floors allow real overtravel: the A350 X home switch sits at
        // machine -19, so "keep the current X while parked at home" must
        // pass (a target at the machine's own resting position was being
        // rejected live). Matches the position-sanity bounds.
        if (machineTarget.x < -25 || machineTarget.x > size.x + 40
                    || machineTarget.y < -25 || machineTarget.y > size.y + 40) {
            throw new McpToolError(`Target (machine ${machineTarget.x.toFixed(1)}, ${machineTarget.y.toFixed(1)}) `
                        + `is outside the ${size.x}x${size.y} build area (overtravel allowance -25..+40).`);
        }
    }

    const channel = connectionManager.getCurrentChannel() as unknown as GcodeChannel;
    if (!channel || typeof channel.executeGcode !== 'function') {
        throw new McpToolError('The connected channel does not support direct moves.');
    }

    const move = `G0 X${target.x.toFixed(3)} Y${target.y.toFixed(3)} F${feedRate}`;
    const gcode = coordinateSystem === 'machine' ? `G53;\n${move};\nG54;` : move;
    const issuedAt = Date.now();
    const executed = await sendGcodeVisible(channel, 'move', gcode);
    if (executed.result !== 0) {
        throw new McpToolError(`Move rejected by controller: ${executed.text || executed.result}`);
    }

    if (args.wait_until_moved === false) {
        // Fire-and-return: no settle, no capture - the frame would not show
        // the commanded position. Poll get_position before relying on it.
        return {
            commanded: { ...target, coordinate_system: coordinateSystem, feed_rate: feedRate },
            position: null,
            position_verified: false,
            note: 'wait_until_moved was false: move accepted but not awaited, and no frame was '
                + 'captured (it would not show the commanded position). Poll get_position.',
        };
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
    if (args.capture === false) {
        return {
            commanded: { ...target, coordinate_system: coordinateSystem, feed_rate: feedRate },
            position: getPositionSnapshot(),
            position_verified: true,
            note: 'position is firmware-reported after settling; capture was false so no frame was taken',
        };
    }
    const frame = await captureFrame();
    const after = getPositionSnapshot();

    return frameContent(frame, {
        commanded: { ...target, coordinate_system: coordinateSystem, feed_rate: feedRate },
        position: after,
        position_verified: true,
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
        name: 'set_tool_region',
        description: 'Update the expectedToolRegion that every capture reports: the fractional box '
            + 'where the endmill images (fixed camera-to-spindle geometry). Refine it from live '
            + 'frames instead of round-tripping through configuration edits. Persists.',
        inputSchema: {
            type: 'object',
            properties: {
                u0: { type: 'number' },
                v0: { type: 'number' },
                u1: { type: 'number' },
                v1: { type: 'number' },
                note: { type: 'string', description: 'Provenance: how the box was determined.' },
            },
            required: ['u0', 'v0', 'u1', 'v1'],
            additionalProperties: false,
        },
        handler: async (args: { u0?: number; v0?: number; u1?: number; v1?: number; note?: string }) => {
            const box = [args.u0, args.v0, args.u1, args.v1].map(Number);
            if (box.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
                throw new McpToolError('u0/v0/u1/v1 must be fractions in [0, 1].');
            }
            if (box[0] >= box[2] || box[1] >= box[3]) {
                throw new McpToolError('Require u0 < u1 and v0 < v1.');
            }
            const region = {
                u0: box[0],
                v0: box[1],
                u1: box[2],
                v1: box[3],
                note: args.note ? String(args.note) : undefined,
            };
            config.set('mcpToolRegion', region);
            return { stored: region };
        },
    });

    registry.register({
        name: 'track_feature',
        description: 'Template-match a patch between two cached frames (by the frameId each capture '
            + 'reports): give the pixel of a feature in one frame and get its measured pixel in the '
            + 'other, with an NCC confidence score. Use this instead of eyeballing pixel coordinates '
            + 'when deriving calibrations or measuring servo error - hand-estimated pixels were the '
            + 'dominant field error source. A small second-peak gap warns of repetitive-grid '
            + 'ambiguity. No motion, no capture.',
        inputSchema: {
            type: 'object',
            properties: {
                template_frame_id: { type: 'string', description: 'Frame the feature pixel refers to.' },
                search_frame_id: { type: 'string', description: 'Frame to locate the feature in.' },
                point: {
                    type: 'object',
                    properties: { u: { type: 'number' }, v: { type: 'number' } },
                    required: ['u', 'v'],
                    description: 'Feature pixel in the template frame.',
                },
                patch_size: { type: 'number', description: 'Odd patch edge in px, default 41, max 101.' },
                search_radius: { type: 'number', description: 'Search half-window in px, default 120, max 250.' },
                expected_shift: {
                    type: 'object',
                    properties: { du: { type: 'number' }, dv: { type: 'number' } },
                    required: ['du', 'dv'],
                    description: 'Optional predicted pixel shift (e.g. J x commanded move). Breaks '
                        + 'ties among near-best candidates on repetitive grids; the response says '
                        + 'when the expectation, not the raw score, chose the match.',
                },
            },
            required: ['template_frame_id', 'search_frame_id', 'point'],
            additionalProperties: false,
        },
        handler: async (args: {
            template_frame_id?: string;
            search_frame_id?: string;
            point?: { u?: number; v?: number };
            patch_size?: number;
            search_radius?: number;
            expected_shift?: { du?: number; dv?: number };
        }) => {
            const templateJpg = getCachedFrame(String(args.template_frame_id || ''));
            const searchJpg = getCachedFrame(String(args.search_frame_id || ''));
            if (!templateJpg || !searchJpg) {
                throw new McpToolError(`Unknown frame id. Cached frames: ${getCachedFrameIds().join(', ') || 'none'} `
                    + '(the cache holds the last 12 captures of this session).');
            }
            const u = Math.round(Number(args.point?.u));
            const v = Math.round(Number(args.point?.v));
            if (!Number.isFinite(u) || !Number.isFinite(v)) {
                throw new McpToolError('point.u and point.v must be numbers.');
            }
            let patch = Math.round(Number(args.patch_size) || 41);
            patch = Math.min(Math.max(patch % 2 === 0 ? patch + 1 : patch, 11), 101);
            const radius = Math.min(Math.max(Math.round(Number(args.search_radius) || 120), 20), 250);

            let expected: { du: number; dv: number } | undefined;
            if (args.expected_shift) {
                const edu = Number(args.expected_shift.du);
                const edv = Number(args.expected_shift.dv);
                if (!Number.isFinite(edu) || !Number.isFinite(edv)) {
                    throw new McpToolError('expected_shift.du and .dv must be numbers.');
                }
                expected = { du: edu, dv: edv };
            }

            const result = trackFeature(decodeToGray(templateJpg), decodeToGray(searchJpg), u, v, patch, radius, expected);
            return {
                template_frame_id: args.template_frame_id,
                search_frame_id: args.search_frame_id,
                point: { u, v },
                matched_point: result.matchedPoint,
                pixel_shift: { du: result.du, dv: result.dv },
                score: result.score,
                second_peak_gap: result.secondPeakGap,
                chosen_by: result.chosenBy,
                distance_from_expected: result.distanceFromExpected,
                raw_best: result.rawBest,
                patch_size: patch,
                search_radius: radius,
                warnings: result.warnings,
            };
        },
    });

    registry.register({
        name: 'query_firmware_position',
        description: 'Ask the firmware directly for its position report (M114) and return the RAW '
            + 'controller response alongside the heartbeat-derived view. This is the authoritative '
            + 'way to establish which coordinate frame the controller is in when heartbeat-derived '
            + 'machine coordinates look wrong (e.g. after homing). Read-only, no motion.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
            const channel = connectionManager.getCurrentChannel() as unknown as GcodeChannel;
            if (!channel || typeof channel.executeGcode !== 'function') {
                throw new McpToolError('No machine connected, or the channel does not support direct commands.');
            }
            const executed = await sendGcodeVisible(channel, 'query_firmware_position', 'M114');
            return {
                raw: executed.text || null,
                result: executed.result,
                heartbeat: positionOrNull(),
            };
        },
    });

    registry.register({
        name: 'home',
        description: 'MACHINE home (G28): drives every axis to its limit switches - this is NOT the '
            + 'work origin; moving to work X0 Y0 is the separate goto_work_origin operation. Z rises '
            + 'first, making this the default first move after (re)connecting: it also clears any '
            + 'stale position state between Luban and the machine, using the same G53;G28;G54 '
            + 'sequence as Luban itself (home in the machine workspace, then reselect workspace 0). '
            + 'WARNING: with the rotary module '
            + 'fitted, G28 also homes B - stock indexed on the rotary WILL rotate (observed -45 to 0 '
            + 'on hardware); warn the operator first. Requires an idle machine with the toolhead '
            + 'off. Waits for the firmware to report homed.',
        inputSchema: {
            type: 'object',
            properties: {
                wait_until_moved: {
                    type: 'boolean',
                    description: 'Default true: block ~15-20s until the firmware reports homed and '
                        + 'settled. false returns right after G28 is accepted - poll get_position '
                        + 'for isHomed before any motion.',
                },
            },
            additionalProperties: false,
        },
        handler: async (args: { wait_until_moved?: boolean }) => {
            probeFeedService.assertNoOvertravel();
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
            // Luban's own Home button sends G53; G28; G54 - home in the
            // machine workspace, then reselect workspace 0. A bare G28 leaves
            // the controller reporting positions in an unselected workspace
            // (observed: derived machine Y 464/Z 656 on the A350).
            const executed = await sendGcodeVisible(channel, 'home', 'G53;\nG28;\nG54;');
            if (executed.result !== 0) {
                throw new McpToolError(`Homing rejected by controller: ${executed.text || executed.result}`);
            }

            if (args.wait_until_moved === false) {
                return {
                    homed: null,
                    position_verified: false,
                    note: 'wait_until_moved was false: G28 accepted but not awaited (homing takes '
                        + '~15-20s). Poll get_position until isHomed is true and the position is '
                        + 'stable before any motion.',
                };
            }

            // Homing on the A350 takes tens of seconds; wait for TWO
            // consecutive identical heartbeats (position AND offset) that
            // report homed and idle. A single fresh heartbeat is not enough:
            // mid-sequence the controller reports from the G53 workspace
            // (offset zeroed) before G54 reselects workspace 0, and returning
            // that transient produced a nonsense snapshot on hardware.
            const deadline = issuedAt + HOME_TIMEOUT_MS;
            const initialFingerprint = JSON.stringify([before.work, before.originOffset]);
            let sawChange = false;
            let previous: string | null = null;
            while (Date.now() < deadline) {
                await sleep(HOME_POLL_MS);
                const now = positionOrNull();
                if (!now) {
                    continue;
                }
                const reportTime = Date.now() - now.reportAgeMs;
                const fingerprint = JSON.stringify([now.work, now.originOffset]);
                const stable = fingerprint === previous;
                previous = fingerprint;
                if (fingerprint !== initialFingerprint) {
                    sawChange = true;
                }
                // The heartbeat lags ~1s, so two identical post-issue beats can
                // both predate the motion. Require the position to have moved
                // off its pre-G28 value at least once - homing always travels -
                // before accepting stability (or 25s, if it started at home).
                const changeOk = sawChange || Date.now() - issuedAt > 25000;
                if (reportTime > issuedAt && stable && changeOk && now.isHomed === true && now.machineStatus === 'idle') {
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
                wait_until_moved: {
                    type: 'boolean',
                    description: 'Default true: settle at the origin and capture there. false returns '
                        + 'right after the controller accepts the move - no settle, no frame; poll '
                        + 'get_position afterwards.',
                },
            },
            additionalProperties: false,
        },
        handler: async (args: { feed_rate?: number; operator_confirmed_clearance?: boolean; wait_until_moved?: boolean }) => {
            // The work origin is a fixed, operator-set destination, so the
            // per-call travel limit (meant to bound the blast radius of a
            // wrong coordinate) does not apply; every other guard does.
            return executeBoundedMoveAndCapture({
                x: 0,
                y: 0,
                coordinate_system: 'work',
                feed_rate: args.feed_rate,
                operator_confirmed_clearance: args.operator_confirmed_clearance,
                wait_until_moved: args.wait_until_moved,
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
                wait_until_moved: {
                    type: 'boolean',
                    description: 'Default true: settle at the target and capture there. false returns '
                        + 'right after the controller accepts the move - no settle, NO FRAME, '
                        + 'position_verified: false; poll get_position afterwards.',
                },
                capture: {
                    type: 'boolean',
                    description: 'Default true. false still settles and verifies the position but '
                        + 'skips the frame - a plain verified move. (The XY travel cap per call is '
                        + 'the configstore key mcpMaxJogDistance, default 100mm.)',
                },
            },
            additionalProperties: false,
        },
        handler: async (args: BoundedMoveArgs) => executeBoundedMoveAndCapture(args),
    });
}
