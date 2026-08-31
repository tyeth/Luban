import config from '../configstore';
import { getMcpStatus } from '../mcp';
import { resolveProbeFeedConfig } from '../mcp/probeFeed';

const ERR_BAD_REQUEST = 400;

// Probe feed (MQTT) fields editable on the Settings -> MCP Server pane.
// Environment variables (LUBAN_MCP_MQTT_*) override these at resolve time;
// the pane shows stored values and flags active env overrides.
const MQTT_FIELD_KEYS = {
    host: 'mcpMqttHost',
    port: 'mcpMqttPort',
    user: 'mcpMqttUser',
    pass: 'mcpMqttPass',
    clientId: 'mcpMqttClientId',
    feedToolsetter: 'mcpMqttFeedToolsetter',
    feedOvertravel: 'mcpMqttFeedOvertravel',
    feedProbe: 'mcpMqttFeedProbe',
    inverted: 'mcpMqttInverted',
};

// api field name -> probeFeed resolver field name (for env-override display)
const MQTT_SOURCE_FIELDS = {
    host: 'host',
    port: 'port',
    user: 'username',
    pass: 'password',
    clientId: 'clientId',
    feedToolsetter: 'toolsetter',
    feedOvertravel: 'overtravel',
    feedProbe: 'probe',
    inverted: 'inverted',
};

function mqttSettings() {
    const resolved = resolveProbeFeedConfig();
    const values = {};
    for (const [field, key] of Object.entries(MQTT_FIELD_KEYS)) {
        if (field === 'pass') {
            continue; // never echo the password, stored or otherwise
        }
        const raw = config.get(key);
        values[field] = (raw === undefined || raw === null) ? '' : String(raw);
    }
    const envOverrides = Object.entries(MQTT_SOURCE_FIELDS)
        .filter(([, sourceField]) => resolved.sources[sourceField] === 'env')
        .map(([field]) => field);
    return {
        values,
        passSet: !!config.get(MQTT_FIELD_KEYS.pass),
        envOverrides,
        configured: resolved.configured,
        missing: resolved.missing,
        defaultClientId: resolved.clientId,
    };
}

export const getStatus = (req, res) => {
    res.send({ ...getMcpStatus(), mqtt: mqttSettings() });
};

/**
 * Persist MCP settings (configstore). Applied at the next start; the
 * response carries live status so the UI can say so. MQTT fields apply at
 * the next probe-feed connect. An empty string clears a stored field; an
 * omitted field is left unchanged (the pane omits an untouched password).
 */
export const updateSettings = (req, res) => {
    const { enabled, port, mqtt } = req.body || {};

    if (port !== undefined) {
        const value = Number(port);
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
            res.status(ERR_BAD_REQUEST).send({ msg: `Invalid port: ${port}` });
            return;
        }
        config.set('mcpPort', value);
    }
    if (enabled !== undefined) {
        config.set('mcpEnabled', !!enabled);
    }

    if (mqtt && typeof mqtt === 'object') {
        for (const [field, key] of Object.entries(MQTT_FIELD_KEYS)) {
            if (mqtt[field] === undefined) {
                continue;
            }
            const value = String(mqtt[field]).trim();
            if (value === '') {
                config.unset(key);
                continue;
            }
            if (field === 'port') {
                const numeric = Number(value);
                if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
                    res.status(ERR_BAD_REQUEST).send({ msg: `Invalid MQTT port: ${value}` });
                    return;
                }
                config.set(key, numeric);
                continue;
            }
            config.set(key, value);
        }
    }

    res.send({ ...getMcpStatus(), mqtt: mqttSettings() });
};
