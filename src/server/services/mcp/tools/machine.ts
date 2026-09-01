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
import config from '../../configstore';
import { connectionManager } from '../../machine/ConnectionManager';
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
 * effectively) before x/y moves". Default 320 (home Z is 328 on the A350);
 * override via configstore mcpSafeTraverseZ. Anything lower needs the
 * operator's explicit clearance for that specific corridor.
 */
export function safeTraverseZ(): number {
    const raw = Number(config.get('mcpSafeTraverseZ'));
    return Number.isFinite(raw) && raw > 0 ? raw : 320;
}

export interface PositionSnapshot {
    work: { x: number | null; y: number | null; z: number | null };
    machine: { x: number | null; y: number | null; z: number | null };
    originOffset: { x: number; y: number; z: number };
    b: number | null;
    isFourAxis: boolean;
    isHomed: boolean | null;
    machineStatus: string | null;
    reportAgeMs: number;
    convention: string;
    warnings: string[];
}

/**
 * Position from the latest heartbeat, shared by get_position and the
 * capture tools. Throws McpToolError when unavailable.
 */
export function getPositionSnapshot(): PositionSnapshot {
    const status = connectionManager.getConnectionStatus();
    if (!status.connected) {
        throw new McpToolError('No machine connected.');
    }

    const state = connectionManager.getLatestMachineState();
    if (!state) {
        throw new McpToolError('No heartbeat received yet on this channel; position unknown.');
    }

    const pos = (state.pos || {}) as { x?: unknown; y?: unknown; z?: unknown; b?: unknown; isFourAxis?: boolean };
    const originOffset = (state.originOffset || {}) as { x?: unknown; y?: unknown; z?: unknown };

    // Heartbeat pos is the WORK position; Luban derives machine
    // coordinates as work - originOffset (see DisplayPanel.jsx).
    const work = {
        x: axisValue(pos.x),
        y: axisValue(pos.y),
        z: axisValue(pos.z),
    };
    const offset = {
        x: axisValue(originOffset.x) || 0,
        y: axisValue(originOffset.y) || 0,
        z: axisValue(originOffset.z) || 0,
    };
    const machine = {
        x: work.x === null ? null : work.x - offset.x,
        y: work.y === null ? null : work.y - offset.y,
        z: work.z === null ? null : work.z - offset.z,
    };

    // Hardware-observed failure mode: a bare G28 leaves the controller
    // reporting positions in an unselected workspace, so derived machine
    // coordinates land outside the build volume (e.g. Z 656 on a 325 mm
    // machine). Flag it rather than let an agent trust it.
    const warnings: string[] = [];
    const size = getMachineSizeByIdentifier(status.machineIdentifier);
    if (size) {
        // Floors/headroom allow real overtravel: the A350 X home switch sits
        // at machine -19, and Z/Y home a few mm past the nominal volume.
        const outside = (['x', 'y', 'z'] as const).filter((axis) => {
            const v = machine[axis];
            return v !== null && (v < -25 || v > size[axis] + 40);
        });
        if (outside.length) {
            warnings.push(`Derived machine ${outside.join('/')} is outside the build volume - the `
                + 'controller is likely reporting positions in an unselected workspace (seen after a '
                + 'bare G28). Verify the frame with query_firmware_position and do not trust work '
                + 'coordinates for cutting until position reporting is coherent again.');
        }
    }

    return {
        work,
        machine,
        originOffset: offset,
        b: axisValue(pos.b),
        isFourAxis: !!pos.isFourAxis,
        isHomed: (state as { isHomed?: boolean }).isHomed ?? null,
        machineStatus: (state as { status?: string }).status || null,
        reportAgeMs: Date.now() - state.timestamp,
        convention: 'machine = work - originOffset; heartbeat reports work coordinates',
        warnings,
    };
}

export function registerMachineTools(registry: ToolRegistry): void {
    registry.register({
        name: 'get_machine_profile',
        description: 'Machine profile: build volume, per-toolhead work ranges, and kinematics '
            + '(which element moves per axis). Defaults to the connected machine. Read-only.',
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
            const identifier = args.identifier || status.machineIdentifier;
            if (!identifier) {
                throw new McpToolError('No machine connected and no identifier given. '
                    + `Known identifiers: ${MACHINES.map((m) => m.identifier).join(', ')}`);
            }

            const machine = findMachine(identifier);
            if (!machine) {
                throw new McpToolError(`Unknown machine identifier: ${identifier}. `
                    + `Known identifiers: ${MACHINES.map((m) => m.identifier).join(', ')}`);
            }

            const state = connectionManager.getLatestMachineState();

            // Add-on modules (quick-swap kit, bracing kit) translate the work
            // envelope by workRangeOffset. Which ones are physically installed
            // cannot be detected - the operator records it in configstore key
            // mcpInstalledModules (array or comma-separated identifiers).
            const modules = (machine.metadata.modules || []).map((module) => ({
                identifier: module.identifier,
                workRangeOffset: module.workRangeOffset || null,
            }));
            const installedRaw = config.get('mcpInstalledModules');
            const installedModules = (Array.isArray(installedRaw)
                ? installedRaw.map(String)
                : String(installedRaw || '').split(',').map((s) => s.trim()).filter(Boolean))
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
        description: 'Current position from the machine heartbeat, in both work and machine '
            + 'coordinates, with originOffset and the age of the report. Read-only.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
        handler: async () => getPositionSnapshot(),
    });
}
