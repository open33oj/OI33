import { db } from 'hydrooj';
import { addLog } from './log';
import { userColl } from './user';
import { algorithmListItems, normalizeDifficulty } from './algorithm-item';
import type {
    Oi33AlgorithmConfig, Oi33AlgorithmItem,
} from './types';

// Item persistence/administration lives in algorithm-item.ts and the bundled
// NOI outline + id import/migration in algorithm-outline.ts. Both are
// re-exported here so `model/algorithm` keeps exporting the same names.
export {
    algorithmListItems, algorithmGetItem, algorithmCountItems,
    algorithmSaveItem, algorithmDeleteItem, algorithmSetItemEnabled, algorithmBulkSetEnabled,
} from './algorithm-item';
export type { AlgorithmItemInput } from './algorithm-item';
export {
    normalizeOutlineId, algorithmOutlineData, algorithmOutlineMeta,
    algorithmImportOutline, algorithmEnsureOutlineImported,
    algorithmDropBasicsSection, algorithmMigrateOutlineIds,
} from './algorithm-outline';
export type {
    AlgorithmOutline, AlgorithmOutlineEntry,
    AlgorithmImportResult, AlgorithmIdMigrationResult,
} from './algorithm-outline';

// --- Collections ---

export const algorithmItemColl = db.collection('oi33_algorithm_item');
export const userAlgorithmColl = db.collection('oi33_user_algorithm');
export const algorithmConfigColl = db.collection('oi33_algorithm_config');

// Students may submit their self-assessment once per Asia/Shanghai calendar
// month; teachers are exempt. Kept in sync with school-cat's Shanghai helpers.
const TIME_ZONE = 'Asia/Shanghai';

// 'YYYY-MM' of the Asia/Shanghai calendar month `now` falls in. Used as the
// monthly quota key so the comparison never depends on the server timezone.
export function algorithmMonthKey(now = new Date()): string {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}`;
}

// First day of the month after `now`, as a display-ready 'YYYY-MM-DD'.
export function algorithmNextUpdateDate(now = new Date()): string {
    const [year, month] = algorithmMonthKey(now).split('-').map((value) => Number(value));
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    return `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
}

// --- Mastery scale ---

// The single 4-level scale shared by the student's self-assessment and the
// teacher's assessment. Index = stored value; 0 is the implicit value of an
// item the user has not rated at all. The frontend colours these four levels
// with the 洛谷 difficulty palette (灰 / 红 / 黄 / 蓝), see the .oi33-alg-*
// rules in templates/partials/oi33_algorithm.html.
export const ALGORITHM_LEVEL_NAMES = ['没学', '不会', '不熟', '熟练'];
export const ALGORITHM_LEVELS = ALGORITHM_LEVEL_NAMES.map((name, value) => ({ value, name }));
export const ALGORITHM_MAX_LEVEL = ALGORITHM_LEVEL_NAMES.length - 1;

export const ALGORITHM_CONFIG_ID = 'main';
export const ALGORITHM_OUTLINE_SOURCE = 'noi2025';
// OI33 deliberately excludes the outline's 「基础知识与编程环境」 section
// (计算机基本构成、操作系统、开发环境使用等): it says nothing about a student's
// algorithmic ability. It is stripped from the bundled outline JSON, and the
// migration deletes it from installs that imported it before the change.
export const ALGORITHM_DROPPED_SECTION = '基础知识与编程环境';

export const ALGORITHM_MAX_TEXT = 200;
export const ALGORITHM_MAX_NOTE = 500;
export const ALGORITHM_MAX_GROUP_NAME = 60;
export const ALGORITHM_MAX_DIFFICULTY = 10;
export const ALGORITHM_MAX_ITEMS = 5000;

export function algorithmNormalizeLevel(value: unknown): number {
    const level = Math.floor(Number(value));
    if (!Number.isSafeInteger(level) || level < 0 || level > ALGORITHM_MAX_LEVEL) return 0;
    return level;
}

export function algorithmLevelName(level: unknown): string {
    return ALGORITHM_LEVEL_NAMES[algorithmNormalizeLevel(level)];
}

// Both rating upserts and the outline import can lose a race against a
// concurrent writer that inserts the same unique key between our read and our
// write. MongoDB reports E11000 in a few shapes (plain error, bulk write
// result, or per-operation writeErrors), so detect all of them and let the
// caller retry those ops as plain updates.
export function isDuplicateKeyError(error: any): boolean {
    if (!error) return false;
    if (error.code === 11000 || error.code === 11001) return true;
    const writeErrors = error.writeErrors || (typeof error.getWriteErrors === 'function' ? error.getWriteErrors() : null);
    if (Array.isArray(writeErrors) && writeErrors.some((item: any) => (item?.code ?? item?.err?.code) === 11000)) {
        return true;
    }
    const resultErrors = error.result?.getWriteErrors ? error.result.getWriteErrors() : null;
    return Array.isArray(resultErrors) && resultErrors.some((item: any) => item?.code === 11000);
}

// --- Indexes ---

export async function ensureAlgorithmIndexes() {
    await Promise.all([
        algorithmItemColl.createIndex({ order: 1, _id: 1 }),
        algorithmItemColl.createIndex({ enabled: 1, order: 1 }),
        algorithmItemColl.createIndex({ levelId: 1, sectionId: 1, order: 1 }),
        algorithmItemColl.createIndex({ source: 1 }),
        userAlgorithmColl.createIndex({ uid: 1, itemId: 1 }, { unique: true }),
        userAlgorithmColl.createIndex({ itemId: 1 }),
        userAlgorithmColl.createIndex({ updatedAt: -1 }),
    ]);
}

// --- Configuration ---

export async function algorithmGetConfig(): Promise<Oi33AlgorithmConfig> {
    const doc = await algorithmConfigColl.findOne({ _id: ALGORITHM_CONFIG_ID });
    return {
        _id: ALGORITHM_CONFIG_ID,
        selfEdit: doc?.selfEdit !== false,
        ...(doc?.outlineVersion ? { outlineVersion: doc.outlineVersion } : {}),
        ...(doc?.lastImportAt ? { lastImportAt: doc.lastImportAt } : {}),
        updatedAt: doc?.updatedAt || new Date(0),
        ...(doc?.updatedBy ? { updatedBy: doc.updatedBy } : {}),
    };
}

export async function algorithmSaveConfig(
    patch: { selfEdit?: boolean }, operator: number,
): Promise<Oi33AlgorithmConfig> {
    const set: Record<string, any> = { updatedAt: new Date(), updatedBy: operator };
    if (patch.selfEdit !== undefined) set.selfEdit = !!patch.selfEdit;
    await algorithmConfigColl.updateOne(
        { _id: ALGORITHM_CONFIG_ID }, { $set: set }, { upsert: true },
    );
    await addLog({
        type: 'algorithm', userId: operator, action: 'config_update',
        reason: `selfEdit=${set.selfEdit === undefined ? 'unchanged' : !!set.selfEdit}`,
    });
    return algorithmGetConfig();
}

// --- Grouping ---

interface AlgorithmGroupingFields {
    _id: string;
    levelId: string;
    levelName: string;
    sectionId: string;
    sectionName: string;
    subsectionId?: string | null;
    subsectionName?: string | null;
}

export interface AlgorithmGroupedSubsection<T> { id: string; name: string; items: T[] }
export interface AlgorithmGroupedSection<T> {
    id: string; name: string; items: T[]; subsections: AlgorithmGroupedSubsection<T>[];
}
export interface AlgorithmGroupedLevel<T> { id: string; name: string; sections: AlgorithmGroupedSection<T>[] }

// Builds the 级 → 板块 → 子板块 tree. Input order is preserved (callers pass
// items already sorted by `order`), so the outline layout is reproduced as-is
// and custom items land exactly where their order puts them.
export function algorithmGroupItems<T extends AlgorithmGroupingFields>(items: T[]): AlgorithmGroupedLevel<T>[] {
    const levels: AlgorithmGroupedLevel<T>[] = [];
    const levelMap = new Map<string, {
        group: AlgorithmGroupedLevel<T>;
        sections: Map<string, AlgorithmGroupedSection<T>>;
        subsections: Map<string, Map<string, AlgorithmGroupedSubsection<T>>>;
    }>();
    for (const item of items) {
        let level = levelMap.get(item.levelId);
        if (!level) {
            const group: AlgorithmGroupedLevel<T> = { id: item.levelId, name: item.levelName, sections: [] };
            level = { group, sections: new Map(), subsections: new Map() };
            levelMap.set(item.levelId, level);
            levels.push(group);
        }
        let section = level.sections.get(item.sectionId);
        if (!section) {
            section = { id: item.sectionId, name: item.sectionName, items: [], subsections: [] };
            level.sections.set(item.sectionId, section);
            level.subsections.set(item.sectionId, new Map());
            level.group.sections.push(section);
        }
        if (item.subsectionId) {
            const subsectionMap = level.subsections.get(item.sectionId)!;
            let subsection = subsectionMap.get(item.subsectionId);
            if (!subsection) {
                subsection = { id: item.subsectionId, name: item.subsectionName || '未命名子板块', items: [] };
                subsectionMap.set(item.subsectionId, subsection);
                section.subsections.push(subsection);
            }
            subsection.items.push(item);
        } else {
            section.items.push(item);
        }
    }
    return levels;
}

// --- Views, stats and the profile panel ---

export interface AlgorithmItemView extends Oi33AlgorithmItem {
    // Global index inside the panel, used as the no-JS form field suffix.
    idx: number;
    level: number;
    rated: boolean;
    // Who produced the current rating ('self' = the student, 'teacher' = a
    // teacher); distinct from the item's own `source` (outline vs custom).
    // Display-only: a student may overwrite a teacher value (once a month).
    ratingSource: 'self' | 'teacher' | null;
    ratedAt: Date | null;
    ratedBy: number | null;
}

export interface AlgorithmStats {
    total: number;
    rated: number;
    // counts[level] over every item (unrated items count as 没学).
    counts: number[];
    // 0-100 mastery score: sum(level) / (maxLevel * total).
    score: number;
}

export interface AlgorithmSubsectionGroup extends AlgorithmGroupedSubsection<AlgorithmItemView> {
    stats: AlgorithmStats;
}
export interface AlgorithmSectionGroup extends AlgorithmGroupedSection<AlgorithmItemView> {
    stats: AlgorithmStats;
    subsections: AlgorithmSubsectionGroup[];
}
export interface AlgorithmLevelGroup extends AlgorithmGroupedLevel<AlgorithmItemView> {
    stats: AlgorithmStats;
    sections: AlgorithmSectionGroup[];
}

// One progress row per NOI outline difficulty coefficient (1-10); 0 collects
// the items the outline left unmarked. Only non-empty buckets are emitted.
export interface AlgorithmDifficultyStat extends AlgorithmStats {
    value: number;
    name: string;
}

export interface AlgorithmProfilePanel {
    groups: AlgorithmLevelGroup[];
    // Per-difficulty progress, alongside the per-level (入门/提高/NOI) one.
    difficulties: AlgorithmDifficultyStat[];
    stats: AlgorithmStats;
    levels: Array<{ value: number; name: string }>;
    maxLevel: number;
    total: number;
    selfEdit: boolean;
}

export function algorithmComputeStats(items: Array<{ level: number; rated: boolean }>): AlgorithmStats {
    const counts = ALGORITHM_LEVEL_NAMES.map(() => 0);
    let rated = 0;
    let sum = 0;
    for (const item of items) {
        const level = algorithmNormalizeLevel(item.level);
        counts[level]++;
        sum += level;
        if (item.rated) rated++;
    }
    const total = items.length;
    const max = ALGORITHM_MAX_LEVEL;
    const score = total && max ? Math.round((sum * 100) / (max * total)) : 0;
    return { total, rated, counts, score };
}

// --- Monthly self-assessment quota ---

export interface AlgorithmSelfQuota {
    // 'YYYY-MM' the student already spent their submit on, or null.
    month: string | null;
    at: Date | null;
    // The current Asia/Shanghai month, exposed so the panel can compare.
    currentMonth: string;
    canUpdate: boolean;
    // First day of next month ('YYYY-MM-DD'), for the "next update" hint.
    nextUpdateAt: string;
}

export async function algorithmGetSelfQuota(uid: number, now = new Date()): Promise<AlgorithmSelfQuota> {
    const doc: any = await userColl.findOne(
        { _id: uid } as any,
        { projection: { algorithm_self_month: 1, algorithm_self_at: 1 } },
    );
    const month = doc?.algorithm_self_month ? String(doc.algorithm_self_month) : null;
    const currentMonth = algorithmMonthKey(now);
    return {
        month,
        at: doc?.algorithm_self_at || null,
        currentMonth,
        canUpdate: month !== currentMonth,
        nextUpdateAt: algorithmNextUpdateDate(now),
    };
}

// Atomically claim the current month. Returns false when the student already
// spent it. The ensure step covers accounts that have no oi33_user document
// yet; the conditional update itself is what makes the claim race-free (the
// filter is re-evaluated against the just-written document).
export async function algorithmClaimSelfQuota(uid: number, month: string, now = new Date()): Promise<boolean> {
    await userColl.updateOne({ _id: uid } as any, { $setOnInsert: { _id: uid } } as any, { upsert: true });
    const result = await userColl.updateOne(
        { _id: uid, algorithm_self_month: { $ne: month } } as any,
        { $set: { algorithm_self_month: month, algorithm_self_at: now } } as any,
    );
    return !!result.matchedCount;
}

// Roll a claim back (submit failed, or nothing actually changed) so the month
// is not silently consumed.
export async function algorithmReleaseSelfQuota(uid: number, month: string): Promise<void> {
    await userColl.updateOne(
        { _id: uid, algorithm_self_month: month } as any,
        { $unset: { algorithm_self_month: '', algorithm_self_at: '' } } as any,
    );
}

// Admin action: give the student this month's submit back.
export async function algorithmResetSelfQuota(uid: number, operator: number): Promise<void> {
    await userColl.updateOne(
        { _id: uid } as any,
        { $unset: { algorithm_self_month: '', algorithm_self_at: '' } } as any,
    );
    await addLog({ type: 'algorithm', userId: operator, uid, action: 'reset_self_quota' });
}

// Everything the mastery panel needs for one user. The once-per-month quota is
// handled by the handler (claim/rollback); this view is pure read data.
export async function algorithmProfileView(
    uid: number, viewerUid: number,
): Promise<AlgorithmProfilePanel> {
    const [items, records, config] = await Promise.all([
        algorithmListItems({ enabledOnly: true }),
        userAlgorithmColl.find({ uid }).toArray(),
        algorithmGetConfig(),
    ]);
    const recordMap = new Map(records.map((record: any) => [String(record.itemId), record]));
    let idx = 0;
    const views: AlgorithmItemView[] = items.map((item) => {
        const record: any = recordMap.get(item._id);
        return {
            ...item,
            idx: idx++,
            level: record ? algorithmNormalizeLevel(record.level) : 0,
            rated: !!record,
            ratingSource: record ? (record.source === 'teacher' ? 'teacher' : 'self') : null,
            ratedAt: record?.updatedAt || null,
            ratedBy: record?.updatedBy ?? null,
        };
    });
    // Every level also carries per-section and per-subsection stats so the
    // display page can show progress on each collapsible heading.
    const groups: AlgorithmLevelGroup[] = algorithmGroupItems(views).map((group) => ({
        ...group,
        stats: algorithmComputeStats(group.sections.flatMap(
            (section) => section.items.concat(...section.subsections.map((sub) => sub.items)),
        )),
        sections: group.sections.map((section) => ({
            ...section,
            stats: algorithmComputeStats(
                section.items.concat(...section.subsections.map((sub) => sub.items)),
            ),
            subsections: section.subsections.map((subsection) => ({
                ...subsection,
                stats: algorithmComputeStats(subsection.items),
            })),
        })),
    }));
    const difficultyBuckets = new Map<number, AlgorithmItemView[]>();
    for (const view of views) {
        const difficulty = normalizeDifficulty(view.difficulty);
        const bucket = difficultyBuckets.get(difficulty);
        if (bucket) bucket.push(view);
        else difficultyBuckets.set(difficulty, [view]);
    }
    const difficulties: AlgorithmDifficultyStat[] = [...difficultyBuckets.entries()]
        // 未标注 (0) sorts after the numbered coefficients, which stay ascending.
        .sort((a, b) => (a[0] || ALGORITHM_MAX_DIFFICULTY + 1) - (b[0] || ALGORITHM_MAX_DIFFICULTY + 1))
        .map(([value, bucket]) => ({
            value,
            name: value >= 1 ? `难度 ${value}` : '未标注',
            ...algorithmComputeStats(bucket),
        }));
    return {
        groups,
        difficulties,
        stats: algorithmComputeStats(views),
        levels: ALGORITHM_LEVELS,
        maxLevel: ALGORITHM_MAX_LEVEL,
        total: views.length,
        selfEdit: config.selfEdit,
    };
}

// --- Rating writes ---

export interface AlgorithmLevelEntry {
    itemId: string;
    level: unknown;
    // The value the client rendered for this row. When present, `onlyChanges`
    // compares against it instead of the stored value, so a stale untouched
    // row can never overwrite a concurrent teacher edit.
    original?: unknown;
}

// A submitted level is one of 0..3. A negative/absent value deletes the rating
// (the mastery UI no longer offers that option — rows without a record simply
// show as 没学 — but programmatic callers may still use it to clear a row).
// Out-of-range values are clamped into 0..3 so one malformed field cannot fail
// a whole bulk save.
function parseSubmittedLevel(value: unknown): number | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.min(ALGORITHM_MAX_LEVEL, Math.floor(parsed));
}

export async function algorithmSetLevels(
    uid: number,
    entries: AlgorithmLevelEntry[],
    operator: number,
    opts: { onlyChanges?: boolean } = {},
): Promise<{ updated: number; cleared: number; skipped: string[]; unchanged: number }> {
    const targetIsSelf = operator === uid;
    const source: 'self' | 'teacher' = targetIsSelf ? 'self' : 'teacher';
    // De-duplicate first (a crafted batch body may repeat an item) so the last
    // submitted value wins and one item is never written twice.
    const levelByItem = new Map<string, { level: number | null; original: number | null | undefined }>();
    for (const entry of entries) {
        const itemId = String(entry.itemId || '');
        if (!itemId) continue;
        levelByItem.set(itemId, {
            level: parseSubmittedLevel(entry.level),
            original: entry.original === undefined ? undefined : parseSubmittedLevel(entry.original),
        });
    }
    const wanted = [...levelByItem.keys()];
    if (!wanted.length) return { updated: 0, cleared: 0, skipped: [], unchanged: 0 };
    const [items, existing] = await Promise.all([
        algorithmItemColl.find({ _id: { $in: wanted } }).project({ _id: 1 }).toArray(),
        userAlgorithmColl.find({ uid, itemId: { $in: wanted } }).toArray(),
    ]);
    const valid = new Set(items.map((item: any) => String(item._id)));
    const existingMap = new Map(existing.map((record: any) => [String(record.itemId), record]));
    const skipped: string[] = [];
    const now = new Date();
    const ops: any[] = [];
    const clearIds: string[] = [];
    let unchanged = 0;
    for (const [itemId, submitted] of levelByItem) {
        const { level, original } = submitted;
        if (!valid.has(itemId)) {
            skipped.push(itemId);
            continue;
        }
        const record: any = existingMap.get(itemId);
        const current = record ? algorithmNormalizeLevel(record.level) : null;
        // The batch form submits every row at once, so skip rows the user never
        // actually touched instead of mass-marking them as rated. The client
        // sends the value it rendered (`original`); comparing against that
        // (falling back to the stored value for programmatic callers) means an
        // untouched row is skipped even if a teacher changed it while the page
        // was open. Rows without a record render as 没学 (0), so leaving one
        // alone writes nothing while an explicit change still lands.
        const baseline = original === undefined ? current : original;
        if (opts.onlyChanges && level === baseline) {
            unchanged++;
            continue;
        }
        if (level === null) {
            if (record) clearIds.push(itemId);
            else unchanged++;
            continue;
        }
        ops.push({
            updateOne: {
                filter: { uid, itemId },
                update: {
                    $set: { level, source, updatedBy: operator, updatedAt: now },
                    $setOnInsert: { createdAt: now },
                },
                upsert: true,
            },
        });
    }
    if (ops.length) {
        try {
            await userAlgorithmColl.bulkWrite(ops, { ordered: false });
        } catch (e) {
            if (!isDuplicateKeyError(e)) throw e;
            // A concurrent writer created the same (uid, itemId); the rows now
            // exist, so replaying the ops as upserts simply updates them.
            for (const op of ops) {
                await userAlgorithmColl.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: true });
            }
        }
    }
    if (clearIds.length) {
        await userAlgorithmColl.deleteMany({ uid, itemId: { $in: clearIds } });
    }
    const updated = ops.length;
    const cleared = clearIds.length;
    if (updated || cleared) {
        await addLog({
            type: 'algorithm', userId: operator, uid,
            action: source === 'teacher' ? 'teacher_set' : 'self_set',
            reason: `${updated} 个知识点${cleared ? `，清除 ${cleared} 个` : ''}`,
        });
    }
    return { updated, cleared, skipped, unchanged };
}

