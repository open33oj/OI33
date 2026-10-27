// 题解加精 (featured problem solutions).
//
// A `featured` flag is stored on the core document row, which makes the list
// order a plain index-free sort (`SolutionModel.getMulti` sorts by
// `{ featured: -1, vote: -1 }`, patched in handler/patches/display.ts). Featuring
// a solution used to be an administrator-only action; when the author is not
// staff (realname_flag < 2) the configured reward is paid out once per solution.
//
// Pure rules (config normalisation, reward text) live in
// ./solution-feature-rules.

import {
    DocumentModel, MessageModel, ObjectId, ProblemModel, ValidationError, db,
} from 'hydrooj';
import type { Oi33SolutionConfig, Oi33SolutionFeatureApply } from './types';
import { addLog } from './log';
import { AI_MAX_TOKENS, aiChat, aiGetConfig, aiResolveChatConfig } from './ai';
import { adjustCatCans } from './cat/can';
import { grantCatFood } from './cat/account';
import { userColl } from './user';
import {
    SOLUTION_CONFIG_ID, normalizeSolutionFeatureConfig, parseSolutionFeatureVerdict,
    solutionFeatureApplyId, solutionFeatureReviewSystemPrompt, solutionFeatureReviewUserPrompt,
    solutionRewardReason, solutionRewardText,
} from './solution-feature-rules';

export * from './solution-feature-rules';

export const solutionConfigColl = db.collection('oi33_solution_config');
// 一次申请 = 一条记录，_id = `${uid}:${YYYY-MM-DD}`，唯一键天然保证每天一篇。
export const solutionFeatureApplyColl = db.collection('oi33_solution_feature_apply');

export function isSolutionFeatured(doc: any): boolean {
    return doc?.featured === true;
}

export async function getSolutionFeatureConfig(): Promise<Oi33SolutionConfig> {
    const stored: any = await solutionConfigColl.findOne({ _id: SOLUTION_CONFIG_ID } as any);
    const normalized = normalizeSolutionFeatureConfig(stored);
    return {
        _id: SOLUTION_CONFIG_ID,
        ...normalized,
        updatedAt: stored?.updatedAt instanceof Date ? stored.updatedAt : new Date(0),
        ...(stored?.updatedBy === undefined ? {} : { updatedBy: stored.updatedBy }),
    };
}

export async function saveSolutionFeatureConfig(raw: any, operator: number, now = new Date()): Promise<Oi33SolutionConfig> {
    const normalized = normalizeSolutionFeatureConfig(raw);
    await solutionConfigColl.updateOne(
        { _id: SOLUTION_CONFIG_ID } as any,
        { $set: { ...normalized, updatedAt: now, updatedBy: operator } } as any,
        { upsert: true },
    );
    await addLog({
        type: 'solution', userId: operator, action: 'feature_config',
        reason: `${normalized.featureRewardType} ${normalized.featureRewardAmount}`
            + ` | AI: ${normalized.featureModel || 'default'} @ ${normalized.featurePassScore}`,
    } as any);
    return await getSolutionFeatureConfig();
}

export interface SolutionFeatureResult {
    featured: boolean;
    rewarded: boolean;
    rewardText: string;
    // Set when featuring succeeded but the reward could not be paid out.
    rewardError?: string;
    owner: number;
}

// Feature / unfeature one solution. Turning the flag on pays the configured
// reward once (tracked by `featuredRewarded`), and only when the author is a
// verified non-staff account — staff and unverified accounts get nothing.
export interface SetSolutionFeaturedOptions {
    // AI 申请流程会自己发一条合并了奖励信息的私信，避免两条通知。
    notify?: boolean;
}

export async function setSolutionFeatured(
    domainId: string,
    psid: ObjectId,
    featured: boolean,
    operator: number,
    now = new Date(),
    options: SetSolutionFeaturedOptions = {},
): Promise<SolutionFeatureResult> {
    const doc: any = await DocumentModel.get(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid);
    if (!doc) throw new ValidationError('题解不存在。');
    const owner = Number(doc.owner) || 0;

    if (!featured) {
        await DocumentModel.set(
            domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid,
            { featured: false } as any,
        );
        await addLog({
            type: 'solution', userId: operator, action: 'unfeature', uid: owner, psid: String(psid),
        } as any);
        return { featured: false, rewarded: false, rewardText: '', owner };
    }

    if (doc.hidden) throw new ValidationError('审核中的题解不能加精。');

    await DocumentModel.set(
        domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid,
        { featured: true, featuredAt: now, featuredBy: operator } as any,
    );
    await addLog({
        type: 'solution', userId: operator, action: 'feature', uid: owner, psid: String(psid),
    } as any);

    const config = await getSolutionFeatureConfig();
    const rewardText = solutionRewardText(config);
    if (doc.featuredRewarded || config.featureRewardType === 'none' || config.featureRewardAmount <= 0) {
        return { featured: true, rewarded: false, rewardText, owner };
    }

    const author: any = await userColl.findOne({ _id: owner } as any, { projection: { realname_flag: 1 } });
    const flag = Number(author?.realname_flag) || 0;
    // Staff (flag >= 2) is excluded by design; unverified accounts (flag < 1)
    // may not hold cat assets at all, so they are skipped too.
    if (flag < 1 || flag >= 2) {
        return { featured: true, rewarded: false, rewardText, owner };
    }

    try {
        if (config.featureRewardType === 'can') {
            await adjustCatCans(owner, operator, config.featureRewardAmount, solutionRewardReason());
        } else {
            await grantCatFood(owner, operator, config.featureRewardAmount, solutionRewardReason());
        }
    } catch (e: any) {
        console.error('[oi33] solution feature reward failed:', e);
        return {
            featured: true, rewarded: false, rewardText, owner,
            rewardError: e?.message || '奖励发放失败。',
        };
    }

    await DocumentModel.set(
        domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid,
        { featuredRewarded: true, featuredRewardText: rewardText } as any,
    );
    if (options.notify !== false) {
        try {
            const pid = Number(doc.parentId);
            await MessageModel.send(
                1, owner,
                `你的题解（题目 ${Number.isSafeInteger(pid) ? pid : doc.parentId}）被加为精华，`
                + `获得奖励：${rewardText}。`,
            );
        } catch (e) {
            console.error('[oi33] solution feature notification failed:', e);
        }
    }
    return { featured: true, rewarded: true, rewardText, owner };
}

// --- 用户申请加精 + AI 审核 ------------------------------------------------

async function notifySolutionAuthor(uid: number, text: string) {
    try {
        await MessageModel.send(1, uid, text);
    } catch (e) {
        console.error('[oi33] solution feature apply notification failed:', e);
    }
}

function featureApplyHeading(pid: number): string {
    return `你的题解（题目 ${pid}）`;
}

export async function solutionFeatureApplyUsedToday(uid: number, now = new Date()): Promise<boolean> {
    if (!uid) return false;
    const found = await solutionFeatureApplyColl.findOne({ _id: solutionFeatureApplyId(uid, now) } as any);
    return !!found;
}

// 申请加精：校验归属/状态 → 原子占当天额度（唯一 _id）→ 返回待审核记录。
// 真正的 AI 调用由 handler 在后台触发（runSolutionFeatureReview）。
export async function applySolutionFeature(
    domainId: string,
    psid: ObjectId,
    uid: number,
    now = new Date(),
): Promise<Oi33SolutionFeatureApply> {
    const doc: any = await DocumentModel.get(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid);
    if (!doc) throw new ValidationError('题解不存在。');
    if (Number(doc.owner) !== uid) throw new ValidationError('只能申请自己的题解。');
    if (doc.hidden) throw new ValidationError('审核中的题解不能申请精华。');
    if (doc.featured) throw new ValidationError('这篇题解已经是精华了。');
    const pid = Number(doc.parentId);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new ValidationError('题解缺少题目信息。');
    const record: Oi33SolutionFeatureApply = {
        _id: solutionFeatureApplyId(uid, now),
        uid,
        domainId,
        psid,
        pid,
        status: 'pending',
        createdAt: now,
    };
    try {
        await solutionFeatureApplyColl.insertOne(record as any);
    } catch (e: any) {
        if (e?.code === 11000) {
            throw new ValidationError('今天已经申请过一篇题解加精了，明天再来吧。');
        }
        throw e;
    }
    await addLog({
        type: 'solution', userId: uid, action: 'feature_apply',
        psid: String(psid), reason: `申请加精（题目 ${pid}）`,
    } as any);
    return record;
}

// 后台执行一次 AI 审核。任何基础设施异常都会删除记录、退回当天额度；
// 内容不合格则保留记录（额度已用）并私信修改建议。
export async function runSolutionFeatureReview(applicationId: string): Promise<void> {
    const application: any = await solutionFeatureApplyColl.findOne({ _id: applicationId } as any);
    if (!application || application.status !== 'pending') return;
    const now = new Date();
    const pid = Number(application.pid);
    const heading = featureApplyHeading(pid);

    const refund = async (message: string, reason: string) => {
        await solutionFeatureApplyColl.deleteOne({ _id: applicationId } as any);
        await notifySolutionAuthor(application.uid, `${heading}本次加精申请未完成：${message}`);
        await addLog({
            type: 'solution', userId: application.uid, action: 'feature_apply_error',
            psid: String(application.psid), reason: `${reason}（额度已退回）`,
        } as any);
    };

    const doc: any = await DocumentModel.get(
        application.domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, application.psid,
    );
    if (!doc || Number(doc.owner) !== application.uid) {
        await refund('题解已不存在或已转交他人，本次不消耗额度。', 'target missing');
        return;
    }
    if (doc.hidden) {
        await refund('题解当前处于隐藏状态，本次不消耗额度；通过审核后再申请。', 'target hidden');
        return;
    }
    if (doc.featured) {
        await refund('这篇题解已经是精华了，无需重复申请，本次不消耗额度。', 'already featured');
        return;
    }

    const cfg = await aiGetConfig();
    const solutionConfig = await getSolutionFeatureConfig();
    const passScore = solutionConfig.featurePassScore;
    // 后台留空 = 内置默认：模型跟随 teacher_model，提示词用内置模板。
    const modelName = solutionConfig.featureModel
        || cfg.teacher_model || cfg.moderation_model || 'deepseek-v4-flash';
    const systemPrompt = solutionConfig.featurePrompt
        || solutionFeatureReviewSystemPrompt(passScore);
    const config = await aiResolveChatConfig(modelName);
    if (!config.apiKey) {
        await refund('AI 审核服务尚未配置，本次不消耗额度，请联系管理员。', 'no api key');
        return;
    }

    let pdoc: any = null;
    try {
        pdoc = await ProblemModel.get(application.domainId, pid);
    } catch {
        pdoc = null;
    }
    const response = await aiChat({
        config,
        system: systemPrompt,
        user: solutionFeatureReviewUserPrompt({
            pid, title: pdoc?.title, content: String(doc.content || ''),
        }),
        maxTokens: AI_MAX_TOKENS,
        json: true,
        usage: { uid: application.uid, type: 'moderation' },
    });
    if (response.error || !response.content) {
        // 思考型模型把预算花光时上游仍是 200，只有 finish_reason 能说明原因；
        // 打到 stderr，pm2 日志里也能直接看到，不用再翻 oi33_log。
        const detail = response.error
            || `empty content (finish_reason=${response.finishReason || 'unknown'},`
                + ` completion_tokens=${response.usage?.completion_tokens ?? 'unknown'})`;
        console.error(`[oi33] solution feature review failed (pid=${pid}):`, detail);
        const budgetExhausted = !response.error && response.finishReason === 'length';
        await refund(
            budgetExhausted
                ? 'AI 评审没有给出结论（模型输出被截断），本次不消耗额度，请稍后重试。'
                : 'AI 审核服务暂时不可用，本次不消耗额度，请稍后重试。',
            budgetExhausted ? `output budget exhausted: ${detail}` : detail,
        );
        return;
    }
    const verdict = parseSolutionFeatureVerdict(response.content, passScore);
    if (!verdict) {
        await refund('AI 审核返回了无法识别的结果，本次不消耗额度，请稍后重试。', 'parse error');
        return;
    }

    const decided = {
        score: verdict.score,
        reason: verdict.reason,
        suggestions: verdict.suggestions,
        model: response.model,
        cost: response.cost,
        decidedAt: now,
    };

    if (!verdict.pass) {
        await solutionFeatureApplyColl.updateOne(
            { _id: applicationId } as any,
            { $set: { status: 'rejected', ...decided } } as any,
        );
        const tips = verdict.suggestions.length
            ? `\n建议：\n${verdict.suggestions.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
            : '';
        await notifySolutionAuthor(
            application.uid,
            `${heading}本次加精申请未通过（AI 评分 ${verdict.score}）。\n`
            + `结论：${verdict.reason}${tips}\n`
            + '题解仍保持发布状态，修改后明天可以再申请。',
        );
        await addLog({
            type: 'solution', userId: application.uid, action: 'feature_apply_reject',
            psid: String(application.psid),
            reason: `AI ${verdict.score} 分：${verdict.reason}`,
        } as any);
        return;
    }

    let featured: SolutionFeatureResult;
    try {
        featured = await setSolutionFeatured(
            application.domainId, application.psid, true, 0, now, { notify: false },
        );
    } catch (e: any) {
        await refund('题解状态在审核期间发生变化，本次不消耗额度，请稍后重试。', e?.message || 'feature failed');
        return;
    }
    await solutionFeatureApplyColl.updateOne(
        { _id: applicationId } as any,
        { $set: { status: 'featured', ...decided } } as any,
    );
    const reward = featured.rewarded
        ? ` 获得奖励：${featured.rewardText}。`
        : featured.rewardError
            ? `（奖励发放失败：${featured.rewardError}）`
            : '';
    await notifySolutionAuthor(
        application.uid,
        `${heading}已通过 AI 审核（评分 ${verdict.score}），成为精华。${reward}`,
    );
    await addLog({
        type: 'solution', userId: application.uid, action: 'feature_apply_pass',
        psid: String(application.psid),
        reason: `AI ${verdict.score} 分：${verdict.reason}`,
    } as any);
}

// 后台页面用：最近的申请记录（含 AI 结论）。
export async function listSolutionFeatureApplications(limit = 20) {
    return await solutionFeatureApplyColl.find({})
        .sort({ createdAt: -1 }).limit(Math.max(1, Math.min(100, limit))).toArray();
}
