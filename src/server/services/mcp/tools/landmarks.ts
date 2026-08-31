/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import config from '../../configstore';
import { connectionManager } from '../../machine/ConnectionManager';
import { calibrationStore } from '../calibration';
import { Landmark, landmarkStore } from '../landmarks';
import { probeFeedService } from '../probeFeed';
import { McpToolError, ToolRegistry } from '../registry';
import { getToolSetterConfig } from '../toolSetter';

// Named scene landmarks (#50) and the stored-state overview (#53): operator
// knowledge captured once, surfaced every session, so no agent spends moves
// re-deriving what the operator already said.

function describeLandmark(landmark: Landmark): object {
    return landmark;
}

export function registerLandmarkTools(registry: ToolRegistry): void {
    registry.register({
        name: 'set_landmark',
        description: 'Persist a named scene landmark (tool height checker, rotary span, tool '
            + 'post...) with its machine-coordinate XY extent and a description. Same name '
            + 'replaces. Landmarks near the current position are surfaced with every capture, '
            + 'so identities the operator has stated once are never re-guessed. Record identity '
            + 'from OPERATOR knowledge, not visual analogy.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Short unique name, e.g. "tool-height-checker".' },
                description: { type: 'string', description: 'What it is and how it looks on camera.' },
                x0: { type: 'number', description: 'Machine-coordinate extent of the feature.' },
                y0: { type: 'number' },
                x1: { type: 'number' },
                y1: { type: 'number' },
                notes: { type: 'string' },
            },
            required: ['name', 'description', 'x0', 'y0', 'x1', 'y1'],
            additionalProperties: false,
        },
        handler: async (args: {
            name?: string;
            description?: string;
            x0?: number;
            y0?: number;
            x1?: number;
            y1?: number;
            notes?: string;
        }) => {
            const name = String(args.name || '').trim();
            const description = String(args.description || '').trim();
            if (!name || !description) {
                throw new McpToolError('name and description are required.');
            }
            const box = [args.x0, args.y0, args.x1, args.y1].map(Number);
            if (box.some((v) => !Number.isFinite(v)) || box[0] >= box[2] || box[1] >= box[3]) {
                throw new McpToolError('Require finite machine coordinates with x0 < x1 and y0 < y1.');
            }
            const landmark = landmarkStore.add({
                name,
                description,
                machine: { x0: box[0], y0: box[1], x1: box[2], y1: box[3] },
                notes: args.notes ? String(args.notes) : null,
            });
            return { landmark: describeLandmark(landmark) };
        },
    });

    registry.register({
        name: 'delete_landmark',
        description: 'Delete one stored landmark by id or name.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'Landmark id or name.' } },
            required: ['id'],
            additionalProperties: false,
        },
        handler: async (args: { id?: string }) => {
            if (!landmarkStore.remove(String(args.id || ''))) {
                throw new McpToolError('Unknown landmark id or name.');
            }
            return { removed: true };
        },
    });

    registry.register({
        name: 'get_stored_state',
        description: 'Everything already known about this machine and bed in one read-only call, '
            + 'so a fresh session orients WITHOUT moving anything: stored calibrations (with '
            + 'surface tags), named landmarks, the expected tool region, motion limits, camera '
            + 'config, and the live connection snapshot. Call this first.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
            let toolRegion: object | null = null;
            const rawRegion = config.get('mcpToolRegion');
            if (rawRegion) {
                try {
                    toolRegion = typeof rawRegion === 'string' ? JSON.parse(rawRegion) : (rawRegion as object);
                } catch (err) {
                    toolRegion = null;
                }
            }
            return {
                connection: connectionManager.getConnectionStatus(),
                calibrations: calibrationStore.list(),
                landmarks: landmarkStore.list().map(describeLandmark),
                expectedToolRegion: toolRegion,
                limits: {
                    maxJogDistanceMm: Number(config.get('mcpMaxJogDistance')) || 100,
                },
                camera: {
                    url: config.get('mcpCameraUrl') || null,
                    device: config.get('mcpCameraDevice') || null,
                    lastGoodDevice: config.get('mcpCameraLastGood') || null,
                },
                installedModules: config.get('mcpInstalledModules') || [],
                probeFeed: probeFeedService.status(),
                toolSetter: getToolSetterConfig(),
            };
        },
    });
}
