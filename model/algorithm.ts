import { readFileSync } from 'fs';
import path from 'path';
import { db, ValidationError } from 'hydrooj';
import { addLog } from './log';
import { userColl } from './user';
import type {
    Oi33AlgorithmConfig, Oi33AlgorithmItem, Oi33UserAlgorithm,
} from './types';

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
// item the user has not rated at all.
export const ALGORITHM_LEVEL_NAMES = ['没学', '了解概念', '会模板题', '熟练掌握'];
export const ALGORITHM_LEVELS = ALGORITHM_LEVEL_NAMES.map((name, value) => ({ value, name }));
export const ALGORITHM_MAX_LEVEL = ALGORITHM_LEVEL_NAMES.length - 1;

export const ALGORITHM_CONFIG_ID = 'main';
export const ALGORITHM_OUTLINE_SOURCE = 'noi2025';

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

function normalizeDifficulty(value: unknown): number {
    const difficulty = Math.floor(Number(value));
    if (!Number.isSafeInteger(difficulty) || difficulty < 0 || difficulty > ALGORITHM_MAX_DIFFICULTY) return 0;
    return difficulty;
}

// Both rating upserts and the outline import can lose a race against a
// concurrent writer that inserts the same unique key between our read and our
// write. MongoDB reports E11000 in a few shapes (plain error, bulk write
// result, or per-operation writeErrors), so detect all of them and let the
// caller retry those ops as plain updates.
function isDuplicateKeyError(error: any): boolean {
    if (!error) return false;
    if (error.code === 11000 || error.code === 11001) return true;
    const writeErrors = error.writeErrors || (typeof error.getWriteErrors === 'function' ? error.getWriteErrors() : null);
    if (Array.isArray(writeErrors) && writeErrors.some((item: any) => (item?.code ?? item?.err?.code) === 11000)) {
        return true;
    }
    const resultErrors = error.result?.getWriteErrors ? error.result.getWriteErrors() : null;
    return Array.isArray(resultErrors) && resultErrors.some((item: any) => item?.code === 11000);
}

// --- Bundled NOI outline ---

export interface AlgorithmOutlineEntry {
    id: string;
    text: string;
    levelId: string;
    levelName: string;
    sectionId: string;
    sectionName: string;
    subsectionId: string | null;
    subsectionName: string | null;
    difficulty: number;
    order: number;
}

export interface AlgorithmOutline {
    title: string;
    edition: string;
    items: AlgorithmOutlineEntry[];
}

const outlineFile = path.join(__dirname, 'noi-outline-2025.json');
let outlineCache: AlgorithmOutline | null = null;

// The official document numbers this chapter 「二、内容」, so every raw id
// starts with `2.` and appends the item ordinal with a dash, e.g. `2.1.1-12`
// or `2.1.2.11-5`. We drop the document number and use dots throughout, so the
// stored ids read `1.1.12` / `1.2.11.5`. Only ids in that shape are touched;
// custom group ids (`c:` / `s:`) and `custom-*` item ids pass through.
export function normalizeOutlineId(raw: unknown): string {
    return String(raw ?? '')
        .trim()
        .replace(/^2\./, '')
        .replace(/-(\d+)$/, '.$1');
}

// The outline ships with the addon (model/noi-outline-2025.json) so the plugin
// stays self-contained: administrators import it once, then edit the resulting
// items freely without depending on an external file path.
export function algorithmOutlineData(): AlgorithmOutline {
    if (!outlineCache) {
        const raw = JSON.parse(readFileSync(outlineFile, 'utf-8'));
        const list = Array.isArray(raw?.items) ? raw.items : [];
        const items: AlgorithmOutlineEntry[] = list.map((entry: any, index: number) => {
            const rawId = String(entry?.id || '').trim();
            const subsectionName = entry?.subsection ? String(entry.subsection).trim() : '';
            // The flat item id ends with `-<index within subsection>`; the
            // prefix is the subsection id (and equals the section id for
            // items that hang directly off a section).
            const rawSubsectionId = subsectionName && rawId.includes('-')
                ? rawId.slice(0, rawId.lastIndexOf('-'))
                : null;
            const subsectionId = rawSubsectionId ? normalizeOutlineId(rawSubsectionId) : null;
            return {
                id: normalizeOutlineId(rawId),
                text: String(entry?.text || '').trim(),
                levelId: normalizeOutlineId(entry?.levelId),
                levelName: String(entry?.level || '').trim(),
                sectionId: normalizeOutlineId(entry?.sectionId),
                sectionName: String(entry?.section || '').trim(),
                subsectionId,
                subsectionName: subsectionId ? subsectionName : null,
                difficulty: normalizeDifficulty(entry?.difficulty),
                order: Number.isFinite(Number(entry?.index)) ? Number(entry.index) : index + 1,
            };
        }).filter((item: AlgorithmOutlineEntry) => item.id && item.text);
        outlineCache = {
            title: String(raw?.meta?.title || '全国青少年信息学奥林匹克系列竞赛大纲'),
            edition: String(raw?.meta?.edition || '2025 年修订版'),
            items,
        };
    }
    return outlineCache;
}

export function algorithmOutlineMeta() {
    const outline = algorithmOutlineData();
    return {
        title: outline.title,
        edition: outline.edition,
        itemCount: outline.items.length,
    };
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

// --- Item reads ---

export async function algorithmListItems(opts: { enabledOnly?: boolean } = {}): Promise<Oi33AlgorithmItem[]> {
    const filter = opts.enabledOnly ? { enabled: { $ne: false } } : {};
    const docs = await algorithmItemColl.find(filter as any).sort({ order: 1, _id: 1 }).toArray();
    return docs as unknown as Oi33AlgorithmItem[];
}

export async function algorithmGetItem(id: string): Promise<Oi33AlgorithmItem | null> {
    const doc = await algorithmItemColl.findOne({ _id: String(id) });
    return (doc as unknown as Oi33AlgorithmItem) || null;
}

export async function algorithmCountItems(): Promise<number> {
    return await algorithmItemColl.countDocuments({});
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

export interface AlgorithmLevelGroup extends AlgorithmGroupedLevel<AlgorithmItemView> {
    stats: AlgorithmStats;
}

export interface AlgorithmProfilePanel {
    groups: AlgorithmLevelGroup[];
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
    const groups: AlgorithmLevelGroup[] = algorithmGroupItems(views).map((group) => ({
        ...group,
        stats: algorithmComputeStats(views.filter((view) => view.levelId === group.id)),
    }));
    return {
        groups,
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

// A submitted level is one of 0..3, or a negative/absent value meaning
// "未评定" — remove the rating entirely. This lets a student undo a
// self-rating, and lets the no-JS form distinguish an untouched unrated row
// (still -1) from a teacher explicitly asserting 没学 (0). Out-of-range values
// are clamped into 0..3 so one malformed field cannot fail a whole bulk save.
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
        // The batch form submits every select at once, so skip rows the user
        // never actually touched instead of mass-marking them as rated.
        // The client sends the value it rendered (`original`); comparing
        // against that (falling back to the stored value for programmatic
        // callers) means an untouched row is skipped even if a teacher changed
        // it while the page was open. A null baseline is an unrated row, so an
        // explicit 没学 is still distinguishable from an untouched one.
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

// --- Item writes (administration) ---

export interface AlgorithmItemInput {
    id?: string;
    text: string;
    note?: string;
    levelName: string;
    sectionName: string;
    subsectionName?: string;
    difficulty?: unknown;
    order?: unknown;
    enabled?: boolean;
}

function generateCustomItemId() {
    return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Resolve the stored 级/板块/子板块 ids for a submitted item. When the name is
// unchanged the existing id is kept; a name that already exists elsewhere is
// reused (so a hand-typed section merges into the real one); a genuinely new
// name gets a deterministic `c:`/`s:` id so repeated saves group together.
async function resolveGrouping(
    existing: Oi33AlgorithmItem | null,
    levelName: string, sectionName: string, subsectionName: string,
): Promise<{ levelId: string; sectionId: string; subsectionId: string | null }> {
    let levelId = existing?.levelId || '';
    if (!levelId || existing!.levelName !== levelName) {
        const found: any = await algorithmItemColl.findOne({ levelName }, { projection: { levelId: 1 } });
        levelId = found?.levelId || `c:${levelName}`;
    }
    let sectionId = existing?.sectionId || '';
    if (!sectionId || existing!.levelId !== levelId || existing!.sectionName !== sectionName) {
        const found: any = await algorithmItemColl.findOne(
            { levelId, sectionName }, { projection: { sectionId: 1 } },
        );
        sectionId = found?.sectionId || `c:${levelId}:${sectionName}`;
    }
    let subsectionId: string | null = existing?.subsectionId || null;
    if (!subsectionName) {
        subsectionId = null;
    } else if (!subsectionId || existing!.subsectionName !== subsectionName || existing!.sectionId !== sectionId) {
        const found: any = await algorithmItemColl.findOne(
            { sectionId, subsectionName }, { projection: { subsectionId: 1 } },
        );
        subsectionId = found?.subsectionId || `s:${sectionId}:${subsectionName}`;
    }
    return { levelId, sectionId, subsectionId };
}

export async function algorithmSaveItem(input: AlgorithmItemInput, operator: number): Promise<Oi33AlgorithmItem> {
    const text = String(input.text || '').trim();
    if (!text || [...text].length > ALGORITHM_MAX_TEXT) {
        throw new ValidationError(`算法项目名称应为 1–${ALGORITHM_MAX_TEXT} 字。`);
    }
    const note = String(input.note || '').trim();
    if ([...note].length > ALGORITHM_MAX_NOTE) {
        throw new ValidationError(`备注不能超过 ${ALGORITHM_MAX_NOTE} 字。`);
    }
    const levelName = String(input.levelName || '').trim();
    const sectionName = String(input.sectionName || '').trim();
    const subsectionName = String(input.subsectionName || '').trim();
    for (const [label, value] of [['级别', levelName], ['板块', sectionName], ['子板块', subsectionName]] as const) {
        if (label === '子板块' && !value) continue;
        if (!value || [...value].length > ALGORITHM_MAX_GROUP_NAME) {
            throw new ValidationError(`${label}名称应为 1–${ALGORITHM_MAX_GROUP_NAME} 字。`);
        }
    }
    const difficulty = normalizeDifficulty(input.difficulty);
    const order = Number(input.order);
    if (!Number.isFinite(order) || Math.abs(order) > 1e9) {
        throw new ValidationError('排序值无效。');
    }

    // A stale edit form (the item was deleted meanwhile) simply becomes a new
    // custom item instead of silently recreating the old id.
    const existing = input.id ? await algorithmGetItem(input.id) : null;
    const { levelId, sectionId, subsectionId } = await resolveGrouping(
        existing, levelName, sectionName, subsectionName,
    );
    const now = new Date();
    const id = existing?._id || generateCustomItemId();
    const doc = {
        text,
        note,
        levelId,
        levelName,
        sectionId,
        sectionName,
        subsectionId,
        subsectionName: subsectionName || null,
        difficulty,
        order,
        enabled: input.enabled !== false,
        source: existing?.source || 'custom',
        idVersion: 2,
        updatedAt: now,
    };
    if (existing) {
        await algorithmItemColl.updateOne({ _id: id }, { $set: doc });
    } else {
        await algorithmItemColl.updateOne(
            { _id: id },
            { $set: doc, $setOnInsert: { createdAt: now, createdBy: operator } },
            { upsert: true },
        );
    }
    await addLog({
        type: 'algorithm', userId: operator,
        action: existing ? 'item_edit' : 'item_create',
        reason: `${id} ${text}`,
    });
    return (await algorithmGetItem(id))!;
}

export async function algorithmDeleteItem(id: string, operator: number): Promise<boolean> {
    const result = await algorithmItemColl.deleteOne({ _id: String(id) });
    if (!result.deletedCount) return false;
    // Ratings for a removed item are meaningless and would resurface if the
    // same outline id is re-imported later.
    await userAlgorithmColl.deleteMany({ itemId: String(id) });
    await addLog({ type: 'algorithm', userId: operator, action: 'item_delete', reason: String(id) });
    return true;
}

export async function algorithmSetItemEnabled(id: string, enabled: boolean, operator: number): Promise<boolean> {
    const result = await algorithmItemColl.updateOne(
        { _id: String(id) }, { $set: { enabled: !!enabled, updatedAt: new Date() } },
    );
    if (!result.matchedCount) return false;
    await addLog({
        type: 'algorithm', userId: operator,
        action: enabled ? 'item_enable' : 'item_disable', reason: String(id),
    });
    return true;
}

export async function algorithmBulkSetEnabled(
    scope: { levelId?: string; sectionId?: string }, enabled: boolean, operator: number,
): Promise<number> {
    const filter: Record<string, any> = {};
    if (scope.levelId) filter.levelId = String(scope.levelId);
    if (scope.sectionId) filter.sectionId = String(scope.sectionId);
    if (!Object.keys(filter).length) throw new ValidationError('请选择要批量操作的级别或板块。');
    const result = await algorithmItemColl.updateMany(
        filter, { $set: { enabled: !!enabled, updatedAt: new Date() } },
    );
    await addLog({
        type: 'algorithm', userId: operator,
        action: enabled ? 'bulk_enable' : 'bulk_disable',
        reason: `${scope.levelId || ''}${scope.sectionId ? ` / ${scope.sectionId}` : ''} (${result.modifiedCount})`,
    });
    return result.modifiedCount;
}

export interface AlgorithmImportResult {
    inserted: number;
    updated: number;
    skipped: number;
    total: number;
    edition: string;
}

// Import (or refresh) the bundled NOI outline. New items are always inserted;
// existing items are only touched when `overwrite` is set, so re-running the
// import never silently reverts an administrator's edits. `enabled` survives
// an overwrite, keeping deliberately hidden items hidden.
export async function algorithmImportOutline(
    operator: number, opts: { overwrite?: boolean } = {},
): Promise<AlgorithmImportResult> {
    // Self-heal installs that imported before ids were normalized: rename the
    // old rows first so this import matches them instead of inserting 277
    // duplicates next to them. No-op once everything is normalized.
    await algorithmMigrateOutlineIds();
    const outline = algorithmOutlineData();
    if (outline.items.length > ALGORITHM_MAX_ITEMS) {
        throw new ValidationError(`大纲项目过多（超过 ${ALGORITHM_MAX_ITEMS} 项）。`);
    }
    const ids = outline.items.map((item) => item.id);
    const existingDocs = await algorithmItemColl.find({ _id: { $in: ids } })
        .project({ _id: 1 }).toArray();
    const existingIds = new Set(existingDocs.map((doc: any) => String(doc._id)));
    const now = new Date();
    const ops: any[] = [];
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const item of outline.items) {
        const doc = {
            text: item.text,
            levelId: item.levelId,
            levelName: item.levelName,
            sectionId: item.sectionId,
            sectionName: item.sectionName,
            subsectionId: item.subsectionId,
            subsectionName: item.subsectionName,
            difficulty: item.difficulty,
            order: item.order,
            source: ALGORITHM_OUTLINE_SOURCE,
            idVersion: 2,
            updatedAt: now,
        };
        if (existingIds.has(item.id)) {
            if (opts.overwrite) {
                ops.push({ updateOne: { filter: { _id: item.id }, update: { $set: doc } } });
                updated++;
            } else {
                skipped++;
            }
            continue;
        }
        ops.push({
            updateOne: {
                filter: { _id: item.id },
                update: {
                    $set: doc,
                    $setOnInsert: { enabled: true, createdAt: now, createdBy: operator },
                },
                upsert: true,
            },
        });
        inserted++;
    }
    if (ops.length) {
        try {
            await algorithmItemColl.bulkWrite(ops, { ordered: false });
        } catch (e) {
            if (!isDuplicateKeyError(e)) throw e;
            // Two imports running at once can race on the same item id; the
            // winner already inserted the document, so update it instead.
            for (const op of ops) {
                await algorithmItemColl.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: true });
            }
        }
    }
    await algorithmConfigColl.updateOne(
        { _id: ALGORITHM_CONFIG_ID },
        {
            $set: {
                outlineVersion: outline.edition,
                lastImportAt: now,
                updatedAt: now,
                updatedBy: operator,
            },
        },
        { upsert: true },
    );
    await addLog({
        type: 'algorithm', userId: operator, action: 'import',
        reason: `${outline.edition}: +${inserted} / ~${updated} / skip ${skipped}`,
    });
    return {
        inserted, updated, skipped, total: outline.items.length, edition: outline.edition,
    };
}

// Called by /oi33/migrate: import the outline once, when no item exists yet.
// Idempotent — an install that already has items is left untouched.
export async function algorithmEnsureOutlineImported(operator: number) {
    if (await algorithmCountItems()) return { inserted: 0, skipped: true };
    const result = await algorithmImportOutline(operator);
    return { inserted: result.inserted, skipped: false };
}

export interface AlgorithmIdMigrationResult {
    itemsRenamed: number;
    fieldsRewritten: number;
    ratingsRenamed: number;
}

// One-shot, idempotent rewrite for installs that imported the outline before
// ids were normalized:
//   item _id       2.1.1-12  -> 1.1.12
//   levelId        2.1       -> 1
//   sectionId      2.1.1     -> 1.1
//   subsectionId   2.1.2.11  -> 1.2.11
// User ratings follow their item. Custom items keep their own `custom-*` _id
// but their group ids are rewritten too, since they may have inherited an
// outline section id from `resolveGrouping`. Only rows without `idVersion: 2`
// are touched, and they are marked as they are processed — the transform is
// NOT safely re-appliable on its own (a new-format `2.1.12` from 提高级 would
// lose another `2.`), so the marker is what makes this idempotent.
export async function algorithmMigrateOutlineIds(): Promise<AlgorithmIdMigrationResult> {
    const result: AlgorithmIdMigrationResult = { itemsRenamed: 0, fieldsRewritten: 0, ratingsRenamed: 0 };
    const docs = await algorithmItemColl.find({ idVersion: { $ne: 2 } } as any).toArray();
    for (const doc of docs as any[]) {
        const oldId = String(doc._id);
        const newId = normalizeOutlineId(oldId);
        const levelId = normalizeOutlineId(doc.levelId);
        const sectionId = normalizeOutlineId(doc.sectionId);
        const subsectionId = doc.subsectionId ? normalizeOutlineId(doc.subsectionId) : (doc.subsectionId ?? null);
        const nextFields: Record<string, any> = { idVersion: 2 };
        if (levelId !== doc.levelId) nextFields.levelId = levelId;
        if (sectionId !== doc.sectionId) nextFields.sectionId = sectionId;
        if (subsectionId !== (doc.subsectionId ?? null)) nextFields.subsectionId = subsectionId;
        const hasFieldChanges = Object.keys(nextFields).length > 1;

        if (newId !== oldId) {
            // `_id` is immutable, so re-insert under the new id and drop the old
            // one; ratings keyed by the old id are moved over.
            const { _id, ...rest } = doc;
            await algorithmItemColl.replaceOne(
                { _id: newId },
                { ...rest, ...nextFields, _id: newId } as any,
                { upsert: true },
            );
            await algorithmItemColl.deleteOne({ _id: oldId });
            const renamed = await userAlgorithmColl.updateMany(
                { itemId: oldId }, { $set: { itemId: newId } },
            );
            result.ratingsRenamed += renamed.modifiedCount || 0;
            result.itemsRenamed++;
        } else {
            await algorithmItemColl.updateOne(
                { _id: oldId }, { $set: { ...nextFields, updatedAt: new Date() } },
            );
        }
        if (hasFieldChanges) result.fieldsRewritten++;
    }
    if (result.itemsRenamed || result.fieldsRewritten) {
        await addLog({
            type: 'algorithm', userId: 0, action: 'import',
            reason: `outline id normalize: rename ${result.itemsRenamed}, fields ${result.fieldsRewritten}, ratings ${result.ratingsRenamed}`,
        });
    }
    return result;
}
