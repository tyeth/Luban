/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention (planProbeProgram takes the
// probe_program arguments verbatim).
import { mcpBroadcast } from './index';
import { probeFeedService } from './probeFeed';
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
    ROTATE_FEED,
    TRAVEL_FEED,
    assertMachineReadyForProcedure,
    knownMachinePosition,
    moveMachineSettled,
    rotateB,
} from './probing';
import {
    RefResolveError,
    RefSpec,
    refMidpoint,
    resolveRef,
    substituteRefs,
    validateRef,
} from './programRefs';
import { McpToolError } from './registry';
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

export { isRef, lookupPath, resolveRef, substituteRefs } from './programRefs';
export type { RefSpec } from './programRefs';

export type ProgramOpKind = 'rotate_b' | 'surface_path' | 'surface_grid' | 'sequence';

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
}

const MAX_OPS = 40;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

type SubPlan =
    | { kind: 'surface_path'; plan: ProbeSurfacePlan }
    | { kind: 'surface_grid'; plan: ProbeSurfacePlan }
    | { kind: 'sequence'; plan: ProbeSequencePlan };

function buildSubPlan(kind: ProgramOpKind, args: { [key: string]: unknown }): SubPlan {
    if (kind === 'surface_path') {
        return { kind, plan: planProbeSurfacePath(args as Parameters<typeof planProbeSurfacePath>[0]) };
    }
    if (kind === 'surface_grid') {
        return { kind, plan: planProbeSurfaceGrid(args as Parameters<typeof planProbeSurfaceGrid>[0]) };
    }
    if (kind === 'sequence') {
        return { kind, plan: planProbeSequence(args as Parameters<typeof planProbeSequence>[0]) };
    }
    throw new McpToolError(`Unsupported op kind ${kind}.`);
}

function describeSubPlan(sub: SubPlan): string {
    return sub.kind === 'sequence' ? describeProbeSequencePlanAsGcode(sub.plan) : describeProbeSurfacePlanAsGcode(sub.plan);
}

export function planProbeProgram(args: { name?: unknown; ops?: unknown }): ProbeProgramPlan {
    const name = String(args.name || '').trim();
    if (!name) {
        throw new McpToolError('name is required (shown to the operator).');
    }
    if (!Array.isArray(args.ops) || args.ops.length < 1 || args.ops.length > MAX_OPS) {
        throw new McpToolError(`ops is required: 1-${MAX_OPS} operations of kind rotate_b | surface_path | surface_grid | sequence.`);
    }
    const snapshot = getPositionSnapshot();
    const { x, y, z } = snapshot.machine;
    if (x === null || y === null || z === null) {
        throw new McpToolError('Current machine position unknown; cannot anchor the program.');
    }
    const hopZ = safeTraverseZ();
    const ids = new Set<string>();
    const ops: ProgramOp[] = [];
    const previews: { id: string; text: string }[] = [];
    const rotations: number[] = [];
    let anyRotate = false;

    (args.ops as unknown[]).forEach((raw, index) => {
        const where = `ops[${index}]`;
        if (!raw || typeof raw !== 'object') {
            throw new McpToolError(`${where}: must be an object.`);
        }
        const op = raw as { [key: string]: unknown };
        const id = String(op.id || '');
        if (!ID_PATTERN.test(id)) {
            throw new McpToolError(`${where}: id is required (letters, digits, _ or -, max 32 chars) - other ops reference results by it.`);
        }
        if (ids.has(id)) {
            throw new McpToolError(`${where}: duplicate id "${id}".`);
        }
        ids.add(id);
        const kind = String(op.kind || '') as ProgramOpKind;
        if (!['rotate_b', 'surface_path', 'surface_grid', 'sequence'].includes(kind)) {
            throw new McpToolError(`${where}: kind must be rotate_b, surface_path, surface_grid or sequence.`);
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
            if (!snapshot.isFourAxis) {
                throw new McpToolError(`${where} (rotate_b): the heartbeat reports no B axis - is the rotary module installed and selected in Machine Settings?`);
            }
            anyRotate = true;
            rotations.push(b);
            ops.push({ id, kind, args: { b, require_z_at_least: requireZ }, on_fail: 'stop', refs: [] });
            previews.push({ id, text: `; ROTATE STOCK: B -> ${b} deg (absolute), requires toolhead machine Z >= ${requireZ}\nG90\nG0 B${b.toFixed(3)} F${ROTATE_FEED}; verified by M114 (B within 0.05 deg)` });
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
        if (refs.some((r) => !ids.has(r.ref.from.split('.')[0]) || r.ref.from.split('.')[0] === id)) {
            const bad = refs.find((r) => !ids.has(r.ref.from.split('.')[0]) || r.ref.from.split('.')[0] === id) as { ref: RefSpec };
            throw new McpToolError(`${where}: reference "${bad.ref.from}" points at an op that does not run BEFORE this one.`);
        }
        let preview: SubPlan;
        try {
            preview = buildSubPlan(kind, previewArgs);
        } catch (err) {
            throw new McpToolError(`${where} ("${id}", ${kind}): ${(err as Error).message}`);
        }
        ops.push({ id, kind, args: opArgs, on_fail: onFail, refs });
        const refLines = refs.map((r) => `; REFERENCE ${r.path} = ${r.ref.from}${r.ref.plus ? ` + ${r.ref.plus}` : ''}${r.ref.minus ? ` - ${r.ref.minus}` : ''}, `
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
    };
}

export function describeProbeProgramAsGcode(plan: ProbeProgramPlan): string {
    const lines = [
        `; PROBE PROGRAM "${plan.name}": ${plan.ops.length} operations, ONE approval`,
        `; anchored at machine (${plan.staged.x}, ${plan.staged.y}, ${plan.staged.z})${plan.staged.b === null ? '' : ` B${plan.staged.b}`}`,
        '; every operation runs through its own runner (position of record, crash guard, hop envelope, slow zone,',
        `; <= 5 mm descent segments) and ends raised at the safe traverse height Z${plan.hopZ}; the next op starts there.`,
        plan.rotations.length
            ? `; THE STOCK WILL ROTATE: B schedule ${plan.rotations.map((b) => `${b} deg`).join(' -> ')} (absolute), only with the toolhead at Z >= ${plan.hopZ}.`
            : '; no rotations in this program.',
        '; A failed operation (no contact where required, hop-guard contact, alarm, rotation not settled) stops the program',
        '; raised at the traverse height and keeps every earlier result; on_fail: skip records the failure and continues.',
        '; References ({from: "<op>.<path>"}) resolve at run time from earlier results and are REFUSED outside their approved bounds.',
    ];
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
    status: 'completed' | 'failed' | 'skipped';
    resolvedRefs: { path: string; from: string; value: number }[];
    startedAt: number;
    endedAt: number;
    result?: object;
    error?: string;
}

export async function runProbeProgramProcedure(plan: ProbeProgramPlan): Promise<object> {
    assertMachineReadyForProcedure();
    const results: { [opId: string]: unknown } = {};
    const report: ProgramOpResult[] = [];
    const phases: { phase: string; note?: string }[] = [];
    const announce = (phase: string, note?: string) => {
        phases.push({ phase, note });
        mcpBroadcast('mcp:activity', { tool: 'probe_program', phase, note });
    };
    const startedAt = Date.now();
    let stoppedAt: string | null = null;

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
                const outcome = await rotateB(`probe_program:${op.id}`, b, requireZ);
                results[op.id] = outcome;
                report.push({ id: op.id, kind: op.kind, status: 'completed', resolvedRefs: resolved, startedAt: opStarted, endedAt: Date.now(), result: outcome });
                announce(`op-${op.id}-done`, `B ${outcome.from === null ? '?' : outcome.from} -> ${outcome.to} deg`);
                continue;
            }
            // Resolve references NOW against earlier results, re-plan at the
            // machine's current (raised) position, run the existing runner.
            const { args: liveArgs } = substituteRefs(op.args, (ref, path) => {
                const r = resolveRef(ref, results);
                resolved.push({ path, from: ref.from, value: r.value });
                announce(`op-${op.id}-ref`, `${path} = ${r.source}`);
                return r.value;
            });
            const sub = buildSubPlan(op.kind, liveArgs);
            const outcome = sub.kind === 'sequence'
                ? await runProbeSequenceProcedure(sub.plan)
                : await runProbeSurfaceProcedure(sub.plan);
            results[op.id] = outcome;
            report.push({ id: op.id, kind: op.kind, status: 'completed', resolvedRefs: resolved, startedAt: opStarted, endedAt: Date.now(), result: outcome });
            announce(`op-${op.id}-done`);
        } catch (err) {
            const message = (err as Error).message;
            report.push({ id: op.id, kind: op.kind, status: 'failed', resolvedRefs: resolved, startedAt: opStarted, endedAt: Date.now(), error: message });
            announce(`op-${op.id}-failed`, message);
            const trip = probeFeedService.getTrip();
            if (trip || op.on_fail === 'stop' || op.kind === 'rotate_b') {
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
                        status: 'skipped',
                        resolvedRefs: [],
                        startedAt: Date.now(),
                        endedAt: Date.now(),
                        error: `not run: program stopped at "${op.id}"`,
                    });
                }
                const completed = report.filter((r) => r.status === 'completed').length;
                const tail = trip ? 'A safety alarm is latched - the operator must clear it.' : 'Machine raised to the traverse height.';
                throw new ProcedureAbort(`Program "${plan.name}" stopped at op "${op.id}" (${index + 1}/${plan.ops.length}): ${message} `
                    + `${completed} earlier op(s) completed; their results are on the job record under result.ops. ${tail}`);
            }
            announce(`op-${op.id}-skipped`, 'on_fail: skip - continuing');
        }
    }

    return {
        name: plan.name,
        ops: report,
        completedOps: report.filter((r) => r.status === 'completed').length,
        stoppedAt,
        rotations: plan.rotations,
        durationMs: Date.now() - startedAt,
        phases,
        note: `Program complete: ${report.filter((r) => r.status === 'completed').length}/${plan.ops.length} operations. `
            + 'Each op result is the same object its standalone tool returns (stations / results, fits, timing).',
    };
}
