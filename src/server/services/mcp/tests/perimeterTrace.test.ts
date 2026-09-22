import { strict as assert } from 'assert';

import {
    TraceIo,
    TraceParams,
    estimateTraceTime,
    insideBounds,
    normalFor,
    rotate,
    segmentPerimeter,
    tangentFor,
    tracePerimeter,
} from '../perimeterTrace';
import { isProcedureAbort } from '../procedureAbort';
import { Xy } from '../wallFollow';

// A synthetic pocket in TIP-CENTRE space: a 60 x 40 rectangle with R5
// internal corners and one lobe - a semicircle of radius 6 bulging out of
// the +X wall about (60, 20). `inside` is the contact oracle: the probe
// reads contact wherever the tip centre is NOT inside the free region.
const W = 60;
const H = 40;
const R = 5;
const LOBE = { cx: 60, cy: 20, r: 6 };

// Touching the wall IS contact: the free region is open (strict inequalities).
function insideRoundedRect(p: Xy): boolean {
    if (p.x <= 0 || p.x >= W || p.y <= 0 || p.y >= H) {
        return false;
    }
    const cx = Math.min(Math.max(p.x, R), W - R);
    const cy = Math.min(Math.max(p.y, R), H - R);
    return Math.hypot(p.x - cx, p.y - cy) < R - 1e-9;
}

function insidePocket(p: Xy): boolean {
    if (insideRoundedRect(p)) {
        return true;
    }
    return p.x > LOBE.cx - 1e-9 && Math.hypot(p.x - LOBE.cx, p.y - LOBE.cy) < LOBE.r - 1e-9;
}

interface Sim {
    io: TraceIo;
    position: Xy;
    moves: number;
    log: string[];
}

/** The simulated machine: a step goes where it is told; the oracle says whether the probe touched. Marches / confirms bisect the boundary. */
function simulate(inside: (p: Xy) => boolean): Sim {
    const sim: Sim = { position: { x: 0, y: 0 }, moves: 0, log: [], io: null as unknown as TraceIo };
    const crossing = (from: Xy, unit: Xy, travel: number): { point: Xy; spreadMm: number } | null => {
        let lo = 0;
        let hi: number | null = null;
        for (let s = 0.05; s <= travel + 1e-9; s += 0.05) {
            const q = { x: from.x + unit.x * s, y: from.y + unit.y * s };
            if (!inside(q)) {
                hi = s;
                break;
            }
            lo = s;
        }
        if (hi === null) {
            return null;
        }
        for (let k = 0; k < 20; k++) {
            const mid = (lo + hi) / 2;
            if (inside({ x: from.x + unit.x * mid, y: from.y + unit.y * mid })) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        const point = { x: Number((from.x + unit.x * hi).toFixed(4)), y: Number((from.y + unit.y * hi).toFixed(4)) };
        sim.position = point;
        return { point, spreadMm: 0 };
    };
    sim.io = {
        step: async (p) => { sim.moves += 1; sim.position = p; return !inside(p); },
        move: async (p) => { sim.moves += 1; sim.position = p; },
        march: async (from, unit, travel) => crossing(from, unit, travel),
        confirm: async (from, unit, travel) => crossing(from, unit, travel),
    };
    return sim;
}

function params(over: Partial<TraceParams> = {}): TraceParams {
    return {
        fineStepMm: 0.1,
        coarseStepMm: 1,
        turnStepDeg: 10,
        bumpMm: 0.1,
        bumpCapSteps: 3,
        lineToleranceMm: 0.1,
        straightPoints: 6,
        maxPerimeterMm: 400,
        maxSteps: 200000,
        bounds: { x0: -1, y0: -1, x1: 70, y1: 41 },
        keepOut: [],
        wallSide: 'right',
        confirmAt: new Set(['first', 'turns', 'unexpected']),
        accuracyEveryMm: null,
        majorTurnDeg: 45,
        tipRadiusMm: 0.625,
        confirmTravelMm: 0.3,
        ...over,
    };
}

const silent = () => undefined;
// Analytical tip-centre perimeter: rounded rectangle (2(W+H) - 8R + 2 pi R) with 12 mm of the +X wall replaced by a pi*6 semicircle.
const EXPECTED_LENGTH = 2 * (W + H) - 8 * R + 2 * Math.PI * R - 2 * LOBE.r + Math.PI * LOBE.r;

/** Which wall region a tip-centre point belongs to, for the fine/coarse assertions. */
function region(p: Xy): 'straight' | 'corner' | 'lobe' | 'other' {
    const tol = 0.3;
    const onStraight = (Math.abs(p.y) < tol && p.x > R && p.x < W - R)
        || (Math.abs(p.y - H) < tol && p.x > R && p.x < W - R)
        || (Math.abs(p.x) < tol && p.y > R && p.y < H - R)
        || (Math.abs(p.x - W) < tol && p.y > R && p.y < H - R && (p.y < LOBE.cy - LOBE.r || p.y > LOBE.cy + LOBE.r));
    if (onStraight) {
        return 'straight';
    }
    if ((p.x < R + tol || p.x > W - R - tol) && (p.y < R + tol || p.y > H - R - tol)) {
        return 'corner';
    }
    if (p.x > W - tol && Math.abs(Math.hypot(p.x - LOBE.cx, p.y - LOBE.cy) - LOBE.r) < tol) {
        return 'lobe';
    }
    return 'other';
}

export const tests: Array<[string, () => Promise<void> | void]> = [
    ['frame helpers: right-hand wall -> tangent is the inward normal turned +90; rotate is counter-clockwise', () => {
        assert.deepEqual(rotate({ x: 1, y: 0 }, 90), { x: 0, y: 1 });
        assert.deepEqual(tangentFor({ x: 0, y: -1 }, 'right'), { x: 1, y: 0 }, 'wall below, on the right: walk +X');
        assert.deepEqual(normalFor({ x: 1, y: 0 }, 'right'), { x: 0, y: -1 });
        assert.deepEqual(tangentFor({ x: 0, y: -1 }, 'left'), { x: -1, y: 0 });
        assert.ok(insideBounds({ x: 5, y: 5 }, { x0: 0, y0: 0, x1: 10, y1: 10 }));
        assert.ok(!insideBounds({ x: 11, y: 5 }, { x0: 0, y0: 0, x1: 10, y1: 10 }));
    }],

    ['the crawl closes the synthetic pocket: full turn, back at the first wall, length within 3 % of the analytical perimeter', async () => {
        const sim = simulate(insidePocket);
        const result = await tracePerimeter(sim.io, { x: 30, y: 20 }, { x: 0, y: -1 }, 30, params(), silent);
        assert.equal(result.ending.kind, 'closed', result.ending.note);
        assert.ok(result.closed);
        assert.ok(Math.abs(result.headingTurnDeg - 360) < 1e-6, `heading ${result.headingTurnDeg}`);
        assert.ok(Math.abs(result.lengthMm - EXPECTED_LENGTH) / EXPECTED_LENGTH < 0.03, `length ${result.lengthMm} vs ${EXPECTED_LENGTH.toFixed(1)}`);
        assert.ok(result.perimeter.length > 300, `${result.perimeter.length} perimeter points`);
        assert.equal(result.perimeter[0].kind, 'first');
        assert.ok(result.perimeter[0].confirmed);
        // Every recorded point lies on the pocket boundary: not free a hair into the material, free a step back.
        for (const pt of result.perimeter) {
            const into = { x: pt.tipCentre.x + pt.normal.x * 0.002, y: pt.tipCentre.y + pt.normal.y * 0.002 };
            assert.ok(!insidePocket(into), `point ${pt.index} (${pt.tipCentre.x}, ${pt.tipCentre.y}) is inside the free region`);
            if (pt.kind === 'bump') {
                const back = { x: pt.tipCentre.x - pt.normal.x * 0.11, y: pt.tipCentre.y - pt.normal.y * 0.11 };
                assert.ok(insidePocket(back), `point ${pt.index} (${pt.tipCentre.x}, ${pt.tipCentre.y}) is more than a step past the wall`);
            }
        }
        // The surface is one tip radius INTO the material.
        assert.ok(result.perimeter[0].surface && result.perimeter[0].surface.y < result.perimeter[0].tipCentre.y);
        assert.equal(result.counts.tangentContacts > 0, true, 'internal corners were met head-on');
    }],

    ['fine steps in the corners and on the lobe, coarse steps on the straights', async () => {
        const sim = simulate(insidePocket);
        const result = await tracePerimeter(sim.io, { x: 30, y: 20 }, { x: 0, y: -1 }, 30, params(), silent);
        assert.ok(result.counts.coarseSteps > 100, `coarse steps ${result.counts.coarseSteps}`);
        assert.ok(result.counts.fineSteps > 100, `fine steps ${result.counts.fineSteps}`);
        const coarsePoints = result.perimeter.filter((pt) => pt.stepMm === 1);
        // A coarse step may land at the very entry of a corner (the straightness window lags by one step); never inside it.
        const bad = coarsePoints.filter((pt) => region(pt.tipCentre) !== 'straight');
        assert.ok(bad.length <= 12, `coarse steps off the straights: ${bad.map((b) => `(${b.tipCentre.x},${b.tipCentre.y})`).join(' ')}`);
        for (const b of bad) {
            const q = b.tipCentre;
            const nearCornerEntry = Math.min(Math.abs(q.x - R), Math.abs(q.x - (W - R)), Math.abs(q.y - R), Math.abs(q.y - (H - R)),
                Math.abs(q.y - (LOBE.cy - LOBE.r)), Math.abs(q.y - (LOBE.cy + LOBE.r))) <= 1.2;
            assert.ok(nearCornerEntry, `coarse step deep in a curve at (${q.x}, ${q.y})`);
        }
        const cornerPoints = result.perimeter.filter((pt) => region(pt.tipCentre) === 'corner' || region(pt.tipCentre) === 'lobe');
        assert.ok(cornerPoints.length > 50, `${cornerPoints.length} corner / lobe points`);
        // Deep in a curve (more than 1.2 mm past where the straight wall ends) every step is fine.
        const deep = cornerPoints.filter((pt) => {
            const q = pt.tipCentre;
            return Math.min(Math.abs(q.x - R), Math.abs(q.x - (W - R)), Math.abs(q.y - R), Math.abs(q.y - (H - R)),
                Math.abs(q.y - (LOBE.cy - LOBE.r)), Math.abs(q.y - (LOBE.cy + LOBE.r))) > 1.2;
        });
        assert.ok(deep.length > 30, `${deep.length} points deep in curves`);
        assert.ok(deep.every((pt) => pt.stepMm === 0.1), 'corners and the lobe are walked at the fine step only');
        // Confirm cycles (operator addendum): the first wall, the first block of each corner, one per major turn -
        // a few dozen at most, not one per 0.1 mm bump.
        assert.ok(result.counts.confirms >= 5 && result.counts.confirms <= 40, `${result.counts.confirms} confirm cycles for ${result.perimeter.length} points`);
    }],

    ['segmentation finds the four R5 corners (interior 90 deg) and the R6 lobe, with residuals', async () => {
        const sim = simulate(insidePocket);
        const result = await tracePerimeter(sim.io, { x: 30, y: 20 }, { x: 0, y: -1 }, 30, params(), silent);
        const { segments, corners } = segmentPerimeter(result.perimeter.map((pt) => pt.tipCentre), 0.15, 4, 0.625);
        const lines = segments.filter((s) => s.kind === 'line');
        assert.ok(lines.length >= 5, `${lines.length} straight segments (4 walls, the +X wall split by the lobe)`);
        // The contacts sit up to a fine step past the wall, so a fitted corner reads R5 within ~0.7.
        const r5 = corners.filter((c) => c.radiusTipCentreMm !== null && Math.abs(c.radiusTipCentreMm - 5) < 0.8);
        assert.ok(r5.length >= 4, `R5 corners found: ${corners.map((c) => c.radiusTipCentreMm).join(', ')}`);
        assert.ok(r5.every((c) => c.interiorAngleDeg === null || Math.abs(c.interiorAngleDeg - 90) < 8), JSON.stringify(r5.map((c) => c.interiorAngleDeg)));
        assert.ok(r5.every((c) => c.radiusPhysicalMm !== null && Math.abs(c.radiusPhysicalMm - 5.625) < 0.8));
        const lobe = corners.find((c) => c.radiusTipCentreMm !== null && Math.abs(c.radiusTipCentreMm - 6) < 0.6);
        assert.ok(lobe, `lobe found: ${corners.map((c) => c.radiusTipCentreMm).join(', ')}`);
        // Residuals are REPORTED on every fitted corner and small on the true arcs (the closure seam may carry a partial curve).
        assert.ok(corners.every((c) => c.center === null || c.maxResidualMm !== null), 'every fitted corner carries its residual');
        assert.ok([...r5, lobe!].every((c) => (c.maxResidualMm as number) < 0.4), `residuals on the true arcs: ${[...r5, lobe!].map((c) => c.maxResidualMm).join(', ')}`);
    }],

    ['the bounds stop the crawl with the partial perimeter; the budget stops it at max_perimeter_mm', async () => {
        // Bounds are the pocket's outer extent PLUS a margin for the bump into the wall; here they admit the
        // rectangle but not the lobe (which reaches x 66).
        const tight = simulate(insidePocket);
        const clipped = await tracePerimeter(tight.io, { x: 30, y: 20 }, { x: 0, y: -1 }, 30, params({ bounds: { x0: -1, y0: -1, x1: 60.5, y1: 41 } }), silent);
        assert.equal(clipped.ending.kind, 'bounds', clipped.ending.note);
        assert.ok(!clipped.closed);
        assert.ok(clipped.perimeter.length > 50 && clipped.lengthMm > 35, `the bottom wall and the first corner (${clipped.lengthMm} mm) were walked before the lobe left the bounds`);
        assert.ok(insideBounds(clipped.position, { x0: -1, y0: -1, x1: 60.5, y1: 41 }), 'the head never left the bounds');
        assert.ok(clipped.position.x > 59 && clipped.position.y > 13 && clipped.position.y < 16, `stopped where the lobe begins: ${JSON.stringify(clipped.position)}`);

        const budget = await tracePerimeter(simulate(insidePocket).io, { x: 30, y: 20 }, { x: 0, y: -1 }, 30, params({ maxPerimeterMm: 50 }), silent);
        assert.equal(budget.ending.kind, 'budget');
        assert.ok(Math.abs(budget.lengthMm - 50) <= 1, `length ${budget.lengthMm}`);

        const keepOut = await tracePerimeter(simulate(insidePocket).io, { x: 30, y: 20 }, { x: 0, y: -1 }, 30,
            params({ keepOut: [{ name: 'clamp', x0: 50, y0: -1, x1: 70, y1: 10 }] }), silent);
        assert.equal(keepOut.ending.kind, 'keep-out');
        assert.ok(keepOut.ending.note.includes('clamp'));
    }],

    ['a tip boxed in aborts after a full turn of failed steps; no wall within the march aborts too', async () => {
        // Free only in a hair-thin slit just below the start: the march touches at once, the back-off lands on material,
        // and every tangent step meets material.
        const boxed = simulate((p) => Math.abs(p.x - 30) < 0.02 && p.y >= 19.9 && p.y <= 19.99);
        let error: unknown = null;
        try {
            await tracePerimeter(boxed.io, { x: 30, y: 20 }, { x: 0, y: -1 }, 30, params(), silent);
        } catch (err) {
            error = err;
        }
        assert.ok(isProcedureAbort(error) && (error as Error).message.includes('Boxed in'), String(error));

        const open = simulate(() => true);
        error = null;
        try {
            await tracePerimeter(open.io, { x: 30, y: 20 }, { x: 0, y: -1 }, 30, params(), silent);
        } catch (err) {
            error = err;
        }
        assert.ok(isProcedureAbort(error) && (error as Error).message.includes('No wall within 30 mm'));
    }],

    ['accuracy points: confirm_at "every" adds a confirm cycle each accuracy_every_mm', async () => {
        const plain = await tracePerimeter(simulate(insidePocket).io, { x: 30, y: 20 }, { x: 0, y: -1 }, 30, params({ confirmAt: new Set(['first']) }), silent);
        const every = await tracePerimeter(simulate(insidePocket).io, { x: 30, y: 20 }, { x: 0, y: -1 }, 30,
            params({ confirmAt: new Set(['first', 'every']), accuracyEveryMm: 20 }), silent);
        assert.equal(plain.counts.confirms, 1, 'the first wall only');
        assert.ok(every.counts.confirms >= 9 && every.counts.confirms <= 12, `${every.counts.confirms} confirms for ~200 mm every 20`);
        assert.ok(every.perimeter.filter((pt) => pt.confirmed).length === every.counts.confirms);
    }],

    ['the time estimate scales with the budget and the step sizes', () => {
        const e = estimateTraceTime({ maxPerimeterMm: 330, fineStepMm: 0.1, coarseStepMm: 1, accuracyEveryMm: null, expectedCorners: 4 });
        assert.equal(e.worstSteps, 6600);
        assert.equal(e.bestSteps, 660);
        assert.equal(e.confirmCycles, 5);
        assert.ok(e.worstMinutes >= 30 && e.worstMinutes <= 40, `worst ${e.worstMinutes} min`);
        assert.ok(e.bestMinutes >= 3 && e.bestMinutes <= 5, `best ${e.bestMinutes} min`);
    }],
];
