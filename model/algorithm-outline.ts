import { readFileSync } from 'fs';
import path from 'path';
import { ValidationError } from 'hydrooj';
import { addLog } from './log';
import {
    ALGORITHM_CONFIG_ID, ALGORITHM_DROPPED_SECTION, ALGORITHM_MAX_ITEMS,
    ALGORITHM_OUTLINE_SOURCE, algorithmConfigColl, algorithmItemColl,
    isDuplicateKeyError, userAlgorithmColl,
} from './algorithm';
import { algorithmCountItems, normalizeDifficulty } from './algorithm-item';
import { normalizeOutlineId } from './algorithm-rules';

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

// Pure id normalisation lives in ./algorithm-rules (no hydrooj/DB imports) so it
// can be unit-tested; re-exported here because this module owns the outline.
export { normalizeOutlineId };

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

// Called by /oi33/migrate: delete the excluded 「基础知识与编程环境」 items (and the
// ratings pointing at them) from installs that imported them before the outline
// changed. Idempotent — a second run finds nothing left to delete.
export async function algorithmDropBasicsSection(): Promise<{ items: number; ratings: number }> {
    const docs = await algorithmItemColl
        .find({ sectionName: ALGORITHM_DROPPED_SECTION })
        .project({ _id: 1 })
        .toArray();
    const ids = docs.map((doc: any) => String(doc._id));
    if (!ids.length) return { items: 0, ratings: 0 };
    const ratings = await userAlgorithmColl.deleteMany({ itemId: { $in: ids } });
    const items = await algorithmItemColl.deleteMany({ _id: { $in: ids } });
    return { items: items.deletedCount || 0, ratings: ratings.deletedCount || 0 };
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
