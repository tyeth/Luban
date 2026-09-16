// traverse_xy planner: law-2 transport. An XY series at the traverse height,
// staged for ONE operator approval and executed one step per start_gcode_job
// call, like move_z - the twin the 100 mm move_and_capture cap kept forcing
// into hand-written file jobs (which is how a frameless `G0 Z0` got staged on
// 2026-09-12). Pure: no server imports, unit-tested in tests/traversePlan.test.ts.
import { MotionSegment, ObstacleBox, checkMotion, describeViolations } from './envelopeChecks';

export interface Xyz {
    x: number;
    y: number;
    z: number;
}

export interface TraverseTarget {
    x?: number;
    y?: number;
}

export interface TraversePlanInput {
    /** 1-20 targets in `frame`; an omitted axis keeps its previous value. */
    targets: TraverseTarget[];
    frame: 'machine' | 'work';
    /** The judged machine position (position of record). */
    currentMachine: Xyz;
    /** machine = work - originOffset. */
    originOffset: Xyz;
    /** Machine travel; null when the machine is unknown (bounds then unchecked). */
    bounds: { min: Xyz; max: Xyz } | null;
    /** The law-2 traverse height (mcpSafeTraverseZ). The current Z must be at or above it. */
    traverseZ: number;
    feedRate: number;
    /** Stored landmarks (+ any program keep-outs) as obstacle boxes. */
    obstacles: ObstacleBox[];
    reason: string;
}

export interface TraverseStep {
    /** Machine-frame endpoints, for the operator and the settle check. */
    from: Xyz;
    to: Xyz;
    /** Target as written in `frame`, with both axes filled in. */
    target: { x: number; y: number };
    distanceMm: number;
    gcode: string;
}

export interface TraversePlan {
    steps: TraverseStep[];
    header: string;
    /** header + steps joined with the direct-batch separator - what the operator approves. */
    reviewText: string;
    name: string;
    totalDistanceMm: number;
}

export class TraversePlanError extends Error {
    public constructor(message: string) {
        super(message);
        // Checked by name at the tool boundary: instanceof is unreliable across the bundle.
        this.name = 'TraversePlanError';
    }
}

/** Travel a target may sit outside the nominal volume (the A350 X switch is at -19; Y/Z home a few mm past nominal). */
export const XY_BOUNDS_LOW_MARGIN_MM = 25;
export const XY_BOUNDS_HIGH_MARGIN_MM = 40;
export const MAX_TRAVERSE_TARGETS = 20;
/**
 * "At the traverse height" allows the heartbeat's float noise: home reports
 * machine Z 327.9989959716797 for a 328 home (seen live 2026-09-14), and an
 * exact >= 328 refused every traverse from home.
 */
export const TRAVERSE_Z_TOLERANCE_MM = 0.05;
/** The direct-batch separator start_gcode_job and the confirm page know. */
export const STEP_SEPARATOR = '\n; --- next approved step ---\n';

/** Word-wrap a comment for the gcode header (mirrors move_z). */
export function wrapCommentText(text: string, width: number): string[] {
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
}

const f3 = (n: number) => n.toFixed(3);

export function planTraverseXy(input: TraversePlanInput): TraversePlan {
    const { targets, frame, currentMachine, originOffset, bounds, traverseZ, feedRate, obstacles } = input;
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_TRAVERSE_TARGETS) {
        throw new TraversePlanError(`Provide 1-${MAX_TRAVERSE_TARGETS} targets.`);
    }
    // Law 2: every XY move over 1 mm happens at the traverse height. There is
    // deliberately no override here - transport that cannot happen at the
    // traverse height is not transport, it is a procedure with its own envelope.
    if (currentMachine.z < traverseZ - TRAVERSE_Z_TOLERANCE_MM) {
        throw new TraversePlanError(`Refused: the toolhead is at machine Z ${f3(currentMachine.z)}, below the traverse height `
            + `${traverseZ} (law 2: all XY over 1 mm at top gantry height). Raise Z with move_z (coordinate_system "machine") first.`);
    }

    const toMachine = (t: { x: number; y: number }) => (frame === 'machine'
        ? { x: t.x, y: t.y }
        : { x: t.x - originOffset.x, y: t.y - originOffset.y });
    const toFrame = (m: { x: number; y: number }) => (frame === 'machine'
        ? { x: m.x, y: m.y }
        : { x: m.x + originOffset.x, y: m.y + originOffset.y });

    const steps: TraverseStep[] = [];
    const segments: MotionSegment[] = [];
    // Within tolerance of the traverse height the head IS at the traverse height:
    // plan the segments there so the landmark check does not fail on 1 um.
    const planZ = Math.max(currentMachine.z, traverseZ);
    let fromMachine: Xyz = { ...currentMachine, z: planZ };
    let total = 0;
    targets.forEach((raw, i) => {
        const hasX = raw.x !== undefined && raw.x !== null;
        const hasY = raw.y !== undefined && raw.y !== null;
        if (!hasX && !hasY) {
            throw new TraversePlanError(`Target ${i + 1} names neither x nor y.`);
        }
        const x = hasX ? Number(raw.x) : NaN;
        const y = hasY ? Number(raw.y) : NaN;
        if ((hasX && !Number.isFinite(x)) || (hasY && !Number.isFinite(y))) {
            throw new TraversePlanError(`Target ${i + 1} is not finite.`);
        }
        const previousInFrame = toFrame(fromMachine);
        const target = { x: hasX ? x : previousInFrame.x, y: hasY ? y : previousInFrame.y };
        const m = toMachine(target);
        if (bounds) {
            const outside = (['x', 'y'] as const).filter((axis) => m[axis] < bounds.min[axis] - XY_BOUNDS_LOW_MARGIN_MM
                || m[axis] > bounds.max[axis] + XY_BOUNDS_HIGH_MARGIN_MM);
            if (outside.length) {
                throw new TraversePlanError(`Target ${i + 1} ${frame} (${f3(target.x)}, ${f3(target.y)}) = machine (${f3(m.x)}, ${f3(m.y)}) is outside `
                    + `the travel on ${outside.join('/')} (X ${bounds.min.x}..${bounds.max.x}, Y ${bounds.min.y}..${bounds.max.y}).`);
            }
        }
        const to: Xyz = { x: m.x, y: m.y, z: planZ };
        const distanceMm = Math.hypot(to.x - fromMachine.x, to.y - fromMachine.y);
        total += distanceMm;
        segments.push({ what: `step ${i + 1}`, kind: 'hop', from: { ...fromMachine }, to: { ...to } });
        const move = `G1 X${f3(target.x)} Y${f3(target.y)} F${feedRate}`;
        // Every MCP-emitted motion declares its frame: G53 for machine, an
        // explicit G54 for the work workspace (operator law 2026-09-14).
        const gcode = frame === 'machine' ? `G90\nG53;\n${move};\nG54;` : `G90\nG54;\n${move}`;
        steps.push({ from: { ...fromMachine }, to, target, distanceMm, gcode });
        fromMachine = to;
    });

    // Landmarks are obstacles (law 4) - at 328 every stored clearance passes on
    // its own merits; a configured lower traverse height or a taller landmark
    // refuses here, naming the step and the landmark.
    const violations = checkMotion(segments, obstacles, { traverseZ });
    if (violations.length) {
        throw new TraversePlanError(`Refused - the path crosses a landmark below its clearance: ${describeViolations(violations)}. `
            + 'Raise the traverse height only if the operator says so; never shrink or delete the landmark.');
    }

    const last = steps[steps.length - 1];
    const header = [
        ...wrapCommentText(`reason: ${input.reason}`, 90).map((row) => `; ${row}`),
        `; frame: ${frame} coords; current machine (${f3(currentMachine.x)}, ${f3(currentMachine.y)}) at machine Z ${f3(currentMachine.z)}`,
        `; Z does NOT change: the whole series runs at machine Z ${f3(currentMachine.z)} >= traverse height ${traverseZ} (law 2)`,
        ...steps.map((s, i) => `; step ${i + 1}: ${frame} (${f3(toFrame(s.from).x)}, ${f3(toFrame(s.from).y)}) -> (${f3(s.target.x)}, ${f3(s.target.y)})`
            + ` = machine (${f3(s.to.x)}, ${f3(s.to.y)}), ${s.distanceMm.toFixed(1)} mm F${feedRate}`),
        `; total XY travel ${total.toFixed(1)} mm over ${steps.length} step(s); landmarks checked against every segment`,
        '; sensors: NO contact expected during these moves - a probe/toolsetter trigger',
        '; while moving latches the CRASH alarm (probe feed must be armed).',
    ].join('\n');
    const reviewText = `${header}\n${steps.map((s) => s.gcode).join(STEP_SEPARATOR)}`;
    const name = steps.length > 1
        ? `xy-series ${frame} x${steps.length} -> (${last.target.x.toFixed(1)}, ${last.target.y.toFixed(1)}) ${total.toFixed(0)}mm - ${input.reason.slice(0, 40)}`
        : `xy-traverse ${frame} -> (${last.target.x.toFixed(1)}, ${last.target.y.toFixed(1)}) ${total.toFixed(0)}mm - ${input.reason.slice(0, 40)}`;
    return { steps, header, reviewText, name, totalDistanceMm: total };
}

/**
 * Abort retreat law (operator, 2026-09-16): an aborted procedure retreats
 * STRAIGHT UP to the traverse height (the Z top), never to its start height
 * and never downward. Job fd7fa6cb6396: the tool setter aborted BEFORE its
 * travel (traverse check at Z 327.999 vs 328) and the old "retreat to start
 * height" plunged the head 122 mm from home to Z 205.5 at the home XY, inside
 * the rotary landmark. Pure: decided from the known machine Z alone.
 */
export interface AbortRaiseDecision {
    /** raise = issue a Z-only move to targetZ; skip = already at the top. */
    action: 'raise' | 'skip';
    targetZ: number;
    reason: string;
}

export function planAbortRaise(currentZ: number | null, traverseZ: number): AbortRaiseDecision {
    if (currentZ !== null && currentZ >= traverseZ - TRAVERSE_Z_TOLERANCE_MM) {
        return {
            action: 'skip',
            targetZ: traverseZ,
            reason: `already at the traverse height (machine Z ${currentZ.toFixed(3)} vs ${traverseZ})`,
        };
    }
    return {
        action: 'raise',
        targetZ: traverseZ,
        reason: currentZ === null
            ? `machine Z unknown - a Z-only move to the traverse height ${traverseZ} is the one retreat that cannot descend`
            : `raise from machine Z ${currentZ.toFixed(3)} to the traverse height ${traverseZ}`,
    };
}

/**
 * True when a move from `fromZ` to `toZ` may LOWER the head: `toZ` is below
 * the known Z (beyond the heartbeat's float noise), or the Z is unknown and a
 * descent cannot be ruled out. An abort path uses this to skip any "back to
 * the start" leg - the start of a Z march is above the contact only once the
 * march has begun; before that it is below the head.
 */
export function mayDescend(fromZ: number | null, toZ: number): boolean {
    return fromZ === null || toZ < fromZ - TRAVERSE_Z_TOLERANCE_MM;
}
