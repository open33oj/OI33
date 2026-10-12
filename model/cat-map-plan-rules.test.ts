import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CAT_MAP_HEIGHT, CAT_MAP_PLAN_MAX_STEPS_DEFAULT, CAT_MAP_PLAN_MAX_STEPS_LIMIT,
    CAT_MAP_WIDTH, normalizeCatMapPlanMaxSteps, validColor, validCoordinate,
    validateCatMapPlanShape,
} from './cat-map-plan-rules.ts';

test('validCoordinate only accepts integers inside the grid', () => {
    assert.equal(validCoordinate(0, 0), true);
    assert.equal(validCoordinate(CAT_MAP_WIDTH - 1, CAT_MAP_HEIGHT - 1), true);
    assert.equal(validCoordinate(CAT_MAP_WIDTH, 0), false);
    assert.equal(validCoordinate(0, CAT_MAP_HEIGHT), false);
    assert.equal(validCoordinate(-1, 0), false);
    assert.equal(validCoordinate(1.5, 2), false);
    assert.equal(validCoordinate(NaN, 0), false);
});

test('validColor only accepts 0..255 integers', () => {
    assert.equal(validColor(0), true);
    assert.equal(validColor(255), true);
    assert.equal(validColor(256), false);
    assert.equal(validColor(-1), false);
    assert.equal(validColor(1.5), false);
});

test('normalizeCatMapPlanMaxSteps clamps to the configured range', () => {
    assert.equal(normalizeCatMapPlanMaxSteps(undefined), CAT_MAP_PLAN_MAX_STEPS_DEFAULT);
    assert.equal(normalizeCatMapPlanMaxSteps(0), CAT_MAP_PLAN_MAX_STEPS_DEFAULT);
    assert.equal(normalizeCatMapPlanMaxSteps(-5), CAT_MAP_PLAN_MAX_STEPS_DEFAULT);
    assert.equal(normalizeCatMapPlanMaxSteps('nope'), CAT_MAP_PLAN_MAX_STEPS_DEFAULT);
    assert.equal(normalizeCatMapPlanMaxSteps(3), 3);
    assert.equal(normalizeCatMapPlanMaxSteps('3'), 3);
    assert.equal(normalizeCatMapPlanMaxSteps(2.9), 2);
    assert.equal(normalizeCatMapPlanMaxSteps(CAT_MAP_PLAN_MAX_STEPS_LIMIT), CAT_MAP_PLAN_MAX_STEPS_LIMIT);
    assert.equal(normalizeCatMapPlanMaxSteps(CAT_MAP_PLAN_MAX_STEPS_LIMIT + 1), CAT_MAP_PLAN_MAX_STEPS_LIMIT);
});

test('validateCatMapPlanShape accepts a connected path and coerces number-like input', () => {
    const base = { x: 4, y: 5 };
    assert.deepEqual(
        validateCatMapPlanShape([{ x: 5, y: 5, color: 0 }, { x: 5, y: 6, color: 255 }], base),
        [{ x: 5, y: 5, color: 0 }, { x: 5, y: 6, color: 255 }],
    );
    // Form values arrive as strings; they must be coerced.
    assert.deepEqual(
        validateCatMapPlanShape([{ x: '5', y: '5', color: '3' }], base),
        [{ x: 5, y: 5, color: 3 }],
    );
});

test('validateCatMapPlanShape rejects a disconnected path', () => {
    const base = { x: 4, y: 5 };
    // First step is not adjacent to the cat.
    assert.throws(() => validateCatMapPlanShape([{ x: 7, y: 5, color: 0 }], base), /必须与上一步相邻/);
    // Second step is diagonal (Manhattan distance 2).
    assert.throws(
        () => validateCatMapPlanShape([{ x: 5, y: 5, color: 0 }, { x: 6, y: 6, color: 0 }], base),
        /必须与上一步相邻/,
    );
    // Revisiting the starting cell is fine, but a two-cell jump is not.
    assert.throws(
        () => validateCatMapPlanShape([{ x: 5, y: 5, color: 0 }, { x: 5, y: 7, color: 0 }], base),
        /必须与上一步相邻/,
    );
});

test('validateCatMapPlanShape rejects bad counts, coordinates and colors', () => {
    const base = { x: 0, y: 0 };
    assert.throws(() => validateCatMapPlanShape([], base), /至少需要 1 步/);
    assert.throws(() => validateCatMapPlanShape('nope', base), /至少需要 1 步/);
    assert.throws(() => validateCatMapPlanShape([{ x: 1, y: 0, color: 0 }], base, 0), /最多 0 步/);
    assert.throws(() => validateCatMapPlanShape([{ x: CAT_MAP_WIDTH, y: 0, color: 0 }], { x: CAT_MAP_WIDTH - 1, y: 0 }), /坐标超出地图范围/);
    assert.throws(() => validateCatMapPlanShape([{ x: 1, y: 0, color: 256 }], base), /颜色码/);
    assert.throws(() => validateCatMapPlanShape([{ x: 1, y: 0, color: 1.5 }], base), /颜色码/);
});
