import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    judgeMonitorNotifyState, judgeMonitorOnlineDiff, normalizeJudgeMonitorConfig,
    normalizeJudgeMonitorNotifyKind, normalizeOnlineMids,
} from './judge-monitor-rules.ts';

test('normalizeJudgeMonitorConfig trims the webhook and accepts checkbox spellings', () => {
    assert.deepEqual(normalizeJudgeMonitorConfig({}), {
        enabled: false, includeServer: false, webhook: '',
    });
    assert.deepEqual(
        normalizeJudgeMonitorConfig({ enabled: 'on', includeServer: 'true', webhook: '  https://x  ' }),
        { enabled: true, includeServer: true, webhook: 'https://x' },
    );
    assert.deepEqual(
        normalizeJudgeMonitorConfig({ enabled: true, includeServer: 'off', webhook: 5 }),
        { enabled: true, includeServer: false, webhook: '' },
    );
});

test('normalizeOnlineMids keeps an empty list distinct from "never checked"', () => {
    assert.equal(normalizeOnlineMids(undefined), null);
    assert.equal(normalizeOnlineMids(''), null);
    assert.equal(normalizeOnlineMids(null), null);
    assert.deepEqual(normalizeOnlineMids([]), []);
    // the legacy setting stored the JSON form of the list
    assert.deepEqual(normalizeOnlineMids('[]'), []);
    assert.deepEqual(normalizeOnlineMids('["a","b","a"]'), ['a', 'b']);
    assert.deepEqual(normalizeOnlineMids(['a', 3 as any, 'b']), ['a', 'b']);
    assert.deepEqual(normalizeOnlineMids('a, b，c'), ['a', 'b', 'c']);
});

test('judgeMonitorNotifyState maps the stored list onto the panel indicator', () => {
    assert.equal(judgeMonitorNotifyState(null), '');
    assert.equal(judgeMonitorNotifyState([]), 'offline');
    assert.equal(judgeMonitorNotifyState(['a']), 'online');
});

test('judgeMonitorOnlineDiff is order insensitive', () => {
    assert.deepEqual(judgeMonitorOnlineDiff(['b', 'a'], ['a', 'b']), { joined: [], left: [] });
    assert.deepEqual(judgeMonitorOnlineDiff(['a'], ['b']), { joined: ['b'], left: ['a'] });
    assert.deepEqual(judgeMonitorOnlineDiff([], ['b']), { joined: ['b'], left: [] });
    assert.deepEqual(judgeMonitorOnlineDiff(['a'], []), { joined: [], left: ['a'] });
});

test('normalizeJudgeMonitorNotifyKind drops unknown kinds', () => {
    assert.equal(normalizeJudgeMonitorNotifyKind('offline'), 'offline');
    assert.equal(normalizeJudgeMonitorNotifyKind('recovery'), 'recovery');
    assert.equal(normalizeJudgeMonitorNotifyKind('delta'), 'delta');
    assert.equal(normalizeJudgeMonitorNotifyKind('nope'), '');
    assert.equal(normalizeJudgeMonitorNotifyKind(undefined), '');
});
