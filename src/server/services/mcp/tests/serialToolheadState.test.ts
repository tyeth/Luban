import assert from 'assert';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';
import { SerialToolheadState } from '../../../controllers/Marlin/SerialToolheadState';
import { assessToolhead, getMcpLaserRecord, toolheadNote, toolheadOnRefusal } from '../toolheadState';
import { dialectById } from '../gcodeDialect';

/* eslint-disable @typescript-eslint/no-explicit-any, global-require */
const dialect = dialectById('sm2-marlin');
const noop = () => undefined;
const POSITION = 'X:60.00 Y:160.00 Z:328.00 E:0.00 Count X:0 Y:0 Z:0';

function load(relative: string, overrides: Record<string, unknown> = {}, globals: Record<string, unknown> = {}): any {
    const source = fs.readFileSync(path.join(__dirname, '../../../..', relative), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
        allowJs: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true,
    } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, {
        exports,
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval: noop,
        Date,
        Promise,
        process: { env: { NODE_ENV: 'test' } },
        ...globals,
        require: (name: string) => {
            if (name in overrides) { return overrides[name]; }
            if (name.startsWith('.')) { return {}; }
            return require(name); // eslint-disable-line import/no-dynamic-require
        },
    });
    return exports;
}

class Queue extends EventEmitter {
    public state = { sent: 0, received: 0 };

    public size = () => 0;

    public isPending = () => false;

    public clear = noop;

    public next = () => false;
}

class SerialPort extends EventEmitter {
    public isOpen = false;

    public constructor(public options: any) { super(); }

    // Do not run connection bootstrap or send anything beyond the test's writes.
    public open(): void { this.isOpen = true; }

    public write(line: string, context: unknown): void {
        this.options.writeFilter(line, context);
        this.emit('written', line.trim());
    }
}

/** Real Marlin parser, write filter and transaction; inert serial transport and timers. */
function machine(markerSuffix?: string): any {
    const parser = load('shared/lib/gcodeParser.js');
    const interpret = load('server/lib/interpret.js', { '../../shared/lib/gcodeParser': parser });
    const Marlin = load('server/controllers/Marlin/Marlin.js');
    const module = load('server/controllers/Marlin/MarlinController.js', {
        './Marlin': Marlin,
        './SerialToolheadState': { SerialToolheadState },
        '../../lib/interpret': interpret,
        '../../lib/numeric-utils': { ensureRange: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)) },
        '../../lib/SerialConnection': SerialPort,
        '../../lib/EventTrigger': class {},
        '../../lib/Feeder': Queue,
        '../../lib/Sender': Queue,
        '../../lib/Workflow': class extends EventEmitter { public state = 'idle'; },
        '../../lib/logger': () => ({ debug: noop, warn: noop, error: noop, info: noop, silly: noop }),
        '../constants': { WRITE_SOURCE_CLIENT: 'client', WRITE_SOURCE_QUERY: 'query', WORKFLOW_STATUS_RUNNING: 'running' },
    }, markerSuffix ? { Math: Object.assign(Object.create(Math), { random: () => ({ toString: () => `0.${markerSuffix}` }) }) } : {});
    const Controller = module.default;
    const result = new Controller({ port: 'inert-test-port' });
    result.open();
    result.ready = true;
    result.receive = (raw: string) => result.serialportListener.data(raw);
    result.assess = () => assessToolhead(dialect, { ...result.controller.state, serialToolhead: result.serialToolhead.snapshot() });
    return result;
}

function respond(controller: any, onLine?: (line: string) => boolean): void {
    controller.serialport.on('written', (line: string) => {
        setTimeout(() => {
            if (line.startsWith('M118 E1 ')) {
                controller.receive(`echo:${line.slice('M118 E1 '.length)}`);
            } else if (onLine?.(line) === false) {
                return;
            } else if (line === 'M114') {
                controller.receive(POSITION);
            }
            controller.receive('ok');
        }, 0);
    });
}

async function start(controller: any, command = 'M3 P100'): Promise<void> {
    controller.writeln(command);
    controller.receive('ok');
    assert.strictEqual(controller.assess().state, 'on');
}

export const tests: Array<[string, () => void | Promise<void>]> = [
    ...['abm3p100cd', 'abm4s255cd', 'abm5cd'].map((suffix): [string, () => Promise<void>] => [
        `M118 synchronization text ${suffix} cannot fabricate spindle commands during a positioning-only transaction`, async () => {
            const controller = machine(suffix);
            await start(controller);
            respond(controller);
            await controller.executeMcpGcode('M5', 1000);
            assert.strictEqual(controller.assess().state, 'off');
            const before = JSON.stringify(controller.serialToolhead.snapshot());
            const sent: string[] = [];
            controller.serialport.on('written', (line: string) => sent.push(line));
            await controller.executeMcpGcode('G90\nG53;\nG1 Z327 F100;\nG54;', 1000);
            assert.ok(sent[0].endsWith(`_${suffix}`), 'exercise the actual M118 transaction fence');
            assert.strictEqual(controller.controller.state.headStatus, false, suffix);
            assert.strictEqual(controller.controller.state.headPower, 100, suffix);
            assert.strictEqual(controller.assess().state, 'off', suffix);
            assert.strictEqual(JSON.stringify(controller.serialToolhead.snapshot()), before, suffix);
        },
    ]),
    ['Marlin messages cannot change spindle, modal or feed state even when they contain executable-looking words', async () => {
        const controller = machine();
        await start(controller);
        const before = JSON.stringify(controller.controller.state);
        const evidence = JSON.stringify(controller.serialToolhead.snapshot());
        for (const line of ['M118 E1 M5 G91 G20 F500', 'M117 M5', 'N123 M118 A1 E1 m5', 'M0118E1 M5']) {
            controller.writeln(line);
            controller.receive('ok');
            assert.strictEqual(JSON.stringify(controller.controller.state), before, line);
            assert.strictEqual(JSON.stringify(controller.serialToolhead.snapshot()), evidence, line);
        }
        respond(controller);
        await controller.executeMcpGcode('M5', 1000);
        controller.writeln('M118 E1 message\nM3 P100');
        assert.strictEqual(controller.assess().state, 'on', 'a multiline write must not hide a real command on the next line');
    }],
    ['serial diagnostic history preserves command/report order, resets and immutable bounded snapshots', () => {
        let at = 100;
        const logged: object[] = [];
        const state = new SerialToolheadState(event => logged.push(event), () => at++);
        state.command('M3', true, { line: 'M3 P100', writeSource: 'client', mcpTransaction: true });
        state.reportPower(45, { line: 'Current Power: 45', writeSource: null, mcpTransaction: false });
        state.command('M5', false, { line: 'M5' });
        state.acknowledge('M5', state.revision);
        const a = assessToolhead(dialect, { headStatus: false, headPower: 45, serialToolhead: state.snapshot() });
        assert.strictEqual(a.state, 'on');
        assert.deepStrictEqual(a.on_signals, ['headPower > 0', 'serial firmware power > 0']);
        const refusal = toolheadOnRefusal(a, 'Refusing to home.') || '';
        assert.match(refusal, /headPower 45, headStatus false/);
        assert.match(refusal, /"powerSource":"firmware"/);
        assert.match(refusal, /off-acknowledged/);
        assert.strictEqual(toolheadNote(a, getMcpLaserRecord(null)), a, 'read-only result includes the same assessed evidence');
        const serial = a.serial_toolhead;
        assert.ok(serial);
        const history = serial.recent;
        assert.deepStrictEqual(history.filter(e => e.kind !== 'invalidated').map(e => e.kind), ['command', 'power-report', 'command', 'off-acknowledged']);
        assert.strictEqual(history[1].line, 'M3 P100');
        assert.strictEqual(history[1].writeSource, 'client');
        assert.strictEqual(history[1].mcpTransaction, true);
        assert.ok(history.every((e, i) => !i || e.at > history[i - 1].at));
        history[1].line = 'mutated snapshot';
        assert.strictEqual(state.snapshot().recent[1].line, 'M3 P100');
        state.reset('firmware-start');
        assert.strictEqual(serial.reportedPower, 45, 'the refusal evidence remains unchanged after reset');
        assert.strictEqual(state.snapshot().reportedPower, null);
        assert.strictEqual(state.snapshot().recent.slice(-1)[0].reason, 'firmware-start');
        for (let i = 0; i < 50; i++) { state.reportStatus(false); }
        assert.strictEqual(state.snapshot().recent.length, 32);
        assert.ok(logged.length > 32, 'persistent log callback retains events evicted from the ring');
    }],
    ['serial parser records raw positive report and real command context for a diagnosable refusal', async () => {
        const controller = machine();
        await start(controller);
        controller.receive('Current Power: 45');
        const report = controller.serialToolhead.snapshot().recent.slice(-1)[0];
        assert.strictEqual(report.kind, 'power-report');
        assert.strictEqual(report.line, 'Current Power: 45');
        assert.strictEqual(report.reportedPower, 45);
        respond(controller);
        await controller.executeMcpGcode('M5', 1000);
        const history = controller.serialToolhead.snapshot().recent;
        const m5 = history.find((e: any) => e.kind === 'command' && e.command === 'M5');
        assert.strictEqual(m5.line, 'M5');
        assert.strictEqual(m5.mcpTransaction, true);
        assert.strictEqual(history.slice(-1)[0].kind, 'off-acknowledged');
        assert.strictEqual(controller.assess().state, 'on', 'diagnostics do not erase a positive firmware reading');
    }],
    ['serial power setpoint survives M5 in UI but the correlated M5 ACK clears its guard', async () => {
        const controller = machine();
        await start(controller);
        const sent: string[] = [];
        controller.serialport.on('written', (line: string) => sent.push(line));
        respond(controller, (line) => {
            if (line === 'M5') {
                assert.strictEqual(controller.controller.state.headStatus, false, 'the UI already says off before its ACK');
                assert.strictEqual(controller.assess().state, 'on', 'pending M5 is not proof');
            }
            if (line === 'M400' || line === 'M114') {
                assert.strictEqual(controller.assess().state, 'on', 'OFF is promoted only when the entire request succeeds');
            }
            return true;
        });
        await controller.executeMcpGcode('M5', 1000);
        assert.strictEqual(controller.controller.state.headPower, 100, 'retain the requested speed for the UI');
        assert.strictEqual(controller.assess().state, 'off');
        assert.match(controller.assess().basis, /retained command setpoint/);
        assert.deepStrictEqual(sent.slice(1), ['M5', 'M400', 'M114'], 'no extra queries or waits added');
    }],
    ['serial default false, uncorrelated ACK and stale OFF report cannot clear a command', async () => {
        const controller = machine();
        controller.controller.state.headPower = 100;
        assert.strictEqual(controller.assess().state, 'on', 'default false does not establish OFF');
        await start(controller);
        controller.writeln('M5');
        controller.receive('ok');
        controller.receive('Current Status: OFF');
        assert.strictEqual(controller.assess().state, 'on', 'raw ACK and OFF are not the isolated M5 ACK');
    }],
    ['serial failed, timed-out and unwritten M5 retain the guard', async () => {
        for (const failure of ['error', 'timeout', 'unwritten', 'position']) {
            const controller = machine();
            await start(controller);
            if (failure === 'unwritten') {
                const write = controller.writeln.bind(controller);
                controller.writeln = (line: string, context: unknown) => (line === 'M5' ? false : write(line, context));
            }
            respond(controller, (line) => {
                if (failure === 'position') {
                    if (line === 'M114') {
                        controller.receive('ok');
                        return false;
                    }
                    return true;
                }
                if (line !== 'M5') { return true; }
                if (failure === 'error') { controller.receive('Error: rejected'); }
                return false;
            });
            await assert.rejects(controller.executeMcpGcode('M5', 50), /failed|Timed out|Could not write|without a complete position/);
            assert.strictEqual(controller.assess().state, 'on', failure);
            assert.strictEqual(controller.serialToolhead.snapshot().offAcknowledged, false, failure);
        }
    }],
    ['serial positive firmware power or status always refuses despite M5 and UI false', async () => {
        for (const report of ['Current Power: 45', 'Current Status: ON']) {
            const controller = machine();
            await start(controller);
            controller.receive(report);
            respond(controller);
            await controller.executeMcpGcode('M5', 1000);
            assert.strictEqual(controller.controller.state.headStatus, false);
            assert.strictEqual(controller.assess().state, 'on', report);
        }
    }],
    ['serial OFF and zero readback clear earlier firmware ON and positive power after acknowledged M5', async () => {
        const controller = machine();
        await start(controller);
        controller.receive('Current Status: ON');
        controller.receive('Current Power: 45');
        respond(controller);
        await controller.executeMcpGcode('M5', 1000);
        assert.strictEqual(controller.assess().state, 'on');
        controller.receive('Current Status: OFF');
        assert.strictEqual(controller.assess().state, 'on', 'OFF must not hide still-positive power');
        controller.receive('Current Power: 0');
        assert.strictEqual(controller.controller.state.headPower, 0, 'the real parser replaces the UI power too');
        assert.strictEqual(controller.assess().state, 'off');
    }],
    ['serial zero report after M5 replaces the retained setpoint and preserves OFF', async () => {
        const controller = machine();
        await start(controller);
        respond(controller);
        await controller.executeMcpGcode('M5', 1000);
        assert.strictEqual(controller.controller.state.headPower, 100);
        controller.receive('Current Power: 0');
        assert.strictEqual(controller.controller.state.headPower, 0);
        assert.strictEqual(controller.assess().state, 'off');
        assert.strictEqual(controller.assess().serial_toolhead.powerSource, 'firmware');
    }],
    ['serial new M3/M4 or positive firmware reading invalidates old OFF, including delayed OFF reports', async () => {
        for (const event of ['M3', 'M4', 'Current Power: 10', 'Current Status: ON']) {
            const controller = machine();
            await start(controller);
            respond(controller);
            await controller.executeMcpGcode('M5', 1000);
            assert.strictEqual(controller.assess().state, 'off');
            if (event.startsWith('M')) { controller.writeln(event); } else { controller.receive(event); }
            controller.receive('Current Status: OFF');
            assert.strictEqual(controller.assess().state, 'on', event);
        }
    }],
    ['serial OFF evidence cannot survive a port reopen or an old completion callback', async () => {
        const controller = machine();
        await start(controller);
        respond(controller);
        await controller.executeMcpGcode('M5', 1000);
        const oldRevision = controller.serialToolhead.revision;
        controller.receive('start');
        assert.strictEqual(controller.assess().state, 'on', 'firmware reboot also invalidates old OFF');
        controller.serialport = null;
        controller.open();
        controller.serialToolhead.acknowledge('M5', oldRevision);
        assert.strictEqual(controller.assess().state, 'on', 'old UI power with reset provenance is conservative');
    }],
    ['serial old query ACK before synchronization cannot acknowledge M5', async () => {
        const controller = machine();
        await start(controller);
        controller.serialport.on('written', (line: string) => {
            if (line.startsWith('M118 E1 ')) { controller.receive('ok'); }
        });
        await assert.rejects(controller.executeMcpGcode('M5', 30), /synchronization echo/);
        assert.strictEqual(controller.serialToolhead.snapshot().offAcknowledged, false);
        assert.strictEqual(controller.assess().state, 'on');
    }],
    ['serial positive report between M5 write and its ACK cannot be hidden by that ACK', async () => {
        const controller = machine();
        await start(controller);
        respond(controller, (line) => {
            if (line === 'M5') { controller.receive('Current Power: 30'); }
            return true;
        });
        await controller.executeMcpGcode('M5', 1000);
        assert.strictEqual(controller.assess().state, 'on');
        assert.strictEqual(controller.serialToolhead.snapshot().offAcknowledged, false);
    }],
    ['firmware restart after frame selection aborts the batch before motion and latches future writes', async () => {
        const controller = machine();
        const sent: string[] = [];
        let resets = 0;
        controller.controller.state.isHomed = true;
        controller.on('firmwareReset', () => { resets++; });
        controller.serialport.on('written', (line: string) => sent.push(line));
        respond(controller, (line) => {
            if (line === 'G53;') { controller.receive('start'); }
            return true;
        });
        await assert.rejects(controller.executeMcpGcode('G90\nG53;\nG1 Z303 F100;\nG54;', 1000), /closed|restarted/);
        assert.deepStrictEqual(sent.slice(1), ['G90', 'G53;'], 'no move may follow the reset even if an old ACK arrives');
        assert.strictEqual(resets, 1);
        assert.strictEqual(controller.ready, false);
        assert.strictEqual(controller.controller.state.isHomed, false);
        assert.ok(controller.mcpTransactionFault);
        await assert.rejects(controller.executeMcpGcode('G1 Z302 F100', 1000), /transaction fault/);
        assert.strictEqual(controller.writeln('G1 Z302 F100'), false, 'legacy writes also fail closed');
    }],
    ['firmware restart cancels a pending reservation and a later ready report cannot clear the fault', async () => {
        const controller = machine();
        const sent: string[] = [];
        controller.serialport.on('written', (line: string) => sent.push(line));
        controller.history.writeSource = 'query';
        const pending = controller.executeMcpGcode('G1 Z303 F100', 1000);
        controller.receive('start');
        controller.receive('ok');
        await assert.rejects(pending, /restarted/);
        controller.checkMachineIsReady({ machineIdentifier: 'A350' });
        await assert.rejects(controller.executeMcpGcode('G1 Z303 F100', 1000), /transaction fault/);
        assert.deepStrictEqual(sent, [], 'no fence or motion was written after the pending-session reset');
    }],
    ['initial firmware boot clears evidence without faulting a new unready connection', () => {
        const controller = machine();
        controller.ready = false;
        controller.controller.state.isHomed = true;
        controller.receive('start');
        assert.strictEqual(controller.mcpTransactionFault, null);
        assert.strictEqual(controller.controller.state.isHomed, false);
    }],
];
