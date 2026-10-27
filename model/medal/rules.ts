import type {
    Oi33MedalAutomaticRuleType, Oi33MedalCategory, Oi33MedalLevel, Oi33MedalRuleType,
} from '../types';
import type { MedalShowcasePiece } from '../../shared/medal-showcase.ts';
import {
    MEDAL_SHOWCASE_CELL, MEDAL_SHOWCASE_COLUMNS, MEDAL_SHOWCASE_HEIGHT, MEDAL_SHOWCASE_MAX_PIECES,
    MEDAL_SHOWCASE_WIDTH,
} from '../../shared/medal-showcase.ts';
// The wall geometry and its display scale are shared with the browser editor
// (frontend/medal-showcase.page.ts), so they live in shared/ rather than here;
// re-exported to keep this module's public surface unchanged. The explicit
// `.ts` extension is required: `node --test` runs this file with the native
// type-stripping loader, which does not resolve extensionless specifiers.
export * from '../../shared/medal-showcase.ts';

// Pure medal rules: category derivation, the four public families, the
// upgradable-level ladders and award rendering. Kept free of hydrooj/DB imports
// so they can be unit-tested with plain `node --test`; model/medal/index.ts re-exports
// them to keep its public API unchanged.

// The automatic rule types a rule evaluator may dispatch on. `certification`
// medals are never automatic: an administrator hands them out and upgrades
// them, so they stay out of every evaluation pass.
export const AUTOMATIC_RULE_TYPES: Oi33MedalAutomaticRuleType[] = [
    'accepted_problems',
    'checkin_streak',
    'checkin_total',
    'cat_food_balance',
    'cat_can_balance',
    'special_medals',
];

export function isAutomaticRuleType(type: unknown): type is Oi33MedalAutomaticRuleType {
    return AUTOMATIC_RULE_TYPES.includes(type as Oi33MedalAutomaticRuleType);
}

// Canonical series identity forged by the initial import and by the migration
// that turns the old one-medal-per-threshold layout into upgradable ladders.
// The ids are stable because the medal id is public and printed in the UI.
export const MEDAL_AUTOMATIC_SERIES: Record<
    Oi33MedalAutomaticRuleType,
    { id: string; name: string; description: string }
> = {
    accepted_problems: {
        id: 'ac', name: '题海',
        description: '按通过的不同题号题目数量自动升级。',
    },
    checkin_streak: {
        id: 'streak', name: '长明',
        description: '按连续登录天数自动升级。',
    },
    checkin_total: {
        id: 'login', name: '足迹',
        description: '按累计登录天数自动升级。',
    },
    cat_food_balance: {
        id: 'food', name: '粮仓',
        description: '按猫粮余额历史峰值自动升级。',
    },
    cat_can_balance: {
        id: 'can', name: '罐藏',
        description: '按猫罐头持有量自动升级。',
    },
    special_medals: {
        id: 'special', name: '珍藏',
        description: '按已获得的一般 / 可售卖 / 奖项认证奖章数量自动升级。',
    },
};

// Human-readable condition for one automatic threshold, shared by the handler
// form, the initial import and the migration.
export function medalAutomaticRuleText(type: Oi33MedalRuleType, threshold: number): string {
    if (type === 'accepted_problems') return `通过 ${threshold} 道题号不同的题目`;
    if (type === 'checkin_streak') return `连续登录 ${threshold} 天`;
    if (type === 'checkin_total') return `累计登录 ${threshold} 天`;
    if (type === 'cat_food_balance') {
        const amount = threshold % 1000 === 0 ? `${threshold / 1000} kg` : `${threshold} g`;
        return `猫粮余额曾达到 ${amount}`;
    }
    if (type === 'cat_can_balance') return `猫罐头持有 ${threshold} 个`;
    if (type === 'special_medals') return `获得 ${threshold} 枚特殊奖章（不含 OJ 成就奖章）`;
    return '';
}

// The four public families, in catalogue/display order: 可售卖 → 奖项认证 →
// 一般 → OJ 自动.
export const MEDAL_CATEGORIES: Oi33MedalCategory[] = ['saleable', 'certification', 'manual', 'oj'];

export const MEDAL_CATEGORY_NAMES: Record<Oi33MedalCategory, string> = {
    saleable: '可售卖奖章',
    certification: '奖项认证奖章',
    manual: '一般奖章',
    oj: 'OJ 成就奖章',
};

// Category is derived, never stored: `saleable` wins over an automatic rule so
// a medal cannot be both auctioned and rule-granted at the same time, and
// `certification` is decided by its own ruleType.
export function medalCategoryOf(medal: any): Oi33MedalCategory {
    if (medal?.ruleType === 'certification') return 'certification';
    if (medal?.saleable === true) return 'saleable';
    return AUTOMATIC_RULE_TYPES.includes(medal?.ruleType) ? 'oj' : 'manual';
}

export function medalCategoryName(medal: any): string {
    return MEDAL_CATEGORY_NAMES[medalCategoryOf(medal)];
}

// 一般奖章可以重复获得（盲盒开出重复的一般奖章、管理员重复发放都会累加数量），
// 数量换算成星级：floor(log2(count))，即 1 枚 0 星、2-3 枚 1 星、4-7 枚 2 星…
export function medalStarLevel(count: unknown): number {
    const value = Math.floor(Number(count));
    if (!Number.isSafeInteger(value) || value < 2) return 0;
    return Math.floor(Math.log2(value));
}

// 等级阶梯的显示名：管理员填的名称直接用，并且去掉历史数据里自动生成的
// 「Lv.N」前缀（旧导入默认名），避免界面上出现多余的 Lv.序号。
export function medalLevelLabel(level: any): string {
    const raw = String(level?.name ?? '').trim();
    const stripped = raw.replace(/^Lv\.?\s*\d+\s*[:：.、-]?\s*/i, '').trim();
    if (stripped) return stripped;
    const ordinal = Number(level?.level);
    return Number.isSafeInteger(ordinal) && ordinal > 0 ? `第 ${ordinal} 级` : raw;
}

// Attach the derived category (and its display name) so handlers and
// templates never re-derive it. Certification ladders are normalised to
// ascending level order here, which makes every consumer order-safe.
export function medalView<T extends Record<string, any>>(medal: T) {
    const category = medalCategoryOf(medal);
    return {
        ...medal,
        ...(Array.isArray((medal as any).levels)
            ? {
                levels: [...(medal as any).levels]
                    .sort((a: any, b: any) => Number(a?.level || 0) - Number(b?.level || 0))
                    .map((level: any) => ({ ...level, label: medalLevelLabel(level) })),
            }
            : {}),
        category,
        categoryName: MEDAL_CATEGORY_NAMES[category],
    };
}

// Display order for medal lists: the user's enumeration order — auctionable
// medals, then certification series, then general hand-outs, then automatic OJ
// series. The `order` field (and fetch order) breaks ties within a group via a
// stable sort.
export function medalCategoryRank(medal: any) {
    return MEDAL_CATEGORIES.indexOf(medalCategoryOf(medal));
}

export function medalGroupByCategory(medals: any[]) {
    const groups: Record<Oi33MedalCategory, any[]> = {
        saleable: [], certification: [], manual: [], oj: [],
    };
    for (const medal of medals) groups[medalCategoryOf(medal)].push(medal);
    return groups;
}

// --- Upgradable series levels (奖项认证奖章 / OJ 成就奖章) ---

export function medalSortedLevels(medal: any): Oi33MedalLevel[] {
    const levels = Array.isArray(medal?.levels) ? medal.levels : [];
    return [...levels].sort((a, b) => Number(a?.level || 0) - Number(b?.level || 0));
}

// Strict lookup, used by every write path: an explicit level must exist on the
// ladder (or the highest rung is returned when no level is named).
export function medalLevelOf(medal: any, level?: number | null): Oi33MedalLevel | null {
    const levels = medalSortedLevels(medal);
    if (!levels.length) return null;
    const wanted = Number(level);
    if (Number.isSafeInteger(wanted) && wanted > 0) {
        return levels.find((item) => Number(item.level) === wanted) || null;
    }
    return levels[levels.length - 1];
}

// Forgiving lookup used only for rendering: an award can hold a rung an
// administrator has since removed from the ladder, and a blank medal would be
// worse than showing the closest surviving rung — the highest one at or below
// the held level, else the lowest.
export function medalDisplayRung(medal: any, level?: number | null): Oi33MedalLevel | null {
    const levels = medalSortedLevels(medal);
    if (!levels.length) return null;
    const wanted = Number(level);
    if (!Number.isFinite(wanted) || wanted <= 0) return levels[levels.length - 1];
    const exact = levels.find((item) => Number(item.level) === wanted);
    if (exact) return exact;
    const below = levels.filter((item) => Number(item.level) < wanted);
    return below.length ? below[below.length - 1] : levels[0];
}

// A definition is an upgradable series when it is one of the two level-bearing
// families and actually carries a ladder. Used to decide whether an award holds
// a rung and whether a grant must name one.
export function medalIsLevelSeries(medal: any): boolean {
    const category = medalCategoryOf(medal);
    if (category !== 'certification' && category !== 'oj') return false;
    return medalSortedLevels(medal).length > 0;
}

// Highest rung whose automatic threshold is met by `value`. Rungs without a
// positive threshold are skipped, so a partially filled ladder is harmless.
export function medalThresholdLevel(medal: any, value: number): Oi33MedalLevel | null {
    let best: Oi33MedalLevel | null = null;
    for (const item of medalSortedLevels(medal)) {
        const threshold = Number(item.threshold);
        if (!Number.isFinite(threshold) || threshold <= 0) continue;
        if (value >= threshold && (!best || Number(item.level) > Number(best.level))) best = item;
    }
    return best;
}

// Resolved display record for one award. For upgradable series the held level's
// own name/description/pixel art replaces the series defaults; every other
// family falls back to the definition itself.
export function medalAwardView(award: any, medal: any) {
    const category = medalCategoryOf(medal);
    const levels = medalSortedLevels(medal);
    const leveled = levels.length > 0 && (category === 'certification' || category === 'oj');
    // A legacy award that predates the level migration carries no rung: holding
    // the series at all means at least the lowest rung was reached, so render
    // that rather than falsely claiming the top rung.
    let held = Number(award?.level);
    if (leveled && (!Number.isSafeInteger(held) || held <= 0)) {
        held = Number(levels[0]?.level) || 1;
    }
    const rung = leveled ? medalDisplayRung(medal, held) : null;
    // `level` is what the user actually holds (a leveled award always reports
    // one); `displayLevel` is the rung whose art/name is rendered, and
    // `levelMissing` flags a held level that no longer exists on the ladder.
    const level = leveled
        ? (Number.isSafeInteger(held) && held > 0 ? held : (rung ? Number(rung.level) : null))
        : null;
    // 一般奖章可以重复获得：award.count 记录持有数量，星级由数量换算
    // （1 枚 0 星不做展示）。其它系列永远只有一枚。
    const count = category === 'manual' ? Math.max(1, Math.floor(Number(award?.count) || 1)) : 1;
    const rungLabel = rung ? medalLevelLabel(rung) : '';
    return {
        category,
        categoryName: MEDAL_CATEGORY_NAMES[category],
        leveled,
        level,
        levelMissing: leveled && level !== null
            && !levels.some((item) => Number(item.level) === level),
        displayLevel: rung ? Number(rung.level) : null,
        levelCount: levels.length,
        levelName: rungLabel,
        name: rung ? `${medal.name} · ${rungLabel}` : (medal?.name || ''),
        description: rung?.description || medal?.description || '',
        imageData: rung?.imageData || medal?.imageData || '',
        imageSize: rung?.imageSize || medal?.imageSize || 24,
        count,
        stars: category === 'manual' ? medalStarLevel(count) : 0,
    };
}

function showcaseCoord(value: unknown, limit: number): number {
    const raw = Number(value);
    const coord = Number.isFinite(raw) ? Math.round(raw) : 0;
    return Math.max(0, Math.min(coord, Math.max(0, limit - MEDAL_SHOWCASE_CELL)));
}

// Normalise stored/edited data to placements. The current format is a list of
// `{ id, x, y }`; the legacy 4×4 wall stored an id/null per slot, so those are
// laid out back onto the 10-column grid (keeping the old order and holes)
// instead of being lost. Every piece is clamped to the canvas, so it always
// fits inside the 320×128 wall.
export function medalShowcasePieces(raw: unknown): MedalShowcasePiece[] {
    const list = Array.isArray(raw) ? raw : [];
    const pieces: MedalShowcasePiece[] = [];
    const legacy: Array<{ id: string; index: number }> = [];
    for (let index = 0; index < list.length; index++) {
        const entry: any = list[index];
        if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
            const id = entry.id.trim();
            if (!id) continue;
            pieces.push({
                id,
                x: showcaseCoord(entry.x, MEDAL_SHOWCASE_WIDTH),
                y: showcaseCoord(entry.y, MEDAL_SHOWCASE_HEIGHT),
            });
        } else if (typeof entry === 'string' && entry.trim()) {
            legacy.push({ id: entry.trim(), index });
        }
    }
    for (const item of legacy) {
        // Old 4×4 / 6×3 / slot arrays are re-laid out row by row on the 10×4 grid.
        const column = item.index % MEDAL_SHOWCASE_COLUMNS;
        const row = Math.floor(item.index / MEDAL_SHOWCASE_COLUMNS);
        pieces.push({
            id: item.id,
            x: showcaseCoord(column * MEDAL_SHOWCASE_CELL, MEDAL_SHOWCASE_WIDTH),
            y: showcaseCoord(row * MEDAL_SHOWCASE_CELL, MEDAL_SHOWCASE_HEIGHT),
        });
    }
    return pieces.slice(0, MEDAL_SHOWCASE_MAX_PIECES);
}

// How many copies of one medal the wall may hold. 一般奖章按星级决定数量
// （0 星只有一枚，仍可放 1 份；★2 放 2 份；★3 放 3 份…），其他系列的奖章
// 只能放一份。The view is `medalAwardView()`'s output for the award.
export function medalShowcaseCopyLimit(view: any): number {
    if (view?.category !== 'manual') return 1;
    const stars = Math.floor(Number(view?.stars) || 0);
    return Math.max(1, Math.min(stars, MEDAL_SHOWCASE_MAX_PIECES));
}

// Keep the first `limit` placements of each medal and drop the rest. Rendering
// uses this so a wall saved before the copy limit existed (or a wall whose
// copies were revoked) still displays a legal layout; `limitOf` returns 0 for
// medals the user no longer holds, which drops them from the wall.
export function medalShowcaseTrim(
    pieces: MedalShowcasePiece[],
    limitOf: (id: string) => number,
): MedalShowcasePiece[] {
    const used = new Map<string, number>();
    const kept: MedalShowcasePiece[] = [];
    for (const piece of pieces) {
        const limit = Math.max(0, Math.floor(Number(limitOf(piece.id)) || 0));
        const count = (used.get(piece.id) || 0) + 1;
        if (count > limit) continue;
        used.set(piece.id, count);
        kept.push(piece);
    }
    return kept;
}
