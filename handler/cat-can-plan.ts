import { ForbiddenError, Handler, Types, param } from 'hydrooj';
import { oi33Model } from '../model';

// 路径规划（计划）的 HTTP 端点：保存/追加、取消、兜底状态同步。计划本身的
// 执行与校验在 model/cat-map-plan.ts，这里只做请求解析与广播。

// A planned route only stays valid while the cat walks it step by step, so any
// manual move/paint stops the plan right away (the reason is shown on the map
// and the plan panel). Returns null when there was no active plan.
export async function stopCatMapPlanAfterManualAction(ctx: any, uid: number, reason: string) {
    try {
        const stopped = await oi33Model.stopCatMapPlan(uid, reason, { auto: false });
        if (!stopped) return null;
        for (const event of stopped.events) ctx.broadcast('oi33/cat-map-change', event);
        return stopped;
    } catch (e) {
        console.error('[oi33] failed to stop cat map plan after manual action:', e);
        return null;
    }
}

export class CatMapPlanHandler extends Handler {
    @param('steps', Types.String)
    @param('mode', Types.String, true)
    async post(domainId: string, steps: string, mode = 'replace') {
        if (mode !== 'replace' && mode !== 'append') throw new ForbiddenError('计划模式无效。');
        let parsed: any;
        try {
            parsed = JSON.parse(steps);
        } catch {
            throw new ForbiddenError('计划数据格式不正确。');
        }
        try {
            const saved = await oi33Model.saveCatMapPlan(this.user._id, parsed, mode as any);
            for (const event of saved.events) (this.ctx as any).broadcast('oi33/cat-map-change', event);
            this.response.type = 'application/json';
            this.response.body = { ok: true, plan: saved.plan, result: saved.result };
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '保存计划失败。');
        }
    }
}

export class CatMapPlanCancelHandler extends Handler {
    async post() {
        try {
            const stopped = await oi33Model.stopCatMapPlan(this.user._id, '你取消了路径计划。', { auto: false });
            if (stopped) {
                for (const event of stopped.events) (this.ctx as any).broadcast('oi33/cat-map-change', event);
            }
            this.response.type = 'application/json';
            this.response.body = {
                ok: true,
                plan: stopped?.plan || await oi33Model.getCatMapPlanView(this.user._id),
            };
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '取消计划失败。');
        }
    }
}

export class CatMapPlanStateHandler extends Handler {
    // 轻量计划视图：前端在计划到点却还没收到 WebSocket 推送时用它兜底同步，
    // 因此只返回自己的计划（私密数据）与服务器时间，不带地图与玩家快照。
    async get() {
        const [plan, config] = await Promise.all([
            oi33Model.getCatMapPlanView(this.user._id),
            oi33Model.getCatMapConfig(),
        ]);
        this.response.type = 'application/json';
        this.response.body = {
            ok: true,
            plan,
            planMaxSteps: config.planMaxSteps,
            serverTime: Date.now(),
        };
    }
}
