/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention (the plan builders take the
// probe_surface_path / probe_surface_grid arguments verbatim).
import { mcpBroadcast } from './index';
import { probeFeedService } from './probeFeed';
import { DESCENT_GUARD_MM } from './probeSequence';
import {
    COARSE_FEED,
    FINE_FEED,
    MAX_RETREAT_MM,
    ProcedureAbort,
    TRAVEL_FEED,
    assertChannelReady,
    assertMachineReadyForProcedure,
    moveMachineSettled,
    senseAfter,
    senseReleaseAfter,
    sleep,
} from './probing';
import { McpToolError } from './registry';
import {
    ContactSample,
    HOP_SEGMENT_MM,
    SurfacePlanError,
    SurfaceStation,
    assertHopsWithin,
    buildZMatrix,
    fitLine,
    fitPlane,
    hopSegments,
    planGridStations,
    planPathStations,
    renderHeightMap,
    renderPathProfile,
    resolveEnvelope,
    stationEnvelope,
    summarizeZ,
} from './surfaceScan';
import { getMachineSizeByIdentifier, getPositionSnapshot, safeTraverseZ } from './tools/machine';
import { connectionManager } from '../machine/ConnectionManager';

// Top-surface scans with the spindle touch probe: N stations along a line
// (probe_surface_path) or over a serpentine grid (probe_surface_grid), each
// measured with a -Z sensor-gated march using the hardware-proven
// coarse/release/fine/confirm mechanics of probe_vector / probe_sequence.
// One operator approval covers the whole circuit; the confirm page
// enumerates every commanded move with concrete numbers.
//
// THE LAW-2 EXCEPTION (operator-authorised, 2026-09-05). Motion law 2 says
// every XY move over 1 mm happens at the safe traverse height. The operator's
// words for these two procedures: "with the grid we need the point to point
// variation to not risk the probe toolhead so no more than 20mm z safe delta
// from the top (within a horizontal change of 60mm)". So, INSIDE THESE TWO
// PROCEDURES ONLY, between CONSECUTIVE stations only, and only while the
// horizontal hop is <= max_hop_mm (cap 60), the probe retracts to
// lastContactZ + z_safe_delta_mm (cap 20) and hops AT THAT HEIGHT instead of
// at the gantry. Nothing else inherits this: the approach to the FIRST
// station is a full law-2 traverse (raise to the safe traverse height, hop,
// guarded descent to the operator-stated start_z_machine), and the scan ends
// raised at the traverse height. Caps are enforced by refusal at staging
// (never clamped), the mechanics are enforced at runtime:
//
//   - hops run with NO expected contact, through moveMachineSettled (crash
//     guard armed), in sensor-checked segments of <= HOP_SEGMENT_MM so a
//     graze is caught within one segment: contact during a hop = collision.
//   - each march may search down to max(lastContact - max_drop_mm, the
//     plan's absolute floor); reaching the floor without contact records the
//     station as no_contact (not an abort) and leaves the reference height
//     at the last REAL contact. The first station finding nothing aborts -
//     there would be no measured reference to base the envelope on.

export type SurfaceScanKind = 'path' | 'grid';

export interface ProbeSurfacePlan {
    kind: SurfaceScanKind;
    tool: 'probe_surface_path' | 'probe_surface_grid';
    stations: SurfaceStation[];
    /** Operator-stated toolhead machine Z at which the FIRST march starts (tip just above the surface). */
    startZMachine: number;
    /** Deepest toolhead Z any march may ever command (default start_z - max_drop). */
    absoluteFloorZ: number;
    zSafeDeltaMm: number;
    maxHopMm: number;
    maxDropMm: number;
    /** Largest consecutive-station distance in this plan (already verified <= maxHopMm). */
    worstHopMm: number;
    /** Safe traverse height: approach to station 1 and the final raise. */
    hopZ: number;
    staged: { x: number; y: number; z: number };
    coarseStepMm: number;
    fineStepMm: number;
    backoffMm: number;
    sensorDelayMs: number;
    confirmPasses: number;
    path?: {
        start: { x: number; y: number };
        end: { x: number; y: number };
        unit: { x: number; y: number };
        lengthMm: number;
        spacingMm: number;
    };
    grid?: {
        xs: number[];
        ys: number[];
        pitchXMm: number;
        pitchYMm: number;
        bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
    };
}

interface CommonArgs {
    start_z_machine?: unknown;
    floor_z_machine?: unknown;
    z_safe_delta_mm?: unknown;
    max_hop_mm?: unknown;
    max_drop_mm?: unknown;
    coarse_step_mm?: number;
    fine_step_mm?: number;
    backoff_mm?: number;
    sensor_delay_ms?: number;
    confirm_passes?: number;
}

function toToolError<T>(fn: () => T): T {
    try {
        return fn();
    } catch (err) {
        if (err instanceof SurfacePlanError) {
            throw new McpToolError(err.message);
        }
        throw err;
    }
}

/** Everything both scans share once the stations exist. */
function finishPlan(
    kind: SurfaceScanKind,
    stations: SurfaceStation[],
    args: CommonArgs
): Omit<ProbeSurfacePlan, 'path' | 'grid'> {
    const env = toToolError(() => resolveEnvelope(args));
    const worstHopMm = toToolError(() => assertHopsWithin(stations, env.maxHopMm));

    const hopZ = safeTraverseZ();
    const startZ = Number(args.start_z_machine);
    if (args.start_z_machine === undefined || !Number.isFinite(startZ)) {
        throw new McpToolError('start_z_machine is REQUIRED: the toolhead machine Z at which the first -Z march '
            + 'starts, with the probe tip just above the surface - a measured or operator-stated number, never a guess.');
    }
    if (startZ <= 0 || startZ > hopZ) {
        throw new McpToolError(`start_z_machine ${startZ} must be in 0..${hopZ} (the safe traverse height).`);
    }
    const floorZ = args.floor_z_machine === undefined ? startZ - env.maxDropMm : Number(args.floor_z_machine);
    if (!Number.isFinite(floorZ) || floorZ < 0) {
        throw new McpToolError('floor_z_machine must be a finite machine Z >= 0.');
    }
    if (floorZ >= startZ) {
        throw new McpToolError(`floor_z_machine ${floorZ} must be below start_z_machine ${startZ}.`);
    }
    if (startZ - floorZ > 150) {
        throw new McpToolError(`start_z_machine - floor_z_machine = ${(startZ - floorZ).toFixed(1)} mm exceeds 150 mm.`);
    }

    const size = getMachineSizeByIdentifier(connectionManager.getConnectionStatus().machineIdentifier);
    if (size) {
        for (const st of stations) {
            if (st.x < -25 || st.x > size.x + 40 || st.y < -25 || st.y > size.y + 40) {
                throw new McpToolError(`Station ${st.label} (${st.x}, ${st.y}) is outside the machine envelope.`);
            }
        }
    }

    const position = getPositionSnapshot();
    const { x, y, z } = position.machine;
    if (x === null || y === null || z === null) {
        throw new McpToolError('Current machine position unknown; cannot anchor the scan.');
    }

    return {
        kind,
        tool: kind === 'path' ? 'probe_surface_path' : 'probe_surface_grid',
        stations,
        startZMachine: Number(startZ.toFixed(3)),
        absoluteFloorZ: Number(floorZ.toFixed(3)),
        zSafeDeltaMm: env.zSafeDeltaMm,
        maxHopMm: env.maxHopMm,
        maxDropMm: env.maxDropMm,
        worstHopMm,
        hopZ,
        staged: { x, y, z },
        coarseStepMm: Math.min(Math.max(Number(args.coarse_step_mm) || 1, 0.2), 2),
        fineStepMm: Math.min(Math.max(Number(args.fine_step_mm) || 0.1, 0.02), 0.5),
        backoffMm: Math.min(Math.max(Number(args.backoff_mm) || 1, Number(args.fine_step_mm) || 0.1), 3),
        sensorDelayMs: Math.min(Math.max(Number(args.sensor_delay_ms) || 300, 100), 10000),
        confirmPasses: Math.min(Math.max(Math.round(Number(args.confirm_passes) || 3), 1), 10),
    };
}

export function planProbeSurfacePath(args: CommonArgs & {
    start_x?: unknown;
    start_y?: unknown;
    end_x?: unknown;
    end_y?: unknown;
    dx?: unknown;
    dy?: unknown;
    length_mm?: unknown;
    stations?: unknown;
    spacing_mm?: unknown;
}): ProbeSurfacePlan {
    const path = toToolError(() => planPathStations({
        start_x: args.start_x,
        start_y: args.start_y,
        end_x: args.end_x,
        end_y: args.end_y,
        dx: args.dx,
        dy: args.dy,
        length_mm: args.length_mm,
        stations: args.stations,
        spacing_mm: args.spacing_mm,
    }));
    return {
        ...finishPlan('path', path.stations, args),
        path: { start: path.start, end: path.end, unit: path.unit, lengthMm: path.lengthMm, spacingMm: path.spacingMm },
    };
}

export function planProbeSurfaceGrid(args: CommonArgs & {
    x_min?: unknown;
    x_max?: unknown;
    y_min?: unknown;
    y_max?: unknown;
    center_x?: unknown;
    center_y?: unknown;
    size_x_mm?: unknown;
    size_y_mm?: unknown;
    pitch_mm?: unknown;
    x_count?: unknown;
    y_count?: unknown;
}): ProbeSurfacePlan {
    const grid = toToolError(() => planGridStations(args));
    return {
        ...finishPlan('grid', grid.stations, args),
        grid: { xs: grid.xs, ys: grid.ys, pitchXMm: grid.pitchXMm, pitchYMm: grid.pitchYMm, bounds: grid.bounds },
    };
}

/** Confirm-page gcode: the whole scan, every commanded move enumerated with its bounds. */
export function describeProbeSurfacePlanAsGcode(plan: ProbeSurfacePlan): string {
    const n = plan.stations.length;
    const first = plan.stations[0];
    let shape = `${n} stations`;
    if (plan.kind === 'path' && plan.path) {
        shape = `${n} stations along (${plan.path.start.x}, ${plan.path.start.y}) -> (${plan.path.end.x}, ${plan.path.end.y}), `
            + `spacing ${plan.path.spacingMm} mm`;
    } else if (plan.grid) {
        shape = `${plan.grid.xs.length} x ${plan.grid.ys.length} = ${n} stations, pitch X ${plan.grid.pitchXMm} / Y ${plan.grid.pitchYMm} mm, `
            + `X ${plan.grid.bounds.xMin}..${plan.grid.bounds.xMax}, Y ${plan.grid.bounds.yMin}..${plan.grid.bounds.yMax}, serpentine`;
    }
    const firstEnv = stationEnvelope(plan.startZMachine, true, plan.startZMachine, {
        zSafeDeltaMm: plan.zSafeDeltaMm, maxDropMm: plan.maxDropMm, absoluteFloorZ: plan.absoluteFloorZ,
    });
    // The guarded descent starts at min(start_z + guard, traverse height): the
    // runner never commands a Z above the height it is already at.
    const guardTop = Math.min(plan.startZMachine + DESCENT_GUARD_MM, plan.hopZ);
    const lines = [
        `; SURFACE ${plan.kind.toUpperCase()} SCAN: ${shape}`,
        '; every station = a -Z sensor-gated march on the probe channel (coarse to contact, release,',
        `; ${plan.fineStepMm} mm fine approach, ${plan.confirmPasses} confirm pass(es), median); all coordinates MACHINE frame.`,
        `; anchored at machine (${plan.staged.x.toFixed(2)}, ${plan.staged.y.toFixed(2)}, ${plan.staged.z.toFixed(2)})`
            + ' - re-verified before any motion, and before EVERY march',
        ';',
        '; ENVELOPE (operator, 2026-09-05: "no more than 20mm z safe delta from the top (within a horizontal',
        '; change of 60mm)") - the operator-authorised EXCEPTION to motion law 2, valid ONLY inside this',
        '; procedure, ONLY between consecutive stations, ONLY for hops <= max_hop_mm:',
        `;   * between stations the probe retracts to LAST CONTACT + ${plan.zSafeDeltaMm} mm (z_safe_delta_mm, cap 20) and hops`,
        `;     horizontally AT THAT HEIGHT in <= ${HOP_SEGMENT_MM} mm sensor-checked segments - ANY probe contact during a hop`,
        ';     is a collision: CRASH alarm latches (job stop + connection close), operator clears it.',
        `;   * largest hop in this plan: ${plan.worstHopMm} mm (max_hop_mm ${plan.maxHopMm}, cap 60) - refused at staging otherwise.`,
        `;   * each march searches from the hop height down to max(last contact - ${plan.maxDropMm} mm, FLOOR Z${plan.absoluteFloorZ});`,
        ';     nothing by the floor = station recorded no_contact, reference height unchanged, scan continues',
        ';     (the FIRST station finding nothing aborts - no measured reference).',
        `;   * the deepest toolhead Z this scan can EVER command is Z${plan.absoluteFloorZ} (floor_z_machine).`,
        '; The approach to station 1 and the final raise are full law-2 moves at the traverse height.',
        '; overtravel feed trips -> job stop + connection close + latched alarm',
        'G90',
        'G53;',
        `G1 Z${plan.hopZ.toFixed(3)} F${TRAVEL_FEED}; raise to the safe traverse height (law 2)`,
        `G1 X${first.x.toFixed(3)} Y${first.y.toFixed(3)} F${TRAVEL_FEED}; hop at gantry height to station 1 "${first.label}"`,
        `G1 Z${guardTop.toFixed(3)} F${TRAVEL_FEED}; descend fast to ${(guardTop - plan.startZMachine).toFixed(1)} mm above start_z_machine`,
        '; ...guarded final approach: 1 mm steps, sensor-checked after each - ANY contact here aborts (CRASH).',
    ];
    for (let gz = guardTop - 1; gz > plan.startZMachine - 1e-9; gz -= 1) {
        lines.push(`G1 Z${Math.max(gz, plan.startZMachine).toFixed(3)} F${COARSE_FEED}; guarded descent step`);
    }
    lines.push(`; --- station 1 "${first.label}" (${first.x}, ${first.y}): march -Z from Z${firstEnv.marchStartZ} to floor Z${firstEnv.floorZ} ---`);
    let s = 0;
    let k = 0;
    while (firstEnv.travelMm - s > 1e-9) {
        s = Math.min(s + plan.coarseStepMm, firstEnv.travelMm);
        k += 1;
        lines.push(`G1 Z${(firstEnv.marchStartZ - s).toFixed(3)} F${COARSE_FEED}; coarse ${k} - settle, check probe, stop at contact`);
    }
    lines.push(`; ...on contact: release, ${plan.fineStepMm} mm fine approach, ${plan.confirmPasses} confirm cycle(s) (lift ${plan.backoffMm} mm)`);
    lines.push(`; retract to contact + ${plan.zSafeDeltaMm} mm (runtime number, never above Z${plan.hopZ})`);
    for (let i = 1; i < n; i++) {
        const prev = plan.stations[i - 1];
        const st = plan.stations[i];
        lines.push(`; --- station ${i + 1} "${st.label}" (${st.x}, ${st.y}): hop ${st.hopFromPreviousMm} mm at Z = last contact + ${plan.zSafeDeltaMm} ---`);
        const segs = hopSegments({ x: prev.x, y: prev.y }, { x: st.x, y: st.y });
        segs.forEach((seg, j) => {
            lines.push(`G1 X${seg.x.toFixed(3)} Y${seg.y.toFixed(3)} F${TRAVEL_FEED}; hop segment ${j + 1}/${segs.length} - settle, probe must NOT be in contact`);
        });
        lines.push(`; march -Z in ${plan.coarseStepMm} mm steps from the hop height to max(last contact - ${plan.maxDropMm}, Z${plan.absoluteFloorZ})`);
        lines.push(`G1 Z${plan.absoluteFloorZ.toFixed(3)} F${COARSE_FEED}; deepest allowed at this station (absolute floor) - no contact by here = no_contact`);
        lines.push(`; ...on contact: release, fine, confirm; retract to contact + ${plan.zSafeDeltaMm} mm`);
    }
    lines.push(`G1 Z${plan.hopZ.toFixed(3)} F${TRAVEL_FEED}; finish at the safe traverse height (also on any abort)`);
    lines.push('G54;');
    return lines.join('\n');
}

export interface SurfaceStationResult {
    index: number;
    label: string;
    x: number;
    y: number;
    s?: number;
    row?: number;
    col?: number;
    status: 'contact' | 'no_contact';
    /** Toolhead machine Z at contact (null when no_contact). */
    z: number | null;
    marchStartZ: number;
    floorZ: number;
    confirmPassContacts?: number[];
    spreadMm?: number;
}

/**
 * One -Z march from startZ down to floorZ at the station's XY: the exact
 * probe_vector / probe_sequence mechanics along the -Z unit vector, except
 * that reaching the floor without contact RETURNS null instead of aborting
 * (a surface scan must record a missing station and carry on).
 */
async function marchDownZ(
    plan: ProbeSurfacePlan,
    station: SurfaceStation,
    startZ: number,
    floorZ: number,
    announce: (phase: string, note?: string) => void
): Promise<{ contactZ: number; passContacts: number[]; spreadMm: number } | null> {
    const travel = Number((startZ - floorZ).toFixed(3));
    const releaseTimeoutMs = Math.max(plan.sensorDelayMs * 4, 3500);
    const zAt = (s: number) => Number((startZ - s).toFixed(3));
    const move = async (tool: string, s: number, feed: number) => {
        await moveMachineSettled(tool, { z: zAt(s) }, feed);
    };
    const tag = `${plan.tool}:${station.label}`;

    let s = 0;
    let coarseContactS: number | null = null;
    while (travel - s > 1e-9) {
        const t0 = Date.now();
        s = Math.min(s + plan.coarseStepMm, travel);
        await move(`${tag}:coarse`, s, COARSE_FEED);
        const sensed = await senseAfter('probe', t0, plan.sensorDelayMs);
        if (sensed.contact) {
            coarseContactS = s;
            announce(`coarse-contact-${station.label}`, `Z${zAt(s)}`);
            break;
        }
    }
    if (coarseContactS === null) {
        return null;
    }
    let released = false;
    while (s > 1e-9 && coarseContactS - s < MAX_RETREAT_MM + 1e-9) {
        const t0 = Date.now();
        s = Math.max(s - plan.coarseStepMm, 0);
        await move(`${tag}:release`, s, COARSE_FEED);
        const sensed = await senseReleaseAfter('probe', t0, releaseTimeoutMs);
        if (!sensed.contact) {
            released = true;
            break;
        }
    }
    if (!released) {
        throw new ProcedureAbort(`Station "${station.label}": probe still triggered ${MAX_RETREAT_MM} mm back from first contact - stuck probe or feed fault.`);
    }
    let fineContactS: number | null = null;
    while (travel - s > 1e-9) {
        const t0 = Date.now();
        s = Math.min(s + plan.fineStepMm, travel);
        await move(`${tag}:fine`, s, FINE_FEED);
        const sensed = await senseAfter('probe', t0, plan.sensorDelayMs);
        if (sensed.contact) {
            fineContactS = s;
            break;
        }
    }
    if (fineContactS === null) {
        throw new ProcedureAbort(`Station "${station.label}": fine approach lost the contact.`);
    }
    const passContacts: number[] = [];
    const cycleLimit = Math.min(fineContactS + Math.max(0.5, plan.backoffMm), travel);
    let reference = fineContactS;
    for (let pass = 1; pass <= plan.confirmPasses; pass++) {
        const t0 = Date.now();
        s = Math.max(reference - plan.backoffMm, 0);
        await move(`${tag}:backoff`, s, FINE_FEED);
        const lifted = await senseReleaseAfter('probe', t0, releaseTimeoutMs);
        if (lifted.contact) {
            throw new ProcedureAbort(`Station "${station.label}": hysteresis exceeds the backoff ${plan.backoffMm} mm.`);
        }
        let passContact: number | null = null;
        while (cycleLimit - s > 1e-9) {
            const t1 = Date.now();
            s = Math.min(s + plan.fineStepMm, cycleLimit);
            await move(`${tag}:confirm`, s, FINE_FEED);
            const sensed = await senseAfter('probe', t1, plan.sensorDelayMs);
            if (sensed.contact) {
                passContact = s;
                break;
            }
        }
        if (passContact === null) {
            throw new ProcedureAbort(`Station "${station.label}": confirm pass ${pass} lost the contact.`);
        }
        passContacts.push(zAt(passContact));
        reference = passContact;
    }
    const sorted = [...passContacts].sort((a, b) => a - b);
    const contactZ = sorted[Math.floor((sorted.length - 1) / 2)];
    const spreadMm = Number((sorted[sorted.length - 1] - sorted[0]).toFixed(3));
    return { contactZ, passContacts, spreadMm };
}

/** Structured procedure result (lands on job.result): stations, statistics, renderings. */
function buildResult(plan: ProbeSurfacePlan, results: SurfaceStationResult[], phases: { phase: string; note?: string }[]): object {
    const contacts: ContactSample[] = results
        .filter((r): r is SurfaceStationResult & { z: number } => r.z !== null)
        .map((r) => ({ x: r.x, y: r.y, z: r.z, s: r.s, label: r.label }));
    const summary = summarizeZ(contacts);
    const noContact = results.filter((r) => r.status === 'no_contact').map((r) => r.label);
    const worstSpread = Math.max(0, ...results.map((r) => r.spreadMm || 0));
    const common = {
        kind: plan.kind,
        tool: plan.tool,
        stations: results,
        contactCount: contacts.length,
        noContactStations: noContact,
        summary,
        worstConfirmSpreadMm: Number(worstSpread.toFixed(3)),
        envelope: {
            zSafeDeltaMm: plan.zSafeDeltaMm,
            maxHopMm: plan.maxHopMm,
            worstHopMm: plan.worstHopMm,
            maxDropMm: plan.maxDropMm,
            absoluteFloorZ: plan.absoluteFloorZ,
            startZMachine: plan.startZMachine,
        },
        coordinateNote: 'All Z values are TOOLHEAD machine Z at probe contact; the physical surface height is Z minus '
            + 'the probe\'s effective length (measure it with run_tool_setter accept_probe_contact - never assume).',
        phases,
        warning: worstSpread > plan.fineStepMm + 1e-9
            ? `Worst confirm spread ${worstSpread.toFixed(3)} mm exceeds one fine step - feed timing was unstable; `
                + 'consider more confirm_passes or a longer sensor_delay_ms.'
            : undefined,
    };
    if (plan.kind === 'path' && plan.path) {
        const line = fitLine(contacts);
        const profile = renderPathProfile(results.map((r) => ({ label: r.label, s: r.s || 0, z: r.z })));
        return {
            ...common,
            path: plan.path,
            lineFit: line,
            profile,
            note: summary
                ? `Surface path: ${contacts.length}/${results.length} contacts, Z ${summary.zMin}..${summary.zMax} `
                    + `(range ${summary.zRange} mm)${line ? `; best-fit slope ${line.slopeMmPer100Mm} mm per 100 mm (${line.slopeDeg} deg), `
                    + `flatness about the line ${line.flatnessMm} mm (rms residual ${line.rmsResidualMm})` : ''}. MACHINE coordinates.`
                : 'Surface path: no contacts.',
        };
    }
    const grid = plan.grid as NonNullable<ProbeSurfacePlan['grid']>;
    const plane = fitPlane(contacts);
    const zMatrix = buildZMatrix(grid.xs, grid.ys, results.map((r) => ({ row: r.row as number, col: r.col as number, z: r.z })));
    return {
        ...common,
        grid: { xs: grid.xs, ys: grid.ys, pitchXMm: grid.pitchXMm, pitchYMm: grid.pitchYMm, bounds: grid.bounds },
        zMatrix,
        heightMap: renderHeightMap(grid.xs, grid.ys, zMatrix),
        planeFit: plane,
        note: summary
            ? `Surface grid: ${contacts.length}/${results.length} contacts, Z ${summary.zMin}..${summary.zMax} `
                + `(range ${summary.zRange} mm, highest ${summary.highest}, lowest ${summary.lowest})`
                + `${plane ? `; best-fit plane tilt X ${plane.tiltXMmPer100Mm} / Y ${plane.tiltYMmPer100Mm} mm per 100 mm, `
                    + `flatness about the plane ${plane.flatnessMm} mm (rms residual ${plane.rmsResidualMm})` : ''}. `
                + 'MACHINE coordinates; zMatrix rows = ys ascending, cols = xs ascending; heightMap prints +Y at the top.'
            : 'Surface grid: no contacts.',
    };
}

export async function runProbeSurfaceProcedure(plan: ProbeSurfacePlan): Promise<object> {
    assertChannelReady('probe', `surface ${plan.kind} scan`);
    assertMachineReadyForProcedure();

    const phases: { phase: string; note?: string }[] = [];
    const announce = (phase: string, note?: string) => {
        phases.push({ phase, note });
        mcpBroadcast('mcp:activity', { tool: plan.tool, phase, note });
    };

    // Position checks: every preceding move verified its own arrival, so a
    // mismatch is drift or a transient heartbeat (a beat inside a G53...G54
    // window carrying no origin offset - job 44abebd9bab3, 2026-09-05).
    // Re-read once after a heartbeat period before believing it.
    const fmt = (sn: ReturnType<typeof getPositionSnapshot>) => `(${sn.machine.x}, ${sn.machine.y}, ${sn.machine.z}) `
        + `[work (${sn.work.x}, ${sn.work.y}, ${sn.work.z}), offset (${sn.originOffset.x}, ${sn.originOffset.y}, ${sn.originOffset.z}) `
        + `from ${sn.originOffsetSource}]`;
    const expectPosition = async (
        expected: { x: number; y: number; z: number },
        what: string,
        onMismatch: (message: string) => Error
    ) => {
        const matches = (p: { x: number | null; y: number | null; z: number | null }) => (
            p.x !== null && p.y !== null && p.z !== null
            && Math.abs(p.x - expected.x) <= 0.5
            && Math.abs(p.y - expected.y) <= 0.5
            && Math.abs(p.z - expected.z) <= 0.5
        );
        let snapshot = getPositionSnapshot();
        if (matches(snapshot.machine)) {
            return;
        }
        const firstRead = snapshot;
        await sleep(1200);
        snapshot = getPositionSnapshot();
        if (!matches(snapshot.machine)) {
            throw onMismatch(`${what}: machine at ${fmt(snapshot)} (first read ${fmt(firstRead)}) but the plan expects `
                + `(${expected.x}, ${expected.y}, ${expected.z}).`);
        }
        announce('position-recheck', `${what}: passed on the second heartbeat (first read was transient)`);
    };

    await expectPosition(plan.staged, 'staged position', (message) => new McpToolError(
        `The machine is not at the position this scan was staged from. ${message} Stage ${plan.tool} again.`
    ));

    const results: SurfaceStationResult[] = [];
    // Reference height for the envelope: the last REAL contact (toolhead Z).
    let reference: number | null = null;
    const hopHeightFor = (ref: number) => Number(Math.min(ref + plan.zSafeDeltaMm, plan.hopZ).toFixed(3));

    let stationIndex = 0;
    try {
        // Approach to station 1: full motion law 2 (raise, traverse at the
        // gantry height, guarded descent to the operator-stated start Z).
        const first = plan.stations[0];
        probeFeedService.clearExpectedContact();
        await moveMachineSettled(`${plan.tool}:raise`, { z: plan.hopZ }, TRAVEL_FEED);
        await moveMachineSettled(`${plan.tool}:traverse`, { x: first.x, y: first.y }, TRAVEL_FEED);
        announce('traverse', `(${first.x}, ${first.y}) at Z${plan.hopZ} (law 2)`);
        const guardTop = plan.startZMachine + DESCENT_GUARD_MM;
        const zNow = getPositionSnapshot().machine.z;
        if (zNow !== null && zNow > guardTop + 1e-9) {
            await moveMachineSettled(`${plan.tool}:descend`, { z: guardTop }, TRAVEL_FEED);
        }
        let gz = Math.min(zNow === null ? guardTop : Math.max(zNow, plan.startZMachine), guardTop);
        while (gz - plan.startZMachine > 1e-9) {
            const t0 = Date.now();
            gz = Math.max(gz - 1, plan.startZMachine);
            await moveMachineSettled(`${plan.tool}:descend-guard`, { z: gz }, COARSE_FEED);
            const sensed = await senseAfter('probe', t0, plan.sensorDelayMs);
            if (sensed.contact) {
                throw new ProcedureAbort(`UNEXPECTED CONTACT during the guarded descent at Z${gz.toFixed(3)} - the surface `
                    + `is above start_z_machine ${plan.startZMachine}. Machine held.`);
            }
        }
        announce('descend', `Z${plan.startZMachine} (guarded final ${DESCENT_GUARD_MM} mm)`);

        let currentZ = plan.startZMachine;
        for (const station of plan.stations) {
            stationIndex = station.index;
            const isFirst = station.index === 1;
            if (!isFirst) {
                // THE LAW-2 EXCEPTION: hop at lastContact + z_safe_delta, in
                // sensor-checked segments, expecting NO contact. See the file
                // header for the operator's authorisation and its bounds.
                const previous = plan.stations[station.index - 2];
                probeFeedService.clearExpectedContact();
                const segs = hopSegments({ x: previous.x, y: previous.y }, { x: station.x, y: station.y });
                for (let j = 0; j < segs.length; j++) {
                    const t0 = Date.now();
                    await moveMachineSettled(`${plan.tool}:hop:${station.label}`, { x: segs[j].x, y: segs[j].y }, TRAVEL_FEED);
                    const sensed = await senseAfter('probe', t0, plan.sensorDelayMs);
                    if (sensed.contact) {
                        throw new ProcedureAbort(`UNEXPECTED CONTACT during the hop to "${station.label}" at `
                            + `(${segs[j].x}, ${segs[j].y}, ${currentZ}) - the surface rises more than ${plan.zSafeDeltaMm} mm `
                            + 'above the last contact. Machine held.');
                    }
                }
                announce(`hop-${station.label}`, `${station.hopFromPreviousMm} mm to (${station.x}, ${station.y}) at Z${currentZ} `
                    + `(last contact + ${plan.zSafeDeltaMm})`);
            }

            const env = stationEnvelope(reference === null ? plan.startZMachine : reference, isFirst, plan.startZMachine, {
                zSafeDeltaMm: plan.zSafeDeltaMm, maxDropMm: plan.maxDropMm, absoluteFloorZ: plan.absoluteFloorZ,
            });
            // The march starts where the walk left us (start_z for station 1,
            // the hop height otherwise). Re-verify before trusting the sensor.
            const marchStartZ = isFirst ? plan.startZMachine : currentZ;
            await expectPosition({ x: station.x, y: station.y, z: marchStartZ }, `station "${station.label}"`,
                (message) => new ProcedureAbort(message));

            probeFeedService.setExpectedContact(['probe']);
            const outcome = await marchDownZ(plan, station, marchStartZ, env.floorZ, announce);
            let retractTo: number;
            if (outcome === null) {
                if (reference === null) {
                    throw new ProcedureAbort(`Station "${station.label}" (the first) found no surface between Z${marchStartZ} and the floor `
                        + `Z${env.floorZ} - no measured reference to base the envelope on. Check start_z_machine / floor_z_machine.`);
                }
                results.push({
                    index: station.index,
                    label: station.label,
                    x: station.x,
                    y: station.y,
                    s: station.s,
                    row: station.row,
                    col: station.col,
                    status: 'no_contact',
                    z: null,
                    marchStartZ,
                    floorZ: env.floorZ,
                });
                retractTo = hopHeightFor(reference);
                announce(`no-contact-${station.label}`, `nothing between Z${marchStartZ} and the floor Z${env.floorZ}; reference stays Z${reference}`);
            } else {
                reference = outcome.contactZ;
                results.push({
                    index: station.index,
                    label: station.label,
                    x: station.x,
                    y: station.y,
                    s: station.s,
                    row: station.row,
                    col: station.col,
                    status: 'contact',
                    z: outcome.contactZ,
                    marchStartZ,
                    floorZ: env.floorZ,
                    confirmPassContacts: outcome.passContacts,
                    spreadMm: outcome.spreadMm,
                });
                retractTo = hopHeightFor(outcome.contactZ);
                announce(`measured-${station.label}`, `(${station.x}, ${station.y}, ${outcome.contactZ}) spread ${outcome.spreadMm}`);
            }

            // Retract to the hop height (contact still expected while leaving
            // the surface), prove the probe released, then hand over to the
            // crash guard for the hop.
            const t0 = Date.now();
            await moveMachineSettled(`${plan.tool}:retract:${station.label}`, { z: retractTo }, TRAVEL_FEED);
            const released = await senseReleaseAfter('probe', t0, Math.max(plan.sensorDelayMs * 4, 3500));
            if (released.contact) {
                throw new ProcedureAbort(`Station "${station.label}": probe still triggered after retracting to Z${retractTo} - stuck probe or feed fault.`);
            }
            probeFeedService.clearExpectedContact();
            currentZ = retractTo;
        }

        await moveMachineSettled(`${plan.tool}:final-raise`, { z: plan.hopZ }, TRAVEL_FEED);
        announce('scan-complete', `${results.filter((r) => r.status === 'contact').length}/${results.length} contacts, raised to Z${plan.hopZ}`);
    } catch (err) {
        const isTrip = !!probeFeedService.getTrip();
        if (!isTrip) {
            try {
                const reading = probeFeedService.getReading('probe');
                if (!reading || !reading.triggered) {
                    probeFeedService.clearExpectedContact();
                    await moveMachineSettled(`${plan.tool}:abort-raise`, { z: plan.hopZ }, TRAVEL_FEED);
                    announce('abort-raised', `Z${plan.hopZ}`);
                } else {
                    announce('abort-held', 'probe still triggered - holding position for the operator');
                }
            } catch (retreatErr) {
                // Logged by the activity stream.
            }
        }
        if (err instanceof ProcedureAbort) {
            throw new McpToolError(`Surface ${plan.kind} scan aborted at station ${stationIndex}: ${err.message} `
                + `Completed stations: ${JSON.stringify(results)} Phases: ${JSON.stringify(phases)}`);
        }
        throw err;
    } finally {
        probeFeedService.clearExpectedContact();
    }

    return buildResult(plan, results, phases);
}
