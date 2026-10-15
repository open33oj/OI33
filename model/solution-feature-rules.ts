// Pure rules for 题解加精: the administrator-facing reward configuration and
// its display text. No hydrooj / database imports so they stay unit-testable.

import type { Oi33SolutionConfig } from './types';

export const SOLUTION_CONFIG_ID = 'main';
export const SOLUTION_REWARD_TYPES = ['none', 'can', 'food'] as const;
export const SOLUTION_REWARD_MAX = 1_000_000;
export const DEFAULT_SOLUTION_REWARD_TYPE: Oi33SolutionConfig['featureRewardType'] = 'can';
export const DEFAULT_SOLUTION_REWARD_AMOUNT = 5;

export function normalizeSolutionRewardType(raw: unknown): Oi33SolutionConfig['featureRewardType'] {
    const text = String(raw ?? '').trim();
    return (SOLUTION_REWARD_TYPES as readonly string[]).includes(text)
        ? text as Oi33SolutionConfig['featureRewardType']
        : DEFAULT_SOLUTION_REWARD_TYPE;
}

export function normalizeSolutionRewardAmount(raw: unknown): number {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0 || value > SOLUTION_REWARD_MAX) {
        return DEFAULT_SOLUTION_REWARD_AMOUNT;
    }
    return value;
}

export function normalizeSolutionFeatureConfig(raw: any): Omit<Oi33SolutionConfig, '_id' | 'updatedAt' | 'updatedBy'> {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        featureRewardType: normalizeSolutionRewardType(source.featureRewardType ?? source.rewardType),
        featureRewardAmount: normalizeSolutionRewardAmount(
            source.featureRewardAmount ?? source.rewardAmount,
        ),
    };
}

export function defaultSolutionFeatureConfig(): Omit<Oi33SolutionConfig, '_id' | 'updatedAt' | 'updatedBy'> {
    return normalizeSolutionFeatureConfig({});
}

// '收到 5 个猫罐头' / '收到 10 猫粮' / '不发放奖励'
export function solutionRewardText(config: Pick<Oi33SolutionConfig, 'featureRewardType' | 'featureRewardAmount'>): string {
    const type = normalizeSolutionRewardType(config?.featureRewardType);
    const amount = normalizeSolutionRewardAmount(config?.featureRewardAmount);
    if (type === 'none' || amount <= 0) return '不发放奖励';
    return type === 'can' ? `${amount} 个猫罐头` : `${amount} 猫粮`;
}

// Reasons written to the cat account bill / audit log.
export function solutionRewardReason(): string {
    return '题解加精奖励';
}
