import crypto from 'crypto';
import * as fs from 'fs-extra';
import http from 'http';
import path from 'path';

import DataStorage from '../../DataStorage';
import logger from '../../lib/logger';
import { GcodeValidationReport } from './validator';

const log = logger('service:mcp:jobs');

// A submitted job may only start after a human approves it in a browser.
// The approval page mints the confirm token and shows it to the human;
// the token is never returned over MCP, so a model driving the MCP surface
// cannot self-authorise motion. (A process with arbitrary local HTTP access
// is outside this trust boundary - it could drive Luban's own APIs anyway.)
const CONFIRM_TOKEN_TTL_MS = 15 * 60 * 1000;
const JOB_RETENTION_LIMIT = 50;

export type McpJobState =
    | 'awaiting_confirmation'
    | 'approved'
    | 'rejected'
    | 'starting'
    | 'started'
    | 'start_failed'
    | 'stopped'
    | 'completed';

/**
 * 'file' runs through prepare_print/start_print (door interlock applies, and
 * the machine interpreter returns to Z top at the job's finish position on
 * completion - XY holds, Z does not; operator-clarified 2026-09-02). 'direct'
 * executes over execute_code on approval - it persists position but is NOT
 * subject to the door interlock, so the confirm page says so and the operator
 * supervises.
 * 'procedure' is a server-driven measurement routine (e.g. the tool setter):
 * the operator approves a motion ENVELOPE and the runner steps within it
 * against live sensor feedback - also on the direct path, not interlocked.
 */
export type McpJobKind = 'file' | 'direct' | 'procedure';

export interface JobEvent {
    at: number;
    /** State change ('submitted', 'approved', 'started', 'completed', ...), a runner phase, 'gcode', 'progress'. */
    phase: string;
    /** Which tool/source produced it. */
    tool?: string;
    note?: string;
    [detail: string]: unknown;
}

const MAX_JOB_EVENTS = 400;

export const TERMINAL_JOB_STATES: McpJobState[] = ['rejected', 'start_failed', 'stopped', 'completed'];

export interface McpJob {
    id: string;
    name: string;
    kind: McpJobKind;
    headType: string;
    filePath: string;
    createdAt: number;
    validation: GcodeValidationReport;
    state: McpJobState;
    confirmToken: string | null;
    approvedAt: number | null;
    tokenUsed: boolean;
    startedAt: number | null;
    // Set when the job reaches a terminal state (completed / stopped).
    endedAt: number | null;
    error: string | null;
    // Everything that happened to the job, in order: state changes, the
    // runner's phase announcements, gcode sent/replies while it was the active
    // job, file-job progress. Returned by get_gcode_job_status so an agent
    // never has to read server logs to learn how a job went. Capped.
    events: JobEvent[];
    // Procedure outcome (tool setter / probe results), kept on the record so
    // a client that timed out waiting on start_gcode_job can still read it.
    result: object | null;
    // Batch direct jobs: the operator approved this exact list; each
    // start_gcode_job call executes ONE step, so captures can happen between
    // steps and the series can be abandoned at any point.
    steps?: string[];
    nextStep?: number;
    // Staged default for direct execution: whether start_gcode_job should
    // block until the move verifiably settles (call-time arg overrides).
    waitUntilMoved?: boolean;
    // Procedure jobs: the server-side runner start_gcode_job invokes after
    // the operator's token is consumed. Never serialised or described.
    runner?: () => Promise<object>;
}

function escapeHtml(text: string): string {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function range(r: { min: number; max: number } | null): string {
    return r ? `${r.min} .. ${r.max}` : '-';
}

export class JobManager {
    private activeJob: McpJob | null = null;

    private jobs = new Map<string, McpJob>();

    private jobsDir: string | null = null;

    private ensureJobsDir(): string {
        if (!this.jobsDir) {
            this.jobsDir = path.join(DataStorage.tmpDir, 'mcp-jobs');
            fs.ensureDirSync(this.jobsDir);
        }
        return this.jobsDir;
    }

    public submit(gcode: string, name: string, headType: string, validation: GcodeValidationReport, kind: McpJobKind = 'file', steps?: string[]): McpJob {
        const id = crypto.randomBytes(6).toString('hex');
        const safeName = (name || 'job').replace(/[^\w.-]/g, '_').slice(0, 64);
        const filePath = path.join(this.ensureJobsDir(), `${id}_${safeName}.nc`);
        fs.writeFileSync(filePath, gcode, 'utf8');

        const job: McpJob = {
            id,
            name: safeName,
            kind,
            headType,
            filePath,
            createdAt: Date.now(),
            validation,
            state: 'awaiting_confirmation',
            confirmToken: null,
            approvedAt: null,
            tokenUsed: false,
            startedAt: null,
            endedAt: null,
            error: null,
            events: [],
            result: null,
            steps,
            nextStep: steps ? 0 : undefined,
        };
        this.jobs.set(id, job);
        this.prune();
        this.appendEvent(job, 'submitted', { note: `${kind} job staged, awaiting human confirmation` });
        log.info(`MCP job submitted: ${id} (${safeName}), awaiting human confirmation`);
        return job;
    }

    /** Record something that happened to a job (state change, phase, gcode, progress). */
    public appendEvent(job: McpJob, phase: string, detail: { [key: string]: unknown } = {}): void {
        job.events.push({ at: Date.now(), phase, ...detail });
        if (job.events.length > MAX_JOB_EVENTS) {
            // Keep the head (submission/approval/start) and the most recent tail.
            job.events.splice(20, job.events.length - MAX_JOB_EVENTS);
        }
    }

    /**
     * The job currently driving the machine (a procedure runner, a direct
     * step, a running file job). Activity broadcast while it is active is
     * attached to its event log - see recordActivity.
     */
    public setActive(job: McpJob | null): void {
        this.activeJob = job;
    }

    public getActive(): McpJob | null {
        return this.activeJob;
    }

    /**
     * Hook for mcpBroadcast: phase-style tool activity (runner announcements,
     * probe feed readings/alarms) and gcode traffic land on the active job's
     * event log. Tool-call summaries (ok/duration) are not job events.
     */
    public recordActivity(eventName: string, options?: object): void {
        const job = this.activeJob;
        if (!job || !options) {
            return;
        }
        const payload = options as { [key: string]: unknown };
        if (eventName === 'mcp:activity' && payload.phase !== undefined) {
            const { phase, ...rest } = payload;
            this.appendEvent(job, String(phase), rest);
        } else if (eventName === 'mcp:gcode') {
            const gcode = payload.gcode !== undefined ? String(payload.gcode).slice(0, 300) : undefined;
            const response = payload.response !== undefined ? String(payload.response).slice(0, 300) : undefined;
            this.appendEvent(job, 'gcode', { tool: payload.tool, gcode, response });
        }
    }

    public isTerminal(job: McpJob): boolean {
        return TERMINAL_JOB_STATES.includes(job.state);
    }

    public get(id: string): McpJob | null {
        return this.jobs.get(id) || null;
    }

    /**
     * Verify a human-supplied confirm token for a job. Single-use, expiring.
     */
    public consumeToken(job: McpJob, token: string): { ok: boolean; reason?: string } {
        // A batch direct job mid-series reads 'started' with steps remaining
        // and its token re-armed; the operator's one approval covers the
        // exact list, so the same code keeps working (bug found live
        // 2026-09-02: step 2 of a 9-step ladder was refused).
        const batchMidSeries = job.state === 'started'
            && Array.isArray(job.steps)
            && (job.nextStep || 0) < job.steps.length
            && !job.tokenUsed;
        if ((job.state !== 'approved' && !batchMidSeries) || !job.confirmToken) {
            return { ok: false, reason: `Job is ${job.state}, not approved.` };
        }
        if (job.tokenUsed) {
            return { ok: false, reason: 'Confirm token already used.' };
        }
        if (Date.now() - (job.approvedAt || 0) > CONFIRM_TOKEN_TTL_MS) {
            return { ok: false, reason: 'Confirm token expired; ask the operator to approve again.' };
        }
        const expected = Buffer.from(job.confirmToken, 'utf8');
        const given = Buffer.from(String(token || ''), 'utf8');
        if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
            return { ok: false, reason: 'Confirm token does not match.' };
        }
        job.tokenUsed = true;
        return { ok: true };
    }

    /**
     * Public view of a job - everything except the confirm token.
     */
    public describe(job: McpJob): object {
        return {
            id: job.id,
            name: job.name,
            kind: job.kind,
            headType: job.headType,
            state: job.state,
            createdAt: job.createdAt,
            approvedAt: job.approvedAt,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
            error: job.error,
            terminal: this.isTerminal(job),
            result: job.result,
            eventCount: job.events.length,
            lastEvent: job.events.length ? job.events[job.events.length - 1] : null,
            totalSteps: job.steps ? job.steps.length : undefined,
            nextStep: job.steps ? job.nextStep : undefined,
            validation: job.validation,
        };
    }

    private prune(): void {
        if (this.jobs.size <= JOB_RETENTION_LIMIT) {
            return;
        }
        const oldest = [...this.jobs.values()]
            .filter((job) => job.state !== 'started' && job.state !== 'starting')
            .sort((a, b) => a.createdAt - b.createdAt);
        for (const job of oldest.slice(0, this.jobs.size - JOB_RETENTION_LIMIT)) {
            this.jobs.delete(job.id);
            fs.remove(job.filePath).catch(() => undefined);
        }
    }

    // ============ human confirmation pages (loopback browser) ============

    /**
     * Routes /confirm/<id> (GET review page, POST approve/reject).
     * Loopback and Origin checks are done by the caller.
     */
    public handleConfirmRequest(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
        const match = pathname.match(/^\/confirm\/([0-9a-f]+)(\/(approve|reject))?$/);
        if (!match) {
            this.page(res, 404, '<p>Not found.</p>');
            return;
        }
        const job = this.jobs.get(match[1]);
        if (!job) {
            this.page(res, 404, '<p>Unknown or expired job.</p>');
            return;
        }
        const action = match[3];

        if (req.method === 'GET' && !action) {
            // Revisiting an approved job re-shows its code while it is still
            // valid (unused, unexpired) - losing the tab must not dead-end
            // the approval (operator request 2026-09-02). MCP still never
            // sees the code; this is the loopback browser only.
            if (job.state === 'approved' && job.confirmToken && !job.tokenUsed
                && Date.now() - (job.approvedAt || 0) <= CONFIRM_TOKEN_TTL_MS) {
                this.page(res, 200, this.approvedPage(job));
                return;
            }
            this.page(res, 200, this.reviewPage(job));
            return;
        }
        if (req.method === 'POST' && action === 'approve') {
            if (job.state !== 'awaiting_confirmation') {
                this.page(res, 409, `<p>Job is ${escapeHtml(job.state)}; nothing to approve.</p>`);
                return;
            }
            job.confirmToken = crypto.randomBytes(4).toString('hex');
            job.approvedAt = Date.now();
            job.state = 'approved';
            this.appendEvent(job, 'approved', { note: 'operator approved on the confirm page' });
            log.info(`MCP job ${job.id} approved by operator`);
            this.page(res, 200, this.approvedPage(job));
            return;
        }
        if (req.method === 'POST' && action === 'reject') {
            job.state = 'rejected';
            job.confirmToken = null;
            this.appendEvent(job, 'rejected', { note: 'operator rejected on the confirm page' });
            log.info(`MCP job ${job.id} rejected by operator`);
            this.page(res, 200, '<h2>Rejected</h2><p>The job will not run.</p>');
            return;
        }
        res.writeHead(405, { Allow: 'GET, POST' });
        res.end();
    }

    /**
     * The gcode is shown AGAIN next to the code (operator request after the
     * 2026-09-01 probe crash): the last thing seen before handing over the
     * code is exactly what the code will run. Re-rendered on GET while the
     * code is still valid, so a lost tab does not dead-end the approval.
     */
    private approvedPage(job: McpJob): string {
        const approvedGcode = fs.readFileSync(job.filePath, 'utf8');
        const approvedLines = approvedGcode.split(/\r?\n/);
        const approvedPreview = approvedLines.length > 80
            ? [...approvedLines.slice(0, 40), `... ${approvedLines.length - 80} lines elided ...`, ...approvedLines.slice(-40)].join('\n')
            : approvedGcode;
        return `
            <h2>Approved</h2>
            <p>Give this one-time code to the agent to start <strong>${escapeHtml(job.name)}</strong>:</p>
            <p style="font-size:2em;font-family:monospace;letter-spacing:0.2em">${job.confirmToken}</p>
            <p>It expires 15 minutes after approval and works once
               (a batch of moves: once per approved step).</p>
            <h3>This code will run exactly:</h3>
            <pre style="background:#f6f6f6;padding:12px;overflow:auto;max-height:300px">${escapeHtml(approvedPreview)}</pre>`;
    }

    private reviewPage(job: McpJob): string {
        const v = job.validation;
        const gcodeText = fs.readFileSync(job.filePath, 'utf8');
        const lines = gcodeText.split(/\r?\n/);
        const preview = lines.length > 80
            ? [...lines.slice(0, 40), `... ${lines.length - 80} lines elided ...`, ...lines.slice(-40)].join('\n')
            : gcodeText;

        const warnings = v.warnings.length
            ? `<ul>${v.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
            : '<p>None.</p>';

        let directBanner = '';
        if (job.kind === 'direct') {
            directBanner = `<p style="background:#fff3cd;border:1px solid #b8860b;padding:10px">
                   <strong>DIRECT MOVE</strong>: on start this executes over the realtime path so the
                   position <em>persists</em> - but it does NOT run as a job, so the enclosure door
                   interlock does not apply. Supervise it.</p>`;
        } else if (job.kind === 'procedure') {
            directBanner = `<p style="background:#fff3cd;border:1px solid #b8860b;padding:10px">
                   <strong>SERVER-DRIVEN PROCEDURE</strong>: on start the server steps the machine
                   within the envelope below, gated by live probe-sensor feedback - it stops early on
                   contact and can never exceed the extents shown. It runs on the realtime path, so
                   the enclosure door interlock does NOT apply, and the overtravel tripwire must be
                   armed. Supervise it.</p>`;
        }

        return `
            <h2>Confirm ${{ direct: 'DIRECT move', procedure: 'SERVER-DRIVEN procedure', file: 'G-code job' }[job.kind]}: ${escapeHtml(job.name)}</h2>
            <p>Submitted by an agent over MCP. Review before approving - approval mints a
               one-time code the agent needs to start it.</p>
            ${directBanner}
            <table border="1" cellpadding="6" style="border-collapse:collapse">
                <tr><td>Head</td><td>${escapeHtml(job.headType)}</td></tr>
                <tr><td>Lines / motion lines</td><td>${v.lineCount} / ${v.motionLineCount}</td></tr>
                <tr><td>X extents</td><td>${range(v.extents.x)}</td></tr>
                <tr><td>Y extents</td><td>${range(v.extents.y)}</td></tr>
                <tr><td>Z extents</td><td>${range(v.extents.z)}</td></tr>
                <tr><td>B extents</td><td>${range(v.extents.b)}</td></tr>
                <tr><td>Feed rates</td><td>${range(v.feedRates)}</td></tr>
                <tr><td>Spindle</td><td>on x${v.spindle.onCommands}, off x${v.spindle.offCommands}, max S ${v.spindle.maxS === null ? '-' : v.spindle.maxS}</td></tr>
                <tr><td>Min Z with spindle on</td><td>${v.minZWithSpindleOn === null ? '-' : v.minZWithSpindleOn}</td></tr>
            </table>
            <h3>Warnings</h3>
            ${warnings}
            <form method="post" action="/confirm/${job.id}/approve" style="display:inline">
                <button type="submit" style="font-size:1.2em;padding:8px 24px">Approve</button>
            </form>
            <form method="post" action="/confirm/${job.id}/reject" style="display:inline;margin-left:16px">
                <button type="submit" style="font-size:1.2em;padding:8px 24px">Reject</button>
            </form>
            <h3>G-code${lines.length > 80 ? ' (first and last 40 lines)' : ''}</h3>
            <pre style="background:#f6f6f6;padding:12px;overflow:auto;max-height:400px">${escapeHtml(preview)}</pre>`;
    }

    private page(res: http.ServerResponse, status: number, body: string): void {
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Luban MCP job confirmation</title></head>
            <body style="font-family:sans-serif;max-width:720px;margin:40px auto">${body}</body></html>`;
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    }
}

export const jobManager = new JobManager();
