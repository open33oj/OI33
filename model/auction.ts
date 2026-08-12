import {
    db, NotFoundError, ObjectId, ValidationError,
} from 'hydrooj';
import type { Oi33Auction } from './types';
import { addLog } from './log';
import { achievementColl, achievementGrant, userAchievementColl } from './achievement';
import { catCanPoolColl, ensureCurrentCatCanPrice } from './cat-can';
import { userColl } from './user';

export const auctionColl = db.collection('oi33_auction');
export const auctionBidColl = db.collection('oi33_auction_bid');

export async function ensureAuctionIndexes() {
    await Promise.all([
        auctionColl.createIndex({ status: 1, endAt: 1 }),
        auctionColl.createIndex({ achievementId: 1, status: 1 }),
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
    achievementId: string;
    startPrice: number;
    durationMs: number;
    operator: number;
}) {
    const achievement = await achievementColl.findOne({ _id: input.achievementId });
    if (!achievement) throw new ValidationError('成就不存在。');
    if (!achievement.saleable) throw new ValidationError('只有标记为可售卖的稀有成就才能拍卖。');
    if (!Number.isSafeInteger(input.startPrice) || input.startPrice < 1) {
        throw new ValidationError('起拍价必须是不少于 1 的整数个猫罐头。');
    }
    // Rare achievements are unique and auctioned at most once: after a
    // successful sale they can only change hands via trade contracts.
    const [settled, held] = await Promise.all([
        auctionColl.findOne({ achievementId: input.achievementId, status: 'settled', winner: { $ne: null } }),
        userAchievementColl.findOne({
            achievementId: input.achievementId, source: { $in: ['auction', 'contract'] },
        }),
    ]);
    if (settled || held) {
        throw new ValidationError('该成就已经拍卖过。稀有成就只拍卖一次，之后只能通过交易合同转让。');
    }
    const running = await auctionColl.findOne({
        achievementId: input.achievementId, status: 'active',
    });
    if (running) throw new ValidationError('该成就已有进行中的拍卖，结束后才能再次上架。');
    const now = new Date();
    const doc: Oi33Auction = {
        _id: new ObjectId(),
        achievementId: input.achievementId,
        startPrice: input.startPrice,
        startAt: now,
        endAt: new Date(now.getTime() + input.durationMs),
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
        auctionId: doc._id.toHexString(), achievementId: doc.achievementId,
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
    const owned = await userAchievementColl.findOne({ uid, achievementId: auction.achievementId });
    if (owned) throw new ValidationError('你已经拥有这个成就，无需竞拍。');
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
        auctionId: auction._id.toHexString(), achievementId: auction.achievementId, amount,
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
    const flipped = await auctionColl.updateOne(
        { _id: auction._id, status: 'active' },
        { $set: { status: 'settled', settledAt: now } },
    );
    if (!flipped.modifiedCount) return await auctionColl.findOne({ _id: auction._id });
    if (auction.highestBidder != null && auction.highestBid != null) {
        try {
            await achievementGrant(auction.highestBidder, auction.achievementId, 0, 'auction', true);
            // The winning cans return to the AMM pool, and the pool burns
            // reserve food equal to their current sell value — exactly as if
            // the winner sold the cans back and the proceeds were destroyed
            // (no fee, no cooldown). This makes auctions a cat-food sink.
            const market: any = await ensureCurrentCatCanPrice(now);
            const pool: any = await catCanPoolColl.findOne({ _id: 'main' });
            const foodBurn = Math.min(
                Math.max(0, Number(pool?.reserveFood) || 0),
                auction.highestBid * Math.max(0, Number(market?.sellPrice) || 0),
            );
            const poolUpdated = await catCanPoolColl.updateOne(
                { _id: 'main', reserveFood: { $gte: foodBurn } },
                {
                    $inc: { reserveFood: -foodBurn, circulatingCans: -auction.highestBid },
                    $set: { updatedAt: now },
                },
            );
            if (!poolUpdated.modifiedCount) {
                // The reserve moved concurrently; never leave the cans stuck.
                await catCanPoolColl.updateOne(
                    { _id: 'main' },
                    { $inc: { circulatingCans: -auction.highestBid }, $set: { updatedAt: now } },
                );
            }
            await auctionColl.updateOne(
                { _id: auction._id },
                { $set: { winner: auction.highestBidder, settlePrice: auction.highestBid, foodBurn } },
            );
            await addLog({
                type: 'auction', userId: auction.highestBidder, action: 'settle',
                auctionId: auction._id.toHexString(), achievementId: auction.achievementId,
                amount: auction.highestBid, foodBurn,
            } as any);
        } catch (e) {
            // Never leave the escrowed cans stuck: if the grant fails (e.g.
            // the achievement was deleted mid-auction) refund the leader.
            console.error(`[oi33] auction settle grant failed for ${auction._id}:`, e);
            await auctionRefund(auction.highestBidder, auction.highestBid, auction._id, '结算失败退款');
        }
    } else {
        await addLog({
            type: 'auction', userId: auction.createdBy, action: 'settle_unsold',
            auctionId: auction._id.toHexString(), achievementId: auction.achievementId,
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
    const flipped = await auctionColl.updateOne(
        { _id: auction._id, status: 'active' },
        { $set: { status: 'cancelled', cancelledAt: now, cancelledBy: operator } },
    );
    if (!flipped.modifiedCount) throw new ValidationError('拍卖已结束。');
    if (auction.highestBidder != null && auction.highestBid != null) {
        await auctionRefund(auction.highestBidder, auction.highestBid, auction._id, '拍卖已取消');
    }
    await addLog({
        type: 'auction', userId: operator, action: 'cancel',
        auctionId: auction._id.toHexString(), achievementId: auction.achievementId,
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

// Rare (saleable) achievements are unique: auctioned at most once, afterwards
// they can only change hands via trade contracts. Each row reports who holds
// the single copy, or that it is on/awaiting its one auction.
export async function auctionRareShowcase() {
    const achievements = await achievementColl.find({ saleable: true }).toArray();
    if (!achievements.length) return [];
    const ids = achievements.map((achievement) => achievement._id);
    const [awards, auctions] = await Promise.all([
        userAchievementColl.find({
            achievementId: { $in: ids }, source: { $in: ['auction', 'contract'] },
        }).toArray(),
        auctionColl.find({ achievementId: { $in: ids } }).toArray(),
    ]);
    return achievements.map((achievement) => {
        const award = awards.find((a) => a.achievementId === achievement._id) || null;
        const activeAuction = auctions.find(
            (a) => a.achievementId === achievement._id && a.status === 'active',
        ) || null;
        const settledAuction = auctions
            .filter((a) => a.achievementId === achievement._id && a.status === 'settled' && a.winner != null)
            .sort((a, b) => (b.settledAt?.getTime() || 0) - (a.settledAt?.getTime() || 0))[0] || null;
        const status = award ? 'held' : activeAuction ? 'auction' : 'pending';
        return {
            achievement, award, activeAuction, settledAuction, status,
        };
    });
}
