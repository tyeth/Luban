import { strict as assert } from 'assert';

import { CAPTURE_SETTLE_MS } from '../procedureLimits';
import { expandProgramGroups } from '../programGroups';
import {
    CAPTURE_EVENT_BUDGET,
    HOME_EVENT_BUDGET,
    PROGRAM_OP_KINDS,
    captureOpArgs,
    groupableOpKind,
    homeOrderError,
    isProgramOpKind,
} from '../programOps';

export const tests: Array<[string, () => void]> = [
    ['the op kind list names capture and home beside the probing kinds', () => {
        assert.ok(isProgramOpKind('capture'));
        assert.ok(isProgramOpKind('home'));
        assert.ok(isProgramOpKind('rotate_b'));
        assert.equal(isProgramOpKind('photo'), false);
        assert.equal(isProgramOpKind(undefined), false);
        assert.ok(isProgramOpKind('wall_follow'));
        assert.equal(PROGRAM_OP_KINDS.length, 8);
    }],

    ['home is the one kind a group may not repeat', () => {
        assert.ok(groupableOpKind('capture'));
        assert.ok(groupableOpKind('sequence'));
        assert.equal(groupableOpKind('home'), false);
        assert.equal(groupableOpKind('group'), false);
    }],

    ['capture takes settle_ms (clamped to CAPTURE_SETTLE_MS), a label and an optional viewing x/y, nothing else', () => {
        assert.deepEqual(captureOpArgs({}, 'ops[1]'), { settle_ms: CAPTURE_SETTLE_MS.default, label: null, view: null });
        assert.deepEqual(captureOpArgs({ settle_ms: 99999, label: ' B180 view ' }, 'ops[1]'), { settle_ms: CAPTURE_SETTLE_MS.max, label: 'B180 view', view: null });
        assert.equal(captureOpArgs({ settle_ms: 1200 }, 'ops[1]').settle_ms, 1200);
        assert.deepEqual(captureOpArgs({ x: 140, y: '200' }, 'ops[1]').view, { x: 140, y: 200 });
        assert.throws(() => captureOpArgs({ x: 140 }, 'ops[1]'), /BOTH x and y/);
        assert.throws(() => captureOpArgs({ x: 140, y: 'abc' }, 'ops[1]'), /BOTH x and y/);
        assert.throws(() => captureOpArgs({ z: 300 }, 'ops[1]'), /unknown argument\(s\) z/);
    }],

    ['a home op anywhere but last is refused, naming its index and what follows', () => {
        assert.equal(homeOrderError(['sequence', 'rotate_b', 'capture']), null);
        assert.equal(homeOrderError(['sequence', 'capture', 'home']), null);
        const err = homeOrderError(['home', 'sequence', 'capture']);
        assert.ok(err && err.includes('ops[0] (home)') && err.includes('2 op(s) follow it'));
        assert.ok(homeOrderError(['sequence', 'home', 'home']));
    }],

    ['the look-rotate-look program is one approval: capture from (x, y), rotate, capture, home', () => {
        // The exact shape the operator asked for on 2026-09-21; every kind exists and the order is legal.
        // The transit is the first capture's viewing position: a hop-only sequence is refused as pure motion.
        const kinds = ['capture', 'rotate_b', 'capture', 'home'];
        assert.ok(kinds.every(isProgramOpKind));
        assert.deepEqual(captureOpArgs({ x: 140, y: 200, label: 'B0' }, 'ops[0]').view, { x: 140, y: 200 });
        assert.equal(homeOrderError(kinds), null);
        assert.ok(CAPTURE_EVENT_BUDGET < HOME_EVENT_BUDGET);
    }],

    ['a capture inside a group is repeated per angle with the _b suffix, like any inner op', () => {
        const { ops } = expandProgramGroups([
            { id: 'look', kind: 'group', for_b: [0, 180], ops: [{ id: 'shot', kind: 'capture', label: `B ${['$', '{b}'].join('')}` }] },
        ]);
        assert.deepEqual(ops.map((o) => (o as { id: string }).id), ['look_rot_b0', 'shot_b0', 'look_rot_b180', 'shot_b180']);
        assert.equal((ops[3] as { label: string }).label, 'B 180');
        // A home inside a group would be expanded twice, so it can never be last: the order rule catches it.
        const homed = expandProgramGroups([{ id: 'g', kind: 'group', for_b: [0, 90], ops: [{ id: 'h', kind: 'home' }] }]);
        assert.ok(homeOrderError(homed.ops.map((o) => String((o as { kind: string }).kind))));
    }],
];
