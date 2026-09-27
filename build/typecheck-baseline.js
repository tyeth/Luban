/**
 * Type check a tsconfig against a committed baseline of known errors.
 *
 * The app tsconfig (tsconfig.json) inherits well over a thousand errors from
 * upstream Luban, mostly in legacy React/three code. Fixing them wholesale is
 * out of scope, so CI ratchets instead: the check fails when any file gains
 * errors of a given code, and asks for the baseline to be lowered when a file
 * loses them. Counts are keyed by file and TS code rather than line or
 * message, so unrelated edits that move or reword an existing error do not
 * trip the check.
 *
 * --only <path prefix> counts just the errors in files under that prefix. The
 * MCP code's strict tsconfig pulls in the legacy server modules it imports,
 * whose strict-mode errors are not the MCP's to fix; with an empty baseline
 * the MCP files themselves must stay clean.
 *
 * Usage:
 *   node build/typecheck-baseline.js <tsconfig> <baseline.json> [--only <prefix>]           check
 *   node build/typecheck-baseline.js <tsconfig> <baseline.json> [--only <prefix>] --update  rewrite the baseline
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const update = argv.includes('--update');
const onlyAt = argv.indexOf('--only');
const only = onlyAt >= 0 ? argv[onlyAt + 1] : null;
const [tsconfig, baselineFile] = argv.filter((arg, i) => !arg.startsWith('--') && (onlyAt < 0 || i !== onlyAt + 1));
if (!tsconfig || !baselineFile || (onlyAt >= 0 && !only)) {
    console.error('usage: node build/typecheck-baseline.js <tsconfig> <baseline.json> [--only <prefix>] [--update]');
    process.exit(2);
}

const ERROR_LINE = /^(.+?)\(\d+,\d+\): error (TS\d+): /;

function currentErrors() {
    const tsc = require.resolve('typescript/bin/tsc');
    const result = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', tsconfig], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    });
    if (result.error) {
        throw result.error;
    }
    const counts = {};
    let total = 0;
    let reported = 0;
    for (const line of result.stdout.split(/\r?\n/)) {
        const match = ERROR_LINE.exec(line);
        if (!match) {
            continue;
        }
        reported++;
        const file = match[1].split(path.sep).join('/');
        if (only && !file.startsWith(only)) {
            continue;
        }
        const code = match[2];
        counts[file] = counts[file] || {};
        counts[file][code] = (counts[file][code] || 0) + 1;
        total++;
    }
    if (reported === 0 && result.status !== 0) {
        // tsc failed without reporting type errors (bad config, crash).
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        process.exit(result.status || 1);
    }
    return { counts, total };
}

function sorted(counts) {
    const out = {};
    for (const file of Object.keys(counts).sort()) {
        out[file] = {};
        for (const code of Object.keys(counts[file]).sort()) {
            out[file][code] = counts[file][code];
        }
    }
    return out;
}

const { counts, total } = currentErrors();
const onlyArgs = only ? ` --only ${only}` : '';

if (update) {
    const written = only ? { tsconfig, only, total, errors: sorted(counts) } : { tsconfig, total, errors: sorted(counts) };
    fs.writeFileSync(baselineFile, `${JSON.stringify(written, null, 2)}\n`);
    console.log(`Baseline written: ${total} errors in ${Object.keys(counts).length} files -> ${baselineFile}`);
    process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')).errors;
const added = [];
const removed = [];
for (const file of new Set([...Object.keys(baseline), ...Object.keys(counts)])) {
    for (const code of new Set([...Object.keys(baseline[file] || {}), ...Object.keys(counts[file] || {})])) {
        const was = (baseline[file] && baseline[file][code]) || 0;
        const now = (counts[file] && counts[file][code]) || 0;
        if (now > was) {
            added.push(`${file} ${code}: ${was} -> ${now}`);
        } else if (now < was) {
            removed.push(`${file} ${code}: ${was} -> ${now}`);
        }
    }
}

console.log(`${tsconfig}: ${total} errors${only ? ` under ${only}` : ''} (baseline ${baselineFile}).`);
if (added.length) {
    console.error(`\nNew type errors (fix them; the baseline only shrinks):\n  ${added.sort().join('\n  ')}`);
    console.error(`\nRun \`npx tsc --noEmit -p ${tsconfig}\` and look at the files above.`);
}
if (removed.length) {
    const log = added.length ? console.error : console.log;
    log(`\nErrors fixed since the baseline:\n  ${removed.sort().join('\n  ')}`);
    log(`\nLower the baseline: node build/typecheck-baseline.js ${tsconfig} ${baselineFile}${onlyArgs} --update`);
}
process.exit(added.length || removed.length ? 1 : 0);
