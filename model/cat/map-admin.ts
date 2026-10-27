import { randomInt } from 'crypto';
import { ObjectId } from 'hydrooj';
import { logColl } from '../log';
import { schoolCatKey, ensureSchoolCatRecord } from './school-shared';
import { getEligibleUser } from './eligibility';
import {
    CAT_MAP_HEIGHT, CAT_MAP_WIDTH, applyTerritoryDeltas, catMapPlayerColl, cellId,
    normalizedCatId, recountSchoolCatTerritories, validColor, validCoordinate, catMapCellColl,
} from './map';

// 行政管理员的地图工具：矩形绘图与强制迁移小猫。普通玩家动作在 map-player.ts。

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

