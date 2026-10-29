import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    WILD_CAT_NEW_CELL_COLOR, WILD_CAT_SLOT_MS, nextWildCatSlot, wildCatBlocksManualMove, wildCatSlotStart,
} from './wildcat-rules.ts';

test('wildcat slots start on Asia/Shanghai even hours', () => {
    // 13:55 上海时间 = 05:55Z，当前槽位是 12:00 上海时间 = 04:00Z。
    assert.equal(
        wildCatSlotStart(new Date('2026-10-28T05:55:33Z')).toISOString(),
        '2026-10-28T04:00:00.000Z',
    );
    // 14:00 上海时间 = 06:00Z。
    assert.equal(
        wildCatSlotStart(new Date('2026-10-28T06:00:00Z')).toISOString(),
        '2026-10-28T06:00:00.000Z',
    );
});

test('wildcat slots wrap over midnight in Shanghai time', () => {
    // 23:30 上海时间 = 15:30Z，当前槽位是 22:00 上海时间 = 14:00Z。
    assert.equal(
        wildCatSlotStart(new Date('2026-10-28T15:30:00Z')).toISOString(),
        '2026-10-28T14:00:00.000Z',
    );
    // 次日 00:30 上海时间 = 前一日 16:30Z，槽位是 00:00 上海时间 = 16:00Z。
    assert.equal(
        wildCatSlotStart(new Date('2026-10-27T16:30:00Z')).toISOString(),
        '2026-10-27T16:00:00.000Z',
    );
});

test('nextWildCatSlot is the next even hour strictly after now', () => {
    // 13:59 上海时间 -> 14:00 上海时间（06:00Z）。
    assert.equal(
        nextWildCatSlot(new Date('2026-10-28T05:59:59.999Z')).toISOString(),
        '2026-10-28T06:00:00.000Z',
    );
    // 正好 14:00 开启 -> 等到 16:00 上海时间（08:00Z）。
    assert.equal(
        nextWildCatSlot(new Date('2026-10-28T06:00:00.000Z')).toISOString(),
        '2026-10-28T08:00:00.000Z',
    );
    assert.equal(
        nextWildCatSlot(new Date('2026-10-28T15:30:00Z')).toISOString(),
        '2026-10-28T16:00:00.000Z',
    );
});

test('wildcat constants keep the two-hour rhythm and white paint color', () => {
    assert.equal(WILD_CAT_SLOT_MS, 2 * 60 * 60 * 1000);
    assert.equal(WILD_CAT_NEW_CELL_COLOR, 15);
});

test('wildCatBlocksManualMove only blocks manual movement while wildcat is on', () => {
    assert.equal(wildCatBlocksManualMove(true, 'manual'), true);
    assert.equal(wildCatBlocksManualMove(true), true);
    assert.equal(wildCatBlocksManualMove(true, 'plan'), false);
    assert.equal(wildCatBlocksManualMove(true, 'wildcat'), false);
    assert.equal(wildCatBlocksManualMove(false, 'manual'), false);
    assert.equal(wildCatBlocksManualMove(undefined, 'manual'), false);
});
