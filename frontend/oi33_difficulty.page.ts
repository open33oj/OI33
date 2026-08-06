import { addPage } from '@hydrooj/ui-default';

// Difficulty mask toggle (pure frontend): the real badge is rendered in the
// page but hidden by CSS; clicks flip inline styles directly (no reliance on
// stylesheet cascade) and mirror the state onto the .oi33-diff-shown class.
//  - Problem page: each masked badge (tag row + sidebar) toggles itself.
//  - Problem list / training detail: the plain-text 显示难度 link in the
//    column header toggles the whole column; cells are not individually
//    toggleable. Hidden cells show a gray 隐藏 placeholder.
// Registered as a plain function (not NamedPage) so it runs on every page
// load — the delegation is bound no matter which page the session starts on.
addPage(() => {
    if ((document as any)._oi33DiffBound) return;
    (document as any)._oi33DiffBound = true;
    document.addEventListener('click', (ev) => {
        const target = ev.target as HTMLElement;
        if (!target || !target.closest) return;
        const colToggle = target.closest('.oi33-diff-col-toggle') as HTMLElement;
        if (colToggle) {
            // Hydro's sticky-header script splits thead/tbody into two
            // sibling tables, and the wrapper markup varies by version —
            // so walk up from the toggle to the nearest ancestor that also
            // contains the value cells instead of relying on a fixed class.
            let scope = colToggle.parentElement as HTMLElement | null;
            while (scope && !scope.querySelector('.oi33-diff-col-value')) scope = scope.parentElement;
            if (!scope) return;
            const shown = !scope.classList.contains('oi33-diff-shown');
            scope.classList.toggle('oi33-diff-shown', shown);
            scope.querySelectorAll<HTMLElement>('.oi33-diff-col-hidden').forEach((el) => {
                el.style.display = shown ? 'none' : '';
            });
            scope.querySelectorAll<HTMLElement>('.oi33-diff-col-value').forEach((el) => {
                el.style.display = shown ? 'inline-block' : 'none';
            });
            colToggle.textContent = shown
                ? colToggle.dataset.hideText || '隐藏难度'
                : colToggle.dataset.showText || '显示难度';
            return;
        }
        const wrap = target.closest('.oi33-diffwrap') as HTMLElement;
        if (wrap) {
            const shown = !wrap.classList.contains('oi33-diff-shown');
            wrap.classList.toggle('oi33-diff-shown', shown);
            const mask = wrap.querySelector<HTMLElement>('.oi33-diff-mask');
            const real = wrap.querySelector<HTMLElement>('.oi33-diff-real');
            if (mask) mask.style.display = shown ? 'none' : '';
            if (real) real.style.display = shown ? 'inline-block' : 'none';
        }
    });
});
