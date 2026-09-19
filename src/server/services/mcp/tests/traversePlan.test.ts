import { strict as assert } from 'assert';

import { ObstacleBox } from '../envelopeChecks';
import { TraversePlanError, TraversePlanInput, mayDescend, planRaiseToTop, planToolSetterEnd, planTraverseXy } from '../traversePlan';

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
        assert.equal(plan.steps[0].to.z, 328, 'segments are planned at the height the head is at');
        refuses(() => planTraverseXy(input({ currentMachine: { x: -19, y: 342, z: 327.9 } })), 'below the motion floor');
    }],

    ['refused below the motion floor, with no override', () => {
        refuses(() => planTraverseXy(input({ currentMachine: { x: 100, y: 100, z: 320 } })), 'below the motion floor 328');
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

    ['abort retreat law: job fd7fa6cb6396 aborted at home (Z 327.999) - nothing is sent, never a plunge to the start height', () => {
        const atHome = planRaiseToTop(327.9989959716797, 328);
        assert.equal(atHome.action, 'skip', 'the head is already at the top within the float tolerance');
        assert.equal(atHome.targetZ, 328);
        const exact = planRaiseToTop(328, 328);
        assert.equal(exact.action, 'skip');
    }],

    ['abort retreat law: below the top the retreat is a Z-only raise TO the traverse height, whatever the start height was', () => {
        const midDescent = planRaiseToTop(205.5, 328);
        assert.equal(midDescent.action, 'raise');
        assert.equal(midDescent.targetZ, 328);
        const justUnder = planRaiseToTop(327.9, 328);
        assert.equal(justUnder.action, 'raise', '0.1 mm under the top is a real shortfall, not float noise');
        const unknown = planRaiseToTop(null, 328);
        assert.equal(unknown.action, 'raise', 'an unknown Z still gets the one move that cannot descend');
        assert.equal(unknown.targetZ, 328);
        assert.ok(unknown.reason.includes('unknown'));
    }],

    ['issue #91: a COMPLETED tool setter run ends at the traverse height - a Z-only raise from the trigger, never the start height', () => {
        // The live rig: trigger ~175.5 with the 75 mm reference, start height ~235, top 328.
        const done = planToolSetterEnd(false, 175.5, 328);
        assert.equal(done.action, 'raise');
        assert.equal(done.targetZ, 328, 'the raise targets the traverse height, not the 235 start height');
        assert.ok(done.reason.includes('raise from machine Z 175.500 to the traverse height 328'), done.reason);
        // The success path and the abort path make the same decision from the same Z.
        assert.deepEqual(done, planRaiseToTop(175.5, 328));
    }],

    ['issue #91: already at the traverse height (float noise included) - nothing is sent', () => {
        const atTop = planToolSetterEnd(false, 327.9989959716797, 328);
        assert.equal(atTop.action, 'skip');
        assert.equal(atTop.targetZ, 328);
        assert.equal(planToolSetterEnd(false, 328, 328).action, 'skip');
        assert.equal(planToolSetterEnd(false, 327.9, 328).action, 'raise', '0.1 mm under the top is a real shortfall');
    }],

    ['issue #91: stay_at_trigger (touchscreen swap wizard) holds in contact - no retreat of any kind', () => {
        const held = planToolSetterEnd(true, 175.5, 328);
        assert.equal(held.action, 'hold');
        assert.equal(held.targetZ, 175.5, 'the head stays at the measured trigger');
        assert.ok(held.reason.includes('no retreat'), held.reason);
        // Holding wins even when a raise would otherwise be due or skipped.
        assert.equal(planToolSetterEnd(true, 328, 328).action, 'hold');
        assert.equal(planToolSetterEnd(true, null, 328).action, 'hold');
    }],

    ['mayDescend: a "back to the start" leg is skipped only when the start is below the head', () => {
        assert.equal(mayDescend(328, 205.5), true, 'abort before the tool-setter travel: start height is 122 mm below');
        assert.equal(mayDescend(200, 205.5), false, 'mid-march: the start is above the contact - retreating to it is a lift');
        assert.equal(mayDescend(205.5, 205.5), false);
        assert.equal(mayDescend(205.52, 205.5), false, 'within the float tolerance is not a descent');
        assert.equal(mayDescend(null, 205.5), true, 'unknown Z: a descent cannot be ruled out, so the leg is skipped and only the raise runs');
    }],

    ['empty, over-long and axis-less target lists are refused', () => {
        refuses(() => planTraverseXy(input({ targets: [] })), 'Provide 1-20');
        refuses(() => planTraverseXy(input({ targets: new Array(21).fill({ x: 1 }) })), 'Provide 1-20');
        refuses(() => planTraverseXy(input({ targets: [{}] })), 'names neither x nor y');
    }],

    // C1: transport is allowed at the motion floor, not only at the park
    // height. The two were one number until 2026-09-19, which is why the park
    // height sat at the ceiling.
    ['transport is allowed at the motion floor and refused below it', () => {
        // A target clear of the rotary box: the floor is about law 2, and the
        // landmark check is exercised separately below.
        const at = (z: number) => planTraverseXy({
            ...input(),
            targets: [{ x: 100, y: 105 }],
            currentMachine: { x: 20, y: 105, z },
            traverseZ: 328,
            motionFloorZ: 320,
        });
        assert.ok(at(328), 'at the park height');
        assert.ok(at(320), 'at the floor');
        assert.ok(at(319.96), 'and a float-noise hair below it');
        assert.throws(() => at(319.9), /below the motion floor 320/);
    }],

    ['the segments are planned where the head actually is, not at the park height', () => {
        const plan = planTraverseXy({
            ...input(),
            targets: [{ x: 100, y: 105 }],
            currentMachine: { x: 20, y: 105, z: 321 },
            traverseZ: 328,
            motionFloorZ: 320,
        });
        assert.equal(plan.steps[0].from.z, 321, 'a corridor the toolhead is actually in');
        assert.equal(plan.steps[0].to.z, 321);
    }],

    ['a landmark is checked at the real height - no exemption for being high', () => {
        // The rotary landmark's clearance is the park height, so transport at
        // the floor across it is refused. That is the point of the floor being
        // safe: the registry does the work the blanket height used to.
        assert.throws(
            () => planTraverseXy({
                ...input(),
                targets: [{ x: 290, y: 105 }],
                currentMachine: { x: 20, y: 105, z: 320 },
                traverseZ: 328,
                motionFloorZ: 320,
                obstacles: [ROTARY],
            }),
            /crosses a landmark/
        );
    }],

    ['omitting the floor keeps the old behaviour exactly', () => {
        assert.throws(
            () => planTraverseXy({ ...input(), currentMachine: { x: 20, y: 105, z: 321 }, traverseZ: 328 }),
            /below the motion floor 328/
        );
    }],
];
