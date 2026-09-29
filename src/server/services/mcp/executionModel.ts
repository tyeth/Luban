// Where the machine really is in a file job, when every number the
// controller reports is ahead of the tool.
//
// Measured on the A350 (job 161b444dc0cb, 2026-09-29): the status's
// `currentLine` is the parser's position (the whole file within seconds),
// and its x/y/z are the END OF THE LAST QUEUED MOVE - Marlin's planner
// position, not the head. The planner keeps BLOCK_BUFFER_SIZE = 16 moves
// queued, so on a raster of ten-second passes the reported position led the
// cutter by eight passes, then advanced in lock-step with it. A dwell (`G4`)
// is a planner sync: the queue drains into the head, the reported position
// freezes at the pre-dwell target, and refills the moment the dwell ends.
//
// So the executing line is ESTIMATED: simulate the file's timing (segment
// length / feed, dwell P) from the last exact anchor - the job start, or
// the end of a dwell, which is visible as the frozen reported position
// starting to advance again - and keep the estimate inside what the queue
// proves: never past the queued line, never more than the buffer depth
// behind it. Alerts only; nothing here commands the machine.
//
// Pure: no server imports, unit-tested in tests/executionModel.test.ts.

import { Point3, SpindleProgram } from './spindleProgram';

export const DEFAULT_PLANNER_LEAD_BLOCKS = 16;
/** Rapid feed assumed for G0 timing (A350: ~3000 mm/min on XY). */
export const RAPID_MM_PER_MIN = 3000;
/** A reported position unchanged this long, with a dwell next in the file, is a planner sync. */
const FREEZE_MS = 1500;

export type EstimateMode = 'time' | 'queue-upper' | 'queue-lower' | 'anchor';

export interface ExecutionEstimate {
    /** 1-based line the head is judged to be executing. */
    line: number;
    mode: EstimateMode;
    /** The position-matched (queued) line this estimate was bounded by, null when none. */
    queuedLine: number | null;
    /** Motion blocks between the estimate and the queued line. */
    leadBlocks: number | null;
}

/**
 * ms each line takes to execute: motion length / feed, dwell P (ms) or S (s),
 * else 0. Axes a file never states before a move (the traverse from the park
 * height at the start of every job) are taken from `start`, the head's
 * position when the job began - without it those moves would take no time
 * and the spindle context would begin while the gantry is still travelling
 * with the spindle off (the 2026-09-29 "8000 RPM before M3" reading).
 */
export function lineDurationsMs(program: SpindleProgram, text: string, start?: Point3 | null): number[] {
    const raw = String(text || '').split(/\r?\n/);
    const fill = (point: Point3): Point3 => ({
        x: Number.isFinite(point.x) || !start ? point.x : start.x,
        y: Number.isFinite(point.y) || !start ? point.y : start.y,
        z: Number.isFinite(point.z) || !start ? point.z : start.z,
    });
    return program.lines.map((line, index) => {
        if (line.motion) {
            const from = fill(line.motion.from);
            const to = fill(line.motion.to);
            let d2 = 0;
            for (const axis of ['x', 'y', 'z'] as const) {
                if (Number.isFinite(from[axis]) && Number.isFinite(to[axis])) {
                    d2 += (to[axis] - from[axis]) ** 2;
                }
            }
            const feed = line.kind === 'feed' && line.feed ? line.feed : RAPID_MM_PER_MIN;
            return (Math.sqrt(d2) / feed) * 60000;
        }
        if (line.kind === 'dwell') {
            const body = (raw[index] || '').toUpperCase().replace(/;.*$/, '');
            const p = body.match(/\bP(\d+(?:\.\d+)?)/);
            const s = body.match(/\bS(\d+(?:\.\d+)?)/);
            if (p) {
                return Number(p[1]);
            }
            if (s) {
                return Number(s[1]) * 1000;
            }
        }
        return 0;
    });
}

export class ExecutionEstimator {
    private readonly program: SpindleProgram;

    private durations: number[];

    private readonly text: string;

    private startPosition: Point3 | null = null;

    private readonly lead: number;

    /** Motion-block ordinal of each line (blocks before and including it). */
    private readonly blockIndex: number[];

    /** Last line known to be COMPLETED at anchorAtMs (0 = nothing yet). */
    private anchorLine = 0;

    private anchorAtMs = 0;

    private anchored = false;

    private lastQueued: number | null = null;

    private queuedSinceMs = 0;

    private lastEstimate = 1;

    public constructor(program: SpindleProgram, text: string, leadBlocks = DEFAULT_PLANNER_LEAD_BLOCKS) {
        this.program = program;
        this.text = text;
        this.durations = lineDurationsMs(program, text);
        this.lead = Math.max(1, Math.round(leadBlocks));
        let blocks = 0;
        this.blockIndex = program.lines.map((line) => {
            if (line.motion) {
                blocks += 1;
            }
            return blocks;
        });
    }

    /** Where the head was when the job started (file frame): gives the leading moves their real durations. Once only. */
    public setStartPosition(start: Point3): void {
        if (this.startPosition) {
            return;
        }
        this.startPosition = { ...start };
        this.durations = lineDurationsMs(this.program, this.text, start);
    }

    /** Line at which the queued line's block minus `lead` blocks starts (the earliest the head can be). */
    private lowerBound(queued: number): number {
        const target = this.blockIndex[queued - 1] - this.lead;
        if (target <= 0) {
            return 1;
        }
        for (let line = 1; line <= queued; line++) {
            if (this.blockIndex[line - 1] >= target && this.program.lines[line - 1].motion) {
                return line;
            }
        }
        return 1;
    }

    /** Walk the file's timing from the anchor: the line in progress at tMs. */
    private byTime(tMs: number): number {
        let remaining = tMs - this.anchorAtMs;
        let completed = this.anchorLine;
        const count = this.program.lines.length;
        while (completed < count) {
            const duration = this.durations[completed];
            if (remaining < duration) {
                break;
            }
            remaining -= duration;
            completed += 1;
        }
        return Math.min(count, completed + 1);
    }

    /** Is the queued line a planner sync (dwell / spindle command), or is one what follows it before any motion? */
    private syncFollows(queued: number): boolean {
        const count = this.program.lines.length;
        const own = this.program.lines[queued - 1];
        if (own.kind === 'dwell' || own.kind === 'spindle') {
            return true;
        }
        for (let line = queued + 1; line <= count; line++) {
            const entry = this.program.lines[line - 1];
            if (entry.motion) {
                return false;
            }
            if (entry.kind === 'dwell' || entry.kind === 'spindle') {
                return true;
            }
        }
        return true;
    }

    public update(tMs: number, queuedLine: number | null): ExecutionEstimate {
        if (!this.anchored) {
            this.anchored = true;
            this.anchorAtMs = tMs;
            this.anchorLine = 0;
        }
        const count = this.program.lines.length;
        const queued = queuedLine !== null && queuedLine >= 1 && queuedLine <= count ? queuedLine : null;
        let mode: EstimateMode = 'time';

        if (queued !== null) {
            if (this.lastQueued === null || queued !== this.lastQueued) {
                // The queue took a NEW MOVE. If it had been frozen at a sync
                // point, the head has just finished that dwell: an exact anchor.
                // (The position matcher also "advances" onto the non-motion
                // lines after a segment's end - the M5 at the end of a file
                // while the head still has a buffer of moves to run - and
                // that is not the planner moving on.)
                if (this.lastQueued !== null && queued > this.lastQueued && !!this.program.lines[queued - 1].motion
                    && tMs - this.queuedSinceMs >= FREEZE_MS && this.syncFollows(this.lastQueued)) {
                    let dwellLine = this.lastQueued;
                    for (let line = this.lastQueued + 1; line < queued; line++) {
                        if (this.program.lines[line - 1].motion) {
                            break;
                        }
                        dwellLine = line;
                    }
                    this.anchorLine = dwellLine;
                    this.anchorAtMs = tMs;
                    mode = 'anchor';
                }
                this.lastQueued = queued;
                this.queuedSinceMs = tMs;
            }
        }

        let estimate = this.byTime(tMs);
        let leadBlocks: number | null = null;
        if (queued !== null) {
            const lower = this.lowerBound(queued);
            if (estimate > queued) {
                estimate = queued;
                mode = 'queue-upper';
                this.anchorLine = estimate - 1;
                this.anchorAtMs = tMs;
            } else if (estimate < lower) {
                estimate = lower;
                mode = 'queue-lower';
                this.anchorLine = estimate - 1;
                this.anchorAtMs = tMs;
            }
            leadBlocks = this.blockIndex[queued - 1] - this.blockIndex[estimate - 1];
        }
        if (estimate < this.lastEstimate) {
            estimate = this.lastEstimate;
        }
        this.lastEstimate = estimate;
        return { line: estimate, mode, queuedLine: queued, leadBlocks };
    }
}
