import {
    ConnectionHandler, Context, ForbiddenError, Handler, PRIV, Types, UserModel, param, subscribe,
} from 'hydrooj';
import { oi33Model } from '../model';
import { checkUserFlag } from './utils';

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
        this.response.body = data;
    }
}

class CatCanArenaHandler extends Handler {
    async get() {
        const role = this.user._id ? await checkUserFlag(this.user._id) : 0;
        this.response.template = 'oi33_cat_can_arena.html';
        this.response.body = {
            loggedIn: !!this.user._id,
            canPaint: role >= 3,
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
    return {
        width: 640,
        height: 480,
        players,
        cells: snapshot.cells.map((cell: any) => [cell.x, cell.y, cell.color]),
        me,
        canJoin: !!viewerUid && !!snapshot.balances[viewerUid] && !me,
        serverTime: Date.now(),
    };
}

class CatMapStateHandler extends Handler {
    async get() {
        this.response.type = 'application/json';
        this.response.body = await buildCatMapState(this.user._id || 0);
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
            this.response.type = 'application/json';
            this.response.body = { ok: true, ...result };
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
            const payload = { type: 'cell', cell: [result.x, result.y, result.color] };
            (this.ctx as any).broadcast('oi33/cat-map-change', payload);
            (this.ctx as any).broadcast('oi33/cat-map-change', {
                type: 'cooldown',
                uid: this.user._id,
                availableAt: result.availableAt,
                freeColorAvailable: result.freeColorAvailable,
            });
            this.response.type = 'application/json';
            this.response.body = { ok: true, ...result };
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '设置颜色失败。');
        }
    }
}

class CatMapAdminHandler extends Handler {
    async get() {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以使用地图绘图后台。');
        this.response.template = 'oi33_cat_map_admin.html';
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
                rect: [result.rowStart, result.columnStart, result.rowEnd, result.columnEnd, result.color],
            });
            this.response.redirect = this.url('oi33_cat_map_admin', {
                query: { notification: `绘图完成：已修改 ${result.count} 个像素。` },
            });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '管理员绘图失败。');
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
        this.send(payload);
    }
}

class CatCanBuyHandler extends Handler {
    @param('quantity', Types.PositiveInt)
    async post(domainId: string, quantity: number) {
        try {
            const result = await oi33Model.buyCatCans(this.user._id, quantity);
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
        try {
            const result = await oi33Model.sellCatCans(this.user._id, quantity);
            const notification = `成功卖出 ${result.quantity} 个猫罐头，实际到账 ${oi33Model.formatCatFood(result.received)}（手续费 ${oi33Model.formatCatFood(result.fee)}）；下次可交易：${formatNextTradeAt(result.nextTradeAt)}`;
            this.response.redirect = this.url('oi33_cat_can', { query: { notification } });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '卖出失败。');
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_cat_can', '/oi33/cat-can', CatCanMarketHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_can_arena', '/oi33/arena', CatCanArenaHandler);
    ctx.Route('oi33_cat_map_state', '/oi33/arena/state', CatMapStateHandler);
    ctx.Route('oi33_cat_map_join', '/oi33/arena/join', CatMapJoinHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_move', '/oi33/arena/move', CatMapMoveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_color', '/oi33/arena/color', CatMapColorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_admin', '/oi33/cat-arena/admin', CatMapAdminHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_map_admin_relocate', '/oi33/cat-arena/admin/relocate', CatMapAdminRelocateHandler, PRIV.PRIV_USER_PROFILE);
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
