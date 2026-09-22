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
import { ProcedureAbort } from './procedureAbort';
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
    /** A lift-and-retest confirm cycle from the free point `from` along `unit` (a few fine steps of travel); the head ends AT the refined contact. */
    confirm(from: Xy, unit: Xy, travelMm: number): Promise<{ point: Xy; spreadMm: number } | null>;
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

export type TracePointKind = 'first' | 'bump' | 'tangent-contact';

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

export type TraceEndingKind = 'closed' | 'budget' | 'max-steps' | 'bounds' | 'keep-out';

export interface TraceCounts {
    fineSteps: number;
    coarseSteps: number;
    bumps: number;
    turns: number;
    retreats: number;
    confirms: number;
    tangentContacts: number;
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
    firstWall: { point: Xy; spreadMm: number };
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
 * Run the crawl. Throws ProcedureAbort when no wall is found from the start
 * or when a full turn of tangent steps all contact (the tip is boxed in);
 * every other ending is returned with the partial perimeter.
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
    const counts: TraceCounts = { fineSteps: 0, coarseSteps: 0, bumps: 0, turns: 0, retreats: 0, confirms: 0, tangentContacts: 0 };
    const perimeter: TracePoint[] = [];
    const surfaceOf = (tip: Xy, n: Xy): Xy | null => (p.tipRadiusMm === null
        ? null
        : { x: r3(tip.x + n.x * p.tipRadiusMm), y: r3(tip.y + n.y * p.tipRadiusMm) });
    const record = (tip: Xy, n: Xy, kind: TracePointKind, confirmed: boolean, spread: number | null, along: number, stepMm: number) => {
        perimeter.push({
            index: perimeter.length, tipCentre: tip, surface: surfaceOf(tip, n), normal: n, kind, confirmed, spreadMm: spread, alongMm: r3(along), stepMm,
        });
    };

    // ---- first wall
    const first = await io.march(start, dir, maxTravelMm);
    if (!first) {
        throw new ProcedureAbort(`No wall within ${maxTravelMm} mm of the start along (${dir.x}, ${dir.y}) - the start is not inside a pocket this size, or dir points along it.`);
    }
    counts.confirms += 1; // the march's own confirm cycles
    let n: Xy = { x: r3(dir.x), y: r3(dir.y) };
    let t = tangentFor(n, p.wallSide);
    record(first.point, n, 'first', true, first.spreadMm, 0, p.fineStepMm);
    // Back off bump_mm along the approach normal onto proven ground.
    let pos: Xy = { x: r3(first.point.x - n.x * p.bumpMm), y: r3(first.point.y - n.y * p.bumpMm) };
    await io.move(pos);
    counts.retreats += 1;
    announce('first-wall', `(${first.point.x}, ${first.point.y}) spread ${first.spreadMm}; crawling with the wall on the ${p.wallSide}`);

    let length = 0;
    let heading = 0;
    let turnedWithoutProgress = 0;
    let turnSinceConfirm = 0;
    let sinceAccuracy = 0;
    // Perimeter walked since the last turn: a block or a fallen-away wall
    // after a long straight run is a NEW feature (unexpected, worth a confirm
    // cycle); the same event a few steps after a turn is the crawl following
    // the curve it is already in.
    let sinceTurnMm = 0;
    let steps = 0;
    let straight = false;
    // The straightness window: the contacts of the last straightSpanMm of
    // perimeter. Six fine points span 0.6 mm and an R5 arc is "straight"
    // over that; the window has to be as long as the coarse steps it
    // licenses, so it spans straightPoints coarse steps.
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

    const confirmCycle = async (from: Xy, unit: Xy): Promise<{ point: Xy; spreadMm: number } | null> => {
        counts.confirms += 1;
        const refined = await io.confirm(from, unit, p.confirmTravelMm);
        await io.move(from);
        counts.retreats += 1;
        turnSinceConfirm = 0;
        sinceAccuracy = 0;
        return refined;
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
                // Blocked ahead: back exactly the attempted step, turn away from the wall, try again.
                // The FIRST blocked step after free progress is the unexpected event (a corner
                // begins); the turns that follow inside the same corner are the crawl doing its job.
                counts.tangentContacts += 1;
                await io.move(pos);
                counts.retreats += 1;
                let refined: { point: Xy; spreadMm: number } | null = null;
                if (wantsConfirm(sinceTurnMm >= straightSpanMm - 1e-9)) {
                    refined = await confirmCycle(pos, t);
                }
                record(refined ? refined.point : q, t, 'tangent-contact', !!refined, refined ? refined.spreadMm : null, length, stepMm);
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
                    throw new ProcedureAbort(`Boxed in at (${pos.x}, ${pos.y}): a full turn of ${p.fineStepMm} mm steps all met material.`);
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
            length += stepMm;
            sinceAccuracy += stepMm;
            sinceTurnMm += stepMm;
            turnedWithoutProgress = 0;

            // Bump toward the wall in fine steps until contact.
            let contactAt: Xy | null = null;
            let bumpsNeeded = 0;
            let free = pos;
            for (let k = 1; k <= p.bumpCapSteps; k++) {
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
                // Back off the one step that touched, onto the last free point
                // (the head is already there when the first bump touched).
                if (free.x !== contactAt.x || free.y !== contactAt.y) {
                    await io.move(free);
                    counts.retreats += 1;
                }
                pos = free;
                const unexpected = bumpsNeeded > 1 && sinceTurnMm >= straightSpanMm - 1e-9;
                let refined: { point: Xy; spreadMm: number } | null = null;
                if (wantsConfirm(unexpected)) {
                    refined = await confirmCycle(free, n);
                }
                const tip = refined ? refined.point : contactAt;
                record(tip, n, 'bump', !!refined, refined ? refined.spreadMm : null, length, stepMm);
                recent.push({ q: tip, along: length });
                while (recent.length && recent[0].along < length - straightSpanMm - 1e-9) {
                    recent.shift();
                }
                if (bumpsNeeded > 1) {
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

            // Closure: a full turn of heading and back within a coarse step of the first wall point.
            if (Math.abs(heading) >= 360 - 1e-6 && length > 2 * p.coarseStepMm && dist(pos, first.point) <= p.coarseStepMm + p.bumpMm + 1e-9) {
                ending = { kind: 'closed', note: `perimeter closed after ${r3(length)} mm, heading turned ${r3(heading)} deg` };
                break;
            }
        }
    } catch (err) {
        if (err instanceof TraceStop) {
            ending = { kind: err.kind, note: err.note };
        } else {
            throw err;
        }
    }
    const end = ending || { kind: 'budget' as TraceEndingKind, note: 'stopped' };
    announce(`trace-${end.kind}`, `${end.note}; ${perimeter.length} point(s), ${counts.confirms} confirm cycle(s)`);
    return {
        perimeter,
        closed: end.kind === 'closed',
        ending: end,
        lengthMm: r3(length),
        headingTurnDeg: r3(heading),
        counts,
        position: pos,
        firstWall: first,
    };
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
 * Wall-clock estimate for the confirm page. One sensor-checked step on the
 * GPIO transport (sensor_delay 50) took 0.25-0.35 s round trip on 2026-09-22
 * (jobs 15048f15286e, 9efe30367c60); a confirm cycle is the march's
 * release + fine + passes, ~8 s at the default passes. Worst case is the
 * whole budget at fine steps with a bump per step; best case coarse steps
 * on every straight.
 */
export const TRACE_STEP_SECONDS = 0.3;
export const TRACE_CONFIRM_SECONDS = 8;

export interface TraceEstimateInput {
    maxPerimeterMm: number;
    fineStepMm: number;
    coarseStepMm: number;
    accuracyEveryMm: number | null;
    expectedCorners: number;
}

export function estimateTraceTime(p: TraceEstimateInput): {
    worstMinutes: number;
    bestMinutes: number;
    worstSteps: number;
    bestSteps: number;
    confirmCycles: number;
} {
    const worstSteps = Math.ceil(p.maxPerimeterMm / p.fineStepMm) * 2;
    const bestSteps = Math.ceil(p.maxPerimeterMm / p.coarseStepMm) * 2;
    const confirmCycles = 1 + p.expectedCorners + (p.accuracyEveryMm ? Math.ceil(p.maxPerimeterMm / p.accuracyEveryMm) : 0);
    const confirmSeconds = confirmCycles * TRACE_CONFIRM_SECONDS;
    return {
        worstSteps,
        bestSteps,
        confirmCycles,
        worstMinutes: Math.round((worstSteps * TRACE_STEP_SECONDS + confirmSeconds) / 60),
        bestMinutes: Math.round((bestSteps * TRACE_STEP_SECONDS + confirmSeconds) / 60),
    };
}
