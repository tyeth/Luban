import { strict as assert } from 'assert';

import { FRAME_REFUSAL_NO_RESTORE, FRAME_REFUSAL_UNDECLARED, FrameResolutionContext, resolveJobFrame, validateGcode } from '../validator';

const A350 = { machineZMax: 330 };

function ctx(over: Partial<FrameResolutionContext> = {}): FrameResolutionContext {
    return { frameArgument: null, originOffsetZ: -328, offsetReliable: true, ...A350, ...over };
}

// The job staged on 2026-09-12: absolute Z0 with no frame anywhere.
const TRANSIT_2026_09_12 = 'G90\nG0 Z0 F1000\nG0 X239 Y-17 F3000\n';
// What move_z emits for a machine-frame step.
const MOVE_Z_MACHINE = 'G90\nG53;\nG1 Z300.000 F300;\nG54;';
// What Luban's own CNC export looks like: G90, moves, no workspace select.
const LUBAN_EXPORT = ';Header Start\nG90\nG0 Z10 F1500\nG1 X10 Y10 F600\nG1 Z-1 F300\nG0 Z10\n';

export const tests: Array<[string, () => void]> = [
    ['G53 on its own line before the first move declares MACHINE', () => {
        const r = resolveJobFrame(validateGcode(MOVE_Z_MACHINE), ctx());
        assert.equal(r.refusal, null);
        assert.equal(r.report.frame.declared, 'machine');
        assert.equal(r.report.frame.source, 'gcode');
        assert.equal(r.report.frame.line, 2);
        assert.equal(r.report.frame.firstMotionLine, 3);
        assert.equal(r.report.frame.mixed, false, 'a trailing G54 with no motion after it is not mixed');
        assert.deepEqual(r.report.machineZExtents, { min: 300, max: 300 });
    }],

    ['G54 before the first move declares WORK and resolves Z through the offset', () => {
        const r = resolveJobFrame(validateGcode('G90\nG54\nG0 Z10\nG1 Z-2\n'), ctx({ originOffsetZ: -200 }));
        assert.equal(r.refusal, null);
        assert.equal(r.report.frame.declared, 'work');
        assert.equal(r.report.frame.source, 'gcode');
        assert.deepEqual(r.report.frame.workspaceSelects, ['G54']);
        assert.deepEqual(r.report.machineZExtents, { min: 198, max: 210 });
        assert.equal(r.report.originOffsetZAtStaging, -200);
    }],

    ['a Luban export (no workspace select) is accepted with frame:"work" and left byte-identical', () => {
        const r = resolveJobFrame(validateGcode(LUBAN_EXPORT), ctx({ frameArgument: 'work', originOffsetZ: -150 }));
        assert.equal(r.refusal, null);
        assert.equal(r.report.frame.declared, 'work');
        assert.equal(r.report.frame.source, 'argument');
        assert.equal(r.report.frame.line, null);
        assert.deepEqual(r.report.machineZExtents, { min: 149, max: 160 });
    }],

    ['undeclared with no argument is REFUSED', () => {
        const r = resolveJobFrame(validateGcode(LUBAN_EXPORT), ctx());
        assert.equal(r.refusal, FRAME_REFUSAL_UNDECLARED);
        assert.equal(r.report.frame.declared, null);
    }],

    ['the 2026-09-12 transit job is refused as undeclared', () => {
        const r = resolveJobFrame(validateGcode(TRANSIT_2026_09_12), ctx());
        assert.equal(r.refusal, FRAME_REFUSAL_UNDECLARED);
        assert.equal(r.report.frame.firstMotionLine, 2);
    }],

    ['the 2026-09-12 transit job with frame:"work" names where work Z0 lands in machine Z', () => {
        const r = resolveJobFrame(validateGcode(TRANSIT_2026_09_12), ctx({ frameArgument: 'work', originOffsetZ: -328 }));
        assert.equal(r.refusal, null);
        assert.deepEqual(r.report.machineZExtents, { min: 328, max: 328 });
        assert.ok(r.report.warnings.some((w) => w.includes('work Z0 is machine Z 328.000')), r.report.warnings.join('\n'));
    }],

    ['frame:"machine" without a literal G53 is refused', () => {
        const r = resolveJobFrame(validateGcode(LUBAN_EXPORT), ctx({ frameArgument: 'machine' }));
        assert.ok(r.refusal && r.refusal.includes('no G53 before its first move'), String(r.refusal));
    }],

    ['a declaration that contradicts the argument is refused both ways', () => {
        const a = resolveJobFrame(validateGcode(MOVE_Z_MACHINE), ctx({ frameArgument: 'work' }));
        assert.ok(a.refusal && a.refusal.includes('declares G53'), String(a.refusal));
        const b = resolveJobFrame(validateGcode('G90\nG54\nG0 Z10\n'), ctx({ frameArgument: 'machine' }));
        assert.ok(b.refusal && b.refusal.includes('selects a work workspace'), String(b.refusal));
    }],

    ['inline "G53 G0 ..." is not a declaration on this controller and is flagged', () => {
        const report = validateGcode('G90\nG53 G0 X10 Y10\nG0 Z5\n');
        assert.deepEqual(report.frame.inlineG53Lines, [2]);
        assert.equal(report.frame.declared, null);
        assert.equal(report.motionLineCount, 2, 'the inline line still counts as motion');
        assert.ok(report.warnings.some((w) => w.includes('does NOT honour a one-shot G53')));
        assert.equal(resolveJobFrame(report, ctx()).refusal, FRAME_REFUSAL_UNDECLARED);
    }],

    ['motion under both frames is reported as mixed', () => {
        const report = validateGcode('G90\nG53\nG1 Z300\nG54\nG1 Z10\n');
        assert.equal(report.frame.declared, 'machine');
        assert.equal(report.frame.mixed, true);
        assert.ok(report.warnings.some((w) => w.includes('BOTH frames')));
    }],

    ['G92 is flagged as a work-origin rewrite', () => {
        const report = validateGcode('G90\nG53\nG92 Z0\nG1 Z10\n');
        assert.equal(report.setsWorkOrigin, true);
        assert.ok(report.warnings.some((w) => w.includes('REWRITES the work origin')));
    }],

    ['machine-frame Z outside the travel is warned, not refused', () => {
        const r = resolveJobFrame(validateGcode('G90\nG53\nG1 Z400\nG54\n'), ctx());
        assert.equal(r.refusal, null);
        assert.ok(r.report.warnings.some((w) => w.includes('outside the 0 .. 330 travel')));
    }],

    ['a work-frame job with an unreliable offset gets unresolved machine extents and a warning', () => {
        const r = resolveJobFrame(validateGcode('G90\nG54\nG1 Z10\n'), ctx({ offsetReliable: false }));
        assert.equal(r.refusal, null);
        assert.equal(r.report.machineZExtents, null);
        assert.ok(r.report.warnings.some((w) => w.includes('not reliable right now')));
    }],

    ['a file with no motion needs no frame', () => {
        const r = resolveJobFrame(validateGcode('; comment only\nG90\nM5\n'), ctx());
        assert.equal(r.refusal, null);
        assert.equal(r.report.frame.declared, null);
        assert.equal(r.report.frame.firstMotionLine, null);
    }],

    ['existing extents/feed/spindle facts still come out (regression)', () => {
        const report = validateGcode('G90\nG53\nM3 S8000\nG1 X10 Y20 Z-3 F600\nG1 X30\nM5\n');
        assert.deepEqual(report.extents.x, { min: 10, max: 30 });
        assert.deepEqual(report.extents.z, { min: -3, max: -3 });
        assert.deepEqual(report.feedRates, { min: 600, max: 600 });
        assert.equal(report.spindle.onCommands, 1);
        assert.equal(report.spindle.maxS, 8000);
        assert.equal(report.minZWithSpindleOn, -3);
        assert.equal(report.motionLineCount, 2);
    }],

    // A5: a machine-frame job must hand the frame back. Live 2026-09-19 a
    // hand-authored centre move ended in G53, the controller stayed in the
    // machine workspace, and every later beat was rejected until a re-home.
    ['a machine-frame job that never selects a work workspace again is refused', () => {
        const r = resolveJobFrame(validateGcode('G90\nG53\nG0 X160 Y175\n'), ctx());
        assert.equal(r.refusal, FRAME_REFUSAL_NO_RESTORE);
        assert.ok(/G54/.test(r.refusal as string), 'the refusal states the epilogue it wants');
        assert.equal(r.report.frame.endsInFrame, 'machine');
    }],

    ['the same job with a trailing G54 stages cleanly', () => {
        const r = resolveJobFrame(validateGcode('G90\nG53;\nG0 X160 Y175;\nG54;\n'), ctx());
        assert.equal(r.refusal, null);
        assert.equal(r.report.frame.declared, 'machine');
        assert.equal(r.report.frame.endsInFrame, 'work');
    }],

    ['every MCP emitter already ends in the work frame (regression)', () => {
        assert.equal(validateGcode(MOVE_Z_MACHINE).frame.endsInFrame, 'work');
    }],

    ['a work-frame job is unaffected - it never left the work workspace', () => {
        const r = resolveJobFrame(validateGcode('G90\nG54\nG0 X10 Y10\n'), ctx());
        assert.equal(r.refusal, null);
        assert.equal(r.report.frame.endsInFrame, 'work');
    }],

    ['a no-motion file is never asked for an epilogue', () => {
        const r = resolveJobFrame(validateGcode('G90\nG53;\n'), ctx());
        assert.equal(r.refusal, null, 'nothing ran, so nothing needs handing back');
    }],

    ['mixed frames: ending in work stages, ending in machine does not', () => {
        const ok = resolveJobFrame(validateGcode('G90\nG53;\nG0 X160;\nG54;\nG0 X5;\n'), ctx());
        assert.equal(ok.refusal, null);
        const bad = resolveJobFrame(validateGcode('G90\nG54;\nG0 X5;\nG53;\nG0 X160;\n'), ctx());
        assert.equal(bad.report.frame.endsInFrame, 'machine');
        assert.equal(bad.refusal, FRAME_REFUSAL_NO_RESTORE);
    }],
];
