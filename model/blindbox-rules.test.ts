import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    BLINDBOX_DAILY_LIMIT, BLINDBOX_MAX_ITEMS, blindboxDayKey, blindboxItemsSum,
    blindboxOpenAtInputValue, normalizeBlindboxItems, normalizeBlindboxName,
    normalizeBlindboxOpenAt, normalizeBlindboxPrice, pickBlindboxMedal, validateBlindboxItems,
} from './blindbox-rules.ts';

test('blindboxDayKey uses the Asia/Shanghai calendar day', () => {
    // 17:00 UTC is already the next day in Shanghai.
    assert.equal(blindboxDayKey(new Date('2026-10-15T17:00:00Z')), '2026-10-16');
    assert.equal(blindboxDayKey(new Date('2026-10-15T10:00:00Z')), '2026-10-15');
});

test('normalizeBlindboxOpenAt reads datetime-local as +08:00', () => {
    const local = normalizeBlindboxOpenAt('2026-10-15T20:00')!;
    assert.equal(local.toISOString(), '2026-10-15T12:00:00.000Z');
    assert.equal(normalizeBlindboxOpenAt('2026-10-15T12:00:00Z')!.toISOString(), '2026-10-15T12:00:00.000Z');
    assert.equal(normalizeBlindboxOpenAt(''), null);
    assert.equal(normalizeBlindboxOpenAt('not a date'), null);
});

test('blindboxOpenAtInputValue round-trips through normalizeBlindboxOpenAt', () => {
    const date = new Date('2026-10-15T12:34:00Z');
    const text = blindboxOpenAtInputValue(date);
    assert.equal(text, '2026-10-15T20:34');
    assert.equal(normalizeBlindboxOpenAt(text)!.getTime(), date.getTime());
});

test('normalizeBlindboxName collapses whitespace and caps the length', () => {
    assert.equal(normalizeBlindboxName('  猫猫   盲盒  '), '猫猫 盲盒');
    assert.equal(normalizeBlindboxName('x'.repeat(60)).length, 40);
});

test('normalizeBlindboxPrice only accepts positive integers', () => {
    assert.equal(normalizeBlindboxPrice('12'), 12);
    assert.equal(normalizeBlindboxPrice(1), 1);
    assert.equal(normalizeBlindboxPrice(0), null);
    assert.equal(normalizeBlindboxPrice(-3), null);
    assert.equal(normalizeBlindboxPrice('1.5'), null);
    assert.equal(normalizeBlindboxPrice('abc'), null);
});

test('normalizeBlindboxItems drops empty rows, duplicates and bad weights', () => {
    const items = normalizeBlindboxItems([
        { medalId: 'a', probability: '30' },
        { medalId: '', probability: '70' },
        { medalId: 'a', probability: '10' },
        { medalId: 'b', probability: '0' },
        { medalId: 'c', probability: '70' },
    ]);
    assert.deepEqual(items, [{ medalId: 'a', probability: 30 }, { medalId: 'c', probability: 70 }]);
    assert.equal(blindboxItemsSum(items), 100);
    assert.equal(validateBlindboxItems(items), null);
});

test('normalizeBlindboxItems never returns more than the cap', () => {
    const rows = Array.from({ length: BLINDBOX_MAX_ITEMS + 5 }, (_, i) => ({ medalId: `m${i}`, probability: 1 }));
    assert.equal(normalizeBlindboxItems(rows).length, BLINDBOX_MAX_ITEMS);
});

test('validateBlindboxItems requires a 100 total and at least one medal', () => {
    assert.match(validateBlindboxItems([])!, /至少/);
    assert.match(validateBlindboxItems([{ medalId: 'a', probability: 60 }])!, /100/);
    assert.equal(validateBlindboxItems([
        { medalId: 'a', probability: 99 }, { medalId: 'b', probability: 1 },
    ]), null);
});

test('pickBlindboxMedal honours the configured weights', () => {
    const items = [
        { medalId: 'rare', probability: 5 },
        { medalId: 'common', probability: 95 },
    ];
    assert.equal(pickBlindboxMedal(items, 0), 'rare');
    assert.equal(pickBlindboxMedal(items, 4), 'rare');
    assert.equal(pickBlindboxMedal(items, 5), 'common');
    assert.equal(pickBlindboxMedal(items, 99), 'common');
    // Owned medals are filtered out before the roll, so the weights may not
    // total 100 any more — the relative ratio still holds.
    assert.equal(pickBlindboxMedal([{ medalId: 'only', probability: 30 }], 7), 'only');
    assert.equal(pickBlindboxMedal([], 0), null);
});

test('the daily limit is three boxes', () => {
    assert.equal(BLINDBOX_DAILY_LIMIT, 3);
});
