// Runtime side of the per-user shell theme: read the `theme_*` fields from
// `oi33_user`, normalize them once, and cache the result briefly (the nav hook
// renders on every page). Pure color/layout rules live in ./theme-rules.ts.
//
// Colors are stored per scheme (`theme_light_*` / `theme_dark_*`). The old
// single-scheme `theme_*` fields are read as a light-mode fallback so existing
// rows keep working until the user saves the new form.

import { ValidationError } from 'hydrooj';
import type { NavGroupConfig } from './nav-rules';
import { normalizeNavGroups } from './nav-rules';
import { normalizeThemeColor } from './theme-rules';
import type { UserTheme, UserThemeColors } from './theme-rules';
import { addLog } from './log';
import { userColl } from './user';

const CACHE_TTL_MS = 30 * 1000;
const MAX_LINKS_LENGTH = 2000;
const cache = new Map<number, { at: number; theme: UserTheme }>();

function modeFromDoc(doc: any, mode: 'light' | 'dark'): UserThemeColors {
    const pick = (field: string) => {
        const value = doc[`theme_${mode}_${field}`];
        // Only light mode has legacy single-scheme fields to fall back to.
        return value === undefined && mode === 'light' ? doc[`theme_${field}`] : value;
    };
    return {
        pageBg: normalizeThemeColor(pick('page_bg')),
        pageFg: normalizeThemeColor(pick('page_fg')),
        topbarBg: normalizeThemeColor(pick('topbar_bg')),
        topbarFg: normalizeThemeColor(pick('topbar_fg')),
        sidebarBg: normalizeThemeColor(pick('sidebar_bg')),
        sidebarFg: normalizeThemeColor(pick('sidebar_fg')),
        accent: normalizeThemeColor(pick('accent')),
        cardBg: normalizeThemeColor(pick('card_bg')),
        cardFg: normalizeThemeColor(pick('card_fg')),
    };
}

function themeFromDoc(doc: any): UserTheme {
    if (!doc) {
        return {
            light: {}, dark: {}, lightCss: null, darkCss: null, links: null, navGroups: null,
        };
    }
    return {
        light: modeFromDoc(doc, 'light'),
        dark: modeFromDoc(doc, 'dark'),
        lightCss: typeof doc.theme_light_css === 'string' ? doc.theme_light_css : null,
        darkCss: typeof doc.theme_dark_css === 'string' ? doc.theme_dark_css : null,
        links: typeof doc.theme_links === 'string' ? doc.theme_links : null,
        navGroups: Array.isArray(doc.theme_nav_groups)
            ? normalizeNavGroups(doc.theme_nav_groups)
            : null,
    };
}

export function invalidateUserTheme(uid: number) {
    cache.delete(uid);
}

export async function getUserTheme(uid?: number): Promise<UserTheme> {
    const id = Number(uid);
    if (!Number.isSafeInteger(id) || id <= 0) {
        return {
            light: {}, dark: {}, lightCss: null, darkCss: null, links: null, navGroups: null,
        };
    }
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.theme;
    const doc = await userColl.findOne({ _id: id }, {
        projection: {
            theme_light_page_bg: 1,
            theme_light_page_fg: 1,
            theme_light_topbar_bg: 1,
            theme_light_topbar_fg: 1,
            theme_light_sidebar_bg: 1,
            theme_light_sidebar_fg: 1,
            theme_light_accent: 1,
            theme_light_card_bg: 1,
            theme_light_card_fg: 1,
            theme_light_css: 1,
            theme_dark_css: 1,
            theme_dark_page_bg: 1,
            theme_dark_page_fg: 1,
            theme_dark_topbar_bg: 1,
            theme_dark_topbar_fg: 1,
            theme_dark_sidebar_bg: 1,
            theme_dark_sidebar_fg: 1,
            theme_dark_accent: 1,
            theme_dark_card_bg: 1,
            theme_dark_card_fg: 1,
            // Legacy single-scheme fields (read as light fallback).
            theme_topbar_bg: 1,
            theme_topbar_fg: 1,
            theme_sidebar_bg: 1,
            theme_sidebar_fg: 1,
            theme_accent: 1,
            theme_links: 1,
            theme_nav_groups: 1,
        },
    });
    const theme = themeFromDoc(doc);
    cache.set(id, { at: Date.now(), theme });
    return theme;
}

export interface UserThemeModeInput {
    pageBg?: unknown;
    pageFg?: unknown;
    topbarBg?: unknown;
    topbarFg?: unknown;
    sidebarBg?: unknown;
    sidebarFg?: unknown;
    accent?: unknown;
    cardBg?: unknown;
    cardFg?: unknown;
}

export interface UserThemeInput {
    light?: UserThemeModeInput;
    dark?: UserThemeModeInput;
    lightCss?: string | null;
    darkCss?: string | null;
    /** null/undefined = use site default links; string = custom list. */
    links?: string | null;
    /** null/undefined = keep site middle groups; array = replace them. */
    navGroups?: NavGroupConfig[] | null;
}

const MODE_LABELS = { light: '亮色模式', dark: '暗色模式' } as const;
const COLOR_FIELDS: Array<[keyof UserThemeModeInput, string]> = [
    ['pageBg', '页面背景色'],
    ['pageFg', '页面文字色'],
    ['topbarBg', '顶栏背景色'],
    ['topbarFg', '顶栏文字色'],
    ['sidebarBg', '侧边栏背景色'],
    ['sidebarFg', '侧边栏文字色'],
    ['accent', '强调色'],
    ['cardBg', '卡片背景色'],
    ['cardFg', '卡片文字色'],
];
const LEGACY_FIELDS = [
    'theme_topbar_bg', 'theme_topbar_fg', 'theme_sidebar_bg',
    'theme_sidebar_fg', 'theme_accent',
];

function cleanColor(value: unknown, label: string): string {
    if (value === undefined || value === null || value === '') return '';
    const color = normalizeThemeColor(value);
    if (!color) throw new ValidationError(`${label}必须是 #rrggbb 格式的颜色。`);
    return color;
}

export async function saveUserTheme(uid: number, input: UserThemeInput) {
    const $set: Record<string, any> = { theme_updated_at: new Date() };
    const $unset: Record<string, ''> = {};
    let configured = 0;
    for (const mode of ['light', 'dark'] as const) {
        const colors = input[mode] || {};
        for (const [field, label] of COLOR_FIELDS) {
            const key = `theme_${mode}_${field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)}`;
            const value = cleanColor(colors[field], `${MODE_LABELS[mode]}${label}`);
            if (value) {
                $set[key] = value;
                configured++;
            } else {
                $unset[key] = '';
            }
        }
    }
    // Drop the pre-light/dark fields when the new form is saved; reads keep
    // falling back to them until then.
    for (const key of LEGACY_FIELDS) $unset[key] = '';
    for (const mode of ['light', 'dark'] as const) {
        const raw = mode === 'light' ? input.lightCss : input.darkCss;
        const key = `theme_${mode}_css`;
        if (raw == null || !raw.trim()) $unset[key] = '';
        else $set[key] = raw.trim();
    }
    if (input.links == null) {
        $unset.theme_links = '';
    } else {
        // Keep an explicitly empty custom list ("I want no top links") distinct
        // from "not customized".
        $set.theme_links = String(input.links).slice(0, MAX_LINKS_LENGTH);
    }
    if (input.navGroups == null) {
        $unset.theme_nav_groups = '';
    } else {
        // Same distinction for the middle groups: [] means "only the fixed
        // first/last groups", null means "follow the site middle".
        $set.theme_nav_groups = normalizeNavGroups(input.navGroups);
    }
    const op: Record<string, any> = { $set };
    if (Object.keys($unset).length) op.$unset = $unset;
    await userColl.updateOne({ _id: uid }, op, { upsert: true });
    invalidateUserTheme(uid);
    await addLog({
        type: 'user', userId: uid, action: 'theme_update',
        reason: `colors=${configured}`
            + `,links=${input.links == null ? 'default' : 'custom'}`
            + `,nav=${input.navGroups == null ? 'default' : 'custom'}`,
    });
}

const RESET_COLOR_ITEM_RE = /^(light|dark)_(page_bg|page_fg|topbar_bg|topbar_fg|sidebar_bg|sidebar_fg|accent|card_bg|card_fg)$/;

// Per-item "restore system default": unset just that field. Light-mode items
// also clear the legacy single-scheme field, otherwise the fallback would hide
// the reset. Unknown names are rejected so the handler cannot unset arbitrary
// user-document keys.
export async function resetUserTheme(uid: number, items: string[]) {
    const $unset: Record<string, ''> = {};
    for (const item of items) {
        if (item === 'links') {
            $unset.theme_links = '';
            continue;
        }
        if (item === 'nav') {
            $unset.theme_nav_groups = '';
            continue;
        }
        if (item === 'light_css' || item === 'dark_css') {
            $unset[`theme_${item}`] = '';
            continue;
        }
        const match = RESET_COLOR_ITEM_RE.exec(item);
        if (!match) throw new ValidationError('未知的主题配置项。');
        $unset[`theme_${item}`] = '';
        if (match[1] === 'light') $unset[`theme_${match[2]}`] = '';
    }
    if (!Object.keys($unset).length) return;
    await userColl.updateOne(
        { _id: uid },
        { $unset, $set: { theme_updated_at: new Date() } },
    );
    invalidateUserTheme(uid);
    await addLog({
        type: 'user', userId: uid, action: 'theme_reset', reason: items.join(','),
    });
}
