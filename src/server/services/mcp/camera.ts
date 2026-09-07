import { execFile } from 'child_process';
import crypto from 'crypto';
import * as fs from 'fs-extra';
import http from 'http';
import https from 'https';
import path from 'path';

import DataStorage from '../../DataStorage';
import logger from '../../lib/logger';
import config from '../configstore';
import { McpToolError } from './registry';

const log = logger('service:mcp:camera');

// Frame capture for the USB webcam near the toolhead (#10). The server is a
// plain forked Node process (no Electron media stack), so capture goes
// through one of two providers:
//   - mcpCameraUrl: HTTP(S) snapshot URL returning a JPEG/PNG per GET
//   - ffmpeg: mcpFfmpegPath (or ffmpeg on PATH) reading the device named by
//     mcpCameraDevice - DirectShow on Windows, v4l2 on Linux. macOS has no
//     ffmpeg input wired up; use mcpCameraUrl there.
const CAPTURE_TIMEOUT_MS = 15000;

const FFMPEG_PROVIDER = process.platform === 'win32' ? 'ffmpeg-dshow' : 'ffmpeg-v4l2';

export interface CapturedFrame {
    frameId: string;
    imageBase64: string;
    mimeType: string;
    provider: string;
    device: string | null;
    capturedAt: number;
}

// Recent frames kept in memory so track_feature can template-match between
// them by id - the dominant field error source was hand-estimated pixel
// coordinates, so measurement between cached frames replaces eyeballing.
const FRAME_CACHE_LIMIT = 12;
const frameCache = new Map<string, Buffer>();

function cacheFrame(jpg: Buffer): string {
    const frameId = crypto.randomBytes(4).toString('hex');
    frameCache.set(frameId, jpg);
    while (frameCache.size > FRAME_CACHE_LIMIT) {
        frameCache.delete(frameCache.keys().next().value);
    }
    return frameId;
}

export function getCachedFrameIds(): string[] {
    return [...frameCache.keys()];
}

export function getCachedFrame(frameId: string): Buffer | null {
    return frameCache.get(frameId) || null;
}

function ffmpegBinary(): string {
    return config.get('mcpFfmpegPath') || 'ffmpeg';
}

async function runFfmpeg(args: string[]): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(ffmpegBinary(), args, { timeout: CAPTURE_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
            if (err && (err as { code?: string }).code === 'ENOENT') {
                reject(new McpToolError('ffmpeg not found. Set configstore key mcpFfmpegPath to an ffmpeg binary, '
                    + 'or set mcpCameraUrl to an HTTP snapshot URL instead.'));
                return;
            }
            resolve({ code: err ? 1 : 0, stderr: String(stderr || '') });
        });
    });
}

/**
 * Enumerate v4l2 capture devices from sysfs (ffmpeg cannot list them). Each
 * physical camera exposes several /dev/video* nodes; only `index` 0 is the
 * actual capture node (the rest are metadata companions), so only those are
 * listed. /dev/videoN numbering shuffles whenever cameras are (un)plugged
 * (seen on the Ubuntu box: the toolhead camera moved video0 -> video2 when
 * a second camera appeared), so entries prefer udev's stable per-device
 * symlink: "/dev/v4l/by-id/usb-...-video-index0 (Friendly Name)", falling
 * back to "/dev/videoN (Friendly Name)". The same string is stored as the
 * sticky device and the leading path is parsed back out at capture time.
 */
function listV4l2Devices(): string[] {
    const root = '/sys/class/video4linux';
    if (!fs.existsSync(root)) {
        return [];
    }
    const byIdDir = '/dev/v4l/by-id';
    const stablePath: { [node: string]: string } = {};
    if (fs.existsSync(byIdDir)) {
        for (const link of fs.readdirSync(byIdDir)) {
            try {
                const target = path.basename(fs.readlinkSync(path.join(byIdDir, link)));
                stablePath[target] = path.join(byIdDir, link);
            } catch (err) {
                // not a symlink; ignore
            }
        }
    }
    const nodes = fs.readdirSync(root)
        .filter((entry) => /^video\d+$/.test(entry))
        .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    const devices: string[] = [];
    for (const node of nodes) {
        const devPath = stablePath[node] || `/dev/${node}`;
        try {
            const index = fs.readFileSync(path.join(root, node, 'index'), 'utf8').trim();
            if (index !== '0') {
                continue;
            }
            const name = fs.readFileSync(path.join(root, node, 'name'), 'utf8').trim();
            devices.push(name ? `${devPath} (${name})` : devPath);
        } catch (err) {
            devices.push(devPath);
        }
    }
    return devices;
}

export async function listCameras(): Promise<{ provider: string; devices: string[]; note?: string }> {
    const cameraUrl = config.get('mcpCameraUrl');
    if (cameraUrl) {
        return { provider: 'http', devices: [String(cameraUrl)], note: 'mcpCameraUrl is set; it takes precedence.' };
    }

    if (process.platform === 'linux') {
        return { provider: 'ffmpeg-v4l2', devices: listV4l2Devices() };
    }
    if (process.platform !== 'win32') {
        return {
            provider: 'ffmpeg',
            devices: [],
            note: `No ffmpeg camera input is wired up for ${process.platform}; set mcpCameraUrl to an `
                + 'HTTP snapshot URL instead.',
        };
    }

    const { stderr } = await runFfmpeg(['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    // ffmpeg prints device lines as: [dshow @ ...] "Device Name" (video)
    const devices: string[] = [];
    for (const line of stderr.split(/\r?\n/)) {
        const match = line.match(/"([^"]+)"\s+\(video\)/);
        if (match) {
            devices.push(match[1]);
        }
    }
    return { provider: 'ffmpeg-dshow', devices };
}

async function captureViaHttp(url: string): Promise<CapturedFrame> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, { timeout: CAPTURE_TIMEOUT_MS }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new McpToolError(`Snapshot URL returned ${res.statusCode}.`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                const contentType = String(res.headers['content-type'] || 'image/jpeg').split(';')[0];
                if (!contentType.startsWith('image/')) {
                    reject(new McpToolError(`Snapshot URL returned ${contentType}, not an image.`));
                    return;
                }
                resolve({
                    frameId: cacheFrame(body),
                    imageBase64: body.toString('base64'),
                    mimeType: contentType,
                    provider: 'http',
                    device: url,
                    capturedAt: Date.now(),
                });
            });
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new McpToolError('Snapshot request timed out.'));
        });
        req.on('error', (err) => {
            reject(new McpToolError(`Snapshot request failed: ${err.message}`));
        });
    });
}

async function captureViaFfmpeg(): Promise<CapturedFrame> {
    // Device choice is sticky: enumeration order is not stable across
    // restarts, and a capture that silently falls back to a different
    // (possibly dead virtual) camera is worse than an error. The last
    // device that produced a frame is remembered and preferred; a missing
    // device is an error, never a substitution.
    if (process.platform !== 'win32' && process.platform !== 'linux') {
        throw new McpToolError(`No ffmpeg camera input is wired up for ${process.platform}. `
            + 'Set mcpCameraUrl to an HTTP snapshot URL instead.');
    }
    let device = config.get('mcpCameraDevice');
    if (!device) {
        const { devices } = await listCameras();
        if (!devices.length) {
            const linuxHint = process.platform === 'linux'
                ? ' (v4l2 devices are read from /sys/class/video4linux; check the camera is attached '
                    + 'and the user can read /dev/video* - video group.)'
                : '';
            throw new McpToolError(`No ${process.platform === 'win32' ? 'DirectShow' : 'v4l2'} video devices `
                + `found. Set configstore key mcpCameraDevice, or mcpCameraUrl for an HTTP snapshot source.${linuxHint}`);
        }
        const lastGood = config.get('mcpCameraLastGood');
        if (lastGood && devices.includes(String(lastGood))) {
            device = lastGood;
        } else if (lastGood) {
            throw new McpToolError(`The last working camera ("${lastGood}") is not in the current device list `
                + `(${devices.join(', ')}). Re-plug it and retry, or set mcpCameraDevice explicitly - refusing `
                + 'to silently substitute a different device.');
        } else {
            device = devices[0];
        }
    }

    // dshow addresses cameras by friendly name; v4l2 by device path. Linux
    // list entries read "<path> (Name)" where path is a /dev/v4l/by-id
    // symlink or /dev/videoN - parse the path back out, and accept a bare
    // path set directly in mcpCameraDevice.
    const inputArgs = process.platform === 'win32'
        ? ['-f', 'dshow', '-i', `video=${device}`]
        : ['-f', 'v4l2', '-i', (String(device).match(/^(\/dev\/\S+)/) || [])[1] || String(device)];

    const outPath = path.join(DataStorage.tmpDir, `mcp-frame-${crypto.randomBytes(4).toString('hex')}.jpg`);
    try {
        const ffmpegArgs = [
            '-hide_banner', '-loglevel', 'error',
            ...inputArgs,
            '-frames:v', '1', '-f', 'image2', '-y', outPath,
        ];
        let { code, stderr } = await runFfmpeg(ffmpegArgs);
        if (code !== 0 || !fs.existsSync(outPath)) {
            // One retry after a beat: first-open flakiness on USB cameras is
            // real and transient; a different device is never substituted.
            await new Promise((resolve) => {
                setTimeout(resolve, 1200);
            });
            ({ code, stderr } = await runFfmpeg(ffmpegArgs));
        }
        if (code !== 0 || !fs.existsSync(outPath)) {
            throw new McpToolError(`ffmpeg capture from "${device}" failed after retry: `
                + `${stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' ')}`);
        }
        config.set('mcpCameraLastGood', String(device));
        const body = await fs.readFile(outPath);
        return {
            frameId: cacheFrame(body),
            imageBase64: body.toString('base64'),
            mimeType: 'image/jpeg',
            provider: FFMPEG_PROVIDER,
            device: String(device),
            capturedAt: Date.now(),
        };
    } finally {
        fs.remove(outPath).catch(() => undefined);
    }
}

export async function captureFrame(): Promise<CapturedFrame> {
    const cameraUrl = config.get('mcpCameraUrl');
    if (cameraUrl) {
        log.debug(`Capturing frame via HTTP snapshot: ${cameraUrl}`);
        return captureViaHttp(String(cameraUrl));
    }
    log.debug(`Capturing frame via ${FFMPEG_PROVIDER}`);
    return captureViaFfmpeg();
}
