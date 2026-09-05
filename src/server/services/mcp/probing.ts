import { connectionManager } from '../machine/ConnectionManager';
import { mcpBroadcast } from './index';
import {
    AXES,
    BeatObservation,
    NullableXyz,
    PositionSource,
    Xyz,
    completeTarget,
    describeReport,
    getPositionOfRecord,
    getTrustedOffset,
    judgeRecheck,
    machineFromReport,
    matchFrameWithOffsets,
    setPositionOfRecord,
    setTrustedOffset,
} from './positionOfRecord';
import { ProbeChannel, probeFeedService, resolveSensorEnabled, sensorLabel } from './probeFeed';
import { McpToolError } from './registry';
import { GcodeChannel, currentGcodeSequence, sendGcodeVisible } from './tools/camera';
import { PositionSnapshot, assertFreshHeartbeat, getPositionSnapshot } from './tools/machine';

// The shared sensor-gated motion engine: settled single moves on the direct
// path, contact/release sensing against a probe feed channel, and the
// readiness guard. Extracted from the tool setter (where every piece was
// hardware-proven 2026-08-31/09-01) so the CNC touch probe reuses the exact
// same verified mechanics against its own feed channel.

export const TRAVEL_FEED = 600; // mm/min, matches the move_z cap
export const COARSE_FEED = 100;
export const FINE_FEED = 60;
const SETTLE_TIMEOUT_MS = 30000;
const SETTLE_POLL_MS = 250;
export const SETTLE_TOLERANCE_MM = 0.15;
export const MAX_RETREAT_MM = 5; // still triggered after this much retreat = stuck sensor
const SENSE_OVERRUN_MS = 200;

export interface SenseTiming {
    kind: 'contact' | 'release';
    windowMs: number;
    elapsedMs: number;
    endedAt: number;
    contact: boolean;
}

/** The most recent sensor wait (window asked for, time it took, when it ended) - stamped on the next send event. */
let lastSense: SenseTiming | null = null;

export function getLastSense(): SenseTiming | null {
    return lastSense;
}

/**
 * Step trace: wall-clock marks at every boundary between one controller
 * reply and the next send, attached to that send's event. Job cdbc29371b97
 * (2026-09-05) placed the whole 1-4.5 s idle between the reply and the
 * start of the sensor wait - a stretch of synchronous code and promise
 * resumptions with no timer in it - so each boundary is stamped:
 * reply-returned (sendGcodeVisible handed back), echo-match / echo-miss,
 * engine-exit, settled-exit (moveMachineSettled returned), sense-start,
 * sense-end, then the runner enters the engine again.
 */
const stepTrace: { label: string; at: number }[] = [];

export function traceMark(label: string): void {
    stepTrace.push({ label, at: Date.now() });
    if (stepTrace.length > 24) {
        stepTrace.splice(0, stepTrace.length - 24);
    }
}

/** Marks since the previous send as "label+ms" relative to `since`, then reset. */
export function takeStepTrace(since: number | null): string | undefined {
    if (!stepTrace.length) {
        return undefined;
    }
    const base = since === null ? stepTrace[0].at : since;
    const text = stepTrace.map((mark) => `${mark.label}+${mark.at - base}`).join(' ');
    stepTrace.length = 0;
    return text;
}

export class ProcedureAbort extends Error {}

export interface StepResult {
    contact: boolean;
    reading: { value: string; receivedAt: number } | null;
    // Which channel fired, when sensing across several (e.g. measuring the
    // spindle touch probe on the tool setter accepts either).
    channel?: ProbeChannel;
}

export function getDirectChannel(): GcodeChannel {
    const channel = connectionManager.getCurrentChannel() as unknown as GcodeChannel;
    if (!channel || typeof channel.executeGcode !== 'function') {
        throw new ProcedureAbort('No machine channel with direct command support.');
    }
    return channel;
}

export async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

// Operator rule (2026-09-05): a move of <= INCH_ESTIMATE_MM whose controller
// reply carried no contradicting position may be taken as arrived when the
// heartbeat has not caught up within INCH_GRACE_MS - inching must not be paced
// by the 2 s status poll. Recorded as an `estimated` position of record.
export const INCH_ESTIMATE_MM = 1;
const INCH_GRACE_MS = 400;
const INCH_GRACE_POLL_MS = 100;
const ECHO_TOLERANCE_MM = 0.02;

function parseEcho(text: string | undefined): NullableXyz | null {
    const echo = String(text || '').match(/X:(-?\d+(?:\.\d+)?)\s+Y:(-?\d+(?:\.\d+)?)\s+Z:(-?\d+(?:\.\d+)?)/);
    return echo ? { x: Number(echo[1]), y: Number(echo[2]), z: Number(echo[3]) } : null;
}

/**
 * Issue one absolute machine-frame move and block until it verifiably
 * completed. Fast path: the HTTP channel executes gcode synchronously and its
 * reply echoes the completed position - an exact match (0.02 mm) in EITHER
 * frame (work coordinates normally; raw machine coordinates when the reply
 * was framed inside the G53 window - positionOfRecord.ts) is proof of
 * arrival with no heartbeat wait. Fallback: heartbeat settle (report newer
 * than issue, machine idle, axes at target in either frame; moves larger than
 * 3x the tolerance accept the first at-target beat, smaller ones require two
 * DISTINCT agreeing beats since a stale beat could pass). Moves of <= 1 mm
 * with no contradicting echo are estimated after a short grace (operator
 * rule above). Every verified arrival becomes the position of record. The
 * overtravel latch is re-checked before the move and on every poll.
 */
export interface MoveOptions {
    /**
     * Descent segments (operator law 2026-09-05): the controller's ok is
     * enough - never wait on the heartbeat when the echo is missing or
     * misframed; record the commanded position as `estimated` and move on.
     * Each segment is <= DESCENT_SEGMENT_MM and sensor-checked by the caller.
     */
    lenient?: boolean;
}

async function moveMachineSettledUnguarded(
    tool: string,
    target: { x?: number; y?: number; z?: number },
    feed: number,
    options: MoveOptions = {}
): Promise<void> {
    const enteredAt = Date.now();
    traceMark('engine-enter');
    probeFeedService.assertNoOvertravel();
    const channel = getDirectChannel();
    const words = [
        target.x !== undefined ? `X${target.x.toFixed(3)}` : '',
        target.y !== undefined ? `Y${target.y.toFixed(3)}` : '',
        target.z !== undefined ? `Z${target.z.toFixed(3)}` : '',
    ].filter(Boolean).join(' ');
    const gcode = `G90\nG53;\nG1 ${words} F${feed};\nG54;`;

    const before = getPositionSnapshot();
    // Where the move starts: the engine's own record while it is current (no
    // other gcode since it was taken), else the heartbeat.
    const record = getPositionOfRecord(currentGcodeSequence());
    const from: NullableXyz = record ? record.machine : before.machine;
    const deltas = AXES
        .filter((axis) => target[axis] !== undefined)
        .map((axis) => (from[axis] === null ? null : Math.abs((target[axis] as number) - (from[axis] as number))));
    const bigMove = deltas.every((d) => d !== null && d > SETTLE_TOLERANCE_MM * 3);
    const inchMove = deltas.every((d) => d !== null && d <= INCH_ESTIMATE_MM);

    const issuedAt = Date.now();
    // Timing stamps for the send event (diagnostics): how long the engine
    // took from entry to send, and what the last sensor wait cost - so an
    // idle gap between steps can be attributed to the runner, the sensor
    // window, or the engine (job d8f6ec1b5c11: 1-4 s idles, echo matched,
    // event loop idle - unexplained without this).
    const executed = await sendGcodeVisible(channel, tool, gcode, { enteredAt, lastSense, trace: takeStepTrace(null) });
    traceMark('reply-returned');
    if (executed.result !== 0) {
        throw new ProcedureAbort(`Controller rejected the move: ${executed.text || executed.result}`);
    }
    const arrived = (machine: NullableXyz, source: PositionSource) => {
        const full = completeTarget(machine, target);
        if (full) {
            setPositionOfRecord(full, source, executed.sequence, tool);
        }
        traceMark(`engine-exit:${source}`);
    };

    // Offsets to judge the echo with: the engine's own trusted offset (the
    // one that last proved an arrival) before whatever the latest heartbeat
    // carried - which reads 0,0,0 inside G53 windows and cost 28 settle-waits
    // in the run after the snapshot fix.
    const offsetCandidates: Xyz[] = [];
    const trusted = getTrustedOffset();
    if (trusted) {
        offsetCandidates.push(trusted);
    }
    offsetCandidates.push(before.originOffset);
    const echo = parseEcho(executed.text);
    let echoContradicts = false;
    if (echo) {
        const match = matchFrameWithOffsets(echo, offsetCandidates, target, ECHO_TOLERANCE_MM);
        if (match) {
            traceMark(`echo-match:${match.frame}`);
            if (match.frame === 'work-frame') {
                setTrustedOffset(match.offset);
            }
            arrived(machineFromReport(echo, match.offset, match.frame), 'echo');
            return;
        }
        traceMark('echo-miss');
        echoContradicts = true;
    } else {
        traceMark('echo-absent');
    }

    if (options.lenient) {
        const estimate = completeTarget(from, target);
        if (estimate) {
            setPositionOfRecord(estimate, 'estimated', executed.sequence, tool);
            traceMark('engine-exit:estimated-lenient');
            mcpBroadcast('mcp:activity', {
                tool,
                phase: 'position-estimated',
                note: `${words}: descent segment - controller accepted, ${echo ? 'echo misframed' : 'no echo'}; not waiting on the `
                    + 'heartbeat (operator rule 2026-09-05), commanded position recorded as estimated',
            });
            return;
        }
    }

    // Reaching here means the controller's reply did not prove arrival. Say
    // so on the job record with the evidence (job cdbc29371b97 placed 1-4 s
    // idles between the reply and the sensor window; this is the only
    // heartbeat wait in that stretch, so it must announce itself).
    mcpBroadcast('mcp:activity', {
        tool,
        phase: 'settle-wait',
        note: `${words}: ${echo ? 'echo did not match either frame' : 'no position echo'} - waiting on the heartbeat`,
        echo: echo ? `${echo.x},${echo.y},${echo.z}` : null,
        offset: `${before.originOffset.x},${before.originOffset.y},${before.originOffset.z}`,
        offsetSource: before.originOffsetSource,
        trustedOffset: trusted ? `${trusted.x},${trusted.y},${trusted.z}` : null,
        target: words,
        inchMove,
        bigMove,
    });
    const settleStartedAt = Date.now();
    const deadline = issuedAt + SETTLE_TIMEOUT_MS;
    let graceUntil: number | null = inchMove && !echoContradicts ? issuedAt + INCH_GRACE_MS : null;
    let previous: string | null = null;
    let previousReportTime: number | null = null;
    while (Date.now() < deadline) {
        await sleep(graceUntil !== null ? INCH_GRACE_POLL_MS : SETTLE_POLL_MS);
        probeFeedService.assertNoOvertravel();
        let now: PositionSnapshot;
        try {
            now = getPositionSnapshot();
        } catch (err) {
            continue;
        }
        const reportTime = now.reportedAt;
        const fingerprint = JSON.stringify([now.work, now.originOffset]);
        // "Stable" = two DISTINCT beats agreeing (the poll here is faster than
        // the 2 s heartbeat, so the same beat read twice proves nothing).
        const stable = fingerprint === previous && previousReportTime !== null && previousReportTime !== reportTime;
        if (previousReportTime !== reportTime) {
            previous = fingerprint;
            previousReportTime = reportTime;
        }
        const fresh = reportTime > issuedAt && now.machineStatus === 'idle';
        if (fresh && (bigMove || stable)) {
            const beatOffsets = trusted ? [now.originOffset, trusted] : [now.originOffset];
            const match = matchFrameWithOffsets(now.work, beatOffsets, target, SETTLE_TOLERANCE_MM);
            if (match) {
                mcpBroadcast('mcp:activity', {
                    tool,
                    phase: 'settle-done',
                    note: `${words}: heartbeat (${match.frame}) confirmed arrival after ${Date.now() - settleStartedAt} ms`,
                });
                if (match.frame === 'work-frame') {
                    setTrustedOffset(match.offset);
                }
                arrived(machineFromReport(now.work, match.offset, match.frame), 'heartbeat');
                return;
            }
        }
        if (graceUntil !== null && Date.now() >= graceUntil) {
            graceUntil = null;
            // No post-issue report at all yet: the status poll is simply
            // behind a move this small. A fresh report that disagrees is NOT
            // estimated over - fall through to the full settle wait.
            const estimate = fresh ? null : completeTarget(from, target);
            if (estimate) {
                setPositionOfRecord(estimate, 'estimated', executed.sequence, tool);
                mcpBroadcast('mcp:activity', {
                    tool,
                    phase: 'position-estimated',
                    note: `${words}: controller accepted a <= ${INCH_ESTIMATE_MM} mm move with no position echo and the `
                        + `latest status report is ${Date.now() - reportTime} ms old - taking the commanded position as `
                        + 'arrived (operator rule 2026-09-05)',
                });
                return;
            }
        }
    }
    throw new ProcedureAbort(`Timed out waiting for the heartbeat to verify the move to ${words}.`);
}

/**
 * Where the engine knows the machine to be: its position of record while it
 * is current (the last verified arrival, no other gcode since), else the
 * heartbeat snapshot. Runners must use THIS, not a bare snapshot, to decide
 * their next move: job 42df7b9351b7 (2026-09-05) read a single zero-offset
 * beat as machine Z-8 while the traverse echo had just verified Z320, skipped
 * the fast descent and aborted at the station check.
 */
export function knownMachinePosition(): { position: NullableXyz; source: 'record' | 'heartbeat'; snapshot: PositionSnapshot } {
    const snapshot = getPositionSnapshot();
    const record = getPositionOfRecord(currentGcodeSequence());
    if (record) {
        return { position: { ...record.machine }, source: 'record', snapshot };
    }
    return { position: snapshot.machine, source: 'heartbeat', snapshot };
}

export const RECHECK_TOLERANCE_MM = 0.5;
const RECHECK_MAX_MS = 4500; // more than two 2 s heartbeat periods
const RECHECK_POLL_MS = 250;

export interface PositionCheck {
    /** What settled it: a heartbeat in one of the two frames, or the engine's record. */
    frame: 'work-frame' | 'machine-frame' | 'record';
    waitedMs: number;
    /** Set when the check did not pass on the first, plainly-framed read - worth announcing. */
    note: string | null;
}

/**
 * Verify the machine is at `expected` (machine coordinates) before trusting
 * the sensor. Decision (positionOfRecord.judgeRecheck): the latest heartbeat
 * matching in either frame passes; the position of record passes while the
 * heartbeat still predates it; two distinct heartbeats agreeing on somewhere
 * else abort at once (real drift); otherwise keep reading for up to
 * RECHECK_MAX_MS. Replaces the per-runner "re-read once after 1.2 s" checks
 * that aborted job 1db4902a4cd6 on one stale beat and one G53-window beat.
 */
export async function expectMachinePosition(
    expected: Xyz,
    what: string,
    onMismatch: (message: string) => Error,
    toleranceMm: number = RECHECK_TOLERANCE_MM
): Promise<PositionCheck> {
    const record = getPositionOfRecord(currentGcodeSequence());
    const startedAt = Date.now();
    const beats: BeatObservation[] = [];
    let first: PositionSnapshot | null = null;
    for (;;) {
        const snapshot = getPositionSnapshot();
        if (!first) {
            first = snapshot;
        }
        const reportTime = snapshot.reportedAt;
        beats.push({ reportTime, raw: snapshot.work, offset: snapshot.originOffset });
        if (beats.length > 3) {
            beats.shift();
        }
        const verdict = judgeRecheck(beats, expected, toleranceMm, record);
        const waitedMs = Date.now() - startedAt;
        if (verdict.verdict === 'pass') {
            if (verdict.frame === 'record') {
                const r = verdict.record;
                return {
                    frame: 'record',
                    waitedMs,
                    note: `latest status report (${Math.round(Date.now() - reportTime)} ms old) predates the last verified `
                        + `move; position of record (${r.machine.x}, ${r.machine.y}, ${r.machine.z}) from ${r.tool} `
                        + `(${r.source}) used`,
                };
            }
            let note: string | null = null;
            if (verdict.frame === 'machine-frame') {
                note = 'status report carried machine-frame coordinates (G53 window) - accepted as such';
            } else if (waitedMs > 0) {
                note = `passed after ${waitedMs} ms (earlier reads were transient)`;
            }
            return { frame: verdict.frame, waitedMs, note };
        }
        if (verdict.verdict === 'drift' || waitedMs >= RECHECK_MAX_MS) {
            const why = verdict.verdict === 'drift'
                ? 'two consecutive status reports agree the machine is elsewhere'
                : `no status report matched within ${RECHECK_MAX_MS} ms`;
            const recordText = record
                ? `Position of record: (${record.machine.x}, ${record.machine.y}, ${record.machine.z}) from ${record.tool} (${record.source}).`
                : 'No position of record.';
            throw onMismatch(`${what}: the plan expects machine (${expected.x}, ${expected.y}, ${expected.z}) but ${why}. `
                + `Latest: ${describeReport(snapshot.work, snapshot.originOffset, snapshot.originOffsetSource)}. `
                + `First read: ${describeReport(first.work, first.originOffset, first.originOffsetSource)}. ${recordText}`);
        }
        await sleep(RECHECK_POLL_MS);
    }
}

/**
 * moveMachineSettledUnguarded inside the motion-in-flight bracket: while the
 * move runs, a contact sensor the procedure did NOT declare as expected
 * (setExpectedContact) firing is a collision and latches CRASH, and the
 * overtravel tripwire is armed (operator, 2026-09-04: alarm on unexpected
 * probe contact during an X/Y/Z move outside the region of interest).
 */
export async function moveMachineSettled(
    tool: string,
    target: { x?: number; y?: number; z?: number },
    feed: number,
    options: MoveOptions = {}
): Promise<void> {
    probeFeedService.motionBegin();
    try {
        await moveMachineSettledUnguarded(tool, target, feed, options);
        traceMark('settled-exit');
    } finally {
        probeFeedService.motionEnd();
    }
}


/**
 * CONTACT detection after a settled step: give the sensor's report a short
 * window to arrive (early-exit on a fresh reading), then judge from the LAST
 * KNOWN state - the sensor publishes on change, so silence means unchanged.
 * A late contact message merely costs one extra step (self-correcting).
 */
function noteSense(kind: 'contact' | 'release', windowMs: number, startedAt: number, contact: boolean): void {
    const endedAt = Date.now();
    lastSense = { kind, windowMs, elapsedMs: endedAt - startedAt, endedAt, contact };
    traceMark(`sense-end:${kind}${contact ? ':contact' : ''}`);
}

export async function senseAfter(
    channels: ProbeChannel | ProbeChannel[],
    stepIssuedAt: number,
    delayMs: number
): Promise<StepResult> {
    const list = Array.isArray(channels) ? channels : [channels];
    const startedAt = Date.now();
    traceMark('sense-start');
    const deadline = startedAt + delayMs;
    for (;;) {
        for (const channel of list) {
            const state = probeFeedService.getReading(channel);
            if (state && state.triggered) {
                noteSense('contact', delayMs, startedAt, true);
                return {
                    contact: true,
                    reading: { value: state.value, receivedAt: state.receivedAt },
                    channel,
                };
            }
        }
        if (Date.now() >= deadline) {
            noteSense('contact', delayMs, startedAt, false);
            // Diagnostics: the window is timer-paced; finishing well past it
            // means the server's timers ran late (diagnostics.ts).
            const overrun = Date.now() - deadline;
            if (overrun > SENSE_OVERRUN_MS) {
                mcpBroadcast('mcp:activity', {
                    tool: 'diagnostics',
                    phase: 'sense_overrun',
                    ms: overrun,
                    note: `sensor window of ${delayMs} ms finished ${overrun} ms late - timers delayed (event loop or CPU)`,
                });
            }
            const state = probeFeedService.getReading(list[0]);
            return {
                contact: false,
                reading: state ? { value: state.value, receivedAt: state.receivedAt } : null,
                channel: list[0],
            };
        }
        await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
}

/**
 * RELEASE detection needs different patience: a stale "triggered" here is a
 * false abort (live-hit on the tool setter: the cloud round-trip of the
 * release message exceeded the contact window). Wait until the last known
 * state reads untriggered, early-exiting on fresh readings, up to timeoutMs;
 * only then is "still triggered" believed.
 */
export async function senseReleaseAfter(
    channels: ProbeChannel | ProbeChannel[],
    stepIssuedAt: number,
    timeoutMs: number
): Promise<StepResult> {
    const list = Array.isArray(channels) ? channels : [channels];
    const startedAt = Date.now();
    traceMark('sense-start:release');
    const deadline = startedAt + timeoutMs;
    for (;;) {
        const states = list.map((channel) => ({ channel, state: probeFeedService.getReading(channel) }));
        const stillTriggered = states.find((s) => s.state && s.state.triggered);
        if (!stillTriggered) {
            noteSense('release', timeoutMs, startedAt, false);
            const first = states[0].state;
            return {
                contact: false,
                reading: first ? { value: first.value, receivedAt: first.receivedAt } : null,
                channel: states[0].channel,
            };
        }
        if (Date.now() >= deadline) {
            noteSense('release', timeoutMs, startedAt, true);
            return {
                contact: true,
                reading: stillTriggered.state
                    ? { value: stillTriggered.state.value, receivedAt: stillTriggered.state.receivedAt }
                    : null,
                channel: stillTriggered.channel,
            };
        }
        await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
}

/**
 * The sensor must be connected, have reported at least once, and read
 * untriggered before any sensor-gated approach may start.
 */
export function assertChannelReady(channel: ProbeChannel, what: string): void {
    probeFeedService.assertNoOvertravel();
    if (!resolveSensorEnabled()[channel]) {
        throw new McpToolError(`The ${sensorLabel(channel)} is disabled (Settings -> MCP Server -> Probe sensor feed). `
            + `Ask the operator to enable it before a ${what} run.`);
    }
    if (!probeFeedService.isConnected()) {
        throw new McpToolError('Probe feed is not connected - connect_probe_feed first. The overtravel '
            + `tripwire MUST be armed for a ${what} run.`);
    }
    const reading = probeFeedService.getReading(channel);
    if (!reading) {
        throw new McpToolError(`No reading has ever arrived on the ${channel} feed - cannot trust the `
            + 'sensor. Ask the operator to trigger it by hand and watch get_probe_feed_status until '
            + 'the touch shows up.');
    }
    if (reading.triggered) {
        throw new McpToolError(`The ${channel} feed already reads triggered ("${reading.value}") before `
            + 'any approach - the sensor is stuck or already in contact. Resolve physically first.');
    }
}

/** Machine idle, homed, toolhead off - the common motion preconditions. */
export function assertMachineReadyForProcedure(): void {
    assertFreshHeartbeat('a probing procedure');
    const position = getPositionSnapshot();
    if (position.machineStatus !== 'idle') {
        throw new McpToolError(`Machine is ${position.machineStatus || 'in an unknown state'}, not idle.`);
    }
    if (position.isHomed !== true) {
        throw new McpToolError('Machine does not report homed; home first.');
    }
    const state = connectionManager.getLatestMachineState() as { headStatus?: unknown; headPower?: unknown } | null;
    const headPower = Number(state && state.headPower);
    if ((Number.isFinite(headPower) && headPower > 0) || (state && (state.headStatus === true || state.headStatus === 'on'))) {
        throw new McpToolError('Toolhead appears to be on; refusing to run the procedure.');
    }
}

/** Longest single Z move toward the work a procedure may issue (operator law 2026-09-05). */
export const DESCENT_SEGMENT_MM = 5;

/**
 * Descend from `fromZ` to `toZ` (machine Z) in segments of at most
 * DESCENT_SEGMENT_MM. Operator law (2026-09-05): a single long G1 toward the
 * work cannot be stopped once sent - a collision would be driven to the end
 * of the move - so every descent is chopped, and NO segment waits on the
 * heartbeat (lenient settle: the controller's ok is the gate).
 *
 * Contact detection during the descent is ASYNCHRONOUS (operator, same day):
 * the probe feed's crash guard already latches the CRASH alarm the moment a
 * channel the procedure did not declare as expected fires while motion is
 * in flight (probeFeed.onReading -> tripSafety: job stop + connection close),
 * and every segment re-checks the latch before it is sent, so a hit ends the
 * descent within one segment (<= 5 mm) without a serial sensor wait between
 * segments. Callers MUST have cleared the expected-contact set for the
 * channels a hit would arrive on (a descent expects no contact). Where a
 * manoeuvre needs a synchronous verdict as well, `serialCheck` adds a
 * senseAfter window after every segment and aborts on contact.
 * Upward moves are a single move: they leave the work.
 */
export async function descendInSegments(
    tool: string,
    fromZ: number,
    toZ: number,
    channels: ProbeChannel | ProbeChannel[],
    sensorDelayMs: number,
    options: { feed?: number; serialCheck?: boolean } = {}
): Promise<{ segments: number }> {
    const feed = options.feed === undefined ? TRAVEL_FEED : options.feed;
    if (toZ >= fromZ - 1e-9) {
        await moveMachineSettled(tool, { z: Number(toZ.toFixed(3)) }, feed);
        return { segments: 1 };
    }
    let z = fromZ;
    let segments = 0;
    while (z - toZ > 1e-9) {
        z = Math.max(Number((z - DESCENT_SEGMENT_MM).toFixed(3)), toZ);
        segments += 1;
        const t0 = Date.now();
        // assertNoOvertravel() inside the engine refuses this segment if the
        // crash guard latched during the previous one.
        await moveMachineSettled(tool, { z }, feed, { lenient: true });
        if (options.serialCheck) {
            const sensed = await senseAfter(channels, t0, sensorDelayMs);
            if (sensed.contact) {
                throw new ProcedureAbort(`UNEXPECTED CONTACT (${sensed.channel}) during the descent at Z${z.toFixed(3)} - something is `
                    + 'where the plan says nothing should be. Machine held.');
            }
        }
    }
    // The latch may have fired on the LAST segment with nothing sent after
    // it: surface it here rather than at the caller's next move.
    probeFeedService.assertNoOvertravel();
    return { segments };
}
