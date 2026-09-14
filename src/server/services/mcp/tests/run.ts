/* eslint-disable no-console */
/**
 * Unit tests for the MCP server's PURE modules - the ones with no server
 * imports (validator, envelopeChecks, positionOfRecord, machinePosition, ...).
 *
 *     npm run test:mcp
 *
 * runs this file under ts-node --transpile-only (see package.json). Each
 * *.test.ts exports `tests`: an array of [name, fn] pairs using node's
 * assert. No framework on purpose: the repo's only other runner is tape over
 * legacy JS, and these modules must stay importable without the Luban
 * server (config/settings.base is ESM-only and breaks ts-node).
 */
import { tests as validatorTests } from './validator.test';

type TestCase = [string, () => void];

const suites: Array<[string, TestCase[]]> = [
    ['validator', validatorTests],
];

let passed = 0;
let failed = 0;
for (const [suite, cases] of suites) {
    for (const [name, fn] of cases) {
        try {
            fn();
            passed += 1;
            console.log(`  ok    ${suite} :: ${name}`);
        } catch (err) {
            failed += 1;
            console.log(`  FAIL  ${suite} :: ${name}`);
            console.log(`        ${(err as Error).message.split('\n').join('\n        ')}`);
        }
    }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
