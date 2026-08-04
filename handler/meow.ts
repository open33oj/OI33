import {
    Context, ForbiddenError, Handler, NotFoundError, ObjectId, PRIV, Types, UserModel,
    ValidationError, param, query,
} from 'hydrooj';
import { HomeHandler } from 'hydrooj/src/handler/home';
import { oi33Model } from '../model';
import { addLog } from '../model/log';
import { checkOi33Admin, checkUserFlag } from './utils';
import { checkRules, configReviewWords, configWords, hashOf, normalizeText, runAiVerdict } from './moderate';

const MAX_CONTENT_LEN = 256;
const FEED_PAGE_SIZE = 20;
const PROFILE_PREVIEW_LIMIT = 8;
const PROFILE_POST_LIMIT = 5;
const HOME_FEED_LIMIT = 10;
const CHAIN_MAX_DEPTH = 5;

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Escapes HTML, then turns "@<username>" mentions into links to the
// corresponding /user/:id page. Purely numeric tokens (@333) are treated as
// uids and left plain — only real usernames are resolved and linked. Unknown
// usernames stay as plain text.
async function linkifyMentions(domainId: string, text: string): Promise<string> {
    const escaped = escapeHtml(text);
    const mentionRe = /@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g;
    const names = new Set<string>();
    let m: RegExpExecArray | null;
    const scan = new RegExp(mentionRe.source, 'g');
    while ((m = scan.exec(escaped))) {
        if (!/^\d+$/.test(m[1])) names.add(m[1]);
    }
    const uidMap = new Map<string, number>();
    for (const name of names) {
        try {
            const u = await UserModel.getByUname(domainId, name);
            if (u) uidMap.set(name, u._id);
        } catch { /* ignore unresolvable mentions */ }
    }
    return escaped.replace(mentionRe, (match, name) => {
        const uid = uidMap.get(name);
        return uid
            ? `<a href="/user/${uid}" class="meow-mention">${match}</a>`
            : match;
    });
}

// Bound concurrent background AI reviews; the discussion pipeline fires per-post
// and doesn't need this cap.
let activeMeowReviews = 0;
const MAX_CONCURRENT_MEOW_REVIEWS = 6;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs the same rules + AI verdict engine as discussion moderation over a
// pending post, then resolves it: pass -> approved, block -> rejected (refunds
// the cat can + resets the cooldown), review -> stays pending for the human
// queue. Never throws.
async function moderateMeowAsync(uid: number, postId: ObjectId) {
    while (activeMeowReviews >= MAX_CONCURRENT_MEOW_REVIEWS) {
        await sleep(250);
    }
    activeMeowReviews++;
    try {
        const post = await oi33Model.meowGetPost(postId);
        if (!post) return;
        const cfg = await oi33Model.aiGetConfig();
        const normalized = normalizeText(post.content);
        const hash = hashOf(normalized);
        const result = await runAiVerdict(uid, normalized, hash, cfg);
        await oi33Model.meowResolveVerdict(postId, result);
    } catch (e: any) {
        // Fail closed: any unexpected error lands in the human queue.
        await oi33Model.meowResolveVerdict(postId, {
            verdict: 'review', source: 'error', category: '其他',
            aiReason: String(e?.message || e).slice(0, 200),
        }).catch(() => {});
    } finally {
        activeMeowReviews--;
    }
}

// Shared user-list loader: merges oi33 identity and the mutual-follow maps.
async function loadUserList(domainId: string, uids: number[], viewerId: number) {
    const udict = uids.length ? await UserModel.getList(domainId, uids) : {};
    const oi33Data = await oi33Model.getUserDataByUids(uids);
    for (const uid of uids) {
        if (!udict[uid]) continue;
        oi33Model.mergeOi33Fields(udict[uid], oi33Data[uid]);
    }
    const [followingMap, followedByMap] = await Promise.all([
        oi33Model.meowFollowingMap(viewerId, uids),
        oi33Model.meowFollowedByMap(viewerId, uids),
    ]);
    return { udict, followingMap, followedByMap };
}

// Prepare posts for template rendering: attach `pid` (hex), resolve forward
// chains, and build a udict that covers every post author and every chain
// author (so `@username : content` resolves in the template). Also computes the
// viewer's liked map.
async function prepareMeowPosts(domainId: string, rawPosts: any[], viewerUid: number) {
    const posts = [];
    const chainUids = new Set<number>();
    for (const raw of rawPosts) {
        const chain = await oi33Model.meowBuildChain(raw, CHAIN_MAX_DEPTH);
        for (const item of chain) chainUids.add(item.uid);
        posts.push({ ...raw, pid: raw._id.toHexString(), chain, html: await linkifyMentions(domainId, raw.content) });
    }
    const allUids = [...new Set([...rawPosts.map((p) => p.uid), ...chainUids])];
    const udict = allUids.length ? await UserModel.getList(domainId, allUids) : {};
    const oi33Data = await oi33Model.getUserDataByUids(allUids);
    for (const uid of allUids) {
        if (!udict[uid]) continue;
        oi33Model.mergeOi33Fields(udict[uid], oi33Data[uid]);
    }
    const likedMap = await oi33Model.meowLikedMap(viewerUid, rawPosts.map((p) => p._id));
    return { posts, udict, likedMap };
}

// --- Main feed ---

class MeowMainHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('forward', Types.ObjectId, true)
    async get(domainId: string, page = 1, forward?: ObjectId) {
        const me = this.user._id;
        const [follows, adminUids] = await Promise.all([
            oi33Model.meowFollowingList(me),
            oi33Model.meowAdminUids(),
        ]);
        // Timeline = self + followed users + all managers/executive admins.
        const feedIds = [...new Set([me, ...follows.map((f) => f.following), ...adminUids])];
        const [
            { docs, upcount }, rawLastPost, anchorPost,
            followingCount, followerCount, dailyFreeAvailable,
        ] = await Promise.all([
            oi33Model.meowFeed(feedIds, page, FEED_PAGE_SIZE),
            oi33Model.meowLastPost(me),
            oi33Model.meowCooldownAnchorPost(me),
            oi33Model.meowFollowingCount(me),
            oi33Model.meowFollowerCount(me),
            oi33Model.meowDailyFreeAvailable(me),
        ]);
        const { posts, udict, likedMap } = await prepareMeowPosts(domainId, docs, me);
        let lastPost: any = null;
        let lastPostRejected = false;
        let cooldownText = '';
        if (rawLastPost) {
            const chain = await oi33Model.meowBuildChain(rawLastPost, CHAIN_MAX_DEPTH);
            lastPost = { ...rawLastPost, pid: rawLastPost._id.toHexString(), chain, html: await linkifyMentions(domainId, rawLastPost.content) };
            lastPostRejected = rawLastPost.status === 'rejected';
            // Resolve chain authors for the forward block in the compose area.
            const extraUids = chain.map((c) => c.uid).filter((u) => !udict[u]);
            if (extraUids.length) {
                const extraUdict = await UserModel.getList(domainId, extraUids);
                const oi33Extra = await oi33Model.getUserDataByUids(extraUids);
                for (const u of extraUids) {
                    if (!extraUdict[u]) continue;
                    oi33Model.mergeOi33Fields(extraUdict[u], oi33Extra[u]);
                    udict[u] = extraUdict[u];
                }
            }
        }
        const remaining = oi33Model.meowCooldownRemaining(anchorPost);
        if (remaining > 0) {
            cooldownText = oi33Model.meowCooldownText(remaining);
        }
        // Forward prefill: ?forward=<pid> fills the compose box with the target's
        // forward path as plain text (" || @B : yyy || @A : XXX"). Forwarding is
        // deliberately not structural - the filled text is submitted as-is.
        let forwardPid = '';
        let forwardUname = '';
        let forwardChain = '';
        if (forward) {
            const fpost = await oi33Model.meowGetPost(forward);
            if (fpost && (fpost.status === 'approved' || fpost.uid === me)) {
                const fu = await UserModel.getById(domainId, fpost.uid);
                forwardUname = fu?.uname || `UID ${fpost.uid}`;
                forwardChain = ` || @${forwardUname} : ${fpost.content}`;
                forwardPid = fpost._id.toHexString();
            }
        }
        this.response.template = 'oi33_meow_main.html';
        this.response.body = {
            posts, udict, likedMap, page, upcount,
            lastPost, lastPostRejected, cooldownText, followingCount, followerCount,
            selfDict: { [me]: this.user },
            myCans: Number(this.user.cat_can) || 0,
            myFood: Number(this.user.cat_food) || 0,
            dailyFreeAvailable,
            forwardPid, forwardUname, forwardChain,
        };
    }
}

class MeowPostHandler extends Handler {
    async get() {
        this.response.redirect = this.url('oi33_meow_main');
    }

    @param('content', Types.String)
    async post(domainId: string, content: string) {
        const text = (content || '').trim();
        if (!text) throw new ValidationError('喵喵内容不能为空。');
        if ([...text].length > MAX_CONTENT_LEN) {
            throw new ValidationError(`喵喵内容不能超过 ${MAX_CONTENT_LEN} 字。`);
        }
        const flag = await checkUserFlag(this.user._id);
        if (flag < 1) throw new ForbiddenError('完成实名认证后才能发布喵喵信息。');
        const cfg = await oi33Model.aiGetConfig();
        const trusted = flag >= 2 || (cfg.moderation_enabled ?? '1') !== '1';
        if (!trusted) {
            const ruleHit = checkRules(
                normalizeText(text), configWords(cfg), configReviewWords(cfg),
            );
            if (ruleHit?.verdict === 'block') {
                throw new ValidationError(`内容未通过社区规范审核（${ruleHit.category}），请修改后再发布。`);
            }
        }
        // meowPostAdd enforces the 2h cooldown, applies the daily free post,
        // and deducts a can only after today's free slot has been used.
        const post = await oi33Model.meowPostAdd(this.user._id, text, {
            status: trusted ? 'approved' : 'pending',
        });
        this.response.redirect = this.url('oi33_meow_main');
    }
}

// --- User posts ---

class MeowUserHandler extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        const me = this.user._id;
        const target = await UserModel.getById(domainId, uid);
        if (!target) throw new NotFoundError(uid);
        const [isSelf, isAdmin, isFollower, followingCount, followerCount] = await Promise.all([
            Promise.resolve(me === uid),
            checkUserFlag(me).then((f) => f >= 2),
            oi33Model.meowIsFollowing(me, uid),
            oi33Model.meowFollowingCount(uid),
            oi33Model.meowFollowerCount(uid),
        ]);
        const canSee = isSelf || isAdmin || isFollower;
        const rawPosts = await oi33Model.meowUserPosts(uid, me, canSee);
        const { posts, udict, likedMap } = await prepareMeowPosts(domainId, rawPosts, me);
        const oi33Data = await oi33Model.getUserDataByUids([uid]);
        oi33Model.mergeOi33Fields(target, oi33Data[uid]);
        this.response.template = 'oi33_meow_user.html';
        this.response.body = {
            target, posts, udict, likedMap,
            isSelf, canSee, isFollower, isAdmin,
            followingCount, followerCount,
        };
    }
}

// --- Follow / unfollow ---

class MeowFollowHandler extends Handler {
    @param('uid', Types.Int)
    async post(domainId: string, uid: number) {
        if (uid === this.user._id) throw new ValidationError('不能关注自己。');
        if (await oi33Model.meowFollow(this.user._id, uid)) {
            await addLog({ type: 'meow', userId: this.user._id, action: 'follow', uid });
        }
        // Stay on whichever page the click happened on.
        const referer = this.request.headers.referer || '';
        this.response.redirect = referer || this.url('user_detail', { uid });
    }
}

class MeowUnfollowHandler extends Handler {
    @param('uid', Types.Int)
    async post(domainId: string, uid: number) {
        await oi33Model.meowUnfollow(this.user._id, uid);
        await addLog({ type: 'meow', userId: this.user._id, action: 'unfollow', uid });
        const referer = this.request.headers.referer || '';
        this.response.redirect = referer || this.url('user_detail', { uid });
    }
}

// --- Like ---

class MeowLikeHandler extends Handler {
    @param('postId', Types.ObjectId)
    async post(domainId: string, postId: ObjectId) {
        const post = await oi33Model.meowGetPost(postId);
        if (!post) throw new NotFoundError(postId);
        // Only approved posts (and your own posts) can be liked, so a manual
        // POST can't discover pending/rejected content by its id.
        if (post.status !== 'approved' && post.uid !== this.user._id) {
            throw new NotFoundError(postId);
        }
        const { liked } = await oi33Model.meowToggleLike(this.user._id, postId);
        const likeCount = Math.max(0, post.likeCount + (liked ? 1 : -1));
        // AJAX request (the like button posts via fetch) → return JSON so the
        // page stays exactly where it is. A forward is its own post; liking it
        // must never navigate away.
        const accept = String(this.request.headers.accept || '');
        if (this.request.headers['x-requested-with'] === 'fetch' || accept.includes('application/json')) {
            this.response.type = 'application/json';
            this.response.body = { liked, likeCount };
            return;
        }
        // No-JS fallback: go back to the exact page the like happened on rather
        // than yanking the user to their own meow timeline.
        const referer = this.request.headers.referer || '';
        this.response.redirect = referer || this.url('oi33_meow_main');
    }
}

// --- Follow lists ---

// Inject 喵喵 data into the /user/:id page so the profile panel can show
// the follow button, the user's recent posts, and previews of their following /
// follower lists. Never throws: a DB hiccup just leaves the panel empty.
function registerMeowUserPanel(ctx: Context) {
    ctx.on('handler/after/UserDetail', async (h: any) => {
        try {
            const body = h.response?.body;
            if (!body?.udoc) return;
            const uid = Number(body.udoc._id);
            if (!Number.isFinite(uid)) return;
            const viewerUid = Number(h.user?._id) || 0;
            const isSelf = viewerUid === uid;
            const viewerFlag = viewerUid ? await checkUserFlag(viewerUid) : 0;
            const [followingRaw, followersRaw, followingCount, followerCount] = await Promise.all([
                oi33Model.meowFollowingList(uid),
                oi33Model.meowFollowerList(uid),
                oi33Model.meowFollowingCount(uid),
                oi33Model.meowFollowerCount(uid),
            ]);
            const followingUids = followingRaw.slice(0, PROFILE_PREVIEW_LIMIT).map((f) => f.following);
            const followerUids = followersRaw.slice(0, PROFILE_PREVIEW_LIMIT).map((f) => f.follower);
            const viewerFollows = viewerUid && !isSelf
                ? await oi33Model.meowIsFollowing(viewerUid, uid)
                : false;
            const canSeePosts = isSelf || viewerFlag >= 2 || viewerFollows;
            const rawPosts = await oi33Model.meowUserPosts(uid, viewerUid, canSeePosts);
            const { posts, udict: postUdict, likedMap } = await prepareMeowPosts('', rawPosts.slice(0, PROFILE_POST_LIMIT), viewerUid);
            for (const p of posts) {
                p.forwardCount = await oi33Model.meowForwardCount(p._id);
            }
            const allUids = [...new Set([...followingUids, ...followerUids])];
            const [followingDict, followerDict, mutualFollowing, mutualFollowers, oi33Data] = await Promise.all([
                followingUids.length ? UserModel.getList('', followingUids) : {},
                followerUids.length ? UserModel.getList('', followerUids) : {},
                oi33Model.meowFollowedByMap(uid, followingUids),
                oi33Model.meowFollowingMap(uid, followerUids),
                oi33Model.getUserDataByUids(allUids),
            ]);
            for (const u of followingUids) {
                if (!followingDict[u]) continue;
                oi33Model.mergeOi33Fields(followingDict[u], oi33Data[u]);
            }
            for (const u of followerUids) {
                if (!followerDict[u]) continue;
                oi33Model.mergeOi33Fields(followerDict[u], oi33Data[u]);
            }
            body.oi33MeowPanel = {
                followingUids, followerUids, followingDict, followerDict,
                followingCount, followerCount,
                posts, udict: postUdict, likedMap,
                isSelf, viewerFollows, canSeePosts, viewerFlag,
                mutualFollowing, mutualFollowers,
            };
        } catch (e) {
            console.error('[oi33] meow profile panel failed:', e);
        }
    });
}

class MeowFollowingHandler extends Handler {
    @query('uid', Types.Int, true)
    async get(domainId: string, targetUid?: number) {
        const me = this.user._id;
        const uid = targetUid || me;
        const follows = await oi33Model.meowFollowingList(uid);
        const uids = follows.map((f) => f.following);
        const { udict } = await loadUserList('', uids, me);
        const [mutualMap, buttonMap] = await Promise.all([
            oi33Model.meowFollowedByMap(uid, uids),
            oi33Model.meowFollowingMap(me, uids),
        ]);
        this.response.template = 'oi33_meow_following.html';
        this.response.body = {
            udict, uids, mutualMap, buttonMap,
            listOwner: uid, isSelfList: uid === me,
        };
    }
}

class MeowFollowersHandler extends Handler {
    @query('uid', Types.Int, true)
    async get(domainId: string, targetUid?: number) {
        const me = this.user._id;
        const uid = targetUid || me;
        const followers = await oi33Model.meowFollowerList(uid);
        const uids = followers.map((f) => f.follower);
        const { udict } = await loadUserList('', uids, me);
        const [mutualMap, buttonMap] = await Promise.all([
            oi33Model.meowFollowingMap(uid, uids),
            oi33Model.meowFollowingMap(me, uids),
        ]);
        this.response.template = 'oi33_meow_followers.html';
        this.response.body = {
            udict, uids, mutualMap, buttonMap,
            listOwner: uid, isSelfList: uid === me,
        };
    }
}

// --- Admin queue ---

class MeowAdminHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('status', Types.String, true)
    async get(domainId: string, page = 1, status = 'all') {
        await checkOi33Admin(this.user._id);
        const [pending, all, todayStats] = await Promise.all([
            oi33Model.meowListPending(),
            oi33Model.meowListAll(page, FEED_PAGE_SIZE, status),
            oi33Model.meowTodayStats(),
        ]);
        const { posts, udict, likedMap } = await prepareMeowPosts('', all.docs, this.user._id);
        const pendingUids = pending.map((p) => p.uid).filter((u) => !udict[u]);
        if (pendingUids.length) {
            const extra = await UserModel.getList('', pendingUids);
            const oi33Extra = await oi33Model.getUserDataByUids(pendingUids);
            for (const u of pendingUids) {
                if (!extra[u]) continue;
                oi33Model.mergeOi33Fields(extra[u], oi33Extra[u]);
                udict[u] = extra[u];
            }
        }
        this.response.template = 'oi33_meow_admin.html';
        this.response.body = {
            pending, posts, udict, likedMap, todayStats,
            page, status, count: all.count, upcount: all.upcount,
        };
    }

    @param('action', Types.String)
    @param('id', Types.ObjectId)
    async post(domainId: string, action: string, id: ObjectId) {
        await checkOi33Admin(this.user._id);
        if (!['approve', 'reject'].includes(action)) throw new ValidationError('action');
        const post = await oi33Model.meowGetPost(id);
        if (!post) throw new NotFoundError(id);
        const ok = await oi33Model.meowSetStatus(id, action === 'approve' ? 'approved' : 'rejected', this.user._id);
        if (!ok) throw new ValidationError('该喵喵信息已被处理。');
        await addLog({
            type: 'meow', userId: post.uid, action, postId: id.toHexString(),
            status: action === 'approve' ? 'approved' : 'rejected',
        });
        this.response.redirect = this.url('oi33_meow_admin');
    }
}

// Permanently delete a meow post (admins only). Forwards of the post survive as
// independent posts; their dangling reference is detached. Deletion is logged.
class MeowAdminDeleteHandler extends Handler {
    @param('postId', Types.ObjectId)
    async post(domainId: string, postId: ObjectId) {
        await checkOi33Admin(this.user._id);
        if (!(await oi33Model.meowDelete(postId, this.user._id))) {
            throw new NotFoundError(postId);
        }
        const referer = this.request.headers.referer || '';
        this.response.redirect = referer || this.url('oi33_meow_admin');
    }
}

// --- Homepage module ---

// The 喵喵 homepage module renders only when manually configured in the
// `hydrooj.homepage` YAML (`meow: <limit>`). `getMeow` is registered on the
// HomeHandler so Hydro's config-driven module loader calls it; nothing is
// auto-injected into the homepage.
function registerHomeMeowModule(ctx: Context) {
    HomeHandler.prototype.getMeow = async function (domainId: string, limit: any) {
        const n = Math.max(1, Math.min(50, Number(limit) || HOME_FEED_LIMIT));
        const viewerUid = this.user?._id || 0;
        const rawPosts = await oi33Model.meowHomeFeed(viewerUid, n);
        const { posts, udict, likedMap } = await prepareMeowPosts(domainId, rawPosts, viewerUid);
        return { posts, udict, likedMap, total: rawPosts.length };
    };
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_meow_main', '/oi33/meow', MeowMainHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_meow_post', '/oi33/meow/post', MeowPostHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_meow_user', '/oi33/meow/user/:uid', MeowUserHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_meow_follow', '/oi33/meow/follow/:uid', MeowFollowHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_meow_unfollow', '/oi33/meow/unfollow/:uid', MeowUnfollowHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_meow_like', '/oi33/meow/like/:postId', MeowLikeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_meow_following', '/oi33/meow/following', MeowFollowingHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_meow_followers', '/oi33/meow/followers', MeowFollowersHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_meow_admin', '/oi33/meow/admin', MeowAdminHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_meow_admin_delete', '/oi33/meow/admin/:postId/delete', MeowAdminDeleteHandler, PRIV.PRIV_USER_PROFILE);
    // model/meow.ts (meowPostAdd) calls this kicker to run the rules+AI verdict.
    oi33Model.setMeowReviewKicker((uid, postId) => {
        moderateMeowAsync(uid, postId)
            .catch((e) => console.error('[oi33] meow AI review failed:', e));
    });
    registerMeowUserPanel(ctx);
    registerHomeMeowModule(ctx);
}
