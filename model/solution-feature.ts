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
    DocumentModel, MessageModel, ObjectId, ValidationError, db,
} from 'hydrooj';
import type { Oi33SolutionConfig } from './types';
import { addLog } from './log';
import { adjustCatCans } from './cat/can';
import { grantCatFood } from './cat/account';
import { userColl } from './user';
import {
    SOLUTION_CONFIG_ID, normalizeSolutionFeatureConfig, solutionRewardReason, solutionRewardText,
} from './solution-feature-rules';

export * from './solution-feature-rules';

export const solutionConfigColl = db.collection('oi33_solution_config');

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
        reason: `${normalized.featureRewardType} ${normalized.featureRewardAmount}`,
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
export async function setSolutionFeatured(
    domainId: string,
    psid: ObjectId,
    featured: boolean,
    operator: number,
    now = new Date(),
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
    return { featured: true, rewarded: true, rewardText, owner };
}
