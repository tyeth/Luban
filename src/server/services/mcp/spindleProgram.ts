// The commanded spindle speed and motion kind at every line of a file job,
// so telemetry can align a status report or an audio frame to what the
// controller was told - by the line number the machine reports, not by
// guessing where a cut falls on a timeline.
//
// A file job runs on the machine's own interpreter; the status poll returns
// `currentLine` (1-based count of lines consumed). Commanded S at that line
// is the last `M3 S` / `M4 S` (or a bare `S` while the spindle is on) at or
// before it; the line's kind says whether the spindle is loaded (a G1/G2/G3
// feed move) or free (rapid, dwell, spindle command, comment).
//
// Pure: no server imports, unit-tested in tests/spindleProgram.test.ts.

export type LineKind = 'feed' | 'rapid' | 'dwell' | 'spindle' | 'other';

export interface ProgramLine {
    kind: LineKind;
    /** Commanded S in effect AFTER this line, null while the spindle is off. */
    s: number | null;
    /** Feed rate in effect after this line (mm/min), null until an F word is seen. */
    feed: number | null;
    /** Index into `epochs` of the spindle epoch this line belongs to, -1 while off. */
    epoch: number;
}

/** One run of a constant commanded S with the spindle on. */
export interface SpindleEpoch {
    index: number;
    /** 1-based line of the command that started it. */
    line: number;
    s: number;
}

export interface SpindleProgram {
    lines: ProgramLine[];
    epochs: SpindleEpoch[];
    lineCount: number;
}

const AXIS_WORDS = ['X', 'Y', 'Z', 'A', 'B', 'C', 'I', 'J', 'K', 'R'];

function stripComments(line: string): string {
    return line.replace(/\(.*?\)/g, ' ').replace(/;.*$/, ' ');
}

export function parseSpindleProgram(text: string): SpindleProgram {
    const raw = String(text || '').split(/\r?\n/);
    const lines: ProgramLine[] = [];
    const epochs: SpindleEpoch[] = [];
    let s: number | null = null;
    let feed: number | null = null;
    let motion: 'G0' | 'G1' = 'G0';
    let epoch = -1;

    raw.forEach((source, index) => {
        const body = stripComments(source).toUpperCase();
        const words: { [letter: string]: number } = {};
        const gCodes: number[] = [];
        const mCodes: number[] = [];
        const wordRe = /([A-Z])\s*([-+]?\d*\.?\d+)/g;
        let match: RegExpExecArray | null;
        // eslint-disable-next-line no-cond-assign
        while ((match = wordRe.exec(body)) !== null) {
            const letter = match[1];
            const value = Number(match[2]);
            if (letter === 'G') {
                gCodes.push(value);
            } else if (letter === 'M') {
                mCodes.push(value);
            } else {
                words[letter] = value;
            }
        }
        if (words.F !== undefined && words.F > 0) {
            feed = words.F;
        }
        let kind: LineKind = 'other';
        if (mCodes.includes(3) || mCodes.includes(4)) {
            kind = 'spindle';
            const commanded = words.S !== undefined ? words.S : s;
            if (commanded !== null && commanded > 0) {
                if (s !== commanded || epoch < 0) {
                    epoch = epochs.length;
                    epochs.push({ index: epoch, line: index + 1, s: commanded });
                }
                s = commanded;
            }
        } else if (mCodes.includes(5)) {
            kind = 'spindle';
            s = null;
            epoch = -1;
        } else if (words.S !== undefined && s !== null && words.S > 0 && words.S !== s && !gCodes.length) {
            // A bare S word while running changes the speed (Marlin/Snapmaker).
            kind = 'spindle';
            s = words.S;
            epoch = epochs.length;
            epochs.push({ index: epoch, line: index + 1, s });
        }
        if (gCodes.includes(4)) {
            kind = 'dwell';
        } else if (kind !== 'spindle') {
            if (gCodes.includes(0)) {
                motion = 'G0';
            } else if (gCodes.some((g) => g === 1 || g === 2 || g === 3)) {
                motion = 'G1';
            }
            const hasAxis = AXIS_WORDS.some((axis) => words[axis] !== undefined);
            const motionWord = gCodes.some((g) => g === 0 || g === 1 || g === 2 || g === 3);
            if (hasAxis && (motionWord || !gCodes.length)) {
                kind = motion === 'G1' ? 'feed' : 'rapid';
            }
        }
        lines.push({ kind, s, feed, epoch });
    });
    return { lines, epochs, lineCount: lines.length };
}

/** Context at the machine's reported line (1-based); null when the number is outside the file. */
export function lineContext(program: SpindleProgram, currentLine: number): ProgramLine | null {
    if (!Number.isFinite(currentLine)) {
        return null;
    }
    const index = Math.round(currentLine) - 1;
    if (index < 0 || index >= program.lines.length) {
        return null;
    }
    return program.lines[index];
}
