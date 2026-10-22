// 盲盒奖章 (medal blind box): an administrator defines a pool of medals with a
// price, an opening time and an integer probability for each medal (totalling
// 100). A purchase charges cat cans and grants one medal, rolled by those
// weights. Every account may buy BLINDBOX_DAILY_LIMIT boxes per Shanghai day
// across all pools.
//
// Pure rules (normalisation, validation, the weighted roll, the day key) live in
// ./blindbox-rules so they stay unit-testable.

import {
    ObjectId, ValidationError, db,
} from 'hydrooj';
import type { Oi33BlindboxItem, Oi33MedalBlindbox } from './types';
import { addLog } from './log';
import { adjustCatCans } from './cat-can';
import {
    medalCategoryOf, medalColl, medalGrant, medalIsLevelSeries, medalStarLevel, userMedalColl,
} from './medal';
import { userColl } from './user';
import {
    BLINDBOX_DAILY_LIMIT, blindboxDayKey, blindboxItemsSum, normalizeBlindboxItems,
    normalizeBlindboxName, normalizeBlindboxOpenAt, normalizeBlindboxPrice,
    pickBlindboxMedal, validateBlindboxItems,
} from './blindbox-rules';

export * from './blindbox-rules';

export const blindboxColl = db.collection('oi33_medal_blindbox');
export const blindboxLogColl = db.collection('oi33_medal_blindbox_log');

export async function ensureBlindboxIndexes() {
    await Promise.all([
        blindboxColl.createIndex({ enabled: 1, openAt: 1 } as any),
        blindboxLogColl.createIndex({ uid: 1, createdAt: -1 } as any),
        blindboxLogColl.createIndex({ poolId: 1, createdAt: -1 } as any),
    ]);
}

// 盲盒是一般奖章的售卖形式，所以池子里只能放一般奖章：可售卖奖章全服唯一（走拍卖
// 与合同）、认证奖章与 OJ 成就奖章有自己的发放渠道（比赛认证 / 自动规则）。
export function blindboxMedalIssue(medal: any): string | null {
    if (!medal) return '奖章不存在。';
    if (medalCategoryOf(medal) !== 'manual') return '盲盒只能放一般奖章。';
    if (medalIsLevelSeries(medal)) return '有等级阶梯的奖章不能放进盲盒。';
    return null;
}

export function toBlindboxId(raw: unknown): ObjectId | null {
    const text = String(raw ?? '').trim();
    if (!ObjectId.isValid(text)) return null;
    return new ObjectId(text);
}

export async function blindboxList(): Promise<any[]> {
    const pools = await blindboxColl.find().sort({ openAt: -1, createdAt: -1 }).toArray();
    const medalIds = [...new Set(pools.flatMap((pool: any) => (pool.items || []).map((item: any) => item.medalId)))];
    const medals = medalIds.length ? await medalColl.find({ _id: { $in: medalIds } } as any).toArray() : [];
    const nameOf = new Map<string, string>(
        medals.map((medal: any): [string, string] => [String(medal._id), String(medal.name || medal._id)]),
    );
    return pools.map((pool: any) => ({
        ...pool,
        // 模板里生成编辑链接用的纯字符串 id（ObjectId 交给 URL helper 容易出意外）。
        id: String(pool._id),
        items: (pool.items || []).map((item: any) => ({
            ...item,
            medalName: nameOf.get(item.medalId) || item.medalId,
        })),
        probabilitySum: blindboxItemsSum(pool.items || []),
    }));
}

// 首页侧栏卡片用：当前可以购买（已上架且已到开放时间）的盲盒数量。
export async function blindboxOpenCount(now = new Date()): Promise<number> {
    return await blindboxColl.countDocuments({ enabled: true, openAt: { $lte: now } } as any);
}

export async function blindboxGet(id: ObjectId): Promise<any | null> {
    return await blindboxColl.findOne({ _id: id } as any);
}

// Create (no id) or update (id) a pool. Returns the stored document.
export async function blindboxSave(input: any, operator: number, now = new Date()): Promise<Oi33MedalBlindbox> {
    const id = input?.id ? toBlindboxId(input.id) : null;
    const name = normalizeBlindboxName(input?.name);
    if (!name) throw new ValidationError('请填写盲盒名称。');
    const price = normalizeBlindboxPrice(input?.price);
    if (price === null) throw new ValidationError('价格必须是 1 到 1000000 之间的整数（猫罐头）。');
    const openAt = normalizeBlindboxOpenAt(input?.openAt);
    if (!openAt) throw new ValidationError('请填写有效的开放购买时间。');
    const items = normalizeBlindboxItems(input?.items);
    const itemIssue = validateBlindboxItems(items);
    if (itemIssue) throw new ValidationError(itemIssue);

    // Every referenced medal must exist and be eligible.
    const medals = await medalColl.find({ _id: { $in: items.map((item) => item.medalId) } } as any).toArray();
    const byId = new Map(medals.map((medal: any) => [String(medal._id), medal]));
    for (const item of items) {
        const issue = blindboxMedalIssue(byId.get(item.medalId));
        if (issue) throw new ValidationError(`${item.medalId}：${issue}`);
    }

    const enabled = input?.enabled === undefined ? true : !!input.enabled;
    let storedId: ObjectId;
    if (id) {
        const existing = await blindboxColl.findOne({ _id: id } as any);
        if (!existing) throw new ValidationError('盲盒不存在。');
        storedId = id;
        await blindboxColl.updateOne(
            { _id: id } as any,
            {
                $set: {
                    name, price, openAt, items, enabled, updatedAt: now, updatedBy: operator,
                },
            } as any,
        );
        await addLog({
            type: 'medal', userId: operator, action: 'blindbox_update', reason: `${id.toHexString()} ${name}`,
        } as any);
    } else {
        storedId = new ObjectId();
        await blindboxColl.insertOne({
            _id: storedId,
            name,
            price,
            openAt,
            items,
            enabled,
            createdAt: now,
            createdBy: operator,
            updatedAt: now,
            updatedBy: operator,
        } as any);
        await addLog({
            type: 'medal', userId: operator, action: 'blindbox_create', reason: `${storedId.toHexString()} ${name}`,
        } as any);
    }
    return await blindboxColl.findOne({ _id: storedId } as any) as any;
}

export async function blindboxDelete(id: ObjectId, operator: number): Promise<void> {
    const pool = await blindboxColl.findOne({ _id: id } as any);
    if (!pool) throw new ValidationError('盲盒不存在。');
    await blindboxColl.deleteOne({ _id: id } as any);
    await addLog({
        type: 'medal', userId: operator, action: 'blindbox_delete', reason: `${id.toHexString()} ${pool.name}`,
    } as any);
}

export async function blindboxSetEnabled(id: ObjectId, enabled: boolean, operator: number, now = new Date()): Promise<void> {
    const pool = await blindboxColl.findOne({ _id: id } as any);
    if (!pool) throw new ValidationError('盲盒不存在。');
    await blindboxColl.updateOne(
        { _id: id } as any,
        { $set: { enabled, updatedAt: now, updatedBy: operator } } as any,
    );
    await addLog({
        type: 'medal', userId: operator, action: 'blindbox_toggle',
        reason: `${id.toHexString()} ${pool.name} ${enabled ? '启用' : '停用'}`,
    } as any);
}

// How many boxes this account has already bought today.
export async function blindboxDailyUsed(uid: number, now = new Date()): Promise<number> {
    const day = blindboxDayKey(now);
    const user: any = await userColl.findOne({ _id: uid } as any, { projection: { blindbox_day: 1, blindbox_count: 1 } });
    if (!user || user.blindbox_day !== day) return 0;
    return Math.max(0, Number(user.blindbox_count) || 0);
}

// Atomically take one box out of today's quota. `false` = the quota is used up.
async function blindboxClaimDaily(uid: number, day: string): Promise<boolean> {
    await userColl.updateOne({ _id: uid } as any, { $setOnInsert: { _id: uid } } as any, { upsert: true });
    // A new day resets the counter; otherwise bump it while it is below the cap.
    const reset = await userColl.updateOne(
        { _id: uid, blindbox_day: { $ne: day } } as any,
        { $set: { blindbox_day: day, blindbox_count: 1, blindbox_at: new Date() } } as any,
    );
    if (reset.matchedCount) return true;
    const bump = await userColl.updateOne(
        { _id: uid, blindbox_day: day, blindbox_count: { $lt: BLINDBOX_DAILY_LIMIT } } as any,
        { $inc: { blindbox_count: 1 }, $set: { blindbox_at: new Date() } } as any,
    );
    return !!bump.matchedCount;
}

// Give a claim back (the purchase failed after the claim).
async function blindboxReleaseDaily(uid: number, day: string): Promise<void> {
    await userColl.updateOne(
        { _id: uid, blindbox_day: day, blindbox_count: { $gt: 0 } } as any,
        { $inc: { blindbox_count: -1 } } as any,
    );
}

export async function blindboxLogs(uid: number, limit = 20): Promise<any[]> {
    const logs = await blindboxLogColl.find({ uid } as any).sort({ createdAt: -1 }).limit(limit).toArray();
    return await blindboxAttachMedals(logs);
}

// 分页版开盒记录（右侧「查看全部」页用），返回 `{ logs, total, upcount }`。
export async function blindboxLogPage(uid: number, page = 1, limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit) || 20));
    const [total, totals] = await Promise.all([
        blindboxLogColl.countDocuments({ uid } as any),
        blindboxLogColl.aggregate([
            { $match: { uid } },
            { $group: { _id: null, spent: { $sum: '$price' }, copies: { $sum: 1 } } },
        ]).toArray(),
    ]);
    const upcount = Math.max(1, Math.ceil(total / safeLimit));
    const current = Math.max(1, Math.min(upcount, Math.floor(page) || 1));
    const logs = await blindboxLogColl.find({ uid } as any)
        .sort({ createdAt: -1 })
        .skip((current - 1) * safeLimit)
        .limit(safeLimit)
        .toArray();
    return {
        logs: await blindboxAttachMedals(logs),
        total,
        upcount,
        page: current,
        pageSize: safeLimit,
        spent: Math.max(0, Number((totals[0] as any)?.spent) || 0),
    };
}

// 给每条开盒记录挂上奖章定义（名称 / 像素图），列表与分页页共用。
export async function blindboxAttachMedals(logs: any[]): Promise<any[]> {
    const medalIds = [...new Set(logs.map((log: any) => String(log.medalId)))];
    const medals = medalIds.length
        ? await medalColl.find({ _id: { $in: medalIds } } as any).toArray()
        : [];
    const medalDict = new Map<string, any>(
        medals.map((medal: any): [string, any] => [String(medal._id), medal]),
    );
    return logs.map((log: any) => ({
        ...log,
        medal: medalDict.get(String(log.medalId)) || null,
        stars: medalStarLevel(log.copies || 1),
    }));
}

export interface BlindboxPurchaseResult {
    poolId: ObjectId;
    poolName: string;
    medalId: string;
    price: number;
    // 抽到后该奖章的持有数量与对应星级（重复的一般奖章会升星）。
    copies: number;
    stars: number;
    remaining: number;
}

// Buy one box. Order of operations matters: quota → payment → grant, and every
// later failure rolls the earlier steps back so a failed purchase never costs
// the buyer anything.
export async function blindboxPurchase(uid: number, poolId: ObjectId, now = new Date()): Promise<BlindboxPurchaseResult> {
    const pool: any = await blindboxColl.findOne({ _id: poolId } as any);
    if (!pool) throw new ValidationError('盲盒不存在。');
    if (!pool.enabled) throw new ValidationError('该盲盒已下架。');
    if (new Date(pool.openAt).getTime() > now.getTime()) {
        throw new ValidationError('该盲盒还没有到开放购买时间。');
    }
    const buyer: any = await userColl.findOne({ _id: uid } as any, { projection: { realname_flag: 1 } });
    // A missing oi33 profile counts as unverified, exactly like checkUserFlag.
    if ((Number(buyer?.realname_flag) || 0) < 1) throw new ValidationError('完成实名认证后才能购买盲盒。');

    // 每次购买都在整组里按权重抽取。抽到已有的一般奖章不会浪费——medalGrant 会把
    // 该奖章的数量 +1，星级随数量提升（floor(log2(count))）。
    const items: Oi33BlindboxItem[] = (pool.items || []).filter((item: any) => item?.medalId);
    if (!items.length) throw new ValidationError('该盲盒还没有配置奖章。');

    const day = blindboxDayKey(now);
    const price = Number(pool.price) || 0;
    if (!Number.isSafeInteger(price) || price < 1) throw new ValidationError('该盲盒价格无效，请联系管理员。');
    if (!await blindboxClaimDaily(uid, day)) {
        throw new ValidationError(`今天已经买过 ${BLINDBOX_DAILY_LIMIT} 次盲盒了，明天再来吧。`);
    }

    try {
        await adjustCatCans(uid, uid, -price, `盲盒奖章：${pool.name}`.slice(0, 100));
    } catch (e: any) {
        await blindboxReleaseDaily(uid, day);
        throw new ValidationError(e?.message || '猫罐头扣除失败。');
    }

    const total = blindboxItemsSum(items);
    const medalId = pickBlindboxMedal(items, Math.floor(Math.random() * Math.max(1, total)))!;
    let copies = 1;
    try {
        // 重复的一般奖章会由 medalGrant 累加数量（星级随数量提升）。
        const granted = await medalGrant(uid, medalId, uid, 'blindbox');
        copies = Math.max(1, Math.floor(Number((granted.grant as any)?.count) || 1));
    } catch (e: any) {
        // Refund both the cans and the daily quota.
        try {
            await adjustCatCans(uid, uid, price, `盲盒奖章退款：${pool.name}`.slice(0, 100));
        } catch (refundError) {
            console.error('[oi33] blindbox refund failed:', refundError);
        }
        await blindboxReleaseDaily(uid, day);
        throw new ValidationError(e?.message || '奖章发放失败，罐头已退回。');
    }

    const log: any = {
        _id: new ObjectId(),
        uid,
        poolId: pool._id,
        poolName: pool.name,
        medalId,
        price,
        copies,
        createdAt: now,
    };
    await blindboxLogColl.insertOne(log);
    await addLog({
        type: 'medal', userId: uid, action: 'blindbox_purchase', medalId, amount: price,
        reason: pool.name,
    } as any);
    // 开盒结果通过页面跳转的 notification 和开盒记录展示，不再另发私信。
    const remaining = await blindboxDailyUsed(uid, now);
    return {
        poolId: pool._id,
        poolName: pool.name,
        medalId,
        price,
        copies,
        stars: medalStarLevel(copies),
        remaining: Math.max(0, BLINDBOX_DAILY_LIMIT - remaining),
    };
}

// View data for the buyer page: every pool with the medals that are still new
// for this user, plus today's remaining quota.
export async function blindboxOverview(uid: number, now = new Date()) {
    const pools = await blindboxList();
    const medalIds = [...new Set(pools.flatMap((pool: any) => (pool.items || []).map((item: any) => item.medalId)))];
    const [medals, owned, used, buyer] = await Promise.all([
        medalIds.length ? medalColl.find({ _id: { $in: medalIds } } as any).toArray() : [],
        medalIds.length ? userMedalColl.find({ uid, medalId: { $in: medalIds } } as any).toArray() : [],
        blindboxDailyUsed(uid, now),
        userColl.findOne({ _id: uid } as any, { projection: { cat_can: 1 } }),
    ]);
    const medalDict = new Map<string, any>(
        medals.map((medal: any): [string, any] => [String(medal._id), medal]),
    );
    const heldDict = new Map<string, any>(
        owned.map((row: any): [string, any] => [String(row.medalId), row]),
    );
    return {
        pools: pools.map((pool: any) => {
            const rows = (pool.items || []).map((item: any) => {
                const held = heldDict.get(item.medalId);
                const count = held ? Math.max(1, Math.floor(Number(held.count) || 1)) : 0;
                return {
                    ...item,
                    medal: medalDict.get(item.medalId) || null,
                    owned: !!held,
                    count,
                    stars: held ? medalStarLevel(count) : 0,
                };
            });
            return {
                ...pool,
                rows,
                ownedCount: rows.filter((row: any) => row.owned).length,
                open: !!pool.enabled && new Date(pool.openAt).getTime() <= now.getTime(),
            };
        }),
        used,
        remaining: Math.max(0, BLINDBOX_DAILY_LIMIT - used),
        catCan: Math.max(0, Number((buyer as any)?.cat_can) || 0),
    };
}
