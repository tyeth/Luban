import os from 'os';

import logger from '../../lib/logger';
import config from '../configstore';
import { connectionManager } from '../machine/ConnectionManager';
import { mcpBroadcast } from './index';
import { MqttClient } from './mqtt';
import { McpToolError } from './registry';

const log = logger('service:mcp:probe-feed');

// External probe sensors (tool height setter, CNC touch probe) report over a
// message feed rather than the machine controller - the controller has no
// input for them. The transport is abstracted behind ProbeFeedService; the
// first implementation is MQTT (Adafruit IO), configured from environment
// variables with the server configstore as the fallback, editable on the
// Settings -> MCP Server pane.
//
// The overtravel channel is a TRIPWIRE: the sensor only reports overtravel
// when the physical mechanism has been pushed past its safe range, so any
// triggered reading immediately stops the running job, force-closes the
// machine connection, latches an alarm that blocks every motion tool, and
// reports to the operator. The latch clears only on the operator's explicit
// word (clear_overtravel_alarm) or an application restart.

export type ProbeChannel = 'toolsetter' | 'overtravel' | 'probe';

export const PROBE_CHANNELS: ProbeChannel[] = ['toolsetter', 'overtravel', 'probe'];

interface FieldSpec {
    env: string;
    key: string;
}

const FIELDS: { [name: string]: FieldSpec } = {
    host: { env: 'LUBAN_MCP_MQTT_HOST', key: 'mcpMqttHost' },
    port: { env: 'LUBAN_MCP_MQTT_PORT', key: 'mcpMqttPort' },
    username: { env: 'LUBAN_MCP_MQTT_USER', key: 'mcpMqttUser' },
    password: { env: 'LUBAN_MCP_MQTT_PASS', key: 'mcpMqttPass' },
    clientId: { env: 'LUBAN_MCP_MQTT_CLIENT_ID', key: 'mcpMqttClientId' },
    toolsetter: { env: 'LUBAN_MCP_MQTT_FEED_TOOLSETTER', key: 'mcpMqttFeedToolsetter' },
    overtravel: { env: 'LUBAN_MCP_MQTT_FEED_OVERTRAVEL', key: 'mcpMqttFeedOvertravel' },
    probe: { env: 'LUBAN_MCP_MQTT_FEED_PROBE', key: 'mcpMqttFeedProbe' },
    // Comma-separated channel names whose sensors idle HIGH and read low on
    // contact (normally-open probe circuits with a pull-up): "probe" marks
    // the CNC touch probe inverted while the tool setter stays direct.
    inverted: { env: 'LUBAN_MCP_MQTT_INVERTED', key: 'mcpMqttInverted' },
};

function resolveField(name: string): { value: string; source: 'env' | 'config' | null } {
    const spec = FIELDS[name];
    const envRaw = process.env[spec.env];
    if (envRaw !== undefined && String(envRaw).trim() !== '') {
        return { value: String(envRaw).trim(), source: 'env' };
    }
    const configRaw = config.get(spec.key);
    if (configRaw !== undefined && configRaw !== null && String(configRaw).trim() !== '') {
        return { value: String(configRaw).trim(), source: 'config' };
    }
    return { value: '', source: null };
}

/**
 * Default client id: username followed by the MAC bytes of the first
 * non-internal interface (e.g. "tyeth0123456789ab") - stable per machine,
 * unique per account, and within Adafruit IO's 23-byte-friendly length for
 * short usernames.
 */
function defaultClientId(username: string): string {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces).sort()) {
        for (const iface of interfaces[name] || []) {
            if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
                return `${username}${iface.mac.replace(/:/g, '')}`;
            }
        }
    }
    return `${username}luban`;
}

export interface ProbeFeedConfig {
    configured: boolean;
    host: string;
    port: number;
    tls: boolean;
    username: string;
    password: string;
    clientId: string;
    topics: { [channel in ProbeChannel]: string | null };
    inverted: { [channel in ProbeChannel]: boolean };
    sources: { [field: string]: 'env' | 'config' | null };
    missing: string[];
}

/**
 * Resolve the feed configuration, environment first then configstore, so a
 * one-off env override never persists. Read fresh on every connect attempt -
 * settings changes apply at the next connect, not mid-connection.
 */
export function resolveProbeFeedConfig(): ProbeFeedConfig {
    const sources: { [field: string]: 'env' | 'config' | null } = {};
    const raw: { [field: string]: string } = {};
    for (const name of Object.keys(FIELDS)) {
        const field = resolveField(name);
        raw[name] = field.value;
        sources[name] = field.source;
    }

    const port = Number(raw.port) || 8883;
    const topics = {} as { [channel in ProbeChannel]: string | null };
    for (const channel of PROBE_CHANNELS) {
        const feed = raw[channel];
        if (!feed) {
            topics[channel] = null;
        } else if (feed.includes('/')) {
            topics[channel] = feed; // full topic given
        } else {
            topics[channel] = `${raw.username}/feeds/${feed}`; // Adafruit IO shape
        }
    }

    const invertedNames = raw.inverted.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
    const inverted = {} as { [channel in ProbeChannel]: boolean };
    for (const channel of PROBE_CHANNELS) {
        inverted[channel] = invertedNames.includes(channel);
    }

    const missing = ['host', 'username', 'password'].filter((name) => !raw[name]);
    if (!PROBE_CHANNELS.some((channel) => topics[channel])) {
        missing.push('at least one feed topic');
    }

    return {
        configured: missing.length === 0,
        host: raw.host,
        port,
        tls: port !== 1883, // Adafruit IO default 8883 is TLS; 1883 is plain
        username: raw.username,
        password: raw.password,
        clientId: raw.clientId || defaultClientId(raw.username || 'luban'),
        topics,
        inverted,
        sources,
        missing,
    };
}

/**
 * Sensor payloads that count as "in contact" / "tripped". `inverted` flips
 * the polarity for normally-open circuits that idle HIGH and read low on
 * contact (the CNC touch probe); an empty payload is unknown, never contact,
 * regardless of polarity.
 */
export function isTriggeredValue(value: string, inverted = false): boolean {
    const text = String(value).trim().toLowerCase();
    if (text === '') {
        return false;
    }
    const numeric = Number(text);
    const raw = Number.isFinite(numeric)
        ? numeric > 0
        : ['on', 'true', 'touch', 'touched', 'triggered', 'contact', 'high', 'yes'].includes(text);
    return inverted ? !raw : raw;
}

export interface ProbeReading {
    value: string;
    triggered: boolean;
    receivedAt: number;
    topic: string;
}

interface SafetyTrip {
    kind: 'overtravel' | 'crash';
    channel: ProbeChannel;
    at: number;
    value: string;
    actions: string[];
}

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;

export class ProbeFeedService {
    private client: MqttClient | null = null;

    private activeConfig: ProbeFeedConfig | null = null;

    private readings = new Map<ProbeChannel, ProbeReading>();

    private trip: SafetyTrip | null = null;

    // Crash guard (added after the 2026-09-01 probe crash): while any
    // sensor-visible motion is in flight, a triggered reading on a contact
    // channel that is NOT expected to touch anything is a collision - same
    // response as overtravel. Procedures declare their expected channels.
    private motionCount = 0;

    private expectedContact = new Set<ProbeChannel>();

    private reconnectTimer: NodeJS.Timeout | null = null;

    private reconnectAttempts = 0;

    private wantConnected = false;

    private connecting = false;

    private lastError: string | null = null;

    /**
     * Start (or keep) the feed connection. Idempotent; reconnection with
     * backoff is automatic until disconnect() is called. Resolves once the
     * broker accepts the session and subscriptions are sent.
     */
    public async connect(): Promise<void> {
        if (this.client && this.client.connected) {
            return;
        }
        const cfg = resolveProbeFeedConfig();
        if (!cfg.configured) {
            throw new Error(`Probe feed is not configured: missing ${cfg.missing.join(', ')}. `
                + 'Set the MQTT fields on Settings -> MCP Server or the LUBAN_MCP_MQTT_* environment variables.');
        }
        this.wantConnected = true;
        await this.openOnce(cfg);
    }

    /** Stop the connection and the reconnect loop. The alarm latch persists. */
    public disconnect(): void {
        this.wantConnected = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.client) {
            this.client.end();
            this.client = null;
        }
        this.connecting = false;
    }

    public isConnected(): boolean {
        return !!(this.client && this.client.connected);
    }

    public getReading(channel: ProbeChannel): ProbeReading | null {
        return this.readings.get(channel) || null;
    }

    /**
     * Wait for a reading on a channel newer than `sinceTimestamp`. Resolves
     * null on timeout - for a change-reporting sensor, silence means the
     * state has not changed.
     */
    public async waitForReading(channel: ProbeChannel, sinceTimestamp: number, timeoutMs: number): Promise<ProbeReading | null> {
        return new Promise((resolve) => {
            const existing = this.readings.get(channel);
            if (existing && existing.receivedAt > sinceTimestamp) {
                resolve(existing);
                return;
            }
            const started = Date.now();
            const poll = setInterval(() => {
                const reading = this.readings.get(channel);
                if (reading && reading.receivedAt > sinceTimestamp) {
                    clearInterval(poll);
                    resolve(reading);
                } else if (Date.now() - started > timeoutMs) {
                    clearInterval(poll);
                    resolve(null);
                }
            }, 50);
        });
    }

    public getTrip(): SafetyTrip | null {
        return this.trip;
    }

    /**
     * Throws when the overtravel alarm is latched - called by every motion
     * tool before sending anything to the machine.
     */
    public assertNoOvertravel(): void {
        if (this.trip) {
            throw new McpToolError(`${this.trip.kind === 'crash' ? 'CRASH' : 'OVERTRAVEL'} ALARM latched at `
                + `${new Date(this.trip.at).toISOString()} (${this.trip.channel} sensor value "${this.trip.value}"). `
                + 'All motion is blocked. The operator must inspect '
                + 'the machine and explicitly clear the alarm (clear_overtravel_alarm) or restart Luban.');
        }
    }

    /** Operator-authorised alarm clear; refuses while still reporting triggered. */
    public clearTrip(): void {
        const channel = this.trip ? this.trip.channel : 'overtravel';
        const reading = this.readings.get(channel);
        if (reading && reading.triggered) {
            throw new McpToolError(`The ${channel} feed still reports triggered; refusing to clear the alarm.`);
        }
        this.trip = null;
        log.warn('Safety alarm cleared by operator authority.');
    }

    /** Motion-in-flight bracket for the crash guard. Always pair with motionEnd. */
    public motionBegin(): void {
        this.motionCount += 1;
    }

    public motionEnd(): void {
        this.motionCount = Math.max(0, this.motionCount - 1);
    }

    /** Declare which channels a probing procedure EXPECTS to touch. */
    public setExpectedContact(channels: ProbeChannel[]): void {
        this.expectedContact = new Set(channels);
    }

    public clearExpectedContact(): void {
        this.expectedContact.clear();
    }

    public status(): object {
        const cfg = this.activeConfig || resolveProbeFeedConfig();
        const feeds: { [channel: string]: object | null } = {};
        for (const channel of PROBE_CHANNELS) {
            const reading = this.readings.get(channel);
            feeds[channel] = {
                topic: cfg.topics[channel],
                inverted: cfg.inverted[channel],
                last: reading ? {
                    value: reading.value,
                    triggered: reading.triggered,
                    receivedAt: reading.receivedAt,
                    ageMs: Date.now() - reading.receivedAt,
                } : null,
            };
        }
        return {
            transport: 'mqtt',
            configured: cfg.configured,
            missing: cfg.missing,
            connected: this.isConnected(),
            connecting: this.connecting,
            host: cfg.host || null,
            port: cfg.port,
            tls: cfg.tls,
            username: cfg.username || null,
            clientId: cfg.clientId,
            configSources: cfg.sources,
            feeds,
            safetyTrip: this.trip,
            reconnectAttempts: this.reconnectAttempts,
            lastError: this.lastError,
        };
    }

    private async openOnce(cfg: ProbeFeedConfig): Promise<void> {
        if (this.connecting) {
            return Promise.resolve();
        }
        this.connecting = true;
        this.activeConfig = cfg;
        return new Promise((resolve, reject) => {
            const client = new MqttClient({
                host: cfg.host,
                port: cfg.port,
                tls: cfg.tls,
                clientId: cfg.clientId,
                username: cfg.username,
                password: cfg.password,
            });
            this.client = client;
            let settled = false;

            client.on('connect', () => {
                this.connecting = false;
                this.reconnectAttempts = 0;
                this.lastError = null;
                const topics = PROBE_CHANNELS.map((channel) => cfg.topics[channel]).filter(Boolean) as string[];
                client.subscribe(topics);
                // Adafruit IO replays a feed's last value when an empty
                // message is published to <topic>/get - prime the cache so a
                // fresh session knows the resting state without waiting for
                // the sensor to change.
                if (cfg.host.toLowerCase().includes('adafruit')) {
                    for (const topic of topics) {
                        client.publish(`${topic}/get`, '');
                    }
                }
                log.info(`Probe feed connected to ${cfg.host}:${cfg.port} as ${cfg.clientId}, `
                    + `subscribed to ${topics.length} topic(s)`);
                mcpBroadcast('mcp:activity', { tool: 'probe_feed', phase: 'connected', host: cfg.host });
                if (!settled) {
                    settled = true;
                    resolve();
                }
            });

            client.on('message', (topic: string, payload: string) => this.onMessage(topic, payload));

            client.on('error', (err: Error) => {
                this.lastError = err.message;
                log.error(`Probe feed error: ${err.message}`);
                if (!settled) {
                    settled = true;
                    this.connecting = false;
                    reject(err);
                }
            });

            client.on('close', () => {
                this.connecting = false;
                if (this.client === client) {
                    this.client = null;
                }
                if (this.wantConnected) {
                    this.scheduleReconnect();
                }
            });

            client.connect();
        });
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer || !this.wantConnected) {
            return;
        }
        this.reconnectAttempts += 1;
        const delay = Math.min(RECONNECT_BASE_MS * (2 ** Math.min(this.reconnectAttempts - 1, 4)), RECONNECT_MAX_MS);
        log.info(`Probe feed reconnect ${this.reconnectAttempts} in ${delay}ms`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            const cfg = resolveProbeFeedConfig();
            if (!cfg.configured) {
                this.wantConnected = false;
                return;
            }
            this.openOnce(cfg).catch(() => {
                // close handler schedules the next attempt
            });
        }, delay);
    }

    private onMessage(topic: string, payload: string): void {
        const cfg = this.activeConfig;
        if (!cfg) {
            return;
        }
        for (const channel of PROBE_CHANNELS) {
            if (cfg.topics[channel] !== topic) {
                continue;
            }
            const reading: ProbeReading = {
                value: payload,
                triggered: isTriggeredValue(payload, cfg.inverted[channel]),
                receivedAt: Date.now(),
                topic,
            };
            this.readings.set(channel, reading);
            mcpBroadcast('mcp:activity', {
                tool: 'probe_feed',
                phase: 'reading',
                channel,
                value: payload,
                triggered: reading.triggered,
            });
            log.info(`reading ${channel}=${payload} triggered=${reading.triggered}`);
            if (!this.trip && reading.triggered) {
                if (channel === 'overtravel') {
                    this.tripSafety('overtravel', channel, reading);
                } else if (this.motionCount > 0 && !this.expectedContact.has(channel)) {
                    // A contact sensor fired during motion that expected no
                    // contact: collision. Stop everything.
                    this.tripSafety('crash', channel, reading);
                }
            }
            return;
        }
    }

    /**
     * The overtravel tripwire: stop whatever is running, force-close the
     * machine connection, latch the alarm, tell the operator. Best-effort on
     * every step - a failed stop must not prevent the disconnect.
     */
    private tripSafety(kind: 'overtravel' | 'crash', channel: ProbeChannel, reading: ProbeReading): void {
        const actions: string[] = [];
        this.trip = { kind, channel, at: reading.receivedAt, value: reading.value, actions };
        log.error(`${kind.toUpperCase()} reported by ${channel} feed (value "${reading.value}") - aborting all jobs and connections`);

        const machineChannel = connectionManager.getCurrentChannel() as unknown as {
            stopGcodeJob?: () => Promise<unknown>;
            connectionClose?: (options: { force: boolean }) => Promise<unknown>;
        } | null;
        if (machineChannel) {
            (async () => {
                if (typeof machineChannel.stopGcodeJob === 'function') {
                    try {
                        await machineChannel.stopGcodeJob();
                        actions.push('stop_gcode_job sent');
                        log.error(`${kind} abort: stop sent to the machine`);
                    } catch (err) {
                        actions.push(`stop_gcode_job failed: ${err.message}`);
                        log.error(`${kind} abort: stop failed: ${err.message}`);
                    }
                }
                if (typeof machineChannel.connectionClose === 'function') {
                    try {
                        await machineChannel.connectionClose({ force: true });
                        actions.push('connection force-closed');
                        log.error(`${kind} abort: machine connection force-closed`);
                    } catch (err) {
                        actions.push(`connection close failed: ${err.message}`);
                        log.error(`${kind} abort: close failed: ${err.message}`);
                    }
                }
            })();
        } else {
            actions.push('no machine channel connected');
        }

        mcpBroadcast('mcp:activity', {
            tool: 'probe_feed',
            phase: kind === 'crash' ? 'CRASH_ALARM' : 'OVERTRAVEL_ALARM',
            value: reading.value,
            message: `${kind === 'crash' ? `Collision: ${channel} sensor fired during motion that expected no contact` : 'Overtravel sensor tripped'}: `
                + 'running job stopped, machine connection force-closed, all MCP motion blocked '
                + 'until the operator clears the alarm.',
        });
    }
}

export const probeFeedService = new ProbeFeedService();
