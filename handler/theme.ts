import {
    Context, Handler, PRIV, ValidationError, yaml,
} from 'hydrooj';
import { oi33Model } from '../model';
import { getNavGroups, getNavLinks } from '../model/nav';
import { NAV_ICONS, navLinksToText, normalizeNavGroups, normalizeNavLinks } from '../model/nav-rules';
import type { NavGroupConfig } from '../model/nav-rules';
import {
    sanitizeThemeCss, THEME_CSS_SELECTORS, THEME_PRESETS, splitSidebarGroups,
    themeSnippet, themeWarnings,
} from '../model/theme-rules';

const MAX_LINKS_TEXT = 2000;
const MAX_NAV_YAML = 12000;
const MAX_LINKS = 12;

function bodyField(body: any, name: string): string {
    const value = body?.[name];
    return String(Array.isArray(value) ? value[0] : value ?? '').trim();
}

function validateLinksText(raw: string) {
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length > MAX_LINKS) throw new ValidationError(`顶部链接最多 ${MAX_LINKS} 条。`);
    // Normalization is the single source of truth for what is a safe link
    // (rejects javascript:, protocol-relative //, backslashes, ...); compare
    // the counts so a bad line is an explicit error instead of being dropped
    // silently.
    if (normalizeNavLinks(raw).length !== lines.length) {
        throw new ValidationError(
            '顶部链接格式应为「名称|URL」；URL 只能是以 / 开头的站内路径或 http(s):// 外链。',
        );
    }
}

function parseNavGroups(raw: string): NavGroupConfig[] {
    if (!raw.trim()) return [];
    let parsed: any;
    try {
        parsed = yaml.load(raw, { json: true });
    } catch {
        throw new ValidationError('侧边栏 YAML 格式不正确，请检查缩进与列表写法。');
    }
    const source = Array.isArray(parsed) ? parsed : parsed?.groups;
    if (!Array.isArray(source)) {
        throw new ValidationError('侧边栏必须是「组」的列表（每组包含 title 与 items）。');
    }
    const groups = normalizeNavGroups(source);
    if (source.length && !groups.length) {
        throw new ValidationError('每个栏目至少需要一个有效条目（items）；只有 title 的分组不会被保存。');
    }
    return groups;
}

class Oi33ThemeHandler extends Handler {
    async get() {
        const theme = await oi33Model.getUserTheme(this.user._id);
        const globalGroups = getNavGroups();
        const split = splitSidebarGroups(globalGroups);
        const middle = theme.navGroups ?? split.middle;
        const linksText = theme.links ?? navLinksToText(getNavLinks());
        this.response.template = 'oi33_theme.html';
        this.response.body = {
            // Avoid the name `theme`: layout/html5.html also sets a local
            // `theme` string for the dark-mode class, which shadows it.
            lightTheme: theme.light,
            darkTheme: theme.dark,
            themePresets: THEME_PRESETS.map((preset) => ({
                id: preset.id,
                label: preset.label,
                light: preset.light,
                dark: preset.dark,
                lightCss: themeSnippet(preset.light),
                darkCss: themeSnippet(preset.dark),
            })),
            themeCssSelectors: THEME_CSS_SELECTORS,
            themeWarnings: themeWarnings(theme),
            lightCss: theme.lightCss || '',
            darkCss: theme.darkCss || '',
            navIcons: [...NAV_ICONS].sort(),
            linksText,
            linksCustom: theme.links != null,
            navGroupsYaml: yaml.dump(middle, { noRefs: true, lineWidth: -1 }),
            navCustom: theme.navGroups != null,
            firstGroup: split.first,
            lastGroup: split.last,
            defaultLinksText: navLinksToText(getNavLinks()),
        };
    }

    async post() {
        const body = this.request.body as any;
        const action = bodyField(body, 'action');
        if (action === 'reset') {
            await oi33Model.saveUserTheme(this.user._id, {});
            this.response.redirect = this.url('oi33_theme', {
                query: { notification: '已恢复全站默认主题。' },
            });
            return;
        }
        // 逐项还原：按钮直接提交 reset_item / reset_mode，只清掉该配置，
        // 不改动表单里其它（可能尚未保存的）内容。
        const resetMode = bodyField(body, 'reset_mode');
        const resetItem = bodyField(body, 'reset_item');
        if (resetItem || resetMode) {
            const colorKeys = ['page_bg', 'page_fg', 'topbar_bg', 'topbar_fg', 'sidebar_bg', 'sidebar_fg', 'accent', 'card_bg', 'card_fg'];
            const items = resetMode
                ? [...colorKeys.map((key) => `${resetMode}_${key}`), `${resetMode}_css`]
                : [resetItem];
            await oi33Model.resetUserTheme(this.user._id, items);
            this.response.redirect = this.url('oi33_theme', {
                query: { notification: '已还原该配置为系统设置版本。' },
            });
            return;
        }
        const currentTheme = await oi33Model.getUserTheme(this.user._id);
        let linksCustom = bodyField(body, 'links_custom') === '1';
        let navCustom = bodyField(body, 'nav_custom') === '1';
        const links = bodyField(body, 'links_text');
        if (links.length > MAX_LINKS_TEXT) throw new ValidationError('顶部链接内容过长。');
        const navYaml = bodyField(body, 'nav_groups');
        if (navYaml.length > MAX_NAV_YAML) throw new ValidationError('侧边栏 YAML 内容过长。');
        const lightCss = bodyField(body, 'light_css');
        const darkCss = bodyField(body, 'dark_css');
        for (const [label, raw, mode] of [
            ['亮色', lightCss, 'light'], ['暗色', darkCss, 'dark'],
        ] as const) {
            if (raw.length > 8000) throw new ValidationError(`${label}自定义 CSS 过长（最多 8000 字符）。`);
            try {
                sanitizeThemeCss(raw, mode);
            } catch (e: any) {
                throw new ValidationError(`${label}自定义 CSS：${e?.message || '格式不正确'}`);
            }
        }
        // 第一次自定义时如果用户只改了文本、忘了勾选，旧页面/无 JS 会静默丢掉。
        // 仅在没有既存自定义时，把「文本与全站默认不同」视为想自定义；已有自定义
        // 的用户取消勾选仍然表示回到全站配置（需要点「还原」清空文本）。
        if (!linksCustom && currentTheme.links == null) {
            const siteLinks = navLinksToText(getNavLinks());
            if (links.trim() !== siteLinks.trim()) linksCustom = true;
        }
        if (!navCustom && currentTheme.navGroups == null) {
            const siteMiddle = yaml.dump(
                splitSidebarGroups(getNavGroups()).middle, { noRefs: true, lineWidth: -1 },
            );
            if (navYaml.trim() !== siteMiddle.trim()) navCustom = true;
        }
        if (linksCustom) validateLinksText(links);
        await oi33Model.saveUserTheme(this.user._id, {
            light: {
                pageBg: bodyField(body, 'light_page_bg'),
                pageFg: bodyField(body, 'light_page_fg'),
                topbarBg: bodyField(body, 'light_topbar_bg'),
                topbarFg: bodyField(body, 'light_topbar_fg'),
                sidebarBg: bodyField(body, 'light_sidebar_bg'),
                sidebarFg: bodyField(body, 'light_sidebar_fg'),
                accent: bodyField(body, 'light_accent'),
                cardBg: bodyField(body, 'light_card_bg'),
                cardFg: bodyField(body, 'light_card_fg'),
            },
            dark: {
                pageBg: bodyField(body, 'dark_page_bg'),
                pageFg: bodyField(body, 'dark_page_fg'),
                topbarBg: bodyField(body, 'dark_topbar_bg'),
                topbarFg: bodyField(body, 'dark_topbar_fg'),
                sidebarBg: bodyField(body, 'dark_sidebar_bg'),
                sidebarFg: bodyField(body, 'dark_sidebar_fg'),
                accent: bodyField(body, 'dark_accent'),
                cardBg: bodyField(body, 'dark_card_bg'),
                cardFg: bodyField(body, 'dark_card_fg'),
            },
            lightCss: lightCss || null,
            darkCss: darkCss || null,
            links: linksCustom ? links : null,
            navGroups: navCustom ? parseNavGroups(navYaml) : null,
        });
        this.response.redirect = this.url('oi33_theme', {
            query: { notification: '个性化主题已保存。' },
        });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_theme', '/oi33/settings/theme', Oi33ThemeHandler, PRIV.PRIV_USER_PROFILE);
}
