import { DiscussionModel, DocumentModel, db, ObjectId } from 'hydrooj';
import { aiChat, aiGetConfig, aiResolveChatConfig } from './ai';
import {
    DEFAULT_MODERATION_PROMPT, MAX_AI_INPUT, MAX_MATH_DEPTH, REVIEW_WORD_CATEGORY,
    bioHashMatches, bioHashOf, bioQueueState, checkRules, configReviewWords, configWords,
    hashOf, mathTooDeep, moderationEnabled, normalizeText, sameBioText,
    sanitizeModerationCategory,
} from './moderate-rules';
import type { BioQueueState, RuleHit } from './moderate-rules';
import type {
    Oi33AiConfig, Oi33AiModeration, Oi33ModerationKind, Oi33ModerationSource,
    Oi33ModerationStatus, Oi33ModerationTarget, Oi33ModerationVerdict,
} from './types';

// The pure rule layer lives in ./moderate-rules so it can be unit-tested
// without a database; re-exported here so existing './moderate' consumers keep
// working.
export {
    DEFAULT_MODERATION_PROMPT, MAX_AI_INPUT, MAX_MATH_DEPTH, REVIEW_WORD_CATEGORY,
    bioHashMatches, bioHashOf, bioQueueState, checkRules, configReviewWords, configWords,
    hashOf, mathTooDeep, moderationEnabled, normalizeText, sameBioText,
    sanitizeModerationCategory,
};
export type { BioQueueState, RuleHit };

export const moderationColl = db.collection('oi33_ai_moderation');

export async function ensureModerationIndexes() {
    await Promise.all([
        moderationColl.createIndex({ contentHash: 1, createdAt: -1 }),
        moderationColl.createIndex({ status: 1, createdAt: -1 }),
        moderationColl.createIndex({ uid: 1, createdAt: -1 }),
        moderationColl.createIndex({ createdAt: -1 }),
    ]);
}

export async function modAdd(entry: Omit<Oi33AiModeration, '_id' | 'createdAt'>) {
    const doc = { ...entry, _id: new ObjectId(), createdAt: new Date() };
    await moderationColl.insertOne(doc);
    return doc;
}

export async function modGet(id: ObjectId) {
    return await moderationColl.findOne({ _id: id });
}

export async function modListPending() {
    return await moderationColl.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(200).toArray();
}

// Close pending entries that can never be operated on (they predate the
// target field, or the target is an empty object). Otherwise clicking
// approve/reject on them fails and they clog the queue forever.
// Bio entries are target-less by design and handled separately — never close.
export async function modCloseMissingTarget(handlerUid = 0) {
    await moderationColl.updateMany(
        { status: 'pending', kind: { $ne: 'bio' }, $or: [{ target: { $exists: false } }, { target: {} }] },
        { $set: { status: 'done', handledAt: new Date(), handler: handlerUid } },
    );
}

export async function modListRecent(limit = 50) {
    return await moderationColl.find({ status: { $ne: 'pending' } })
        .sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function modSetStatus(id: ObjectId, status: Oi33ModerationStatus, handlerUid: number) {
    await moderationColl.updateOne(
        { _id: id },
        { $set: { status, handledAt: new Date(), handler: handlerUid } },
    );
}

// Close entries that can never be decided any more (the reviewed content is
// gone, or a newer version superseded them) as 'stale'. Only pending entries
// are touched, so a record another admin already handled is left alone.
// Closing never changes the moderated content itself — it only clears the
// queue, which is why both the individual and the bulk cleanup use it.
export async function modExpireEntries(ids: ObjectId[], handlerUid = 0) {
    if (!ids.length) return 0;
    const res = await moderationColl.updateMany(
        { _id: { $in: ids }, status: 'pending' },
        { $set: { status: 'stale', handledAt: new Date(), handler: handlerUid } },
    );
    return res.modifiedCount;
}

// Verdict cache: same normalized content reuses a recent final verdict,
// so reposting spam doesn't burn another AI call. Only rule/AI verdicts are
// cached — rate-limit and fuse outcomes are circumstantial, not content-based.
export async function modFindCachedVerdict(contentHash: string) {
    return await moderationColl.findOne({
        contentHash,
        status: { $in: ['done', 'approved', 'rejected'] },
        verdict: { $in: ['pass', 'block'] },
        source: { $in: ['ai', 'rules'] },
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
    }, { sort: { createdAt: -1 } });
}

function startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

export async function modCountTodayByUid(uid: number) {
    return await moderationColl.countDocuments({ uid, createdAt: { $gte: startOfToday() } });
}

// Today's AI spend on moderation, for the budget fuse.
export async function modTodayCost(): Promise<number> {
    const rows = await moderationColl.aggregate<{ cost: number }>([
        { $match: { createdAt: { $gte: startOfToday() }, source: 'ai' } },
        { $group: { _id: null, cost: { $sum: '$cost' } } },
    ]).toArray();
    return rows[0]?.cost || 0;
}

export async function modStats() {
    const rows = await moderationColl.aggregate<{
        _id: { status: Oi33ModerationStatus; verdict: Oi33ModerationVerdict };
        count: number;
    }>([
        { $match: { createdAt: { $gte: startOfToday() } } },
        { $group: { _id: { status: '$status', verdict: '$verdict' }, count: { $sum: 1 } } },
    ]).toArray();
    const stats = {
        pending: 0, pass: 0, block: 0, review: 0, handled: 0,
    };
    for (const row of rows) {
        if (row._id.status === 'pending') stats.pending += row.count;
        else if (row._id.status === 'approved' || row._id.status === 'rejected' || row._id.status === 'stale') stats.handled += row.count;
        else if (row._id.verdict === 'pass') stats.pass += row.count;
        else if (row._id.verdict === 'block') stats.block += row.count;
        else if (row._id.verdict === 'review') stats.review += row.count;
    }
    return stats;
}

// --- Reusable moderation engine -------------------------------------------
// Every content type (discussion topics/replies, problem solutions, bios, and
// any future feature) runs the same three layers: cheap deterministic rules →
// AI verdict → human queue. This section owns those layers plus the generic
// "apply the verdict to a target" action, so a feature only has to describe
// its text and how to hide/unhide/delete the content.

// The rule layer (normalization, hashing, math-depth guard, keyword checks,
// config word parsing, category whitelist and the default prompt) lives in
// ./moderate-rules and is re-exported above.

export interface ModerationVerdict {
    verdict: Oi33ModerationVerdict;
    source: Oi33ModerationSource;
    category: string;
    aiReason?: string;
    model?: string;
    cost?: number;
}

// The shared verdict engine: cache → rules → budget fuse → AI (fail-closed),
// then the rule layer has the final say over review-words. Never throws.
export async function runAiVerdict(uid: number, normalized: string, hash: string, cfg: any): Promise<ModerationVerdict> {
    // Cache: identical normalized content reuses a recent final verdict.
    const cached = await modFindCachedVerdict(hash);
    if (cached) return { verdict: cached.verdict, source: 'cache', category: cached.category };

    const ruleHit = checkRules(normalized, configWords(cfg), configReviewWords(cfg));
    if (ruleHit?.verdict === 'block') {
        return {
            verdict: 'block', source: 'rules', category: ruleHit.category,
            aiReason: ruleHit.word ? `命中「${ruleHit.word}」` : '',
        };
    }

    // Budget fuse: over the daily cap → everything goes to human review.
    const budget = cfg.moderation_daily_budget || 0;
    if (budget > 0 && (await modTodayCost()) >= budget) {
        return { verdict: 'review', source: 'fuse', category: ruleHit?.category || '其他' };
    }

    // AI layer. Any failure here fails closed (→ human review), never open.
    const config = await aiResolveChatConfig(cfg.moderation_model || 'deepseek-v4-flash');
    if (!config.apiKey) {
        return {
            verdict: 'review', source: 'error', category: ruleHit?.category || '其他',
            aiReason: 'no api key configured',
        };
    }
    const systemPrompt = (cfg.moderation_prompt || '').trim() || DEFAULT_MODERATION_PROMPT;
    const userPrompt = `<post>\n${normalized.slice(0, MAX_AI_INPUT)}\n</post>`;
    const response = await aiChat({
        config,
        system: systemPrompt,
        user: userPrompt,
        maxTokens: 1024,
        json: true,
        usage: { uid, type: 'moderation', deducted: false },
    });
    const { content: aiOut, error, cost } = response;

    let verdict: Oi33ModerationVerdict = 'review';
    let category = '其他';
    let aiReason = '';
    let source: Oi33ModerationSource = 'ai';
    if (error || !aiOut) {
        source = 'error';
        aiReason = error || 'empty response';
    } else {
        try {
            const parsed = JSON.parse(aiOut);
            if (['pass', 'block', 'review'].includes(parsed.verdict)) verdict = parsed.verdict;
            else source = 'error';
            category = sanitizeModerationCategory(parsed.category);
            aiReason = String(parsed.reason || '').slice(0, 200);
        } catch {
            source = 'error';
            aiReason = `unparseable response: ${aiOut.slice(0, 100)}`;
        }
    }

    // Rule layer wins over the AI. A review-word hit always lands in the human
    // queue — the AI alone can neither clear it (pass) nor escalate it (block).
    // Links keep the older, softer rule: the AI alone cannot clear them, but
    // its block still stands.
    if (ruleHit?.category === REVIEW_WORD_CATEGORY) {
        verdict = 'review';
        category = ruleHit.category;
        aiReason = ruleHit.word
            ? `命中待审词「${ruleHit.word}」${aiReason ? `；AI：${aiReason}` : ''}`
            : aiReason;
    } else if (verdict === 'pass' && ruleHit?.verdict === 'review') {
        verdict = 'review';
        category = ruleHit.category;
    }
    return {
        verdict, source, category, aiReason, model: config.model, cost,
    };
}

// Convenience for features that keep their own state/queue: normalize + hash +
// run the shared verdict engine. Prefer this over calling runAiVerdict directly
// so every caller hashes the exact same canonical text.
export async function evaluateContent(
    uid: number, text: string, cfg?: Oi33AiConfig,
): Promise<{ normalized: string; hash: string; verdict: ModerationVerdict }> {
    const normalized = normalizeText(text);
    const hash = hashOf(normalized);
    const config = cfg || await aiGetConfig();
    const verdict = await runAiVerdict(uid, normalized, hash, config);
    return { normalized, hash, verdict };
}

// --- Target actions ---

// Does the original content still exist? Guards the background verdict and the
// admin queue against entries whose post was deleted before being reviewed.
export async function moderationTargetExists(target: Oi33ModerationTarget): Promise<boolean> {
    if (target.psid) {
        const psdoc: any = await DocumentModel.get(
            target.domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, target.psid,
        );
        if (!psdoc) return false;
        if (!target.psrid) return true;
        return (psdoc.reply || []).some((r: any) => r._id.equals(target.psrid));
    }
    if (target.drrid && target.drid) {
        const [drdoc, drrdoc] = await DiscussionModel.getTailReply(target.domainId, target.drid, target.drrid);
        return !!(drdoc && drrdoc);
    }
    if (target.drid) return !!(await DiscussionModel.getReply(target.domainId, target.drid));
    if (target.did) return !!(await DiscussionModel.get(target.domainId, target.did));
    return false;
}

export async function hideModerationTarget(target: Oi33ModerationTarget) {
    if (target.psid) {
        if (target.psrid) {
            await DocumentModel.setSub(
                target.domainId, DocumentModel.TYPE_PROBLEM_SOLUTION,
                target.psid, 'reply', target.psrid, { hidden: true } as any,
            );
        } else {
            await DocumentModel.set(
                target.domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, target.psid, { hidden: true } as any,
            );
        }
    } else if (target.drrid && target.drid) {
        await DocumentModel.setSub(
            target.domainId, DocumentModel.TYPE_DISCUSSION_REPLY,
            target.drid, 'reply', target.drrid, { hidden: true } as any,
        );
    } else if (target.drid) {
        await DocumentModel.set(
            target.domainId, DocumentModel.TYPE_DISCUSSION_REPLY, target.drid, { hidden: true } as any,
        );
    } else if (target.did) {
        await DiscussionModel.edit(target.domainId, target.did, { hidden: true });
    }
}

export async function unhideModerationTarget(target: Oi33ModerationTarget) {
    // Already gone: nothing to restore. Skipping also avoids document.set's
    // upsert:true re-creating a phantom empty topic/reply.
    if (!await moderationTargetExists(target)) return;
    if (target.psid) {
        if (target.psrid) {
            await DocumentModel.setSub(
                target.domainId, DocumentModel.TYPE_PROBLEM_SOLUTION,
                target.psid, 'reply', target.psrid, { hidden: false } as any,
            );
        } else {
            await DocumentModel.set(
                target.domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, target.psid, { hidden: false } as any,
            );
        }
    } else if (target.drrid && target.drid) {
        await DocumentModel.setSub(
            target.domainId, DocumentModel.TYPE_DISCUSSION_REPLY,
            target.drid, 'reply', target.drrid, { hidden: false } as any,
        );
    } else if (target.drid) {
        await DocumentModel.set(
            target.domainId, DocumentModel.TYPE_DISCUSSION_REPLY, target.drid, { hidden: false } as any,
        );
    } else if (target.did) {
        await DiscussionModel.edit(target.domainId, target.did, { hidden: false });
    }
}

export async function deleteModerationTarget(target: Oi33ModerationTarget) {
    // Already gone: nothing to delete. Avoids delReply throwing
    // DocumentNotFoundError when the reply was removed in the meantime.
    if (!await moderationTargetExists(target)) return;
    if (target.psid) {
        if (target.psrid) {
            await DocumentModel.deleteSub(
                target.domainId, DocumentModel.TYPE_PROBLEM_SOLUTION,
                target.psid, 'reply', target.psrid,
            );
        } else {
            await DocumentModel.deleteOne(
                target.domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, target.psid,
            );
        }
    } else if (target.drrid && target.drid) {
        await DiscussionModel.delTailReply(target.domainId, target.drid, target.drrid);
    } else if (target.drid) {
        await DiscussionModel.delReply(target.domainId, target.drid);
    } else if (target.did) {
        await DiscussionModel.del(target.domainId, target.did);
    }
}

// Built-in resolution for the common case: pass restores visibility, block
// removes the content, review leaves it hidden for the human queue.
export async function applyModerationTarget(target: Oi33ModerationTarget, result: ModerationVerdict) {
    if (result.verdict === 'pass') await unhideModerationTarget(target);
    else if (result.verdict === 'block') await deleteModerationTarget(target);
}

// --- Content-agnostic orchestration ---

export interface ModerateContentOptions {
    kind: Oi33ModerationKind;
    uid: number;
    text: string;
    // Built-in target handling is used when `applyVerdict` is absent.
    target?: Oi33ModerationTarget;
    // Feature-specific reaction to the verdict (e.g. flip a bio/meow status).
    // Overrides the built-in target handling.
    applyVerdict?: (result: ModerationVerdict) => Promise<void> | void;
    // Write a row into oi33_ai_moderation (default true). Features with their
    // own review queue set this to false.
    record?: boolean;
    // For recorded entries: should a 'review' verdict wait for a human?
    // Default true. Pass false (or a lazy function that inspects the outcome of
    // `applyVerdict`) when the feature has already resolved the content another
    // way, e.g. a bio version that was superseded.
    queueForReview?: boolean | (() => boolean);
    cfg?: Oi33AiConfig;
}

// Runs the full background pipeline over already-hidden content: verdict
// (fail-closed) → action → queue entry. Never throws.
export async function moderateContent(opts: ModerateContentOptions): Promise<ModerationVerdict> {
    const { kind, uid, text } = opts;
    const normalized = normalizeText(text);
    const hash = hashOf(normalized);
    let result: ModerationVerdict;
    try {
        const cfg = opts.cfg || await aiGetConfig();
        result = await runAiVerdict(uid, normalized, hash, cfg);
    } catch (e: any) {
        result = {
            verdict: 'review', source: 'error', category: '其他',
            aiReason: String(e?.message || e).slice(0, 200),
        };
    }

    // Edits are never auto-deleted: blocking an edit would destroy the whole
    // pre-existing post. They stay hidden for a human instead.
    const isEdit = kind.includes('_edit');
    if (result.verdict === 'block' && isEdit) result.verdict = 'review';

    try {
        if (opts.applyVerdict) await opts.applyVerdict(result);
        else if (opts.target) await applyModerationTarget(opts.target, result);
    } catch (e: any) {
        // Action failed (e.g. deleted in the meantime) — fail closed.
        result = {
            ...result, verdict: 'review',
            aiReason: `action failed: ${String(e?.message || e).slice(0, 150)}`,
        };
    }

    if (opts.record !== false) {
        const queueForReview = typeof opts.queueForReview === 'function'
            ? opts.queueForReview()
            : (opts.queueForReview ?? true);
        await modAdd({
            uid,
            kind,
            contentHash: hash,
            preview: normalized.slice(0, 120),
            content: text,
            target: opts.target,
            verdict: result.verdict,
            source: result.source,
            category: result.category,
            aiReason: result.aiReason,
            model: result.model,
            cost: result.cost,
            status: result.verdict === 'review' && queueForReview ? 'pending' : 'done',
        }).catch((e) => console.error('[oi33] failed to log moderation entry:', e));
    }
    return result;
}

// Fire-and-forget variant for request-scoped hooks.
export function moderateContentInBackground(opts: ModerateContentOptions): void {
    moderateContent(opts).catch((e) => console.error('[oi33] moderateContent failed:', e));
}
