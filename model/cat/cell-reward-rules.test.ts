import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CAT_CELL_REWARD_MIN_CELLS, catCellRewardCans, cellRewardMonthKey, previousCellRewardMonth,
} from './cell-reward-rules.ts';

test('catCellRewardCans pays nothing below 100 cells', () => {
    assert.equal(CAT_CELL_REWARD_MIN_CELLS, 100);
    assert.equal(catCellRewardCans(0), 0);
    assert.equal(catCellRewardCans(99), 0);
    assert.equal(catCellRewardCans(-5), 0);
});

test('catCellRewardCans doubles the threshold for each extra can', () => {
    assert.equal(catCellRewardCans(100), 1);
    assert.equal(catCellRewardCans(199), 1);
    assert.equal(catCellRewardCans(200), 2);
    assert.equal(catCellRewardCans(399), 2);
    assert.equal(catCellRewardCans(400), 3);
    assert.equal(catCellRewardCans(799), 3);
    assert.equal(catCellRewardCans(800), 4);
    assert.equal(catCellRewardCans(1600), 5);
});

test('reward months follow Asia/Shanghai natural months', () => {
    assert.equal(cellRewardMonthKey(new Date('2026-01-15T00:00:00Z')), '2026-01');
    assert.equal(previousCellRewardMonth(new Date('2026-01-15T00:00:00Z')), '2025-12');
    assert.equal(previousCellRewardMonth(new Date('2026-03-01T00:00:00Z')), '2026-02');
    // 2026-01-31T16:30Z = 2026-02-01 00:30 上海时间
    assert.equal(cellRewardMonthKey(new Date('2026-01-31T16:30:00Z')), '2026-02');
    assert.equal(previousCellRewardMonth(new Date('2026-01-31T16:30:00Z')), '2026-01');
});
