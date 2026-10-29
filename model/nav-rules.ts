// Pure navigation configuration rules: normalisation and the built-in default
// sidebar. The runtime side (reading `oi33.nav_groups` from SystemModel, parsing
// YAML, resolving Hydro Nav nodes and handler URLs) lives in ./nav.ts so this
// module stays free of hydrooj/DB/DOM imports and can be unit tested directly.

export interface NavItemConfig {
    /** Hydro Nav node name (`ui.getNodes('Nav')`), e.g. `problem_main`. */
    node?: string;
    /** Link label. Optional for node items (the node's own label is used). */
    label?: string;
    /** Absolute path or http(s) URL for a plain link item. */
    href?: string;
    /** Hydro route name for a plain link item; resolved with `handler.url`. */
    route?: string;
    /** Sprite icon name; unknown names fall back to `dot`, `none` hides it. */
    icon?: string;
    /** `page_name` prefix used for the active state. */
    prefix?: string;
    /** Require an exact `page_name === prefix` match instead of startsWith. */
    exact?: boolean;
    /** Only show to logged-in users. */
    login?: boolean;
    /** Only show to OI33 admins (realname_flag >= 2). */
    admin?: boolean;
}

export interface NavGroupConfig {
    title?: string;
    items: NavItemConfig[];
}

export interface NavLink {
    name: string;
    url: string;
    /** http(s) links open in a new tab; internal `/...` paths stay in the tab. */
    external?: boolean;
}

// The sprite in templates/partials/nav.html defines exactly these symbols.
export const NAV_ICONS = new Set([
    'activity', 'award', 'book', 'book-open', 'can', 'cap', 'chart', 'chat',
    'clipboard', 'copy', 'crown', 'dot', 'file-text', 'flask', 'gift', 'hammer',
    'home', 'layers', 'message', 'paw', 'pen', 'settings', 'shield', 'trophy', 'users',
]);

const MAX_GROUPS = 24;
const MAX_ITEMS = 60;
const MAX_LINKS = 12;
const MAX_TITLE = 40;
const MAX_LABEL = 40;
const MAX_URL = 500;
const MAX_ROUTE = 100;
const MAX_ICON = 40;
const MAX_PREFIX = 100;

const text = (value: unknown, max: number): string => (
    typeof value === 'string' ? value.trim().slice(0, max) : ''
);
const flag = (value: unknown): boolean => value === true;
// Control characters and backslashes are unsafe in hrefs: browsers normalize
// `\` to `/`, so `/\evil.example` would otherwise escape to another origin.
// eslint-disable-next-line no-control-regex
const UNSAFE_URL_CHARS = /[\u0000-\u0020\u007f\u2028\u2029\\]/;
const isHttp = (url: string): boolean => {
    if (!/^https?:\/\//i.test(url) || UNSAFE_URL_CHARS.test(url)) return false;
    try {
        const parsed = new URL(url);
        // Embedded credentials are a classic phishing vector; no legitimate
        // top-bar/nav link needs them.
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && !parsed.username && !parsed.password;
    } catch {
        return false;
    }
};
// Internal links must start with a single slash. `//host` is a
// protocol-relative external URL, and `/\host` is normalized to it by browsers,
// so neither may pass as an internal path.
const isLinkHref = (url: string): boolean => (
    (url.startsWith('/') && !url.startsWith('//') && !UNSAFE_URL_CHARS.test(url)) || isHttp(url)
);
const isRouteName = (route: string): boolean => /^[a-z0-9_]+$/i.test(route);

function normalizeIcon(value: unknown): string | undefined {
    const name = text(value, MAX_ICON);
    if (!name) return undefined;
    if (name === 'none') return 'none';
    return NAV_ICONS.has(name) ? name : 'dot';
}

function normalizeItem(raw: unknown): NavItemConfig | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    const node = text(source.node, MAX_ROUTE);
    const label = text(source.label, MAX_LABEL);
    const href = text(source.href, MAX_URL);
    const route = text(source.route, MAX_ROUTE);
    const item: NavItemConfig = {};
    if (node) item.node = node;
    if (label) item.label = label;
    if (href && isLinkHref(href)) item.href = href;
    if (route && isRouteName(route)) item.route = route;
    const icon = normalizeIcon(source.icon);
    if (icon) item.icon = icon;
    const prefix = text(source.prefix, MAX_PREFIX);
    if (prefix) item.prefix = prefix;
    if (flag(source.exact)) item.exact = true;
    if (flag(source.login)) item.login = true;
    if (flag(source.admin)) item.admin = true;
    if (!item.node && !item.label) return null;
    if (!item.node && !item.href && !item.route) return null;
    return item;
}

/**
 * Turn a parsed YAML/JSON value into a safe navigation config. Invalid groups
 * and items are dropped instead of breaking the sidebar; an explicitly empty
 * array means "no sidebar items", while `null`/garbage means "no usable config".
 */
export function normalizeNavGroups(input: unknown): NavGroupConfig[] {
    const source = Array.isArray(input)
        ? input
        : (input && typeof input === 'object' && Array.isArray((input as any).groups)
            ? (input as any).groups
            : null);
    if (!source) return [];
    const groups: NavGroupConfig[] = [];
    for (const rawGroup of source.slice(0, MAX_GROUPS)) {
        if (!rawGroup || typeof rawGroup !== 'object') continue;
        const rawItems = (rawGroup as any).items;
        if (!Array.isArray(rawItems)) continue;
        const items: NavItemConfig[] = [];
        for (const rawItem of rawItems.slice(0, MAX_ITEMS)) {
            const item = normalizeItem(rawItem);
            if (item) items.push(item);
        }
        if (!items.length) continue;
        groups.push({ title: text((rawGroup as any).title, MAX_TITLE), items });
    }
    return groups;
}

/** Parse the one-link-per-line `名称|URL` text used by the top bar setting. */
export function normalizeNavLinks(raw: unknown): NavLink[] {
    if (typeof raw !== 'string' || !raw.trim()) return [];
    const links: NavLink[] = [];
    for (const line of raw.split(/\r?\n/).slice(0, MAX_LINKS)) {
        const splitAt = line.indexOf('|');
        if (splitAt < 0) continue;
        const name = text(line.slice(0, splitAt), MAX_LABEL);
        const url = text(line.slice(splitAt + 1), MAX_URL);
        if (!name || !isLinkHref(url)) continue;
        links.push({ name, url, external: isHttp(url) });
    }
    return links;
}

export function navLinksToText(links: NavLink[]): string {
    return links.map((link) => `${link.name}|${link.url}`).join('\n');
}

export const DEFAULT_NAV_LINKS: NavLink[] = [
    { name: '百科', url: '/oi33/wiki', external: false },
    { name: '主域', url: '/', external: false },
];

export const DEFAULT_NAV_GROUPS: NavGroupConfig[] = [
    {
        title: '',
        items: [
            { node: 'homepage', icon: 'home' },
            { node: 'problem_main', icon: 'book' },
            { node: 'training_main', icon: 'cap' },
            { node: 'contest_main', icon: 'trophy' },
            { node: 'homework_main', icon: 'clipboard' },
            { node: 'record_main', icon: 'activity' },
        ],
    },
    {
        title: '社区',
        items: [
            { node: 'ranking', icon: 'chart' },
            { node: 'discussion_main', icon: 'chat' },
            { label: '题目讨论', href: '/oi33/discuss/problem', icon: 'message', prefix: 'oi33_problem_discussions' },
            { label: '喵喵广场', href: '/oi33/meow', icon: 'chat', prefix: 'oi33_meow' },
            { label: '题解', href: '/oi33/solutions', icon: 'file-text', prefix: 'oi33_solution' },
            { label: '百科', href: '/oi33/wiki', icon: 'book-open', prefix: 'oi33_wiki' },
        ],
    },
    {
        title: '更多功能',
        items: [
            { label: '剪贴板', href: '/oi33/paste/manage', icon: 'copy', prefix: 'oi33_paste', login: true },
            { label: '算法掌握', href: '/oi33/algorithm', icon: 'flask', prefix: 'oi33_algorithm', login: true },
            { label: '猫猫广场', href: '/oi33/arena', icon: 'paw', prefix: 'oi33_cat_can_arena' },
            { label: '像素画', href: '/oi33/draw', icon: 'pen', prefix: 'oi33_draw' },
        ],
    },
    {
        title: '管理',
        items: [
            { label: 'OI33 管理后台', href: '/oi33/admin', icon: 'shield', prefix: 'oi33_admin', admin: true },
            { node: 'manage_dashboard', icon: 'settings' },
            { node: 'domain_dashboard', icon: 'layers' },
        ],
    },
];
