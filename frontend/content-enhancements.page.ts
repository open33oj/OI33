import { addPage, NamedPage } from '@hydrooj/ui-default';
import './content-enhancements.css';

function emphasizeFileIoTag() {
    document.querySelectorAll<HTMLElement>('.problem__tag-item.icon-book').forEach((tag) => {
        const text = (tag.textContent || '').trim();
        if (/^(文件\s*IO|File\s*IO)\s*[:：]/i.test(text)) tag.classList.add('oi33-file-io-tag');
    });
}

function headingId(text: string, index: number) {
    const slug = text.normalize('NFKC').toLowerCase()
        .replace(/[^\w\u3400-\u9fff-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return `oi33-heading-${slug || index + 1}`;
}

function mountContentToc() {
    document.querySelectorAll<HTMLElement>('[data-content-toc]').forEach((root) => {
        if (root.dataset.tocMounted) return;
        root.dataset.tocMounted = '1';
        const source = root.querySelector<HTMLElement>('[data-content-toc-source]');
        const layout = root.querySelector<HTMLElement>('[data-content-toc-layout]');
        const controls = root.querySelector<HTMLElement>('[data-content-toc-controls]');
        const toggle = root.querySelector<HTMLInputElement>('[data-content-toc-toggle]');
        const aside = root.querySelector<HTMLElement>('[data-content-toc-aside]');
        const list = root.querySelector<HTMLElement>('[data-content-toc-list]');
        if (!source || !layout || !controls || !toggle || !aside || !list) return;

        const headings = Array.from(source.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
            .filter((heading) => !!heading.textContent?.trim());
        if (!headings.length) return;

        const usedIds = new Set<string>();
        document.querySelectorAll<HTMLElement>('[id]').forEach((element) => {
            if (!headings.includes(element)) usedIds.add(element.id);
        });
        const minimumLevel = Math.min(...headings.map((heading) => Number(heading.tagName.slice(1))));
        headings.forEach((heading, index) => {
            const text = heading.textContent!.trim();
            let id = heading.id || headingId(text, index);
            const base = id;
            let suffix = 2;
            while (usedIds.has(id)) id = `${base}-${suffix++}`;
            heading.id = id;
            usedIds.add(id);

            const item = document.createElement('li');
            const link = document.createElement('a');
            link.className = 'oi33-content-toc__link';
            link.href = `#${encodeURIComponent(id)}`;
            link.textContent = text;
            link.style.setProperty('--oi33-toc-depth', String(Number(heading.tagName.slice(1)) - minimumLevel));
            item.append(link);
            list.append(item);
        });

        const storageKey = 'oi33.contentToc.visible';
        let visible = true;
        try {
            const saved = window.localStorage.getItem(storageKey);
            if (saved !== null) visible = saved === '1';
        } catch { /* localStorage may be unavailable */ }

        const update = () => {
            layout.classList.toggle('is-toc-visible', toggle.checked);
            aside.hidden = !toggle.checked;
            try { window.localStorage.setItem(storageKey, toggle.checked ? '1' : '0'); } catch { /* ignore */ }
        };
        toggle.checked = visible;
        controls.hidden = false;
        toggle.addEventListener('change', update);
        update();
    });
}

function mountAiSummaryTag() {
    const parseGlobal = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v) || {};
    const user = parseGlobal((window as any).UserContext);
    const ui = parseGlobal((window as any).UiContext);
    if ((Number(user.realname_flag) || 0) < 2) return;
    const m = /\/p\/([\w-]+)(?:[/?#]|$)/.exec(window.location.pathname);
    if (!m) return;
    const menu = document.querySelector('.section--problem-sidebar ol.menu');
    if (!menu || menu.querySelector('.oi33-ai-summary-item')) return;
    const seperator = document.createElement('li');
    seperator.className = 'menu__seperator oi33-ai-summary-item';
    const li = document.createElement('li');
    li.className = 'menu__item oi33-ai-summary-item';
    const a = document.createElement('a');
    a.className = 'menu__link';
    a.href = `/oi33/ai/summary?domainId=${encodeURIComponent(ui.domainId || 'system')}&pid=${m[1]}`;
    const icon = document.createElement('span');
    icon.className = 'icon icon-book';
    a.append(icon, ' AI 精简题意');
    li.appendChild(a);
    menu.append(seperator, li);
}

addPage(new NamedPage(['problem_detail', 'contest_detail_problem', 'homework_detail_problem'], emphasizeFileIoTag));
addPage(new NamedPage('problem_detail', mountAiSummaryTag));
addPage(new NamedPage(['oi33_wiki_main', 'oi33_wiki_show', 'oi33_paste_show'], mountContentToc));
