import { randomInt } from 'crypto';
import { db, ObjectId } from 'hydrooj';
import { catCanPoolColl } from './cat-can';
import { logColl } from './log';
import { userColl } from './user';

export const CAT_MAP_WIDTH = 640;
export const CAT_MAP_HEIGHT = 480;
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

async function repairDuplicatePositions() {
    const players: any[] = await catMapPlayerColl.find().sort({ _id: 1 }).toArray();
    const used = new Set<string>();
    for (const player of players) {
        let key = cellId(player.x, player.y);
        if (!used.has(key)) {
            used.add(key);
            continue;
        }
        let x = 0;
        let y = 0;
        let found = false;
        for (let attempt = 0; attempt < 256; attempt++) {
            x = randomInt(CAT_MAP_WIDTH);
            y = randomInt(CAT_MAP_HEIGHT);
            if (!used.has(cellId(x, y))) {
                found = true;
                break;
            }
        }
        if (!found) {
            outer: for (y = 0; y < CAT_MAP_HEIGHT; y++) {
                for (x = 0; x < CAT_MAP_WIDTH; x++) {
                    if (!used.has(cellId(x, y))) {
                        found = true;
                        break outer;
                    }
                }
            }
        }
        if (!found) throw new Error('猫咪地图已经没有空位了。');
        key = cellId(x, y);
        used.add(key);
        await catMapPlayerColl.updateOne(
            { _id: player._id },
            { $set: { x, y, updatedAt: new Date() }, $unset: { stackable: '' } },
        );
    }
}

export async function ensureCatMapIndexes() {
    // Remove untouched positions created by the previous automatic random-placement behavior.
    await catMapPlayerColl.deleteMany({
        joinedAt: { $exists: false },
        movedAt: { $exists: false },
        availableAt: { $exists: false },
    } as any);
    // Unverified users must not keep invisible positions that block otherwise empty cells.
    const eligibleUsers = await userColl.find({ realname_flag: { $gte: 1 } }).project({ _id: 1 }).toArray();
    await catMapPlayerColl.deleteMany({ _id: { $nin: eligibleUsers.map((user) => user._id) } } as any);
    try {
        await catMapPlayerColl.dropIndex('x_1_y_1');
    } catch (e: any) {
        if (![26, 27].includes(e?.code)) throw e;
    }
    await repairDuplicatePositions();
    await catMapPlayerColl.updateMany({}, { $unset: { stackable: '' } });
    await Promise.all([
        catMapPlayerColl.createIndex({ x: 1, y: 1 }, { unique: true }),
        catMapPlayerColl.createIndex({ updatedAt: -1 }),
        catMapCellColl.createIndex({ x: 1, y: 1 }, { unique: true }),
        catMapCellColl.createIndex({ updatedAt: -1 }),
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
        throw new Error('这个格子刚刚被其他小猫占用了，请选择其他位置。');
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
        catMapCellColl.find().toArray(),
    ]);
    const balances = Object.fromEntries(eligible.map((user: any) => [user._id, {
        food: Math.max(0, Number(user.cat_food) || 0),
        cans: Math.max(0, Math.floor(Number(user.cat_can) || 0)),
    }]));
    return { players, cells, balances };
}

export async function moveCatMapPlayer(uid: number, targetX: number, targetY: number, now = new Date()) {
    if (!validCoordinate(targetX, targetY)) throw new Error('目标格子超出地图范围。');
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以进入猫咪地图。');
    const player: any = await catMapPlayerColl.findOne({ _id: uid });
    if (!player) throw new Error('请先在地图上免费选择一个空位加入猫猫广场。');
    if (player.x === targetX && player.y === targetY) throw new Error('小猫已经在这个格子里。');
    if (player.availableAt && new Date(player.availableAt).getTime() > now.getTime()) {
        throw new Error(`操作冷却中，请在 ${new Date(player.availableAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 后再试。`);
    }

    const distance = Math.abs(player.x - targetX) + Math.abs(player.y - targetY);
    const action = distance === 1 ? 'move' : 'teleport';
    const foodCost = action === 'move' ? CAT_MAP_MOVE_FOOD_COST : 0;
    const canCost = action === 'teleport' ? CAT_MAP_TELEPORT_CAN_COST : 0;
    const cansBefore = Math.max(0, Math.floor(Number(user.cat_can) || 0));
    const minutes = cooldownMinutes(cansBefore - canCost);
    const availableAt = new Date(now.getTime() + minutes * 60 * 1000);
    const lock = new ObjectId();
    const staleLockAt = new Date(now.getTime() - 30_000);
    let claimed;
    try {
        claimed = await catMapPlayerColl.updateOne({
            _id: uid,
            x: player.x,
            y: player.y,
            $and: [
                { $or: [{ availableAt: { $exists: false } }, { availableAt: { $lte: now } }] },
                { $or: [{ movementLock: { $exists: false } }, { movementLockAt: { $lt: staleLockAt } }] },
            ],
        } as any, { $set: { movementLock: lock, movementLockAt: now }, $unset: { stackable: '' } });
    } catch (e: any) {
        if (e?.code === 11000) throw new Error('当前位置与其他小猫重叠，请刷新地图后重试。');
        throw e;
    }
    if (!claimed.modifiedCount) throw new Error('小猫的位置或冷却状态刚刚发生了变化，请重试。');

    let foodDeducted = false;
    let canDeducted = false;
    let poolUpdated = false;
    let movementLogged = false;
    const movementLogId = new ObjectId();
    try {
        const occupied = await catMapPlayerColl.findOne({
            _id: { $ne: uid }, x: targetX, y: targetY,
        } as any);
        if (occupied) throw new Error('目标格子已经有小猫了。');
        if (foodCost) {
            const result = await userColl.updateOne(
                { _id: uid, realname_flag: { $gte: 1 }, cat_food: { $gte: foodCost } },
                { $inc: { cat_food: -foodCost } },
            );
            if (!result.modifiedCount) throw new Error(`猫粮不足，本次移动需要 ${foodCost}g 猫粮。`);
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
        await logColl.insertOne({
            _id: movementLogId,
            createdAt: now,
            type: 'cat_account',
            userId: uid,
            sender: uid,
            action: `cat_map_${action}`,
            amount: -foodCost,
            canAmount: -canCost,
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
        if (foodDeducted) await userColl.updateOne({ _id: uid }, { $inc: { cat_food: foodCost } });
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
        if ((e as any)?.code === 11000) throw new Error('目标格子刚刚被另一只小猫占用了。');
        throw e;
    }

    const updatedUser: any = await userColl.findOne({ _id: uid });
    return {
        uid, fromX: player.x, fromY: player.y, x: targetX, y: targetY,
        action, foodCost, canCost,
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
    const previous: any = await catMapCellColl.findOne({ _id: id } as any);
    const logId = new ObjectId();
    let cellUpdated = false;
    let logged = false;
    try {
        await catMapCellColl.updateOne(
            { _id: id } as any,
            { $set: { x, y, color, updatedBy: operator, updatedAt: now } },
            { upsert: true },
        );
        cellUpdated = true;
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
        } as any);
        logged = true;
        await catMapPlayerColl.updateOne(
            { _id: operator, movementLock: lock } as any,
            { $unset: { movementLock: '', movementLockAt: '' } },
        );
    } catch (e) {
        if (logged) await logColl.deleteOne({ _id: logId });
        if (cellUpdated) {
            if (previous) await catMapCellColl.replaceOne({ _id: id } as any, previous);
            else await catMapCellColl.deleteOne({ _id: id } as any);
        }
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
        throw new Error('行坐标必须为 0～479，列坐标必须为 0～639。');
    }
    if (rowStart > rowEnd || columnStart > columnEnd) throw new Error('矩形起点必须位于终点的左上方。');
    if (!validColor(color)) throw new Error('颜色码必须是 0～255 的整数。');

    const operations: any[] = [];
    let count = 0;
    for (let row = rowStart; row <= rowEnd; row++) {
        for (let column = columnStart; column <= columnEnd; column++) {
            const id = cellId(column, row);
            operations.push({
                updateOne: {
                    filter: { _id: id },
                    update: { $set: { x: column, y: row, color, updatedBy: operator, updatedAt: now } },
                    upsert: true,
                },
            });
            count++;
            if (operations.length >= 1000) {
                await catMapCellColl.bulkWrite(operations, { ordered: false });
                operations.length = 0;
            }
        }
    }
    if (operations.length) await catMapCellColl.bulkWrite(operations, { ordered: false });
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
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log admin map paint:', e);
    }
    return { rowStart, columnStart, rowEnd, columnEnd, color, count };
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

    let destination: { x: number; y: number } | null = null;
    try {
        for (let attempt = 0; attempt < 256; attempt++) {
            const x = randomInt(CAT_MAP_WIDTH);
            const y = randomInt(CAT_MAP_HEIGHT);
            if (x === player.x && y === player.y) continue;
            try {
                const moved = await catMapPlayerColl.updateOne(
                    { _id: uid, movementLock: lock } as any,
                    {
                        $set: { x, y, movedAt: now, updatedAt: now },
                        $unset: { movementLock: '', movementLockAt: '', stackable: '' },
                    },
                );
                if (!moved.modifiedCount) throw new Error('管理员迁移锁已失效，请重试。');
                destination = { x, y };
                break;
            } catch (e: any) {
                if (e?.code !== 11000) throw e;
            }
        }
        if (!destination) {
            const occupiedRows: any[] = await catMapPlayerColl.find({ _id: { $ne: uid } } as any)
                .project({ x: 1, y: 1 }).toArray();
            const occupied = new Set(occupiedRows.map((row) => cellId(row.x, row.y)));
            const start = randomInt(CAT_MAP_WIDTH * CAT_MAP_HEIGHT);
            for (let offset = 0; offset < CAT_MAP_WIDTH * CAT_MAP_HEIGHT; offset++) {
                const index = (start + offset) % (CAT_MAP_WIDTH * CAT_MAP_HEIGHT);
                const x = index % CAT_MAP_WIDTH;
                const y = Math.floor(index / CAT_MAP_WIDTH);
                const key = cellId(x, y);
                if ((x === player.x && y === player.y) || occupied.has(key)) continue;
                try {
                    const moved = await catMapPlayerColl.updateOne(
                        { _id: uid, movementLock: lock } as any,
                        {
                            $set: { x, y, movedAt: now, updatedAt: now },
                            $unset: { movementLock: '', movementLockAt: '', stackable: '' },
                        },
                    );
                    if (!moved.modifiedCount) throw new Error('管理员迁移锁已失效，请重试。');
                    destination = { x, y };
                    break;
                } catch (e: any) {
                    if (e?.code !== 11000) throw e;
                    occupied.add(key);
                }
            }
        }
        if (!destination) throw new Error('猫猫广场已经没有可用空位。');
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
