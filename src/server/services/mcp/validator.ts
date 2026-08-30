/**
 * Static G-code inspection for the MCP gate.
 *
 * Reports facts an agent and a human reviewer need before a job runs:
 * motion extents, feeds, spindle commands, and hazards worth flagging.
 * It renders judgment material, not judgment - starting a job still
 * requires human confirmation.
 */

export interface GcodeValidationReport {
    lineCount: number;
    motionLineCount: number;
    extents: {
        x: { min: number; max: number } | null;
        y: { min: number; max: number } | null;
        z: { min: number; max: number } | null;
        b: { min: number; max: number } | null;
    };
    feedRates: { min: number; max: number } | null;
    spindle: {
        onCommands: number; // M3/M4 count
        offCommands: number; // M5 count
        maxS: number | null;
    };
    usesRelativeMotion: boolean; // any G91 present
    usesArcs: boolean; // G2/G3 present (extents are approximated from endpoints)
    fourAxis: boolean; // any B-axis word
    minZWithSpindleOn: number | null;
    warnings: string[];
}

const MOTION_RE = /^G0*[0123](?:\.\d+)?$/;

function parseWords(line: string): { code: string | null; words: { [letter: string]: number } } {
    // strip comments: ; to end, and ( ... )
    const stripped = line.replace(/;.*$/, '').replace(/\([^)]*\)/g, '').trim();
    if (!stripped) {
        return { code: null, words: {} };
    }

    const tokens = stripped.toUpperCase().split(/\s+/);
    const words: { [letter: string]: number } = {};
    let code: string | null = null;

    for (const token of tokens) {
        const letter = token[0];
        const value = Number(token.slice(1));
        if (!letter || Number.isNaN(value)) {
            continue;
        }
        if ((letter === 'G' || letter === 'M') && code === null) {
            code = token;
        } else {
            words[letter] = value;
        }
    }
    return { code, words };
}

function extend(range: { min: number; max: number } | null, value: number): { min: number; max: number } {
    if (!range) {
        return { min: value, max: value };
    }
    return { min: Math.min(range.min, value), max: Math.max(range.max, value) };
}

export function validateGcode(gcode: string): GcodeValidationReport {
    const lines = gcode.split(/\r?\n/);

    let x: { min: number; max: number } | null = null;
    let y: { min: number; max: number } | null = null;
    let z: { min: number; max: number } | null = null;
    let b: { min: number; max: number } | null = null;
    let feed: { min: number; max: number } | null = null;
    let maxS: number | null = null;
    let onCommands = 0;
    let offCommands = 0;
    let motionLineCount = 0;
    let usesRelativeMotion = false;
    let usesArcs = false;
    let relativeMode = false;
    let spindleOn = false;
    let minZWithSpindleOn: number | null = null;
    const warnings: string[] = [];

    for (const line of lines) {
        const { code, words } = parseWords(line);
        if (!code) {
            continue;
        }

        if (code === 'G90') {
            relativeMode = false;
        } else if (code === 'G91') {
            relativeMode = true;
            usesRelativeMotion = true;
        } else if (code === 'M3' || code === 'M03' || code === 'M4' || code === 'M04') {
            onCommands += 1;
            spindleOn = true;
            if (words.S !== undefined) {
                maxS = maxS === null ? words.S : Math.max(maxS, words.S);
            }
        } else if (code === 'M5' || code === 'M05') {
            offCommands += 1;
            spindleOn = false;
        } else if (MOTION_RE.test(code)) {
            motionLineCount += 1;
            if (code === 'G2' || code === 'G02' || code === 'G3' || code === 'G03') {
                usesArcs = true;
            }
            if (relativeMode) {
                // Relative moves make static extents unreliable; report the
                // fact instead of accumulating wrong numbers.
                continue;
            }
            if (words.X !== undefined) x = extend(x, words.X);
            if (words.Y !== undefined) y = extend(y, words.Y);
            if (words.Z !== undefined) {
                z = extend(z, words.Z);
                if (spindleOn) {
                    minZWithSpindleOn = minZWithSpindleOn === null
                        ? words.Z : Math.min(minZWithSpindleOn, words.Z);
                }
            }
            if (words.B !== undefined) b = extend(b, words.B);
            if (words.F !== undefined) feed = extend(feed, words.F);
        }

        if (words.S !== undefined && (code === 'M3' || code === 'M03' || code === 'M4' || code === 'M04' || MOTION_RE.test(code))) {
            maxS = maxS === null ? words.S : Math.max(maxS, words.S);
        }
    }

    if (usesRelativeMotion) {
        warnings.push('Contains G91 relative motion; extents exclude relative segments and are unreliable.');
    }
    if (usesArcs) {
        warnings.push('Contains arcs (G2/G3); extents are computed from endpoints only and may understate the true envelope.');
    }
    if (onCommands > 0 && offCommands === 0) {
        warnings.push('Spindle/laser is turned on (M3/M4) but never turned off (M5).');
    }
    if (minZWithSpindleOn !== null && minZWithSpindleOn < 0) {
        warnings.push(`Cutting below Z0 with spindle on (min Z ${minZWithSpindleOn}). Verify Z0 is the stock top.`);
    }
    if (motionLineCount === 0) {
        warnings.push('No motion commands found.');
    }

    return {
        lineCount: lines.length,
        motionLineCount,
        extents: { x, y, z, b },
        feedRates: feed,
        spindle: { onCommands, offCommands, maxS },
        usesRelativeMotion,
        usesArcs,
        fourAxis: b !== null,
        minZWithSpindleOn,
        warnings,
    };
}
