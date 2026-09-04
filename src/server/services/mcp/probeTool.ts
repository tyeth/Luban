/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention (planProbePoint takes the
// probe_point arguments verbatim).
import { mcpBroadcast } from './index';
import { probeFeedService } from './probeFeed';
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
} from './probing';
import { McpToolError } from './registry';
import { getMachineSizeByIdentifier, getPositionSnapshot, safeTraverseZ } from './tools/machine';
import { connectionManager } from '../machine/ConnectionManager';

// Point probing with the spindle-mounted touch probe (normally-open, probe
// feed channel, inverted polarity handled by the feed): a single-axis
// sensor-gated march from the CURRENT position, using the same staged
// mechanics hardware-proven on the tool setter - coarse steps to contact,
// retreat to release, fine steps, then quick lift-and-retest confirm cycles;
// the result is the median contact coordinate with the spread reported.
//
// The envelope the operator approves is anchored to the position at staging:
// the runner re-verifies it before moving, so the page is always truthful.

export type ProbeAxis = 'x' | 'y' | 'z';

export interface ProbePointPlan {
    axis: ProbeAxis;
    direction: 1 | -1;
    start: { x: number; y: number; z: number }; // machine coords at staging
    maxTravelMm: number;
    limitCoord: number; // start[axis] + direction * maxTravel, envelope-clamped
    coarseStepMm: number;
    fineStepMm: number;
    backoffMm: number;
    sensorDelayMs: number;
    confirmPasses: number;
}

export function planProbePoint(args: {
    axis?: string;
    direction?: number;
    max_travel_mm?: number;
    coarse_step_mm?: number;
    fine_step_mm?: number;
    backoff_mm?: number;
    sensor_delay_ms?: number;
    confirm_passes?: number;
}): ProbePointPlan {
    const axis = String(args.axis || '').toLowerCase() as ProbeAxis;
    if (!['x', 'y', 'z'].includes(axis)) {
        throw new McpToolError('axis must be "x", "y" or "z".');
    }
    const direction = Number(args.direction);
    if (direction !== 1 && direction !== -1) {
        throw new McpToolError('direction must be 1 or -1 (the sign of travel along the axis).');
    }
    if (axis === 'z' && direction === 1) {
        throw new McpToolError('Z probing is downward only (direction -1).');
    }
    const maxTravelMm = Number(args.max_travel_mm);
    if (!Number.isFinite(maxTravelMm) || maxTravelMm < 1 || maxTravelMm > 150) {
        throw new McpToolError('max_travel_mm is required: how far the probe may march before aborting (1-150).');
    }

    const position = getPositionSnapshot();
    const { x, y, z } = position.machine;
    if (x === null || y === null || z === null) {
        throw new McpToolError('Current machine position unknown; cannot anchor the probe envelope.');
    }

    let limitCoord = { x, y, z }[axis] + direction * maxTravelMm;
    // Clamp to the same envelope the direct-move guards use (machine
    // -25..size+40 for X/Y; Z never below 0).
    const size = getMachineSizeByIdentifier(connectionManager.getConnectionStatus().machineIdentifier);
    if (axis === 'z') {
        limitCoord = Math.max(limitCoord, 0);
    } else if (size) {
        limitCoord = Math.min(Math.max(limitCoord, -25), size[axis] + 40);
    }
    if (Math.abs(limitCoord - { x, y, z }[axis]) < 0.5) {
        throw new McpToolError('The clamped probe travel is under 0.5 mm - already at the envelope edge.');
    }

    return {
        axis,
        direction: direction as 1 | -1,
        start: { x, y, z },
        maxTravelMm,
        limitCoord: Number(limitCoord.toFixed(3)),
        coarseStepMm: Math.min(Math.max(Number(args.coarse_step_mm) || 1, 0.2), 2),
        fineStepMm: Math.min(Math.max(Number(args.fine_step_mm) || 0.1, 0.02), 0.5),
        backoffMm: Math.min(Math.max(Number(args.backoff_mm) || 1, Number(args.fine_step_mm) || 0.1), 3),
        sensorDelayMs: Math.min(Math.max(Number(args.sensor_delay_ms) || 300, 100), 10000),
        confirmPasses: Math.min(Math.max(Math.round(Number(args.confirm_passes) || 3), 1), 10),
    };
}

/** Confirm-page gcode: every stepped command as it would execute. */
export function describeProbePlanAsGcode(plan: ProbePointPlan): string {
    const word = plan.axis.toUpperCase();
    const lines = [
        '; TOUCH PROBE POINT MEASUREMENT (server-driven, sensor-gated on the probe channel)',
        '; EVERY LINE IS SENT INDIVIDUALLY: after each move settles, the probe feed is checked',
        '; before the next line. The march stops at first contact; running the full ladder',
        `; without contact ABORTS at the travel limit ${word} ${plan.limitCoord.toFixed(3)}.`,
        `; anchored at machine (${plan.start.x.toFixed(2)}, ${plan.start.y.toFixed(2)}, ${plan.start.z.toFixed(2)})`
            + ' - re-verified before any motion',
        '; overtravel feed trips -> job stop + connection close + latched alarm',
        'G90',
        'G53;',
    ];
    let coord = plan.start[plan.axis];
    let step = 0;
    const towards = (value: number) => (plan.direction === 1
        ? Math.min(value, plan.limitCoord) : Math.max(value, plan.limitCoord));
    while (Math.abs(coord - plan.limitCoord) > 1e-9) {
        coord = towards(coord + plan.direction * plan.coarseStepMm);
        step += 1;
        lines.push(`G1 ${word}${coord.toFixed(3)} F${COARSE_FEED}; coarse step ${step} - settle, check probe, stop at contact`);
    }
    lines.push(
        `; ...on contact: retreat ${plan.coarseStepMm} mm steps until released, approach in ${plan.fineStepMm} mm`,
        `; steps to contact, then ${plan.confirmPasses} quick confirm cycles (lift ${plan.backoffMm} mm, wait for release,`,
        `; re-approach). Result = median contact ${word} (spread reported).`,
        `G1 ${word}${plan.start[plan.axis].toFixed(3)} F${TRAVEL_FEED}; retreat to the start ${word} when done (also on any abort)`,
    );
    const traverse = safeTraverseZ();
    if (plan.start.z < traverse) {
        lines.push(`G1 Z${traverse.toFixed(3)} F${TRAVEL_FEED}; finish at the safe traverse height (motion law 2)`);
    }
    lines.push('G54;');
    return lines.join('\n');
}

export interface ProbePointResult {
    axis: ProbeAxis;
    direction: number;
    contactMachine: { x: number; y: number; z: number };
    contactWorkOffsetApplied: string;
    confirmPassContacts: number[];
    spreadMm: number;
    phases: { phase: string; coord: number; note?: string }[];
    note: string;
    warning?: string;
}

export async function runProbePointProcedure(plan: ProbePointPlan): Promise<object> {
    assertChannelReady('probe', 'touch probe');
    assertMachineReadyForProcedure();
    // The probe is EXPECTED to touch during this procedure; the toolsetter
    // firing instead would be a collision (crash guard). Cleared in finally.
    probeFeedService.setExpectedContact(['probe']);

    const position = getPositionSnapshot();
    const here = position.machine;
    if (here.x === null || here.y === null || here.z === null
        || Math.abs(here.x - plan.start.x) > 0.5
        || Math.abs(here.y - plan.start.y) > 0.5
        || Math.abs(here.z - plan.start.z) > 0.5) {
        throw new McpToolError('The machine is not at the position this probe envelope was staged from '
            + `(staged (${plan.start.x}, ${plan.start.y}, ${plan.start.z}), now `
            + `(${here.x}, ${here.y}, ${here.z})). Stage probe_point again from the current position.`);
    }

    const word = plan.axis.toUpperCase();
    const phases: { phase: string; coord: number; note?: string }[] = [];
    const announce = (phase: string, coord: number, note?: string) => {
        phases.push({ phase, coord: Number(coord.toFixed(3)), note });
        mcpBroadcast('mcp:activity', { tool: 'probe_point', phase, axis: plan.axis, coord: Number(coord.toFixed(3)), note });
    };
    const releaseTimeoutMs = Math.max(plan.sensorDelayMs * 4, 3500);
    const startCoord = plan.start[plan.axis];
    const towards = (value: number) => (plan.direction === 1
        ? Math.min(value, plan.limitCoord) : Math.max(value, plan.limitCoord));
    const move = async (tool: string, coord: number, feed: number) => {
        await moveMachineSettled(tool, { [plan.axis]: coord } as { x?: number; y?: number; z?: number }, feed);
    };

    let current = startCoord;
    try {
        // Coarse march to first contact.
        let coarseContact: number | null = null;
        while (Math.abs(current - plan.limitCoord) > 1e-9) {
            const stepStart = Date.now();
            current = towards(current + plan.direction * plan.coarseStepMm);
            await move('probe:coarse', current, COARSE_FEED);
            const sensed = await senseAfter('probe', stepStart, plan.sensorDelayMs);
            if (sensed.contact) {
                coarseContact = current;
                announce('coarse-contact', current, `probe "${sensed.reading?.value}"`);
                break;
            }
        }
        if (coarseContact === null) {
            throw new ProcedureAbort(`Reached the travel limit ${word} ${plan.limitCoord.toFixed(3)} without `
                + 'contact - nothing to probe within max_travel_mm, or the probe is not reporting.');
        }

        // Retreat until released.
        let released = false;
        while (Math.abs(current - startCoord) > 1e-9 && Math.abs(current - coarseContact) < MAX_RETREAT_MM + 1e-9) {
            const stepStart = Date.now();
            current = plan.direction === 1
                ? Math.max(current - plan.coarseStepMm, startCoord)
                : Math.min(current + plan.coarseStepMm, startCoord);
            await move('probe:release', current, COARSE_FEED);
            const sensed = await senseReleaseAfter('probe', stepStart, releaseTimeoutMs);
            if (!sensed.contact) {
                released = true;
                announce('released', current);
                break;
            }
        }
        if (!released) {
            throw new ProcedureAbort(`Probe still reads triggered ${MAX_RETREAT_MM} mm back from first `
                + 'contact - stuck probe or feed fault.');
        }

        // Fine approach.
        let fineContact: number | null = null;
        while (Math.abs(current - plan.limitCoord) > 1e-9) {
            const stepStart = Date.now();
            current = towards(current + plan.direction * plan.fineStepMm);
            await move('probe:fine', current, FINE_FEED);
            const sensed = await senseAfter('probe', stepStart, plan.sensorDelayMs);
            if (sensed.contact) {
                fineContact = current;
                announce('fine-contact', current, `probe "${sensed.reading?.value}"`);
                break;
            }
        }
        if (fineContact === null) {
            throw new ProcedureAbort('Fine approach reached the travel limit without re-contact after a '
                + 'coarse contact - inconsistent probe.');
        }

        // Quick lift-and-retest confirm cycles; median wins, spread reported.
        const passContacts: number[] = [];
        const cycleLimit = towards(fineContact + plan.direction * Math.max(0.5, plan.backoffMm));
        let reference = fineContact;
        for (let pass = 1; pass <= plan.confirmPasses; pass++) {
            const liftIssuedAt = Date.now();
            current = reference - plan.direction * plan.backoffMm;
            await move('probe:backoff', current, FINE_FEED);
            const liftSense = await senseReleaseAfter('probe', liftIssuedAt, releaseTimeoutMs);
            if (liftSense.contact) {
                throw new ProcedureAbort(`Probe still triggered ${releaseTimeoutMs} ms after backing off `
                    + `${plan.backoffMm} mm - hysteresis exceeds the backoff. Rerun with a larger backoff_mm.`);
            }
            let passContact: number | null = null;
            while (Math.abs(current - cycleLimit) > 1e-9) {
                const stepStart = Date.now();
                current = plan.direction === 1
                    ? Math.min(current + plan.fineStepMm, cycleLimit)
                    : Math.max(current - plan.fineStepMm, cycleLimit);
                await move('probe:confirm', current, FINE_FEED);
                const sensed = await senseAfter('probe', stepStart, plan.sensorDelayMs);
                if (sensed.contact) {
                    passContact = current;
                    break;
                }
            }
            if (passContact === null) {
                throw new ProcedureAbort(`Confirm pass ${pass} went 0.5 mm past the first contact without `
                    + 're-contact - inconsistent probe.');
            }
            passContacts.push(Number(passContact.toFixed(3)));
            announce(`confirm-${pass}`, passContact, `of ${plan.confirmPasses}`);
            reference = passContact;
        }
        const sorted = [...passContacts].sort((a, b) => a - b);
        const measured = sorted[Math.floor((sorted.length - 1) / 2)];
        const spreadMm = Number((sorted[sorted.length - 1] - sorted[0]).toFixed(3));
        announce('measured', measured, `median of [${passContacts.join(', ')}], spread ${spreadMm} mm`);

        // Retreat along the probed axis to the start coordinate, then finish
        // at the safe traverse height (operator request 2026-09-02) so no
        // separate staged lift is needed before the next reposition.
        await move('probe:retreat', startCoord, TRAVEL_FEED);
        announce('retreated', startCoord);
        const traverse = safeTraverseZ();
        if (plan.start.z < traverse) {
            await moveMachineSettled('probe:raise', { z: traverse }, TRAVEL_FEED);
            announce('raised', traverse, 'safe traverse height');
        }

        const contactMachine = { ...plan.start, [plan.axis]: measured };
        const after = getPositionSnapshot();
        const result: ProbePointResult = {
            axis: plan.axis,
            direction: plan.direction,
            contactMachine,
            contactWorkOffsetApplied: `work = machine + originOffset (${JSON.stringify(after.originOffset)})`,
            confirmPassContacts: passContacts,
            spreadMm,
            phases,
            note: `Probe contact at machine ${word} ${measured.toFixed(3)} - median of ${plan.confirmPasses} `
                + `passes [${passContacts.join(', ')}], spread ${spreadMm} mm (+/- ${plan.fineStepMm} mm step `
                + 'resolution, minus the probe tip radius on side probes - the tip touches before its centre).',
            warning: spreadMm > plan.fineStepMm + 1e-9
                ? `Confirm passes spread ${spreadMm} mm exceeds one fine step - feed timing was unstable; `
                    + 'consider more confirm_passes or a longer sensor_delay_ms.'
                : undefined,
        };
        return result as unknown as object;
    } catch (err) {
        const isTrip = !!probeFeedService.getTrip();
        if (!isTrip) {
            try {
                await move('probe:abort-retreat', startCoord, TRAVEL_FEED);
                announce('abort-retreated', startCoord);
                const traverse = safeTraverseZ();
                const reading = probeFeedService.getReading('probe');
                if (plan.start.z < traverse && (!reading || !reading.triggered)) {
                    await moveMachineSettled('probe:abort-raise', { z: traverse }, TRAVEL_FEED);
                    announce('abort-raised', traverse, 'safe traverse height');
                }
            } catch (retreatErr) {
                // The abort itself already reports; retreat failure is logged
                // by the activity stream.
            }
        }
        if (err instanceof ProcedureAbort) {
            throw new McpToolError(`Probe run aborted: ${err.message} Phases completed: ${JSON.stringify(phases)}`);
        }
        throw err;
    } finally {
        probeFeedService.clearExpectedContact();
    }
}
