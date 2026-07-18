import {
    Context, ForbiddenError, Handler, PRIV, Types, param,
} from 'hydrooj';
import { oi33Model } from '../model';

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
    ctx.Route('oi33_cat_can_buy', '/oi33/cat-can/buy', CatCanBuyHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_can_sell', '/oi33/cat-can/sell', CatCanSellHandler, PRIV.PRIV_USER_PROFILE);
}
