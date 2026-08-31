/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention (planToolSetterRun takes
// the run_tool_setter arguments verbatim).
import logger from '../../lib/logger';
import config from '../configstore';
import { connectionManager } from '../machine/ConnectionManager';
import { mcpBroadcast } from './index';
import { probeFeedService } from './probeFeed';
import { McpToolError } from './registry';
import { GcodeChannel, sendGcodeVisible } from './tools/camera';
import { getPositionSnapshot } from './tools/machine';

const log = logger('service:mcp:tool-setter');

// Tool height measurement against the fixed tool setter (the gold cylinder
// on the A350 bed; a normally-open switch that reports over the probe feed).
// The whole procedure is ONE operator approval: the confirm page shows the
// motion envelope (XY centre, start Z, hard floor Z, increments, feeds) and
// the server-side runner drives the steps deterministically against live
// sensor feedback - the model never chooses a Z during the run.
//
// Staged approach (operator-specified):
//   1. travel: XY to the centre at the current (post-home) Z, then Z down to
//      startZ = reference trigger Z + (longest bit - reference bit) + 50 mm
//   2. coarse: descend in 1 mm steps, checking the toolsetter feed after
//      each settled step, until contact
//   3. release: retreat in 1 mm steps until the feed reports released
//   4. fine: descend in 0.1 mm steps until contact
//   5. confirm: back off 0.3 mm, then descend 0.1 mm per >=2 s until contact
//   6. retreat to startZ and report
// A hard floor (expected trigger Z for the declared bit minus a margin)
// aborts the descent; the overtravel tripwire aborts everything at any time.

const CONFIG_KEY = 'mcpToolSetter';

const TRAVEL_FEED = 600; // mm/min, matches the move_z cap
const COARSE_FEED = 100;
const FINE_FEED = 60;
const SETTLE_TIMEOUT_MS = 30000;
const SETTLE_POLL_MS = 250;
const SETTLE_TOLERANCE_MM = 0.15;
const MAX_RETREAT_MM = 5; // still triggered after this much retreat = stuck sensor

export interface ToolSetterConfig {
    centerX: number; // machine coords of the setter's centre
    centerY: number;
    triggerZ: number; // machine Z at trigger with the reference bit fitted
    referenceBitLengthMm: number;
    longestBitLengthMm: number;
    floorMarginMm: number; // how far below the expected trigger Z to allow
    notes: string | null;
}

export function getToolSetterConfig(): ToolSetterConfig | null {
    const raw = config.get(CONFIG_KEY);
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const cfg = raw as { [key: string]: unknown };
    const numbers = ['centerX', 'centerY', 'triggerZ', 'referenceBitLengthMm', 'longestBitLengthMm'];
    if (numbers.some((key) => !Number.isFinite(Number(cfg[key])))) {
        return null;
    }
    return {
        centerX: Number(cfg.centerX),
        centerY: Number(cfg.centerY),
        triggerZ: Number(cfg.triggerZ),
        referenceBitLengthMm: Number(cfg.referenceBitLengthMm),
        longestBitLengthMm: Number(cfg.longestBitLengthMm),
        floorMarginMm: Number.isFinite(Number(cfg.floorMarginMm)) ? Number(cfg.floorMarginMm) : 3,
        notes: cfg.notes ? String(cfg.notes) : null,
    };
}

export function setToolSetterConfig(cfg: ToolSetterConfig): void {
    config.set(CONFIG_KEY, cfg);
    log.info(`Tool setter config stored: centre (${cfg.centerX}, ${cfg.centerY}), `
        + `trigger Z ${cfg.triggerZ} with ${cfg.referenceBitLengthMm} mm reference bit`);
}

export interface ToolSetterPlan {
    config: ToolSetterConfig;
    bitLengthMm: number;
    expectedTriggerZ: number;
    startZ: number;
    floorZ: number;
    // Bottom of the coarse ladder: coarse steps stop this far ABOVE the
    // expected trigger and the descent continues in fine steps, so a
    // correctly-declared bit presses at most one fine step into the setter
    // (a full coarse step can overrun by up to its own size - observed
    // 0.5 mm on the first live run).
    coarseFloorZ: number;
    slowZoneMm: number;
    coarseStepMm: number;
    fineStepMm: number;
    backoffMm: number;
    sensorDelayMs: number;
    confirmPasses: number;
    storeAsReference: boolean;
}

/**
 * Derive the motion envelope for a declared bit length. Throws McpToolError
 * with operator guidance when configuration or physics rule the run out.
 */
export function planToolSetterRun(args: {
    bit_length_mm?: number;
    coarse_step_mm?: number;
    fine_step_mm?: number;
    backoff_mm?: number;
    sensor_delay_ms?: number;
    confirm_passes?: number;
    start_clearance_mm?: number;
    slow_zone_mm?: number;
    store_as_reference?: boolean;
}): ToolSetterPlan {
    const cfg = getToolSetterConfig();
    if (!cfg) {
        throw new McpToolError('Tool setter is not configured. Ask the operator for the setter centre '
            + '(machine XY), the machine Z at trigger with a known bit, that bit\'s length, and the '
            + 'longest bit in use, then store them with set_tool_setter_config.');
    }
    const bitLengthMm = Number(args.bit_length_mm);
    if (!Number.isFinite(bitLengthMm) || bitLengthMm <= 0 || bitLengthMm > 300) {
        throw new McpToolError('bit_length_mm must be the approximate protrusion of the fitted bit in mm '
            + '(0-300), as stated by the operator.');
    }
    const coarseStepMm = Math.min(Math.max(Number(args.coarse_step_mm) || 1, 0.2), 2);
    const fineStepMm = Math.min(Math.max(Number(args.fine_step_mm) || 0.1, 0.02), 0.5);
    const backoffMm = Math.min(Math.max(Number(args.backoff_mm) || 0.3, fineStepMm), 2);
    // 200ms default is tuned to the operator's local-broker latency; the
    // hard floor and the overtravel tripwire backstop a missed message.
    const sensorDelayMs = Math.min(Math.max(Number(args.sensor_delay_ms) || 200, 100), 10000);
    const confirmPasses = Math.min(Math.max(Math.round(Number(args.confirm_passes) || 3), 1), 10);
    const startClearanceMm = Math.min(Math.max(Number(args.start_clearance_mm) || 30, 10), 150);
    const slowZoneMm = Math.min(Math.max(Number(args.slow_zone_mm) || 1, fineStepMm), 10);

    const expectedTriggerZ = cfg.triggerZ + (bitLengthMm - cfg.referenceBitLengthMm);
    const startZ = cfg.triggerZ + (cfg.longestBitLengthMm - cfg.referenceBitLengthMm) + startClearanceMm;
    const floorZ = expectedTriggerZ - cfg.floorMarginMm;
    if (floorZ < 0) {
        throw new McpToolError(`Computed floor Z ${floorZ.toFixed(1)} is below machine Z 0 - the declared `
            + 'bit length or stored trigger reference must be wrong. Re-check with the operator.');
    }
    if (startZ <= expectedTriggerZ) {
        throw new McpToolError('Computed start Z is at or below the expected trigger Z; check '
            + 'longestBitLengthMm and the clearance.');
    }

    return {
        config: cfg,
        bitLengthMm,
        expectedTriggerZ,
        startZ,
        floorZ,
        coarseFloorZ: Math.min(Math.max(expectedTriggerZ + slowZoneMm, floorZ), startZ),
        slowZoneMm,
        coarseStepMm,
        fineStepMm,
        backoffMm,
        sensorDelayMs,
        confirmPasses,
        storeAsReference: args.store_as_reference === true,
    };
}

/**
 * The gcode shown on the confirm page. Every line is sent INDIVIDUALLY: the
 * runner waits for each move to verifiably settle, then checks the sensor
 * feed, before issuing the next line - so the coarse descent is enumerated
 * step by step exactly as it would execute against a silent sensor. It stops
 * at the first contact, after which the fine/backoff/confirm steps repeat
 * the same one-command-per-check pattern in fine increments around the
 * contact Z (their exact targets depend on where contact happens, and all of
 * them lie between the contact Z plus backoff and the hard floor).
 */
export function describePlanAsGcode(plan: ToolSetterPlan): string {
    const c = plan.config;
    const lines = [
        '; TOOL SETTER MEASUREMENT PROCEDURE (server-driven, sensor-gated)',
        '; EVERY LINE IS SENT INDIVIDUALLY: after each move settles, the toolsetter',
        '; feed is checked before the next line is issued. Descent stops at first',
        '; contact - the full ladder below only executes if the sensor stays silent,',
        `; and then the run ABORTS at the hard floor Z ${plan.floorZ.toFixed(2)}.`,
        `; centre: machine X${c.centerX} Y${c.centerY}; declared bit ${plan.bitLengthMm} mm; expected trigger Z ${plan.expectedTriggerZ.toFixed(2)}`,
        '; overtravel feed trips -> job stop + connection close + latched alarm',
        'G90',
        'G53;',
        `G0 X${c.centerX.toFixed(3)} Y${c.centerY.toFixed(3)}; XY to setter centre at current (post-home) Z`,
        `G1 Z${plan.startZ.toFixed(3)} F${TRAVEL_FEED}; travel to start height`,
    ];
    let z = plan.startZ;
    let step = 0;
    while (z - plan.coarseStepMm >= plan.coarseFloorZ - 1e-9) {
        z = Math.max(z - plan.coarseStepMm, plan.coarseFloorZ);
        step += 1;
        lines.push(`G1 Z${z.toFixed(3)} F${COARSE_FEED}; coarse step ${step} - settle, check sensor, stop at contact`);
    }
    lines.push(
        `; coarse ladder ends ${plan.slowZoneMm} mm ABOVE the expected trigger; contact above this`,
        `; line means the bit is longer than declared (retreat ${plan.coarseStepMm} mm steps until released).`,
        `; SLOW ZONE - fine ${plan.fineStepMm} mm steps, max press into the setter = one step:`,
    );
    step = 0;
    while (z - plan.fineStepMm >= plan.floorZ - 1e-9) {
        z -= plan.fineStepMm;
        step += 1;
        lines.push(`G1 Z${z.toFixed(3)} F${FINE_FEED}; fine step ${step} - settle, check sensor, stop at contact`);
    }
    lines.push(
        `; ...on contact: ${plan.confirmPasses} quick confirm cycles, each = lift ${plan.backoffMm} mm, wait for the`,
        `; sensor to release, re-approach in ${plan.fineStepMm} mm steps to contact. Result = median of the`,
        '; cycle contacts (spread reported); a cycle never descends more than 0.5 mm below first contact.',
        `G1 Z${plan.startZ.toFixed(3)} F${TRAVEL_FEED}; retreat to start height when done (also on any abort)`,
        'G54;',
    );
    return lines.join('\n');
}

interface StepResult {
    contact: boolean;
    reading: { value: string; receivedAt: number } | null;
}

class ProcedureAbort extends Error {}

function getDirectChannel(): GcodeChannel {
    const channel = connectionManager.getCurrentChannel() as unknown as GcodeChannel;
    if (!channel || typeof channel.executeGcode !== 'function') {
        throw new ProcedureAbort('No machine channel with direct command support.');
    }
    return channel;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Issue one absolute machine-frame move and block until the heartbeat
 * verifiably reports it (same contract as move_z): report newer than issue,
 * two identical consecutive beats, machine idle, and axes at target.
 */
async function moveMachineSettled(
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

    // When every commanded axis moves by well over the tolerance, a stale
    // pre-move heartbeat cannot sit within tolerance of the target, so the
    // FIRST post-issue beat at the target is already proof of arrival - no
    // need to wait out a second identical beat (~1-1.5s/step saved on the
    // coarse ladder). Small steps (fine/confirm, at or under the tolerance)
    // keep the strict stable-double-beat rule. Judged from the position
    // BEFORE the move is issued.
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

    // Fast path: the HTTP channel executes gcode synchronously and its reply
    // echoes the position after completion ("X:.. Y:.. Z:.." in WORK
    // coordinates, hardware-observed to always match the exact target). An
    // exact echo match (0.02 mm, tighter than one fine step) is proof of
    // arrival with no heartbeat wait (~2s/step saved - the heartbeat only
    // ticks ~2s on the wifi channel). Anything less falls through to the
    // strict heartbeat settle below.
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
 * After a settled step, give the sensor's report time to arrive (early-exits
 * when a fresh reading lands), then judge contact from the LAST KNOWN state -
 * the sensor publishes on change, so silence means unchanged.
 *
 * This short window is for CONTACT detection while descending, where a late
 * message merely costs one extra step before detection (self-correcting).
 */
async function senseAfter(stepIssuedAt: number, delayMs: number): Promise<StepResult> {
    const fresh = await probeFeedService.waitForReading('toolsetter', stepIssuedAt, delayMs);
    const state = fresh || probeFeedService.getReading('toolsetter');
    return {
        contact: !!(state && state.triggered),
        reading: state ? { value: state.value, receivedAt: state.receivedAt } : null,
    };
}

/**
 * RELEASE detection needs different patience: a stale "triggered" here is a
 * false abort (live-hit on run 2: the cloud round-trip of the release
 * message exceeded the 200 ms contact window). Wait until the last known
 * state reads untriggered, early-exiting on fresh readings, up to timeoutMs;
 * only then is "still triggered" believed.
 */
async function senseReleaseAfter(stepIssuedAt: number, timeoutMs: number): Promise<StepResult> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const state = probeFeedService.getReading('toolsetter');
        if (state && !state.triggered) {
            return { contact: false, reading: { value: state.value, receivedAt: state.receivedAt } };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            return {
                contact: !!(state && state.triggered),
                reading: state ? { value: state.value, receivedAt: state.receivedAt } : null,
            };
        }
        await probeFeedService.waitForReading(
            'toolsetter',
            state ? state.receivedAt : stepIssuedAt,
            Math.min(remaining, 250)
        );
    }
}

function assertFeedReady(): void {
    probeFeedService.assertNoOvertravel();
    if (!probeFeedService.isConnected()) {
        throw new McpToolError('Probe feed is not connected - connect_probe_feed first. The overtravel '
            + 'tripwire MUST be armed for a tool setter run.');
    }
    const setter = probeFeedService.getReading('toolsetter');
    if (!setter) {
        throw new McpToolError('No reading has ever arrived on the toolsetter feed - cannot trust the '
            + 'sensor. Ask the operator to trigger the setter by hand and watch get_probe_feed_status '
            + 'until the touch shows up.');
    }
    if (setter.triggered) {
        throw new McpToolError(`The toolsetter feed already reads triggered ("${setter.value}") before `
            + 'any approach - the sensor is stuck or something is resting on it. Resolve physically first.');
    }
}

export interface ToolSetterResult {
    measuredTriggerZ: number;
    confirmPassContacts: number[];
    spreadMm: number;
    expectedTriggerZ: number;
    deltaMm: number;
    derivedBitLengthMm: number;
    phases: { phase: string; z: number; note?: string }[];
    storedAsReference: boolean;
    note: string;
    warning?: string;
}

/**
 * The operator-approved run. Every motion re-checks the overtravel latch;
 * any abort retreats to the start height when the machine still answers.
 */
export async function runToolSetterProcedure(plan: ToolSetterPlan): Promise<object> {
    assertFeedReady();
    const position = getPositionSnapshot();
    if (position.machineStatus !== 'idle') {
        throw new McpToolError(`Machine is ${position.machineStatus || 'in an unknown state'}, not idle.`);
    }
    if (position.isHomed !== true) {
        throw new McpToolError('Machine does not report homed; the tool setter centre is only valid '
            + 'after homing. Call home first.');
    }
    const state = connectionManager.getLatestMachineState() as { headStatus?: unknown; headPower?: unknown } | null;
    const headPower = Number(state && state.headPower);
    if ((Number.isFinite(headPower) && headPower > 0) || (state && (state.headStatus === true || state.headStatus === 'on'))) {
        throw new McpToolError('Toolhead appears to be on; refusing to run the tool setter.');
    }

    const phases: { phase: string; z: number; note?: string }[] = [];
    const c = plan.config;
    const announce = (phase: string, z: number, note?: string) => {
        phases.push({ phase, z: Number(z.toFixed(3)), note });
        mcpBroadcast('mcp:activity', { tool: 'run_tool_setter', phase, z: Number(z.toFixed(3)), note });
    };

    let currentZ = plan.startZ;
    try {
        // Phase 1: position over the centre, then travel down to start height.
        // XY first at the current (post-home, high) Z, so the bit never sweeps
        // across the bed at approach height.
        announce('travel-xy', position.machine.z ?? plan.startZ, `XY to (${c.centerX}, ${c.centerY})`);
        await moveMachineSettled('toolsetter:travel', { x: c.centerX, y: c.centerY }, TRAVEL_FEED);
        announce('travel-z', plan.startZ);
        await moveMachineSettled('toolsetter:travel', { z: plan.startZ }, TRAVEL_FEED);

        // Phase 2: coarse descent, sensor-checked after every settled step,
        // ONLY down to the slow zone above the expected trigger. Contact in
        // this phase means the bit is longer than declared (a coarse step can
        // press up to its own size into the setter - the slow zone keeps a
        // correctly-declared bit out of that regime).
        let coarseContactZ: number | null = null;
        while (currentZ - plan.coarseStepMm >= plan.coarseFloorZ - 1e-9) {
            const stepStart = Date.now();
            currentZ = Math.max(currentZ - plan.coarseStepMm, plan.coarseFloorZ);
            await moveMachineSettled('toolsetter:coarse', { z: currentZ }, COARSE_FEED);
            const sensed = await senseAfter(stepStart, plan.sensorDelayMs);
            if (sensed.contact) {
                coarseContactZ = currentZ;
                announce('coarse-contact', currentZ,
                    `sensor "${sensed.reading?.value}" ABOVE the slow zone - bit longer than declared`);
                break;
            }
        }

        // Release-type checks wait out the feed's real-world latency (the
        // release message has been observed arriving ~1s after the motion);
        // a short window here caused a false "hysteresis" abort on run 2.
        const releaseTimeoutMs = Math.max(plan.sensorDelayMs * 4, 2500);

        // Phase 3: only after a coarse contact - retreat until released, so
        // the fine approach starts from a clear sensor.
        if (coarseContactZ !== null) {
            let releasedZ: number | null = null;
            while (currentZ < coarseContactZ + MAX_RETREAT_MM) {
                const stepStart = Date.now();
                currentZ += plan.coarseStepMm;
                await moveMachineSettled('toolsetter:release', { z: currentZ }, COARSE_FEED);
                const sensed = await senseReleaseAfter(stepStart, releaseTimeoutMs);
                if (!sensed.contact) {
                    releasedZ = currentZ;
                    announce('released', currentZ);
                    break;
                }
            }
            if (releasedZ === null) {
                throw new ProcedureAbort(`Sensor still reads triggered ${MAX_RETREAT_MM} mm above first contact - `
                    + 'stuck switch or feed fault.');
            }
        } else {
            announce('slow-zone', currentZ, 'coarse ladder done, no contact; continuing in fine steps');
        }

        // Phase 4: fine approach - the primary contact phase when the
        // declared bit length is right (max press = one fine step).
        let fineContactZ: number | null = null;
        while (currentZ - plan.fineStepMm >= plan.floorZ - 1e-9) {
            const stepStart = Date.now();
            currentZ -= plan.fineStepMm;
            await moveMachineSettled('toolsetter:fine', { z: currentZ }, FINE_FEED);
            const sensed = await senseAfter(stepStart, plan.sensorDelayMs);
            if (sensed.contact) {
                fineContactZ = currentZ;
                announce('fine-contact', currentZ, `sensor "${sensed.reading?.value}"`);
                break;
            }
        }
        if (fineContactZ === null) {
            throw new ProcedureAbort(`Reached the hard floor Z ${plan.floorZ.toFixed(2)} without contact. `
                + 'The declared bit length, the stored trigger reference, or the sensor is wrong.');
        }

        // Phase 5: repeated quick lift-and-retest cycles (operator-specified
        // protocol): each pass lifts by the backoff, waits for the sensor to
        // actually release (patient - correctness gates on it), then
        // re-approaches in fine steps with the SHORT contact window. A pass
        // risks only a couple of fine steps, so a feed timing aberration
        // shows up as spread between passes instead of biasing the result;
        // the reported trigger Z is the median.
        const passContacts: number[] = [];
        const cycleFloor = Math.max(plan.floorZ, fineContactZ - 0.5);
        let referenceContactZ = fineContactZ;
        for (let pass = 1; pass <= plan.confirmPasses; pass++) {
            const liftIssuedAt = Date.now();
            currentZ = referenceContactZ + plan.backoffMm;
            await moveMachineSettled('toolsetter:backoff', { z: currentZ }, FINE_FEED);
            const liftSense = await senseReleaseAfter(liftIssuedAt, releaseTimeoutMs);
            if (liftSense.contact) {
                throw new ProcedureAbort(`Sensor still triggered ${releaseTimeoutMs} ms after backing off `
                    + `${plan.backoffMm} mm - trigger hysteresis exceeds the backoff. Rerun with a larger backoff_mm.`);
            }
            let passContact: number | null = null;
            while (currentZ - plan.fineStepMm >= cycleFloor - 1e-9) {
                const stepStart = Date.now();
                currentZ -= plan.fineStepMm;
                await moveMachineSettled('toolsetter:confirm', { z: currentZ }, FINE_FEED);
                const sensed = await senseAfter(stepStart, plan.sensorDelayMs);
                if (sensed.contact) {
                    passContact = currentZ;
                    break;
                }
            }
            if (passContact === null) {
                throw new ProcedureAbort(`Confirm pass ${pass} descended to ${cycleFloor.toFixed(2)} `
                    + '(0.5 mm below the first fine contact) without re-contact - inconsistent sensor.');
            }
            passContacts.push(Number(passContact.toFixed(3)));
            announce(`confirm-${pass}`, passContact, `of ${plan.confirmPasses}`);
            referenceContactZ = passContact;
        }
        const sorted = [...passContacts].sort((a, b) => a - b);
        const measuredZ = sorted[Math.floor((sorted.length - 1) / 2)];
        const spreadMm = Number((sorted[sorted.length - 1] - sorted[0]).toFixed(3));
        announce('measured', measuredZ, `median of [${passContacts.join(', ')}], spread ${spreadMm} mm`);

        // Phase 6: retreat to the start height and report.
        await moveMachineSettled('toolsetter:retreat', { z: plan.startZ }, TRAVEL_FEED);
        announce('retreated', plan.startZ);

        const derivedBitLengthMm = c.referenceBitLengthMm + (measuredZ - c.triggerZ);
        let storedAsReference = false;
        if (plan.storeAsReference) {
            setToolSetterConfig({
                ...c,
                triggerZ: measuredZ,
                referenceBitLengthMm: plan.bitLengthMm,
            });
            storedAsReference = true;
        }

        const result: ToolSetterResult = {
            measuredTriggerZ: measuredZ,
            confirmPassContacts: passContacts,
            spreadMm,
            expectedTriggerZ: plan.expectedTriggerZ,
            deltaMm: Number((measuredZ - plan.expectedTriggerZ).toFixed(3)),
            derivedBitLengthMm: Number(derivedBitLengthMm.toFixed(3)),
            phases,
            storedAsReference,
            note: `Trigger at machine Z ${measuredZ.toFixed(3)} - median of ${plan.confirmPasses} confirm `
                + `passes [${passContacts.join(', ')}], spread ${spreadMm} mm (+/- ${plan.fineStepMm} mm step `
                + 'resolution). The derived bit length assumes the stored reference is exact; report it '
                + 'with that uncertainty.',
            warning: spreadMm > plan.fineStepMm + 1e-9
                ? `Confirm passes spread ${spreadMm} mm exceeds one fine step - feed timing was unstable; `
                    + 'consider more confirm_passes or a longer sensor_delay_ms.'
                : undefined,
        };
        return result as unknown as object;
    } catch (err) {
        // Best-effort retreat to the safe start height, unless the failure is
        // the overtravel latch itself (the connection is being force-closed).
        const isTrip = !!probeFeedService.getTrip();
        if (!isTrip) {
            try {
                await moveMachineSettled('toolsetter:abort-retreat', { z: plan.startZ }, TRAVEL_FEED);
                announce('abort-retreated', plan.startZ);
            } catch (retreatErr) {
                log.error(`Tool setter abort retreat failed: ${retreatErr.message}`);
            }
        }
        if (err instanceof ProcedureAbort) {
            throw new McpToolError(`Tool setter run aborted: ${err.message} `
                + `Phases completed: ${JSON.stringify(phases)}`);
        }
        throw err;
    }
}
