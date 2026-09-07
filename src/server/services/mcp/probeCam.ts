/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import * as fs from 'fs-extra';
import path from 'path';

import { MotionSegment, checkMotion, describeViolations } from './envelopeChecks';
import {
    InspectionReport,
    ProbeResultRecord,
    ReportFormat,
    deviationAlongNormal,
    renderReport,
    reportExtension,
} from './inspectionReport';
import { landmarkStore } from './landmarks';
import {
    MarchParams,
    Xyz,
    makeAnnounce,
    marchToContact,
    retreatAlong,
    steppedTraverseZ,
} from './march';
import { probeFeedService } from './probeFeed';
import { ParsedProbeGcode, ProbeGcodeError, parseProbingGcode } from './probeGcode';
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
    rotateB,
    senseAfter,
    senseReleaseAfter,
    sleep,
} from './probing';
import { McpToolError } from './registry';
import { probeGeometry } from './rotaryGeometry';
import { getMachineSizeByIdentifier, getPositionSnapshot, safeTraverseZ } from './tools/machine';
import DataStorage from '../../DataStorage';
import { connectionManager } from '../machine/ConnectionManager';

// run_probing_gcode (mcp/49, operator request 2026-09-07): a probing program
// written by CAM (Fusion 360, FreeCAD, a Grbl/Marlin post, or by hand) is
// PARSED, never sent to the controller as-is - the Snapmaker firmware has no
// G38 probing cycle and a raw program would obey none of the motion laws.
// Every step is translated:
//
//   G38.2 / G38.3   -> a sensor-gated march (march.ts) from the current point
//                      toward the programmed target, the target being the
//                      travel limit; the probe retreats to the cycle start,
//                      as the parser assumes. G38.2 without contact aborts
//                      (Grbl semantics) unless on_miss: continue; G38.3 records.
//   G38.4 / G38.5   -> a probe-away: coarse steps along the vector until the
//                      probe RELEASES, then on to the target (G38.4 without a
//                      release aborts; G38.5 records).
//   G0 / G1 links   -> law 2: XY travel at the safe traverse height (raise,
//                      traverse, guarded segmented descent to the programmed
//                      Z) - link_mode "raise", the default - or a stepped
//                      touch-probing traverse at the programmed height that
//                      lifts on contact (link_mode "stepped"). A pure Z drop
//                      is a guarded segmented descent, a pure Z rise a move.
//   G0 B<angle>     -> a 3+2 station: the head is raised to the safe traverse
//                      height first (inserted here, law 2, enumerated on the
//                      page), then rotate_b's absolute rotation on the direct
//                      path verified by M114 / the heartbeat's b. B together
//                      with X/Y/Z, incremental B, and A/C are refused.
//   G4              -> a dwell; comments -> notes on the record.
//
// Programmed feeds are ignored (the march's own coarse/fine feeds keep the
// press bounded); coordinates are the CAM's WCS (work frame, G54) unless
// frame: "machine" or a G53 line. The result is an inspection report the CAM
// can read back (Fusion G800/G801 text, CSV, Grbl [PRB:], JSON).

export type LinkMode = 'raise' | 'stepped';

export interface ProbeCamPlan {
    tool: 'run_probing_gcode';
    source: string;
    parsed: ParsedProbeGcode;
    linkMode: LinkMode;
    hopLiftMm: number;
    onMiss: 'abort' | 'continue';
    march: MarchParams;
    hopZ: number;
    staged: Xyz;
    originOffset: Xyz;
    frame: 'work' | 'machine';
    tipDiameterMm: number | null;
    reportFormat: ReportFormat;
    warnings: string[];
}

interface CamArgs {
    gcode?: unknown;
    source?: unknown;
    frame?: unknown;
    link_mode?: unknown;
    hop_lift_mm?: unknown;
    on_miss?: unknown;
    report_format?: unknown;
    coarse_step_mm?: unknown;
    fine_step_mm?: unknown;
    backoff_mm?: unknown;
    sensor_delay_ms?: unknown;
    confirm_passes?: unknown;
}

const r3 = (v: number) => Number(v.toFixed(3));
const MAX_PROBE_TRAVEL_MM = 150;
const MAX_STEPS = 400;

function unitOf(from: Xyz, to: Xyz): { unit: Xyz; length: number } {
    const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    const length = Math.hypot(d.x, d.y, d.z);
    return { unit: { x: d.x / length, y: d.y / length, z: d.z / length }, length: r3(length) };
}

/** Motion list for the keep-out check, following the link policy. */
export function camMotion(plan: ProbeCamPlan): MotionSegment[] {
    const out: MotionSegment[] = [];
    for (const step of plan.parsed.steps) {
        if (step.kind === 'probe') {
            out.push({ kind: 'march', what: `line ${step.line} ${step.mode}`, from: step.from, to: step.target });
        } else if (step.kind === 'move') {
            const xyMoves = step.from.x !== step.target.x || step.from.y !== step.target.y;
            if (!xyMoves) {
                if (step.target.z < step.from.z) {
                    out.push({ kind: 'column', what: `line ${step.line} descent`, from: step.from, to: step.target });
                }
                continue;
            }
            if (plan.linkMode === 'raise') {
                out.push({ kind: 'hop', what: `line ${step.line} traverse`, from: { ...step.from, z: plan.hopZ }, to: { ...step.target, z: plan.hopZ } });
                out.push({ kind: 'column', what: `line ${step.line} descent`, from: { ...step.target, z: plan.hopZ }, to: step.target });
            } else {
                const linkZ = Math.max(step.from.z, step.target.z);
                out.push({ kind: 'march', what: `line ${step.line} stepped link`, from: { ...step.from, z: linkZ }, to: { ...step.target, z: linkZ } });
                if (step.target.z < linkZ) {
                    out.push({ kind: 'column', what: `line ${step.line} descent`, from: { ...step.target, z: linkZ }, to: step.target });
                }
            }
        }
    }
    return out;
}

export function planProbeCam(args: CamArgs): ProbeCamPlan {
    const gcode = String(args.gcode || '');
    if (!gcode.trim()) {
        throw new McpToolError('gcode is required: the probing program text (Grbl / Marlin dialect, G38.x cycles).');
    }
    const source = String(args.source || 'probing program').trim().slice(0, 80);
    const frame = args.frame === 'machine' ? 'machine' : 'work';
    const linkMode: LinkMode = args.link_mode === 'stepped' ? 'stepped' : 'raise';
    if (args.link_mode !== undefined && args.link_mode !== 'raise' && args.link_mode !== 'stepped') {
        throw new McpToolError('link_mode must be "raise" (XY at the traverse height, default) or "stepped" (touch-probing traverse at the programmed height).');
    }
    const onMiss = args.on_miss === 'continue' ? 'continue' : 'abort';
    const reportFormat = (args.report_format === undefined ? 'fusion' : String(args.report_format)) as ReportFormat;
    if (!['json', 'fusion', 'renishaw', 'csv', 'grbl'].includes(reportFormat)) {
        throw new McpToolError('report_format must be fusion, renishaw, csv, grbl or json.');
    }
    const hopLift = args.hop_lift_mm === undefined ? 2 : Number(args.hop_lift_mm);
    if (!Number.isFinite(hopLift) || hopLift < 0.5 || hopLift > 10) {
        throw new McpToolError('hop_lift_mm must be 0.5-10.');
    }

    const snapshot = getPositionSnapshot();
    const { x, y, z } = snapshot.machine;
    if (x === null || y === null || z === null) {
        throw new McpToolError('Current machine position unknown; cannot anchor the program.');
    }
    if (frame === 'work' && snapshot.originOffsetSource === 'assumed-zero') {
        throw new McpToolError('The work origin offset is unknown (heartbeat reports none yet), so a work-frame program cannot be placed. '
            + 'Wait for a heartbeat with the offset, or pass frame: "machine" for a program already in machine coordinates.');
    }
    const originOffset = frame === 'machine' ? { x: 0, y: 0, z: 0 } : { ...snapshot.originOffset };
    const hopZ = safeTraverseZ();

    let parsed: ParsedProbeGcode;
    try {
        parsed = parseProbingGcode(gcode, { startMachine: { x, y, z }, originOffset, startB: snapshot.b });
    } catch (err) {
        if (err instanceof ProbeGcodeError) {
            throw new McpToolError(`Probing program refused: ${err.message}`);
        }
        throw err;
    }
    const motionSteps = parsed.steps.filter((s) => s.kind === 'move' || s.kind === 'probe' || s.kind === 'rotate');
    if (parsed.rotations.length && !snapshot.isFourAxis) {
        throw new McpToolError(`The program rotates B (${parsed.rotations.join(', ')} deg) but the heartbeat reports no B axis - is the rotary module installed and selected?`);
    }
    if (motionSteps.length > MAX_STEPS) {
        throw new McpToolError(`${motionSteps.length} motion steps exceeds the cap of ${MAX_STEPS} per program - split it.`);
    }
    const warnings = [...parsed.warnings];
    if (parsed.steps.some((s) => (s.kind === 'move' || s.kind === 'probe') && s.feed !== null)) {
        warnings.push('Programmed feeds are ignored: probe cycles run the sensor-gated march (coarse F100 / fine F60), links at the traverse feed.');
    }

    // Envelope and per-step validity.
    const size = getMachineSizeByIdentifier(connectionManager.getConnectionStatus().machineIdentifier);
    for (const step of parsed.steps) {
        if (step.kind !== 'move' && step.kind !== 'probe') {
            continue;
        }
        const t = step.target;
        if (size && (t.x < -25 || t.x > size.x + 40 || t.y < -25 || t.y > size.y + 40)) {
            throw new McpToolError(`line ${step.line}: target (${t.x}, ${t.y}) is outside the machine envelope.`);
        }
        if (t.z < 0 || t.z > hopZ + 1e-9) {
            throw new McpToolError(`line ${step.line}: target Z${t.z} is outside 0..${hopZ} (the safe traverse height).`);
        }
        if (step.kind === 'probe') {
            const { unit, length } = unitOf(step.from, step.target);
            if (length > MAX_PROBE_TRAVEL_MM) {
                throw new McpToolError(`line ${step.line}: ${step.mode} travel ${length} mm exceeds ${MAX_PROBE_TRAVEL_MM} mm.`);
            }
            if ((step.mode === 'G38.2' || step.mode === 'G38.3') && unit.z > 1e-9) {
                throw new McpToolError(`line ${step.line}: upward probing (${step.mode} with +Z) is refused - the probe cannot measure the gantry.`);
            }
        }
    }

    const plan: ProbeCamPlan = {
        tool: 'run_probing_gcode',
        source,
        parsed,
        linkMode,
        hopLiftMm: hopLift,
        onMiss,
        march: {
            coarseStepMm: Math.min(Math.max(Number(args.coarse_step_mm) || 1, 0.2), 1), // operator law: never 2 mm
            fineStepMm: Math.min(Math.max(Number(args.fine_step_mm) || 0.1, 0.02), 0.5),
            backoffMm: Math.min(Math.max(Number(args.backoff_mm) || 1, Number(args.fine_step_mm) || 0.1), 3),
            sensorDelayMs: Math.min(Math.max(Number(args.sensor_delay_ms) || 300, 30), 10000),
            confirmPasses: Math.min(Math.max(Math.round(Number(args.confirm_passes) || 3), 1), 10),
        },
        hopZ,
        staged: { x, y, z },
        originOffset,
        frame,
        tipDiameterMm: (probeGeometry() || { tipDiameter: null }).tipDiameter,
        reportFormat,
        warnings,
    };

    const violations = checkMotion(camMotion(plan), landmarkStore.obstacleBoxes(), { traverseZ: hopZ });
    if (violations.length) {
        throw new McpToolError(`Probing program refused (law 4, landmarks are obstacles): ${describeViolations(violations)}.`);
    }
    return plan;
}

export function describeProbeCamPlanAsGcode(plan: ProbeCamPlan): string {
    const lines = [
        `; CAM PROBING PROGRAM "${plan.source}": ${plan.parsed.lineCount} lines, ${plan.parsed.probeCount} probe cycle(s), ${plan.frame} frame`
            + `${plan.frame === 'work' ? ` (work origin at machine ${-plan.originOffset.x}, ${-plan.originOffset.y}, ${-plan.originOffset.z})` : ''}`,
        '; The program is TRANSLATED, never sent raw: every G38.x becomes a sensor-gated march to its target (the travel limit),',
        `; links follow law 2 (${plan.linkMode === 'raise'
            ? `XY at the traverse height Z${plan.hopZ}, guarded segmented descents`
            : `stepped touch-probing traverse at the programmed height, lifting ${plan.hopLiftMm} mm on contact, descents guarded`}),`,
        `; programmed feeds are ignored (coarse ${plan.march.coarseStepMm} mm F${COARSE_FEED}, fine ${plan.march.fineStepMm}, ${plan.march.confirmPasses} confirm pass(es), sensor ${plan.march.sensorDelayMs} ms).`,
        `; G38.2 without contact: ${plan.onMiss === 'abort' ? 'ABORTS (Grbl semantics)' : 'records no_contact and continues'}; G38.3 always records. Report: ${plan.reportFormat}.`,
        ...(plan.parsed.rotations.length
            ? [`; THE STOCK WILL ROTATE: B schedule ${plan.parsed.rotations.map((b) => `${b} deg`).join(' -> ')} (absolute), each preceded by a raise to Z${plan.hopZ}.`]
            : []),
        ...plan.warnings.map((w) => `; WARNING ${w}`),
        `; anchored at machine (${plan.staged.x.toFixed(2)}, ${plan.staged.y.toFixed(2)}, ${plan.staged.z.toFixed(2)}) - re-verified before motion`,
        'G90',
    ];
    for (const step of plan.parsed.steps) {
        if (step.kind === 'note') {
            lines.push(`; L${step.line} (${step.text})`);
        } else if (step.kind === 'dwell') {
            lines.push(`G4 S${step.seconds}; L${step.line} dwell`);
        } else if (step.kind === 'rotate') {
            lines.push(`; L${step.line} ${step.source}`);
            lines.push(`G1 Z${plan.hopZ.toFixed(3)} F${TRAVEL_FEED}; raise to the traverse height before the stock turns (law 2)`);
            lines.push(`G0 B${step.bDeg.toFixed(3)}; rotate to B${step.bDeg} (absolute), verified by M114 / heartbeat b`);
        } else if (step.kind === 'move') {
            const xyMoves = step.from.x !== step.target.x || step.from.y !== step.target.y;
            lines.push(`; L${step.line} ${step.source}`);
            if (!xyMoves) {
                if (step.target.z > step.from.z) {
                    lines.push(`G1 Z${step.target.z.toFixed(3)} F${TRAVEL_FEED}; rise`);
                } else if (step.target.z < step.from.z) {
                    lines.push(`G1 Z${step.target.z.toFixed(3)} F${COARSE_FEED}; descend in <= ${DESCENT_SEGMENT_MM} mm segments, last ${DESCENT_GUARD_MM} mm in guarded 1 mm steps (contact aborts)`);
                }
            } else if (plan.linkMode === 'raise') {
                lines.push(`G1 Z${plan.hopZ.toFixed(3)} F${TRAVEL_FEED}; raise to the traverse height (law 2)`);
                lines.push(`G1 X${step.target.x.toFixed(3)} Y${step.target.y.toFixed(3)} F${TRAVEL_FEED}; traverse (crash guard armed)`);
                if (step.target.z < plan.hopZ) {
                    lines.push(`G1 Z${step.target.z.toFixed(3)} F${COARSE_FEED}; descend in segments, guarded last ${DESCENT_GUARD_MM} mm`);
                }
            } else {
                const linkZ = Math.max(step.from.z, step.target.z);
                if (linkZ > step.from.z) {
                    lines.push(`G1 Z${linkZ.toFixed(3)} F${TRAVEL_FEED}; rise to the link height`);
                }
                lines.push(`G1 X${step.target.x.toFixed(3)} Y${step.target.y.toFixed(3)} F300; stepped touch-probing traverse at Z${linkZ} (1 mm steps, lifts ${plan.hopLiftMm} mm on contact)`);
                if (step.target.z < linkZ) {
                    lines.push(`G1 Z${step.target.z.toFixed(3)} F${COARSE_FEED}; descend in segments, guarded last ${DESCENT_GUARD_MM} mm`);
                }
            }
        } else {
            const { length } = unitOf(step.from, step.target);
            const label = step.meta.name || step.meta.id || `probe ${step.index}`;
            lines.push(`; L${step.line} ${step.source}  -> "${label}"`);
            lines.push(`G1 X${step.target.x.toFixed(3)} Y${step.target.y.toFixed(3)} Z${step.target.z.toFixed(3)} F${COARSE_FEED}; ${step.mode} march up to ${length} mm - `
                + `${step.mode === 'G38.4' || step.mode === 'G38.5' ? 'coarse steps until the probe RELEASES, then on to the target' : `${plan.march.coarseStepMm} mm steps to contact, release, fine, confirm; retreat to (${step.from.x}, ${step.from.y}, ${step.from.z})`}`);
        }
    }
    lines.push(`G1 Z${plan.hopZ.toFixed(3)} F${TRAVEL_FEED}; finish at the safe traverse height (also on any abort)`);
    return lines.join('\n');
}

export interface ProbeCamResult {
    tool: 'run_probing_gcode';
    report: InspectionReport;
    reportFormat: ReportFormat;
    reportText: string;
    files: { [format: string]: string };
    phases: { phase: string; note?: string }[];
    note: string;
    aborted?: boolean;
}

function reportDir(): string {
    return path.join(DataStorage.userDataDir, 'mcp-inspection');
}

export function writeReportFiles(report: InspectionReport, formats: ReportFormat[], stem: string): { [format: string]: string } {
    const dir = reportDir();
    fs.ensureDirSync(dir);
    const files: { [format: string]: string } = {};
    for (const format of Array.from(new Set(formats))) {
        const file = path.join(dir, `${stem}.${reportExtension(format)}`);
        fs.writeFileSync(file, renderReport(report, format), 'utf8');
        files[format] = file;
    }
    return files;
}

export async function runProbeCamProcedure(plan: ProbeCamPlan, jobId: string | null): Promise<ProbeCamResult> {
    assertMachineReadyForProcedure();
    assertChannelReady('probe', 'CAM probing program');
    const phases: { phase: string; note?: string }[] = [];
    const announce = makeAnnounce(plan.tool, phases);
    const tag = 'cam';
    const records: ProbeResultRecord[] = [];
    const startedAt = Date.now();
    const offset = plan.originOffset;
    const toWork = (p: Xyz): Xyz => ({ x: r3(p.x + offset.x), y: r3(p.y + offset.y), z: r3(p.z + offset.z) });

    const build = (aborted: string | null): ProbeCamResult => {
        const contacts = records.filter((r) => r.status === 'contact' || r.status === 'released').length;
        const misses = records.filter((r) => r.status === 'no_contact' || r.status === 'not_released').length;
        const devs = records.map((r) => r.deviationMm).filter((d): d is number => d !== null);
        const report: InspectionReport = {
            source: plan.source,
            jobId,
            startedAt,
            endedAt: Date.now(),
            frame: { originOffset: offset, convention: 'work = machine + originOffset; contacts are tip-centre positions' },
            tipDiameterMm: plan.tipDiameterMm,
            results: plan.parsed.results,
            probes: records,
            summary: {
                total: plan.parsed.probeCount,
                contacts,
                misses,
                outOfTolerance: records.filter((r) => r.withinTolerance === false).length,
                maxAbsDeviationMm: devs.length ? r3(Math.max(...devs.map((d) => Math.abs(d)))) : null,
            },
            aborted: aborted || undefined,
        };
        let files: { [format: string]: string } = {};
        try {
            files = writeReportFiles(report, ['json', plan.reportFormat], jobId || `unsaved-${startedAt}`);
        } catch (err) {
            announce('report-file-failed', (err as Error).message);
        }
        return {
            tool: plan.tool,
            report,
            reportFormat: plan.reportFormat,
            reportText: renderReport(report, plan.reportFormat),
            files,
            phases,
            note: `${aborted ? 'ABORTED. ' : ''}${contacts}/${plan.parsed.probeCount} probe cycle(s) made contact`
                + `${report.summary.outOfTolerance ? `, ${report.summary.outOfTolerance} out of tolerance` : ''}`
                + `${report.summary.maxAbsDeviationMm !== null ? `, max |deviation| ${report.summary.maxAbsDeviationMm} mm` : ''}. `
                + `Report (${plan.reportFormat}) in reportText and on disk under mcp-inspection/.`,
            aborted: aborted ? true : undefined,
        };
    };

    const guardedDescent = async (label: string, toZ: number) => {
        const known = knownMachinePosition();
        const zNow = known.position.z;
        if (zNow === null) {
            throw new ProcedureAbort(`Machine Z unknown before the descent at ${label} - refusing to guess.`);
        }
        if (zNow < toZ - RECHECK_TOLERANCE_MM) {
            throw new ProcedureAbort(`${label}: the toolhead is at Z${zNow} (${known.source}), BELOW the descent target Z${toZ} - a descent never rises.`);
        }
        const guardTop = toZ + DESCENT_GUARD_MM;
        probeFeedService.clearExpectedContact();
        if (zNow > guardTop + 1e-9) {
            await descendInSegments(`${tag}:descend:${label}`, zNow, guardTop, 'probe', plan.march.sensorDelayMs);
        }
        let gz = Math.min(Math.max(zNow, toZ), guardTop);
        while (gz - toZ > 1e-9) {
            const t0 = Date.now();
            gz = Math.max(gz - 1, toZ);
            await moveMachineSettled(`${tag}:descend-guard:${label}`, { z: gz }, COARSE_FEED);
            const sensed = await senseAfter('probe', t0, plan.march.sensorDelayMs);
            if (sensed.contact) {
                throw new ProcedureAbort(`UNEXPECTED CONTACT at Z${gz.toFixed(3)} during the guarded descent (${label}) - something is where the program says nothing is. Machine held.`);
            }
        }
    };

    try {
        await expectMachinePosition(plan.staged, 'staged position', (message) => new McpToolError(
            `The machine is not at the position this program was staged from. ${message} Stage run_probing_gcode again.`
        ));
        let current: Xyz = { ...plan.staged };
        let currentB: number | null = getPositionSnapshot().b;

        for (const step of plan.parsed.steps) {
            if (step.kind === 'note') {
                announce(`L${step.line}`, step.text);
                continue;
            }
            if (step.kind === 'dwell') {
                announce(`L${step.line}-dwell`, `${step.seconds} s`);
                await sleep(step.seconds * 1000);
                continue;
            }
            const label = `L${step.line}`;
            if (step.kind === 'rotate') {
                probeFeedService.clearExpectedContact();
                if (current.z < plan.hopZ - 1e-9) {
                    await moveMachineSettled(`${tag}:raise:${label}`, { z: plan.hopZ }, TRAVEL_FEED);
                    current = { ...current, z: plan.hopZ };
                }
                const outcome = await rotateB(`${tag}:${label}`, step.bDeg, plan.hopZ);
                currentB = outcome.to;
                announce(`${label}-rotated`, `B ${outcome.from === null ? '?' : outcome.from} -> ${outcome.to} deg (${outcome.verifiedBy})`);
                continue;
            }
            await expectMachinePosition(current, label, (m) => new ProcedureAbort(m));
            if (step.kind === 'move') {
                const xyMoves = step.from.x !== step.target.x || step.from.y !== step.target.y;
                probeFeedService.clearExpectedContact();
                if (!xyMoves) {
                    if (step.target.z > current.z + 1e-9) {
                        await moveMachineSettled(`${tag}:rise:${label}`, { z: step.target.z }, TRAVEL_FEED);
                    } else if (step.target.z < current.z - 1e-9) {
                        await guardedDescent(label, step.target.z);
                    }
                } else if (plan.linkMode === 'raise') {
                    if (current.z < plan.hopZ - 1e-9) {
                        await moveMachineSettled(`${tag}:raise:${label}`, { z: plan.hopZ }, TRAVEL_FEED);
                    }
                    await moveMachineSettled(`${tag}:traverse:${label}`, { x: step.target.x, y: step.target.y }, TRAVEL_FEED);
                    if (step.target.z < plan.hopZ - 1e-9) {
                        await guardedDescent(label, step.target.z);
                    }
                } else {
                    const linkZ = Math.max(current.z, step.target.z);
                    if (linkZ > current.z + 1e-9) {
                        await moveMachineSettled(`${tag}:rise:${label}`, { z: linkZ }, TRAVEL_FEED);
                    }
                    const traverse = await steppedTraverseZ(tag, label, current, step.target, linkZ, {
                        liftMm: plan.hopLiftMm, maxZ: plan.hopZ, sensorDelayMs: plan.march.sensorDelayMs,
                    }, announce);
                    if (step.target.z < traverse.z - 1e-9) {
                        await guardedDescent(label, step.target.z);
                    }
                }
                current = { ...step.target };
                announce(`${label}-at`, `(${current.x}, ${current.y}, ${current.z})`);
                continue;
            }

            // ---- probe cycle
            const { unit, length } = unitOf(step.from, step.target);
            const id = step.meta.id || String(step.index);
            const name = step.meta.name || null;
            const base: Omit<ProbeResultRecord, 'status' | 'contactMachine' | 'contactWork' | 'travelMm' | 'shortOfTargetMm' | 'spreadMm' | 'deviationMm' | 'withinTolerance'> = {
                index: step.index,
                id,
                name,
                line: step.line,
                mode: step.mode,
                bDeg: currentB,
                startMachine: { ...step.from },
                targetMachine: { ...step.target },
                direction: { x: r3(unit.x), y: r3(unit.y), z: r3(unit.z) },
                maxTravelMm: length,
                meta: step.meta,
            };
            if (step.mode === 'G38.2' || step.mode === 'G38.3') {
                probeFeedService.setExpectedContact(['probe']);
                const contact = await marchToContact(tag, `${label}-${id}`, current, unit, length, plan.march, announce);
                if (contact) {
                    const contactWork = toWork(contact.point);
                    let deviationMm: number | null = null;
                    let withinTolerance: boolean | null = null;
                    if (step.meta.nominal && plan.tipDiameterMm !== null) {
                        // Surface = tip centre minus one tip radius along the
                        // normal; without a stored tip diameter the deviation
                        // stays null rather than being off by a stylus radius.
                        const nominalWork = step.meta.frame === 'machine' ? toWork(step.meta.nominal) : step.meta.nominal;
                        const normal = step.meta.normal || { x: -unit.x, y: -unit.y, z: -unit.z };
                        ({ deviationMm, withinTolerance } = deviationAlongNormal(
                            contactWork, nominalWork, normal, step.meta.upperTolMm, step.meta.lowerTolMm, plan.tipDiameterMm / 2
                        ));
                    } else if (step.meta.nominal) {
                        announce(`${label}-no-tip`, 'nominal given but no probe tip diameter stored (set_probe_geometry): deviation not computed');
                    }
                    records.push({
                        ...base,
                        status: 'contact',
                        contactMachine: contact.point,
                        contactWork,
                        travelMm: contact.s,
                        shortOfTargetMm: r3(length - contact.s),
                        spreadMm: contact.spreadMm,
                        deviationMm,
                        withinTolerance,
                    });
                } else {
                    records.push({ ...base, status: 'no_contact', contactMachine: null, contactWork: null, travelMm: null, shortOfTargetMm: null, spreadMm: null, deviationMm: null, withinTolerance: null });
                    announce(`${label}-no-contact`, `${step.mode}: nothing within ${length} mm`);
                    if (step.mode === 'G38.2' && plan.onMiss === 'abort') {
                        await retreatAlong(tag, `${label}-${id}`, current, unit, 0);
                        probeFeedService.clearExpectedContact();
                        throw new ProcedureAbort(`${label}: G38.2 reached its target without contact (Grbl: probe fail). Pass on_miss: "continue" to record misses instead.`);
                    }
                }
                // Retreat to the cycle start (the parser's assumption); the
                // probe may still be in contact, so it stays expected.
                await retreatAlong(tag, `${label}-${id}`, current, unit, 0);
                probeFeedService.clearExpectedContact();
                continue;
            }

            // G38.4 / G38.5: probe away - coarse steps until the probe releases.
            probeFeedService.setExpectedContact(['probe']);
            const reading = probeFeedService.getReading('probe');
            if (!reading || !reading.triggered) {
                announce(`${label}-not-in-contact`, `${step.mode} starts without contact - treated as released at the start`);
            }
            let s = 0;
            let releasedAt: number | null = (!reading || !reading.triggered) ? 0 : null;
            while (releasedAt === null && length - s > 1e-9) {
                const t0 = Date.now();
                s = Math.min(s + plan.march.coarseStepMm, length);
                const p = { x: r3(current.x + unit.x * s), y: r3(current.y + unit.y * s), z: r3(current.z + unit.z * s) };
                await moveMachineSettled(`${tag}:away:${label}`, p, COARSE_FEED);
                const sensed = await senseReleaseAfter('probe', t0, Math.max(plan.march.sensorDelayMs * 4, 3500));
                if (!sensed.contact) {
                    releasedAt = s;
                }
            }
            if (releasedAt === null) {
                records.push({ ...base, status: 'not_released', contactMachine: null, contactWork: null, travelMm: null, shortOfTargetMm: null, spreadMm: null, deviationMm: null, withinTolerance: null });
                probeFeedService.clearExpectedContact();
                if (step.mode === 'G38.4') {
                    throw new ProcedureAbort(`${label}: G38.4 reached its target without the probe releasing.`);
                }
            } else {
                const point = { x: r3(current.x + unit.x * releasedAt), y: r3(current.y + unit.y * releasedAt), z: r3(current.z + unit.z * releasedAt) };
                records.push({ ...base, status: 'released', contactMachine: point, contactWork: toWork(point), travelMm: releasedAt, shortOfTargetMm: r3(length - releasedAt), spreadMm: null, deviationMm: null, withinTolerance: null });
                announce(`${label}-released`, `at ${releasedAt} mm along`);
            }
            // Leaving the surface is safe: on to the programmed target.
            probeFeedService.clearExpectedContact();
            await moveMachineSettled(`${tag}:away-to-target:${label}`, { x: step.target.x, y: step.target.y, z: step.target.z }, TRAVEL_FEED);
            current = { ...step.target };
        }

        probeFeedService.clearExpectedContact();
        if (current.z < plan.hopZ - 1e-9) {
            await moveMachineSettled(`${tag}:final-raise`, { z: plan.hopZ }, TRAVEL_FEED);
        }
        const result = build(null);
        announce('program-complete', result.note);
        return result;
    } catch (err) {
        const isTrip = !!probeFeedService.getTrip();
        if (!isTrip) {
            try {
                const reading = probeFeedService.getReading('probe');
                if (!reading || !reading.triggered) {
                    probeFeedService.clearExpectedContact();
                    await moveMachineSettled(`${tag}:abort-raise`, { z: plan.hopZ }, TRAVEL_FEED);
                    announce('abort-raised', `Z${plan.hopZ}`);
                } else {
                    announce('abort-held', 'probe still triggered - holding position for the operator');
                }
            } catch (retreatErr) {
                // Logged by the activity stream.
            }
        }
        if (err instanceof ProcedureAbort) {
            const Ctor = err instanceof ProcedureStopped ? ProcedureStopped : ProcedureAbort;
            throw new Ctor(`CAM probing program aborted: ${err.message} ${records.length} probe cycle(s) recorded so far are on the job record (partial report written).`,
                build(err.message));
        }
        throw err;
    } finally {
        probeFeedService.clearExpectedContact();
    }
}

/** Re-render a stored report (job.result.report) in another format and write it beside the others. */
export function renderStoredReport(report: InspectionReport, format: ReportFormat, stem: string): { text: string; file: string | null } {
    const text = renderReport(report, format);
    let file: string | null = null;
    try {
        file = writeReportFiles(report, [format], stem)[format];
    } catch (err) {
        file = null;
    }
    return { text, file };
}
