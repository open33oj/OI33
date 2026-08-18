import { db, ObjectId } from 'hydrooj';
import { Oi33Log } from './types';

export const logColl = db.collection('oi33_log');

export async function ensureLogIndexes() {
    // The first weekly-reward implementation keyed logs only by period/user.
    // Re-settling a rolled-back week needs one immutable ledger row per
    // revision, so migrate legacy rows and replace that index in place.
    let indexes: any[] = [];
    try {
        indexes = await logColl.listIndexes().toArray();
    } catch (e: any) {
        if (e?.code !== 26 && e?.codeName !== 'NamespaceNotFound') throw e;
    }
    const legacyRewardIndex = indexes.find((index: any) => index?.key?.type === 1
        && index?.key?.action === 1
        && index?.key?.schoolCatRewardPeriod === 1
        && index?.key?.userId === 1
        && index?.key?.schoolCatRewardRevision === undefined);
    if (legacyRewardIndex?.name) await logColl.dropIndex(legacyRewardIndex.name);
    await logColl.updateMany({
        schoolCatRewardPeriod: { $type: 'string' },
        schoolCatRewardRevision: { $exists: false },
    } as any, { $set: { schoolCatRewardRevision: 1 } } as any);
    await Promise.all([
        logColl.createIndex({ createdAt: 1 }),
        // Supports the one-time/idempotent legacy movement contribution scan.
        logColl.createIndex({
            type: 1, action: 1, schoolCatContributionCounted: 1, userId: 1,
        }),
        logColl.createIndex({ schoolCatContributionBatch: 1 }, { sparse: true }),
        logColl.createIndex(
            {
                type: 1, action: 1, schoolCatRewardPeriod: 1,
                schoolCatRewardRevision: 1, userId: 1,
            },
            {
                unique: true,
                partialFilterExpression: { schoolCatRewardPeriod: { $type: 'string' } },
            },
        ),
    ]);
}

export async function addLog(entry: Omit<Oi33Log, '_id' | 'createdAt'>) {
    await logColl.insertOne({ ...entry, _id: new ObjectId(), createdAt: new Date() } as any);
}

export async function getRecentActivities(limit = 40) {
    return await logColl.find().sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
}

export async function getRecentActivitiesPaginated(page: number, pageSize = 30, type = '') {
    const filter: any = type ? { type } : {};
    // 喵喵 posts that are still pending review are not surfaced — only
    // approved/rejected outcomes (plus follow/unfollow/approve/reject) appear.
    filter.$or = [
        { type: { $ne: 'meow' } },
        { status: { $ne: 'pending' } },
        { status: { $exists: false } },
    ];
    const total = await logColl.countDocuments(filter as any);
    const tpcount = Math.ceil(total / pageSize);
    const activities = await logColl.find(filter as any)
        .sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();
    return { activities, tpcount };
}

function catFoodLogFilter(userId: number) {
    return {
        type: { $in: ['checkin', 'cat_account'] },
        userId,
        amount: { $exists: true, $ne: 0 },
    };
}

export async function getCatFoodLogCount(userId: number) {
    return await logColl.countDocuments(catFoodLogFilter(userId) as any);
}

export async function getCatFoodLogs(userId: number, page: number, pageSize = 50) {
    return await logColl.find(catFoodLogFilter(userId) as any)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();
}

export async function compactRequestLogs() {
    const terminalReqIds = await logColl.distinct('reqId', {
        type: 'request',
        status: { $in: ['approved', 'rejected'] },
    });
    if (!terminalReqIds.length) return 0;
    const result = await logColl.deleteMany({
        type: 'request',
        status: 'pending',
        reqId: { $in: terminalReqIds },
    });
    return result.deletedCount;
}
