import { strict as assert } from 'assert';

import { lineContext, parseSpindleProgram } from '../spindleProgram';

// The E4 spindle-load ladder as toolpaths.py writes it (abridged).
const E4 = `; E4_spindle_load - Spindle-load ladder
G21
G90
G54
G0 Z10
G0 X-44 Y70
M3 S18000
G4 P3000
; E4 C1 S18000 F200 baseline
G0 Y14
G0 Z-1
G1 Z-7 F400
G4 P4000
; E4 C1 S18000 F200 cut
G1 X44 F200
G4 P2000
G0 Z10
M3 S12000
G4 P3000
G0 X-44 Y26
G0 Z-1
G1 Z-7 F400
G4 P4000
G1 X44 F200
G4 P2000
G0 Z10
M5
G0 Z50`;

export const tests: Array<[string, () => void]> = [
    ['commanded S follows the M3 S words and M5 clears it', () => {
        const program = parseSpindleProgram(E4);
        const lines = E4.split('\n');
        const m5 = lines.indexOf('M5') + 1;
        assert.equal(program.lineCount, lines.length);
        assert.equal(program.epochs.length, 2);
        assert.deepEqual(program.epochs[0], { index: 0, line: lines.indexOf('M3 S18000') + 1, s: 18000 });
        assert.deepEqual(program.epochs[1], { index: 1, line: lines.indexOf('M3 S12000') + 1, s: 12000 });
        assert.equal(lineContext(program, 6)?.s, null, 'before M3');
        assert.equal(lineContext(program, 7)?.s, 18000);
        assert.equal(lineContext(program, 15)?.s, 18000);
        assert.equal(lineContext(program, lines.indexOf('M3 S12000') + 1)?.s, 12000);
        assert.equal(lineContext(program, m5 - 1)?.s, 12000);
        assert.equal(lineContext(program, m5)?.s, null, 'M5');
        assert.equal(lineContext(program, m5)?.epoch, -1);
        assert.equal(lineContext(program, m5 + 1)?.s, null);
    }],

    ['line kinds: feed moves load the spindle, rapids and dwells do not', () => {
        const program = parseSpindleProgram(E4);
        const kinds = program.lines.map((line) => line.kind);
        assert.equal(kinds[0], 'other', 'comment');
        assert.equal(kinds[4], 'rapid', 'G0 Z10');
        assert.equal(kinds[6], 'spindle', 'M3');
        assert.equal(kinds[7], 'dwell', 'G4');
        assert.equal(kinds[11], 'feed', 'G1 Z-7 plunge');
        assert.equal(kinds[14], 'feed', 'G1 X44 cut');
        assert.equal(kinds[E4.split('\n').indexOf('M5')], 'spindle', 'M5');
    }],

    ['feed in effect is carried forward from the last F word', () => {
        const program = parseSpindleProgram(E4);
        assert.equal(lineContext(program, 11)?.feed, null, 'no F yet');
        assert.equal(lineContext(program, 12)?.feed, 400);
        assert.equal(lineContext(program, 15)?.feed, 200);
        assert.equal(lineContext(program, 17)?.feed, 200, 'carried through the rapid');
    }],

    ['modal motion: a bare axis word after G1 is a feed move, after G0 a rapid', () => {
        const program = parseSpindleProgram('M3 S10000\nG1 X10 F300\nX20\nY5\nG0 X0\nY0\n');
        // The trailing newline is a (blank) line too - the controller counts it.
        assert.deepEqual(program.lines.map((line) => line.kind), ['spindle', 'feed', 'feed', 'feed', 'rapid', 'rapid', 'other']);
    }],

    ['a speed change while running, or a bare S word, starts a new epoch; a repeated M3 at the same S does not', () => {
        const program = parseSpindleProgram('M3 S8000\nG4 P1000\nM3 S8000\nS9000\nM3 S9000\nM4 S1000\n');
        assert.deepEqual(program.epochs.map((e) => [e.line, e.s]), [[1, 8000], [4, 9000], [6, 1000]]);
        assert.equal(program.lines[2].epoch, 0);
        assert.equal(program.lines[3].epoch, 1);
    }],

    ['comments in parentheses and after semicolons never command anything', () => {
        const program = parseSpindleProgram('(M3 S5000)\nG0 X1 ; M3 S6000\nM3 S7000 (spindle on)\n');
        assert.equal(program.epochs.length, 1);
        assert.equal(program.epochs[0].s, 7000);
        assert.equal(program.lines[1].kind, 'rapid');
    }],

    ['lineContext rejects numbers outside the file', () => {
        const program = parseSpindleProgram('G0 X1');
        assert.equal(lineContext(program, 0), null);
        assert.equal(lineContext(program, 2), null);
        assert.equal(lineContext(program, NaN), null);
        assert.equal(lineContext(program, 1)?.kind, 'rapid');
    }],
];
