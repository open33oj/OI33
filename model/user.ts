import { db } from 'hydrooj';
import { Oi33User } from './types';
import { addLog } from './log';

export const userColl = db.collection('oi33_user');

export async function getUserDataByUids(uids: number[]): Promise<Record<number, Oi33User>> {
    const docs = await userColl.find({ _id: { $in: uids } }).toArray();
    const dict: Record<number, Oi33User> = {};
    for (const doc of docs) dict[doc._id] = doc;
    return dict;
}

export function mergeOi33Fields(udoc: any, oi33: Oi33User | undefined, fields?: string[]) {
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
        udoc.realname_flag = oi33.realname_flag;
        udoc.realname_name = oi33.realname_name || '';
    }
    if (mergeAll || fields!.includes('badge')) {
        if (oi33.badge_text) {
            udoc.badge = oi33.badge_text + '#' + oi33.badge_color + '#' + oi33.badge_textColor;
        }
    }
    if (mergeAll || fields!.includes('atcoder')) {
        udoc.atcoder = oi33.atcoder || '';
        udoc.atcoder_rating = oi33.atcoder_rating;
        udoc.atcoder_updated_at = oi33.atcoder_updated_at;
    }
    if (mergeAll || fields!.includes('codeforces')) {
        udoc.codeforces = oi33.codeforces || '';
        udoc.codeforces_rating = oi33.codeforces_rating;
        udoc.codeforces_updated_at = oi33.codeforces_updated_at;
    }
}

// --- Coin ---

export const billColl = db.collection('oi33_coin_bill');

export async function coinInc(userId: number, rootId: number, amount: number, text: string) {
    await billColl.insertOne({ userId, rootId, amount, text });
    await userColl.updateOne(
        { _id: userId },
        { $inc: { coin_now: amount, ...(amount > 0 ? { coin_all: amount } : {}) } },
        { upsert: true },
    );
    await addLog({ type: 'coin', sender: rootId, receiver: userId, amount, reason: text });
}

export async function coinBillCount() {
    return await billColl.countDocuments();
}

export async function coinGetAll(limit: number, page: number) {
    return await billColl.find().limit(limit).skip((page - 1) * limit).sort({ _id: -1 }).toArray();
}

export async function coinUserBillCount(userId: number) {
    return await billColl.countDocuments({ userId });
}

export async function coinGetUser(userId: number, limit: number, page: number) {
    return await billColl.find({ userId }).limit(limit).skip((page - 1) * limit).sort({ _id: -1 }).toArray();
}

export async function coinGetLeaderboard(page: number) {
    return await userColl.find({ coin_all: { $exists: true } }).sort({ coin_now: -1 }).toArray();
}

// --- Birthday ---

export async function setBirthday(userId: number, date: string) {
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

export async function getTodayBirthdays() {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const monthDay = `${mm}-${dd}`;
    return await userColl.find({ birthday_monthDay: monthDay }).toArray();
}

export async function getAllBirthdays() {
    return await userColl.find({ birthday_date: { $exists: true } }).sort({ _id: -1 }).toArray();
}

export async function getBirthdayCount() {
    return await userColl.countDocuments({ birthday_date: { $exists: true } });
}

export async function getRecentBirthdays(limit: number) {
    return await userColl.find({ birthday_date: { $exists: true } }).sort({ _id: -1 }).limit(limit).toArray();
}

// --- Badge ---

export async function setBadge(userId: number, text: string, color: string, textColor: string) {
    await userColl.updateOne(
        { _id: userId },
        { $set: { badge_text: text, badge_color: color, badge_textColor: textColor } },
        { upsert: true },
    );
    await addLog({ type: 'badge', userId, badgeText: text, badgeColor: color, badgeTextColor: textColor });
}

export async function getBadgedUsers() {
    return await userColl.find({ badge_text: { $exists: true, $ne: '' } }).toArray();
}

export async function removeBadge(userId: number) {
    await userColl.updateOne(
        { _id: userId },
        { $unset: { badge_text: '', badge_color: '', badge_textColor: '' } },
    );
}

// --- Realname ---

export async function setRealname(userId: number, flag: number, name: string) {
    await userColl.updateOne(
        { _id: userId },
        { $set: { realname_flag: flag, realname_name: name } },
        { upsert: true },
    );
    await addLog({ type: 'realname', userId, realnameName: name });
}

export async function getRealnamedUsers() {
    return await userColl.find({ realname_flag: { $exists: true } }).toArray();
}

// --- Checkin ---

export async function doCheckin(userId: number, todayStr: string) {
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

export async function getCheckinUser(userId: number) {
    return await userColl.findOne({ _id: userId });
}

// --- Combined users query ---

export async function getAllUsersData(page: number, pageSize: number, flag?: number) {
    const conditions: Record<string, any>[] = [
        { coin_now: { $exists: true } },
        { birthday_date: { $exists: true } },
        { realname_flag: { $exists: true } },
    ];
    const filter: Record<string, any> = { $or: conditions };
    if (flag !== undefined) {
        filter.realname_flag = flag;
        delete filter.$or;
    }
    const total = await userColl.countDocuments(filter);
    const upcount = Math.ceil(total / pageSize);
    const docs = await userColl.find(filter).sort({ _id: 1 })
        .skip((page - 1) * pageSize).limit(pageSize).toArray();
    return { docs, total, upcount };
}

// --- Rating page ---

export async function getRatedUsers(sortBy: string, page: number, pageSize: number) {
    const filter = {
        $or: [
            { atcoder: { $exists: true, $ne: '' } },
            { codeforces: { $exists: true, $ne: '' } },
        ],
    };
    const total = await userColl.countDocuments(filter);
    const upcount = Math.ceil(total / pageSize);
    const sortField = sortBy === 'codeforces' ? 'codeforces_rating' : 'atcoder_rating';
    const docs = await userColl.find(filter)
        .sort({ [sortField]: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();
    return { docs, total, upcount };
}
