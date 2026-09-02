/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention (planProbeCircle takes the
// probe_circle arguments verbatim).
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

// Circle probing: N sensor-gated radial marches around a roughly-round
// vertical feature (a post, a boss, a pin), then a least-squares circle fit.
// Physics note the result carries: every contact adds the probe tip's
// effective radius, so the fit yields the COMBINED diameter
// (feature + tip) - they cannot be separated without one being known.
// The operator's min/max diameter estimates bound every march: approaches
// start beyond max/2 and abort at min/2 without contact instead of
// pressing on into a wrong guess.
//
// Safety inherits the probe_point mechanics (hardware-proven), plus: the
// probe channel is EXPECTED contact only while marching/confirming - during
// repositioning hops and descents it is not, so a graze there latches the
// CRASH alarm instead of being absorbed. Repositioning between points obeys
// motion law 2 in full (operator, 2026-09-02: "x/y motion over 1mm is never
// below gantry height"): every hop lifts to the safe traverse height,
// traverses, then descends - no local hop heights above the feature.

export interface ProbeCirclePoint {
    azimuthDeg: number;
    startXY: { x: number; y: number };
}

export interface ProbeCirclePlan {
    center: { x: number; y: number }; // operator estimate, machine coords
    diameterMinMm: number;
    diameterMaxMm: number;
    topZMachine: number; // toolhead machine Z with the tip at the feature top
    probeZ: number; // side-contact toolhead Z
    hopZ: number; // repositioning toolhead Z: the safe traverse height (law 2)
    startRadiusMm: number;
    floorRadiusMm: number;
    points: ProbeCirclePoint[];
    coarseStepMm: number;
    fineStepMm: number;
    backoffMm: number;
    sensorDelayMs: number;
    confirmPasses: number;
    staged: { x: number; y: number; z: number }; // position at staging
}

export function planProbeCircle(args: {
    center_x?: number;
    center_y?: number;
    diameter_min_mm?: number;
    diameter_max_mm?: number;
    top_z_machine?: number;
    probe_depth_mm?: number;
    points?: number;
    approach_clearance_mm?: number;
    coarse_step_mm?: number;
    fine_step_mm?: number;
    backoff_mm?: number;
    sensor_delay_ms?: number;
    confirm_passes?: number;
}): ProbeCirclePlan {
    const centerX = Number(args.center_x);
    const centerY = Number(args.center_y);
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
        throw new McpToolError('center_x and center_y (machine coords, operator estimate) are required.');
    }
    const dMin = Number(args.diameter_min_mm);
    const dMax = Number(args.diameter_max_mm);
    if (!Number.isFinite(dMin) || !Number.isFinite(dMax) || dMin <= 0 || dMax < dMin || dMax > 100) {
        throw new McpToolError('diameter_min_mm and diameter_max_mm are required: the operator\'s bounds '
            + 'on the feature diameter (0 < min <= max <= 100). They bound every march - no contact by '
            + 'the min-diameter radius aborts instead of pressing on.');
    }
    const topZ = Number(args.top_z_machine);
    if (!Number.isFinite(topZ) || topZ <= 0 || topZ > 400) {
        throw new McpToolError('top_z_machine is required: the toolhead machine Z at which the probe tip '
            + 'touches the feature TOP - a measured or operator-stated number, never a guess.');
    }
    const probeDepth = Math.min(Math.max(Number(args.probe_depth_mm) || 3, 0.5), 20);
    const pointCount = Math.min(Math.max(Math.round(Number(args.points) || 8), 4), 16);
    const approach = Math.min(Math.max(Number(args.approach_clearance_mm) || 5, 1), 20);

    const startRadius = dMax / 2 + approach;
    const floorRadius = dMin / 2;
    if (startRadius - floorRadius < 1) {
        throw new McpToolError('Less than 1 mm between the approach start radius and the min-diameter '
            + 'floor - widen approach_clearance_mm or the diameter bounds.');
    }

    const position = getPositionSnapshot();
    const { x, y, z } = position.machine;
    if (x === null || y === null || z === null) {
        throw new McpToolError('Current machine position unknown; cannot anchor the envelope.');
    }

    const size = getMachineSizeByIdentifier(connectionManager.getConnectionStatus().machineIdentifier);
    const points: ProbeCirclePoint[] = [];
    for (let i = 0; i < pointCount; i++) {
        const azimuth = (360 / pointCount) * i;
        const rad = (azimuth * Math.PI) / 180;
        const sx = Number((centerX + startRadius * Math.cos(rad)).toFixed(3));
        const sy = Number((centerY + startRadius * Math.sin(rad)).toFixed(3));
        if (size && (sx < -25 || sx > size.x + 40 || sy < -25 || sy > size.y + 40)) {
            throw new McpToolError(`Approach start for azimuth ${azimuth.toFixed(0)} deg `
                + `(${sx}, ${sy}) falls outside the machine envelope.`);
        }
        points.push({ azimuthDeg: azimuth, startXY: { x: sx, y: sy } });
    }

    return {
        center: { x: centerX, y: centerY },
        diameterMinMm: dMin,
        diameterMaxMm: dMax,
        topZMachine: topZ,
        probeZ: Number((topZ - probeDepth).toFixed(3)),
        hopZ: safeTraverseZ(),
        startRadiusMm: Number(startRadius.toFixed(3)),
        floorRadiusMm: Number(floorRadius.toFixed(3)),
        points,
        coarseStepMm: Math.min(Math.max(Number(args.coarse_step_mm) || 0.5, 0.2), 2),
        fineStepMm: Math.min(Math.max(Number(args.fine_step_mm) || 0.1, 0.02), 0.5),
        backoffMm: Math.min(Math.max(Number(args.backoff_mm) || 0.5, Number(args.fine_step_mm) || 0.1), 3),
        sensorDelayMs: Math.min(Math.max(Number(args.sensor_delay_ms) || 200, 100), 10000),
        confirmPasses: Math.min(Math.max(Math.round(Number(args.confirm_passes) || 2), 1), 5),
        staged: { x, y, z },
    };
}

/** Confirm-page gcode: every commanded move of the whole star, enumerated. */
export function describeProbeCirclePlanAsGcode(plan: ProbeCirclePlan): string {
    const lines = [
        `; TOUCH PROBE CIRCLE MEASUREMENT: ${plan.points.length} radial marches around `
            + `estimated centre (${plan.center.x}, ${plan.center.y})`,
        `; operator diameter bounds ${plan.diameterMinMm}..${plan.diameterMaxMm} mm; approaches start at `
            + `radius ${plan.startRadiusMm} and ABORT at radius ${plan.floorRadiusMm} without contact`,
        `; feature top measured at toolhead Z ${plan.topZMachine}; side contacts at Z ${plan.probeZ}; `
            + `hops between points at the safe traverse height Z ${plan.hopZ} (motion law 2)`,
        '; EVERY LINE IS SENT INDIVIDUALLY and settle-verified; the probe feed is checked after each',
        '; march step. A probe touch during a hop or descent latches the CRASH alarm.',
        '; overtravel feed trips -> job stop + connection close + latched alarm',
        'G90',
        'G53;',
    ];
    for (const point of plan.points) {
        const rad = (point.azimuthDeg * Math.PI) / 180;
        lines.push(`; --- point at azimuth ${point.azimuthDeg.toFixed(1)} deg ---`);
        lines.push(`G1 Z${plan.hopZ.toFixed(3)} F${TRAVEL_FEED}; lift to safe traverse height`);
        lines.push(`G1 X${point.startXY.x.toFixed(3)} Y${point.startXY.y.toFixed(3)} F${TRAVEL_FEED}; approach start`);
        lines.push(`G1 Z${plan.probeZ.toFixed(3)} F${TRAVEL_FEED}; descend to probing depth`);
        let r = plan.startRadiusMm;
        let step = 0;
        while (r - plan.floorRadiusMm > 1e-9) {
            r = Math.max(r - plan.coarseStepMm, plan.floorRadiusMm);
            step += 1;
            const px = plan.center.x + r * Math.cos(rad);
            const py = plan.center.y + r * Math.sin(rad);
            lines.push(`G1 X${px.toFixed(3)} Y${py.toFixed(3)} F${COARSE_FEED}; coarse step ${step} `
                + `(radius ${r.toFixed(3)}) - settle, check probe, stop at contact`);
        }
        lines.push(`; ...on contact: retreat ${plan.coarseStepMm} mm radially until released, fine approach `
            + `in ${plan.fineStepMm} mm steps, ${plan.confirmPasses} confirm cycle(s) (lift ${plan.backoffMm} mm)`);
        lines.push(`G1 X${point.startXY.x.toFixed(3)} Y${point.startXY.y.toFixed(3)} F${TRAVEL_FEED}; retreat to approach start`);
    }
    lines.push(`G1 Z${plan.hopZ.toFixed(3)} F${TRAVEL_FEED}; final lift to hop height`);
    lines.push('G54;');
    return lines.join('\n');
}

/** Kasa least-squares circle fit; returns centre, radius and residuals. */
function fitCircle(contacts: { x: number; y: number }[]): {
    center: { x: number; y: number };
    radius: number;
    residuals: number[];
    rmsResidual: number;
    maxResidual: number;
} {
    // Linear system: x^2 + y^2 = 2ax + 2by + c, solved by normal equations.
    let sxx = 0; let sxy = 0; let syy = 0; let sx = 0; let sy = 0;
    let sxz = 0; let syz = 0; let sz = 0;
    const n = contacts.length;
    for (const p of contacts) {
        const zz = p.x * p.x + p.y * p.y;
        sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y;
        sx += p.x; sy += p.y;
        sxz += p.x * zz; syz += p.y * zz; sz += zz;
    }
    // Solve [2sxx 2sxy sx; 2sxy 2syy sy; 2sx 2sy n] * [a b c]' = [sxz syz sz]'
    const m = [
        [2 * sxx, 2 * sxy, sx, sxz],
        [2 * sxy, 2 * syy, sy, syz],
        [2 * sx, 2 * sy, n, sz],
    ];
    for (let col = 0; col < 3; col++) {
        let pivot = col;
        for (let row = col + 1; row < 3; row++) {
            if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) {
                pivot = row;
            }
        }
        [m[col], m[pivot]] = [m[pivot], m[col]];
        if (Math.abs(m[col][col]) < 1e-12) {
            throw new ProcedureAbort('Circle fit is degenerate (contacts nearly collinear).');
        }
        for (let row = 0; row < 3; row++) {
            if (row === col) {
                continue;
            }
            const factor = m[row][col] / m[col][col];
            for (let k = col; k < 4; k++) {
                m[row][k] -= factor * m[col][k];
            }
        }
    }
    const a = m[0][3] / m[0][0];
    const b = m[1][3] / m[1][1];
    const c = m[2][3] / m[2][2];
    const radius = Math.sqrt(Math.max(c + a * a + b * b, 0));
    const residuals = contacts.map((p) => Number((Math.hypot(p.x - a, p.y - b) - radius).toFixed(4)));
    const rms = Math.sqrt(residuals.reduce((acc, r) => acc + r * r, 0) / n);
    return {
        center: { x: Number(a.toFixed(3)), y: Number(b.toFixed(3)) },
        radius: Number(radius.toFixed(4)),
        residuals,
        rmsResidual: Number(rms.toFixed(4)),
        maxResidual: Number(Math.max(...residuals.map((r) => Math.abs(r))).toFixed(4)),
    };
}

export async function runProbeCircleProcedure(plan: ProbeCirclePlan): Promise<object> {
    assertChannelReady('probe', 'circle probe');
    assertMachineReadyForProcedure();

    const position = getPositionSnapshot();
    const here = position.machine;
    if (here.x === null || here.y === null || here.z === null
        || Math.abs(here.x - plan.staged.x) > 0.5
        || Math.abs(here.y - plan.staged.y) > 0.5
        || Math.abs(here.z - plan.staged.z) > 0.5) {
        throw new McpToolError('The machine is not at the position this envelope was staged from '
            + `(staged (${plan.staged.x}, ${plan.staged.y}, ${plan.staged.z}), now `
            + `(${here.x}, ${here.y}, ${here.z})). Stage probe_circle again.`);
    }
    if (here.z < plan.hopZ - 0.5) {
        throw new McpToolError(`Current machine Z ${here.z} is below the hop height ${plan.hopZ}; `
            + 'position at or above it before staging.');
    }

    const phases: { phase: string; note?: string }[] = [];
    const announce = (phase: string, note?: string) => {
        phases.push({ phase, note });
        mcpBroadcast('mcp:activity', { tool: 'probe_circle', phase, note });
    };
    const releaseTimeoutMs = Math.max(plan.sensorDelayMs * 4, 2500);
    const contacts: { azimuthDeg: number; x: number; y: number; radius: number; passRadii: number[]; spreadMm: number }[] = [];

    const radialXY = (azimuthRad: number, r: number) => ({
        x: Number((plan.center.x + r * Math.cos(azimuthRad)).toFixed(3)),
        y: Number((plan.center.y + r * Math.sin(azimuthRad)).toFixed(3)),
    });

    try {
        for (const point of plan.points) {
            const rad = (point.azimuthDeg * Math.PI) / 180;
            const label = `az${point.azimuthDeg.toFixed(0)}`;

            // Reposition: contact here is NOT expected - a graze latches CRASH.
            probeFeedService.clearExpectedContact();
            await moveMachineSettled(`circle:hop:${label}`, { z: plan.hopZ }, TRAVEL_FEED);
            await moveMachineSettled(`circle:hop:${label}`, { ...point.startXY }, TRAVEL_FEED);
            await moveMachineSettled(`circle:descend:${label}`, { z: plan.probeZ }, TRAVEL_FEED);
            announce(`start-${label}`, `approach start (${point.startXY.x}, ${point.startXY.y}) Z${plan.probeZ}`);

            // March radially inward; contact on the probe channel is expected.
            probeFeedService.setExpectedContact(['probe']);
            let r = plan.startRadiusMm;
            let coarseContactR: number | null = null;
            while (r - plan.floorRadiusMm > 1e-9) {
                const stepStart = Date.now();
                r = Math.max(r - plan.coarseStepMm, plan.floorRadiusMm);
                await moveMachineSettled(`circle:coarse:${label}`, radialXY(rad, r), COARSE_FEED);
                const sensed = await senseAfter('probe', stepStart, plan.sensorDelayMs);
                if (sensed.contact) {
                    coarseContactR = r;
                    announce(`coarse-contact-${label}`, `radius ${r.toFixed(3)}`);
                    break;
                }
            }
            if (coarseContactR === null) {
                throw new ProcedureAbort(`No contact by the min-diameter radius ${plan.floorRadiusMm} at `
                    + `azimuth ${point.azimuthDeg.toFixed(0)} deg - the centre estimate or diameter bounds `
                    + 'are wrong, or the probe is not reporting.');
            }

            // Retreat radially until released.
            let released = false;
            while (r < plan.startRadiusMm - 1e-9 && r - coarseContactR < MAX_RETREAT_MM + 1e-9) {
                const stepStart = Date.now();
                r = Math.min(r + plan.coarseStepMm, plan.startRadiusMm);
                await moveMachineSettled(`circle:release:${label}`, radialXY(rad, r), COARSE_FEED);
                const sensed = await senseReleaseAfter('probe', stepStart, releaseTimeoutMs);
                if (!sensed.contact) {
                    released = true;
                    break;
                }
            }
            if (!released) {
                throw new ProcedureAbort(`Probe still triggered ${MAX_RETREAT_MM} mm back from contact at `
                    + `azimuth ${point.azimuthDeg.toFixed(0)} deg - stuck probe or feed fault.`);
            }

            // Fine approach.
            let fineContactR: number | null = null;
            while (r - plan.floorRadiusMm > 1e-9) {
                const stepStart = Date.now();
                r = Math.max(r - plan.fineStepMm, plan.floorRadiusMm);
                await moveMachineSettled(`circle:fine:${label}`, radialXY(rad, r), FINE_FEED);
                const sensed = await senseAfter('probe', stepStart, plan.sensorDelayMs);
                if (sensed.contact) {
                    fineContactR = r;
                    break;
                }
            }
            if (fineContactR === null) {
                throw new ProcedureAbort(`Fine approach lost the contact at azimuth ${point.azimuthDeg.toFixed(0)} deg.`);
            }

            // Confirm cycles on the radius; median wins.
            const passRadii: number[] = [];
            const cycleFloor = Math.max(fineContactR - 0.5, plan.floorRadiusMm);
            let reference = fineContactR;
            for (let pass = 1; pass <= plan.confirmPasses; pass++) {
                const liftIssuedAt = Date.now();
                r = Math.min(reference + plan.backoffMm, plan.startRadiusMm);
                await moveMachineSettled(`circle:backoff:${label}`, radialXY(rad, r), FINE_FEED);
                const liftSense = await senseReleaseAfter('probe', liftIssuedAt, releaseTimeoutMs);
                if (liftSense.contact) {
                    throw new ProcedureAbort(`Probe still triggered after backing off ${plan.backoffMm} mm at `
                        + `azimuth ${point.azimuthDeg.toFixed(0)} deg - hysteresis exceeds the backoff.`);
                }
                let passContact: number | null = null;
                while (r - cycleFloor > 1e-9) {
                    const stepStart = Date.now();
                    r = Math.max(r - plan.fineStepMm, cycleFloor);
                    await moveMachineSettled(`circle:confirm:${label}`, radialXY(rad, r), FINE_FEED);
                    const sensed = await senseAfter('probe', stepStart, plan.sensorDelayMs);
                    if (sensed.contact) {
                        passContact = r;
                        break;
                    }
                }
                if (passContact === null) {
                    throw new ProcedureAbort(`Confirm pass ${pass} lost the contact at azimuth `
                        + `${point.azimuthDeg.toFixed(0)} deg.`);
                }
                passRadii.push(Number(passContact.toFixed(3)));
                reference = passContact;
            }
            const sorted = [...passRadii].sort((a, b) => a - b);
            const measuredR = sorted[Math.floor((sorted.length - 1) / 2)];
            const spreadMm = Number((sorted[sorted.length - 1] - sorted[0]).toFixed(3));
            const contactPoint = radialXY(rad, measuredR);
            contacts.push({
                azimuthDeg: point.azimuthDeg,
                ...contactPoint,
                radius: Number(measuredR.toFixed(3)),
                passRadii,
                spreadMm,
            });
            announce(`measured-${label}`, `radius ${measuredR.toFixed(3)} spread ${spreadMm}`);

            // Retreat radially to the approach start (still expected-contact
            // until physically clear).
            await moveMachineSettled(`circle:retreat:${label}`, { ...point.startXY }, TRAVEL_FEED);
        }

        // Final lift; reposition rules apply again.
        probeFeedService.clearExpectedContact();
        await moveMachineSettled('circle:final-lift', { z: plan.hopZ }, TRAVEL_FEED);
        announce('final-lift', `Z${plan.hopZ}`);

        const fit = fitCircle(contacts.map((c) => ({ x: c.x, y: c.y })));
        const combinedDiameter = Number((fit.radius * 2).toFixed(3));
        const tipMin = Number(Math.max(combinedDiameter - plan.diameterMaxMm, 0).toFixed(3));
        const tipMax = Number(Math.max(combinedDiameter - plan.diameterMinMm, 0).toFixed(3));
        const worstSpread = Math.max(...contacts.map((c) => c.spreadMm));
        return {
            contacts,
            fit: {
                center: fit.center,
                combinedDiameterMm: combinedDiameter,
                rmsResidualMm: fit.rmsResidual,
                maxResidualMm: fit.maxResidual,
                residualsMm: fit.residuals,
            },
            centerOffsetFromEstimate: {
                x: Number((fit.center.x - plan.center.x).toFixed(3)),
                y: Number((fit.center.y - plan.center.y).toFixed(3)),
            },
            tipEffectiveDiameterMm: { min: tipMin, max: tipMax },
            phases,
            note: `Fitted centre machine (${fit.center.x}, ${fit.center.y}), COMBINED diameter `
                + `${combinedDiameter} mm (feature + probe tip - inseparable without one known: if the `
                + `feature is truly ${plan.diameterMinMm}..${plan.diameterMaxMm} mm, the tip's effective `
                + `diameter is ${tipMin}..${tipMax} mm). Fit residuals rms ${fit.rmsResidual} / max `
                + `${fit.maxResidual} mm - direction-dependent residuals mean an out-of-round tip or `
                + `feature. Worst per-point confirm spread ${worstSpread} mm.`,
            warning: fit.maxResidual > 0.2
                ? 'Max fit residual exceeds 0.2 mm: the feature or the probe tip is significantly '
                    + 'out of round, or a contact was bad. Inspect residualsMm by azimuth.'
                : undefined,
        };
    } catch (err) {
        const isTrip = !!probeFeedService.getTrip();
        if (!isTrip) {
            try {
                // Abort retreat: radially out to the current point's start
                // radius is unknown here, so lift straight up to hopZ only if
                // the probe reads released; a stuck-triggered probe means
                // physical contact - leave the machine where it is.
                const reading = probeFeedService.getReading('probe');
                if (!reading || !reading.triggered) {
                    await moveMachineSettled('circle:abort-lift', { z: plan.hopZ }, TRAVEL_FEED);
                    announce('abort-lifted', `Z${plan.hopZ}`);
                } else {
                    announce('abort-held', 'probe still triggered - holding position for the operator');
                }
            } catch (retreatErr) {
                // Logged by the activity stream.
            }
        }
        if (err instanceof ProcedureAbort) {
            throw new McpToolError(`Circle probe aborted: ${err.message} Phases completed: ${JSON.stringify(phases)}`);
        }
        throw err;
    } finally {
        probeFeedService.clearExpectedContact();
    }
}
