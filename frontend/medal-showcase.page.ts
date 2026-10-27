import { AutoloadPage, NamedPage, addPage } from '@hydrooj/ui-default';
import {
    MEDAL_SHOWCASE_CELL, MEDAL_SHOWCASE_HEIGHT, MEDAL_SHOWCASE_MAX_PIECES,
    MEDAL_SHOWCASE_MAX_SCALE, MEDAL_SHOWCASE_SNAP, MEDAL_SHOWCASE_WIDTH, medalShowcaseScale,
} from '../shared/medal-showcase';
import './medal-showcase.css';

// 奖章展示墙：一块 320×128 的像素画布（10×4 个 32×32 奖章），奖章按 { id, x, y } 摆放。
//
// 个人页与编辑页都由服务端渲染好每个奖章的绝对位置，这里的 AutoloadPage 只
// 负责算缩放倍数（--wall-k）：编辑页用整数倍便于精确拖动，个人页只看展示，
// 按卡片宽度等比铺满；编辑页的 NamedPage 再负责拖动、点选与保存。
//
// 编辑器交互：
// - 从右侧托盘拖到画布：放一份新的；默认吸附半格（16 像素），按住 Alt 1 像素自由摆放。
// - 拖动画布上的奖章：移动；拖回托盘或按 Delete 取下。
// - 点托盘奖章再点画布：不用拖也能放；方向键微调选中的奖章。

interface WallPiece {
    id: string;
    x: number;
    y: number;
}

interface WallDrag {
    kind: 'move' | 'new';
    pointerId: number;
    id: string;
    index: number;
    offsetX: number;
    offsetY: number;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
    active: boolean;
    element: HTMLElement | null;
    x: number;
    y: number;
    overTray: boolean;
}

// --- 整数倍缩放（个人页与编辑页共用） -----------------------------------

function fitMedalWalls() {
    for (const wall of Array.from(document.querySelectorAll<HTMLElement>('[data-oi33-medal-wall]'))) {
        const parent = wall.parentElement;
        if (!parent) continue;
        const style = getComputedStyle(parent);
        const available = parent.clientWidth
            - (Number.parseFloat(style.paddingLeft) || 0)
            - (Number.parseFloat(style.paddingRight) || 0);
        const min = Number(wall.dataset.wallMinScale) || 1;
        const max = Number(wall.dataset.wallMaxScale) || MEDAL_SHOWCASE_MAX_SCALE;
        // 编辑页要精确拖动，保持整数倍；个人页只在展示，按容器宽度等比铺满，
        // 这样窄卡片里也不会在右侧留下一条空白（像素图仍走 nearest-neighbour）。
        const scale = wall.dataset.wallFill === '1'
            ? Math.max(min, Math.min(max, available / MEDAL_SHOWCASE_WIDTH))
            : medalShowcaseScale(available - 2, min, max);
        wall.style.setProperty('--wall-k', String(scale));
    }
}

let fitTimer: ReturnType<typeof setTimeout> | null = null;

addPage(new AutoloadPage('oi33MedalWallFit', () => {
    fitMedalWalls();
    window.addEventListener('resize', () => {
        if (fitTimer) clearTimeout(fitTimer);
        fitTimer = setTimeout(fitMedalWalls, 150);
    });
}));

// --- 编辑页 --------------------------------------------------------------

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const snapValue = (value: number, step: number) => (step > 1 ? Math.round(value / step) * step : Math.round(value));

function mountShowcaseWall() {
    const form = document.getElementById('oi33-wall-form') as HTMLFormElement | null;
    const wall = document.getElementById('oi33-wall');
    const canvas = document.getElementById('oi33-wall-canvas');
    const tray = document.getElementById('oi33-wall-tray');
    const slotsInput = document.getElementById('oi33-wall-slots') as HTMLInputElement | null;
    if (!form || !wall || !canvas || !tray || !slotsInput) return;

    const wallWidth = Number(canvas.dataset.wallWidth) || MEDAL_SHOWCASE_WIDTH;
    const wallHeight = Number(canvas.dataset.wallHeight) || MEDAL_SHOWCASE_HEIGHT;
    const snapStep = Math.max(1, Number(canvas.dataset.snap) || MEDAL_SHOWCASE_SNAP);
    const maxPieces = Math.max(1, Number(canvas.dataset.maxPieces) || MEDAL_SHOWCASE_MAX_PIECES);
    // 所有奖章在墙上都是同一个 32×32 的大小（画布 10×4 格）。
    const cell = MEDAL_SHOWCASE_CELL;

    const countEl = document.getElementById('oi33-wall-count');
    const selectedEl = document.getElementById('oi33-wall-selected');
    const removeEl = document.getElementById('oi33-wall-remove') as HTMLButtonElement | null;
    const clearEl = document.getElementById('oi33-wall-clear');
    const statusEl = document.getElementById('oi33-wall-status');
    const dirtyEl = document.getElementById('oi33-wall-dirty');
    const trayEmptyEl = document.getElementById('oi33-wall-tray-empty');
    const filterEl = document.getElementById('oi33-wall-filter') as HTMLInputElement | null;

    const trayItems = new Map<string, HTMLElement>();
    const limits = new Map<string, number>();
    const names = new Map<string, string>();
    for (const item of Array.from(tray.querySelectorAll<HTMLElement>('.oi33-wall__medal'))) {
        const id = item.dataset.medalId || '';
        if (!id) continue;
        trayItems.set(id, item);
        limits.set(id, Math.max(1, Number(item.dataset.limit) || 1));
        names.set(id, item.dataset.name || id);
    }

    const pieces: WallPiece[] = Array.from(canvas.querySelectorAll<HTMLElement>('.oi33-wall__piece')).map((el) => ({
        id: el.dataset.medalId || '',
        x: Number(el.dataset.x) || 0,
        y: Number(el.dataset.y) || 0,
    })).filter((piece) => !!piece.id);

    const nameOf = (id: string) => names.get(id) || id;
    const spriteOf = (id: string) => trayItems.get(id)?.querySelector('img')?.getAttribute('src') || '';

    let selected = -1;
    let armed: string | null = null;
    let query = '';
    let initial = '';
    let statusTimer: ReturnType<typeof setTimeout> | null = null;
    let suppressClickUntil = 0;
    let drag: WallDrag | null = null;

    function say(text: string) {
        if (!statusEl) return;
        statusEl.textContent = text;
        if (statusTimer) clearTimeout(statusTimer);
        statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 2600);
    }

    // ---- 渲染 ----

    function stylePiece(element: HTMLElement, piece: WallPiece, size: number) {
        element.style.left = `calc(var(--wall-k) * ${piece.x}px)`;
        element.style.top = `calc(var(--wall-k) * ${piece.y}px)`;
        element.style.width = `calc(var(--wall-k) * ${size}px)`;
        element.style.height = `calc(var(--wall-k) * ${size}px)`;
    }

    function buildPiece(piece: WallPiece, index: number, preview = false) {
        const element = document.createElement('div');
        element.className = `oi33-wall__piece${preview ? ' is-preview' : ''}`;
        element.dataset.index = String(index);
        element.dataset.medalId = piece.id;
        element.dataset.x = String(piece.x);
        element.dataset.y = String(piece.y);
        element.title = nameOf(piece.id);
        stylePiece(element, piece, cell);
        const image = document.createElement('img');
        image.src = spriteOf(piece.id);
        image.alt = nameOf(piece.id);
        image.draggable = false;
        element.append(image);
        return element;
    }

    function countById() {
        const counts = new Map<string, number>();
        for (const piece of pieces) counts.set(piece.id, (counts.get(piece.id) || 0) + 1);
        return counts;
    }

    function updateTray() {
        const counts = countById();
        let visible = 0;
        trayItems.forEach((item, id) => {
            const limit = limits.get(id) || 1;
            const used = counts.get(id) || 0;
            const matched = !query || (item.dataset.name || '').toLowerCase().includes(query);
            const hide = used >= limit || !matched;
            item.hidden = hide;
            item.classList.toggle('is-armed', armed === id);
            if (!hide) visible++;
            const cap = item.querySelector('.oi33-wall__medal-cap');
            if (cap) cap.textContent = used > 0 ? `还可放 ${limit - used} 枚` : `可放 ${limit} 枚`;
        });
        if (trayEmptyEl) {
            trayEmptyEl.hidden = visible > 0;
            if (!visible) {
                trayEmptyEl.textContent = query
                    ? '没有匹配的奖章。'
                    : '所有奖章都已经在展示墙上了。';
            }
        }
    }

    function updateToolbar() {
        if (countEl) countEl.textContent = String(pieces.length);
        const piece = selected >= 0 ? pieces[selected] : null;
        if (selectedEl) {
            selectedEl.textContent = piece
                ? `${nameOf(piece.id)} · x ${piece.x} · y ${piece.y}`
                : (armed ? `点击画布放置「${nameOf(armed)}」` : '未选中');
        }
        if (removeEl) removeEl.disabled = !piece;
    }

    function trimmed() {
        return pieces.map((piece) => ({ id: piece.id, x: piece.x, y: piece.y }));
    }

    function updateDirty() {
        if (!dirtyEl) return;
        dirtyEl.hidden = JSON.stringify(trimmed()) === initial;
    }

    function render() {
        for (const element of Array.from(canvas.querySelectorAll<HTMLElement>('.oi33-wall__piece'))) {
            element.remove();
        }
        pieces.forEach((piece, index) => {
            const element = buildPiece(piece, index);
            if (index === selected) element.classList.add('is-selected');
            canvas.append(element);
        });
        if (selected >= pieces.length) selected = -1;
        updateTray();
        updateToolbar();
        slotsInput.value = JSON.stringify(trimmed());
        updateDirty();
    }

    // ---- 坐标与放置 ----

    function toLogical(clientX: number, clientY: number) {
        const rect = canvas.getBoundingClientRect();
        const scale = rect.width > 0 ? rect.width / wallWidth : 1;
        return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
    }

    function isOverCanvas(clientX: number, clientY: number) {
        const rect = canvas.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right
            && clientY >= rect.top && clientY <= rect.bottom;
    }

    function isOverTray(clientX: number, clientY: number) {
        const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        return !!element?.closest('#oi33-wall-tray');
    }

    function moveTo(state: WallDrag, clientX: number, clientY: number, fine: boolean) {
        const point = toLogical(clientX, clientY);
        const step = fine ? 1 : snapStep;
        state.x = clamp(snapValue(point.x - state.offsetX, step), 0, wallWidth - cell);
        state.y = clamp(snapValue(point.y - state.offsetY, step), 0, wallHeight - cell);
        if (!state.element) return;
        state.element.style.left = `calc(var(--wall-k) * ${state.x}px)`;
        state.element.style.top = `calc(var(--wall-k) * ${state.y}px)`;
        if (state.kind === 'move' && pieces[state.index]) {
            pieces[state.index].x = state.x;
            pieces[state.index].y = state.y;
            updateToolbar();
            updateDirty();
        }
    }

    // 同一格已经有一枚奖章时，放置会替换它（那枚回到托盘），移动则互换位置。
    function pieceIndexAt(x: number, y: number, except = -1) {
        return pieces.findIndex((piece, index) => index !== except && piece.x === x && piece.y === y);
    }

    function canPlaceAt(id: string, x: number, y: number) {
        const occupant = pieceIndexAt(x, y);
        const limit = limits.get(id) || 1;
        const used = countById().get(id) || 0;
        if (used >= limit && !(occupant >= 0 && pieces[occupant].id === id)) {
            say(`「${nameOf(id)}」最多只能放 ${limit} 枚。`);
            return false;
        }
        if (pieces.length >= maxPieces && occupant < 0) {
            say(`展示墙最多摆放 ${maxPieces} 枚奖章。`);
            return false;
        }
        return true;
    }

    function addPiece(id: string, x: number, y: number) {
        const occupant = pieceIndexAt(x, y);
        if (occupant >= 0) {
            pieces[occupant] = { id, x, y };
            selected = occupant;
        } else {
            pieces.push({ id, x, y });
            selected = pieces.length - 1;
        }
    }

    function placeAt(id: string, clientX: number, clientY: number, fine: boolean) {
        if (!isOverCanvas(clientX, clientY)) return;
        const point = toLogical(clientX, clientY);
        const step = fine ? 1 : snapStep;
        const x = clamp(snapValue(point.x - cell / 2, step), 0, wallWidth - cell);
        const y = clamp(snapValue(point.y - cell / 2, step), 0, wallHeight - cell);
        if (!canPlaceAt(id, x, y)) return;
        addPiece(id, x, y);
        armed = null;
        render();
    }

    function removeSelected() {
        if (selected < 0 || !pieces[selected]) return;
        pieces.splice(selected, 1);
        selected = -1;
        render();
    }

    // ---- 指针拖动 ----

    function cleanupDrag() {
        drag = null;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
    }

    function activateDrag() {
        if (!drag) return;
        drag.active = true;
        suppressClickUntil = Date.now() + 400;
        if (drag.kind === 'new') {
            drag.element = buildPiece({ id: drag.id, x: drag.x, y: drag.y }, -1, true);
            canvas.append(drag.element);
        } else {
            drag.element = canvas.querySelector<HTMLElement>(`.oi33-wall__piece[data-index="${drag.index}"]`);
            drag.element?.classList.add('is-dragging');
        }
    }

    function onPointerMove(event: PointerEvent) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!drag.active) {
            if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
            activateDrag();
        }
        event.preventDefault();
        moveTo(drag, event.clientX, event.clientY, event.altKey);
        const overTray = isOverTray(event.clientX, event.clientY);
        if (overTray !== drag.overTray) {
            drag.overTray = overTray;
            drag.element?.classList.toggle('is-remove', overTray);
        }
    }

    function onPointerUp(event: PointerEvent) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const state = drag;
        if (!state.active) {
            cleanupDrag();
            return;
        }
        suppressClickUntil = Date.now() + 400;
        if (state.kind === 'new') {
            if (isOverCanvas(event.clientX, event.clientY) && canPlaceAt(state.id, state.x, state.y)) {
                addPiece(state.id, state.x, state.y);
                armed = null;
            }
            state.element?.remove();
        } else if (state.overTray) {
            pieces.splice(state.index, 1);
            selected = -1;
        } else {
            // 落到另一枚奖章的同一坐标上：两枚互换位置。
            const occupant = pieceIndexAt(state.x, state.y, state.index);
            if (occupant >= 0) {
                pieces[occupant].x = state.originX;
                pieces[occupant].y = state.originY;
            }
        }
        cleanupDrag();
        render();
    }

    function onPointerCancel() {
        if (drag?.active) {
            // 拖动被浏览器中断：把还没落地的拖影清掉，已移动的奖章保持当前位置。
            drag.element?.remove();
            drag.element?.classList.remove('is-dragging');
        }
        cleanupDrag();
        render();
    }

    // 窗口失焦时 pointerup 可能收不到，清掉未完成的拖动，避免整面墙失去响应。
    window.addEventListener('blur', () => {
        if (!drag) return;
        drag.element?.remove();
        drag.element?.classList.remove('is-dragging');
        cleanupDrag();
        render();
    });

    wall.addEventListener('pointerdown', (event) => {
        if (drag) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const target = event.target as HTMLElement;
        const pieceElement = target.closest('.oi33-wall__piece') as HTMLElement | null;
        const medalElement = target.closest('.oi33-wall__medal') as HTMLElement | null;
        if (pieceElement) {
            const index = Number(pieceElement.dataset.index);
            const piece = pieces[index];
            if (!piece) return;
            const point = toLogical(event.clientX, event.clientY);
            drag = {
                kind: 'move',
                pointerId: event.pointerId,
                id: piece.id,
                index,
                offsetX: point.x - piece.x,
                offsetY: point.y - piece.y,
                originX: piece.x,
                originY: piece.y,
                startX: event.clientX,
                startY: event.clientY,
                active: false,
                element: null,
                x: piece.x,
                y: piece.y,
                overTray: false,
            };
        } else if (medalElement && !medalElement.hidden) {
            const id = medalElement.dataset.medalId || '';
            if (!id) return;
            drag = {
                kind: 'new',
                pointerId: event.pointerId,
                id,
                index: -1,
                offsetX: cell / 2,
                offsetY: cell / 2,
                originX: 0,
                originY: 0,
                startX: event.clientX,
                startY: event.clientY,
                active: false,
                element: null,
                x: 0,
                y: 0,
                overTray: false,
            };
        } else {
            return;
        }
        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerCancel);
    });

    // ---- 点击 / 键盘 ----

    wall.addEventListener('click', (event) => {
        if (Date.now() < suppressClickUntil) {
            event.preventDefault();
            return;
        }
        const target = event.target as HTMLElement;
        const pieceElement = target.closest('.oi33-wall__piece') as HTMLElement | null;
        if (pieceElement) {
            selected = Number(pieceElement.dataset.index);
            armed = null;
            render();
            return;
        }
        const medalElement = target.closest('.oi33-wall__medal') as HTMLElement | null;
        if (medalElement && !medalElement.hidden) {
            const id = medalElement.dataset.medalId || '';
            if (!id) return;
            armed = armed === id ? null : id;
            if (armed) say(`点击画布放置「${nameOf(id)}」`);
            render();
            return;
        }
        if (target.closest('#oi33-wall-canvas')) {
            if (armed) {
                placeAt(armed, event.clientX, event.clientY, event.altKey);
                return;
            }
            selected = -1;
            render();
        }
    });

    function nudge(dx: number, dy: number, fine: boolean) {
        const piece = selected >= 0 ? pieces[selected] : null;
        if (!piece) return;
        const step = fine ? 1 : snapStep;
        piece.x = clamp(piece.x + dx * step, 0, wallWidth - cell);
        piece.y = clamp(piece.y + dy * step, 0, wallHeight - cell);
        render();
    }

    canvas.addEventListener('keydown', (event) => {
        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            removeSelected();
            return;
        }
        if (event.key === 'Escape') {
            armed = null;
            selected = -1;
            render();
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            if (!armed) return;
            event.preventDefault();
            const rect = canvas.getBoundingClientRect();
            placeAt(armed, rect.left + rect.width / 2, rect.top + rect.height / 2, false);
            return;
        }
        const deltas: Record<string, [number, number]> = {
            ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
        };
        const delta = deltas[event.key];
        if (!delta || selected < 0) return;
        event.preventDefault();
        nudge(delta[0], delta[1], event.altKey);
    });

    if (filterEl) {
        filterEl.addEventListener('input', () => {
            query = filterEl.value.trim().toLowerCase();
            updateTray();
        });
    }

    if (removeEl) {
        removeEl.addEventListener('click', () => {
            removeSelected();
            canvas.focus();
        });
    }

    if (clearEl) {
        clearEl.addEventListener('click', () => {
            if (!pieces.length) return;
            if (!window.confirm('清空展示墙上的全部奖章？')) return;
            pieces.length = 0;
            selected = -1;
            armed = null;
            render();
        });
    }

    // ---- 保存 / 离开提醒 ----

    form.addEventListener('submit', () => {
        initial = JSON.stringify(trimmed());
        slotsInput.value = initial;
        if (dirtyEl) dirtyEl.hidden = true;
    });

    window.addEventListener('beforeunload', (event) => {
        if (JSON.stringify(trimmed()) === initial) return;
        event.preventDefault();
        event.returnValue = '';
    });

    // 点画布让它接住方向键（点中的奖章会被下面的 click 处理选中）。
    canvas.addEventListener('pointerdown', () => canvas.focus());

    initial = JSON.stringify(trimmed());
    render();
}

addPage(new NamedPage('oi33_medal_showcase', () => {
    mountShowcaseWall();
}));
