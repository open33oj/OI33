import type {
    Oi33MedalAutomaticRuleType, Oi33MedalCategory, Oi33MedalLevel, Oi33MedalRuleType,
} from './types';

// Pure medal rules: category derivation, the four public families, the
// upgradable-level ladders and award rendering. Kept free of hydrooj/DB imports
// so they can be unit-tested with plain `node --test`; model/medal.ts re-exports
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
