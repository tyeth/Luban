/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import { MotionSegment, ObstacleBox, checkMotion, describeViolations } from './envelopeChecks';
import { clearanceOptions } from './clearanceContext';
import { landmarkStore } from './landmarks';
import { MarchParams, Xyz, makeAnnounce, marchToContact, retreatAlong } from './march';
import { STEPPED_HOP_FEED } from './marchCore';
import {
    CONFIRM_AT_VALUES,
    ConfirmAt,
    PerimeterCorner,
    PerimeterSegment,
    TraceBounds,
    TraceIo,
    TraceParams,
    TraceResult,
    WallSide,
    estimateTraceTime,
    insideBounds,
    segmentPerimeter,
    tracePerimeter,
} from './perimeterTrace';
import { probeFeedService } from './probeFeed';
import { DESCENT_GUARD_MM } from './probeSequence';
import {
    COARSE_FEED,
    DESCENT_SEGMENT_MM,
    ProcedureAbort,
    ProcedureStopped,
    RECHECK_TOLERANCE_MM,
    TRAVEL_FEED,
    assertChannelReady,
    assertMachineReadyForProcedure,
    descendInSegments,
    expectMachinePosition,
    knownMachinePosition,
    moveMachineSettled,
    senseAfter,
    isProcedureAbort,
    isProcedureStopped,
    abortRaiseToTop,
} from './probing';
import {
    GPIO_SENSOR_DELAY_MS,
    MARCH_TRAVEL_MM,
    TRACE_ACCURACY_EVERY_MM,
    TRACE_BUMP_CAP_STEPS,
    TRACE_COARSE_STEP_MM,
    TRACE_FINE_STEP_MM,
    TRACE_MAJOR_TURN_DEG,
    TRACE_MAX_PERIMETER_MM,
    TRACE_MAX_STEPS,
    TRACE_STRAIGHT_POINTS,
    TRACE_TURN_STEP_DEG,
    WALL_LINE_TOLERANCE_MM,
    clampCount,
    clampTo,
    resolveMarchParams,
    within,
} from './procedureLimits';
import { McpToolError } from './registry';
import { probeGeometry } from './rotaryGeometry';
import { assertWithinTravel, getPositionSnapshot, requirePlanningTravel, safeTraverseZ } from './tools/machine';
import { TRAVERSE_Z_TOLERANCE_MM } from './traversePlan';
import { Xy, unit2 } from './wallFollow';

// probe_trace_perimeter (operator spec 2026-09-22, handoff §4 item 7): trace
// the whole internal perimeter of a pocket of UNKNOWN shape from one point
// known to be inside it, under one approval. The crawl itself is pure
// (perimeterTrace.ts); this file validates the arguments (every cap named in
// procedureLimits.ts), checks the bounds against the travel and the
// landmarks, describes the crawl on the confirm page with its time estimate,
// and binds the crawl's IO to the engine:
//
//   step(p)    -> moveMachineSettled at the stepped-hop feed with the probe
//                 EXPECTED, then a sensor read (the 1 mm sensor-checked step
//                 of every stepped traverse, here at 0.1 mm);
//   move(p)    -> a plain settled move along ground the crawl has proven;
//   march(..)  -> march.marchToContact (coarse / release / fine / confirm);
//   confirm(..)-> the same march from the free point over a few fine steps -
//                 the lift-and-retest cycle, run only where it buys accuracy.
//
// Law 2 to the start (raise, hop, guarded segmented descent to z_machine),
// law 8 on abort (straight up; held while the probe reads contact).

export interface ProbeTracePlan {
    tool: 'probe_trace_perimeter';
    start: Xy;
    dir: Xy;
    maxTravelMm: number;
    zMachine: number;
    params: TraceParams;
    lineToleranceMm: number;
    march: MarchParams;
    hopZ: number;
    staged: Xyz;
    tipDiameterMm: number | null;
    estimate: ReturnType<typeof estimateTraceTime>;
    confirmAt: ConfirmAt[];
}

interface TraceArgs {
    start_x?: unknown;
    start_y?: unknown;
    z_machine?: unknown;
    dir_x?: unknown;
    dir_y?: unknown;
    max_travel_mm?: unknown;
    fine_step_mm?: unknown;
    coarse_step_mm?: unknown;
    turn_step_deg?: unknown;
    bump_mm?: unknown;
    bump_cap_steps?: unknown;
    line_tolerance_mm?: unknown;
    straight_points?: unknown;
    max_perimeter_mm?: unknown;
    max_steps?: unknown;
    bounds?: unknown;
    keep_out?: unknown;
    wall_side?: unknown;
    confirm_at?: unknown;
    accuracy_every_mm?: unknown;
    major_turn_deg?: unknown;
    expected_corners?: unknown;
    backoff_mm?: unknown;
    sensor_delay_ms?: unknown;
    confirm_passes?: unknown;
}

const r3 = (v: number) => Number(v.toFixed(3));

function required(value: unknown, name: string): number {
    const n = Number(value);
    if (value === undefined || value === null || value === '' || !Number.isFinite(n)) {
        throw new McpToolError(`${name} is required (a finite number).`);
    }
    return n;
}

function boundsOf(raw: unknown): TraceBounds {
    const o = (raw || {}) as { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown };
    const v = [o.x0, o.y0, o.x1, o.y1].map(Number);
    if (v.some((n) => !Number.isFinite(n))) {
        throw new McpToolError('bounds {x0, y0, x1, y1} is REQUIRED: the machine XY box the tip centre may never leave - the pocket\'s outer extent as the operator '
            + 'estimates it PLUS a margin for the bump into the wall (at least the fine step; a coarse step is safer). Law 3: no bound is invented.');
    }
    return { x0: Math.min(v[0], v[2]), y0: Math.min(v[1], v[3]), x1: Math.max(v[0], v[2]), y1: Math.max(v[1], v[3]) };
}

/**
 * Motion list for the landmark check: the start column, then the crawl's
 * bounds as marches (sensor-gated: exempt from crossing landmarks, never
 * from volumes).
 */
export function traceMotion(plan: ProbeTracePlan): MotionSegment[] {
    const b = plan.params.bounds;
    const z = plan.zMachine;
    const c = (x: number, y: number) => ({ x, y, z });
    return [
        { kind: 'column', what: 'trace start descent', from: { ...plan.start, z: plan.hopZ }, to: { ...plan.start, z } },
        { kind: 'march', what: 'first-wall march', from: c(plan.start.x, plan.start.y), to: c(r3(plan.start.x + plan.dir.x * plan.maxTravelMm), r3(plan.start.y + plan.dir.y * plan.maxTravelMm)) },
        { kind: 'march', what: 'crawl bounds south edge', from: c(b.x0, b.y0), to: c(b.x1, b.y0) },
        { kind: 'march', what: 'crawl bounds east edge', from: c(b.x1, b.y0), to: c(b.x1, b.y1) },
        { kind: 'march', what: 'crawl bounds north edge', from: c(b.x1, b.y1), to: c(b.x0, b.y1) },
        { kind: 'march', what: 'crawl bounds west edge', from: c(b.x0, b.y1), to: c(b.x0, b.y0) },
    ];
}

export function planProbeTracePerimeter(args: TraceArgs, extraObstacles: ObstacleBox[] = []): ProbeTracePlan {
    const snapshot = getPositionSnapshot();
    const { x, y, z } = snapshot.machine;
    if (x === null || y === null || z === null) {
        throw new McpToolError('Current machine position unknown; cannot anchor the perimeter trace.');
    }
    const hopZ = safeTraverseZ();
    const start = { x: required(args.start_x, 'start_x (machine X of a point KNOWN to be inside the pocket)'), y: required(args.start_y, 'start_y') };
    const zMachine = required(args.z_machine, 'z_machine (toolhead machine Z of the crawl: a MEASURED top minus a depth, never a guess)');
    if (zMachine <= 0 || zMachine > hopZ) {
        throw new McpToolError(`z_machine ${zMachine} must be in 0..${hopZ}.`);
    }
    const dirRaw = { x: args.dir_x === undefined ? 1 : Number(args.dir_x), y: args.dir_y === undefined ? 0 : Number(args.dir_y) };
    const dir = unit2(dirRaw);
    if (!dir || !Number.isFinite(dirRaw.x) || !Number.isFinite(dirRaw.y)) {
        throw new McpToolError('dir_x / dir_y must be a finite non-zero direction (default +X): the first march toward a wall.');
    }
    const maxTravel = required(args.max_travel_mm, 'max_travel_mm (how far the first march may run before it aborts with no wall)');
    if (!within(maxTravel, MARCH_TRAVEL_MM)) {
        throw new McpToolError(`max_travel_mm must be ${MARCH_TRAVEL_MM.min}..${MARCH_TRAVEL_MM.max}.`);
    }
    const fineStep = clampTo(args.fine_step_mm, TRACE_FINE_STEP_MM);
    const coarseStep = Math.max(fineStep, clampTo(args.coarse_step_mm, TRACE_COARSE_STEP_MM));
    const turnStep = clampTo(args.turn_step_deg, TRACE_TURN_STEP_DEG);
    const bump = args.bump_mm === undefined || args.bump_mm === null || args.bump_mm === '' ? fineStep : clampTo(args.bump_mm, TRACE_FINE_STEP_MM);
    const bumpCap = clampCount(args.bump_cap_steps, TRACE_BUMP_CAP_STEPS);
    const straightPoints = clampCount(args.straight_points, TRACE_STRAIGHT_POINTS);
    const majorTurn = clampTo(args.major_turn_deg, TRACE_MAJOR_TURN_DEG);
    let lineTol = fineStep;
    if (args.line_tolerance_mm !== undefined && args.line_tolerance_mm !== null && args.line_tolerance_mm !== '') {
        lineTol = Number(args.line_tolerance_mm);
        if (!within(lineTol, WALL_LINE_TOLERANCE_MM)) {
            throw new McpToolError(`line_tolerance_mm must be ${WALL_LINE_TOLERANCE_MM.min}..${WALL_LINE_TOLERANCE_MM.max} (default: the fine step).`);
        }
    }
    const maxPerimeter = required(args.max_perimeter_mm, 'max_perimeter_mm (REQUIRED, law 3: the perimeter budget the operator approves)');
    if (!within(maxPerimeter, TRACE_MAX_PERIMETER_MM)) {
        throw new McpToolError(`max_perimeter_mm must be ${TRACE_MAX_PERIMETER_MM.min}..${TRACE_MAX_PERIMETER_MM.max}.`);
    }
    const maxSteps = clampCount(args.max_steps, TRACE_MAX_STEPS);
    const bounds = boundsOf(args.bounds);
    if (!insideBounds(start, bounds)) {
        throw new McpToolError(`start (${start.x}, ${start.y}) is outside bounds X ${bounds.x0}..${bounds.x1} Y ${bounds.y0}..${bounds.y1}.`);
    }
    const wallSide: WallSide = args.wall_side === 'left' ? 'left' : 'right';
    if (args.wall_side !== undefined && args.wall_side !== 'left' && args.wall_side !== 'right') {
        throw new McpToolError('wall_side must be "right" (default: right hand on the wall, counter-clockwise round the inside) or "left".');
    }
    let confirmAt: ConfirmAt[] = ['first', 'turns', 'unexpected'];
    if (args.confirm_at !== undefined) {
        if (!Array.isArray(args.confirm_at) || args.confirm_at.some((c) => !CONFIRM_AT_VALUES.includes(c as ConfirmAt))) {
            throw new McpToolError(`confirm_at must list values from ${CONFIRM_AT_VALUES.join(', ')}.`);
        }
        confirmAt = Array.from(new Set(args.confirm_at as ConfirmAt[]));
    }
    let accuracyEvery: number | null = null;
    if (args.accuracy_every_mm !== undefined && args.accuracy_every_mm !== null && args.accuracy_every_mm !== '') {
        accuracyEvery = Number(args.accuracy_every_mm);
        if (!within(accuracyEvery, TRACE_ACCURACY_EVERY_MM)) {
            throw new McpToolError(`accuracy_every_mm must be ${TRACE_ACCURACY_EVERY_MM.min}..${TRACE_ACCURACY_EVERY_MM.max}.`);
        }
        if (!confirmAt.includes('every')) {
            confirmAt.push('every');
        }
    } else if (confirmAt.includes('every')) {
        throw new McpToolError('confirm_at "every" needs accuracy_every_mm.');
    }
    const expectedCorners = Math.max(0, Math.round(Number(args.expected_corners) || 4));

    const travel = requirePlanningTravel('a perimeter trace', { x, y });
    assertWithinTravel(
        [
            { label: 'Trace start', x: start.x, y: start.y },
            { label: 'Bounds corner (x0, y0)', x: bounds.x0, y: bounds.y0 },
            { label: 'Bounds corner (x1, y1)', x: bounds.x1, y: bounds.y1 },
            { label: 'Bounds corner (x0, y1)', x: bounds.x0, y: bounds.y1 },
            { label: 'Bounds corner (x1, y0)', x: bounds.x1, y: bounds.y0 },
        ],
        travel
    );
    const keepOut = [...landmarkStore.obstacleBoxes().filter((b) => b.mode === 'volume'), ...extraObstacles]
        .map((b) => ({ name: b.name, x0: b.machine.x0, y0: b.machine.y0, x1: b.machine.x1, y1: b.machine.y1 }));
    const geometry = probeGeometry();
    const tipDiameterMm = geometry ? geometry.tipDiameter : null;
    const march = resolveMarchParams(args, { delay: GPIO_SENSOR_DELAY_MS, coarse: { default: fineStep, min: fineStep, max: fineStep } });
    const params: TraceParams = {
        fineStepMm: fineStep,
        coarseStepMm: coarseStep,
        turnStepDeg: turnStep,
        bumpMm: bump,
        bumpCapSteps: bumpCap,
        lineToleranceMm: lineTol,
        straightPoints,
        maxPerimeterMm: maxPerimeter,
        maxSteps,
        bounds,
        keepOut,
        wallSide,
        confirmAt: new Set(confirmAt),
        accuracyEveryMm: accuracyEvery,
        majorTurnDeg: majorTurn,
        tipRadiusMm: tipDiameterMm === null ? null : r3(tipDiameterMm / 2),
        confirmTravelMm: r3(fineStep * 3),
    };
    const plan: ProbeTracePlan = {
        tool: 'probe_trace_perimeter',
        start,
        dir: { x: r3(dir.x), y: r3(dir.y) },
        maxTravelMm: maxTravel,
        zMachine: r3(zMachine),
        params,
        lineToleranceMm: lineTol,
        march,
        hopZ,
        staged: { x, y, z },
        tipDiameterMm,
        estimate: estimateTraceTime({
            maxPerimeterMm: maxPerimeter, fineStepMm: fineStep, coarseStepMm: coarseStep, accuracyEveryMm: accuracyEvery, expectedCorners,
        }),
        confirmAt,
    };
    const violations = checkMotion(traceMotion(plan), [...landmarkStore.obstacleBoxes(), ...extraObstacles], { traverseZ: hopZ, ...clearanceOptions() });
    if (violations.length) {
        throw new McpToolError(`Perimeter trace refused (law 4, landmarks are obstacles): ${describeViolations(violations)}. Shrink the bounds or state the keep-out.`);
    }
    return plan;
}

export function describeProbeTracePlanAsGcode(plan: ProbeTracePlan): string {
    const p = plan.params;
    const e = plan.estimate;
    const b = p.bounds;
    const lines = [
        `; PERIMETER TRACE of an UNKNOWN pocket from (${plan.start.x}, ${plan.start.y}) at toolhead Z${plan.zMachine}: first march along (${plan.dir.x}, ${plan.dir.y}) up to ${plan.maxTravelMm} mm,`,
        `; then a CRAWL with the wall on the ${p.wallSide}, the probe EXPECTED on every move: ${p.fineStepMm} mm steps along the wall, a ${p.fineStepMm} mm bump toward it after each,`,
        `; ${p.coarseStepMm} mm steps only on a run proven straight (last ${p.straightPoints} contacts over ${r3(p.straightPoints * p.coarseStepMm)} mm within ${p.lineToleranceMm} mm of a line).`,
        `; A blocked step retreats exactly the step it attempted and turns the heading ${p.turnStepDeg} deg AWAY from the wall (corners, inward curves);`,
        `; a wall that falls away for ${p.bumpCapSteps} bumps turns it ${p.turnStepDeg} deg TOWARD the wall (outward curves). A full 360 deg of blocked steps ABORTS.`,
        `; BOUNDS the tip centre never leaves: X ${b.x0}..${b.x1} Y ${b.y0}..${b.y1}${p.keepOut.length ? `; keep-out: ${p.keepOut.map((k) => k.name).join(', ')}` : ''}. `
            + `Budget: ${p.maxPerimeterMm} mm of perimeter, ${p.maxSteps} steps. Closure = heading turned 360 deg and back within ${p.coarseStepMm} mm of the first wall point.`,
        `; CONFIRM CYCLES (lift-and-retest, ${plan.march.confirmPasses} pass(es)) only at: ${plan.confirmAt.join(', ')}${p.accuracyEveryMm ? ` (every ${p.accuracyEveryMm} mm)` : ''}`
            + ` - expected about ${e.confirmCycles} (1 first wall + ~1 per corner${p.accuracyEveryMm ? ' + accuracy points' : ''}); every other contact is one sensed 0.1 mm bump.`,
        `; TIME: ${e.bestSteps}..${e.worstSteps} sensor-checked steps at ~0.3 s each (GPIO, 2026-09-22) = ${e.bestMinutes}..${e.worstMinutes} min for the full budget`
            + ' (best: coarse on every straight; worst: fine everywhere). Job events will exceed the buffer on a long crawl; result.perimeter is never trimmed.',
        `; RESULT: ordered perimeter points (tip-centre${plan.tipDiameterMm === null ? '; no tip diameter stored, so no surface points' : ` and surface = + ${r3(plan.tipDiameterMm / 2)} mm into the material`}), `
            + 'line / arc segments with residuals, corners with radius and centre, closure, length, counts, timing.',
        `; anchored at machine (${plan.staged.x.toFixed(2)}, ${plan.staged.y.toFixed(2)}, ${plan.staged.z.toFixed(2)}) - re-verified before motion`,
        'G90',
        'G53;',
        `G1 Z${plan.hopZ.toFixed(3)} F${TRAVEL_FEED}; raise to the safe traverse height (law 2)`,
        `G1 X${plan.start.x.toFixed(3)} Y${plan.start.y.toFixed(3)} F${TRAVEL_FEED}; traverse to the start (inside the pocket)`,
        `G1 Z${Math.min(plan.zMachine + DESCENT_GUARD_MM, plan.hopZ).toFixed(3)} F${TRAVEL_FEED}; descend in <= ${DESCENT_SEGMENT_MM} mm segments (crash guard armed)`,
        `G1 Z${plan.zMachine.toFixed(3)} F${COARSE_FEED}; guarded 1 mm steps (ANY contact aborts: the start is not over free space)`,
        `G1 X${r3(plan.start.x + plan.dir.x * plan.maxTravelMm).toFixed(3)} Y${r3(plan.start.y + plan.dir.y * plan.maxTravelMm).toFixed(3)} F${COARSE_FEED}; first-wall march limit (contact expected before it)`,
        `; ... crawl: G1 steps of ${p.fineStepMm} / ${p.coarseStepMm} mm at F${STEPPED_HOP_FEED} inside the bounds above, each followed by a sensor read; retreats of one step at F${TRAVEL_FEED}`,
        `G1 Z${plan.hopZ.toFixed(3)} F${TRAVEL_FEED}; finish at the safe traverse height (also on any abort, law 8)`,
        'G54;',
    ];
    return lines.join('\n');
}

export interface TraceProcedureResult {
    tool: 'probe_trace_perimeter';
    zMachine: number;
    trace: TraceResult;
    segments: PerimeterSegment[];
    corners: PerimeterCorner[];
    tipDiameterMm: number | null;
    timing: { totalMs: number; perStepMs: number | null; confirmCycles: number };
    phases: { phase: string; note?: string }[];
    note: string;
    aborted?: boolean;
}

export async function runProbeTracePerimeterProcedure(plan: ProbeTracePlan): Promise<TraceProcedureResult> {
    assertMachineReadyForProcedure();
    assertChannelReady('probe', 'perimeter trace');
    const phases: { phase: string; note?: string }[] = [];
    const announce = makeAnnounce(plan.tool, phases);
    const tag = 'trace';
    const z = plan.zMachine;
    const startedAt = Date.now();
    let trace: TraceResult | null = null;
    let partialPoints = 0;

    const build = (aborted: boolean): TraceProcedureResult => {
        const pts = trace ? trace.perimeter.map((pt) => pt.tipCentre) : [];
        const seg = pts.length >= 3
            ? segmentPerimeter(pts, plan.lineToleranceMm * 1.5, 4, plan.params.tipRadiusMm, plan.params.coarseStepMm * 4)
            : { segments: [], corners: [] };
        const totalMs = Date.now() - startedAt;
        const steps = trace ? trace.counts.fineSteps + trace.counts.coarseSteps + trace.counts.bumps : 0;
        return {
            tool: plan.tool,
            zMachine: z,
            trace: trace || {
                perimeter: [],
                closed: false,
                ending: { kind: 'budget', note: 'aborted before the first wall' },
                lengthMm: 0,
                headingTurnDeg: 0,
                counts: { fineSteps: 0, coarseSteps: 0, bumps: 0, turns: 0, retreats: 0, confirms: 0, tangentContacts: 0 },
                position: plan.start,
                firstWall: { point: plan.start, spreadMm: 0 },
            },
            segments: seg.segments,
            corners: seg.corners,
            tipDiameterMm: plan.tipDiameterMm,
            timing: { totalMs, perStepMs: steps ? Math.round(totalMs / steps) : null, confirmCycles: trace ? trace.counts.confirms : 0 },
            phases,
            note: `${aborted ? 'ABORTED. ' : ''}${trace ? `${trace.ending.kind.toUpperCase()}: ${trace.ending.note}. ${trace.perimeter.length} perimeter point(s) over ${trace.lengthMm} mm; `
                + `${seg.segments.filter((s) => s.kind === 'line').length} straight wall(s), ${seg.corners.length} corner(s)`
                + `${seg.corners.length ? ` (tip-centre radii ${seg.corners.map((c) => (c.radiusTipCentreMm === null ? '?' : c.radiusTipCentreMm.toFixed(2))).join(', ')})` : ''}; `
                + `${trace.counts.confirms} confirm cycle(s), ${trace.counts.turns} turn(s), ${Math.round(totalMs / 1000)} s` : `${partialPoints} point(s) before the abort`}. `
                + `Contacts are tip-centre at toolhead Z${z}${plan.tipDiameterMm === null ? '; no tip diameter stored' : `; surface = + ${r3(plan.tipDiameterMm / 2)} mm into the material`}.`,
            aborted: aborted || undefined,
        };
    };

    const guardedDescent = async (label: string, toZ: number) => {
        const known = knownMachinePosition();
        const zNow = known.position.z;
        if (zNow === null) {
            throw new ProcedureAbort(`Machine Z unknown before the descent at "${label}" - refusing to guess.`);
        }
        if (zNow < toZ - RECHECK_TOLERANCE_MM) {
            throw new ProcedureAbort(`"${label}": the toolhead is at Z${zNow} (${known.source}), BELOW the descent target Z${toZ} - a descent never rises.`);
        }
        const guardTop = toZ + DESCENT_GUARD_MM;
        probeFeedService.clearExpectedContact();
        if (zNow > guardTop + TRAVERSE_Z_TOLERANCE_MM) {
            await descendInSegments(`${tag}:descend:${label}`, zNow, guardTop, 'probe', plan.march.sensorDelayMs);
        }
        let gz = Math.min(Math.max(zNow, toZ), guardTop);
        while (gz - toZ > 1e-9) {
            const t0 = Date.now();
            gz = Math.max(gz - 1, toZ);
            await moveMachineSettled(`${tag}:descend-guard:${label}`, { z: gz }, COARSE_FEED);
            const sensed = await senseAfter('probe', t0, plan.march.sensorDelayMs);
            if (sensed.contact) {
                throw new ProcedureAbort(`UNEXPECTED CONTACT at Z${gz.toFixed(3)} during the guarded descent at "${label}": the start is not over free space at z_machine. Machine held.`);
            }
        }
    };

    // The crawl's IO on the real machine. Every move runs with the probe
    // expected (a contact is data, not a collision); the expected set is
    // cleared on return, whatever happens.
    let stepCount = 0;
    const io: TraceIo = {
        step: async (p: Xy) => {
            stepCount += 1;
            const t0 = Date.now();
            await moveMachineSettled(`${tag}:step`, { x: p.x, y: p.y }, STEPPED_HOP_FEED);
            const sensed = await senseAfter('probe', t0, plan.march.sensorDelayMs);
            if (sensed.contact) {
                partialPoints += 1;
            }
            return sensed.contact;
        },
        move: async (p: Xy) => {
            await moveMachineSettled(`${tag}:retreat`, { x: p.x, y: p.y }, TRAVEL_FEED);
        },
        march: async (from: Xy, unit: Xy, travelMm: number) => {
            const contact = await marchToContact(tag, 'first-wall', { x: from.x, y: from.y, z }, { x: unit.x, y: unit.y, z: 0 }, travelMm, plan.march, announce);
            if (!contact) {
                await retreatAlong(tag, 'first-wall', { x: from.x, y: from.y, z }, { x: unit.x, y: unit.y, z: 0 }, 0);
                return null;
            }
            return { point: { x: contact.point.x, y: contact.point.y }, spreadMm: contact.spreadMm };
        },
        confirm: async (from: Xy, unit: Xy, travelMm: number) => {
            const contact = await marchToContact(tag, `confirm-${stepCount}`, { x: from.x, y: from.y, z }, { x: unit.x, y: unit.y, z: 0 }, travelMm, plan.march, () => undefined);
            return contact ? { point: { x: contact.point.x, y: contact.point.y }, spreadMm: contact.spreadMm } : null;
        },
    };

    try {
        await expectMachinePosition(plan.staged, 'staged position', (message) => new McpToolError(
            `The machine is not at the position this trace was staged from. ${message} Stage probe_trace_perimeter again.`
        ));
        probeFeedService.clearExpectedContact();
        await moveMachineSettled(`${tag}:raise`, { z: plan.hopZ }, TRAVEL_FEED);
        await moveMachineSettled(`${tag}:traverse`, { x: plan.start.x, y: plan.start.y }, TRAVEL_FEED);
        announce('traverse', `start (${plan.start.x}, ${plan.start.y}) at Z${plan.hopZ}`);
        await guardedDescent('start', z);
        probeFeedService.setExpectedContact(['probe']);
        // Sparse announcements: a long crawl would flood the job events.
        let lastAnnouncedAt = Date.now();
        const sparse = (phase: string, note?: string) => {
            if (phase.startsWith('trace-') || phase === 'first-wall' || Date.now() - lastAnnouncedAt > 15000) {
                lastAnnouncedAt = Date.now();
                announce(phase, note);
            }
        };
        trace = await tracePerimeter(io, plan.start, plan.dir, plan.maxTravelMm, plan.params, sparse);
        probeFeedService.clearExpectedContact();
        await moveMachineSettled(`${tag}:final-raise`, { z: plan.hopZ }, TRAVEL_FEED);
        const result = build(false);
        announce('trace-complete', result.note);
        return result;
    } catch (err) {
        const isTrip = !!probeFeedService.getTrip();
        if (!isTrip) {
            try {
                await abortRaiseToTop(tag, (phase, zz, note) => announce(phase, zz === null ? note : `Z${zz} - ${note}`), { holdIfTriggered: 'probe' });
            } catch (retreatErr) {
                // Logged by the activity stream.
            }
        }
        if (isProcedureAbort(err)) {
            const Ctor = isProcedureStopped(err) ? ProcedureStopped : ProcedureAbort;
            throw new Ctor(`Perimeter trace aborted: ${err.message} ${partialPoints} contact(s) so far are on the job record.`, build(true));
        }
        throw err;
    } finally {
        probeFeedService.clearExpectedContact();
    }
}
