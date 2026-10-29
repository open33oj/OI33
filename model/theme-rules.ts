// Pure rules for the per-user theme (page / cards / top bar / sidebar colors,
// top links, middle sidebar groups). No hydrooj/DB/DOM imports so `node --test`
// can run it directly; model/theme.ts does the storage and parsing.
//
// Boundaries:
//   - Colors are per scheme (light / dark); a light palette never leaks into dark.
//   - Only surfaces we own are recolored: page background, default `.section`
//     cards, top bar, sidebar, their text/secondary text/borders/hover, and
//     plain form controls inside cards. Semantic colors (judge status, badges,
//     difficulty, medals, charts, cat-map/medal-wall canvases, syntax
//     highlighting, images) keep the site palette.
//   - Modals/dropdowns keep the site scheme so floating menus remain readable.
//   - Empty fields mean "site default"; card colors fall back to sidebar, then
//     top bar, then page.

import type { NavGroupConfig } from './nav-rules';

export interface UserThemeColors {
    pageBg?: string;
    pageFg?: string;
    cardBg?: string;
    cardFg?: string;
    topbarBg?: string;
    topbarFg?: string;
    sidebarBg?: string;
    sidebarFg?: string;
    accent?: string;
}

export interface UserTheme {
    light: UserThemeColors;
    dark: UserThemeColors;
    /** 用户自定义 CSS（仅背景色/文字色；保存时已校验，读取时再校验一次）。 */
    lightCss: string | null;
    darkCss: string | null;
    /** Top-bar links text (`名称|URL` per line); null = use site defaults. */
    links: string | null;
    /** Middle sidebar groups; null = use the site's middle groups. */
    navGroups: NavGroupConfig[] | null;
}

export const THEME_COLOR_RE = /^#[0-9a-f]{6}$/i;

export const EMPTY_USER_THEME: UserTheme = {
    light: {},
    dark: {},
    lightCss: null,
    darkCss: null,
    links: null,
    navGroups: null,
};

export const THEME_FIELD_NAMES: Array<[keyof UserThemeColors, string]> = [
    ['pageBg', 'page_bg'],
    ['pageFg', 'page_fg'],
    ['cardBg', 'card_bg'],
    ['cardFg', 'card_fg'],
    ['topbarBg', 'topbar_bg'],
    ['topbarFg', 'topbar_fg'],
    ['sidebarBg', 'sidebar_bg'],
    ['sidebarFg', 'sidebar_fg'],
    ['accent', 'accent'],
];

// Hydro puts the scheme on <html>: `theme--dark` and/or
// `data-mantine-color-scheme="dark"`. Light selectors explicitly exclude both
// so a custom light palette cannot tint dark mode.
const LIGHT_ROOT = 'html.oi33-shell:not(.theme--dark):not([data-mantine-color-scheme="dark"])';
const DARK_ROOT = 'html.oi33-shell.theme--dark, html.oi33-shell[data-mantine-color-scheme="dark"]';

export function normalizeThemeColor(value: unknown): string {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!THEME_COLOR_RE.test(text)) return '';
    return text.toLowerCase();
}

function hexToRgb(hex: string): [number, number, number] | null {
    const color = normalizeThemeColor(hex);
    if (!color) return null;
    return [
        Number.parseInt(color.slice(1, 3), 16),
        Number.parseInt(color.slice(3, 5), 16),
        Number.parseInt(color.slice(5, 7), 16),
    ];
}

function rgba(hex: string, alpha: number): string {
    const rgb = hexToRgb(hex);
    if (!rgb) return '';
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function darken(hex: string, ratio: number): string {
    const rgb = hexToRgb(hex);
    if (!rgb) return '';
    const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value * (1 - ratio))));
    return `#${rgb.map((value) => channel(value).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex: string): number | null {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    const [r, g, b] = rgb.map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Pick a readable text color for a custom background when no fg is set. */
export function contrastText(hex: string): string {
    const value = luminance(hex);
    if (value === null) return '';
    return value > 0.5 ? '#1f2430' : '#ffffff';
}

/** WCAG contrast ratio; 0 when either color is invalid. */
export function contrastRatio(foreground: string, background: string): number {
    const a = luminance(foreground);
    const b = luminance(background);
    if (a === null || b === null) return 0;
    const [light, dark] = a >= b ? [a, b] : [b, a];
    return (light + 0.05) / (dark + 0.05);
}


// --- 受限自定义 CSS -------------------------------------------------------
// 用户只能改「背景色 / 文字色」，且选择器必须来自下面这张白名单。生成时统一
// 加上当前配色模式的前缀，避免亮色规则污染暗色模式。
export interface ThemeCssSelector {
    selector: string;
    label: string;
    target: string;
}

export const THEME_CSS_SELECTORS: ThemeCssSelector[] = [
    { selector: 'body', label: '页面背景/文字', target: 'body' },
    { selector: '#panel', label: '内容区背景/文字', target: '#panel' },
    { selector: '.footer', label: '页脚', target: '.footer' },
    { selector: '.section', label: '默认卡片', target: '#panel .section' },
    { selector: '.section__header', label: '卡片头部', target: '#panel .section__header' },
    { selector: '.section__body', label: '卡片正文', target: '#panel .section__body' },
    { selector: '.section__footer', label: '卡片底部', target: '#panel .section__footer' },
    { selector: '.section__title', label: '卡片标题', target: '#panel .section .section__title' },
    { selector: '.data-table', label: '表格', target: '#panel .section .data-table' },
    { selector: '.data-table th', label: '表头', target: '#panel .section .data-table th' },
    { selector: '.data-table td', label: '表格单元格', target: '#panel .section .data-table td' },
    { selector: '.textbox', label: '文本输入框', target: '#panel .section .textbox' },
    { selector: '.select', label: '下拉框', target: '#panel .section .select' },
    { selector: 'textarea', label: '多行输入框', target: '#panel .section textarea' },
    { selector: '.button', label: '按钮', target: '#panel .section .button' },
    { selector: 'a', label: '正文链接', target: '#panel .section .typo a:not(.user-profile-name):not(.button)' },
    { selector: 'h1', label: '一级标题', target: '#panel .section h1' },
    { selector: 'h2', label: '二级标题', target: '#panel .section h2' },
    { selector: 'h3', label: '三级标题', target: '#panel .section h3' },
    { selector: 'h4', label: '四级标题', target: '#panel .section h4' },
    { selector: 'h5', label: '五级标题', target: '#panel .section h5' },
    { selector: 'h6', label: '六级标题', target: '#panel .section h6' },
    { selector: 'pre', label: '代码块', target: '#panel .section pre' },
    { selector: 'code', label: '行内代码', target: '#panel .section code' },
    { selector: '.oi33-topbar', label: '顶栏', target: '.oi33-topbar' },
    { selector: '.oi33-topbar__links a', label: '顶栏链接', target: '.oi33-topbar__links a' },
    { selector: '.oi33-sidebar', label: '侧边栏', target: '.oi33-sidebar' },
    { selector: '.oi33-nav__item', label: '侧边栏条目', target: '.oi33-sidebar .oi33-nav__item' },
    { selector: '.oi33-user', label: '顶栏用户区', target: '.oi33-topbar .oi33-user' },
    { selector: '.oi33-user__menu', label: '用户菜单', target: '.oi33-user__menu' },
];

const THEME_CSS_TARGETS = new Map(THEME_CSS_SELECTORS.map((item) => [item.selector, item.target]));
const COLOR_VALUE_RE = /^(#[0-9a-f]{3,8}|rgba?\([0-9a-z.,%\s/+-]*\)|hsla?\([0-9a-z.,%\s/+-]*\)|[a-z]{3,20})$/i;
const DISALLOWED_VALUE = /(url|var|calc|expression|attr|env)\s*\(|!important|[;{}<>\\@]/i;

function isSafeColorValue(value: string): boolean {
    if (!value || value.length > 120 || DISALLOWED_VALUE.test(value)) return false;
    return COLOR_VALUE_RE.test(value);
}

/**
 * Validate one mode's custom CSS and return it scoped to that mode. Only
 * `background-color` / `color` declarations and whitelisted selectors are
 * accepted; anything else throws with a user-facing message.
 */
export function sanitizeThemeCss(raw: string, mode: 'light' | 'dark'): string {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (text.length > 8000) throw new Error('自定义 CSS 过长（最多 8000 字符）。');
    if (/\/\*|\*\/|<\/?style|@|[<>]/i.test(text)) {
        throw new Error('自定义 CSS 不允许注释、@ 规则或 HTML 标签。');
    }
    const root = mode === 'light' ? LIGHT_ROOT : DARK_ROOT;
    const blocks: string[] = [];
    let cursor = 0;
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRe.exec(text))) {
        if (text.slice(cursor, match.index).trim()) {
            throw new Error('自定义 CSS 格式不正确，请检查大括号是否成对。');
        }
        cursor = ruleRe.lastIndex;
        const selectors = match[1].split(',').map((item) => item.trim()).filter(Boolean);
        if (!selectors.length) throw new Error('自定义 CSS 缺少选择器。');
        const targets = selectors.map((selector) => {
            const target = THEME_CSS_TARGETS.get(selector.toLowerCase());
            if (!target) throw new Error(`不支持的选择器：${selector}（请从页面上的白名单选择）。`);
            return `${root} ${target}`;
        });
        const declarations: string[] = [];
        for (const rawDecl of match[2].split(';')) {
            const decl = rawDecl.trim();
            if (!decl) continue;
            const splitAt = decl.indexOf(':');
            if (splitAt < 0) throw new Error(`自定义 CSS 声明格式不正确：${decl}`);
            const prop = decl.slice(0, splitAt).trim().toLowerCase();
            const value = decl.slice(splitAt + 1).trim();
            if (prop !== 'background-color' && prop !== 'color') {
                throw new Error(`只允许 background-color 和 color，不能使用 ${prop}。`);
            }
            if (!isSafeColorValue(value)) throw new Error(`颜色值不安全或格式不正确：${value}`);
            declarations.push(`  ${prop}: ${value};`);
        }
        if (!declarations.length) continue;
        blocks.push(`${targets.join(', ')} {\n${declarations.join('\n')}\n}`);
    }
    if (text.slice(cursor).trim()) {
        throw new Error('自定义 CSS 格式不正确，请检查大括号是否成对。');
    }
    return blocks.join('\n');
}

export function themeSnippet(colors: UserThemeColors): string {
    const resolved = resolveModeColors(colors);
    const rules: string[] = [];
    if (resolved.pageBg || resolved.pageFg) {
        rules.push(`body { ${resolved.pageBg ? `background-color: ${resolved.pageBg}; ` : ''}${resolved.pageFg ? `color: ${resolved.pageFg};` : ''} }`);
    }
    // Card colors are stored as structured fields and emitted by the base
    // theme CSS. Keep the preset snippet focused on the page/shell so a later
    // card-color tweak in the advanced form is not immediately overridden by a
    // stale literal rule in the CSS editor.
    if (resolved.topbarBg || resolved.topbarFg) {
        rules.push(`.oi33-topbar { ${resolved.topbarBg ? `background-color: ${resolved.topbarBg}; ` : ''}${resolved.topbarFg ? `color: ${resolved.topbarFg};` : ''} }`);
    }
    if (resolved.sidebarBg || resolved.sidebarFg) {
        rules.push(`.oi33-sidebar { ${resolved.sidebarBg ? `background-color: ${resolved.sidebarBg}; ` : ''}${resolved.sidebarFg ? `color: ${resolved.sidebarFg};` : ''} }`);
    }
    if (resolved.sidebarFg) rules.push(`.oi33-nav__item { color: ${resolved.sidebarFg}; }`);
    if (resolved.pageBg || resolved.pageFg) {
        rules.push(`.footer { ${resolved.pageBg ? `background-color: ${resolved.pageBg}; ` : ''}${resolved.pageFg ? `color: ${resolved.pageFg};` : ''} }`);
    }
    return rules.join('\n');
}

export interface ResolvedModeColors {
    pageBg: string;
    pageFg: string;
    cardBg: string;
    cardFg: string;
    topbarBg: string;
    topbarFg: string;
    sidebarBg: string;
    sidebarFg: string;
    accent: string;
}

/**
 * Fill in derivable foregrounds and card fallbacks. Only explicit colors are
 * returned for page/topbar/sidebar backgrounds; derived text colors are chosen
 * for contrast when the background is explicit.
 */
export function resolveModeColors(colors: UserThemeColors): ResolvedModeColors {
    const topbarBg = normalizeThemeColor(colors.topbarBg);
    const topbarFg = normalizeThemeColor(colors.topbarFg) || (topbarBg ? contrastText(topbarBg) : '');
    const sidebarBg = normalizeThemeColor(colors.sidebarBg);
    const sidebarFg = normalizeThemeColor(colors.sidebarFg) || (sidebarBg ? contrastText(sidebarBg) : '');
    const pageBg = normalizeThemeColor(colors.pageBg);
    const pageFg = normalizeThemeColor(colors.pageFg) || (pageBg ? contrastText(pageBg) : '');
    const cardBgRaw = normalizeThemeColor(colors.cardBg);
    const cardBg = cardBgRaw || sidebarBg || topbarBg || pageBg;
    let cardFg = normalizeThemeColor(colors.cardFg);
    if (!cardFg) {
        if (cardBgRaw) cardFg = contrastText(cardBgRaw);
        else if (sidebarBg) cardFg = sidebarFg;
        else if (topbarBg) cardFg = topbarFg;
        else if (pageBg) cardFg = pageFg;
    }
    return {
        pageBg,
        pageFg,
        cardBg,
        cardFg,
        topbarBg,
        topbarFg,
        sidebarBg,
        sidebarFg,
        accent: normalizeThemeColor(colors.accent),
    };
}

/** Turn a comma-separated root selector into the same selector scoped to X. */
function scoped(root: string, suffix: string): string {
    return root.split(',').map((selector) => `${selector.trim()} ${suffix}`).join(', ');
}

function scopedList(root: string, suffixes: string[]): string {
    return suffixes
        .flatMap((suffix) => root.split(',').map((selector) => `${selector.trim()} ${suffix}`))
        .join(', ');
}

function scopeCss(selector: string, fg: string): string {
    return [
        `${selector} {`,
        `  --oi33-text: ${fg};`,
        `  --oi33-muted: ${rgba(fg, 0.62)};`,
        `  --oi33-border: ${rgba(fg, 0.16)};`,
        `  --oi33-hover: ${rgba(fg, 0.08)};`,
        '}',
    ].join('\n');
}

function pageCss(root: string, bg: string, fg: string): string {
    if (!bg && !fg) return '';
    const blocks: string[] = [];
    if (bg) {
        blocks.push(`${scoped(root, 'body')} { background-color: ${bg}; }`);
        blocks.push(`${scoped(root, '#panel')} { background-color: ${bg}; }`);
        blocks.push(`${scoped(root, '.footer')} { background-color: ${bg}; }`);
    }
    if (fg) {
        blocks.push(`${scoped(root, 'body')} { color: ${fg}; }`);
        blocks.push(`${scoped(root, '#panel')} { color: ${fg}; }`);
        blocks.push(`${scoped(root, '.footer')} { color: ${rgba(fg, 0.8)}; }`);
    }
    return blocks.join('\n');
}

function cardCss(root: string, bg: string, fg: string, accent: string): string {
    if (!bg && !fg) return '';
    const blocks: string[] = [];
    const base = scoped(root, '#panel .section');
    if (bg) blocks.push(`${base} { background-color: ${bg}; }`);
    if (fg) {
        blocks.push(`${base} { color: ${fg}; }`);
        blocks.push(`${scopedList(root, [
            '#panel .section .section__title',
            '#panel .section h1', '#panel .section h2', '#panel .section h3',
            '#panel .section h4', '#panel .section h5', '#panel .section h6',
        ])} { color: ${fg}; }`);
        blocks.push(`${scopedList(root, [
            '#panel .section .supplementary',
            '#panel .section .section__table-header',
            '#panel .section .data-table th',
        ])} { color: ${rgba(fg, 0.72)}; }`);
        blocks.push(`${scopedList(root, [
            '#panel .section',
            '#panel .section .data-table th',
            '#panel .section .data-table td',
            '#panel .section__header',
            '#panel .section__footer',
        ])} { border-color: ${rgba(fg, 0.16)}; }`);
        blocks.push(`${scopedList(root, [
            '#panel .section .data-table tbody tr:hover',
            '#panel .section .section__list__item:hover',
        ])} { background-color: ${rgba(fg, 0.06)}; }`);
        // Plain form controls inside cards: keep them readable on the custom
        // surface. Specialized controls (color pickers, code editors, canvases)
        // are excluded by the selector / keep their own styles.
        blocks.push(`${scopedList(root, [
            '#panel .section .textbox',
            '#panel .section .select',
            '#panel .section textarea',
        ])} { background-color: ${rgba(fg, 0.06)}; border-color: ${rgba(fg, 0.22)}; color: ${fg}; }`);
        blocks.push(`${scopedList(root, [
            '#panel .section .textbox::placeholder',
            '#panel .section textarea::placeholder',
        ])} { color: ${rgba(fg, 0.5)}; }`);
        if (accent) {
            blocks.push(`${scopedList(root, [
                '#panel .section .typo a:not(.user-profile-name):not(.button)',
                '#panel .section .typo .link:not(.user-profile-name):not(.button)',
            ])} { color: ${accent}; }`);
        }
    }
    return blocks.join('\n');
}

function modeCss(root: string, colors: UserThemeColors): string {
    const resolved = resolveModeColors(colors);
    const blocks: string[] = [];
    const rootLines: string[] = [];
    if (resolved.accent) {
        rootLines.push(
            `  --oi33-accent: ${resolved.accent};`,
            `  --oi33-accent-strong: ${darken(resolved.accent, 0.16)};`,
            `  --oi33-accent-weak: ${rgba(resolved.accent, 0.15)};`,
        );
    }
    if (resolved.pageBg) rootLines.push(`  --oi33-page-bg: ${resolved.pageBg};`);
    if (resolved.pageFg) {
        rootLines.push(
            `  --oi33-page-fg: ${resolved.pageFg};`,
            `  --oi33-page-muted: ${rgba(resolved.pageFg, 0.62)};`,
            `  --oi33-page-border: ${rgba(resolved.pageFg, 0.16)};`,
        );
    }
    if (resolved.cardBg) rootLines.push(`  --oi33-card-bg: ${resolved.cardBg};`);
    if (resolved.cardFg) {
        rootLines.push(
            `  --oi33-card-fg: ${resolved.cardFg};`,
            `  --oi33-card-muted: ${rgba(resolved.cardFg, 0.72)};`,
            `  --oi33-card-border: ${rgba(resolved.cardFg, 0.16)};`,
            `  --oi33-card-hover: ${rgba(resolved.cardFg, 0.06)};`,
        );
    }
    if (resolved.topbarBg) rootLines.push(`  --oi33-topbar-bg: ${resolved.topbarBg};`);
    if (resolved.sidebarBg) rootLines.push(`  --oi33-sidebar-bg: ${resolved.sidebarBg};`);
    if (rootLines.length) blocks.push([`${root} {`, ...rootLines, '}'].join('\n'));
    if (resolved.topbarFg) {
        blocks.push(scopeCss(scoped(root, '.oi33-topbar'), resolved.topbarFg));
        // Links have their own `color: var(--oi33-muted)`; set it explicitly so
        // the top-bar text color also wins over custom CSS that only colors
        // `.oi33-topbar` (the CSS editor cannot set variables).
        const linkColor = rgba(resolved.topbarFg, 0.72);
        blocks.push(`${scoped(root, '.oi33-topbar__links a')} { color: ${linkColor}; }`);
        blocks.push(`${scoped(root, '.oi33-topbar__links a:visited')} { color: ${linkColor}; }`);
    }
    if (resolved.sidebarFg) blocks.push(scopeCss(scoped(root, '.oi33-sidebar'), resolved.sidebarFg));
    const page = pageCss(root, resolved.pageBg, resolved.pageFg);
    if (page) blocks.push(page);
    const cards = cardCss(root, resolved.cardBg, resolved.cardFg, resolved.accent);
    if (cards) blocks.push(cards);
    return blocks.join('\n');
}

/** CSS text for a user theme, or '' when neither scheme is customized. */
export function themeCss(
    theme: Pick<UserTheme, 'light' | 'dark'> & Partial<Pick<UserTheme, 'lightCss' | 'darkCss'>>,
): string {
    const blocks = [modeCss(LIGHT_ROOT, theme.light), modeCss(DARK_ROOT, theme.dark)];
    // Custom CSS is stored only after validation, but re-validate on read so a
    // hand-edited DB row can never inject arbitrary CSS/HTML.
    for (const mode of ['light', 'dark'] as const) {
        const raw = mode === 'light' ? theme.lightCss : theme.darkCss;
        if (!raw) continue;
        try {
            const css = sanitizeThemeCss(raw, mode);
            if (css) blocks.push(css);
        } catch (e) {
            console.error(`[oi33] ignoring invalid custom ${mode} theme CSS:`, e);
        }
    }
    return blocks.filter(Boolean).join('\n');
}

/** Readability warnings for explicit/derived foreground-background pairs. */
export function themeWarnings(
    theme: Pick<UserTheme, 'light' | 'dark'> & Partial<Pick<UserTheme, 'lightCss' | 'darkCss'>>,
): string[] {
    const warnings: string[] = [];
    for (const [mode, raw] of [['亮色', theme.lightCss], ['暗色', theme.darkCss]] as const) {
        if (raw && /(^|\n)\s*\.section(?:\s|,|\{)/.test(raw)) {
            warnings.push(`${mode}自定义 CSS 包含 .section 规则，会覆盖上方卡片颜色；如需卡片跟随逐项颜色，请删除该规则或重新套用预设。`);
            break;
        }
    }
    for (const mode of ['light', 'dark'] as const) {
        const label = mode === 'light' ? '亮色模式' : '暗色模式';
        const resolved = resolveModeColors(theme[mode] || {});
        const pairs: Array<[string, string, string]> = [
            ['页面', resolved.pageFg, resolved.pageBg],
            ['卡片', resolved.cardFg, resolved.cardBg],
            ['顶栏', resolved.topbarFg, resolved.topbarBg],
            ['侧边栏', resolved.sidebarFg, resolved.sidebarBg],
        ];
        for (const [name, fg, bg] of pairs) {
            if (!fg || !bg) continue;
            const ratio = contrastRatio(fg, bg);
            if (ratio && ratio < 3) {
                warnings.push(`${label}${name}文字与背景对比度较低（${ratio.toFixed(1)}:1），建议调整。`);
            }
        }
        if (resolved.accent) {
            for (const [name, bg] of [['卡片', resolved.cardBg], ['页面', resolved.pageBg]] as const) {
                if (!bg) continue;
                const ratio = contrastRatio(resolved.accent, bg);
                if (ratio && ratio < 2.2) {
                    warnings.push(`${label}强调色在${name}背景上对比度较低（${ratio.toFixed(1)}:1）。`);
                }
            }
        }
    }
    return [...new Set(warnings)];
}

export interface UserThemePreset {
    id: string;
    label: string;
    light: UserThemeColors;
    dark: UserThemeColors;
}

// 初始方案：都同时给出亮/暗两套，用户套用后再微调。
export const THEME_PRESETS: UserThemePreset[] = [
    { id: 'default', label: '默认', light: {}, dark: {} },
    {
        id: 'yanzhi',
        label: '胭脂',
        light: {
            pageBg: '#fdf2f3', pageFg: '#3b1a1e',
            cardBg: '#fbe6e9', cardFg: '#3b1a1e',
            topbarBg: '#8c2f3a', topbarFg: '#fff4f5',
            sidebarBg: '#9d2933', sidebarFg: '#fff4f5',
            accent: '#b23a48',
        },
        dark: {
            pageBg: '#170b0d', pageFg: '#f7e6e8',
            cardBg: '#241013', cardFg: '#f7e6e8',
            topbarBg: '#8c2f3a', topbarFg: '#fff4f5',
            sidebarBg: '#9d2933', sidebarFg: '#fff4f5',
            accent: '#e06b78',
        },
    },
    {
        id: 'zhusha',
        label: '朱砂',
        light: {
            pageBg: '#fff5f2', pageFg: '#3a1b14',
            cardBg: '#ffe9e3', cardFg: '#3a1b14',
            topbarBg: '#b23a32', topbarFg: '#fff6f3',
            sidebarBg: '#c0443a', sidebarFg: '#fff6f3',
            accent: '#d94f3f',
        },
        dark: {
            pageBg: '#180b08', pageFg: '#fae9e3',
            cardBg: '#27120e', cardFg: '#fae9e3',
            topbarBg: '#b23a32', topbarFg: '#fff6f3',
            sidebarBg: '#c0443a', sidebarFg: '#fff6f3',
            accent: '#ff7a68',
        },
    },
    {
        id: 'jiangzi',
        label: '绛紫',
        light: {
            pageBg: '#f9f1f6', pageFg: '#351b28',
            cardBg: '#f2e2eb', cardFg: '#351b28',
            topbarBg: '#6d2f45', topbarFg: '#fbeef4',
            sidebarBg: '#8c4356', sidebarFg: '#fbeef4',
            accent: '#a64b68',
        },
        dark: {
            pageBg: '#150b10', pageFg: '#f6e6ee',
            cardBg: '#221019', cardFg: '#f6e6ee',
            topbarBg: '#6d2f45', topbarFg: '#fbeef4',
            sidebarBg: '#8c4356', sidebarFg: '#fbeef4',
            accent: '#d97a9c',
        },
    },
    {
        id: 'ouhe',
        label: '藕荷',
        light: {
            pageBg: '#fdf6f9', pageFg: '#3a2430',
            cardBg: '#f8e9ef', cardFg: '#3a2430',
            topbarBg: '#8c5a72', topbarFg: '#fff5f8',
            sidebarBg: '#9c6a82', sidebarFg: '#fff5f8',
            accent: '#b86f8e',
        },
        dark: {
            pageBg: '#171015', pageFg: '#f6e9ef',
            cardBg: '#241820', cardFg: '#f6e9ef',
            topbarBg: '#6d4055', topbarFg: '#fff5f8',
            sidebarBg: '#7e4c63', sidebarFg: '#fff5f8',
            accent: '#d9a0b8',
        },
    },
    {
        id: 'tianqing',
        label: '天青',
        light: {
            pageBg: '#f2fafc', pageFg: '#173039',
            cardBg: '#e6f4f8', cardFg: '#173039',
            topbarBg: '#3e7f92', topbarFg: '#f0fbff',
            sidebarBg: '#4a8fa3', sidebarFg: '#f0fbff',
            accent: '#3f8fa6',
        },
        dark: {
            pageBg: '#081216', pageFg: '#e4f4f9',
            cardBg: '#101e24', cardFg: '#e4f4f9',
            topbarBg: '#2f6273', topbarFg: '#f0fbff',
            sidebarBg: '#3b7a8c', sidebarFg: '#f0fbff',
            accent: '#6cc4dc',
        },
    },
    {
        id: 'dailan',
        label: '黛蓝',
        light: {
            pageBg: '#f2f6fa', pageFg: '#1c2a35',
            cardBg: '#e4ecf3', cardFg: '#1c2a35',
            topbarBg: '#2f4a5c', topbarFg: '#eef7ff',
            sidebarBg: '#3a5668', sidebarFg: '#eef7ff',
            accent: '#4a718a',
        },
        dark: {
            pageBg: '#0a1015', pageFg: '#e4edf4',
            cardBg: '#141d24', cardFg: '#e4edf4',
            topbarBg: '#2f4a5c', topbarFg: '#eef7ff',
            sidebarBg: '#3a5668', sidebarFg: '#eef7ff',
            accent: '#79a7c4',
        },
    },
    {
        id: 'zhuqing',
        label: '竹青',
        light: {
            pageBg: '#f4f8f1', pageFg: '#243322',
            cardBg: '#e8f1e2', cardFg: '#243322',
            topbarBg: '#4f6b46', topbarFg: '#f3faef',
            sidebarBg: '#5e7a52', sidebarFg: '#f3faef',
            accent: '#5d8a53',
        },
        dark: {
            pageBg: '#0c120b', pageFg: '#e8f2e4',
            cardBg: '#172016', cardFg: '#e8f2e4',
            topbarBg: '#4f6b46', topbarFg: '#f3faef',
            sidebarBg: '#5e7a52', sidebarFg: '#f3faef',
            accent: '#8fc383',
        },
    },
    {
        id: 'canglv',
        label: '苍绿',
        light: {
            pageBg: '#f1f7f4', pageFg: '#1c3029',
            cardBg: '#e2efe9', cardFg: '#1c3029',
            topbarBg: '#3b5f52', topbarFg: '#eef8f3',
            sidebarBg: '#4f7a6a', sidebarFg: '#eef8f3',
            accent: '#4f8a74',
        },
        dark: {
            pageBg: '#08110e', pageFg: '#e2f1ea',
            cardBg: '#111f1a', cardFg: '#e2f1ea',
            topbarBg: '#3b5f52', topbarFg: '#eef8f3',
            sidebarBg: '#4f7a6a', sidebarFg: '#eef8f3',
            accent: '#7dc4a8',
        },
    },
    {
        id: 'qingci',
        label: '青瓷',
        light: {
            pageBg: '#f1f8f7', pageFg: '#1e312e',
            cardBg: '#e1efec', cardFg: '#1e312e',
            topbarBg: '#4f7f78', topbarFg: '#f0fbf8',
            sidebarBg: '#5c8a84', sidebarFg: '#f0fbf8',
            accent: '#477f78',
        },
        dark: {
            pageBg: '#081211', pageFg: '#e1f1ee',
            cardBg: '#111f1d', cardFg: '#e1f1ee',
            topbarBg: '#4f7f78', topbarFg: '#f0fbf8',
            sidebarBg: '#5c8a84', sidebarFg: '#f0fbf8',
            accent: '#8ccbc2',
        },
    },
    {
        id: 'qiuxiang',
        label: '秋香',
        light: {
            pageBg: '#fdf9ed', pageFg: '#3a3018',
            cardBg: '#f8f0d8', cardFg: '#3a3018',
            topbarBg: '#8a6d1f', topbarFg: '#fff8e0',
            sidebarBg: '#a07f2a', sidebarFg: '#fff8e0',
            accent: '#9a741c',
        },
        dark: {
            pageBg: '#141106', pageFg: '#f7efd6',
            cardBg: '#211b0c', cardFg: '#f7efd6',
            topbarBg: '#6d5518', topbarFg: '#fff8e0',
            sidebarBg: '#7d6220', sidebarFg: '#fff8e0',
            accent: '#e0bb55',
        },
    },
    {
        id: 'chase',
        label: '茶色',
        light: {
            pageBg: '#f8f4f0', pageFg: '#33241a',
            cardBg: '#efe5dc', cardFg: '#33241a',
            topbarBg: '#6f4630', topbarFg: '#fbf3ec',
            sidebarBg: '#8a5a3b', sidebarFg: '#fbf3ec',
            accent: '#9a6644',
        },
        dark: {
            pageBg: '#120c08', pageFg: '#f1e7df',
            cardBg: '#1f1510', cardFg: '#f1e7df',
            topbarBg: '#6f4630', topbarFg: '#fbf3ec',
            sidebarBg: '#8a5a3b', sidebarFg: '#fbf3ec',
            accent: '#c98e68',
        },
    },
    {
        id: 'xuanqing',
        label: '玄青',
        light: {
            pageBg: '#f4f6f8', pageFg: '#1b242b',
            cardBg: '#e8edf1', cardFg: '#1b242b',
            topbarBg: '#1f2a33', topbarFg: '#eaf2f7',
            sidebarBg: '#26343f', sidebarFg: '#eaf2f7',
            accent: '#3f6b82',
        },
        dark: {
            pageBg: '#0b1013', pageFg: '#e6eef3',
            cardBg: '#151d23', cardFg: '#e6eef3',
            topbarBg: '#1f2a33', topbarFg: '#eaf2f7',
            sidebarBg: '#26343f', sidebarFg: '#eaf2f7',
            accent: '#79a8c0',
        },
    },
    {
        id: 'yuebai',
        label: '月白',
        light: {
            pageBg: '#f7fafc', pageFg: '#26313a',
            cardBg: '#edf3f8', cardFg: '#26313a',
            topbarBg: '#6f8797', topbarFg: '#fbfdff',
            sidebarBg: '#647d8d', sidebarFg: '#fbfdff',
            accent: '#5f8398',
        },
        dark: {
            pageBg: '#0f1519', pageFg: '#eaf2f7',
            cardBg: '#192228', cardFg: '#eaf2f7',
            topbarBg: '#566d7c', topbarFg: '#fbfdff',
            sidebarBg: '#647d8d', sidebarFg: '#fbfdff',
            accent: '#9fc3d6',
        },
    },
];

/** Split the site groups into the fixed first/last and the replaceable middle. */
export function splitSidebarGroups(globalGroups: NavGroupConfig[]): {
    first: NavGroupConfig | null;
    middle: NavGroupConfig[];
    last: NavGroupConfig | null;
} {
    if (!globalGroups.length) return { first: null, middle: [], last: null };
    if (globalGroups.length === 1) {
        return { first: globalGroups[0], middle: [], last: null };
    }
    return {
        first: globalGroups[0],
        middle: globalGroups.slice(1, -1),
        last: globalGroups[globalGroups.length - 1],
    };
}

/**
 * Effective sidebar: fixed first group + (user middle or site middle) + fixed
 * last group. `middle === null` means "not customized"; `[]` means the user
 * deliberately cleared the middle.
 */
export function mergeSidebarGroups(
    globalGroups: NavGroupConfig[],
    middle: NavGroupConfig[] | null,
): NavGroupConfig[] {
    if (!globalGroups.length) return middle ? [...middle] : [];
    const split = splitSidebarGroups(globalGroups);
    const effectiveMiddle = middle === null ? split.middle : middle;
    const result: NavGroupConfig[] = [];
    if (split.first) result.push(split.first);
    result.push(...effectiveMiddle);
    if (split.last) result.push(split.last);
    return result;
}
