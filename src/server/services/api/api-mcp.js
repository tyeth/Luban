import config from '../configstore';
import { getMcpStatus } from '../mcp';
import { MAX_RECENT_LIMIT, MIN_RECENT_LIMIT, diagnosticsRecentLimit } from '../mcp/diagnostics';
import { DEFAULT_BLINKA_ENV, resolveGpioFeedConfig } from '../mcp/gpioFeed';
import { MAX_JOB_EVENT_LIMIT, MIN_JOB_EVENT_LIMIT, approvalHandoff, jobEventLimit } from '../mcp/jobs';
import { probeFeedService, resolveProbeFeedConfig, resolveProbeTransportKind, resolveSensorEnabled } from '../mcp/probeFeed';

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

// Probe feed (Blinka GPIO) fields, same env-first resolution
// (LUBAN_MCP_GPIO_*). Pin values are a Blinka pin name with an optional
// pull suffix, e.g. "GP6:up".
const GPIO_FIELD_KEYS = {
    python: 'mcpGpioPython',
    pinToolsetter: 'mcpGpioPinToolsetter',
    pinOvertravel: 'mcpGpioPinOvertravel',
    pinProbe: 'mcpGpioPinProbe',
    inverted: 'mcpGpioInverted',
    pollMs: 'mcpGpioPollMs',
    blinkaEnv: 'mcpGpioBlinkaEnv',
};

// api field name -> gpioFeed resolver field name (for env-override display)
const GPIO_SOURCE_FIELDS = {
    python: 'python',
    pinToolsetter: 'toolsetter',
    pinOvertravel: 'overtravel',
    pinProbe: 'probe',
    inverted: 'inverted',
    pollMs: 'pollMs',
    blinkaEnv: 'blinkaEnv',
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

function gpioSettings() {
    const resolved = resolveGpioFeedConfig();
    const values = {};
    for (const [field, key] of Object.entries(GPIO_FIELD_KEYS)) {
        const raw = config.get(key);
        values[field] = (raw === undefined || raw === null) ? '' : String(raw);
    }
    const envOverrides = Object.entries(GPIO_SOURCE_FIELDS)
        .filter(([, sourceField]) => resolved.sources[sourceField] === 'env')
        .map(([field]) => field);
    return {
        values,
        envOverrides,
        configured: resolved.configured,
        missing: resolved.missing,
        defaultPython: resolved.python,
        defaultBlinkaEnv: DEFAULT_BLINKA_ENV,
    };
}

function sensorSettings() {
    const enabled = resolveSensorEnabled();
    return {
        toolSetter: enabled.toolsetter,
        probe: enabled.probe,
        stored: {
            toolSetter: config.get('mcpToolSetterEnabled'),
            probe: config.get('mcpProbeToolEnabled'),
        },
        envOverrides: ['LUBAN_MCP_TOOLSETTER_ENABLED', 'LUBAN_MCP_PROBE_ENABLED'].filter((name) => !!(process.env[name] || '').trim()),
    };
}

// Diagnostic buffer sizes (jobs.ts / diagnostics.ts). Env overrides win.
function limitSource(envName, configKey) {
    if (process.env[envName]) {
        return 'env';
    }
    return config.get(configKey) ? 'config' : 'default';
}

function bufferSettings() {
    return {
        jobEventLimit: jobEventLimit(),
        jobEventLimitRange: [MIN_JOB_EVENT_LIMIT, MAX_JOB_EVENT_LIMIT],
        jobEventLimitSource: limitSource('LUBAN_MCP_JOB_EVENT_LIMIT', 'mcpJobEventLimit'),
        diagnosticsRecentLimit: diagnosticsRecentLimit(),
        diagnosticsRecentLimitRange: [MIN_RECENT_LIMIT, MAX_RECENT_LIMIT],
        diagnosticsRecentLimitSource: limitSource('LUBAN_MCP_DIAGNOSTICS_RECENT_LIMIT', 'mcpDiagnosticsRecentLimit'),
    };
}

function transportSettings() {
    return {
        // What the operator stored (may be empty = auto), and what is live.
        stored: String(config.get('mcpProbeTransport') || ''),
        envOverride: !!(process.env.LUBAN_MCP_PROBE_TRANSPORT || '').trim(),
        active: resolveProbeTransportKind(),
    };
}

// Job approval hand-off (jobs.ts approvalHandoff): 'agent' lets a waiting
// start_gcode_job start on the operator's click; 'code' requires the relayed code.
function approvalSettings() {
    return {
        handoff: approvalHandoff(),
        source: limitSource('LUBAN_MCP_APPROVAL_HANDOFF', 'mcpApprovalHandoff'),
    };
}

function settingsPayload() {
    return {
        ...getMcpStatus(),
        transport: transportSettings(),
        sensors: sensorSettings(),
        mqtt: mqttSettings(),
        gpio: gpioSettings(),
        buffers: bufferSettings(),
        approval: approvalSettings(),
    };
}

export const getStatus = (req, res) => {
    res.send(settingsPayload());
};

/**
 * Operator clears the latched safety alarm (overtravel or crash) from the
 * Workspace pill. A human click in the app IS the operator's explicit word;
 * the same guard as clear_overtravel_alarm applies - refused (409) while the
 * tripped channel still reads triggered.
 */
export const clearAlarm = (req, res) => {
    const trip = probeFeedService.getTrip();
    if (!trip) {
        res.send({ cleared: false, note: 'No safety alarm is latched.', probeFeed: probeFeedService.status() });
        return;
    }
    try {
        probeFeedService.clearTrip();
    } catch (err) {
        res.status(409).send({ msg: err.message, probeFeed: probeFeedService.status() });
        return;
    }
    const reason = String((req.body || {}).reason || 'cleared from the Workspace connection panel');
    res.send({ cleared: true, previousTrip: trip, reason, probeFeed: probeFeedService.status() });
};

/**
 * Persist MCP settings (configstore). Applied at the next start; the
 * response carries live status so the UI can say so. MQTT fields apply at
 * the next probe-feed connect. An empty string clears a stored field; an
 * omitted field is left unchanged (the pane omits an untouched password).
 */
export const updateSettings = (req, res) => {
    const { enabled, port, allowLan, sensors, mqtt, gpio, transport, buffers, approvalHandoff: handoff } = req.body || {};

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
    if (allowLan !== undefined) {
        // Applies at the next start (bind address). No authentication exists:
        // the pane carries the warning; here we only persist the choice.
        config.set('mcpAllowLan', !!allowLan);
    }
    if (handoff !== undefined) {
        const value = String(handoff).trim().toLowerCase();
        if (value === '') {
            config.unset('mcpApprovalHandoff'); // default: agent
        } else if (value === 'agent' || value === 'code') {
            config.set('mcpApprovalHandoff', value);
        } else {
            res.status(ERR_BAD_REQUEST).send({ msg: `Invalid approvalHandoff: ${handoff} (agent, code or empty)` });
            return;
        }
    }
    if (buffers && typeof buffers === 'object') {
        // Diagnostic buffer sizes: applied immediately (read on every append).
        const limits = [
            ['jobEventLimit', 'mcpJobEventLimit', MIN_JOB_EVENT_LIMIT, MAX_JOB_EVENT_LIMIT],
            ['diagnosticsRecentLimit', 'mcpDiagnosticsRecentLimit', MIN_RECENT_LIMIT, MAX_RECENT_LIMIT],
        ];
        for (const [field, key, min, max] of limits) {
            if (buffers[field] === undefined) {
                continue;
            }
            const value = String(buffers[field]).trim();
            if (value === '') {
                config.unset(key); // back to the default
                continue;
            }
            const numeric = Number(value);
            if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
                res.status(ERR_BAD_REQUEST).send({ msg: `Invalid ${field}: ${value} (${min}-${max})` });
                return;
            }
            config.set(key, numeric);
        }
    }
    if (sensors && typeof sensors === 'object') {
        if (sensors.toolSetter !== undefined) {
            config.set('mcpToolSetterEnabled', !!sensors.toolSetter);
        }
        if (sensors.probe !== undefined) {
            config.set('mcpProbeToolEnabled', !!sensors.probe);
        }
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

    if (transport !== undefined) {
        const value = String(transport).trim().toLowerCase();
        if (value === '') {
            config.unset('mcpProbeTransport'); // back to auto-detect
        } else if (value === 'mqtt' || value === 'gpio') {
            config.set('mcpProbeTransport', value);
        } else {
            res.status(ERR_BAD_REQUEST).send({ msg: `Invalid probe transport: ${transport} (mqtt, gpio or empty)` });
            return;
        }
    }

    if (gpio && typeof gpio === 'object') {
        for (const [field, key] of Object.entries(GPIO_FIELD_KEYS)) {
            if (gpio[field] === undefined) {
                continue;
            }
            const value = String(gpio[field]).trim();
            if (value === '') {
                config.unset(key);
                continue;
            }
            if (field === 'pollMs') {
                const numeric = Number(value);
                if (!Number.isFinite(numeric) || numeric < 2 || numeric > 1000) {
                    res.status(ERR_BAD_REQUEST).send({ msg: `Invalid GPIO poll interval: ${value} (2-1000 ms)` });
                    return;
                }
                config.set(key, numeric);
                continue;
            }
            config.set(key, value);
        }
    }

    res.send(settingsPayload());
};
