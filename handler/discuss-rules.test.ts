import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestReplyInfo } from './discuss-rules.ts';

const at = (time: string) => ({ getTimestamp: () => new Date(time) });

test('latestReplyInfo returns null when there is no reply', () => {
    assert.equal(latestReplyInfo([]), null);
    assert.equal(latestReplyInfo([{ owner: 1 } as any]), null);
});

test('latestReplyInfo picks the newest top-level reply regardless of input order', () => {
    const older = { _id: at('2026-10-28T03:00:00Z'), owner: 2 };
    const newer = { _id: at('2026-10-28T03:10:00Z'), owner: 3 };
    assert.deepEqual(latestReplyInfo([newer, older]), { owner: 3, at: new Date('2026-10-28T03:10:00Z') });
    assert.deepEqual(latestReplyInfo([older, newer]), { owner: 3, at: new Date('2026-10-28T03:10:00Z') });
});

test('latestReplyInfo counts a tail reply as the last reply', () => {
    // 楼中楼只刷新讨论的 updateAt，不会产生新的主楼；如果只看主楼，
    // 列表就会出现「名字是主楼作者、时间却来自楼中楼」的错位。
    const reply = {
        _id: at('2026-10-28T03:00:00Z'),
        owner: 2,
        reply: [
            { _id: at('2026-10-28T03:05:00Z'), owner: 4 },
            { _id: at('2026-10-28T03:09:00Z'), owner: 3 },
        ],
    };
    assert.deepEqual(latestReplyInfo([reply]), { owner: 3, at: new Date('2026-10-28T03:09:00Z') });
});

test('latestReplyInfo prefers a newer top-level reply over an older tail reply', () => {
    const olderWithTail = {
        _id: at('2026-10-28T03:00:00Z'),
        owner: 2,
        reply: [{ _id: at('2026-10-28T03:06:00Z'), owner: 2 }],
    };
    const newer = { _id: at('2026-10-28T03:08:00Z'), owner: 5 };
    assert.deepEqual(latestReplyInfo([olderWithTail, newer]), { owner: 5, at: new Date('2026-10-28T03:08:00Z') });
});

test('latestReplyInfo skips replies without a usable owner or timestamp', () => {
    const valid = { _id: at('2026-10-28T03:00:00Z'), owner: 2 };
    assert.deepEqual(latestReplyInfo([
        { owner: 3 },
        { _id: at('2026-10-28T03:05:00Z') },
        { _id: at('2026-10-28T03:06:00Z'), owner: 'nobody' },
        valid,
    ] as any), { owner: 2, at: new Date('2026-10-28T03:00:00Z') });
});

test('latestReplyInfo ignores an empty tail reply array', () => {
    const reply = { _id: at('2026-10-28T03:00:00Z'), owner: 2, reply: [] };
    assert.deepEqual(latestReplyInfo([reply]), { owner: 2, at: new Date('2026-10-28T03:00:00Z') });
});
