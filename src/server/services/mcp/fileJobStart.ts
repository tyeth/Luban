// Evidence for a file start whose reply may have been lost (#256), and the
// shape of each channel's file-job transport (#328).
// Idle is not proof of rejection: a short program may already have finished.
//
// Pure module: no server imports, unit-tested in tests/fileJobStart.test.ts.

/**
 * Heartbeat statuses that mean the controller is running (or holding) a file.
 * 'starting' is the Ray's SYSTEM_STATUS_STARTING: its work switch was pressed
 * and the SD card has up to 10 s to enter printing (RayController
 * file_manager.cpp WAITING_PLATFORM_STARTED); the A350 over HTTP never reports it.
 */
export const FILE_JOB_ACTIVE_STATUSES = ['starting', 'running', 'paused', 'pausing', 'stopping', 'resuming'];

/**
 * How a channel starts a file job once it is uploaded (#328).
 *
 * - `command`: the channel sends a start (the A350's SSTP `start_print`) and
 *   `startGcodeJob()` reports the controller's answer.
 * - `operator-switch`: the controller has NO start command for an uploaded
 *   file. The Snapmaker Ray (SACP over UDP, firmware V1.7.4) runs the file
 *   `/ray.nc` only when the operator presses and holds its work switch:
 *   RayController file_manager.cpp `hmi_req_cb_start_file_print` says "here
 *   wouldn't start print, need use press button" and ACKs without starting,
 *   and Luban's own Ray UI (RayUploadWidget) uploads `ray.nc` and tells the
 *   operator to press the switch. The MCP uploads the file, records the job
 *   `armed`, and adopts the run from the heartbeat when the operator starts it.
 *
 * `stop` says what the channel's `stopGcodeJob` can stop: the A350's
 * `stop_print` ends whatever the controller runs; the Ray's SACP job stop
 * (0xAC 0x06, file_manager.cpp `hmi_req_cb_stop_file_print`) stops a FILE
 * print only and raises a non-blocking alarm when nothing is printing, so it
 * is never sent for a direct step or to an idle machine.
 */
export interface FileJobTransport {
    start: 'command' | 'operator-switch';
    /** The filename the controller runs (the Ray: `ray.nc`); null when the channel keeps the job's own name. */
    target: string | null;
    /** What the operator must do to start it; null for a command start. */
    instruction: string | null;
    stop: 'any-job' | 'file-print-only';
}

/** The transport of a channel that declares none: the A350's HTTP path, unchanged. */
export const COMMAND_FILE_JOB_TRANSPORT: FileJobTransport = { start: 'command', target: null, instruction: null, stop: 'any-job' };

/** The filename the controller will report for a job uploaded through `transport`. */
export function fileJobTarget(transport: FileJobTransport, jobName: string): string {
    return transport.target || `${jobName}.nc`;
}

/**
 * What a channel's uploadGcodeFile callback says beside its message (#328).
 * The SSTP channel passes the controller's data; the SACP channel passes one
 * of these so the start can tell a definite refusal from a lost result.
 */
export interface FileJobUploadOutcome {
    /** Refused before anything was sent (a gcode lease is held): the approval was not spent on the machine. */
    notSent?: boolean;
    /** The controller may hold the file although no result arrived: never retry blindly. */
    uncertain?: boolean;
    /** The controller (or the local read) definitely refused the file: nothing usable is on it. */
    rejected?: boolean;
    /** The filename the controller holds. */
    target?: string;
}

export interface FileStartReport {
    timestamp: number;
    status?: unknown;
    gcodePrintingInfo?: { name?: string; total?: number; sent?: number; progress?: number };
}

export interface FileStartAttempt {
    requestedAt: number;
    acknowledged: boolean;
    observedRunningAt: number | null;
    error: string | null;
    machineStatusAfter: string | null;
    retrySafe: boolean;
    /** An operator-switch transport: the file is on the controller, waiting for the switch (#328). */
    operatorStart?: { target: string; instruction: string; armedAt: number } | null;
}

/** `/ray.nc` and `ray.nc` are the same file: the Ray reports the SD path, Luban uploads the basename. */
function sameFile(reported: string, expected: string): boolean {
    const strip = (name: string) => name.replace(/^\/+/, '');
    return strip(reported) === strip(expected);
}

/** Only a new, fresh report from the original session can identify this run. */
export function fileStartEvidence(report: FileStartReport | null, requestedAt: number, now: number,
    sameConnection: boolean, filename: string, lineCount?: number): 'active' | 'idle' | 'unknown' {
    if (!sameConnection || !report || report.timestamp <= requestedAt
        || report.timestamp > now || now - report.timestamp > 10000) {
        return 'unknown';
    }
    const name = report.gcodePrintingInfo?.name;
    if (name && !sameFile(name, filename)) {
        return 'unknown';
    }
    if (FILE_JOB_ACTIVE_STATUSES.includes(String(report.status))) {
        const total = report.gcodePrintingInfo?.total;
        if (!name && total && lineCount && total !== lineCount) {
            return 'unknown';
        }
        return 'active';
    }
    return report.status === 'idle' ? 'idle' : 'unknown';
}
