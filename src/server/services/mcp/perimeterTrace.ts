/* eslint-disable camelcase */
// confirm_at values and the wall side are MCP tool argument vocabulary (snake_case).
//
// The unknown-pocket PERIMETER TRACER (operator spec, 2026-09-22 01:25 BST):
// "a survey of the corners and all the internal walls of the pocket, ideally
// just doing 0.1 millimeter bumping in the corners (or where non-straight
// paths / deviations are detected) so there's no retreat wastage, except
// when it encounters an inability to step forwards, in which case it should
// change the approach angle and try 0.1 mm in that direction after
// retreating back the 0.1 mm it had attempted when making unexpected
// contact."
//
// The crawl, in TIP-CENTRE space, with the probe EXPECTED on every move:
//   0. (runner) law 2 to the start, a point KNOWN to be inside the pocket;
//      march `dir` to the first wall; back off bump_mm along the normal.
//   1. Step fine_step along the tangent (the normal turned so the wall stays
//      on the chosen side, default the RIGHT - right hand on the wall walks
//      an internal perimeter counter-clockwise).
//   2. Tangent step CONTACTS -> retreat exactly the attempted step along its
//      reverse, turn the tangent AWAY from the wall by turn_step, try again
//      (internal corners and inward curves at fine resolution). A full 360
//      of failed turns aborts.
//   3. Tangent step is FREE -> bump toward the wall along the inward normal
//      in fine steps until contact (cap bump_cap_steps); the contact is a
//      perimeter point and the head backs off the one step that touched. If
//      the wall has fallen away past the cap, turn the tangent TOWARD the
//      wall by turn_step (outward curves, external corners).
//   4. Straightness: a running total-least-squares line over the last
//      straight_points contacts; while its max residual is under
//      line_tolerance the tangent step is coarse_step; back to fine_step the
//      moment a step contacts, a bump needs more than one step or the
//      residual grows.
//   5. Closure: heading turned 360 and the tip centre within one coarse step
//      of the first wall point. Otherwise the crawl STOPS (partial polyline,
//      clear ending) on the perimeter budget, max_steps, the bounds or a
//      keep-out.
//   Confirm cycles (lift-and-retest, the expensive part) only where they buy
//   accuracy (operator addendum): the FIRST wall contact, the contact after
//   a MAJOR direction change, any UNEXPECTED contact, and optional accuracy
//   points EVERY accuracy_every_mm. A routine bump is one sensed contact.
//
// Pure: no server imports. The runner (probeTracePerimeter.ts) binds the IO
// to the engine; tests run it on a synthetic pocket (tests/perimeterTrace.test.ts).

import { CircleFit, fitCircle } from './cornerFit';
import { ProcedureAbort, isProcedureAbort } from './procedureAbort';
import { WallLineFit, Xy, fitWallLine } from './wallFollow';

const r3 = (v: number) => Number(v.toFixed(3));

export type ConfirmAt = 'first' | 'turns' | 'unexpected' | 'every';
export const CONFIRM_AT_VALUES: ConfirmAt[] = ['first', 'turns', 'unexpected', 'every'];
export type WallSide = 'right' | 'left';

export interface TraceBounds {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** What the crawl needs from the machine. Every move runs with the probe EXPECTED; a stop request or a fault throws. */
export interface TraceIo {
    /** Sensor-checked move to `p` at the crawl feed; true = contact sensed. The head is AT `p` afterwards (the probe deflected if it touched). */
    step(p: Xy): Promise<boolean>;
    /** Plain move to a point already proven free (a retreat along the path just travelled). */
    move(p: Xy): Promise<void>;
    /** The initial sensor-gated march (coarse / release / fine / confirm) from `from` along `unit` up to `travelMm`; the head ends AT the contact. */
    march(from: Xy, unit: Xy, travelMm: number): Promise<{ point: Xy; spreadMm: number } | null>;
    /**
     * A lift-and-retest confirm cycle from the free point `from` along `unit`
     * (a few fine steps of travel); the head ends AT the refined contact.
     * `{ stuck: true }` when the cycle ended with the probe still reading
     * contact after its own retreat to `from` (T8: a rub, not a fault - the
     * crawl retreats along the normal and carries on unconfirmed).
     */
    confirm(from: Xy, unit: Xy, travelMm: number): Promise<ConfirmOutcome>;
    /** Wait out the release window: true when the probe reads RELEASED where the head stands. */
    released(): Promise<boolean>;
}

export type ConfirmOutcome = { point: Xy; spreadMm: number } | { stuck: true } | null;

export function isStuck(outcome: ConfirmOutcome): outcome is { stuck: true } {
    return !!outcome && (outcome as { stuck?: unknown }).stuck === true;
}

export interface TraceParams {
    fineStepMm: number;
    coarseStepMm: number;
    turnStepDeg: number;
    bumpMm: number;
    /** Fine steps toward the wall before "the wall has fallen away". */
    bumpCapSteps: number;
    lineToleranceMm: number;
    /** Contacts the straightness line is fitted over. */
    straightPoints: number;
    maxPerimeterMm: number;
    maxSteps: number;
    bounds: TraceBounds;
    /** Keep-out boxes (machine XY) the tip centre may not enter at the crawl height. */
    keepOut: (TraceBounds & { name: string })[];
    wallSide: WallSide;
    confirmAt: Set<ConfirmAt>;
    accuracyEveryMm: number | null;
    /** Accumulated turn since the last confirm above this = a major direction change. */
    majorTurnDeg: number;
    tipRadiusMm: number | null;
    /** Travel of a confirm cycle beyond the free point (fine steps). */
    confirmTravelMm: number;
}

/**
 * first = the march; bump = a normal bump contact; tangent-contact = a
 * blocked step (a corner); rub = a graze along the wall whose retreat did not
 * release the probe (the wall came to the tip).
 */
export type TracePointKind = 'first' | 'bump' | 'tangent-contact' | 'rub';

export interface TracePoint {
    index: number;
    /** Tip-centre contact (machine XY at the crawl Z). */
    tipCentre: Xy;
    /** tipCentre + tip radius INTO the material; null without a stored tip. */
    surface: Xy | null;
    /** Unit normal INTO the material at the contact. */
    normal: Xy;
    kind: TracePointKind;
    /** True when a lift-and-retest cycle refined this point (spreadMm then holds its spread). */
    confirmed: boolean;
    spreadMm: number | null;
    /** Perimeter length walked when the point was taken. */
    alongMm: number;
    /** Tangent step in force when it was taken. */
    stepMm: number;
}

/** 'aborted' travels on a ProcedureAbort's `partial`: the perimeter so far is never lost. */
export type TraceEndingKind = 'closed' | 'budget' | 'max-steps' | 'bounds' | 'keep-out' | 'aborted';

export interface TraceCounts {
    fineSteps: number;
    coarseSteps: number;
    bumps: number;
    turns: number;
    retreats: number;
    confirms: number;
    /** Confirm cycles that ended with the probe still triggered and were skipped (a rub, not a fault). */
    confirmsSkipped: number;
    tangentContacts: number;
    /** Tangent steps whose retreat did not release the probe: the wall came to the tip; the standoff was repaired. */
    rubs: number;
    /** Fine retreat steps made to reach a RELEASED reading after contacts. */
    releaseSteps: number;
}

/** A zero count set - the crawl's own, and the empty result an abort before the crawl reports. */
export function emptyTraceCounts(): TraceCounts {
    return {
        fineSteps: 0,
        coarseSteps: 0,
        bumps: 0,
        turns: 0,
        retreats: 0,
        confirms: 0,
        confirmsSkipped: 0,
        tangentContacts: 0,
        rubs: 0,
        releaseSteps: 0,
    };
}

export interface TraceResult {
    perimeter: TracePoint[];
    closed: boolean;
    ending: { kind: TraceEndingKind; note: string };
    lengthMm: number;
    headingTurnDeg: number;
    counts: TraceCounts;
    /** Where the head is at the end (free point, crawl Z). */
    position: Xy;
    /** The measured first wall (null only when the first march found nothing). */
    firstWall: { point: Xy; spreadMm: number } | null;
    /** The release-verified standoff in force at the end: how far the tip centre parks off the last contact. */
    standoffMm: number;
}

export function rotate(v: Xy, deg: number): Xy {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // `|| 0` turns a -0 into 0 so deepEqual and text never show "-0".
    return { x: r3(v.x * c - v.y * s) || 0, y: r3(v.x * s + v.y * c) || 0 };
}

/** Signed angle from `a` to `b` in degrees (counter-clockwise positive). */
export function turnBetween(a: Xy, b: Xy): number {
    return r3((Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180) / Math.PI);
}

/** The tangent for a wall on `side`: right-hand wall -> the tangent is the inward normal turned +90 (counter-clockwise). */
export function tangentFor(normalIn: Xy, side: WallSide): Xy {
    return rotate(normalIn, side === 'right' ? 90 : -90);
}

export function normalFor(tangent: Xy, side: WallSide): Xy {
    return rotate(tangent, side === 'right' ? -90 : 90);
}

export function insideBounds(p: Xy, b: TraceBounds): boolean {
    return p.x >= Math.min(b.x0, b.x1) && p.x <= Math.max(b.x0, b.x1) && p.y >= Math.min(b.y0, b.y1) && p.y <= Math.max(b.y0, b.y1);
}

function inKeepOut(p: Xy, boxes: TraceParams['keepOut']): string | null {
    const hit = boxes.find((b) => insideBounds(p, b));
    return hit ? hit.name : null;
}

const dist = (a: Xy, b: Xy) => Math.hypot(a.x - b.x, a.y - b.y);

class TraceStop {
    public readonly kind: TraceEndingKind;

    public readonly note: string;

    public constructor(kind: TraceEndingKind, note: string) {
        this.kind = kind;
        this.note = note;
    }
}

/**
 * Run the crawl. Throws ProcedureAbort - with the partial TraceResult attached
 * as `partial` (ending kind 'aborted') - when no wall is found from the
 * start, when a full turn of tangent steps all contact (the tip is boxed in)
 * or when the probe stays triggered after retreating to the last point known
 * free; every other ending is returned with the partial perimeter.
 */
export async function tracePerimeter(
    io: TraceIo,
    start: Xy,
    dir: Xy,
    maxTravelMm: number,
    params: TraceParams,
    announce: (phase: string, note?: string) => void
): Promise<TraceResult> {
    const p = params;
    const counts: TraceCounts = emptyTraceCounts();
    const perimeter: TracePoint[] = [];
    const surfaceOf = (tip: Xy, n: Xy): Xy | null => (p.tipRadiusMm === null
        ? null
        : { x: r3(tip.x + n.x * p.tipRadiusMm), y: r3(tip.y + n.y * p.tipRadiusMm) });
    // The perimeter LENGTH is measured from the CONTACTS, along a polyline
    // that only moves its anchor on once the next contact is two fine steps
    // away. A sum of the tangent steps under-read a lap by a tenth - the
    // standoff re-references the head to each new contact, so a curve is
    // partly walked by the bumps, not by the steps - and the raw contact-to-
    // contact polyline over-read it by 5 %, because the contacts sit on the
    // fine-step grid and zig-zag a step across it. The budget, the closure and
    // the confirm cadence all use this length.
    let length = 0;
    let sinceAccuracy = 0;
    let sinceTurnMm = 0;
    let anchor: Xy | null = null;
    const record = (tip: Xy, n: Xy, kind: TracePointKind, confirmed: boolean, spread: number | null, stepMm: number) => {
        if (!anchor) {
            anchor = tip;
        } else {
            const d = dist(anchor, tip);
            if (d >= 2 * p.fineStepMm - 1e-9) {
                length += d;
                sinceAccuracy += d;
                sinceTurnMm += d;
                anchor = tip;
            }
        }
        perimeter.push({
            index: perimeter.length, tipCentre: tip, surface: surfaceOf(tip, n), normal: n, kind, confirmed, spreadMm: spread, alongMm: r3(length), stepMm,
        });
    };
    let n: Xy = { x: r3(dir.x), y: r3(dir.y) };
    let t = tangentFor(n, p.wallSide);
    let pos: Xy = { ...start };
    let firstWall: { point: Xy; spreadMm: number } | null = null;
    let heading = 0;
    let standoffSteps = 0;

    const result = (ending: { kind: TraceEndingKind; note: string }): TraceResult => ({
        perimeter,
        closed: ending.kind === 'closed',
        ending,
        lengthMm: r3(length),
        headingTurnDeg: r3(heading),
        counts,
        position: pos,
        firstWall,
        standoffMm: r3(standoffSteps * p.fineStepMm),
    });
    const abort = (message: string): ProcedureAbort => new ProcedureAbort(message, result({ kind: 'aborted', note: message }));

    // ---- first wall (the normal coarse / release / fine / confirm march)
    const first = await io.march(start, dir, maxTravelMm);
    if (!first) {
        throw abort(`No wall within ${maxTravelMm} mm of the start along (${dir.x}, ${dir.y}) - the start is not inside a pocket this size, or dir points along it.`);
    }
    firstWall = first;
    counts.confirms += 1; // the march's own confirm cycles
    record(first.point, n, 'first', true, first.spreadMm, p.fineStepMm);
    pos = first.point;

    /**
     * RELEASE-VERIFIED STANDOFF (T8, job 8088e3a6aff5): parking one bump step
     * off the contact coordinate left the tip 0.05 mm inside a wavy wooden
     * wall, and the next advance rubbed. From the contact, retreat along the
     * inward normal one fine step at a time until the probe READS released,
     * then one more; `knownFreeSteps` says how many steps back the last point
     * known free lies - staying triggered one step past it is a fault, and
     * the message states the retreat actually made.
     */
    const standOff = async (from: Xy, knownFreeSteps: number, what: string): Promise<void> => {
        const cap = knownFreeSteps + 1;
        for (let k = 1; k <= cap; k++) {
            pos = { x: r3(from.x - n.x * p.fineStepMm * k), y: r3(from.y - n.y * p.fineStepMm * k) };
            await io.move(pos);
            counts.retreats += 1;
            counts.releaseSteps += 1;
            if (await io.released()) {
                pos = { x: r3(from.x - n.x * p.fineStepMm * (k + 1)), y: r3(from.y - n.y * p.fineStepMm * (k + 1)) };
                await io.move(pos);
                counts.retreats += 1;
                standoffSteps = k + 1;
                return;
            }
        }
        throw abort(`${what}: the probe still reads triggered after retreating ${r3(cap * p.fineStepMm)} mm along (${r3(-n.x)}, ${r3(-n.y)}) from the contact at `
            + `(${from.x}, ${from.y}) - one fine step past the last point known free. A stuck probe or feed fault, or the wall moved. `
            + 'Recovery: raise straight up (move_z to the traverse height); the tip is at most one fine step into the wall.');
    };
    await standOff(first.point, p.bumpCapSteps, 'first wall');
    announce('first-wall', `(${first.point.x}, ${first.point.y}) spread ${first.spreadMm}; standoff ${r3(standoffSteps * p.fineStepMm)} mm; crawling with the wall on the ${p.wallSide}`);

    let turnedWithoutProgress = 0;
    let turnSinceConfirm = 0;
    // sinceTurnMm (above): perimeter walked since the last turn - a block or a
    // receding wall after a long straight run is a NEW feature (unexpected,
    // worth a confirm cycle); the same event a few steps after a turn is the
    // crawl following the curve it is already in.
    let steps = 0;
    let straight = false;
    // The straightness window spans straightPoints coarse steps of perimeter:
    // six fine points span 0.6 mm and an R5 arc is "straight" over that.
    const straightSpanMm = p.straightPoints * p.coarseStepMm;
    let recent: { q: Xy; along: number }[] = [{ q: first.point, along: 0 }];
    const awaySign = p.wallSide === 'right' ? 1 : -1;
    let ending: { kind: TraceEndingKind; note: string } | null = null;

    const checkPlace = (q: Xy): void => {
        if (!insideBounds(q, p.bounds)) {
            throw new TraceStop('bounds', `the next step (${q.x}, ${q.y}) would leave the bounds X ${p.bounds.x0}..${p.bounds.x1} Y ${p.bounds.y0}..${p.bounds.y1}`);
        }
        const ko = inKeepOut(q, p.keepOut);
        if (ko) {
            throw new TraceStop('keep-out', `the next step (${q.x}, ${q.y}) would enter keep-out "${ko}"`);
        }
    };

    /**
     * A lift-and-retest cycle from the free point `from` along `unit`. A
     * cycle that ends with the probe stuck is NOT a fault by itself (T8: the
     * "stuck probe" was a rub on wavy wood): the head retreats along the
     * inward normal until released, the point stays unconfirmed, the crawl
     * goes on; only a retreat that never releases aborts.
     */
    const confirmCycle = async (from: Xy, unit: Xy, contact: Xy): Promise<{ point: Xy; spreadMm: number } | null> => {
        counts.confirms += 1;
        const outcome = await io.confirm(from, unit, p.confirmTravelMm);
        if (isStuck(outcome)) {
            counts.confirms -= 1;
            counts.confirmsSkipped += 1;
            announce('confirm-skipped', `confirm cycle at (${from.x}, ${from.y}) ended with the probe still triggered - a rub, not a fault: retreating to a released standoff`);
            await standOff(contact, p.bumpCapSteps + standoffSteps, 'confirm cycle');
            return null;
        }
        await io.move(from);
        counts.retreats += 1;
        pos = from;
        turnSinceConfirm = 0;
        sinceAccuracy = 0;
        return outcome;
    };

    const wantsConfirm = (unexpected: boolean): boolean => {
        if (unexpected && p.confirmAt.has('unexpected')) {
            return true;
        }
        if (p.confirmAt.has('turns') && turnSinceConfirm >= p.majorTurnDeg - 1e-9) {
            return true;
        }
        if (p.confirmAt.has('every') && p.accuracyEveryMm !== null && sinceAccuracy >= p.accuracyEveryMm - 1e-9) {
            return true;
        }
        return false;
    };

    try {
        for (;;) {
            if (steps >= p.maxSteps) {
                throw new TraceStop('max-steps', `${p.maxSteps} steps taken`);
            }
            if (length >= p.maxPerimeterMm - 1e-9) {
                throw new TraceStop('budget', `${r3(length)} mm of perimeter walked (max_perimeter_mm ${p.maxPerimeterMm})`);
            }
            const stepMm = straight ? p.coarseStepMm : p.fineStepMm;
            const q: Xy = { x: r3(pos.x + t.x * stepMm), y: r3(pos.y + t.y * stepMm) };
            checkPlace(q);
            steps += 1;
            const hit = await io.step(q);
            if (hit) {
                // Retreat exactly the attempted step. If the probe still reads
                // triggered there, this was a RUB - the wall came to us along
                // the tangent (wavy wood) - not a block: repair the standoff
                // along the normal and carry on; a block is a contact from
                // which the retreat releases.
                const before = pos;
                await io.move(before);
                counts.retreats += 1;
                if (!(await io.released())) {
                    counts.rubs += 1;
                    record(q, n, 'rub', false, null, stepMm);
                    await standOff(before, standoffSteps + p.bumpCapSteps, 'rub along the wall');
                    straight = false;
                    recent = [];
                    continue;
                }
                // Blocked ahead: turn away from the wall, try again. The FIRST
                // block after free progress is the unexpected event (a corner
                // begins); the turns inside the corner are the crawl at work.
                counts.tangentContacts += 1;
                let refined: { point: Xy; spreadMm: number } | null = null;
                if (wantsConfirm(sinceTurnMm >= straightSpanMm - 1e-9)) {
                    refined = await confirmCycle(before, t, q);
                }
                record(refined ? refined.point : q, t, 'tangent-contact', !!refined, refined ? refined.spreadMm : null, stepMm);
                t = rotate(t, awaySign * p.turnStepDeg);
                n = normalFor(t, p.wallSide);
                heading += awaySign * p.turnStepDeg;
                turnedWithoutProgress += p.turnStepDeg;
                turnSinceConfirm += p.turnStepDeg;
                sinceTurnMm = 0;
                counts.turns += 1;
                straight = false;
                recent = [];
                if (turnedWithoutProgress >= 360 - 1e-9) {
                    throw abort(`Boxed in at (${pos.x}, ${pos.y}): a full turn of ${p.fineStepMm} mm steps all met material.`);
                }
                continue;
            }
            // Free: advance.
            if (straight) {
                counts.coarseSteps += 1;
            } else {
                counts.fineSteps += 1;
            }
            pos = q;
            turnedWithoutProgress = 0;

            // Bump toward the wall in fine steps until contact. The wall is
            // expected standoffSteps away; bumpCapSteps beyond that it has
            // fallen away.
            let contactAt: Xy | null = null;
            let bumpsNeeded = 0;
            let free = pos;
            const bumpCap = standoffSteps + p.bumpCapSteps;
            for (let k = 1; k <= bumpCap; k++) {
                const b: Xy = { x: r3(pos.x + n.x * p.fineStepMm * k), y: r3(pos.y + n.y * p.fineStepMm * k) };
                checkPlace(b);
                counts.bumps += 1;
                steps += 1;
                if (await io.step(b)) {
                    contactAt = b;
                    bumpsNeeded = k;
                    break;
                }
                free = b;
            }
            if (contactAt) {
                // The wall is expected standoffSteps away: FURTHER than that and
                // it has receded (an outward curve) - not straight any more.
                // Nearer is the normal state, not an event: the standoff is a
                // floor (the step that released plus one), the crawl crabs a
                // little, and a wall that keeps coming blocks the advance,
                // which is what turns the crawl. Calling "nearer" a curve
                // suppressed the straight runs entirely and with them the
                // re-alignment onto the fitted wall, so the crawl crabbed 40
                // deg off a straight wall for its whole length.
                const receded = bumpsNeeded > standoffSteps + 1;
                const unexpected = receded && sinceTurnMm >= straightSpanMm - 1e-9;
                let refined: { point: Xy; spreadMm: number } | null = null;
                await standOff(contactAt, bumpsNeeded, 'bump');
                if (wantsConfirm(unexpected)) {
                    refined = await confirmCycle(pos, n, contactAt);
                }
                const tip = refined ? refined.point : contactAt;
                record(tip, n, 'bump', !!refined, refined ? refined.spreadMm : null, stepMm);
                recent.push({ q: tip, along: length });
                // Keep the ONE entry that still spans the window: dropping
                // every entry older than the cut-off left recent[0] inside it,
                // so "the window is straightSpanMm long" could never be true
                // once the contact-to-contact spacing stopped being exactly
                // the step (it stopped when length became the polyline through
                // the contacts), and no straight run was ever declared.
                while (recent.length > 1 && recent[1].along <= length - straightSpanMm + 1e-9) {
                    recent.shift();
                }
                if (receded) {
                    straight = false;
                    recent = [{ q: tip, along: length }];
                } else if (recent.length >= p.straightPoints && length - recent[0].along >= straightSpanMm - 1e-9) {
                    const fit: WallLineFit | null = fitWallLine(recent.map((e) => e.q), n, t);
                    straight = !!fit && fit.maxAbsMm <= p.lineToleranceMm + 1e-9;
                    if (straight && fit) {
                        // Align the crawl with the wall it has proven straight:
                        // the quantised tangent may sit a turn step off it.
                        const aligned = fit.direction.x * t.x + fit.direction.y * t.y >= 0
                            ? fit.direction
                            : { x: -fit.direction.x, y: -fit.direction.y };
                        heading += turnBetween(t, aligned);
                        t = { x: r3(aligned.x) || 0, y: r3(aligned.y) || 0 };
                        n = normalFor(t, p.wallSide);
                    }
                } else {
                    straight = false;
                }
            } else {
                // The wall fell away: stand where the bumps ended and turn toward it.
                pos = free;
                t = rotate(t, -awaySign * p.turnStepDeg);
                n = normalFor(t, p.wallSide);
                heading -= awaySign * p.turnStepDeg;
                turnSinceConfirm += p.turnStepDeg;
                sinceTurnMm = 0;
                counts.turns += 1;
                straight = false;
                recent = [];
            }

            // Closure: a full turn of heading (within one turn step - the re-alignments onto fitted walls are
            // not quantised) and back within a coarse step plus the standoff of the first wall point.
            if (Math.abs(heading) >= 360 - p.turnStepDeg - 1e-6 && length > 2 * p.coarseStepMm
                && dist(pos, first.point) <= p.coarseStepMm + standoffSteps * p.fineStepMm + 1e-9) {
                ending = { kind: 'closed', note: `perimeter closed after ${r3(length)} mm, heading turned ${r3(heading)} deg` };
                break;
            }
        }
    } catch (err) {
        if (err instanceof TraceStop) {
            ending = { kind: err.kind, note: err.note };
        } else {
            // A fault from the machine (a stop request, an engine abort): the
            // perimeter so far travels with it - never lost on the abort path.
            if (isProcedureAbort(err) && !err.partial) {
                err.partial = result({ kind: 'aborted', note: err.message });
            }
            throw err;
        }
    }
    const end = ending || { kind: 'budget' as TraceEndingKind, note: 'stopped' };
    announce(`trace-${end.kind}`, `${end.note}; ${perimeter.length} point(s), ${counts.confirms} confirm cycle(s), ${counts.rubs} rub(s)`);
    return result(end);
}

// ---------------------------------------------------------------- segmentation

export type PerimeterSegment =
    | { kind: 'line'; from: number; to: number; fit: WallLineFit; lengthMm: number }
    | { kind: 'arc'; from: number; to: number; fit: CircleFit | null; points: number };

export interface PerimeterCorner {
    /** Perimeter point indices of the arc between two lines. */
    from: number;
    to: number;
    radiusTipCentreMm: number | null;
    radiusPhysicalMm: number | null;
    center: Xy | null;
    maxResidualMm: number | null;
    /** Interior angle between the two straight walls the arc joins (degrees). */
    interiorAngleDeg: number | null;
}

function residualFrom(fit: WallLineFit, q: Xy): number {
    return (q.x - fit.point.x) * fit.normal.x + (q.y - fit.point.y) * fit.normal.y;
}

/** Grow a straight run from `i`: each candidate is judged against the line fitted WITHOUT it, then the line is refitted. */
function growLineFrom(points: Xy[], i: number, tolMm: number): { to: number; fit: WallLineFit | null } {
    const accepted = [i];
    let fit: WallLineFit | null = null;
    let j = i + 1;
    while (j < points.length) {
        if (accepted.length >= 2 && fit && Math.abs(residualFrom(fit, points[j])) > tolMm + 1e-9) {
            break;
        }
        const trial = fitWallLine([...accepted, j].map((k) => points[k]), { x: 0, y: 0 });
        if (accepted.length >= 2 && (!trial || trial.maxAbsMm > tolMm + 1e-9)) {
            break;
        }
        accepted.push(j);
        fit = trial;
        j += 1;
    }
    return { to: accepted[accepted.length - 1], fit };
}

function chordLength(points: Xy[], from: number, to: number): number {
    return Math.hypot(points[to].x - points[from].x, points[to].y - points[from].y);
}

function cornersOf(segments: PerimeterSegment[], tipRadiusMm: number | null): PerimeterCorner[] {
    const corners: PerimeterCorner[] = [];
    for (let s = 0; s < segments.length; s++) {
        const seg = segments[s];
        if (seg.kind !== 'arc') {
            continue;
        }
        const before = s > 0 && segments[s - 1].kind === 'line' ? segments[s - 1] : null;
        const after = s + 1 < segments.length && segments[s + 1].kind === 'line' ? segments[s + 1] : null;
        let interior: number | null = null;
        if (before && after && before.kind === 'line' && after.kind === 'line') {
            const dot = Math.max(-1, Math.min(1, -(before.fit.normal.x * after.fit.normal.x + before.fit.normal.y * after.fit.normal.y)));
            interior = r3((Math.acos(dot) * 180) / Math.PI);
        }
        corners.push({
            from: seg.from,
            to: seg.to,
            radiusTipCentreMm: seg.fit ? seg.fit.radius : null,
            radiusPhysicalMm: seg.fit && tipRadiusMm !== null ? r3(seg.fit.radius + tipRadiusMm) : null,
            center: seg.fit ? seg.fit.center : null,
            maxResidualMm: seg.fit ? seg.fit.maxResidual : null,
            interiorAngleDeg: interior,
        });
    }
    return corners;
}

/**
 * Split an ordered perimeter into straight walls and the curves between
 * them. A wall is a run of >= minLinePoints contacts, at least
 * minLineLengthMm long (an arc sampled every fraction of a millimetre is
 * locally straight, so a short run is part of the curve around it), whose
 * residuals from the running line stay under tolMm - each candidate judged
 * against the line WITHOUT it. Each wall is then extended over the
 * neighbouring points the greedy split left behind, as far as they stay on
 * its line. Everything between two walls is a curve, fitted with a circle,
 * including the tangent point at each end. Corners are the curves between
 * two walls, with the interior angle of those walls. Pure.
 */
export function segmentPerimeter(
    points: Xy[],
    tolMm: number,
    minLinePoints: number = 4,
    tipRadiusMm: number | null = null,
    minLineLengthMm: number = 4
): {
    segments: PerimeterSegment[];
    corners: PerimeterCorner[];
} {
    const n = points.length;
    const lines: { from: number; to: number; fit: WallLineFit }[] = [];
    let i = 0;
    while (i < n) {
        const grown = growLineFrom(points, i, tolMm);
        if (grown.fit && grown.to - i + 1 >= minLinePoints && chordLength(points, i, grown.to) >= minLineLengthMm - 1e-9) {
            lines.push({ from: i, to: grown.to, fit: grown.fit });
            i = grown.to + 1;
        } else {
            i += 1;
        }
    }
    for (let k = 0; k < lines.length; k++) {
        const line = lines[k];
        const prevTo = k > 0 ? lines[k - 1].to : -1;
        const nextFrom = k + 1 < lines.length ? lines[k + 1].from : n;
        while (line.from - 1 > prevTo && Math.abs(residualFrom(line.fit, points[line.from - 1])) <= tolMm + 1e-9) {
            line.from -= 1;
        }
        while (line.to + 1 < nextFrom && Math.abs(residualFrom(line.fit, points[line.to + 1])) <= tolMm + 1e-9) {
            line.to += 1;
        }
        const refit = fitWallLine(points.slice(line.from, line.to + 1), { x: 0, y: 0 });
        if (refit) {
            line.fit = refit;
        }
    }
    const segments: PerimeterSegment[] = [];
    const pushCurve = (from: number, to: number) => {
        const a = Math.max(0, from);
        const b = Math.min(n - 1, to);
        if (b < a) {
            return;
        }
        const pts = points.slice(a, b + 1);
        segments.push({ kind: 'arc', from: a, to: b, fit: pts.length >= 3 ? fitCircle(pts) : null, points: pts.length });
    };
    let cursor = 0;
    for (const line of lines) {
        if (line.from > cursor) {
            pushCurve(cursor - 1, line.from);
        }
        segments.push({ kind: 'line', from: line.from, to: line.to, fit: line.fit, lengthMm: r3(chordLength(points, line.from, line.to)) });
        cursor = line.to + 1;
    }
    if (cursor < n) {
        pushCurve(cursor - 1, n - 1);
    }
    return { segments, corners: cornersOf(segments, tipRadiusMm) };
}

// ---------------------------------------------------------------- estimate

/**
 * Wall-clock estimate for the confirm page, from T8 (job 8088e3a6aff5,
 * 2026-09-22, GPIO, sensor_delay 50): one crawl cycle - advance, bump,
 * retreat, three settled batches at ~0.27 s of fixed overhead each - took
 * 0.90 s, i.e. 9.0 s per mm at 0.1 mm steps and 0.93 s per mm at 1 mm; the
 * first-wall march ran 0.33 s per 1 mm coarse step; a confirm cycle (3
 * passes) about 10 s. Worst case is the whole budget at fine steps; best
 * case coarse steps on every straight.
 */
export const TRACE_CYCLE_SECONDS = 0.9;
export const TRACE_MARCH_SECONDS_PER_MM = 0.33;
export const TRACE_CONFIRM_SECONDS = 10;

export interface TraceEstimateInput {
    maxPerimeterMm: number;
    fineStepMm: number;
    coarseStepMm: number;
    accuracyEveryMm: number | null;
    expectedCorners: number;
    /** The first-wall march travel (coarse 1 mm steps). */
    maxTravelMm?: number;
}

export function estimateTraceTime(p: TraceEstimateInput): {
    worstMinutes: number;
    bestMinutes: number;
    worstCycles: number;
    bestCycles: number;
    confirmCycles: number;
    approachSeconds: number;
} {
    const worstCycles = Math.ceil(p.maxPerimeterMm / p.fineStepMm);
    const bestCycles = Math.ceil(p.maxPerimeterMm / p.coarseStepMm);
    const confirmCycles = 1 + p.expectedCorners + (p.accuracyEveryMm ? Math.ceil(p.maxPerimeterMm / p.accuracyEveryMm) : 0);
    const confirmSeconds = confirmCycles * TRACE_CONFIRM_SECONDS;
    const approachSeconds = Math.round((p.maxTravelMm || 0) * TRACE_MARCH_SECONDS_PER_MM);
    return {
        worstCycles,
        bestCycles,
        confirmCycles,
        approachSeconds,
        worstMinutes: Math.round((worstCycles * TRACE_CYCLE_SECONDS + confirmSeconds + approachSeconds) / 60),
        bestMinutes: Math.round((bestCycles * TRACE_CYCLE_SECONDS + confirmSeconds + approachSeconds) / 60),
    };
}
