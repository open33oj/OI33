import { ValidationError } from 'hydrooj';
import { addLog } from './log';
import {
    ALGORITHM_MAX_DIFFICULTY, ALGORITHM_MAX_GROUP_NAME, ALGORITHM_MAX_NOTE, ALGORITHM_MAX_TEXT,
    algorithmItemColl, userAlgorithmColl,
} from './algorithm';
import type { Oi33AlgorithmItem } from './types';

export function normalizeDifficulty(value: unknown): number {
    const difficulty = Math.floor(Number(value));
    if (!Number.isSafeInteger(difficulty) || difficulty < 0 || difficulty > ALGORITHM_MAX_DIFFICULTY) return 0;
    return difficulty;
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
