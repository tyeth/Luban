import { strict as assert } from 'assert';

import {
    BACKOFF_MM,
    CIRCLE_COARSE_STEP_MM,
    COARSE_STEP_MM,
    CONFIRM_PASSES,
    FINE_STEP_MM,
    GPIO_SENSOR_DELAY_MS,
    RELEASE_TIMEOUT_MIN_MS,
    SENSOR_DELAY_MS,
    SURVEY_PITCH_MM,
    TOOL_SETTER_BACKOFF_MM,
    TOOL_SETTER_RELEASE_TIMEOUT_MIN_MS,
    clampCount,
    clampTo,
    releaseTimeoutFor,
    resolveMarchParams,
    within,
} from '../procedureLimits';

export const tests: Array<[string, () => void]> = [
    ['clampTo keeps the planners\' idiom: absent, non-numeric and zero all mean the default, then min/max', () => {
        assert.equal(clampTo(undefined, SURVEY_PITCH_MM), 80);
        assert.equal(clampTo('abc', SURVEY_PITCH_MM), 80);
        assert.equal(clampTo(0, SURVEY_PITCH_MM), 80);
        assert.equal(clampTo(5, SURVEY_PITCH_MM), 20);
        assert.equal(clampTo(1000, SURVEY_PITCH_MM), 160);
        assert.equal(clampTo('40', SURVEY_PITCH_MM), 40);
    }],

    ['clampCount rounds before it clamps', () => {
        assert.equal(clampCount(2.6, CONFIRM_PASSES), 3);
        assert.equal(clampCount(99, CONFIRM_PASSES), 10);
        assert.equal(clampCount(undefined, CONFIRM_PASSES), 3);
    }],

    ['within is a refusal-style check, inclusive at both ends and false for NaN', () => {
        assert.equal(within(1, { min: 1, max: 150 }), true);
        assert.equal(within(150, { min: 1, max: 150 }), true);
        assert.equal(within(150.001, { min: 1, max: 150 }), false);
        assert.equal(within(Number.NaN, { min: 1, max: 150 }), false);
    }],

    ['the shared march defaults are the ones every planner had inline', () => {
        assert.deepEqual(resolveMarchParams({}), {
            coarseStepMm: 1,
            fineStepMm: 0.1,
            backoffMm: 1,
            sensorDelayMs: 300,
            confirmPasses: 3,
        });
    }],

    ['operator law 2026-09-05: no planner may take a 2 mm coarse step, probe_circle included', () => {
        assert.equal(resolveMarchParams({ coarse_step_mm: 2 }).coarseStepMm, 1);
        assert.equal(resolveMarchParams({ coarse_step_mm: 2 }, { coarse: CIRCLE_COARSE_STEP_MM }).coarseStepMm, 1);
        assert.equal(COARSE_STEP_MM.max, 1);
        assert.equal(CIRCLE_COARSE_STEP_MM.default, 0.5, 'the circle keeps its own default');
    }],

    ['the backoff never drops below the fine step actually in use', () => {
        // fine asked at 0.4: the backoff floor follows it, whatever was asked.
        assert.equal(resolveMarchParams({ fine_step_mm: 0.4, backoff_mm: 0.1 }).backoffMm, 0.4);
        // fine asked at 5 is clamped to 0.5, and the backoff floors at the CLAMPED value.
        assert.equal(resolveMarchParams({ fine_step_mm: 5, backoff_mm: 0.1 }).backoffMm, FINE_STEP_MM.max);
        assert.equal(resolveMarchParams({ backoff_mm: 10 }).backoffMm, BACKOFF_MM.max);
        assert.equal(resolveMarchParams({}, { backoff: TOOL_SETTER_BACKOFF_MM }).backoffMm, 0.3);
    }],

    ['a planner\'s stated variation applies to that one parameter only', () => {
        const gpio = resolveMarchParams({ sensor_delay_ms: 30 }, { delay: GPIO_SENSOR_DELAY_MS });
        assert.equal(gpio.sensorDelayMs, 30, 'the GPIO transport may run at its 30 ms floor');
        assert.equal(resolveMarchParams({ sensor_delay_ms: 30 }).sensorDelayMs, SENSOR_DELAY_MS.min, 'the others keep the 100 ms floor');
        assert.equal(gpio.coarseStepMm, 1, 'everything else stays shared');
    }],

    ['the release timeout is four sensor delays, never shorter than the observed latency floor', () => {
        assert.equal(releaseTimeoutFor(300), RELEASE_TIMEOUT_MIN_MS);
        assert.equal(releaseTimeoutFor(2000), 8000);
        assert.equal(releaseTimeoutFor(200, TOOL_SETTER_RELEASE_TIMEOUT_MIN_MS), TOOL_SETTER_RELEASE_TIMEOUT_MIN_MS);
    }],
];
