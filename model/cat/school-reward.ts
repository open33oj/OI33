import { ObjectId } from 'hydrooj';
import { catCanPoolColl, ensureCatCanPool } from './can';
import { addLog, logColl } from '../log';
import {
    SCHOOL_CAT_ADMIN_CANS_PER_FEEDER, SCHOOL_CAT_REWARD_ALLOCATION_PAGE_SIZE,
    SCHOOL_CAT_REWARD_PAGE_SIZE, isAdminSchoolCatRecord, schoolCatColl,
    schoolCatKey, schoolCatRewardColl, schoolCatRewardPeriod,
    schoolCatTerritoryBaseReward, schoolIdFromCatKey,
} from './school-shared';
import type {
    Oi33SchoolCatRewardAllocation, Oi33SchoolCatRewardSummary,
} from '../types';
import { userColl } from '../user';

const REWARD_PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeSchoolCatRewardPeriod(period: string) {
    const normalized = String(period || '').trim();
    if (!REWARD_PERIOD_RE.test(normalized)) throw new Error('结算周期格式无效。');
    const date = new Date(`${normalized}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized
        || date.getUTCDay() !== 1) {
        throw new Error('结算周期必须是有效的周一日期。');
    }
    return normalized;
}

function schoolCatRewardRevision(plan: any) {
    const revision = Math.floor(Number(plan?.revision) || 1);
    return Math.max(1, revision);
}

function schoolCatRewardRunKey(period: string, revision: number) {
    return `${period}#${revision}`;
}

function rewardTieBreak(period: string, schoolId: number, uid: number) {
    const text = `${period}:${schoolId}:${uid}`;
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

async function buildSchoolCatWeeklyRewardPlan(period: string) {
    const feeders: any[] = await userColl.find({
        realname_flag: { $gte: 1 },
        school_cat: { $exists: true },
        school_cat_food: { $gt: 0 },
    } as any, {
        projection: { _id: 1, school_cat: 1, school_cat_food: 1 },
    }).sort({ school_cat: 1, _id: 1 }).toArray();
    const bySchool = new Map<number, Array<{ uid: number; contribution: number }>>();
    for (const feeder of feeders) {
        const schoolId = Number(feeder.school_cat);
        const contribution = Math.max(0, Math.floor(Number(feeder.school_cat_food) || 0));
        if (!Number.isSafeInteger(schoolId) || !contribution) continue;
        const rows = bySchool.get(schoolId) || [];
        rows.push({ uid: feeder._id, contribution });
        bySchool.set(schoolId, rows);
    }
    const schoolIds = Array.from(bySchool.keys());
    const catRows: any[] = schoolIds.length
        ? await schoolCatColl.find({ _id: { $in: schoolIds } } as any).toArray()
        : [];
    const catBySchool = new Map<number, any>(catRows.map((cat: any) => [cat._id, cat]));
    const cats: Oi33SchoolCatRewardSummary[] = [];
    const allocations: Oi33SchoolCatRewardAllocation[] = [];

    for (const schoolId of schoolIds.sort((a, b) => a - b)) {
        const cat = catBySchool.get(schoolId);
        if (!cat) continue;
        const rows = bySchool.get(schoolId)!;
        const feederCount = rows.length;
        const territoryCount = Math.max(0, Math.floor(Number(cat.territoryCount) || 0));
        const weightGrams = Math.max(0, Math.floor(Number(cat.currentWeight) || 0));
        const isAdminCat = isAdminSchoolCatRecord(cat);
        if (isAdminCat) {
            const plannedCans = feederCount * SCHOOL_CAT_ADMIN_CANS_PER_FEEDER;
            cats.push({
                schoolId, isAdminCat, territoryCount, feederCount, weightGrams,
                baseCans: SCHOOL_CAT_ADMIN_CANS_PER_FEEDER,
                multiplier: feederCount, plannedCans,
            });
            for (const row of rows) {
                allocations.push({
                    ...row, schoolId, isAdminCat,
                    weight: Math.max(0, Math.floor(Math.log2(row.contribution))),
                    amount: SCHOOL_CAT_ADMIN_CANS_PER_FEEDER,
                });
            }
            continue;
        }

        const baseCans = schoolCatTerritoryBaseReward(territoryCount);
        // Pool multiplier scales with the cat's weight: max(0, floor(log2(weight)) - 10).
        // A cat under 2048g (2^11) has multiplier 0 and emits no cans regardless of territory.
        const multiplier = weightGrams > 0 ? Math.max(0, Math.floor(Math.log2(weightGrams)) - 10) : 0;
        const weighted = rows.map((row) => ({
            ...row,
            weight: Math.max(0, Math.floor(Math.log2(row.contribution))),
        }));
        const totalWeight = weighted.reduce((sum, row) => sum + row.weight, 0);
        // floor(log2(1)) is zero. If every feeder has zero weight there is no
        // defined proportional recipient, so this cat emits no cans this week.
        const plannedCans = totalWeight ? baseCans * multiplier : 0;
        cats.push({
            schoolId, isAdminCat, territoryCount, feederCount,
            baseCans, multiplier, plannedCans, weightGrams,
        });
        if (!plannedCans) continue;
        const shares = weighted.map((row) => {
            const numerator = plannedCans * row.weight;
            return {
                ...row,
                amount: Math.floor(numerator / totalWeight),
                remainder: numerator % totalWeight,
                tieBreak: rewardTieBreak(period, schoolId, row.uid),
            };
        });
        let remaining = plannedCans - shares.reduce((sum, row) => sum + row.amount, 0);
        shares.sort((a, b) => b.remainder - a.remainder || a.tieBreak - b.tieBreak || a.uid - b.uid);
        for (let index = 0; index < remaining; index++) shares[index].amount++;
        shares.sort((a, b) => a.uid - b.uid);
        for (const row of shares) {
            if (!row.amount) continue;
            allocations.push({
                uid: row.uid, schoolId, contribution: row.contribution,
                weight: row.weight, amount: row.amount, isAdminCat,
            });
        }
    }
    return {
        cats,
        allocations,
        plannedUsers: allocations.length,
        plannedCans: allocations.reduce((sum, row) => sum + row.amount, 0),
    };
}

async function getOrCreateSchoolCatRewardPlan(period: string, operator: number, now: Date) {
    let existing: any = await schoolCatRewardColl.findOne({ _id: period } as any);
    if (existing) return existing;
    const plan = await buildSchoolCatWeeklyRewardPlan(period);
    const doc = {
        _id: period,
        status: 'planned',
        revision: 1,
        ...plan,
        operator,
        createdAt: now,
    };
    try {
        await schoolCatRewardColl.insertOne(doc as any);
        return doc;
    } catch (e: any) {
        if (e?.code !== 11000) throw e;
        existing = await schoolCatRewardColl.findOne({ _id: period } as any);
        if (!existing) throw e;
        return existing;
    }
}

export async function getSchoolCatWeeklyRewardStatus(now = new Date()) {
    const period = schoolCatRewardPeriod(now);
    const row: any = await schoolCatRewardColl.findOne(
        { _id: period } as any,
        { projection: { allocations: 0, 'history.cats': 0 } },
    );
    return row || { _id: period, status: 'pending', plannedUsers: 0, plannedCans: 0 };
}

export async function listSchoolCatWeeklyRewards(page = 1, pageSize = SCHOOL_CAT_REWARD_PAGE_SIZE) {
    const size = Math.max(1, Math.min(100, Math.floor(pageSize) || SCHOOL_CAT_REWARD_PAGE_SIZE));
    const total = await schoolCatRewardColl.countDocuments({});
    const upcount = Math.max(1, Math.ceil(total / size));
    const current = Math.max(1, Math.min(upcount, Math.floor(page) || 1));
    const rewards: any[] = await schoolCatRewardColl.find({}, {
        projection: { allocations: 0, 'history.cats': 0 },
    }).sort({ _id: -1 }).skip((current - 1) * size).limit(size).toArray();
    return { rewards, page: current, upcount, total };
}

export async function getSchoolCatWeeklyRewardDetail(
    rawPeriod: string,
    allocationPage = 1,
    pageSize = SCHOOL_CAT_REWARD_ALLOCATION_PAGE_SIZE,
) {
    const period = normalizeSchoolCatRewardPeriod(rawPeriod);
    const size = Math.max(1, Math.min(500, Math.floor(pageSize) || SCHOOL_CAT_REWARD_ALLOCATION_PAGE_SIZE));
    const base: any = await schoolCatRewardColl.findOne(
        { _id: period } as any,
        { projection: { allocations: 0, 'history.cats': 0 } },
    );
    if (!base) return null;
    const total = Math.max(0, Math.floor(Number(base.plannedUsers) || 0));
    const upcount = Math.max(1, Math.ceil(total / size));
    const current = Math.max(1, Math.min(upcount, Math.floor(allocationPage) || 1));
    const sliced: any = await schoolCatRewardColl.findOne(
        { _id: period } as any,
        { projection: {
            allocations: { $slice: [(current - 1) * size, size] },
            'history.cats': 0,
        } } as any,
    );
    return {
        ...sliced,
        revision: schoolCatRewardRevision(sliced),
        allocationPage: current,
        allocationPages: upcount,
        allocationTotal: total,
    };
}

function schoolCatRewardHistoryEntry(plan: any) {
    return {
        revision: schoolCatRewardRevision(plan),
        status: String(plan.status || ''),
        plannedUsers: Math.max(0, Number(plan.plannedUsers) || 0),
        plannedCans: Math.max(0, Number(plan.plannedCans) || 0),
        issuedUsers: Math.max(0, Number(plan.issuedUsers) || 0),
        issuedCans: Math.max(0, Number(plan.issuedCans) || 0),
        createdAt: plan.createdAt || new Date(),
        completedAt: plan.completedAt,
        rolledBackAt: plan.rolledBackAt,
        rolledBackBy: plan.rolledBackBy,
        rollbackReason: plan.rollbackReason,
        cats: Array.isArray(plan.cats) ? plan.cats : [],
    };
}

async function rebuildRolledBackSchoolCatRewardPlan(period: string, operator: number, now: Date) {
    const previous: any = await schoolCatRewardColl.findOne({ _id: period } as any);
    if (!previous || previous.status !== 'rolled_back') return previous;
    const revision = schoolCatRewardRevision(previous) + 1;
    const next = await buildSchoolCatWeeklyRewardPlan(period);
    const rebuilt = await schoolCatRewardColl.updateOne(
        { _id: period, status: 'rolled_back' } as any,
        {
            $push: { history: schoolCatRewardHistoryEntry(previous) },
            $set: {
                status: 'planned', revision, ...next,
                operator, createdAt: now,
            },
            $unset: {
                startedAt: '', completedAt: '', failedAt: '', lastError: '',
                issuedUsers: '', issuedCans: '', rolledBackAt: '', rolledBackBy: '',
                rollbackReason: '', lockOwner: '', lockUntil: '', foodDecayed: '',
            },
        } as any,
    );
    if (!rebuilt.modifiedCount) throw new Error('结算批次刚刚发生变化，请刷新后重试。');
    return await schoolCatRewardColl.findOne({ _id: period } as any);
}

async function renewSchoolCatRewardLock(period: string, lockOwner: ObjectId) {
    const renewed = await schoolCatRewardColl.updateOne(
        { _id: period, status: 'processing', lockOwner } as any,
        { $set: { lockUntil: new Date(Date.now() + 30 * 60 * 1000) } } as any,
    );
    if (!renewed.matchedCount) throw new Error('每周奖励结算锁已失效。');
}

// The big cats eat 5% of every user's current feed contribution at weekly
// settlement; cat weights shrink by the same 5% to keep the ledger balanced.
// The batch document is claimed first so a resumed or retried settlement can
// never charge twice — a crash after claiming skips the decay for that batch
// instead of double-charging users. Returns null when already applied.
async function applySchoolCatWeeklyFoodDecay(period: string, now: Date) {
    const claimed = await schoolCatRewardColl.updateOne(
        { _id: period, foodDecayed: { $ne: true } } as any,
        { $set: { foodDecayed: true } } as any,
    );
    if (!claimed.modifiedCount) return null;
    const decayedField = (field: string) => ({
        $subtract: [field, { $floor: { $multiply: [field, 0.05] } }],
    });
    const sumField = (field: string) => ({ $sum: { $floor: { $multiply: [field, 0.05] } } });
    const userStats: any[] = await userColl.aggregate([
        { $match: { school_cat_food: { $gt: 0 } } },
        { $group: { _id: null, grams: sumField('$school_cat_food') } },
    ] as any).toArray();
    const catStats: any[] = await schoolCatColl.aggregate([
        { $match: { currentWeight: { $gt: 0 } } },
        { $group: { _id: null, grams: sumField('$currentWeight') } },
    ] as any).toArray();
    const userResult = await userColl.updateMany(
        { school_cat_food: { $gt: 0 } } as any,
        [{ $set: { school_cat_food: decayedField('$school_cat_food') } }] as any,
    );
    const catResult = await schoolCatColl.updateMany(
        { currentWeight: { $gt: 0 } } as any,
        [{ $set: { currentWeight: decayedField('$currentWeight'), updatedAt: now } }] as any,
    );
    const stats = {
        users: userResult.modifiedCount,
        cats: catResult.modifiedCount,
        userGrams: Math.max(0, Math.floor(Number(userStats[0]?.grams) || 0)),
        catGrams: Math.max(0, Math.floor(Number(catStats[0]?.grams) || 0)),
    };
    await addLog({
        type: 'school_cat', action: 'weekly_food_decay',
        schoolCatRewardPeriod: period,
        amount: stats.userGrams,
        reason: `${period} 每周结算猫粮消耗：${stats.users} 位用户贡献共减少 ${stats.userGrams}g，`
            + `${stats.cats} 只大猫体重共减少 ${stats.catGrams}g（各 5%）`,
        createdAt: now,
    } as any);
    return stats;
}

// Builds one immutable snapshot per Shanghai week and applies it idempotently.
// A database lease serializes manual and scheduled runs. Per-user/pool run
// keys and idempotent log upserts allow an expired lease to resume safely
// after a process interruption. After all rewards are issued the cats eat 5%
// of everyone's current feed contribution (see applySchoolCatWeeklyFoodDecay);
// snapshot weights are computed before that, so the decay never affects the
// current week's allocation.
export async function settleSchoolCatWeeklyRewards(
    operator = 0,
    now = new Date(),
    requestedPeriod = schoolCatRewardPeriod(now),
) {
    const period = normalizeSchoolCatRewardPeriod(requestedPeriod);
    let plan: any = await getOrCreateSchoolCatRewardPlan(period, operator, now);
    if (plan.status === 'rolled_back') {
        // A manual rollback pauses the automatic ten-minute scheduler until an
        // administrator explicitly requests a fresh revision.
        if (!operator) {
            return {
                period, revision: schoolCatRewardRevision(plan), paused: true,
                completed: false, newlyCompleted: false, running: false,
                users: 0, cans: 0, awardedUids: [] as number[],
            };
        }
        plan = await rebuildRolledBackSchoolCatRewardPlan(period, operator, now);
    }
    if (plan.status === 'completed') {
        return {
            period, revision: schoolCatRewardRevision(plan),
            completed: true, newlyCompleted: false, running: false,
            users: Number(plan.issuedUsers) || 0,
            cans: Number(plan.issuedCans) || 0,
            awardedUids: [] as number[],
        };
    }
    if (['rolling_back', 'rollback_failed'].includes(plan.status)) {
        throw new Error('该批次正在回滚或回滚未完成，请先在结算管理页完成回滚。');
    }

    const revision = schoolCatRewardRevision(plan);
    const runKey = schoolCatRewardRunKey(period, revision);

    const lockOwner = new ObjectId();
    const lockUntil = new Date(now.getTime() + 30 * 60 * 1000);
    const locked = await schoolCatRewardColl.updateOne({
        _id: period,
        status: { $in: ['planned', 'failed', 'processing'] },
        $or: [
            { lockUntil: { $exists: false } },
            { lockUntil: { $lte: now } },
        ],
    } as any, {
        $set: { status: 'processing', operator, startedAt: now, lockOwner, lockUntil },
        $unset: { failedAt: '', lastError: '' },
    } as any);
    if (!locked.modifiedCount) {
        plan = await schoolCatRewardColl.findOne({ _id: period } as any);
        return {
            period,
            revision: schoolCatRewardRevision(plan),
            completed: plan?.status === 'completed',
            newlyCompleted: false,
            running: plan?.status !== 'completed',
            users: Number(plan?.issuedUsers) || 0,
            cans: Number(plan?.issuedCans) || 0,
            awardedUids: [] as number[],
        };
    }

    try {
        plan = await schoolCatRewardColl.findOne({ _id: period, lockOwner } as any);
        if (!plan) throw new Error('每周奖励结算锁已失效。');
        // Adopt a partially applied legacy revision without minting twice.
        if (revision === 1) {
            await userColl.updateMany({
                school_cat_reward_period: period,
                school_cat_reward_revision: { $exists: false },
            } as any, {
                $set: { school_cat_reward_revision: 1 },
                $addToSet: { school_cat_reward_keys: runKey },
            } as any);
            await logColl.updateMany({
                type: 'cat_account', action: 'school_cat_weekly_reward',
                schoolCatRewardPeriod: period,
                schoolCatRewardRevision: { $exists: false },
            } as any, { $set: { schoolCatRewardRevision: 1 } } as any);
        }
        const allocations: Oi33SchoolCatRewardAllocation[] = Array.isArray(plan.allocations)
            ? plan.allocations.filter((row: any) => Number.isSafeInteger(row?.uid)
                && Number.isSafeInteger(row?.amount) && row.amount > 0)
            : [];
        for (let offset = 0; offset < allocations.length; offset += 500) {
            const chunk = allocations.slice(offset, offset + 500);
            await userColl.bulkWrite(chunk.map((row) => ({
                updateOne: {
                    filter: {
                        _id: row.uid,
                        realname_flag: { $gte: 1 },
                        school_cat_reward_keys: { $ne: runKey },
                    },
                    update: {
                        $inc: { cat_can: row.amount },
                        $addToSet: { school_cat_reward_keys: runKey },
                        $set: {
                            school_cat_reward_period: period,
                            school_cat_reward_revision: revision,
                            school_cat_reward_amount: row.amount,
                            school_cat_reward_school_id: row.schoolId,
                            school_cat_reward_at: now,
                        },
                    },
                },
            })), { ordered: false });
            await renewSchoolCatRewardLock(period, lockOwner);
        }

        const allocationByUid = new Map(allocations.map((row) => [row.uid, row]));
        const issued: Oi33SchoolCatRewardAllocation[] = [];
        const uids = Array.from(allocationByUid.keys());
        for (let offset = 0; offset < uids.length; offset += 2000) {
            const chunk = uids.slice(offset, offset + 2000);
            const users: any[] = await userColl.find({
                _id: { $in: chunk },
                school_cat_reward_keys: runKey,
            } as any, {
                projection: { _id: 1 },
            }).toArray();
            for (const user of users) {
                const allocation = allocationByUid.get(user._id);
                if (!allocation) continue;
                issued.push(allocation);
            }
            await renewSchoolCatRewardLock(period, lockOwner);
        }
        const issuedCans = issued.reduce((sum, row) => sum + row.amount, 0);
        await ensureCatCanPool(now);
        if (revision === 1) {
            const legacyPool: any = await catCanPoolColl.findOne({
                _id: 'main', schoolCatRewardPeriod: period,
                schoolCatRewardRevision: { $exists: false },
            } as any);
            if (legacyPool) {
                if (Number(legacyPool.schoolCatRewardCans) !== issuedCans) {
                    throw new Error('旧版每周奖励的市场计数器与奖励计划不一致。');
                }
                await catCanPoolColl.updateOne(
                    { _id: 'main', schoolCatRewardPeriod: period, schoolCatRewardRevision: { $exists: false } } as any,
                    {
                        $set: { schoolCatRewardRevision: 1 },
                        $addToSet: { schoolCatRewardKeys: runKey },
                    } as any,
                );
            }
        }
        const poolUpdated = await catCanPoolColl.updateOne(
            { _id: 'main', schoolCatRewardKeys: { $ne: runKey } } as any,
            {
                $inc: { virtualCanSupply: issuedCans, circulatingCans: issuedCans },
                $addToSet: { schoolCatRewardKeys: runKey },
                $set: {
                    schoolCatRewardPeriod: period,
                    schoolCatRewardRevision: revision,
                    schoolCatRewardCans: issuedCans,
                    schoolCatRewardAt: now,
                    updatedAt: now,
                },
            } as any,
        );
        if (!poolUpdated.modifiedCount) {
            const pool: any = await catCanPoolColl.findOne({ _id: 'main' });
            if (!Array.isArray(pool?.schoolCatRewardKeys)
                || !pool.schoolCatRewardKeys.includes(runKey)) {
                throw new Error('每周奖励的市场计数器与奖励计划不一致。');
            }
        }

        for (let offset = 0; offset < issued.length; offset += 500) {
            const chunk = issued.slice(offset, offset + 500);
            await logColl.bulkWrite(chunk.map((row) => ({
                updateOne: {
                    filter: {
                        type: 'cat_account',
                        action: 'school_cat_weekly_reward',
                        schoolCatRewardPeriod: period,
                        schoolCatRewardRevision: revision,
                        userId: row.uid,
                    },
                    update: {
                        $setOnInsert: {
                            _id: new ObjectId(),
                            type: 'cat_account',
                            action: 'school_cat_weekly_reward',
                            schoolCatRewardPeriod: period,
                            schoolCatRewardRevision: revision,
                            userId: row.uid,
                            sender: operator,
                            amount: 0,
                            canAmount: row.amount,
                            catId: schoolCatKey(row.schoolId),
                            reason: `第 ${revision} 版 · ${row.isAdminCat
                                ? `管理员大猫每周奖励：每位当前投喂者 ${SCHOOL_CAT_ADMIN_CANS_PER_FEEDER} 个`
                                : `大猫领地每周奖励：当前贡献 ${row.contribution}g，权重 ${row.weight}`}`,
                            createdAt: now,
                        },
                    },
                    upsert: true,
                },
            })), { ordered: false });
            await renewSchoolCatRewardLock(period, lockOwner);
        }
        await logColl.updateOne({
            type: 'school_cat', action: 'weekly_reward_settle',
            schoolCatRewardPeriod: period, schoolCatRewardRevision: revision,
        } as any, {
            $setOnInsert: {
                _id: new ObjectId(), type: 'school_cat', action: 'weekly_reward_settle',
                schoolCatRewardPeriod: period, schoolCatRewardRevision: revision,
                sender: operator,
                reason: `${period} 第 ${revision} 版结算：${issued.length} 位用户，共 ${issuedCans} 个罐头`,
                createdAt: now,
            },
        } as any, { upsert: true });
        await applySchoolCatWeeklyFoodDecay(period, now);
        await renewSchoolCatRewardLock(period, lockOwner);
        const completedAt = new Date();
        const completed = await schoolCatRewardColl.updateOne(
            { _id: period, lockOwner } as any,
            {
                $set: {
                    status: 'completed',
                    issuedUsers: issued.length,
                    issuedCans,
                    completedAt,
                },
                $unset: { lockOwner: '', lockUntil: '', lastError: '', failedAt: '' },
            } as any,
        );
        if (!completed.modifiedCount) throw new Error('每周奖励已发放，但结算状态写入失败。');
        return {
            period, revision, completed: true, newlyCompleted: true, running: false,
            users: issued.length, cans: issuedCans,
            awardedUids: issued.map((row) => row.uid),
        };
    } catch (e: any) {
        await schoolCatRewardColl.updateOne(
            { _id: period, lockOwner } as any,
            {
                $set: {
                    status: 'failed',
                    failedAt: new Date(),
                    lastError: e?.message || String(e),
                },
                $unset: { lockOwner: '', lockUntil: '' },
            } as any,
        );
        throw e;
    }
}

async function ensureSchoolCatRewardLogRevision(period: string) {
    await logColl.updateMany({
        action: { $in: ['school_cat_weekly_reward', 'school_cat_weekly_reward_rollback'] },
        schoolCatRewardPeriod: period,
        schoolCatRewardRevision: { $exists: false },
    } as any, { $set: { schoolCatRewardRevision: 1 } } as any);
}

async function getIssuedSchoolCatRewardRows(period: string, revision: number) {
    await ensureSchoolCatRewardLogRevision(period);
    const logs: any[] = await logColl.find({
        type: 'cat_account', action: 'school_cat_weekly_reward',
        schoolCatRewardPeriod: period, schoolCatRewardRevision: revision,
        canAmount: { $gt: 0 },
    } as any, {
        projection: { userId: 1, canAmount: 1, catId: 1 },
    }).sort({ userId: 1 }).toArray();
    return logs.map((log: any) => ({
        uid: Number(log.userId),
        amount: Math.max(0, Math.floor(Number(log.canAmount) || 0)),
        schoolId: schoolIdFromCatKey(Number(log.catId)),
    })).filter((row) => Number.isSafeInteger(row.uid) && row.uid > 0 && row.amount > 0);
}

async function schoolCatRewardRollbackReadiness(plan: any) {
    const period = normalizeSchoolCatRewardPeriod(plan._id);
    const revision = schoolCatRewardRevision(plan);
    const runKey = schoolCatRewardRunKey(period, revision);
    const rows = await getIssuedSchoolCatRewardRows(period, revision);
    const expectedUsers = Math.max(0, Math.floor(Number(plan.issuedUsers) || 0));
    const expectedCans = Math.max(0, Math.floor(Number(plan.issuedCans) || 0));
    const issuedCans = rows.reduce((sum, row) => sum + row.amount, 0);
    if (rows.length !== expectedUsers || issuedCans !== expectedCans) {
        throw new Error(`结算日志与批次汇总不一致（日志 ${rows.length} 人/${issuedCans} 个，批次 ${expectedUsers} 人/${expectedCans} 个）。`);
    }
    const users = new Map<number, any>();
    const uids = rows.map((row) => row.uid);
    for (let offset = 0; offset < uids.length; offset += 2000) {
        const chunk: any[] = await userColl.find({ _id: { $in: uids.slice(offset, offset + 2000) } } as any, {
            projection: { cat_can: 1, school_cat_reward_rollback_keys: 1 },
        }).toArray();
        for (const user of chunk) users.set(user._id, user);
    }
    const pending: typeof rows = [];
    const insufficient: Array<{ uid: number; required: number; balance: number | null }> = [];
    let alreadyRolledBack = 0;
    for (const row of rows) {
        const user = users.get(row.uid);
        const rollbackKeys = Array.isArray(user?.school_cat_reward_rollback_keys)
            ? user.school_cat_reward_rollback_keys : [];
        if (rollbackKeys.includes(runKey)) {
            alreadyRolledBack++;
            continue;
        }
        const balance = user ? Math.floor(Number(user.cat_can) || 0) : null;
        if (balance === null || balance < row.amount) {
            insufficient.push({ uid: row.uid, required: row.amount, balance });
        } else pending.push(row);
    }
    return {
        period, revision, runKey, rows, pending, insufficient,
        canRollback: insufficient.length === 0,
        alreadyRolledBack,
        issuedUsers: rows.length,
        issuedCans,
    };
}

export async function getSchoolCatWeeklyRewardRollbackCheck(rawPeriod: string) {
    const period = normalizeSchoolCatRewardPeriod(rawPeriod);
    const plan: any = await schoolCatRewardColl.findOne(
        { _id: period } as any,
        { projection: { allocations: 0 } },
    );
    if (!plan || !['completed', 'rolling_back', 'rollback_failed'].includes(plan.status)) return null;
    return await schoolCatRewardRollbackReadiness(plan);
}

async function renewSchoolCatRewardRollbackLock(period: string, lockOwner: ObjectId) {
    const renewed = await schoolCatRewardColl.updateOne(
        { _id: period, status: 'rolling_back', lockOwner } as any,
        { $set: { lockUntil: new Date(Date.now() + 30 * 60 * 1000) } } as any,
    );
    if (!renewed.matchedCount) throw new Error('每周奖励回滚锁已失效。');
}

// Rolls back only the issued cans. The 5% weekly food decay applied at
// settlement is NOT restored — reward rollback and food consumption are
// independent, and the eaten food stays eaten.
export async function rollbackSchoolCatWeeklyRewards(
    operator: number,
    rawPeriod: string,
    reason: string,
    now = new Date(),
) {
    const period = normalizeSchoolCatRewardPeriod(rawPeriod);
    const normalizedReason = String(reason || '').trim();
    if (!normalizedReason || normalizedReason.length > 100) throw new Error('回滚原因不能为空且不能超过 100 字。');
    let plan: any = await schoolCatRewardColl.findOne({ _id: period } as any);
    if (!plan) throw new Error('该结算批次不存在。');
    if (plan.status === 'rolled_back') {
        return {
            period, revision: schoolCatRewardRevision(plan), newlyRolledBack: false,
            users: Number(plan.issuedUsers) || 0, cans: Number(plan.issuedCans) || 0,
        };
    }
    if (!['completed', 'rolling_back', 'rollback_failed'].includes(plan.status)) {
        throw new Error('只有已完成或回滚失败的结算批次可以回滚。');
    }

    // Give a useful error before claiming the batch. The same check is run
    // again under the lease because users can trade between these two reads.
    const preview = await schoolCatRewardRollbackReadiness(plan);
    if (preview.insufficient.length) {
        const examples = preview.insufficient.slice(0, 5)
            .map((row) => `UID ${row.uid}（需 ${row.required}，现有 ${row.balance ?? '不存在'}）`).join('、');
        throw new Error(`有 ${preview.insufficient.length} 位用户罐头余额不足，暂不能安全回滚：${examples}`);
    }

    const revision = schoolCatRewardRevision(plan);
    const runKey = schoolCatRewardRunKey(period, revision);
    const lockOwner = new ObjectId();
    const locked = await schoolCatRewardColl.updateOne({
        _id: period,
        status: { $in: ['completed', 'rolling_back', 'rollback_failed'] },
        $or: [
            { lockUntil: { $exists: false } },
            { lockUntil: { $lte: now } },
        ],
    } as any, {
        $set: {
            status: 'rolling_back', lockOwner,
            lockUntil: new Date(now.getTime() + 30 * 60 * 1000),
            rollbackStartedAt: now, rolledBackBy: operator, rollbackReason: normalizedReason,
        },
        $unset: { failedAt: '', lastError: '' },
    } as any);
    if (!locked.modifiedCount) throw new Error('该批次正在被另一个进程处理，请稍后刷新。');

    try {
        plan = await schoolCatRewardColl.findOne({ _id: period, lockOwner } as any);
        if (!plan) throw new Error('每周奖励回滚锁已失效。');
        const readiness = await schoolCatRewardRollbackReadiness(plan);
        if (readiness.insufficient.length) {
            const examples = readiness.insufficient.slice(0, 5)
                .map((row) => `UID ${row.uid}（需 ${row.required}，现有 ${row.balance ?? '不存在'}）`).join('、');
            throw new Error(`回滚前余额发生变化：${examples}`);
        }

        for (let offset = 0; offset < readiness.pending.length; offset += 500) {
            const chunk = readiness.pending.slice(offset, offset + 500);
            await userColl.bulkWrite(chunk.map((row) => ({
                updateOne: {
                    filter: {
                        _id: row.uid, cat_can: { $gte: row.amount },
                        school_cat_reward_rollback_keys: { $ne: runKey },
                    },
                    update: {
                        $inc: { cat_can: -row.amount },
                        $addToSet: { school_cat_reward_rollback_keys: runKey },
                    },
                },
            })), { ordered: false });
            await renewSchoolCatRewardRollbackLock(period, lockOwner);
        }

        const rollbackUsers = await userColl.countDocuments({
            _id: { $in: readiness.rows.map((row) => row.uid) },
            school_cat_reward_rollback_keys: runKey,
        } as any);
        if (rollbackUsers !== readiness.rows.length) {
            throw new Error(`仅完成 ${rollbackUsers}/${readiness.rows.length} 位用户的扣回，可能有余额刚刚发生变化。`);
        }

        await ensureCatCanPool(now);
        const poolUpdated = await catCanPoolColl.updateOne({
            _id: 'main', schoolCatRewardRollbackKeys: { $ne: runKey },
            virtualCanSupply: { $gte: readiness.issuedCans },
            circulatingCans: { $gte: readiness.issuedCans },
        } as any, {
            $inc: {
                virtualCanSupply: -readiness.issuedCans,
                circulatingCans: -readiness.issuedCans,
            },
            $addToSet: { schoolCatRewardRollbackKeys: runKey },
            $set: { updatedAt: now },
        } as any);
        if (!poolUpdated.modifiedCount) {
            const pool: any = await catCanPoolColl.findOne({ _id: 'main' });
            if (!Array.isArray(pool?.schoolCatRewardRollbackKeys)
                || !pool.schoolCatRewardRollbackKeys.includes(runKey)) {
                throw new Error('市场罐头计数不足或不一致，无法完成回滚。');
            }
        }

        const revisionFilter: any = revision === 1
            ? { $or: [{ school_cat_reward_revision: 1 }, { school_cat_reward_revision: { $exists: false } }] }
            : { school_cat_reward_revision: revision };
        await userColl.updateMany({
            school_cat_reward_period: period, ...revisionFilter,
        } as any, { $unset: {
            school_cat_reward_period: '', school_cat_reward_revision: '',
            school_cat_reward_amount: '', school_cat_reward_school_id: '', school_cat_reward_at: '',
        } } as any);
        const poolRevisionFilter: any = revision === 1
            ? { $or: [{ schoolCatRewardRevision: 1 }, { schoolCatRewardRevision: { $exists: false } }] }
            : { schoolCatRewardRevision: revision };
        await catCanPoolColl.updateOne({
            _id: 'main', schoolCatRewardPeriod: period, ...poolRevisionFilter,
        } as any, { $unset: {
            schoolCatRewardPeriod: '', schoolCatRewardRevision: '',
            schoolCatRewardCans: '', schoolCatRewardAt: '',
        } } as any);

        for (let offset = 0; offset < readiness.rows.length; offset += 500) {
            const chunk = readiness.rows.slice(offset, offset + 500);
            await logColl.bulkWrite(chunk.map((row) => ({
                updateOne: {
                    filter: {
                        type: 'cat_account', action: 'school_cat_weekly_reward_rollback',
                        schoolCatRewardPeriod: period, schoolCatRewardRevision: revision,
                        userId: row.uid,
                    },
                    update: { $setOnInsert: {
                        _id: new ObjectId(), type: 'cat_account',
                        action: 'school_cat_weekly_reward_rollback',
                        schoolCatRewardPeriod: period, schoolCatRewardRevision: revision,
                        userId: row.uid, sender: operator, amount: 0,
                        canAmount: -row.amount,
                        catId: row.schoolId === null ? 0 : schoolCatKey(row.schoolId),
                        reason: `回滚 ${period} 第 ${revision} 版每周大猫奖励：${normalizedReason}`,
                        createdAt: now,
                    } },
                    upsert: true,
                },
            })), { ordered: false });
            await renewSchoolCatRewardRollbackLock(period, lockOwner);
        }
        await logColl.updateOne({
            type: 'school_cat', action: 'weekly_reward_rollback',
            schoolCatRewardPeriod: period, schoolCatRewardRevision: revision,
        } as any, { $setOnInsert: {
            _id: new ObjectId(), type: 'school_cat', action: 'weekly_reward_rollback',
            schoolCatRewardPeriod: period, schoolCatRewardRevision: revision,
            sender: operator,
            reason: `${period} 第 ${revision} 版回滚：${readiness.rows.length} 位用户，共 ${readiness.issuedCans} 个罐头；${normalizedReason}`,
            createdAt: now,
        } } as any, { upsert: true });

        const rolledBackAt = new Date();
        const completed = await schoolCatRewardColl.updateOne(
            { _id: period, status: 'rolling_back', lockOwner } as any,
            {
                $set: {
                    status: 'rolled_back', rolledBackAt,
                    rolledBackBy: operator, rollbackReason: normalizedReason,
                },
                $unset: { lockOwner: '', lockUntil: '', failedAt: '', lastError: '', rollbackStartedAt: '' },
            } as any,
        );
        if (!completed.modifiedCount) throw new Error('奖励已扣回，但批次状态写入失败。');
        return {
            period, revision, newlyRolledBack: true,
            users: readiness.rows.length, cans: readiness.issuedCans,
        };
    } catch (e: any) {
        await schoolCatRewardColl.updateOne(
            { _id: period, lockOwner } as any,
            {
                $set: { status: 'rollback_failed', failedAt: new Date(), lastError: e?.message || String(e) },
                $unset: { lockOwner: '', lockUntil: '' },
            } as any,
        );
        throw e;
    }
}
