// The Ray's job frame (boundary.nc): Luban's Run Boundary G-code, where a
// job's frame comes from, when it must be re-sent, and what the operator is
// told a short press runs. Pure modules only.
import assert from 'assert';
import {
    boundaryFrameSummary,
    boundaryUploadNeeded,
    getRunBoundaryCode,
    jobBoundarySource,
} from '../../../../shared/lib/rayBoundary';
import { BoundaryRefresh, FileJobTransport, operatorStartInstruction, shortPressNote } from '../fileJobStart';

const RANGE = { min: { x: 10, y: 20, b: 0 }, max: { x: 30, y: 40, b: 90 } };

const LUBAN_HEADER = [
    ';Header Start',
    ';header_type: laser',
    ';tool_head: 20W Laser Module',
    ';machine: Ray',
    ';is_rotate: false',
    ';max_x(mm): 110.77699999999999',
    ';max_y(mm): 54.291000000000004',
    ';max_b(mm): 0',
    ';min_x(mm): 1',
    ';min_y(mm): 0.9990000000000023',
    ';min_b(mm): 0',
    ';origin: bottom-left',
];

const TRANSPORT: FileJobTransport = {
    start: 'operator-switch',
    target: 'ray.nc',
    instruction: 'Hold the switch. A SHORT press runs the controller boundary.nc.',
    holdInstruction: 'Hold the switch.',
    stop: 'file-print-only',
};

export const tests: Array<[string, () => void]> = [
    ['getRunBoundaryCode: Luban\'s crosshair frame in Control Mode (no G92, back to the centre)', () => {
        assert.strictEqual(getRunBoundaryCode(RANGE, 'Crosshair', false, 'control-panel'), [
            ';motor_mode: 3',
            'M2000 L13 P1',
            'G90',
            'G1 S0 X10 Y20 F6000',
            'G1 S0 X30 Y20 F6000',
            'G1 S0 X30 Y40 F6000',
            'G1 S0 X10 Y40 F6000',
            'G1 S0 X10 Y20 F6000',
            'G1 S0 X20 Y30 F6000',
            ';End',
        ].join('\n'));
    }],
    ['getRunBoundaryCode: Luban\'s laser-spot frame set up by hand (G92 here, back to 0,0, laser off at the end)', () => {
        assert.strictEqual(getRunBoundaryCode(RANGE, 'LaserSpot', false, 'manually'), [
            'M3 S0',
            'G1 S10 F6000',
            'G90',
            'G92 X0 Y0 B0',
            'G1 S10 X10 Y20 F6000',
            'G1 S10 X30 Y20 F6000',
            'G1 S10 X30 Y40 F6000',
            'G1 S10 X10 Y40 F6000',
            'G1 S10 X10 Y20 F6000',
            'G1 S10 X0 Y0 F6000',
            'M5 S0',
            ';End',
        ].join('\n'));
    }],
    ['getRunBoundaryCode: a rotary job frames B instead of X', () => {
        const code = getRunBoundaryCode(RANGE, 'Crosshair', true, 'control-panel');
        assert.match(code, /G1 S0 B0 Y20 F6000\nG1 S0 B90 Y20 F6000/);
        assert.match(code, /G1 S0 B45 Y30 F6000\n;End$/);
        assert.doesNotMatch(code, / X/);
    }],
    ['jobBoundarySource: a Luban export frames its header box; M2003 in the header means Crosshair', () => {
        const crosshair = jobBoundarySource([...LUBAN_HEADER, 'M2003', 'M2004', ';Header End', 'G90', 'G1 X200 Y200'].join('\n'),
            { x: { min: 0, max: 500 }, y: { min: 0, max: 500 } });
        assert.deepStrictEqual(crosshair, {
            range: { min: { x: 1, y: 0.9990000000000023, b: 0 }, max: { x: 110.77699999999999, y: 54.291000000000004, b: 0 } },
            jobOffsetMode: 'Crosshair',
            isRotate: false,
            basis: 'header',
        });
        const spot = jobBoundarySource([...LUBAN_HEADER, ';Header End', 'M2003'].join('\n'), null);
        assert.strictEqual(spot?.jobOffsetMode, 'LaserSpot', 'M2003 after ;Header End is not the header\'s mode');
        const rotary = jobBoundarySource([...LUBAN_HEADER.map((l) => l.replace(';is_rotate: false', ';is_rotate: true')
            .replace(';max_b(mm): 0', ';max_b(mm): 180')), ';Header End'].join('\n'), null);
        assert.strictEqual(rotary?.isRotate, true);
        assert.deepStrictEqual(boundaryFrameSummary(rotary!), { min_x: 0, max_x: 180, min_y: 0.9990000000000023, max_y: 54.291000000000004, axis: 'b', mode: 'laser spot at S10' });
    }],
    ['jobBoundarySource: without a usable header the validator extents are framed in Crosshair; neither gives null', () => {
        const bare = jobBoundarySource('G90\nG1 X10 Y20 S500\nM5', { x: { min: 10, max: 30 }, y: { min: 20, max: 40 } });
        assert.deepStrictEqual(bare, { range: { min: { x: 10, y: 20, b: 0 }, max: { x: 30, y: 40, b: 0 } }, jobOffsetMode: 'Crosshair', isRotate: false, basis: 'extents' });
        const partial = jobBoundarySource(';Header Start\n;max_x(mm): 5\n;Header End\n', { x: { min: 0, max: 5 }, y: { min: 0, max: 6 } });
        assert.strictEqual(partial?.basis, 'extents', 'a header without the whole box is not used');
        assert.strictEqual(jobBoundarySource('G90\nM5', null), null);
        assert.strictEqual(jobBoundarySource('G90\nM5', { x: { min: 0, max: 1 }, y: null }), null);
        assert.strictEqual(jobBoundarySource('G90\nM5', { x: { min: 0, max: NaN }, y: { min: 0, max: 1 } }), null);
    }],
    ['boundaryUploadNeeded: only the same bytes on the same connection are skipped', () => {
        assert.strictEqual(boundaryUploadNeeded(null, 'abc', 1), true, 'unknown: a new connection or a failed upload');
        assert.strictEqual(boundaryUploadNeeded({ digest: 'abc', generation: 1 }, 'abc', 1), false);
        assert.strictEqual(boundaryUploadNeeded({ digest: 'abc', generation: 1 }, 'abd', 1), true);
        assert.strictEqual(boundaryUploadNeeded({ digest: 'abc', generation: 1 }, 'abc', 2), true, 'a reconnect');
    }],
    ['operatorStartInstruction: what a short press runs after each refresh outcome', () => {
        const frame = { min_x: 1, max_x: 2, min_y: 3, max_y: 4, axis: 'x' as const, mode: 'crosshair' };
        const refresh = (status: BoundaryRefresh['status'], reason: string | null = null): BoundaryRefresh => ({
            status, target: 'boundary.nc', reason, basis: 'header', frame: status === 'not-framed' ? null : frame,
        });
        assert.strictEqual(operatorStartInstruction(TRANSPORT, refresh('uploaded')),
            'Hold the switch. A SHORT press runs this job\'s frame (X 1..2, Y 3..4 in the work frame, crosshair): boundary.nc was updated to it.');
        assert.match(operatorStartInstruction(TRANSPORT, refresh('unchanged')), /already matched it/);
        assert.strictEqual(shortPressNote(refresh('failed', 'SD card unavailable.')),
            'A SHORT press runs the controller boundary.nc, which could NOT be updated for this job (SD card unavailable.): '
            + 'it is the LAST boundary uploaded, not this job\'s frame - frame this job with laser_frame instead.');
        assert.match(shortPressNote(refresh('not-framed', 'no X/Y extents')), /was not updated \(no frame could be computed\) for this job \(no X\/Y extents\)/);
        assert.strictEqual(operatorStartInstruction(TRANSPORT, null), TRANSPORT.instruction, 'no refresh: the staging text');
        assert.strictEqual(operatorStartInstruction({ ...TRANSPORT, holdInstruction: null }, refresh('uploaded')), TRANSPORT.instruction);
    }],
];
