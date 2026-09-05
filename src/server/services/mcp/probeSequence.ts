/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention (planProbeSequence takes
// the probe_sequence arguments verbatim).
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

// A whole measurement CIRCUIT as ONE staged, operator-approved procedure
// (operator-requested 2026-09-02: "I won't do separate approvals"). The
// operator approves a single enumerated plan of steps:
//
//   hop     - XY traverse; the runner FIRST raises to the safe traverse
//             height (motion law 2 is enforced mechanically, not by trust),
//             then moves XY. Contact during a hop latches CRASH.
//   descend - absolute Z move at the current XY (a "measured or operator-
//             stated number, never a guess" - the confirm page shows every
//             one). Contact during a descent latches CRASH.
//   probe   - a sensor-gated march along +/-X, +/-Y or -Z (or any unit
//             vector) from the position the plan has walked to, with the
//             proven coarse/release/fine/confirm mechanics. Contact is
//             EXPECTED only here. Each march is named; results are keyed
//             by name.
//
// The plan is SIMULATED at staging: the page enumerates every commanded
// move with concrete numbers, and the runner re-verifies the machine is
// where the simulation says it should be (+/-0.5mm) before every march.
// The sequence ends raised at the traverse height.

interface SequenceStepHop {
    kind: 'hop';
    x: number;
    y: number;
}
interface SequenceStepDescend {
    kind: 'descend';
    z: number;
}
interface SequenceStepProbe {
    kind: 'probe';
    name: string;
    unit: { x: number; y: number; z: number };
    maxTravelMm: number;
    start: { x: number; y: number; z: number }; // simulated position at march start
}
type SequenceStep = SequenceStepHop | SequenceStepDescend | SequenceStepProbe;

export const DESCENT_GUARD_MM = 20;

export interface ProbeSequencePlan {
    steps: SequenceStep[];
    coarseStepMm: number;
    fineStepMm: number;
    backoffMm: number;
    sensorDelayMs: number;
    confirmPasses: number;
    hopZ: number;
    staged: { x: number; y: number; z: number };
}

export function planProbeSequence(args: {
    steps?: unknown;
    coarse_step_mm?: number;
    fine_step_mm?: number;
    backoff_mm?: number;
    sensor_delay_ms?: number;
    confirm_passes?: number;
}): ProbeSequencePlan {
    if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 60) {
        throw new McpToolError('steps is required: 1-60 entries of {kind: hop|descend|probe, ...}.');
    }

    const position = getPositionSnapshot();
    const { x, y, z } = position.machine;
    if (x === null || y === null || z === null) {
        throw new McpToolError('Current machine position unknown; cannot anchor the envelope.');
    }
    const staged = { x, y, z };
    const hopZ = safeTraverseZ();
    const size = getMachineSizeByIdentifier(connectionManager.getConnectionStatus().machineIdentifier);
    const inEnvelope = (px: number, py: number) => !size
        || (px >= -25 && px <= size.x + 40 && py >= -25 && py <= size.y + 40);

    // Simulate the walk so every step is anchored to concrete coordinates.
    const virtual = { ...staged };
    const steps: SequenceStep[] = [];
    const names = new Set<string>();
    let probeCount = 0;
    (args.steps as { [key: string]: unknown }[]).forEach((raw, index) => {
        const kind = String(raw.kind || '');
        const at = `steps[${index}]`;
        if (kind === 'hop') {
            const hx = Number(raw.x);
            const hy = Number(raw.y);
            if (!Number.isFinite(hx) || !Number.isFinite(hy) || !inEnvelope(hx, hy)) {
                throw new McpToolError(`${at}: hop needs finite x/y inside the machine envelope.`);
            }
            steps.push({ kind: 'hop', x: hx, y: hy });
            virtual.x = hx;
            virtual.y = hy;
            virtual.z = hopZ; // the runner raises before every hop
        } else if (kind === 'descend') {
            const dz = Number(raw.z);
            if (!Number.isFinite(dz) || dz < 0 || dz > hopZ) {
                throw new McpToolError(`${at}: descend needs an absolute machine Z in 0..${hopZ}.`);
            }
            steps.push({ kind: 'descend', z: dz });
            virtual.z = dz;
        } else if (kind === 'probe') {
            const name = String(raw.name || `probe${probeCount + 1}`);
            if (names.has(name)) {
                throw new McpToolError(`${at}: duplicate probe name "${name}".`);
            }
            const dx = Number(raw.dx) || 0;
            const dy = Number(raw.dy) || 0;
            const dz = Number(raw.dz) || 0;
            const norm = Math.hypot(dx, dy, dz);
            if (!Number.isFinite(norm) || norm < 1e-9) {
                throw new McpToolError(`${at}: probe needs a direction (dx/dy/dz, at least one non-zero).`);
            }
            if (dz > 1e-9) {
                throw new McpToolError(`${at}: upward probing (dz > 0) is refused.`);
            }
            const unit = {
                x: Number((dx / norm).toFixed(6)),
                y: Number((dy / norm).toFixed(6)),
                z: Number((dz / norm).toFixed(6)),
            };
            const travel = Number(raw.max_travel_mm);
            if (!Number.isFinite(travel) || travel < 1 || travel > 150) {
                throw new McpToolError(`${at}: max_travel_mm required (1-150).`);
            }
            const limit = {
                x: virtual.x + unit.x * travel,
                y: virtual.y + unit.y * travel,
                z: virtual.z + unit.z * travel,
            };
            if (!inEnvelope(limit.x, limit.y) || limit.z < 0) {
                throw new McpToolError(`${at}: the march limit leaves the machine envelope.`);
            }
            steps.push({
                kind: 'probe',
                name,
                unit,
                maxTravelMm: travel,
                start: { ...virtual },
            });
            names.add(name);
            probeCount += 1;
            // The march retreats to its own start; the runner then raises to
            // the traverse height before whatever comes next.
            virtual.z = hopZ;
        } else {
            throw new McpToolError(`${at}: kind must be hop, descend or probe.`);
        }
    });
    if (probeCount === 0) {
        throw new McpToolError('The sequence has no probe steps - use move_z / a gcode job for pure motion.');
    }

    return {
        steps,
        coarseStepMm: Math.min(Math.max(Number(args.coarse_step_mm) || 1, 0.2), 2),
        fineStepMm: Math.min(Math.max(Number(args.fine_step_mm) || 0.1, 0.02), 0.5),
        backoffMm: Math.min(Math.max(Number(args.backoff_mm) || 1, Number(args.fine_step_mm) || 0.1), 3),
        sensorDelayMs: Math.min(Math.max(Number(args.sensor_delay_ms) || 300, 100), 10000),
        confirmPasses: Math.min(Math.max(Math.round(Number(args.confirm_passes) || 3), 1), 10),
        hopZ,
        staged,
    };
}

function pointAlong(start: { x: number; y: number; z: number }, unit: { x: number; y: number; z: number }, s: number) {
    return {
        x: Number((start.x + unit.x * s).toFixed(3)),
        y: Number((start.y + unit.y * s).toFixed(3)),
        z: Number((start.z + unit.z * s).toFixed(3)),
    };
}

function marchWords(step: SequenceStepProbe, s: number): { x?: number; y?: number; z?: number } {
    const p = pointAlong(step.start, step.unit, s);
    const words: { x?: number; y?: number; z?: number } = {};
    if (Math.abs(step.unit.x) > 1e-9) {
        words.x = p.x;
    }
    if (Math.abs(step.unit.y) > 1e-9) {
        words.y = p.y;
    }
    if (Math.abs(step.unit.z) > 1e-9) {
        words.z = p.z;
    }
    return words;
}

/** Confirm-page gcode: the whole circuit, every commanded move enumerated. */
export function describeProbeSequencePlanAsGcode(plan: ProbeSequencePlan): string {
    const probes = plan.steps.filter((s) => s.kind === 'probe').length;
    const lines = [
        `; PROBE SEQUENCE: one approved circuit of ${plan.steps.length} steps (${probes} sensor-gated marches)`,
        `; anchored at machine (${plan.staged.x.toFixed(2)}, ${plan.staged.y.toFixed(2)}, ${plan.staged.z.toFixed(2)})`
            + ' - re-verified before any motion, and before EVERY march',
        `; law 2 enforced mechanically: every hop first raises to the traverse height Z${plan.hopZ};`,
        '; every march retreats to its start and raises before the next step.',
        '; sensors: contact is EXPECTED only during marches - a probe/toolsetter trigger during',
        '; any hop, raise or descent latches the CRASH alarm (feed must be armed).',
        '; overtravel feed trips -> job stop + connection close + latched alarm',
        'G90',
        'G53;',
    ];
    for (const step of plan.steps) {
        if (step.kind === 'hop') {
            lines.push(`G1 Z${plan.hopZ.toFixed(3)} F${TRAVEL_FEED}; raise to traverse height (law 2)`);
            lines.push(`G1 X${step.x.toFixed(3)} Y${step.y.toFixed(3)} F${TRAVEL_FEED}; hop`);
        } else if (step.kind === 'descend') {
            lines.push(`G1 Z${(step.z + DESCENT_GUARD_MM).toFixed(3)} F${TRAVEL_FEED}; descend fast to ${DESCENT_GUARD_MM} mm above target`);
            lines.push('; ...guarded final approach (operator, 2026-09-02): 1 mm steps, sensor-checked after each -');
            lines.push('; ANY contact during a descent aborts and latches the CRASH alarm.');
            for (let gz = step.z + DESCENT_GUARD_MM - 1; gz > step.z - 1e-9; gz -= 1) {
                const zz = Math.max(gz, step.z);
                lines.push(`G1 Z${zz.toFixed(3)} F${COARSE_FEED}; guarded descent step`);
            }
        } else {
            const dir = `(${step.unit.x}, ${step.unit.y}, ${step.unit.z})`;
            lines.push(`; --- march "${step.name}" along ${dir}, max ${step.maxTravelMm} mm ---`);
            let s = 0;
            let n = 0;
            while (step.maxTravelMm - s > 1e-9) {
                s = Math.min(s + plan.coarseStepMm, step.maxTravelMm);
                n += 1;
                const w = marchWords(step, s);
                const text = [
                    w.x !== undefined ? `X${w.x.toFixed(3)}` : '',
                    w.y !== undefined ? `Y${w.y.toFixed(3)}` : '',
                    w.z !== undefined ? `Z${w.z.toFixed(3)}` : '',
                ].filter(Boolean).join(' ');
                lines.push(`G1 ${text} F${COARSE_FEED}; coarse ${n} - settle, check probe, stop at contact`);
            }
            lines.push(`; ...on contact: retreat/release, ${plan.fineStepMm} mm fine approach, `
                + `${plan.confirmPasses} confirm cycle(s) (lift ${plan.backoffMm} mm); ABORTS at the limit without contact`);
            lines.push(`G1 X${step.start.x.toFixed(3)} Y${step.start.y.toFixed(3)} Z${step.start.z.toFixed(3)} `
                + `F${TRAVEL_FEED}; retreat to the march start (also on any abort)`);
            lines.push(`G1 Z${plan.hopZ.toFixed(3)} F${TRAVEL_FEED}; raise to traverse height`);
        }
    }
    lines.push('G54;');
    return lines.join('\n');
}

const sleep = async (ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
});

export async function runProbeSequenceProcedure(plan: ProbeSequencePlan): Promise<object> {
    assertChannelReady('probe', 'probe sequence');
    assertMachineReadyForProcedure();

    const position = getPositionSnapshot();
    const here = position.machine;
    if (here.x === null || here.y === null || here.z === null
        || Math.abs(here.x - plan.staged.x) > 0.5
        || Math.abs(here.y - plan.staged.y) > 0.5
        || Math.abs(here.z - plan.staged.z) > 0.5) {
        throw new McpToolError('The machine is not at the position this sequence was staged from '
            + `(staged (${plan.staged.x}, ${plan.staged.y}, ${plan.staged.z}), now `
            + `(${here.x}, ${here.y}, ${here.z})). Stage probe_sequence again.`);
    }

    const phases: { phase: string; note?: string }[] = [];
    const announce = (phase: string, note?: string) => {
        phases.push({ phase, note });
        mcpBroadcast('mcp:activity', { tool: 'probe_sequence', phase, note });
    };
    const releaseTimeoutMs = Math.max(plan.sensorDelayMs * 4, 3500);
    const results: {
        name: string;
        contactMachine: { x: number; y: number; z: number };
        contactDistanceMm: number;
        confirmPassContacts: number[];
        spreadMm: number;
    }[] = [];

    let stepIndex = 0;
    try {
        for (const step of plan.steps) {
            stepIndex += 1;
            if (step.kind === 'hop') {
                probeFeedService.clearExpectedContact();
                await moveMachineSettled(`seq:raise:${stepIndex}`, { z: plan.hopZ }, TRAVEL_FEED);
                await moveMachineSettled(`seq:hop:${stepIndex}`, { x: step.x, y: step.y }, TRAVEL_FEED);
                announce(`hop-${stepIndex}`, `(${step.x}, ${step.y}) at Z${plan.hopZ}`);
            } else if (step.kind === 'descend') {
                probeFeedService.clearExpectedContact();
                const guardTop = step.z + DESCENT_GUARD_MM;
                const zNow = getPositionSnapshot().machine.z;
                if (zNow !== null && zNow > guardTop + 1e-9) {
                    await moveMachineSettled(`seq:descend:${stepIndex}`, { z: guardTop }, TRAVEL_FEED);
                }
                let gz = Math.min(zNow === null ? guardTop : Math.max(zNow, step.z), guardTop);
                while (gz - step.z > 1e-9) {
                    const t0 = Date.now();
                    gz = Math.max(gz - 1, step.z);
                    await moveMachineSettled(`seq:descend-guard:${stepIndex}`, { z: gz }, COARSE_FEED);
                    const sensed = await senseAfter('probe', t0, plan.sensorDelayMs);
                    if (sensed.contact) {
                        throw new ProcedureAbort(`UNEXPECTED CONTACT during guarded descent at Z${gz.toFixed(3)} `
                            + '- something is where the plan says nothing should be. Machine held.');
                    }
                }
                announce(`descend-${stepIndex}`, `Z${step.z} (guarded final ${DESCENT_GUARD_MM} mm)`);
            } else {
                // Re-verify the walk matches the simulation before marching.
                // Every preceding move already verified its own arrival, so a
                // mismatch here is either real drift or a transient heartbeat
                // (a beat inside a G53...G54 window reporting no/zero origin
                // offset - job 44abebd9bab3, 2026-09-05). Re-read once after a
                // heartbeat period before believing it.
                const expected = step.start;
                const matches = (p: { x: number | null; y: number | null; z: number | null }) => (
                    p.x !== null && p.y !== null && p.z !== null
                    && Math.abs(p.x - expected.x) <= 0.5
                    && Math.abs(p.y - expected.y) <= 0.5
                    && Math.abs(p.z - expected.z) <= 0.5
                );
                let snapshot = getPositionSnapshot();
                if (!matches(snapshot.machine)) {
                    const first = snapshot;
                    await sleep(1200);
                    snapshot = getPositionSnapshot();
                    if (!matches(snapshot.machine)) {
                        const fmt = (s: typeof snapshot) => `(${s.machine.x}, ${s.machine.y}, ${s.machine.z}) [work (${s.work.x}, ${s.work.y}, ${s.work.z}), offset (${s.originOffset.x}, ${s.originOffset.y}, ${s.originOffset.z}) from ${s.originOffsetSource}]`;
                        throw new ProcedureAbort(`March "${step.name}": machine at ${fmt(snapshot)} `
                            + `(first read ${fmt(first)}) but the plan expects `
                            + `(${expected.x}, ${expected.y}, ${expected.z}).`);
                    }
                    announce(`recheck-${stepIndex}`, 'position re-check passed on the second heartbeat (first read was transient)');
                }
                probeFeedService.setExpectedContact(['probe']);
                const move = async (tool: string, s: number, feed: number) => {
                    await moveMachineSettled(tool, marchWords(step, s), feed);
                };

                let s = 0;
                let coarseContactS: number | null = null;
                while (step.maxTravelMm - s > 1e-9) {
                    const t0 = Date.now();
                    s = Math.min(s + plan.coarseStepMm, step.maxTravelMm);
                    await move(`seq:coarse:${step.name}`, s, COARSE_FEED);
                    const sensed = await senseAfter('probe', t0, plan.sensorDelayMs);
                    if (sensed.contact) {
                        coarseContactS = s;
                        announce(`coarse-contact-${step.name}`, `${s.toFixed(3)} mm along`);
                        break;
                    }
                }
                if (coarseContactS === null) {
                    throw new ProcedureAbort(`March "${step.name}": no contact within ${step.maxTravelMm} mm.`);
                }
                let released = false;
                while (s > 1e-9 && coarseContactS - s < MAX_RETREAT_MM + 1e-9) {
                    const t0 = Date.now();
                    s = Math.max(s - plan.coarseStepMm, 0);
                    await move(`seq:release:${step.name}`, s, COARSE_FEED);
                    const sensed = await senseReleaseAfter('probe', t0, releaseTimeoutMs);
                    if (!sensed.contact) {
                        released = true;
                        break;
                    }
                }
                if (!released) {
                    throw new ProcedureAbort(`March "${step.name}": still triggered ${MAX_RETREAT_MM} mm back.`);
                }
                let fineContactS: number | null = null;
                while (step.maxTravelMm - s > 1e-9) {
                    const t0 = Date.now();
                    s = Math.min(s + plan.fineStepMm, step.maxTravelMm);
                    await move(`seq:fine:${step.name}`, s, FINE_FEED);
                    const sensed = await senseAfter('probe', t0, plan.sensorDelayMs);
                    if (sensed.contact) {
                        fineContactS = s;
                        break;
                    }
                }
                if (fineContactS === null) {
                    throw new ProcedureAbort(`March "${step.name}": fine approach lost the contact.`);
                }
                const passContacts: number[] = [];
                const cycleLimit = Math.min(fineContactS + Math.max(0.5, plan.backoffMm), step.maxTravelMm);
                let reference = fineContactS;
                for (let pass = 1; pass <= plan.confirmPasses; pass++) {
                    const t0 = Date.now();
                    s = Math.max(reference - plan.backoffMm, 0);
                    await move(`seq:backoff:${step.name}`, s, FINE_FEED);
                    const lifted = await senseReleaseAfter('probe', t0, releaseTimeoutMs);
                    if (lifted.contact) {
                        throw new ProcedureAbort(`March "${step.name}": hysteresis exceeds the backoff.`);
                    }
                    let passContact: number | null = null;
                    while (cycleLimit - s > 1e-9) {
                        const t1 = Date.now();
                        s = Math.min(s + plan.fineStepMm, cycleLimit);
                        await move(`seq:confirm:${step.name}`, s, FINE_FEED);
                        const sensed = await senseAfter('probe', t1, plan.sensorDelayMs);
                        if (sensed.contact) {
                            passContact = s;
                            break;
                        }
                    }
                    if (passContact === null) {
                        throw new ProcedureAbort(`March "${step.name}": confirm pass ${pass} lost the contact.`);
                    }
                    passContacts.push(Number(passContact.toFixed(3)));
                    reference = passContact;
                }
                const sorted = [...passContacts].sort((a, b) => a - b);
                const measuredS = sorted[Math.floor((sorted.length - 1) / 2)];
                const spreadMm = Number((sorted[sorted.length - 1] - sorted[0]).toFixed(3));
                const contact = pointAlong(step.start, step.unit, measuredS);
                results.push({
                    name: step.name,
                    contactMachine: contact,
                    contactDistanceMm: measuredS,
                    confirmPassContacts: passContacts,
                    spreadMm,
                });
                announce(`measured-${step.name}`, `(${contact.x}, ${contact.y}, ${contact.z}) spread ${spreadMm}`);

                // Retreat to the march start, then raise (still expected-contact
                // until physically clear of the surface).
                await moveMachineSettled(`seq:retreat:${step.name}`, {
                    x: step.start.x, y: step.start.y, z: step.start.z,
                }, TRAVEL_FEED);
                probeFeedService.clearExpectedContact();
                await moveMachineSettled(`seq:raise:${step.name}`, { z: plan.hopZ }, TRAVEL_FEED);
            }
        }

        announce('sequence-complete', `${results.length} contacts`);
        return {
            results,
            phases,
            note: `Probe sequence complete: ${results.length} contacts, all MACHINE coordinates. `
                + 'Worst confirm spread '
                + `${Math.max(...results.map((r) => r.spreadMm)).toFixed(3)} mm.`,
        };
    } catch (err) {
        const isTrip = !!probeFeedService.getTrip();
        if (!isTrip) {
            try {
                const reading = probeFeedService.getReading('probe');
                if (!reading || !reading.triggered) {
                    await moveMachineSettled('seq:abort-raise', { z: plan.hopZ }, TRAVEL_FEED);
                    announce('abort-raised', `Z${plan.hopZ}`);
                } else {
                    announce('abort-held', 'probe still triggered - holding position for the operator');
                }
            } catch (retreatErr) {
                // Logged by the activity stream.
            }
        }
        if (err instanceof ProcedureAbort) {
            throw new McpToolError(`Probe sequence aborted at step ${stepIndex}: ${err.message} `
                + `Completed contacts: ${JSON.stringify(results)} Phases: ${JSON.stringify(phases)}`);
        }
        throw err;
    } finally {
        probeFeedService.clearExpectedContact();
    }
}
