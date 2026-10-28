import { NamedPage, addPage } from '@hydrooj/ui-default';

// 奖章目录的四类标签页：一般 / 可售卖 / 奖项认证 / OJ。
// 用 NamedPage 而不是模板内联脚本，pjax 跳转进目录时也能初始化；
// 没有脚本时模板里的 <noscript> 会退回「四块全部展开」。
function setupCatalogueTabs() {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-catalogue-tab]'));
    const panels = Array.from(document.querySelectorAll<HTMLElement>('[data-catalogue-panel]'));
    if (!tabs.length || !panels.length) return;

    function activate(name: string) {
        for (const tab of tabs) {
            const on = tab.getAttribute('data-catalogue-tab') === name;
            tab.classList.toggle('is-active', on);
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        for (const panel of panels) {
            panel.classList.toggle('is-active', panel.getAttribute('data-catalogue-panel') === name);
        }
    }

    for (const tab of tabs) {
        tab.addEventListener('click', () => {
            const name = tab.getAttribute('data-catalogue-tab') || '';
            if (!name) return;
            activate(name);
            if (window.history && window.history.replaceState) {
                window.history.replaceState(null, '', `#${name}`);
            }
        });
    }

    const initial = (window.location.hash || '').replace(/^#/, '');
    if (!initial) return;
    if (panels.some((panel) => panel.getAttribute('data-catalogue-panel') === initial)) {
        activate(initial);
    }
}

// 管理页的「奖章一览」也使用同一套分类标签页。
addPage(new NamedPage('oi33_medal_catalogue', setupCatalogueTabs));
addPage(new NamedPage('oi33_medal_manage', setupCatalogueTabs));
