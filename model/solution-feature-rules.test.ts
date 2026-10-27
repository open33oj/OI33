import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_FEATURE_PASS_SCORE, DEFAULT_SOLUTION_REWARD_AMOUNT, normalizeFeatureModel,
    normalizeFeaturePassScore, normalizeFeaturePrompt, normalizeSolutionFeatureConfig,
    normalizeSolutionRewardAmount, normalizeSolutionRewardType, parseSolutionFeatureVerdict,
    solutionFeatureApplyDayKey, solutionFeatureApplyId, solutionFeatureReviewSystemPrompt,
    solutionFeatureReviewUserPrompt, solutionRewardReason, solutionRewardText,
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
        featureModel: '',
        featurePrompt: '',
        featurePassScore: DEFAULT_FEATURE_PASS_SCORE,
    });
    assert.deepEqual(normalizeSolutionFeatureConfig(null), {
        featureRewardType: 'can',
        featureRewardAmount: DEFAULT_SOLUTION_REWARD_AMOUNT,
        featureModel: '',
        featurePrompt: '',
        featurePassScore: DEFAULT_FEATURE_PASS_SCORE,
    });
});

test('solutionRewardText describes the configured reward', () => {
    assert.equal(solutionRewardText({ featureRewardType: 'can', featureRewardAmount: 5 }), '5 个猫罐头');
    assert.equal(solutionRewardText({ featureRewardType: 'food', featureRewardAmount: 10 }), '10 猫粮');
    assert.equal(solutionRewardText({ featureRewardType: 'none', featureRewardAmount: 5 }), '不发放奖励');
    assert.equal(solutionRewardText({ featureRewardType: 'can', featureRewardAmount: 0 }), '不发放奖励');
    assert.equal(solutionRewardReason(), '题解加精奖励');
});

test('solutionFeatureApplyDayKey uses Asia/Shanghai natural days', () => {
    assert.equal(solutionFeatureApplyDayKey(new Date('2026-10-26T15:59:59Z')), '2026-10-26');
    assert.equal(solutionFeatureApplyDayKey(new Date('2026-10-26T16:00:00Z')), '2026-10-27');
    assert.equal(solutionFeatureApplyId(7, new Date('2026-10-26T16:00:00Z')), '7:2026-10-27');
});

test('parseSolutionFeatureVerdict accepts plain JSON and code fences', () => {
    const plain = parseSolutionFeatureVerdict(JSON.stringify({
        pass: true, score: 88, reason: '清晰', suggestions: [],
    }));
    assert.deepEqual(plain, { pass: true, score: 88, reason: '清晰', suggestions: [] });
    const fenced = parseSolutionFeatureVerdict('```json\n{"pass":false,"score":40,"reason":"缺复杂度","suggestions":["补复杂度分析"]}\n```');
    assert.equal(fenced?.pass, false);
    assert.deepEqual(fenced?.suggestions, ['补复杂度分析']);
});

test('parseSolutionFeatureVerdict requires pass and a passing score', () => {
    assert.equal(parseSolutionFeatureVerdict('{"pass":true,"score":50}')?.pass, false);
    assert.equal(parseSolutionFeatureVerdict('{"pass":true,"score":90}')?.pass, true);
    assert.equal(parseSolutionFeatureVerdict('{"pass":false,"score":90}')?.pass, false);
    assert.equal(parseSolutionFeatureVerdict('not json'), null);
    assert.equal(parseSolutionFeatureVerdict(''), null);
});

test('parseSolutionFeatureVerdict normalises suggestions and fills a default', () => {
    const verdict = parseSolutionFeatureVerdict(JSON.stringify({
        pass: false, score: 30, suggestions: ['  ', 'a', 'b', 'c', 'd'],
    }));
    assert.deepEqual(verdict?.suggestions, ['a', 'b', 'c']);
    const empty = parseSolutionFeatureVerdict('{"pass":false,"score":10,"suggestions":[]}');
    assert.equal(empty?.suggestions.length, 1);
});

test('solutionFeatureReviewUserPrompt includes the full solution text', () => {
    const content = 'x'.repeat(9000) + 'TAIL_MARKER';
    const prompt = solutionFeatureReviewUserPrompt({ pid: 1001, title: 'A+B', content });
    assert.ok(prompt.includes('<problem id="1001">A+B</problem>'));
    assert.ok(prompt.includes(content));
    assert.ok(prompt.includes('TAIL_MARKER'));
});

test('normalizeFeaturePassScore clamps the threshold', () => {
    assert.equal(normalizeFeaturePassScore('85'), 85);
    assert.equal(normalizeFeaturePassScore(-5), 0);
    assert.equal(normalizeFeaturePassScore(150), 100);
    assert.equal(normalizeFeaturePassScore('abc'), DEFAULT_FEATURE_PASS_SCORE);
});

test('normalizeFeatureModel and normalizeFeaturePrompt trim and cap', () => {
    assert.equal(normalizeFeatureModel('  deepseek-v4-pro  '), 'deepseek-v4-pro');
    assert.equal(normalizeFeatureModel('x'.repeat(200)).length, 120);
    assert.equal(normalizeFeaturePrompt('  prompt  '), 'prompt');
    assert.equal(normalizeFeaturePrompt('x'.repeat(9000)).length, 8000);
});

test('solutionFeatureReviewSystemPrompt follows the configured threshold', () => {
    assert.ok(solutionFeatureReviewSystemPrompt(85).includes('score >= 85'));
    assert.ok(solutionFeatureReviewSystemPrompt().includes('score >= 70'));
});

test('parseSolutionFeatureVerdict honours a custom threshold', () => {
    assert.equal(parseSolutionFeatureVerdict('{"pass":true,"score":75}', 80)?.pass, false);
    assert.equal(parseSolutionFeatureVerdict('{"pass":true,"score":75}', 70)?.pass, true);
    const missing = parseSolutionFeatureVerdict('{"pass":true}', 85);
    assert.equal(missing?.score, 85);
    assert.equal(missing?.pass, true);
});
