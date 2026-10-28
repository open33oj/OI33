// 野猫模式（用户级）：加入猫猫广场并绑定了大猫的用户，可以让自己的小猫
// 在固定的偶数整点自动走一格、顺手抢占地盘。
//
// 规则：
//   - 只在 Asia/Shanghai 的偶数整点（00:00、02:00 … 22:00）检查一次；
//   - 四邻中优先扩张到还没归自己大猫的格子，其次没走过的，避开刚离开的格子；
//   - 只走相邻格，跳过其他大猫 00区核心；
//   - 仍然走普通移动的消耗与冷却：扣 3g 猫粮，冷却按罐头数量在 50~120 分钟；
//     整点检查时冷却未结束或猫粮不足就跳过这一轮；
//   - 到达有色格子时保持该格颜色，只把 catId 改成自己的大猫、updatedBy 改成自己
//     （个人占格数随之转移）；没涂色的格子染成 15 号白色后占领；
//   - 按 uid 升序结算；用户有正在执行的路径计划时跳过，避免打架。

import { db } from 'hydrooj';
import { addLog } from '../log';
import { userColl } from '../user';
import {
    CAT_MAP_MOVE_FOOD_COST, catMapCellColl, catMapPlayerColl, cellId,
    fortressCatIdAt, isCatMapCoreZone, normalizedCatId, validCoordinate,
} from './map';
import { moveCatMapPlayer, setCatMapCellColor } from './map-player';
import { schoolCatKey } from './school-shared';
import {
    WILD_CAT_NEW_CELL_COLOR, WILD_CAT_SLOT_MS, nextWildCatSlot, wildCatSlotStart,
} from './wildcat-rules';

export { WILD_CAT_NEW_CELL_COLOR, WILD_CAT_SLOT_MS } from './wildcat-rules';
// 兼容旧名字：仍然表示两次野猫检查之间的间隔。
export const WILD_CAT_INTERVAL_MS = WILD_CAT_SLOT_MS;

const MAX_VISITED = 4096;
const MAX_PER_RUN = 200;
const DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

function decodeCellId(id: string) {
    const [x, y] = String(id).split(':').map(Number);
    return { x, y };
}

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
    // 开启后从下一个偶数整点开始参与检查；关闭时清空待检查时间。
    const nextAt = enabled ? nextWildCatSlot(now) : null;
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
            reason: enabled
                ? '开启野猫模式：每个偶数整点自动尝试占地（消耗 3g 猫粮）'
                : '关闭野猫模式',
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
    painted: boolean;
    foodCost: number;
    cans: number;
    food: number;
    freeColorAvailable: boolean;
    availableAt: Date;
    wildcatNextAt: Date;
    displaced: any[];
}

async function runOne(
    player: any, now: Date, nextAt: Date,
): Promise<WildCatMoveEvent | null> {
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
        uid, status: 'active',
    } as any, { projection: { _id: 1 } });
    if (plan) return null;
    // 消耗与冷却和手动移动完全一致：冷却中或猫粮不足就跳过这个整点。
    if (player.availableAt && new Date(player.availableAt).getTime() > now.getTime()) return null;
    if (Math.max(0, Number(user.cat_food) || 0) < CAT_MAP_MOVE_FOOD_COST) return null;

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
    if (!candidates.length) return null;
    // 不只「没走过」：优先扩张到还没归自己大猫的格子，并避开刚离开的格子，
    // 否则在自家领地内随机走会来回绕圈。同分时再用一点随机量。
    const candidateIds = candidates.map((pos) => cellId(pos.x, pos.y));
    const candidateRows: any[] = await catMapCellColl.find(
        { _id: { $in: candidateIds } } as any,
        { projection: { catId: 1, color: 1, updatedAt: 1, updatedBy: 1 } } as any,
    ).toArray();
    const cellById = new Map(candidateRows.map((row) => [String(row._id), row]));
    const previousId = visited.length >= 2 ? visited[visited.length - 2] : null;
    let lastDx = 0;
    let lastDy = 0;
    if (visited.length >= 2) {
        const previous = decodeCellId(visited[visited.length - 2]);
        lastDx = currentX - previous.x;
        lastDy = currentY - previous.y;
    }
    const scored = candidates.map((pos) => {
        const candidateId = cellId(pos.x, pos.y);
        const candidateCell: any = cellById.get(candidateId);
        const candidateCatId = normalizedCatId(candidateCell?.catId);
        const expanding = candidateCatId !== ownCatId ? 100 : 0;
        const unvisitedScore = visitedSet.has(candidateId) ? 0 : 30;
        const forward = (pos.x - currentX === lastDx && pos.y - currentY === lastDy) ? 12 : 0;
        const backtrack = candidateId === previousId ? -200 : 0;
        return {
            pos,
            score: expanding + unvisitedScore + forward + backtrack + Math.random() * .1,
        };
    });
    scored.sort((a, b) => b.score - a.score);
    const target = scored[0].pos;
    const id = cellId(target.x, target.y);

    // 选格期间小猫可能被管理员迁移或另一个请求移动；确认仍在原格再走，
    // 避免 moveCatMapPlayer 把相邻移动误判成消耗罐头的传送。
    const livePlayer: any = await catMapPlayerColl.findOne({ _id: uid } as any);
    if (!livePlayer
        || Number(livePlayer.x) !== currentX
        || Number(livePlayer.y) !== currentY) return null;

    // 真正移动：扣 3g 猫粮、按罐头数量计算冷却、写账本日志、更新位置，
    // 并赠送一次免冷却染色（下面立刻用它完成占地）。
    let moveResult: any = null;
    try {
        moveResult = await moveCatMapPlayer(uid, target.x, target.y, now);
    } catch (e: any) {
        const message = String(e?.message || e);
        // 冷却/缺粮/核心格/并发冲突都是正常的「这一轮不走」，不刷错误日志。
        if (!/冷却中|猫粮不足|领地核心|已经在这个格子|请重试|刚刚发生变化/.test(message)) {
            console.error(`[oi33] wildcat move failed for uid ${uid}:`, e);
        }
        return null;
    }

    // 一次标准染色事件完成占地：先读取目标格当前颜色，有色格原样再染一次，
    // 无色格染 15 号白色；归属、领地计数、核心驱逐与日志都交给
    // setCatMapCellColor，不再单独维护一套格子写入逻辑。
    const targetCell: any = await catMapCellColl.findOne(
        { _id: id } as any,
        { projection: { color: 1 } } as any,
    );
    const color = targetCell && Number.isSafeInteger(targetCell.color)
        ? Number(targetCell.color)
        : WILD_CAT_NEW_CELL_COLOR;
    let colorResult: any = null;
    try {
        colorResult = await setCatMapCellColor(uid, target.x, target.y, color, now);
    } catch (e) {
        // 已经完成移动并扣费；染色失败时移动附带的免冷却染色会保留给用户手动补色。
        console.error(`[oi33] wildcat color failed for uid ${uid}:`, e);
    }
    const nextVisited = [...visited, id].slice(-MAX_VISITED);
    await catMapPlayerColl.updateOne(
        { _id: uid, wildcat: true } as any,
        { $set: { wildcatVisited: nextVisited, updatedAt: now } } as any,
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
            color: colorResult?.color ?? null,
            catId: colorResult?.catId ?? ownCatId,
            foodCost: moveResult.foodCost,
            reason: colorResult?.territoryChanged
                ? `野猫模式从 (${currentY}, ${currentX}) 走到 (${target.y}, ${target.x})，`
                    + `为 #${user.school_cat} 抢下 1 格`
                : colorResult
                    ? `野猫模式从 (${currentY}, ${currentX}) 走到 (${target.y}, ${target.x})`
                    : `野猫模式走到 (${target.y}, ${target.x})，但染色失败，未完成占地`,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log wildcat move:', e);
    }

    return {
        uid,
        uname: String(user.uname || `UID ${uid}`),
        x: target.x,
        y: target.y,
        color: colorResult?.color ?? null,
        catId: colorResult?.catId ?? ownCatId,
        schoolId: Number(user.school_cat),
        previousCatId: colorResult?.previousCatId ?? 0,
        claimed: !!colorResult?.territoryChanged,
        painted: !!colorResult,
        foodCost: moveResult.foodCost,
        cans: Math.max(0, Math.floor(Number(moveResult.cans) || 0)),
        food: Math.max(0, Number(moveResult.food) || 0),
        freeColorAvailable: !colorResult,
        availableAt: colorResult?.availableAt
            ? new Date(colorResult.availableAt)
            : moveResult.availableAt ? new Date(moveResult.availableAt) : now,
        wildcatNextAt: nextAt,
        displaced: colorResult?.displaced || [],
    };
}

export async function runWildCats(now = new Date()) {
    // 只结算「当前偶数整点槽位」到期的野猫。槽位内每只野猫只检查一次：先原子
    // 推进 wildcatNextAt 再执行，避免 10 分钟调度器在同一槽位里重复尝试。
    const slot = wildCatSlotStart(now);
    const nextAt = nextWildCatSlot(now);
    const players: any[] = await catMapPlayerColl.find({
        wildcat: true,
        wildcatNextAt: { $lte: slot },
    } as any).sort({ _id: 1 }).limit(MAX_PER_RUN).toArray();
    const events: WildCatMoveEvent[] = [];
    let checked = 0;
    for (const player of players) {
        const claimed = await catMapPlayerColl.updateOne({
            _id: player._id,
            wildcat: true,
            wildcatNextAt: { $lte: slot },
        } as any, {
            $set: { wildcatNextAt: nextAt, updatedAt: now },
        });
        if (!claimed.modifiedCount) continue;
        checked++;
        const event = await runOne(player, now, nextAt);
        if (event) events.push(event);
    }
    return { due: players.length, checked, events };
}
