// The accelerometer feed: runs the sensor monitor (vibration_monitor.py),
// turns its batches into timed samples per sensor, keeps a look-back ring
// of each stream, and hands samples to whoever is recording (captures).
//
// Two transports, one protocol:
//   - blinka: the monitor runs here under Python + Adafruit Blinka, spawned
//     like the GPIO probe monitor, on a USB I2C bridge of its OWN (or a Pi
//     header). vibrationConfig refuses the probe feed's bridge: the probe
//     and crash sensors are safety equipment and never share a USB device
//     with an experiment.
//   - serial: a CircuitPython board near the machine runs the same file as
//     code.py and streams over USB serial; this side sends it the sensor
//     list. A board does the I2C at full speed, so it suits several
//     sensors and long cables to the toolhead / tailstock / rotary.
//
// Read-only with respect to the machine: nothing here commands, pauses or
// stops anything, and nothing in the motion or probe path waits on it.

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

import logger from '../../lib/logger';
import config from '../configstore';
import { VibrationConfig, SensorSpec, monitorConfig, resolveVibrationConfig } from './vibrationConfig';
import { VIBRATION_MONITOR_SOURCE } from './vibrationMonitorSource';
import { ClockStats, FifoClock, MonitorBatch, PollResampler, ProtocolError, decodeBatch } from './vibrationProtocol';

const log = logger('service:mcp:vibration-feed');

const HEARTBEAT_MS = 1000;
/** No line at all for this long after ready: the monitor (or cable) is dead. */
const STALL_MS = 6000;
/** First Blinka import + bridge enumeration can be slow. */
const READY_TIMEOUT_MS = 30000;
const BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];
const STDERR_TAIL_CHARS = 2000;
/** A poll stream silent for longer than this is a gap, not a slow sample. */
const POLL_MAX_GAP_S = 0.5;
/** Recent batches over which a board clock's offset to the host is taken (lower envelope). */
const BOARD_OFFSET_WINDOW = 100;

export function currentVibrationConfig(): VibrationConfig {
    return resolveVibrationConfig(process.env, (key) => config.get(key));
}

/** Fixed-capacity ring of timed samples (host ms; accel x,y,z g; optional gyro dps). */
export class SampleRing {
    public readonly capacity: number;

    private readonly times: Float64Array;

    private readonly accel: Float32Array;

    private gyro: Float32Array | null = null;

    private head = 0;

    private size = 0;

    public constructor(capacity: number) {
        this.capacity = Math.max(16, capacity);
        this.times = new Float64Array(this.capacity);
        this.accel = new Float32Array(this.capacity * 3);
    }

    public push(times: Float64Array, accel: Float32Array, gyro: Float32Array | null): void {
        if (gyro && !this.gyro) {
            this.gyro = new Float32Array(this.capacity * 3);
        }
        for (let i = 0; i < times.length; i++) {
            const at = this.head;
            this.times[at] = times[i];
            this.accel[at * 3] = accel[i * 3];
            this.accel[at * 3 + 1] = accel[i * 3 + 1];
            this.accel[at * 3 + 2] = accel[i * 3 + 2];
            if (this.gyro) {
                this.gyro[at * 3] = gyro ? gyro[i * 3] : 0;
                this.gyro[at * 3 + 1] = gyro ? gyro[i * 3 + 1] : 0;
                this.gyro[at * 3 + 2] = gyro ? gyro[i * 3 + 2] : 0;
            }
            this.head = (this.head + 1) % this.capacity;
            this.size = Math.min(this.size + 1, this.capacity);
        }
    }

    public get length(): number {
        return this.size;
    }

    public span(): { fromMs: number; toMs: number } | null {
        if (!this.size) {
            return null;
        }
        const first = (this.head - this.size + this.capacity) % this.capacity;
        const last = (this.head - 1 + this.capacity) % this.capacity;
        return { fromMs: this.times[first], toMs: this.times[last] };
    }

    /** Samples with fromMs <= t < toMs, oldest first. */
    public slice(fromMs: number, toMs: number): { times: Float64Array; accel: Float32Array; gyro: Float32Array | null } {
        const picked: number[] = [];
        for (let i = 0; i < this.size; i++) {
            const at = (this.head - this.size + i + this.capacity) % this.capacity;
            const t = this.times[at];
            if (t >= fromMs && t < toMs) {
                picked.push(at);
            }
        }
        const times = new Float64Array(picked.length);
        const accel = new Float32Array(picked.length * 3);
        const gyro = this.gyro ? new Float32Array(picked.length * 3) : null;
        picked.forEach((at, i) => {
            times[i] = this.times[at];
            accel.set(this.accel.subarray(at * 3, at * 3 + 3), i * 3);
            if (gyro && this.gyro) {
                gyro.set(this.gyro.subarray(at * 3, at * 3 + 3), i * 3);
            }
        });
        return { times, accel, gyro };
    }
}

export interface SensorRuntime {
    spec: SensorSpec;
    /** waiting: no word from the monitor yet; ok: streaming; failed: the monitor reported it failed (retried there). */
    state: 'waiting' | 'ok' | 'failed';
    error: string | null;
    /** What the monitor said about it at ready (chip, WHO_AM_I, the chip's own ODR, scale). */
    info: { [key: string]: unknown } | null;
    /** The monitor's latest heartbeat counters for it. */
    counters: { [key: string]: unknown } | null;
    clock: FifoClock | null;
    resampler: PollResampler | null;
    ring: SampleRing;
    boardOffsets: number[];
    lastBatchAt: number | null;
    batches: number;
    samples: number;
    gaps: number;
    protocolErrors: number;
}

/** The sample rate a stream is recorded at right now (Hz). */
export function streamRate(runtime: SensorRuntime): number {
    if (runtime.clock) {
        return runtime.clock.rateHz();
    }
    return runtime.resampler ? runtime.resampler.rateHz : runtime.spec.rateHz;
}

interface LineTransport extends EventEmitter {
    open(): void;
    close(): void;
    send(line: string): void;
    describe(): { [key: string]: unknown };
}

class ChildTransport extends EventEmitter implements LineTransport {
    private child: ChildProcess | null = null;

    private buffer = '';

    private stderrTail = '';

    public constructor(private readonly cfg: VibrationConfig) {
        super();
    }

    public open(): void {
        const cfgJson = JSON.stringify(monitorConfig(this.cfg, HEARTBEAT_MS));
        let child: ChildProcess;
        try {
            child = spawn(this.cfg.python, ['-u', '-c', VIBRATION_MONITOR_SOURCE, cfgJson], {
                env: { ...process.env, ...this.cfg.blinkaEnv },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (err) {
            setImmediate(() => this.emit('close', `failed to spawn "${this.cfg.python}": ${(err as Error).message}`));
            return;
        }
        this.child = child;
        child.on('error', (err: Error) => {
            this.emit('close', `monitor spawn failed ("${this.cfg.python}"): ${err.message}`);
        });
        if (child.stderr) {
            child.stderr.on('data', (chunk: Buffer) => {
                this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
            });
        }
        if (child.stdout) {
            child.stdout.on('data', (chunk: Buffer) => {
                this.buffer += chunk.toString('utf8');
                let newline = this.buffer.indexOf('\n');
                while (newline >= 0) {
                    const line = this.buffer.slice(0, newline).trim();
                    this.buffer = this.buffer.slice(newline + 1);
                    if (line) {
                        this.emit('line', line);
                    }
                    newline = this.buffer.indexOf('\n');
                }
            });
        }
        child.on('exit', (code: number | null, signal: string | null) => {
            if (this.child === child) {
                this.child = null;
            }
            const tail = this.stderrTail.trim().split('\n').slice(-3).join(' | ');
            this.emit('close', `monitor exited (${signal || `code ${code}`})${tail ? `: ${tail}` : ''}`);
        });
    }

    public close(): void {
        const child = this.child;
        this.child = null;
        if (child) {
            try {
                child.kill();
            } catch (err) {
                // already gone
            }
        }
    }

    public send(): void {
        // The child takes its configuration on the command line.
    }

    public describe(): { [key: string]: unknown } {
        return { transport: 'blinka', python: this.cfg.python, blinkaEnv: this.cfg.blinkaEnvText, pid: this.child ? this.child.pid : null };
    }
}

interface SerialPortLike extends EventEmitter {
    open(callback: (err: Error | null) => void): void;
    close(callback?: (err: Error | null) => void): void;
    write(data: string): boolean;
    isOpen: boolean;
}

class SerialTransport extends EventEmitter implements LineTransport {
    private port: SerialPortLike | null = null;

    private buffer = '';

    public constructor(private readonly cfg: VibrationConfig) {
        super();
    }

    public open(): void {
        let port: SerialPortLike;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
            const { SerialPort } = require('serialport');
            // USB CDC ignores the baud rate; 115200 for a UART adapter.
            port = new SerialPort({ path: this.cfg.serialPort as string, baudRate: 115200, autoOpen: false }) as SerialPortLike;
        } catch (err) {
            setImmediate(() => this.emit('close', `serial port unavailable: ${(err as Error).message}`));
            return;
        }
        this.port = port;
        port.on('data', (chunk: Buffer) => {
            this.buffer += chunk.toString('utf8');
            if (this.buffer.length > 1 << 22) {
                this.buffer = '';
            }
            let newline = this.buffer.indexOf('\n');
            while (newline >= 0) {
                const line = this.buffer.slice(0, newline).trim();
                this.buffer = this.buffer.slice(newline + 1);
                if (line) {
                    this.emit('line', line);
                }
                newline = this.buffer.indexOf('\n');
            }
        });
        port.on('close', () => {
            if (this.port === port) {
                this.port = null;
            }
            this.emit('close', `serial port ${this.cfg.serialPort} closed`);
        });
        port.on('error', (err: Error) => {
            log.warn(`vibration serial ${this.cfg.serialPort}: ${err.message}`);
        });
        port.open((err: Error | null) => {
            if (err) {
                this.port = null;
                this.emit('close', `cannot open ${this.cfg.serialPort}: ${err.message}`);
                return;
            }
            this.emit('opened');
        });
    }

    public close(): void {
        const port = this.port;
        this.port = null;
        if (port && port.isOpen) {
            port.close();
        }
    }

    public send(line: string): void {
        if (this.port && this.port.isOpen) {
            this.port.write(`${line}\r\n`);
        }
    }

    public describe(): { [key: string]: unknown } {
        return { transport: 'serial', port: this.cfg.serialPort, open: !!(this.port && this.port.isOpen) };
    }
}

function rateSource(rt: SensorRuntime | undefined, clock: ClockStats | null): string | null {
    if (clock) {
        return clock.rateSource;
    }
    return rt && rt.resampler ? 'poll-grid' : null;
}

function runBreaks(rt: SensorRuntime | undefined, clock: ClockStats | null): number | null {
    if (clock) {
        return clock.breaks;
    }
    return rt ? rt.gaps : null;
}

export type FeedState = 'off' | 'unconfigured' | 'starting' | 'running' | 'retrying';

/**
 * Events: 'samples' (sensorId, timesMs: Float64Array, accel: Float32Array,
 * gyro: Float32Array | null, gap: boolean) for every decoded batch.
 */
export class VibrationFeedService extends EventEmitter {
    private cfg: VibrationConfig | null = null;

    private transport: LineTransport | null = null;

    private state: FeedState = 'off';

    private lastError: string | null = null;

    private ready: { [key: string]: unknown } | null = null;

    private progress: { [key: string]: unknown } | null = null;

    private busy: number | null = null;

    private readonly sensors = new Map<string, SensorRuntime>();

    private stallTimer: NodeJS.Timeout | null = null;

    private readyTimer: NodeJS.Timeout | null = null;

    private retryTimer: NodeJS.Timeout | null = null;

    private configResentAt = 0;

    private attempt = 0;

    private connectedAt: number | null = null;

    private warnings: Array<{ at: number; id: string | null; error: string }> = [];

    /** (Re)read the settings and start, restart or stop to match them. */
    public reconfigure(): void {
        this.shutdown();
        const cfg = currentVibrationConfig();
        this.cfg = cfg;
        if (!cfg.enabled) {
            this.state = 'off';
            return;
        }
        if (cfg.problems.length) {
            this.state = 'unconfigured';
            this.lastError = cfg.problems.join('; ');
            log.warn(`vibration feed not started: ${this.lastError}`);
            return;
        }
        this.attempt = 0;
        this.connect();
    }

    public shutdown(): void {
        this.clearTimers();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        const transport = this.transport;
        this.transport = null;
        if (transport) {
            transport.removeAllListeners();
            transport.close();
        }
        this.state = 'off';
        this.connectedAt = null;
    }

    public isRunning(): boolean {
        return this.state === 'running';
    }

    public config(): VibrationConfig {
        return this.cfg || currentVibrationConfig();
    }

    public runtime(id: string): SensorRuntime | null {
        return this.sensors.get(id) || null;
    }

    public runtimes(): SensorRuntime[] {
        return [...this.sensors.values()];
    }

    public status(): { [key: string]: unknown } {
        const cfg = this.config();
        return {
            enabled: cfg.enabled,
            state: this.state,
            transport: this.transport ? this.transport.describe() : { transport: cfg.transport },
            last_error: this.lastError,
            problems: cfg.problems,
            connected_since: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
            board: this.ready ? this.ready.board : null,
            i2c_pins: this.ready ? this.ready.pins : (this.progress && this.progress.pins) || null,
            startup_progress: this.state === 'running' ? null : this.progress,
            bus_busy_fraction: this.busy,
            sensors: cfg.sensors.map((spec) => {
                const rt = this.sensors.get(spec.id);
                const clock = rt && rt.clock ? rt.clock.stats() : null;
                const jitter = rt && rt.resampler ? rt.resampler.jitter() : null;
                const span = rt ? rt.ring.span() : null;
                return {
                    id: spec.id,
                    location: spec.location,
                    chip: spec.chip,
                    mode: spec.mode,
                    address: `0x${spec.address.toString(16)}`,
                    mux: spec.mux ? { address: `0x${spec.mux.address.toString(16)}`, channel: spec.mux.channel } : null,
                    configured_rate_hz: spec.rateHz,
                    range_g: spec.rangeG,
                    gyro: spec.gyro,
                    orientation: spec.orientation ? `x:${spec.orientation[0]},y:${spec.orientation[1]},z:${spec.orientation[2]}` : null,
                    note: spec.note,
                    state: rt ? rt.state : 'waiting',
                    error: rt ? rt.error : null,
                    chip_report: rt ? rt.info : null,
                    rate_hz: rt ? Math.round(streamRate(rt) * 1000) / 1000 : null,
                    rate_source: rateSource(rt, clock),
                    run_breaks: runBreaks(rt, clock),
                    poll_jitter_ms: jitter ? { mean: Math.round(jitter.meanS * 10000) / 10, p95: Math.round(jitter.p95S * 10000) / 10 } : null,
                    samples: rt ? rt.samples : 0,
                    buffered_s: span ? Math.round((span.toMs - span.fromMs) / 100) / 10 : 0,
                    last_batch_age_ms: rt && rt.lastBatchAt ? Date.now() - rt.lastBatchAt : null,
                    monitor_counters: rt ? rt.counters : null,
                    protocol_errors: rt ? rt.protocolErrors : 0,
                };
            }),
            recent_warnings: this.warnings.slice(-10).map((w) => ({ at: new Date(w.at).toISOString(), sensor: w.id, error: w.error })),
        };
    }

    private connect(): void {
        const cfg = this.cfg as VibrationConfig;
        this.state = this.attempt ? 'retrying' : 'starting';
        this.ready = null;
        this.progress = null;
        this.busy = null;
        this.sensors.clear();
        for (const spec of cfg.sensors) {
            const capacity = Math.ceil(spec.rateHz * 1.02 * cfg.bufferS);
            this.sensors.set(spec.id, {
                spec,
                state: 'waiting',
                error: null,
                info: null,
                counters: null,
                clock: spec.mode === 'fifo' ? new FifoClock(spec.rateHz) : null,
                resampler: spec.mode === 'poll' ? new PollResampler(spec.rateHz, POLL_MAX_GAP_S) : null,
                ring: new SampleRing(capacity),
                boardOffsets: [],
                lastBatchAt: null,
                batches: 0,
                samples: 0,
                gaps: 0,
                protocolErrors: 0,
            });
        }
        const transport: LineTransport = cfg.transport === 'serial' ? new SerialTransport(cfg) : new ChildTransport(cfg);
        this.transport = transport;
        transport.on('line', (line: string) => this.onLine(line));
        transport.on('opened', () => this.sendConfig());
        transport.on('close', (reason: string) => this.onClose(reason));
        this.readyTimer = setTimeout(() => {
            this.onClose(`no ready line within ${READY_TIMEOUT_MS} ms (startup stage: ${JSON.stringify(this.progress)})`);
        }, READY_TIMEOUT_MS);
        transport.open();
    }

    private sendConfig(): void {
        if (!this.transport || !this.cfg) {
            return;
        }
        this.configResentAt = Date.now();
        this.transport.send(JSON.stringify(monitorConfig(this.cfg, HEARTBEAT_MS)));
    }

    private onClose(reason: string): void {
        if (!this.transport) {
            return;
        }
        const transport = this.transport;
        this.transport = null;
        transport.removeAllListeners();
        transport.close();
        this.clearTimers();
        this.lastError = reason;
        this.connectedAt = null;
        for (const rt of this.sensors.values()) {
            rt.state = 'waiting';
        }
        const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
        this.attempt++;
        this.state = 'retrying';
        log.warn(`vibration feed down (${reason}); retrying in ${delay} ms`);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.cfg && this.cfg.enabled) {
                this.connect();
            }
        }, delay);
        if (typeof this.retryTimer.unref === 'function') {
            this.retryTimer.unref();
        }
    }

    private clearTimers(): void {
        if (this.stallTimer) {
            clearTimeout(this.stallTimer);
            this.stallTimer = null;
        }
        if (this.readyTimer) {
            clearTimeout(this.readyTimer);
            this.readyTimer = null;
        }
    }

    private bumpStall(): void {
        if (this.stallTimer) {
            clearTimeout(this.stallTimer);
        }
        this.stallTimer = setTimeout(() => this.onClose(`monitor silent for ${STALL_MS} ms`), STALL_MS);
        if (typeof this.stallTimer.unref === 'function') {
            this.stallTimer.unref();
        }
    }

    private warn(id: string | null, error: string): void {
        this.warnings.push({ at: Date.now(), id, error });
        if (this.warnings.length > 50) {
            this.warnings.splice(0, this.warnings.length - 50);
        }
    }

    private onLine(line: string): void {
        if (line[0] !== '{') {
            // CircuitPython's own console chatter ("Auto-reload...", "Code done running").
            return;
        }
        let msg: { [key: string]: unknown };
        try {
            msg = JSON.parse(line);
        } catch (err) {
            return;
        }
        if (this.state === 'running') {
            this.bumpStall();
        }
        switch (msg.t) {
            case 'progress':
                this.progress = msg;
                if (msg.stage === 'waiting-config' && Date.now() - this.configResentAt > 1500) {
                    this.sendConfig();
                }
                return;
            case 'ready':
                this.onReady(msg);
                return;
            case 'batch':
                this.onBatch(msg);
                return;
            case 'hb':
                this.busy = typeof msg.busy === 'number' ? msg.busy : null;
                if (msg.sensors && typeof msg.sensors === 'object') {
                    for (const [id, counters] of Object.entries(msg.sensors as { [id: string]: { [key: string]: unknown } })) {
                        const rt = this.sensors.get(id);
                        if (rt) {
                            rt.counters = counters;
                            if (counters.state === 'ok' || counters.state === 'failed') {
                                rt.state = counters.state;
                            }
                        }
                    }
                }
                return;
            case 'warn': {
                const id = msg.id ? String(msg.id) : null;
                const error = String(msg.error || 'unknown');
                const rt = id ? this.sensors.get(id) : null;
                if (rt) {
                    rt.error = error;
                    if (!/switching to one word per read/.test(error)) {
                        rt.state = 'failed';
                    }
                }
                this.warn(id, error);
                log.warn(`vibration monitor: ${id ? `${id}: ` : ''}${error}`);
                return;
            }
            case 'fatal':
                this.lastError = String(msg.error || 'fatal');
                this.warn(null, this.lastError);
                log.error(`vibration monitor fatal: ${this.lastError}`);
                break;
            default:
        }
    }

    private onReady(msg: { [key: string]: unknown }): void {
        if (this.readyTimer) {
            clearTimeout(this.readyTimer);
            this.readyTimer = null;
        }
        this.ready = msg;
        this.state = 'running';
        this.attempt = 0;
        this.lastError = null;
        this.connectedAt = Date.now();
        for (const rt of this.sensors.values()) {
            // A new monitor run: new sequence numbers, new clocks.
            rt.clock = rt.spec.mode === 'fifo' ? new FifoClock(rt.spec.rateHz) : null;
            rt.resampler = rt.spec.mode === 'poll' ? new PollResampler(rt.spec.rateHz, POLL_MAX_GAP_S) : null;
            rt.boardOffsets = [];
        }
        const described = Array.isArray(msg.sensors) ? msg.sensors as Array<{ [key: string]: unknown }> : [];
        for (const info of described) {
            const rt = this.sensors.get(String(info.id));
            if (rt) {
                rt.info = info;
                rt.state = info.state === 'ok' ? 'ok' : 'failed';
                rt.error = info.error ? String(info.error) : null;
            }
        }
        log.info(`vibration monitor ready on ${String(msg.board)} (${String(msg.pins)}): `
            + `${described.map((s) => `${String(s.id)}=${String(s.state)}`).join(', ')}`);
        this.bumpStall();
    }

    private toHostMs(rt: SensorRuntime, batch: MonitorBatch, times: Float64Array): Float64Array {
        if (batch.clock === 'host') {
            return times.map((t) => t * 1000);
        }
        // Board clock: the offset to the host is the smallest (arrival -
        // stamp) seen recently - the batch that arrived with least delay.
        rt.boardOffsets.push(Date.now() - batch.stampS * 1000);
        if (rt.boardOffsets.length > BOARD_OFFSET_WINDOW) {
            rt.boardOffsets.splice(0, rt.boardOffsets.length - BOARD_OFFSET_WINDOW);
        }
        const offset = Math.min(...rt.boardOffsets);
        return times.map((t) => t * 1000 + offset);
    }

    private onBatch(msg: { [key: string]: unknown }): void {
        const rt = this.sensors.get(String(msg.id));
        if (!rt) {
            return;
        }
        let batch: MonitorBatch;
        try {
            batch = decodeBatch(msg);
        } catch (err) {
            rt.protocolErrors++;
            if (rt.protocolErrors <= 3 && err instanceof ProtocolError) {
                this.warn(rt.spec.id, `malformed batch: ${err.message}`);
            }
            return;
        }
        rt.state = 'ok';
        rt.lastBatchAt = Date.now();
        rt.batches++;
        let times: Float64Array;
        let accel: Float32Array;
        let gyro: Float32Array | null = null;
        let gap: boolean;
        if (rt.clock && batch.mode === 'fifo') {
            const placed = rt.clock.place(batch);
            times = placed.times;
            accel = batch.accel;
            gyro = batch.gyro;
            gap = placed.gap;
        } else if (rt.resampler && batch.mode === 'poll') {
            const resampled = rt.resampler.push(batch);
            times = resampled.times;
            accel = resampled.accel;
            gap = resampled.gap;
        } else {
            rt.protocolErrors++;
            return;
        }
        if (gap) {
            rt.gaps++;
        }
        if (!times.length) {
            return;
        }
        const hostMs = this.toHostMs(rt, batch, times);
        rt.samples += hostMs.length;
        rt.ring.push(hostMs, accel, gyro);
        this.emit('samples', rt.spec.id, hostMs, accel, gyro, gap);
    }
}

export const vibrationFeedService = new VibrationFeedService();
