// The shell's navigation is driven by `oi33.nav_groups` (and `oi33.nav_links`
// for the top bar), with a per-user override for colors, top links and the
// middle sidebar groups (see model/theme.ts). Resolve it once per request,
// after the handler method has run (so contest pages can supply
// `response.body.overrideNav`) and before the template is rendered.

import { Context, ValidationError } from 'hydrooj';
import { buildNavGroups, getNavLinks, validateNavGroupsYaml } from '../model/nav';
import { normalizeNavLinks } from '../model/nav-rules';
import { getUserTheme } from '../model/theme';
import { themeCss } from '../model/theme-rules';

export function apply(ctx: Context) {
    // `/manage/setting` (SystemSettingHandler) does not run Setting.validation,
    // so invalid YAML would be persisted and silently make the rail fall back to
    // defaults. Reject it here with a normal ValidationError instead.
    ctx.on('handler/before/SystemSetting', (h: any) => {
        const args = h?.args || {};
        const raw = args['oi33.nav_groups'] ?? args.oi33?.nav_groups;
        if (typeof raw === 'string' && raw.trim() && !validateNavGroupsYaml(raw)) {
            throw new ValidationError('oi33.nav_groups');
        }
    });
    ctx.on('handler/after', async (h: any) => {
        // JSON/raw/file responses never render the shell; skip the work.
        if (!h.response?.template) return;
        try {
            const theme = await getUserTheme(h.user?._id);
            h.oi33Theme = theme;
            h.oi33ThemeCss = themeCss(theme);
            h.oi33NavLinks = theme.links == null ? getNavLinks() : normalizeNavLinks(theme.links);
            h.oi33NavGroups = buildNavGroups(h, theme.navGroups);
            // Templates are hot-reloaded from disk in debug mode while the
            // running worker may still be older than the route registration.
            // Resolve the theme URL defensively so the every-page user menu can
            // never break with "No route found for name: oi33_theme".
            try {
                h.oi33ThemeUrl = h.url('oi33_theme');
            } catch {
                h.oi33ThemeUrl = '';
            }
        } catch (e) {
            console.error('[oi33] failed to build the sidebar navigation:', e);
            // Leave `oi33NavGroups` undefined so the nav template falls back to
            // Hydro's own Nav nodes instead of rendering an empty rail.
            h.oi33NavLinks = [];
        }
    });
}
