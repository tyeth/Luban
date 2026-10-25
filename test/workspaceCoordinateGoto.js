import { test } from 'tape';
import { parseCoordinate, planCoordinateGoto } from '../src/app/ui/widgets/ConnectionControl/coordinateGoto';

const base = {
    axis: 'x',
    frame: 'work',
    initial: '10.000',
    originOffset: { x: 25, y: -5, z: 2, b: 0 },
    isPrinting: false,
    jogSpeed: 1500,
    travel: null
};

test('parseCoordinate accepts plain decimals only', (t) => {
    t.equal(parseCoordinate('12.5'), 12.5);
    t.equal(parseCoordinate(' -3 '), -3);
    t.equal(parseCoordinate('+.5'), 0.5);
    t.equal(parseCoordinate('7.'), 7);
    for (const bad of ['', ' ', '-', '.', '+', '1e3', '1e999', 'abc', '12,5', '1.2.3', 'NaN', 'Infinity']) {
        t.equal(parseCoordinate(bad), null, `rejects ${JSON.stringify(bad)}`);
    }
    t.end();
});

test('a work-frame edit moves that axis in the work frame', (t) => {
    const result = planCoordinateGoto({ ...base, raw: '42.25' });
    t.equal(result.kind, 'move');
    t.equal(result.gcode, 'G90\nG0 X42.25 F1500');
    t.equal(result.workTarget, 42.25);
    t.equal(result.machineTarget, 17.25, 'machine = work - offset, as the table displays it');
    t.end();
});

test('a machine-frame edit adds the origin offset back', (t) => {
    const result = planCoordinateGoto({ ...base, axis: 'y', frame: 'machine', initial: '0.000', raw: '100' });
    t.equal(result.kind, 'move');
    t.equal(result.workTarget, 95);
    t.equal(result.machineTarget, 100);
    t.equal(result.gcode, 'G90\nG0 Y95 F1500');
    t.end();
});

test('the printing head shows machine = work, so no offset applies', (t) => {
    const result = planCoordinateGoto({ ...base, axis: 'z', frame: 'machine', initial: '1.000', isPrinting: true, raw: '20' });
    t.equal(result.gcode, 'G90\nG0 Z20 F1500');
    t.end();
});

test('unchanged and retyped values do not move', (t) => {
    t.equal(planCoordinateGoto({ ...base, raw: '10.000' }).kind, 'unchanged');
    t.equal(planCoordinateGoto({ ...base, raw: '10' }).kind, 'unchanged');
    t.equal(planCoordinateGoto({ ...base, raw: ' 10.0004 ' }).kind, 'unchanged');
    t.equal(planCoordinateGoto({ ...base, raw: '10.001' }).kind, 'move');
    t.end();
});

test('non-numeric input is refused, never sent', (t) => {
    const result = planCoordinateGoto({ ...base, raw: 'abc' });
    t.equal(result.kind, 'invalid');
    t.equal(result.gcode, undefined);
    t.end();
});

test('rounding: three decimals, no -0, no float noise', (t) => {
    t.equal(planCoordinateGoto({ ...base, originOffset: { x: 0.1 }, frame: 'machine', initial: '5', raw: '0.2' }).gcode, 'G90\nG0 X0.3 F1500');
    t.equal(planCoordinateGoto({ ...base, initial: '5', raw: '-0.0001' }).gcode, 'G90\nG0 X0 F1500');
    t.end();
});

test('no feed word without a usable jog speed', (t) => {
    t.equal(planCoordinateGoto({ ...base, jogSpeed: NaN, raw: '1' }).gcode, 'G90\nG0 X1');
    t.end();
});

test('Ray travel: the machine target must be inside the work area', (t) => {
    const ray = { ...base, travel: { x: 600, y: 400 } };
    const inside = planCoordinateGoto({ ...ray, frame: 'machine', initial: '1', raw: '600' });
    t.equal(inside.kind, 'move', 'the far edge is allowed');
    const past = planCoordinateGoto({ ...ray, frame: 'machine', initial: '1', raw: '600.5' });
    t.deepEqual(past, { kind: 'outside-travel', machineTarget: 600.5, min: 0, max: 600 });
    const below = planCoordinateGoto({ ...ray, frame: 'work', raw: '20' });
    t.equal(below.kind, 'outside-travel', 'work 20 with offset 25 is machine -5');
    t.equal(below.machineTarget, -5);
    const z = planCoordinateGoto({ ...ray, axis: 'z', frame: 'machine', initial: '1', raw: '-50' });
    t.equal(z.kind, 'move', 'only X and Y carry a travel limit');
    t.end();
});
