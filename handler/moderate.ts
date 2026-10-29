import {
    Context, DiscussionModel, DocumentModel, ForbiddenError, Handler, MessageModel,
    NotFoundError, ObjectId, PERM, PRIV, Types, UserModel, ValidationError, db, param, query,
} from 'hydrooj';
import { oi33Model } from '../model';
import {
    DEFAULT_MODERATION_PROMPT, MAX_MATH_DEPTH, bioHashOf, bioQueueState, checkRules,
    configReviewWords, configWords, deleteModerationTarget, hashOf, hideModerationTarget,
    linkReviewPolicy, mathTooDeep, moderateContentInBackground, moderationEnabled, moderationTargetExists,
    normalizeText, unhideModerationTarget,
} from '../model/moderate';
import type {
    Oi33ModerationKind, Oi33ModerationTarget,
} from '../model/types';
import { addLog } from '../model/log';
import { checkOi33Admin, checkUserFlag } from './utils';

const DEFAULT_RATE_LIMIT = 50;

const KIND_LABELS: Record<Oi33ModerationKind, string> = {
    topic: '主题',
    reply: '回复',
    tailreply: '评论',
    topic_edit: '主题编辑',
    reply_edit: '回复编辑',
    tailreply_edit: '评论编辑',
    solution: '题解',
    solution_edit: '题解编辑',
    solution_reply: '题解评论',
    solution_reply_edit: '题解评论编辑',
    bio: '个人简介',
};

// --- Synchronous pre-check (instant; runs before the write is accepted) ---
// Only cheap, deterministic checks happen here — the AI verdict is always
// computed in the background after the content is published hidden.

function blockError(category: string) {
    return new ValidationError(`内容未通过社区规范审核（${category}），请修改后再发布。`);
}

export async function runModerationPrecheck(
    uid: number, kind: Oi33ModerationKind, text: string,
): Promise<void> {
    const flag = await checkUserFlag(uid);
    if (flag < 1) throw new ForbiddenError('完成实名认证后才能参与讨论。');
    // Technical limit, not moderation: staff bypass every check below, but a
    // deep-math post would freeze the site for them all the same.
    if (mathTooDeep(text)) {
        throw new ValidationError(`公式嵌套超过 ${MAX_MATH_DEPTH} 层，请简化后再发布。`);
    }
    // Teachers/admins post freely; their content is trusted.
    if (flag >= 2) return;
    const cfg = await oi33Model.aiGetConfig();
    // Default ON: an unset value means moderation is active (fail-closed).
    if (!moderationEnabled(cfg)) return;

    const limit = cfg.moderation_rate_limit || DEFAULT_RATE_LIMIT;
    if (await oi33Model.modCountTodayByUid(uid) >= limit) {
        throw new ForbiddenError('今日发言次数已达上限，请明天再试。');
    }

    const normalized = normalizeText(text);
    const ruleHit = checkRules(normalized, configWords(cfg), configReviewWords(cfg));
    if (ruleHit?.verdict === 'block') {
        await oi33Model.modAdd({
            uid,
            kind,
            contentHash: hashOf(normalized),
            preview: normalized.slice(0, 120),
            content: text,
            verdict: 'block',
            source: 'rules',
            category: ruleHit.category,
            aiReason: ruleHit.word ? `命中「${ruleHit.word}」` : '',
            status: 'done',
        });
        throw blockError(ruleHit.category);
    }
}

// --- Discussion hooks (handler lifecycle events) ---

function hookDomain(h: any): string {
    return h.domain?._id || h.args?.domainId || 'system';
}

// Never throws: on a DB/config error, fail closed (moderate) rather than
// letting content through unmoderated. Teachers bypass as usual.
async function shouldModerate(uid: number): Promise<boolean> {
    try {
        const flag = await checkUserFlag(uid);
        if (flag !== 1) return false; // teachers bypass; unverified were rejected in pre-check
        const cfg = await oi33Model.aiGetConfig();
        return moderationEnabled(cfg);
    } catch (e) {
        console.error('[oi33] shouldModerate failed, failing closed:', e);
        return true;
    }
}

async function hideBeforeReview(target: Oi33ModerationTarget) {
    try {
        await hideModerationTarget(target);
    } catch (e) {
        // Content is already written; still run the AI verdict so it lands in
        // the queue. If hiding failed it may stay visible until the verdict.
        console.error('[oi33] hideModerationTarget failed:', e);
    }
}

function applyDiscussionHooks(ctx: Context) {
    // 1. Topic create: instant pre-check, then hidden-publish + background AI.
    ctx.on('handler/before/DiscussionCreate#post', async (h: any) => {
        const { title, content } = h.args || {};
        if (typeof content !== 'string' || !content.trim()) return;
        const text = [title, content].filter((s) => typeof s === 'string' && s.trim()).join('\n');
        await runModerationPrecheck(h.user._id, 'topic', text);
    });

    // Hide student topics at insert time (discussion.add payload is mutable).
    ctx.on('discussion/before-add', async (payload: any) => {
        try {
            if (await shouldModerate(payload.owner)) payload.hidden = true;
        } catch (e) {
            // Safety net (shouldModerate never throws): keep student content
            // hidden rather than publishing unmoderated.
            console.error('[oi33] discussion/before-add hook failed:', e);
            payload.hidden = true;
        }
    });

    // Fire the background verdict once the topic exists.
    ctx.on('discussion/add', async (payload: any) => {
        try {
            if (!await shouldModerate(payload.owner)) return;
            const text = [payload.title, payload.content]
                .filter((s) => typeof s === 'string' && s.trim()).join('\n');
            if (!text) return;
            moderateContentInBackground({
                kind: 'topic',
                uid: payload.owner,
                text,
                target: { domainId: payload.domainId, did: payload.docId },
            });
        } catch (e) {
            console.error('[oi33] discussion/add moderation hook failed:', e);
        }
    });

    // 2. Replies / tail replies / their edits: instant pre-check…
    ctx.on('handler/before-operation/DiscussionDetail', async (h: any) => {
        const op = h.request.body?.operation;
        const content = h.args?.content;
        if (typeof content !== 'string' || !content.trim()) return;
        if (op === 'reply' || op === 'tail_reply') {
            // Cost gates only; the handler re-checks everything itself.
            if (!h.user.hasPerm(PERM.PERM_REPLY_DISCUSSION)) return;
            if (h.ddoc?.lock) return;
            await runModerationPrecheck(h.user._id, op === 'reply' ? 'reply' : 'tailreply', content);
        } else if (op === 'edit_reply' || op === 'edit_tail_reply') {
            if (!h.user.hasPerm(PERM.PERM_EDIT_DISCUSSION_REPLY_SELF)) return;
            await runModerationPrecheck(h.user._id, op === 'edit_reply' ? 'reply_edit' : 'tailreply_edit', content);
        }
    });

    // …then hide the freshly written content and fire the background verdict.
    ctx.on('handler/after/DiscussionDetail#post', async (h: any) => {
        const op = h.request.body?.operation;
        if (!['reply', 'tail_reply', 'edit_reply', 'edit_tail_reply'].includes(op)) return;
        const content = h.args?.content;
        if (typeof content !== 'string' || !content.trim()) return;
        let target: Oi33ModerationTarget | null = null;
        let kind: Oi33ModerationKind | null = null;
        try {
            if (!await shouldModerate(h.user._id)) return;
            const domainId = hookDomain(h);
            if (op === 'reply') {
                const dridRaw = h.response?.body?.drid;
                if (!dridRaw) return;
                target = { domainId, drid: new ObjectId(String(dridRaw)) };
                kind = 'reply';
            } else if (op === 'tail_reply') {
                // addTailReply returns nothing to the handler, so locate the
                // user's newest tail reply on this comment.
                const drid = new ObjectId(String(h.args.drid));
                const drdoc = await DiscussionModel.getReply(domainId, drid);
                const mine = (drdoc?.reply || []).filter((r: any) => r.owner === h.user._id);
                if (!mine.length) return;
                mine.sort((a: any, b: any) => b._id.getTimestamp().getTime() - a._id.getTimestamp().getTime());
                target = { domainId, drid, drrid: mine[0]._id };
                kind = 'tailreply';
            } else if (op === 'edit_reply') {
                target = { domainId, drid: new ObjectId(String(h.args.drid)) };
                kind = 'reply_edit';
            } else {
                target = {
                    domainId,
                    drid: new ObjectId(String(h.args.drid)),
                    drrid: new ObjectId(String(h.args.drrid)),
                };
                kind = 'tailreply_edit';
            }
            if (target && kind) {
                // 作者编辑精华题解 = 内容变了：先取消精华，等新一轮审核通过后再发布，
                // 避免出现「隐藏 + 精华」这种第四种状态。
                if (op === 'edit_solution' && !target.psrid) {
                    const psdoc: any = await DocumentModel.get(
                        domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, target.psid,
                    );
                    if (psdoc?.featured) {
                        await DocumentModel.set(
                            domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, target.psid,
                            { featured: false } as any,
                        );
                    }
                }
                await hideBeforeReview(target);
                // 题解（不是题解评论）只有三种状态：隐藏 / 发布 / 精华。
                // block/review 都保持隐藏，绝不自动删除；通过则恢复发布。
                const rootSolution = !target.psrid;
                moderateContentInBackground({
                    kind, uid: h.user._id, text: content, target,
                    ...(rootSolution ? {
                        applyVerdict: async (result: any) => {
                            if (result.verdict === 'pass') {
                                await unhideModerationTarget(target);
                                return;
                            }
                            await hideModerationTarget(target);
                            if (result.verdict === 'block') {
                                // Definitive rejection: tell the author why, so a hidden
                                // solution is actionable instead of a silent dead end.
                                await MessageModel.send(
                                    1, h.user._id,
                                    `你的题解未通过审核，已隐藏（仅你和管理员可见）。\n`
                                    + `原因：${result.aiReason || '不符合社区规范'}。\n`
                                    + '修改后重新提交即可再次审核。',
                                ).catch(() => {});
                            }
                        },
                    } : {}),
                });
            }
        } catch (e) {
            console.error('[oi33] moderation after-hook failed:', e);
        }
    });

    // 3. Topic edits: instant pre-check, then hide + background verdict.
    ctx.on('handler/before-operation/DiscussionEdit', async (h: any) => {
        if (h.request.body?.operation !== 'update') return;
        const { title, content } = h.args || {};
        if (typeof content !== 'string' || !content.trim()) return;
        // The handler will reject non-owners without edit perm; skip them too.
        if (!h.user.own(h.ddoc) && !h.user.hasPerm(PERM.PERM_EDIT_DISCUSSION)) return;
        const text = [title, content].filter((s) => typeof s === 'string' && s.trim()).join('\n');
        await runModerationPrecheck(h.user._id, 'topic_edit', text);
    });

    ctx.on('handler/after/DiscussionEdit#post', async (h: any) => {
        if (h.request.body?.operation !== 'update') return;
        const { title, content, did } = h.args || {};
        if (typeof content !== 'string' || !content.trim()) return;
        try {
            if (!await shouldModerate(h.user._id)) return;
            const text = [title, content].filter((s) => typeof s === 'string' && s.trim()).join('\n');
            const target = { domainId: hookDomain(h), did: new ObjectId(String(did)) };
            await hideBeforeReview(target);
            moderateContentInBackground({ kind: 'topic_edit', uid: h.user._id, text, target });
        } catch (e) {
            console.error('[oi33] discussion edit moderation hook failed:', e);
        }
    });

    // 4. Rendering: pending-review topics stay unreachable via shared links
    // (404 for non-owners/staff). Pending replies are never shown raw to
    // non-staff — their text is replaced with an "under review" notice until a
    // human approves them (the author sees the notice too). Staff still see the
    // real content, but with a leading "under review" prefix so it's obvious.
    const PENDING_NOTICE = '（审核中，审核通过后将显示）';
    const PENDING_PREFIX = '（审核中）';
    ctx.on('handler/after/DiscussionDetail', async (h: any) => {
        const body = h.response?.body;
        if (!body) return;
        const uid = h.user?._id || 0;
        const flag = uid ? await checkUserFlag(uid) : 0;
        const privileged = flag >= 2 || !!h.user?.hasPerm?.(PERM.PERM_EDIT_DISCUSSION);
        if (body.ddoc?.hidden && !privileged && body.ddoc.owner !== uid) {
            throw new NotFoundError('Discussion');
        }
        const maskReply = (doc: any) => {
            if (!doc.hidden) return doc;
            if (privileged) return { ...doc, content: `${PENDING_PREFIX} ${doc.content}` };
            return { ...doc, content: PENDING_NOTICE };
        };
        if (Array.isArray(body.drdocs)) {
            body.drdocs = body.drdocs.map((d: any) => {
                let doc = maskReply(d);
                if (Array.isArray(doc.reply) && doc.reply.length) {
                    doc = { ...doc, reply: doc.reply.map(maskReply) };
                }
                return doc;
            });
        }
    });
}

// --- Problem solution hooks (题解走同一套规则/AI/人工队列) ---

// Core stores solutions as document.TYPE_PROBLEM_SOLUTION with replies in a
// `reply` sub-array (see ProblemSolutionHandler). The lifecycle is the same as
// discussions: instant rule pre-check → hide + background AI → admin queue.
function applySolutionHooks(ctx: Context) {
    ctx.on('handler/before-operation/ProblemSolution', async (h: any) => {
        const op = h.request.body?.operation;
        const content = h.args?.content;
        if (typeof content !== 'string' || !content.trim()) return;
        if (op === 'submit') {
            if (!h.user.hasPerm(PERM.PERM_CREATE_PROBLEM_SOLUTION)) return;
            await runModerationPrecheck(h.user._id, 'solution', content);
        } else if (op === 'edit_solution') {
            if (!h.user.hasPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION)
                && !h.user.hasPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION_SELF)) return;
            await runModerationPrecheck(h.user._id, 'solution_edit', content);
        } else if (op === 'reply') {
            if (!h.user.hasPerm(PERM.PERM_REPLY_PROBLEM_SOLUTION)) return;
            await runModerationPrecheck(h.user._id, 'solution_reply', content);
        } else if (op === 'edit_reply') {
            if (!h.user.hasPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION_REPLY_SELF)) return;
            await runModerationPrecheck(h.user._id, 'solution_reply_edit', content);
        }
    });

    ctx.on('handler/after/ProblemSolution#post', async (h: any) => {
        const op = h.request.body?.operation;
        if (!['submit', 'edit_solution', 'reply', 'edit_reply'].includes(op)) return;
        const content = h.args?.content;
        if (typeof content !== 'string' || !content.trim()) return;
        try {
            if (!await shouldModerate(h.user._id)) return;
            const domainId = hookDomain(h);
            let target: Oi33ModerationTarget | null = null;
            let kind: Oi33ModerationKind | null = null;
            if (op === 'submit') {
                const psidRaw = h.response?.body?.psid;
                if (!psidRaw) return;
                target = { domainId, psid: new ObjectId(String(psidRaw)) };
                kind = 'solution';
            } else if (op === 'edit_solution') {
                target = { domainId, psid: new ObjectId(String(h.args.psid)) };
                kind = 'solution_edit';
            } else if (op === 'reply') {
                // postReply returns nothing to the handler, so locate the
                // user's newest comment on this solution.
                const psid = new ObjectId(String(h.args.psid));
                const psdoc: any = await DocumentModel.get(
                    domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid,
                );
                const mine = (psdoc?.reply || []).filter((r: any) => r.owner === h.user._id);
                if (!mine.length) return;
                mine.sort((a: any, b: any) => b._id.getTimestamp().getTime() - a._id.getTimestamp().getTime());
                target = { domainId, psid, psrid: mine[0]._id };
                kind = 'solution_reply';
            } else {
                target = {
                    domainId,
                    psid: new ObjectId(String(h.args.psid)),
                    psrid: new ObjectId(String(h.args.psrid)),
                };
                kind = 'solution_reply_edit';
            }
            if (target && kind) {
                // 作者编辑精华题解 = 内容变了：先取消精华，等新一轮审核通过后再发布，
                // 避免出现「隐藏 + 精华」这种第四种状态。
                if (op === 'edit_solution' && !target.psrid) {
                    const psdoc: any = await DocumentModel.get(
                        domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, target.psid,
                    );
                    if (psdoc?.featured) {
                        await DocumentModel.set(
                            domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, target.psid,
                            { featured: false } as any,
                        );
                    }
                }
                await hideBeforeReview(target);
                // 题解（不是题解评论）只有三种状态：隐藏 / 发布 / 精华。
                // block/review 都保持隐藏，绝不自动删除；通过则恢复发布。
                const rootSolution = !target.psrid;
                moderateContentInBackground({
                    kind, uid: h.user._id, text: content, target,
                    ...(rootSolution ? {
                        applyVerdict: async (result: any) => {
                            if (result.verdict === 'pass') {
                                await unhideModerationTarget(target);
                                return;
                            }
                            await hideModerationTarget(target);
                            if (result.verdict === 'block') {
                                // Definitive rejection: tell the author why, so a hidden
                                // solution is actionable instead of a silent dead end.
                                await MessageModel.send(
                                    1, h.user._id,
                                    `你的题解未通过审核，已隐藏（仅你和管理员可见）。\n`
                                    + `原因：${result.aiReason || '不符合社区规范'}。\n`
                                    + '修改后重新提交即可再次审核。',
                                ).catch(() => {});
                            }
                        },
                    } : {}),
                });
            }
        } catch (e) {
            console.error('[oi33] solution moderation after-hook failed:', e);
        }
    });
}

// --- Admin queue & settings ---

const KIND_GROUPS: Record<string, Oi33ModerationKind[]> = {
    discussion: ['topic', 'reply', 'tailreply', 'topic_edit', 'reply_edit', 'tailreply_edit'],
    solution: ['solution', 'solution_edit', 'solution_reply', 'solution_reply_edit'],
    bio: ['bio'],
};

class Ai33ModerationHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        // Close legacy pending entries that can't be operated on (missing
        // target), so they don't error out or clog the queue.
        await oi33Model.modCloseMissingTarget(this.user._id);
        const [pendingAll, recentAll, stats, cfg, todayCost, meowPending, hiddenSolutionCount] = await Promise.all([
            oi33Model.modListPending(),
            oi33Model.modListRecent(50),
            oi33Model.modStats(),
            oi33Model.aiGetConfig(),
            oi33Model.modTodayCost(),
            oi33Model.meowListPending(),
            oi33Model.countHiddenSolutions(),
        ]);
        const fallbackDomain = String((this as any).args?.domainId || 'system');
        // 给每条待审记录算出目标位置：题解需要 parentId(docId) 拼 URL，讨论直接
        // 用 did，简介落到用户资料页；这些链接只用于管理员查看，不参与裁决。
        // 内容可能来自其它域，URL 必须带上 target.domainId 才会生成 /d/<domain> 前缀。
        const solutionPsids = [...new Set([...pendingAll, ...recentAll]
            .map((entry) => (entry.target?.psid ? String(entry.target.psid) : ''))
            .filter(Boolean))];
        const solutionParents = solutionPsids.length
            ? await db.collection<any>('document').find({
                _id: { $in: solutionPsids.map((id) => new ObjectId(id)) },
                docType: DocumentModel.TYPE_PROBLEM_SOLUTION,
            }).project({ _id: 1, parentId: 1, domainId: 1 }).toArray()
            : [];
        const parentByPsid = new Map<string, number>(
            solutionParents.map((doc: any) => [String(doc._id), Number(doc.parentId)]),
        );
        // Replies are stored as their own documents with parentId = the topic
        // id; batch-resolve so a reply target links to the topic, not /discuss/<reply>.
        const replyIds = [...new Set([...pendingAll, ...recentAll]
            .map((entry) => (entry.target?.drid ? String(entry.target.drid) : ''))
            .filter(Boolean))];
        const replyParents = replyIds.length
            ? await db.collection<any>('document').find({
                _id: { $in: replyIds.map((id) => new ObjectId(id)) },
                docType: DocumentModel.TYPE_DISCUSSION_REPLY,
            }).project({ _id: 1, parentId: 1 }).toArray()
            : [];
        const didByDrid = new Map<string, any>(
            replyParents.map((doc: any) => [String(doc._id), doc.parentId]),
        );
        const targetDomainOf = (entry: any): string => {
            if (entry.kind === 'bio') return '';
            return String(entry.target?.domainId || '');
        };
        const targetUrlOf = (entry: any): string => {
            if (entry.kind === 'bio') return this.url('user_detail', { uid: entry.uid });
            const target = entry.target;
            if (!target) return '';
            const domain = target.domainId || fallbackDomain;
            if (target.psid) {
                const pid = parentByPsid.get(String(target.psid));
                return Number.isSafeInteger(pid) && pid > 0
                    ? this.url('problem_solution_detail', { domainId: domain, pid, sid: target.psid }) : '';
            }
            if (target.did) return this.url('discussion_detail', { domainId: domain, did: target.did });
            if (target.drid) {
                const did = didByDrid.get(String(target.drid));
                return did ? this.url('discussion_detail', { domainId: domain, did }) : '';
            }
            return '';
        };
        for (const entry of pendingAll) {
            (entry as any).targetUrl = targetUrlOf(entry);
            (entry as any).targetDomain = targetDomainOf(entry);
        }
        for (const entry of recentAll) {
            (entry as any).targetUrl = targetUrlOf(entry);
            (entry as any).targetDomain = targetDomainOf(entry);
        }
        for (const post of meowPending) {
            (post as any).targetUrl = this.url('oi33_meow_user', { uid: post.uid });
        }
        const args = (this as any).args || {};
        const kind = Object.prototype.hasOwnProperty.call(KIND_GROUPS, String(args.kind))
            ? String(args.kind) : 'all';
        const memberKinds = KIND_GROUPS[kind];
        const pending = memberKinds ? pendingAll.filter((e) => memberKinds.includes(e.kind)) : pendingAll;
        const recent = memberKinds ? recentAll.filter((e) => memberKinds.includes(e.kind)) : recentAll;
        const countOf = (group: string) => pendingAll.filter((e) => KIND_GROUPS[group].includes(e.kind)).length;
        const kindTabs = [
            { id: 'all', label: '全部', count: pendingAll.length },
            { id: 'discussion', label: '讨论', count: countOf('discussion') },
            { id: 'solution', label: '题解', count: countOf('solution') },
            { id: 'bio', label: '简介', count: countOf('bio') },
        ];
        // 隐藏题解有独立页面（可能来自任意域），主页只保留入口与数量。
        const uids = [...new Set([
            ...pendingAll.map((e) => e.uid),
            ...recentAll.map((e) => e.uid),
            ...meowPending.map((post) => post.uid),
        ].filter((uid) => Number.isSafeInteger(uid) && uid > 0))];
        const udict = uids.length ? await UserModel.getList('', uids) : {};
        // Flag queued bio versions that are no longer the live bio: they can
        // only be closed, and the bulk button clears them all at once.
        const bioEntries = pendingAll.filter((e) => e.kind === 'bio');
        const liveBios = bioEntries.length
            ? await oi33Model.getLiveBios([...new Set(bioEntries.map((e) => e.uid))])
            : {};
        let staleBioCount = 0;
        for (const entry of bioEntries) {
            const state = bioQueueState(entry, liveBios[entry.uid]);
            (entry as any).bioState = state;
            if (state === 'stale') staleBioCount++;
        }
        let notice = '';
        if (args.expired) {
            notice = '该审核记录对应的简介已被本人修改（或账号不存在），记录已标记为失效；'
                + '用户的简介状态未被改动。';
        } else if (args.closed !== undefined) {
            notice = `已清理 ${Number(args.closed) || 0} 条失效的个人简介审核记录。`;
        } else if (args.meow === 'approved') {
            notice = '喵喵已通过审核并展示。';
        } else if (args.meow === 'rejected') {
            notice = '喵喵已驳回（不会展示）。';
        } else if (args.solution === 'published') {
            notice = '题解已恢复发布。';
        }
        this.response.template = 'oi33_ai_moderation.html';
        this.response.body = {
            pending,
            recent,
            stats,
            config: cfg,
            todayCost: todayCost.toFixed(4),
            udict,
            kindLabels: KIND_LABELS,
            kind,
            kindTabs,
            defaultPrompt: DEFAULT_MODERATION_PROMPT,
            staleBioCount,
            notice,
            meowPending,
            hiddenSolutionCount,
        };
    }

    @param('action', Types.String)
    @param('id', Types.ObjectId, true)
    @param('moderation_enabled', Types.String, true)
    @param('moderation_model', Types.String, true)
    @param('moderation_prompt', Types.String, true)
    @param('moderation_prompt_solution', Types.String, true)
    @param('moderation_words', Types.String, true)
    @param('moderation_review_words', Types.String, true)
    @param('moderation_link_review', Types.String, true)
    @param('moderation_link_allow', Types.String, true)
    @param('moderation_daily_budget', Types.Float, true)
    @param('moderation_rate_limit', Types.UnsignedInt, true)
    @param('from', Types.String, true)
    async post(
        // First param must be named domainId* — the framework only injects
        // args.domainId as the first positional arg when the source name
        // starts with "domainid" (see @hydrooj/framework decorators.ts);
        // any other name receives the whole raw args object instead. The bio
        // branch reads the bio straight from the core user collection, so the
        // value itself is only needed for this injection contract.
        domainId: string, action: string, id?: ObjectId,
        moderation_enabled?: string, moderation_model?: string, moderation_prompt?: string,
        moderation_prompt_solution?: string,
        moderation_words?: string, moderation_review_words?: string,
        moderation_link_review?: string, moderation_link_allow?: string,
        moderation_daily_budget = 0, moderation_rate_limit = 0,
        from?: string,
    ) {
        await checkOi33Admin(this.user._id);
        if (action === 'meow_approve' || action === 'meow_reject') {
            if (!id) throw new ValidationError('缺少喵喵 ID。');
            const post = await oi33Model.meowGetPost(id);
            if (!post) throw new NotFoundError(id);
            const next = action === 'meow_approve' ? 'approved' : 'rejected';
            const ok = await oi33Model.meowSetStatus(id, next, this.user._id);
            if (!ok) throw new ValidationError('该喵喵信息已被处理。');
            await addLog({
                type: 'meow', userId: post.uid, action: next, postId: id.toHexString(), status: next,
            });
            this.response.redirect = this.url('oi33_ai_moderation', {
                query: { meow: next },
            });
            return;
        }
        if (action === 'solution_publish' && id) {
            const doc = await oi33Model.publishHiddenSolution(id);
            if (!doc) throw new NotFoundError(id);
            await addLog({
                type: 'solution', userId: Number((doc as any).owner) || 0,
                action: 'publish', psid: String(id), reason: '审核中心恢复发布',
            } as any);
            this.response.redirect = from === 'hidden'
                ? this.url('oi33_ai_hidden_solutions', { query: { published: '1' } })
                : this.url('oi33_ai_moderation', { query: { solution: 'published' } });
            return;
        }
        if (action === 'save_settings') {
            await oi33Model.aiSaveConfig({
                moderation_enabled: moderation_enabled === '1' ? '1' : '',
                moderation_model: (moderation_model || '').trim() || 'deepseek-v4-flash',
                // Empty prompt = fall back to the built-in default.
                moderation_prompt: (moderation_prompt || '').trim(),
                // Empty = reuse the general moderation prompt (meow/discussion/bio).
                moderation_prompt_solution: (moderation_prompt_solution || '').trim(),
                moderation_words: moderation_words || '',
                moderation_review_words: moderation_review_words || '',
                // Invalid/missing → 'external': internal links stay out of the
                // queue, links to other sites still get a human look.
                moderation_link_review: linkReviewPolicy({ moderation_link_review }),
                moderation_link_allow: moderation_link_allow || '',
                moderation_daily_budget: Math.max(0, moderation_daily_budget || 0),
                moderation_rate_limit: Math.max(0, moderation_rate_limit || 0),
            });
        } else if (action === 'expire' && id) {
            // Close a record without deciding it. Only records that can never
            // be applied qualify: bio versions the user already replaced, and
            // discussion entries whose target is gone (the same ones the page
            // closes by itself when it loads). A decidable entry must be
            // approved or rejected, never silently dropped.
            const entry = await oi33Model.modGet(id);
            if (!entry || entry.status !== 'pending') throw new ValidationError('该条目已被处理。');
            const expirable = entry.kind === 'bio'
                || !entry.target || !await moderationTargetExists(entry.target);
            if (!expirable) throw new ValidationError('该条目仍可处理，请选择通过或驳回。');
            await oi33Model.modExpireEntries([id], this.user._id);
            this.response.redirect = this.url('oi33_ai_moderation', { query: { expired: '1' } });
            return;
        } else if (action === 'expire_stale_bio') {
            // Bulk cleanup of every queued bio version that is no longer live.
            const closed = await oi33Model.expireStaleBioEntries(this.user._id);
            this.response.redirect = this.url('oi33_ai_moderation', { query: { closed: String(closed) } });
            return;
        } else if ((action === 'approve' || action === 'reject') && id) {
            const entry = await oi33Model.modGet(id);
            if (!entry || entry.status !== 'pending') throw new ValidationError('该条目已被处理。');
            // Bio entries have no discussion target: they flip the stored bio
            // review state directly. The decision is tied to the bio version
            // the record was created for, so it is only applied while that
            // version still is the live bio.
            if (entry.kind === 'bio') {
                const liveBio = await oi33Model.getLiveBio(entry.uid);
                const state = bioQueueState(entry, liveBio);
                if (state === 'stale') {
                    // The user edited the bio again (or cleared it, or the
                    // account is gone) after this record was created, so the
                    // record can never be applied. Close it as stale instead of
                    // failing: the queue stays usable and the current bio is
                    // left exactly as it is (the newer edit has its own record).
                    console.warn(`[oi33] bio entry ${id} (uid ${entry.uid}) is stale: `
                        + `reviewed version no longer matches the live bio (live length ${liveBio?.length ?? -1})`);
                    await oi33Model.modExpireEntries([id], this.user._id);
                    this.response.redirect = this.url('oi33_ai_moderation', { query: { expired: '1' } });
                    return;
                }
                const status = action === 'approve' ? 'approved' : 'rejected';
                // The hash guard keeps a concurrent edit safe. When the write
                // did not match, re-read once: an edit landing in between makes
                // the record stale, while a merely drifted hash (e.g. written
                // by an older batch run) still describes this exact text — then
                // the reviewed text is authoritative and its hash is rewritten,
                // otherwise an approval would leave the bio invisible.
                if (!await oi33Model.bioSetStatus(entry.uid, entry.contentHash, status)) {
                    const liveAgain = await oi33Model.getLiveBio(entry.uid);
                    if (bioQueueState(entry, liveAgain) === 'stale') {
                        console.warn(`[oi33] bio entry ${id} (uid ${entry.uid}): bio changed during the decision, `
                            + 'closing the record as stale');
                        await oi33Model.modExpireEntries([id], this.user._id);
                        this.response.redirect = this.url('oi33_ai_moderation', { query: { expired: '1' } });
                        return;
                    }
                    console.warn(`[oi33] bio entry ${id} (uid ${entry.uid}): stored bio_hash drifted, `
                        + 'applying the decision to the verified live text');
                    await oi33Model.bioSetReviewed(entry.uid, bioHashOf(liveAgain as string), status);
                }
                if (action === 'reject') {
                    await MessageModel.send(
                        1, entry.uid,
                        '你的个人简介人工审核未通过，不会对其他用户展示。'
                        + '可在「账号设置」中修改后重新提交（两次修改间隔 2 小时）。',
                    ).catch(() => {});
                }
                await oi33Model.modSetStatus(id, status, this.user._id);
                this.response.redirect = this.url('oi33_ai_moderation');
                return;
            }
            // Entries from before the target field existed, or whose content was
            // already removed, can't be operated on — close them so the queue
            // isn't stuck, recording the admin's choice.
            if (!entry.target || !await moderationTargetExists(entry.target)) {
                console.warn(`[oi33] ${action} ${id}: target missing or already gone, closing entry`);
                await oi33Model.modSetStatus(id, action === 'approve' ? 'approved' : 'rejected', this.user._id);
                this.response.redirect = this.url('oi33_ai_moderation');
                return;
            }
            if (action === 'approve') {
                // Approved content simply becomes visible again; deliberately
                // no站内信, so no "received a message" popup.
                await unhideModerationTarget(entry.target);
                await oi33Model.modSetStatus(id, 'approved', this.user._id);
            } else if (entry.target.psid && !entry.target.psrid) {
                // 题解只有三态：人工驳回也保持隐藏（可编辑后重新提交），不删除。
                await hideModerationTarget(entry.target);
                await oi33Model.modSetStatus(id, 'rejected', this.user._id);
            } else {
                // Reject is deliberately silent: content is removed with no
                // notification (the standard richtext message didn't render).
                await deleteModerationTarget(entry.target);
                await oi33Model.modSetStatus(id, 'rejected', this.user._id);
            }
        }
        this.response.redirect = this.url('oi33_ai_moderation');
    }
}

// 隐藏题解独立页：被规则/AI 隐藏、又不在人工队列里的题解，可能来自任意域，
// 所以从内容审核主页拆出来，按目标域筛选并生成带 /d/<domain> 的链接。
class Ai33HiddenSolutionsHandler extends Handler {
    @query('domain', Types.String, true)
    async get(domainId: string, domainFilter = '') {
        await checkOi33Admin(this.user._id);
        const filter = String(domainFilter || '').trim();
        const args = (this as any).args || {};
        const [docs, domains] = await Promise.all([
            oi33Model.listHiddenSolutions(200, filter || undefined),
            db.collection<any>('document').distinct('domainId', {
                docType: DocumentModel.TYPE_PROBLEM_SOLUTION,
                hidden: true,
            }) as Promise<string[]>,
        ]);
        const uids = [...new Set(docs
            .map((doc: any) => Number(doc.owner))
            .filter((uid) => Number.isSafeInteger(uid) && uid > 0))];
        const udict = uids.length ? await UserModel.getList('', uids) : {};
        for (const doc of docs) {
            const targetDomain = String(doc.domainId || 'system');
            (doc as any).targetDomain = targetDomain;
            (doc as any).targetUrl = Number(doc.parentId) > 0
                ? this.url('problem_solution_detail', {
                    domainId: targetDomain, pid: doc.parentId, sid: doc._id,
                })
                : '';
        }
        this.response.template = 'oi33_ai_hidden_solutions.html';
        this.response.body = {
            docs,
            udict,
            domains: [...new Set(domains.map(String))].sort(),
            domain: filter,
            notice: args.published ? '题解已恢复发布。' : '',
            noDomain: !filter,
        };
    }

    @param('id', Types.ObjectId)
    @param('domain', Types.String, true)
    async post(domainId: string, id: ObjectId, domainFilter?: string) {
        await checkOi33Admin(this.user._id);
        const doc = await oi33Model.publishHiddenSolution(id);
        if (!doc) throw new NotFoundError(id);
        await addLog({
            type: 'solution', userId: Number((doc as any).owner) || 0,
            action: 'publish', psid: String(id), reason: '审核中心恢复发布（隐藏题解页）',
        } as any);
        const filter = String(domainFilter || '').trim();
        this.response.redirect = this.url('oi33_ai_hidden_solutions', {
            query: { ...(filter ? { domain: filter } : {}), published: '1' },
        });
    }
}

export async function apply(ctx: Context) {
    applyDiscussionHooks(ctx);
    applySolutionHooks(ctx);
    ctx.Route('oi33_ai_moderation', '/oi33/ai/moderation', Ai33ModerationHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route(
        'oi33_ai_hidden_solutions', '/oi33/ai/moderation/hidden-solutions',
        Ai33HiddenSolutionsHandler, PRIV.PRIV_USER_PROFILE,
    );
}
