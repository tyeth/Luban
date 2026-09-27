// Run with: node test/typecheckBaseline.js (also included in npm test).
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');

const checker = path.resolve(__dirname, '../build/typecheck-baseline.js');
const prefix = 'src/server/services/mcp/';

function withProject(check) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luban-typecheck-'));
    const write = (file, text) => {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
    };
    const config = (options = {}) => write('tsconfig.json', JSON.stringify({
        compilerOptions: { strict: true, types: [], skipLibCheck: true, ...options },
        include: ['src/**/*.ts'],
    }));
    const run = (...args) => {
        const result = spawnSync(process.execPath, [checker, 'tsconfig.json', 'baseline.json', ...args], {
            cwd: root,
            encoding: 'utf8',
        });
        if (result.error) throw result.error;
        return { ...result, output: result.stdout + result.stderr };
    };
    try {
        config();
        write('baseline.json', JSON.stringify({ errors: {} }));
        write('src/legacy.ts', 'export const legacy: number = "bad";');
        write(`${prefix}check.ts`, 'export const value: number = 1;');
        check({ root, write, config, run });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('typecheck: ignore legacy semantic errors but reject new MCP errors', (t) => {
    withProject(({ write, run }) => {
        const clean = run('--only', prefix);
        t.equal(clean.status, 0, clean.output);
        write(`${prefix}check.ts`, 'export const value: number = "bad";');
        const broken = run('--only', prefix);
        t.equal(broken.status, 1, 'new MCP error fails the check');
        t.ok(broken.output.includes(`${prefix}check.ts TS2322: 0 -> 1`), broken.output);
    });
    t.end();
});

test('typecheck: an excluded syntax error must not hide MCP errors or rewrite the baseline', (t) => {
    withProject(({ root, write, run }) => {
        write('src/legacy.ts', 'export const legacy = ;');
        write(`${prefix}check.ts`, 'export const value: number = "bad";');
        const before = fs.readFileSync(path.join(root, 'baseline.json'), 'utf8');
        for (const args of [[], ['--update']]) {
            const broken = run('--only', prefix, ...args);
            t.equal(broken.status, 1, `syntax error fails ${args.length ? 'update' : 'check'}`);
            t.ok(broken.output.includes('src/legacy.ts(1,23): error TS1109'), broken.output);
        }
        t.equal(fs.readFileSync(path.join(root, 'baseline.json'), 'utf8'), before, 'failed update preserves the baseline');
    });
    t.end();
});

test('typecheck: configuration and global errors stay fatal outside the path filter', (t) => {
    withProject(({ config, write, run }) => {
        config({ types: ['missing-type-package'] });
        const missingType = run('--only', prefix);
        t.equal(missingType.status, 1, 'missing ambient types fail');
        t.ok(missingType.output.includes('TS2688'), missingType.output);
        config({ noLib: true });
        const missingGlobals = run('--only', prefix);
        t.equal(missingGlobals.status, 1, 'missing global types fail');
        t.ok(missingGlobals.output.includes('TS2318'), missingGlobals.output);
        write('tsconfig.json', '{ "compilerOptions": { "target": "invalid-target" } }');
        const badConfig = run('--only', prefix);
        t.equal(badConfig.status, 1, 'invalid compiler options fail');
        t.ok(badConfig.output.includes('TS6046'), badConfig.output);
    });
    t.end();
});

test('typecheck: preserve baseline keys, updates, and the shrinking ratchet', (t) => {
    withProject(({ root, write, run }) => {
        const baseline = () => JSON.parse(fs.readFileSync(path.join(root, 'baseline.json'), 'utf8'));
        t.equal(run('--update').status, 0, 'write an unfiltered baseline');
        t.deepEqual(baseline(), { tsconfig: 'tsconfig.json', total: 1, errors: { 'src/legacy.ts': { TS2322: 1 } } });
        t.equal(run().status, 0, 'unchanged errors match the baseline');
        write('src/legacy.ts', 'export const legacy: number = 1;');
        const fixed = run();
        t.equal(fixed.status, 1, 'fixed errors require a smaller baseline');
        t.ok(fixed.output.includes('src/legacy.ts TS2322: 1 -> 0'), fixed.output);
        t.equal(run('--only', prefix, '--update').status, 0, 'write a filtered baseline');
        t.deepEqual(baseline(), { tsconfig: 'tsconfig.json', only: prefix, total: 0, errors: {} });
        t.equal(run('--only', prefix).status, 0, 'clean filtered baseline matches');
    });
    t.end();
});
