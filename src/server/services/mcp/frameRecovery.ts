// Recovering the controller's coordinate FRAME, and the words used to tell an
// agent how.
//
// Why this exists (live 2026-09-19): an agent-authored job declared `G53` and
// never selected a work workspace again, so the controller kept reporting in
// the machine workspace. Every heartbeat then carried machine coordinates in
// its raw fields WITH the work-origin offset still populated, `raw - offset`
// fell outside the travel, and the position of record judged every beat
// incoherent - permanently. Motion and staging refuse while the position is
// `awaiting-resync`, so the one thing that would have fixed it - a no-motion
// `G54` - was refused too, and only a re-home cleared the state.
//
// Pure: no server imports, unit-tested in tests/frameRecovery.test.ts.

/**
 * The no-motion program that puts the controller back in the work workspace.
 * `G90` first so the file declares its distance mode (the validator refuses a
 * file that assumes one), then `G54` on its own line - this controller does
 * not honour an inline `G53`/`G54` carried on a motion line, and every MCP
 * emitter uses the same "code on its own line" form.
 *
 * Deliberately contains no axis word: restoring the frame must never move the
 * machine, which is exactly why it is allowed to run when nothing else is.
 */
export const WORK_FRAME_RESTORE_GCODE = 'G90\nG54;';

/** Reliability values, mirrored from machinePosition.ts to keep this module pure. */
export type ReliabilityName = 'verified' | 'heartbeat' | 'cached-offset' | 'awaiting-resync' | 'stale';

/**
 * What an agent should DO about a position it may not act on. The remedy has
 * to be named in the refusal itself: the session that hit this read the
 * refusal, correctly concluded the position was untrustworthy, and had no way
 * to learn that a no-motion frame restore was both possible and permitted.
 */
export function resyncHint(reliability: ReliabilityName): string {
    if (reliability === 'awaiting-resync') {
        return ' Wait for the next status report (2 s) and read get_position again. If it persists, the controller is '
            + 'probably still in the machine workspace after a G53 job: call restore_work_frame (no motion, allowed '
            + 'while the position is incoherent) and read get_position again. query_firmware_position shows which '
            + 'frame the controller is actually in. A re-home is not the remedy.';
    }
    if (reliability === 'stale') {
        return ' Reconnect the machine and re-verify get_position before any motion.';
    }
    return '';
}

/** True when `restore_work_frame` is worth running rather than waiting. */
export function frameRestoreIsWorthTrying(reliability: ReliabilityName): boolean {
    return reliability === 'awaiting-resync' || reliability === 'stale';
}
