/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import crypto from 'crypto';
import * as fs from 'fs-extra';
import path from 'path';

import DataStorage from '../../DataStorage';
import { connectionManager } from '../machine/ConnectionManager';
import { BootstrapPose, planPoseSweep, planSearchGrid, sweepStops } from './bootstrapPlan';
import { captureFrame } from './camera';
import { clearanceOptions } from './clearanceContext';
import { landmarkStore } from './landmarks';
import { McpToolError } from './registry';
import { rotaryAxisPoints } from './rotaryGeometry';
import { getToolSetterConfig } from './toolSetter';
import { getMachineSizeByIdentifier, getPositionSnapshot, motionFloorZ, safeTraverseZ } from './tools/machine';
import { assertMachineReadyForProcedure, descendInSegments, moveMachineSettled, TRAVEL_FEED } from './probing';
import { ProbeChannel } from './probeFeed';

// The camera pre-configuration stage.
//
// Operator law 2026-09-19: the camera can sit differently after every power
// cycle, be knocked, be re-aimed, or be a different camera entirely. So this
// has to bootstrap FROM NOTHING - no assumed direction, no assumed offset, no
// assumed field of view, no assumed lens - and it does that in two staged
// jobs, each with its own approval, because the second cannot be planned until
// a human (or an agent) has looked at the first.
//
//   search: a serpentine grid at the park height across the X band the camera
//     could be looking from, bracketing the tool setter's KNOWN machine XY.
//     Which frames contain it, compared with the toolhead XY of those frames,
//     gives the coarse camera offset INCLUDING ITS SIGN with no prior
//     assumption at all. This is the only step that is meaningful without a
//     calibration, which is exactly why it comes first. On 2026-09-19 the same
//     grid was reached only after forty minutes of single poses.
//
//   poses: with a coarse offset in hand, visit each named pose and sweep Z
//     from the park height down to the motion floor with XY STATIONARY,
//     capturing at every stop. Targets at three different heights over an 8 mm
//     baseline are what turn a flat pixels-per-millimetre number into
//     perspective.
//
// Both write the same indexed frame set, which scripts/camera_bootstrap.py
// solves into a model.

export interface BootstrapTarget {
    name: string;
    machine: { x: number; y: number; z: number };
    /** How its machine coordinates are known - quoted into the index, never guessed. */
    source: string;
    /** A known size in the scene is an absolute scale constraint. */
    diameterMm?: number;
}

/**
 * Everything whose machine coordinates the server already knows well enough to
 * solve against. Emptiness is a refusal, not a warning: a bootstrap with no
 * known target measures nothing.
 */
export function bootstrapTargets(): BootstrapTarget[] {
    const targets: BootstrapTarget[] = [];
    const setter = getToolSetterConfig();
    if (setter) {
        targets.push({
            name: 'tool-setter',
            machine: {
                x: setter.centerX,
                y: setter.centerY,
                // The plate top: the trigger Z is where the REFERENCE BIT's tip
                // sits when it closes the switch, so the plate is that much
                // higher than the toolhead was.
                z: Number((setter.triggerZ - setter.referenceBitLengthMm).toFixed(3)),
            },
            source: 'set_tool_setter_config (centre, and trigger_z - reference_bit_length_mm for the plate top)',
            diameterMm: setter.discDiameterMm,
        });
    }
    for (const point of rotaryAxisPoints()) {
        targets.push({
            name: point.name,
            machine: { x: point.x, y: point.y, z: point.z },
            source: 'set_probe_geometry (rotary_axis_x / rotary_axis_z_physical and the named end)',
        });
    }
    return targets;
}

export interface BootstrapFrameRecord {
    file: string;
    label: string;
    machine: { x: number; y: number; z: number };
    capturedAt: number;
}

export interface BootstrapIndex {
    bootstrapId: string;
    stage: 'search' | 'poses';
    createdAt: number;
    /** What the camera was, at the time - the solver writes it into the model. */
    camera: { device: string | null };
    parkZ: number;
    floorZ: number;
    targets: BootstrapTarget[];
    frames: BootstrapFrameRecord[];
    note: string;
}

// The sweep expects no contact on either channel; a trigger is a collision.
const PROBE_CHANNELS: ProbeChannel[] = ['probe', 'toolsetter'];
const SENSOR_DELAY_MS = 120;

function bootstrapDir(id: string): string {
    return path.join(DataStorage.userDataDir, 'mcp-camera-bootstrap', id);
}

/** The X band the camera could be looking from, given no knowledge of where it looks. */
export function searchBand(targetX: number, sizeX: number, reachMm: number): { xMin: number; xMax: number } {
    return {
        xMin: Math.max(-25, targetX - reachMm),
        xMax: Math.min(sizeX + 40, targetX + reachMm),
    };
}

export interface SearchPlanArgs {
    reach_mm?: number;
    pitch_mm?: number;
    y_span_mm?: number;
}

export function planSearchStage(args: SearchPlanArgs): {
    waypoints: Array<{ x: number; y: number }>;
    target: BootstrapTarget;
    parkZ: number;
    bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
} {
    const targets = bootstrapTargets();
    const setter = targets.find((t) => t.name === 'tool-setter');
    if (!setter) {
        throw new McpToolError('The search stage brackets the tool setter, whose machine coordinates are the one thing '
            + 'known exactly without any camera knowledge at all - and no setter is configured. Run '
            + 'set_tool_setter_config first, or state another target the same way.');
    }
    const size = getMachineSizeByIdentifier(connectionManager.getConnectionStatus().machineIdentifier);
    if (!size) {
        throw new McpToolError('Unknown machine size; cannot plan the search band.');
    }
    const reach = Math.min(Math.max(Number(args.reach_mm) || 200, 40), 400);
    const pitch = Math.min(Math.max(Number(args.pitch_mm) || 40, 10), 120);
    const ySpan = Math.min(Math.max(Number(args.y_span_mm) || 0, 0), 300);
    const band = searchBand(setter.machine.x, size.x, reach);
    const bounds = {
        ...band,
        yMin: Math.max(-25, setter.machine.y - (ySpan / 2)),
        yMax: Math.min(size.y + 40, setter.machine.y + (ySpan / 2)),
    };
    return {
        waypoints: planSearchGrid({ ...bounds, pitchMm: pitch }),
        target: setter,
        parkZ: safeTraverseZ(),
        bounds,
    };
}

export interface PosePlanArgs {
    poses?: Array<{ label?: string; x?: number; y?: number }>;
    step_mm?: number;
    floor_z?: number;
}

export function planPoseStage(args: PosePlanArgs) {
    const raw = Array.isArray(args.poses) ? args.poses : [];
    if (!raw.length || raw.length > 12) {
        throw new McpToolError('Provide 1-12 poses: the toolhead XY to view each target from, derived from the search '
            + 'stage\'s coarse offset. plan_view_pose computes them once a model exists.');
    }
    const poses: BootstrapPose[] = raw.map((p, i) => {
        const x = Number(p.x);
        const y = Number(p.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new McpToolError(`Pose ${i + 1} needs finite machine x and y (where the TOOLHEAD goes).`);
        }
        return { label: String(p.label || `pose-${i + 1}`).slice(0, 40), x, y };
    });
    const position = getPositionSnapshot();
    const { x, y, z } = position.machine;
    if (x === null || y === null || z === null) {
        throw new McpToolError('Current machine position unknown.');
    }
    const parkZ = safeTraverseZ();
    const floorZ = Math.max(Number(args.floor_z) || motionFloorZ(), motionFloorZ());
    const plan = planPoseSweep({
        poses,
        parkZ,
        floorZ,
        stepMm: Number(args.step_mm) || 2,
        obstacles: landmarkStore.obstacleBoxes(),
        fromMachine: { x, y, z },
        ...clearanceOptions(),
    });
    if (!plan.poses.length) {
        throw new McpToolError(`No pose survives the obstacle check: ${plan.dropped.map((d) => `${d.label}: ${d.reason}`).join(' ')}`);
    }
    return { plan, parkZ, floorZ, stops: sweepStops(parkZ, floorZ, Number(args.step_mm) || 2) };
}

/** The gcode envelope an operator approves for either stage. */
export function describeBootstrapGcode(lines: string[]): string {
    return ['G90', 'G53;', ...lines, 'G54;'].join('\n');
}

export async function runSearchStage(
    plan: ReturnType<typeof planSearchStage>,
    announce: (phase: string, note: string) => void
): Promise<object> {
    assertMachineReadyForProcedure();
    const id = crypto.randomBytes(4).toString('hex');
    const dir = bootstrapDir(id);
    fs.ensureDirSync(dir);
    const frames: BootstrapFrameRecord[] = [];
    let device: string | null = null;
    for (let i = 0; i < plan.waypoints.length; i++) {
        const w = plan.waypoints[i];
        announce('search:move', `waypoint ${i + 1}/${plan.waypoints.length} (${w.x}, ${w.y})`);
        await moveMachineSettled('bootstrap:search', { x: w.x, y: w.y }, TRAVEL_FEED * 4);
        const frame = await captureFrame();
        device = frame.device;
        const file = path.join(dir, `search${String(i + 1).padStart(3, '0')}_x${w.x}_y${w.y}.jpg`);
        fs.writeFileSync(file, Buffer.from(frame.imageBase64, 'base64'));
        frames.push({ file, label: 'search', machine: { x: w.x, y: w.y, z: plan.parkZ }, capturedAt: frame.capturedAt });
    }
    const index: BootstrapIndex = {
        bootstrapId: id,
        stage: 'search',
        createdAt: Date.now(),
        camera: { device },
        parkZ: plan.parkZ,
        floorZ: plan.parkZ,
        targets: bootstrapTargets(),
        frames,
        note: 'Stage 0. Find which frames contain the tool setter. Its machine XY is known exactly, so the toolhead XY '
            + 'of the frames that show it gives the camera offset INCLUDING ITS SIGN, to within half the grid pitch, '
            + 'with no prior assumption about where the camera looks. Then plan the pose stage from that.',
    };
    fs.writeJsonSync(path.join(dir, 'index.json'), index, { spaces: 2 });
    return {
        bootstrapId: id,
        directory: dir,
        stage: 'search',
        frameCount: frames.length,
        targets: index.targets,
        next_step: index.note,
    };
}

export async function runPoseStage(
    planned: ReturnType<typeof planPoseStage>,
    announce: (phase: string, note: string) => void
): Promise<object> {
    assertMachineReadyForProcedure();
    const id = crypto.randomBytes(4).toString('hex');
    const dir = bootstrapDir(id);
    fs.ensureDirSync(dir);
    const frames: BootstrapFrameRecord[] = [];
    let device: string | null = null;
    for (const pose of planned.plan.poses) {
        announce('poses:traverse', `${pose.label} -> (${pose.x}, ${pose.y}) at Z ${planned.parkZ}`);
        await moveMachineSettled('bootstrap:traverse', { x: pose.x, y: pose.y }, TRAVEL_FEED * 4);
        let fromZ = planned.parkZ;
        for (const stop of pose.stops) {
            if (stop.z !== planned.parkZ) {
                // XY stationary: the sweep is a vertical baseline, and law 2
                // is satisfied because nothing moves in XY below the floor.
                announce('poses:descend', `${pose.label} to Z ${stop.z}`);
                // Segmented and crash-guarded, like every other descent: the
                // sweep expects no contact, so a trigger during it is a
                // collision, not a measurement.
                await descendInSegments('bootstrap:descend', fromZ, stop.z, PROBE_CHANNELS, SENSOR_DELAY_MS);
            }
            const frame = await captureFrame();
            device = frame.device;
            const file = path.join(dir, `${pose.label}_z${stop.z}.jpg`.replace(/[^\w.-]/g, '_'));
            fs.writeFileSync(file, Buffer.from(frame.imageBase64, 'base64'));
            frames.push({ file, label: pose.label, machine: { x: pose.x, y: pose.y, z: stop.z }, capturedAt: frame.capturedAt });
            fromZ = stop.z;
        }
        // Back to the park height before the next XY move, always.
        announce('poses:raise', `${pose.label} back to Z ${planned.parkZ}`);
        await moveMachineSettled('bootstrap:raise', { z: planned.parkZ }, TRAVEL_FEED);
    }
    const index: BootstrapIndex = {
        bootstrapId: id,
        stage: 'poses',
        createdAt: Date.now(),
        camera: { device },
        parkZ: planned.parkZ,
        floorZ: planned.floorZ,
        targets: bootstrapTargets(),
        frames,
        note: 'Stage 1-2. Solve with scripts/camera_bootstrap.py <directory>, then store the result with '
            + 'set_camera_model and prove it with verify_camera_model at a pose that is NOT in this set.',
    };
    fs.writeJsonSync(path.join(dir, 'index.json'), index, { spaces: 2 });
    return {
        bootstrapId: id,
        directory: dir,
        stage: 'poses',
        frameCount: frames.length,
        poses: planned.plan.poses,
        dropped: planned.plan.dropped,
        targets: index.targets,
        next_step: index.note,
    };
}
