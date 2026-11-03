interface SerialToolheadValues {
    source: 'text-serial';
    powerSource: 'unknown' | 'command' | 'firmware';
    reportedPower: number | null;
    reportedStatus: boolean | null;
    commandedOn: boolean;
    offAcknowledged: boolean;
}

export interface SerialToolheadContext {
    line?: string;
    writeSource?: string | null;
    mcpTransaction?: boolean;
}

export interface SerialToolheadEvent extends SerialToolheadValues, SerialToolheadContext {
    kind: 'command' | 'power-report' | 'status-report' | 'off-acknowledged' | 'invalidated' | 'reset';
    at: number;
    revision: number;
    command?: string;
    reason?: string;
}

/** Provenance for the text channel's optimistic UI fields. Never changes their values. */
export interface SerialToolheadEvidence extends SerialToolheadValues {
    revision: number;
    /** Bounded changes on this controller instance, including connection/reset boundaries. */
    recent: SerialToolheadEvent[];
}

/**
 * M3/M4's requested power survives M5 in the UI. It can be treated as an idle
 * setpoint only after an isolated M5 ACK, behind executeMcpGcode's M118 fence.
 * Generic ACKs and unsolicited OFF reports cannot prove that a pending M5 ran.
 * Keep firmware readings separately: a command must never erase positive readback.
 */
export class SerialToolheadState {
    public revision = 0;

    private evidence: SerialToolheadValues = this.empty();

    private recent: SerialToolheadEvent[] = [];

    private pendingOff = false;

    private onEvent?: (event: SerialToolheadEvent) => void;

    private now: () => number;

    public constructor(onEvent?: (event: SerialToolheadEvent) => void, now: () => number = Date.now) {
        this.onEvent = onEvent;
        this.now = now;
    }

    private record(kind: SerialToolheadEvent['kind'], context: SerialToolheadContext & { command?: string; reason?: string } = {}): void {
        const event = {
            ...this.evidence,
            ...context,
            kind,
            at: this.now(),
            revision: this.revision,
            ...(context.line ? { line: context.line.slice(0, 256) } : {}),
        };
        this.recent.push(event);
        if (this.recent.length > 32) { this.recent.shift(); }
        this.onEvent?.({ ...event });
    }

    private empty(): SerialToolheadValues {
        return {
            source: 'text-serial',
            powerSource: 'unknown',
            reportedPower: null,
            reportedStatus: null,
            commandedOn: false,
            offAcknowledged: false,
        };
    }

    public reset(reason = 'connection-reset'): void {
        this.revision++;
        this.evidence = this.empty();
        this.pendingOff = false;
        this.record('reset', { reason });
    }

    public invalidate(reason = 'uncertain-transaction'): void {
        this.revision++;
        this.evidence.offAcknowledged = false;
        this.pendingOff = false;
        this.record('invalidated', { reason });
    }

    public command(cmd: string, setsPower = false, context: SerialToolheadContext = {}): void {
        if (cmd === 'M112') {
            this.invalidate(cmd);
            this.record('command', { ...context, command: cmd });
        } else if (cmd === 'M3' || cmd === 'M4' || cmd === 'M5') {
            this.invalidate(cmd);
            this.pendingOff = cmd === 'M5';
            if (cmd !== 'M5') {
                this.evidence.commandedOn = true;
                if (setsPower) {
                    this.evidence.powerSource = 'command';
                }
            }
            this.record('command', { ...context, command: cmd });
        }
    }

    public reportPower(power: number, context: SerialToolheadContext = {}): void {
        this.evidence.powerSource = 'firmware';
        this.evidence.reportedPower = power;
        if (power > 0) {
            this.invalidate('positive-firmware-power');
        }
        this.record('power-report', context);
    }

    public reportStatus(on: boolean, context: SerialToolheadContext = {}): void {
        this.evidence.reportedStatus = on;
        if (on) {
            this.invalidate('positive-firmware-status');
        }
        this.record('status-report', context);
    }

    /** Call only after the entire serialized, fenced transaction containing this ACK succeeds. */
    public acknowledge(line: string, revision: number): void {
        // Deliberately exclude multi-command lines: M5 followed by M3 is not OFF.
        if (/^M0*5\s*(?:;[^\r\n]*)?$/i.test(line.trim()) && this.pendingOff && revision === this.revision) {
            this.evidence.offAcknowledged = true;
            this.evidence.commandedOn = false;
            this.pendingOff = false;
            this.record('off-acknowledged', { line });
        }
    }

    public snapshot(): SerialToolheadEvidence {
        return { ...this.evidence, revision: this.revision, recent: this.recent.map(event => ({ ...event })) };
    }
}
