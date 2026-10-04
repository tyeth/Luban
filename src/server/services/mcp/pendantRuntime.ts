import crypto from 'crypto';
import http from 'http';
import { SerialPort } from 'serialport';

import logger from '../../lib/logger';
import { connectionManager } from '../machine/ConnectionManager';
import { clearanceOptions } from './clearanceContext';
import { jobManager } from './jobs';
import { landmarkStore } from './landmarks';
import { requiredToolheadZ } from './landmarkClearance';
import { manualControlGate } from './manualControl';
import { isLoopback } from './McpServer';
import { JogBounds, JogPosition, PendantSession, parsePendantInput, validateJogBounds } from './pendant';
import { pendantPage } from './pendantPage';
import { currentGcodeSequence, getPositionOfRecord } from './positionOfRecord';
import { probeFeedService } from './probeFeed';
import { assertMachineReadyForProcedure, moveMachineSettled } from './probing';
import { connectionEpoch, getMachineSizeByIdentifier, getPositionSnapshot, requirePlanningTravel, safeTraverseZ } from './tools/machine';

const log = logger('service:mcp:pendant');

export class PendantRuntime {
    private session = new PendantSession();

    private port: SerialPort | null = null;

    private buffer = '';

    private busy = false;

    private owned = false;

    private opening = false;

    private pageAliveAt = 0;

    private timer: ReturnType<typeof setInterval> | null = null;

    private error: string | null = null;

    private token = crypto.randomBytes(32).toString('hex');

    private epoch: number | null = null;

    private position(): JogPosition {
        const p = getPositionSnapshot();
        if (!p.machine || !['x', 'y', 'z'].every((a) => Number.isFinite(p.machine[a as keyof JogPosition]))) {
            throw new Error('Complete, reliable machine XYZ is required.');
        }
        return p.machine as JogPosition;
    }

    private machineEpoch(): number | null {
        return connectionEpoch();
    }

    private ready(): void {
        assertMachineReadyForProcedure();
        probeFeedService.assertNoOvertravel();
        if (getPositionSnapshot().warnings.length) { throw new Error('Machine position has unresolved warnings.'); }
        const record = getPositionOfRecord(currentGcodeSequence());
        if (record && record.source === 'estimated') { throw new Error('Last move was only estimated; wait for a verified position.'); }
        if (jobManager.getActive()?.state === 'started') { throw new Error('A machine job is active.'); }
    }

    private travelBounds(): JogBounds {
        const travel = requirePlanningTravel('manual jogging', this.position());
        if (travel.conflicts.length) { throw new Error('Machine travel has unresolved conflicts.'); }
        const size = getMachineSizeByIdentifier(connectionManager.getConnectionStatus().machineIdentifier);
        if (!size) { throw new Error('Machine travel is unknown.'); }
        // Match stagingFrameContext: A350 profile Z325 excludes its reachable Z328 park.
        return { ...travel.limits, zMin: 0, zMax: Math.max(size.z, safeTraverseZ()) };
    }

    private reviewedBounds(requested: JogBounds): JogBounds {
        validateJogBounds(requested, this.position());
        const travel = this.travelBounds();
        const bounds = { ...requested };
        for (const axis of ['x', 'y', 'z'] as const) {
            bounds[`${axis}Min`] = Math.max(requested[`${axis}Min`], travel[`${axis}Min`]);
            bounds[`${axis}Max`] = Math.min(requested[`${axis}Max`], travel[`${axis}Max`]);
        }
        this.validateEnvelope(bounds);
        return bounds;
    }

    private validateEnvelope(bounds: JogBounds): void {
        const current = this.position();
        validateJogBounds(bounds, current);
        const travel = this.travelBounds();
        for (const axis of ['x', 'y', 'z'] as const) {
            if (bounds[`${axis}Min`] < travel[`${axis}Min`] || bounds[`${axis}Max`] > travel[`${axis}Max`]) {
                throw new Error(`Machine ${axis.toUpperCase()} bounds must stay within ${travel[`${axis}Min`]}..${travel[`${axis}Max`]} mm.`);
            }
        }
        // Conservative: forbid the entire envelope if any XY corridor crosses a known obstacle at its lowest Z.
        const opts = clearanceOptions();
        const hits = landmarkStore.obstacleBoxes().filter((box) => {
            const overlap = bounds.xMax >= box.machine.x0 - 5 && bounds.xMin <= box.machine.x1 + 5
                && bounds.yMax >= box.machine.y0 - 5 && bounds.yMin <= box.machine.y1 + 5;
            const required = requiredToolheadZ(box.clearanceZ, box.clearanceBasis || 'toolhead',
                opts.toolProtrusionMm, opts.clearanceMarginMm);
            return overlap && (required === null || bounds.zMin < required - 0.05);
        });
        if (hits.length) { throw new Error(`Reviewed envelope intersects known obstacles below their clearances: ${hits.map((box) => box.name).join(', ')}. Narrow the envelope or raise its minimum Z.`); }
    }

    private release(): void {
        if (this.owned && !this.busy && !this.session.armed) {
            manualControlGate.release();
            this.owned = false;
        }
    }

    public disarm(reason = 'Disarmed by operator.'): void {
        if (this.session.armed || this.error !== reason) { log.info(`Disarmed: ${reason}`); }
        this.session.disarm();
        this.error = reason;
        this.release();
    }

    private async ports() {
        return (await SerialPort.list()).filter((p) => p.vendorId?.toLowerCase() === '239a'
            && p.productId?.toLowerCase() === '8124');
    }

    private async connect(path: string): Promise<void> {
        if (this.busy || this.opening) { throw new Error('Wait for the current connection or jog to finish.'); }
        this.opening = true;
        try {
            const ports = await this.ports();
            if (!ports.some((p) => p.path === path)) { throw new Error('Select the Feather USB data port.'); }
            this.shutdown();
            this.session.reset();
            const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
            this.port = port;
            port.on('error', (err: Error) => { if (port === this.port) { this.disarm(err.message); } });
            port.on('close', () => { if (port === this.port) { this.disarm('USB disconnected; reconnect and re-arm.'); } });
            port.on('data', (data: Buffer) => {
                if (port !== this.port) { return; }
                this.buffer += data.toString('utf8');
                if (this.buffer.length > 4096) { this.buffer = ''; this.disarm('USB receive buffer overflow.'); return; }
                const lines = this.buffer.split('\n');
                this.buffer = lines.pop() || '';
                try {
                    for (const line of lines) {
                        if (line.trim()) {
                            const input = parsePendantInput(line);
                            this.session.receive(input, Date.now());
                            if (input.stop) { this.disarm('Stopped with Feather D2.'); }
                        }
                    }
                } catch (err) { this.disarm((err as Error).message); }
            });
            await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
            this.error = 'Connected. Centre all axes before arming.';
            log.info(`USB connected: ${path}`);
            this.timer = setInterval(() => { this.tick().catch((err: Error) => this.disarm(err.message)); }, 100);
        } finally { this.opening = false; }
    }

    private dro(): object {
        try {
            const p = getPositionSnapshot();
            const record = getPositionOfRecord(currentGcodeSequence());
            return { machine: p.machine,
                work: p.work,
                reliability: record?.source === 'estimated' ? 'estimated' : p.reliability,
                age_ms: p.reportAgeMs,
                warnings: p.warnings };
        } catch (err) {
            return { machine: null, work: null, reliability: 'disconnected', age_ms: null, warnings: [(err as Error).message] };
        }
    }

    private async tick(): Promise<void> {
        const now = Date.now();
        if (this.session.armed && (now - this.pageAliveAt > 2000 || now - this.session.receivedAt > 300
            || now >= this.session.expiresAt || this.machineEpoch() !== this.epoch)) {
            this.disarm('Session, browser, USB input or machine connection expired. Re-arm at centre.');
        }
        if (this.port?.isOpen && this.port.writableLength < 1024) {
            this.port.write(`${JSON.stringify({ v: 1,
                type: 'dro',
                armed: this.session.armed,
                neutral: this.session.neutral,
                ...this.dro(),
                message: this.error })}\n`, (err) => {
                if (err) { this.disarm(err.message); }
            });
        }
        this.release();
        if (this.busy || !this.session.armed) { return; }
        this.ready();
        const from = this.position();
        const target = this.session.target(from, now);
        if (!target) { this.release(); return; }
        this.validateEnvelope(this.session.bounds as JogBounds);
        this.busy = true;
        try {
            await moveMachineSettled('usb_pendant', target.position, target.feed);
        } finally {
            this.busy = false;
            this.release();
        }
    }

    public shutdown(): void {
        this.disarm('USB pendant closed.');
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        const port = this.port;
        this.port = null;
        this.buffer = '';
        if (port?.isOpen) { port.close(); }
    }

    private defaultBounds(): JogBounds | null {
        try {
            const p = this.position();
            const travel = this.travelBounds();
            return { xMin: Math.max(travel.xMin, p.x - 5),
                xMax: Math.min(travel.xMax, p.x + 5),
                yMin: Math.max(travel.yMin, p.y - 5),
                yMax: Math.min(travel.yMax, p.y + 5),
                zMin: 280,
                zMax: 329 };
        } catch (err) { return null; }
    }

    public async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
        const reply = (status: number, body: object) => {
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
        };
        // Manual authority stays loopback-only even if the MCP listener permits LAN clients.
        const host = req.headers.host || '';
        if (!isLoopback(req.socket.remoteAddress) || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
            || (req.headers.origin && new URL(req.headers.origin).host !== host)) {
            reply(403, { error: 'USB manual control is local and same-origin only.' }); return;
        }
        if (req.method === 'GET' && url.pathname === '/pendant') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Frame-Options': 'DENY',
                'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
            res.end(pendantPage(this.token)); return;
        }
        if (req.method === 'GET' && url.pathname === '/pendant/status') {
            let travelBounds: JogBounds | null = null;
            try { travelBounds = this.travelBounds(); } catch (err) { /* Unknown travel is shown explicitly. */ }
            reply(200, { armed: this.session.armed,
                neutral: this.session.neutral,
                busy: this.busy,
                port: this.port?.path || null,
                input: this.session.latest,
                error: this.error,
                dro: this.dro(),
                bounds: this.session.bounds,
                defaultBounds: this.defaultBounds(),
                travelBounds,
                ports: await this.ports() }); return;
        }
        if (req.method !== 'POST' || req.headers['x-pendant-token'] !== this.token) {
            reply(403, { error: 'Use the local operator page.' }); return;
        }
        let body = '';
        for await (const chunk of req) {
            body += chunk.toString();
            if (body.length > 4096) { reply(413, { error: 'Request too large.' }); return; }
        }
        try {
            const args = JSON.parse(body || '{}');
            switch (url.pathname) {
                case '/pendant/connect':
                    await this.connect(String(args.path || '')); break;
                case '/pendant/arm': {
                    if (!this.port?.isOpen || this.busy || Date.now() - this.session.receivedAt > 300) {
                        throw new Error('No recent USB input, or a jog is still settling.');
                    }
                    if (args.clearanceConfirmed !== true) { throw new Error('Review and confirm the entire envelope.'); }
                    this.ready();
                    const bounds = this.reviewedBounds(args.bounds);
                    manualControlGate.acquire(() => this.disarm('Stopped through MCP.'));
                    this.owned = true;
                    this.session.arm(bounds, this.position(), Date.now());
                    this.epoch = this.machineEpoch();
                    this.pageAliveAt = Date.now();
                    this.error = null;
                    log.info(`Armed reviewed envelope: ${JSON.stringify(bounds)}`);
                    break;
                }
                case '/pendant/disarm': this.disarm(); break;
                case '/pendant/keepalive': this.pageAliveAt = Date.now(); break;
                default: reply(404, { error: 'Unknown pendant action.' }); return;
            }
            reply(200, { ok: true });
        } catch (err) {
            const message = `${url.pathname.split('/').pop()} refused: ${(err as Error).message}`;
            this.disarm(message);
            log.warn(message);
            reply(400, { error: message });
        }
    }
}

export const pendantRuntime = new PendantRuntime();
