// What probe_trace_perimeter REPORTS from the ordered contacts the crawl
// (perimeterTrace.ts) produced. Pure: no server imports.
//
// T8 rerun (job d677bd88d31a, issue #183): the crawl measured the pocket to
// ~0.1 mm, but the result misreported it -
//   1. each point's normal was the crawl heading's, which trails the wall for
//      tens of points after every corner (surfaces off by up to ~0.5 mm);
//   2. four walls came out as eleven "straights" (arc tails, a zig-zag
//      outlier, the closure seam);
//   3. corner circles were fitted through the tails of the adjacent walls
//      (chuck +X centre 2.1 mm off, r 6.71 for a 4.68 corner);
//   4. irregular lobes were reported as one radius (rms 1.3 mm);
//   6. only the tip-centre length was reported.
// Everything here is analysis of the recorded points: nothing bounds motion.
//
// Geometry is TIP-CENTRE unless a name says surface. A point's normal points
// INTO the material; its surface is tipCentre + tip radius * normal.

import { CircleFit, fitCircle } from './cornerFit';
import type { TracePoint, TraceResult, WallSide } from './perimeterTrace';
import { WallLineFit, Xy, fitWallLine } from './wallFollow';

const r3 = (v: number) => Number(v.toFixed(3));
const r4 = (v: number) => Number(v.toFixed(4));
const dist = (a: Xy, b: Xy) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------- normals (item 1)

/**
 * The unit normal INTO the material at each point from LOCAL GEOMETRY: a
 * total-least-squares line through the neighbouring tip centres within
 * `halfWindowMm` of the point (at least one neighbour each side), oriented
 * so the material lies on `side` of the direction of travel through the
 * window. The crawl heading's normal trails the wall after a corner (the
 * heading is only re-aligned once a straight run is proven); the contacts
 * themselves do not. null where the window is degenerate (fewer than two
 * distinct points); the caller keeps the crawl's normal there.
 */
export function localNormals(points: Xy[], side: WallSide, halfWindowMm: number, closed: boolean): (Xy | null)[] {
    const n = points.length;
    const at = (k: number): number | null => {
        if (closed) {
            return ((k % n) + n) % n;
        }
        return k >= 0 && k < n ? k : null;
    };
    const out: (Xy | null)[] = [];
    for (let i = 0; i < n; i++) {
        const window: number[] = [i];
        for (const dir of [-1, 1]) {
            for (let s = 1; s < n; s++) {
                const k = at(i + dir * s);
                if (k === null || k === i || window.includes(k)) {
                    break;
                }
                if (s > 1 && dist(points[k], points[i]) > halfWindowMm + 1e-9) {
                    break;
                }
                if (dir < 0) {
                    window.unshift(k);
                } else {
                    window.push(k);
                }
            }
        }
        const pts = window.map((k) => points[k]);
        const chord = { x: pts[pts.length - 1].x - pts[0].x, y: pts[pts.length - 1].y - pts[0].y };
        const fit = pts.length >= 2 && Math.hypot(chord.x, chord.y) > 1e-9 ? fitWallLine(pts, { x: 0, y: 0 }, chord) : null;
        if (!fit) {
            out.push(null);
            continue;
        }
        const d = fit.direction;
        // Material on the right of travel: the travel direction turned -90.
        const nrm = side === 'right' ? { x: d.y, y: -d.x } : { x: -d.y, y: d.x };
        const len = Math.hypot(nrm.x, nrm.y) || 1;
        out.push({ x: r3(nrm.x / len) || 0, y: r3(nrm.y / len) || 0 });
    }
    return out;
}

export interface NormalRefinement {
    perimeter: TracePoint[];
    /** How the normals were derived, for the result. */
    normals: { source: 'local-fit'; halfWindowMm: number; crawlNormalKept: number };
}

/** Replace each point's normal (and surface) with the local-geometry one. The tip-centre points are untouched. */
export function refineNormals(perimeter: TracePoint[], side: WallSide, tipRadiusMm: number | null, halfWindowMm: number, closed: boolean): NormalRefinement {
    const normals = localNormals(perimeter.map((p) => p.tipCentre), side, halfWindowMm, closed);
    let kept = 0;
    const refined = perimeter.map((p, i) => {
        const nrm = normals[i];
        if (!nrm) {
            kept += 1;
            return p;
        }
        const surface = tipRadiusMm === null ? null : { x: r3(p.tipCentre.x + nrm.x * tipRadiusMm), y: r3(p.tipCentre.y + nrm.y * tipRadiusMm) };
        return { ...p, normal: nrm, surface };
    });
    return { perimeter: refined, normals: { source: 'local-fit', halfWindowMm: r3(halfWindowMm), crawlNormalKept: kept } };
}

// ---------------------------------------------------------------- length (item 6)

/**
 * Length along the points by the crawl's own rule: the polyline's anchor
 * moves on only once the next point is `minStepMm` away (the contacts sit on
 * the fine-step grid and zig-zag a step across it; a raw point-to-point sum
 * over-reads a lap by ~5 %). Applied to the tip centres it reproduces the
 * crawl's lengthMm; applied to the surface points it is the perimeter a CAD
 * model of the pocket reports.
 */
export function anchoredLength(points: Xy[], minStepMm: number): number {
    let length = 0;
    let anchor: Xy | null = null;
    for (const p of points) {
        if (!anchor) {
            anchor = p;
        } else {
            const d = dist(anchor, p);
            if (d >= minStepMm - 1e-9) {
                length += d;
                anchor = p;
            }
        }
    }
    return r3(length);
}

// ---------------------------------------------------------------- segmentation (items 2-4)

export interface PerimeterPiece {
    kind: 'line' | 'arc';
    /** Perimeter point indices (from > to: the piece runs through the closure seam). */
    from: number;
    to: number;
    points: number;
    radiusTipCentreMm: number | null;
    radiusPhysicalMm: number | null;
    center: Xy | null;
    rmsResidualMm: number;
    maxResidualMm: number;
}

export type PerimeterSegment =
    | {
        kind: 'line';
        from: number;
        to: number;
        /** The TIP-CENTRE line (its `normal` sign is arbitrary). */
        fit: WallLineFit;
        lengthMm: number;
        /** How many greedy straights were merged into this wall (item 2). */
        merged: number;
        /** The wall SURFACE: the tip-centre line moved one tip radius into the material; `normal` points into it. null without a tip radius or a wall side. */
        surface: { point: Xy; normal: Xy } | null;
    }
    | { kind: 'arc'; from: number; to: number; fit: CircleFit | null; points: number; shape: CornerShape };

/**
 * arc = a single circle describes the curve within the tolerance; sharp =
 * fewer than three points lie off both walls (nothing to fit); irregular =
 * no single circle fits (T8's free-end lobes, rms 1.3 / 0.9 mm): no radius
 * is reported, the polyline and the piecewise fit are.
 */
export type CornerShape = 'arc' | 'sharp' | 'irregular';

export interface PerimeterCorner {
    /** Perimeter point indices of the curve between two lines (from > to: through the closure seam). */
    from: number;
    to: number;
    shape: CornerShape;
    /** Tip-centre radius of the circle through the points off BOTH adjacent walls; null unless shape 'arc'. */
    radiusTipCentreMm: number | null;
    radiusPhysicalMm: number | null;
    center: Xy | null;
    maxResidualMm: number | null;
    rmsResidualMm: number | null;
    /** Signed radial residual of each point the circle was fitted to (positive = outside), in `fitIndices` order. */
    residualsMm: number[] | null;
    /** The points the circle was fitted to: those whose residual from BOTH adjacent wall lines exceeds the tolerance. */
    fitIndices: number[];
    /** Curve points left out of the fit because they lie on an adjacent wall's line (the tails the old fit absorbed). */
    onWallPoints: number;
    /** Off-wall points dropped from the ENDS of the fit because they sat off the circle by more than the tolerance (the wall's transition into the arc). */
    trimmedPoints: number;
    /** Interior angle between the two straight walls the curve joins (degrees). */
    interiorAngleDeg: number | null;
    /** Path length of the curve (tip centre, anchored polyline). */
    pathLengthMm: number;
    /** irregular: what ONE circle through the same points would have been, so the misfit is on the record. */
    singleArc: { radiusTipCentreMm: number; center: Xy; rmsResidualMm: number; maxResidualMm: number } | null;
    /** irregular: the curve as a polyline (Douglas-Peucker at the tolerance), tip-centre vertices with their point index. */
    polyline: { index: number; tipCentre: Xy }[] | null;
    /** irregular: the curve as consecutive line / arc pieces, each within the tolerance. */
    pieces: PerimeterPiece[] | null;
}

export interface SegmentOptions {
    /** The trace closed: the last point is followed by the first. */
    closed?: boolean;
    /** Adjacent straights whose directions differ by at most this are one wall (default: the crawl's turn step, 10 deg). */
    mergeAngleDeg?: number;
    /** The anchored-length step for a curve's path length (default 0: every point; the crawl's rule is two fine steps). */
    lengthStepMm?: number;
    /** The side the material was on while crawling: orients each wall's surface line. */
    wallSide?: WallSide;
}

interface LineRun {
    from: number;
    to: number;
    fit: WallLineFit;
    merged: number;
}

function residualFrom(fit: WallLineFit, q: Xy): number {
    return (q.x - fit.point.x) * fit.normal.x + (q.y - fit.point.y) * fit.normal.y;
}

function angleBetweenLines(a: WallLineFit, b: WallLineFit): number {
    const dot = Math.abs(a.direction.x * b.direction.x + a.direction.y * b.direction.y);
    return (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
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

function fitRange(points: Xy[], from: number, to: number): WallLineFit | null {
    return fitWallLine(points.slice(from, to + 1), { x: 0, y: 0 });
}

/**
 * Merge adjacent straights into one wall (item 2). They are one wall when
 * their directions agree within `mergeAngleDeg` and ONE line through both
 * runs - and any points the greedy split left between them - describes them
 * as well as a wall scattering uniformly within +/- the tolerance would:
 * rms <= tol / sqrt(3). T8's walls wave +/- 0.15 mm (wood) against a 0.15
 * tolerance, which is what split them; a max-residual test would keep them
 * split, an rms test does not, and a lobe or a ledge between two collinear
 * runs still fails it. The merged line's own residuals are reported as they
 * are. The ends of the merged run that sit off it by more than the
 * tolerance (a corner's tail, which the short run was fitted to) are
 * trimmed back to the curves beside it; at least half of each run survives.
 */
function tryMerge(points: Xy[], a: LineRun, b: LineRun, tolMm: number, mergeAngleDeg: number): LineRun | null {
    if (angleBetweenLines(a.fit, b.fit) > mergeAngleDeg + 1e-9) {
        return null;
    }
    let from = a.from;
    let to = b.to;
    let fit = fitRange(points, from, to);
    while (fit) {
        const f: WallLineFit = fit;
        const headOff = Math.abs(residualFrom(f, points[from])) > tolMm + 1e-9;
        const tailOff = Math.abs(residualFrom(f, points[to])) > tolMm + 1e-9;
        if (!headOff && !tailOff) {
            break;
        }
        from += headOff ? 1 : 0;
        to -= tailOff ? 1 : 0;
        if (to - from < 2) {
            return null;
        }
        fit = fitRange(points, from, to);
    }
    if (!fit || fit.rmsMm > tolMm / Math.sqrt(3) + 1e-9) {
        return null;
    }
    const keptA = Math.max(0, Math.min(a.to, to) - Math.max(a.from, from) + 1);
    const keptB = Math.max(0, Math.min(b.to, to) - Math.max(b.from, from) + 1);
    if (keptA * 2 < a.to - a.from + 1 || keptB * 2 < b.to - b.from + 1) {
        return null;
    }
    return { from, to, fit, merged: a.merged + b.merged };
}

/** Straight runs of an ORDERED (open) point list: greedy growth, extension over the leftovers, collinear merge. */
function findLines(points: Xy[], tolMm: number, minLinePoints: number, minLineLengthMm: number, mergeAngleDeg: number): LineRun[] {
    const n = points.length;
    let lines: LineRun[] = [];
    let i = 0;
    while (i < n) {
        const grown = growLineFrom(points, i, tolMm);
        if (grown.fit && grown.to - i + 1 >= minLinePoints && chordLength(points, i, grown.to) >= minLineLengthMm - 1e-9) {
            lines.push({ from: i, to: grown.to, fit: grown.fit, merged: 1 });
            i = grown.to + 1;
        } else {
            i += 1;
        }
    }
    const extend = () => {
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
            const refit = fitRange(points, line.from, line.to);
            if (refit && refit.maxAbsMm <= tolMm + 1e-9) {
                line.fit = refit;
            }
        }
    };
    extend();
    for (let changed = true; changed;) {
        changed = false;
        for (let k = 0; k + 1 < lines.length; k++) {
            const merged = tryMerge(points, lines[k], lines[k + 1], tolMm, mergeAngleDeg);
            if (merged) {
                lines = [...lines.slice(0, k), merged, ...lines.slice(k + 2)];
                changed = true;
                break;
            }
        }
    }
    extend();
    return lines;
}

/**
 * The Kasa circle through `idx`. Whether ONE circle describes the curve is
 * judged on every off-wall point (`whole`); only when it does are the run's
 * END points then dropped one at a time while the worse end sits off the
 * circle by more than the tolerance - the transition from a wall into its
 * corner is on neither the wall's line nor the arc (T8 chuck +X: the +X
 * wall leans in 0.25 mm over its last 3 mm) and pulls the centre. An
 * irregular curve is never trimmed down to whichever sub-arc happens to fit.
 */
function trimmedCircle(points: Xy[], idx: number[], tolMm: number): { used: number[]; whole: CircleFit | null; fit: CircleFit | null } {
    const whole = idx.length >= 3 ? fitCircle(idx.map((k) => points[k])) : null;
    if (!whole || whole.rmsResidual > tolMm + 1e-9) {
        return { used: [...idx], whole, fit: whole };
    }
    let used = [...idx];
    let fit: CircleFit = whole;
    while (used.length > 3) {
        const head = Math.abs(fit.residuals[0]);
        const tail = Math.abs(fit.residuals[fit.residuals.length - 1]);
        if (Math.max(head, tail) <= tolMm + 1e-9) {
            break;
        }
        const trial = head >= tail ? used.slice(1) : used.slice(0, -1);
        const next = fitCircle(trial.map((k) => points[k]));
        if (!next) {
            break;
        }
        used = trial;
        fit = next;
    }
    return { used, whole, fit };
}

/** Douglas-Peucker over points[from..to] (indices into `points`), vertices as indices. */
function simplify(points: Xy[], idx: number[], tolMm: number): number[] {
    if (idx.length <= 2) {
        return [...idx];
    }
    const a = points[idx[0]];
    const b = points[idx[idx.length - 1]];
    const len = dist(a, b);
    let worst = -1;
    let worstAt = -1;
    for (let k = 1; k < idx.length - 1; k++) {
        const p = points[idx[k]];
        const d = len < 1e-9 ? dist(p, a) : Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
        if (d > worst) {
            worst = d;
            worstAt = k;
        }
    }
    if (worst <= tolMm + 1e-9) {
        return [idx[0], idx[idx.length - 1]];
    }
    const left = simplify(points, idx.slice(0, worstAt + 1), tolMm);
    const right = simplify(points, idx.slice(worstAt), tolMm);
    return [...left.slice(0, -1), ...right];
}

/**
 * The curve as consecutive pieces (item 4), each grown point by point while
 * ONE line or ONE circle holds all its points within the tolerance; a piece
 * is a line when a line holds it.
 */
function piecewise(points: Xy[], idx: number[], tolMm: number, tipRadiusMm: number | null): PerimeterPiece[] {
    const pieces: PerimeterPiece[] = [];
    let s = 0;
    while (s < idx.length - 1) {
        let best: PerimeterPiece | null = null;
        for (let e = s + 1; e < idx.length; e++) {
            const pts = idx.slice(s, e + 1).map((k) => points[k]);
            const line = fitWallLine(pts, { x: 0, y: 0 });
            let piece: PerimeterPiece | null = null;
            if (line && line.maxAbsMm <= tolMm + 1e-9) {
                piece = {
                    kind: 'line',
                    from: idx[s],
                    to: idx[e],
                    points: pts.length,
                    radiusTipCentreMm: null,
                    radiusPhysicalMm: null,
                    center: null,
                    rmsResidualMm: line.rmsMm,
                    maxResidualMm: line.maxAbsMm,
                };
            } else {
                const arc = pts.length >= 3 ? fitCircle(pts) : null;
                if (arc && arc.maxResidual <= tolMm + 1e-9) {
                    piece = {
                        kind: 'arc',
                        from: idx[s],
                        to: idx[e],
                        points: pts.length,
                        radiusTipCentreMm: arc.radius,
                        radiusPhysicalMm: tipRadiusMm === null ? null : r4(arc.radius + tipRadiusMm),
                        center: arc.center,
                        rmsResidualMm: arc.rmsResidual,
                        maxResidualMm: arc.maxResidual,
                    };
                }
            }
            if (!piece) {
                break;
            }
            best = piece;
        }
        if (!best) {
            break;
        }
        pieces.push(best);
        // Consecutive pieces share their joining point.
        s = idx.indexOf(best.to, s);
    }
    return pieces;
}

/**
 * Split an ordered perimeter into straight walls and the curves between
 * them. A wall is a run of >= minLinePoints contacts, at least
 * minLineLengthMm long (an arc sampled every fraction of a millimetre is
 * locally straight, so a short run is part of the curve around it), whose
 * residuals from the running line stay under tolMm - each candidate judged
 * against the line WITHOUT it; each wall is extended over the neighbouring
 * points that stay on its line, and adjacent walls that are one line (item 2)
 * are merged. A CLOSED trace is segmented from the start of a curve so the
 * wall through the closure seam is one wall. Everything between two walls
 * is a curve. A corner's circle is fitted ONLY to the curve points off BOTH
 * adjacent wall lines (item 3; splitWallRun's rule (a)); when one circle
 * does not fit those within the tolerance the corner is 'irregular' and is
 * reported as a polyline and line / arc pieces, never as one radius (item 4).
 * Pure.
 */
export function segmentPerimeter(
    points: Xy[],
    tolMm: number,
    minLinePoints: number = 4,
    tipRadiusMm: number | null = null,
    minLineLengthMm: number = 4,
    options: SegmentOptions = {}
): {
    segments: PerimeterSegment[];
    corners: PerimeterCorner[];
} {
    const n = points.length;
    const mergeAngle = options.mergeAngleDeg === undefined ? 10 : options.mergeAngleDeg;
    const lengthStep = options.lengthStepMm === undefined ? 0 : options.lengthStepMm;
    if (n < 2) {
        return { segments: [], corners: [] };
    }
    // Closed: rotate so the order starts at the first curve point after a wall.
    let offset = 0;
    if (options.closed) {
        const first = findLines(points, tolMm, minLinePoints, minLineLengthMm, mergeAngle);
        const afterWall = first.find((l, k) => l.to + 1 < n && (k + 1 >= first.length || first[k + 1].from > l.to + 1));
        if (afterWall) {
            offset = afterWall.to + 1;
        }
    }
    const pts = offset ? [...points.slice(offset), ...points.slice(0, offset)] : points;
    const orig = (k: number) => (k + offset) % n;
    const lines = findLines(pts, tolMm, minLinePoints, minLineLengthMm, mergeAngle);

    // Segments in rotated order.
    type Raw = { kind: 'line'; line: LineRun } | { kind: 'curve'; from: number; to: number };
    const raw: Raw[] = [];
    let cursor = 0;
    for (const line of lines) {
        if (line.from > cursor) {
            raw.push({ kind: 'curve', from: Math.max(0, cursor - 1), to: line.from });
        }
        raw.push({ kind: 'line', line });
        cursor = line.to + 1;
    }
    if (cursor < n) {
        raw.push({ kind: 'curve', from: Math.max(0, cursor - 1), to: n - 1 });
    }
    const neighbourLine = (s: number, step: -1 | 1): LineRun | null => {
        let k = s + step;
        if (options.closed) {
            k = (k + raw.length) % raw.length;
        }
        if (k < 0 || k >= raw.length || k === s) {
            return null;
        }
        const r = raw[k];
        return r.kind === 'line' ? r.line : null;
    };

    const segments: PerimeterSegment[] = [];
    const corners: PerimeterCorner[] = [];
    raw.forEach((r, s) => {
        if (r.kind === 'line') {
            const { line } = r;
            let surface: { point: Xy; normal: Xy } | null = null;
            if (tipRadiusMm !== null && options.wallSide) {
                const travel = { x: pts[line.to].x - pts[line.from].x, y: pts[line.to].y - pts[line.from].y };
                const d = line.fit.direction.x * travel.x + line.fit.direction.y * travel.y >= 0
                    ? line.fit.direction
                    : { x: -line.fit.direction.x, y: -line.fit.direction.y };
                const into = options.wallSide === 'right' ? { x: d.y, y: -d.x } : { x: -d.y, y: d.x };
                surface = {
                    point: { x: r3(line.fit.point.x + into.x * tipRadiusMm), y: r3(line.fit.point.y + into.y * tipRadiusMm) },
                    normal: { x: r3(into.x) || 0, y: r3(into.y) || 0 },
                };
            }
            segments.push({
                kind: 'line', from: orig(line.from), to: orig(line.to), fit: line.fit, lengthMm: r3(chordLength(pts, line.from, line.to)), merged: line.merged, surface,
            });
            return;
        }
        const idx: number[] = [];
        for (let k = r.from; k <= r.to; k++) {
            idx.push(k);
        }
        const before = neighbourLine(s, -1);
        const after = neighbourLine(s, 1);
        const walls = [before, after].filter((l): l is LineRun => !!l);
        const offWalls = idx.filter((k) => walls.every((w) => Math.abs(residualFrom(w.fit, pts[k])) > tolMm + 1e-9));
        const { used: off, whole, fit } = trimmedCircle(pts, offWalls, tolMm);
        let shape: CornerShape = 'sharp';
        if (offWalls.length >= 3) {
            shape = whole && whole.rmsResidual <= tolMm + 1e-9 ? 'arc' : 'irregular';
        }
        segments.push({ kind: 'arc', from: orig(r.from), to: orig(r.to), fit: shape === 'arc' ? fit : null, points: idx.length, shape });
        if (!before || !after) {
            return;
        }
        const dot = Math.max(-1, Math.min(1, -(before.fit.normal.x * after.fit.normal.x + before.fit.normal.y * after.fit.normal.y)));
        const irregular = shape === 'irregular';
        corners.push({
            from: orig(r.from),
            to: orig(r.to),
            shape,
            radiusTipCentreMm: shape === 'arc' && fit ? fit.radius : null,
            radiusPhysicalMm: shape === 'arc' && fit && tipRadiusMm !== null ? r3(fit.radius + tipRadiusMm) : null,
            center: shape === 'arc' && fit ? fit.center : null,
            maxResidualMm: fit ? fit.maxResidual : null,
            rmsResidualMm: fit ? fit.rmsResidual : null,
            residualsMm: shape === 'arc' && fit ? fit.residuals : null,
            fitIndices: off.map(orig),
            onWallPoints: idx.length - offWalls.length,
            trimmedPoints: offWalls.length - off.length,
            interiorAngleDeg: r3((Math.acos(dot) * 180) / Math.PI),
            pathLengthMm: anchoredLength(idx.map((k) => pts[k]), lengthStep),
            singleArc: irregular && fit ? {
                radiusTipCentreMm: fit.radius,
                center: fit.center,
                rmsResidualMm: fit.rmsResidual,
                maxResidualMm: fit.maxResidual,
            } : null,
            polyline: irregular ? simplify(pts, idx, tolMm).map((k) => ({ index: orig(k), tipCentre: pts[k] })) : null,
            pieces: irregular ? piecewise(pts, idx, tolMm, tipRadiusMm).map((p) => ({ ...p, from: orig(p.from), to: orig(p.to) })) : null,
        });
    });
    return { segments, corners };
}

// ---------------------------------------------------------------- the whole report

export interface TraceAnalysisParams {
    wallSide: WallSide;
    tipRadiusMm: number | null;
    fineStepMm: number;
    coarseStepMm: number;
    turnStepDeg: number;
    lineToleranceMm: number;
}

export interface TraceLengths {
    /** The crawl's own length: the tip-centre path (anchored polyline, two fine steps). */
    tipCentreMm: number;
    /**
     * The same rule along the SURFACE points (tip centre + tip radius along the
     * local normal): what a CAD model of the pocket reports. null without a tip radius.
     */
    surfaceMm: number | null;
    /** Cross-check: tip-centre length + tip radius x the heading turned (radians) - exact for a closed offset curve. null without a tip radius. */
    surfaceFromTurnMm: number | null;
}

export interface TraceAnalysis {
    /** The perimeter with normals and surfaces from local geometry (item 1). */
    perimeter: TracePoint[];
    normals: NormalRefinement['normals'];
    segments: PerimeterSegment[];
    corners: PerimeterCorner[];
    lengths: TraceLengths;
}

/**
 * Everything probe_trace_perimeter reports from a crawl's result (complete
 * or the partial one an abort carried): refined normals and surfaces, the
 * segmentation with merged walls, corner fits and irregular lobes, and both
 * lengths. Every scale is the crawl's own: the normal window is one coarse
 * step each side (the scale on which the crawl calls a wall straight), the
 * segmentation tolerance 1.5 x line_tolerance, a wall at least four coarse
 * steps long, walls within one turn step of each other merge (a smaller
 * direction change is inside the crawl's heading quantum), lengths anchored
 * at two fine steps. Pure.
 */
export function analyseTrace(trace: TraceResult, p: TraceAnalysisParams): TraceAnalysis {
    const refined = refineNormals(trace.perimeter, p.wallSide, p.tipRadiusMm, p.coarseStepMm, trace.closed);
    const tips = refined.perimeter.map((pt) => pt.tipCentre);
    const lengthStep = 2 * p.fineStepMm;
    const seg = tips.length >= 3
        ? segmentPerimeter(tips, p.lineToleranceMm * 1.5, 4, p.tipRadiusMm, p.coarseStepMm * 4, {
            closed: trace.closed, mergeAngleDeg: p.turnStepDeg, lengthStepMm: lengthStep, wallSide: p.wallSide,
        })
        : { segments: [], corners: [] };
    const surfaces = refined.perimeter.map((pt) => pt.surface).filter((q): q is Xy => !!q);
    const hasSurface = p.tipRadiusMm !== null && surfaces.length === refined.perimeter.length && surfaces.length > 0;
    return {
        perimeter: refined.perimeter,
        normals: refined.normals,
        segments: seg.segments,
        corners: seg.corners,
        lengths: {
            tipCentreMm: trace.lengthMm,
            surfaceMm: hasSurface ? anchoredLength(surfaces, lengthStep) : null,
            surfaceFromTurnMm: p.tipRadiusMm === null ? null : r3(trace.lengthMm + p.tipRadiusMm * Math.abs((trace.headingTurnDeg * Math.PI) / 180)),
        },
    };
}
