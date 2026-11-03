// Continuous GPIO health and the coarse-only USB probe gate. Pure, no timers
// or hardware: there is deliberately no per-step sensor sampling deadline.
import { ProcedureAbort, isProcedureStopped } from './procedureAbort';
import { marchSegments } from './procedureLimits';

export const PROBE_PROGRESS_MS = 100;
export const PROBE_HEALTH_MAX_MS = 300;
export const PROBE_FAST_MAX_POLL_MS = 50;

export interface ProbeProgress {
    sequence: number;
    sampledAt: number;
    receivedAt: number;
    discontinuities: number;
    pollMs: number;
}

/** Remembers gaps even if the feed recovers before a controller reply arrives. */
export class ProbeProgressTracker {
    private latest: ProbeProgress | null = null;

    private discontinuities = 0;

    public note(sequence: number, sampledAt: number, receivedAt: number, pollMs: number): void {
        const previous = this.latest;
        if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isFinite(sampledAt) || sampledAt <= 0) {
            this.discontinuities++;
            this.latest = null;
            return;
        }
        if (sampledAt > receivedAt + 5 || receivedAt - sampledAt > PROBE_HEALTH_MAX_MS
            || (previous && (sequence !== previous.sequence + 1 || sampledAt <= previous.sampledAt
                || sampledAt - previous.sampledAt > PROBE_HEALTH_MAX_MS
                || receivedAt - previous.receivedAt > PROBE_HEALTH_MAX_MS))) {
            this.discontinuities++;
        }
        this.latest = { sequence, sampledAt, receivedAt, discontinuities: this.discontinuities, pollMs };
    }

    public snapshot(): ProbeProgress | null {
        return this.latest ? { ...this.latest } : null;
    }
}

export interface ContinuousProbeState {
    generation: number;
    progress: ProbeProgress;
    contactCount: number;
    triggered: boolean;
    value: string;
    receivedAt: number;
}

export function continuousProbeHealthy(state: ContinuousProbeState | null, now: number): state is ContinuousProbeState {
    if (!state) { return false; }
    const p = state.progress;
    return p.pollMs > 0 && p.pollMs <= PROBE_FAST_MAX_POLL_MS
        && p.sampledAt <= now + 5 && p.receivedAt <= now
        && now - p.sampledAt <= PROBE_HEALTH_MAX_MS && now - p.receivedAt <= PROBE_HEALTH_MAX_MS;
}

export class ProbeSynchronizationLost extends ProcedureAbort {
    public readonly probeSynchronizationLost = true;

    public constructor(reason: string) {
        super(`Continuous probe synchronization lost: ${reason}. Holding position; no automatic retreat or contact coordinate.`);
        this.name = 'ProbeSynchronizationLost';
    }
}

export function isProbeSynchronizationLost(err: unknown): err is ProbeSynchronizationLost {
    return !!err && typeof err === 'object' && (err as { probeSynchronizationLost?: unknown }).probeSynchronizationLost === true;
}

export interface ContinuousCoarseIo {
    read(): ContinuousProbeState | null;
    now(): number;
    checkStop(): void;
    /** One physical segment; must reject unless USB completion AND its target position are proven. */
    move(s: number): Promise<void>;
    sensed(contact: boolean): void;
}

/** The counter is only a stop signal. A coarse endpoint is never the measured contact coordinate. */
export class ContinuousCoarseProbe {
    private readonly initial: ContinuousProbeState;

    public constructor(private readonly io: ContinuousCoarseIo, initial: ContinuousProbeState) {
        this.initial = initial;
    }

    public assertSynchronized(): ContinuousProbeState {
        const state = this.io.read();
        if (!continuousProbeHealthy(state, this.io.now())) {
            throw new ProbeSynchronizationLost('continuous GPIO health is missing or stale');
        }
        if (state.generation !== this.initial.generation
            || state.progress.discontinuities !== this.initial.progress.discontinuities
            || state.progress.sequence < this.initial.progress.sequence
            || state.contactCount < this.initial.contactCount) {
            throw new ProbeSynchronizationLost('GPIO generation, sequence or continuity changed');
        }
        return state;
    }

    public async advance(fromS: number, toS: number): Promise<{
        s: number; segments: number; sensed: { contact: boolean; reading: { value: string; receivedAt: number } };
    }> {
        let s = fromS;
        let segments = 0;
        const sense = () => {
            const state = this.assertSynchronized();
            const contact = state.triggered || state.contactCount > this.initial.contactCount;
            this.io.sensed(contact);
            return { contact, reading: { value: state.value, receivedAt: state.receivedAt } };
        };
        let sensed = sense();
        for (const next of marchSegments(fromS, toS)) {
            this.io.checkStop();
            sensed = sense();
            if (sensed.contact) { break; }
            try {
                await this.io.move(next);
            } catch (err) {
                if (isProcedureStopped(err)) { throw err; }
                throw new ProbeSynchronizationLost(err instanceof Error ? err.message : String(err));
            }
            s = next;
            segments++;
            sensed = sense();
            if (sensed.contact) { break; }
        }
        return { s, segments, sensed };
    }
}
