import {
    db, NotFoundError, ObjectId, ValidationError,
} from 'hydrooj';
import type { Oi33Auction } from './types';
import { addLog } from './log';
import { medalColl, medalGrant, userMedalColl } from './medal';
import { catCanPoolColl, ensureCurrentCatCanPrice } from './cat-can';
import { userColl } from './user';

export const auctionColl = db.collection('oi33_auction');
export const auctionBidColl = db.collection('oi33_auction_bid');
export const AUCTION_BID_EXTENSION_MS = 60 * 1000;

// Human-readable remaining time, shared by the auction pages and the medal
// catalogue (which surfaces the live auction of each saleable medal).
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

export async function ensureAuctionIndexes() {
    await Promise.all([
        auctionColl.createIndex({ status: 1, endAt: 1 }),
        auctionColl.createIndex({ medalId: 1, status: 1 }),
        auctionColl.createIndex({ createdAt: -1 }),
        auctionBidColl.createIndex({ auctionId: 1, createdAt: -1 }),
    ]);
}

export async function auctionGet(id: string | ObjectId) {
    let objectId: ObjectId;
    try {
        objectId = typeof id === 'string' ? new ObjectId(id) : id;
    } catch {
        return null;
    }
    return await auctionColl.findOne({ _id: objectId });
}

export async function auctionCreate(input: {
    medalId: string;
    startPrice: number;
    durationMs: number;
    operator: number;
}) {
    const medal = await medalColl.findOne({ _id: input.medalId });
    if (!medal) throw new ValidationError('奖章不存在。');
    if (!medal.saleable) throw new ValidationError('只有「可售卖奖章」才能拍卖。');
    if (!Number.isSafeInteger(input.startPrice) || input.startPrice < 1) {
        throw new ValidationError('起拍价必须是不少于 1 的整数个猫罐头。');
    }
    // Rare medals are unique and auctioned at most once: after a
    // successful sale they can only change hands via trade contracts.
    const [settled, held] = await Promise.all([
        auctionColl.findOne({ medalId: input.medalId, status: 'settled', winner: { $ne: null } }),
        userMedalColl.findOne({
            medalId: input.medalId, source: { $in: ['auction', 'contract'] },
        }),
    ]);
    if (settled || held) {
        throw new ValidationError('该奖章已经拍卖过。可售卖奖章只拍卖一次，之后只能通过交易合同转让。');
    }
    const running = await auctionColl.findOne({
        medalId: input.medalId, status: 'active',
    });
    if (running) throw new ValidationError('该奖章已有进行中的拍卖，结束后才能再次上架。');
    const now = new Date();
    const scheduledEndAt = new Date(now.getTime() + input.durationMs);
    const doc: Oi33Auction = {
        _id: new ObjectId(),
        medalId: input.medalId,
        startPrice: input.startPrice,
        startAt: now,
        scheduledEndAt,
        endAt: scheduledEndAt,
        createdBy: input.operator,
        createdAt: now,
        status: 'active',
        highestBid: null,
        highestBidder: null,
        bidCount: 0,
    };
    await auctionColl.insertOne(doc as any);
    await addLog({
        type: 'auction', userId: input.operator, action: 'create',
        auctionId: doc._id.toHexString(), medalId: doc.medalId,
        amount: doc.startPrice,
    } as any);
    return doc;
}

async function auctionRefund(uid: number, amount: number, auctionId: ObjectId, reason: string) {
    await userColl.updateOne({ _id: uid }, { $inc: { cat_can: amount } }, { upsert: true });
    await addLog({
        type: 'auction', userId: uid, action: 'refund',
        auctionId: auctionId.toHexString(), amount, reason,
    } as any);
    // Account-page ledger: the refunded cans return to the user balance. They
    // were escrowed out of circulation accounting on the bid, so this entry is
    // excluded from the can-flow economy stats.
    await addLog({
        type: 'cat_account', userId: uid, sender: uid,
        action: 'auction_refund', amount: 0, canAmount: amount,
        reason: `拍卖退款（${reason}）`,
    } as any);
}

export async function auctionBid(id: string | ObjectId, uid: number, amount: number, now = new Date()) {
    const auction = await auctionGet(id);
    if (!auction) throw new NotFoundError(String(id));
    if (auction.status !== 'active') throw new ValidationError('拍卖已结束。');
    if (now.getTime() >= auction.endAt.getTime()) {
        await auctionSettle(auction._id, now);
        throw new ValidationError('拍卖已结束。');
    }
    if (auction.highestBidder === uid) throw new ValidationError('你已经是当前最高出价者。');
    if (!Number.isSafeInteger(amount) || amount < 1) throw new ValidationError('出价无效。');
    const owned = await userMedalColl.findOne({ uid, medalId: auction.medalId });
    if (owned) throw new ValidationError('你已经拥有这个奖章，无需竞拍。');
    const minBid = auction.highestBid != null ? auction.highestBid + 1 : auction.startPrice;
    if (amount < minBid) throw new ValidationError(`出价至少需要 ${minBid} 个猫罐头。`);

    // Escrow: deduct the full bid up front; the previous leader is refunded.
    const deducted = await userColl.updateOne(
        { _id: uid, cat_can: { $gte: amount } },
        { $inc: { cat_can: -amount } },
    );
    if (!deducted.modifiedCount) throw new ValidationError('猫罐头不足，无法出价。');
    // Return the pre-update doc so the refund below targets the leader that
    // was actually displaced by THIS update. Refunding from the stale read
    // above races concurrent bids: two bidders reading the same state can both
    // win the atomic filter in turn, and the intermediate leader's escrow
    // would never be refunded.
    const bidDeadline = new Date(now.getTime() + AUCTION_BID_EXTENSION_MS);
    const previous = await auctionColl.findOneAndUpdate(
        {
            _id: auction._id,
            status: 'active',
            endAt: { $gt: now },
            highestBidder: { $ne: uid },
            $or: [{ highestBid: null }, { highestBid: { $lt: amount } }],
        },
        {
            $set: { highestBid: amount, highestBidder: uid },
            // `endAt` remains max(administrator deadline, last bid + 1 min).
            // $max also keeps concurrent bids from shortening either value.
            $max: { endAt: bidDeadline, lastBidAt: now },
            $inc: { bidCount: 1 },
        },
        { returnDocument: 'before' },
    );
    if (!previous) {
        await auctionRefund(uid, amount, auction._id, '出价未生效');
        const latest = await auctionColl.findOne({ _id: auction._id });
        if (!latest || latest.status !== 'active' || latest.endAt.getTime() <= now.getTime()) {
            if (latest?.status === 'active') await auctionSettle(auction._id, now);
            throw new ValidationError('拍卖已结束。');
        }
        if (latest.highestBidder === uid) throw new ValidationError('你已经是当前最高出价者。');
        throw new ValidationError(`出价至少需要 ${(latest.highestBid ?? 0) + 1} 个猫罐头。`);
    }
    await auctionBidColl.insertOne({
        _id: new ObjectId(), auctionId: auction._id, uid, amount, createdAt: now,
    } as any);
    await addLog({
        type: 'auction', userId: uid, action: 'bid',
        auctionId: auction._id.toHexString(), medalId: auction.medalId, amount,
    } as any);
    // Account-page ledger: the bid is escrowed out of the user balance but
    // stays in circulation (the pool counter is untouched), so this entry is
    // excluded from the can-flow economy stats; the settled outcome is
    // counted from the type:'auction' settle log.
    await addLog({
        type: 'cat_account', userId: uid, sender: uid,
        action: 'auction_bid', amount: 0, canAmount: -amount,
        reason: '奖章拍卖出价托管',
    } as any);
    if (previous.highestBidder != null && previous.highestBid != null) {
        await auctionRefund(previous.highestBidder, previous.highestBid, auction._id, '被更高出价超越');
    }
    return await auctionColl.findOne({ _id: auction._id });
}

// Lazy settlement: called whenever an auction is viewed or bid on after its
// end time. The atomic status flip guarantees only one caller settles.
export async function auctionSettle(id: string | ObjectId, now = new Date()) {
    const auction = await auctionGet(id);
    if (!auction || auction.status !== 'active') return auction;
    if (auction.endAt.getTime() > now.getTime()) return auction;
    // Include the deadline in the atomic flip. A last-moment bid can extend
    // endAt after our initial read; in that race settlement must lose.
    const settledAuction = await auctionColl.findOneAndUpdate(
        { _id: auction._id, status: 'active', endAt: { $lte: now } },
        { $set: { status: 'settled', settledAt: now } },
        { returnDocument: 'before' },
    );
    if (!settledAuction) return await auctionColl.findOne({ _id: auction._id });
    if (settledAuction.highestBidder != null && settledAuction.highestBid != null) {
        try {
            await medalGrant(settledAuction.highestBidder, settledAuction.medalId, 0, 'auction', true);
            // The winning cans return to the AMM pool, and the pool burns
            // reserve food equal to their current sell value — exactly as if
            // the winner sold the cans back and the proceeds were destroyed
            // (no fee, no cooldown). This makes auctions a cat-food sink.
            const market: any = await ensureCurrentCatCanPrice(now);
            const pool: any = await catCanPoolColl.findOne({ _id: 'main' });
            const foodBurn = Math.min(
                Math.max(0, Number(pool?.reserveFood) || 0),
                settledAuction.highestBid * Math.max(0, Number(market?.sellPrice) || 0),
            );
            const poolUpdated = await catCanPoolColl.updateOne(
                { _id: 'main', reserveFood: { $gte: foodBurn } },
                {
                    $inc: { reserveFood: -foodBurn, circulatingCans: -settledAuction.highestBid },
                    $set: { updatedAt: now },
                },
            );
            if (!poolUpdated.modifiedCount) {
                // The reserve moved concurrently; never leave the cans stuck.
                await catCanPoolColl.updateOne(
                    { _id: 'main' },
                    { $inc: { circulatingCans: -settledAuction.highestBid }, $set: { updatedAt: now } },
                );
            }
            await auctionColl.updateOne(
                { _id: auction._id },
                { $set: { winner: settledAuction.highestBidder, settlePrice: settledAuction.highestBid, foodBurn } },
            );
            await addLog({
                type: 'auction', userId: settledAuction.highestBidder, action: 'settle',
                auctionId: auction._id.toHexString(), medalId: settledAuction.medalId,
                amount: settledAuction.highestBid, foodBurn,
            } as any);
        } catch (e) {
            // Never leave the escrowed cans stuck: if the grant fails (e.g.
            // the medal was deleted mid-auction) refund the leader.
            console.error(`[oi33] auction settle grant failed for ${auction._id}:`, e);
            await auctionRefund(settledAuction.highestBidder, settledAuction.highestBid, auction._id, '结算失败退款');
        }
    } else {
        await addLog({
            type: 'auction', userId: settledAuction.createdBy, action: 'settle_unsold',
            auctionId: auction._id.toHexString(), medalId: settledAuction.medalId,
        } as any);
    }
    return await auctionColl.findOne({ _id: auction._id });
}

export async function auctionSettleExpired(now = new Date()) {
    const expired = await auctionColl.find({
        status: 'active', endAt: { $lte: now },
    }, { projection: { _id: 1 } }).toArray();
    for (const auction of expired) {
        try {
            await auctionSettle(auction._id, now);
        } catch (e) {
            console.error(`[oi33] auction settle failed for ${auction._id}:`, e);
        }
    }
    return expired.length;
}

export async function auctionCancel(id: string | ObjectId, operator: number, now = new Date()) {
    const auction = await auctionGet(id);
    if (!auction) throw new NotFoundError(String(id));
    if (auction.status !== 'active') throw new ValidationError('拍卖已结束。');
    // Refund the leader captured by the same atomic status change. A bid may
    // otherwise land between the read above and cancellation, leaving its
    // newer escrow unrefunded.
    const cancelledAuction = await auctionColl.findOneAndUpdate(
        { _id: auction._id, status: 'active' },
        { $set: { status: 'cancelled', cancelledAt: now, cancelledBy: operator } },
        { returnDocument: 'before' },
    );
    if (!cancelledAuction) throw new ValidationError('拍卖已结束。');
    if (cancelledAuction.highestBidder != null && cancelledAuction.highestBid != null) {
        await auctionRefund(
            cancelledAuction.highestBidder,
            cancelledAuction.highestBid,
            auction._id,
            '拍卖已取消',
        );
    }
    await addLog({
        type: 'auction', userId: operator, action: 'cancel',
        auctionId: auction._id.toHexString(), medalId: auction.medalId,
    } as any);
    return await auctionColl.findOne({ _id: auction._id });
}

export async function auctionListActive(now = new Date()) {
    return await auctionColl.find({ status: 'active', endAt: { $gt: now } })
        .sort({ endAt: 1 }).toArray();
}

export async function auctionListRecentFinished(limit = 20) {
    return await auctionColl.find({ status: { $in: ['settled', 'cancelled'] } })
        .sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function auctionGetBids(auctionId: ObjectId, limit = 50) {
    return await auctionBidColl.find({ auctionId })
        .sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
}

// Saleable medals (可售卖奖章) are unique: auctioned at most once, afterwards
// they can only change hands via trade contracts. Each row reports who holds
// the single copy, or that it is on/awaiting its one auction.
export async function auctionSaleableShowcase() {
    const medals = await medalColl.find({ saleable: true }).toArray();
    if (!medals.length) return [];
    const ids = medals.map((medal) => medal._id);
    const [awards, auctions] = await Promise.all([
        userMedalColl.find({
            medalId: { $in: ids }, source: { $in: ['auction', 'contract'] },
        }).toArray(),
        auctionColl.find({ medalId: { $in: ids } }).toArray(),
    ]);
    return medals.map((medal) => {
        const awarded = awards.find((a) => a.medalId === medal._id) || null;
        const activeAuction = auctions.find(
            (a) => a.medalId === medal._id && a.status === 'active',
        ) || null;
        const settledAuction = auctions
            .filter((a) => a.medalId === medal._id && a.status === 'settled' && a.winner != null)
            .sort((a, b) => (b.settledAt?.getTime() || 0) - (a.settledAt?.getTime() || 0))[0] || null;
        const status = awarded ? 'held' : activeAuction ? 'auction' : 'pending';
        return {
            medal, award: awarded, activeAuction, settledAuction, status,
        };
    });
}
