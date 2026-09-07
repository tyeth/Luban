import { connectionManager } from '../../machine/ConnectionManager';
import { diagnosticsSnapshot } from '../diagnostics';
import { getPositionOfRecord, getTrustedOffset } from '../positionOfRecord';
import { probeFeedService } from '../probeFeed';
import { ToolRegistry } from '../registry';
import { currentGcodeSequence } from './camera';
import { originOffsetDiagnostics } from './machine';

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
        name: 'get_mcp_diagnostics',
        description: 'Timing evidence for slow or aborted procedures, read-only: server event-loop stalls, '
            + 'machine heartbeat cadence/gaps/frame flips, direct-gcode pacing (exec and idle ms), sensor pipe '
            + 'latency, the probe feed status and the motion engine\'s current position of record. The same '
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
                originOffset: { ...originOffsetDiagnostics(), trustedByEngine: getTrustedOffset() },
                gcodeSequence: currentGcodeSequence(),
            };
        },
    });
}
