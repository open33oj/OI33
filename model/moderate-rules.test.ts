import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    MAX_MATH_DEPTH, bioHashMatches, bioHashOf, bioQueueState, checkRules, configReviewWords,
    configWords, hashOf, mathTooDeep, moderationEnabled, normalizeText,
    sameBioText, sanitizeModerationCategory,
} from './moderate-rules.ts';

test('normalizeText strips zero-width/invisible chars and lowercases', () => {
    assert.equal(normalizeText('He​llo'), 'hello');
    assert.equal(normalizeText('ＡＢＣ'), 'abc');
});

test('hashOf is deterministic and content-sensitive', () => {
    assert.equal(hashOf('abc'), hashOf('abc'));
    assert.notEqual(hashOf('abc'), hashOf('abd'));
    assert.match(hashOf('abc'), /^[0-9a-f]{64}$/);
});

test('mathTooDeep only trips past the nesting cap', () => {
    assert.equal(mathTooDeep('$' + '{'.repeat(MAX_MATH_DEPTH) + '}'.repeat(MAX_MATH_DEPTH) + '$'), false);
    assert.equal(mathTooDeep('$' + '{'.repeat(MAX_MATH_DEPTH + 1) + '}'.repeat(MAX_MATH_DEPTH + 1) + '$'), true);
    // Braces outside math do not count.
    assert.equal(mathTooDeep('{'.repeat(100)), false);
    // Escaped braces are ignored.
    assert.equal(mathTooDeep('$\\{' + '{'.repeat(100) + '$'), true);
});

test('checkRules blocks configured words and phone/contact leaks', () => {
    assert.deepEqual(checkRules('这是违禁内容', ['违禁']), {
        verdict: 'block', category: '违禁词', word: '违禁',
    });
    assert.equal(checkRules('call me 13800138000', [])?.word, '手机号');
    assert.equal(checkRules('加群 123456789', [])?.word, '联系方式');
});

test('checkRules routes review words and links to the human queue', () => {
    assert.equal(checkRules('xxx', [], ['某某']), null); // no match
    assert.deepEqual(checkRules('提到某某了', [], ['某某']), {
        verdict: 'review', category: '待审', word: '某某',
    });
    assert.deepEqual(checkRules('see https://example.com', []), {
        verdict: 'review', category: '广告引流', word: '外链',
    });
});

test('configured words are normalized before matching', () => {
    const cfg = { moderation_words: 'Bad\n  Good  ', moderation_review_words: 'Review' };
    assert.deepEqual(configWords(cfg), ['bad', 'good']);
    assert.deepEqual(configReviewWords(cfg), ['review']);
    assert.equal(checkRules(normalizeText('a BAD word'), configWords(cfg))?.verdict, 'block');
});

test('sanitizeModerationCategory keeps whitelisted values and falls back', () => {
    assert.equal(sanitizeModerationCategory('政治'), '政治');
    assert.equal(sanitizeModerationCategory('乱七八糟'), '其他');
    assert.equal(sanitizeModerationCategory(undefined), '其他');
});

test('moderationEnabled defaults ON and only an explicit empty value disables it', () => {
    assert.equal(moderationEnabled(undefined), true);
    assert.equal(moderationEnabled(null), true);
    assert.equal(moderationEnabled({}), true);
    assert.equal(moderationEnabled({ moderation_enabled: '1' }), true);
    assert.equal(moderationEnabled({ moderation_enabled: '' }), false);
});

test('bio hash helpers accept the legacy trimmed representation only when needed', () => {
    const bio = 'Hello World';
    assert.equal(bioHashOf(bio), hashOf(normalizeText(bio)));
    assert.equal(bioHashMatches(bioHashOf(bio), bio), true);
    // Legacy hashes were computed on the trimmed text.
    assert.equal(bioHashMatches(bioHashOf('  Hello World  '), bio), false);
    assert.equal(bioHashMatches(bioHashOf('Hello World'), '  Hello World  '), true);
    assert.equal(bioHashMatches(undefined, bio), false);
    assert.equal(bioHashMatches(bioHashOf('other'), bio), false);
});

test('sameBioText compares verbatim with a trim fallback', () => {
    assert.equal(sameBioText('abc', 'abc'), true);
    assert.equal(sameBioText(' abc ', 'abc'), true);
    assert.equal(sameBioText('abc', 'abd'), false);
    assert.equal(sameBioText(undefined, ''), true);
});

test('bioQueueState classifies queued bio entries', () => {
    const content = 'my bio';
    const hash = bioHashOf(content);
    assert.equal(bioQueueState({ content, contentHash: hash }, null), 'stale');
    assert.equal(bioQueueState({ content, contentHash: hash }, content), 'ok');
    // Same text, drifted hash (older batch run) => decision still applies.
    assert.equal(bioQueueState({ content, contentHash: 'deadbeef' }, content), 'text');
    // The user changed the bio => the record can only be closed.
    assert.equal(bioQueueState({ content, contentHash: hash }, 'new bio'), 'stale');
});
