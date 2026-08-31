/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import { McpToolError, ToolRegistry } from '../registry';
import { probeFeedService, resolveProbeFeedConfig } from '../probeFeed';

// External probe sensors (tool height setter, CNC touch probe, overtravel
// switch) report over a message feed (MQTT / Adafruit IO). These tools manage
// the feed connection; the sensors themselves are read by the measurement
// procedures that consume them.

export function registerProbeTools(registry: ToolRegistry): void {
    registry.register({
        name: 'get_probe_feed_status',
        description: 'State of the external probe sensor feed (MQTT): configuration, connection, '
            + 'the last reading per channel (toolsetter / overtravel / probe) with its age, and '
            + 'whether the overtravel alarm is latched. Read-only.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => probeFeedService.status(),
    });

    registry.register({
        name: 'connect_probe_feed',
        description: 'Connect (or reconnect) to the probe sensor feed using the current settings '
            + '(environment variables first, then the Settings -> MCP Server MQTT fields). '
            + 'Subscribes to the configured toolsetter/overtravel/probe topics and arms the '
            + 'overtravel tripwire. Idempotent.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
            const cfg = resolveProbeFeedConfig();
            if (!cfg.configured) {
                throw new McpToolError(`Probe feed is not configured: missing ${cfg.missing.join(', ')}. `
                    + 'Ask the operator to fill in the MQTT fields on Settings -> MCP Server '
                    + '(or set LUBAN_MCP_MQTT_* environment variables) and restart or retry.');
            }
            try {
                await probeFeedService.connect();
            } catch (err) {
                throw new McpToolError(`Probe feed connection failed: ${err.message}`);
            }
            return probeFeedService.status();
        },
    });

    registry.register({
        name: 'disconnect_probe_feed',
        description: 'Disconnect from the probe sensor feed and stop reconnecting. NOTE: this '
            + 'disarms the overtravel tripwire - do not disconnect while any probing procedure '
            + 'could run. A latched overtravel alarm persists across disconnects.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
            probeFeedService.disconnect();
            return probeFeedService.status();
        },
    });

    registry.register({
        name: 'clear_overtravel_alarm',
        description: 'Clear the latched overtravel alarm that is blocking all motion. ONLY on the '
            + 'operator\'s explicit word, after they have physically inspected the machine and the '
            + 'overtravel mechanism: pass operator_confirmed: true and repeat their words in reason. '
            + 'Refused while the overtravel feed still reports triggered.',
        inputSchema: {
            type: 'object',
            properties: {
                operator_confirmed: {
                    type: 'boolean',
                    description: 'true ONLY when the human operator has explicitly said the machine '
                        + 'has been inspected and the alarm may be cleared. Never on the model\'s own judgment.',
                },
                reason: { type: 'string', description: 'The operator\'s words authorising the clear.' },
            },
            required: ['operator_confirmed', 'reason'],
            additionalProperties: false,
        },
        handler: async (args: { operator_confirmed?: boolean; reason?: string }) => {
            if (args.operator_confirmed !== true) {
                throw new McpToolError('Refusing: operator_confirmed must be true, and only on the '
                    + 'operator\'s explicit word after physical inspection.');
            }
            if (!String(args.reason || '').trim()) {
                throw new McpToolError('Provide the operator\'s authorisation as reason.');
            }
            const trip = probeFeedService.getTrip();
            if (!trip) {
                return { cleared: false, note: 'No overtravel alarm is latched.' };
            }
            probeFeedService.clearTrip();
            return { cleared: true, previous_trip: trip };
        },
    });
}
