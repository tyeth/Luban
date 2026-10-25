// Turns a value typed into the Workspace coordinate table into the move that
// takes that one axis there. Kept free of React and app imports so the tape
// suite can check it without a machine (test/workspaceCoordinateGoto.js).

export type CoordinateAxis = 'x' | 'y' | 'z' | 'b';
export type CoordinateFrame = 'machine' | 'work';

export type AxisOffsets = Partial<Record<CoordinateAxis, number | string>>;

/** Machine-frame [0, size] travel for the axes a machine refuses absolute moves past (the Ray's work area). */
export type MachineTravel = Partial<Record<'x' | 'y', number>>;

export interface CoordinateGotoRequest {
    axis: CoordinateAxis;
    frame: CoordinateFrame;
    /** What the operator typed. */
    raw: string;
    /** The value the field was pre-filled with (the display string). */
    initial: string;
    /** Work minus machine, as the DisplayPanel uses it: machine = work - offset. */
    originOffset: AxisOffsets;
    /** The printing head's display shows machine = work, so no offset applies. */
    isPrinting: boolean;
    jogSpeed: number;
    travel?: MachineTravel | null;
    /** Send G1 rather than G0: GRBL (the Ray) runs G0 at each axis's maximum rate and ignores F, as the jog pad does. */
    feedMove?: boolean;
}

export type CoordinateGotoResult =
    | { kind: 'move'; gcode: string; workTarget: number; machineTarget: number }
    | { kind: 'unchanged' }
    | { kind: 'invalid'; raw: string }
    | { kind: 'outside-travel'; machineTarget: number; min: number; max: number };

// Plain decimals only: no exponent, no lone sign or point.
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

export function parseCoordinate(raw: string): number | null {
    const text = String(raw ?? '').trim();
    if (!DECIMAL.test(text)) {
        return null;
    }
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
}

function offsetFor(axis: CoordinateAxis, originOffset: AxisOffsets, isPrinting: boolean): number {
    if (isPrinting) {
        return 0;
    }
    const value = Number(originOffset[axis]);
    return Number.isFinite(value) ? value : 0;
}

// Three decimals, as the table displays, and never -0.
function roundMm(value: number): number {
    const rounded = Math.round(value * 1000) / 1000;
    return rounded === 0 ? 0 : rounded;
}

export function planCoordinateGoto(request: CoordinateGotoRequest): CoordinateGotoResult {
    const { axis, frame, raw, initial, originOffset, isPrinting, jogSpeed, travel, feedMove } = request;
    const typed = parseCoordinate(raw);
    if (typed === null) {
        return { kind: 'invalid', raw };
    }
    // Clicking in and out of a field, or retyping what it shows, must not move.
    const shown = parseCoordinate(initial);
    if (shown !== null && Math.abs(typed - shown) < 0.0005) {
        return { kind: 'unchanged' };
    }

    // Rounded to the table's three decimals so float noise in the offset
    // cannot push a target typed at the edge of travel just outside it.
    const offset = offsetFor(axis, originOffset, isPrinting);
    const workTarget = roundMm(frame === 'work' ? typed : typed + offset);
    const machineTarget = roundMm(frame === 'machine' ? typed : typed - offset);

    if (travel && (axis === 'x' || axis === 'y') && travel[axis] !== undefined) {
        const max = Number(travel[axis]);
        if (machineTarget < 0 || machineTarget > max) {
            return { kind: 'outside-travel', machineTarget, min: 0, max };
        }
    }

    const feed = Number.isFinite(jogSpeed) && jogSpeed > 0 ? ` F${jogSpeed}` : '';
    const gcode = `G90\n${feedMove ? 'G1' : 'G0'} ${axis.toUpperCase()}${workTarget}${feed}`;
    return { kind: 'move', gcode, workTarget, machineTarget };
}
