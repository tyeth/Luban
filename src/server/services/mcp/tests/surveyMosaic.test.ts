import { strict as assert } from 'assert';

import {
    FramePlacement,
    MAX_MOSAIC_PX,
    MIN_PITCH_MM,
    machineToMosaicPixel,
    mosaicPixelToMachine,
    pitchForOverlap,
    planMosaic,
    seamCoverage,
} from '../surveyMosaic';

function frames(centres: Array<[number, number]>, w = 100, h = 60): FramePlacement[] {
    return centres.map(([x, y]) => ({ centre: { x, y }, widthMm: w, heightMm: h }));
}

export const tests: Array<[string, () => void]> = [
    // E1: a pitch is only "seamless" relative to a field of view.
    ['the pitch falls out of the field of view and the overlap asked for', () => {
        assert.deepEqual(pitchForOverlap(100, 60, 0.3), { x: 70, y: 42 });
        assert.deepEqual(pitchForOverlap(100, 60, 0), { x: 100, y: 60 }, 'no overlap, frames just touch');
        assert.deepEqual(pitchForOverlap(100, 60, 0.5), { x: 50, y: 30 });
    }],

    ['an absurd overlap is clamped rather than producing a pitch of nothing', () => {
        const tight = pitchForOverlap(100, 60, 0.99);
        assert.equal(tight.x, MIN_PITCH_MM);
        assert.equal(tight.y, MIN_PITCH_MM);
        assert.deepEqual(pitchForOverlap(1000, 1000, 0), { x: 160, y: 160 }, 'and a huge frame is still capped');
    }],

    // E3: the mosaic is indexed in machine coordinates, so reading a feature's
    // position off it is a lookup rather than an inference.
    ['the mosaic covers every frame and its affine round-trips', () => {
        const layout = planMosaic(frames([[100, 100], [170, 100], [100, 142]]), 0.25);
        assert.ok(layout);
        const m = layout as NonNullable<typeof layout>;
        assert.deepEqual(m.bounds, { xMin: 50, xMax: 220, yMin: 70, yMax: 172 });
        assert.equal(m.mmPerPixel, 0.25);
        assert.equal(m.widthPx, Math.ceil(170 / 0.25));
        assert.equal(m.heightPx, Math.ceil(102 / 0.25));

        const point = { x: 123.5, y: 140.25 };
        const px = machineToMosaicPixel(m, point.x, point.y);
        const back = mosaicPixelToMachine(m, px.u, px.v);
        assert.ok(Math.abs(back.x - point.x) < 1e-9);
        assert.ok(Math.abs(back.y - point.y) < 1e-9);
    }],

    ['machine Y runs up the picture, not down it', () => {
        const m = planMosaic(frames([[100, 100]]), 0.5) as NonNullable<ReturnType<typeof planMosaic>>;
        const top = machineToMosaicPixel(m, 100, m.bounds.yMax);
        const bottom = machineToMosaicPixel(m, 100, m.bounds.yMin);
        assert.equal(top.v, 0);
        assert.ok(bottom.v > top.v, 'the largest machine Y is the top row');
        assert.equal(m.affine.yFlipped, true);
    }],

    ['a whole-bed mosaic is coarsened rather than refused', () => {
        const wide = frames([[0, 0], [320, 340]], 200, 200);
        const m = planMosaic(wide, 0.05) as NonNullable<ReturnType<typeof planMosaic>>;
        assert.ok(m.widthPx <= MAX_MOSAIC_PX, `${m.widthPx}`);
        assert.ok(m.heightPx <= MAX_MOSAIC_PX, `${m.heightPx}`);
        assert.ok(m.mmPerPixel > 0.05, 'the scale gives way, not the coverage');
        // The affine still describes the coarsened picture exactly.
        const back = mosaicPixelToMachine(m, m.widthPx, 0);
        assert.ok(Math.abs(back.x - m.bounds.xMax) < m.mmPerPixel);
    }],

    ['nothing to place is null, not an empty canvas', () => {
        assert.equal(planMosaic([], 0.25), null);
        assert.equal(planMosaic(frames([[0, 0]]), 0), null);
    }],

    // E4: the seams ARE the drift check, so their absence matters.
    ['overlap is measured, and a grid that does not overlap says so', () => {
        const overlapping = seamCoverage(frames([[100, 100], [170, 100]]));
        assert.equal(overlapping.pairs, 1);
        assert.ok(overlapping.overlapFraction > 0.2, `${overlapping.overlapFraction}`);

        const apart = seamCoverage(frames([[100, 100], [400, 100]]));
        assert.equal(apart.pairs, 0);
        assert.equal(apart.overlapFraction, 0,
            'no shared ground: nothing to stitch on, and no way to notice a knocked camera');
    }],

    ['a 30% pitch really does leave about 30% shared', () => {
        const pitch = pitchForOverlap(100, 60, 0.3);
        const coverage = seamCoverage(frames([[0, 0], [pitch.x, 0]]));
        assert.ok(Math.abs(coverage.overlapFraction - 0.3) < 0.02, `${coverage.overlapFraction}`);
    }],
];
