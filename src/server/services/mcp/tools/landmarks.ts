/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import config from '../../configstore';
import { connectionManager } from '../../machine/ConnectionManager';
import { calibrationStore } from '../calibration';
import { Landmark, landmarkStore } from '../landmarks';
import { probeFeedService } from '../probeFeed';
import { McpToolError, ToolRegistry } from '../registry';
import { GEOMETRY_FIELDS, geometrySettings, setGeometryValues } from '../rotaryGeometry';
import { getToolSetterConfig } from '../toolSetter';
import { readAppMachineSettings } from './machine';

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
                clearance_z: {
                    type: 'number',
                    description: 'Marks this landmark as an OBSTACLE: minimum safe toolhead machine Z '
                        + 'when an XY path crosses its box (operator accounts for tool length). Direct '
                        + 'XY moves below it across the box are refused. Omit for non-obstacles.',
                },
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
            clearance_z?: number;
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
            const clearanceZ = args.clearance_z !== undefined ? Number(args.clearance_z) : null;
            if (clearanceZ !== null && !Number.isFinite(clearanceZ)) {
                throw new McpToolError('clearance_z must be a finite machine Z when given.');
            }
            const landmark = landmarkStore.add({
                name,
                description,
                machine: { x0: box[0], y0: box[1], x1: box[2], y1: box[3] },
                clearanceZ,
                notes: args.notes ? String(args.notes) : null,
            });
            return { landmark: describeLandmark(landmark) };
        },
    });

    registry.register({
        name: 'set_probe_geometry',
        description: 'Store the jig/tool constants a rotary probe_program may reference as the "axis" namespace: '
            + 'rotary_axis_x (machine X of the axis line), rotary_axis_z_physical (PHYSICAL machine Z of the axis, '
            + 'e.g. from an opposite-face pair: (topA + topB)/2 - probe length), probe_effective_length (toolhead Z at '
            + 'contact minus this = surface; run_tool_setter accept_probe_contact measures it), probe_tip_diameter. '
            + 'Operator-stated or MEASURED values only, with the reason - like set_landmark. Omit a field to leave it; '
            + 'null clears it. None of these is a prerequisite for probing: only a program that references axis.* '
            + 'needs them; B0-only, stationary or off-rotary work needs nothing here. Stock size is never stored '
            + '(a rotation\'s swept radius is a per-program argument).',
        inputSchema: {
            type: 'object',
            properties: {
                rotary_axis_x: { type: ['number', 'null'], description: 'Machine X of the rotary axis line.' },
                rotary_axis_z_physical: { type: ['number', 'null'], description: 'Physical machine Z of the axis (not a contact Z).' },
                probe_effective_length: { type: ['number', 'null'], description: 'Probe effective length in mm (this fitting).' },
                probe_tip_diameter: { type: ['number', 'null'], description: 'Probe tip diameter in mm.' },
                reason: { type: 'string', description: 'How the values were obtained (which job / measurement / operator statement).' },
            },
            required: ['reason'],
            additionalProperties: false,
        },
        handler: async (args: { [key: string]: unknown }) => {
            const reason = String(args.reason || '').trim();
            if (!reason) {
                throw new McpToolError('reason is required: say how the values were measured or who stated them.');
            }
            const values: { [field: string]: unknown } = {};
            for (const spec of GEOMETRY_FIELDS) {
                if (args[spec.field] !== undefined) {
                    values[spec.field] = args[spec.field];
                }
            }
            if (!Object.keys(values).length) {
                throw new McpToolError(`Nothing to set: pass one or more of ${GEOMETRY_FIELDS.map((f) => f.field).join(', ')}.`);
            }
            try {
                const outcome = setGeometryValues(values, reason);
                return { ...outcome, geometry: geometrySettings() };
            } catch (err) {
                throw new McpToolError((err as Error).message);
            }
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
                // From Luban's Machine Settings (machine.json), never a private key.
                machineSettings: readAppMachineSettings(),
                installedModules: (readAppMachineSettings() || { modules: [] }).modules,
                probeFeed: probeFeedService.status(),
                toolSetter: getToolSetterConfig(),
                // Operator-measured jig/tool constants (Settings -> MCP Server ->
                // Rotary and probe geometry); programs read them as `axis.*`.
                geometry: geometrySettings(),
            };
        },
    });
}
