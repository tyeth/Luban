import { strict as assert } from 'assert';

import { MotionSegment, ObstacleBox, checkMotion } from '../envelopeChecks';

// The rotary-axis landmark as stored on the A350: X140-200 x Y0-350, clearance 328
// (the box includes the tailstock, whose height is unmeasured).
const ROTARY: ObstacleBox = { name: 'rotary-axis', machine: { x0: 140, y0: 0, x1: 200, y1: 350 }, clearanceZ: 328, mode: 'crossing' };
// A program keep-out for the chuck jaws: a VOLUME nothing enters.
const JAWS: ObstacleBox = { name: 'chuck jaws', machine: { x0: 150, y0: 269, x1: 190, y1: 310 }, clearanceZ: 250, mode: 'volume' };

function hop(z: number, fromX: number, toX: number, y = 105): MotionSegment {
    return { what: `hop at Z${z}`, kind: 'hop', from: { x: fromX, y, z }, to: { x: toX, y, z } };
}

export const tests: Array<[string, () => void]> = [
    ['a hop at 328 across the rotary footprint passes on its own merits (no exemption needed)', () => {
        const v = checkMotion([hop(328, 20, 290)], [ROTARY], { traverseZ: 328 });
        assert.deepEqual(v, []);
    }],

    ['a hop at 320 across the rotary footprint is refused - the old exemption is gone', () => {
        const v = checkMotion([hop(320, 20, 290)], [ROTARY], { traverseZ: 320 });
        assert.equal(v.length, 1);
        assert.equal(v[0].obstacle, 'rotary-axis');
        assert.equal(v[0].z, 320);
        assert.equal(v[0].clearanceZ, 328);
    }],

    ['the exemption is gone even when the planner says 320 is its traverse height', () => {
        // This is exactly the case that used to `continue`: lowZ >= traverseZ.
        const v = checkMotion([hop(320, 20, 290)], [ROTARY], { traverseZ: 320 });
        assert.equal(v.length, 1);
    }],

    ['a low hop wholly INSIDE a crossing landmark is allowed (probing the stock is the job)', () => {
        const v = checkMotion([hop(220, 160, 180, 200)], [ROTARY], { traverseZ: 328 });
        assert.deepEqual(v, []);
    }],

    ['a march into a crossing landmark is allowed; a plain hop entering it low is not', () => {
        const march: MotionSegment = { what: 'march -X into stock', kind: 'march', from: { x: 230, y: 200, z: 220 }, to: { x: 190, y: 200, z: 220 } };
        assert.deepEqual(checkMotion([march], [ROTARY]), []);
        const entering: MotionSegment = { what: 'hop into stock', kind: 'hop', from: { x: 230, y: 200, z: 220 }, to: { x: 190, y: 200, z: 220 } };
        assert.equal(checkMotion([entering], [ROTARY]).length, 1);
    }],

    ['a volume keep-out refuses everything below its clearance, even a column and even at the traverse height', () => {
        const column: MotionSegment = { what: 'descend column', kind: 'column', from: { x: 170, y: 290, z: 328 }, to: { x: 170, y: 290, z: 240 } };
        assert.equal(checkMotion([column], [JAWS], { traverseZ: 328 }).length, 1);
        const low = checkMotion([hop(240, 100, 250, 290)], [JAWS], { traverseZ: 328 });
        assert.equal(low.length, 1);
        assert.deepEqual(checkMotion([hop(328, 100, 250, 290)], [JAWS], { traverseZ: 328 }), [], 'above the volume clearance is fine');
    }],
];
