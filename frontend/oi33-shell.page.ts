import {
    $, AutoloadPage, Notification, addPage, request, selectUser,
} from '@hydrooj/ui-default';
// The shell (top bar + left navigation) replaces Hydro's horizontal nav. The
// drawer and the account menu are plain CSS class toggles; keeping them here
// instead of reusing Hydro's slideout means the sidebar can live on the left
// without fighting the right-side slideout + panel transform.

const MOBILE_BREAKPOINT = 1000;

function setupDrawer() {
    const root = document.documentElement;
    const burger = document.querySelector<HTMLElement>('[data-oi33-burger]');
    const overlay = document.querySelector<HTMLElement>('[data-oi33-overlay]');
    const closeButton = document.querySelector<HTMLElement>('[data-oi33-close]');
    const sidebar = document.getElementById('oi33-sidebar');
    if (!burger || !sidebar) return;

    let open = false;
    const apply = (next: boolean) => {
        open = next;
        root.classList.toggle('oi33-nav-open', next);
        burger.setAttribute('aria-expanded', String(next));
        burger.setAttribute('aria-label', next ? '关闭导航' : '展开导航');
    };
    burger.addEventListener('click', () => apply(!open));
    overlay?.addEventListener('click', () => apply(false));
    closeButton?.addEventListener('click', () => apply(false));
    // Following a link navigates away; close first so the drawer does not stay
    // open when the browser restores the page from the bfcache.
    sidebar.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => apply(false)));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && open) apply(false);
    });
    window.addEventListener('resize', () => {
        if (open && window.innerWidth > MOBILE_BREAKPOINT) apply(false);
    });
}

function setupUserMenu() {
    const wrap = document.querySelector<HTMLElement>('[data-oi33-user]');
    if (!wrap) return;
    const trigger = wrap.querySelector<HTMLElement>('[data-oi33-user-trigger]');
    if (!trigger) return;

    let open = false;
    const apply = (next: boolean) => {
        open = next;
        wrap.classList.toggle('is-open', next);
        trigger.setAttribute('aria-expanded', String(next));
    };
    trigger.addEventListener('click', (event) => {
        // Keep ctrl/cmd/middle click working: those should open the profile in a
        // new tab instead of toggling the menu.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        apply(!open);
    });
    document.addEventListener('click', (event) => {
        if (open && !wrap.contains(event.target as Node)) apply(false);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && open) apply(false);
    });
}

// Desktop sidebar collapse/expand. The initial class is restored by the inline
// script in partials/nav.html before the shell markup is parsed, so this only
// handles the click and keeps localStorage/aria in sync.
function setupSidebarToggle() {
    const button = document.querySelector<HTMLElement>('[data-oi33-sidebar-toggle]');
    if (!button) return;
    const root = document.documentElement;
    const sync = () => {
        const collapsed = root.classList.contains('oi33-sidebar-collapsed');
        const label = collapsed ? '展开侧边栏' : '收起侧边栏';
        button.setAttribute('aria-expanded', String(!collapsed));
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
    };
    button.addEventListener('click', () => {
        const collapsed = !root.classList.contains('oi33-sidebar-collapsed');
        root.classList.toggle('oi33-sidebar-collapsed', collapsed);
        try {
            window.localStorage.setItem('oi33.sidebar.collapsed', collapsed ? '1' : '0');
        } catch { /* localStorage unavailable */ }
        sync();
        // Let sticky-kit / StyledTable recalculate after the content widens.
        $(document).trigger('vjLayout');
    });
    sync();
}

// Hydro's navigation page normally owns the "switch account" action; since the
// horizontal nav is gone, bind the same flow here.
function setupSwitchAccount() {
    document.querySelectorAll<HTMLElement>('[name="nav_switch_account"]').forEach((element) => {
        element.addEventListener('click', async (event) => {
            event.preventDefault();
            const target = await selectUser();
            if (!target) return;
            try {
                const res = await request.get(`/account/${target._id}`);
                if (res.url) window.location.href = res.url;
                else window.location.reload();
            } catch (error: any) {
                Notification.error(error.message);
            }
        });
    });
}

addPage(new AutoloadPage('oi33Shell', () => {
    // The partial adds this class synchronously; without it Hydro's original
    // navigation is in charge (e.g. DEV template lookup shadowing our override).
    if (!document.documentElement.classList.contains('oi33-shell')) return;
    setupDrawer();
    setupSidebarToggle();
    setupUserMenu();
    setupSwitchAccount();
}));
