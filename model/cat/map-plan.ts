import { MessageModel, ObjectId } from 'hydrooj';
import {
    CAT_MAP_PLAN_LOCK_MS, CAT_MAP_PLAN_RETRY_DELAY_MS, CAT_MAP_PLAN_RETRY_LIMIT,
    boundCatIdOf, catMapConfigColl, catMapPlanColl, catMapPlayerColl, fortressCatIdAt,

} from './map';
import { moveCatMapPlayer, setCatMapCellColor } from './map-player';
import { getEligibleUser } from './eligibility';
import {
    CAT_MAP_PLAN_MAX_STEPS_DEFAULT, normalizeCatMapPlanMaxSteps, validateCatMapPlanShape,
} from './map-plan-rules';
import { logColl } from '../log';

// 纯校验/规范化在 ./cat-map-plan-rules（不依赖 hydrooj/DB，可单测）；这里再导出
// 以保持公开 API 不变。
export { normalizeCatMapPlanMaxSteps, validateCatMapPlanShape };

// 路径规划：一人一计划，由 index.ts 的 5 秒调度器在 nextAt 到期时推进。这里只
// 依赖 cat-map.ts 暴露的格子移动/染色与归属判定，不反向引用，避免循环依赖。

// --- 路径规划（计划） ------------------------------------------------------
// 一步 = 移动到相邻格（3g 猫粮）后立刻涂抹该格。计划由 index.ts 的 5 秒调度器
// 在 nextAt 到期时推进；任何一步失败（并发冲突重试 3 次后仍失败）即自动停止。
// 返回的事件对象与 handler/cat/can.ts 里广播的载荷形状一致，可直接 broadcast。

// 移动/涂色失败信息里带「请重试」的都是并发竞态（移动锁被占用），可以稍后重试。
const RETRYABLE_MOVE_ERROR = /请重试/;

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
