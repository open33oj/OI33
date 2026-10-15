// Pure blind-box rules: input normalisation, probability validation and the
// weighted roll. Deliberately free of hydrooj / database imports so the maths
// and every error message can be unit-tested.

import type { Oi33BlindboxItem } from './types';

// Every account may buy this many boxes per calendar day (Asia/Shanghai),
// counted across all pools.
export const BLINDBOX_DAILY_LIMIT = 3;
// A pool holds at most this many medals, and probabilities always total 100.
export const BLINDBOX_MAX_ITEMS = 10;
export const BLINDBOX_PROBABILITY_TOTAL = 100;
export const BLINDBOX_NAME_MAX = 40;
export const BLINDBOX_PRICE_MAX = 1_000_000;

const SHANGHAI_DAY = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

// 'YYYY-MM-DD' of the Asia/Shanghai calendar day a moment belongs to. The daily
// purchase quota resets on this key, not on the server's local midnight.
export function blindboxDayKey(now: Date = new Date()): string {
    return SHANGHAI_DAY.format(now);
}

const SHANGHAI_INPUT = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

// Value for an `<input type="datetime-local">`: the Asia/Shanghai wall clock
// (matching normalizeBlindboxOpenAt, which reads such a value back as +08:00).
export function blindboxOpenAtInputValue(date: Date): string {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const parts = SHANGHAI_INPUT.formatToParts(date);
    const get = (type: string) => parts.find((part) => part.type === type)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function normalizeBlindboxName(raw: unknown): string {
    return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, BLINDBOX_NAME_MAX);
}

export function normalizeBlindboxPrice(raw: unknown): number | null {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > BLINDBOX_PRICE_MAX) return null;
    return value;
}

export function normalizeBlindboxOpenAt(raw: unknown): Date | null {
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        const fromNumber = new Date(raw);
        return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
    }
    const text = String(raw ?? '').trim();
    if (!text) return null;
    // Accept both `2026-10-15T20:00` (datetime-local) and ISO strings with a
    // timezone. A bare local-looking value is read as Asia/Shanghai (+08:00).
    const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text) ? `${text}+08:00` : text;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
}

// Rows come from the admin form: `medalId_<i>` + `probability_<i>`. Rows without
// a medal are dropped, duplicates keep the first entry, and every weight must be
// a positive integer.
export function normalizeBlindboxItems(raw: unknown): Oi33BlindboxItem[] {
    const rows = Array.isArray(raw) ? raw : [];
    const items: Oi33BlindboxItem[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        const medalId = String((row as any)?.medalId ?? '').trim();
        if (!medalId || seen.has(medalId)) continue;
        const probability = Number((row as any)?.probability);
        if (!Number.isSafeInteger(probability) || probability < 1 || probability > BLINDBOX_PROBABILITY_TOTAL) continue;
        seen.add(medalId);
        items.push({ medalId, probability });
        if (items.length >= BLINDBOX_MAX_ITEMS) break;
    }
    return items;
}

export function blindboxItemsSum(items: Oi33BlindboxItem[]): number {
    return items.reduce((sum, item) => sum + (Number(item.probability) || 0), 0);
}

// `null` when the pool is valid, otherwise the message shown to the admin.
export function validateBlindboxItems(items: Oi33BlindboxItem[]): string | null {
    if (!items.length) return '至少要选择一个奖章。';
    if (items.length > BLINDBOX_MAX_ITEMS) return `一组奖章最多 ${BLINDBOX_MAX_ITEMS} 个。`;
    const sum = blindboxItemsSum(items);
    if (sum !== BLINDBOX_PROBABILITY_TOTAL) {
        return `所有奖章的出现几率之和必须等于 ${BLINDBOX_PROBABILITY_TOTAL}，当前为 ${sum}。`;
    }
    return null;
}

// Weighted roll. `roll` must be in [0, sum(items)) — callers pass
// `Math.floor(Math.random() * sum)` so the weights (out of 100) are honoured
// even when owned medals were filtered out and the remaining weights no longer
// total 100.
export function pickBlindboxMedal(items: Oi33BlindboxItem[], roll: number): string | null {
    let acc = 0;
    for (const item of items) {
        acc += Number(item.probability) || 0;
        if (roll < acc) return item.medalId;
    }
    return items.length ? items[items.length - 1].medalId : null;
}
