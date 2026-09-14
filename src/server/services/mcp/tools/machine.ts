import * as fs from 'fs-extra';
import path from 'path';
import {
    SnapmakerA150Machine,
    SnapmakerA250Machine,
    SnapmakerA350Machine,
    SnapmakerArtisanMachine,
    SnapmakerJ1Machine,
    SnapmakerOriginalExtendedMachine,
    SnapmakerOriginalMachine,
    SnapmakerRayMachine,
} from '../../../../app/machines';

import DataStorage from '../../../DataStorage';
import config from '../../configstore';
import { connectionManager } from '../../machine/ConnectionManager';
import {
    FrameJudgement,
    Reliability,
    createMachinePositionState,
    judgeBeatStateful,
    noteDisconnected,
    reliableForMotion,
} from '../machinePosition';
import {
    ZERO_OFFSET_ACCEPT_BEATS,
    clearPositionOfRecord,
    clearTrustedOffset,
    currentGcodeSequence,
    directGcodeQuiet,
    getPositionOfRecord,
} from '../positionOfRecord';
import { McpToolError, ToolRegistry } from '../registry';

const MACHINES = [
    SnapmakerOriginalMachine,
    SnapmakerOriginalExtendedMachine,
    SnapmakerA150Machine,
    SnapmakerA250Machine,
    SnapmakerA350Machine,
    SnapmakerArtisanMachine,
    SnapmakerJ1Machine,
    SnapmakerRayMachine,
];

// Kinematics an agent must not guess. On the Snapmaker 2.0 gantry the
// platform itself travels in Y while the toolhead moves in X and Z, so a
// camera fixed to the machine frame or toolhead sees the platform move
// under it: any pixel-to-machine mapping is only valid at the Y value it
// was captured at.
const SM2_KINEMATICS = {
    movingElement: { x: 'toolhead', y: 'platform', z: 'toolhead' },
    note: 'The platform travels in Y; the toolhead moves in X and Z. '
        + 'A pixel-to-machine mapping is only valid at the Y it was captured at.',
};

const KINEMATICS_BY_IDENTIFIER: { [identifier: string]: object } = {
    [SnapmakerA150Machine.identifier]: SM2_KINEMATICS,
    [SnapmakerA250Machine.identifier]: SM2_KINEMATICS,
    [SnapmakerA350Machine.identifier]: SM2_KINEMATICS,
};

function findMachine(identifier: string) {
    return MACHINES.find((machine) => machine.identifier === identifier) || null;
}

export interface AppMachineSettings {
    /** Machine identifier as selected in Luban, e.g. "Snapmaker 2.0 A350". */
    series: string | null;
    /** Selected toolhead per function: printingToolhead / laserToolhead / cncToolhead. */
    toolHead: { [kind: string]: string };
    /** Installed add-on module identifiers, e.g. "snapmaker-2.0-bracing-kit-module". */
    modules: string[];
}

/**
 * The machine the OPERATOR selected in Luban's Machine Settings - series,
 * toolheads and add-on modules (quick-swap kit, bracing kit). Read fresh from
 * the app's own persisted store (userData/machine.json, state.machine) on
 * every call, so a settings change - the app returns to its home page when
 * the machine config changes - is honoured immediately. This is the single
 * source of truth for what is installed; nothing is duplicated in the
 * server configstore.
 */
export function readAppMachineSettings(): AppMachineSettings | null {
    try {
        const file = path.join(DataStorage.userDataDir, 'machine.json');
        if (!fs.existsSync(file)) {
            return null;
        }
        const store = fs.readJsonSync(file);
        const machine = store && store.state && store.state.machine;
        if (!machine || typeof machine !== 'object') {
            return null;
        }
        return {
            series: typeof machine.series === 'string' ? machine.series : null,
            toolHead: machine.toolHead && typeof machine.toolHead === 'object' ? machine.toolHead : {},
            modules: Array.isArray(machine.modules) ? machine.modules.map(String) : [],
        };
    } catch (err) {
        return null;
    }
}

/**
 * Build volume of a machine by identifier, or null when unknown.
 */
export function getMachineSizeByIdentifier(identifier: string | null): { x: number; y: number; z: number } | null {
    const machine = identifier ? findMachine(identifier) : null;
    return machine ? machine.metadata.size : null;
}

function axisValue(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * The minimum toolhead machine Z for X/Y traverses - OPERATOR LAW after the
 * 2026-09-01 probe crash: "always retreat to top gantry height (home
 * effectively) before x/y moves". Default 328 = home Z on the A350 (operator
 * decision 2026-09-14: the earlier 320 left 8 mm of unverified headroom over
 * the rotary landmark's clearance 328 - its tailstock is unmeasured - and the
 * crossing-landmark exemption at traverse height covered that up). Override
 * via configstore mcpSafeTraverseZ. In-procedure sub-motions keep their own
 * tool-specific envelopes and are checked against landmarks like any low
 * segment; every procedure ends raised to this height.
 */
export const DEFAULT_SAFE_TRAVERSE_Z = 328;

export function safeTraverseZ(): number {
    const raw = Number(config.get('mcpSafeTraverseZ'));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SAFE_TRAVERSE_Z;
}

export interface PositionSnapshot {
    work: { x: number | null; y: number | null; z: number | null };
    machine: { x: number | null; y: number | null; z: number | null };
    originOffset: { x: number; y: number; z: number };
    originOffsetSource: 'heartbeat' | 'cached' | 'assumed-zero';
    /**
     * Trust level of `machine` - the JUDGED position of record (machinePosition.ts).
     * verified: controller echo of the last commanded move; heartbeat: a coherent
     * beat with its own offset; cached-offset: coherent beat, offset reused from
     * the last complete one; awaiting-resync: the beat was REJECTED (out of
     * bounds, frame flip, no offset yet) and `machine` is the last accepted
     * position - motion and staging refuse until a coherent beat arrives;
     * stale: no report for > HEARTBEAT_STALE_MS.
     */
    reliability: Reliability;
    /** Which reading the judged position rests on. */
    frame: FrameJudgement;
    /** Beat timestamp `machine` comes from (the held position's own time when the latest beat was rejected). */
    machineReportedAt: number | null;
    /** Why the judgement is what it is; also mirrored into warnings. */
    reasons: string[];
    judged: {
        accepted: boolean;
        rejectedReason: string | null;
        /** raw - offset for THIS beat, for diagnostics only - never for motion. */
        derived: { x: number | null; y: number | null; z: number | null };
    };
    b: number | null;
    isFourAxis: boolean;
    isHomed: boolean | null;
    machineStatus: string | null;
    reportAgeMs: number;
    /** The beat's own timestamp (ms epoch) - compare beats with this, never with Date.now() - reportAgeMs (1 ms jitter made one beat look like two). */
    reportedAt: number;
    convention: string;
    warnings: string[];
}

// The WiFi status poll runs every 2 s (3 s timeout); a report older than this
// means the machine connection has likely dropped without the server noticing
// (observed live 2026-09-02: 5.7 minutes of stale state served as truth while
// the machine was disconnected).
export const HEARTBEAT_STALE_MS = 10000;

// Machine position of record (machinePosition.ts): one judged position per
// distinct beat, forgotten on every (re)connection. get_position, the capture
// tools, the planners and diagnostics all read it; nothing else in the server
// derives `work - originOffset` on its own.
const machinePosition = createMachinePositionState();
// Only QUIET beats count towards believing a zero offset: while direct gcode is
// in flight (or replied within the last ZERO_OFFSET_QUIET_MS) a zero is the
// G53-window artefact by construction - a scan stepping every second produced
// runs of them and the 3-beat streak accepted the zero 28 times in one run
// (2026-09-05). A real re-zero from the touchscreen happens with the machine
// idle and is believed after 3 quiet beats (~6 s).
const ZERO_OFFSET_QUIET_MS = 3000;

/** Diagnostics: how the machine position is currently being judged. */
export function machinePositionDiagnostics() {
    const last = machinePosition.lastJudgement;
    return {
        cachedOffset: machinePosition.cachedOffset,
        zeroOffsetStreak: machinePosition.zeroStreak,
        zeroOffsetAcceptBeats: ZERO_OFFSET_ACCEPT_BEATS,
        /** Snapshots that set a zero-offset report aside as a G53-window transient. */
        zeroOffsetTransientsSeen: machinePosition.zeroTransients,
        /** Beats rejected by reason - each one would have been a wrong machine position handed to a guard. */
        rejectedBeats: { ...machinePosition.rejected },
        /** Rejected -> accepted transitions: "rectified on the next sync". */
        resyncs: machinePosition.resyncs,
        disconnects: machinePosition.disconnects,
        /** When the state was last forgotten (a disconnect); null on the first connection. */
        resetAt: machinePosition.resetAt,
        lastAccepted: machinePosition.lastAccepted,
        lastJudgement: last
            ? { reliability: last.reliability, frame: last.frame, accepted: last.accepted, rejectedReason: last.rejectedReason, reasons: last.reasons }
            : null,
    };
}

/**
 * The channel reports no state (closed, or not yet connected): forget the
 * previous connection's offsets and record. Work origins die on a machine
 * reboot, so nothing learnt before may leak into the next connection.
 */
export function noteMachineDisconnected(): void {
    noteDisconnected(machinePosition, Date.now());
    clearPositionOfRecord();
    clearTrustedOffset();
}

/** Machine travel as the bounds a derived position must stay within (+/- BOUNDS_MARGIN_MM). */
function machineBounds(identifier: string | null) {
    const size = getMachineSizeByIdentifier(identifier);
    return size ? { min: { x: 0, y: 0, z: 0 }, max: { x: size.x, y: size.y, z: size.z } } : null;
}

/**
 * Position from the latest heartbeat, judged into the position of record.
 * Shared by get_position, the capture tools and every planner. Throws
 * McpToolError when unavailable.
 */
export function getPositionSnapshot(): PositionSnapshot {
    const status = connectionManager.getConnectionStatus();
    if (!status.connected) {
        noteMachineDisconnected();
        throw new McpToolError('No machine connected.');
    }

    const state = connectionManager.getLatestMachineState();
    if (!state) {
        noteMachineDisconnected();
        throw new McpToolError('No heartbeat received yet on this channel; position unknown.');
    }

    const pos = (state.pos || {}) as { x?: unknown; y?: unknown; z?: unknown; b?: unknown; isFourAxis?: boolean };
    const originOffset = (state.originOffset || {}) as { x?: unknown; y?: unknown; z?: unknown };

    // The raw fields: the position in the workspace the controller currently
    // has selected (normally the work frame), and the offset the SSTP status
    // poll rebuilt from offsetX/Y/Z on this beat. Both are handed to the
    // judge as they are; nothing here subtracts.
    const work = {
        x: axisValue(pos.x),
        y: axisValue(pos.y),
        z: axisValue(pos.z),
    };
    const reported = {
        x: axisValue(originOffset.x),
        y: axisValue(originOffset.y),
        z: axisValue(originOffset.z),
    };
    const now = Date.now();
    const record = getPositionOfRecord(currentGcodeSequence());
    const judgement = judgeBeatStateful(
        machinePosition,
        { raw: work, offsetReported: reported, reportedAt: state.timestamp },
        {
            now,
            staleMs: HEARTBEAT_STALE_MS,
            bounds: machineBounds(status.machineIdentifier),
            verified: record ? { ...record.machine } : null,
            directGcodeQuiet: directGcodeQuiet(ZERO_OFFSET_QUIET_MS),
        }
    );

    return {
        work,
        machine: judgement.machine,
        originOffset: judgement.offset.offset,
        originOffsetSource: judgement.offset.source,
        reliability: judgement.reliability,
        frame: judgement.frame,
        machineReportedAt: judgement.machineReportedAt,
        reasons: judgement.reasons,
        judged: {
            accepted: judgement.accepted,
            rejectedReason: judgement.rejectedReason,
            derived: judgement.derived,
        },
        b: axisValue(pos.b),
        isFourAxis: !!pos.isFourAxis,
        isHomed: (state as { isHomed?: boolean }).isHomed ?? null,
        machineStatus: (state as { status?: string }).status || null,
        reportAgeMs: now - state.timestamp,
        reportedAt: state.timestamp,
        convention: 'machine = the JUDGED position of record (machinePosition.ts) with `reliability`; work/originOffset are the '
            + 'raw report - never derive machine = work - originOffset by hand. Agents plan in machine coordinates; the work '
            + 'origin is the operator\'s.',
        warnings: [...judgement.reasons],
    };
}

/**
 * Refuse to act on a machine position the position of record does not vouch
 * for. `awaiting-resync` clears itself on the next coherent beat (2 s); `stale`
 * needs a reconnect.
 */
export function requireReliableMachine(position: PositionSnapshot, what: string): void {
    if (reliableForMotion(position.reliability)) {
        return;
    }
    const why = position.reasons.length ? ` ${position.reasons.join(' ')}` : '';
    const hint = position.reliability === 'awaiting-resync'
        ? ' Wait for the next status report (2 s) and read get_position again; if it persists, query_firmware_position for liveness and tell the operator.'
        : ' Reconnect the machine and re-verify get_position before any motion.';
    throw new McpToolError(`Refusing ${what}: the machine position is ${position.reliability}.${why}${hint}`);
}

/**
 * Refuse to act on a stale OR incoherent heartbeat. Every motion-adjacent
 * path (staging, procedure preconditions, direct execution, job start) calls
 * this: a position the machine reported minutes ago is not a position, and
 * neither is a beat the position of record rejected (out of bounds, frame
 * flip, no offset yet - operator law 2026-09-14). None of the callers sits in
 * a runner's per-move loop, so a rejected G53-window beat can only delay a
 * start by one poll period, never abort a running procedure.
 */
export function assertFreshHeartbeat(what: string): void {
    const state = connectionManager.getLatestMachineState();
    if (!state) {
        throw new McpToolError('No heartbeat received yet on this channel; position unknown.');
    }
    const age = Date.now() - state.timestamp;
    if (age > HEARTBEAT_STALE_MS) {
        throw new McpToolError(`Refusing ${what}: the last heartbeat is ${(age / 1000).toFixed(0)}s old `
            + '(poll period 2 s) - the machine connection has likely dropped without the server noticing. '
            + 'Reconnect the machine, verify get_position reports a fresh, correct position, then retry.');
    }
    requireReliableMachine(getPositionSnapshot(), what);
}

export function registerMachineTools(registry: ToolRegistry): void {
    registry.register({
        name: 'get_machine_profile',
        description: 'Machine profile: build volume, per-toolhead work ranges, and kinematics '
            + '(which element moves per axis). Defaults to the connected machine, else the one '
            + 'selected in Luban Machine Settings; installed add-on modules (bracing kit, quick-swap) '
            + 'come from those same settings. Read-only.',
        inputSchema: {
            type: 'object',
            properties: {
                identifier: {
                    type: 'string',
                    description: 'Machine identifier, e.g. "Snapmaker 2.0 A350". Omit for the connected machine.',
                },
            },
            additionalProperties: false,
        },
        handler: async (args: { identifier?: string }) => {
            const status = connectionManager.getConnectionStatus();
            const appSettings = readAppMachineSettings();
            const identifier = args.identifier || status.machineIdentifier || (appSettings && appSettings.series) || '';
            if (!identifier) {
                throw new McpToolError('No machine connected, none selected in Luban Machine Settings, and no '
                    + `identifier given. Known identifiers: ${MACHINES.map((m) => m.identifier).join(', ')}`);
            }

            const machine = findMachine(identifier);
            if (!machine) {
                throw new McpToolError(`Unknown machine identifier: ${identifier}. `
                    + `Known identifiers: ${MACHINES.map((m) => m.identifier).join(', ')}`);
            }

            const state = connectionManager.getLatestMachineState();

            // Add-on modules (quick-swap kit, bracing kit) translate the work
            // envelope by workRangeOffset. Which ones are installed cannot be
            // detected from the machine - it is whatever the operator selected
            // in Luban's Machine Settings (readAppMachineSettings).
            const modules = (machine.metadata.modules || []).map((module) => ({
                identifier: module.identifier,
                workRangeOffset: module.workRangeOffset || null,
            }));
            const installedModules = (appSettings ? appSettings.modules : [])
                .filter((id) => modules.some((module) => module.identifier === id));
            const netOffset = [0, 0, 0];
            for (const module of modules) {
                if (installedModules.includes(module.identifier) && module.workRangeOffset) {
                    netOffset[0] += module.workRangeOffset[0];
                    netOffset[1] += module.workRangeOffset[1];
                    netOffset[2] += module.workRangeOffset[2];
                }
            }
            const hasOffset = netOffset.some((v) => v !== 0);

            return {
                identifier: machine.identifier,
                fullName: machine.fullName,
                machineType: machine.machineType,
                size: machine.metadata.size,
                toolHeads: machine.metadata.toolHeads.map((toolHead) => ({
                    identifier: toolHead.identifier,
                    workRange: toolHead.workRange || null,
                    // Luban translates min and max alike by the module offset
                    // (see src/app/flux/printing/index.ts).
                    effectiveWorkRange: hasOffset && toolHead.workRange ? {
                        min: toolHead.workRange.min.map((v, i) => v + netOffset[i]),
                        max: toolHead.workRange.max.map((v, i) => v + netOffset[i]),
                    } : null,
                })),
                modules,
                installedModules,
                installedModulesSource: appSettings ? 'Luban Machine Settings (machine.json)' : 'unavailable - machine.json not found',
                machineSettings: appSettings,
                netWorkRangeOffset: hasOffset ? netOffset : null,
                // null means "not recorded" - do not guess kinematics.
                kinematics: KINEMATICS_BY_IDENTIFIER[machine.identifier] || null,
                connected: identifier === status.machineIdentifier,
                connectedHead: state ? {
                    headType: (state as { headType?: string }).headType || null,
                    toolHead: (state as { toolHead?: string }).toolHead || null,
                } : null,
            };
        },
    });

    registry.register({
        name: 'get_position',
        description: 'The machine POSITION OF RECORD: the judged machine-frame position with its `reliability` '
            + '(verified | heartbeat | cached-offset | awaiting-resync | stale), the frame it rests on, why (`reasons`), '
            + 'plus the raw work-frame report and originOffset, B, homed/idle flags and the report age. Motion and staging '
            + 'refuse unless reliability is verified/heartbeat/cached-offset; awaiting-resync clears on the next coherent '
            + 'beat (2 s). Never compute machine = work - originOffset yourself. Read-only.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
        handler: async () => getPositionSnapshot(),
    });
}
