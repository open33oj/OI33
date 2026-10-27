import { ObjectId, db } from 'hydrooj';
import { addLog, logColl } from '../log';
import { userColl } from '../user';
import {
    ensureSchoolCatRecord, getSchoolView, schoolCatColl,
    schoolCatKey, schoolDisplay, schoolFeedHistoryColl,
} from './school-shared';
import { getEligibleUser } from './eligibility';

// 行政操作：领地计数重算、整只大猫的转移、历史移动贡献的一次性回填。

const catMapCellColl = db.collection('oi33_cat_map_cell');

async function recountSchoolCatTerritoryFor(schoolIds: number[], now = new Date()) {
    const keys = schoolIds.map((id) => schoolCatKey(id));
    const groups: any[] = await catMapCellColl.aggregate([
        { $match: { catId: { $in: keys } } },
        { $group: { _id: '$catId', count: { $sum: 1 } } },
    ]).toArray();
    const counts = new Map<number, number>(groups.map(
        (group: any) => [Number(group._id), Math.max(0, Math.floor(Number(group.count) || 0))],
    ));
    await schoolCatColl.bulkWrite(schoolIds.map((id) => ({
        updateOne: {
            filter: { _id: id },
            update: { $set: { territoryCount: counts.get(schoolCatKey(id)) || 0, updatedAt: now } },
        },
    })), { ordered: false });
}

export async function transferSchoolCat(
    operator: number, fromId: number, toId: number, now = new Date(),
) {
    const admin: any = await getEligibleUser(operator);
    if (!admin || (Number(admin.realname_flag) || 0) < 3) {
        throw new Error('仅行政管理员可以转移大猫记录。');
    }
    if (!Number.isSafeInteger(fromId) || !Number.isSafeInteger(toId)) throw new Error('大猫编号无效。');
    if (fromId === toId) throw new Error('来源和目标不能是同一只大猫。');
    const fromCat: any = await schoolCatColl.findOne({ _id: fromId } as any);
    if (!fromCat) throw new Error('来源大猫记录不存在。');
    const toView: any = await getSchoolView(toId);
    if (!toView) throw new Error('目标大猫不存在。');
    await ensureSchoolCatRecord(toId, now);
    const currentWeight = Math.max(0, Math.floor(Number(fromCat.currentWeight) || 0));
    const historyWeight = Math.max(0, Math.floor(Number(fromCat.historyWeight) || 0));
    const users = await userColl.updateMany({ school_cat: fromId } as any, { $set: { school_cat: toId } });
    const history = await schoolFeedHistoryColl.updateMany(
        { schoolId: fromId } as any, { $set: { schoolId: toId } },
    );
    await schoolCatColl.updateOne(
        { _id: toId } as any,
        { $inc: { currentWeight, historyWeight }, $set: { updatedAt: now } } as any,
    );
    await schoolCatColl.updateOne(
        { _id: fromId } as any,
        { $set: { currentWeight: 0, historyWeight: 0, updatedAt: now } } as any,
    );
    const cells = await catMapCellColl.updateMany(
        { catId: schoolCatKey(fromId) } as any,
        { $set: { catId: schoolCatKey(toId) } },
    );
    await recountSchoolCatTerritoryFor([fromId, toId], now);
    await addLog({
        type: 'school_cat',
        userId: operator,
        sender: operator,
        action: 'school_cat_transfer',
        catId: schoolCatKey(toId),
        reason: `将大猫 #${fromId} 的记录转移到 ${schoolDisplay(toView)}：${users.modifiedCount} 位用户改绑、`
            + `${history.modifiedCount} 条投喂历史、${cells.modifiedCount} 格领地、`
            + `体重 ${currentWeight}g（历史 ${historyWeight}g）`,
    } as any);
    return {
        fromId,
        toId,
        display: schoolDisplay(toView),
        users: users.modifiedCount,
        history: history.modifiedCount,
        cells: cells.modifiedCount,
        currentWeight,
        historyWeight,
    };
}

const uncountedMoveContributionFilter = {
    type: 'cat_account',
    action: { $in: ['cat_map_move', 'cat_map_territory_teleport'] },
    amount: { $lt: 0 },
    schoolCatContributionCounted: { $ne: true },
};

// Legacy movement logs predate per-move big-cat attribution. This operation
// claims them per user, aggregates inside MongoDB, then attributes the exact
// burned food to that user's current binding. Bound/verified users are handled
// without loading individual movement rows into the application process.
export async function backfillSchoolCatMoveContributions(operator: number, now = new Date()) {
    const admin: any = await getEligibleUser(operator);
    if (!admin || (Number(admin.realname_flag) || 0) < 3) {
        throw new Error('仅行政管理员可以回算历史移动贡献。');
    }
    const candidateValues = await logColl.distinct('userId', uncountedMoveContributionFilter as any);
    const candidateUids = candidateValues.filter((uid: any): uid is number => Number.isSafeInteger(uid));
    const eligibleByUid = new Map<number, any>();
    for (let offset = 0; offset < candidateUids.length; offset += 2000) {
        const chunk = candidateUids.slice(offset, offset + 2000);
        const rows: any[] = await userColl.find({
            _id: { $in: chunk },
            realname_flag: { $gte: 1 },
            school_cat: { $exists: true },
        } as any, { projection: { school_cat: 1 } }).toArray();
        rows.forEach((row: any) => {
            if (Number.isSafeInteger(row.school_cat)) eligibleByUid.set(row._id, row);
        });
    }

    let moves = 0;
    let contribution = 0;
    const affectedCatIds = new Set<number>();
    for (const uid of candidateUids) {
        const user = eligibleByUid.get(uid);
        if (!user) continue;
        const schoolId = Number(user.school_cat);
        await ensureSchoolCatRecord(schoolId, now);
        const batchId = new ObjectId();
        const claimed = await logColl.updateMany({
            ...uncountedMoveContributionFilter,
            userId: uid,
            schoolCatContributionBatch: { $exists: false },
        } as any, {
            $set: { schoolCatContributionBatch: batchId, catId: schoolCatKey(schoolId) },
        } as any);
        if (!claimed.modifiedCount) continue;

        const summary: any[] = await logColl.aggregate([
            { $match: { schoolCatContributionBatch: batchId } },
            {
                $group: {
                    _id: null,
                    amount: { $sum: { $multiply: ['$amount', -1] } },
                    moves: { $sum: 1 },
                },
            },
        ]).toArray();
        const amount = Math.max(0, Math.floor(Number(summary[0]?.amount) || 0));
        const moveCount = Math.max(0, Math.floor(Number(summary[0]?.moves) || 0));
        let userApplied = false;
        let catApplied = false;
        try {
            if (!amount || !moveCount) throw new Error('历史移动日志金额无效。');
            const userResult = await userColl.updateOne({
                _id: uid,
                realname_flag: { $gte: 1 },
                school_cat: schoolId,
            }, { $inc: { school_cat_food: amount } });
            if (!userResult.modifiedCount) throw new Error(`UID ${uid} 的大猫绑定刚刚发生变化，请重试。`);
            userApplied = true;
            const catResult = await schoolCatColl.updateOne(
                { _id: schoolId } as any,
                { $inc: { currentWeight: amount }, $set: { updatedAt: now } } as any,
            );
            if (!catResult.modifiedCount) throw new Error(`大猫 #${schoolId} 的历史贡献更新失败。`);
            catApplied = true;
            const marked = await logColl.updateMany(
                { schoolCatContributionBatch: batchId } as any,
                {
                    $set: { schoolCatContributionCounted: true },
                    $unset: { schoolCatContributionBatch: '' },
                } as any,
            );
            if (marked.modifiedCount !== moveCount) throw new Error(`UID ${uid} 的历史移动标记不完整。`);
        } catch (e) {
            if (catApplied) {
                await schoolCatColl.updateOne(
                    { _id: schoolId } as any,
                    { $inc: { currentWeight: -amount }, $set: { updatedAt: now } } as any,
                );
            }
            if (userApplied) await userColl.updateOne({ _id: uid }, { $inc: { school_cat_food: -amount } });
            await logColl.updateMany(
                { schoolCatContributionBatch: batchId } as any,
                { $unset: { schoolCatContributionBatch: '', catId: '', schoolCatContributionCounted: '' } } as any,
            );
            throw e;
        }
        moves += moveCount;
        contribution += amount;
        affectedCatIds.add(schoolId);
    }
    const pendingMoves = await logColl.countDocuments(uncountedMoveContributionFilter as any);
    await addLog({
        type: 'school_cat',
        userId: operator,
        sender: operator,
        action: 'move_contribution_backfill',
        amount: contribution,
        reason: `按用户当前绑定回算 ${moves} 次历史猫粮移动，共 ${contribution}g；仍有 ${pendingMoves} 次因未认证或未绑定而待处理`,
    } as any);
    return {
        moves,
        contribution,
        pendingMoves,
        affectedCatIds: Array.from(affectedCatIds),
    };
}

