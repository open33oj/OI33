import { addPage } from '@hydrooj/ui-default';

// 算法掌握【评定页】的渐进增强。
// 每行是一组四档单选框（没学 / 不会 / 不熟 / 熟练），怎么点都行，
// 改完后一次「提交本月更新 / 保存修改」整份落库（学生每月一次，老师不限）。
// 没有评定记录的知识点默认就是「没学」。
// 脚本负责四件事：实时预览统计（总分 / 级别 / 难度 / 板块 / 子板块）、
// 按评价 + 关键词筛选、未保存改动计数、提交前确认与离开提醒。
// 事件用 document 级委托绑定，pjax 换页后无需重新初始化；展示页没有编辑器，脚本自然空转。

function editorOf(el: Element | null): HTMLElement | null {
    return (el?.closest?.('.oi33-alg-editor') as HTMLElement | null) || null;
}

function maxLevelOf(editor: HTMLElement) {
    const value = Number(editor.dataset.algMaxLevel);
    return Number.isSafeInteger(value) && value > 0 ? value : 3;
}

function setText(root: ParentNode, selector: string, value: string) {
    const el = root.querySelector(selector);
    if (el) el.textContent = value;
}

function scoreOf(sum: number, total: number, maxLevel: number) {
    return total && maxLevel ? Math.round((sum * 100) / (maxLevel * total)) : 0;
}

interface Bucket { total: number; sum: number; counts: number[] }

function bucketOf(map: Map<string, Bucket>, key: string): Bucket {
    let bucket = map.get(key);
    if (!bucket) {
        bucket = { total: 0, sum: 0, counts: [0, 0, 0, 0] };
        map.set(key, bucket);
    }
    return bucket;
}

function addTo(bucket: Bucket, level: number) {
    bucket.total++;
    bucket.sum += level;
    bucket.counts[level] = (bucket.counts[level] || 0) + 1;
}

// 每行总有一个选中项；万一没有（脚本禁用时的异常 DOM），按「没学」计。
function rowLevel(row: HTMLElement): number {
    const checked = row.querySelector<HTMLInputElement>('input.oi33-alg-radio:checked');
    return checked ? Number(checked.value) : 0;
}

function rowsOf(editor: HTMLElement) {
    return Array.from(editor.querySelectorAll<HTMLElement>('.oi33-alg-item'));
}

// Re-derive the summary from the current radios so counts, bars and node stats
// preview the pending (unsaved) state before the batch submit.
function recompute(editor: HTMLElement) {
    const maxLevel = maxLevelOf(editor);
    const rows = rowsOf(editor);
    const counts = [0, 0, 0, 0];
    const byGroup = new Map<string, Bucket>();
    const bySection = new Map<string, Bucket>();
    const bySubsection = new Map<string, Bucket>();
    const byDifficulty = new Map<string, Bucket>();
    let sum = 0;
    for (const row of rows) {
        const level = rowLevel(row);
        counts[level] = (counts[level] || 0) + 1;
        sum += level;
        addTo(bucketOf(byGroup, row.closest<HTMLElement>('[data-alg-group]')?.dataset.algGroup || ''), level);
        addTo(bucketOf(bySection, row.closest<HTMLElement>('[data-alg-section]')?.dataset.algSection || ''), level);
        addTo(bucketOf(bySubsection, row.closest<HTMLElement>('[data-alg-subsection]')?.dataset.algSubsection || ''), level);
        addTo(bucketOf(byDifficulty, row.dataset.algDifficulty || '0'), level);
    }
    const total = rows.length;
    const score = scoreOf(sum, total, maxLevel);
    setText(editor, '[data-alg-stat="score"]', String(score));
    setText(editor, '[data-alg-stat="total"]', String(total));
    for (let level = 0; level < counts.length; level++) {
        setText(editor, `[data-alg-stat="count-${level}"]`, String(counts[level] || 0));
    }
    const bar = editor.querySelector<HTMLElement>('[data-alg-stat-bar]');
    if (bar) bar.style.width = `${score}%`;

    const paintMini = (el: HTMLElement, bucket: Bucket | undefined, barSelector: string, textSelector: string) => {
        if (!bucket?.total) return;
        const value = scoreOf(bucket.sum, bucket.total, maxLevel);
        const miniBar = el.querySelector<HTMLElement>(barSelector);
        if (miniBar) miniBar.style.width = `${value}%`;
        const miniText = el.querySelector<HTMLElement>(textSelector);
        if (miniText) miniText.textContent = `${value}%`;
    };
    for (const mini of editor.querySelectorAll<HTMLElement>('.oi33-alg-mini[data-alg-level]')) {
        paintMini(mini, byGroup.get(mini.dataset.algLevel || ''), '[data-alg-level-bar]', '[data-alg-level-score]');
    }
    for (const mini of editor.querySelectorAll<HTMLElement>('.oi33-alg-mini[data-alg-difficulty]')) {
        paintMini(mini, byDifficulty.get(mini.dataset.algDifficulty || ''), '[data-alg-difficulty-bar]', '[data-alg-difficulty-score]');
    }

    const paintStats = (label: HTMLElement | null, bucket: Bucket | undefined) => {
        if (bucket?.total && label) {
            // 与 nodeStats 保持一致：熟练 / 总数 · 掌握度。
            label.textContent = `${bucket.counts[3] || 0}/${bucket.total} · ${scoreOf(bucket.sum, bucket.total, maxLevel)}%`;
        }
    };
    for (const node of editor.querySelectorAll<HTMLElement>('details[data-alg-group]')) {
        paintStats(node.querySelector<HTMLElement>('[data-alg-group-stats]'), byGroup.get(node.dataset.algGroup || ''));
    }
    for (const node of editor.querySelectorAll<HTMLElement>('details[data-alg-section]')) {
        paintStats(node.querySelector<HTMLElement>('[data-alg-section-stats]'), bySection.get(node.dataset.algSection || ''));
    }
    for (const node of editor.querySelectorAll<HTMLElement>('details[data-alg-subsection]')) {
        paintStats(node.querySelector<HTMLElement>('[data-alg-subsection-stats]'), bySubsection.get(node.dataset.algSubsection || ''));
    }
}

function dirtyRows(editor: HTMLElement) {
    return rowsOf(editor).filter((row) => rowLevel(row) !== Number(row.dataset.algOrig));
}

function refreshDirty(editor: HTMLElement) {
    const dirty = dirtyRows(editor);
    for (const row of rowsOf(editor)) {
        row.classList.toggle('oi33-alg-item--dirty', rowLevel(row) !== Number(row.dataset.algOrig));
    }
    const label = editor.querySelector<HTMLElement>('[data-alg-dirty]');
    if (label) {
        label.hidden = dirty.length === 0;
        label.textContent = `${dirty.length} 处未保存改动`;
    }
    const submit = editor.querySelector<HTMLButtonElement>('[data-alg-submit]');
    if (submit) submit.disabled = dirty.length === 0;
    editor.dataset.algDirty = dirty.length ? '1' : '0';
}

// 「按评价筛选」+ 关键词搜索。评价筛选记在 editor 的 data 上，改动后重新应用，
// 因此刚改过的行会立刻切换到（或离开）对应的筛选项。
function applyFilter(editor: HTMLElement) {
    const needle = (editor.querySelector<HTMLInputElement>('input.oi33-alg-search')?.value || '').trim().toLowerCase();
    const rating = editor.dataset.algRating || 'all';
    const isVisible = (el: HTMLElement) => el.style.display !== 'none';
    for (const row of rowsOf(editor)) {
        const textOk = !needle || (row.dataset.algText || '').toLowerCase().includes(needle);
        const ratingOk = rating === 'all' || String(rowLevel(row)) === rating;
        row.style.display = textOk && ratingOk ? '' : 'none';
    }
    for (const node of editor.querySelectorAll<HTMLElement>('details[data-alg-subsection]')) {
        node.style.display = Array.from(node.querySelectorAll<HTMLElement>('.oi33-alg-item')).some(isVisible) ? '' : 'none';
    }
    for (const node of editor.querySelectorAll<HTMLElement>('details[data-alg-section]')) {
        node.style.display = Array.from(node.querySelectorAll<HTMLElement>('.oi33-alg-item')).some(isVisible) ? '' : 'none';
    }
    for (const node of editor.querySelectorAll<HTMLDetailsElement>('details[data-alg-group]')) {
        const any = Array.from(node.querySelectorAll<HTMLElement>('.oi33-alg-item')).some(isVisible);
        node.style.display = any ? '' : 'none';
        if (needle && any) node.open = true;
    }
}

function refreshPanel(editor: HTMLElement) {
    recompute(editor);
    refreshDirty(editor);
    applyFilter(editor);
}

function syncFilterButtons(editor: HTMLElement) {
    const rating = editor.dataset.algRating || 'all';
    for (const button of editor.querySelectorAll<HTMLElement>('.oi33-alg-filter')) {
        button.classList.toggle('oi33-alg-filter--on', (button.dataset.algFilter || 'all') === rating);
    }
}

function toggleAll(el: Element, open: boolean) {
    const editor = editorOf(el);
    if (!editor) return;
    for (const node of editor.querySelectorAll<HTMLDetailsElement>('.oi33-alg-tree details')) {
        node.open = open;
    }
}

addPage(() => {
    if ((document as any)._oi33AlgorithmBound) return;
    (document as any)._oi33AlgorithmBound = true;

    // Initial pass: server-rendered stats are already correct, but the submit
    // button starts disabled until something changes. Read-only editors render
    // the display tree instead, so they are skipped (no rows to recompute).
    for (const editor of document.querySelectorAll<HTMLElement>('.oi33-alg-editor')) {
        if (editor.dataset.algCanEdit !== '1') continue;
        syncFilterButtons(editor);
        refreshPanel(editor);
    }

    document.addEventListener('change', (ev) => {
        const radio = (ev.target as HTMLElement)?.closest?.('input.oi33-alg-radio') as HTMLInputElement | null;
        if (!radio) return;
        const editor = editorOf(radio);
        if (editor && editor.dataset.algCanEdit === '1') refreshPanel(editor);
    });

    document.addEventListener('click', (ev) => {
        const target = ev.target as HTMLElement;
        if (!target?.closest) return;
        const filter = target.closest('.oi33-alg-filter') as HTMLElement | null;
        if (filter) {
            ev.preventDefault();
            const editor = editorOf(filter);
            if (editor) {
                editor.dataset.algRating = filter.dataset.algFilter || 'all';
                syncFilterButtons(editor);
                applyFilter(editor);
            }
            return;
        }
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
        const editor = editorOf(search);
        if (editor) applyFilter(editor);
    });

    document.addEventListener('submit', (ev) => {
        const form = ev.target as HTMLFormElement;
        if (!form || form.id !== 'alg-form') return;
        const editor = editorOf(form) || document.querySelector<HTMLElement>('.oi33-alg-editor');
        if (!editor) return;
        if (dirtyRows(editor).length === 0) {
            ev.preventDefault();
            return;
        }
        // Students consume their one submit this month, so confirm first.
        if (editor.dataset.algQuota === '1'
            && !window.confirm('提交后本月将不能再修改自评，确定提交吗？')) {
            ev.preventDefault();
            return;
        }
        // 表单真的提交了：清掉未保存标记，否则浏览器会立刻弹
        // 「你所做的更改可能未保存」的 beforeunload 确认框。
        for (const row of rowsOf(editor)) row.classList.remove('oi33-alg-item--dirty');
        editor.dataset.algDirty = '0';
    });

    window.addEventListener('beforeunload', (ev) => {
        const dirty = Array.from(document.querySelectorAll<HTMLElement>('.oi33-alg-editor'))
            .some((editor) => editor.dataset.algDirty === '1');
        if (!dirty) return;
        ev.preventDefault();
        ev.returnValue = '';
    });
});
