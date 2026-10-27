// 野猫模式（用户级）：加入猫猫广场并绑定了大猫的用户，可以让自己的小猫
// 每 2 小时自动走一格、顺手抢占地盘。
//
// 规则：
//   - 四邻中优先走「没走过的」；都走过则四邻随机；
//   - 只走相邻格，跳过其他大猫 00区核心；
//   - 到达有色格子时保持该格颜色，只把 catId 改成自己的大猫、updatedBy 改成自己
//     （个人占格数随之转移）；没涂色的格子只移动、不抢归属；
//   - 每 2 小时一步，按 uid 升序结算；用户有正在执行的路径计划时跳过，避免打架。

import { randomInt } from 'crypto';
import { db } from 'hydrooj';
import { addLog } from '../log';
import { userColl } from '../user';
import {
    catMapCellColl, catMapPlayerColl, cellId, fortressCatIdAt, isCatMapCoreZone,
    moveTerritoryCount, normalizedCatId, validCoordinate,
} from './map';
import { schoolCatKey } from './school-shared';

export const WILD_CAT_INTERVAL_MS = 2 * 60 * 60 * 1000;
const MAX_VISITED = 4096;
const MAX_PER_RUN = 200;
const DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

export interface WildCatState {
    enabled: boolean;
    nextAt: Date | null;
}

export async function getWildCatState(uid: number): Promise<WildCatState> {
    const player: any = await catMapPlayerColl.findOne({ _id: uid } as any, {
        projection: { wildcat: 1, wildcatNextAt: 1 },
    });
    return {
        enabled: !!player?.wildcat,
        nextAt: player?.wildcatNextAt || null,
    };
}

export async function setWildCatMode(uid: number, enabled: boolean, now = new Date()) {
    const user: any = await userColl.findOne({
        _id: uid, realname_flag: { $gte: 1 },
    } as any);
    if (!user) throw new Error('只有已认证用户可以开启野猫模式。');
    const player: any = await catMapPlayerColl.findOne({ _id: uid } as any);
    if (!player) throw new Error('请先加入猫猫广场。');
    if (enabled && !Number.isSafeInteger(user.school_cat)) {
        throw new Error('请先绑定一只大猫，野猫模式会帮它占地盘。');
    }
    const nextAt = enabled ? now : null;
    await catMapPlayerColl.updateOne(
        { _id: uid } as any,
        {
            $set: {
                wildcat: !!enabled,
                wildcatNextAt: nextAt,
                updatedAt: now,
            },
            ...(enabled ? {} : { $unset: { wildcatVisited: '' } }),
        } as any,
    );
    try {
        await addLog({
            type: 'cat_map',
            userId: uid,
            sender: uid,
            action: enabled ? 'wildcat_enable' : 'wildcat_disable',
            reason: enabled ? '开启野猫模式：每 2 小时自动占地' : '关闭野猫模式',
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log wildcat toggle:', e);
    }
    return await getWildCatState(uid);
}

export interface WildCatMoveEvent {
    uid: number;
    uname: string;
    x: number;
    y: number;
    color: number | null;
    catId: number;
    schoolId: number;
    previousCatId: number;
    claimed: boolean;
    cans: number;
    food: number;
    availableAt: Date | null;
    wildcatNextAt: Date;
}

async function runOne(player: any, now: Date): Promise<WildCatMoveEvent | null> {
    const uid = Number(player._id);
    const user: any = await userColl.findOne({
        _id: uid, realname_flag: { $gte: 1 },
    } as any, {
        projection: { uname: 1, school_cat: 1, cat_food: 1, cat_can: 1 },
    });
    if (!user || !Number.isSafeInteger(user.school_cat)) {
        // 解绑/降级后自动关闭，避免一直空转。
        await catMapPlayerColl.updateOne({ _id: uid } as any, {
            $set: { wildcat: false, updatedAt: now },
            $unset: { wildcatNextAt: '', wildcatVisited: '' },
        } as any);
        return null;
    }
    // 有正在执行的路径计划时让路，等计划结束后的下一轮再走。
    const plan = await db.collection('oi33_cat_map_plan').findOne({
        uid, status: 'running',
    } as any, { projection: { _id: 1 } });
    if (plan) return null;

    const ownCatId = schoolCatKey(user.school_cat);
    const currentX = Number(player.x);
    const currentY = Number(player.y);
    if (!validCoordinate(currentX, currentY)) return null;
    const visited: string[] = Array.isArray(player.wildcatVisited)
        ? player.wildcatVisited.map((item: any) => String(item))
        : [];
    const visitedSet = new Set(visited);
    const candidates: Array<{ x: number; y: number }> = [];
    for (const [dx, dy] of DIRECTIONS) {
        const x = currentX + dx;
        const y = currentY + dy;
        if (!validCoordinate(x, y)) continue;
        if (isCatMapCoreZone(x, y)) {
            const fortress = await fortressCatIdAt(x, y);
            if (fortress && fortress !== ownCatId) continue;
        }
        candidates.push({ x, y });
    }
    if (!candidates.length) {
        await catMapPlayerColl.updateOne({ _id: uid } as any, {
            $set: {
                wildcatNextAt: new Date(now.getTime() + WILD_CAT_INTERVAL_MS),
                updatedAt: now,
            },
        } as any);
        return null;
    }
    const unvisited = candidates.filter((pos) => !visitedSet.has(cellId(pos.x, pos.y)));
    const pool = unvisited.length ? unvisited : candidates;
    const target = pool[randomInt(pool.length)];

    const id = cellId(target.x, target.y);
    const cell: any = await catMapCellColl.findOne({ _id: id } as any);
    let color: number | null = null;
    let previousCatId = 0;
    let claimed = false;
    if (cell && Number.isSafeInteger(cell.color)) {
        color = cell.color;
        previousCatId = normalizedCatId(cell.catId);
        if (previousCatId !== ownCatId || Number(cell.updatedBy) !== uid) {
            await catMapCellColl.updateOne(
                { _id: id, color: cell.color } as any,
                {
                    $set: {
                        catId: ownCatId,
                        updatedBy: uid,
                        updatedAt: now,
                    },
                } as any,
            );
            if (previousCatId !== ownCatId) await moveTerritoryCount(previousCatId, ownCatId, now);
            claimed = true;
        }
    }

    const nextVisited = [...visited, id].slice(-MAX_VISITED);
    const wildcatNextAt = new Date(now.getTime() + WILD_CAT_INTERVAL_MS);
    await catMapPlayerColl.updateOne(
        { _id: uid, wildcat: true } as any,
        {
            $set: {
                x: target.x,
                y: target.y,
                movedAt: now,
                updatedAt: now,
                wildcatNextAt,
                wildcatVisited: nextVisited,
            },
        } as any,
    );
    try {
        await addLog({
            type: 'cat_map',
            userId: uid,
            sender: uid,
            action: 'wildcat_move',
            fromX: currentX,
            fromY: currentY,
            x: target.x,
            y: target.y,
            color,
            catId: ownCatId,
            reason: claimed
                ? `野猫模式从 (${currentY}, ${currentX}) 走到 (${target.y}, ${target.x})，`
                    + `为 #${user.school_cat} 抢下 1 格`
                : `野猫模式从 (${currentY}, ${currentX}) 走到 (${target.y}, ${target.x})`,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log wildcat move:', e);
    }
    return {
        uid,
        uname: String(user.uname || `UID ${uid}`),
        x: target.x,
        y: target.y,
        color,
        catId: ownCatId,
        schoolId: Number(user.school_cat),
        previousCatId,
        claimed,
        cans: Math.max(0, Math.floor(Number(user.cat_can) || 0)),
        food: Math.max(0, Number(user.cat_food) || 0),
        availableAt: player.availableAt || null,
        wildcatNextAt,
    };
}

export async function runWildCats(now = new Date()) {
    const players: any[] = await catMapPlayerColl.find({
        wildcat: true,
        wildcatNextAt: { $lte: now },
    } as any).sort({ _id: 1 }).limit(MAX_PER_RUN).toArray();
    const events: WildCatMoveEvent[] = [];
    for (const player of players) {
        const event = await runOne(player, now);
        if (event) events.push(event);
    }
    return { due: players.length, events };
}
