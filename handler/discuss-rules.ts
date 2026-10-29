// 讨论列表卡片的「最后回复」是派生数据，不落库：core 只在 discussion 文档上维护
// updateAt / nReply，真正最后回帖的人需要从 reply 文档里找。楼中楼（tail reply）
// 同样会刷新 updateAt，所以「最后回复」必须把楼中楼也算进去，否则会出现
// 「名字是上一条主楼、时间却来自楼中楼」的错位。
//
// 纯逻辑放这里，不 import hydrooj / DB / DOM，方便 `node --test` 直接跑；
// handler/discuss.ts 负责查询与写回 ddoc。

export interface DiscussionReplyLike {
    owner?: unknown;
    _id?: { getTimestamp?: () => Date } | null;
    reply?: readonly DiscussionReplyLike[] | null;
}

export interface LastReplyInfo {
    owner: number;
    at: Date;
}

function replyTime(reply: DiscussionReplyLike | null | undefined): number | null {
    const at = reply?._id?.getTimestamp?.();
    if (!(at instanceof Date)) return null;
    const time = at.getTime();
    return Number.isFinite(time) ? time : null;
}

// 在一条主楼及其楼中楼里找最晚的活动；同秒时取数组里靠后的（楼中楼按追加顺序）。
function latestInReply(reply: DiscussionReplyLike): LastReplyInfo | null {
    let best: LastReplyInfo | null = null;
    const candidates = [reply, ...(Array.isArray(reply.reply) ? reply.reply : [])];
    for (const candidate of candidates) {
        const owner = Number(candidate?.owner);
        const time = replyTime(candidate);
        if (!Number.isSafeInteger(owner) || time === null) continue;
        if (best && time < best.at.getTime()) continue;
        best = { owner, at: new Date(time) };
    }
    return best;
}

// replies 通常按 _id 升序传入；这里不依赖顺序，直接取全局最新的一条。
export function latestReplyInfo(replies: readonly DiscussionReplyLike[]): LastReplyInfo | null {
    let best: LastReplyInfo | null = null;
    for (const reply of replies) {
        if (!reply) continue;
        const candidate = latestInReply(reply);
        if (!candidate) continue;
        if (best && candidate.at.getTime() < best.at.getTime()) continue;
        best = candidate;
    }
    return best;
}
