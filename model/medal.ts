import {
    db, DocumentModel, ObjectId, STATUS, SystemModel, ValidationError,
} from 'hydrooj';
import type {
    Oi33MedalAutomaticRuleType, Oi33MedalCategory, Oi33MedalImageSize, Oi33MedalLevel,
    Oi33MedalRuleType, Oi33UserMedal,
} from './types';
import { addLog, logColl } from './log';
import { meowMedalPostAdd, meowDelete, meowPostColl } from './meow';
import { userColl } from './user';

export const medalColl = db.collection('oi33_medal');
export const userMedalColl = db.collection('oi33_user_medal');

const ACCEPTED_PROBLEM_DOMAINS_KEY = 'oi33.medal.accepted_problem_domains';
// The setting was stored under the 成就 name before the rename to 奖章. It is
// read as a fallback so an upgraded install keeps its configured domains even
// before /oi33/migrate has copied the value across.
const LEGACY_ACCEPTED_PROBLEM_DOMAINS_KEY = 'oi33.achievement.accepted_problem_domains';

function normalizeAcceptedDomains(values: unknown[]): string[] {
    return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function parseAcceptedDomains(raw: unknown): string[] {
    if (Array.isArray(raw)) return normalizeAcceptedDomains(raw);
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return normalizeAcceptedDomains(parsed);
    } catch { /* Backward-compatible plain text value. */ }
    return normalizeAcceptedDomains(raw.split(/[,，\s]+/));
}

// An empty list means every domain. The value is JSON-encoded so it remains
// portable across Hydro versions whose SystemModel value typing differs.
export function medalGetAcceptedDomains(): string[] {
    const current = parseAcceptedDomains(SystemModel.get(ACCEPTED_PROBLEM_DOMAINS_KEY) as unknown);
    if (current.length) return current;
    return parseAcceptedDomains(SystemModel.get(LEGACY_ACCEPTED_PROBLEM_DOMAINS_KEY) as unknown);
}

// One-shot, idempotent copy of the pre-rename setting into the new key. Called
// by /oi33/migrate; the read fallback above covers installs that have not run
// it yet.
export async function medalMigrateAcceptedDomains() {
    const legacy = parseAcceptedDomains(SystemModel.get(LEGACY_ACCEPTED_PROBLEM_DOMAINS_KEY) as unknown);
    if (!legacy.length) return 0;
    await SystemModel.set(ACCEPTED_PROBLEM_DOMAINS_KEY, JSON.stringify(legacy));
    return legacy.length;
}

export function medalAcceptedDomainIncluded(domainId: string): boolean {
    const domains = medalGetAcceptedDomains();
    return !domains.length || domains.includes(domainId);
}

export async function medalSetAcceptedDomains(domainIds: string[], operator: number) {
    const normalized = normalizeAcceptedDomains(domainIds);
    await SystemModel.set(ACCEPTED_PROBLEM_DOMAINS_KEY, JSON.stringify(normalized));
    await addLog({
        type: 'medal', userId: operator, action: 'config_update',
        reason: normalized.join(', '),
    });
    return normalized;
}

export async function ensureMedalIndexes() {
    await Promise.all([
        medalColl.createIndex({ order: 1, _id: 1 }),
        medalColl.createIndex({ ruleType: 1, threshold: 1, order: 1 }),
        medalColl.createIndex({ ruleType: 1, order: 1 }),
        userMedalColl.createIndex({ uid: 1, medalId: 1 }, { unique: true }),
        userMedalColl.createIndex({ medalId: 1, earnedAt: -1 }),
        userMedalColl.createIndex({ earnedAt: -1 }),
    ]);
}

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

// Attach the derived category (and its display name) so handlers and
// templates never re-derive it. Certification ladders are normalised to
// ascending level order here, which makes every consumer order-safe.
export function medalView<T extends Record<string, any>>(medal: T) {
    const category = medalCategoryOf(medal);
    return {
        ...medal,
        ...(Array.isArray((medal as any).levels)
            ? {
                levels: [...(medal as any).levels].sort(
                    (a: any, b: any) => Number(a?.level || 0) - Number(b?.level || 0),
                ),
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

export async function medalGet(id: string) {
    const medal = await medalColl.findOne({ _id: id });
    return medal ? medalView(medal) : null;
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
    return {
        category,
        categoryName: MEDAL_CATEGORY_NAMES[category],
        leveled,
        level,
        levelMissing: leveled && level !== null
            && !levels.some((item) => Number(item.level) === level),
        displayLevel: rung ? Number(rung.level) : null,
        levelCount: levels.length,
        levelName: rung?.name || '',
        name: rung ? `${medal.name} · ${rung.name}` : (medal?.name || ''),
        description: rung?.description || medal?.description || '',
        imageData: rung?.imageData || medal?.imageData || '',
        imageSize: rung?.imageSize || medal?.imageSize || 24,
    };
}

export async function medalList() {
    const medals = await medalColl.find().sort({ order: 1, _id: 1 }).toArray();
    return medals
        .map((medal) => medalView(medal))
        .sort((a, b) => medalCategoryRank(a) - medalCategoryRank(b));
}

// Public catalogue: every medal, grouped into the four families.
export async function medalCatalogue() {
    return medalGroupByCategory(await medalList());
}

export async function medalSave(input: {
    id: string;
    name: string;
    description: string;
    rule: string;
    ruleType: Oi33MedalRuleType;
    threshold?: number;
    imageData: string;
    imageSize: Oi33MedalImageSize;
    levels?: Oi33MedalLevel[];
    order: number;
    saleable: boolean;
    operator: number;
}) {
    const now = new Date();
    const existing = await medalColl.findOne({ _id: input.id });
    const set: Record<string, any> = {
        name: input.name,
        description: input.description,
        rule: input.rule,
        ruleType: input.ruleType,
        imageData: input.imageData,
        imageSize: input.imageSize,
        order: input.order,
        saleable: input.saleable,
        updatedAt: now,
    };
    const update: Record<string, any> = {
        $set: set,
        $setOnInsert: {
            createdAt: now,
            createdBy: input.operator,
        },
    };
    const isAutomatic = isAutomaticRuleType(input.ruleType);
    if (input.ruleType === 'manual' || input.ruleType === 'certification') {
        update.$unset = { threshold: '' };
    } else if (isAutomatic) {
        // The series threshold is the top rung's threshold: kept for sorting,
        // legacy queries and display; the evaluator reads each rung's own
        // threshold instead.
        set.threshold = (input.levels || []).reduce(
            (max, item) => Math.max(max, Number(item.threshold) || 0), 0,
        ) || input.threshold;
    }
    // The level ladder exists on both upgradable families: certification
    // (manually assigned rungs) and OJ 成就奖章 (rule-driven thresholds). It is
    // explicitly removed when a series is converted into another family so no
    // stale rungs survive.
    if (input.ruleType === 'certification' || isAutomatic) {
        set.levels = (input.levels || []).slice().sort(
            (a, b) => Number(a.level) - Number(b.level),
        );
    } else {
        update.$unset = { ...(update.$unset || {}), levels: '' };
    }
    await medalColl.updateOne(
        { _id: input.id },
        update,
        { upsert: true },
    );
    await addLog({
        type: 'medal',
        userId: input.operator,
        action: existing ? 'definition_edit' : 'definition_create',
        medalId: input.id,
    });
    return await medalGet(input.id);
}

// --- Definition import / export -------------------------------------------
//
// The payload carries definitions only: names, rules, pixel art and level
// ladders. Awards, announcements and moderation state are deliberately
// excluded, so a file can be moved to another installation — or another OJ's
// medal set can be loaded here — without touching who holds what.

const MEDAL_EXPORT_FORMAT = 'oi33-medals';
const MEDAL_EXPORT_VERSION = 1;
const MAX_IMPORT_MEDALS = 500;
const MAX_MEDAL_IMAGE_BYTES = 256 * 1024;
const MAX_MEDAL_LEVELS = 24;
const MEDAL_IMAGE_SIZES = new Set([8, 16, 24, 32]);
const MEDAL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MEDAL_RULE_TYPES = new Set<Oi33MedalRuleType>([
    'manual', 'accepted_problems', 'checkin_streak', 'checkin_total',
    'cat_food_balance', 'cat_can_balance', 'certification',
]);

export interface MedalDefinitionExport {
    format: string;
    version: number;
    exportedAt: string;
    count: number;
    medals: any[];
}

export async function medalExportDefinitions(): Promise<MedalDefinitionExport> {
    const medals = await medalColl.find().sort({ order: 1, _id: 1 }).toArray();
    return {
        format: MEDAL_EXPORT_FORMAT,
        version: MEDAL_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        count: medals.length,
        medals: medals.map((medal) => {
            const levels = medalSortedLevels(medal);
            return {
                id: medal._id,
                name: medal.name,
                description: medal.description,
                rule: medal.rule,
                ruleType: medal.ruleType,
                ...(Number(medal.threshold) > 0 ? { threshold: Number(medal.threshold) } : {}),
                imageData: medal.imageData,
                imageSize: medal.imageSize,
                ...(levels.length
                    ? {
                        levels: levels.map((level) => ({
                            level: level.level,
                            name: level.name,
                            ...(level.description ? { description: level.description } : {}),
                            imageData: level.imageData,
                            imageSize: level.imageSize,
                            ...(Number(level.threshold) > 0 ? { threshold: Number(level.threshold) } : {}),
                        })),
                    }
                    : {}),
                order: Number(medal.order) || 0,
                saleable: medal.saleable === true,
            };
        }),
    };
}

// A base64 PNG data URL of one of the four allowed square sizes, or null.
function normalizeMedalImage(raw: unknown): { imageData: string; imageSize: Oi33MedalImageSize } | null {
    const value = String(raw ?? '').trim();
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
    if (!match) return null;
    let data: Buffer;
    try {
        data = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
    } catch {
        return null;
    }
    if (data.length < 24 || data.length > MAX_MEDAL_IMAGE_BYTES) return null;
    if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || data.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (width !== height || !MEDAL_IMAGE_SIZES.has(width)) return null;
    return { imageData: value, imageSize: width as Oi33MedalImageSize };
}

function normalizeImportedLevel(
    raw: any,
    index: number,
    fallback: { imageData: string; imageSize: Oi33MedalImageSize },
    medalId: string,
    warnings: string[],
): Oi33MedalLevel {
    const name = String(raw?.name ?? '').trim().slice(0, 50) || `Lv.${index + 1}`;
    const description = String(raw?.description ?? '').trim().slice(0, 200);
    const image = normalizeMedalImage(raw?.imageData);
    if (!image && raw?.imageData) {
        warnings.push(`${medalId}: 等级「${name}」的像素图无效，已改用系列图标。`);
    }
    const threshold = Number.parseInt(String(raw?.threshold ?? ''), 10);
    return {
        level: index + 1,
        name,
        ...(description ? { description } : {}),
        imageData: (image || fallback).imageData,
        imageSize: (image || fallback).imageSize,
        ...(Number.isSafeInteger(threshold) && threshold > 0 ? { threshold } : {}),
    };
}

interface NormalizedMedalDefinition {
    _id: string;
    fields: Record<string, any>;
    warnings: string[];
}

// Turn one foreign definition into the fields this plugin stores. IDs are
// lower-cased and stripped of characters the plugin cannot address, and an
// optional prefix can be prepended to avoid collisions with local medals.
function normalizeImportedMedal(raw: any, index: number, idPrefix: string): NormalizedMedalDefinition {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`第 ${index + 1} 项不是一个奖章对象。`);
    }
    const warnings: string[] = [];
    const rawId = String(raw.id ?? raw._id ?? raw.medalId ?? '').trim();
    const id = `${idPrefix}${rawId}`
        .trim().toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    if (!id || !MEDAL_ID_RE.test(id)) {
        throw new Error(`第 ${index + 1} 项缺少可用的奖章 ID（原始值：${rawId || '空'}）。`);
    }
    const name = String(raw.name ?? '').trim().slice(0, 50);
    if (!name) throw new Error(`奖章「${id}」缺少名称。`);

    const rawType = String(raw.ruleType ?? '').trim();
    let ruleType: Oi33MedalRuleType;
    if (MEDAL_RULE_TYPES.has(rawType as Oi33MedalRuleType)) {
        ruleType = rawType as Oi33MedalRuleType;
    } else {
        ruleType = 'manual';
        warnings.push(`${id}: 未知 ruleType「${rawType || '空'}」，已按一般奖章导入。`);
    }

    const image = normalizeMedalImage(raw.imageData);
    if (!image && raw.imageData) warnings.push(`${id}: 像素图无效，已改用默认奖章图标。`);
    const base = image || { imageData: INITIAL_MEDAL_IMAGES[0], imageSize: 24 as Oi33MedalImageSize };

    const isLeveled = ruleType === 'certification' || isAutomaticRuleType(ruleType);
    let levels: Oi33MedalLevel[] | undefined;
    if (isLeveled && Array.isArray(raw.levels) && raw.levels.length) {
        const rows = raw.levels
            .filter((item: any) => item && typeof item === 'object')
            .slice(0, MAX_MEDAL_LEVELS)
            .map((item: any, i: number) => normalizeImportedLevel(item, i, base, id, warnings));
        if (raw.levels.length > MAX_MEDAL_LEVELS) {
            warnings.push(`${id}: 等级过多，只保留前 ${MAX_MEDAL_LEVELS} 级。`);
        }
        if (ruleType === 'certification') {
            levels = rows;
        } else {
            // OJ rungs are driven by their thresholds; a rung without one can
            // never be reached, so it is dropped rather than silently kept.
            const withThreshold = rows.filter((item) => Number(item.threshold) > 0);
            if (withThreshold.length !== rows.length) {
                warnings.push(`${id}: 忽略了 ${rows.length - withThreshold.length} 个没有阈值的等级。`);
            }
            levels = withThreshold
                .sort((a, b) => Number(a.threshold) - Number(b.threshold))
                .map((item, i) => ({ ...item, level: i + 1 }));
        }
    }

    const flatThreshold = Number.parseInt(String(raw.threshold ?? ''), 10);
    const topThreshold = levels && levels.length
        ? Number(levels[levels.length - 1].threshold) || 0
        : (Number.isSafeInteger(flatThreshold) && flatThreshold > 0 ? flatThreshold : 0);
    const automatic = isAutomaticRuleType(ruleType);
    if (automatic && topThreshold <= 0) {
        warnings.push(`${id}: 自动奖章没有任何可用阈值，导入后不会自动发放。`);
    }

    let rule = String(raw.rule ?? '').trim().slice(0, 500);
    if (!rule) {
        if (ruleType === 'certification') {
            rule = levels && levels.length
                ? `${levels.length} 级认证：${levels.map((item) => item.name).join(' < ')}`
                : '奖项认证奖章';
        } else if (automatic) {
            rule = topThreshold > 0
                ? `${medalAutomaticRuleText(ruleType, topThreshold)} 起逐级自动升级`
                : '由系统按指标自动升级';
        } else {
            rule = '由管理员根据活动结果发放';
        }
    }

    // Only 一般奖章 may be marked saleable: the evaluator skips saleable
    // definitions and certification ignores the flag.
    if (raw.saleable === true && ruleType !== 'manual') {
        warnings.push(`${id}: 只有一般奖章可以标记为可售卖，已忽略 saleable。`);
    }

    const fields: Record<string, any> = {
        name,
        description: String(raw.description ?? '').trim().slice(0, 500) || name,
        rule,
        ruleType,
        imageData: base.imageData,
        imageSize: base.imageSize,
        order: Number.isSafeInteger(Number(raw.order)) ? Number(raw.order) : 0,
        saleable: raw.saleable === true && ruleType === 'manual',
    };
    if (isLeveled && levels && levels.length) fields.levels = levels;
    if (automatic && topThreshold > 0) fields.threshold = topThreshold;
    return { _id: id, fields, warnings };
}

export interface MedalImportOptions {
    // 'merge' overwrites an existing definition with the same id; 'insert'
    // keeps the local one and counts the import as skipped.
    mode?: 'merge' | 'insert';
    idPrefix?: string;
    operator: number;
}

export interface MedalImportResult {
    total: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    warnings: string[];
    errors: string[];
}

export async function medalImportDefinitions(
    payload: unknown,
    options: MedalImportOptions,
): Promise<MedalImportResult> {
    const list = Array.isArray(payload)
        ? payload
        : (Array.isArray((payload as any)?.medals) ? (payload as any).medals : null);
    if (!list) {
        throw new ValidationError('导入内容格式无效：应为奖章数组，或包含 medals 数组的导出文件。');
    }
    if (!list.length) throw new ValidationError('导入内容里没有任何奖章定义。');
    if (list.length > MAX_IMPORT_MEDALS) {
        throw new ValidationError(`单次最多导入 ${MAX_IMPORT_MEDALS} 枚奖章。`);
    }
    const mode = options.mode === 'insert' ? 'insert' : 'merge';
    const idPrefix = String(options.idPrefix ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    const now = new Date();
    const result: MedalImportResult = {
        total: list.length, created: 0, updated: 0, skipped: 0, failed: 0,
        warnings: [], errors: [],
    };
    const seen = new Set<string>();
    for (let index = 0; index < list.length; index++) {
        try {
            const normalized = normalizeImportedMedal(list[index], index, idPrefix);
            if (seen.has(normalized._id)) {
                result.skipped++;
                result.warnings.push(`${normalized._id}: 文件内重复，已保留最先出现的一条。`);
                continue;
            }
            seen.add(normalized._id);
            const existing = await medalColl.findOne({ _id: normalized._id });
            if (existing && mode === 'insert') {
                result.skipped++;
                continue;
            }
            const unset: Record<string, ''> = {};
            if (!normalized.fields.levels) unset.levels = '';
            if (!('threshold' in normalized.fields)) unset.threshold = '';
            await medalColl.updateOne(
                { _id: normalized._id },
                {
                    $set: { ...normalized.fields, updatedAt: now },
                    $setOnInsert: { createdAt: now, createdBy: options.operator },
                    ...(Object.keys(unset).length ? { $unset: unset } : {}),
                },
                { upsert: true },
            );
            if (existing) result.updated++; else result.created++;
            result.warnings.push(...normalized.warnings);
        } catch (e: any) {
            result.failed++;
            result.errors.push(e?.message || `第 ${index + 1} 项导入失败。`);
        }
    }
    await addLog({
        type: 'medal', userId: options.operator, action: 'definition_import',
        reason: `total=${result.total} created=${result.created} updated=${result.updated} `
            + `skipped=${result.skipped} failed=${result.failed}`,
    });
    return result;
}

export async function medalDelete(id: string, operator: number) {
    const awards = await userMedalColl.countDocuments({ medalId: id });
    if (awards) throw new ValidationError('已有用户获得该奖章，不能删除；可以修改奖章信息。');
    const result = await medalColl.deleteOne({ _id: id });
    if (result.deletedCount) {
        await addLog({
            type: 'medal', userId: operator,
            action: 'definition_delete', medalId: id,
        });
    }
    return !!result.deletedCount;
}

export async function medalGetUserAwards(uid: number) {
    const grants = await userMedalColl.find({ uid }).sort({ earnedAt: -1 }).toArray();
    if (!grants.length) return [];
    const definitions = await medalColl.find({
        _id: { $in: grants.map((grant) => grant.medalId) },
    }).toArray();
    const definitionMap = new Map(definitions.map((definition) => [definition._id, definition]));
    return grants
        .map((grant) => {
            const raw = definitionMap.get(grant.medalId);
            if (!raw) return null;
            const medal = medalView(raw);
            // `view` is the resolved display record: awards of an upgradable
            // series render their current rung's name, text and pixel art.
            return { ...grant, medal, view: medalAwardView(grant, medal) };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => (
            medalCategoryRank(a.medal) - medalCategoryRank(b.medal)
            || a.medal.order - b.medal.order
            || a.earnedAt.getTime() - b.earnedAt.getTime()
        ));
}

export async function medalListRecentAwards(limit = 50) {
    return await userMedalColl.find().sort({ earnedAt: -1 }).limit(limit).toArray();
}

// Paginated award history for the management page: newest first, with the
// total count and page count returned so the pager can render without a
// second query.
export async function medalListAwardsPaginated(page: number, pageSize = 50) {
    const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
    const total = await userMedalColl.countDocuments({});
    const awards = await userMedalColl.find({})
        .sort({ earnedAt: -1, _id: -1 })
        .skip((safePage - 1) * pageSize)
        .limit(pageSize)
        .toArray();
    return { awards, total, tpcount: Math.ceil(total / pageSize) };
}

// Every user currently sitting on one rung of an upgradable series. The
// catalogue links each certification level here; earliest achievers render
// first so the page reads like a hall of fame.
export async function medalListLevelHolders(medalId: string, level: number) {
    return await userMedalColl.find({ medalId, level })
        .sort({ earnedAt: 1, _id: 1 })
        .toArray();
}

export interface MedalAwardStat {
    total: number;
    // Upgradable series only: how many holders sit on each rung.
    byLevel: Record<string, number>;
}

// Holder counts for the public catalogue. One pass over the award collection;
// `total` covers every family, `byLevel` is only meaningful for upgradable
// series (where the award carries its rung).
export async function medalAwardStats(): Promise<Record<string, MedalAwardStat>> {
    const rows = await userMedalColl.aggregate([
        { $group: { _id: { medalId: '$medalId', level: '$level' }, count: { $sum: 1 } } },
    ]).toArray();
    const stats: Record<string, MedalAwardStat> = {};
    for (const row of rows as any[]) {
        const medalId = String(row._id?.medalId ?? '');
        if (!medalId) continue;
        const stat = stats[medalId] || (stats[medalId] = { total: 0, byLevel: {} });
        const count = Number(row.count) || 0;
        stat.total += count;
        if (row._id?.level !== undefined && row._id?.level !== null) {
            stat.byLevel[String(row._id.level)] = count;
        }
    }
    return stats;
}

export interface MedalEvaluateOptions {
    ruleTypes?: Oi33MedalRuleType[];
    historicalCatFood?: boolean;
    announce?: boolean;
    source?: string;
}

async function medalGetHistoricalCatFoodPeak(uid: number, currentBalance: number) {
    let balance = currentBalance;
    let peak = currentBalance;
    const cursor = logColl.find({
        userId: uid,
        type: { $in: ['checkin', 'cat_account'] },
        amount: { $exists: true, $ne: 0 },
    }, {
        projection: { amount: 1 },
    }).sort({ createdAt: -1, _id: -1 });
    try {
        while (await cursor.hasNext()) {
            const entry = await cursor.next();
            if (!entry) break;
            // Walking newest to oldest: subtracting a transaction delta gives
            // the balance immediately before that transaction.
            balance -= Number(entry.amount) || 0;
            if (balance > peak) peak = balance;
        }
    } finally {
        await cursor.close();
    }
    return Math.max(0, peak);
}

export async function medalEvaluateUser(
    uid: number,
    options: MedalEvaluateOptions = {},
) {
    // Only the automatic (OJ 成就奖章) rule types are ever evaluated;
    // `manual` and `certification` definitions are exempt by construction.
    const ruleTypes = (options.ruleTypes || AUTOMATIC_RULE_TYPES)
        .filter((type) => isAutomaticRuleType(type));
    if (!ruleTypes.length) return { checked: 0, matched: 0, granted: [] as string[] };
    const allDefinitions = await medalColl.find({
        ruleType: { $in: ruleTypes },
        // Auction/trade medals are exclusive to the 可售卖奖章 family: even a
        // legacy definition carrying both an automatic rule and the saleable
        // flag must not be handed out by a rule evaluator.
        saleable: { $ne: true },
    }).sort({ order: 1, threshold: 1, _id: 1 }).toArray();
    // A definition is actionable when it carries either an upgradable ladder
    // with per-rung thresholds or a legacy flat threshold.
    const definitions = allDefinitions.filter((item) => (
        medalSortedLevels(item).some((level) => Number(level.threshold) > 0)
        || Number(item.threshold) > 0
    ));
    if (!definitions.length) return { checked: 0, matched: 0, granted: [] as string[] };

    const needsAccepted = definitions.some((item) => item.ruleType === 'accepted_problems');
    const user = await userColl.findOne({ _id: uid });
    // Unverified users never trigger automatic medals.
    if ((Number(user?.realname_flag) || 0) < 1) return { checked: 0, matched: 0, granted: [] as string[] };
    const acceptedDomains = needsAccepted ? medalGetAcceptedDomains() : [];
    const acceptedFilter: Record<string, any> = {
        docType: DocumentModel.TYPE_PROBLEM,
        uid,
        status: STATUS.STATUS_ACCEPTED,
    };
    if (acceptedDomains.length) acceptedFilter.domainId = { $in: acceptedDomains };
    const acceptedStatuses = needsAccepted
        ? await DocumentModel.collStatus.find(acceptedFilter, {
            projection: { domainId: 1, docId: 1 },
        }).toArray()
        : [];
    const acceptedRefsByDomain = new Map<string, Map<string, any>>();
    for (const status of acceptedStatuses as any[]) {
        const domainId = String(status.domainId);
        if (!acceptedRefsByDomain.has(domainId)) acceptedRefsByDomain.set(domainId, new Map());
        acceptedRefsByDomain.get(domainId)!.set(String(status.docId), status.docId);
    }
    const acceptedProblems = needsAccepted
        ? (await Promise.all([...acceptedRefsByDomain].map(([domainId, refs]) => (
            DocumentModel.coll.find({
                domainId,
                docType: DocumentModel.TYPE_PROBLEM,
                docId: { $in: [...refs.values()] },
            }, {
                projection: { sort: 1 },
            }).toArray()
        )))).flat()
        : [];
    // `sort` is the public problem number. Deliberately do not include
    // domainId here: the same sort in different configured domains is one
    // distinct problem for medal purposes.
    const acceptedCount = new Set(acceptedProblems
        .map((item: any) => item.sort)
        .filter((sort: any) => sort !== undefined && sort !== null && String(sort) !== '')
        .map((sort: any) => String(sort))).size;
    const currentCatFood = Number(user?.cat_food) || 0;
    const catFoodValue = options.historicalCatFood
        && definitions.some((item) => item.ruleType === 'cat_food_balance')
        ? await medalGetHistoricalCatFoodPeak(uid, currentCatFood)
        : currentCatFood;
    const values: Partial<Record<Oi33MedalRuleType, number>> = {
        accepted_problems: acceptedCount,
        checkin_streak: Number(user?.checkin_cnt_now) || 0,
        checkin_total: Number(user?.checkin_cnt_all) || 0,
        cat_food_balance: catFoodValue,
        cat_can_balance: Number(user?.cat_can) || 0,
    };
    const granted: string[] = [];
    let matched = 0;
    for (const definition of definitions) {
        const value = values[definition.ruleType] || 0;
        const sourceText = options.source
            ? `${options.source}:${definition.ruleType}`
            : `rule:${definition.ruleType}`;
        const rungs = medalSortedLevels(definition).filter(
            (item) => Number(item.threshold) > 0,
        );
        if (rungs.length) {
            // Upgradable OJ series: grant or raise the award to the highest rung
            // the user's indicator has reached. It never downgrades and never
            // publishes an automatic announcement.
            const target = medalThresholdLevel(definition, value);
            if (!target) continue;
            matched++;
            const result = await medalUpgradeAwardLevel(
                uid, definition, Number(target.level), sourceText,
            );
            if (result.created || result.upgraded) granted.push(definition._id);
            continue;
        }
        const threshold = Number(definition.threshold) || 0;
        if (value < threshold) continue;
        matched++;
        const result = await medalGrant(
            uid, definition._id, 0, sourceText, options.announce !== false,
        );
        if (result.created) granted.push(definition._id);
    }
    return { checked: definitions.length, matched, granted };
}

export async function medalEvaluateAll() {
    const cursor = userColl.find({}, { projection: { _id: 1 } }).sort({ _id: 1 });
    let users = 0;
    let granted = 0;
    let matched = 0;
    try {
        while (await cursor.hasNext()) {
            const user = await cursor.next();
            if (!user) break;
            const result = await medalEvaluateUser(user._id, {
                historicalCatFood: true,
                announce: false,
                source: 'scan',
            });
            users++;
            granted += result.granted.length;
            matched += result.matched;
            if (users % 50 === 0) {
                console.info(
                    `[oi33] medal scan progress: ${users} users, `
                    + `${matched} matched, ${granted} granted`,
                );
            }
            // Keep the scan deliberately sequential and yield between users
            // so a large backfill cannot monopolize the Hydro process.
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    } finally {
        await cursor.close();
    }
    return { users, matched, granted };
}

interface InitialMedalGroup {
    orderBase: number;
    ruleType: Oi33MedalAutomaticRuleType;
    thresholds: number[];
    // Full rung names, e.g. 题海·初帆. The series name is stripped when the
    // ladder is built, so an award renders as「题海 · 初帆」.
    names: string[];
    description: (value: number) => string;
}

const INITIAL_THRESHOLDS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
const INITIAL_MEDAL_IMAGES = [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA6UlEQVR4AcyRgQkCMQxFy82huIMzOIkTuIErOIGTuIJDiO6h94QPoU2wPVtR+OTyr/kvV6frcfscqSnNv8NlnUZojk5vAA+j9D+A82aVJPu18qjW13PVFzC8vz2SRE8AVR6VHt+qCmAHvBDeR34TgBA2JdAq8jnTBGCgVdWAaMvI1yLVAO9qCIl83qEqACFsKtEzTJVHpce3cgEclnSYYUkeVR6VPlcBIJjDEn0+1NIXAIJbAj6dLQB2gO2/BYaAHuEs6wJ6hbuAnuEuABOIFd5SFVfEn5praThzBQCzp34DOO3uaYS4iRcAAAD//zJp41IAAAAGSURBVAMAI4Hm6TXgFL8AAAAASUVORK5CYII=',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA30lEQVR4AcyRgQ0CIQxFm5tD4w7O4CRO4Aau4ARO4goOYXQPvWfyE1LgAgjmLvmhLe1/wE338/49UpPN3+m2tRGare0LIBil9QCuu41J/rbUfU150Q0wOD5eJpFjwIqIcyoChMOhoYDhvo+rAJhj6k2W8irAklFurxjQcnqgxYDap8EcFQEw5wYSOcPKfUwuJQEaZFUjplKq5vfUEwEwVTMruZpb1giAaYtRbiYChI2c/ldgFtDDnMMmAb3Mk4Ce5kkARSChqLUqeiJ+qlerOXMRgGJP/QdwOTxthHiJDwAAAP//0AWwbgAAAAZJREFUAwCKJ9rpq4UaHQAAAABJRU5ErkJggg==',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA5UlEQVR4AcyRgQ3CIBBFSefQuIMzOIkTuIErOIGTuIJDGN1D+0x+cil3kSI0bfJz8DneBzrcz/t3Tw1p/E63beqhEZ2+AQx6aT0B190mSfa28qjW17joBmw+Pl5JYg6AKo/KHN+qKMBusBCgds0bzwoAHkGjtVkB3gnxIjhrxQERJPKBo+IA72l+wYsDgAOTmLMZyVPFs3JvoGaqmoFKnjddU08WAFTNVOZqrqlZANAaULQnC7CNnP7fwDCgBZzDugGt4G5AS7gbgEmIFV6tsifip05VC2dfFoDZUssEXA7P1EO8xAcAAP//ruSLFgAAAAZJREFUAwCh0uzp5qUSbAAAAABJRU5ErkJggg==',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA7ElEQVR4AcyRgQ3CMAwErc4BYgdmYBImYANWYAImYQWGQLAH9JBeshqjOiVBVHo5/sZ/aTpcj9tnTw02PofL2npojLY3gEUv/Q/gvFmZ5L9WHtX7Wqe+gOH97WESPQFUeVR6fK8UwA/4EEL9u2hdBSA8CsVH0bsqQHRCPIIREHqvNIBhQvxwZp0GROFA5yApAOGESfQEU+VR6fG9QgCbJW1mWJJHlUeln6oAEMxmiX46VNMXAIJrAub2FgA/wOm/BX4EtAjnsCGgVXgIaBkeAjCBeOEtVXFF/NSploYzVwAwW+o3gNPubj3ETbwAAAD//30u0rMAAAAGSURBVAMA5h7p6QWk6YkAAAAASUVORK5CYII=',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA40lEQVR4AcyRWwrCMBBFQ9chuDd34Lf4JX67A9eSrQjuQ3uEC0MysWlMpIXLPJq5Z5pOMcbXSE1hfs6nWxih2Tp8ACSjtB3Afb8LUvq1pT7nqr4Ag8PjGSRqhhE5fXJPVQA7iKGtl/JVAMzttmntwVYBPIOlXjWgtC19BEiRXKoG2KvRMD2JHjnRqgrAINtJ1NbkW+4CZETUMKaSejbyztbKMwCmHJaodbglZgCMW4xKMxnAHmT7X4FFQA9zlnUBvcxdQE9zF0ATiBW9VmVXxE9N1WrOXAag2VP/AVyuxzBC3MQbAAD//1LRkUsAAAAGSURBVAMA5KrtGbQrQNYAAAAASUVORK5CYII=',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA50lEQVR4AcyRwQnCQBREF+sQ7M0OPIsn8WwH1pJWBPvQPOHBJ7uSTdwVhWHyJ/vnJXEzDMOzpzZp/J2O19RDY3V6A7jopf8B3HbbpHxb5+je06vegIL9/ZEUswVmurleBfAwHsuZ57QIQDlPGkvJVMy9XgRwSQcWBch7ejWAZcpcrPVqQKkc6ByoCkA5ZYqZYtwMZyaPKgI4rDzMsjLDzXDmqTIAxRxWzNOlJXMGoHhJwdzZDBAXePpvgR8BLcp52CKgVXkR0LK8CCAEEkW2Vtkn4k+dam05exmAsKV+AzhfDqmH+BIvAAAA//+uR30pAAAABklEQVQDAKso/xntGbeAAAAAAElFTkSuQmCC',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA6UlEQVR4AcyR0QkCMRBEl6tDsDc78Fv8Er/twFrSimAfek8YWJKIm5iIB8Nm57LzkrslpfSYqcXW53i42Ayt0fYCsJil/wFctxuT/G3lUb2vdegGDO9ud5PoCaDKo9Lje4UAfqAWovdAtFZtAhCeh+BJCvW1CeAHtQYoAZKvGgYwTJAGozUM6AnnECEA4dxAomeYKo9Kj+9VBbBZ0maGJXlUeVT6XAWAYDZL9PlQS18ACG4J+LS3APgBTv8t8C1gRDiHrQJGhVcBI8OrAEwgXni9Kj4RPzVXbzhzBQBzpH4DOJ33NkN8iScAAAD//xs9Fv4AAAAGSURBVAMAY1P8GS1ppRsAAAAASUVORK5CYII=',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA3klEQVR4AcyRwQkCMRBFw9Yh2JsdeBZP4tkOrGVbEexD9wkfhmSSTdZEXPhMZpL5b5Kd5nl+jdQUlu98uoURWqzDB8BilP4HcN/vgqTbKrdRe4pVN8Dg8HgGiRwD5YrUYlUBbJPMba20bgJgzrSeYW6vCeAZr9WqAbkJAZT2qgG5pwFQUhUAc6aUyEumds8FyIiow5hKqilS1zqOCQBTGiTyuKklTwAYtxisnU0AtoHpvwVmAT3MGdYF9DJ3AT3NXQBFIFbUtip5In5qrK3m9CUAij31G8DlegwjxEu8AQAA//8mtPrQAAAABklEQVQDAGKM7RlA2ZNjAAAAAElFTkSuQmCC',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA60lEQVR4AcyR4QkCMRSDHzeH4Cau4A7iWOIOruAS/hbc47xPCDzaiq+1PU4I6UubpD2n+WHzSEy2/A7no43AEm2fAhajsJ2C635ngn+tNNjrWodegPn0fJnATAAsDWZG9wgVeEMpxO+n66oCwrmpQlijCczaE1cVyCQmmFCBWXvicAFmgmSMcrigJZxLhAoI5wUCM2ZYGsyM7lEs4LCgw5gFabA0mDlFVkAwhwXm1FQzZwUE1wT8OpsVeAO3/7fwa0GPcC5bLOgVXizoGV4sQKTEA60V2SfiT03RGo4vK0DsiXUK7pebjQBf4g0AAP//98ZtrQAAAAZJREFUAwDwpvUpxojRjwAAAABJRU5ErkJggg==',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA7klEQVR4AcyR4QnCMBCFj84huIkruIM4lriDK7iEvwX3qP2EB8cl1aQmpcLj7l5z70vrMD5s7KnBpt/hfLQemqLtA6Dppe0ArvudSf5t5VG9r77oDVg+PV8mMRNAlUdlxvcqAviFXIh/HvsqAOHcNIZ8m6sAMQgYUCk+Zy4GEEIgS154kvfVFwMI0ZIqUPVztQhAOGESM4FUeVRmfK8sgMOSDrMsyaPKozJHJQCCOSwxx6WaOQEQXBPw62wC8Avc/l/gLKBFOJfNAlqFZwEtw7MATCBeeEuVfCL+1Kil4ewlAMyWWgdwv9ysh/gSbwAAAP//Nk897gAAAAZJREFUAwD6TfIpQ8OYbQAAAABJRU5ErkJggg==',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA30lEQVR4AcyR0Q3CMAxErc6BxCaswA6IsRA7sAJL8I3EHiUPyVIaOyVtkqqIU+PDvueGYXzJ2FODhM/pepYeCtHyA3DopX0B7seDeVE8lfkxGEVvkAvAv7w/oqIOmZNvEUADJpNJ4YXTUgSgcU6Es4TX0wTgBatXDZjbHkg1IHc1hKMiAFsiBngizoRzVlHjx3IBOsCTZgZT4aPYp05lAITGQ9Tp0JLaAAhfEvCv1wDiAbavBWYBLcJZ1gW0CncBLcNdACaQWHhrZa6IPzXV2nDmDACzpbYBPG8P6SFu4gsAAP//azgxNwAAAAZJREFUAwDjruMplq/NkQAAAABJRU5ErkJggg==',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAyklEQVR4AeyS4QnCMBCFj84huIkruIM4lriDK7iEvwX3qP2EwHF3qTEmpT9a+EjyknsvSTOMDxl7Msj0Hc5H6cFkLZ8AOr1YV8B1vwsPmtNZXHQCDIACDRpozfaLAk7Pl4AtRgOr63FRgC74tb8FfL2xoivipQButDDXZy4RBmCQYCEvxTKnM5dwARhrM8ZpcU3rAjCvMcrVuAC9kN3/G5gNaGHOZsOAVuZhQEvzMACREA1aLe6K+KmWWnPqXABiS5YJuF9u0gNu4g0AAP//j5U9KQAAAAZJREFUAwBKY9cphJFt+gAAAABJRU5ErkJggg==',
];
const INITIAL_MEDAL_GROUPS: InitialMedalGroup[] = [
    {
        orderBase: 0, ruleType: 'accepted_problems',
        thresholds: INITIAL_THRESHOLDS,
        names: [
            '题海·初帆', '题海·试帆', '题海·扬帆', '题海·云帆',
            '题海·逐浪', '题海·踏浪', '题海·破浪', '题海·凌浪',
            '题海·巡海', '题海·驭海', '题海·镇海', '题海·瀚海',
        ],
        description: (value) => `通过 ${value} 道题号不同的题目。`,
    },
    {
        orderBase: 100, ruleType: 'checkin_streak',
        thresholds: INITIAL_THRESHOLDS,
        names: [
            '长明·火种', '长明·微火', '长明·灯火', '长明·炬火',
            '长明·长夜', '长明·守夜', '长明·星夜', '长明·彻夜',
            '长明·极光', '长明·耀光', '长明·恒光', '长明·永光',
        ],
        description: (value) => `连续登录 ${value} 天。`,
    },
    {
        orderBase: 200, ruleType: 'checkin_total',
        thresholds: INITIAL_THRESHOLDS,
        names: [
            '足迹·初步', '足迹·起步', '足迹·迈步', '足迹·阔步',
            '足迹·旅途', '足迹·远途', '足迹·长途', '足迹·征途',
            '足迹·常来', '足迹·常驻', '足迹·常年', '足迹·常伴',
        ],
        description: (value) => `累计登录 ${value} 天。`,
    },
    {
        orderBase: 300, ruleType: 'cat_food_balance',
        thresholds: INITIAL_THRESHOLDS.map((value) => value * 1000),
        names: [
            '粮仓·初囤', '粮仓·小囤', '粮仓·成囤', '粮仓·满囤',
            '粮仓·小仓', '粮仓·成仓', '粮仓·满仓', '粮仓·丰仓',
            '粮仓·丰野', '粮仓·丰丘', '粮仓·丰山', '粮仓·永丰',
        ],
        description: (value) => `猫粮余额曾达到 ${value / 1000} kg。`,
    },
    {
        orderBase: 400, ruleType: 'cat_can_balance',
        thresholds: INITIAL_THRESHOLDS,
        names: [
            '罐藏·初罐', '罐藏·双罐', '罐藏·四罐', '罐藏·满罐',
            '罐藏·入库', '罐藏·小库', '罐藏·满库', '罐藏·丰库',
            '罐藏·宝箱', '罐藏·宝库', '罐藏·宝山', '罐藏·宝藏',
        ],
        description: (value) => `猫罐头持有量达到 ${value} 个。`,
    },
];

// Strip the series prefix from a legacy rung name so the award view (which
// renders「系列 · 等级」) does not repeat it.
function automaticLevelName(ruleType: Oi33MedalAutomaticRuleType, name: string): string {
    const prefix = `${MEDAL_AUTOMATIC_SERIES[ruleType].name}·`;
    const trimmed = String(name || '').trim();
    return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

// Build a series ladder out of the old one-definition-per-threshold layout,
// ordered by threshold.
function automaticLevelsFromFlat(
    ruleType: Oi33MedalAutomaticRuleType,
    defs: any[],
): Oi33MedalLevel[] {
    return [...defs]
        .sort((a, b) => (Number(a.threshold) || 0) - (Number(b.threshold) || 0)
            || String(a._id).localeCompare(String(b._id)))
        .map((def, index) => ({
            level: index + 1,
            name: automaticLevelName(ruleType, def.name),
            description: String(def.description || '')
                || medalAutomaticRuleText(ruleType, Number(def.threshold) || 0),
            imageData: String(def.imageData || INITIAL_MEDAL_IMAGES[
                Math.min(index, INITIAL_MEDAL_IMAGES.length - 1)
            ]),
            imageSize: (Number(def.imageSize) || 24) as Oi33MedalImageSize,
            threshold: Number(def.threshold) || 0,
        }));
}

function automaticSeriesRuleText(
    ruleType: Oi33MedalAutomaticRuleType,
    levels: Oi33MedalLevel[],
): string {
    const top = levels[levels.length - 1];
    if (!top) return MEDAL_AUTOMATIC_SERIES[ruleType].description;
    return `${medalAutomaticRuleText(ruleType, Number(top.threshold) || 0)} 起逐级自动升级`;
}

// Import the five built-in indicators as one upgradable series each. Rungs are
// the old threshold ladder, so the award for a user is the highest rung
// reached. Only missing series are created: a re-import never clobbers a ladder
// an administrator has since edited.
export async function medalImportInitialDefinitions(operator: number) {
    const now = new Date();
    const operations: any[] = INITIAL_MEDAL_GROUPS.map((group) => {
        const meta = MEDAL_AUTOMATIC_SERIES[group.ruleType];
        const levels: Oi33MedalLevel[] = group.thresholds.map((threshold, index) => ({
            level: index + 1,
            name: automaticLevelName(group.ruleType, group.names[index]),
            description: group.description(threshold),
            imageData: INITIAL_MEDAL_IMAGES[index],
            imageSize: 24 as Oi33MedalImageSize,
            threshold,
        }));
        const top = levels[levels.length - 1];
        return {
            updateOne: {
                filter: { _id: meta.id },
                update: {
                    $setOnInsert: {
                        name: meta.name,
                        description: meta.description,
                        imageData: top.imageData,
                        imageSize: 24,
                        order: group.orderBase,
                        rule: automaticSeriesRuleText(group.ruleType, levels),
                        ruleType: group.ruleType,
                        threshold: top.threshold,
                        levels,
                        saleable: false,
                        createdAt: now,
                        updatedAt: now,
                        createdBy: operator,
                    },
                },
                upsert: true,
            },
        };
    });
    const result = await medalColl.bulkWrite(operations, { ordered: false });
    await addLog({
        type: 'medal', userId: operator, action: 'initial_import',
        reason: `${operations.length} series`,
    });
    return {
        total: operations.length,
        inserted: result.upsertedCount || 0,
        existing: result.matchedCount || 0,
        modified: result.modifiedCount || 0,
    };
}

export interface MedalAutomaticMigrationResult {
    ruleTypes: number;
    seriesCreated: number;
    definitionsMerged: number;
    awardsRewritten: number;
    awardsRemoved: number;
    logsRewritten: number;
    meowRewritten: number;
    // One entry per indicator that failed; the others still migrate because the
    // step is idempotent and is meant to be re-runnable.
    errors: string[];
}

// Idempotent migration from the pre-upgrade layout — one automatic definition
// per threshold — to one upgradable series per indicator. Every user's awards
// collapse to the highest rung they reached, and the retired definition ids are
// rewritten in logs and medal announcements. Called by /oi33/migrate.
export async function medalMigrateAutomaticLevels(): Promise<MedalAutomaticMigrationResult> {
    const result: MedalAutomaticMigrationResult = {
        ruleTypes: 0, seriesCreated: 0, definitionsMerged: 0,
        awardsRewritten: 0, awardsRemoved: 0, logsRewritten: 0, meowRewritten: 0,
        errors: [],
    };
    for (const ruleType of AUTOMATIC_RULE_TYPES) {
        // Each indicator is independent: a failure on one (e.g. a legacy
        // duplicate the dedupe below could not resolve) must not stop the rest,
        // and re-running the step continues where it left off.
        try {
        const defs = await medalColl.find({
            ruleType,
            saleable: { $ne: true },
        }).toArray();
        const flat = defs.filter(
            (def) => medalSortedLevels(def).length === 0 && Number(def.threshold) > 0,
        );
        // Nothing to fold once the series has no flat definitions left.
        if (!flat.length) continue;
        result.ruleTypes++;
        const meta = MEDAL_AUTOMATIC_SERIES[ruleType];
        let series: any = defs.find((def) => medalSortedLevels(def).length > 0) || null;
        if (!series) {
            // Reuse the flat definition already carrying the canonical id when
            // possible so an existing public medal id keeps working; otherwise
            // create the canonical series.
            const canonical = flat.find((def) => def._id === meta.id) || null;
            if (canonical) {
                series = canonical;
            } else {
                const levels = automaticLevelsFromFlat(ruleType, flat);
                const top = levels[levels.length - 1];
                const now = new Date();
                await medalColl.insertOne({
                    _id: meta.id,
                    name: meta.name,
                    description: meta.description,
                    rule: automaticSeriesRuleText(ruleType, levels),
                    ruleType,
                    imageData: top.imageData,
                    imageSize: top.imageSize,
                    levels,
                    threshold: top.threshold,
                    order: Math.min(...flat.map((def) => Number(def.order) || 0)),
                    saleable: false,
                    createdAt: now,
                    updatedAt: now,
                    createdBy: 0,
                } as any);
                series = await medalColl.findOne({ _id: meta.id });
                result.seriesCreated++;
            }
        }
        if (!series) continue;
        let levels = medalSortedLevels(series);
        if (!levels.length) {
            // The canonical id was one of the flat medals: give it the ladder
            // built from the whole group and turn it into the series.
            levels = automaticLevelsFromFlat(ruleType, flat);
            const top = levels[levels.length - 1];
            await medalColl.updateOne(
                { _id: series._id },
                {
                    $set: {
                        name: meta.name,
                        description: meta.description,
                        rule: automaticSeriesRuleText(ruleType, levels),
                        imageData: top.imageData,
                        imageSize: top.imageSize,
                        levels,
                        threshold: top.threshold,
                        updatedAt: new Date(),
                    },
                },
            );
            series.levels = levels;
            result.seriesCreated++;
        }
        // Each retired definition maps to the highest series rung it qualifies
        // for; a threshold below the first rung still counts as rung 1.
        const flatLevel = new Map<string, number>();
        for (const def of flat) {
            const rung = medalThresholdLevel(series, Number(def.threshold) || 0);
            flatLevel.set(String(def._id), rung ? Number(rung.level) : 1);
        }
        const seriesId = String(series._id);
        const flatIds = flat.map((def) => String(def._id)).filter((id) => id !== seriesId);
        const awards = await userMedalColl.find({
            medalId: { $in: [...flatIds, seriesId] },
        }).toArray();
        const byUid = new Map<number, any[]>();
        for (const award of awards) {
            const list = byUid.get(Number(award.uid)) || [];
            list.push(award);
            byUid.set(Number(award.uid), list);
        }
        for (const list of byUid.values()) {
            const seriesAward = list.find((award) => String(award.medalId) === seriesId) || null;
            // A series award may itself be a converted flat award (the canonical
            // id was one of the old medals), so seed from its mapped rung too.
            let target = seriesAward
                ? Math.max(Number(seriesAward.level) || 0, flatLevel.get(seriesId) || 0)
                : 0;
            for (const award of list) {
                if (String(award.medalId) === seriesId) continue;
                target = Math.max(target, flatLevel.get(String(award.medalId)) || 0);
            }
            if (target <= 0) target = 1;
            const keeper = seriesAward || list
                .filter((award) => String(award.medalId) !== seriesId)
                .sort((a, b) => (
                    (flatLevel.get(String(b.medalId)) || 0) - (flatLevel.get(String(a.medalId)) || 0)
                ))[0];
            if (!keeper) continue;
            if (String(keeper.medalId) !== seriesId || Number(keeper.level) !== target) {
                await userMedalColl.updateOne(
                    { _id: keeper._id },
                    { $set: { medalId: seriesId, level: target } },
                );
                result.awardsRewritten++;
            }
            const removeIds = list
                .filter((award) => !award._id.equals(keeper._id))
                .map((award) => award._id);
            if (removeIds.length) {
                const removed = await userMedalColl.deleteMany({ _id: { $in: removeIds } });
                result.awardsRemoved += removed.deletedCount || 0;
            }
        }
        // Retire the flat definitions only after every award points at the
        // series; references in logs and medal announcements are rewritten too.
        for (const oldId of flatIds) {
            const level = flatLevel.get(oldId);
            const logs = await logColl.updateMany(
                { medalId: oldId },
                { $set: { medalId: seriesId, ...(level ? { level } : {}) } },
            );
            result.logsRewritten += logs.modifiedCount || 0;
        }
        // `oi33_meow_post` has a unique (uid, medalId) index for medal
        // announcements, so a user holding announcements for several old rungs
        // cannot keep them all once they map to the same series. Collapse each
        // user to one series announcement (a post already on the series wins,
        // otherwise the highest rung) and delete the rest BEFORE rewriting the
        // winner's medalId — a per-id updateMany would fail with E11000.
        const meowPosts = await meowPostColl.find({
            medalId: { $in: [...flatIds, seriesId] },
        }).toArray();
        const meowsByUid = new Map<number, any[]>();
        for (const post of meowPosts) {
            const list = meowsByUid.get(Number(post.uid)) || [];
            list.push(post);
            meowsByUid.set(Number(post.uid), list);
        }
        for (const list of meowsByUid.values()) {
            const seriesPost = list.find((post) => String(post.medalId) === seriesId) || null;
            const keeper = seriesPost || [...list].sort((a, b) => (
                (flatLevel.get(String(b.medalId)) || 0) - (flatLevel.get(String(a.medalId)) || 0)
            ))[0];
            if (!keeper) continue;
            const removeIds = list
                .filter((post) => !post._id.equals(keeper._id))
                .map((post) => post._id);
            if (removeIds.length) {
                await meowPostColl.deleteMany({ _id: { $in: removeIds } });
                result.meowRewritten += removeIds.length;
            }
            if (String(keeper.medalId) !== seriesId) {
                await meowPostColl.updateOne(
                    { _id: keeper._id },
                    { $set: { medalId: seriesId } },
                );
                result.meowRewritten++;
            }
        }
        if (flatIds.length) {
            const removed = await medalColl.deleteMany({ _id: { $in: flatIds } });
            result.definitionsMerged += removed.deletedCount || 0;
        }
        } catch (e: any) {
            result.errors.push(`${ruleType}: ${e?.message || e}`);
        }
    }
    return result;
}

// This is the only entry point automatic rule evaluators should call. The
// unique index makes it safe for several evaluators/processes to race.
export async function medalGrant(
    uid: number,
    medalId: string,
    grantedBy = 0,
    source = 'automatic',
    announce = true,
    level?: number,
): Promise<{ grant: Oi33UserMedal; created: boolean }> {
    const medal = await medalColl.findOne({ _id: medalId });
    if (!medal) throw new ValidationError('奖章不存在。');
    const grant: Oi33UserMedal = {
        _id: new ObjectId(),
        uid,
        medalId,
        earnedAt: new Date(),
        grantedBy,
        source,
    };
    // Upgradable series carry the earned rung on the award itself. The
    // requested level must exist — granting is strict; only rendering is
    // forgiving about rungs an administrator later removed.
    if (medalIsLevelSeries(medal)) {
        const rung = medalLevelOf(medal, level);
        if (!rung) throw new ValidationError('该奖章没有这个等级。');
        grant.level = Number(rung.level);
    } else if (medalCategoryOf(medal) === 'certification') {
        throw new ValidationError('该认证奖章还没有配置任何等级。');
    }
    try {
        await userMedalColl.insertOne(grant);
    } catch (e: any) {
        if (e?.code !== 11000) throw e;
        const existing = await userMedalColl.findOne({ uid, medalId });
        if (!existing) throw e;
        return { grant: existing, created: false };
    }

    // Managers (realname_flag >= 2) do not get an automatic meow post.
    // Announcements are also limited to auctionable (saleable) medals and
    // manual admin grants; automatic rule, auction and contract grants stay
    // silent.
    if (announce && (medal.saleable === true || source === 'manual')
        && await medalAnnounceAllowed(uid)) {
        try {
            const post = await meowMedalPostAdd(uid, medal, medalAwardView(grant, medal));
            await userMedalColl.updateOne(
                { _id: grant._id },
                { $set: { announcementPostId: post._id } },
            );
            grant.announcementPostId = post._id;
        } catch (e) {
            await userMedalColl.deleteOne({ _id: grant._id });
            throw e;
        }
    }
    try {
        await addLog({
            type: 'medal', userId: uid, sender: grantedBy,
            action: 'grant', medalId, level: grant.level,
        });
    } catch (e) {
        console.error('[oi33] medal grant log failed:', e);
    }
    return { grant, created: true };
}

// Managers (realname_flag >= 2) never receive automatic announcement posts.
async function medalAnnounceAllowed(uid: number) {
    const recipient = await userColl.findOne({ _id: uid }, { projection: { realname_flag: 1 } });
    return (Number(recipient?.realname_flag) || 0) < 2;
}

// Automatic (OJ 成就奖章) rule upgrade: raise an existing award to the rung the
// user has just reached, or create the award at that rung. It never downgrades,
// never publishes a new announcement, and only refreshes an announcement that
// already exists.
async function medalUpgradeAwardLevel(
    uid: number,
    medal: any,
    targetLevel: number,
    source: string,
): Promise<{ created: boolean; upgraded: boolean; previousLevel: number | null; level: number }> {
    const existing = await userMedalColl.findOne({ uid, medalId: medal._id });
    if (!existing) {
        await medalGrant(uid, medal._id, 0, source, false, targetLevel);
        return { created: true, upgraded: true, previousLevel: null, level: targetLevel };
    }
    const previousLevel = Number.isSafeInteger(Number(existing.level)) && Number(existing.level) > 0
        ? Number(existing.level)
        : null;
    if (previousLevel !== null && targetLevel <= previousLevel) {
        return { created: false, upgraded: false, previousLevel, level: previousLevel };
    }
    await userMedalColl.updateOne(
        { _id: existing._id },
        { $set: { level: targetLevel, earnedAt: new Date(), source } },
    );
    if (existing.announcementPostId) {
        try {
            const refreshed = await userMedalColl.findOne({ _id: existing._id });
            await meowMedalPostAdd(uid, medal, medalAwardView(refreshed, medal));
        } catch (e) {
            // A failed refresh must not roll back a legitimate upgrade.
            console.error('[oi33] medal level announcement refresh failed:', e);
        }
    }
    await addLog({
        type: 'medal', userId: uid, action: 'level_update',
        medalId: medal._id, level: targetLevel,
        reason: `Lv.${previousLevel ?? '-'} → Lv.${targetLevel}（自动升级）`,
    });
    return { created: false, upgraded: true, previousLevel, level: targetLevel };
}

// Upgradable series are a ladder: setting a level on a user who does not hold
// the series yet creates the award, and setting a new level on an existing
// award upgrades (or corrects) it in place. Re-announcing follows the same
// manual-grant rule as a fresh grant. Administrators may move either direction;
// the automatic evaluator only ever upgrades.
export async function medalSetLevel(
    uid: number,
    medalId: string,
    level: number,
    operator: number,
): Promise<{ created: boolean; previousLevel: number | null; level: number }> {
    const medal = await medalColl.findOne({ _id: medalId });
    if (!medal) throw new ValidationError('奖章不存在。');
    if (!medalIsLevelSeries(medal)) {
        throw new ValidationError('只有可升级的奖章系列才能按等级发放。');
    }
    const rung = medalLevelOf(medal, level);
    if (!rung) throw new ValidationError('该奖章没有这个等级。');
    const target = Number(rung.level);
    const existing = await userMedalColl.findOne({ uid, medalId });
    if (!existing) {
        await medalGrant(uid, medalId, operator, 'manual', true, target);
        return { created: true, previousLevel: null, level: target };
    }
    const previousLevel = Number.isSafeInteger(Number(existing.level)) && existing.level
        ? Number(existing.level)
        : null;
    if (previousLevel === target) return { created: false, previousLevel, level: target };
    await userMedalColl.updateOne(
        { _id: existing._id },
        { $set: { level: target, earnedAt: new Date(), grantedBy: operator, source: 'manual' } },
    );
    // The existing announcement describes the level just replaced;
    // meowMedalPostAdd rewrites that same post's text (keeping its likes and id)
    // so a level change never leaves a stale rung on someone's timeline.
    if (await medalAnnounceAllowed(uid)) {
        try {
            const refreshed = await userMedalColl.findOne({ _id: existing._id });
            const post = await meowMedalPostAdd(uid, medal, medalAwardView(refreshed, medal));
            await userMedalColl.updateOne(
                { _id: existing._id },
                { $set: { announcementPostId: post._id } },
            );
        } catch (e) {
            // A failed announcement must not roll back a legitimate level change.
            console.error('[oi33] medal level announcement failed:', e);
        }
    }
    await addLog({
        type: 'medal', userId: uid, sender: operator,
        action: 'level_update', medalId, level: target,
        reason: `Lv.${previousLevel ?? '-'} → Lv.${target}`,
    });
    return { created: false, previousLevel, level: target };
}

export async function medalRevoke(
    uid: number,
    medalId: string,
    operator: number,
) {
    const grant = await userMedalColl.findOne({ uid, medalId });
    if (!grant) return false;
    await userMedalColl.deleteOne({ _id: grant._id });
    if (grant.announcementPostId) {
        await meowDelete(grant.announcementPostId, operator);
    }
    await addLog({
        type: 'medal', userId: uid, sender: operator,
        action: 'revoke', medalId,
    });
    return true;
}
