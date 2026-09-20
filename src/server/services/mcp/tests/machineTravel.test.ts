import { strict as assert } from 'assert';

import { clampBand, describeClipping, resolveTravel } from '../machineTravel';

// The A350 as it actually is: a 320 x 350 definition, a machine frame that
// runs X -19...339, and a home position at X-19 Y342 that PROVES the low X
// end is reachable however the definition reads.
const A350 = { x: 320, y: 350 };
const NOTHING_STATED = { xMin: null, xMax: null, yMin: null, yMax: null };
const AT_HOME = { x: -19, y: 342 };

export const tests: Array<[string, () => void]> = [
    ['with nothing stated the travel is the machine definition', () => {
        const travel = resolveTravel({ size: A350, stated: NOTHING_STATED, observed: null });
        assert.deepEqual(travel.limits, { xMin: 0, xMax: 320, yMin: 0, yMax: 350 });
        assert.equal(travel.ends.xMin.source, 'nominal');
    }],

    ['a position the toolhead has occupied widens an unstated end - it is proof of reach', () => {
        const travel = resolveTravel({ size: A350, stated: NOTHING_STATED, observed: AT_HOME });
        assert.equal(travel.limits.xMin, -19);
        assert.equal(travel.ends.xMin.source, 'observed');
        // Y342 is INSIDE the nominal 0..350, so it changes nothing.
        assert.equal(travel.limits.yMax, 350);
        assert.equal(travel.ends.yMax.source, 'nominal');
    }],

    ['a stated limit beats both the definition and the observation', () => {
        const travel = resolveTravel({
            size: A350,
            stated: { xMin: -19, xMax: 339, yMin: 0, yMax: 342 },
            observed: AT_HOME,
        });
        assert.deepEqual(travel.limits, { xMin: -19, xMax: 339, yMin: 0, yMax: 342 });
        assert.equal(travel.ends.xMax.source, 'stated');
        assert.deepEqual(travel.conflicts, []);
    }],

    ['an observation outside a stated limit is a conflict, not a silent widening', () => {
        // Someone stated X can only reach 0, but the machine is sitting at -19.
        const travel = resolveTravel({
            size: A350,
            stated: { xMin: 0, xMax: null, yMin: null, yMax: null },
            observed: AT_HOME,
        });
        assert.equal(travel.limits.xMin, 0, 'the operator still wins');
        assert.equal(travel.conflicts.length, 1);
        assert.match(travel.conflicts[0], /observed at X -19/);
    }],

    ['an unknown machine with nothing stated has no honest travel at all', () => {
        assert.equal(resolveTravel({ size: null, stated: NOTHING_STATED, observed: AT_HOME }), null);
    }],

    ['an unknown machine with every end stated is planned from those', () => {
        const travel = resolveTravel({
            size: null,
            stated: { xMin: -19, xMax: 339, yMin: 0, yMax: 342 },
            observed: null,
        });
        assert.deepEqual(travel.limits, { xMin: -19, xMax: 339, yMin: 0, yMax: 342 });
    }],

    // The bug this exists to stop: a symmetric reach around an off-centre
    // target, planned past the end of the machine.
    ['a reach that overruns the low end is clipped and says how much it lost', () => {
        const band = clampBand(79, 200, -19, 339);
        assert.equal(band.min, -19);
        assert.equal(band.max, 279);
        assert.equal(band.clippedLowMm, 102, '79 - 200 = -121, which is 102 mm below the travel');
        assert.equal(band.clippedHighMm, 0);
    }],

    ['a reach that fits loses nothing', () => {
        const band = clampBand(79, 98, -19, 339);
        assert.deepEqual([band.min, band.max, band.clippedLowMm, band.clippedHighMm], [-19, 177, 0, 0]);
    }],

    ['a reach that overruns BOTH ends is clipped at both', () => {
        const band = clampBand(160, 400, -19, 339);
        assert.equal(band.min, -19);
        assert.equal(band.max, 339);
        assert.equal(band.clippedLowMm, 221);
        assert.equal(band.clippedHighMm, 221);
    }],

    ['a target near the high edge clips the high side, not the low', () => {
        // The "nearer another edge" case: a setter at X330 on a 339 limit.
        const band = clampBand(330, 100, -19, 339);
        assert.equal(band.min, 230);
        assert.equal(band.max, 339);
        assert.equal(band.clippedLowMm, 0);
        assert.equal(band.clippedHighMm, 91);
    }],

    ['a zero span is a single line at the target, not an error', () => {
        const band = clampBand(293, 0, 0, 342);
        assert.deepEqual([band.min, band.max], [293, 293]);
    }],

    ['a target outside the travel collapses onto the nearest reachable point', () => {
        // Never a waypoint the toolhead cannot reach, whatever was asked for.
        const band = clampBand(400, 50, -19, 339);
        assert.equal(band.min, 339);
        assert.equal(band.max, 339);
    }],

    ['an inverted travel is a programming error, not a band', () => {
        assert.throws(() => clampBand(0, 10, 100, 50), /below its minimum/);
    }],

    ['clipping is described only when something was actually lost', () => {
        assert.equal(describeClipping('X', clampBand(79, 98, -19, 339)), null);
        const text = describeClipping('X', clampBand(79, 200, -19, 339));
        assert.match(text, /102 mm below X-19/);
        assert.match(text, /not planned/);
    }],
];
