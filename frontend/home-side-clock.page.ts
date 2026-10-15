import { AutoloadPage, addPage } from '@hydrooj/ui-default';

// The homepage side card renders its date/time line server-side, which is the
// server's timezone and freezes at page load. Replace it with the visitor's own
// local time and keep it ticking, so the line really is "current local
// date + time". The interval is created once and simply re-queries the DOM each
// second, which keeps it correct across pjax navigations.

const pad = (value: number) => String(value).padStart(2, '0');

function formatLocal(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function tick() {
    const el = document.querySelector<HTMLElement>('[data-oi33-now]');
    if (!el) return;
    const now = new Date();
    const text = formatLocal(now);
    if (el.textContent !== text) el.textContent = text;
    el.title = now.toString();
}

let timer: ReturnType<typeof setInterval> | null = null;

addPage(new AutoloadPage('oi33HomeSideClock', () => {
    tick();
    if (timer) return;
    timer = setInterval(tick, 1000);
}));
