import { db, ObjectId } from 'hydrooj';
import type {
    Oi33AiModeration, Oi33ModerationStatus, Oi33ModerationVerdict,
} from './types';

export const moderationColl = db.collection<Oi33AiModeration>('oi33_ai_moderation');

export async function ensureModerationIndexes() {
    await Promise.all([
        moderationColl.createIndex({ contentHash: 1, createdAt: -1 }),
        moderationColl.createIndex({ status: 1, createdAt: -1 }),
        moderationColl.createIndex({ uid: 1, createdAt: -1 }),
        moderationColl.createIndex({ createdAt: -1 }),
    ]);
}

export async function modAdd(entry: Omit<Oi33AiModeration, '_id' | 'createdAt'>) {
    const doc = { ...entry, _id: new ObjectId(), createdAt: new Date() };
    await moderationColl.insertOne(doc);
    return doc;
}

export async function modGet(id: ObjectId) {
    return await moderationColl.findOne({ _id: id });
}

export async function modListPending() {
    return await moderationColl.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(200).toArray();
}

// Close pending entries that can never be operated on (they predate the
// target field, or the target is an empty object). Otherwise clicking
// approve/reject on them fails and they clog the queue forever.
export async function modCloseMissingTarget(handlerUid = 0) {
    await moderationColl.updateMany(
        { status: 'pending', $or: [{ target: { $exists: false } }, { target: {} }] },
        { $set: { status: 'done', handledAt: new Date(), handler: handlerUid } },
    );
}

export async function modListRecent(limit = 50) {
    return await moderationColl.find({ status: { $ne: 'pending' } })
        .sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function modSetStatus(id: ObjectId, status: Oi33ModerationStatus, handlerUid: number) {
    await moderationColl.updateOne(
        { _id: id },
        { $set: { status, handledAt: new Date(), handler: handlerUid } },
    );
}

// Verdict cache: same normalized content reuses a recent final verdict,
// so reposting spam doesn't burn another AI call. Only rule/AI verdicts are
// cached — rate-limit and fuse outcomes are circumstantial, not content-based.
export async function modFindCachedVerdict(contentHash: string) {
    return await moderationColl.findOne({
        contentHash,
        status: { $in: ['done', 'approved', 'rejected'] },
        verdict: { $in: ['pass', 'block'] },
        source: { $in: ['ai', 'rules'] },
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
    }, { sort: { createdAt: -1 } });
}

function startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

export async function modCountTodayByUid(uid: number) {
    return await moderationColl.countDocuments({ uid, createdAt: { $gte: startOfToday() } });
}

// Today's AI spend on moderation, for the budget fuse.
export async function modTodayCost(): Promise<number> {
    const rows = await moderationColl.aggregate<{ cost: number }>([
        { $match: { createdAt: { $gte: startOfToday() }, source: 'ai' } },
        { $group: { _id: null, cost: { $sum: '$cost' } } },
    ]).toArray();
    return rows[0]?.cost || 0;
}

export async function modStats() {
    const rows = await moderationColl.aggregate<{
        _id: { status: Oi33ModerationStatus; verdict: Oi33ModerationVerdict };
        count: number;
    }>([
        { $match: { createdAt: { $gte: startOfToday() } } },
        { $group: { _id: { status: '$status', verdict: '$verdict' }, count: { $sum: 1 } } },
    ]).toArray();
    const stats = {
        pending: 0, pass: 0, block: 0, review: 0, handled: 0,
    };
    for (const row of rows) {
        if (row._id.status === 'pending') stats.pending += row.count;
        else if (row._id.status === 'approved' || row._id.status === 'rejected') stats.handled += row.count;
        else if (row._id.verdict === 'pass') stats.pass += row.count;
        else if (row._id.verdict === 'block') stats.block += row.count;
        else if (row._id.verdict === 'review') stats.review += row.count;
    }
    return stats;
}
