// Pure homepage side-card rules: the normalizers shared by the admin form, the
// upgrade seed and the homepage patch. No hydrooj/DB imports (types only) so
// this module can be unit-tested with plain `node --test`; model/home-config.ts
// re-exports everything and adds the database access.

import type { Oi33HomeConfig, Oi33HomeCountdownDate, Oi33HomeLuckType } from './types';

export const HOME_CONFIG_ID = 'main';
export const HOME_LUCK_LEVELS = 7;
export const HOME_LUCK_TEXT_MAX = 12;
export const HOME_DATE_NAME_MAX = 40;
export const HOME_COUNTDOWN_TITLE_MAX = 40;
export const HOME_MAX_DATES_LIMIT = 50;
export const HOME_MAX_DATE_ROWS = 100;

// Fallback used for levels the admin leaves blank, and for a fresh install.
export const DEFAULT_HOME_LUCK_TYPE: Oi33HomeLuckType[] = [
    { text: '大吉', color: '#ed5a65' },
    { text: '吉', color: '#ed5a65' },
    { text: '小吉', color: '#ed5a65' },
    { text: '平', color: '#161823' },
    { text: '小凶', color: '#161823' },
    { text: '凶', color: '#161823' },
    { text: '大凶', color: '#161823' },
];

export const DEFAULT_HOME_COUNTDOWN_TITLE = '倒计时';
export const DEFAULT_HOME_MAX_DATES = 5;

const COLOR_RE = /^#[0-9a-f]{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type HomeConfigShape = Omit<Oi33HomeConfig, '_id' | 'updatedAt' | 'updatedBy'>;

export function normalizeHomeColor(raw: unknown, fallback = '#161823'): string {
    const value = String(raw ?? '').trim().toLowerCase();
    const withHash = value.startsWith('#') ? value : `#${value}`;
    return COLOR_RE.test(withHash) ? withHash : fallback;
}

export function normalizeLuckType(raw: unknown): Oi33HomeLuckType[] {
    const rows = Array.isArray(raw) ? raw : [];
    return Array.from({ length: HOME_LUCK_LEVELS }, (_, index) => {
        const row: any = rows[index] || {};
        const fallback = DEFAULT_HOME_LUCK_TYPE[index];
        const text = String(row.text ?? '').trim().slice(0, HOME_LUCK_TEXT_MAX);
        return {
            text: text || fallback.text,
            color: normalizeHomeColor(row.color, fallback.color),
        };
    });
}

// Accepts only a real YYYY-MM-DD (rejects 2026-02-31) and returns '' otherwise.
export function normalizeHomeDate(raw: unknown): string {
    const text = String(raw ?? '').trim();
    if (!DATE_RE.test(text)) return '';
    const [year, month, day] = text.split('-').map(Number);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return '';
    return text;
}

export function normalizeCountdownDates(raw: unknown): Oi33HomeCountdownDate[] {
    const rows = Array.isArray(raw) ? raw : [];
    const out: Oi33HomeCountdownDate[] = [];
    for (const row of rows) {
        const name = String((row as any)?.name ?? '').trim().slice(0, HOME_DATE_NAME_MAX);
        const date = normalizeHomeDate((row as any)?.date);
        if (!name || !date) continue;
        out.push({ name, date });
        if (out.length >= HOME_MAX_DATE_ROWS) break;
    }
    return out;
}

export function normalizeHomeMaxDates(raw: unknown): number {
    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value) || value < 1) return 1;
    return Math.min(value, HOME_MAX_DATES_LIMIT);
}

export function normalizeLuckVip(raw: unknown): number[] {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,，、]+/);
    const out: number[] = [];
    for (const item of list) {
        const uid = Number(String(item).trim());
        if (!Number.isSafeInteger(uid) || uid <= 0 || out.includes(uid)) continue;
        out.push(uid);
        if (out.length >= 200) break;
    }
    return out;
}

export function normalizeCountdownTitle(raw: unknown): string {
    const text = String(raw ?? '').trim().slice(0, HOME_COUNTDOWN_TITLE_MAX);
    return text || DEFAULT_HOME_COUNTDOWN_TITLE;
}

export function normalizeHomeConfig(raw: any): HomeConfigShape {
    const source = raw && typeof raw === 'object' ? raw : {};
    const countdown = source.countdown && typeof source.countdown === 'object' ? source.countdown : {};
    return {
        enabled: source.enabled === undefined ? true : !!source.enabled,
        column: source.column === 'main' ? 'main' : 'sidebar',
        luck_type: normalizeLuckType(source.luck_type),
        luck_vip: normalizeLuckVip(source.luck_vip),
        countdown: {
            title: normalizeCountdownTitle(countdown.title),
            max_dates: normalizeHomeMaxDates(countdown.max_dates ?? DEFAULT_HOME_MAX_DATES),
            dates: normalizeCountdownDates(countdown.dates),
        },
    };
}

export function defaultHomeConfig(): HomeConfigShape {
    return normalizeHomeConfig({ enabled: true, column: 'sidebar' });
}

// A document that was never saved by an admin (updatedBy falsy) is still a pure
// seed, so it can be topped up from the legacy YAML: the card may have been
// created before the YAML gained its countdown dates, or the first import may
// have missed the setting entirely (e.g. the setting service was not readable
// from that code path). Only *missing* pieces are filled — an admin's save
// stamps updatedBy, after which nothing is auto-imported again.
export function fillMissingFromSeed(
    current: HomeConfigShape,
    seed: Partial<HomeConfigShape> | null | undefined,
): { config: HomeConfigShape; changed: boolean } {
    const next: HomeConfigShape = {
        ...current,
        luck_type: current.luck_type.map((row) => ({ ...row })),
        luck_vip: [...current.luck_vip],
        countdown: { ...current.countdown, dates: current.countdown.dates.map((row) => ({ ...row })) },
    };
    if (!seed) return { config: next, changed: false };
    let changed = false;
    const seedDates = normalizeCountdownDates(seed.countdown?.dates);
    if (!next.countdown.dates.length && seedDates.length) {
        next.countdown.dates = seedDates;
        changed = true;
    }
    if (!next.luck_vip.length && seed.luck_vip?.length) {
        next.luck_vip = normalizeLuckVip(seed.luck_vip);
        changed = true;
    }
    const seedLuck = seed.luck_type ? normalizeLuckType(seed.luck_type) : null;
    if (seedLuck
        && JSON.stringify(next.luck_type) === JSON.stringify(DEFAULT_HOME_LUCK_TYPE)
        && JSON.stringify(seedLuck) !== JSON.stringify(DEFAULT_HOME_LUCK_TYPE)) {
        next.luck_type = seedLuck;
        changed = true;
    }
    return { config: next, changed };
}

// Pull the legacy `hydrooj.homepage` payloads (already parsed by js-yaml) into
// a seed document. Returns {} when the YAML never configured the card.
export function legacyHomeConfigFromHomepage(info: unknown): Partial<HomeConfigShape> {
    const columns = Array.isArray(info) ? info : [];
    const seed: Partial<HomeConfigShape> = {};
    for (const column of columns) {
        if (!column || typeof column !== 'object') continue;
        const { checkin, countdown } = column as any;
        const hasCheckin = checkin && typeof checkin === 'object';
        const hasCountdown = countdown && typeof countdown === 'object';
        if (!hasCheckin && !hasCountdown) continue;
        if (hasCheckin) {
            seed.luck_type = normalizeLuckType(checkin.luck_type);
            seed.luck_vip = normalizeLuckVip(checkin.luck_vip);
        }
        if (hasCountdown) {
            seed.countdown = {
                title: normalizeCountdownTitle(countdown.title),
                max_dates: normalizeHomeMaxDates(countdown.max_dates ?? DEFAULT_HOME_MAX_DATES),
                dates: normalizeCountdownDates(countdown.dates),
            };
        }
        seed.enabled = true;
        seed.column = Number((column as any).width) <= 4 ? 'sidebar' : 'main';
    }
    return seed;
}
