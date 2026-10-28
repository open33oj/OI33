import { randomInt } from 'crypto';
import { db, ObjectId } from 'hydrooj';
import { logColl } from '../log';
import {
    ensureSchoolCatRecord, schoolCatColl, schoolCatKey, schoolIdFromCatKey,
} from './school-shared';
import { userColl } from '../user';
import { getEligibleUser } from './eligibility';
import { CAT_MAP_CORE_MAX, CAT_MAP_CORE_MIN, isCatMapCoreZone } from '../../shared/cat-map';
import {
    CAT_MAP_HEIGHT, CAT_MAP_PLAN_MAX_STEPS_DEFAULT, CAT_MAP_PLAN_MAX_STEPS_LIMIT,
    CAT_MAP_WIDTH, validColor, validCoordinate,
} from './map-plan-rules';

// 地图边界与路径规划规则在 ./map-plan-rules（纯函数，可单测）；尺寸与分区
// 常量在 shared/cat-map.ts（前后端共用）。这里引入供本模块内部使用，并原样
// 再导出以保持公开 API 不变。
export {
    CAT_MAP_HEIGHT, CAT_MAP_PLAN_MAX_STEPS_DEFAULT, CAT_MAP_PLAN_MAX_STEPS_LIMIT,
    CAT_MAP_WIDTH, validColor, validCoordinate,
};
export { CAT_MAP_CORE_MAX, CAT_MAP_CORE_MIN, isCatMapCoreZone };

export const CAT_MAP_MOVE_FOOD_COST = 3;
export const CAT_MAP_TELEPORT_CAN_COST = 3;
export const CAT_MAP_MIN_COOLDOWN_MINUTES = 50;
export const CAT_MAP_BASE_COOLDOWN_MINUTES = 120;
// 路径规划：一步 = 移动到相邻格 + 涂抹该格。步数上限是可配置项
// （oi33_cat_map_config.planMaxSteps），默认值与硬上限见 cat-map-plan-rules。
// 并发冲突（移动锁被其他请求占用等）时最多重试几次，之后按失败停止计划。
export const CAT_MAP_PLAN_RETRY_LIMIT = 3;
export const CAT_MAP_PLAN_RETRY_DELAY_MS = 60 * 1000;
// 单步执行租约：一次推进最多占用多久，超时后允许其他进程接管。
export const CAT_MAP_PLAN_LOCK_MS = 60 * 1000;

export const catMapPlayerColl = db.collection('oi33_cat_map_player');
export const catMapCellColl = db.collection('oi33_cat_map_cell');
export const catMapPlanColl = db.collection('oi33_cat_map_plan');
export const catMapConfigColl = db.collection('oi33_cat_map_config');

export function cellId(x: number, y: number) {
    return `${x}:${y}`;
}

export function cooldownMinutes(cans: number) {
    return Math.ceil(Math.max(
        CAT_MAP_MIN_COOLDOWN_MINUTES,
        CAT_MAP_BASE_COOLDOWN_MINUTES * Math.pow(0.95, Math.sqrt(Math.max(0, Math.floor(cans)))),
    ));
}

export async function ensureCatMapIndexes() {
    // Remove untouched positions created by the previous automatic random-placement behavior.
    await catMapPlayerColl.deleteMany({
        joinedAt: { $exists: false },
        movedAt: { $exists: false },
        availableAt: { $exists: false },
    } as any);
    // Unverified users must not keep invisible positions on the public map.
    const eligibleUsers = await userColl.find({ realname_flag: { $gte: 1 } }).project({ _id: 1 }).toArray();
    await catMapPlayerColl.deleteMany({ _id: { $nin: eligibleUsers.map((user) => user._id) } } as any);
    try {
        await catMapPlayerColl.dropIndex('x_1_y_1');
    } catch (e: any) {
        if (![26, 27].includes(e?.code)) throw e;
    }
    await catMapPlayerColl.updateMany({}, { $unset: { stackable: '' } });
    // Existing artwork is retained in place. Legacy cells had no ownership,
    // so they explicitly belong to big cat 0 until an administrator refreshes
    // ownership from each cell's latest painter.
    await catMapCellColl.updateMany(
        { catId: { $exists: false } },
        { $set: { catId: 0 } },
    );
    await Promise.all([
        catMapPlayerColl.createIndex({ x: 1, y: 1 }),
        catMapPlayerColl.createIndex({ updatedAt: -1 }),
        catMapCellColl.createIndex({ x: 1, y: 1 }, { unique: true }),
        catMapCellColl.createIndex({ updatedAt: -1 }),
        catMapCellColl.createIndex({ catId: 1 }),
        catMapCellColl.createIndex({ updatedBy: 1 }),
        catMapCellColl.createIndex({ catId: 1, updatedBy: 1 }),
        // Due plans are scanned by the 5s scheduler with this index.
        catMapPlanColl.createIndex({ status: 1, nextAt: 1 }),
        catMapPlanColl.createIndex({ updatedAt: -1 }),
    ]);
    // Create the cat map config document (planMaxSteps) if it is missing;
    // $setOnInsert keeps an existing configuration untouched.
    await catMapConfigColl.updateOne(
        { _id: 'main' } as any,
        {
            $setOnInsert: {
                planMaxSteps: CAT_MAP_PLAN_MAX_STEPS_DEFAULT,
                wildcatEnabled: false,
                wildcatX: null,
                wildcatY: null,
                wildcatNextAt: null,
                wildcatVisited: [],
                updatedAt: new Date(),
            },
        } as any,
        { upsert: true },
    );
}

export async function getCatMapSnapshot() {
    const eligible = await userColl.find({ realname_flag: { $gte: 1 } })
        .project({ _id: 1, cat_food: 1, cat_can: 1 }).toArray();
    const uids = eligible.map((user) => user._id);
    const [players, cells] = await Promise.all([
        catMapPlayerColl.find({ _id: { $in: uids } }).toArray(),
        catMapCellColl.find({}, { projection: { x: 1, y: 1, color: 1, catId: 1 } }).toArray(),
    ]);
    const balances = Object.fromEntries(eligible.map((user: any) => [user._id, {
        food: Math.max(0, Number(user.cat_food) || 0),
        cans: Math.max(0, Math.floor(Number(user.cat_can) || 0)),
    }]));
    return { players, cells, balances };
}

export function normalizedCatId(value: unknown) {
    // Both positive school keys and negative special-cat keys are valid
    // ownership ids; only 0 means "no big cat".
    return Number.isSafeInteger(value) && Number(value) !== 0 ? Number(value) : 0;
}

// 00区「领地核心」判定：格子本身已涂色归属某大猫，且上下左右四格全部归属同一大猫。
// 返回核心格所属的大猫 catId，不是核心格时返回 0。
export async function fortressCatIdAt(x: number, y: number) {
    if (!isCatMapCoreZone(x, y)) return 0;
    const ids = [cellId(x, y), cellId(x - 1, y), cellId(x + 1, y), cellId(x, y - 1), cellId(x, y + 1)];
    const rows: any[] = await catMapCellColl.find(
        { _id: { $in: ids } } as any,
        { projection: { catId: 1 } },
    ).toArray();
    if (rows.length < ids.length) return 0;
    const cats = new Map(rows.map((row) => [row._id, normalizedCatId(row.catId)]));
    const center = cats.get(ids[0]) || 0;
    if (!center) return 0;
    return ids.every((id) => cats.get(id) === center) ? center : 0;
}

export function boundCatIdOf(user: any) {
    return Number.isSafeInteger(user?.school_cat) ? schoolCatKey(user.school_cat) : 0;
}

export async function randomEmpirePosition(avoidX: number, avoidY: number) {
    for (let attempt = 0; attempt < 64; attempt++) {
        const x = randomInt(CAT_MAP_WIDTH);
        const y = randomInt(CAT_MAP_HEIGHT);
        if (isCatMapCoreZone(x, y)) continue;
        if (x === avoidX && y === avoidY) continue;
        return { x, y };
    }
    return { x: 0, y: 0 };
}

// 染色后扫描受影响的 5 格（自身 + 四邻），把滞留在新形成的领地核心格上的
// 其他大猫的小猫驱逐出去：绑定了大猫的传送到自己大猫领地的随机格子，
// 未绑定的传送到帝国区随机位置。
export async function displaceFortressIntruders(x: number, y: number, now = new Date()) {
    const candidates = [
        [x, y], [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
    ].filter(([cx, cy]) => validCoordinate(cx, cy) && isCatMapCoreZone(cx, cy));
    const displaced: any[] = [];
    for (const [cx, cy] of candidates) {
        const fortressCatId = await fortressCatIdAt(cx, cy);
        if (!fortressCatId) continue;
        const intruders: any[] = await catMapPlayerColl.find({
            x: cx,
            y: cy,
            movementLock: { $exists: false },
        } as any).toArray();
        for (const intruder of intruders) {
            const occupant: any = await userColl.findOne(
                { _id: intruder._id },
                { projection: { school_cat: 1 } },
            );
            const ownCatId = boundCatIdOf(occupant);
            if (ownCatId === fortressCatId) continue;
            let destination: { x: number; y: number } | null = null;
            if (ownCatId) {
                const samples: any[] = await catMapCellColl.aggregate([
                    { $match: { catId: ownCatId } },
                    { $sample: { size: 1 } },
                ]).toArray();
                if (samples.length) destination = { x: samples[0].x, y: samples[0].y };
            }
            if (!destination) destination = await randomEmpirePosition(cx, cy);
            const moved = await catMapPlayerColl.updateOne(
                { _id: intruder._id, x: cx, y: cy } as any,
                { $set: { x: destination.x, y: destination.y, movedAt: now, updatedAt: now } },
            );
            if (!moved.modifiedCount) continue;
            displaced.push({
                uid: intruder._id,
                fromX: cx,
                fromY: cy,
                x: destination.x,
                y: destination.y,
                availableAt: intruder.availableAt || null,
                freeColorAvailable: !!intruder.freeColorAvailable,
            });
            try {
                await logColl.insertOne({
                    _id: new ObjectId(),
                    createdAt: now,
                    type: 'cat_map',
                    userId: intruder._id,
                    sender: intruder._id,
                    action: 'fortress_displace',
                    fromX: cx,
                    fromY: cy,
                    x: destination.x,
                    y: destination.y,
                    catId: fortressCatId,
                } as any);
            } catch (e) {
                console.error('[oi33] failed to log fortress displacement:', e);
            }
        }
    }
    return displaced;
}

export async function applyTerritoryDeltas(deltas: Map<number, number>, now = new Date()) {
    const entries = Array.from(deltas.entries()).filter(([catId, delta]) => catId !== 0 && delta !== 0);
    if (!entries.length) return;
    for (const [catId] of entries) {
        const schoolId = schoolIdFromCatKey(catId);
        if (schoolId !== null) await ensureSchoolCatRecord(schoolId, now);
    }
    const operations = entries.map(([catId, delta]) => {
        const schoolId = schoolIdFromCatKey(catId)!;
        return {
            updateOne: {
                // Do not guard decrements with territoryCount >= n. Two
                // concurrent transitions on the same cell may apply their
                // counter deltas out of order; unconditional $inc operations
                // are commutative and therefore converge to the exact count.
                filter: { _id: schoolId },
                update: { $inc: { territoryCount: delta }, $max: { updatedAt: now } },
            },
        };
    });
    if (operations.length) await schoolCatColl.bulkWrite(operations, { ordered: false });
}

export async function moveTerritoryCount(previousCatId: number, nextCatId: number, now = new Date()) {
    if (previousCatId === nextCatId) return false;
    const deltas = new Map<number, number>();
    if (previousCatId !== 0) deltas.set(previousCatId, -1);
    if (nextCatId !== 0) deltas.set(nextCatId, (deltas.get(nextCatId) || 0) + 1);
    await applyTerritoryDeltas(deltas, now);
    return true;
}

export async function recountSchoolCatTerritories(now = new Date()) {
    const groups: any[] = await catMapCellColl.aggregate([
        { $match: { catId: { $ne: 0 } } },
        { $group: { _id: '$catId', count: { $sum: 1 } } },
    ], { allowDiskUse: true } as any).toArray();
    const validGroups: Array<{ catId: number; schoolId: number; count: number }> = [];
    for (const group of groups) {
        const catId = normalizedCatId(group._id);
        const schoolId = schoolIdFromCatKey(catId);
        if (schoolId === null) continue;
        try {
            await ensureSchoolCatRecord(schoolId, now);
            validGroups.push({ catId, schoolId, count: Math.max(0, Math.floor(Number(group.count) || 0)) });
        } catch {
            // Ignore corrupt ownership ids; the explicit refresh operation will
            // rewrite them from authoritative user bindings.
        }
    }
    await schoolCatColl.updateMany(
        { territoryCount: { $ne: 0 } },
        { $set: { territoryCount: 0, updatedAt: now } } as any,
    );
    if (validGroups.length) {
        await schoolCatColl.bulkWrite(validGroups.map((group) => ({
            updateOne: {
                filter: { _id: group.schoolId },
                update: { $set: { territoryCount: group.count, updatedAt: now } },
            },
        })), { ordered: false });
    }
    return { catCount: validGroups.length, cellCount: validGroups.reduce((sum, group) => sum + group.count, 0) };
}

export async function refreshCatMapTerritories(operator: number, now = new Date()) {
    const admin: any = await getEligibleUser(operator);
    if (!admin || (Number(admin.realname_flag) || 0) < 3) {
        throw new Error('仅行政管理员可以更新全图的大猫归属。');
    }
    const cellCount = await catMapCellColl.countDocuments({ color: { $exists: true } });
    if (cellCount) {
        // Work per distinct painter, not per cell: only user ids cross the
        // process boundary, while each indexed updateMany stays inside Mongo.
        const painterValues = await catMapCellColl.distinct('updatedBy', {
            color: { $exists: true },
        });
        const painterIds = painterValues.filter((uid: any) => Number.isSafeInteger(uid));
        const bindings = new Map<number, number>();
        for (let offset = 0; offset < painterIds.length; offset += 2000) {
            const chunk = painterIds.slice(offset, offset + 2000);
            const rows: any[] = await userColl.find(
                { _id: { $in: chunk } },
                { projection: { school_cat: 1 } },
            ).toArray();
            rows.forEach((row: any) => bindings.set(
                row._id,
                Number.isSafeInteger(row.school_cat)
                    ? schoolCatKey(row.school_cat)
                    : 0,
            ));
        }
        for (let offset = 0; offset < painterValues.length; offset += 500) {
            const chunk = painterValues.slice(offset, offset + 500);
            await catMapCellColl.bulkWrite(chunk.map((uid: any) => ({
                updateMany: {
                    filter: { updatedBy: uid, color: { $exists: true } },
                    update: { $set: { catId: bindings.get(uid) || 0 } },
                },
            })), { ordered: false });
        }
        await catMapCellColl.updateMany(
            { color: { $exists: true }, updatedBy: { $exists: false } },
            { $set: { catId: 0 } },
        );
    }
    const counts = await recountSchoolCatTerritories(now);
    await logColl.insertOne({
        _id: new ObjectId(),
        createdAt: now,
        type: 'cat_map',
        userId: operator,
        sender: operator,
        action: 'refresh_territories',
        reason: `按每格最后绘图者的当前绑定刷新 ${cellCount} 个格子，${counts.catCount} 只大猫占领 ${counts.cellCount} 格`,
    } as any);
    return { cellCount, catCount: counts.catCount, claimedCellCount: counts.cellCount };
}


// --- 用户占格（个人贡献） ---
// 格子记录 updatedBy = 最后画这格的人；被其他人覆盖时 updatedBy 自然改变，
// 所以“被别人占回去要扣减”是天然成立的，不需要额外的计数器。

export interface CatCellCount {
    uid: number;
    count: number;
}

export async function countUserCatCells(uid: number): Promise<number> {
    if (!Number.isSafeInteger(uid) || uid <= 0) return 0;
    return await catMapCellColl.countDocuments({
        updatedBy: uid,
        color: { $exists: true },
    } as any);
}

export async function computeCatCellCounts(catId?: number, limit = 0): Promise<CatCellCount[]> {
    const match: any = {
        color: { $exists: true },
        updatedBy: { $type: 'number' },
    };
    if (Number.isSafeInteger(catId) && catId !== 0) match.catId = catId;
    const pipeline: any[] = [
        { $match: match },
        { $group: { _id: '$updatedBy', count: { $sum: 1 } } },
        { $match: { _id: { $gt: 0 } } },
        { $sort: { count: -1, _id: 1 } },
    ];
    if (limit > 0) pipeline.push({ $limit: Math.floor(limit) });
    const rows: any[] = await catMapCellColl.aggregate(pipeline, { allowDiskUse: true } as any).toArray();
    return rows.map((row) => ({
        uid: Number(row._id),
        count: Math.max(0, Math.floor(Number(row.count) || 0)),
    }));
}

export async function listUserCatCells(uid: number, limit = 20000) {
    if (!Number.isSafeInteger(uid) || uid <= 0) return [];
    const rows: any[] = await catMapCellColl.find(
        { updatedBy: uid, color: { $exists: true } } as any,
        { projection: { x: 1, y: 1, color: 1, catId: 1 } } as any,
    ).limit(Math.max(1, Math.min(50000, limit))).toArray();
    return rows.map((row) => [Number(row.x), Number(row.y), Number(row.color), Number(row.catId) || 0]);
}

export async function listCatCellRanking(limit = 50, catId?: number) {
    return await computeCatCellCounts(catId, limit);
}

export const getCatMapCooldownMinutes = cooldownMinutes;
