import {
    Context, ForbiddenError, Handler, NotFoundError, PRIV, Types, UserModel, ValidationError,
    param, query,
} from 'hydrooj';
import { oi33Model, userAchievementColl } from '../model';
import type { Oi33Auction } from '../model/types';
import { checkOi33Admin, checkUserFlag } from './utils';

function field(body: any, name: string): string {
    const value = body?.[name];
    return String(Array.isArray(value) ? value[0] : value ?? '').trim();
}

async function getViewerInfo(uid: number): Promise<{ flag: number; cans: number }> {
    if (!uid) return { flag: 0, cans: 0 };
    const data = (await oi33Model.getUserDataByUids([uid]))[uid];
    return { flag: data?.realname_flag ?? 0, cans: Number(data?.cat_can) || 0 };
}

export function remainText(endAt: Date, now: Date): string {
    const ms = endAt.getTime() - now.getTime();
    if (ms <= 0) return '已结束';
    const minutes = Math.floor(ms / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;
    if (days) return `${days} 天 ${hours} 小时`;
    if (hours) return `${hours} 小时 ${rest} 分钟`;
    return `${Math.max(1, rest)} 分钟`;
}

async function buildUserDict(domainId: string, uids: number[]) {
    const unique = [...new Set(uids.filter((uid) => Number.isSafeInteger(uid) && uid > 0))];
    if (!unique.length) return {};
    const udict = await UserModel.getList(domainId, unique);
    const oi33Data = await oi33Model.getUserDataByUids(unique);
    for (const uid of unique) {
        if (udict[uid] && oi33Data[uid]) oi33Model.mergeOi33Fields(udict[uid], oi33Data[uid]);
    }
    return udict;
}

class AuctionListHandler extends Handler {
    @query('achievement', Types.String, true)
    async get(domainId: string, preselect = '') {
        await oi33Model.auctionSettleExpired();
        const now = new Date();
        const [active, finished, achievements] = await Promise.all([
            oi33Model.auctionListActive(now),
            oi33Model.auctionListRecentFinished(),
            oi33Model.achievementList(),
        ]);
        const achievementDict = Object.fromEntries(
            achievements.map((achievement) => [achievement._id, achievement]),
        );
        const viewer = await getViewerInfo(this.user._id);
        const uids: number[] = [];
        for (const auction of [...active, ...finished]) {
            if (auction.highestBidder) uids.push(auction.highestBidder);
            if (auction.winner) uids.push(auction.winner);
        }
        const udict = await buildUserDict(domainId, uids);
        const decorate = (auction: Oi33Auction) => ({
            ...auction,
            remainText: auction.status === 'active' ? remainText(auction.endAt, now) : '',
        });
        this.response.template = 'oi33_auction_list.html';
        this.response.body = {
            active: active.map(decorate),
            finished: finished.map(decorate),
            achievementDict,
            udict,
            canManage: viewer.flag >= 2,
            viewerFlag: viewer.flag,
            achievements,
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
        const achievement = await oi33Model.achievementGet(auction.achievementId);
        if (!achievement) throw new NotFoundError(auction.achievementId);
        const now = new Date();
        const bids = await oi33Model.auctionGetBids(auction._id);
        const viewer = await getViewerInfo(this.user._id);
        const uids = bids.map((bid) => bid.uid);
        if (auction.highestBidder) uids.push(auction.highestBidder);
        if (auction.winner) uids.push(auction.winner);
        const udict = await buildUserDict(domainId, uids);
        const viewerOwned = this.user._id
            ? !!(await userAchievementColl.findOne({
                uid: this.user._id, achievementId: auction.achievementId,
            }))
            : false;
        this.response.template = 'oi33_auction_detail.html';
        this.response.body = {
            auction,
            achievement,
            bids,
            udict,
            now,
            remainText: auction.status === 'active' ? remainText(auction.endAt, now) : '',
            minBid: auction.highestBid != null ? auction.highestBid + 1 : auction.startPrice,
            canManage: viewer.flag >= 2,
            canBid: viewer.flag >= 1 && auction.status === 'active' && !viewerOwned
                && auction.highestBidder !== this.user._id,
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
        const achievementId = field(body, 'achievementId');
        const startPrice = Number(field(body, 'startPrice'));
        const hours = Number(field(body, 'hours'));
        if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
            throw new ValidationError('拍卖时长应在 1–720 小时之间。');
        }
        await oi33Model.auctionCreate({
            achievementId,
            startPrice,
            durationMs: Math.round(hours * 3600 * 1000),
            operator: this.user._id,
        });
        this.response.redirect = this.url('oi33_auction');
    }
}

class AuctionCancelHandler extends Handler {
    @param('id', Types.String)
    async post(domainId: string, id: string) {
        await checkOi33Admin(this.user._id);
        await oi33Model.auctionCancel(id, this.user._id);
        this.response.redirect = this.url('oi33_auction_detail', { id });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_auction', '/oi33/auction', AuctionListHandler);
    ctx.Route('oi33_auction_create', '/oi33/auction/create', AuctionCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_auction_detail', '/oi33/auction/:id', AuctionDetailHandler);
    ctx.Route('oi33_auction_bid', '/oi33/auction/:id/bid', AuctionBidHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_auction_cancel', '/oi33/auction/:id/cancel', AuctionCancelHandler, PRIV.PRIV_USER_PROFILE);
}
