// Runtime side of the configurable sidebar: read `oi33.nav_groups` /
// `oi33.nav_links` from SystemModel, parse the YAML once per value, resolve
// Hydro Nav nodes, handler routes and per-user visibility, and hand the nav
// partial a render-ready structure. Pure validation/defaults live in
// ./nav-rules.ts.

import { SystemModel, yaml } from 'hydrooj';
import {
    DEFAULT_NAV_GROUPS, DEFAULT_NAV_LINKS, navLinksToText,
    normalizeNavGroups, normalizeNavLinks,
} from './nav-rules';
import type { NavGroupConfig, NavItemConfig, NavLink } from './nav-rules';

export const DEFAULT_NAV_GROUPS_YAML = yaml.dump(DEFAULT_NAV_GROUPS, { noRefs: true, lineWidth: -1 });
export const DEFAULT_NAV_LINKS_TEXT = navLinksToText(DEFAULT_NAV_LINKS);

// Fallback icons for Hydro Nav nodes when the config does not set one.
const NODE_ICONS: Record<string, string> = {
    homepage: 'home',
    problem_main: 'book',
    training_main: 'cap',
    contest_main: 'trophy',
    homework_main: 'clipboard',
    discussion_main: 'chat',
    record_main: 'activity',
    ranking: 'chart',
    domain_dashboard: 'layers',
    manage_dashboard: 'settings',
};

export interface NavRenderItem {
    /** Hydro Nav node object (rendered by `core_nav` in the template). */
    nodeObj?: any;
    href?: string;
    label: string;
    icon: string;
    prefix: string;
    exact?: boolean;
    external?: boolean;
}

export interface NavRenderGroup {
    title: string;
    items: NavRenderItem[];
}

let groupsRaw: string | null | undefined;
let groupsCache: NavGroupConfig[] = DEFAULT_NAV_GROUPS;
let linksRaw: string | null | undefined;
let linksCache: NavLink[] = DEFAULT_NAV_LINKS;

export function getNavGroups(): NavGroupConfig[] {
    const raw = SystemModel.get('oi33.nav_groups') as string | undefined;
    if (raw === groupsRaw) return groupsCache;
    groupsRaw = raw;
    // An empty textarea means "not configured": use the built-in default. `[]`
    // in the YAML explicitly means "no sidebar entries".
    if (raw == null || !String(raw).trim()) return (groupsCache = DEFAULT_NAV_GROUPS);
    try {
        return (groupsCache = normalizeNavGroups(yaml.load(String(raw), { json: true })));
    } catch (e) {
        console.error('[oi33] invalid nav config, falling back to the default sidebar:', e);
        return (groupsCache = DEFAULT_NAV_GROUPS);
    }
}

export function getNavLinks(): NavLink[] {
    const raw = SystemModel.get('oi33.nav_links') as string | undefined;
    if (raw === linksRaw) return linksCache;
    linksRaw = raw;
    if (raw == null) return (linksCache = DEFAULT_NAV_LINKS);
    return (linksCache = normalizeNavLinks(String(raw)));
}

export function validateNavGroupsYaml(raw: unknown): boolean {
    if (typeof raw !== 'string' || !raw.trim()) return true;
    try {
        const parsed = yaml.load(raw, { json: true });
        if (Array.isArray(parsed)) return true;
        return !!parsed && typeof parsed === 'object' && Array.isArray((parsed as any).groups);
    } catch {
        return false;
    }
}

function resolveLink(handler: any, item: NavItemConfig): NavRenderItem | null {
    const user = handler?.user;
    if (item.login && !user?._id) return null;
    if (item.admin && (Number(user?.realname_flag) || 0) < 2) return null;
    let href = item.href || '';
    if (item.route) {
        try {
            href = handler.url(item.route);
        } catch {
            return null;
        }
    }
    if (!href) return null;
    return {
        href,
        label: item.label || href,
        icon: item.icon || 'dot',
        prefix: item.prefix || item.route || '',
        exact: !!item.exact,
        external: /^https?:\/\//i.test(href),
    };
}

/**
 * Build the per-request sidebar. Contest pages set `response.body.overrideNav`
 * (Hydro's contextual nav); when present that replaces the configured sidebar,
 * matching the old horizontal nav's behaviour.
 */
export function buildNavGroups(handler: any): NavRenderGroup[] {
    const override = handler?.response?.body?.overrideNav;
    if (Array.isArray(override) && override.length) {
        const items: NavRenderItem[] = [];
        for (const node of override) {
            if (!node) continue;
            if (typeof node.checker === 'function' && !node.checker(handler)) continue;
            items.push({
                nodeObj: node,
                label: node.displayName || node.name,
                icon: NODE_ICONS[node.name] || 'dot',
                prefix: '',
            });
        }
        return items.length ? [{ title: '', items }] : [];
    }

    const nodes = ((global as any).Hydro?.ui?.getNodes?.('Nav') || []) as any[];
    const result: NavRenderGroup[] = [];
    for (const group of getNavGroups()) {
        const items: NavRenderItem[] = [];
        for (const item of group.items) {
            if (item.node) {
                const node = nodes.find((entry) => entry.name === item.node);
                if (!node) continue;
                if (typeof node.checker === 'function' && !node.checker(handler)) continue;
                items.push({
                    nodeObj: node,
                    label: item.label || '',
                    icon: item.icon || NODE_ICONS[node.name] || 'dot',
                    prefix: '',
                });
            } else {
                const link = resolveLink(handler, item);
                if (link) items.push(link);
            }
        }
        if (items.length) result.push({ title: group.title || '', items });
    }
    return result;
}
