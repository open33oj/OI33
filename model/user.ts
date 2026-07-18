import { db } from 'hydrooj';
import { Oi33User } from './types';
import { addLog } from './log';

export const userColl = db.collection('oi33_user');

export const CAT_FOOD_START_DATE = '2026-07-18';
export const CAT_FOOD_NORMAL_REWARD = 100;
export const CAT_FOOD_STREAK_REWARD = 150;
const CAT_FOOD_BACKFILL_VERSION = 2;

function getPreviousDate(dateStr: string) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
}

function getHistoricalCatFood(doc: Pick<Oi33User, 'checkin_cnt_all' | 'checkin_cnt_now' | 'checkin_time'>) {
    const base = Math.max(0, Math.floor(Number(doc.checkin_cnt_all) || 0)) * CAT_FOOD_NORMAL_REWARD;
    const streakBonus = doc.checkin_time === CAT_FOOD_START_DATE && (doc.checkin_cnt_now || 0) > 1
        ? CAT_FOOD_STREAK_REWARD - CAT_FOOD_NORMAL_REWARD
        : 0;
    return base + streakBonus;
}

function getCatFoodBackfillGrant(doc: Oi33User) {
    const target = getHistoricalCatFood(doc);
    return Math.max(0, target - Math.max(0, Number(doc.cat_food) || 0));
}

function needsCatFoodBackfillFilter() {
    return {
        $or: [
            { cat_food_backfill_version: { $exists: false } },
            { cat_food_backfill_version: { $lt: CAT_FOOD_BACKFILL_VERSION } },
        ],
    };
}

export async function previewCatFoodBackfill() {
    const docs = await userColl.find(needsCatFoodBackfillFilter())
        .project({ _id: 1, checkin_cnt_all: 1, checkin_cnt_now: 1, checkin_time: 1, cat_food: 1 }).toArray();
    return {
        users: docs.length,
        amount: docs.reduce((sum, doc) => sum + getCatFoodBackfillGrant(doc), 0),
    };
}

export async function backfillCatFoodForUser(userId: number) {
    const doc = await userColl.findOne({ _id: userId });
    if (!doc || (doc.cat_food_backfill_version || 0) >= CAT_FOOD_BACKFILL_VERSION) {
        return { updated: false, granted: 0 };
    }
    // Reconcile to the launch entitlement instead of blindly adding it again.
    // This lets users already marked by v1 receive only the newly missing amount.
    const granted = getCatFoodBackfillGrant(doc);
    const update: any = {
        $set: {
            cat_food_backfill_version: CAT_FOOD_BACKFILL_VERSION,
            cat_food_backfilled_at: new Date(),
        },
    };
    if (granted) update.$inc = { cat_food: granted };
    const result = await userColl.updateOne(
        { _id: userId, ...needsCatFoodBackfillFilter() },
        update,
    );
    if (!result.modifiedCount) return { updated: false, granted: 0 };
    if (granted) {
        await addLog({
            type: 'checkin',
            userId,
            action: 'cat_food_backfill',
            amount: granted,
        });
    }
    return { updated: true, granted };
}

export async function backfillAllCatFood() {
    const docs = await userColl.find(needsCatFoodBackfillFilter()).project({ _id: 1 }).toArray();
    let users = 0;
    let amount = 0;
    for (const doc of docs) {
        const result = await backfillCatFoodForUser(doc._id);
        if (!result.updated) continue;
        users++;
        amount += result.granted;
    }
    return { users, amount };
}

export async function getUserDataByUids(uids: number[]): Promise<Record<number, Oi33User>> {
    const docs = await userColl.find({ _id: { $in: uids } }).toArray();
    const dict: Record<number, Oi33User> = {};
    for (const doc of docs) dict[doc._id] = doc;
    return dict;
}

function setPrivateDisplayField(udoc: any, key: string, value: any) {
    Object.defineProperty(udoc, key, {
        configurable: true,
        enumerable: false,
        writable: true,
        value,
    });
}

export function anonymizeOi33Identity(udoc: any) {
    if (!udoc?.oi33_profile_hidden) return;
    if (udoc.oi33_original_uname === undefined) setPrivateDisplayField(udoc, 'oi33_original_uname', udoc.uname || '');
    if (udoc.oi33_original_avatar === undefined) setPrivateDisplayField(udoc, 'oi33_original_avatar', udoc.avatar || '');
    setPrivateDisplayField(udoc, 'oi33_identity_anonymized', true);
    udoc.uname = `UID ${udoc._id}`;
    udoc.avatar = '';
    if ('avatarUrl' in udoc) udoc.avatarUrl = '';
    udoc.displayName = '';
    udoc.realname_name = '';
}

export function mergeOi33Fields(udoc: any, oi33: Oi33User | undefined, fields?: string[]) {
    const profileHidden = (oi33?.realname_flag ?? 0) < 1;
    udoc.oi33_profile_hidden = profileHidden;
    if (profileHidden) {
        if (udoc.oi33_original_uname === undefined) setPrivateDisplayField(udoc, 'oi33_original_uname', udoc.uname || '');
        if (udoc.oi33_original_avatar === undefined) setPrivateDisplayField(udoc, 'oi33_original_avatar', udoc.avatar || '');
    }
    if (!oi33) {
        if (udoc.oi33_identity_anonymized) anonymizeOi33Identity(udoc);
        return;
    }
    const mergeAll = !fields;
    if (mergeAll || fields!.includes('coin')) {
        udoc.coin_now = oi33.coin_now ?? 0;
        udoc.coin_all = oi33.coin_all ?? 0;
    }
    if (mergeAll || fields!.includes('cat_food')) {
        udoc.cat_food = oi33.cat_food ?? 0;
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
    if (udoc.oi33_identity_anonymized) anonymizeOi33Identity(udoc);
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
    await backfillCatFoodForUser(userId);
    const doc = await userColl.findOne({ _id: userId });
    const prev = doc || {};
    if (doc?.checkin_time === todayStr) {
        return {
            checkedIn: false,
            checkin_luck: doc.checkin_luck ?? 0,
            checkin_cnt_now: doc.checkin_cnt_now ?? 0,
            checkin_cnt_all: doc.checkin_cnt_all ?? 0,
            cat_food_reward: 0,
            cat_food: doc.cat_food ?? 0,
        };
    }
    let checkin_cnt_all = (prev.checkin_cnt_all || 0) + 1;
    let checkin_cnt_now = prev.checkin_cnt_now || 0;
    const isConsecutive = prev.checkin_time === getPreviousDate(todayStr) && checkin_cnt_now > 0;
    checkin_cnt_now = isConsecutive ? checkin_cnt_now + 1 : 1;
    const checkin_luck = Math.floor(Math.random() * 7);
    const cat_food_reward = todayStr >= CAT_FOOD_START_DATE
        ? isConsecutive ? CAT_FOOD_STREAK_REWARD : CAT_FOOD_NORMAL_REWARD
        : 0;
    const filter = doc
        ? {
            _id: userId,
            ...(doc.checkin_time
                ? { checkin_time: doc.checkin_time }
                : { checkin_time: { $exists: false } }),
        }
        : { _id: userId, checkin_time: { $exists: false } };
    const update: any = {
        $set: { checkin_time: todayStr, checkin_luck, checkin_cnt_now, checkin_cnt_all },
        $setOnInsert: {
            cat_food_backfill_version: CAT_FOOD_BACKFILL_VERSION,
            cat_food_backfilled_at: new Date(),
        },
    };
    if (cat_food_reward) update.$inc = { cat_food: cat_food_reward };

    let result;
    try {
        result = await userColl.updateOne(filter, update, { upsert: !doc });
    } catch (e: any) {
        if (e?.code !== 11000) throw e;
    }
    if (!result || (!result.matchedCount && !result.upsertedCount)) {
        const current = await userColl.findOne({ _id: userId });
        return {
            checkedIn: false,
            checkin_luck: current?.checkin_luck ?? 0,
            checkin_cnt_now: current?.checkin_cnt_now ?? 0,
            checkin_cnt_all: current?.checkin_cnt_all ?? 0,
            cat_food_reward: 0,
            cat_food: current?.cat_food ?? 0,
        };
    }
    await addLog({
        type: 'checkin',
        userId,
        action: 'checkin',
        amount: cat_food_reward,
    });
    return {
        checkedIn: true,
        checkin_luck,
        checkin_cnt_now,
        checkin_cnt_all,
        cat_food_reward,
        cat_food: (prev.cat_food ?? 0) + cat_food_reward,
    };
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
