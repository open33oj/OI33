import {
    $, AutoloadPage, Notification, addPage, api, i18n, prompt, request,
} from '@hydrooj/ui-default';

// Hydro's "Switch account" flow opens a user picker whose field handler starts
// with `if (e === selected[name]) return;`. Because the autocomplete reports the
// raw input value on every keystroke, typing the *complete* username makes that
// value equal the clicked suggestion's key, so the click is swallowed and the
// dialog never receives the user object — pressing OK then does nothing (or
// complains that the field is required). Typing only a prefix works, which is
// exactly the reported symptom. Upstream fixed it by scoping the guard to
// multi-select (Hydro PR #1184), but an addon cannot assume the deployed
// ui-default carries that fix.
//
// So instead of relying on the dialog's return value we take the handler over:
// when OK is pressed we read the picked text straight from the dialog's
// autocomplete input (exactly what a suggestion click writes there) and resolve
// it to a UID ourselves; the dialog's own value is only a fallback, so a fixed
// ui-default and an old one both end up switching to the same account.

function textOfInput(): string {
    const input = document.querySelector<HTMLInputElement>('.dialog .autocomplete-container input');
    return String(input?.value || '').trim();
}

async function resolveUid(text: string): Promise<number | null> {
    const query = text.trim();
    if (!query) return null;
    // Verified users are rendered as "UID <id>" by the OI33 anonymization.
    const anonymous = /^UID\s+(-?\d+)$/i.exec(query);
    if (anonymous) return Number(anonymous[1]);
    try {
        const rows: any = await api('users', { search: query, exact: true }, ['_id', 'uname']);
        const exact = Array.isArray(rows) ? rows : [];
        const hit = exact.find((u: any) => String(u?.uname || '').toLowerCase() === query.toLowerCase())
            || exact.find((u: any) => String(u?._id) === query)
            || exact[0];
        if (hit?._id) return Number(hit._id);
    } catch (e) {
        console.error('[oi33] switch-account exact user lookup failed:', e);
    }
    try {
        const rows: any = await api('users', { search: query }, ['_id', 'uname']);
        const first = Array.isArray(rows) ? rows[0] : null;
        if (first?._id) return Number(first._id);
    } catch (e) {
        console.error('[oi33] switch-account user lookup failed:', e);
    }
    return null;
}

async function pickUser(): Promise<number | null> {
    let pickedText = '';
    const rememberPickedText = (ev: Event) => {
        const target = ev.target as HTMLElement | null;
        if (!target?.closest?.('[data-action="ok"], [data-action="yes"]')) return;
        if (!target.closest('.dialog')) return;
        pickedText = textOfInput();
    };
    document.addEventListener('click', rememberPickedText, true);
    try {
        const answer: any = await prompt(i18n('Select User'), {
            user: {
                type: 'user',
                label: i18n('Username / UID'),
                autofocus: true,
                // The dialog's own value is unreliable on an old ui-default;
                // asking for `required` would just block OK with an error.
                required: false,
            },
        });
        if (!answer) return null;
        // The input text is what the suggestion click wrote, so it is the
        // authoritative pick; the dialog value is the fallback.
        const byText = await resolveUid(pickedText);
        if (byText) return byText;
        const picked = answer.user;
        if (picked && picked._id) return Number(picked._id);
        if (pickedText) Notification.error(i18n('User {0} not found.', pickedText));
        else Notification.error(i18n('{0} is required', i18n('Username / UID')));
        return null;
    } finally {
        document.removeEventListener('click', rememberPickedText, true);
    }
}

// Replace core's switch-account handler: the ui-default pages (including
// navigationPage) are registered before addon extraPages, so by the time this
// runs the delegated click handler exists and `off` removes it. Re-binding
// (instead of stopping propagation) keeps the account dropdown's own
// close-on-click behaviour intact.
addPage(new AutoloadPage('oi33SwitchAccount', () => {
    $(document).off('click', '[name="nav_switch_account"]');
    $(document).on('click', '[name="nav_switch_account"]', async (ev) => {
        ev.preventDefault();
        try {
            const uid = await pickUser();
            if (!uid) return;
            const res: any = await request.get(`/account/${uid}`);
            if (res?.url) window.location.href = res.url;
            else window.location.reload();
        } catch (error: any) {
            Notification.error(error?.message || String(error));
        }
    });
}));
