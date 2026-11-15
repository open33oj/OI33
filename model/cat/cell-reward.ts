// 占格月奖励：按每个用户当前占领的格子数发罐头。
//
// 100 格 = 1 罐，200 格 = 2 罐，400 格 = 3 罐……（见 cell-reward-rules.ts）。
// 与旧的大猫周奖励完全独立：不按大猫分组、不按投喂比例、不扣 5% 猫粮；
// 无主领地也算个人占格。按自然月结算，默认结算上一个月，幂等。

import { ObjectId } from 'hydrooj';
import { db } from 'hydrooj';
import { addLog, logColl } from '../log';
import type { Oi33CatCellRewardAllocation } from '../types';
import { userColl } from '../user';
import { catCanPoolColl, ensureCatCanPool } from './can';
import { computeCatCellCounts } from './map';
import {
    catCellRewardCans, cellRewardMonthKey, previousCellRewardMonth,
} from './cell-reward-rules';

export * from './cell-reward-rules';

export const catCellRewardColl = db.collection('oi33_cat_cell_reward');

const PERIOD_RE = /^\d{4}-\d{2}$/;
const LOCK_MS = 30 * 60 * 1000;

async function renewCatCellRewardLock(period: string, lockOwner: ObjectId) {
    const renewed = await catCellRewardColl.updateOne(
        { _id: period, status: 'processing', lockOwner } as any,
        { $set: { lockUntil: new Date(Date.now() + LOCK_MS) } } as any,
    );
    if (!renewed.matchedCount) throw new Error('占格月奖励结算锁已失效。');
}

function normalizePeriod(period: string) {
    const value = String(period || '').trim();
    if (!PERIOD_RE.test(value)) throw new Error('结算月份格式无效。');
    const [year, month] = value.split('-').map(Number);
    if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month)
        || year < 2020 || year > 2100 || month < 1 || month > 12) {
        throw new Error('结算月份无效。');
    }
    return value;
}

// 首次部署的月份；只结算这个月及以后的上一月，避免上线时把上个月按
// “当前格子数”追溯发一遍。
async function ensureStartMonth(now: Date) {
    const current = cellRewardMonthKey(now);
    const doc: any = await catCellRewardColl.findOneAndUpdate(
        { _id: 'config' } as any,
        { $setOnInsert: { startMonth: current, createdAt: now } },
        { upsert: true, returnDocument: 'after' },
    );
    return String(doc?.startMonth || current);
}

export async function getCatCellRewardStatus(now = new Date()) {
    const period = previousCellRewardMonth(now);
    const startMonth = await ensureStartMonth(now);
    if (period < startMonth) {
        return {
            _id: period, status: 'waiting', startMonth,
            users: 0, cans: 0, cells: 0,
        };
    }
    const doc: any = await catCellRewardColl.findOne({ _id: period } as any);
    return doc || {
        _id: period, status: 'pending', startMonth, users: 0, cans: 0, cells: 0,
    };
}

export async function listCatCellRewards(limit = 12) {
    return await catCellRewardColl.find({ _id: { $regex: /^\d{4}-\d{2}$/ } } as any)
        .sort({ _id: -1 })
        .limit(Math.max(1, Math.min(52, limit)))
        .project({ allocations: 0 } as any)
        .toArray();
}

export async function settleCatCellMonthlyRewards(
    operator = 0,
    now = new Date(),
    requestedPeriod?: string,
) {
    const period = normalizePeriod(requestedPeriod || previousCellRewardMonth(now));
    const startMonth = await ensureStartMonth(now);
    if (period < startMonth) {
        return {
            period, completed: false, newlyCompleted: false, running: false,
            skipped: true, startMonth, users: 0, cans: 0, cells: 0,
        };
    }
    const existing: any = await catCellRewardColl.findOne({ _id: period } as any);
    if (existing?.status === 'completed') {
        return {
            period, completed: true, newlyCompleted: false, running: false,
            users: Number(existing.users) || 0,
            cans: Number(existing.cans) || 0,
            cells: Number(existing.cells) || 0,
        };
    }
    const lockOwner = new ObjectId();
    const lockUntil = new Date(now.getTime() + LOCK_MS);
    let plan: any;
    try {
        plan = await catCellRewardColl.findOneAndUpdate(
            {
                _id: period,
                $or: [
                    { status: { $exists: false } },
                    { status: { $in: ['pending', 'failed'] } },
                    // 进程中断留下的过期租约允许接管，否则会永远卡在 processing。
                    { status: 'processing', lockUntil: { $lt: now } },
                ],
            } as any,
            {
                $set: {
                    status: 'processing', operator, startedAt: now, lockOwner, lockUntil,
                },
                $setOnInsert: { _id: period, createdAt: now },
                $unset: { lastError: '', failedAt: '' },
            } as any,
            { upsert: true, returnDocument: 'after' },
        );
    } catch (e: any) {
        if (e?.code !== 11000) throw e;
        plan = await catCellRewardColl.findOne({ _id: period } as any);
    }
    if (!plan) throw new Error('占格奖励结算状态异常，请重试。');
    if (plan.status === 'completed') {
        return {
            period, completed: true, newlyCompleted: false, running: false,
            users: Number(plan.users) || 0,
            cans: Number(plan.cans) || 0,
            cells: Number(plan.cells) || 0,
        };
    }
    if (plan.lockOwner && String(plan.lockOwner) !== String(lockOwner)) {
        return {
            period, completed: false, newlyCompleted: false, running: true,
            users: 0, cans: 0, cells: 0,
        };
    }

    try {
        let allocations: Oi33CatCellRewardAllocation[];
        if (Array.isArray(plan.allocations) && plan.allocationsAt) {
            // A previous attempt persisted the snapshot; reuse it so a retry
            // cannot re-snapshot the (possibly changed) current map and pay the
            // remaining users a different amount.
            allocations = plan.allocations
                .filter((row: any) => Number.isSafeInteger(row?.uid)
                    && Number.isSafeInteger(row?.cells) && row.cells > 0
                    && Number.isSafeInteger(row?.cans) && row.cans > 0)
                .map((row: any) => ({ uid: row.uid, cells: row.cells, cans: row.cans }));
        } else {
            const rows = await computeCatCellCounts();
            const uids = rows.map((row) => row.uid);
            const verified = new Set<number>();
            for (let offset = 0; offset < uids.length; offset += 2000) {
                const users: any[] = await userColl.find({
                    _id: { $in: uids.slice(offset, offset + 2000) },
                    realname_flag: { $gte: 1 },
                } as any, { projection: { _id: 1 } }).toArray();
                for (const user of users) verified.add(user._id);
            }
            allocations = rows
                .filter((row) => verified.has(row.uid))
                .map((row) => ({ uid: row.uid, cells: row.count, cans: catCellRewardCans(row.count) }))
                .filter((row) => row.cans > 0);
            const snapshotCans = allocations.reduce((sum, row) => sum + row.cans, 0);
            const snapshotCells = allocations.reduce((sum, row) => sum + row.cells, 0);
            // Persist the allocation snapshot before the first credit. A crash
            // or expired lease must resume from this snapshot, not from a map
            // that may have changed since the period actually ended.
            const snapshot = await catCellRewardColl.updateOne(
                { _id: period, lockOwner, status: 'processing' } as any,
                {
                    $set: {
                        allocations,
                        allocationsAt: now,
                        plannedUsers: allocations.length,
                        plannedCans: snapshotCans,
                        plannedCells: snapshotCells,
                    },
                } as any,
            );
            if (!snapshot.modifiedCount) throw new Error('占格月奖励结算锁已失效。');
        }
        const plannedUsers = allocations.length;
        const plannedCans = allocations.reduce((sum, row) => sum + row.cans, 0);
        const plannedCells = allocations.reduce((sum, row) => sum + row.cells, 0);

        for (let offset = 0; offset < allocations.length; offset += 500) {
            const chunk = allocations.slice(offset, offset + 500);
            await userColl.bulkWrite(chunk.map((row) => ({
                updateOne: {
                    filter: {
                        _id: row.uid,
                        realname_flag: { $gte: 1 },
                        cell_reward_keys: { $ne: period },
                    },
                    update: {
                        $inc: { cat_can: row.cans },
                        $addToSet: { cell_reward_keys: period },
                        $set: {
                            cell_reward_period: period,
                            cell_reward_at: now,
                            cell_reward_cells: row.cells,
                            cell_reward_cans: row.cans,
                        },
                    },
                },
            })) as any, { ordered: false });
            await renewCatCellRewardLock(period, lockOwner);
        }

        // Count only users that actually hold this period's key. The pool
        // counters and the ledger must describe the same set of credited users,
        // even if a user disappeared or the lease was taken over mid-run.
        const allocationByUid = new Map(allocations.map((row) => [row.uid, row]));
        const issued: Oi33CatCellRewardAllocation[] = [];
        const allocationUids = Array.from(allocationByUid.keys());
        for (let offset = 0; offset < allocationUids.length; offset += 2000) {
            const chunk = allocationUids.slice(offset, offset + 2000);
            const users: any[] = await userColl.find({
                _id: { $in: chunk },
                cell_reward_keys: period,
            } as any, { projection: { _id: 1 } }).toArray();
            for (const user of users) {
                const allocation = allocationByUid.get(user._id);
                if (allocation) issued.push(allocation);
            }
            await renewCatCellRewardLock(period, lockOwner);
        }
        const issuedCans = issued.reduce((sum, row) => sum + row.cans, 0);
        const issuedCells = issued.reduce((sum, row) => sum + row.cells, 0);

        // Minting cans without growing the pool's supply is exactly the
        // accounting hole this settlement used to have: the users' balances
        // grew while virtualCanSupply/circulatingCans did not. The period key
        // makes the pool side idempotent across retries.
        await ensureCatCanPool(now);
        const poolUpdated = await catCanPoolColl.updateOne(
            { _id: 'main', cellRewardKeys: { $ne: period } } as any,
            {
                $inc: { virtualCanSupply: issuedCans, circulatingCans: issuedCans },
                $addToSet: { cellRewardKeys: period },
                $set: {
                    cellRewardPeriod: period,
                    cellRewardCans: issuedCans,
                    cellRewardAt: now,
                    updatedAt: now,
                },
            } as any,
        );
        if (!poolUpdated.modifiedCount) {
            const pool: any = await catCanPoolColl.findOne({ _id: 'main' });
            if (!Array.isArray(pool?.cellRewardKeys) || !pool.cellRewardKeys.includes(period)) {
                throw new Error('占格月奖励的市场计数器与结算计划不一致。');
            }
        }

        for (let offset = 0; offset < issued.length; offset += 500) {
            const chunk = issued.slice(offset, offset + 500);
            await logColl.bulkWrite(chunk.map((row) => ({
                updateOne: {
                    filter: {
                        type: 'cat_account', action: 'cat_cell_monthly_reward',
                        cellRewardMonth: period, userId: row.uid,
                    },
                    update: {
                        $setOnInsert: {
                            _id: new ObjectId(),
                            type: 'cat_account',
                            action: 'cat_cell_monthly_reward',
                            cellRewardMonth: period,
                            userId: row.uid,
                            sender: operator,
                            canAmount: row.cans,
                            cellCount: row.cells,
                            reason: `占格月奖励：${row.cells} 格 → ${row.cans} 个罐头`,
                            createdAt: now,
                        },
                    },
                    upsert: true,
                },
            })), { ordered: false });
            await renewCatCellRewardLock(period, lockOwner);
        }

        const completed = await catCellRewardColl.updateOne(
            { _id: period, lockOwner } as any,
            {
                $set: {
                    status: 'completed',
                    users: issued.length,
                    cans: issuedCans,
                    cells: issuedCells,
                    issuedUsers: issued.length,
                    issuedCans,
                    completedAt: new Date(),
                },
                $unset: { lockOwner: '', lockUntil: '' },
            } as any,
        );
        if (!completed.modifiedCount) throw new Error('占格月奖励已发放，但结算状态写入失败。');
        await addLog({
            type: 'admin',
            userId: operator,
            sender: operator,
            action: 'cat_cell_reward_settle',
            cellRewardMonth: period,
            amount: issuedCans,
            reason: `${period} 占格月奖励：${issued.length}/${plannedUsers} 位用户、${issuedCells} 格，`
                + `共 ${issuedCans} 个罐头（计划 ${plannedCans} 个 / ${plannedCells} 格）`,
        } as any);
        return {
            period, completed: true, newlyCompleted: true, running: false,
            users: issued.length, cans: issuedCans, cells: issuedCells,
        };
    } catch (e: any) {
        await catCellRewardColl.updateOne({ _id: period, lockOwner } as any, {
            $set: { status: 'failed', failedAt: new Date(), lastError: e?.message || String(e) },
            $unset: { lockOwner: '', lockUntil: '' },
        } as any);
        throw e;
    }
}
