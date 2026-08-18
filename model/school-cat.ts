import { randomInt } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { db, ObjectId } from 'hydrooj';
import { catCanPoolColl, ensureCatCanPool } from './cat-can';
import { addLog, logColl } from './log';
import type {
    Oi33School, Oi33SchoolCatRewardAllocation, Oi33SchoolCatRewardSummary,
} from './types';
import { userColl } from './user';

export const SCHOOL_CAT_FEED_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const SCHOOL_CAT_PAGE_SIZE = 50;
export const SCHOOL_CAT_COLOR_MAX = 0xFFFFFF;
export const SCHOOL_CAT_SIDEBAR_RANKING_SIZE = 32;
export const SCHOOL_CAT_WEEKLY_MIN_TERRITORY = 64;
export const SCHOOL_CAT_WEEKLY_MAX_BASE_CANS = 12;
export const SCHOOL_CAT_WEEKLY_FEEDERS_PER_MULTIPLIER = 3;
export const SCHOOL_CAT_ADMIN_CANS_PER_FEEDER = 5;

const TIME_ZONE = 'Asia/Shanghai';

export const schoolCatColl = db.collection('oi33_school_cat');
export const schoolFeedHistoryColl = db.collection('oi33_school_feed_history');
export const schoolCatRewardColl = db.collection('oi33_school_cat_reward');

// Cell ownership uses 0 as the explicit "no big cat" sentinel. OIerDB has a
// real school #0, so persisted cat ids are encoded as schoolId + 1.
export function schoolCatKey(schoolId: number) {
    return Number.isSafeInteger(schoolId) && schoolId >= 0 ? schoolId + 1 : 0;
}

export function schoolIdFromCatKey(catId: number) {
    return Number.isSafeInteger(catId) && catId > 0 ? catId - 1 : null;
}

export function schoolCatColorCss(color: number) {
    const safe = Math.max(0, Math.min(SCHOOL_CAT_COLOR_MAX, Math.floor(Number(color) || 0)));
    return `#${safe.toString(16).padStart(6, '0')}`;
}

export function schoolDisplay(school: { _id: number; prov: string; abbr: string }) {
    return `${school.abbr}#${school._id}`;
}

export function schoolUrl(schoolId: number) {
    return `https://oier.baoshuo.dev/school/${schoolId}`;
}

function shanghaiMonthKey(now = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}`;
}

export function schoolCatRewardPeriod(now = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
    const localDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
    const daysSinceMonday = (localDate.getUTCDay() + 6) % 7;
    localDate.setUTCDate(localDate.getUTCDate() - daysSinceMonday);
    return localDate.toISOString().slice(0, 10);
}

export function schoolCatTerritoryBaseReward(territoryCount: number) {
    const cells = Math.max(0, Math.floor(Number(territoryCount) || 0));
    if (cells < SCHOOL_CAT_WEEKLY_MIN_TERRITORY) return 0;
    return Math.min(
        SCHOOL_CAT_WEEKLY_MAX_BASE_CANS,
        1 + Math.floor(Math.log2(cells / SCHOOL_CAT_WEEKLY_MIN_TERRITORY)),
    );
}

const schoolDataFile = path.join(__dirname, 'school-cat-data.json');
const schoolData = JSON.parse(readFileSync(schoolDataFile, 'utf-8'));
const schools: Oi33School[] = (schoolData.schools || [])
    .map(([code, prov, abbr]: [number, string, string]) => ({ _id: code, prov, abbr }))
    .sort((a: Oi33School, b: Oi33School) => a._id - b._id);
const schoolById = new Map<number, Oi33School>(schools.map((school) => [school._id, school]));

function validTerritoryColor(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= SCHOOL_CAT_COLOR_MAX;
}

function unusedRandomColor(used: Set<number>) {
    for (let attempt = 0; attempt < 1000; attempt++) {
        const color = randomInt(SCHOOL_CAT_COLOR_MAX + 1);
        if (!used.has(color)) return color;
    }
    for (let color = 0; color <= SCHOOL_CAT_COLOR_MAX; color++) {
        if (!used.has(color)) return color;
    }
    throw new Error('没有可分配的大猫领地颜色。');
}

export async function ensureSchoolCatRecord(schoolId: number, now = new Date()) {
    if (!schoolById.has(schoolId)) throw new Error('该学校不存在。');
    await schoolCatColl.updateOne(
        { _id: schoolId } as any,
        {
            $setOnInsert: {
                currentWeight: 0,
                historyWeight: 0,
                territoryCount: 0,
                isAdminCat: false,
                spawnedAt: now,
                updatedAt: now,
            },
        } as any,
        { upsert: true },
    );
    for (let attempt = 0; attempt < 64; attempt++) {
        const current: any = await schoolCatColl.findOne({ _id: schoolId } as any);
        if (validTerritoryColor(current?.territoryColor)) return current;
        const territoryColor = randomInt(SCHOOL_CAT_COLOR_MAX + 1);
        const colorFilter = current && Object.prototype.hasOwnProperty.call(current, 'territoryColor')
            ? { territoryColor: current.territoryColor }
            : { territoryColor: { $exists: false } };
        try {
            const assigned = await schoolCatColl.updateOne(
                { _id: schoolId, ...colorFilter } as any,
                { $set: { territoryColor, updatedAt: now } } as any,
            );
            if (assigned.modifiedCount) return await schoolCatColl.findOne({ _id: schoolId } as any);
        } catch (e: any) {
            if (e?.code !== 11000) throw e;
        }
    }
    throw new Error('分配大猫领地颜色失败，请重试。');
}

export async function ensureSchoolCatIndexes() {
    const now = new Date();
    // Position fields belonged to the retired sprite-placement implementation.
    await schoolCatColl.updateMany({
        $or: [
            { x: { $exists: true } },
            { y: { $exists: true } },
            { positionAt: { $exists: true } },
        ],
    }, { $unset: { x: '', y: '', positionAt: '' } } as any);
    await schoolCatColl.updateMany(
        { territoryCount: { $exists: false } },
        { $set: { territoryCount: 0 } } as any,
    );
    await schoolCatColl.updateMany(
        { isAdminCat: { $exists: false } },
        { $set: { isAdminCat: false } } as any,
    );

    // Repair missing/duplicate legacy colors before enforcing uniqueness.
    const colorDocs: any[] = await schoolCatColl.find({}).sort({ _id: 1 })
        .project({ territoryColor: 1 }).toArray();
    const used = new Set<number>();
    const needsColor: any[] = [];
    // Reserve every valid first occurrence before assigning replacements.
    // This also works when the unique index already exists: a replacement
    // can never collide with a valid color later in the sorted result set.
    for (const cat of colorDocs) {
        if (validTerritoryColor(cat.territoryColor) && !used.has(cat.territoryColor)) {
            used.add(cat.territoryColor);
        } else needsColor.push(cat);
    }
    const colorOps: any[] = [];
    for (const cat of needsColor) {
        const territoryColor = unusedRandomColor(used);
        used.add(territoryColor);
        colorOps.push({
            updateOne: {
                filter: { _id: cat._id },
                update: { $set: { territoryColor, updatedAt: now } },
            },
        });
    }
    if (colorOps.length) await schoolCatColl.bulkWrite(colorOps, { ordered: false });
    await Promise.all([
        schoolCatColl.createIndex({ currentWeight: -1 }),
        schoolCatColl.createIndex({ territoryCount: -1 }),
        schoolCatColl.createIndex({ isAdminCat: 1, territoryCount: -1, currentWeight: -1 }),
        schoolCatColl.createIndex({ territoryColor: 1 }, { unique: true, sparse: true }),
        schoolFeedHistoryColl.createIndex({ schoolId: 1, uid: 1 }),
        schoolFeedHistoryColl.createIndex({ uid: 1, createdAt: -1 }),
        userColl.createIndex({ school_cat: 1, school_cat_food: -1, _id: 1 }),
        userColl.createIndex({ school_cat_reward_period: 1 }),
        schoolCatRewardColl.createIndex({ createdAt: -1 }),
        schoolCatRewardColl.createIndex({ status: 1, createdAt: -1 }),
    ]);
}

function withDisplay(school: any) {
    return {
        id: school._id,
        display: schoolDisplay(school),
        prov: school.prov,
        url: schoolUrl(school._id),
    };
}

export async function getSchool(schoolId: number) {
    if (!Number.isSafeInteger(schoolId) || schoolId < 0) return null;
    return schoolById.get(schoolId) || null;
}

export async function searchSchools(query: string, limit = 20) {
    const trimmed = (query || '').trim();
    const capped = Math.max(1, Math.min(50, limit));
    if (!trimmed) return schools.slice(0, capped).map(withDisplay);
    if (/^\d+$/.test(trimmed)) {
        const school = schoolById.get(Number(trimmed));
        return school ? [withDisplay(school)] : [];
    }
    const upper = trimmed.toUpperCase();
    let matched: Oi33School[];
    if (upper.includes('#')) {
        // 省份代码#缩写前缀（JX#JJSDYZX、JX#JJ）或 缩写#编号（JJSDYZX#13396）。
        const [rawLeft, ...rest] = upper.split('#');
        const left = rawLeft.trim();
        const right = rest.join('#').trim();
        if (left && right && !/^\d+$/.test(right)) {
            matched = schools.filter((school) => (school.prov === left && school.abbr.startsWith(right))
                || school.abbr.startsWith(left));
        } else if (left && /^\d+$/.test(right)) {
            const school = schoolById.get(Number(right));
            matched = school && school.abbr.startsWith(left) ? [school] : [];
        } else if (left) {
            matched = schools.filter((school) => school.abbr.startsWith(left) || school.prov.startsWith(left));
        } else matched = schools;
    } else {
        // 普通文本：缩写子串（JJSD）或省份代码前缀（JX）。
        matched = schools.filter((school) => school.abbr.includes(upper) || school.prov.startsWith(upper));
    }
    return matched.slice(0, capped).map(withDisplay);
}

export async function listSchools(page = 1, pageSize = SCHOOL_CAT_PAGE_SIZE) {
    const size = Math.max(1, Math.min(200, pageSize));
    const total = schools.length;
    const current = Math.max(1, Math.min(Math.ceil(total / size) || 1, Math.floor(page) || 1));
    const pageRows = schools.slice((current - 1) * size, current * size);
    return {
        schools: pageRows.map(withDisplay),
        page: current,
        upcount: Math.ceil(total / size),
        total,
    };
}

async function getEligibleUser(uid: number) {
    return await userColl.findOne({ _id: uid, realname_flag: { $gte: 1 } });
}

function publicCat(cat: any, school: any) {
    const weight = Math.max(0, Math.floor(Number(cat.currentWeight) || 0));
    const color = Math.max(0, Math.floor(Number(cat.territoryColor) || 0));
    return {
        id: cat._id,
        catId: schoolCatKey(cat._id),
        display: school ? schoolDisplay(school) : `#${cat._id}`,
        url: schoolUrl(cat._id),
        color,
        colorCss: schoolCatColorCss(color),
        weight,
        historyWeight: Math.max(0, Math.floor(Number(cat.historyWeight) || 0)),
        territoryCount: Math.max(0, Math.floor(Number(cat.territoryCount) || 0)),
        isAdminCat: cat.isAdminCat === true,
    };
}

const activeSchoolCatFilter = {
    $or: [
        { currentWeight: { $gt: 0 } },
        { territoryCount: { $gt: 0 } },
    ],
};

export async function getSchoolCatRanking() {
    const cats: any[] = await schoolCatColl.find(activeSchoolCatFilter as any).toArray();
    const visible = cats.map((cat: any) => publicCat(cat, schoolById.get(cat._id)))
        .sort((a: any, b: any) => b.territoryCount - a.territoryCount
            || b.weight - a.weight || a.id - b.id);
    let numericRank = 0;
    return visible.map((cat: any) => ({
        ...cat,
        // Administrative cats stay visible at their territory-sorted position,
        // but do not consume a numeric place in the public ranking.
        rank: cat.isAdminCat ? null : ++numericRank,
    }));
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
        school_cat: { $gte: 0 },
        school_cat_food: { $gt: 0 },
    } as any, {
        projection: { _id: 1, school_cat: 1, school_cat_food: 1 },
    }).sort({ school_cat: 1, _id: 1 }).toArray();
    const bySchool = new Map<number, Array<{ uid: number; contribution: number }>>();
    for (const feeder of feeders) {
        const schoolId = Number(feeder.school_cat);
        const contribution = Math.max(0, Math.floor(Number(feeder.school_cat_food) || 0));
        if (!Number.isSafeInteger(schoolId) || schoolId < 0 || !contribution) continue;
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
        const isAdminCat = cat.isAdminCat === true;
        if (isAdminCat) {
            const plannedCans = feederCount * SCHOOL_CAT_ADMIN_CANS_PER_FEEDER;
            cats.push({
                schoolId, isAdminCat, territoryCount, feederCount,
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
        const multiplier = Math.floor(feederCount / SCHOOL_CAT_WEEKLY_FEEDERS_PER_MULTIPLIER);
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
            baseCans, multiplier, plannedCans,
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
        { projection: { allocations: 0 } },
    );
    return row || { _id: period, status: 'pending', plannedUsers: 0, plannedCans: 0 };
}

async function renewSchoolCatRewardLock(period: string, lockOwner: ObjectId) {
    const renewed = await schoolCatRewardColl.updateOne(
        { _id: period, status: 'processing', lockOwner } as any,
        { $set: { lockUntil: new Date(Date.now() + 30 * 60 * 1000) } } as any,
    );
    if (!renewed.matchedCount) throw new Error('每周奖励结算锁已失效。');
}

// Builds one immutable snapshot per Shanghai week and applies it idempotently.
// A database lease serializes manual and scheduled runs. Per-user period
// markers, the pool period marker and idempotent log upserts allow an expired
// lease to resume safely after a process interruption.
export async function settleSchoolCatWeeklyRewards(operator = 0, now = new Date()) {
    const period = schoolCatRewardPeriod(now);
    let plan: any = await getOrCreateSchoolCatRewardPlan(period, operator, now);
    if (plan.status === 'completed') {
        return {
            period, completed: true, newlyCompleted: false, running: false,
            users: Number(plan.issuedUsers) || 0,
            cans: Number(plan.issuedCans) || 0,
            awardedUids: [] as number[],
        };
    }

    const lockOwner = new ObjectId();
    const lockUntil = new Date(now.getTime() + 30 * 60 * 1000);
    const locked = await schoolCatRewardColl.updateOne({
        _id: period,
        status: { $ne: 'completed' },
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
                        school_cat_reward_period: { $ne: period },
                    },
                    update: {
                        $inc: { cat_can: row.amount },
                        $set: {
                            school_cat_reward_period: period,
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
                school_cat_reward_period: period,
            } as any, {
                projection: {
                    school_cat_reward_amount: 1,
                    school_cat_reward_school_id: 1,
                },
            }).toArray();
            for (const user of users) {
                const allocation = allocationByUid.get(user._id);
                if (!allocation) continue;
                if (Number(user.school_cat_reward_amount) !== allocation.amount
                    || Number(user.school_cat_reward_school_id) !== allocation.schoolId) {
                    throw new Error(`UID ${user._id} 的每周奖励幂等标记与奖励计划不一致。`);
                }
                issued.push(allocation);
            }
            await renewSchoolCatRewardLock(period, lockOwner);
        }
        const issuedCans = issued.reduce((sum, row) => sum + row.amount, 0);
        await ensureCatCanPool(now);
        const poolUpdated = await catCanPoolColl.updateOne(
            { _id: 'main', schoolCatRewardPeriod: { $ne: period } } as any,
            {
                $inc: { virtualCanSupply: issuedCans, circulatingCans: issuedCans },
                $set: {
                    schoolCatRewardPeriod: period,
                    schoolCatRewardCans: issuedCans,
                    schoolCatRewardAt: now,
                    updatedAt: now,
                },
            } as any,
        );
        if (!poolUpdated.modifiedCount) {
            const pool: any = await catCanPoolColl.findOne({ _id: 'main' });
            if (pool?.schoolCatRewardPeriod !== period
                || Number(pool?.schoolCatRewardCans) !== issuedCans) {
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
                        userId: row.uid,
                    },
                    update: {
                        $setOnInsert: {
                            _id: new ObjectId(),
                            type: 'cat_account',
                            action: 'school_cat_weekly_reward',
                            schoolCatRewardPeriod: period,
                            userId: row.uid,
                            sender: operator,
                            amount: 0,
                            canAmount: row.amount,
                            catId: schoolCatKey(row.schoolId),
                            reason: row.isAdminCat
                                ? `管理员大猫每周奖励：每位当前投喂者 ${SCHOOL_CAT_ADMIN_CANS_PER_FEEDER} 个`
                                : `大猫领地每周奖励：当前贡献 ${row.contribution}g，权重 ${row.weight}`,
                            createdAt: now,
                        },
                    },
                    upsert: true,
                },
            })), { ordered: false });
            await renewSchoolCatRewardLock(period, lockOwner);
        }
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
            period, completed: true, newlyCompleted: true, running: false,
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

export async function getBigCatWorldState(viewerUid = 0) {
    const [ranking, viewer]: any[] = await Promise.all([
        getSchoolCatRanking(),
        viewerUid
            ? userColl.findOne({ _id: viewerUid, realname_flag: { $gte: 1 } })
            : Promise.resolve(null),
    ]);
    const boundId = viewer && Number.isSafeInteger(viewer.school_cat) ? viewer.school_cat : null;
    let me: any = null;
    if (viewer) {
        const boundSchool = boundId === null ? null : schoolById.get(boundId);
        const boundCat: any = boundId === null
            ? null
            : ranking.find((cat: any) => cat.id === boundId)
                || await schoolCatColl.findOne({ _id: boundId } as any);
        const boundColor = boundCat?.color ?? boundCat?.territoryColor;
        me = {
            food: Math.max(0, Number(viewer.cat_food) || 0),
            boundId,
            boundCatId: boundId === null ? 0 : schoolCatKey(boundId),
            boundDisplay: boundSchool ? schoolDisplay(boundSchool) : null,
            boundUrl: boundId === null ? null : schoolUrl(boundId),
            boundColor: validTerritoryColor(boundColor) ? boundColor : null,
            contribution: Math.max(0, Math.floor(Number(viewer.school_cat_food) || 0)),
            canChange: (viewer.school_cat_month || '') !== shanghaiMonthKey(),
            nextFeedAt: viewer.school_cat_feed_at
                ? new Date(viewer.school_cat_feed_at).getTime() + SCHOOL_CAT_FEED_COOLDOWN_MS
                : 0,
        };
    }
    return {
        cats: ranking,
        ranking: ranking.slice(0, SCHOOL_CAT_SIDEBAR_RANKING_SIZE).map((cat: any) => ({
            id: cat.id,
            catId: cat.catId,
            display: cat.display,
            url: cat.url,
            color: cat.color,
            weight: cat.weight,
            territoryCount: cat.territoryCount,
            isAdminCat: cat.isAdminCat,
            rank: cat.rank,
        })),
        rankingTotal: ranking.length,
        me,
        serverTime: Date.now(),
    };
}

export async function setSchoolCatAdminCat(
    operator: number, schoolId: number, enabled: boolean, now = new Date(),
) {
    const admin: any = await getEligibleUser(operator);
    if (!admin || (Number(admin.realname_flag) || 0) < 3) {
        throw new Error('仅行政管理员可以设置管理员大猫。');
    }
    const school: any = await getSchool(schoolId);
    if (!school) throw new Error('该学校不存在。');
    const cat: any = await ensureSchoolCatRecord(schoolId, now);
    const previous = cat?.isAdminCat === true;
    if (previous === enabled) return { ...publicCat(cat, school), changed: false };
    const stateFilter = previous
        ? { isAdminCat: true }
        : { $or: [{ isAdminCat: false }, { isAdminCat: { $exists: false } }] };
    const result = await schoolCatColl.updateOne(
        { _id: schoolId, ...stateFilter } as any,
        { $set: { isAdminCat: enabled, updatedAt: now } } as any,
    );
    if (!result.modifiedCount) throw new Error('大猫状态刚刚发生变化，请刷新后重试。');
    await addLog({
        type: 'school_cat',
        userId: operator,
        sender: operator,
        action: enabled ? 'admin_cat_enable' : 'admin_cat_disable',
        catId: schoolCatKey(schoolId),
        reason: `${enabled ? '设为' : '取消'}管理员大猫：${schoolDisplay(school)}`,
    } as any);
    const updated: any = await schoolCatColl.findOne({ _id: schoolId } as any);
    return { ...publicCat(updated, school), changed: true };
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
            school_cat: { $gte: 0 },
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

export async function bindSchoolCat(uid: number, schoolId: number, now = new Date()) {
    if (!Number.isSafeInteger(schoolId) || schoolId < 0) throw new Error('学校编号无效。');
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以选择投喂的大猫。');
    const school: any = await getSchool(schoolId);
    if (!school) throw new Error('该学校不存在。');
    const previousId = Number.isSafeInteger(user.school_cat) ? user.school_cat : null;
    if (previousId === schoolId) throw new Error('你已经绑定了这只大猫。');
    const monthKey = shanghaiMonthKey(now);
    if (previousId !== null && (user.school_cat_month || '') === monthKey) {
        throw new Error('每个月只能修改一次绑定的大猫，请下个月再修改。');
    }
    const targetCat: any = await ensureSchoolCatRecord(schoolId, now);
    const contribution = Math.max(0, Math.floor(Number(user.school_cat_food) || 0));
    if (previousId !== null && contribution > 0) {
        await schoolCatColl.updateOne(
            { _id: previousId } as any,
            {
                $inc: { currentWeight: -contribution, historyWeight: contribution },
                $set: { updatedAt: now },
                $setOnInsert: { spawnedAt: now },
            } as any,
            { upsert: true },
        );
        await schoolFeedHistoryColl.insertOne({
            _id: new ObjectId(),
            uid,
            schoolId: previousId,
            amount: contribution,
            createdAt: now,
        } as any);
    }
    // 绑定回以前投喂过的大猫时，把历史投喂恢复为当前投喂。
    const historyRows = await schoolFeedHistoryColl.find({ schoolId, uid }).toArray();
    const restored = historyRows.reduce((sum, row: any) => sum + Math.max(0, Math.floor(Number(row.amount) || 0)), 0);
    if (restored > 0) {
        await schoolFeedHistoryColl.deleteMany({ schoolId, uid });
        await schoolCatColl.updateOne(
            { _id: schoolId } as any,
            {
                $inc: { currentWeight: restored, historyWeight: -restored },
                $set: { updatedAt: now },
                $setOnInsert: { spawnedAt: now },
            } as any,
            { upsert: true },
        );
    }
    await userColl.updateOne(
        { _id: uid },
        {
            $set: previousId === null
                // 首次绑定不占每月一次的修改额度，只有改绑才记录月份。
                ? { school_cat: schoolId, school_cat_food: restored }
                : { school_cat: schoolId, school_cat_food: restored, school_cat_month: monthKey },
        },
    );
    try {
        await addLog({
            type: 'school_cat',
            userId: uid,
            sender: uid,
            action: previousId === null ? 'bind' : 'rebind',
            reason: previousId === null
                ? `绑定大猫 ${schoolDisplay(school)}${restored ? `，恢复历史投喂 ${restored}g` : ''}`
                : `从 #${previousId} 改绑 ${schoolDisplay(school)}，${contribution}g 转入历史投喂${restored ? `，恢复历史投喂 ${restored}g` : ''}`,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log school cat bind:', e);
    }
    return {
        boundId: schoolId,
        boundCatId: schoolCatKey(schoolId),
        boundDisplay: schoolDisplay(school),
        boundUrl: schoolUrl(schoolId),
        boundColor: targetCat.territoryColor,
        movedToHistory: previousId === null ? 0 : contribution,
        restoredFromHistory: restored,
        canChange: previousId === null,
    };
}

export async function removeSchoolCatBinding(uid: number, now = new Date()) {
    const user: any = await userColl.findOne({ _id: uid });
    const schoolId = Number.isSafeInteger(user?.school_cat) ? user.school_cat : null;
    if (schoolId === null) return;
    const contribution = Math.max(0, Math.floor(Number(user.school_cat_food) || 0));
    if (contribution > 0) {
        await schoolCatColl.updateOne(
            { _id: schoolId } as any,
            {
                $inc: { currentWeight: -contribution, historyWeight: contribution },
                $set: { updatedAt: now },
            } as any,
        );
        await schoolFeedHistoryColl.insertOne({
            _id: new ObjectId(),
            uid,
            schoolId,
            amount: contribution,
            createdAt: now,
        } as any);
    }
    await userColl.updateOne({ _id: uid }, { $unset: { school_cat: '', school_cat_food: '' } });
}

export async function feedSchoolCat(uid: number, amount: number, now = new Date()) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('投喂量必须是正整数。');
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以投喂大猫。');
    const schoolId = Number.isSafeInteger(user.school_cat) ? user.school_cat : null;
    if (schoolId === null) throw new Error('请先绑定一只大猫再投喂。');
    const school: any = await getSchool(schoolId);
    if (!school) throw new Error('绑定的学校不存在，请重新绑定。');
    await ensureSchoolCatRecord(schoolId, now);
    const display = schoolDisplay(school);
    const nextFeedAt = user.school_cat_feed_at
        ? new Date(user.school_cat_feed_at).getTime() + SCHOOL_CAT_FEED_COOLDOWN_MS
        : 0;
    if (nextFeedAt > now.getTime()) {
        throw new Error(`投喂冷却中，请在 ${new Date(nextFeedAt).toLocaleString('zh-CN', { timeZone: TIME_ZONE })} 后再投喂。`);
    }

    const deducted = await userColl.updateOne(
        {
            _id: uid,
            realname_flag: { $gte: 1 },
            cat_food: { $gte: amount },
            $or: [
                { school_cat_feed_at: { $exists: false } },
                { school_cat_feed_at: { $lte: new Date(now.getTime() - SCHOOL_CAT_FEED_COOLDOWN_MS) } },
            ],
        },
        { $inc: { cat_food: -amount, school_cat_food: amount }, $set: { school_cat_feed_at: now } },
    );
    if (!deducted.modifiedCount) throw new Error(`猫粮不足，本次投喂需要 ${amount}g 猫粮（或投喂仍在冷却中）。`);

    let poolUpdated = false;
    let catUpdated = false;
    try {
        const poolResult = await catCanPoolColl.updateOne(
            { _id: 'main' } as any,
            { $inc: { userFoodTotal: -amount }, $set: { updatedAt: now } } as any,
        );
        poolUpdated = !!poolResult.modifiedCount;
        const catResult = await schoolCatColl.updateOne(
            { _id: schoolId } as any,
            {
                $inc: { currentWeight: amount },
                $set: { updatedAt: now },
                $setOnInsert: { historyWeight: 0, spawnedAt: now },
            } as any,
            { upsert: true },
        );
        catUpdated = !!catResult.modifiedCount || !!catResult.upsertedCount;
        await addLog({
            type: 'cat_account',
            userId: uid,
            sender: uid,
            action: 'school_feed',
            amount: -amount,
            reason: `投喂大猫 ${display}`,
        } as any);
    } catch (e) {
        const rollbackFeedAt: any = user.school_cat_feed_at
            ? { $set: { school_cat_feed_at: user.school_cat_feed_at } }
            : { $unset: { school_cat_feed_at: '' } };
        const rollback = [
            userColl.updateOne({ _id: uid }, {
                $inc: { cat_food: amount, school_cat_food: -amount },
                ...rollbackFeedAt,
            }),
        ];
        if (poolUpdated) rollback.push(catCanPoolColl.updateOne({ _id: 'main' } as any, { $inc: { userFoodTotal: amount } } as any) as any);
        if (catUpdated) rollback.push(schoolCatColl.updateOne({ _id: schoolId } as any, { $inc: { currentWeight: -amount } } as any) as any);
        await Promise.all(rollback);
        throw e;
    }
    const [updatedUser, updatedCat]: any[] = await Promise.all([
        userColl.findOne({ _id: uid }),
        schoolCatColl.findOne({ _id: schoolId } as any),
    ]);
    const weight = Math.max(0, Math.floor(Number(updatedCat?.currentWeight) || 0));
    return {
        schoolId,
        display,
        url: schoolUrl(schoolId),
        weight,
        historyWeight: Math.max(0, Math.floor(Number(updatedCat?.historyWeight) || 0)),
        territoryCount: Math.max(0, Math.floor(Number(updatedCat?.territoryCount) || 0)),
        color: Math.max(0, Math.floor(Number(updatedCat?.territoryColor) || 0)),
        isAdminCat: updatedCat?.isAdminCat === true,
        contribution: Math.max(0, Math.floor(Number(updatedUser?.school_cat_food) || 0)),
        balance: Math.max(0, Number(updatedUser?.cat_food) || 0),
        nextFeedAt: now.getTime() + SCHOOL_CAT_FEED_COOLDOWN_MS,
    };
}

async function getTopFeeder(schoolId: number) {
    const rows = await userColl.find(
        { school_cat: schoolId, school_cat_food: { $gt: 0 } },
    ).sort({ school_cat_food: -1, _id: 1 }).limit(1)
        .project({ _id: 1, school_cat_food: 1 }).toArray();
    return rows[0] || null;
}

export async function setSchoolCatTerritoryColor(
    uid: number, schoolId: number, territoryColor: number, now = new Date(),
) {
    if (!validTerritoryColor(territoryColor)) throw new Error('领地颜色必须是有效的 #RRGGBB 颜色。');
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以修改大猫领地颜色。');
    if (!Number.isSafeInteger(user.school_cat) || user.school_cat !== schoolId) {
        throw new Error('只能修改自己当前绑定的大猫颜色。');
    }
    const school: any = await getSchool(schoolId);
    if (!school) throw new Error('该学校不存在。');
    const cat: any = await ensureSchoolCatRecord(schoolId, now);
    const top = await getTopFeeder(schoolId);
    if (!top || top._id !== uid) throw new Error('只有当前贡献最多的用户可以修改这只大猫的领地颜色。');
    if (cat.territoryColor === territoryColor) return {
        schoolId, catId: schoolCatKey(schoolId), color: territoryColor,
    };
    try {
        await schoolCatColl.updateOne(
            { _id: schoolId } as any,
            { $set: { territoryColor, updatedAt: now } } as any,
        );
    } catch (e: any) {
        if (e?.code === 11000) throw new Error('这个颜色已被其他大猫使用，请换一个颜色。');
        throw e;
    }
    try {
        await addLog({
            type: 'school_cat',
            userId: uid,
            sender: uid,
            action: 'territory_color',
            color: territoryColor,
            reason: `将 ${schoolDisplay(school)} 的领地颜色改为 ${schoolCatColorCss(territoryColor)}`,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log school cat territory color:', e);
    }
    return {
        schoolId,
        catId: schoolCatKey(schoolId),
        color: territoryColor,
    };
}

export async function getSchoolCatDetail(schoolId: number, viewerUid = 0) {
    const school: any = await getSchool(schoolId);
    if (!school) throw new Error('该学校不存在。');
    const cat: any = await schoolCatColl.findOne({ _id: schoolId } as any);
    const weight = Math.max(0, Math.floor(Number(cat?.currentWeight) || 0));
    const historyWeight = Math.max(0, Math.floor(Number(cat?.historyWeight) || 0));
    const currentRows = await userColl.find(
        { school_cat: schoolId, school_cat_food: { $gt: 0 } },
    ).sort({ school_cat_food: -1, _id: 1 }).limit(50)
        .project({ _id: 1, school_cat_food: 1 }).toArray();
    const historyRows = await schoolFeedHistoryColl.aggregate([
        { $match: { schoolId } },
        { $group: { _id: '$uid', amount: { $sum: '$amount' } } },
        { $sort: { amount: -1, _id: 1 } },
        { $limit: 50 },
    ]).toArray();
    let mine: any = null;
    if (viewerUid) {
        const viewer: any = await userColl.findOne({ _id: viewerUid });
        const historyMine = await schoolFeedHistoryColl.aggregate([
            { $match: { schoolId, uid: viewerUid } },
            { $group: { _id: null, amount: { $sum: '$amount' } } },
        ]).toArray();
        mine = {
            bound: Number.isSafeInteger(viewer?.school_cat) && viewer.school_cat === schoolId,
            current: viewer?.school_cat === schoolId ? Math.max(0, Math.floor(Number(viewer.school_cat_food) || 0)) : 0,
            history: Math.max(0, Math.floor(Number(historyMine[0]?.amount) || 0)),
        };
    }
    return {
        school: withDisplay(school),
        weight,
        historyWeight,
        catId: schoolCatKey(schoolId),
        color: validTerritoryColor(cat?.territoryColor) ? cat.territoryColor : null,
        territoryCount: Math.max(0, Math.floor(Number(cat?.territoryCount) || 0)),
        isAdminCat: cat?.isAdminCat === true,
        canSetColor: !!viewerUid
            && currentRows.length > 0
            && currentRows[0]._id === viewerUid,
        current: currentRows.map((row: any) => ({ uid: row._id, amount: Math.max(0, Math.floor(Number(row.school_cat_food) || 0)) })),
        history: historyRows.map((row: any) => ({ uid: row._id, amount: Math.max(0, Math.floor(Number(row.amount) || 0)) })),
        mine,
    };
}
