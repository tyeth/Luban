/**
 * Static G-code inspection for the MCP gate.
 *
 * Reports facts an agent and a human reviewer need before a job runs:
 * motion extents, feeds, spindle commands, the coordinate FRAME the job
 * declares, and hazards worth flagging. It renders judgment material, not
 * judgment - starting a job still requires human confirmation - with one
 * exception: resolveJobFrame() refuses a job that never declares its frame,
 * because an undeclared job runs in whatever workspace the controller happens
 * to have selected (operator law, 2026-09-14, after a work-frame `G0 Z0`
 * transit job reached the confirm page reading "Z 0 .. 0, warnings: none").
 *
 * No server imports: unit-testable with ts-node.
 */

export type JobFrame = 'machine' | 'work';

export interface FrameDeclaration {
    /** Frame in force at the first motion line: G53 -> machine, G54..G59 -> work, none -> null. */
    declared: JobFrame | null;
    /** Where the declaration came from: a code in the file, the submit argument, or nothing. */
    source: 'gcode' | 'argument' | null;
    /** 1-based line of the declaring code when source is 'gcode'. */
    line: number | null;
    /** 1-based line of the first G0..G3, or null when the file has no motion. */
    firstMotionLine: number | null;
    /** Motion occurred under BOTH frames (a trailing G54 with no motion after it is not mixed). */
    mixed: boolean;
    /** Distinct workspace-select codes seen (G54..G59). */
    workspaceSelects: string[];
    /** Lines carrying G53 together with a motion word - this controller does not honour inline G53. */
    inlineG53Lines: number[];
}

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
    assumesDistanceMode: boolean; // motion before any G90/G91
    endsInRelativeMode: boolean; // G91 still active at end of file
    usesArcs: boolean; // G2/G3 present (extents are approximated from endpoints)
    fourAxis: boolean; // any B-axis word
    minZWithSpindleOn: number | null;
    /** G92 rewrites the work origin; the only sanctioned path is apply_tool_length_offset. */
    setsWorkOrigin: boolean;
    frame: FrameDeclaration;
    /**
     * Z extents in MACHINE coordinates: the raw extents for a machine-frame job,
     * raw minus the staging origin offset for a work-frame job. Filled by
     * resolveJobFrame(); null until then, and null when the offset was not
     * reliable at staging.
     */
    machineZExtents: { min: number; max: number } | null;
    /** Work-origin Z offset used to resolve machineZExtents (work-frame jobs only). */
    originOffsetZAtStaging: number | null;
    warnings: string[];
}

const MOTION_RE = /^G0*[0123](?:\.\d+)?$/;
const WORKSPACE_RE = /^G5[4-9]$/;

interface ParsedLine {
    /** Every G/M code on the line, in order (a line may carry G53 G0 ...). */
    codes: string[];
    /** Non-code words: X/Y/Z/B/F/S ... */
    words: { [letter: string]: number };
}

function normaliseCode(token: string): string {
    // G01 -> G1, G0 -> G0, G38.2 stays, M03 -> M3
    const m = /^([GM])0*(\d+(?:\.\d+)?)$/.exec(token);
    return m ? `${m[1]}${m[2]}` : token;
}

function parseLine(line: string): ParsedLine {
    // strip comments: ; to end, and ( ... )
    const stripped = line.replace(/;.*$/, '').replace(/\([^)]*\)/g, '').trim();
    if (!stripped) {
        return { codes: [], words: {} };
    }

    const tokens = stripped.toUpperCase().split(/\s+/);
    const words: { [letter: string]: number } = {};
    const codes: string[] = [];

    for (const token of tokens) {
        const letter = token[0];
        const value = Number(token.slice(1));
        if (!letter || Number.isNaN(value)) {
            continue;
        }
        if (letter === 'G' || letter === 'M') {
            codes.push(normaliseCode(token));
        } else {
            words[letter] = value;
        }
    }
    return { codes, words };
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
    let distanceModeSet = false;
    let motionBeforeDistanceMode = false;
    let spindleOn = false;
    let minZWithSpindleOn: number | null = null;
    let setsWorkOrigin = false;
    const warnings: string[] = [];

    // Frame tracking. On this controller `G53` on its own line selects the
    // machine workspace and stays selected until a G54..G59 reselects a work
    // workspace (every MCP emitter and Luban's own Home button rely on that:
    // `G53; G28; G54`). An inline `G53 G0 ...` is NOT honoured by the firmware -
    // the move runs in the selected workspace - so it never counts as a
    // declaration and is flagged.
    let frameModal: JobFrame | null = null;
    let declarationLine: number | null = null;
    let firstMotionLine: number | null = null;
    let declaredAtFirstMotion: JobFrame | null = null;
    const motionFrames = new Set<string>();
    const workspaceSelects = new Set<string>();
    const inlineG53Lines: number[] = [];

    lines.forEach((line, index) => {
        const lineNo = index + 1;
        const { codes, words } = parseLine(line);
        if (!codes.length) {
            return;
        }
        const motionCode = codes.find((c) => MOTION_RE.test(c)) || null;
        const hasG53 = codes.includes('G53');
        const workspace = codes.find((c) => WORKSPACE_RE.test(c)) || null;

        if (hasG53 && motionCode) {
            inlineG53Lines.push(lineNo);
        } else if (hasG53) {
            frameModal = 'machine';
            if (declarationLine === null) {
                declarationLine = lineNo;
            }
        }
        if (workspace) {
            workspaceSelects.add(workspace);
            frameModal = 'work';
            if (declarationLine === null) {
                declarationLine = lineNo;
            }
        }

        for (const code of codes) {
            if (code === 'G90') {
                relativeMode = false;
                distanceModeSet = true;
            } else if (code === 'G91') {
                relativeMode = true;
                usesRelativeMotion = true;
                distanceModeSet = true;
            } else if (code === 'G92') {
                setsWorkOrigin = true;
            } else if (code === 'M3' || code === 'M4') {
                onCommands += 1;
                spindleOn = true;
                if (words.S !== undefined) {
                    maxS = maxS === null ? words.S : Math.max(maxS, words.S);
                }
            } else if (code === 'M5') {
                offCommands += 1;
                spindleOn = false;
            }
        }

        if (motionCode) {
            motionLineCount += 1;
            if (firstMotionLine === null) {
                firstMotionLine = lineNo;
                declaredAtFirstMotion = frameModal;
            }
            motionFrames.add(frameModal || 'undeclared');
            if (!distanceModeSet) {
                motionBeforeDistanceMode = true;
            }
            if (motionCode === 'G2' || motionCode === 'G3') {
                usesArcs = true;
            }
            if (words.S !== undefined) {
                maxS = maxS === null ? words.S : Math.max(maxS, words.S);
            }
            if (relativeMode && !hasG53) {
                // Relative moves make static extents unreliable; report the
                // fact instead of accumulating wrong numbers. (G53 is absolute
                // even under G91.)
                return;
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
    });

    const frame: FrameDeclaration = {
        declared: declaredAtFirstMotion,
        source: declaredAtFirstMotion ? 'gcode' : null,
        line: declaredAtFirstMotion ? declarationLine : null,
        firstMotionLine,
        mixed: motionFrames.has('machine') && motionFrames.has('work'),
        workspaceSelects: [...workspaceSelects].sort(),
        inlineG53Lines,
    };

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
    if (z !== null && z.min < 0 && minZWithSpindleOn === null) {
        warnings.push(`Moves to absolute work Z below zero with the spindle off (min Z ${z.min}). `
            + 'If a relative drop was intended, wrap the move in G91 ... G90 instead - an absolute '
            + 'Z-20 is a position, not a distance. Verify the work origin either way.');
    }
    if (motionBeforeDistanceMode) {
        warnings.push('Motion occurs before any G90/G91: the first move executes in whatever distance '
            + 'mode the controller happens to be in. State the mode explicitly first.');
    }
    if (relativeMode) {
        warnings.push('The file ends with G91 still active, leaving the controller in relative mode - '
            + "Luban's convention is to restore G90 after relative moves.");
    }
    if (setsWorkOrigin) {
        warnings.push('Contains G92: this REWRITES the work origin for every job that follows. The only '
            + 'sanctioned work-origin write is apply_tool_length_offset (it mirrors the touchscreen '
            + 'tool-change wizard). Remove it unless the operator asked for exactly this.');
    }
    if (inlineG53Lines.length) {
        warnings.push(`Inline G53 with a move on line(s) ${inlineG53Lines.join(', ')}: this controller does NOT `
            + 'honour a one-shot G53 - the move runs in the selected workspace, not machine coordinates. '
            + 'Put G53 on its own line before the moves (and G54 after) instead.');
    }
    if (frame.mixed) {
        warnings.push('Motion occurs under BOTH frames (G53 machine and G54..G59 work). Extents mix the two; '
            + 'review every Z with its frame.');
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
        assumesDistanceMode: motionBeforeDistanceMode,
        endsInRelativeMode: relativeMode,
        usesArcs,
        fourAxis: b !== null,
        minZWithSpindleOn,
        setsWorkOrigin,
        frame,
        machineZExtents: null,
        originOffsetZAtStaging: null,
        warnings,
    };
}

export interface FrameResolutionContext {
    /** The submit call's `frame` argument, if any. */
    frameArgument?: JobFrame | null;
    /** Work-origin Z offset from the position of record (machine = work - offset), or null when unknown. */
    originOffsetZ: number | null;
    /** False when the offset is cached / assumed / the position is awaiting resync - resolution is then refused for work jobs. */
    offsetReliable: boolean;
    /** Machine Z travel (home height), for bounds warnings; null when the machine is unknown. */
    machineZMax: number | null;
}

export interface FrameResolution {
    report: GcodeValidationReport;
    /** Non-null = the job must be REFUSED at staging with this message. */
    refusal: string | null;
}

export const FRAME_REFUSAL_UNDECLARED = 'Refused: the job never declares its coordinate frame, so its moves would run in '
    + 'whatever workspace the controller happens to have selected. Declare it: put `G53` on its own line before the '
    + 'first move (and `G54` after the last) for MACHINE coordinates, or pass frame: "work" for a Luban/slicer file '
    + 'that runs in the operator\'s work origin. G90/G91 is distance mode, not a frame.';

/**
 * Settle which frame a staged file job runs in, from what the gcode declares
 * and what the caller passed. Pure: the caller supplies the live offset.
 */
export function resolveJobFrame(input: GcodeValidationReport, ctx: FrameResolutionContext): FrameResolution {
    const report: GcodeValidationReport = {
        ...input,
        frame: { ...input.frame },
        warnings: [...input.warnings],
    };
    const arg = ctx.frameArgument || null;
    const declared = report.frame.declared;

    if (report.motionLineCount === 0) {
        return { report, refusal: null };
    }

    if (declared === 'machine' && arg === 'work') {
        return { report, refusal: `Refused: the gcode declares G53 (machine frame) at line ${report.frame.line} but frame: "work" was passed. Say which one you mean.` };
    }
    if (declared === 'work' && arg === 'machine') {
        return { report, refusal: `Refused: the gcode selects a work workspace (${report.frame.workspaceSelects.join('/')}) at line ${report.frame.line} but frame: "machine" was passed. A machine-frame job must contain G53 literally.` };
    }
    if (declared === null) {
        if (arg === 'work') {
            report.frame.declared = 'work';
            report.frame.source = 'argument';
        } else if (arg === 'machine') {
            return {
                report,
                refusal: `Refused: frame: "machine" was passed but the gcode contains no G53 before its first move (line ${report.frame.firstMotionLine}). The controller runs an undeclared file in the selected WORK workspace, so a machine-frame job must carry G53 literally - the MCP never edits your gcode to add it.`,
            };
        } else {
            return { report, refusal: FRAME_REFUSAL_UNDECLARED };
        }
    }

    const zMax = ctx.machineZMax;
    const rawZ = report.extents.z;
    if (report.frame.declared === 'machine') {
        report.machineZExtents = rawZ ? { ...rawZ } : null;
        if (rawZ && zMax !== null && (rawZ.min < -1 || rawZ.max > zMax + 1)) {
            report.warnings.push(`Machine-frame Z ${rawZ.min} .. ${rawZ.max} is outside the 0 .. ${zMax} travel. `
                + 'A machine coordinate more than 50 mm outside the bounds is a bug, not a position.');
        }
    } else {
        if (!ctx.offsetReliable || ctx.originOffsetZ === null) {
            report.machineZExtents = null;
            report.warnings.push('Work-frame job, but the work-origin offset is not reliable right now (no fresh heartbeat, '
                + 'or the position of record is awaiting resync): the machine-resolved Z extents could not be computed. '
                + 'Re-check get_position before approving.');
        } else {
            report.originOffsetZAtStaging = ctx.originOffsetZ;
            report.machineZExtents = rawZ
                ? { min: rawZ.min - ctx.originOffsetZ, max: rawZ.max - ctx.originOffsetZ }
                : null;
            if (rawZ && rawZ.min <= 0 && rawZ.max >= 0) {
                report.warnings.push('Work-frame job with an absolute Z at or crossing 0: with the current origin, work Z0 is '
                    + `machine Z ${(-ctx.originOffsetZ).toFixed(3)}. Confirm that is where you want the tool.`);
            }
            const m = report.machineZExtents;
            if (rawZ && m && zMax !== null && (m.min < -1 || m.max > zMax + 1)) {
                report.warnings.push(`Work-frame Z ${rawZ.min} .. ${rawZ.max} resolves to machine Z ${m.min.toFixed(3)} .. `
                    + `${m.max.toFixed(3)} with the current origin - outside the 0 .. ${zMax} travel.`);
            }
        }
    }
    return { report, refusal: null };
}
