// 一次性退役「大猫主动贡献」（手动投喂）。
//
// 迁移内容：
//   1. 按 oi33_log 的 school_feed 日志，把每个用户手动投喂的猫粮全额退回；
//   2. 删除所有大猫的 currentWeight / historyWeight 字段；
//   3. 删除 school_feed_history（历史投喂不再参与任何计算）；
//   4. 清空用户的 school_cat_food / school_cat_feed_at；
//   5. 按格子重新统计 territoryCount。
//
// 幂等：退回过的日志打 feedRefunded，重复执行不会二次退款；其余步骤都是
// 覆盖/删除，可安全重跑。迁移页会先展示预览（人数、猫粮总量、体重记录数）。

import { createHash } from 'crypto';
import { ObjectId, db } from 'hydrooj';
import { addLog, logColl } from '../log';
import { userColl } from '../user';
import { catCanPoolColl, ensureCatCanPool } from './can';
import { recountSchoolCatTerritories } from './map';
import { schoolCatColl, schoolFeedHistoryColl } from './school-shared';

const FEED_ACTION = 'school_feed';
const FEED_REFUND_ACTION = 'school_feed_refund';

// 退款流水的 _id 由「用户 + 退款批次时间」确定：补账可以重复执行，重复插入
// 会撞唯一 _id 而不是生成第二笔退款记录。退款本身早已发生，这里只补展示流水。
function feedRefundLogId(uid: number, refundedAt: Date) {
    const hex = createHash('sha1')
        .update(`oi33:feed-refund:${uid}:${refundedAt.getTime()}`)
        .digest('hex')
        .slice(0, 24);
    return new ObjectId(hex);
}

async function ensureFeedRefundLog(
    uid: number, feeds: number, grams: number, refundedAt: Date, backfill: boolean,
): Promise<'inserted' | 'existing'> {
    if (!Number.isSafeInteger(uid) || uid <= 0 || grams <= 0) return 'existing';
    try {
        await logColl.insertOne({
            _id: feedRefundLogId(uid, refundedAt),
            createdAt: refundedAt,
            type: 'cat_account',
            userId: uid,
            sender: 0,
            action: FEED_REFUND_ACTION,
            amount: grams,
            reason: `大猫主动贡献退役退款：${feeds} 笔历史投喂，共 ${grams}g`,
            feedRefundBatchAt: refundedAt,
            feedRefundFeeds: feeds,
            ...(backfill ? { feedRefundBackfill: true } : {}),
        } as any);
        return 'inserted';
    } catch (e: any) {
        if (e?.code === 11000) return 'existing';
        throw e;
    }
}

export interface FeedRefundBackfillResult {
    batches: number;
    users: number;
    grams: number;
    inserted: number;
    insertedGrams: number;
    existing: number;
    skipped: number;
}

// 为已经执行过退款、但只有 admin 汇总日志而没有个人流水的历史投喂补写
// cat_account 退款记录。只插入日志，绝不改动余额，也不会重新退款。
export async function backfillFeedRefundLogs(): Promise<FeedRefundBackfillResult> {
    const rows: any[] = await logColl.aggregate([
        {
            $match: {
                type: 'cat_account',
                action: FEED_ACTION,
                userId: { $gt: 0 },
                amount: { $lt: 0 },
                feedRefunded: true,
            },
        },
        {
            $group: {
                _id: { userId: '$userId', refundedAt: '$feedRefundedAt' },
                feeds: { $sum: 1 },
                grams: { $sum: { $multiply: ['$amount', -1] } },
            },
        },
    ]).toArray();
    const batches = new Map<string, { uid: number; feeds: number; grams: number; refundedAt: Date }>();
    let skipped = 0;
    for (const row of rows) {
        const uid = Number(row._id?.userId);
        const rawAt = row._id?.refundedAt;
        const refundedAt = rawAt instanceof Date ? rawAt : rawAt ? new Date(rawAt) : null;
        const feeds = Math.max(0, Math.floor(Number(row.feeds) || 0));
        const grams = Math.max(0, Math.floor(Number(row.grams) || 0));
        if (!Number.isSafeInteger(uid) || uid <= 0 || !refundedAt
            || Number.isNaN(refundedAt.getTime()) || grams <= 0) {
            skipped++;
            continue;
        }
        // 同类时间戳可能以 Date/字符串两种形式存在；按 epoch 合并，避免同一批次
        // 被拆成多条退款流水。
        const key = `${uid}:${refundedAt.getTime()}`;
        const existing = batches.get(key);
        if (existing) {
            existing.feeds += feeds;
            existing.grams += grams;
        } else {
            batches.set(key, { uid, feeds, grams, refundedAt });
        }
    }
    const uids = new Set<number>();
    let inserted = 0;
    let existing = 0;
    let totalGrams = 0;
    let insertedGrams = 0;
    for (const batch of batches.values()) {
        uids.add(batch.uid);
        totalGrams += batch.grams;
        const status = await ensureFeedRefundLog(
            batch.uid, batch.feeds, batch.grams, batch.refundedAt, true,
        );
        if (status === 'inserted') {
            inserted++;
            insertedGrams += batch.grams;
        } else {
            existing++;
        }
    }
    return {
        batches: batches.size,
        users: uids.size,
        grams: totalGrams,
        inserted,
        insertedGrams,
        existing,
        skipped,
    };
}

export interface RetireContributionPreview {
    users: number;
    feeds: number;
    grams: number;
    catsWithWeight: number;
    historyRows: number;
    usersWithContribution: number;
}

async function refundRows() {
    const rows: any[] = await logColl.aggregate([
        {
            $match: {
                type: 'cat_account',
                action: FEED_ACTION,
                userId: { $gt: 0 },
                amount: { $lt: 0 },
                feedRefunded: { $ne: true },
                schoolFeedRollbackId: { $exists: false },
            },
        },
        {
            $group: {
                _id: '$userId',
                feeds: { $sum: 1 },
                grams: { $sum: { $multiply: ['$amount', -1] } },
            },
        },
    ]).toArray();
    return rows
        .map((row) => ({
            uid: Number(row._id),
            feeds: Math.max(0, Math.floor(Number(row.feeds) || 0)),
            grams: Math.max(0, Math.floor(Number(row.grams) || 0)),
        }))
        .filter((row) => Number.isSafeInteger(row.uid) && row.uid > 0 && row.grams > 0);
}

export async function previewRetireActiveContribution(): Promise<RetireContributionPreview> {
    const rows = await refundRows();
    const [catsWithWeight, historyRows, usersWithContribution] = await Promise.all([
        schoolCatColl.countDocuments({
            $or: [
                { currentWeight: { $gt: 0 } },
                { historyWeight: { $gt: 0 } },
            ],
        } as any),
        schoolFeedHistoryColl.countDocuments({}),
        userColl.countDocuments({ school_cat_food: { $gt: 0 } } as any),
    ]);
    return {
        users: rows.length,
        feeds: rows.reduce((sum, row) => sum + row.feeds, 0),
        grams: rows.reduce((sum, row) => sum + row.grams, 0),
        catsWithWeight,
        historyRows,
        usersWithContribution,
    };
}

export async function retireActiveContribution(operator = 0, now = new Date()) {
    const rows = await refundRows();
    let refundedUsers = 0;
    let refundedGrams = 0;
    for (const row of rows) {
        // 先退回再打标记：中途崩溃时宁可下一次重复退一次，也不能让用户退款丢失。
        const refunded = await userColl.updateOne(
            { _id: row.uid } as any,
            { $inc: { cat_food: row.grams } } as any,
        );
        if (!refunded.matchedCount) continue;
        refundedUsers++;
        refundedGrams += row.grams;
        await logColl.updateMany({
            type: 'cat_account',
            action: FEED_ACTION,
            userId: row.uid,
            amount: { $lt: 0 },
            feedRefunded: { $ne: true },
            schoolFeedRollbackId: { $exists: false },
        } as any, {
            $set: { feedRefunded: true, feedRefundedAt: now },
        } as any);
        // 同时补一条个人退款流水，让账户明细与已退回的余额对得上。
        // 流水失败不应回滚已经完成的退款；事后可用运维动作幂等补记。
        try {
            await ensureFeedRefundLog(row.uid, row.feeds, row.grams, now, false);
        } catch (e) {
            console.error(`[oi33] failed to log feed refund for uid ${row.uid}:`, e);
        }
    }

    await ensureCatCanPool(now);
    if (refundedGrams > 0) {
        await catCanPoolColl.updateOne(
            { _id: 'main' } as any,
            { $inc: { userFoodTotal: refundedGrams }, $set: { updatedAt: now } } as any,
        );
    }

    const catsCleared = await schoolCatColl.countDocuments({
        $or: [
            { currentWeight: { $gt: 0 } },
            { historyWeight: { $gt: 0 } },
        ],
    } as any);
    await userColl.updateMany({} as any, {
        $unset: { school_cat_food: '', school_cat_feed_at: '' },
    } as any);
    await schoolFeedHistoryColl.deleteMany({} as any);
    // 直接 unset 而不是写 0：新代码不再读写体重，字段本身也不应该继续存在。
    await schoolCatColl.updateMany({} as any, {
        $set: { updatedAt: now },
        $unset: { currentWeight: '', historyWeight: '' },
    } as any);
    await schoolCatColl.dropIndex('currentWeight_-1').catch(() => {});
    // 清掉早期全局野猫（-1000 号特殊大猫）留下的领地，改为用户级野猫模式。
    const legacyWildCells = await db.collection('oi33_cat_map_cell').updateMany(
        { catId: -1000 } as any,
        { $set: { catId: 0 } } as any,
    );
    await db.collection('oi33_school_cat').deleteOne({ _id: -1000 } as any);
    await db.collection('oi33_cat_map_config').updateOne(
        { _id: 'main' } as any,
        {
            $unset: {
                wildcatEnabled: '', wildcatX: '', wildcatY: '',
                wildcatNextAt: '', wildcatVisited: '',
            },
        } as any,
    );
    const territory = await recountSchoolCatTerritories(now);

    await addLog({
        type: 'admin',
        userId: operator,
        sender: operator,
        action: 'retire_cat_contribution',
        amount: refundedGrams,
        reason: `关闭大猫主动贡献：退回 ${refundedUsers} 位用户 ${refundedGrams}g 猫粮，`
            + `清空体重与投喂历史，重算 ${territory.catCount} 只大猫的 ${territory.cellCount} 格领地`,
    } as any);

    return {
        refundedUsers,
        refundedGrams,
        catsWithWeightCleared: catsCleared,
        legacyWildCells: legacyWildCells.modifiedCount,
        territoryCells: territory.cellCount,
    };
}
