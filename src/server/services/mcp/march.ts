import { mcpBroadcast } from './index';
import { probeFeedService } from './probeFeed';
import {
    COARSE_FEED,
    FINE_FEED,
    MAX_RETREAT_MM,
    ProcedureAbort,
    TRAVEL_FEED,
    moveMachineSettled,
    senseAfter,
    senseReleaseAfter,
} from './probing';

// Shared sensor-gated motion primitives (mcp/48, operator request 2026-09-06):
//
//  - marchToContact(): the proven coarse -> release -> fine -> confirm march
//    every runner carries a copy of (probe_vector, probe_sequence, tool
//    setter, surface scans), with the same numbers, as one function. A miss
//    (limit reached without contact) is RETURNED, not thrown: the caller
//    decides (a measurement of "nothing within N mm" is usually fine).
//
//  - steppedTraverse(): a move between two points close to a surface as a
//    TOUCH-PROBING move: 1 mm steps with the probe channel expected, and a
//    contact means "the surface is closer here" - back off one step, retreat
//    `liftMm` along the retreat direction (up, for a top; away from the face,
//    for a side), continue. The result is a step profile of the surface
//    between the points (gentle for a slope, one big lift for the wall of a
//    hole, one bump for a projection on a side) instead of the fixed "last
//    contact + N mm" clearance whose only answer to a contact was to abort.
//    Retreats are capped: for a top, at the traverse height, above which a
//    plain move finishes (law 2); for a side, at the approved start line,
//    where a further contact is a fault (something stands where the operator
//    approved empty space).

export type Xyz = { x: number; y: number; z: number };

export interface MarchParams {
    coarseStepMm: number;
    fineStepMm: number;
    backoffMm: number;
    sensorDelayMs: number;
    confirmPasses: number;
}

export interface MarchContact {
    /** Distance along the unit vector from the start (median of the confirm passes). */
    s: number;
    point: Xyz;
    passContacts: number[];
    spreadMm: number;
    coarseContactS: number;
}

export type Announce = (phase: string, note?: string) => void;

export function makeAnnounce(tool: string, phases: { phase: string; note?: string }[]): Announce {
    return (phase: string, note?: string) => {
        phases.push({ phase, note });
        mcpBroadcast('mcp:activity', { tool, phase, note });
    };
}

const r3 = (v: number) => Number(v.toFixed(3));

export function pointAlong(start: Xyz, unit: Xyz, s: number): Xyz {
    return { x: r3(start.x + unit.x * s), y: r3(start.y + unit.y * s), z: r3(start.z + unit.z * s) };
}

function wordsAlong(start: Xyz, unit: Xyz, s: number): { x?: number; y?: number; z?: number } {
    const p = pointAlong(start, unit, s);
    const words: { x?: number; y?: number; z?: number } = {};
    if (Math.abs(unit.x) > 1e-9) {
        words.x = p.x;
    }
    if (Math.abs(unit.y) > 1e-9) {
        words.y = p.y;
    }
    if (Math.abs(unit.z) > 1e-9) {
        words.z = p.z;
    }
    return words;
}

/**
 * March from `start` along `unit` (unit vector, dz <= 0) up to `maxTravelMm`
 * on the probe channel. Returns the contact, or null when the limit was
 * reached without one (the probe is then AT the limit: the caller retreats).
 * Throws ProcedureAbort on an inconsistent probe (stuck, lost re-contact).
 * The expected-contact set is the caller's: set it before, clear it after
 * the retreat.
 */
export async function marchToContact(
    tag: string,
    name: string,
    start: Xyz,
    unit: Xyz,
    maxTravelMm: number,
    params: MarchParams,
    announce: Announce
): Promise<MarchContact | null> {
    const releaseTimeoutMs = Math.max(params.sensorDelayMs * 4, 3500);
    const move = async (tool: string, s: number, feed: number) => {
        await moveMachineSettled(tool, wordsAlong(start, unit, s), feed);
    };
    let s = 0;
    let coarseContactS: number | null = null;
    while (maxTravelMm - s > 1e-9) {
        const t0 = Date.now();
        s = Math.min(s + params.coarseStepMm, maxTravelMm);
        await move(`${tag}:coarse:${name}`, s, COARSE_FEED);
        const sensed = await senseAfter('probe', t0, params.sensorDelayMs);
        if (sensed.contact) {
            coarseContactS = s;
            announce(`coarse-contact-${name}`, `${s.toFixed(3)} mm along`);
            break;
        }
    }
    if (coarseContactS === null) {
        return null;
    }
    let released = false;
    while (s > 1e-9 && coarseContactS - s < MAX_RETREAT_MM + 1e-9) {
        const t0 = Date.now();
        s = Math.max(s - params.coarseStepMm, 0);
        await move(`${tag}:release:${name}`, s, COARSE_FEED);
        const sensed = await senseReleaseAfter('probe', t0, releaseTimeoutMs);
        if (!sensed.contact) {
            released = true;
            break;
        }
    }
    if (!released) {
        throw new ProcedureAbort(`March "${name}": still triggered ${MAX_RETREAT_MM} mm back - stuck probe or feed fault.`);
    }
    let fineContactS: number | null = null;
    while (maxTravelMm - s > 1e-9) {
        const t0 = Date.now();
        s = Math.min(s + params.fineStepMm, maxTravelMm);
        await move(`${tag}:fine:${name}`, s, FINE_FEED);
        const sensed = await senseAfter('probe', t0, params.sensorDelayMs);
        if (sensed.contact) {
            fineContactS = s;
            break;
        }
    }
    if (fineContactS === null) {
        throw new ProcedureAbort(`March "${name}": fine approach lost the contact.`);
    }
    const passContacts: number[] = [];
    const cycleLimit = Math.min(fineContactS + Math.max(0.5, params.backoffMm), maxTravelMm);
    let reference = fineContactS;
    for (let pass = 1; pass <= params.confirmPasses; pass++) {
        const t0 = Date.now();
        s = Math.max(reference - params.backoffMm, 0);
        await move(`${tag}:backoff:${name}`, s, FINE_FEED);
        const lifted = await senseReleaseAfter('probe', t0, releaseTimeoutMs);
        if (lifted.contact) {
            throw new ProcedureAbort(`March "${name}": hysteresis exceeds the backoff ${params.backoffMm} mm.`);
        }
        let passContact: number | null = null;
        while (cycleLimit - s > 1e-9) {
            const t1 = Date.now();
            s = Math.min(s + params.fineStepMm, cycleLimit);
            await move(`${tag}:confirm:${name}`, s, FINE_FEED);
            const sensed = await senseAfter('probe', t1, params.sensorDelayMs);
            if (sensed.contact) {
                passContact = s;
                break;
            }
        }
        if (passContact === null) {
            throw new ProcedureAbort(`March "${name}": confirm pass ${pass} lost the contact.`);
        }
        passContacts.push(r3(passContact));
        reference = passContact;
    }
    const sorted = [...passContacts].sort((a, b) => a - b);
    const measuredS = sorted[Math.floor((sorted.length - 1) / 2)];
    const spreadMm = r3(sorted[sorted.length - 1] - sorted[0]);
    const point = pointAlong(start, unit, measuredS);
    announce(`measured-${name}`, `(${point.x}, ${point.y}, ${point.z}) spread ${spreadMm}`);
    return { s: measuredS, point, passContacts, spreadMm, coarseContactS };
}

/** Move along the march vector to distance `s` from its start (0 = the start; the probe may still be in contact: keep it expected). */
export async function retreatAlong(tag: string, name: string, start: Xyz, unit: Xyz, s: number): Promise<void> {
    await moveMachineSettled(`${tag}:retreat:${name}`, wordsAlong(start, unit, s), TRAVEL_FEED);
}

export const STEPPED_HOP_STEP_MM = 1;
export const STEPPED_HOP_FEED = 300;

export interface SteppedTraverseParams {
    /** Unit vector of the retreat on contact: (0,0,1) over a top, away from the face along a side. */
    retreatUnit: Xyz;
    /** Retreat per contact (mm). */
    liftMm: number;
    /** Total retreat allowed from the start plane (mm): traverse height minus z over a top; the start line along a side. */
    maxLiftTotalMm: number;
    /**
     * At the cap: 'plain-move' finishes with one plain move (law 2, at the
     * traverse height); 'stop-lifting' keeps stepping and a further contact is a fault.
     */
    onMax: 'plain-move' | 'stop-lifting';
    sensorDelayMs: number;
    /** Give up after this many lifts on one traverse (default 60). */
    maxLifts?: number;
}

export interface SteppedTraverseResult {
    /** Where the toolhead arrived: `to` displaced by the total retreat along retreatUnit. */
    position: Xyz;
    /** Total retreat from the start plane (mm). */
    liftTotalMm: number;
    lifts: { x: number; y: number; z: number; liftMm: number }[];
    steps: number;
    toppedOut: boolean;
}

/**
 * Touch-probing traverse from `from` to `to` (see the file header). Both are
 * full machine points; the traverse direction is `to - from`. The
 * expected-contact set includes 'probe' while it runs and is cleared on
 * return. Returns the arrival position, which lies on the line through `to`
 * along retreatUnit.
 */
export async function steppedTraverse(
    tag: string,
    name: string,
    from: Xyz,
    to: Xyz,
    params: SteppedTraverseParams,
    announce: Announce
): Promise<SteppedTraverseResult> {
    const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    const length = Math.hypot(d.x, d.y, d.z);
    const lifts: SteppedTraverseResult['lifts'] = [];
    let liftTotal = 0;
    let steps = 0;
    if (length < 1e-9) {
        return { position: { ...to }, liftTotalMm: 0, lifts, steps, toppedOut: false };
    }
    const u = { x: d.x / length, y: d.y / length, z: d.z / length };
    const ru = params.retreatUnit;
    const at = (s: number): Xyz => ({
        x: r3(from.x + u.x * s + ru.x * liftTotal),
        y: r3(from.y + u.y * s + ru.y * liftTotal),
        z: r3(from.z + u.z * s + ru.z * liftTotal),
    });
    const words = (p: Xyz) => {
        const w: { x?: number; y?: number; z?: number } = {};
        if (Math.abs(u.x) > 1e-9 || Math.abs(ru.x) > 1e-9) {
            w.x = p.x;
        }
        if (Math.abs(u.y) > 1e-9 || Math.abs(ru.y) > 1e-9) {
            w.y = p.y;
        }
        if (Math.abs(u.z) > 1e-9 || Math.abs(ru.z) > 1e-9) {
            w.z = p.z;
        }
        return w;
    };
    const maxLifts = params.maxLifts ?? 60;
    let liftingStopped = false;
    probeFeedService.setExpectedContact(['probe']);
    try {
        let s = 0;
        while (length - s > 1e-9) {
            const next = Math.min(s + STEPPED_HOP_STEP_MM, length);
            const p = at(next);
            const t0 = Date.now();
            await moveMachineSettled(`${tag}:hop:${name}`, words(p), STEPPED_HOP_FEED);
            steps += 1;
            const sensed = await senseAfter('probe', t0, params.sensorDelayMs);
            if (!sensed.contact) {
                s = next;
                continue;
            }
            // The surface is closer here: back off one step, wait for the
            // release, retreat, try the same step again.
            const back = at(s);
            const t1 = Date.now();
            await moveMachineSettled(`${tag}:hop-back:${name}`, words(back), STEPPED_HOP_FEED);
            const released = await senseReleaseAfter('probe', t1, Math.max(params.sensorDelayMs * 4, 3500));
            if (released.contact) {
                throw new ProcedureAbort(`Stepped traverse "${name}": probe still triggered after backing off ${STEPPED_HOP_STEP_MM} mm `
                    + `at (${back.x}, ${back.y}, ${back.z}).`);
            }
            if (liftingStopped) {
                throw new ProcedureAbort(`Stepped traverse "${name}": contact at (${p.x}, ${p.y}, ${p.z}) with the retreat already at its cap `
                    + `${params.maxLiftTotalMm} mm - something stands where the approved plan has empty space.`);
            }
            if (lifts.length >= maxLifts) {
                throw new ProcedureAbort(`Stepped traverse "${name}": ${maxLifts} retreats without clearing the surface - stopping.`);
            }
            const lift = Math.min(params.liftMm, params.maxLiftTotalMm - liftTotal);
            if (lift <= 1e-9) {
                liftingStopped = true;
                if (params.onMax === 'plain-move') {
                    probeFeedService.clearExpectedContact();
                    await moveMachineSettled(`${tag}:hop-top:${name}`, words(at(length)), TRAVEL_FEED);
                    return { position: at(length), liftTotalMm: r3(liftTotal), lifts, steps, toppedOut: true };
                }
                throw new ProcedureAbort(`Stepped traverse "${name}": contact at (${p.x}, ${p.y}, ${p.z}) with no retreat left (cap ${params.maxLiftTotalMm} mm).`);
            }
            liftTotal = r3(liftTotal + lift);
            lifts.push({ x: p.x, y: p.y, z: p.z, liftMm: r3(lift) });
            const lifted = at(s);
            announce(`hop-lift-${name}`, `surface closer at (${p.x}, ${p.y}, ${p.z}): retreat ${r3(lift)} mm (total ${liftTotal})`);
            await moveMachineSettled(`${tag}:hop-lift:${name}`, words(lifted), TRAVEL_FEED);
            if (liftTotal >= params.maxLiftTotalMm - 1e-9) {
                if (params.onMax === 'plain-move') {
                    // At the traverse height nothing can be in the way (law 2).
                    probeFeedService.clearExpectedContact();
                    await moveMachineSettled(`${tag}:hop-top:${name}`, words(at(length)), TRAVEL_FEED);
                    return { position: at(length), liftTotalMm: liftTotal, lifts, steps, toppedOut: true };
                }
                liftingStopped = true;
            }
        }
        return { position: at(length), liftTotalMm: liftTotal, lifts, steps, toppedOut: liftingStopped };
    } finally {
        probeFeedService.clearExpectedContact();
    }
}

/** Convenience for travel over a top: horizontal from -> to at toolhead Z `z`, lifting toward the traverse height on contact. */
export async function steppedTraverseZ(
    tag: string,
    name: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    z: number,
    params: { liftMm: number; maxZ: number; sensorDelayMs: number },
    announce: Announce
): Promise<{ z: number; lifts: SteppedTraverseResult['lifts']; steps: number; toppedOut: boolean }> {
    const result = await steppedTraverse(tag, name, { x: from.x, y: from.y, z }, { x: to.x, y: to.y, z }, {
        retreatUnit: { x: 0, y: 0, z: 1 },
        liftMm: params.liftMm,
        maxLiftTotalMm: Math.max(0, r3(params.maxZ - z)),
        onMax: 'plain-move',
        sensorDelayMs: params.sensorDelayMs,
    }, announce);
    return { z: result.position.z, lifts: result.lifts, steps: result.steps, toppedOut: result.toppedOut };
}
