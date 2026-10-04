import { AXES, judgeRecheck, nearMachine, PositionOfRecord, Xyz } from './positionOfRecord';
import type { PositionSnapshot } from './tools/machine';

/** Present the existing position tracker to the pendant; no second position cache. */
export function pendantPosition(p: PositionSnapshot, record: PositionOfRecord | null, trustedOffset: Xyz | null, now: number, staleMs: number) {
    const ownEcho = record?.source === 'echo' && record.tool === 'usb_pendant'
        && now - record.at >= 0 && now - record.at <= staleMs
        && p.reportAgeMs >= 0 && p.reportAgeMs <= staleMs
        && p.reliability === 'verified' && p.originOffsetSource !== 'assumed-zero'
        && p.judged.rejectedReason !== 'no-offset-yet'
        && trustedOffset && nearMachine(p.originOffset, trustedOffset, 0.02)
        && nearMachine(p.machine, record.machine, 0.001)
        && judgeRecheck([{ raw: p.work, offset: p.originOffset, reportTime: p.reportedAt }],
            record.machine, 0.02, record).verdict === 'pass';
    // The engine already reconciles G53-window and lagging reports. A fresh,
    // verified pendant arrival can outrank one of those reports here too.
    // Estimates, stale data, changed offsets and unresolved newer reports cannot.
    const warnings = ownEcho ? [] : p.warnings;
    const reliable = ['verified', 'heartbeat', 'cached-offset'].includes(p.reliability)
        && record?.source !== 'estimated' && warnings.length === 0;
    const work = reliable && p.originOffsetSource !== 'assumed-zero'
        ? Object.fromEntries(AXES.map((axis) => [axis,
            p.machine[axis] === null ? null : (p.machine[axis] as number) + p.originOffset[axis]])) : null;
    return { machine: p.machine,
        work,
        reliability: record?.source === 'estimated' ? 'estimated' : p.reliability,
        age_ms: p.reportAgeMs,
        stale_after_ms: staleMs,
        warnings,
        heartbeatWarnings: p.warnings,
        source: ownEcho ? 'pendant-controller-echo' : p.reliability };
}
