import { db, ObjectId, ValidationError } from 'hydrooj';
import type {
    Oi33MeowFollow, Oi33MeowLike, Oi33MeowPost, Oi33MeowStatus,
    Oi33ModerationSource, Oi33ModerationVerdict,
} from './types';
import { addLog, logColl } from './log';
import { userColl } from './user';
import { catCanPoolColl } from './cat-can';

export const meowPostColl = db.collection<Oi33MeowPost>('oi33_meow_post');
export const meowFollowColl = db.collection<Oi33MeowFollow>('oi33_meow_follow');
export const meowLikeColl = db.collection<Oi33MeowLike>('oi33_meow_like');

const TIME_ZONE = 'Asia/Shanghai';
// Posting a 喵喵信息 costs 1 cat can; the next one may be posted 2h later.
export const MEOW_POST_CAN_COST = 1;
export const MEOW_POST_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// Calendar day key in Asia/Shanghai — used for the admin "今日" stats.
export function meowDateKey(now = new Date()): string {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function ensureMeowIndexes() {
    // The original 1-post-per-day rule used a unique (uid, dateKey) index.
    // Posting is now governed by a 2-hour cooldown + cat-can cost, so the old
    // unique index must be dropped or nobody could post twice on one day.
    await meowPostColl.dropIndex('uid_1_dateKey_1').catch(() => {});
    await Promise.all([
        meowPostColl.createIndex({ uid: 1, createdAt: -1, _id: -1 }),
        meowPostColl.createIndex({ uid: 1, status: 1, createdAt: -1 }),
        meowPostColl.createIndex({ status: 1, createdAt: -1 }),
        meowPostColl.createIndex({ createdAt: -1 }),
        meowPostColl.createIndex({ dateKey: 1 }),
        meowFollowColl.createIndex({ follower: 1, following: 1 }, { unique: true }),
        meowFollowColl.createIndex({ following: 1, createdAt: -1 }),
        meowLikeColl.createIndex({ uid: 1, postId: 1 }, { unique: true }),
        meowLikeColl.createIndex({ postId: 1 }),
        meowPostColl.createIndex({ ref: 1 }),
    ]);
}

// The rules+AI verdict engine lives in handler/moderate.ts; the handler layer
// registers a runner here so model code can kick a background AI review without
// importing handler modules (avoids a circular dependency).
type MeowReviewKicker = (uid: number, postId: ObjectId) => void;
let meowReviewKicker: MeowReviewKicker | null = null;

export function setMeowReviewKicker(fn: MeowReviewKicker) {
    meowReviewKicker = fn;
}

// --- Posts ---

export async function meowGetPost(id: ObjectId): Promise<Oi33MeowPost | null> {
    return await meowPostColl.findOne({ _id: id });
}

// A user's most recent 喵喵信息 (any status) — used for display only.
export async function meowLastPost(uid: number): Promise<Oi33MeowPost | null> {
    return await meowPostColl.findOne({ uid }, { sort: { createdAt: -1, _id: -1 } });
}

// The post that anchors the 2h cooldown: the most recent NON-rejected post.
// Rejected posts are refunded (can + cooldown), so they must not keep the user
// locked out — the user can immediately post again after a rejection.
export async function meowCooldownAnchorPost(uid: number): Promise<Oi33MeowPost | null> {
    return await meowPostColl.findOne(
        { uid, status: { $ne: 'rejected' } }, { sort: { createdAt: -1, _id: -1 } },
    );
}

// Milliseconds remaining until the user may post again (0 = ready).
export function meowCooldownRemaining(last: Oi33MeowPost | null, now = new Date()): number {
    if (!last) return 0;
    return Math.max(0, last.createdAt.getTime() + MEOW_POST_COOLDOWN_MS - now.getTime());
}

// Human-friendly cooldown text, e.g. "2 小时", "45 分钟", "1 小时 30 分钟".
export function meowCooldownText(remaining: number): string {
    const minutes = Math.max(1, Math.ceil(remaining / 60000));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h > 0 && m === 0) return `${h} 小时`;
    if (h === 0) return `${m} 分钟`;
    return `${h} 小时 ${m} 分钟`;
}

// Refund the cat can spent on a post that was ultimately rejected. Restores the
// balance, the circulating-cans pool counter, and records a ledger entry.
export async function meowRefundCan(uid: number, operator = 0) {
    await userColl.updateOne({ _id: uid }, { $inc: { cat_can: MEOW_POST_CAN_COST } });
    await catCanPoolColl.updateOne(
        { _id: 'main' } as any, { $inc: { circulatingCans: MEOW_POST_CAN_COST } } as any,
    );
    await addLog({
        type: 'cat_account', userId: uid, sender: operator,
        action: 'meow_refund', amount: 0, canAmount: MEOW_POST_CAN_COST,
        reason: '喵喵信息未通过审核，退还猫罐头',
    });
}

// Create a post. Every 喵喵信息 (including forwards) costs 1 cat can and is
// gated by a 2-hour cooldown after the previous one. `status` is decided by
// the handler (teachers/moderation-off → approved; everyone else → pending
// until the AI verdict). The can is not refunded on later rejection.
export async function meowPostAdd(
    uid: number, content: string, opts: {
        status: 'approved' | 'pending'; ref?: ObjectId; refUid?: number;
    },
): Promise<Oi33MeowPost> {
    const now = new Date();
    const last = await meowCooldownAnchorPost(uid);
    const remaining = meowCooldownRemaining(last, now);
    if (remaining > 0) {
        throw new ValidationError(`发布冷却中，${meowCooldownText(remaining)}后可再次发布喵喵信息。`);
    }

    // Deduct 1 cat can atomically (guard: balance must cover the cost).
    const costResult = await userColl.updateOne(
        { _id: uid, cat_can: { $gte: MEOW_POST_CAN_COST } },
        { $inc: { cat_can: -MEOW_POST_CAN_COST } },
    );
    if (!costResult.modifiedCount) {
        throw new ValidationError(`猫罐头不足，发布喵喵信息需要 ${MEOW_POST_CAN_COST} 个猫罐头。`);
    }

    // Pool counter + unified cat-account ledger (rollback on any later failure).
    let poolUpdated = false;
    let costLogId: ObjectId | null = null;
    try {
        const poolResult = await catCanPoolColl.updateOne(
            { _id: 'main' } as any,
            { $inc: { circulatingCans: -MEOW_POST_CAN_COST }, $set: { updatedAt: now } } as any,
        );
        poolUpdated = !!poolResult.modifiedCount;
        const logDoc = {
            _id: new ObjectId(),
            createdAt: now,
            type: 'cat_account' as const,
            userId: uid,
            sender: uid,
            action: 'meow_post',
            amount: 0,
            canAmount: -MEOW_POST_CAN_COST,
            reason: '发布喵喵信息',
        };
        const inserted = await logColl.insertOne(logDoc as any);
        costLogId = inserted.insertedId;
    } catch (e) {
        await userColl.updateOne({ _id: uid }, { $inc: { cat_can: MEOW_POST_CAN_COST } });
        if (poolUpdated) {
            await catCanPoolColl.updateOne(
                { _id: 'main' } as any, { $inc: { circulatingCans: MEOW_POST_CAN_COST } } as any,
            );
        }
        throw e;
    }

    const doc: Oi33MeowPost = {
        _id: new ObjectId(),
        uid,
        content,
        dateKey: meowDateKey(now),
        status: opts.status,
        likeCount: 0,
        createdAt: now,
        ...(opts.ref ? { ref: opts.ref, refUid: opts.refUid } : {}),
    };
    try {
        await meowPostColl.insertOne(doc);
    } catch (e) {
        // Refund the can and drop the cost ledger so a failed insert leaves
        // no phantom deduction behind.
        await userColl.updateOne({ _id: uid }, { $inc: { cat_can: MEOW_POST_CAN_COST } });
        if (poolUpdated) {
            await catCanPoolColl.updateOne(
                { _id: 'main' } as any, { $inc: { circulatingCans: MEOW_POST_CAN_COST } } as any,
            );
        }
        if (costLogId) await logColl.deleteOne({ _id: costLogId });
        throw e;
    }
    if (doc.status === 'approved') {
        await addLog({
            type: 'meow', userId: uid, action: 'post',
            postId: doc._id.toHexString(), status: 'approved',
        });
    }
    if (opts.status === 'pending' && meowReviewKicker) {
        try {
            meowReviewKicker(uid, doc._id);
        } catch (e) {
            console.error('[oi33] meow review kick failed:', e);
        }
    }
    return doc;
}

// All OI33 managers / executive admins (realname_flag >= 2). Their 信息 is
// always visible on every user's timeline.
export async function meowAdminUids(): Promise<number[]> {
    const docs = await userColl.find({ realname_flag: { $gte: 2 } }, { projection: { _id: 1 } }).toArray();
    return docs.map((d) => d._id);
}

// Homepage module feed: admins + (if logged in) followed users + self.
export async function meowHomeFeed(viewerUid: number, limit = 10) {
    const uids = new Set<number>(await meowAdminUids());
    if (viewerUid) {
        uids.add(viewerUid);
        const follows = await meowFollowingList(viewerUid);
        for (const f of follows) uids.add(f.following);
    }
    return await meowPostColl.find({ uid: { $in: [...uids] }, status: 'approved' })
        .sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
}

// Build the display chain of a (possibly forwarded) post: [self, ref, ref.ref,
// ...]. A plain post yields a single-element chain. Depth is bounded so a
// pathological forward cycle can't blow up the render.
export async function meowBuildChain(
    post: Oi33MeowPost, maxDepth = 5,
): Promise<Array<{ uid: number; content: string }>> {
    const chain: Array<{ uid: number; content: string }> = [{ uid: post.uid, content: post.content }];
    let refId = post.ref;
    let depth = 0;
    while (refId && depth < maxDepth) {
        const ref = await meowPostColl.findOne(
            { _id: refId }, { projection: { uid: 1, content: 1, ref: 1 } },
        );
        if (!ref) break;
        chain.push({ uid: ref.uid, content: ref.content });
        refId = ref.ref;
        depth++;
    }
    return chain;
}

// How many times a post has been forwarded (posts whose `ref` points to it).
export async function meowForwardCount(postId: ObjectId): Promise<number> {
    return await meowPostColl.countDocuments({ ref: postId });
}

// Feed: approved posts from the given uids (followed users + self).
export async function meowFeed(uids: number[], page: number, pageSize = 20) {
    const filter = { uid: { $in: uids }, status: 'approved' };
    const total = await meowPostColl.countDocuments(filter);
    const upcount = Math.max(1, Math.ceil(total / pageSize));
    const docs = await meowPostColl.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize).limit(pageSize).toArray();
    return { docs, total, upcount };
}

// A user's own posts. Owners see everything (with status badges); followers and
// admins see approved posts only; everyone else sees nothing.
export async function meowUserPosts(uid: number, viewerId: number, canSee: boolean) {
    if (uid === viewerId) {
        return await meowPostColl.find({ uid }).sort({ createdAt: -1, _id: -1 }).limit(50).toArray();
    }
    if (!canSee) return [];
    return await meowPostColl.find({ uid, status: 'approved' })
        .sort({ createdAt: -1, _id: -1 }).limit(50).toArray();
}

// Apply the rules/AI verdict to a pending post: pass → approved, block →
// rejected, review → stays pending (human queue). No-op if already handled.
export async function meowResolveVerdict(postId: ObjectId, result: {
    verdict: Oi33ModerationVerdict;
    source: Oi33ModerationSource;
    category: string;
    aiReason?: string;
    model?: string;
    cost?: number;
}) {
    const post = await meowPostColl.findOne({ _id: postId });
    if (!post || post.status !== 'pending') return;
    const status: Oi33MeowStatus = result.verdict === 'pass' ? 'approved'
        : result.verdict === 'block' ? 'rejected' : 'pending';
    const set: Record<string, any> = {
        verdict: result.verdict,
        verdictSource: result.source,
        category: result.category || '其他',
        aiReason: result.aiReason || '',
        status,
    };
    if (status !== 'pending') set.handledAt = new Date();
    if (result.model !== undefined) set.model = result.model;
    if (result.cost !== undefined) set.cost = result.cost;
    // Atomic guard: skip if an admin already handled it.
    const r = await meowPostColl.updateOne({ _id: postId, status: 'pending' }, { $set: set });
    if (!r.matchedCount) return;
    // AI/human rejection → refund the cat can + reset the cooldown.
    if (status === 'rejected') await meowRefundCan(post.uid);
    // Only log the final verdict — a pending post is not surfaced in the log.
    if (status !== 'pending') {
        await addLog({
            type: 'meow', userId: post.uid, action: 'post',
            postId: postId.toHexString(), status,
        });
    }
}

// --- Admin queue ---

export async function meowListPending() {
    return await meowPostColl.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(200).toArray();
}

export async function meowListRecent(limit = 50) {
    return await meowPostColl.find({ status: { $ne: 'pending' } })
        .sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function meowTodayStats() {
    const rows = await meowPostColl.aggregate<{ _id: string; count: number }>([
        { $match: { dateKey: meowDateKey() } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).toArray();
    const stats = { total: 0, pending: 0, approved: 0, rejected: 0 };
    for (const row of rows) {
        stats.total += row.count;
        if (row._id === 'pending') stats.pending += row.count;
        else if (row._id === 'approved') stats.approved += row.count;
        else if (row._id === 'rejected') stats.rejected += row.count;
    }
    return stats;
}

// Approve/reject a pending post from the human queue. Rejection refunds the
// cat can spent on it and resets the cooldown.
export async function meowSetStatus(id: ObjectId, status: 'approved' | 'rejected', handlerUid: number) {
    const post = await meowPostColl.findOne({ _id: id });
    if (!post || post.status !== 'pending') return false;
    const r = await meowPostColl.updateOne(
        { _id: id, status: 'pending' },
        { $set: { status, handledAt: new Date(), handler: handlerUid } },
    );
    if (!r.matchedCount) return false;
    if (status === 'rejected') await meowRefundCan(post.uid, handlerUid);
    return true;
}

// Paginated listing of every meow post, optionally filtered by status. Used by
// the admin "全部喵喵" page.
export async function meowListAll(
    page: number, pageSize = 20, status = 'all',
): Promise<{ docs: Oi33MeowPost[]; count: number; upcount: number }> {
    if (!['pending', 'approved', 'rejected'].includes(status)) status = 'all';
    const filter = status === 'all' ? {} : { status };
    const count = await meowPostColl.countDocuments(filter);
    const docs = await meowPostColl.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize).limit(pageSize).toArray();
    return { docs, count, upcount: Math.max(1, Math.ceil(count / pageSize)) };
}

// Delete a meow post outright (admin action). Removes its likes and detaches any
// forwards so they survive as independent posts, then logs the deletion. The
// cat can spent on the post is NOT refunded — deletion is a moderation removal.
export async function meowDelete(postId: ObjectId, operatorUid: number): Promise<boolean> {
    const post = await meowPostColl.findOne({ _id: postId });
    if (!post) return false;
    await meowPostColl.deleteOne({ _id: postId });
    await meowLikeColl.deleteMany({ postId });
    await meowPostColl.updateMany({ ref: postId }, { $unset: { ref: '', refUid: '' } });
    await addLog({
        type: 'meow', userId: post.uid, action: 'delete',
        postId: postId.toHexString(), operator: operatorUid,
    });
    return true;
}

// --- Follows ---

export async function meowFollow(follower: number, following: number): Promise<boolean> {
    if (follower === following) return false;
    await meowFollowColl.updateOne(
        { follower, following },
        {
            $setOnInsert: {
                _id: new ObjectId(), follower, following, createdAt: new Date(),
            },
        },
        { upsert: true },
    );
    return true;
}

export async function meowUnfollow(follower: number, following: number) {
    await meowFollowColl.deleteOne({ follower, following });
}

export async function meowIsFollowing(follower: number, following: number) {
    return !!(await meowFollowColl.findOne({ follower, following }, { projection: { _id: 1 } }));
}

export async function meowFollowingList(uid: number) {
    return await meowFollowColl.find({ follower: uid }).sort({ createdAt: -1 }).toArray();
}

export async function meowFollowerList(uid: number) {
    return await meowFollowColl.find({ following: uid }).sort({ createdAt: -1 }).toArray();
}

export async function meowFollowingCount(uid: number) {
    return await meowFollowColl.countDocuments({ follower: uid });
}

export async function meowFollowerCount(uid: number) {
    return await meowFollowColl.countDocuments({ following: uid });
}

// Which of `targets` does `uid` follow?
export async function meowFollowingMap(uid: number, targets: number[]): Promise<Record<number, boolean>> {
    if (!targets.length) return {};
    const docs = await meowFollowColl.find({ follower: uid, following: { $in: targets } }).toArray();
    const map: Record<number, boolean> = {};
    for (const d of docs) map[d.following] = true;
    return map;
}

// Which of `targets` follow `uid`?
export async function meowFollowedByMap(uid: number, targets: number[]): Promise<Record<number, boolean>> {
    if (!targets.length) return {};
    const docs = await meowFollowColl.find({ following: uid, follower: { $in: targets } }).toArray();
    const map: Record<number, boolean> = {};
    for (const d of docs) map[d.follower] = true;
    return map;
}

// --- Likes ---

export async function meowToggleLike(uid: number, postId: ObjectId): Promise<{ liked: boolean }> {
    const existing = await meowLikeColl.findOne({ uid, postId });
    if (existing) {
        await meowLikeColl.deleteOne({ _id: existing._id });
        await meowPostColl.updateOne(
            { _id: postId, likeCount: { $gt: 0 } }, { $inc: { likeCount: -1 } },
        );
        return { liked: false };
    }
    await meowLikeColl.insertOne({ _id: new ObjectId(), uid, postId, createdAt: new Date() });
    await meowPostColl.updateOne({ _id: postId }, { $inc: { likeCount: 1 } });
    return { liked: true };
}

export async function meowLikedMap(uid: number, postIds: ObjectId[]): Promise<Record<string, boolean>> {
    if (!postIds.length) return {};
    const docs = await meowLikeColl.find({ uid, postId: { $in: postIds } }).toArray();
    const map: Record<string, boolean> = {};
    for (const d of docs) map[d.postId.toHexString()] = true;
    return map;
}
