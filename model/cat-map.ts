import { randomInt } from 'crypto';
import { db, MessageModel, ObjectId } from 'hydrooj';
import { catCanPoolColl } from './cat-can';
import { logColl } from './log';
import {
    ensureSchoolCatRecord, schoolCatColl, schoolCatKey, schoolIdFromCatKey,
} from './school-cat';
import { userColl } from './user';

export const CAT_MAP_WIDTH = 1000;
export const CAT_MAP_HEIGHT = 1000;
export const CAT_MAP_MOVE_FOOD_COST = 3;
export const CAT_MAP_TELEPORT_CAN_COST = 3;
export const CAT_MAP_MIN_COOLDOWN_MINUTES = 50;
export const CAT_MAP_BASE_COOLDOWN_MINUTES = 120;
// 地图分两个区域：帝国区是距离边框 250 格内的环形区域（前/后 250 行、左/右 250 列），
// 其余中央 500×500 为 00区。00区内上下左右均归属同一大猫的格子是「领地核心」，
// 禁止其他大猫的小猫进入。
export const CAT_MAP_CORE_MIN = 250;
export const CAT_MAP_CORE_MAX = 749;
// 路径规划：一步 = 移动到相邻格 + 涂抹该格。步数上限是可配置项
// （oi33_cat_map_config.planMaxSteps），这里给出默认值与硬上限。
export const CAT_MAP_PLAN_MAX_STEPS_DEFAULT = 10;
export const CAT_MAP_PLAN_MAX_STEPS_LIMIT = 50;
// 并发冲突（移动锁被其他请求占用等）时最多重试几次，之后按失败停止计划。
export const CAT_MAP_PLAN_RETRY_LIMIT = 3;
export const CAT_MAP_PLAN_RETRY_DELAY_MS = 60 * 1000;
// 单步执行租约：一次推进最多占用多久，超时后允许其他进程接管。
export const CAT_MAP_PLAN_LOCK_MS = 60 * 1000;

export function isCatMapCoreZone(x: number, y: number) {
    return x >= CAT_MAP_CORE_MIN && x <= CAT_MAP_CORE_MAX
        && y >= CAT_MAP_CORE_MIN && y <= CAT_MAP_CORE_MAX;
}

export const catMapPlayerColl = db.collection('oi33_cat_map_player');
export const catMapCellColl = db.collection('oi33_cat_map_cell');
export const catMapPlanColl = db.collection('oi33_cat_map_plan');
export const catMapConfigColl = db.collection('oi33_cat_map_config');

function cellId(x: number, y: number) {
    return `${x}:${y}`;
}

function validCoordinate(x: number, y: number) {
    return Number.isSafeInteger(x) && Number.isSafeInteger(y)
        && x >= 0 && x < CAT_MAP_WIDTH && y >= 0 && y < CAT_MAP_HEIGHT;
}

function validColor(color: number) {
    return Number.isSafeInteger(color) && color >= 0 && color <= 255;
}

function cooldownMinutes(cans: number) {
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
        // Due plans are scanned by the 30s scheduler with this index.
        catMapPlanColl.createIndex({ status: 1, nextAt: 1 }),
        catMapPlanColl.createIndex({ updatedAt: -1 }),
    ]);
    // Create the cat map config document (planMaxSteps) if it is missing;
    // $setOnInsert keeps an existing configuration untouched.
    await catMapConfigColl.updateOne(
        { _id: 'main' } as any,
        { $setOnInsert: { planMaxSteps: CAT_MAP_PLAN_MAX_STEPS_DEFAULT, updatedAt: new Date() } } as any,
        { upsert: true },
    );
}

export async function removeCatMapPlayer(uid: number) {
    return await catMapPlayerColl.deleteOne({ _id: uid });
}

async function getEligibleUser(uid: number) {
    return await userColl.findOne({ _id: uid, realname_flag: { $gte: 1 } });
}

export async function joinCatMapPlayer(uid: number, x: number, y: number, now = new Date()) {
    if (!validCoordinate(x, y)) throw new Error('目标格子超出地图范围。');
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以加入猫猫广场。');
    if (await catMapPlayerColl.findOne({ _id: uid })) throw new Error('你的小猫已经加入猫猫广场了。');
    const fortressCatId = await fortressCatIdAt(x, y);
    if (fortressCatId && fortressCatId !== boundCatIdOf(user)) {
        throw new Error('目标格子位于 00区大猫领地核心，上下左右均归属同一大猫，只有绑定该大猫的小猫才能进入。');
    }
    const doc = { _id: uid, x, y, joinedAt: now, createdAt: now, updatedAt: now };
    try {
        await catMapPlayerColl.insertOne(doc as any);
    } catch (e: any) {
        if (e?.code !== 11000) throw e;
        if (await catMapPlayerColl.findOne({ _id: uid })) throw new Error('你的小猫已经加入猫猫广场了。');
        throw e;
    }
    if (!await getEligibleUser(uid)) {
        await catMapPlayerColl.deleteOne({ _id: uid, x, y } as any);
        throw new Error('认证状态刚刚发生变化，请刷新页面后重试。');
    }
    try {
        await logColl.insertOne({
            _id: new ObjectId(),
            createdAt: now,
            type: 'cat_map',
            userId: uid,
            sender: uid,
            action: 'join',
            x,
            y,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log cat map join:', e);
    }
    return {
        uid,
        x,
        y,
        action: 'join',
        foodCost: 0,
        canCost: 0,
        food: Math.max(0, Number(user.cat_food) || 0),
        cans: Math.max(0, Math.floor(Number(user.cat_can) || 0)),
        availableAt: null,
        freeColorAvailable: false,
    };
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

function normalizedCatId(value: unknown) {
    // Both positive school keys and negative special-cat keys are valid
    // ownership ids; only 0 means "no big cat".
    return Number.isSafeInteger(value) && Number(value) !== 0 ? Number(value) : 0;
}

// 00区「领地核心」判定：格子本身已涂色归属某大猫，且上下左右四格全部归属同一大猫。
// 返回核心格所属的大猫 catId，不是核心格时返回 0。
async function fortressCatIdAt(x: number, y: number) {
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

function boundCatIdOf(user: any) {
    return Number.isSafeInteger(user?.school_cat) ? schoolCatKey(user.school_cat) : 0;
}

async function randomEmpirePosition(avoidX: number, avoidY: number) {
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
async function displaceFortressIntruders(x: number, y: number, now = new Date()) {
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

async function applyTerritoryDeltas(deltas: Map<number, number>, now = new Date()) {
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

async function moveTerritoryCount(previousCatId: number, nextCatId: number, now = new Date()) {
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

export async function moveCatMapPlayer(uid: number, targetX: number, targetY: number, now = new Date()) {
    if (!validCoordinate(targetX, targetY)) throw new Error('目标格子超出地图范围。');
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以进入猫咪地图。');
    const player: any = await catMapPlayerColl.findOne({ _id: uid });
    if (!player) throw new Error('请先在地图上免费选择一个位置加入猫猫广场。');
    if (player.x === targetX && player.y === targetY) throw new Error('小猫已经在这个格子里。');
    if (player.availableAt && new Date(player.availableAt).getTime() > now.getTime()) {
        throw new Error(`操作冷却中，请在 ${new Date(player.availableAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 后再试。`);
    }

    const distance = Math.abs(player.x - targetX) + Math.abs(player.y - targetY);
    const ownCatId = boundCatIdOf(user);
    const fortressCatId = await fortressCatIdAt(targetX, targetY);
    if (fortressCatId && fortressCatId !== ownCatId) {
        throw new Error('目标格子位于 00区大猫领地核心，上下左右均归属同一大猫，只有绑定该大猫的小猫才能进入。');
    }
    let territoryTeleport = false;
    if (distance !== 1 && ownCatId) {
        const endpointIds = [cellId(player.x, player.y), cellId(targetX, targetY)];
        const endpointRows: any[] = await catMapCellColl.find(
            { _id: { $in: endpointIds } } as any,
            { projection: { catId: 1 } },
        ).toArray();
        const endpointCats = new Map(endpointRows.map((cell: any) => [cell._id, normalizedCatId(cell.catId)]));
        territoryTeleport = endpointCats.get(endpointIds[0]) === ownCatId
            && endpointCats.get(endpointIds[1]) === ownCatId;
    }
    const action = distance === 1 ? 'move' : territoryTeleport ? 'territory_teleport' : 'teleport';
    const foodCost = action === 'move' || action === 'territory_teleport' ? CAT_MAP_MOVE_FOOD_COST : 0;
    const canCost = action === 'teleport' ? CAT_MAP_TELEPORT_CAN_COST : 0;
    const contributionSchoolId = foodCost > 0
        && Number.isSafeInteger(user.school_cat)
        ? Number(user.school_cat)
        : null;
    if (contributionSchoolId !== null) await ensureSchoolCatRecord(contributionSchoolId, now);
    const cansBefore = Math.max(0, Math.floor(Number(user.cat_can) || 0));
    const minutes = cooldownMinutes(cansBefore - canCost);
    const availableAt = new Date(now.getTime() + minutes * 60 * 1000);
    const lock = new ObjectId();
    const staleLockAt = new Date(now.getTime() - 30_000);
    const claimed = await catMapPlayerColl.updateOne({
        _id: uid,
        x: player.x,
        y: player.y,
        $and: [
            { $or: [{ availableAt: { $exists: false } }, { availableAt: { $lte: now } }] },
            { $or: [{ movementLock: { $exists: false } }, { movementLockAt: { $lt: staleLockAt } }] },
        ],
    } as any, { $set: { movementLock: lock, movementLockAt: now }, $unset: { stackable: '' } });
    if (!claimed.modifiedCount) throw new Error('小猫的位置或冷却状态刚刚发生了变化，请重试。');

    let foodDeducted = false;
    let canDeducted = false;
    let poolUpdated = false;
    let catContributionUpdated = false;
    let movementLogged = false;
    const movementLogId = new ObjectId();
    try {
        if (foodCost) {
            const foodFilter: any = { _id: uid, realname_flag: { $gte: 1 }, cat_food: { $gte: foodCost } };
            const foodIncrements: any = { cat_food: -foodCost };
            if (contributionSchoolId !== null) {
                // Keep the binding stable across the balance/contribution write.
                foodFilter.school_cat = contributionSchoolId;
                foodIncrements.school_cat_food = foodCost;
            }
            const result = await userColl.updateOne(
                foodFilter,
                { $inc: foodIncrements },
            );
            if (!result.modifiedCount) throw new Error(`猫粮不足或大猫绑定刚刚发生变化，本次移动需要 ${foodCost}g 猫粮。`);
            foodDeducted = true;
        }
        if (canCost) {
            const result = await userColl.updateOne(
                { _id: uid, realname_flag: { $gte: 1 }, cat_can: { $gte: canCost } },
                { $inc: { cat_can: -canCost } },
            );
            if (!result.modifiedCount) throw new Error(`猫罐头不足，本次传送需要 ${canCost} 个猫罐头。`);
            canDeducted = true;
        }
        const increments: any = {};
        if (foodCost) increments.userFoodTotal = -foodCost;
        if (canCost) increments.circulatingCans = -canCost;
        const poolResult = await catCanPoolColl.updateOne(
            { _id: 'main' } as any,
            { $inc: increments, $set: { updatedAt: now } } as any,
        );
        poolUpdated = !!poolResult.modifiedCount;
        if (contributionSchoolId !== null) {
            const catResult = await schoolCatColl.updateOne(
                { _id: contributionSchoolId } as any,
                { $inc: { currentWeight: foodCost }, $set: { updatedAt: now } } as any,
            );
            if (!catResult.modifiedCount) throw new Error('移动猫粮计入大猫贡献失败，请重试。');
            catContributionUpdated = true;
        }
        await logColl.insertOne({
            _id: movementLogId,
            createdAt: now,
            type: 'cat_account',
            userId: uid,
            sender: uid,
            action: `cat_map_${action}`,
            amount: -foodCost,
            canAmount: -canCost,
            catId: contributionSchoolId === null ? 0 : schoolCatKey(contributionSchoolId),
            schoolCatContributionCounted: true,
            reason: `从 (${player.y}, ${player.x}) 到 (${targetY}, ${targetX})（行,列）`,
        } as any);
        movementLogged = true;
        const playerPatch: any = {
            x: targetX,
            y: targetY,
            movedAt: now,
            availableAt,
            freeColorAvailable: true,
            updatedAt: now,
        };
        const moved = await catMapPlayerColl.updateOne(
            { _id: uid, movementLock: lock } as any,
            {
                $set: playerPatch,
                $unset: { movementLock: '', movementLockAt: '', stackable: '' },
            },
        );
        if (!moved.modifiedCount) throw new Error('移动锁已失效，请重试。');
    } catch (e) {
        if (movementLogged) await logColl.deleteOne({ _id: movementLogId });
        if (catContributionUpdated && contributionSchoolId !== null) {
            await schoolCatColl.updateOne(
                { _id: contributionSchoolId } as any,
                { $inc: { currentWeight: -foodCost } } as any,
            );
        }
        if (foodDeducted) {
            const foodRollback: any = { cat_food: foodCost };
            if (contributionSchoolId !== null) foodRollback.school_cat_food = -foodCost;
            await userColl.updateOne({ _id: uid }, { $inc: foodRollback });
        }
        if (canDeducted) await userColl.updateOne({ _id: uid }, { $inc: { cat_can: canCost } });
        if (poolUpdated) {
            const increments: any = {};
            if (foodCost) increments.userFoodTotal = foodCost;
            if (canCost) increments.circulatingCans = canCost;
            await catCanPoolColl.updateOne({ _id: 'main' } as any, { $inc: increments } as any);
        }
        await catMapPlayerColl.updateOne(
            { _id: uid, movementLock: lock } as any,
            { $unset: { movementLock: '', movementLockAt: '' } },
        );
        throw e;
    }

    const updatedUser: any = await userColl.findOne({ _id: uid });
    return {
        uid, fromX: player.x, fromY: player.y, x: targetX, y: targetY,
        // uname is returned for the broadcast payload: planned steps are executed
        // by the scheduler, which has no handler context to read it from.
        uname: user.uname || `UID ${uid}`,
        action, foodCost, canCost, territoryTeleport,
        contributedSchoolId: contributionSchoolId,
        contributedCatId: contributionSchoolId === null ? 0 : schoolCatKey(contributionSchoolId),
        cans: Math.max(0, Number(updatedUser?.cat_can) || 0),
        food: Math.max(0, Number(updatedUser?.cat_food) || 0),
        cooldownMinutes: minutes, availableAt,
        freeColorAvailable: true,
    };
}

export async function setCatMapCellColor(
    operator: number, x: number, y: number, color: number, now = new Date(),
) {
    if (!validCoordinate(x, y)) throw new Error('目标格子超出地图范围。');
    if (!validColor(color)) throw new Error('颜色码必须是 0～255 的整数。');
    const user: any = await getEligibleUser(operator);
    if (!user) throw new Error('只有已认证用户可以修改格子颜色。');
    const catId = Number.isSafeInteger(user.school_cat)
        ? schoolCatKey(user.school_cat)
        : 0;
    if (catId !== 0) await ensureSchoolCatRecord(user.school_cat, now);
    const player: any = await catMapPlayerColl.findOne({ _id: operator });
    if (!player || player.x !== x || player.y !== y) throw new Error('只能设置自己小猫当前所在格子的颜色。');

    const cans = Math.max(0, Math.floor(Number(user.cat_can) || 0));
    const minutes = cooldownMinutes(cans);
    const availableAt = new Date(now.getTime() + minutes * 60 * 1000);
    const lock = new ObjectId();
    const staleLockAt = new Date(now.getTime() - 30_000);
    const claimed = await catMapPlayerColl.updateOne({
        _id: operator,
        x,
        y,
        $and: [
            {
                $or: [
                    { freeColorAvailable: true },
                    { availableAt: { $exists: false } },
                    { availableAt: { $lte: now } },
                ],
            },
            { $or: [{ movementLock: { $exists: false } }, { movementLockAt: { $lt: staleLockAt } }] },
        ],
    } as any, {
        $set: { movementLock: lock, movementLockAt: now, availableAt, updatedAt: now },
        $unset: { freeColorAvailable: '', stackable: '' },
    });
    if (!claimed.modifiedCount) throw new Error('操作冷却中，暂时不能更换颜色。');

    const id = cellId(x, y);
    let previous: any = null;
    let previousCatId = 0;
    const logId = new ObjectId();
    let cellUpdated = false;
    let logged = false;
    try {
        previous = await catMapCellColl.findOneAndUpdate(
            { _id: id } as any,
            { $set: { x, y, color, catId, updatedBy: operator, updatedAt: now } },
            { upsert: true, returnDocument: 'before' },
        );
        cellUpdated = true;
        previousCatId = normalizedCatId(previous?.catId);
        await moveTerritoryCount(previousCatId, catId, now);
        await logColl.insertOne({
            _id: logId,
            createdAt: now,
            type: 'cat_map',
            userId: operator,
            sender: operator,
            action: 'color',
            x,
            y,
            color,
            catId,
        } as any);
        logged = true;
        await catMapPlayerColl.updateOne(
            { _id: operator, movementLock: lock } as any,
            { $unset: { movementLock: '', movementLockAt: '' } },
        );
    } catch (e) {
        if (logged) await logColl.deleteOne({ _id: logId });
        if (cellUpdated) {
            // Only undo our own write. Another user may already have painted
            // the same shared cell while a later counter/log operation was
            // failing; replacing unconditionally would erase that newer art.
            const ownWrite = {
                _id: id,
                updatedBy: operator,
                updatedAt: now,
                color,
                catId,
            } as any;
            if (previous) await catMapCellColl.replaceOne(ownWrite, previous);
            else await catMapCellColl.deleteOne(ownWrite);
        }
        if (previousCatId !== catId) await recountSchoolCatTerritories(now);
        const rollback: any = { $unset: { movementLock: '', movementLockAt: '' }, $set: {} };
        if (player.availableAt) rollback.$set.availableAt = player.availableAt;
        else rollback.$unset.availableAt = '';
        if (player.freeColorAvailable) rollback.$set.freeColorAvailable = true;
        else rollback.$unset.freeColorAvailable = '';
        if (!Object.keys(rollback.$set).length) delete rollback.$set;
        await catMapPlayerColl.updateOne({ _id: operator, movementLock: lock } as any, rollback);
        throw e;
    }
    const displaced = catId ? await displaceFortressIntruders(x, y, now) : [];
    return {
        _id: id,
        x,
        y,
        color,
        catId,
        previousCatId,
        territoryChanged: previousCatId !== catId,
        displaced,
        updatedBy: operator,
        updatedAt: now,
        cooldownMinutes: minutes,
        availableAt,
        freeColorAvailable: false,
    };
}

export async function adminPaintCatMap(
    operator: number,
    rowStart: number,
    columnStart: number,
    rowEnd: number,
    columnEnd: number,
    color: number,
    now = new Date(),
) {
    const user: any = await getEligibleUser(operator);
    if (!user || (Number(user.realname_flag) || 0) < 3) throw new Error('仅行政管理员可以使用地图绘图后台。');
    if (!validCoordinate(columnStart, rowStart) || !validCoordinate(columnEnd, rowEnd)) {
        throw new Error(`行列坐标必须为 0～${CAT_MAP_HEIGHT - 1}、0～${CAT_MAP_WIDTH - 1}。`);
    }
    if (rowStart > rowEnd || columnStart > columnEnd) throw new Error('矩形起点必须位于终点的左上方。');
    if (!validColor(color)) throw new Error('颜色码必须是 0～255 的整数。');

    const catId = Number.isSafeInteger(user.school_cat)
        ? schoolCatKey(user.school_cat)
        : 0;
    if (catId !== 0) await ensureSchoolCatRecord(user.school_cat, now);
    const priorGroups: any[] = await catMapCellColl.aggregate([
        {
            $match: {
                x: { $gte: columnStart, $lte: columnEnd },
                y: { $gte: rowStart, $lte: rowEnd },
            },
        },
        { $group: { _id: { $ifNull: ['$catId', 0] }, count: { $sum: 1 } } },
    ]).toArray();

    const operations: any[] = [];
    let count = 0;
    for (let row = rowStart; row <= rowEnd; row++) {
        for (let column = columnStart; column <= columnEnd; column++) {
            const id = cellId(column, row);
            operations.push({
                updateOne: {
                    filter: { _id: id },
                    update: { $set: { x: column, y: row, color, catId, updatedBy: operator, updatedAt: now } },
                    upsert: true,
                },
            });
            count++;
            if (operations.length >= 1000) {
                try {
                    await catMapCellColl.bulkWrite(operations, { ordered: false });
                } catch (e) {
                    await recountSchoolCatTerritories(now);
                    throw e;
                }
                operations.length = 0;
            }
        }
    }
    if (operations.length) {
        try {
            await catMapCellColl.bulkWrite(operations, { ordered: false });
        } catch (e) {
            await recountSchoolCatTerritories(now);
            throw e;
        }
    }
    const territoryDeltas = new Map<number, number>();
    let alreadyOwned = 0;
    for (const group of priorGroups) {
        const previousCatId = normalizedCatId(group._id);
        const groupCount = Math.max(0, Math.floor(Number(group.count) || 0));
        if (previousCatId === catId) {
            alreadyOwned += groupCount;
        } else if (previousCatId !== 0) {
            territoryDeltas.set(previousCatId, (territoryDeltas.get(previousCatId) || 0) - groupCount);
        }
    }
    if (catId !== 0 && count > alreadyOwned) territoryDeltas.set(
        catId,
        (territoryDeltas.get(catId) || 0) + count - alreadyOwned,
    );
    try {
        await applyTerritoryDeltas(territoryDeltas, now);
    } catch (e) {
        await recountSchoolCatTerritories(now);
        throw e;
    }
    try {
        await logColl.insertOne({
            _id: new ObjectId(),
            createdAt: now,
            type: 'cat_map',
            userId: operator,
            sender: operator,
            action: count === 1 ? 'admin_paint_pixel' : 'admin_paint_rect',
            rowStart,
            columnStart,
            rowEnd,
            columnEnd,
            color,
            catId,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log admin map paint:', e);
    }
    return { rowStart, columnStart, rowEnd, columnEnd, color, catId, count };
}

export async function adminRelocateCatMapPlayer(
    operator: number, uid: number, now = new Date(),
) {
    const admin: any = await getEligibleUser(operator);
    if (!admin || (Number(admin.realname_flag) || 0) < 3) {
        throw new Error('仅行政管理员可以强制迁移小猫。');
    }
    const target: any = await getEligibleUser(uid);
    if (!target) throw new Error('目标用户不存在或尚未认证。');
    const player: any = await catMapPlayerColl.findOne({ _id: uid });
    if (!player) throw new Error('目标用户的小猫尚未加入猫猫广场。');

    const lock = new ObjectId();
    const staleLockAt = new Date(now.getTime() - 30_000);
    const claimed = await catMapPlayerColl.updateOne({
        _id: uid,
        x: player.x,
        y: player.y,
        $or: [
            { movementLock: { $exists: false } },
            { movementLockAt: { $lt: staleLockAt } },
        ],
    } as any, {
        $set: { movementLock: lock, movementLockAt: now },
        $unset: { stackable: '' },
    });
    if (!claimed.modifiedCount) throw new Error('目标小猫正在执行其他操作，请稍后重试。');

    let x = randomInt(CAT_MAP_WIDTH);
    let y = randomInt(CAT_MAP_HEIGHT);
    while (x === player.x && y === player.y) {
        x = randomInt(CAT_MAP_WIDTH);
        y = randomInt(CAT_MAP_HEIGHT);
    }
    const destination = { x, y };
    try {
        const moved = await catMapPlayerColl.updateOne(
            { _id: uid, movementLock: lock } as any,
            {
                $set: { x, y, movedAt: now, updatedAt: now },
                $unset: { movementLock: '', movementLockAt: '', stackable: '' },
            },
        );
        if (!moved.modifiedCount) throw new Error('管理员迁移锁已失效，请重试。');
    } catch (e) {
        await catMapPlayerColl.updateOne(
            { _id: uid, movementLock: lock } as any,
            { $unset: { movementLock: '', movementLockAt: '' } },
        );
        throw e;
    }

    try {
        await logColl.insertOne({
            _id: new ObjectId(),
            createdAt: now,
            type: 'cat_map',
            userId: operator,
            sender: operator,
            targetUid: uid,
            action: 'admin_relocate',
            fromX: player.x,
            fromY: player.y,
            x: destination.x,
            y: destination.y,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log admin cat relocation:', e);
    }
    return {
        uid,
        fromX: player.x,
        fromY: player.y,
        x: destination.x,
        y: destination.y,
        cans: Math.max(0, Math.floor(Number(target.cat_can) || 0)),
        availableAt: player.availableAt || null,
        freeColorAvailable: !!player.freeColorAvailable,
    };
}

// --- 路径规划（计划） ------------------------------------------------------
// 一步 = 移动到相邻格（3g 猫粮）后立刻涂抹该格。计划由 index.ts 的 30 秒调度器
// 在 nextAt 到期时推进；任何一步失败（并发冲突重试 3 次后仍失败）即自动停止。
// 返回的事件对象与 handler/cat-can.ts 里广播的载荷形状一致，可直接 broadcast。

// 移动/涂色失败信息里带「请重试」的都是并发竞态（移动锁被占用），可以稍后重试。
const RETRYABLE_MOVE_ERROR = /请重试/;

export function normalizeCatMapPlanMaxSteps(value: unknown) {
    const steps = Math.floor(Number(value) || 0);
    if (!Number.isFinite(steps) || steps < 1) return CAT_MAP_PLAN_MAX_STEPS_DEFAULT;
    return Math.min(steps, CAT_MAP_PLAN_MAX_STEPS_LIMIT);
}

export async function getCatMapConfig() {
    const doc: any = await catMapConfigColl.findOne({ _id: 'main' } as any);
    return {
        planMaxSteps: normalizeCatMapPlanMaxSteps(doc?.planMaxSteps ?? CAT_MAP_PLAN_MAX_STEPS_DEFAULT),
    };
}

export async function saveCatMapConfig(patch: { planMaxSteps?: unknown }, now = new Date()) {
    const planMaxSteps = normalizeCatMapPlanMaxSteps(patch.planMaxSteps);
    await catMapConfigColl.updateOne(
        { _id: 'main' } as any,
        { $set: { planMaxSteps, updatedAt: now } } as any,
        { upsert: true },
    );
    return { planMaxSteps };
}

// 纯校验（无数据库访问，便于单测）：数量、坐标、颜色，以及「路径必须连续」——
// 第一步必须与 base 相邻，之后每一步都必须与上一步相邻（曼哈顿距离为 1）。
export function validateCatMapPlanShape(
    steps: unknown,
    base: { x: number; y: number },
    maxSteps = CAT_MAP_PLAN_MAX_STEPS_DEFAULT,
) {
    if (!Array.isArray(steps) || !steps.length) throw new Error('计划至少需要 1 步。');
    if (steps.length > maxSteps) throw new Error(`计划最多 ${maxSteps} 步。`);
    const normalized: Array<{ x: number; y: number; color: number }> = [];
    let previous = { x: Number(base?.x), y: Number(base?.y) };
    steps.forEach((raw: any, index: number) => {
        const x = Number(raw?.x);
        const y = Number(raw?.y);
        const color = Number(raw?.color);
        if (!validCoordinate(x, y)) throw new Error(`第 ${index + 1} 步的坐标超出地图范围。`);
        if (!validColor(color)) throw new Error(`第 ${index + 1} 步的颜色码必须是 0～255 的整数。`);
        const distance = Math.abs(previous.x - x) + Math.abs(previous.y - y);
        if (distance !== 1) {
            throw new Error(`第 ${index + 1} 步必须与上一步相邻（只能走到上下左右一格），计划路径必须连续。`);
        }
        normalized.push({ x, y, color });
        previous = { x, y };
    });
    return normalized;
}

export function buildCatMapPlanView(plan: any, maxSteps: number) {
    if (!plan || !Array.isArray(plan.steps)) return null;
    const cursor = Math.max(0, Math.min(Number(plan.cursor) || 0, plan.steps.length));
    return {
        status: plan.status,
        cursor,
        steps: plan.steps.map((step: any, index: number) => ({
            index,
            x: Number(step.x),
            y: Number(step.y),
            color: Number(step.color),
            executed: index < cursor,
        })),
        maxSteps,
        originX: Number(plan.originX),
        originY: Number(plan.originY),
        nextAt: plan.nextAt ? new Date(plan.nextAt).getTime() : 0,
        failReason: plan.failReason || '',
        updatedAt: plan.updatedAt ? new Date(plan.updatedAt).getTime() : 0,
    };
}

export async function getCatMapPlan(uid: number) {
    return await catMapPlanColl.findOne({ _id: uid } as any);
}

export async function getCatMapPlanView(uid: number) {
    const [plan, config] = await Promise.all([getCatMapPlan(uid), getCatMapConfig()]);
    return buildCatMapPlanView(plan, config.planMaxSteps);
}

async function logCatMapPlan(
    uid: number,
    action: string,
    detail: Record<string, any> = {},
    now = new Date(),
) {
    try {
        await logColl.insertOne({
            _id: new ObjectId(),
            createdAt: now,
            type: 'cat_map',
            userId: uid,
            sender: uid,
            action,
            ...detail,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log cat map plan:', e);
    }
}

// 计划停止只发私信给本人，且仅自动停止时发送（手动取消是用户自己的意图）。
async function notifyCatMapPlanStopped(uid: number, reason: string, auto: boolean) {
    if (!auto) return;
    try {
        await MessageModel.send(
            1, uid,
            `你的猫猫广场路径计划已自动停止：${reason}。`
            + '计划执行期间手动移动或染色也会停止计划，可回到猫猫广场重新规划。',
        );
    } catch (e) {
        console.error('[oi33] cat map plan notification failed:', e);
    }
}

// 保存（整体替换）或追加步骤。返回 { plan, events, result }：
// events 交给调用方广播，result 是「保存即执行」时那一步的执行结果。
export async function saveCatMapPlan(
    uid: number,
    steps: unknown,
    mode: 'replace' | 'append' = 'replace',
    now = new Date(),
) {
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以规划小猫路线。');
    const player: any = await catMapPlayerColl.findOne({ _id: uid });
    if (!player) throw new Error('请先在猫猫广场里免费选一个位置加入。');
    const config = await getCatMapConfig();
    const maxSteps = config.planMaxSteps;
    const existing: any = await catMapPlanColl.findOne({ _id: uid });
    const append = mode === 'append';
    if (append && (!existing || existing.status !== 'active')) {
        throw new Error('当前没有正在执行的计划，无法追加步骤。');
    }
    const existingSteps: any[] = append ? (existing.steps || []) : [];
    const cursor = append
        ? Math.max(0, Math.min(Number(existing.cursor) || 0, existingSteps.length))
        : 0;
    if (append) {
        if (existingSteps.length >= maxSteps) {
            throw new Error(`计划最多 ${maxSteps} 步（当前已规划 ${existingSteps.length} 步），无法继续追加。`);
        }
        // 计划必须与实际位置同步：上一处已执行的位置就是小猫现在应该在的地方。
        const expected = cursor > 0
            ? existingSteps[cursor - 1]
            : { x: Number(existing.originX), y: Number(existing.originY) };
        if (player.x !== Number(expected.x) || player.y !== Number(expected.y)) {
            throw new Error('小猫当前位置与计划路径不一致（可能被手动操作或驱逐），请取消计划后重新规划。');
        }
    }
    const base = append
        ? existingSteps[existingSteps.length - 1]
        : { x: player.x, y: player.y };
    const normalized = validateCatMapPlanShape(
        steps,
        { x: Number(base.x), y: Number(base.y) },
        append ? maxSteps - existingSteps.length : maxSteps,
    );
    // 预检领地核心：其他大猫的核心格进不去，提前失败好过走到一半停下。
    const ownCatId = boundCatIdOf(user);
    for (let index = 0; index < normalized.length; index++) {
        const fortressCatId = await fortressCatIdAt(normalized[index].x, normalized[index].y);
        if (fortressCatId && fortressCatId !== ownCatId) {
            throw new Error(`第 ${index + 1} 步位于其他大猫的领地核心，只有绑定该大猫的小猫才能进入。`);
        }
    }
    const nextSteps = append ? [...existingSteps, ...normalized] : normalized;
    // 追加时不重排既有节奏（例如并发冲突后的 60 秒重试延迟）；整体替换则从当前冷却状态重新开始。
    const nextAt = append
        ? new Date(existing.nextAt || player.availableAt || now)
        : new Date(player.availableAt || now);
    await catMapPlanColl.updateOne({ _id: uid } as any, {
        $set: {
            steps: nextSteps,
            cursor,
            status: 'active',
            originX: append ? Number(existing.originX) : player.x,
            originY: append ? Number(existing.originY) : player.y,
            nextAt,
            updatedAt: now,
            startedAt: append ? (existing.startedAt || now) : now,
        },
        $unset: {
            failReason: '', finishedAt: '', attempts: '', lockOwner: '', lockUntil: '',
        },
    } as any, { upsert: true });
    await logCatMapPlan(uid, append ? 'plan_extend' : 'plan_start', {
        stepCount: nextSteps.length,
        addedCount: normalized.length,
    }, now);
    const events: any[] = [];
    let result: any = null;
    // 保存/追加时若已经不在冷却中（且没有别的 worker 正在执行），立刻走下一步。
    if (nextAt.getTime() <= now.getTime()) {
        const advanced = await advanceCatMapPlan(uid, now);
        if (advanced) {
            events.push(...advanced.events);
            result = advanced.result;
        }
    }
    const saved: any = await catMapPlanColl.findOne({ _id: uid });
    return { plan: buildCatMapPlanView(saved, maxSteps), events, result };
}

// 停止计划（手动取消或自动失败）。仅对 active 计划生效，返回 null 表示当时没有可停的计划。
export async function stopCatMapPlan(
    uid: number,
    reason: string,
    options: { auto?: boolean } = {},
    now = new Date(),
) {
    const config = await getCatMapConfig();
    const stopped = await catMapPlanColl.updateOne(
        { _id: uid, status: 'active' } as any,
        {
            $set: {
                status: 'stopped', failReason: reason || '', finishedAt: now, updatedAt: now,
            },
            $unset: { lockOwner: '', lockUntil: '', attempts: '' },
        } as any,
    );
    if (!stopped.modifiedCount) return null;
    await logCatMapPlan(uid, 'plan_stop', {
        reason: reason || '', auto: !!options.auto,
    }, now);
    await notifyCatMapPlanStopped(uid, reason, !!options.auto);
    const plan: any = await catMapPlanColl.findOne({ _id: uid });
    const view = buildCatMapPlanView(plan, config.planMaxSteps);
    return {
        plan: view,
        events: [{ type: 'plan', targetUid: uid, plan: view, stopped: true, reason: reason || '' }],
    };
}

// 推进一个计划的一步。返回 null 表示这次没轮到它（未到期或已被其他进程持有租约）。
export async function advanceCatMapPlan(uid: number, now = new Date()) {
    const lock = new ObjectId();
    // 数据库租约：抢到才执行，避免同一计划被并发执行两次。
    const plan: any = await catMapPlanColl.findOneAndUpdate({
        _id: uid,
        status: 'active',
        nextAt: { $lte: now },
        $or: [{ lockUntil: { $exists: false } }, { lockUntil: { $lte: now } }],
    } as any, {
        $set: {
            lockOwner: lock,
            lockUntil: new Date(now.getTime() + CAT_MAP_PLAN_LOCK_MS),
            updatedAt: now,
        },
    } as any, { returnDocument: 'after' });
    if (!plan) return null;
    const config = await getCatMapConfig();
    const maxSteps = config.planMaxSteps;
    const steps: any[] = Array.isArray(plan.steps) ? plan.steps : [];
    const cursor = Math.max(0, Math.min(Number(plan.cursor) || 0, steps.length));
    const events: any[] = [];
    const release = async (patch: any) => {
        await catMapPlanColl.updateOne({ _id: uid, lockOwner: lock } as any, {
            ...patch,
            $unset: { lockOwner: '', lockUntil: '' },
        } as any);
    };
    const view = async () => {
        const current: any = await catMapPlanColl.findOne({ _id: uid });
        return buildCatMapPlanView(current, maxSteps);
    };
    // 所有步骤都执行完了（正常流程里最后一步会直接写成 done，这里是兜底）。
    if (cursor >= steps.length) {
        await release({ $set: { status: 'done', finishedAt: now, updatedAt: now } });
        const finishedView = await view();
        events.push({ type: 'plan', targetUid: uid, plan: finishedView, finished: true });
        return { events, result: null, finished: true };
    }
    // 停止计划前必须先释放租约：stopCatMapPlan 只处理 active 状态。
    const fail = async (reason: string) => {
        await release({ $set: { updatedAt: now } });
        const stopped = await stopCatMapPlan(uid, reason, { auto: true }, now);
        if (stopped) events.push(...stopped.events);
        return { events, result: null, stopped: true, reason };
    };
    const step = steps[cursor];
    const previous = cursor > 0
        ? steps[cursor - 1]
        : { x: Number(plan.originX), y: Number(plan.originY) };
    const player: any = await catMapPlayerColl.findOne({ _id: uid });
    if (!player) return await fail('小猫已不在猫猫广场（未认证或被移除），计划已停止。');
    // 推进光标，并把这一步的事件补上。nextAt 一般取涂色返回的 availableAt。
    const finishStep = async (nextAt: Date, extraEvents: any[] = []) => {
        const finished = cursor + 1 >= steps.length;
        await release({
            $set: {
                cursor: cursor + 1,
                status: finished ? 'done' : 'active',
                attempts: 0,
                nextAt,
                updatedAt: now,
                ...(finished ? { finishedAt: now } : {}),
            },
        });
        events.push(...extraEvents);
        const steppedView = await view();
        events.push({
            type: 'plan',
            targetUid: uid,
            plan: steppedView,
            step: {
                index: cursor, x: step.x, y: step.y, color: step.color,
            },
            finished,
        });
        return {
            events,
            result: {
                step: {
                    index: cursor, x: step.x, y: step.y, color: step.color,
                },
                finished,
            },
            finished,
        };
    };
    // 幂等恢复：上一轮在「已移动、未涂色」之间中断（进程崩溃或并发重入）时，
    // 小猫正站在目标格上且免冷却染色还没用掉——补涂一次，再把这一步算作完成。
    // 免冷却染色已被用掉说明这一步早已完成（或小猫被驱逐到这里），只推进光标，
    // 不重复消耗一次冷却。
    if (player.x === step.x && player.y === step.y) {
        if (player.freeColorAvailable) {
            let recovered: any = null;
            try {
                recovered = await setCatMapCellColor(uid, step.x, step.y, step.color, now);
            } catch (e: any) {
                return await fail(`恢复中断的计划时补涂失败：${e?.message || String(e)}`);
            }
            const extraEvents: any[] = [
                { type: 'cell', cell: [recovered.x, recovered.y, recovered.color, recovered.catId] },
            ];
            for (const moved of recovered.displaced || []) extraEvents.push({ type: 'player', player: moved });
            if (recovered.territoryChanged) extraEvents.push({ type: 'bigcat', cat: { catId: recovered.catId } });
            extraEvents.push({
                type: 'cooldown',
                uid,
                availableAt: recovered.availableAt,
                freeColorAvailable: recovered.freeColorAvailable,
            });
            return await finishStep(
                recovered.availableAt ? new Date(recovered.availableAt) : now,
                extraEvents,
            );
        }
        return await finishStep(player.availableAt ? new Date(player.availableAt) : now);
    }
    if (player.x !== Number(previous.x) || player.y !== Number(previous.y)) {
        return await fail('小猫位置与计划路径不一致（可能被手动操作、驱逐或管理员迁移），计划已停止。');
    }
    let moveResult: any = null;
    try {
        moveResult = await moveCatMapPlayer(uid, step.x, step.y, now);
    } catch (e: any) {
        const message = e?.message || String(e);
        const attempts = (Number(plan.attempts) || 0) + 1;
        // 并发冲突：让出本轮，稍后重试；连续失败达到上限才停止计划。
        if (RETRYABLE_MOVE_ERROR.test(message) && attempts < CAT_MAP_PLAN_RETRY_LIMIT) {
            await release({
                $set: {
                    attempts,
                    nextAt: new Date(now.getTime() + CAT_MAP_PLAN_RETRY_DELAY_MS),
                    updatedAt: now,
                },
            });
            return {
                events, result: null, retry: true, reason: message,
            };
        }
        return await fail(message);
    }
    events.push({
        type: 'player',
        player: {
            uid,
            uname: moveResult.uname,
            fromX: moveResult.fromX,
            fromY: moveResult.fromY,
            x: moveResult.x,
            y: moveResult.y,
            cans: moveResult.cans,
            food: moveResult.food,
            foodCost: moveResult.foodCost,
            canCost: moveResult.canCost,
            availableAt: moveResult.availableAt,
            freeColorAvailable: moveResult.freeColorAvailable,
        },
    });
    let colorResult: any = null;
    try {
        colorResult = await setCatMapCellColor(uid, step.x, step.y, step.color, now);
    } catch (e: any) {
        // 已经走到目标格：按「已到达」推进光标，然后停止计划（这一步的颜色没能画上）。
        const message = e?.message || String(e);
        await release({ $set: { cursor: cursor + 1, updatedAt: now } });
        const stopped = await stopCatMapPlan(uid, `移动成功但涂色失败：${message}`, { auto: true }, now);
        if (stopped) events.push(...stopped.events);
        return {
            events, result: { move: moveResult, color: null, step: null }, stopped: true, reason: message,
        };
    }
    const colorEvents: any[] = [
        { type: 'cell', cell: [colorResult.x, colorResult.y, colorResult.color, colorResult.catId] },
    ];
    for (const moved of colorResult.displaced || []) {
        colorEvents.push({ type: 'player', player: moved });
    }
    if (moveResult.contributedSchoolId !== null && moveResult.contributedSchoolId !== undefined) {
        colorEvents.push({ type: 'bigcat', cat: { id: moveResult.contributedSchoolId } });
    }
    if (colorResult.territoryChanged) {
        colorEvents.push({ type: 'bigcat', cat: { catId: colorResult.catId } });
    }
    colorEvents.push({
        type: 'cooldown',
        uid,
        availableAt: colorResult.availableAt,
        freeColorAvailable: colorResult.freeColorAvailable,
    });
    const stepped = await finishStep(
        colorResult.availableAt ? new Date(colorResult.availableAt) : now,
        colorEvents,
    );
    return { ...stepped, result: { move: moveResult, color: colorResult, ...stepped.result } };
}

// 调度器入口：把所有到期计划的下一批步骤跑掉，返回需要广播的事件。
export async function runCatMapPlansDue(now = new Date(), limit = 50) {
    const due: any[] = await catMapPlanColl.find(
        { status: 'active', nextAt: { $lte: now } } as any,
    ).sort({ nextAt: 1 }).limit(limit).toArray();
    const events: any[] = [];
    let advanced = 0;
    for (const plan of due) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const result = await advanceCatMapPlan(Number(plan._id), now);
            if (!result) continue;
            advanced++;
            events.push(...result.events);
        } catch (e) {
            console.error(`[oi33] cat map plan step failed for uid ${plan._id}:`, e);
        }
    }
    return { scanned: due.length, advanced, events };
}

export const getCatMapCooldownMinutes = cooldownMinutes;
