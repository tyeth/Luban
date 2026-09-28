import { connectionManager } from '../../machine/ConnectionManager';
import { diagnosticsSnapshot } from '../diagnostics';
import { getPositionOfRecord, getTrustedOffset } from '../positionOfRecord';
import { probeFeedService } from '../probeFeed';
import { McpToolError, ToolRegistry } from '../registry';
import { currentGcodeSequence } from './camera';
import { machinePositionDiagnostics } from './machine';

// Seed tool: read-only report of the machine connection. Proves the bridge
// from the MCP endpoint to ConnectionManager; every later tool (#8-#13)
// follows this shape.
export function registerStatusTools(registry: ToolRegistry): void {
    registry.register({
        name: 'get_connection_status',
        description: 'Report whether Luban is connected to a machine, and over which channel. '
            + 'Read-only; sends nothing to the machine.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
        handler: async () => {
            return connectionManager.getConnectionStatus();
        },
    });

    registry.register({
        name: 'recover_machine_connection',
        description: 'Recover stopped HTTP heartbeat polling using only the machine session already held by Luban. '
            + 'Verifies that session with a read-only status request, then restarts polling. No motion, no /connect '
            + 'request, no new authentication and no touchscreen pairing prompt. Refuses missing/expired credentials '
            + 'or a different active transport. Never use raw backend/socket requests, blank tokens or stored-token '
            + 'edits as a fallback. After success read get_position and require a fresh report before motion.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
            try {
                await connectionManager.recoverMachineConnection();
            } catch (error) {
                throw new McpToolError((error as Error).message);
            }
            return {
                recovered: true,
                connection: connectionManager.getConnectionStatus(),
                note: 'Existing session verified; heartbeat polling restarted. Read get_position for a fresh report. No motion or pairing was requested.',
            };
        },
    });

    registry.register({
        name: 'get_mcp_diagnostics',
        description: 'Timing evidence for slow or aborted procedures, read-only: server event-loop stalls, '
            + 'machine heartbeat cadence/gaps/frame flips, direct-gcode pacing (exec and idle ms), sensor pipe '
            + 'latency, the probe feed status and the machine position of record (rejected beats by reason, resyncs, '
            + 'disconnects, the trusted offset). The same '
            + 'signals appear as job events (event_loop_stall, heartbeat_gap, heartbeat_frame_flip, slow_step, '
            + 'sense_overrun, position-estimated, and idleMs/execMs on gcode events) so read '
            + 'get_gcode_job_status first and use this for the totals.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
        handler: async () => {
            return {
                ...diagnosticsSnapshot(),
                probeFeed: probeFeedService.status(),
                positionOfRecord: getPositionOfRecord(currentGcodeSequence()),
                machinePosition: { ...machinePositionDiagnostics(), trustedOffsetByEngine: getTrustedOffset() },
                gcodeSequence: currentGcodeSequence(),
            };
        },
    });
}
