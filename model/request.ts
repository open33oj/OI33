import { db, ObjectId } from 'hydrooj';
import { Oi33Request, Oi33RequestKind, Oi33RequestPayload, Oi33RequestStatus } from './types';
import { addLog, logColl } from './log';
import { userColl } from './user';

export const requestColl = db.collection('oi33_request');

function buildRequestDoc(uid: number, kind: Oi33RequestKind, requester: number, payload: Oi33RequestPayload, status: Oi33RequestStatus): Omit<Oi33Request, '_id'> {
    const doc: any = { uid, kind, requester, status, createdAt: new Date() };
    for (const key of ['birthday_date', 'realname_flag', 'realname_name',
        'badge_text', 'badge_color', 'badge_textColor', 'atcoder', 'codeforces'] as const) {
        if (payload[key] !== undefined) doc[key] = payload[key];
    }
    return doc;
}

export async function applyRequestPayload(uid: number, payload: Oi33RequestPayload) {
    const $set: Record<string, any> = {};
    const $unset: Record<string, ''> = {};
    if (payload.birthday_date !== undefined) {
        if (!payload.birthday_date) {
            $unset.birthday_date = '';
            $unset.birthday_monthDay = '';
        } else {
            const parts = payload.birthday_date.split('-');
            if (parts.length !== 3) throw new Error('Invalid date format, expected YYYY-MM-DD');
            $set.birthday_date = payload.birthday_date;
            $set.birthday_monthDay = `${parts[1]}-${parts[2]}`;
        }
    }
    if (payload.realname_flag !== undefined) $set.realname_flag = payload.realname_flag;
    if (payload.realname_name !== undefined) $set.realname_name = payload.realname_name;
    if (payload.badge_text !== undefined) {
        if (!payload.badge_text) {
            $unset.badge_text = '';
            $unset.badge_color = '';
            $unset.badge_textColor = '';
        } else {
            $set.badge_text = payload.badge_text;
            if (payload.badge_color !== undefined) $set.badge_color = payload.badge_color;
            if (payload.badge_textColor !== undefined) $set.badge_textColor = payload.badge_textColor;
        }
    }
    if (payload.atcoder !== undefined) $set.atcoder = payload.atcoder;
    if (payload.codeforces !== undefined) $set.codeforces = payload.codeforces;

    const update: any = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (!Object.keys(update).length) return;
    await userColl.updateOne({ _id: uid }, update, { upsert: true });
}

export async function submitRequest(uid: number, kind: Oi33RequestKind, requester: number, payload: Oi33RequestPayload) {
    const stale = await requestColl.find({ uid, kind, status: 'pending' }).project({ _id: 1 }).toArray();
    if (stale.length) {
        const staleIds = stale.map((d) => d._id);
        const staleHex = staleIds.map((id) => id.toHexString());
        await requestColl.updateMany(
            { _id: { $in: staleIds } },
            { $set: { status: 'cancelled', handledAt: new Date() } },
        );
        await logColl.updateMany(
            { type: 'request', status: 'pending', reqId: { $in: staleHex } },
            { $set: { status: 'cancelled' } },
        );
    }
    const doc = buildRequestDoc(uid, kind, requester, payload, 'pending');
    const { insertedId } = await requestColl.insertOne(doc as Oi33Request);
    await addLog({ type: 'request', userId: uid, requester, reqId: insertedId.toHexString(), status: 'pending', kind });
    return insertedId;
}

export async function directUpdate(uid: number, kind: Oi33RequestKind, admin: number, payload: Oi33RequestPayload) {
    await applyRequestPayload(uid, payload);
    const doc: any = buildRequestDoc(uid, kind, admin, payload, 'approved');
    doc.handler = admin;
    doc.handledAt = new Date();
    const { insertedId } = await requestColl.insertOne(doc as Oi33Request);
    await addLog({ type: 'request', userId: uid, requester: admin, reqId: insertedId.toHexString(), status: 'approved', kind });
    return insertedId;
}

export async function approveRequest(reqId: ObjectId, handlerUid: number) {
    const doc = await requestColl.findOne({ _id: reqId, status: 'pending' });
    if (!doc) return false;
    await applyRequestPayload(doc.uid, doc);
    await requestColl.updateOne(
        { _id: reqId },
        { $set: { status: 'approved', handler: handlerUid, handledAt: new Date() } },
    );
    await addLog({ type: 'request', userId: doc.uid, requester: doc.requester, reqId: reqId.toHexString(), status: 'approved', kind: doc.kind });
    return true;
}

export async function rejectRequest(reqId: ObjectId, handlerUid: number) {
    const doc = await requestColl.findOne({ _id: reqId, status: 'pending' });
    if (!doc) return false;
    await requestColl.updateOne(
        { _id: reqId },
        { $set: { status: 'rejected', handler: handlerUid, handledAt: new Date() } },
    );
    await addLog({ type: 'request', userId: doc.uid, requester: doc.requester, reqId: reqId.toHexString(), status: 'rejected', kind: doc.kind });
    return true;
}

export async function getPendingRequests() {
    return await requestColl.find({ status: 'pending' }).sort({ createdAt: -1 }).toArray();
}

export async function getPendingRequestCount() {
    return await requestColl.countDocuments({ status: 'pending' });
}

export async function getRequestById(reqId: ObjectId) {
    return await requestColl.findOne({ _id: reqId });
}

export async function getRequestsByIds(reqIdHex: string[]): Promise<Record<string, Oi33Request>> {
    if (!reqIdHex.length) return {};
    const objIds: ObjectId[] = [];
    for (const s of reqIdHex) {
        try { objIds.push(new ObjectId(s)); } catch { /* ignore invalid */ }
    }
    if (!objIds.length) return {};
    const docs = await requestColl.find({ _id: { $in: objIds } }).toArray();
    const dict: Record<string, Oi33Request> = {};
    for (const d of docs) dict[d._id.toHexString()] = d;
    return dict;
}

export async function getUserPendingRequests(uid: number): Promise<Partial<Record<Oi33RequestKind, Oi33Request>>> {
    const docs = await requestColl.find({ uid, status: 'pending' }).toArray();
    const dict: Partial<Record<Oi33RequestKind, Oi33Request>> = {};
    for (const doc of docs) dict[doc.kind] = doc;
    return dict;
}
