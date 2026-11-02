/** Provenance for the text channel's optimistic UI fields. Never changes their values. */
export interface SerialToolheadEvidence {
    source: 'text-serial';
    powerSource: 'unknown' | 'command' | 'firmware';
    reportedPower: number | null;
    reportedStatus: boolean | null;
    commandedOn: boolean;
    offAcknowledged: boolean;
}

/**
 * M3/M4's requested power survives M5 in the UI. It can be treated as an idle
 * setpoint only after an isolated M5 ACK, behind executeMcpGcode's M118 fence.
 * Generic ACKs and unsolicited OFF reports cannot prove that a pending M5 ran.
 * Keep firmware readings separately: a command must never erase positive readback.
 */
export class SerialToolheadState {
    public revision = 0;

    private evidence: SerialToolheadEvidence = this.empty();

    private pendingOff = false;

    private empty(): SerialToolheadEvidence {
        return {
            source: 'text-serial',
            powerSource: 'unknown',
            reportedPower: null,
            reportedStatus: null,
            commandedOn: false,
            offAcknowledged: false,
        };
    }

    public reset(): void {
        this.revision++;
        this.evidence = this.empty();
        this.pendingOff = false;
    }

    public invalidate(): void {
        this.revision++;
        this.evidence.offAcknowledged = false;
        this.pendingOff = false;
    }

    public command(cmd: string, setsPower = false): void {
        if (cmd === 'M112') {
            this.invalidate();
        } else if (cmd === 'M3' || cmd === 'M4' || cmd === 'M5') {
            this.invalidate();
            this.pendingOff = cmd === 'M5';
            if (cmd !== 'M5') {
                this.evidence.commandedOn = true;
                if (setsPower) {
                    this.evidence.powerSource = 'command';
                }
            }
        }
    }

    public reportPower(power: number): void {
        this.evidence.powerSource = 'firmware';
        this.evidence.reportedPower = power;
        if (power > 0) {
            this.invalidate();
        }
    }

    public reportStatus(on: boolean): void {
        this.evidence.reportedStatus = on;
        if (on) {
            this.invalidate();
        }
    }

    /** Call only after the entire serialized, fenced transaction containing this ACK succeeds. */
    public acknowledge(line: string, revision: number): void {
        // Deliberately exclude multi-command lines: M5 followed by M3 is not OFF.
        if (/^M0*5\s*(?:;[^\r\n]*)?$/i.test(line.trim()) && this.pendingOff && revision === this.revision) {
            this.evidence.offAcknowledged = true;
            this.evidence.commandedOn = false;
            this.pendingOff = false;
        }
    }

    public snapshot(): SerialToolheadEvidence {
        return { ...this.evidence };
    }
}
