import { randomBytes } from 'crypto';
import { db } from 'hydrooj';
import { Oi33Wiki, Oi33WikiCategoryDoc } from './types';
import { addLog } from './log';

export const wikiColl = db.collection('oi33_wiki');
export const wikiCatColl = db.collection('oi33_wiki_category');

// --- Wiki CRUD ---

export async function wikiAdd(uid: number, title: string, content: string, category: string): Promise<string> {
    const slug = randomBytes(8).toString('hex') + Date.now().toString(36);
    const now = new Date();
    await wikiColl.insertOne({
        _id: slug,
        title,
        content,
        category,
        order: 0,
        createdAt: now,
        updatedAt: now,
    });
    await addLog({ type: 'wiki', action: 'create', uid, title, wikiId: slug });
    return slug;
}

export async function wikiEdit(id: string, uid: number, title: string, content: string, category: string): Promise<boolean> {
    const doc = await wikiColl.findOne({ _id: id });
    if (!doc) return false;
    const now = new Date();
    const result = await wikiColl.updateOne(
        { _id: id },
        { $set: { title, content, category, updatedAt: now } },
    );
    await addLog({ type: 'wiki', action: 'edit', uid, title, wikiId: id });
    return result.modifiedCount > 0;
}

export async function wikiGet(id: string): Promise<Oi33Wiki | null> {
    return await wikiColl.findOne({ _id: id });
}

export async function wikiGetApproved(category?: string, page = 1, pageSize = 30) {
    const filter: Record<string, any> = { _id: { $ne: 'index' } };
    if (category) filter.category = category;
    const total = await wikiColl.countDocuments(filter);
    const upcount = Math.ceil(total / pageSize);
    const docs = await wikiColl.find(filter).sort({ updatedAt: -1 })
        .skip((page - 1) * pageSize).limit(pageSize).toArray();
    return { docs, total, upcount };
}

export async function wikiGetOrCreateIndex(): Promise<Oi33Wiki> {
    const now = new Date();
    const result = await wikiColl.findOneAndUpdate(
        { _id: 'index' },
        {
            $setOnInsert: {
                _id: 'index',
                title: 'Wiki Index',
                content: '欢迎来到 33OJ 百科！这里会发布最新的通知公告。',
                category: 'announcement',
                order: 0,
                createdAt: now,
                updatedAt: now,
            },
        },
        { upsert: true, returnDocument: 'after' },
    );
    return result as Oi33Wiki;
}

export async function wikiDelete(id: string, uid: number): Promise<boolean> {
    const doc = await wikiColl.findOne({ _id: id });
    if (!doc) return false;
    await wikiColl.deleteOne({ _id: id });
    await addLog({ type: 'wiki', action: 'delete', uid, title: doc.title, wikiId: id });
    return true;
}

// --- Wiki Categories ---

export async function wikiCatGetAll(): Promise<Oi33WikiCategoryDoc[]> {
    const docs = await wikiCatColl.find().sort({ order: 1 }).toArray();
    if (!docs.length) {
        const defaults = [
            { _id: 'algorithm', name: '算法', order: 0 },
            { _id: 'announcement', name: '公告', order: 1 },
        ];
        await wikiCatColl.insertMany(defaults);
        return defaults as Oi33WikiCategoryDoc[];
    }
    return docs;
}

export async function wikiCatAdd(slug: string, name: string, order: number): Promise<void> {
    await wikiCatColl.insertOne({ _id: slug, name, order });
}

export async function wikiCatEdit(slug: string, name: string, order: number): Promise<boolean> {
    const result = await wikiCatColl.updateOne({ _id: slug }, { $set: { name, order } });
    return result.modifiedCount > 0;
}

export async function wikiCatDelete(slug: string): Promise<{ ok: boolean; count: number }> {
    const count = await wikiColl.countDocuments({ category: slug });
    if (count > 0) return { ok: false, count };
    await wikiCatColl.deleteOne({ _id: slug });
    return { ok: true, count: 0 };
}
