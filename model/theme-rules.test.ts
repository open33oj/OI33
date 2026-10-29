import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    contrastRatio, contrastText, mergeSidebarGroups, normalizeThemeColor,
    sanitizeThemeCss, splitSidebarGroups, themeCss, themeSnippet,
    THEME_PRESETS, themeWarnings,
} from './theme-rules.ts';
import type { NavGroupConfig } from './nav-rules.ts';

const group = (title: string): NavGroupConfig => ({ title, items: [{ label: title, href: '/' }] });
const GLOBAL = [group('基础'), group('常用'), group('更多'), group('管理')];

test('normalizeThemeColor only accepts #rrggbb', () => {
    assert.equal(normalizeThemeColor('#3A6FD8'), '#3a6fd8');
    assert.equal(normalizeThemeColor('  #ffffff '), '#ffffff');
    assert.equal(normalizeThemeColor('#fff'), '');
    assert.equal(normalizeThemeColor('red'), '');
    assert.equal(normalizeThemeColor(123), '');
});

test('contrastText picks readable text for light and dark backgrounds', () => {
    assert.equal(contrastText('#ffffff'), '#1f2430');
    assert.equal(contrastText('#f5f5f5'), '#1f2430');
    assert.equal(contrastText('#000000'), '#ffffff');
    assert.equal(contrastText('#14324f'), '#ffffff');
});

test('themeCss is empty when neither scheme is customized', () => {
    assert.equal(themeCss({ light: {}, dark: {} }), '');
});

test('themeCss emits separate light and dark blocks', () => {
    const css = themeCss({
        light: {
            topbarBg: '#ffffff',
            topbarFg: '#1f2430',
            sidebarBg: '#f5f7fa',
            accent: '#3a6fd8',
        },
        dark: {
            topbarBg: '#0f2742',
            topbarFg: '#eaf2ff',
            sidebarBg: '#14324f',
            accent: '#4d9cf0',
        },
    });
    assert.match(css, /html\.oi33-shell:not\(\.theme--dark\)/);
    assert.match(css, /html\.oi33-shell\.theme--dark/);
    assert.match(css, /--oi33-topbar-bg: #ffffff;/);
    assert.match(css, /--oi33-topbar-bg: #0f2742;/);
    assert.match(css, /--oi33-text: #1f2430;/);
    assert.match(css, /--oi33-text: #eaf2ff;/);
});

test('themeCss only emits the configured scheme', () => {
    const lightOnly = themeCss({ light: { accent: '#112233' }, dark: {} });
    assert.match(lightOnly, /html\.oi33-shell:not\(\.theme--dark\)/);
    assert.doesNotMatch(lightOnly, /html\.oi33-shell\.theme--dark/);
    const darkOnly = themeCss({ light: {}, dark: { accent: '#445566' } });
    assert.doesNotMatch(darkOnly, /html\.oi33-shell:not\(\.theme--dark\)/);
    assert.match(darkOnly, /html\.oi33-shell\.theme--dark/);
});

test('themeCss derives a readable foreground when only a background is set', () => {
    const css = themeCss({ light: { topbarBg: '#ffffff' }, dark: {} });
    assert.match(css, /--oi33-text: #1f2430;/);
    const dark = themeCss({ light: {}, dark: { sidebarBg: '#000000' } });
    assert.match(dark, /--oi33-text: #ffffff;/);
});

test('splitSidebarGroups keeps the first and last group fixed', () => {
    const split = splitSidebarGroups(GLOBAL);
    assert.equal(split.first?.title, '基础');
    assert.equal(split.last?.title, '管理');
    assert.deepEqual(split.middle.map((item) => item.title), ['常用', '更多']);
    const single = splitSidebarGroups([group('唯一')]);
    assert.equal(single.first?.title, '唯一');
    assert.equal(single.last, null);
    assert.deepEqual(single.middle, []);
});

test('mergeSidebarGroups replaces only the middle groups', () => {
    const merged = mergeSidebarGroups(GLOBAL, [group('我的'), group('收藏')]);
    assert.deepEqual(merged.map((item) => item.title), ['基础', '我的', '收藏', '管理']);
});

test('mergeSidebarGroups treats null as "use site middle" and [] as "clear"', () => {
    assert.deepEqual(
        mergeSidebarGroups(GLOBAL, null).map((item) => item.title),
        ['基础', '常用', '更多', '管理'],
    );
    assert.deepEqual(
        mergeSidebarGroups(GLOBAL, []).map((item) => item.title),
        ['基础', '管理'],
    );
});

test('mergeSidebarGroups handles an empty site config', () => {
    assert.deepEqual(mergeSidebarGroups([], [group('我的')]).map((item) => item.title), ['我的']);
    assert.deepEqual(mergeSidebarGroups([], null), []);
});

test('themeCss applies sidebar colors to default cards as a fallback', () => {
    const css = themeCss({
        light: { sidebarBg: '#203040', sidebarFg: '#eaf2ff' },
        dark: {},
    });
    assert.match(css, /#panel \.section \{ background-color: #203040; \}/);
    assert.match(css, /#panel \.section \{ color: #eaf2ff; \}/);
});

test('themeCss lets card colors override the sidebar fallback', () => {
    const css = themeCss({
        light: {
            sidebarBg: '#000000', sidebarFg: '#ffffff', cardBg: '#f5f5f5', cardFg: '#111111',
        },
        dark: {},
    });
    assert.match(css, /#panel \.section \{ background-color: #f5f5f5; \}/);
    assert.match(css, /#panel \.section \{ color: #111111; \}/);
    assert.doesNotMatch(css, /#panel \.section \{ background-color: #000000; \}/);
});

test('themeCss derives card foreground when only a card background is set', () => {
    const css = themeCss({ light: { cardBg: '#ffffff' }, dark: {} });
    assert.match(css, /#panel \.section \{ background-color: #ffffff; \}/);
    assert.match(css, /#panel \.section \{ color: #1f2430; \}/);
});

test('themeCss falls back to top-bar colors for cards when the sidebar is unset', () => {
    const css = themeCss({ light: { topbarBg: '#0f2742', topbarFg: '#eaf2ff' }, dark: {} });
    assert.match(css, /#panel \.section \{ background-color: #0f2742; \}/);
    assert.match(css, /#panel \.section \{ color: #eaf2ff; \}/);
});

test('contrastRatio and themeWarnings catch unreadable pairs', () => {
    assert.ok(contrastRatio('#000000', '#ffffff') > 20);
    assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
    const warnings = themeWarnings({
        light: { cardBg: '#ffffff', cardFg: '#ffffff' },
        dark: {},
    });
    assert.ok(warnings.some((warning) => warning.includes('卡片')));
});

test('shipped presets are complete, valid and readable', () => {
    assert.ok(THEME_PRESETS.length >= 5);
    const ids = new Set<string>();
    for (const preset of THEME_PRESETS) {
        assert.ok(!ids.has(preset.id));
        ids.add(preset.id);
        for (const mode of ['light', 'dark'] as const) {
            for (const color of Object.values(preset[mode])) {
                if (color) assert.match(color as string, /^#[0-9a-f]{6}$/i);
            }
        }
        const warnings = themeWarnings({ light: preset.light, dark: preset.dark });
        assert.deepEqual(warnings, [], `${preset.id} should be readable`);
    }
});

test('themeCss emits page background and text overrides', () => {
    const css = themeCss({
        light: { pageBg: '#f5f6f8', pageFg: '#303845' },
        dark: {},
    });
    assert.match(css, /body \{ background-color: #f5f6f8; \}/);
    assert.match(css, /body \{ color: #303845; \}/);
});

test('sanitizeThemeCss only allows background-color/color on whitelisted selectors', () => {
    const css = sanitizeThemeCss('.section { background-color: #ffffff; color: #333333; }', 'light');
    assert.match(css, /#panel \.section \{/);
    assert.match(css, /background-color: #ffffff;/);
    assert.match(css, /color: #333333;/);
    assert.throws(() => sanitizeThemeCss('.section { background: #fff; }', 'light'), /background-color/);
    assert.throws(() => sanitizeThemeCss('.unknown { color: red; }', 'light'), /不支持的选择器/);
    assert.throws(() => sanitizeThemeCss('body { color: url(x); }', 'light'), /不安全|格式/);
    assert.throws(() => sanitizeThemeCss('body { color: #fff !important; }', 'light'), /不安全|格式/);
    assert.throws(() => sanitizeThemeCss('@media all { body { color: red; } }', 'light'), /不允许/);
    assert.throws(() => sanitizeThemeCss('/* x */ body { color: red; }', 'light'), /不允许/);
});

test('custom CSS is scoped per scheme and appended after the base palette', () => {
    const css = themeCss({
        light: { pageBg: '#f5f6f8' },
        dark: {},
        lightCss: 'body { color: #222222; }',
        darkCss: 'body { color: #dddddd; }',
    });
    assert.match(css, /body \{\n  color: #222222;\n\}/);
    assert.match(css, /body \{\n  color: #dddddd;\n\}/);
});

test('preset CSS snippets are accepted by the sanitizer', () => {
    for (const preset of THEME_PRESETS) {
        for (const mode of ['light', 'dark'] as const) {
            const snippet = themeSnippet(preset[mode]);
            assert.doesNotThrow(() => sanitizeThemeCss(snippet, mode), `${preset.id}/${mode}`);
        }
    }
});

test('themeWarnings points out custom CSS that overrides card colors', () => {
    const warnings = themeWarnings({
        light: {},
        dark: {},
        lightCss: '.section { background-color: #ffffff; }',
    });
    assert.ok(warnings.some((warning) => warning.includes('.section')));
});
