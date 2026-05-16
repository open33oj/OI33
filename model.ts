import { randomBytes } from 'crypto';
import { _, db, ObjectId } from 'hydrooj';

const userColl = db.collection('oi33_user');
const billColl = db.collection('oi33_coin_bill');
const pasteColl = db.collection('oi33_paste');
const logColl = db.collection('oi33_log');
const requestColl = db.collection('oi33_request');

interface Oi33User {
    _id: number;
    coin_now?: number;
    coin_all?: number;
    birthday_date?: string;
    birthday_monthDay?: string;
    badge_text?: string;
    badge_color?: string;
    badge_textColor?: string;
    realname_flag?: number;
    realname_name?: string;
    checkin_time?: string;
    checkin_luck?: number;
    checkin_cnt_now?: number;
    checkin_cnt_all?: number;
    atcoder?: string;
    codeforces?: string;
}

export type Oi33RequestStatus = 'pending' | 'approved' | 'rejected';
export type Oi33RequestKind = 'birthday' | 'realname' | 'badge';

export interface Oi33RequestPayload {
    birthday_date?: string;
    realname_flag?: number;
    realname_name?: string;
    badge_text?: string;
    badge_color?: string;
    badge_textColor?: string;
    atcoder?: string;
    codeforces?: string;
}

interface Oi33Request extends Oi33RequestPayload {
    _id: ObjectId;
    uid: number;
    kind: Oi33RequestKind;
    requester: number;
    status: Oi33RequestStatus;
    createdAt: Date;
    handledAt?: Date;
    handler?: number;
    rejectReason?: string;
}

interface Oi33CoinBill {
    _id: string;
    userId: number;
    rootId: number;
    amount: number;
    text: string;
}

interface Oi33Paste {
    _id: string;
    updateAt: Date;
    title: string;
    owner: number;
    content: string;
    isprivate: boolean;
}

interface Oi33Log {
    _id: Date;
    type: 'coin' | 'birthday' | 'badge' | 'realname' | 'paste' | 'request';
    // coin
    sender?: number;
    receiver?: number;
    amount?: number;
    reason?: string;
    // birthday
    userId?: number;
    birthdayDate?: string;
    // badge
    badgeText?: string;
    // realname
    realnameName?: string;
    // paste
    owner?: number;
    title?: string;
    // request
    requester?: number;
    reqId?: string;
    status?: Oi33RequestStatus;
}

declare module 'hydrooj' {
    interface Model {
        oi33: typeof oi33Model;
    }
    interface Collections {
        oi33_user: Oi33User;
        oi33_coin_bill: Oi33CoinBill;
        oi33_paste: Oi33Paste;
        oi33_log: Oi33Log;
        oi33_request: Oi33Request;
    }
}

// --- oi33_user helpers ---

async function getUserDataByUids(uids: number[]): Promise<Record<number, Oi33User>> {
    const docs = await userColl.find({ _id: { $in: uids } }).toArray();
    const dict: Record<number, Oi33User> = {};
    for (const doc of docs) dict[doc._id] = doc;
    return dict;
}

function mergeOi33Fields(udoc: any, oi33: Oi33User | undefined, fields?: string[]) {
    if (!oi33) return;
    const mergeAll = !fields;
    if (mergeAll || fields!.includes('coin')) {
        udoc.coin_now = oi33.coin_now ?? 0;
        udoc.coin_all = oi33.coin_all ?? 0;
    }
    if (mergeAll || fields!.includes('birthday')) {
        udoc.birthday_date = oi33.birthday_date || '';
    }
    if (mergeAll || fields!.includes('realname')) {
        udoc.realname_flag = oi33.realname_flag ?? 0;
        udoc.realname_name = oi33.realname_name || '';
    }
    if (mergeAll || fields!.includes('badge')) {
        if (oi33.badge_text) {
            udoc.badge = oi33.badge_text + '#' + oi33.badge_color + '#' + oi33.badge_textColor;
        }
    }
}

// --- Log helper ---

async function addLog(entry: Omit<Oi33Log, '_id'>) {
    await logColl.insertOne({ ...entry, _id: new Date() });
}

// --- Coin ---

async function coinInc(userId: number, rootId: number, amount: number, text: string) {
    await billColl.insertOne({ userId, rootId, amount, text });
    // coin_all tracks lifetime positive earnings only — deductions do not reduce it
    await userColl.updateOne(
        { _id: userId },
        { $inc: { coin_now: amount, ...(amount > 0 ? { coin_all: amount } : {}) } },
        { upsert: true },
    );
    await addLog({ type: 'coin', sender: rootId, receiver: userId, amount, reason: text });
}

async function coinBillCount() {
    return await billColl.countDocuments();
}

async function coinGetAll(limit: number, page: number) {
    return await billColl.find().limit(limit).skip((page - 1) * limit).sort({ _id: -1 }).toArray();
}

async function coinUserBillCount(userId: number) {
    return await billColl.countDocuments({ userId });
}

async function coinGetUser(userId: number, limit: number, page: number) {
    return await billColl.find({ userId }).limit(limit).skip((page - 1) * limit).sort({ _id: -1 }).toArray();
}

async function coinGetLeaderboard(page: number) {
    return await userColl.find({ coin_all: { $exists: true } }).sort({ coin_now: -1 }).toArray();
}

// --- Birthday ---

async function setBirthday(userId: number, date: string) {
    const parts = date.split('-');
    if (parts.length !== 3) throw new Error('Invalid date format, expected YYYY-MM-DD');
    const monthDay = `${parts[1]}-${parts[2]}`;
    await userColl.updateOne(
        { _id: userId },
        { $set: { birthday_date: date, birthday_monthDay: monthDay } },
        { upsert: true },
    );
    await addLog({ type: 'birthday', userId, birthdayDate: date });
}

async function getTodayBirthdays() {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const monthDay = `${mm}-${dd}`;
    return await userColl.find({ birthday_monthDay: monthDay }).toArray();
}

async function getAllBirthdays() {
    return await userColl.find({ birthday_date: { $exists: true } }).sort({ _id: -1 }).toArray();
}

async function getBirthdayCount() {
    return await userColl.countDocuments({ birthday_date: { $exists: true } });
}

async function getRecentBirthdays(limit: number) {
    return await userColl.find({ birthday_date: { $exists: true } }).sort({ _id: -1 }).limit(limit).toArray();
}

// --- Badge ---

async function setBadge(userId: number, text: string, color: string, textColor: string) {
    await userColl.updateOne(
        { _id: userId },
        { $set: { badge_text: text, badge_color: color, badge_textColor: textColor } },
        { upsert: true },
    );
    await addLog({ type: 'badge', userId, badgeText: text });
}

async function getBadgedUsers() {
    return await userColl.find({ badge_text: { $exists: true, $ne: '' } }).toArray();
}

async function removeBadge(userId: number) {
    await userColl.updateOne(
        { _id: userId },
        { $unset: { badge_text: '', badge_color: '', badge_textColor: '' } },
    );
}

// --- Realname ---

async function setRealname(userId: number, flag: number, name: string) {
    await userColl.updateOne(
        { _id: userId },
        { $set: { realname_flag: flag, realname_name: name } },
        { upsert: true },
    );
    await addLog({ type: 'realname', userId, realnameName: name });
}

async function getRealnamedUsers() {
    return await userColl.find({ realname_flag: { $exists: true } }).toArray();
}

// --- Checkin ---

async function doCheckin(userId: number, todayStr: string) {
    const doc = await userColl.findOne({ _id: userId });
    const prev = doc || {};
    let checkin_cnt_all = (prev.checkin_cnt_all || 0) + 1;
    let checkin_cnt_now = prev.checkin_cnt_now || 0;
    if (prev.checkin_time && checkin_cnt_now) {
        const prevDate = new Date(prev.checkin_time);
        const todayDate = new Date(todayStr);
        const diffDays = Math.round((todayDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
            checkin_cnt_now++;
        } else {
            checkin_cnt_now = 1;
        }
    } else {
        checkin_cnt_now = 1;
    }
    const checkin_luck = Math.floor(Math.random() * 7);
    await userColl.updateOne(
        { _id: userId },
        { $set: { checkin_time: todayStr, checkin_luck, checkin_cnt_now, checkin_cnt_all } },
        { upsert: true },
    );
    return { checkin_luck, checkin_cnt_now, checkin_cnt_all };
}

async function getCheckinUser(userId: number) {
    return await userColl.findOne({ _id: userId });
}

// --- Pastebin ---

async function pasteAdd(owner: number, title: string, content: string, isprivate: boolean): Promise<string> {
    const pasteId = randomBytes(8).toString('hex') + Date.now().toString(36);
    await pasteColl.insertOne({
        _id: pasteId,
        updateAt: new Date(),
        title,
        owner,
        content,
        isprivate,
    });
    await addLog({ type: 'paste', owner, title });
    return pasteId;
}

async function pasteEdit(pasteId: string, owner: number, title: string, content: string, isprivate: boolean) {
    await pasteColl.updateOne(
        { _id: pasteId },
        { $set: { title, updateAt: new Date(), owner, content, isprivate } },
    );
}

async function pasteGet(pasteId: string): Promise<Oi33Paste | null> {
    return await pasteColl.findOne({ _id: pasteId });
}

async function pasteDel(pasteId: string) {
    return await pasteColl.deleteOne({ _id: pasteId });
}

async function pasteCountUser(owner: number): Promise<number> {
    if (owner !== 0) return await pasteColl.countDocuments({ owner });
    return await pasteColl.countDocuments();
}

async function pasteGetUser(owner: number, limit: number, page: number) {
    const query = owner !== 0 ? { owner } : {};
    return await pasteColl.find(query).sort({ updateAt: -1, _id: -1 }).limit(limit).skip((page - 1) * limit).toArray();
}

// --- Combined users query ---

async function getAllUsersData(page: number, pageSize: number) {
    const filter = {
        $or: [
            { coin_now: { $exists: true } },
            { birthday_date: { $exists: true } },
            { realname_flag: { $exists: true } },
        ],
    };
    const total = await userColl.countDocuments(filter);
    const upcount = Math.ceil(total / pageSize);
    const docs = await userColl.find(filter).sort({ _id: 1 })
        .skip((page - 1) * pageSize).limit(pageSize).toArray();
    return { docs, total, upcount };
}

// --- Recent activities timeline ---

async function getRecentActivities(limit = 40) {
    return await logColl.find().sort({ _id: -1 }).limit(limit).toArray();
}

// --- Profile edit requests ---

async function applyRequestPayload(uid: number, payload: Oi33RequestPayload) {
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

function buildRequestDoc(uid: number, kind: Oi33RequestKind, requester: number, payload: Oi33RequestPayload, status: Oi33RequestStatus): Omit<Oi33Request, '_id'> {
    const doc: any = { uid, kind, requester, status, createdAt: new Date() };
    for (const key of ['birthday_date', 'realname_flag', 'realname_name',
        'badge_text', 'badge_color', 'badge_textColor', 'atcoder', 'codeforces'] as const) {
        if (payload[key] !== undefined) doc[key] = payload[key];
    }
    return doc;
}

async function submitRequest(uid: number, kind: Oi33RequestKind, requester: number, payload: Oi33RequestPayload) {
    await requestColl.deleteMany({ uid, kind, status: 'pending' });
    const doc = buildRequestDoc(uid, kind, requester, payload, 'pending');
    const { insertedId } = await requestColl.insertOne(doc as Oi33Request);
    await addLog({ type: 'request', userId: uid, requester, reqId: insertedId.toHexString(), status: 'pending' });
    return insertedId;
}

async function directUpdate(uid: number, kind: Oi33RequestKind, admin: number, payload: Oi33RequestPayload) {
    await applyRequestPayload(uid, payload);
    const doc: any = buildRequestDoc(uid, kind, admin, payload, 'approved');
    doc.handler = admin;
    doc.handledAt = new Date();
    const { insertedId } = await requestColl.insertOne(doc as Oi33Request);
    await addLog({ type: 'request', userId: uid, requester: admin, reqId: insertedId.toHexString(), status: 'approved' });
    return insertedId;
}

async function approveRequest(reqId: ObjectId, handlerUid: number) {
    const doc = await requestColl.findOne({ _id: reqId, status: 'pending' });
    if (!doc) return false;
    await applyRequestPayload(doc.uid, doc);
    await requestColl.updateOne(
        { _id: reqId },
        { $set: { status: 'approved', handler: handlerUid, handledAt: new Date() } },
    );
    await addLog({ type: 'request', userId: doc.uid, requester: doc.requester, reqId: reqId.toHexString(), status: 'approved' });
    return true;
}

async function rejectRequest(reqId: ObjectId, handlerUid: number, reason: string) {
    const doc = await requestColl.findOne({ _id: reqId, status: 'pending' });
    if (!doc) return false;
    await requestColl.updateOne(
        { _id: reqId },
        { $set: { status: 'rejected', handler: handlerUid, handledAt: new Date(), rejectReason: reason || '' } },
    );
    await addLog({ type: 'request', userId: doc.uid, requester: doc.requester, reqId: reqId.toHexString(), status: 'rejected' });
    return true;
}

async function getPendingRequests() {
    return await requestColl.find({ status: 'pending' }).sort({ createdAt: -1 }).toArray();
}

async function getPendingRequestCount() {
    return await requestColl.countDocuments({ status: 'pending' });
}

async function getRequestById(reqId: ObjectId) {
    return await requestColl.findOne({ _id: reqId });
}

async function getUserPendingRequests(uid: number): Promise<Partial<Record<Oi33RequestKind, Oi33Request>>> {
    const docs = await requestColl.find({ uid, status: 'pending' }).toArray();
    const dict: Partial<Record<Oi33RequestKind, Oi33Request>> = {};
    for (const doc of docs) dict[doc.kind] = doc;
    return dict;
}

const oi33Model = {
    getUserDataByUids, mergeOi33Fields,
    coinInc, coinBillCount, coinGetAll, coinUserBillCount, coinGetUser, coinGetLeaderboard,
    setBirthday, getTodayBirthdays, getAllBirthdays, getBirthdayCount, getRecentBirthdays,
    setBadge, getBadgedUsers, removeBadge,
    setRealname, getRealnamedUsers,
    doCheckin, getCheckinUser,
    pasteAdd, pasteEdit, pasteGet, pasteDel, pasteCountUser, pasteGetUser,
    getAllUsersData, getRecentActivities,
    submitRequest, directUpdate, approveRequest, rejectRequest,
    getPendingRequests, getPendingRequestCount, getRequestById, getUserPendingRequests,
    applyRequestPayload,
};
global.Hydro.model.oi33 = oi33Model;

export { userColl, billColl, pasteColl, logColl, requestColl, oi33Model, Oi33User, Oi33CoinBill, Oi33Paste, Oi33Log, Oi33Request };
