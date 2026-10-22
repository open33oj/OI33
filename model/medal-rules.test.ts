import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    AUTOMATIC_RULE_TYPES, MEDAL_AUTOMATIC_SERIES,
    MEDAL_SHOWCASE_CELL, MEDAL_SHOWCASE_COLUMNS, MEDAL_SHOWCASE_HEIGHT,
    MEDAL_SHOWCASE_MAX_PIECES, MEDAL_SHOWCASE_MAX_SCALE, MEDAL_SHOWCASE_ROWS, MEDAL_SHOWCASE_SNAP,
    MEDAL_SHOWCASE_WIDTH, medalAutomaticRuleText, medalAwardView, medalCategoryOf, medalDisplayRung, medalIsLevelSeries,
    medalLevelLabel, medalLevelOf, medalShowcaseCopyLimit, medalShowcasePieces, medalShowcaseScale,
    medalShowcaseTrim, medalSortedLevels, medalStarLevel, medalThresholdLevel, medalView,
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

test('special_medals is a first-class automatic (OJ) indicator', () => {
    assert.ok(AUTOMATIC_RULE_TYPES.includes('special_medals'));
    assert.equal(MEDAL_AUTOMATIC_SERIES.special_medals.id, 'special');
    // 新指标属于 OJ 系列，否则会被当成一般奖章
    assert.equal(medalCategoryOf({ ruleType: 'special_medals' }), 'oj');
    assert.match(medalAutomaticRuleText('special_medals', 5), /特殊奖章/);
    assert.match(medalAutomaticRuleText('special_medals', 5), /5/);
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

test('medalStarLevel maps duplicate counts to stars', () => {
    assert.equal(medalStarLevel(0), 0);
    assert.equal(medalStarLevel(1), 0);
    assert.equal(medalStarLevel(2), 1);
    assert.equal(medalStarLevel(3), 1);
    assert.equal(medalStarLevel(4), 2);
    assert.equal(medalStarLevel(7), 2);
    assert.equal(medalStarLevel(8), 3);
    assert.equal(medalStarLevel(15), 3);
    assert.equal(medalStarLevel(16), 4);
    assert.equal(medalStarLevel(undefined), 0);
});

test('medalLevelLabel drops the legacy Lv.N prefix', () => {
    assert.equal(medalLevelLabel({ level: 1, name: '一等奖' }), '一等奖');
    assert.equal(medalLevelLabel({ level: 2, name: 'Lv.2 二等奖' }), '二等奖');
    assert.equal(medalLevelLabel({ level: 3, name: 'lv3' }), '第 3 级');
    assert.equal(medalLevelLabel({ level: 4, name: '' }), '第 4 级');
    assert.equal(medalLevelLabel({ level: 5 }), '第 5 级');
});

test('medalAwardView reports count and stars for 一般奖章', () => {
    const medal = { _id: 'm', name: '银猫', ruleType: 'manual' };
    const once = medalAwardView({ medalId: 'm', count: 1 }, medal);
    assert.equal(once.category, 'manual');
    assert.equal(once.count, 1);
    assert.equal(once.stars, 0);
    const many = medalAwardView({ medalId: 'm', count: 6 }, medal);
    assert.equal(many.count, 6);
    assert.equal(many.stars, 2);
    // 其它系列永远只有一枚，星级恒为 0
    const oj = medalAwardView({ medalId: 'o', count: 9 }, { _id: 'o', name: 'AC', ruleType: 'accepted_problems' });
    assert.equal(oj.count, 1);
    assert.equal(oj.stars, 0);
});

test('medalView adds a label to every rung', () => {
    const view = medalView({
        _id: 'c',
        name: '认证',
        ruleType: 'certification',
        levels: [
            { level: 2, name: 'Lv.2 银' },
            { level: 1, name: '铜' },
            { level: 3, name: 'Lv.3' },
        ],
    });
    // 阶梯一律按 level 升序，且每级都带上去掉 Lv. 前缀的显示名
    assert.deepEqual(view.levels.map((item: any) => item.level), [1, 2, 3]);
    assert.deepEqual(view.levels.map((item: any) => item.label), ['铜', '银', '第 3 级']);
});

test('the wall is a uniform 10×4 grid of 32 px cells', () => {
    assert.equal(MEDAL_SHOWCASE_CELL, 32);
    assert.equal(MEDAL_SHOWCASE_COLUMNS, 10);
    assert.equal(MEDAL_SHOWCASE_ROWS, 4);
    assert.equal(MEDAL_SHOWCASE_WIDTH, 320);
    assert.equal(MEDAL_SHOWCASE_HEIGHT, 128);
    // 半格对齐：16 px
    assert.equal(MEDAL_SHOWCASE_SNAP, 16);
    assert.equal(MEDAL_SHOWCASE_MAX_PIECES, 40);
});

test('medalShowcasePieces lays legacy slot arrays onto the 10-column grid', () => {
    // 旧数据的 id/null 槽位：按原顺序排成 10 列，空洞保留位置
    assert.deepEqual(medalShowcasePieces(['a', null, 'b']), [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 64, y: 0 },
    ]);
    const cols = Array.from({ length: 11 }, (_, i) => `m${i}`);
    const placed = medalShowcasePieces(cols);
    // 前 10 个在第一行，第 11 个换到第二行
    assert.deepEqual(placed.slice(0, 10).map((piece) => piece.x), [0, 32, 64, 96, 128, 160, 192, 224, 256, 288]);
    assert.deepEqual(placed.slice(0, 10).map((piece) => piece.y), Array(10).fill(0));
    assert.deepEqual(placed[10], { id: 'm10', x: 0, y: 32 });
    assert.deepEqual(medalShowcasePieces(undefined), []);
    assert.deepEqual(medalShowcasePieces('nope'), []);
});

test('medalShowcasePieces clamps free positions to the 320×128 canvas', () => {
    const pieces = medalShowcasePieces([
        { id: 'big', x: -5, y: 200 },
        { id: 'small', x: 999, y: 3.6 },
    ]);
    // 所有奖章统一 32 px，右/下边界最多 192-32 / 96-32；小数坐标四舍五入
    assert.deepEqual(pieces, [
        { id: 'big', x: 0, y: MEDAL_SHOWCASE_HEIGHT - MEDAL_SHOWCASE_CELL },
        { id: 'small', x: MEDAL_SHOWCASE_WIDTH - MEDAL_SHOWCASE_CELL, y: 4 },
    ]);
    assert.deepEqual(medalShowcasePieces([]), []);
});

test('medalShowcasePieces caps the wall at 10×4 placements', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, x: 0, y: 0 }));
    assert.equal(medalShowcasePieces(many).length, MEDAL_SHOWCASE_MAX_PIECES);
});

test('medalShowcaseCopyLimit lets 一般奖章 repeat by star level', () => {
    // 只有一枚（0 星）仍然可以摆 1 份；星级就是可摆的份数
    assert.equal(medalShowcaseCopyLimit({ category: 'manual', stars: 0 }), 1);
    assert.equal(medalShowcaseCopyLimit({ category: 'manual', stars: 1 }), 1);
    assert.equal(medalShowcaseCopyLimit({ category: 'manual', stars: 2 }), 2);
    assert.equal(medalShowcaseCopyLimit({ category: 'manual', stars: 3 }), 3);
    // 其它系列固定 1 份
    assert.equal(medalShowcaseCopyLimit({ category: 'oj', stars: 0 }), 1);
    assert.equal(medalShowcaseCopyLimit({ category: 'certification' }), 1);
    assert.equal(medalShowcaseCopyLimit({ category: 'saleable' }), 1);
    assert.equal(medalShowcaseCopyLimit(undefined), 1);
    // 不会超过 6×3 的摆放总数
    assert.equal(medalShowcaseCopyLimit({ category: 'manual', stars: 99 }), MEDAL_SHOWCASE_MAX_PIECES);
});

test('medalShowcaseTrim keeps only the allowed copies', () => {
    const limit = (id: string) => ({ m1: 2, m2: 1 } as Record<string, number>)[id] || 0;
    const pieces = [
        { id: 'm1', x: 0, y: 0 },
        { id: 'm2', x: 32, y: 0 },
        { id: 'm1', x: 64, y: 0 },
        { id: 'm1', x: 96, y: 0 },
        { id: 'm3', x: 128, y: 0 },
    ];
    // 第三份 m1 与已不持有的 m3 被丢弃，其余保持原位置
    assert.deepEqual(medalShowcaseTrim(pieces, limit), [pieces[0], pieces[1], pieces[2]]);
    assert.deepEqual(medalShowcaseTrim([], limit), []);
});

test('medalShowcaseScale only ever returns whole numbers', () => {
    assert.equal(medalShowcaseScale(MEDAL_SHOWCASE_WIDTH), 1);
    assert.equal(medalShowcaseScale(MEDAL_SHOWCASE_WIDTH * 2 - 1), 1);
    assert.equal(medalShowcaseScale(MEDAL_SHOWCASE_WIDTH * 2), 2);
    assert.equal(medalShowcaseScale(760), 2);
    assert.equal(medalShowcaseScale(5000), MEDAL_SHOWCASE_MAX_SCALE);
    assert.equal(medalShowcaseScale(0), 1);
    // 编辑器可以直接抬高最小倍数（小屏时横向滚动），也可以压低最大倍数
    assert.equal(medalShowcaseScale(100, 2, 6), 2);
    assert.equal(medalShowcaseScale(5000, 1, 4), 4);
});
