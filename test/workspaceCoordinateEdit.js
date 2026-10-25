// The Workspace coordinate table's click-to-edit go-to: the real DisplayPanel
// with its presentation dependencies isolated, as test/workspaceJog.js does.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('tape');
const React = require('react');
const { act, create } = require('react-test-renderer');
const { transformSync } = require('@babel/core');
const lodash = require('lodash');
const coordinateGoto = require('../src/app/ui/widgets/ConnectionControl/coordinateGoto');

const filename = path.resolve(__dirname, '../src/app/ui/widgets/ConnectionControl/DisplayPanel.jsx');
const code = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename,
    configFile: false,
    babelrc: false,
    presets: ['@babel/preset-react'],
    // Class fields are left to Node, which runs them natively.
    plugins: ['@babel/plugin-transform-modules-commonjs']
}).code;

function loadDisplayPanel() {
    const propType = () => null;
    propType.isRequired = () => null;
    const mocks = {
        classnames: (...names) => names.filter(Boolean).join(' '),
        'lodash/includes': lodash.includes,
        'prop-types': { func: propType, object: propType, string: propType },
        react: React,
        '../../../constants': { HEAD_PRINTING: '3dp', METRIC_UNITS: 'mm' },
        '../../../lib/i18n': { _: (key, values) => (values ? `${key} ${JSON.stringify(values)}` : key) },
        '../../components/Buttons': { Button: 'button' },
        '../../components/Dropdown': 'dropdown',
        '../../components/Menu': Object.assign(() => null, { Item: 'menu-item' }),
        '../../components/SvgIcon': 'svg-icon',
        // Every class name maps to itself; not an ES module, so Babel's interop wraps it.
        './styles.styl': new Proxy({}, { get: (target, name) => (name === '__esModule' ? undefined : String(name)) }),
        './coordinateGoto': coordinateGoto
    };
    const module = { exports: {} };
    const requireMock = (name) => {
        if (Object.prototype.hasOwnProperty.call(mocks, name)) return mocks[name];
        throw new Error(`Unexpected dependency in isolated UI test: ${name}`);
    };
    vm.runInNewContext(code, { module, exports: module.exports, require: requireMock });
    return module.exports.default;
}

function mount({ canClick = true, travel = null, headType = 'cnc', feedMove = false } = {}) {
    const DisplayPanel = loadDisplayPanel();
    const commands = [];
    const props = {
        executeGcode: gcode => commands.push(gcode),
        workPosition: { x: '30.000', y: '5.000', z: '12.500', b: '0.000', isFourAxis: false },
        originOffset: { x: 10, y: 0, z: 2, b: 0 },
        headType,
        state: { units: 'mm', canClick, axes: ['x', 'y', 'z'], jogSpeed: 1500 },
        travel,
        feedMove
    };
    let renderer;
    act(() => { renderer = create(React.createElement(DisplayPanel, props)); });
    const editable = title => renderer.root.findAll(node => node.props.role === 'button'
        && node.props.title === title);
    const input = () => renderer.root.findAllByType('input')[0];
    return {
        commands,
        renderer,
        input,
        // Columns: index 0 = X, 1 = Y, 2 = Z.
        open: (frame, row) => act(() => editable(`key-Workspace/Control/DisplayPanel-Click to type a ${frame} position to go to`)[row].props.onClick()),
        type: value => act(() => input().props.onChange({ target: { value } })),
        key: name => act(() => input().props.onKeyDown({ key: name, preventDefault: () => {} })),
        blur: () => act(() => input().props.onBlur()),
        update: next => act(() => renderer.update(React.createElement(DisplayPanel, { ...props, ...next }))),
        error: () => renderer.root.findAll(node => node.props.className === 'coordinate-error').map(node => node.children.join('')),
        close: () => act(() => renderer.unmount())
    };
}

test('clicking a work coordinate opens an input pre-filled with it; Enter sends one move', (t) => {
    const ui = mount();
    ui.open('work', 0);
    t.equal(ui.input().props.value, '30.000', 'pre-filled with the displayed work X');
    ui.type('42');
    ui.key('Enter');
    t.deepEqual(ui.commands, ['G90\nG0 X42 F1500'], 'one absolute work-frame move on X only');
    t.equal(ui.renderer.root.findAllByType('input').length, 0, 'editor closed');
    ui.close();
    t.end();
});

test('a machine coordinate edit moves to that machine position via the work frame', (t) => {
    const ui = mount();
    ui.open('machine', 2);
    t.equal(ui.input().props.value, '10.500', 'machine Z = work 12.5 - offset 2');
    ui.type('20');
    ui.key('Enter');
    t.deepEqual(ui.commands, ['G90\nG0 Z22 F1500'], 'machine 20 = work 22');
    ui.close();
    t.end();
});

test('Escape cancels without a move, and the blur after it does not commit', (t) => {
    const ui = mount();
    ui.open('work', 1);
    ui.type('99');
    const { onBlur } = ui.input().props;
    ui.key('Escape');
    act(() => onBlur());
    t.deepEqual(ui.commands, [], 'nothing sent');
    ui.close();
    t.end();
});

test('Enter then the blur that follows sends exactly one move', (t) => {
    const ui = mount();
    ui.open('work', 0);
    ui.type('1');
    const { onBlur } = ui.input().props;
    ui.key('Enter');
    act(() => onBlur());
    t.equal(ui.commands.length, 1);
    ui.close();
    t.end();
});

test('blur commits a changed value, but clicking in and out does nothing', (t) => {
    const ui = mount();
    ui.open('work', 2);
    ui.blur();
    t.deepEqual(ui.commands, [], 'unchanged value: no micro-move on Z');
    ui.open('work', 2);
    ui.type('13');
    ui.blur();
    t.deepEqual(ui.commands, ['G90\nG0 Z13 F1500'], 'changed value is sent on blur');
    ui.close();
    t.end();
});

test('non-numeric input is refused: Enter keeps the editor open, blur closes it', (t) => {
    const ui = mount();
    ui.open('work', 0);
    ui.type('abc');
    ui.key('Enter');
    t.deepEqual(ui.commands, []);
    t.ok(ui.input(), 'still editing after Enter');
    t.ok(ui.error()[0].includes('Not a number'), 'says why');
    ui.blur();
    t.equal(ui.renderer.root.findAllByType('input').length, 0, 'blur closes it');
    t.deepEqual(ui.commands, [], 'still nothing sent');
    ui.close();
    t.end();
});

test('Ray: a target outside the work area is refused with the reason', (t) => {
    const ui = mount({ travel: { x: 600, y: 400 } });
    ui.open('machine', 1);
    ui.type('450');
    ui.key('Enter');
    t.deepEqual(ui.commands, []);
    t.ok(ui.error()[0].includes('outside the machine travel'), 'says why');
    ui.close();
    t.end();
});

test('Ray: a typed position moves with G1 at the jog speed', (t) => {
    const ui = mount({ travel: { x: 600, y: 400 }, feedMove: true });
    ui.open('work', 0);
    ui.type('42');
    ui.key('Enter');
    t.deepEqual(ui.commands, ['G90\nG1 X42 F1500'], 'G1 so GRBL honours F');
    ui.close();
    t.end();
});

test('not editable while the machine cannot take commands; an open edit is dropped', (t) => {
    const busy = mount({ canClick: false });
    t.equal(busy.renderer.root.findAll(node => node.props.role === 'button').length, 0, 'plain readouts');
    busy.close();

    const ui = mount();
    ui.open('work', 0);
    ui.type('5');
    ui.update({ state: { units: 'mm', canClick: false, axes: ['x', 'y', 'z'], jogSpeed: 1500 } });
    t.equal(ui.renderer.root.findAllByType('input').length, 0, 'editor closed when a job starts');
    t.deepEqual(ui.commands, [], 'nothing sent');
    ui.close();
    t.end();
});
