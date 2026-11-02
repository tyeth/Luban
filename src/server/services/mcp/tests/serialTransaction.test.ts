import assert from 'assert';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';
import { SerialToolheadState } from '../../../controllers/Marlin/SerialToolheadState';

/** Load only the controller class; each test supplies an inert serial port. */
function controller(): EventEmitter & Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const source = fs.readFileSync(path.join(__dirname, '../../../controllers/Marlin/MarlinController.js'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
        allowJs: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true,
    } }).outputText;
    const dependencies: Record<string, unknown> = {
        events: { EventEmitter },
        '../../lib/logger': () => ({ debug: () => undefined, warn: () => undefined, error: () => undefined }),
    };
    const pattern = /from ['"]([^'"]+)['"]/g;
    for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
        if (!dependencies[match[1]]) { dependencies[match[1]] = {}; }
    }
    const exports: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    vm.runInNewContext(compiled, {
        exports,
        require: (name: string) => dependencies[name],
        setTimeout,
        clearTimeout,
        Date,
        Promise,
    });
    const instance = Object.create(exports.default.prototype);
    EventEmitter.call(instance);
    instance.isOpen = () => true;
    instance.ready = true;
    instance.history = { writeSource: null, writeLine: null };
    instance.feeder = { size: () => 0, isPending: () => false, clear: () => undefined };
    instance.sender = { state: { sent: 0, received: 0 }, unload: () => undefined };
    instance.workflow = { state: 'idle', stop: () => undefined };
    instance.query = { type: null };
    instance.mcpTransactionActive = false;
    instance.mcpTransactionFault = null;
    instance.serialToolhead = new SerialToolheadState();
    return instance;
}

const POSITION = 'X:60.00 Y:150.00 Z:328.00 E:0.00 B:0.00 Count X:0 Y:0 Z:0';

type FakeController = EventEmitter & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function installWriteln(machine: FakeController, send: (line: string) => boolean): void {
    machine.writeln = (line: string) => {
        if (line.startsWith('M118 E1 ')) {
            machine.emit('mcpRawLine', `echo:${line.slice('M118 E1 '.length)}`);
            machine.emit('mcpReply', { ok: true, raw: 'ok' });
            return true;
        }
        return send(line);
    };
}

export const tests: Array<[string, () => void | Promise<void>]> = [
    ['USB MCP waits for every reply, a planner barrier, and actual M114 text', async () => {
        const machine = controller();
        const written: string[] = [];
        installWriteln(machine, (line: string) => {
            written.push(line);
            setTimeout(() => {
                if (line === 'M114') { machine.emit('mcpPositionReport', { raw: POSITION }); }
                machine.emit('mcpReply', { ok: true, raw: 'ok' });
            }, 5);
            return true;
        });
        const pending = machine.executeMcpGcode('G90\nG1 X60 F600', 1000);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(written, ['G90'], 'only the first line may be outstanding');
        const result = await pending;
        assert.deepStrictEqual(written, ['G90', 'G1 X60 F600', 'M400', 'M114']);
        assert.strictEqual(result.result, 0);
        assert.strictEqual(result.text, POSITION);
    }],
    ['USB M114 returns its position reply without synthetic ok or motion barrier', async () => {
        const machine = controller();
        const written: string[] = [];
        installWriteln(machine, (line: string) => {
            written.push(line);
            setTimeout(() => {
                machine.emit('mcpPositionReport', { raw: POSITION });
                machine.emit('mcpReply', { ok: true, raw: 'ok' });
            }, 0);
            return true;
        });
        const result = await machine.executeMcpGcode('M114', 1000);
        assert.deepStrictEqual(written, ['M114']);
        assert.strictEqual(result.text, POSITION);
    }],
    ['USB synchronization ignores an older ok until the unique firmware echo', async () => {
        const machine = controller();
        const written: string[] = [];
        machine.writeln = (line: string) => {
            written.push(line);
            if (line.startsWith('M118 E1 ')) {
                machine.emit('mcpReply', { ok: true, raw: 'old query ok' });
                setTimeout(() => {
                    machine.emit('mcpRawLine', `echo:${line.slice('M118 E1 '.length)}`);
                    machine.emit('mcpReply', { ok: true, raw: 'marker ok' });
                }, 5);
            } else {
                setTimeout(() => {
                    machine.emit('mcpPositionReport', { raw: POSITION });
                    machine.emit('mcpReply', { ok: true, raw: 'ok' });
                }, 0);
            }
            return true;
        };
        const pending = machine.executeMcpGcode('M114', 1000);
        assert.strictEqual(written.length, 1, 'old ok must not advance to M114');
        const result = await pending;
        assert.strictEqual(written[1], 'M114');
        assert.strictEqual(result.text, POSITION);
    }],
    ['USB M503 preserves the firmware configuration output', async () => {
        const machine = controller();
        const written: string[] = [];
        installWriteln(machine, (line: string) => {
            written.push(line);
            setTimeout(() => {
                machine.emit('mcpRawLine', 'echo: M203 X300 Y300 Z20');
                machine.emit('mcpRawLine', 'echo: M201 X1000 Y1000 Z100');
                machine.emit('mcpReply', { ok: true, raw: 'ok' });
            }, 0);
            return true;
        });
        const result = await machine.executeMcpGcode('M503 S', 1000);
        assert.deepStrictEqual(written, ['M503 S']);
        assert.match(result.text, /M203 X300/);
        assert.match(result.text, /M201 X1000/);
    }],
    ['USB serial reserves the transaction while waiting for an older query', async () => {
        const machine = controller();
        machine.history.writeSource = 'query';
        installWriteln(machine, (line: string) => {
            setTimeout(() => {
                if (line === 'M114') { machine.emit('mcpPositionReport', { raw: POSITION }); }
                machine.emit('mcpReply', { ok: true, raw: 'ok' });
            }, 0);
            return true;
        });
        const first = machine.executeMcpGcode('M114', 1000);
        await assert.rejects(machine.executeMcpGcode('M114', 1000), /in progress/);
        machine.history.writeSource = null;
        assert.strictEqual((await first).text, POSITION);
    }],
    ['USB controller error stops the batch and faults later MCP commands', async () => {
        const machine = controller();
        const written: string[] = [];
        installWriteln(machine, (line: string) => {
            written.push(line);
            setTimeout(() => machine.emit('mcpReply', { ok: false, raw: 'Error: limit' }), 0);
            return true;
        });
        await assert.rejects(machine.executeMcpGcode('G1 X1\nG1 X2', 1000), /Error: limit/);
        assert.deepStrictEqual(written, ['G1 X1']);
        await assert.rejects(machine.executeMcpGcode('G1 X3', 1000), /transaction fault/);
        assert.deepStrictEqual(written, ['G1 X1']);
    }],
    ['USB missing reply times out, and missing M114 position is never success', async () => {
        const noReply = controller();
        installWriteln(noReply, () => true);
        await assert.rejects(noReply.executeMcpGcode('G1 X1', 25), /Timed out/);
        await assert.rejects(noReply.executeMcpGcode('G1 X2', 25), /transaction fault/);

        const noPosition = controller();
        installWriteln(noPosition, () => { setTimeout(() => noPosition.emit('mcpReply', { ok: true, raw: 'ok' }), 0); return true; });
        await assert.rejects(noPosition.executeMcpGcode('M114', 1000), /without a complete position report/);
    }],
    ['USB quickstop during a transaction aborts its remaining lines and remains unverified', async () => {
        const machine = controller();
        machine.serialport = { port: { drain: (done: (err: Error | null) => void) => done(null) } };
        const written: string[] = [];
        installWriteln(machine, (line: string) => { written.push(line); return true; });
        const pending = machine.executeMcpGcode('G1 X1\nG1 X2', 1000);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(written, ['G1 X1']);
        assert.strictEqual(await machine.requestMcpQuickstop(), true);
        machine.emit('mcpReply', { ok: true, raw: 'ok' });
        await assert.rejects(pending, /quickstop requested/);
        assert.deepStrictEqual(written, ['G1 X1', 'M410']);
    }],
    ['USB quickstop halts the host sender before writing M410', async () => {
        const machine = controller();
        const actions: string[] = [];
        machine.workflow.stop = () => { actions.push('workflow stop'); machine.workflow.state = 'idle'; };
        machine.sender.unload = () => actions.push('sender unload');
        machine.feeder.clear = () => actions.push('feeder clear');
        machine.serialport = { port: { drain: (done: (err: Error | null) => void) => { actions.push('drain'); done(null); } } };
        machine.writeln = (line: string) => { actions.push(line); return true; };
        assert.strictEqual(await machine.requestMcpQuickstop(), true);
        assert.deepStrictEqual(actions, ['workflow stop', 'sender unload', 'feeder clear', 'M410', 'drain']);
    }],
    ['native Stop cancels the active MCP batch and sends quickstop', async () => {
        const machine = controller();
        const written: string[] = [];
        machine.event = { trigger: () => undefined };
        machine.emitAll = () => undefined;
        machine.serialport = { port: { drain: (done: (err: Error | null) => void) => done(null) } };
        installWriteln(machine, (line: string) => { written.push(line); return true; });
        const pending = machine.executeMcpGcode('G1 X1\nG1 X2', 1000);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(written, ['G1 X1']);
        machine.command(null, 'gcode:stop');
        machine.emit('mcpReply', { ok: true, raw: 'ok' });
        await assert.rejects(pending, /quickstop requested|Stop requested/);
        assert.deepStrictEqual(written, ['G1 X1', 'M410']);
    }],
    ['native Stop quickstops a faulted session after a timed-out move', async () => {
        const machine = controller();
        const written: string[] = [];
        machine.event = { trigger: () => undefined };
        machine.emitAll = () => undefined;
        machine.serialport = { port: { drain: (done: (err: Error | null) => void) => done(null) } };
        machine.mcpTransactionFault = 'G1 timed out; motion may continue';
        machine.writeln = (line: string) => { written.push(line); return true; };
        machine.command(null, 'gcode:stop');
        assert.deepStrictEqual(written, ['M410']);
    }],
    ['USB fault latch blocks legacy motion writes and commands', () => {
        const machine = controller();
        const written: string[] = [];
        machine.serialport = { write: (line: string) => written.push(line) };
        machine.emitAll = () => undefined;
        machine.mcpTransactionFault = 'timed out';
        assert.strictEqual(Object.getPrototypeOf(machine).writeln.call(machine, 'G1 X1'), false);
        assert.strictEqual(Object.getPrototypeOf(machine).writeln.call(machine, 'M114\nG1 X1'), false);
        assert.strictEqual(Object.getPrototypeOf(machine).writeln.call(machine, 'M112\nG1 X1'), false);
        machine.command(null, 'gcode', 'G1 X2');
        assert.deepStrictEqual(written, []);
        assert.strictEqual(Object.getPrototypeOf(machine).writeln.call(machine, 'M114'), true);
        assert.deepStrictEqual(written, ['M114\n']);
    }],
];
