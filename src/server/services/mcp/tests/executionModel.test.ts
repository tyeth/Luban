import { strict as assert } from 'assert';

import { ExecutionEstimator, lineDurationsMs } from '../executionModel';
import { parseSpindleProgram } from '../spindleProgram';

// A raster like the levelling skim: 81 mm passes at F500 (9.72 s each) with
// 4 mm steps (0.48 s), preceded by a spindle dwell and a plunge.
function raster(passes: number): { text: string; program: ReturnType<typeof parseSpindleProgram>; passLine: (k: number) => number } {
    const lines = ['G90', 'G54', 'G0 X-40.5 Y11.2', 'G0 Z10', 'M3 S8000', 'G4 P3000', 'G1 Z-1 F200'];
    const passLines: number[] = [];
    for (let k = 0; k < passes; k++) {
        const y = 11.2 + 4 * k;
        passLines.push(lines.length + 1);
        lines.push(`G1 X${k % 2 === 0 ? 40.5 : -40.5} Y${y} F500`);
        if (k + 1 < passes) {
            lines.push(`G1 Y${y + 4} F500`);
        }
    }
    lines.push('G0 Z5', 'M5');
    const text = lines.join('\n');
    return { text, program: parseSpindleProgram(text), passLine: (k) => passLines[k] };
}

export const tests: Array<[string, () => void]> = [
    ['line durations: feed moves by length / F, rapids at the rapid feed, dwells by P', () => {
        const { text, program } = raster(2);
        const ms = lineDurationsMs(program, text);
        assert.equal(ms[0], 0, 'G90');
        assert.equal(ms[2], 0, 'first rapid from an unknown position has no length');
        assert.equal(ms[3], 0, 'G0 Z10 from an unknown Z has no length either');
        assert.equal(ms[5], 3000, 'G4 P3000');
        assert.equal(Math.round(ms[6]), 3300, 'plunge 11 mm at F200');
        assert.equal(Math.round(ms[7]), 9720, '81 mm pass at F500');
        assert.equal(Math.round(ms[8]), 480, '4 mm step');
    }],

    ['the queue leads by the buffer depth; the estimate follows the file timing behind it', () => {
        const { text, program, passLine } = raster(30);
        const est = new ExecutionEstimator(program, text, 16);
        // t = 0: nothing queued yet.
        let e = est.update(0, null);
        assert.ok(e.line <= 6, `at t = 0 the zero-length setup lines are done and the dwell is in progress: line ${e.line}`);
        // Dwell over at ~3.5 s, plunge to ~6.8 s; the planner fills 16 blocks
        // at once: the reported position is pass 8's end.
        e = est.update(7000, passLine(8));
        assert.ok(e.line >= 7 && e.line <= passLine(0), `during the plunge / start of pass 1: line ${e.line}`);
        // 30 s later (t = 37 s): pass 4 is executing (3.1 passes since 6.8 s); the queue reports pass 11.
        e = est.update(37000, passLine(11));
        assert.equal(e.line, passLine(3), `pass 4 at 37 s: line ${e.line}`);
        assert.equal(e.mode, 'time');
        assert.ok(e.leadBlocks !== null && e.leadBlocks >= 14 && e.leadBlocks <= 16, `lead ${e.leadBlocks}`);
        // Never past the queue: a wildly late report still caps the estimate.
        e = est.update(400000, passLine(12));
        assert.equal(e.line, passLine(12));
        assert.equal(e.mode, 'queue-upper');
    }],

    ['never more than the buffer behind the queue, and never backwards', () => {
        const { text, program, passLine } = raster(30);
        const est = new ExecutionEstimator(program, text, 16);
        est.update(0, null);
        // The clock says pass 1 but the queue is already at pass 20: the head must be within 16 blocks.
        const e = est.update(8000, passLine(20));
        assert.equal(e.mode, 'queue-lower');
        assert.ok(e.leadBlocks !== null && e.leadBlocks <= 16, `lead ${e.leadBlocks}`);
        const later = est.update(8500, passLine(20));
        assert.ok(later.line >= e.line, 'monotonic');
    }],

    ['the end of the file is not a sync: the head keeps running its buffered passes after the queue reads M5', () => {
        const { text, program, passLine } = raster(30);
        const est = new ExecutionEstimator(program, text, 16);
        est.update(0, null);
        // Steady state: the queue 8 passes ahead of the cutter (a pass is 10.2 s).
        for (let t = 7000; t <= 215000; t += 5000) {
            const q = Math.min(29, Math.floor((t - 6300) / 10200) + 8);
            est.update(t, passLine(q));
        }
        // The queue reaches the last pass at ~220 s; the matcher then sits on
        // the file's trailing M5 (a non-motion line) while the head still has
        // eight passes (~80 s) to run.
        const last = program.lines.length; // M5
        est.update(220000, passLine(29));
        est.update(226000, last);
        const mid = est.update(260000, last);
        assert.ok(mid.line >= passLine(22) && mid.line < passLine(29), `on a buffered pass at 260 s: line ${mid.line}`);
        assert.equal(mid.mode, 'time');
        const done = est.update(400000, last);
        assert.equal(done.line, last, 'eventually at the end');
    }],

    ['a dwell is a planner sync: the frozen reported position resuming re-anchors the clock', () => {
        // Two cuts separated by a 4 s dwell (E4 style).
        const text = ['G90', 'M3 S8000', 'G0 X0 Y0', 'G1 X50 F500', 'G4 P4000', 'G1 X0 F500', 'G4 P4000', 'M5'].join('\n');
        const program = parseSpindleProgram(text);
        const est = new ExecutionEstimator(program, text, 16);
        est.update(0, null);
        // The queue reaches the first cut's end at once; the position matcher
        // reports the dwell after it (endpoint mode) and freezes there.
        est.update(500, 5);
        est.update(3000, 5);
        est.update(9000, 5);
        // At 10.5 s the reported position moves on to line 6: the dwell (line 5) has just ended.
        const e = est.update(10500, 6);
        assert.equal(e.mode, 'anchor');
        assert.equal(e.line, 6, 'the dwell just finished: the second cut is starting');
        // 3 s later the second cut (6 s long) is executing.
        const f = est.update(13500, 6);
        assert.equal(f.line, 6);
        assert.equal(f.mode, 'time');
    }],
];
