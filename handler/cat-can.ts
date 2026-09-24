import {
    ConnectionHandler, Context, ForbiddenError, Handler, PRIV, Types, UserModel, param, subscribe,
} from 'hydrooj';
import { medalColl, oi33Model } from '../model';
import { CAT_MAP_HEIGHT, CAT_MAP_WIDTH } from '../model/cat-map';
import { checkUserFlag } from './utils';
import { remainText } from '../model/auction';

function formatNextTradeAt(value: Date) {
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(value);
}

class CatCanMarketHandler extends Handler {
    async get() {
        const data = await oi33Model.getCatCanPage(this.user._id);
        this.response.template = 'oi33_cat_can.html';
        this.response.body = {
            ...data,
            canCalibrate: this.user._id ? await checkUserFlag(this.user._id) >= 3 : false,
        };
    }
}

class CatCanArenaHandler extends Handler {
    async get() {
        const role = this.user._id ? await checkUserFlag(this.user._id) : 0;
        const now = new Date();
        await oi33Model.auctionSettleExpired(now);
        const [activeAuctions, canQuote] = await Promise.all([
            oi33Model.auctionListActive(now),
            oi33Model.getCatCanDayChange(now),
        ]);
        const shown = activeAuctions.slice(0, 4);
        const medals = shown.length
            ? await medalColl.find({ _id: { $in: shown.map((auction) => auction.medalId) } }).toArray()
            : [];
        const medalDict = Object.fromEntries(
            medals.map((medal) => [medal._id, medal]),
        );
        const arenaAuctions = shown.map((auction) => ({
            ...auction,
            medal: medalDict[auction.medalId] || null,
            remainText: remainText(auction.endAt, now),
        }));
        this.response.template = 'oi33_cat_can_arena.html';
        this.response.body = {
            loggedIn: !!this.user._id,
            canPaint: role >= 3,
            canQuote,
            arenaAuctions,
        };
    }
}

class LegacyCatCanArenaHandler extends Handler {
    async get() {
        this.response.redirect = this.url('oi33_cat_can_arena');
    }
}

class LegacyCatMapAdminHandler extends Handler {
    async get() {
        this.response.redirect = this.url('oi33_cat_map_admin');
    }
}

async function buildCatMapState(viewerUid = 0) {
    const snapshot: any = await oi33Model.getCatMapSnapshot();
    const uids = snapshot.players.map((player: any) => player._id);
    const udict = uids.length ? await UserModel.getList('', uids) : {};
    const players = snapshot.players.map((player: any) => {
        const udoc = udict[player._id];
        if (!udoc) return null;
        const balance = snapshot.balances[player._id] || { food: 0, cans: 0 };
        return {
            uid: player._id,
            uname: udoc.uname || `UID ${player._id}`,
            x: player.x,
            y: player.y,
            cans: balance.cans,
            food: balance.food,
            availableAt: player.availableAt ? new Date(player.availableAt).getTime() : 0,
            freeColorAvailable: !!player.freeColorAvailable,
        };
    }).filter(Boolean);
    const me = viewerUid ? players.find((player: any) => player.uid === viewerUid) || null : null;
    // The planned route is private: only the viewer's own plan is ever returned,
    // and plan changes are broadcast with a targetUid that the socket handler
    // filters (see CatMapConnectionHandler.onMapChange).
    const config = await oi33Model.getCatMapConfig();
    const plan = viewerUid ? await oi33Model.getCatMapPlan(viewerUid) : null;
    return {
        width: CAT_MAP_WIDTH,
        height: CAT_MAP_HEIGHT,
        players,
        cells: snapshot.cells.map((cell: any) => [cell.x, cell.y, cell.color, Number(cell.catId) || 0]),
        me,
        canJoin: !!viewerUid && !!snapshot.balances[viewerUid] && !me,
        plan: oi33Model.buildCatMapPlanView(plan, config.planMaxSteps),
        planMaxSteps: config.planMaxSteps,
        serverTime: Date.now(),
    };
}

class CatMapStateHandler extends Handler {
    async get() {
        this.response.type = 'application/json';
        this.response.body = await buildCatMapState(this.user._id || 0);
    }
}

// A planned route only stays valid while the cat walks it step by step, so any
// manual move/paint stops the plan right away (the reason is shown on the map
// and the plan panel). Returns null when there was no active plan.
async function stopCatMapPlanAfterManualAction(ctx: any, uid: number, reason: string) {
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

class CatMapPlanHandler extends Handler {
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

class CatMapPlanCancelHandler extends Handler {
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

class CatMapPlanStateHandler extends Handler {
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

class CatMapMoveHandler extends Handler {
    @param('x', Types.Int)
    @param('y', Types.Int)
    async post(domainId: string, x: number, y: number) {
        try {
            const result = await oi33Model.moveCatMapPlayer(this.user._id, x, y);
            const payload = {
                type: 'player',
                player: {
                    uid: result.uid,
                    uname: this.user.uname || `UID ${this.user._id}`,
                    fromX: result.fromX,
                    fromY: result.fromY,
                    x: result.x,
                    y: result.y,
                    cans: result.cans,
                    food: result.food,
                    foodCost: result.foodCost,
                    canCost: result.canCost,
                    availableAt: result.availableAt,
                    freeColorAvailable: result.freeColorAvailable,
                },
            };
            (this.ctx as any).broadcast('oi33/cat-map-change', payload);
            if (result.contributedSchoolId !== null) {
                (this.ctx as any).broadcast('oi33/cat-map-change', {
                    type: 'bigcat', cat: { id: result.contributedSchoolId },
                });
            }
            this.response.type = 'application/json';
            const stoppedPlan = await stopCatMapPlanAfterManualAction(
                this.ctx, this.user._id, '你手动移动了小猫，路径连续性已破坏，计划已停止。',
            );
            this.response.body = { ok: true, ...result, planStopped: !!stoppedPlan };
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '移动失败。');
        }
    }
}

class CatMapJoinHandler extends Handler {
    @param('x', Types.Int)
    @param('y', Types.Int)
    async post(domainId: string, x: number, y: number) {
        try {
            const result = await oi33Model.joinCatMapPlayer(this.user._id, x, y);
            const payload = {
                type: 'player',
                player: {
                    uid: result.uid,
                    x: result.x,
                    y: result.y,
                    cans: result.cans,
                    food: result.food,
                    availableAt: result.availableAt,
                    freeColorAvailable: result.freeColorAvailable,
                    uname: this.user.uname || `UID ${this.user._id}`,
                },
            };
            (this.ctx as any).broadcast('oi33/cat-map-change', payload);
            this.response.type = 'application/json';
            this.response.body = { ok: true, ...result };
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '加入猫猫广场失败。');
        }
    }
}

class CatMapColorHandler extends Handler {
    @param('x', Types.Int)
    @param('y', Types.Int)
    @param('color', Types.Int)
    async post(domainId: string, x: number, y: number, color: number) {
        try {
            const result = await oi33Model.setCatMapCellColor(this.user._id, x, y, color);
            const payload = { type: 'cell', cell: [result.x, result.y, result.color, result.catId] };
            (this.ctx as any).broadcast('oi33/cat-map-change', payload);
            for (const moved of result.displaced || []) {
                (this.ctx as any).broadcast('oi33/cat-map-change', { type: 'player', player: moved });
            }
            if (result.territoryChanged) {
                (this.ctx as any).broadcast('oi33/cat-map-change', {
                    type: 'bigcat',
                    cat: { catId: result.catId },
                });
            }
            (this.ctx as any).broadcast('oi33/cat-map-change', {
                type: 'cooldown',
                uid: this.user._id,
                availableAt: result.availableAt,
                freeColorAvailable: result.freeColorAvailable,
            });
            this.response.type = 'application/json';
            const stoppedPlan = await stopCatMapPlanAfterManualAction(
                this.ctx, this.user._id, '你手动修改了格子颜色，路径连续性已破坏，计划已停止。',
            );
            this.response.body = { ok: true, ...result, planStopped: !!stoppedPlan };
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '设置颜色失败。');
        }
    }
}

class CatMapAdminHandler extends Handler {
    async get() {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以使用地图绘图后台。');
        const config = await oi33Model.getCatMapConfig();
        this.response.template = 'oi33_cat_map_admin.html';
        this.response.body = {
            planMaxSteps: config.planMaxSteps,
            planStepLimit: oi33Model.CAT_MAP_PLAN_MAX_STEPS_LIMIT,
        };
    }

    @param('mode', Types.String)
    @param('rowStart', Types.Int)
    @param('columnStart', Types.Int)
    @param('rowEnd', Types.Int, true)
    @param('columnEnd', Types.Int, true)
    @param('color', Types.Int)
    async post(
        domainId: string,
        mode: string,
        rowStart: number,
        columnStart: number,
        rowEnd: number | undefined,
        columnEnd: number | undefined,
        color: number,
    ) {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以使用地图绘图后台。');
        if (mode === 'single') {
            rowEnd = rowStart;
            columnEnd = columnStart;
        } else if (mode !== 'rectangle') throw new ForbiddenError('绘图模式无效。');
        try {
            const result = await oi33Model.adminPaintCatMap(
                this.user._id, rowStart, columnStart, rowEnd!, columnEnd!, color,
            );
            (this.ctx as any).broadcast('oi33/cat-map-change', {
                type: 'rect',
                rect: [result.rowStart, result.columnStart, result.rowEnd, result.columnEnd, result.color, result.catId],
            });
            (this.ctx as any).broadcast('oi33/cat-map-change', { type: 'bigcat', cat: { catId: result.catId } });
            this.response.redirect = this.url('oi33_cat_map_admin', {
                query: { notification: `绘图完成：已修改 ${result.count} 个像素。` },
            });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '管理员绘图失败。');
        }
    }
}

class CatMapAdminRefreshTerritoriesHandler extends Handler {
    async post() {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以更新全图的大猫归属。');
        try {
            const result = await oi33Model.refreshCatMapTerritories(this.user._id);
            (this.ctx as any).broadcast('oi33/cat-map-change', { type: 'territory_refresh' });
            this.response.redirect = this.url('oi33_cat_map_admin', {
                query: {
                    notification: `归属更新完成：处理 ${result.cellCount} 个有色格子，${result.catCount} 只大猫共占领 ${result.claimedCellCount} 格。`,
                },
            });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '更新全图大猫归属失败。');
        }
    }
}

class CatMapAdminSettingsHandler extends Handler {
    @param('planMaxSteps', Types.Int)
    async post(domainId: string, planMaxSteps: number) {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以修改地图配置。');
        try {
            const saved = await oi33Model.saveCatMapConfig({ planMaxSteps });
            this.response.redirect = this.url('oi33_cat_map_admin', {
                query: {
                    notification: `路径规划步数上限已设为 ${saved.planMaxSteps} 步（允许 1～${oi33Model.CAT_MAP_PLAN_MAX_STEPS_LIMIT}）。`,
                },
            });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '保存地图配置失败。');
        }
    }
}

class CatMapAdminRelocateHandler extends Handler {
    @param('uid', Types.Int)
    async post(domainId: string, uid: number) {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以强制迁移小猫。');
        try {
            const result = await oi33Model.adminRelocateCatMapPlayer(this.user._id, uid);
            const udict = await UserModel.getList('', [uid]);
            const udoc = udict[uid];
            (this.ctx as any).broadcast('oi33/cat-map-change', {
                type: 'player',
                player: {
                    ...result,
                    uname: udoc?.uname || `UID ${uid}`,
                },
            });
            // The forced move breaks the target's planned route as well.
            await stopCatMapPlanAfterManualAction(
                this.ctx, uid, '管理员强制迁移了你的小猫，计划已停止。',
            );
            this.response.redirect = this.url('oi33_cat_map_admin', {
                query: {
                    notification: `已将 UID ${uid} 的小猫随机迁移到（行 ${result.y}，列 ${result.x}）。`,
                },
            });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '强制迁移小猫失败。');
        }
    }
}

class CatMapConnectionHandler extends ConnectionHandler {
    async prepare() {
        this.send({ type: 'ready' });
    }

    @subscribe('oi33/cat-map-change')
    onMapChange(payload: any) {
        // Planned routes are private: events carrying a targetUid (plan create,
        // step, stop, finish) are only delivered to that user's connections.
        if (payload?.targetUid && Number(payload.targetUid) !== Number(this.user?._id)) return;
        this.send(payload);
    }
}

class CatCanBuyHandler extends Handler {
    @param('quantity', Types.PositiveInt)
    async post(domainId: string, quantity: number) {
        if (await checkUserFlag(this.user._id) < 1) throw new ForbiddenError('完成实名认证后才能购买猫罐头。');
        try {
            const result = await oi33Model.buyCatCans(this.user._id, quantity);
            await oi33Model.medalEvaluateUser(this.user._id, {
                ruleTypes: ['cat_can_balance'],
            }).catch((e) => console.error('[oi33] cat-can medal evaluation failed:', e));
            const notification = `成功买入 ${result.quantity} 个猫罐头，含手续费共支付 ${oi33Model.formatCatFood(result.total)}；下次可交易：${formatNextTradeAt(result.nextTradeAt)}`;
            this.response.redirect = this.url('oi33_cat_can', { query: { notification } });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '购买失败。');
        }
    }
}

class CatCanSellHandler extends Handler {
    @param('quantity', Types.PositiveInt)
    async post(domainId: string, quantity: number) {
        if (await checkUserFlag(this.user._id) < 1) throw new ForbiddenError('完成实名认证后才能卖出猫罐头。');
        try {
            const result = await oi33Model.sellCatCans(this.user._id, quantity);
            await oi33Model.medalEvaluateUser(this.user._id, {
                ruleTypes: ['cat_food_balance'],
            }).catch((e) => console.error('[oi33] cat-food medal evaluation failed:', e));
            const notification = `成功卖出 ${result.quantity} 个猫罐头，实际到账 ${oi33Model.formatCatFood(result.received)}（手续费 ${oi33Model.formatCatFood(result.fee)}）；下次可交易：${formatNextTradeAt(result.nextTradeAt)}`;
            this.response.redirect = this.url('oi33_cat_can', { query: { notification } });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '卖出失败。');
        }
    }
}

class CatCanCalibrateHandler extends Handler {
    async post() {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以校准罐头市场计数器。');
        try {
            const result = await oi33Model.calibrateCatCanPool(this.user._id);
            const notification = `已按账本校准罐头市场：流通 ${result.before.circulatingCans}→${result.after.circulatingCans} 个，`
                + `供应 ${result.before.virtualCanSupply}→${result.after.virtualCanSupply} 个，`
                + `储备 ${oi33Model.formatCatFood(result.before.reserveFood)}→${oi33Model.formatCatFood(result.after.reserveFood)}；`
                + `累计增发 ${result.minted}、销毁 ${result.burned} 个。`;
            this.response.redirect = this.url('oi33_cat_can', { query: { notification } });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '校准罐头市场失败。');
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_cat_can', '/oi33/cat-can', CatCanMarketHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_can_calibrate', '/oi33/cat-can/calibrate', CatCanCalibrateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_can_arena', '/oi33/arena', CatCanArenaHandler);
    ctx.Route('oi33_cat_map_state', '/oi33/arena/state', CatMapStateHandler);
    ctx.Route('oi33_cat_map_join', '/oi33/arena/join', CatMapJoinHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_move', '/oi33/arena/move', CatMapMoveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_color', '/oi33/arena/color', CatMapColorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_plan', '/oi33/arena/plan', CatMapPlanHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_plan_cancel', '/oi33/arena/plan/cancel', CatMapPlanCancelHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_plan_state', '/oi33/arena/plan/state', CatMapPlanStateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_admin', '/oi33/cat-arena/admin', CatMapAdminHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_admin_settings', '/oi33/cat-arena/admin/settings', CatMapAdminSettingsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_admin_relocate', '/oi33/cat-arena/admin/relocate', CatMapAdminRelocateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_admin_refresh_territories', '/oi33/cat-arena/admin/refresh-territories', CatMapAdminRefreshTerritoriesHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('oi33_cat_map_conn', '/oi33/arena/conn', CatMapConnectionHandler);
    ctx.Route('oi33_cat_can_arena_legacy', '/oi33/cat-can/arena', LegacyCatCanArenaHandler);
    ctx.Route('oi33_cat_map_admin_legacy', '/oi33/cat-can/arena/admin', LegacyCatMapAdminHandler);
    ctx.Route('oi33_cat_map_state_legacy', '/oi33/cat-can/arena/state', CatMapStateHandler);
    ctx.Route('oi33_cat_map_move_legacy', '/oi33/cat-can/arena/move', CatMapMoveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_color_legacy', '/oi33/cat-can/arena/color', CatMapColorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('oi33_cat_map_conn_legacy', '/oi33/cat-can/arena/conn', CatMapConnectionHandler);
    ctx.Route('oi33_cat_can_buy', '/oi33/cat-can/buy', CatCanBuyHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_can_sell', '/oi33/cat-can/sell', CatCanSellHandler, PRIV.PRIV_USER_PROFILE);
}
