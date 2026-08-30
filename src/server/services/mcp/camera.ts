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
//   - ffmpeg DirectShow: mcpFfmpegPath (or ffmpeg on PATH) reading the
//     device named by mcpCameraDevice
const CAPTURE_TIMEOUT_MS = 15000;

export interface CapturedFrame {
    imageBase64: string;
    mimeType: string;
    provider: string;
    device: string | null;
    capturedAt: number;
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

export async function listCameras(): Promise<{ provider: string; devices: string[]; note?: string }> {
    const cameraUrl = config.get('mcpCameraUrl');
    if (cameraUrl) {
        return { provider: 'http', devices: [String(cameraUrl)], note: 'mcpCameraUrl is set; it takes precedence.' };
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
    let device = config.get('mcpCameraDevice');
    if (!device) {
        const { devices } = await listCameras();
        if (!devices.length) {
            throw new McpToolError('No DirectShow video devices found. Set configstore key mcpCameraDevice, '
                + 'or mcpCameraUrl for an HTTP snapshot source.');
        }
        device = devices[0];
    }

    const outPath = path.join(DataStorage.tmpDir, `mcp-frame-${crypto.randomBytes(4).toString('hex')}.jpg`);
    try {
        const { code, stderr } = await runFfmpeg([
            '-hide_banner', '-loglevel', 'error',
            '-f', 'dshow', '-i', `video=${device}`,
            '-frames:v', '1', '-f', 'image2', '-y', outPath,
        ]);
        if (code !== 0 || !fs.existsSync(outPath)) {
            throw new McpToolError(`ffmpeg capture failed: ${stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' ')}`);
        }
        const body = await fs.readFile(outPath);
        return {
            imageBase64: body.toString('base64'),
            mimeType: 'image/jpeg',
            provider: 'ffmpeg-dshow',
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
    log.debug('Capturing frame via ffmpeg dshow');
    return captureViaFfmpeg();
}
