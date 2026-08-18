import { randomInt } from 'crypto';
import { db, ObjectId } from 'hydrooj';
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

export const catMapPlayerColl = db.collection('oi33_cat_map_player');
export const catMapCellColl = db.collection('oi33_cat_map_cell');

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
    ]);
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
    return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

async function applyTerritoryDeltas(deltas: Map<number, number>, now = new Date()) {
    const entries = Array.from(deltas.entries()).filter(([catId, delta]) => catId > 0 && delta !== 0);
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
    if (previousCatId > 0) deltas.set(previousCatId, -1);
    if (nextCatId > 0) deltas.set(nextCatId, (deltas.get(nextCatId) || 0) + 1);
    await applyTerritoryDeltas(deltas, now);
    return true;
}

export async function recountSchoolCatTerritories(now = new Date()) {
    const groups: any[] = await catMapCellColl.aggregate([
        { $match: { catId: { $gt: 0 } } },
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
                Number.isSafeInteger(row.school_cat) && row.school_cat >= 0
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
    let territoryTeleport = false;
    if (distance !== 1 && Number.isSafeInteger(user.school_cat) && user.school_cat >= 0) {
        const ownCatId = schoolCatKey(user.school_cat);
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
        && Number.isSafeInteger(user.school_cat) && user.school_cat >= 0
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
    const catId = Number.isSafeInteger(user.school_cat) && user.school_cat >= 0
        ? schoolCatKey(user.school_cat)
        : 0;
    if (catId > 0) await ensureSchoolCatRecord(user.school_cat, now);
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
    return {
        _id: id,
        x,
        y,
        color,
        catId,
        previousCatId,
        territoryChanged: previousCatId !== catId,
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

    const catId = Number.isSafeInteger(user.school_cat) && user.school_cat >= 0
        ? schoolCatKey(user.school_cat)
        : 0;
    if (catId > 0) await ensureSchoolCatRecord(user.school_cat, now);
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
        } else if (previousCatId > 0) {
            territoryDeltas.set(previousCatId, (territoryDeltas.get(previousCatId) || 0) - groupCount);
        }
    }
    if (catId > 0 && count > alreadyOwned) territoryDeltas.set(
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

export const getCatMapCooldownMinutes = cooldownMinutes;
