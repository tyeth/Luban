/* eslint-disable camelcase */
// Pure rules for the probe_program op list that do not need the machine:
// which kinds exist, what the no-motion `capture` op takes, and where a
// `home` op may sit. probeProgram.ts applies them; the tests exercise them
// without the server (see tests/run.ts for why the split matters).
//
// Why `capture` and `home` are program ops at all (2026-09-21): the operator
// asked for "move over the stock, photo, rotate B to 180, photo, home" as ONE
// approval. Every motion in that request already had a program op or a gated
// tool; the two non-probing steps did not, so the request cost three confirm
// pages. A `capture` is no motion - a position- and B-stamped frame saved on
// the job record - and a `home` is the same G53;G28;G54 the home tool sends,
// allowed only as the LAST op because it moves every axis to its switches
// and homes B: nothing measured after it would relate to what came before.

import { Bounded, CAPTURE_SETTLE_MS, clampTo } from './procedureLimits';

export const PROGRAM_OP_KINDS = ['rotate_b', 'surface_path', 'surface_grid', 'sequence', 'stock_outline', 'wall_follow', 'corner', 'capture', 'home'] as const;
export type ProgramOpKindName = typeof PROGRAM_OP_KINDS[number];

export function isProgramOpKind(kind: unknown): kind is ProgramOpKindName {
    return typeof kind === 'string' && (PROGRAM_OP_KINDS as readonly string[]).includes(kind);
}

/** The kinds a `group` may repeat per angle: anything but `home` (it ends the program) and a nested group. */
export function groupableOpKind(kind: unknown): boolean {
    return isProgramOpKind(kind) && kind !== 'home';
}

export interface CaptureOpArgs {
    /** Damping wait before the frame, ms (CAPTURE_SETTLE_MS). */
    settle_ms: number;
    /** Free text the agent attaches to the frame (what it expects to see). */
    label: string | null;
    /**
     * Where to look FROM: a machine XY the head hops to at the traverse height
     * before the frame (law 2: raise, then XY), checked against travel and
     * every obstacle box exactly like a sequence hop. null = capture where the
     * previous op left the head. A plain hop-only sequence is refused ("pure
     * motion"), so this is the one way a program positions the camera.
     */
    view: { x: number; y: number } | null;
}

/** Normalise a `capture` op's arguments; every other key is refused so a typo cannot pass silently. */
export function captureOpArgs(raw: { [key: string]: unknown }, where: string): CaptureOpArgs {
    const allowed = ['settle_ms', 'label', 'x', 'y'];
    const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
    if (unknown.length) {
        throw new Error(`${where} (capture): unknown argument(s) ${unknown.join(', ')} - a capture takes settle_ms, label and an optional viewing position x/y (machine, hopped to at the traverse height).`);
    }
    const label = raw.label === undefined || raw.label === null ? null : String(raw.label).trim().slice(0, 120) || null;
    const hasX = raw.x !== undefined && raw.x !== null;
    const hasY = raw.y !== undefined && raw.y !== null;
    let view: { x: number; y: number } | null = null;
    if (hasX || hasY) {
        const x = Number(raw.x);
        const y = Number(raw.y);
        if (!hasX || !hasY || !Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`${where} (capture): a viewing position needs BOTH x and y (finite machine coordinates); omit both to capture where the head is.`);
        }
        view = { x, y };
    }
    return { settle_ms: clampTo(raw.settle_ms, CAPTURE_SETTLE_MS as Bounded), label, view };
}

/**
 * A `home` op must be the last op of the program: after G28 every axis is at
 * its switch and B is 0, so no later op could reference anything measured
 * before it, and a rotation schedule the page enumerated would be silently
 * undone half way. Returns the refusal text, or null when the order is fine.
 */
export function homeOrderError(kinds: string[]): string | null {
    const first = kinds.indexOf('home');
    if (first === -1) {
        return null;
    }
    if (first !== kinds.length - 1) {
        return `ops[${first}] (home): a home op must be the LAST op of the program - it drives every axis to its switches and homes B, `
            + `so nothing after it relates to what came before (${kinds.length - 1 - first} op(s) follow it).`;
    }
    return null;
}

/** Job-event estimates for the two no-probe ops (measured shapes: a capture logs its phases; a home ~20 s of polled beats). */
export const CAPTURE_EVENT_BUDGET = 10;
export const HOME_EVENT_BUDGET = 30;
