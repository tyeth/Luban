/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import crypto from 'crypto';
import * as fs from 'fs-extra';
import path from 'path';

import DataStorage from '../../../DataStorage';
import { connectionManager } from '../../machine/ConnectionManager';
import { captureFrame } from '../camera';
import { jobManager } from '../jobs';
import { describeProbeCirclePlanAsGcode, planProbeCircle, runProbeCircleProcedure } from '../probeCircle';
import { describeProbePlanAsGcode, planProbePoint, runProbePointProcedure } from '../probeTool';
import { describeProbeSequencePlanAsGcode, planProbeSequence, runProbeSequenceProcedure } from '../probeSequence';
import { describeProbeVectorPlanAsGcode, planProbeVector, runProbeVectorProcedure } from '../probeVector';
import { probeFeedService } from '../probeFeed';
import { TRAVEL_FEED, assertMachineReadyForProcedure, moveMachineSettled } from '../probing';
import { McpToolError, ToolRegistry } from '../registry';
import { getMachineSizeByIdentifier, getPositionSnapshot, safeTraverseZ } from './machine';
import { validateGcode } from '../validator';

// The spindle touch probe (probe feed channel) and the whole-bed camera
// survey: the survey gives the agent visual context ("measure the stock on
// the rotary axis"), the probe turns that context into millimetres.


export function registerProbingTools(registry: ToolRegistry, getConfirmBaseUrl: () => string): void {
    registry.register({
        name: 'probe_point',
        description: 'Stage a touch-probe point measurement for human confirmation: a single-axis '
            + 'sensor-gated march FROM THE CURRENT POSITION along +/-X, +/-Y or -Z, using the '
            + 'spindle touch probe (probe feed channel). Same staged mechanics as the tool setter: '
            + 'coarse steps to contact, retreat to release, fine steps, quick lift-and-retest '
            + 'confirm cycles - returns the median contact coordinate in machine coords with '
            + 'spread. Position first (move_and_capture / move_z), then stage; the envelope is '
            + 'anchored to the staging position and re-verified before motion. Remember the tip '
            + 'radius on side probes: the surface is one tip-radius beyond the contact centre.',
        inputSchema: {
            type: 'object',
            properties: {
                axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'Axis to march along.' },
                direction: { type: 'number', enum: [1, -1], description: 'Sign of travel; Z is -1 only.' },
                max_travel_mm: {
                    type: 'number',
                    description: 'REQUIRED hard travel limit (1-150): the march aborts here without contact.',
                },
                coarse_step_mm: { type: 'number', description: 'Coarse step, default 1 (0.2-2).' },
                fine_step_mm: { type: 'number', description: 'Fine step, default 0.1 (0.02-0.5).' },
                backoff_mm: { type: 'number', description: 'Confirm-cycle lift, default 1 (also the confirm re-contact window).' },
                sensor_delay_ms: { type: 'number', description: 'Contact-check window per step, default 300.' },
                confirm_passes: { type: 'number', description: 'Lift-and-retest cycles, default 3 (1-10).' },
                reason: { type: 'string', description: 'Shown to the operator: what is being measured and why.' },
            },
            required: ['axis', 'direction', 'max_travel_mm', 'reason'],
            additionalProperties: false,
        },
        handler: async (args: { [key: string]: unknown }) => {
            if (!String(args.reason || '').trim()) {
                throw new McpToolError('reason is required; it is shown to the operator.');
            }
            probeFeedService.assertNoOvertravel();
            const plan = planProbePoint(args as Parameters<typeof planProbePoint>[0]);
            const envelope = `; reason: ${String(args.reason).trim()}
${describeProbePlanAsGcode(plan)}`;
            const validation = validateGcode(envelope);
            const job = jobManager.submit(
                envelope,
                `probe ${plan.direction === 1 ? '+' : '-'}${plan.axis.toUpperCase()} `
                    + `${plan.maxTravelMm}mm - ${String(args.reason).slice(0, 40)}`,
                'cnc',
                validation,
                'procedure'
            );
            job.runner = async () => runProbePointProcedure(plan);
            return {
                job: jobManager.describe(job),
                plan,
                confirm_url: `${getConfirmBaseUrl()}/confirm/${job.id}`,
                next_step: 'Ask the operator to open confirm_url, review the envelope (anchored to the '
                    + 'current position), and approve. Their one-time code passed to start_gcode_job '
                    + 'runs the march and returns the contact coordinate.',
            };
        },
    });

    registry.register({
        name: 'probe_vector',
        description: 'Stage a touch-probe march along an ARBITRARY direction for human confirmation: '
            + 'from the CURRENT position along the given (dx, dy, dz) heading - any XY direction, '
            + 'optionally angled downward, never upward. Same staged mechanics as probe_point '
            + '(coarse steps to contact, retreat to release, fine steps, lift-and-retest confirm '
            + 'cycles); the march is parametrized along the unit vector so every commanded position '
            + 'lies on the approved segment. Returns the median contact as machine XYZ plus the '
            + 'distance along the vector. probe_point is the axis-aligned special case; use this '
            + 'for angled edges, chamfers, polygon faces, and inside-a-hole checks. Position first '
            + '(top-gantry traverse, operator-confirmed descent), then stage.',
        inputSchema: {
            type: 'object',
            properties: {
                dx: { type: 'number', description: 'Direction X component (machine frame). Magnitude ignored.' },
                dy: { type: 'number', description: 'Direction Y component.' },
                dz: { type: 'number', description: 'Direction Z component; must be <= 0 (downward or level).' },
                max_travel_mm: {
                    type: 'number',
                    description: 'REQUIRED hard travel limit (1-150) along the vector: the march aborts '
                        + 'there without contact. Clamped so the whole segment stays in the machine envelope.',
                },
                coarse_step_mm: { type: 'number', description: 'Coarse step, default 1 (0.2-2).' },
                fine_step_mm: { type: 'number', description: 'Fine step, default 0.1 (0.02-0.5).' },
                backoff_mm: { type: 'number', description: 'Confirm-cycle lift, default 1 (also the confirm re-contact window).' },
                sensor_delay_ms: { type: 'number', description: 'Contact-check window per step, default 300.' },
                confirm_passes: { type: 'number', description: 'Lift-and-retest cycles, default 3 (1-10).' },
                reason: { type: 'string', description: 'Shown to the operator: what is being measured and why.' },
            },
            required: ['max_travel_mm', 'reason'],
            additionalProperties: false,
        },
        handler: async (args: { [key: string]: unknown }) => {
            if (!String(args.reason || '').trim()) {
                throw new McpToolError('reason is required; it is shown to the operator.');
            }
            probeFeedService.assertNoOvertravel();
            const plan = planProbeVector(args as Parameters<typeof planProbeVector>[0]);
            const envelope = `; reason: ${String(args.reason).trim()}
${describeProbeVectorPlanAsGcode(plan)}`;
            const validation = validateGcode(envelope);
            const job = jobManager.submit(
                envelope,
                `probe-vector (${plan.unit.x},${plan.unit.y},${plan.unit.z}) ${plan.maxTravelMm}mm `
                    + `- ${String(args.reason).slice(0, 40)}`,
                'cnc',
                validation,
                'procedure'
            );
            job.runner = async () => runProbeVectorProcedure(plan);
            return {
                job: jobManager.describe(job),
                plan,
                confirm_url: `${getConfirmBaseUrl()}/confirm/${job.id}`,
                next_step: 'Ask the operator to open confirm_url, review the envelope (anchored to the '
                    + 'current position), and approve. Their one-time code passed to start_gcode_job '
                    + 'runs the march and returns the contact coordinate.',
            };
        },
    });

    registry.register({
        name: 'probe_sequence',
        description: 'Stage a whole measurement CIRCUIT as ONE operator approval: an ordered list of '
            + 'steps - hop (XY traverse; the runner always raises to the safe traverse height first), '
            + 'descend (absolute Z at current XY), probe (named sensor-gated march along +/-X/+/-Y/-Z '
            + 'or any downward vector, with the proven coarse/release/fine/confirm mechanics). The '
            + 'plan is simulated at staging so the confirm page enumerates every commanded move with '
            + 'concrete numbers; the runner re-verifies the machine matches the simulation before '
            + 'every march. Contact is expected ONLY during marches - a touch during any hop, raise '
            + 'or descent latches the CRASH alarm. Every number must be measured or operator-stated. '
            + 'Ends raised at the traverse height. Results keyed by march name, machine coords only.',
        inputSchema: {
            type: 'object',
            properties: {
                steps: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 60,
                    description: 'Ordered circuit steps.',
                    items: {
                        type: 'object',
                        properties: {
                            kind: { type: 'string', enum: ['hop', 'descend', 'probe'] },
                            x: { type: 'number', description: 'hop: target machine X.' },
                            y: { type: 'number', description: 'hop: target machine Y.' },
                            z: { type: 'number', description: 'descend: absolute machine Z.' },
                            name: { type: 'string', description: 'probe: unique result key.' },
                            dx: { type: 'number', description: 'probe: direction X component.' },
                            dy: { type: 'number', description: 'probe: direction Y component.' },
                            dz: { type: 'number', description: 'probe: direction Z component (<= 0).' },
                            max_travel_mm: { type: 'number', description: 'probe: hard travel limit (1-150).' },
                        },
                        required: ['kind'],
                        additionalProperties: false,
                    },
                },
                coarse_step_mm: { type: 'number', description: 'Coarse step for all marches, default 1 (0.2-2).' },
                fine_step_mm: { type: 'number', description: 'Fine step, default 0.1 (0.02-0.5).' },
                backoff_mm: { type: 'number', description: 'Confirm-cycle lift, default 1 (also the confirm re-contact window).' },
                sensor_delay_ms: { type: 'number', description: 'Contact-check window per step, default 300.' },
                confirm_passes: { type: 'number', description: 'Lift-and-retest cycles per march, default 3 (1-10).' },
                reason: { type: 'string', description: 'Shown to the operator: what the circuit measures and why.' },
            },
            required: ['steps', 'reason'],
            additionalProperties: false,
        },
        handler: async (args: { [key: string]: unknown }) => {
            if (!String(args.reason || '').trim()) {
                throw new McpToolError('reason is required; it is shown to the operator.');
            }
            probeFeedService.assertNoOvertravel();
            const plan = planProbeSequence(args as Parameters<typeof planProbeSequence>[0]);
            const envelope = `; reason: ${String(args.reason).trim()}
${describeProbeSequencePlanAsGcode(plan)}`;
            const validation = validateGcode(envelope);
            const marches = plan.steps.filter((s) => s.kind === 'probe').length;
            const job = jobManager.submit(
                envelope,
                `probe-sequence ${plan.steps.length}steps/${marches}marches - ${String(args.reason).slice(0, 40)}`,
                'cnc',
                validation,
                'procedure'
            );
            job.runner = async () => runProbeSequenceProcedure(plan);
            return {
                job: jobManager.describe(job),
                plan,
                confirm_url: `${getConfirmBaseUrl()}/confirm/${job.id}`,
                next_step: 'Ask the operator to open confirm_url, review the ENTIRE circuit (every hop, '
                    + 'descent and march is enumerated), and approve once. Their one-time code passed to '
                    + 'start_gcode_job runs the whole circuit and returns all named contacts.',
            };
        },
    });

    registry.register({
        name: 'probe_circle',
        description: 'Stage an N-point circle measurement of a roughly-round vertical feature for '
            + 'human confirmation: radial sensor-gated marches from evenly spaced azimuths, then a '
            + 'least-squares circle fit. OUTSIDE mode (post/boss/pin, default): marches step inward; '
            + 'requires the estimated centre and a MEASURED top height; yields the COMBINED diameter '
            + '(feature + tip). INSIDE mode (inside: true, a HOLE): the operator first positions the '
            + 'tip INSIDE the hole at the measuring depth; marches step OUTWARD from that staged '
            + 'position to the wall, no hops, ending with a vertical raise out along the entry path; '
            + 'yields hole diameter MINUS tip. Both need the operator\'s MIN and MAX diameter '
            + 'estimates - they bound every march so a wrong guess aborts instead of pressing on. '
            + 'Residuals expose an out-of-round tip or feature. Outside repositioning obeys motion '
            + 'law 2 (traverse-height hops); a probe touch during a hop or descent latches CRASH. '
            + 'All results in MACHINE coordinates.',
        inputSchema: {
            type: 'object',
            properties: {
                inside: {
                    type: 'boolean',
                    description: 'true = measure a HOLE from inside (tip already positioned in it at '
                        + 'depth); false/omitted = measure a feature from outside.',
                },
                center_x: { type: 'number', description: 'OUTSIDE mode: estimated feature centre X, machine coords. Ignored inside (the staged position is the march origin).' },
                center_y: { type: 'number', description: 'OUTSIDE mode: estimated feature centre Y, machine coords.' },
                diameter_min_mm: {
                    type: 'number',
                    description: 'Operator\'s LOWER bound on the feature diameter: marches abort at this '
                        + 'radius without contact instead of pressing on.',
                },
                diameter_max_mm: {
                    type: 'number',
                    description: 'Operator\'s UPPER bound on the feature diameter: approaches start '
                        + 'approach_clearance_mm beyond this radius.',
                },
                top_z_machine: {
                    type: 'number',
                    description: 'OUTSIDE mode (required there): toolhead machine Z at which the probe '
                        + 'tip touches the feature TOP - measured (probe_point -Z) or operator-stated, '
                        + 'never guessed. Optional record-keeping inside.',
                },
                probe_depth_mm: { type: 'number', description: 'Side contacts this far below the top, default 3 (0.5-20).' },
                points: { type: 'number', description: 'Contact points around the circle, default 8 (4-16).' },
                approach_clearance_mm: {
                    type: 'number',
                    description: 'Start-radius margin beyond max/2, default 5 (1-20). Must exceed the '
                        + 'probe tip radius plus a safety margin.',
                },
                coarse_step_mm: { type: 'number', description: 'Coarse radial step, default 0.5 (0.2-2).' },
                fine_step_mm: { type: 'number', description: 'Fine step, default 0.1 (0.02-0.5).' },
                backoff_mm: { type: 'number', description: 'Confirm-cycle lift, default 1 (also the confirm re-contact window).' },
                sensor_delay_ms: { type: 'number', description: 'Contact-check window per step, default 300.' },
                confirm_passes: { type: 'number', description: 'Lift-and-retest cycles per point, default 2 (1-5).' },
                reason: { type: 'string', description: 'Shown to the operator: what is being measured and why.' },
            },
            required: ['diameter_min_mm', 'diameter_max_mm', 'reason'],
            additionalProperties: false,
        },
        handler: async (args: { [key: string]: unknown }) => {
            if (!String(args.reason || '').trim()) {
                throw new McpToolError('reason is required; it is shown to the operator.');
            }
            probeFeedService.assertNoOvertravel();
            const plan = planProbeCircle(args as Parameters<typeof planProbeCircle>[0]);
            const envelope = `; reason: ${String(args.reason).trim()}
${describeProbeCirclePlanAsGcode(plan)}`;
            const validation = validateGcode(envelope);
            const job = jobManager.submit(
                envelope,
                `probe-circle${plan.inside ? ' INSIDE' : ''} ${plan.points.length}pts d${plan.diameterMinMm}-${plan.diameterMaxMm} `
                    + `- ${String(args.reason).slice(0, 40)}`,
                'cnc',
                validation,
                'procedure'
            );
            job.runner = async () => runProbeCircleProcedure(plan);
            return {
                job: jobManager.describe(job),
                plan,
                confirm_url: `${getConfirmBaseUrl()}/confirm/${job.id}`,
                next_step: 'Ask the operator to open confirm_url, review the full envelope (all marches, '
                    + 'hops and depths), and approve. Their one-time code passed to start_gcode_job runs '
                    + 'the whole star and returns the circle fit.',
            };
        },
    });

    registry.register({
        name: 'survey_bed',
        description: 'Stage a whole-bed camera survey for human confirmation: a serpentine XY grid at '
            + 'the CURRENT Z (which must be high - machine Z >= 250 unless the operator has confirmed '
            + 'clearance), capturing a frame at every waypoint. Frames are saved to disk with a '
            + 'machine-position index so the scene can be reviewed as a whole (read the files '
            + 'directly); they do NOT go through the 12-frame cache. Requires a working camera '
            + '(mcpCameraUrl or ffmpeg).',
        inputSchema: {
            type: 'object',
            properties: {
                pitch_mm: { type: 'number', description: 'MAXIMUM grid spacing, default 80 (20-160). Each axis span is divided into equal steps no larger than this, so rows and columns are uniform and both edges are covered - no fixed-pitch stub at the far end.' },
                margin_mm: { type: 'number', description: 'Inset from the default bounds, default 10.' },
                x_min: { type: 'number', description: 'Machine-coord grid bounds. Defaults: margin..(size-margin).' },
                x_max: { type: 'number', description: 'Set beyond the nominal size to cover reachable overtravel (e.g. the far-X column the camera angle otherwise misses - setup-specific, so state it explicitly).' },
                y_min: { type: 'number' },
                y_max: { type: 'number' },
                operator_confirmed_clearance: {
                    type: 'boolean',
                    description: 'Set true ONLY on the operator\'s explicit word that the current Z '
                        + 'clears everything on the bed; required when machine Z < 250.',
                },
                reason: { type: 'string', description: 'Shown to the operator.' },
            },
            required: ['reason'],
            additionalProperties: false,
        },
        handler: async (args: {
            pitch_mm?: number;
            margin_mm?: number;
            x_min?: number;
            x_max?: number;
            y_min?: number;
            y_max?: number;
            operator_confirmed_clearance?: boolean;
            reason?: string;
        }) => {
            probeFeedService.assertNoOvertravel();
            const position = getPositionSnapshot();
            const { x, y, z } = position.machine;
            if (x === null || y === null || z === null) {
                throw new McpToolError('Current machine position unknown.');
            }
            if (z < safeTraverseZ() && args.operator_confirmed_clearance !== true) {
                throw new McpToolError(`Machine Z ${z.toFixed(1)} is below the safe traverse height `
                    + `${safeTraverseZ()} (top gantry - operator law for all X/Y motion) - raise Z `
                    + '(move_z), or pass operator_confirmed_clearance: true only on the operator\'s '
                    + 'explicit word that this Z clears everything on the bed.');
            }
            const size = getMachineSizeByIdentifier(connectionManager.getConnectionStatus().machineIdentifier);
            if (!size) {
                throw new McpToolError('Unknown machine size; cannot plan the grid.');
            }
            const pitch = Math.min(Math.max(Number(args.pitch_mm) || 80, 20), 160);
            const margin = Math.min(Math.max(Number(args.margin_mm) || 10, 0), 50);

            // Serpentine at the current Z. Bounds are explicit (clamped to the
            // direct-move envelope) and BOTH endpoints are always covered.
            // Each axis is divided EVENLY into steps no larger than the pitch
            // (operator, 2026-09-05: the old fixed pitch gave 80 mm jumps and
            // then a 9-10 mm stub at the far edge - uneven coverage on both
            // axes); the far reach is often the only view of its region.
            const clampAxis = (value: number, max: number) => Math.min(Math.max(value, -25), max + 40);
            const bounds = {
                xMin: clampAxis(args.x_min !== undefined ? Number(args.x_min) : margin, size.x),
                xMax: clampAxis(args.x_max !== undefined ? Number(args.x_max) : size.x - margin, size.x),
                yMin: clampAxis(args.y_min !== undefined ? Number(args.y_min) : margin, size.y),
                yMax: clampAxis(args.y_max !== undefined ? Number(args.y_max) : size.y - margin, size.y),
            };
            if (!(bounds.xMax > bounds.xMin) || !(bounds.yMax > bounds.yMin)) {
                throw new McpToolError('Survey bounds are empty after clamping; check x/y min/max.');
            }
            const axisPoints = (min: number, max: number): { points: number[]; step: number } => {
                const span = max - min;
                const intervals = Math.max(1, Math.ceil(span / pitch - 1e-9));
                const step = span / intervals;
                const points: number[] = [];
                for (let i = 0; i <= intervals; i++) {
                    points.push(Number((min + (step * i)).toFixed(1)));
                }
                return { points, step: Number(step.toFixed(2)) };
            };
            const xAxis = axisPoints(bounds.xMin, bounds.xMax);
            const yAxis = axisPoints(bounds.yMin, bounds.yMax);
            const xs = xAxis.points;
            const ys = yAxis.points;
            const waypoints: { x: number; y: number }[] = [];
            ys.forEach((wy, row) => {
                const ordered = row % 2 === 0 ? xs : [...xs].reverse();
                ordered.forEach((wx) => waypoints.push({ x: wx, y: wy }));
            });

            const envelope = [
                `; BED SURVEY: ${waypoints.length} waypoints, serpentine grid step X ${xAxis.step} / Y ${yAxis.step} mm (max ${pitch}) at CURRENT machine Z ${z.toFixed(1)}`,
                '; one frame captured per waypoint after the move settles; frames saved to disk with a',
                '; machine-position index. Each line is sent individually. Aborts on the first capture failure.',
                'G90',
                'G53;',
                ...waypoints.map((w, i) => `G0 X${w.x.toFixed(1)} Y${w.y.toFixed(1)}; waypoint ${i + 1} + capture`),
                'G54;',
            ].join('\n');
            const validation = validateGcode(envelope);
            const job = jobManager.submit(
                envelope,
                `bed-survey ${waypoints.length}pts pitch${pitch} - ${String(args.reason).slice(0, 40)}`,
                'cnc',
                validation,
                'procedure'
            );
            job.runner = async () => {
                assertMachineReadyForProcedure();
                const surveyId = crypto.randomBytes(4).toString('hex');
                const dir = path.join(DataStorage.userDataDir, 'mcp-surveys', surveyId);
                fs.ensureDirSync(dir);
                const frames: object[] = [];
                for (let i = 0; i < waypoints.length; i++) {
                    const w = waypoints[i];
                    await moveMachineSettled('survey:move', { x: w.x, y: w.y }, TRAVEL_FEED * 4);
                    let frame;
                    try {
                        frame = await captureFrame();
                    } catch (err) {
                        throw new McpToolError(`Capture failed at waypoint ${i + 1}/${waypoints.length} `
                            + `(machine ${w.x}, ${w.y}): ${err.message}. Survey aborted; `
                            + `${frames.length} frames saved in ${dir}.`);
                    }
                    const file = path.join(dir, `wp${String(i + 1).padStart(3, '0')}_x${w.x}_y${w.y}.jpg`);
                    fs.writeFileSync(file, Buffer.from(frame.imageBase64, 'base64'));
                    frames.push({ file, machine: { x: w.x, y: w.y, z }, capturedAt: frame.capturedAt });
                }
                const index = { surveyId, machineZ: z, pitchMm: pitch, frames };
                fs.writeJsonSync(path.join(dir, 'index.json'), index, { spaces: 2 });
                return {
                    surveyId,
                    directory: dir,
                    frameCount: frames.length,
                    index_file: path.join(dir, 'index.json'),
                    frames,
                    note: 'Frames are position-stamped files on disk - read them directly to view the '
                        + 'bed. The camera is toolhead-mounted: each frame is centred near the waypoint '
                        + 'plus the fixed camera-to-spindle offset.',
                };
            };
            return {
                job: jobManager.describe(job),
                waypoints: waypoints.length,
                grid: { max_pitch_mm: pitch, step_x_mm: xAxis.step, step_y_mm: yAxis.step, xs, ys, machine_z: z, columns: xs.length, rows: ys.length },
                confirm_url: `${getConfirmBaseUrl()}/confirm/${job.id}`,
                next_step: 'Ask the operator to open confirm_url, check the Z clears everything on the '
                    + 'bed (rotary included), and approve. start_gcode_job then drives the whole grid '
                    + 'and returns the frame index.',
            };
        },
    });
}
