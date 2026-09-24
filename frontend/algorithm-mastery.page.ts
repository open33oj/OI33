import { addPage } from '@hydrooj/ui-default';

// 算法掌握面板的渐进增强。
// 核心提交是页面上唯一的 <form id="alg-form">：所有 select 通过 form= 关联到它，
// 学生改完整份面板后点一次「提交本月更新」（服务端校验每月一次），老师则随时
// 「保存修改」。脚本只做三件事：实时预览统计、显示未保存改动数、提交前确认
// （学生提交会消耗当月额度）以及带未保存改动离开时提醒。
// 事件用 document 级委托绑定，pjax 换页后无需重新初始化。

function panelOf(el: Element | null): HTMLElement | null {
    return (el?.closest?.('.oi33-alg-panel') as HTMLElement | null) || null;
}

function maxLevelOf(panel: HTMLElement) {
    const value = Number(panel.dataset.algMaxLevel);
    return Number.isSafeInteger(value) && value > 0 ? value : 3;
}

function setText(root: ParentNode, selector: string, value: string) {
    const el = root.querySelector(selector);
    if (el) el.textContent = value;
}

function scoreOf(sum: number, total: number, maxLevel: number) {
    return total && maxLevel ? Math.round((sum * 100) / (maxLevel * total)) : 0;
}

// Re-derive the summary from the current selects so the counts and progress
// bars preview the pending (unsaved) state before the batch submit.
function recompute(panel: HTMLElement) {
    const maxLevel = maxLevelOf(panel);
    const rows = Array.from(panel.querySelectorAll<HTMLElement>('.oi33-alg-item'));
    const counts = [0, 0, 0, 0];
    const byGroup = new Map<string, { total: number; sum: number; rated: number }>();
    let sum = 0;
    let rated = 0;
    for (const row of rows) {
        const select = row.querySelector<HTMLSelectElement>('select.oi33-alg-select');
        // A select value of -1 means 未评定.
        const raw = select ? Number(select.value) : Number(row.dataset.algLevel) || 0;
        const isRated = select ? raw >= 0 : row.dataset.algRated === '1';
        const level = raw < 0 ? 0 : raw;
        counts[level] = (counts[level] || 0) + 1;
        sum += level;
        if (isRated) rated++;
        const groupId = row.closest<HTMLElement>('[data-alg-group]')?.dataset.algGroup || '';
        const bucket = byGroup.get(groupId) || { total: 0, sum: 0, rated: 0 };
        bucket.total++;
        bucket.sum += level;
        if (isRated) bucket.rated++;
        byGroup.set(groupId, bucket);
    }
    const total = rows.length;
    const score = scoreOf(sum, total, maxLevel);
    setText(panel, '[data-alg-stat="score"]', String(score));
    setText(panel, '[data-alg-stat="rated"]', String(rated));
    setText(panel, '[data-alg-stat="total"]', String(total));
    setText(panel, '[data-alg-stat="unrated"]', String(total - rated));
    for (let level = 0; level < counts.length; level++) {
        setText(panel, `[data-alg-stat="count-${level}"]`, String(counts[level] || 0));
    }
    const bar = panel.querySelector<HTMLElement>('[data-alg-stat-bar]');
    if (bar) bar.style.width = `${score}%`;

    for (const mini of panel.querySelectorAll<HTMLElement>('.oi33-alg-mini[data-alg-level]')) {
        const bucket = byGroup.get(mini.dataset.algLevel || '');
        if (!bucket?.total) continue;
        const value = scoreOf(bucket.sum, bucket.total, maxLevel);
        const miniBar = mini.querySelector<HTMLElement>('[data-alg-level-bar]');
        if (miniBar) miniBar.style.width = `${value}%`;
        const miniText = mini.querySelector<HTMLElement>('[data-alg-level-score]');
        if (miniText) miniText.textContent = `${value}%`;
    }
    for (const group of panel.querySelectorAll<HTMLElement>('details[data-alg-group]')) {
        const bucket = byGroup.get(group.dataset.algGroup || '');
        const label = group.querySelector<HTMLElement>('[data-alg-group-stats]');
        if (bucket?.total && label) {
            label.textContent = `${bucket.rated}/${bucket.total} · ${scoreOf(bucket.sum, bucket.total, maxLevel)}%`;
        }
    }
}

function dirtySelects(panel: HTMLElement) {
    return Array.from(panel.querySelectorAll<HTMLSelectElement>('select.oi33-alg-select'))
        .filter((select) => String(select.value) !== (select.dataset.prev ?? ''));
}

function refreshDirty(panel: HTMLElement) {
    const dirty = dirtySelects(panel);
    for (const select of panel.querySelectorAll<HTMLSelectElement>('select.oi33-alg-select')) {
        select.closest<HTMLElement>('.oi33-alg-item')
            ?.classList.toggle('oi33-alg-item--dirty', String(select.value) !== (select.dataset.prev ?? ''));
    }
    const label = panel.querySelector<HTMLElement>('[data-alg-dirty]');
    if (label) {
        label.hidden = dirty.length === 0;
        label.textContent = `${dirty.length} 处未保存改动`;
    }
    const submit = panel.querySelector<HTMLButtonElement>('[data-alg-submit]');
    if (submit) submit.disabled = dirty.length === 0;
    panel.dataset.algDirty = dirty.length ? '1' : '0';
}

function refreshPanel(panel: HTMLElement) {
    recompute(panel);
    refreshDirty(panel);
}

function applyFilter(panel: HTMLElement, query: string) {
    const needle = query.trim().toLowerCase();
    const isVisible = (el: HTMLElement) => el.style.display !== 'none';
    for (const row of panel.querySelectorAll<HTMLElement>('.oi33-alg-item')) {
        const haystack = (row.dataset.algText || '').toLowerCase();
        row.style.display = !needle || haystack.includes(needle) ? '' : 'none';
    }
    for (const subsection of panel.querySelectorAll<HTMLElement>('[data-alg-subsection]')) {
        subsection.style.display = Array.from(subsection.querySelectorAll<HTMLElement>('.oi33-alg-item')).some(isVisible) ? '' : 'none';
    }
    for (const section of panel.querySelectorAll<HTMLElement>('[data-alg-section]')) {
        section.style.display = Array.from(section.querySelectorAll<HTMLElement>('.oi33-alg-item')).some(isVisible) ? '' : 'none';
    }
    for (const group of panel.querySelectorAll<HTMLDetailsElement>('details[data-alg-group]')) {
        const visible = Array.from(group.querySelectorAll<HTMLElement>('.oi33-alg-item')).some(isVisible);
        group.style.display = visible ? '' : 'none';
        if (needle && visible) group.open = true;
    }
}

function toggleAll(el: Element, open: boolean) {
    const panel = panelOf(el);
    if (!panel) return;
    for (const group of panel.querySelectorAll<HTMLDetailsElement>('details[data-alg-group]')) {
        group.open = open;
    }
}

addPage(() => {
    if ((document as any)._oi33AlgorithmBound) return;
    (document as any)._oi33AlgorithmBound = true;

    // Initial pass: server-rendered stats are already correct, but the submit
    // button starts disabled until something changes.
    for (const panel of document.querySelectorAll<HTMLElement>('.oi33-alg-panel')) refreshDirty(panel);

    document.addEventListener('change', (ev) => {
        const select = (ev.target as HTMLElement)?.closest?.('select.oi33-alg-select') as HTMLSelectElement | null;
        if (!select) return;
        const panel = panelOf(select);
        if (panel) refreshPanel(panel);
    });

    document.addEventListener('click', (ev) => {
        const target = ev.target as HTMLElement;
        if (!target?.closest) return;
        const expand = target.closest('.oi33-alg-expand');
        if (expand) {
            ev.preventDefault();
            toggleAll(expand, true);
            return;
        }
        const collapse = target.closest('.oi33-alg-collapse');
        if (collapse) {
            ev.preventDefault();
            toggleAll(collapse, false);
        }
    });

    document.addEventListener('input', (ev) => {
        const search = (ev.target as HTMLElement)?.closest?.('input.oi33-alg-search') as HTMLInputElement | null;
        if (!search) return;
        const panel = panelOf(search);
        if (panel) applyFilter(panel, search.value);
    });

    document.addEventListener('submit', (ev) => {
        const form = ev.target as HTMLFormElement;
        if (!form || form.id !== 'alg-form') return;
        const panel = form.closest<HTMLElement>('.oi33-alg-panel')
            || document.querySelector<HTMLElement>('.oi33-alg-panel');
        if (!panel) return;
        if (dirtySelects(panel).length === 0) {
            ev.preventDefault();
            return;
        }
        // Students consume their one submit this month, so confirm first.
        if (panel.dataset.algQuota === '1'
            && !window.confirm('提交后本月将不能再修改自评，确定提交吗？')) {
            ev.preventDefault();
        }
    });

    window.addEventListener('beforeunload', (ev) => {
        const dirty = Array.from(document.querySelectorAll<HTMLElement>('.oi33-alg-panel'))
            .some((panel) => panel.dataset.algDirty === '1');
        if (!dirty) return;
        ev.preventDefault();
        ev.returnValue = '';
    });
});
