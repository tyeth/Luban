/* eslint-disable camelcase */
// Evidence keys are snake_case: they are serialised straight into tool results.
//
// Modal cleanup after a FAILED tool call (#221).
//
// Why this exists: a failed operation can stop after selecting `G53` (machine
// workspace) or `G91` (relative distance) and before handing the controller
// back its normal `G90`/`G54`. Luban then refuses ordinary jogging, the
// position of record goes incoherent, and - worse - an agent may read a later
// command's coordinate or distance mode wrongly. Every tool call goes through
// ToolRegistry.call(), so that is where the hook runs, still inside the call's
// ownership gate: it reads a per-call "modal ledger" of what was actually sent
// and decides, with stated reasons, whether a no-motion restore is warranted
// and permitted.
//
// What it never does: retry the failed command, send an axis word, turn the
// failure into a success, set or clear the position of record, or talk to a
// connection generation the operation did not start on.
//
// Pure apart from node's async_hooks: no Luban server imports. The runtime
// pieces (send, connection, position) are injected, and unit-tested with fakes
// in tests/failureRecovery.test.ts.
import { AsyncLocalStorage } from 'async_hooks';

import { isProcedureStopped } from './procedureAbort';

/** The explicit no-motion recovery an agent or operator can run afterwards. */
export const MANUAL_RECOVERY = 'restore_work_frame';

/** A work offset smaller than this on every axis makes the work and machine frames indistinguishable. */
export const FRAME_VERIFY_MIN_OFFSET_MM = 0.5;

/** One status-poll period: a beat must arrive at least this long after the cleanup reply to count. */
export const FRAME_VERIFY_MIN_BEAT_DELAY_MS = 2000;

/**
 * Thrown by the injected send when nothing could go out (no channel, or a
 * channel without a direct path): the command is NOT SENT, not indeterminate.
 */
export class NotSentError extends Error {
    public readonly notSent: true = true;

    public constructor(message: string) {
        super(`NOT SENT: ${message}`);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

// Transport failures: the payload may or may not have reached the controller.
// SSTP reports them as "Controller request failed (ECONNRESET|ETIMEDOUT|
// REQUEST_ERROR|transport error): ..."; a plain HTTP status code from the
// controller itself stays a rejection.
const INDETERMINATE_REPLY = new RegExp(
    'ECONN[A-Z]*|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|REQUEST_ERROR|transport[ _]error'
    + '|connection changed during command execution',
    'i',
);

export type Workspace = 'G53' | 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59';
export type DistanceMode = 'G90' | 'G91';
export type ModalWord = Workspace | DistanceMode;

/**
 * accepted: result 0. rejected: the controller refused a line - SSTP runs a
 * batch line by line and stops at the first failure, so the lines before it
 * DID run. indeterminate: transport error / connection changed mid-command -
 * it may or may not have run. not-sent: a queued item cancelled before it
 * reached the controller. pending: no reply yet (still queued or executing).
 */
export type SendOutcome = 'pending' | 'accepted' | 'rejected' | 'indeterminate' | 'not-sent';

/** Classify an executeGcode reply. executeGcode resolves {result 0|-1, text}; it does not reject. */
export function classifyReply(reply: { result: number; text?: string } | null | undefined): SendOutcome {
    if (!reply) {
        return 'indeterminate';
    }
    if (reply.result === 0) {
        return 'accepted';
    }
    const text = String(reply.text || '');
    if (/Cancelled after an earlier command failed|Machine connection ended before command execution/i.test(text)) {
        return 'not-sent';
    }
    if (INDETERMINATE_REPLY.test(text)) {
        return 'indeterminate';
    }
    return 'rejected';
}

export interface LedgerEntry {
    gcode: string;
    modal: ModalWord[];
    /** Connection generation the payload went out on. */
    connection: string;
    outcome: SendOutcome;
}

/**
 * The workspace/distance words in a payload, in order. Comments (`;...` and
 * `(...)`) are ignored; decimal subcodes (`G90.1` arc mode) are not distance
 * modes and are skipped.
 */
export function modalWords(gcode: string): ModalWord[] {
    const words: ModalWord[] = [];
    for (const rawLine of String(gcode).split(/\r?\n/)) {
        const line = rawLine.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '');
        const re = /G0*(\d+)(\.\d+)?/gi;
        let match: RegExpExecArray | null = re.exec(line);
        while (match) {
            const code = Number(match[1]);
            if (!match[2] && ((code >= 53 && code <= 59) || code === 90 || code === 91)) {
                words.push(`G${code}` as ModalWord);
            }
            match = re.exec(line);
        }
    }
    return words;
}

export class ModalLedger {
    public readonly entries: LedgerEntry[] = [];

    public closed = false;

    public readonly tool: string;

    public readonly mutating: boolean;

    /** The connection generation when the call began (null when no machine was connected). */
    public readonly startConnection: string | null;

    public constructor(tool: string, mutating: boolean, startConnection: string | null = null) {
        this.tool = tool;
        this.mutating = mutating;
        this.startConnection = startConnection;
    }

    /** Record a send as it leaves; settle it with the reply. Ignored once closed. */
    public record(connection: string, gcode: string): (outcome: SendOutcome) => void {
        if (this.closed) {
            return () => undefined;
        }
        const entry: LedgerEntry = { gcode, modal: modalWords(gcode), connection, outcome: 'pending' };
        this.entries.push(entry);
        return (outcome: SendOutcome) => {
            entry.outcome = outcome;
        };
    }
}

// Per-call context: sends made anywhere inside a tool handler land on that
// call's ledger without threading it through every procedure. Detached
// runners outlive the call; their later sends hit a CLOSED ledger and are
// ignored (the job they belong to is "another operation" from then on).
const storage = new AsyncLocalStorage<ModalLedger>();
const openLedgers = new Set<ModalLedger>();

export async function runWithLedger<T>(ledger: ModalLedger, fn: () => Promise<T>): Promise<T> {
    openLedgers.add(ledger);
    return storage.run(ledger, fn);
}

/** Close a call's ledger: later (stray) sends are no longer attributed to it. */
export function closeLedger(ledger: ModalLedger): void {
    ledger.closed = true;
    openLedgers.delete(ledger);
}

/** Called by the direct send path for every payload; a no-op outside a tool call. */
export function recordModalSend(connection: string, gcode: string): (outcome: SendOutcome) => void {
    const ledger = storage.getStore();
    return ledger ? ledger.record(connection, gcode) : () => undefined;
}

/** Other mutating tool calls still in progress, excluding `self`. */
export function otherMutatingOperations(self: ModalLedger | null): string[] {
    return [...openLedgers].filter((l) => l !== self && l.mutating).map((l) => l.tool);
}

export interface Exposure {
    /** The call may have left G53, G91, or a mode it cannot account for. */
    exposed: boolean;
    /** Modes at the end of the call, assuming it began in G90/G54; 'unknown' where an unfinished payload carried that word. */
    state: { workspace: Workspace | 'unknown'; distance: DistanceMode | 'unknown' };
    pending_payloads: number;
    connections: string[];
    reasons: string[];
}

/**
 * Could the call have changed workspace or distance mode? Accepted payloads
 * are replayed in order; a rejected, indeterminate or pending payload makes
 * every mode it names unknown (part of it may have run). Not-sent payloads
 * changed nothing. G55-G59 accepted are deliberate selections, not exposure.
 */
export function assessExposure(entries: LedgerEntry[]): Exposure {
    let workspace: Workspace | 'unknown' = 'G54';
    let distance: DistanceMode | 'unknown' = 'G90';
    let pending = 0;
    const reasons: string[] = [];
    for (const entry of entries) {
        if (entry.outcome === 'not-sent') {
            continue;
        }
        if (entry.outcome === 'pending') {
            pending += 1;
        }
        const known = entry.outcome === 'accepted';
        for (const word of entry.modal) {
            if (word === 'G90' || word === 'G91') {
                distance = known ? word : 'unknown';
            } else {
                workspace = known ? word : 'unknown';
            }
        }
        if (!known && entry.modal.length) {
            reasons.push(`a ${entry.outcome} payload carried ${entry.modal.join('/')}: part of it may have run`);
        }
    }
    if (workspace === 'G53' || distance === 'G91') {
        reasons.push(`the last accepted payload left ${workspace === 'G53' ? 'G53' : ''}${workspace === 'G53' && distance === 'G91' ? '/' : ''}`
            + `${distance === 'G91' ? 'G91' : ''} selected`);
    }
    return {
        exposed: workspace === 'G53' || workspace === 'unknown' || distance === 'G91' || distance === 'unknown',
        state: { workspace, distance },
        pending_payloads: pending,
        connections: [...new Set(entries.filter((e) => e.outcome !== 'not-sent').map((e) => e.connection))],
        reasons,
    };
}

/**
 * The commands to send, each its own call (SACP runs a multi-line payload in
 * parallel; SSTP would skip G54 after a failed G90). G54 only when the call
 * ended in G53 or an unknown workspace - a deliberate G55-G59 is left alone.
 */
export function restoreCommands(exposure: Exposure): string[] {
    const commands = ['G90'];
    if (exposure.state.workspace === 'G53' || exposure.state.workspace === 'unknown') {
        commands.push('G54');
    }
    return commands;
}

export type FailureKind = 'thrown' | 'error-result' | 'timeout' | 'stopped';

/**
 * Classify a failure from what the handler threw or returned. A stop, a
 * probe trip or an overtravel is `stopped`: the controller is in a state the
 * operator must look at, so nothing is sent after it.
 */
export function classifyFailure(threw: boolean, thrown: unknown, result: unknown): FailureKind | null {
    if (threw) {
        const err = thrown as { message?: unknown; procedureStopped?: unknown; name?: unknown } | null;
        const message = String(err?.message ?? thrown);
        // isProcedureStopped is the real marker; the words are only a backstop
        // (the authority check in recoverAfterFailure reads the actual latches).
        if (isProcedureStopped(thrown)
            || /stop_gcode_job|stopped|overtravel|CRASH ALARM|UNEXPECTED CONTACT|probe (?:trip|contact)|tripped|cancel/i.test(message)) {
            return 'stopped';
        }
        if (/timed? ?out|timeout/i.test(message)) {
            return 'timeout';
        }
        return 'thrown';
    }
    if (!result || typeof result !== 'object') {
        return null;
    }
    const r = result as { ok?: unknown; error?: unknown; isError?: unknown; cancelled?: unknown; aborted?: unknown };
    if (r.cancelled === true || r.aborted === true) {
        return 'stopped';
    }
    if (r.ok === false || r.isError === true || (typeof r.error === 'string' && r.error.length > 0)) {
        return 'error-result';
    }
    return null;
}

export type SkipReason =
    | 'call-succeeded-with-modal-exposure'
    | 'authority-closed'
    | 'not-applicable'
    | 'nothing-sent'
    | 'no-modal-change'
    | 'stopped-or-tripped'
    | 'disconnected'
    | 'connection-replaced'
    | 'commands-in-flight'
    | 'manual-control-active'
    | 'another-operation-active'
    | 'machine-not-idle';

export interface PositionReading {
    reliability: string;
    frame: string;
    /** Beat time the judged position rests on. */
    reportedAt: number | null;
    originOffset: { x: number; y: number; z: number };
    machineStatus: string | null;
    /**
     * The raw reported position, read AS a machine position, is outside the
     * travel: only then is a work-frame reading the sole possible one.
     */
    rawImpossibleAsMachine: boolean;
}

export interface RecoveryDeps {
    /** Connection generation now; null when no machine is connected. Never throws. */
    connectionId(): string | null;
    send(label: string, gcode: string): Promise<{ result: number; text?: string }>;
    settle(): Promise<void>;
    /** Only called while connected. */
    readPosition(): PositionReading | null;
    reliableForMotion(reliability: string): boolean;
    jobRunning(): boolean;
    manualControl(): boolean;
    /**
     * Why command authority is closed (crash/overtravel latch, unexpected
     * contact, a procedure stop request), or null. Read from the real state,
     * not from the error text; re-checked before every cleanup send.
     */
    authorityClosed(): string | null;
    now(): number;
}

export interface CommandEvidence {
    gcode: string;
    outcome: SendOutcome | 'not-sent';
    reply: string | null;
}

export interface RecoveryEvidence {
    status: 'attempted' | 'skipped' | 'failed';
    failure_kind: FailureKind | 'none';
    /** Set only when the hook itself threw. */
    hook_error?: string;
    tool: string;
    exposure: Exposure;
    skip_reason: SkipReason | null;
    explanation: string;
    commands: CommandEvidence[];
    connection: { at_start: string | null; operation: string[]; at_cleanup: string | null };
    resulting_modes: { workspace: string; distance: string; workspace_verified: boolean; distance_verified: false } | null;
    position: { reliability: string | null; frame: string | null; trustworthy: boolean; note: string };
    recovery_action: string | null;
    warnings: string[];
}

const MODE_WARNING = 'Distance mode cannot be observed in status reports: an accepted G90 is not proof the controller '
    + 'is absolute. Every later program must declare G90 or G91 itself; never infer that relative or machine-coordinate '
    + 'motion is safe from this cleanup or from a heartbeat.';

/** The injected send reported that nothing went out (NotSentError, matched by its message prefix). */
function notSentError(error: string, reply: unknown): boolean {
    return reply === null && /^NOT SENT: /.test(error);
}

function safe<T>(fn: () => T, fallback: T): T {
    try {
        return fn();
    } catch (err) {
        return fallback;
    }
}

/** Why cleanup may not be sent right now; null when it may. Re-checked before EVERY cleanup send. */
function authorityProblem(ledger: ModalLedger, exposure: Exposure, deps: RecoveryDeps): [SkipReason, string] | null {
    const now = safe(() => deps.connectionId(), null);
    if (!now) {
        return ['disconnected', 'The machine is disconnected: command authority closed with the connection.'];
    }
    const foreign = [ledger.startConnection, ...exposure.connections].filter((c) => c !== now);
    if (foreign.length) {
        return ['connection-replaced', `The call started on connection ${ledger.startConnection} and sent on `
            + `${exposure.connections.join(', ')}, but the current connection is ${now}: a reconnected controller has its `
            + 'own state, and cleanup aimed at the old one would land on the new one.'];
    }
    const closed = safe(() => deps.authorityClosed(), 'the safety latch state could not be read');
    if (closed) {
        return ['authority-closed', `Command authority is closed: ${closed}. The operator must inspect the machine first.`];
    }
    if (safe(() => deps.manualControl(), true)) {
        return ['manual-control-active', 'The USB pendant owns manual control.'];
    }
    const others = otherMutatingOperations(ledger);
    const jobRunning = safe(() => deps.jobRunning(), true);
    if (others.length || jobRunning) {
        return ['another-operation-active', `Another operation owns the controller (${[...others, ...(jobRunning ? ['a running job'] : [])]
            .join(', ')}); cleanup would be injected into its command stream.`];
    }
    return null;
}

/**
 * The hook proper. Called once, after the handler has failed and its ledger
 * has been closed, while the call still holds the ownership gate. Never
 * throws: the original failure is what the caller reports; this only adds
 * evidence.
 */
export async function recoverAfterFailure(ledger: ModalLedger, failureKind: FailureKind, deps: RecoveryDeps): Promise<RecoveryEvidence> {
    const exposure = assessExposure(ledger.entries);
    const evidence: RecoveryEvidence = {
        status: 'skipped',
        failure_kind: failureKind,
        tool: ledger.tool,
        exposure,
        skip_reason: null,
        explanation: '',
        commands: [],
        connection: { at_start: ledger.startConnection, operation: exposure.connections, at_cleanup: safe(() => deps.connectionId(), null) },
        resulting_modes: null,
        position: { reliability: null, frame: null, trustworthy: false, note: 'not read' },
        recovery_action: null,
        warnings: [],
    };
    const skip = (reason: SkipReason, explanation: string): RecoveryEvidence => {
        evidence.skip_reason = reason;
        evidence.explanation = explanation;
        if (reason !== 'not-applicable' && reason !== 'nothing-sent' && reason !== 'no-modal-change') {
            evidence.recovery_action = MANUAL_RECOVERY;
            evidence.warnings.push(`Modal cleanup was SKIPPED (${reason}): the controller may still be in `
                + `${exposure.state.workspace}/${exposure.state.distance}. When the controller is idle and owned by you, `
                + `call ${MANUAL_RECOVERY} (no motion) and then get_position before any motion.`, MODE_WARNING);
        }
        return evidence;
    };
    if (!ledger.mutating) {
        return skip('not-applicable', 'Read-only tool.');
    }
    if (!ledger.entries.some((e) => e.outcome !== 'not-sent')) {
        return skip('nothing-sent', 'The call sent nothing to the controller, so its modes are unchanged.');
    }
    if (!exposure.exposed) {
        return skip('no-modal-change', 'Every payload that reached the controller left it in G90 and a work workspace.');
    }
    if (failureKind === 'stopped') {
        return skip('stopped-or-tripped', 'The call ended in a stop, probe trip or overtravel: the controller state needs '
            + 'the operator, so nothing is sent automatically.');
    }
    if (exposure.pending_payloads > 0) {
        return skip('commands-in-flight', `${exposure.pending_payloads} payload(s) never got a reply and may still be `
            + 'queued: a restore sent now could run BEFORE them and be undone by them.');
    }
    const problem = authorityProblem(ledger, exposure, deps);
    if (problem) {
        return skip(problem[0], problem[1]);
    }
    const status = safe(() => deps.readPosition()?.machineStatus ?? null, null);
    if (status !== 'idle') {
        return skip('machine-not-idle', `The heartbeat machine status is ${status === null ? 'unknown' : status}, not idle.`);
    }

    evidence.status = 'attempted';
    evidence.explanation = `Restoring ${restoreCommands(exposure).join(' then ')} as separate commands with no axis words.`;
    const label = `failure-recovery:${ledger.tool}`;
    let ok = true;
    let lastReplyAt = 0;
    for (const gcode of restoreCommands(exposure)) {
        const blocked = ok ? authorityProblem(ledger, exposure, deps) : null;
        if (!ok || blocked) {
            evidence.commands.push({ gcode, outcome: 'not-sent', reply: blocked ? `blocked: ${blocked[0]}` : null });
            ok = false;
            continue;
        }
        let reply: { result: number; text?: string } | null = null;
        let error: string | null = null;
        try {
            // eslint-disable-next-line no-await-in-loop
            reply = await deps.send(label, gcode);
        } catch (err) {
            error = String((err as Error)?.message || err);
        }
        lastReplyAt = safe(() => deps.now(), 0);
        const outcome = error !== null && notSentError(error, reply) ? 'not-sent' : classifyReply(reply);
        evidence.commands.push({ gcode, outcome, reply: error || reply?.text || null });
        ok = outcome === 'accepted';
    }
    if (!ok) {
        evidence.status = 'failed';
        evidence.recovery_action = MANUAL_RECOVERY;
        evidence.warnings.push(`Modal cleanup INCOMPLETE: ${evidence.commands.map((c) => `${c.gcode}=${c.outcome}`).join(', ')}. `
            + `The controller's workspace and distance mode are unknown. Call ${MANUAL_RECOVERY} (no motion) when the `
            + 'controller is idle, then get_position, before any motion.', MODE_WARNING);
        return evidence;
    }

    // Verify the workspace from a status report taken AFTER the cleanup reply,
    // and only where the frames are distinguishable (some work offset beyond
    // 0.5 mm). The distance mode has no status field: never claimed verified.
    // Nothing here sets or clears the position of record.
    await deps.settle().catch(() => undefined);
    const reading = safe(() => deps.connectionId(), null) ? safe(() => deps.readPosition(), null) : null;
    const offset = reading ? Math.max(Math.abs(reading.originOffset.x), Math.abs(reading.originOffset.y), Math.abs(reading.originOffset.z)) : 0;
    const distinguishable = offset > FRAME_VERIFY_MIN_OFFSET_MM;
    // The judge only spots a machine-frame report when raw - offset falls far
    // outside the travel, so frame === 'work-frame' alone is ambiguous: with
    // G53 still active the same beat can read as a plausible work position.
    // Verified needs the OTHER reading to be impossible as well.
    const freshBeat = !!reading && reading.reportedAt !== null && reading.reportedAt >= lastReplyAt + FRAME_VERIFY_MIN_BEAT_DELAY_MS;
    const sentG54 = restoreCommands(exposure).includes('G54');
    const consistent = sentG54 && freshBeat && distinguishable && reading?.frame === 'work-frame';
    const workspaceVerified = consistent && !!reading?.rawImpossibleAsMachine;
    let workspaceText = sentG54 ? 'G54 accepted, workspace unverified' : `${exposure.state.workspace} kept (deliberate selection), not re-verified`;
    if (workspaceVerified) {
        workspaceText = 'G54 (a post-cleanup status report is only possible in the work frame)';
    } else if (consistent) {
        workspaceText = 'G54 accepted, consistent with work frame, unverified (the report would also fit the machine frame)';
    } else if (sentG54 && !distinguishable && reading) {
        workspaceText = 'G54 accepted, workspace unverifiable: the work offset is ~0 so both frames read alike';
    }
    evidence.resulting_modes = {
        workspace: workspaceText,
        distance: 'G90 accepted, distance mode unverified',
        workspace_verified: workspaceVerified,
        distance_verified: false,
    };
    if (reading) {
        // A verified (echoed) position is not invalidated by an ordinary
        // delayed heartbeat; awaiting-resync / stale stay named as such.
        evidence.position = {
            reliability: reading.reliability,
            frame: reading.frame,
            trustworthy: deps.reliableForMotion(reading.reliability) && reading.frame !== 'machine-frame',
            note: freshBeat
                ? 'judged from a status report taken after the cleanup'
                : 'no status report after the cleanup yet: this judgement predates it',
        };
    } else {
        evidence.position.note = 'position could not be read after the cleanup';
    }
    if ((sentG54 && !workspaceVerified) || !evidence.position.trustworthy) {
        evidence.recovery_action = MANUAL_RECOVERY;
        evidence.warnings.push('The cleanup commands were accepted but restoration is NOT verified'
            + `${reading ? ` (position ${reading.reliability}, frame ${reading.frame})` : ''}. Read get_position; if it is `
            + `not coherent, call ${MANUAL_RECOVERY} (no motion) or query_firmware_position.`);
    }
    evidence.warnings.push(MODE_WARNING);
    return evidence;
}

/**
 * A call that SUCCEEDED but left G53, G91 or an unknown mode behind. Nothing
 * is sent (a success is never second-guessed with commands), but the agent is
 * told, because the next relative or machine-frame program would inherit it.
 */
export function exposureAfterSuccess(ledger: ModalLedger): RecoveryEvidence | null {
    if (!ledger.mutating) {
        return null;
    }
    const exposure = assessExposure(ledger.entries);
    if (!exposure.exposed) {
        return null;
    }
    return {
        status: 'skipped',
        failure_kind: 'none',
        tool: ledger.tool,
        exposure,
        skip_reason: 'call-succeeded-with-modal-exposure',
        explanation: 'The call succeeded but its last payloads left a non-default or unknown mode; nothing was sent.',
        commands: [],
        connection: { at_start: ledger.startConnection, operation: exposure.connections, at_cleanup: null },
        resulting_modes: null,
        position: { reliability: null, frame: null, trustworthy: false, note: 'not read' },
        recovery_action: MANUAL_RECOVERY,
        warnings: [`The controller may still be in ${exposure.state.workspace}/${exposure.state.distance} after this call. `
            + `Call ${MANUAL_RECOVERY} (no motion) before ordinary jogging, and declare G90/G91 and the workspace in every `
            + 'later program.', MODE_WARNING],
    };
}

/** Evidence when the hook itself failed: whatever it sent, modes and position are unknown. */
export function hookFailureEvidence(ledger: ModalLedger, failureKind: FailureKind, err: unknown): RecoveryEvidence {
    const exposure = safe(() => assessExposure(ledger.entries), {
        exposed: true,
        state: { workspace: 'unknown', distance: 'unknown' },
        pending_payloads: 0,
        connections: [],
        reasons: ['exposure could not be assessed'],
    } as Exposure);
    return {
        status: 'failed',
        failure_kind: failureKind,
        tool: ledger.tool,
        exposure,
        skip_reason: null,
        explanation: 'The cleanup hook itself failed.',
        hook_error: String((err as Error)?.message || err),
        commands: [],
        connection: { at_start: ledger.startConnection, operation: exposure.connections, at_cleanup: null },
        resulting_modes: null,
        position: { reliability: null, frame: null, trustworthy: false, note: 'unknown: the cleanup hook failed' },
        recovery_action: MANUAL_RECOVERY,
        warnings: ['The modal cleanup hook failed part way: cleanup commands may or may not have been sent. The workspace, '
            + `distance mode and position are UNKNOWN. Call ${MANUAL_RECOVERY} (no motion) when the controller is idle, then `
            + 'get_position, before any motion.', MODE_WARNING],
    };
}

/** True when the evidence is worth showing (a no-op skip is not). */
export function evidenceIsRelevant(evidence: RecoveryEvidence | null): evidence is RecoveryEvidence {
    return !!evidence && !['not-applicable', 'nothing-sent', 'no-modal-change'].includes(String(evidence.skip_reason));
}

/** Appended to a thrown error's text, after the original message, so the evidence reaches the agent. */
export function describeEvidence(evidence: RecoveryEvidence): string {
    return `failure_recovery: ${JSON.stringify(evidence)}`;
}
