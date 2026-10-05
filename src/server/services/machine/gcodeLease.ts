// Exclusive gcode lease for a run that changes controller modal state across
// several requests (the USB pendant's queued G53 window). While it is held,
// every command from anyone else is refused at the channel and at the
// ConnectionManager entry points, so nothing can land between the run's G53
// and its closing G54 and be read in the wrong frame. A UI "go to work
// origin" (G0 X0 Y0, G0 Z0) inside that window would be a machine-frame
// plunge, and a UI G54/G91/G92 would shift the run's next G1.
//
// The holder's own commands are recognised by async context (runAs), so no
// channel signature changes. The lease expires after its TTL if the holder
// never renews or releases it, so a stuck holder cannot lock the machine out
// for ever. The holder keeps its own frame-uncertainty latch for that case
// (positionOfRecord.ts).
import { AsyncLocalStorage } from 'async_hooks';

interface Holder {
    id: number;
    owner: string;
    acquiredAt: number;
    expiresAt: number;
}

export class GcodeLease {
    private holder: Holder | null = null;

    private nextId = 1;

    private context = new AsyncLocalStorage<number>();

    private refused = 0;

    private lastRefusal: { at: number; what: string } | null = null;

    private expired = 0;

    private current(now: number): Holder | null {
        if (this.holder && now >= this.holder.expiresAt) {
            this.expired += 1;
            this.holder = null;
        }
        return this.holder;
    }

    /** Take the lease. Throws when someone else holds an unexpired one. */
    public acquire(owner: string, ttlMs: number, now: number = Date.now()): number {
        const held = this.current(now);
        if (held) {
            throw new Error(`Machine commands are reserved by ${held.owner}.`);
        }
        const id = this.nextId;
        this.nextId += 1;
        this.holder = { id, owner, acquiredAt: now, expiresAt: now + ttlMs };
        return id;
    }

    /** Extend the holder's lease; false when it is no longer held by `id`. */
    public renew(id: number, ttlMs: number, now: number = Date.now()): boolean {
        const held = this.current(now);
        if (!held || held.id !== id) { return false; }
        held.expiresAt = now + ttlMs;
        return true;
    }

    public release(id: number): void {
        if (this.holder && this.holder.id === id) { this.holder = null; }
    }

    /** Run `fn` as the holder `id`: its commands (and their awaits) are admitted. */
    public async runAs<T>(id: number, fn: () => Promise<T>): Promise<T> {
        return this.context.run(id, fn);
    }

    /** null when this caller may command the machine, else the refusal text. */
    public refusal(what: string, now: number = Date.now()): string | null {
        const held = this.current(now);
        if (!held || this.context.getStore() === held.id) { return null; }
        this.refused += 1;
        this.lastRefusal = { at: now, what: what.slice(0, 80) };
        return `Refused "${what.slice(0, 80)}": machine commands are reserved by ${held.owner} until it restores the work frame. `
            + 'Stop or release the pendant first.';
    }

    public status(now: number = Date.now()) {
        const held = this.current(now);
        return { held: held ? { owner: held.owner, ageMs: now - held.acquiredAt, expiresInMs: held.expiresAt - now } : null,
            refused: this.refused,
            lastRefusal: this.lastRefusal,
            expired: this.expired };
    }
}

export const gcodeLease = new GcodeLease();
