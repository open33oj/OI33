import { ObjectId } from 'hydrooj';
import { logColl } from '../log';
import { userColl } from '../user';
import { catCanPoolColl } from './can';
import { getEligibleUser } from './eligibility';
import { CAT_MAP_TELEPORT_CAN_COST, cellId, cooldownMinutes, boundCatIdOf, catMapCellColl, catMapPlayerColl, CAT_MAP_MOVE_FOOD_COST, displaceFortressIntruders, fortressCatIdAt, moveTerritoryCount, normalizedCatId, recountSchoolCatTerritories, validColor, validCoordinate } from './map';
import { ensureSchoolCatRecord, schoolCatColl, schoolCatKey } from './school-shared';

// 小猫在地图上的动作：加入、移动、染色、切换领地传送与冷却计算。
// 地图数据与领土统计在 map.ts，管理员强制操作在 map-admin.ts。

export async function removeCatMapPlayer(uid: number) {
    return await catMapPlayerColl.deleteOne({ _id: uid });
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

