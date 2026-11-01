import crypto from 'crypto';
import dgram from 'dgram';
import fs from 'fs';
import path from 'path';

import { SACP_TYPE_SERIES_MAP } from '../../../../app/constants/machines';
import {
    BoundaryExtents,
    RAY_BOUNDARY_FILENAME,
    SETUP_BY_CONTROL_PANEL,
    boundaryFrameSummary,
    boundaryUploadNeeded,
    getRunBoundaryCode,
    jobBoundarySource,
} from '../../../../shared/lib/rayBoundary';
import DataStorage from '../../../DataStorage';
import logger from '../../../lib/logger';
import SacpClient from '../sacp/SacpClient';
import { ChannelEvent } from './ChannelEvent';
import SacpChannelBase from './SacpChannel';
import { ExecuteGcodeResult } from './Channel';
import { gcodeLease } from '../gcodeLease';
import type { BoundaryRefresh, FileJobTransport, FileJobUploadOutcome } from '../../mcp/fileJobStart';
import type { UploadFileOptions } from './Channel';

const log = logger('machine:channels:SacpUdpChannel');

/**
 * The only file the Ray's work switch starts: RayController file_manager.cpp
 * `hmi_req_cb_start_file_print` ("for new can only start print /ray.nc") and
 * led_button_virt_ray.cpp (long press: `start_print("/ray.nc")`). Luban's own
 * RayUploadWidget uploads the job under this name.
 */
export const RAY_JOB_FILENAME = 'ray.nc';

/** What Luban's Ray UI tells the operator after the upload (RayUploadWidget). */
export const RAY_HOLD_INSTRUCTION = 'Press and hold the work switch on the Ray integrated controller for about 3 seconds until '
    + 'the machine starts the task.';

/** The staging-time instruction: the start uploads the job's frame too, and its result says what a SHORT press runs. */
export const RAY_START_INSTRUCTION = `${RAY_HOLD_INSTRUCTION} A SHORT press runs the controller ${RAY_BOUNDARY_FILENAME}: `
    + 'start_gcode_job updates it to this job\'s frame with the upload (only when it differs from the one already there) and '
    + 'its result says whether that succeeded; until then it is the LAST boundary uploaded, not this job\'s frame.';

/** No reply from the controller for this long during an upload ends it as uncertain (never retried blindly). */
export const UPLOAD_INACTIVITY_MS = 30000;

class SacpUdpChannel extends SacpChannelBase {
    // private client: dgram.
    private socketClient = dgram.createSocket('udp4');

    private heartbeatTimer2 = null;

    /** The boundary.nc this connection last put on the controller; null = unknown (see boundaryUploadNeeded). */
    private lastBoundary: { digest: string; generation: number } | null = null;

    public constructor() {
        super();

        this.socketClient.bind(8889, () => {
            log.debug('Bind local port 8889');
        });

        this.socketClient.on('message', (buffer) => {
            // Only when connection is established, then SACP client will be created
            if (this.sacpClient) {
                this.sacpClient.read(buffer);
            }
        });
        this.socketClient.on('close', () => {
            log.info('UDP connection closed');
            this.bumpConnectionGeneration('UDP socket closed');
            const result = {
                code: 200,
                data: {},
                msg: '',
                text: ''
            };
            this.socket && this.socket.emit('connection:close', result);
        });
        this.socketClient.on('error', (err) => {
            log.error(`UDP connection error: ${err}`);
            this.bumpConnectionGeneration('UDP socket error');
        });
    }

    public async test(host: string, port: number): Promise<boolean> {
        const sacpResponse = (async () => {
            this.bumpConnectionGeneration('UDP probe session created');
            this.sacpClient = new SacpClient('udp', {
                socket: this.socketClient,
                host,
                port,
            });
            this.sacpClient.setLogger(log);

            const { data } = await this.sacpClient.getMachineInfo();
            return !!data;
        })();

        const timeoutPromise = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000));

        return Promise.race([sacpResponse, timeoutPromise]);
    }

    public async connectionOpen(options: { address: string }): Promise<boolean> {
        log.debug(`connectionOpen(): options = ${options}`);

        this.emit(ChannelEvent.Connecting);

        this.bumpConnectionGeneration('UDP session created');
        this.sacpClient = new SacpClient('udp', {
            socket: this.socketClient,
            host: options.address,
            port: 8889,
        });
        this.sacpClient.setLogger(log);

        // Get Machine Info
        const machineInfo = await this.getMachineInfo();
        const machineIdentifier = SACP_TYPE_SERIES_MAP[machineInfo.type];
        log.debug(`Get machine info, type = ${machineInfo.type}`);
        log.debug(`Get machine info, machine identifier = ${machineIdentifier}`);

        // Once responsed, it's connected
        this.emit(ChannelEvent.Connected);

        // Machine detected
        this.emit(ChannelEvent.Ready, {
            machineIdentifier,
            deviceSerial: this.deviceSerialOf(machineInfo),
        });

        return true;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async connectionClose(options?: { force: boolean }): Promise<boolean> {
        // UDP is stateless, not need to close
        this.bumpConnectionGeneration('UDP connection closed');
        this.sacpClient?.dispose();

        return true;
    }

    public async startHeartbeat(): Promise<void> {
        return super.startHeartbeat();
    }

    public async stopHeartbeat(id?: string): Promise<void> {
        // Remove heartbeat timeout check
        if (this.heartbeatTimer2) {
            clearTimeout(this.heartbeatTimer2);
            this.heartbeatTimer2 = null;
        }

        // Cancel subscription of heartbeat
        const res = await this.sacpClient.unsubscribeHeartbeat(null);
        log.info(`Unsubscribe heartbeat, result = ${res.code}`);

        super.stopHeartbeat(id);
    }

    /**
     * Generic execute G-code commands.
     *
     * Result 0 of SACP 0x01 0x02 does NOT mean the line ran: the Ray V1.7.4
     * ACKs before it even queues the line, and then drops lines it cannot take
     * (80+ bytes, a full input ring, G-code in Alarm) without a word
     * (RayController 91a675f snapmaker.cpp:272-291). Confirm effects by state.
     * Never resend on a lost ACK: the firmware does not dedupe 0x01 0x02.
     */
    public async executeGcode(gcode: string): Promise<ExecuteGcodeResult> {
        const refusal = gcodeLease.refusal(gcode);
        if (refusal) { return { result: -1, text: refusal }; }
        const result = await this.sacpClient.executeGcode(gcode);

        // if any gcode line fails, then fails
        if (result.response.result !== 0) {
            return {
                result: -1,
            };
        }

        return {
            result: 0,
            text: 'ok',
        };
    }

    /** The channel's own home (SACP 0x01/0x35); true when the controller accepted it. */
    public goHome = async (): Promise<boolean> => {
        const { response } = await this.sacpClient.requestHome();
        this.socket && this.socket.emit('serialport:read', { data: response.result === 0 ? 'OK' : 'WARNING' });
        return response.result === 0;
    }

    // MCP file jobs (#328). The Ray has no start command for an uploaded file:
    // the operator's work switch starts /ray.nc (fileJobStart.ts says where in
    // the firmware), so the MCP uploads and arms; the job-progress
    // subscriptions (SacpChannel) feed the watcher that adopts the run.

    public fileJobTransport(): FileJobTransport {
        return {
            start: 'operator-switch',
            target: RAY_JOB_FILENAME,
            instruction: RAY_START_INSTRUCTION,
            holdInstruction: RAY_HOLD_INSTRUCTION,
            stop: 'file-print-only',
        };
    }

    /**
     * Every upload to boundary.nc (Luban's Run Boundary and Upload Job, the
     * MCP's job frame) goes through here: the transfer is skipped when this
     * connection already put the same bytes on the controller.
     */
    public async compressUploadFile(options: UploadFileOptions): Promise<boolean> {
        if (options.targetFilename !== RAY_BOUNDARY_FILENAME) {
            return super.compressUploadFile(options);
        }
        const result = await this.uploadBoundaryFile(options);
        return result.status !== 'failed';
    }

    /** Upload a boundary file unless it is already current; 'failed' carries the reason. */
    private async uploadBoundaryFile(options: UploadFileOptions): Promise<{ status: 'uploaded' | 'unchanged' | 'failed'; reason?: string }> {
        let digest: string;
        try {
            digest = crypto.createHash('sha256').update(fs.readFileSync(options.filePath)).digest('hex');
        } catch (err) {
            const reason = `cannot read ${options.filePath}: ${(err as Error).message}`;
            options.onFailed?.(reason);
            return { status: 'failed', reason };
        }
        const generation = this.getConnectionGeneration();
        if (!boundaryUploadNeeded(this.lastBoundary, digest, generation)) {
            log.info(`${RAY_BOUNDARY_FILENAME} unchanged on this connection (sha256 ${digest.slice(0, 12)}); not re-sent`);
            return { status: 'unchanged' };
        }
        // Unknown while the transfer runs: an interrupted upload may leave anything there.
        this.lastBoundary = null;
        let failure: string | null = null;
        const ok = await super.compressUploadFile({
            ...options,
            targetFilename: RAY_BOUNDARY_FILENAME,
            onFailed: (reason: string) => {
                failure = reason;
                options.onFailed?.(reason);
            },
        }).catch((err: Error) => {
            failure = `upload request failed: ${err.message}`;
            options.onFailed?.(failure);
            return false;
        });
        if (!ok) {
            return { status: 'failed', reason: failure || 'the controller did not accept the file' };
        }
        // Only the session the file went out on vouches for it.
        this.lastBoundary = this.getConnectionGeneration() === generation ? { digest, generation } : null;
        return { status: 'uploaded' };
    }

    /**
     * Frame an MCP file job for a short press of the work switch: Luban's own
     * Run Boundary G-code (shared/lib/rayBoundary getRunBoundaryCode) from the
     * job's Luban header, or from the validator's work-frame extents when the
     * file has none, uploaded to boundary.nc unless already current. The MCP
     * starts Ray jobs only in Control Mode (motors held, homed), so the frame
     * is the control-panel form: no G92, back to the frame's centre at the end.
     */
    public async uploadJobBoundary(gcodeFilePath: string, extents?: BoundaryExtents | null): Promise<BoundaryRefresh> {
        let text = '';
        try {
            text = fs.readFileSync(gcodeFilePath, 'utf8');
        } catch (err) {
            return { status: 'failed', target: RAY_BOUNDARY_FILENAME, reason: `cannot read the job file: ${(err as Error).message}`, basis: null, frame: null };
        }
        const source = jobBoundarySource(text, extents);
        if (!source) {
            return { status: 'not-framed', target: RAY_BOUNDARY_FILENAME, reason: 'the job has no Luban header bounding box and no X/Y extents', basis: null, frame: null };
        }
        const frame = boundaryFrameSummary(source);
        const gcode = getRunBoundaryCode(source.range, source.jobOffsetMode, source.isRotate, SETUP_BY_CONTROL_PANEL);
        // One armed job at a time holds the machine, so one scratch name is enough.
        const filePath = path.join(DataStorage.tmpDir, 'mcp-job-boundary.nc');
        try {
            fs.writeFileSync(filePath, gcode, 'utf8');
        } catch (err) {
            return { status: 'failed', target: RAY_BOUNDARY_FILENAME, reason: `cannot write the frame file: ${(err as Error).message}`, basis: source.basis, frame };
        }
        const result = await this.uploadBoundaryFile({ filePath, targetFilename: RAY_BOUNDARY_FILENAME });
        return { status: result.status, target: RAY_BOUNDARY_FILENAME, reason: result.reason || null, basis: source.basis, frame };
    }

    /**
     * Upload a job for the MCP exactly as Luban's Ray UI does: the compressed
     * SACP transfer (0xB0 0x10 / 0x11, result 0xB0 0x02) to `ray.nc`, whatever
     * `renderName` says. The callback gets a message on failure and an outcome
     * that tells a definite refusal (nothing usable on the controller) from a
     * lost result (the controller may hold the file; the switch would run it).
     */
    public uploadGcodeFile = (gcodeFilePath: string, type: string, renderName: string,
        callback: (msg: string | null, outcome: FileJobUploadOutcome) => void): void => {
        const refusal = gcodeLease.refusal('start job');
        if (refusal) {
            callback(refusal, { notSent: true });
            return;
        }
        log.info(`MCP file job: compress-uploading ${gcodeFilePath} (${renderName}, ${type}) to the controller as ${RAY_JOB_FILENAME}`);
        let settled = false;
        let failure: string | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (msg: string | null, outcome: FileJobUploadOutcome) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            callback(msg, outcome);
        };
        // The SDK's transfer never times out on its own (a lost 0xB0 0x02 hangs
        // Luban's UI too): no chunk request or result for this long is uncertain.
        const arm = () => {
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => finish(`no reply from the controller for ${UPLOAD_INACTIVITY_MS / 1000} s during the upload`, { uncertain: true }),
                UPLOAD_INACTIVITY_MS);
        };
        arm();
        this.compressUploadFile({
            filePath: gcodeFilePath,
            targetFilename: RAY_JOB_FILENAME,
            onProgress: arm,
            onCompressing: arm,
            onDecompressing: arm,
            onFailed: (reason: string) => { failure = reason; },
        }).then((ok) => {
            if (ok) {
                finish(null, { target: RAY_JOB_FILENAME });
            } else {
                finish(failure || 'the upload did not complete (file unreadable, compression failed, or the controller refused it)', { rejected: true });
            }
        }).catch((err: Error) => {
            // The start request's reply was lost; the controller may still request the chunks.
            finish(`upload request failed: ${err.message}`, { uncertain: true });
        });
    };

    /**
     * The SACP job stop (0xAC 0x06) Luban's own Stop sends over this channel.
     * The Ray stops a FILE print with it (while printing: pause with the abort
     * reason, then stop); outside a file print it raises a non-blocking alarm,
     * which is why fileJobTransport().stop is 'file-print-only'.
     */
    public async stopGcodeJob(): Promise<{ ok: boolean; code?: number; text?: string }> {
        const ok = await this.stopGcode();
        return { ok, text: ok ? 'SACP job stop (0xAC 0x06) accepted by the controller' : 'the controller refused the SACP job stop (0xAC 0x06)' };
    }
}

const channel = new SacpUdpChannel();

export {
    channel as sacpUdpChannel
};

export default SacpUdpChannel;
