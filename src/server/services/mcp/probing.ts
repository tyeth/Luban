import { connectionManager } from '../machine/ConnectionManager';
import { ProbeChannel, probeFeedService } from './probeFeed';
import { McpToolError } from './registry';
import { GcodeChannel, sendGcodeVisible } from './tools/camera';
import { assertFreshHeartbeat, getPositionSnapshot } from './tools/machine';

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

/**
 * Issue one absolute machine-frame move and block until it verifiably
 * completed. Fast path: the HTTP channel executes gcode synchronously and its
 * reply echoes the completed position in WORK coordinates - an exact match
 * (0.02 mm) is proof of arrival with no heartbeat wait. Fallback: heartbeat
 * settle (report newer than issue, machine idle, axes at target; moves larger
 * than 3x the tolerance accept the first at-target beat, smaller ones require
 * a stable double-beat since a stale beat could pass). The overtravel latch
 * is re-checked before the move and on every poll.
 */
async function moveMachineSettledUnguarded(
    tool: string,
    target: { x?: number; y?: number; z?: number },
    feed: number
): Promise<void> {
    probeFeedService.assertNoOvertravel();
    const channel = getDirectChannel();
    const words = [
        target.x !== undefined ? `X${target.x.toFixed(3)}` : '',
        target.y !== undefined ? `Y${target.y.toFixed(3)}` : '',
        target.z !== undefined ? `Z${target.z.toFixed(3)}` : '',
    ].filter(Boolean).join(' ');
    const gcode = `G90\nG53;\nG1 ${words} F${feed};\nG54;`;

    const before = getPositionSnapshot();
    const bigMove = (['x', 'y', 'z'] as const).every((axis) => {
        const want = target[axis];
        if (want === undefined) {
            return true;
        }
        const from = before.machine[axis];
        return from !== null && Math.abs(want - from) > SETTLE_TOLERANCE_MM * 3;
    });

    const issuedAt = Date.now();
    const executed = await sendGcodeVisible(channel, tool, gcode);
    if (executed.result !== 0) {
        throw new ProcedureAbort(`Controller rejected the move: ${executed.text || executed.result}`);
    }

    const echo = String(executed.text || '').match(/X:(-?\d+(?:\.\d+)?)\s+Y:(-?\d+(?:\.\d+)?)\s+Z:(-?\d+(?:\.\d+)?)/);
    if (echo) {
        const offset = before.originOffset;
        const echoMachine = {
            x: Number(echo[1]) - offset.x,
            y: Number(echo[2]) - offset.y,
            z: Number(echo[3]) - offset.z,
        };
        const exact = (['x', 'y', 'z'] as const).every((axis) => {
            const want = target[axis];
            return want === undefined || Math.abs(echoMachine[axis] - want) <= 0.02;
        });
        if (exact) {
            return;
        }
    }

    const deadline = issuedAt + SETTLE_TIMEOUT_MS;
    let previous: string | null = null;
    while (Date.now() < deadline) {
        await sleep(SETTLE_POLL_MS);
        probeFeedService.assertNoOvertravel();
        let now;
        try {
            now = getPositionSnapshot();
        } catch (err) {
            continue;
        }
        const reportTime = Date.now() - now.reportAgeMs;
        const fingerprint = JSON.stringify([now.work, now.originOffset]);
        const stable = fingerprint === previous;
        previous = fingerprint;
        if (reportTime <= issuedAt || now.machineStatus !== 'idle') {
            continue;
        }
        if (!bigMove && !stable) {
            continue;
        }
        const atTarget = (['x', 'y', 'z'] as const).every((axis) => {
            const want = target[axis];
            const have = now.machine[axis];
            return want === undefined || (have !== null && Math.abs(have - want) <= SETTLE_TOLERANCE_MM);
        });
        if (atTarget) {
            return;
        }
    }
    throw new ProcedureAbort(`Timed out waiting for the heartbeat to verify the move to ${words}.`);
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
    feed: number
): Promise<void> {
    probeFeedService.motionBegin();
    try {
        await moveMachineSettledUnguarded(tool, target, feed);
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
export async function senseAfter(
    channels: ProbeChannel | ProbeChannel[],
    stepIssuedAt: number,
    delayMs: number
): Promise<StepResult> {
    const list = Array.isArray(channels) ? channels : [channels];
    const deadline = Date.now() + delayMs;
    for (;;) {
        for (const channel of list) {
            const state = probeFeedService.getReading(channel);
            if (state && state.triggered) {
                return {
                    contact: true,
                    reading: { value: state.value, receivedAt: state.receivedAt },
                    channel,
                };
            }
        }
        if (Date.now() >= deadline) {
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
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const states = list.map((channel) => ({ channel, state: probeFeedService.getReading(channel) }));
        const stillTriggered = states.find((s) => s.state && s.state.triggered);
        if (!stillTriggered) {
            const first = states[0].state;
            return {
                contact: false,
                reading: first ? { value: first.value, receivedAt: first.receivedAt } : null,
                channel: states[0].channel,
            };
        }
        if (Date.now() >= deadline) {
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
