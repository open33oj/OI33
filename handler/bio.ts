import {
    Context, Handler, MessageModel, PRIV, UserModel, ValidationError,
} from 'hydrooj';
import { oi33Model } from '../model';
import { checkOi33Admin } from './utils';
import { bioHashOf, normalizeText, runAiVerdict } from './moderate';

// Bio edits go through Hydro core's HomeSettingsHandler (no content review
// there), so everything here hangs off its lifecycle hooks: the before-hook
// enforces the edit cooldown, the after-hook fires the background AI review.
// Display gating itself lives in mergeOi33Fields (udoc.bio_visible) and the
// user_detail / homepage-ranking templates.
const BIO_EDIT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const BIO_REVIEW_BATCH_ID = 'bio_review';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Bound concurrent background reviews; edits are rare so a small cap suffices.
let activeBioReviews = 0;
const MAX_CONCURRENT_BIO_REVIEWS = 3;

// Record every bio verdict in the shared moderation log so admins can see
// results on /oi33/ai/moderation; 'review' verdicts enter the human queue
// (status pending) — the bio stays hidden until an admin approves it there
// or the user edits again. Never throws.
async function recordBioVerdict(
    uid: number, bio: string, hash: string,
    result: { verdict: 'pass' | 'block' | 'review', source: string, category: string, aiReason?: string },
) {
    try {
        await oi33Model.modAdd({
            uid,
            kind: 'bio',
            contentHash: hash,
            preview: normalizeText(bio).slice(0, 120),
            content: bio,
            verdict: result.verdict,
            source: result.source as any,
            category: result.category,
            aiReason: result.aiReason || '',
            status: result.verdict === 'review' ? 'pending' : 'done',
        });
    } catch (e) {
        console.error('[oi33] bio moderation record failed:', e);
    }
}

// Notify the user by private message when their bio ends up hidden: blocked
// outright, or parked waiting for a human decision. Never throws.
async function notifyBioRejected(
    uid: number,
    result: { verdict: 'pass' | 'block' | 'review', category: string, aiReason?: string },
) {
    try {
        const state = result.verdict === 'block' ? '未通过审核' : '未通过自动审核，已转人工复核';
        const reason = result.aiReason ? `：${result.aiReason}` : '';
        await MessageModel.send(
            1, uid,
            `你的个人简介${state}（${result.category}）${reason}，审核通过前不会对其他用户展示。`
            + '可在「账号设置」中修改，审核通过后会自动公开（两次修改间隔 2 小时）。',
        );
    } catch (e) {
        console.error('[oi33] bio reject notification failed:', e);
    }
}

// Runs the shared rules + AI verdict engine over a freshly edited bio, then
// resolves it: pass -> approved (visible), block/review -> rejected (hidden
// until an admin approves in the queue or the user edits again). Never throws;
// any error fails closed to rejected + queued for a human.
async function moderateBioAsync(uid: number, bio: string, hash: string) {
    while (activeBioReviews >= MAX_CONCURRENT_BIO_REVIEWS) {
        await sleep(250);
    }
    activeBioReviews++;
    try {
        const cfg = await oi33Model.aiGetConfig();
        // Moderation explicitly switched off by an admin: auto-approve.
        if ((cfg.moderation_enabled ?? '1') !== '1') {
            await oi33Model.bioSetStatus(uid, hash, 'approved');
            return;
        }
        const result = await runAiVerdict(uid, normalizeText(bio), hash, cfg);
        await oi33Model.bioSetStatus(uid, hash, result.verdict === 'pass' ? 'approved' : 'rejected');
        await recordBioVerdict(uid, bio, hash, result);
        if (result.verdict !== 'pass') await notifyBioRejected(uid, result);
    } catch (e: any) {
        console.error('[oi33] bio moderation failed:', e);
        await oi33Model.bioSetStatus(uid, hash, 'rejected').catch(() => {});
        const fallback = {
            verdict: 'review' as const, source: 'error', category: '其他',
            aiReason: String(e?.message || e).slice(0, 200),
        };
        await recordBioVerdict(uid, bio, hash, fallback);
        await notifyBioRejected(uid, fallback);
    } finally {
        activeBioReviews--;
    }
}

// --- One-off batch review of every non-empty bio (manual admin trigger) ---

let bioReviewBatchRunning = false;

async function runBioReviewBatch(users: { _id: number, bio: string }[]) {
    const counters = {
        done: 0, generated: 0, applied: 0, skipped: 0, failed: 0,
    };
    try {
        const cfg = await oi33Model.aiGetConfig();
        const enabled = (cfg.moderation_enabled ?? '1') === '1';
        const oi33Dict = await oi33Model.getUserDataByUids(users.map((u) => u._id));
        for (const u of users) {
            try {
                const bio = String(u.bio || '');
                const hash = bioHashOf(bio);
                const cur = oi33Dict[u._id];
                // Idempotent: a bio whose current version already has a final
                // verdict is left untouched, so the batch is safe to re-run.
                if (cur?.bio_hash === hash
                    && (cur.bio_status === 'approved' || cur.bio_status === 'rejected')) {
                    counters.skipped++;
                } else {
                    let approved = true;
                    if (enabled) {
                        const result = await runAiVerdict(u._id, normalizeText(bio), hash, cfg);
                        approved = result.verdict === 'pass';
                        await oi33Model.bioSetReviewed(u._id, hash, approved ? 'approved' : 'rejected');
                        await recordBioVerdict(u._id, bio, hash, result);
                        if (!approved) await notifyBioRejected(u._id, result);
                    } else {
                        await oi33Model.bioSetReviewed(u._id, hash, 'approved');
                    }
                    if (approved) counters.generated++;
                    else counters.applied++;
                }
            } catch (e: any) {
                counters.failed++;
                console.error(`[oi33] bio review batch: user ${u._id} failed:`, e);
            }
            counters.done++;
            await oi33Model.aiBatchSaveStatus({ ...counters, currentSort: `UID ${u._id}` }, BIO_REVIEW_BATCH_ID);
            // Stay sequential and yield so a large batch cannot monopolize
            // the Hydro process (same discipline as the summary batch).
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await oi33Model.aiBatchSaveStatus({ finishedAt: new Date() }, BIO_REVIEW_BATCH_ID);
    } catch (e: any) {
        console.error('[oi33] bio review batch failed:', e);
        await oi33Model.aiBatchSaveStatus(
            { lastError: e?.message || String(e), finishedAt: new Date() },
            BIO_REVIEW_BATCH_ID,
        );
    } finally {
        await oi33Model.aiBatchSaveStatus({ running: false }, BIO_REVIEW_BATCH_ID).catch(() => {});
        bioReviewBatchRunning = false;
    }
}

class BioReviewBatchHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        const status = await oi33Model.aiBatchGetStatus(BIO_REVIEW_BATCH_ID);
        this.response.template = 'oi33_ai_bio_review.html';
        this.response.body = { status };
    }

    async post() {
        await checkOi33Admin(this.user._id);
        if (bioReviewBatchRunning) throw new ValidationError('批量审查正在进行中。');
        const users = await UserModel.getMulti({ bio: { $exists: true, $nin: ['', null] } } as any)
            .project({ _id: 1, bio: 1 } as any).toArray();
        if (!users.length) throw new ValidationError('没有个人简介非空的用户。');
        bioReviewBatchRunning = true;
        await oi33Model.aiBatchSaveStatus({
            running: true,
            total: users.length,
            done: 0,
            generated: 0,
            difficulties: 0,
            applied: 0,
            skipped: 0,
            failed: 0,
            currentSort: '',
            startedAt: new Date(),
            finishedAt: null as any,
            lastError: '',
        }, BIO_REVIEW_BATCH_ID);
        runBioReviewBatch(users as any);
        this.response.redirect = this.url('oi33_ai_bio_review');
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_ai_bio_review', '/oi33/ai/bio-review', BioReviewBatchHandler, PRIV.PRIV_USER_PROFILE);

    // Edit cooldown: reject a bio change within 2h of the previous one. Only
    // the account category carries bio, and unchanged text is not an edit.
    ctx.on('handler/before/HomeSettings#post', async (h: any) => {
        if (h.args?.category !== 'account') return;
        if (typeof h.args.bio !== 'string') return;
        const uid = Number(h.user?._id) || 0;
        if (!uid) return;
        if (h.args.bio.trim() === String(h.user.bio || '').trim()) return;
        const oi33 = (await oi33Model.getUserDataByUids([uid]))[uid];
        const editedAt = oi33?.bio_edited_at ? new Date(oi33.bio_edited_at).getTime() : 0;
        const remaining = editedAt + BIO_EDIT_COOLDOWN_MS - Date.now();
        if (remaining > 0) {
            throw new ValidationError(`个人简介修改冷却中，请 ${Math.ceil(remaining / 60000)} 分钟后再试。`);
        }
    });

    // After a successful settings save, detect a bio change and review it.
    // h.args.bio is exactly what core validated and stored (trimmed content).
    ctx.on('handler/after/HomeSettings#post', async (h: any) => {
        if (h.args?.category !== 'account') return;
        if (typeof h.args.bio !== 'string') return;
        const uid = Number(h.user?._id) || 0;
        if (!uid) return;
        try {
            const bio = h.args.bio.trim();
            const hash = bioHashOf(bio);
            const oi33 = (await oi33Model.getUserDataByUids([uid]))[uid];
            if (oi33?.bio_hash === hash) return; // unchanged or already reviewed
            await oi33Model.bioMarkEdited(uid, hash);
            // An emptied bio is trivially displayable (nothing renders).
            if (!bio) await oi33Model.bioSetStatus(uid, hash, 'approved');
            else moderateBioAsync(uid, bio, hash);
        } catch (e) {
            console.error('[oi33] bio after-hook failed:', e);
        }
    });
}
