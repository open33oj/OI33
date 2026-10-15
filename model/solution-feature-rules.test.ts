import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_SOLUTION_REWARD_AMOUNT, normalizeSolutionFeatureConfig, normalizeSolutionRewardAmount,
    normalizeSolutionRewardType, solutionRewardReason, solutionRewardText,
} from './solution-feature-rules.ts';

test('normalizeSolutionRewardType keeps known types and falls back', () => {
    assert.equal(normalizeSolutionRewardType('none'), 'none');
    assert.equal(normalizeSolutionRewardType('food'), 'food');
    assert.equal(normalizeSolutionRewardType('can'), 'can');
    assert.equal(normalizeSolutionRewardType('cans'), 'can');
    assert.equal(normalizeSolutionRewardType(undefined), 'can');
});

test('normalizeSolutionRewardAmount clamps bad input to the default', () => {
    assert.equal(normalizeSolutionRewardAmount('20'), 20);
    assert.equal(normalizeSolutionRewardAmount(0), 0);
    assert.equal(normalizeSolutionRewardAmount(-1), DEFAULT_SOLUTION_REWARD_AMOUNT);
    assert.equal(normalizeSolutionRewardAmount('1.5'), DEFAULT_SOLUTION_REWARD_AMOUNT);
    assert.equal(normalizeSolutionRewardAmount(1e9), DEFAULT_SOLUTION_REWARD_AMOUNT);
});

test('normalizeSolutionFeatureConfig accepts the legacy field names', () => {
    assert.deepEqual(normalizeSolutionFeatureConfig({ rewardType: 'food', rewardAmount: '7' }), {
        featureRewardType: 'food',
        featureRewardAmount: 7,
    });
    assert.deepEqual(normalizeSolutionFeatureConfig(null), {
        featureRewardType: 'can',
        featureRewardAmount: DEFAULT_SOLUTION_REWARD_AMOUNT,
    });
});

test('solutionRewardText describes the configured reward', () => {
    assert.equal(solutionRewardText({ featureRewardType: 'can', featureRewardAmount: 5 }), '5 个猫罐头');
    assert.equal(solutionRewardText({ featureRewardType: 'food', featureRewardAmount: 10 }), '10 猫粮');
    assert.equal(solutionRewardText({ featureRewardType: 'none', featureRewardAmount: 5 }), '不发放奖励');
    assert.equal(solutionRewardText({ featureRewardType: 'can', featureRewardAmount: 0 }), '不发放奖励');
    assert.equal(solutionRewardReason(), '题解加精奖励');
});
