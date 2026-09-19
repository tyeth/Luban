import { strict as assert } from 'assert';

import { WORK_FRAME_RESTORE_GCODE, frameRestoreIsWorthTrying, resyncHint } from '../frameRecovery';
import { resolveJobFrame, validateGcode } from '../validator';

export const tests: Array<[string, () => void]> = [
    ['the frame restore carries no motion at all', () => {
        const report = validateGcode(WORK_FRAME_RESTORE_GCODE);
        assert.equal(report.motionLineCount, 0, 'no motion lines');
        assert.deepEqual(report.extents, { x: null, y: null, z: null, b: null }, 'no axis words');
        assert.equal(report.spindle.onCommands, 0);
        assert.equal(report.setsWorkOrigin, false, 'restoring the frame is not a G92 origin rewrite');
    }],

    ['the frame restore selects the work workspace and states its distance mode', () => {
        const report = validateGcode(WORK_FRAME_RESTORE_GCODE);
        assert.deepEqual(report.frame.workspaceSelects, ['G54'], 'G54 on its own line');
        assert.equal(report.assumesDistanceMode, false, 'G90 is explicit - the validator refuses a file that assumes it');
        assert.deepEqual(report.frame.inlineG53Lines, [], 'nothing is carried on a motion line');
        // `declared` answers "which frame is in force at the first MOVE", and
        // there is no move: a frame restore changes the workspace without
        // running in it. That is the whole point.
        assert.equal(report.frame.declared, null);
        assert.equal(report.frame.firstMotionLine, null);
    }],

    ['the frame restore would itself pass staging (it is a legal job, not a special case)', () => {
        const resolved = resolveJobFrame(validateGcode(WORK_FRAME_RESTORE_GCODE), {
            frameArgument: null,
            originOffsetZ: 0,
            offsetReliable: true,
            machineZMax: 328,
        });
        assert.equal(resolved.refusal, null, 'a no-motion job needs no frame handshake');
    }],

    ['an incoherent position is told to restore the frame, not to re-home', () => {
        const hint = resyncHint('awaiting-resync');
        assert.ok(/restore_work_frame/.test(hint), 'names the remedy');
        assert.ok(/no motion/.test(hint), 'says why it is allowed');
        assert.ok(/re-home is not the remedy/.test(hint));
    }],

    ['a stale position is told to reconnect - the frame is not the problem', () => {
        const hint = resyncHint('stale');
        assert.ok(/[Rr]econnect/.test(hint));
        assert.ok(!/restore_work_frame/.test(hint), 'a dead connection is not a frame fault');
    }],

    ['a usable position gets no hint at all', () => {
        assert.equal(resyncHint('verified'), '');
        assert.equal(resyncHint('heartbeat'), '');
        assert.equal(resyncHint('cached-offset'), '');
    }],

    ['the restore is worth trying exactly when the position is unusable', () => {
        assert.equal(frameRestoreIsWorthTrying('awaiting-resync'), true);
        assert.equal(frameRestoreIsWorthTrying('stale'), true);
        assert.equal(frameRestoreIsWorthTrying('verified'), false);
        assert.equal(frameRestoreIsWorthTrying('heartbeat'), false);
        assert.equal(frameRestoreIsWorthTrying('cached-offset'), false);
    }],
];
