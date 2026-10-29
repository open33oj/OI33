import {
    Context, ForbiddenError, Handler, NotFoundError, PRIV, Types, ValidationError,
    param, query,
} from 'hydrooj';
import { oi33Model, userMedalColl } from '../model';
import { remainText } from '../model/auction';
import type { Oi33Auction } from '../model/types';
import { checkOi33Admin, checkUserFlag, loadOi33Users } from './utils';

function field(body: any, name: string): string {
    const value = body?.[name];
    return String(Array.isArray(value) ? value[0] : value ?? '').trim();
}

async function getViewerInfo(uid: number): Promise<{ flag: number; cans: number }> {
    if (!uid) return { flag: 0, cans: 0 };
    const data = (await oi33Model.getUserDataByUids([uid]))[uid];
    return { flag: data?.realname_flag ?? 0, cans: Number(data?.cat_can) || 0 };
}

async function buildUserDict(domainId: string, uids: number[]) {
    const unique = uids.filter((uid) => Number.isSafeInteger(uid) && uid > 0);
    return loadOi33Users(domainId, unique);
}

class AuctionListHandler extends Handler {
    @query('medal', Types.String, true)
    async get(domainId: string, preselect = '') {
        await oi33Model.auctionSettleExpired();
        const now = new Date();
        const [active, finished, medals] = await Promise.all([
            oi33Model.auctionListActive(now),
            oi33Model.auctionListRecentFinished(),
            oi33Model.medalList(),
        ]);
        const medalDict = Object.fromEntries(
            medals.map((medal) => [medal._id, medal]),
        );
        const viewer = await getViewerInfo(this.user._id);
        const uids: number[] = [];
        for (const auction of [...active, ...finished]) {
            if (auction.highestBidder) uids.push(auction.highestBidder);
            if (auction.winner) uids.push(auction.winner);
        }
        const udict = await buildUserDict(domainId, uids);
        // The create form only offers saleable medals that have never
        // been successfully auctioned and are not currently held.
        const rareRows = viewer.flag >= 2 ? await oi33Model.auctionSaleableShowcase() : [];
        const auctionable = rareRows.filter((row) => row.status === 'pending').map((row) => row.medal);
        // 用户拍卖：只列自己持有的「可交易成就」，且当前没有待处理合同。
        const offerable = viewer.flag >= 1
            ? await oi33Model.contractListSellableAwards(this.user._id)
            : [];
        const decorate = (auction: Oi33Auction) => ({
            ...auction,
            remainText: auction.status === 'active' ? remainText(auction.endAt, now) : '',
        });
        this.response.template = 'oi33_auction_list.html';
        this.response.body = {
            active: active.map(decorate),
            finished: finished.map(decorate),
            medalDict,
            udict,
            canManage: viewer.flag >= 2,
            viewerFlag: viewer.flag,
            medals: auctionable,
            offerable,
            canOffer: viewer.flag >= 1 && offerable.length > 0,
            sellerFeePercent: 5,
            userAuctionDays: 7,
            preselect,
            viewerCans: viewer.cans,
        };
    }
}

class AuctionDetailHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        let auction = await oi33Model.auctionGet(id);
        if (!auction) throw new NotFoundError(id);
        if (auction.status === 'active') {
            const settled = await oi33Model.auctionSettle(id);
            if (settled) auction = settled;
        }
        // 奖章定义可能已被删除（历史拍卖保留可读，且管理员仍需能打开页面取消它）。
        const medal = (await oi33Model.medalGet(auction.medalId)) || {
            _id: auction.medalId,
            name: `${auction.medalId}（已删除）`,
            description: '该奖章定义已被删除。',
            rule: '—',
            imageData: '',
            saleable: false,
        };
        const now = new Date();
        const bids = await oi33Model.auctionGetBids(auction._id);
        const viewer = await getViewerInfo(this.user._id);
        const uids = bids.map((bid) => bid.uid);
        if (auction.highestBidder) uids.push(auction.highestBidder);
        if (auction.winner) uids.push(auction.winner);
        if (auction.seller) uids.push(auction.seller);
        const udict = await buildUserDict(domainId, uids);
        const viewerOwned = this.user._id
            ? !!(await userMedalColl.findOne({
                uid: this.user._id, medalId: auction.medalId,
            }))
            : false;
        const isSeller = auction.seller != null && auction.seller === this.user._id;
        this.response.template = 'oi33_auction_detail.html';
        this.response.body = {
            auction,
            medal,
            bids,
            udict,
            now,
            remainText: auction.status === 'active' ? remainText(auction.endAt, now) : '',
            minBid: auction.highestBid != null ? auction.highestBid + 1 : auction.startPrice,
            canManage: viewer.flag >= 2 || isSeller,
            // 用户拍卖禁止取消（卖家/管理员都不行），只能到期流拍。
            canCancel: viewer.flag >= 2 && auction.seller == null,
            isSeller,
            canBid: viewer.flag >= 1 && auction.status === 'active' && !viewerOwned
                && !isSeller && auction.highestBidder !== this.user._id,
            sellerFeePercent: 5,
            viewerOwned,
            viewerCans: viewer.cans,
        };
    }
}

class AuctionBidHandler extends Handler {
    @param('id', Types.String)
    async post(domainId: string, id: string) {
        if ((await checkUserFlag(this.user._id)) < 1) {
            throw new ForbiddenError('只有通过认证的用户才能参与拍卖出价。');
        }
        const amount = Number(field(this.request.body, 'amount'));
        await oi33Model.auctionBid(id, this.user._id, amount);
        this.response.redirect = this.url('oi33_auction_detail', {
            id, query: { notification: '出价成功' },
        });
    }
}

class AuctionCreateHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const medalId = field(body, 'medalId');
        const startPrice = Number(field(body, 'startPrice'));
        const hours = Number(field(body, 'hours'));
        if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
            throw new ValidationError('拍卖时长应在 1–720 小时之间。');
        }
        await oi33Model.auctionCreate({
            medalId,
            startPrice,
            durationMs: Math.round(hours * 3600 * 1000),
            operator: this.user._id,
        });
        this.response.redirect = this.url('oi33_auction');
    }
}

class AuctionOfferHandler extends Handler {
    async post() {
        if ((await checkUserFlag(this.user._id)) < 1) {
            throw new ForbiddenError('只有通过认证的用户才能发起拍卖。');
        }
        const body = this.request.body as any;
        const medalId = field(body, 'medalId');
        const startPrice = Number(field(body, 'startPrice'));
        const auction = await oi33Model.auctionOffer({
            medalId,
            seller: this.user._id,
            startPrice,
        });
        this.response.redirect = this.url('oi33_auction_detail', {
            id: auction._id,
            query: { notification: '拍卖已上架，固定 7 天，成交后收取 5%（向上取整）手续费。' },
        });
    }
}

class AuctionCancelHandler extends Handler {
    @param('id', Types.String)
    async post(domainId: string, id: string) {
        const auction = await oi33Model.auctionGet(id);
        if (!auction) throw new NotFoundError(id);
        if (auction.seller !== this.user._id) await checkOi33Admin(this.user._id);
        await oi33Model.auctionCancel(id, this.user._id);
        this.response.redirect = this.url('oi33_auction_detail', {
            id, query: { notification: '拍卖已取消，出价已退款，奖章已退回卖家。' },
        });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_auction', '/oi33/auction', AuctionListHandler);
    ctx.Route('oi33_auction_create', '/oi33/auction/create', AuctionCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_auction_offer', '/oi33/auction/offer', AuctionOfferHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_auction_detail', '/oi33/auction/:id', AuctionDetailHandler);
    ctx.Route('oi33_auction_bid', '/oi33/auction/:id/bid', AuctionBidHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_auction_cancel', '/oi33/auction/:id/cancel', AuctionCancelHandler, PRIV.PRIV_USER_PROFILE);
}
