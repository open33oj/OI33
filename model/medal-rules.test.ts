import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    medalAwardView, medalCategoryOf, medalDisplayRung, medalIsLevelSeries, medalLevelOf,
    medalSortedLevels, medalThresholdLevel,
} from './medal-rules.ts';

const level = (lvl: number, threshold?: number, extra: Record<string, any> = {}) => ({
    level: lvl, name: `Lv${lvl}`, description: `d${lvl}`, ...(threshold ? { threshold } : {}), ...extra,
});

test('medalCategoryOf derives the four families', () => {
    assert.equal(medalCategoryOf({ ruleType: 'certification' }), 'certification');
    assert.equal(medalCategoryOf({ saleable: true }), 'saleable');
    assert.equal(medalCategoryOf({ ruleType: 'accepted_problems' }), 'oj');
    assert.equal(medalCategoryOf({ ruleType: 'checkin_total' }), 'oj');
    assert.equal(medalCategoryOf({ ruleType: 'manual' }), 'manual');
    assert.equal(medalCategoryOf({}), 'manual');
    // certification is checked before saleable, so it cannot be sold as a normal medal
    assert.equal(medalCategoryOf({ ruleType: 'certification', saleable: true }), 'certification');
    // saleable wins over an automatic rule: one medal cannot be both
    assert.equal(medalCategoryOf({ ruleType: 'accepted_problems', saleable: true }), 'saleable');
});

test('medalSortedLevels sorts ascending and tolerates a missing ladder', () => {
    assert.deepEqual(medalSortedLevels({ levels: [level(3), level(1), level(2)] }).map((l) => l.level), [1, 2, 3]);
    assert.deepEqual(medalSortedLevels({}), []);
    assert.deepEqual(medalSortedLevels(null), []);
    // does not mutate the input array
    const medal = { levels: [level(2), level(1)] };
    medalSortedLevels(medal);
    assert.deepEqual(medal.levels.map((l) => l.level), [2, 1]);
});

test('medalLevelOf is a strict lookup used by write paths', () => {
    const medal = { levels: [level(1), level(2), level(3)] };
    assert.equal(medalLevelOf(medal, 2)?.level, 2);
    assert.equal(medalLevelOf(medal, 9), null);
    assert.equal(medalLevelOf(medal, undefined)?.level, 3);
    assert.equal(medalLevelOf({ levels: [] }, 1), null);
});

test('medalDisplayRung falls back to the closest surviving rung', () => {
    const medal = { levels: [level(1), level(3), level(5)] };
    assert.equal(medalDisplayRung(medal, 3)?.level, 3);
    // 4 was removed from the ladder: show the highest rung at or below it
    assert.equal(medalDisplayRung(medal, 4)?.level, 3);
    // below the lowest rung: show the lowest
    assert.equal(medalDisplayRung(medal, 1)?.level, 1);
    assert.equal(medalDisplayRung({ levels: [level(2)] }, 0)?.level, 2);
    assert.equal(medalDisplayRung({ levels: [] }, 1), null);
});

test('medalIsLevelSeries requires a leveled family with a ladder', () => {
    assert.equal(medalIsLevelSeries({ ruleType: 'certification', levels: [level(1)] }), true);
    assert.equal(medalIsLevelSeries({ ruleType: 'accepted_problems', levels: [level(1)] }), true);
    assert.equal(medalIsLevelSeries({ ruleType: 'certification', levels: [] }), false);
    assert.equal(medalIsLevelSeries({ levels: [level(1)] }), false);
});

test('medalThresholdLevel picks the highest rung whose threshold is met', () => {
    const medal = { levels: [level(1, 10), level(2, 100), level(3, 1000)] };
    assert.equal(medalThresholdLevel(medal, 5), null);
    assert.equal(medalThresholdLevel(medal, 10)?.level, 1);
    assert.equal(medalThresholdLevel(medal, 999)?.level, 2);
    assert.equal(medalThresholdLevel(medal, 100000)?.level, 3);
    // non-positive/absent thresholds are skipped instead of matching everything
    assert.equal(medalThresholdLevel({ levels: [level(1), level(2, 0), level(3, -5)] }, 1e9), null);
});

test('medalAwardView renders a legacy or removed rung instead of a blank medal', () => {
    const series = {
        _id: 'ac', name: '题海', description: 'series', imageData: 'series-img', imageSize: 32,
        ruleType: 'accepted_problems',
        levels: [level(1, 10, { name: '青铜', description: 'b', imageData: 'img1' }), level(2, 100, { name: '白银', imageData: 'img2' })],
    };
    // Legacy award with no recorded level: render the lowest rung, not the top one.
    const legacy = medalAwardView({}, series);
    assert.equal(legacy.level, 1);
    assert.equal(legacy.displayLevel, 1);
    assert.equal(legacy.name, '题海 · 青铜');
    assert.equal(legacy.imageData, 'img1');
    assert.equal(legacy.levelCount, 2);
    // Award holding a rung that no longer exists on the ladder.
    const removed = medalAwardView({ level: 2 }, { ...series, levels: [level(1, 10, { name: '青铜' })] });
    assert.equal(removed.level, 2);
    assert.equal(removed.levelMissing, true);
    assert.equal(removed.displayLevel, 1);
    // A plain (non-leveled) medal falls back to the definition itself.
    const plain = medalAwardView({}, { name: '参与奖', description: 'thanks', ruleType: 'manual' });
    assert.equal(plain.leveled, false);
    assert.equal(plain.level, null);
    assert.equal(plain.name, '参与奖');
});
