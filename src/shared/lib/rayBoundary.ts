// The Ray's job frame: the boundary.nc a SHORT press of its work switch runs.
//
// getRunBoundaryCode is Luban's own Run Boundary G-code, moved here unchanged
// from RaySetOriginWidget/SetOriginView so the renderer (Run Boundary, Upload
// Job) and the server (MCP file jobs) write the same bytes for the same job.
// Pure: no app or server imports (the MCP's unit tests load it directly).

/** The file the Ray's work switch runs on a short press (Luban uploads it under this name). */
export const RAY_BOUNDARY_FILENAME = 'boundary.nc';

/** JobOffsetMode values (app/constants/coordinate). */
export const BOUNDARY_MODE_CROSSHAIR = 'Crosshair';
export const BOUNDARY_MODE_LASER_SPOT = 'LaserSpot';

/** SetupCoordinateMethod.ByControlPanel (app/constants): the Ray in Control Mode (motors held, homed). */
export const SETUP_BY_CONTROL_PANEL = 'control-panel';

export interface BoundaryWorkRange {
    min: { x: number; y: number; b?: number };
    max: { x: number; y: number; b?: number };
}

export const getRunBoundaryCode = (
    axisWorkRange: BoundaryWorkRange,
    jobOffsetMode: string,
    isRotate: boolean = false,
    setupCoordinateMethod: string
) => {
    const useBInsteadOfX = isRotate;
    const gCommand = jobOffsetMode === BOUNDARY_MODE_CROSSHAIR ? 'G1 S0' : 'G1 S10';

    const goto = (x: number, y: number): string => {
        let code = gCommand;

        if (useBInsteadOfX) {
            code += ` B${x || 0}`;
        } else {
            code += ` X${x || 0}`;
        }

        code += ` Y${y}`;
        code += ' F6000';

        return code;
    };

    const gcodeList = [];

    if (setupCoordinateMethod === SETUP_BY_CONTROL_PANEL) {
        gcodeList.push(
            ';motor_mode: 3',
        );
    }

    if (jobOffsetMode === BOUNDARY_MODE_CROSSHAIR) {
        // Use crosshair to run boundary
        gcodeList.push('M2000 L13 P1'); // turn on crosshair
    } else if (jobOffsetMode === BOUNDARY_MODE_LASER_SPOT) {
        // Use laser spot to run boundary
        gcodeList.push('M3 S0');
        gcodeList.push(`${gCommand} F6000`); // turn on laser spot
    }

    gcodeList.push(
        'G90', // absolute position
    );

    // set current position as origin
    if (setupCoordinateMethod !== SETUP_BY_CONTROL_PANEL) {
        gcodeList.push(
            'G92 X0 Y0 B0',
        );
    }

    if (useBInsteadOfX) {
        gcodeList.push(
            // run bounding box
            goto(axisWorkRange.min.b, axisWorkRange.min.y),
            goto(axisWorkRange.max.b, axisWorkRange.min.y),
            goto(axisWorkRange.max.b, axisWorkRange.max.y),
            goto(axisWorkRange.min.b, axisWorkRange.max.y),
            goto(axisWorkRange.min.b, axisWorkRange.min.y),
        );
    } else {
        gcodeList.push(
            // run bounding box
            goto(axisWorkRange.min.x, axisWorkRange.min.y),
            goto(axisWorkRange.max.x, axisWorkRange.min.y),
            goto(axisWorkRange.max.x, axisWorkRange.max.y),
            goto(axisWorkRange.min.x, axisWorkRange.max.y),
            goto(axisWorkRange.min.x, axisWorkRange.min.y),
        );
    }


    if (setupCoordinateMethod === SETUP_BY_CONTROL_PANEL) {
        // go back to origin
        if (useBInsteadOfX) {
            gcodeList.push(
                goto(
                    axisWorkRange.min.b + (axisWorkRange.max.b - axisWorkRange.min.b) / 2,
                    axisWorkRange.min.y + (axisWorkRange.max.y - axisWorkRange.min.y) / 2
                )
            );
        } else {
            gcodeList.push(
                goto(
                    axisWorkRange.min.x + (axisWorkRange.max.x - axisWorkRange.min.x) / 2,
                    axisWorkRange.min.y + (axisWorkRange.max.y - axisWorkRange.min.y) / 2
                )
            );
        }
    } else {
        gcodeList.push(
            goto(0, 0)
        );
    }

    if (jobOffsetMode === BOUNDARY_MODE_LASER_SPOT) {
        gcodeList.push('M5 S0'); // turn off laser spot
    }

    gcodeList.push(
        ';End', // empty line
    );

    const gcode = gcodeList.join('\n');

    return gcode;
};

/** A job's frame inputs, as Luban reads them from the job's header when it loads the file. */
export interface JobBoundarySource {
    range: BoundaryWorkRange;
    jobOffsetMode: string;
    isRotate: boolean;
    /** 'header': the Luban header's min/max lines, as the renderer uses them; 'extents': the validator's work-frame extents. */
    basis: 'header' | 'extents';
}

/** The validator's work-frame X/Y extents (validate_gcode extents), the fallback frame. */
export interface BoundaryExtents {
    x?: { min: number; max: number } | null;
    y?: { min: number; max: number } | null;
}

/** The box a frame runs, for reports: B replaces X on a rotary job. */
export function boundaryFrameSummary(source: JobBoundarySource) {
    const axis: 'x' | 'b' = source.isRotate ? 'b' : 'x';
    return {
        min_x: source.range.min[axis] ?? 0,
        max_x: source.range.max[axis] ?? 0,
        min_y: source.range.min.y,
        max_y: source.range.max.y,
        axis,
        mode: source.jobOffsetMode === BOUNDARY_MODE_CROSSHAIR ? 'crosshair' : 'laser spot at S10',
    };
}

const NUMBER = /^(-?\d+)(\.\d+)?$/;

/**
 * The frame inputs of a job file. A Luban export carries its bounding box in
 * the header (;min_x(mm) ... ;max_b(mm)), which is what the renderer frames
 * (actions-gcode uploadGcodeFile -> gcodeAxisWorkRange), and its job offset
 * mode as M2003/M2004 before ;Header End (generateGcode writes them only for
 * Crosshair). Values parse as parseLubanGcodeHeader does (parseFloat of plain
 * decimals), so both paths print the same numbers. Without a usable header
 * the validator's work-frame extents are framed with the Ray's default mode
 * (Crosshair, the laser state's default); null when neither gives X and Y.
 */
export function jobBoundarySource(gcodeText: string, extents?: BoundaryExtents | null): JobBoundarySource | null {
    const lines = String(gcodeText || '').split('\n', 100);
    const header: Record<string, number | string> = {};
    let inHeader = false;
    let crosshair = false;
    let sawHeader = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (line.indexOf(';Header Start') !== -1) {
            inHeader = true;
            sawHeader = true;
            continue;
        }
        if (line.indexOf(';Header End') !== -1) {
            break;
        }
        if (!inHeader) {
            continue;
        }
        if (/^M2003\b/.test(line)) {
            crosshair = true;
        }
        const sep = line.indexOf(':');
        if (line.startsWith(';') && sep !== -1) {
            const key = line.substr(0, sep).trim();
            const value = line.substr(sep + 1).trim();
            header[key] = NUMBER.test(value) ? parseFloat(value) : value;
        }
    }
    const num = (key: string): number | null => (typeof header[key] === 'number' ? header[key] as number : null);
    const minX = num(';min_x(mm)');
    const maxX = num(';max_x(mm)');
    const minY = num(';min_y(mm)');
    const maxY = num(';max_y(mm)');
    if (sawHeader && minX !== null && maxX !== null && minY !== null && maxY !== null) {
        return {
            range: {
                min: { x: minX, y: minY, b: num(';min_b(mm)') ?? 0 },
                max: { x: maxX, y: maxY, b: num(';max_b(mm)') ?? 0 },
            },
            jobOffsetMode: crosshair ? BOUNDARY_MODE_CROSSHAIR : BOUNDARY_MODE_LASER_SPOT,
            isRotate: header[';is_rotate'] === 'true',
            basis: 'header',
        };
    }
    if (extents && extents.x && extents.y && [extents.x.min, extents.x.max, extents.y.min, extents.y.max].every(Number.isFinite)) {
        return {
            range: { min: { x: extents.x.min, y: extents.y.min, b: 0 }, max: { x: extents.x.max, y: extents.y.max, b: 0 } },
            jobOffsetMode: BOUNDARY_MODE_CROSSHAIR,
            isRotate: false,
            basis: 'extents',
        };
    }
    return null;
}

/**
 * Whether a boundary must be sent: only when this connection has not already
 * put exactly these bytes on the controller. `last` is what this connection
 * uploaded (null = unknown: a new connection, a reconnect, a failed or
 * interrupted upload). Anything else on the controller (the phone app,
 * another Luban) is invisible to it, so the rule is per connection.
 */
export function boundaryUploadNeeded(last: { digest: string; generation: number } | null, digest: string, generation: number): boolean {
    return !last || last.generation !== generation || last.digest !== digest;
}
