import { connectionManager } from '../../machine/ConnectionManager';
import { ToolRegistry } from '../registry';

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
}
