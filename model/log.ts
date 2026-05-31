import { db, ObjectId } from 'hydrooj';
import { Oi33Log } from './types';

export const logColl = db.collection('oi33_log');

export async function addLog(entry: Omit<Oi33Log, '_id' | 'createdAt'>) {
    await logColl.insertOne({ ...entry, _id: new ObjectId(), createdAt: new Date() } as any);
}

export async function getRecentActivities(limit = 40) {
    return await logColl.find().sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
}

export async function getRecentActivitiesPaginated(page: number, pageSize = 30) {
    const total = await logColl.countDocuments();
    const tpcount = Math.ceil(total / pageSize);
    const activities = await logColl.find()
        .sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();
    return { activities, tpcount };
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
