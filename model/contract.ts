import {
    db, NotFoundError, ObjectId, ValidationError,
} from 'hydrooj';
import type { Oi33Contract } from './types';
import { addLog } from './log';
import { achievementColl, achievementGrant, userAchievementColl } from './achievement';
import { userColl } from './user';

export const contractColl = db.collection('oi33_achievement_contract');

export async function ensureContractIndexes() {
    await Promise.all([
        contractColl.createIndex({ buyer: 1, status: 1 }),
        contractColl.createIndex({ seller: 1, status: 1 }),
        contractColl.createIndex({ seller: 1, achievementId: 1, status: 1 }),
        contractColl.createIndex({ createdAt: -1 }),
    ]);
}

export async function contractGet(id: string | ObjectId) {
    let objectId: ObjectId;
    try {
        objectId = typeof id === 'string' ? new ObjectId(id) : id;
    } catch {
        return null;
    }
    return await contractColl.findOne({ _id: objectId });
}

// A user's award is sellable only when the achievement definition allows
// reselling AND this copy was won at auction (source === 'auction').
export async function contractListSellableAwards(uid: number) {
    const awards = await userAchievementColl.find({ uid, source: 'auction' }).toArray();
    if (!awards.length) return [];
    const definitions = await achievementColl.find({
        _id: { $in: awards.map((award) => award.achievementId) },
        saleable: true,
    }).toArray();
    const pending = await contractColl.find({
        seller: uid, status: 'pending',
    }, { projection: { achievementId: 1 } }).toArray();
    const pendingIds = new Set(pending.map((contract) => contract.achievementId));
    return definitions.filter((definition) => !pendingIds.has(definition._id));
}

export async function contractCreate(input: {
    achievementId: string;
    seller: number;
    buyer: number;
    price: number;
}) {
    const { achievementId, seller, buyer, price } = input;
    if (seller === buyer) throw new ValidationError('不能把成就卖给自己。');
    if (!Number.isSafeInteger(price) || price < 1) {
        throw new ValidationError('猫粮价格必须是不少于 1 的整数。');
    }
    const achievement = await achievementColl.findOne({ _id: achievementId });
    if (!achievement) throw new ValidationError('成就不存在。');
    if (!achievement.saleable) throw new ValidationError('该成就不可售卖。');
    const award = await userAchievementColl.findOne({ uid: seller, achievementId, source: 'auction' });
    if (!award) throw new ValidationError('只有拍卖获得的成就才能转售。');
    const buyerAward = await userAchievementColl.findOne({ uid: buyer, achievementId });
    if (buyerAward) throw new ValidationError('对方已经拥有这个成就。');
    const running = await contractColl.findOne({ seller, achievementId, status: 'pending' });
    if (running) throw new ValidationError('该成就已有一份待处理的合同。');
    const now = new Date();
    const doc: Oi33Contract = {
        _id: new ObjectId(),
        achievementId,
        seller,
        buyer,
        price,
        status: 'pending',
        createdAt: now,
    };
    await contractColl.insertOne(doc as any);
    await addLog({
        type: 'contract', userId: seller, uid: buyer, action: 'create',
        contractId: doc._id.toHexString(), achievementId, amount: price,
    } as any);
    return doc;
}

export async function contractAccept(id: string | ObjectId, buyer: number, now = new Date()) {
    const contract = await contractGet(id);
    if (!contract) throw new NotFoundError(String(id));
    if (contract.buyer !== buyer) throw new ValidationError('只有合同指定的用户可以接受。');
    if (contract.status !== 'pending') throw new ValidationError('合同已处理。');
    const achievement = await achievementColl.findOne({ _id: contract.achievementId });
    if (!achievement?.saleable) throw new ValidationError('该成就已不可售卖，合同失效。');
    const award = await userAchievementColl.findOne({
        uid: contract.seller, achievementId: contract.achievementId, source: 'auction',
    });
    if (!award) throw new ValidationError('卖家已经不再拥有该成就，合同失效。');
    const buyerAward = await userAchievementColl.findOne({
        uid: buyer, achievementId: contract.achievementId,
    });
    if (buyerAward) throw new ValidationError('你已经拥有这个成就。');
    // Claim the contract first so a double click cannot settle twice.
    const flipped = await contractColl.updateOne(
        { _id: contract._id, status: 'pending' },
        { $set: { status: 'accepted', resolvedAt: now } },
    );
    if (!flipped.modifiedCount) throw new ValidationError('合同已处理。');
    // Cat food moves buyer → seller (user-to-user, pool totals unchanged).
    const deducted = await userColl.updateOne(
        { _id: buyer, cat_food: { $gte: contract.price } },
        { $inc: { cat_food: -contract.price } },
    );
    if (!deducted.modifiedCount) {
        await contractColl.updateOne(
            { _id: contract._id }, { $set: { status: 'pending' }, $unset: { resolvedAt: '' } },
        );
        throw new ValidationError('猫粮不足，无法支付合同价格。');
    }
    try {
        await userColl.updateOne(
            { _id: contract.seller }, { $inc: { cat_food: contract.price } }, { upsert: true },
        );
        await userAchievementColl.deleteOne({ _id: award._id });
        await achievementGrant(buyer, contract.achievementId, 0, 'contract', true);
    } catch (e) {
        await userColl.updateOne({ _id: buyer }, { $inc: { cat_food: contract.price } });
        // Best-effort restore of the seller's award if it was already removed.
        await userAchievementColl.insertOne(award as any).catch(() => {});
        await contractColl.updateOne(
            { _id: contract._id }, { $set: { status: 'pending' }, $unset: { resolvedAt: '' } },
        );
        throw e;
    }
    await addLog({
        type: 'contract', userId: buyer, uid: contract.seller, action: 'accept',
        contractId: contract._id.toHexString(), achievementId: contract.achievementId,
        amount: contract.price,
    } as any);
    return await contractColl.findOne({ _id: contract._id });
}

async function contractResolve(
    id: string | ObjectId,
    actor: number,
    role: 'buyer' | 'seller',
    status: 'declined' | 'cancelled',
) {
    const contract = await contractGet(id);
    if (!contract) throw new NotFoundError(String(id));
    if (contract[role] !== actor) throw new ValidationError('无权处理该合同。');
    if (contract.status !== 'pending') throw new ValidationError('合同已处理。');
    const flipped = await contractColl.updateOne(
        { _id: contract._id, status: 'pending' },
        { $set: { status, resolvedAt: new Date() } },
    );
    if (!flipped.modifiedCount) throw new ValidationError('合同已处理。');
    await addLog({
        type: 'contract', userId: actor, uid: role === 'buyer' ? contract.seller : contract.buyer,
        action: status === 'declined' ? 'decline' : 'cancel',
        contractId: contract._id.toHexString(), achievementId: contract.achievementId,
        amount: contract.price,
    } as any);
    return await contractColl.findOne({ _id: contract._id });
}

export async function contractDecline(id: string | ObjectId, buyer: number) {
    return await contractResolve(id, buyer, 'buyer', 'declined');
}

export async function contractCancel(id: string | ObjectId, seller: number) {
    return await contractResolve(id, seller, 'seller', 'cancelled');
}

export async function contractListIncoming(buyer: number) {
    return await contractColl.find({ buyer, status: 'pending' }).sort({ createdAt: -1 }).toArray();
}

export async function contractListOutgoing(seller: number, limit = 20) {
    return await contractColl.find({ seller }).sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function contractListRecentResolved(uid: number, limit = 20) {
    return await contractColl.find({
        $or: [{ buyer: uid }, { seller: uid }],
        status: { $ne: 'pending' },
    }).sort({ resolvedAt: -1 }).limit(limit).toArray();
}
