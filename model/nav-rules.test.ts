import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_NAV_GROUPS, DEFAULT_NAV_LINKS, NAV_ICONS, navLinksToText,
    normalizeNavGroups, normalizeNavLinks,
} from './nav-rules.ts';

test('normalizeNavGroups keeps node and link items', () => {
    const groups = normalizeNavGroups([
        {
            title: ' 社区 ',
            items: [
                { node: 'discussion_main', icon: 'chat' },
                { label: ' 喵喵 ', href: '/oi33/meow', icon: 'chat', prefix: 'oi33_meow' },
                { label: '路线', route: 'oi33_meow_main', login: true },
            ],
        },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].title, '社区');
    assert.deepEqual(groups[0].items[0], { node: 'discussion_main', icon: 'chat' });
    assert.equal(groups[0].items[1].href, '/oi33/meow');
    assert.equal(groups[0].items[1].label, '喵喵');
    assert.equal(groups[0].items[2].route, 'oi33_meow_main');
    assert.equal(groups[0].items[2].login, true);
});

test('normalizeNavGroups drops invalid items and empty groups', () => {
    const groups = normalizeNavGroups([
        { title: '坏组', items: [] },
        {
            title: '混合',
            items: [
                null,
                { label: '没有链接' },
                { label: 'js', href: 'javascript:alert(1)' },
                { node: 'problem_main' },
            ],
        },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 1);
    assert.equal(groups[0].items[0].node, 'problem_main');
});

test('normalizeNavGroups accepts { groups: [...] } and unknown icons', () => {
    const groups = normalizeNavGroups({
        groups: [{ items: [{ label: 'x', href: 'https://example.com', icon: 'not-real' }] }],
    });
    assert.equal(groups[0].items[0].icon, 'dot');
    assert.equal(groups[0].title, '');
});

test('normalizeNavGroups keeps none icon and external links', () => {
    const groups = normalizeNavGroups([
        { items: [{ label: '外站', href: 'https://example.com/x', icon: 'none' }] },
    ]);
    assert.equal(groups[0].items[0].icon, 'none');
    assert.equal(groups[0].items[0].href, 'https://example.com/x');
});

test('normalizeNavGroups rejects non-array garbage', () => {
    assert.deepEqual(normalizeNavGroups('nope'), []);
    assert.deepEqual(normalizeNavGroups({ items: [] }), []);
    assert.deepEqual(normalizeNavGroups([{ title: 'x' }]), []);
});

test('normalizeNavGroups truncates long fields and caps groups', () => {
    const groups = normalizeNavGroups([
        { title: 'x'.repeat(100), items: [{ label: 'y'.repeat(100), href: `/${'z'.repeat(600)}` }] },
    ]);
    assert.equal(groups[0].title.length, 40);
    assert.equal(groups[0].items[0].label.length, 40);
    assert.ok(groups[0].items[0].href.length <= 500);
});

test('normalizeNavLinks parses name|url, ignores bad lines and javascript', () => {
    const links = normalizeNavLinks(' A | https://a.example \ninvalid\nB|javascript:alert(1)\nC|/relative\nD|/\nE|/d/test');
    assert.deepEqual(links, [
        { name: 'A', url: 'https://a.example', external: true },
        { name: 'C', url: '/relative', external: false },
        { name: 'D', url: '/', external: false },
        { name: 'E', url: '/d/test', external: false },
    ]);
});

test('normalizeNavLinks caps the number of links', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `L${i}|https://x${i}.example`).join('\n');
    assert.equal(normalizeNavLinks(raw).length, 12);
});

test('navLinksToText round-trips the default links', () => {
    assert.deepEqual(normalizeNavLinks(navLinksToText(DEFAULT_NAV_LINKS)), DEFAULT_NAV_LINKS);
});

test('built-in default config is valid and covers the main nav', () => {
    const groups = normalizeNavGroups(DEFAULT_NAV_GROUPS);
    assert.equal(groups.length, DEFAULT_NAV_GROUPS.length);
    const nodes = groups.flatMap((group) => group.items.map((item) => item.node)).filter(Boolean);
    assert.ok(nodes.includes('problem_main'));
    assert.ok(nodes.includes('discussion_main'));
    const titles = groups.map((group) => group.title);
    assert.deepEqual(titles, ['', '社区', '更多功能', '管理']);
    for (const group of groups) {
        for (const item of group.items) {
            if (item.icon && item.icon !== 'none') assert.ok(NAV_ICONS.has(item.icon), item.icon);
        }
    }
});
