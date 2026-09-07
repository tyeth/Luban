/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention (planProbeProgram takes the
// probe_program arguments verbatim).
import { KeepOutError, ObstacleBox, insideSweptCylinder, normalizeKeepOut } from './envelopeChecks';
import { ExpandedGroup, GroupExpandError, expandProgramGroups } from './programGroups';
import { mcpBroadcast } from './index';
import { probeFeedService } from './probeFeed';
import {
    ProbeOutlinePlan,
    describeProbeOutlinePlanAsGcode,
    planProbeOutline,
    runProbeOutlineProcedure,
} from './probeOutline';
import {
    ProbeSequencePlan,
    describeProbeSequencePlanAsGcode,
    planProbeSequence,
    runProbeSequenceProcedure,
} from './probeSequence';
import {
    ProbeSurfacePlan,
    describeProbeSurfacePlanAsGcode,
    planProbeSurfaceGrid,
    planProbeSurfacePath,
    runProbeSurfaceProcedure,
} from './probeSurface';
import {
    ProcedureAbort,
    ProcedureStopped,
    ROTATE_FEED,
    TRAVEL_FEED,
    assertMachineReadyForProcedure,
    knownMachinePosition,
    moveMachineSettled,
    procedureStopRequested,
    rotateB,
} from './probing';
import {
    RefResolveError,
    RefSpec,
    describeRef,
    refMidpoint,
    refOpIds,
    resolveRef,
    substituteRefs,
    validateRef,
} from './programRefs';
import { McpToolError } from './registry';
import { AxisNamespace, missingGeometryNote, programSeedNamespaces } from './rotaryGeometry';
import { deriveStockSection } from './stockGeometry';
import { getPositionSnapshot, safeTraverseZ } from './tools/machine';

// A composite probing PROGRAM: an ordered list of operations - rotate the
// rotary axis, top-surface scans (path / grid), probe sequences (side and
// end marches) - staged ONCE, approved ONCE on a single confirm page that
// enumerates every operation's envelope and every rotation, and run by ONE
// runner that hands the machine from operation to operation. Operator
// request 2026-09-05 after a four-face survey that took 18 approvals.
//
// Numbers an operation needs but cannot know at staging (the top of the
// face that a centre probe earlier in the SAME program will measure) are
// REFERENCES to earlier results: { from: "c90.top.z", plus: 7, between:
// [195, 240] }. Law 3 is kept by the bounds: the operator approves the
// range, the runner refuses the operation (and stops the program, raised)
// if the resolved value falls outside it, and the confirm page shows the
// bounds with a preview plan computed at the mid-point. Every other law is
// unchanged: each operation runs through the existing runners (position of
// record, crash guard, hop envelope, slow zone, segmented descents), a
// rotation requires the toolhead at or above the safe traverse height, and
// every operation ends raised at that height.

export { describeRef, isRef, lookupPath, refOpIds, resolveRef, substituteRefs } from './programRefs';
export type { RefSpec } from './programRefs';

export type ProgramOpKind = 'rotate_b' | 'surface_path' | 'surface_grid' | 'sequence' | 'stock_outline';

export interface ProgramOp {
    id: string;
    kind: ProgramOpKind;
    /** Raw arguments for the underlying tool (numbers or references). */
    args: { [key: string]: unknown };
    /** What to do when this op fails: stop the program (default) or record and continue. Rotations always stop. */
    on_fail: 'stop' | 'skip';
    /** Dotted arg paths that hold references, with their bounds (for the page). */
    refs: { path: string; ref: RefSpec }[];
}

export interface ProbeProgramPlan {
    name: string;
    ops: ProgramOp[];
    hopZ: number;
    staged: { x: number; y: number; z: number; b: number | null };
    /** Preview descriptions (refs at their mid-point) for the confirm page. */
    previews: { id: string; text: string }[];
    rotations: number[];
    /** Namespaces seeded into the results before op 1 (jig/tool constants: `axis`). */
    seeds: { axis?: AxisNamespace };
    /** Transient obstacle boxes for THIS clamping (chuck jaws, tailstock), checked with the stored landmarks. */
    keepOut: ObstacleBox[];
    /** `group` ops expanded at staging (for the page header). */
    groups: ExpandedGroup[];
    /** Estimated job events this program writes (100 + 120/station + 60/probe + 20/rotation). */
    eventBudget: number;
}

const MAX_OPS = 80;

/** Job-event estimate per op (measured: 763 events for an 8-station path; a sequence probe ~60). */
function eventBudgetFor(sub: SubPlan | { kind: 'rotate_b' }): number {
    if (sub.kind === 'rotate_b') {
        return 20;
    }
    if (sub.kind === 'sequence') {
        return 20 + sub.plan.steps.length * 20 + sub.plan.steps.filter((st) => st.kind === 'probe').length * 60;
    }
    if (sub.kind === 'stock_outline') {
        return 60 + sub.plan.topPoints.length * 80 + sub.plan.sidePoints.length * 90;
    }
    return 40 + sub.plan.stations.length * 120;
}
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

type SubPlan =
    | { kind: 'surface_path'; plan: ProbeSurfacePlan }
    | { kind: 'surface_grid'; plan: ProbeSurfacePlan }
    | { kind: 'sequence'; plan: ProbeSequencePlan }
    | { kind: 'stock_outline'; plan: ProbeOutlinePlan };

function buildSubPlan(kind: ProgramOpKind, args: { [key: string]: unknown }, keepOut: ObstacleBox[]): SubPlan {
    if (kind === 'surface_path') {
        return { kind, plan: planProbeSurfacePath(args as Parameters<typeof planProbeSurfacePath>[0], keepOut) };
    }
    if (kind === 'surface_grid') {
        return { kind, plan: planProbeSurfaceGrid(args as Parameters<typeof planProbeSurfaceGrid>[0], keepOut) };
    }
    if (kind === 'sequence') {
        return { kind, plan: planProbeSequence(args as Parameters<typeof planProbeSequence>[0], keepOut) };
    }
    if (kind === 'stock_outline') {
        return { kind, plan: planProbeOutline(args as Parameters<typeof planProbeOutline>[0], keepOut) };
    }
    throw new McpToolError(`Unsupported op kind ${kind}.`);
}

function describeSubPlan(sub: SubPlan): string {
    if (sub.kind === 'sequence') {
        return describeProbeSequencePlanAsGcode(sub.plan);
    }
    if (sub.kind === 'stock_outline') {
        return describeProbeOutlinePlanAsGcode(sub.plan);
    }
    return describeProbeSurfacePlanAsGcode(sub.plan);
}

async function runSubPlan(sub: SubPlan): Promise<object> {
    if (sub.kind === 'sequence') {
        return runProbeSequenceProcedure(sub.plan);
    }
    if (sub.kind === 'stock_outline') {
        return runProbeOutlineProcedure(sub.plan);
    }
    return runProbeSurfaceProcedure(sub.plan);
}

export function planProbeProgram(args: { name?: unknown; ops?: unknown; keep_out?: unknown }): ProbeProgramPlan {
    const name = String(args.name || '').trim();
    if (!name) {
        throw new McpToolError('name is required (shown to the operator).');
    }
    let keepOut: ObstacleBox[];
    try {
        keepOut = normalizeKeepOut(args.keep_out);
    } catch (err) {
        if (err instanceof KeepOutError) {
            throw new McpToolError(err.message);
        }
        throw err;
    }
    if (!Array.isArray(args.ops) || args.ops.length < 1) {
        throw new McpToolError('ops is required: operations of kind rotate_b | surface_path | surface_grid | sequence | stock_outline | group.');
    }
    let expandedOps: unknown[];
    let groups: ExpandedGroup[];
    try {
        ({ ops: expandedOps, groups } = expandProgramGroups(args.ops));
    } catch (err) {
        if (err instanceof GroupExpandError) {
            throw new McpToolError(err.message);
        }
        throw err;
    }
    if (expandedOps.length > MAX_OPS) {
        throw new McpToolError(`${expandedOps.length} operations after group expansion exceeds the cap of ${MAX_OPS}.`);
    }
    const snapshot = getPositionSnapshot();
    const { x, y, z } = snapshot.machine;
    if (x === null || y === null || z === null) {
        throw new McpToolError('Current machine position unknown; cannot anchor the program.');
    }
    const hopZ = safeTraverseZ();
    const seeds = programSeedNamespaces();
    const seeded = new Set(Object.keys(seeds));
    const ids = new Set<string>();
    const ops: ProgramOp[] = [];
    const previews: { id: string; text: string }[] = [];
    const rotations: number[] = [];
    let anyRotate = false;
    let eventBudget = 100;

    expandedOps.forEach((raw, index) => {
        const where = `ops[${index}]`;
        if (!raw || typeof raw !== 'object') {
            throw new McpToolError(`${where}: must be an object.`);
        }
        const op = raw as { [key: string]: unknown };
        const id = String(op.id || '');
        if (!ID_PATTERN.test(id)) {
            throw new McpToolError(`${where}: id is required (letters, digits, _ or -, max 32 chars) - other ops reference results by it.`);
        }
        if (id === 'axis') {
            throw new McpToolError(`${where}: "axis" is the seeded jig-geometry namespace, not an op id.`);
        }
        if (ids.has(id)) {
            throw new McpToolError(`${where}: duplicate id "${id}".`);
        }
        ids.add(id);
        const kind = String(op.kind || '') as ProgramOpKind;
        if (!['rotate_b', 'surface_path', 'surface_grid', 'sequence', 'stock_outline'].includes(kind)) {
            throw new McpToolError(`${where}: kind must be rotate_b, surface_path, surface_grid, sequence or stock_outline.`);
        }
        const onFail = op.on_fail === 'skip' ? 'skip' : 'stop';
        const opArgs: { [key: string]: unknown } = {};
        for (const [key, value] of Object.entries(op)) {
            if (!['id', 'kind', 'on_fail'].includes(key)) {
                opArgs[key] = value;
            }
        }

        if (kind === 'rotate_b') {
            const b = Number(opArgs.b);
            if (!Number.isFinite(b) || b < -360 || b > 360) {
                throw new McpToolError(`${where} (rotate_b): b is required, absolute degrees in -360..360.`);
            }
            const requireZ = opArgs.require_z_at_least === undefined ? hopZ : Number(opArgs.require_z_at_least);
            if (!Number.isFinite(requireZ) || requireZ < hopZ) {
                throw new McpToolError(`${where} (rotate_b): require_z_at_least must be >= the safe traverse height ${hopZ} (law 2: the stock turns under a raised head).`);
            }
            // Stock size belongs to the program, not the jig: an optional
            // swept radius (largest reach of THIS stock and clamping about the
            // axis) adds a tip-outside-the-cylinder check before the turn.
            let sweptRadius: number | null = null;
            if (opArgs.swept_radius_mm !== undefined && opArgs.swept_radius_mm !== null) {
                sweptRadius = Number(opArgs.swept_radius_mm);
                if (!Number.isFinite(sweptRadius) || sweptRadius <= 0 || sweptRadius > 200) {
                    throw new McpToolError(`${where} (rotate_b): swept_radius_mm must be 0-200 (largest reach of the stock and clamping about the axis).`);
                }
                if (!seeds.axis) {
                    throw new McpToolError(`${where} (rotate_b): swept_radius_mm needs the rotary axis and probe length. ${missingGeometryNote()}`);
                }
            }
            if (!snapshot.isFourAxis) {
                throw new McpToolError(`${where} (rotate_b): the heartbeat reports no B axis - is the rotary module installed and selected in Machine Settings?`);
            }
            anyRotate = true;
            rotations.push(b);
            eventBudget += eventBudgetFor({ kind: 'rotate_b' });
            ops.push({ id, kind, args: { b, require_z_at_least: requireZ, swept_radius_mm: sweptRadius }, on_fail: 'stop', refs: [] });
            const swept = sweptRadius !== null && seeds.axis
                ? `\n; swept cylinder (this stock): axis X${seeds.axis.x}, physical Z${seeds.axis.z_physical}, radius ${sweptRadius} -> the probe tip clears it with the toolhead at Z >= ${(seeds.axis.z_contact + sweptRadius).toFixed(3)}`
                : '';
            previews.push({ id, text: `; ROTATE STOCK: B -> ${b} deg (absolute), requires toolhead machine Z >= ${requireZ}${swept}\nG90\nG0 B${b.toFixed(3)} F${ROTATE_FEED}; verified by M114 (B within 0.05 deg)` });
            return;
        }

        // Validate references (bounds), then build a PREVIEW plan at the
        // mid-point of each bounded reference so the page can enumerate the
        // envelope and every cap is checked now, not at run time.
        let previewArgs: { [key: string]: unknown };
        let refs: { path: string; ref: RefSpec }[];
        try {
            ({ args: previewArgs, refs } = substituteRefs(opArgs, (ref, path) => {
                validateRef(ref, `${where}.${path}`);
                return refMidpoint(ref);
            }));
        } catch (err) {
            if (err instanceof RefResolveError) {
                throw new McpToolError(err.message);
            }
            throw err;
        }
        for (const r of refs) {
            const missing = refOpIds(r.ref).find((dep) => dep === id || (!ids.has(dep) && !seeded.has(dep)));
            if (missing === 'axis') {
                throw new McpToolError(`${where}: reference ${describeRef(r.ref)} reads the "axis" namespace, which is not configured. ${missingGeometryNote()}`);
            }
            if (missing) {
                throw new McpToolError(`${where}: reference ${describeRef(r.ref)} reads "${missing}", which is not an op that runs BEFORE this one`
                    + `${seeded.size ? ` (or a seeded namespace: ${Array.from(seeded).join(', ')})` : ''}.`);
            }
        }
        let preview: SubPlan;
        try {
            preview = buildSubPlan(kind, previewArgs, keepOut);
        } catch (err) {
            throw new McpToolError(`${where} ("${id}", ${kind}): ${(err as Error).message}`);
        }
        ops.push({ id, kind, args: opArgs, on_fail: onFail, refs });
        eventBudget += eventBudgetFor(preview);
        const refLines = refs.map((r) => `; REFERENCE ${r.path} = ${describeRef(r.ref)}, `
            + `approved bounds [${r.ref.between[0]}, ${r.ref.between[1]}] - preview below uses ${refMidpoint(r.ref)}; the runner REFUSES the op outside the bounds`);
        previews.push({ id, text: [...refLines, describeSubPlan(preview)].join('\n') });
    });

    return {
        name,
        ops,
        hopZ,
        staged: { x, y, z, b: snapshot.b },
        previews,
        rotations: anyRotate ? rotations : [],
        seeds,
        keepOut,
        groups,
        eventBudget,
    };
}

export function describeProbeProgramAsGcode(plan: ProbeProgramPlan): string {
    const lines = [
        `; PROBE PROGRAM "${plan.name}": ${plan.ops.length} operations, ONE approval; about ${plan.eventBudget} job events`,
        ...plan.groups.map((g) => `; GROUP "${g.id}": ${g.innerCount} op(s) repeated at B ${g.angles.join(' / ')} deg (each preceded by a rotation)`),
        `; anchored at machine (${plan.staged.x}, ${plan.staged.y}, ${plan.staged.z})${plan.staged.b === null ? '' : ` B${plan.staged.b}`}`,
        '; every operation runs through its own runner (position of record, crash guard, hop envelope, slow zone,',
        `; <= 5 mm descent segments) and ends raised at the safe traverse height Z${plan.hopZ}; the next op starts there.`,
        plan.rotations.length
            ? `; THE STOCK WILL ROTATE: B schedule ${plan.rotations.map((b) => `${b} deg`).join(' -> ')} (absolute), only with the toolhead at Z >= ${plan.hopZ}.`
            : '; no rotations in this program.',
        '; A failed operation (no contact where required, hop-guard contact, alarm, rotation not settled) stops the program',
        '; raised at the traverse height and keeps every earlier result; on_fail: skip records the failure and continues.',
        '; References ({from: "<op>.<path>"}, mid/diff/min/max of paths, +/- a number or path) resolve at run time from earlier',
        '; results and are REFUSED outside their approved bounds.',
    ];
    if (plan.keepOut.length) {
        lines.push(`; KEEP-OUT for this clamping (${plan.keepOut.length}, checked with the stored landmarks against every hop, column and march):`);
        for (const k of plan.keepOut) {
            lines.push(`;   "${k.name}": machine X ${k.machine.x0}..${k.machine.x1}, Y ${k.machine.y0}..${k.machine.y1}, toolhead must stay at Z >= ${k.clearanceZ} over it (+5 mm margin)`);
        }
    }
    if (plan.seeds.axis) {
        const a = plan.seeds.axis;
        lines.push(`; JIG GEOMETRY (operator settings, namespace "axis"): axis X${a.x}, physical Z${a.z_physical}, probe ${a.probe_length} mm`
            + ` -> axis.z_contact ${a.z_contact}${a.tip_radius === null ? '' : `, tip radius ${a.tip_radius}`}`);
    }
    plan.ops.forEach((op, index) => {
        lines.push('');
        lines.push(`; ===== OP ${index + 1}/${plan.ops.length} "${op.id}" (${op.kind}${op.on_fail === 'skip' ? ', on_fail: skip' : ''}) =====`);
        const preview = plan.previews.find((p) => p.id === op.id);
        lines.push(preview ? preview.text : '; (no preview)');
    });
    lines.push('');
    lines.push(`G1 Z${plan.hopZ.toFixed(3)} F${TRAVEL_FEED}; program ends raised at the safe traverse height (also on abort)`);
    return lines.join('\n');
}

export interface ProgramOpResult {
    id: string;
    kind: ProgramOpKind;
    /** Rotary angle the op ran at (last verified rotation, or the staged B). */
    b: number | null;
    status: 'completed' | 'failed' | 'skipped';
    resolvedRefs: { path: string; from: string; value: number }[];
    startedAt: number;
    endedAt: number;
    result?: object;
    /** What a failed op measured before it aborted (stations / contacts). */
    partial?: object;
    error?: string;
}

/** The program's result object - returned on success and carried as `partial` on an abort/stop. */
function programResult(
    plan: ProbeProgramPlan,
    report: ProgramOpResult[],
    stoppedAt: string | null,
    startedAt: number,
    phases: { phase: string; note?: string }[]
): object {
    return {
        name: plan.name,
        ops: report,
        completedOps: report.filter((r) => r.status === 'completed').length,
        stoppedAt,
        rotations: plan.rotations,
        axis: plan.seeds.axis || null,
        derived: deriveStockSection(
            report.filter((r) => r.status === 'completed').map((r) => ({ id: r.id, kind: r.kind, b: r.b, result: r.result })),
            plan.seeds.axis || null
        ),
        durationMs: Date.now() - startedAt,
        phases,
        note: `Program ${stoppedAt ? `stopped at "${stoppedAt}"` : 'complete'}: ${report.filter((r) => r.status === 'completed').length}/${plan.ops.length} operations. `
            + 'Each op result is the same object its standalone tool returns (stations / results, fits, timing).',
    };
}

export async function runProbeProgramProcedure(plan: ProbeProgramPlan): Promise<object> {
    assertMachineReadyForProcedure();
    const results: { [opId: string]: unknown } = { ...plan.seeds };
    const report: ProgramOpResult[] = [];
    const phases: { phase: string; note?: string }[] = [];
    const announce = (phase: string, note?: string) => {
        phases.push({ phase, note });
        mcpBroadcast('mcp:activity', { tool: 'probe_program', phase, note });
    };
    const startedAt = Date.now();
    let stoppedAt: string | null = null;
    let currentB: number | null = plan.staged.b;

    for (let index = 0; index < plan.ops.length; index++) {
        const op = plan.ops[index];
        const opStarted = Date.now();
        const resolved: ProgramOpResult['resolvedRefs'] = [];
        announce(`op-${op.id}-start`, `${index + 1}/${plan.ops.length} ${op.kind}`);
        try {
            probeFeedService.assertNoOvertravel();
            if (op.kind === 'rotate_b') {
                const b = Number(op.args.b);
                const requireZ = Number(op.args.require_z_at_least);
                const axis = plan.seeds.axis;
                const sweptRadius = op.args.swept_radius_mm === null || op.args.swept_radius_mm === undefined ? null : Number(op.args.swept_radius_mm);
                if (axis && sweptRadius !== null) {
                    // Belt and braces over the Z >= traverse rule: the tip must
                    // be outside this stock's swept cylinder before it turns.
                    const known = knownMachinePosition();
                    const { x: kx, z: kz } = known.position;
                    if (kx !== null && kz !== null
                        && insideSweptCylinder({ x: kx, z: kz }, axis.probe_length, { x: axis.x, zPhysical: axis.z_physical, radius: sweptRadius })) {
                        throw new ProcedureAbort(`Rotation refused: the probe tip (toolhead machine X${kx} Z${kz}, ${known.source}) is inside the `
                            + `stock's swept cylinder (axis X${axis.x}, physical Z${axis.z_physical}, radius ${sweptRadius}).`);
                    }
                }
                const outcome = await rotateB(`probe_program:${op.id}`, b, requireZ);
                currentB = outcome.to;
                results[op.id] = outcome;
                report.push({ id: op.id, kind: op.kind, b: currentB, status: 'completed', resolvedRefs: resolved, startedAt: opStarted, endedAt: Date.now(), result: outcome });
                announce(`op-${op.id}-done`, `B ${outcome.from === null ? '?' : outcome.from} -> ${outcome.to} deg`);
                continue;
            }
            // Resolve references NOW against earlier results, re-plan at the
            // machine's current (raised) position, run the existing runner.
            const { args: liveArgs } = substituteRefs(op.args, (ref, path) => {
                const r = resolveRef(ref, results);
                resolved.push({ path, from: describeRef(ref), value: r.value });
                announce(`op-${op.id}-ref`, `${path} = ${r.source}`);
                return r.value;
            });
            const sub = buildSubPlan(op.kind, liveArgs, plan.keepOut);
            const outcome = await runSubPlan(sub);
            results[op.id] = outcome;
            report.push({ id: op.id, kind: op.kind, b: currentB, status: 'completed', resolvedRefs: resolved, startedAt: opStarted, endedAt: Date.now(), result: outcome });
            announce(`op-${op.id}-done`);
        } catch (err) {
            const message = (err as Error).message;
            const partial = (err as { partial?: object }).partial;
            report.push({ id: op.id, kind: op.kind, b: currentB, status: 'failed', resolvedRefs: resolved, startedAt: opStarted, endedAt: Date.now(), partial, error: message });
            announce(`op-${op.id}-failed`, message);
            const trip = probeFeedService.getTrip();
            // A requested stop (stop_gcode_job) ends the PROGRAM, whatever the
            // op's on_fail says.
            const stop = procedureStopRequested();
            if (trip || stop || op.on_fail === 'stop' || op.kind === 'rotate_b') {
                stoppedAt = op.id;
                // Every sub-runner raises to the traverse height on its own
                // abort; make sure of it here for the program as a whole
                // (unless an alarm is latched - then nothing moves).
                if (!trip) {
                    try {
                        const known = knownMachinePosition();
                        if (known.position.z !== null && known.position.z < plan.hopZ - 0.5) {
                            await moveMachineSettled('probe_program:abort-raise', { z: plan.hopZ }, TRAVEL_FEED);
                        }
                    } catch (raiseErr) {
                        announce('abort-raise-failed', (raiseErr as Error).message);
                    }
                }
                for (const later of plan.ops.slice(index + 1)) {
                    report.push({
                        id: later.id,
                        kind: later.kind,
                        b: currentB,
                        status: 'skipped',
                        resolvedRefs: [],
                        startedAt: Date.now(),
                        endedAt: Date.now(),
                        error: `not run: program stopped at "${op.id}"`,
                    });
                }
                const completed = report.filter((r) => r.status === 'completed').length;
                const tail = trip ? 'A safety alarm is latched - the operator must clear it.' : 'Machine raised to the traverse height.';
                const Ctor = stop || err instanceof ProcedureStopped ? ProcedureStopped : ProcedureAbort;
                throw new Ctor(`Program "${plan.name}" stopped at op "${op.id}" (${index + 1}/${plan.ops.length}): ${message} `
                    + `${completed} earlier op(s) completed; their results are on the job record under result.ops. ${tail}`,
                programResult(plan, report, op.id, startedAt, phases));
            }
            announce(`op-${op.id}-skipped`, 'on_fail: skip - continuing');
        }
    }

    return programResult(plan, report, stoppedAt, startedAt, phases);
}
