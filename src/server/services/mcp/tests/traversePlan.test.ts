import { strict as assert } from 'assert';

import { ObstacleBox } from '../envelopeChecks';
import { TraversePlanError, TraversePlanInput, planTraverseXy } from '../traversePlan';

const BOUNDS = { min: { x: 0, y: 0, z: 0 }, max: { x: 320, y: 340, z: 330 } };
const OFFSET = { x: -51, y: -122, z: -328 };
const ROTARY: ObstacleBox = { name: 'rotary-axis', machine: { x0: 140, y0: 0, x1: 200, y1: 350 }, clearanceZ: 328, mode: 'crossing' };

function input(over: Partial<TraversePlanInput> = {}): TraversePlanInput {
    return {
        targets: [{ x: 290, y: 105 }],
        frame: 'machine',
        currentMachine: { x: -19, y: 342, z: 328 },
        originOffset: OFFSET,
        bounds: BOUNDS,
        traverseZ: 328,
        feedRate: 1500,
        obstacles: [ROTARY],
        reason: 'transit to the tailstock viewing pose',
        ...over,
    };
}

function refuses(fn: () => unknown, needle: string): void {
    try {
        fn();
    } catch (err) {
        assert.ok(err instanceof TraversePlanError, `expected TraversePlanError, got ${String(err)}`);
        assert.ok((err as Error).message.includes(needle), (err as Error).message);
        return;
    }
    assert.fail(`expected a refusal containing "${needle}"`);
}

export const tests: Array<[string, () => void]> = [
    ['the 2026-09-12 transit as a staged machine-frame traverse at 328: one declared step, no Z word', () => {
        const plan = planTraverseXy(input());
        assert.equal(plan.steps.length, 1);
        assert.equal(plan.steps[0].gcode, 'G90\nG53;\nG1 X290.000 Y105.000 F1500;\nG54;');
        assert.ok(!/Z/.test(plan.steps[0].gcode.replace(/G53|G54/g, '')), 'no Z word in an XY traverse');
        assert.equal(Math.round(plan.steps[0].distanceMm), 389);
        assert.ok(plan.header.includes('frame: machine coords'));
        assert.ok(plan.header.includes('Z does NOT change'));
        assert.ok(plan.name.startsWith('xy-traverse machine -> (290.0, 105.0)'));
    }],

    ['home reports 327.9989959716797 for Z328: that IS the traverse height (live refusal 2026-09-14)', () => {
        const plan = planTraverseXy(input({ currentMachine: { x: -19, y: 342, z: 327.9989959716797 } }));
        assert.equal(plan.steps.length, 1, 'the rotary landmark (clearance 328) must not refuse a 1 um shortfall either');
        assert.equal(plan.steps[0].to.z, 328, 'segments are planned at the traverse height');
        refuses(() => planTraverseXy(input({ currentMachine: { x: -19, y: 342, z: 327.9 } })), 'below the traverse height');
    }],

    ['refused below the traverse height, with no override', () => {
        refuses(() => planTraverseXy(input({ currentMachine: { x: 100, y: 100, z: 320 } })), 'below the traverse height 328');
    }],

    ['a series fills omitted axes from the previous target and reports every leg', () => {
        const plan = planTraverseXy(input({ targets: [{ x: 100 }, { y: 200 }, { x: 150, y: 250 }] }));
        assert.deepEqual(plan.steps.map((s) => s.target), [{ x: 100, y: 342 }, { x: 100, y: 200 }, { x: 150, y: 250 }]);
        assert.equal(plan.steps[1].gcode, 'G90\nG53;\nG1 X100.000 Y200.000 F1500;\nG54;');
        assert.ok(plan.reviewText.includes('; --- next approved step ---'));
        assert.ok(plan.name.startsWith('xy-series machine x3'));
        assert.ok(Math.abs(plan.totalDistanceMm - (119 + 142 + Math.hypot(50, 50))) < 0.01);
    }],

    ['work-frame targets convert through the offset for the checks and declare G54', () => {
        const plan = planTraverseXy(input({ frame: 'work', targets: [{ x: 239, y: -17 }] }));
        assert.deepEqual(plan.steps[0].to, { x: 290, y: 105, z: 328 });
        assert.equal(plan.steps[0].gcode, 'G90\nG54;\nG1 X239.000 Y-17.000 F1500');
        assert.ok(plan.header.includes('= machine (290.000, 105.000)'));
    }],

    ['a target outside the travel is refused, naming the axis and the machine coordinates', () => {
        refuses(() => planTraverseXy(input({ targets: [{ x: 400, y: 100 }] })), 'outside the travel on x');
        refuses(() => planTraverseXy(input({ frame: 'work', targets: [{ x: 0, y: 300 }] })), 'machine (51.000, 422.000)');
    }],

    ['the real overtravel is inside the margins (home X-19, Y342)', () => {
        const plan = planTraverseXy(input({ currentMachine: { x: 100, y: 100, z: 328 }, targets: [{ x: -19, y: 342 }] }));
        assert.equal(plan.steps.length, 1);
    }],

    ['a landmark taller than the current Z refuses the path and names it', () => {
        const tall: ObstacleBox = { ...ROTARY, name: 'tall-fixture', clearanceZ: 335 };
        refuses(() => planTraverseXy(input({ obstacles: [tall] })), 'tall-fixture');
    }],

    ['at 328 the rotary landmark (clearance 328) is crossed lawfully - no exemption involved', () => {
        const plan = planTraverseXy(input({ traverseZ: 328 }));
        assert.equal(plan.steps.length, 1);
    }],

    ['a lower configured traverse height with the head at that height refuses crossing the rotary box', () => {
        refuses(() => planTraverseXy(input({ traverseZ: 320, currentMachine: { x: -19, y: 342, z: 320 } })), 'rotary-axis');
    }],

    ['empty, over-long and axis-less target lists are refused', () => {
        refuses(() => planTraverseXy(input({ targets: [] })), 'Provide 1-20');
        refuses(() => planTraverseXy(input({ targets: new Array(21).fill({ x: 1 }) })), 'Provide 1-20');
        refuses(() => planTraverseXy(input({ targets: [{}] })), 'names neither x nor y');
    }],
];
