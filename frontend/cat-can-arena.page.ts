import {
    addPage, NamedPage, Notification, request, Socket,
} from '@hydrooj/ui-default';
import './cat-can-arena.css';
import { CAT_FRAMES, CAT_PIXEL_COLORS } from './cat-sprites';

const MAP_WIDTH = 640;
const MAP_HEIGHT = 480;
const DEFAULT_GRID_SCALE = 52;
const MIN_VIEW_SCALE = 0.25;
const MAX_VIEW_SCALE = 110;
const MIN_GRID_SPACING = 4;
const MIN_CAT_SIZE = 8;
const MIN_CAT_RENDER_SCALE = 6;
const PLAYER_BUCKET_SIZE = 16;
const CAT_IDLE_FRAME_MS = 3200;
const LABEL_BUCKET_WIDTH = 80;
const LABEL_BUCKET_HEIGHT = 24;

interface MapPlayer {
    uid: number;
    uname: string;
    x: number;
    y: number;
    cans: number;
    food: number;
    availableAt: number;
    freeColorAvailable: boolean;
}

interface MapState {
    width: number;
    height: number;
    players: MapPlayer[];
    cells: [number, number, number][];
    me: MapPlayer | null;
    canJoin: boolean;
    serverTime: number;
}

function paletteColor(code: number) {
    const standard = [
        '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
        '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
    ];
    if (code < 16) return standard[code];
    if (code < 232) {
        const value = code - 16;
        const levels = [0, 95, 135, 175, 215, 255];
        return `rgb(${levels[Math.floor(value / 36)]}, ${levels[Math.floor(value / 6) % 6]}, ${levels[value % 6]})`;
    }
    const gray = 8 + (code - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
}

function mountPalettes() {
    document.querySelectorAll<HTMLElement>('[data-palette]').forEach((palette) => {
        if (palette.dataset.mounted) return;
        palette.dataset.mounted = '1';
        const scope = palette.closest('dialog, form') || document;
        const input = scope.querySelector<HTMLInputElement>('[data-color-input]');
        const preview = scope.querySelector<HTMLElement>('[data-color-preview]');
        const update = (value: number) => {
            const color = Math.max(0, Math.min(255, Math.floor(value || 0)));
            if (input) input.value = String(color);
            if (preview) preview.style.background = paletteColor(color);
            palette.querySelectorAll('button').forEach((button, index) => button.classList.toggle('is-selected', index === color));
        };
        for (let code = 0; code < 256; code++) {
            const swatch = document.createElement('button');
            swatch.type = 'button';
            swatch.textContent = String(code);
            swatch.title = `颜色码 ${code}`;
            swatch.setAttribute('aria-label', `选择颜色码 ${code}`);
            swatch.style.background = paletteColor(code);
            swatch.addEventListener('click', () => update(code));
            palette.append(swatch);
        }
        input?.addEventListener('input', () => update(Number(input.value)));
        update(Number(input?.value || 34));
    });
}

function mountAdminPaintForm() {
    const form = document.querySelector<HTMLFormElement>('[data-admin-paint-form]');
    const fields = form?.querySelector<HTMLElement>('[data-rect-fields]');
    if (!form || !fields) return;
    const inputs = fields.querySelectorAll<HTMLInputElement>('input');
    const rowStartInput = form.querySelector<HTMLInputElement>('[name="rowStart"]')!;
    const columnStartInput = form.querySelector<HTMLInputElement>('[name="columnStart"]')!;
    const rowEndInput = form.querySelector<HTMLInputElement>('[name="rowEnd"]')!;
    const columnEndInput = form.querySelector<HTMLInputElement>('[name="columnEnd"]')!;
    const canvas = form.querySelector<HTMLCanvasElement>('[data-admin-paint-canvas]');
    const selectionText = form.querySelector<HTMLElement>('[data-admin-selection]');
    fields.hidden = false;
    inputs.forEach((input) => {
        input.disabled = false;
        input.required = true;
    });
    if (selectionText) selectionText.textContent = '点击或拖动选择矩形';
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const layer = document.createElement('canvas');
    layer.width = MAP_WIDTH;
    layer.height = MAP_HEIGHT;
    const layerContext = layer.getContext('2d')!;
    layerContext.fillStyle = '#fff';
    layerContext.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let initialized = false;
    let selection: { rowStart: number; columnStart: number; rowEnd: number; columnEnd: number } | null = null;
    let drag: {
        startX: number; startY: number; startRow: number; startColumn: number;
        offsetX: number; offsetY: number; pan: boolean;
    } | null = null;

    const size = () => ({ width: canvas.clientWidth, height: canvas.clientHeight });
    const clamp = () => {
        const view = size();
        const margin = 70;
        offsetX = Math.min(view.width - margin, Math.max(margin - MAP_WIDTH * scale, offsetX));
        offsetY = Math.min(view.height - margin, Math.max(margin - MAP_HEIGHT * scale, offsetY));
    };
    const fit = () => {
        const view = size();
        scale = Math.min(view.width / MAP_WIDTH, view.height / MAP_HEIGHT);
        offsetX = (view.width - MAP_WIDTH * scale) / 2;
        offsetY = (view.height - MAP_HEIGHT * scale) / 2;
        initialized = true;
    };
    const draw = () => {
        const view = size();
        context.clearRect(0, 0, view.width, view.height);
        context.fillStyle = '#e9ece9';
        context.fillRect(0, 0, view.width, view.height);
        context.imageSmoothingEnabled = false;
        context.drawImage(layer, offsetX, offsetY, MAP_WIDTH * scale, MAP_HEIGHT * scale);
        context.strokeStyle = '#111';
        context.strokeRect(offsetX + .5, offsetY + .5, MAP_WIDTH * scale - 1, MAP_HEIGHT * scale - 1);
        if (selection) {
            context.fillStyle = 'rgba(255,62,62,.18)';
            context.strokeStyle = '#ff2f2f';
            context.lineWidth = 2;
            const x = offsetX + selection.columnStart * scale;
            const y = offsetY + selection.rowStart * scale;
            const width = (selection.columnEnd - selection.columnStart + 1) * scale;
            const height = (selection.rowEnd - selection.rowStart + 1) * scale;
            context.fillRect(x, y, width, height);
            context.strokeRect(x, y, width, height);
        }
    };
    const resize = () => {
        const ratio = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.max(1, Math.round(rect.width * ratio));
        canvas.height = Math.max(1, Math.round(rect.height * ratio));
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        if (!initialized) fit();
        else clamp();
        draw();
    };
    const toCell = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        return {
            column: Math.max(0, Math.min(MAP_WIDTH - 1, Math.floor((clientX - rect.left - offsetX) / scale))),
            row: Math.max(0, Math.min(MAP_HEIGHT - 1, Math.floor((clientY - rect.top - offsetY) / scale))),
        };
    };
    const commitSelection = (startRow: number, startColumn: number, endRow: number, endColumn: number) => {
        selection = {
            rowStart: Math.min(startRow, endRow),
            columnStart: Math.min(startColumn, endColumn),
            rowEnd: Math.max(startRow, endRow),
            columnEnd: Math.max(startColumn, endColumn),
        };
        rowStartInput.value = String(selection.rowStart);
        columnStartInput.value = String(selection.columnStart);
        rowEndInput.value = String(selection.rowEnd);
        columnEndInput.value = String(selection.columnEnd);
        if (selectionText) selectionText.textContent = selection.rowStart === selection.rowEnd && selection.columnStart === selection.columnEnd
            ? `已选择 1×1 矩形 (${selection.rowStart}, ${selection.columnStart})`
            : `已选择矩形 (${selection.rowStart}, ${selection.columnStart}) ～ (${selection.rowEnd}, ${selection.columnEnd})`;
        draw();
    };
    canvas.addEventListener('pointerdown', (event) => {
        const cell = toCell(event.clientX, event.clientY);
        drag = {
            startX: event.clientX,
            startY: event.clientY,
            startRow: cell.row,
            startColumn: cell.column,
            offsetX,
            offsetY,
            pan: event.altKey,
        };
        canvas.setPointerCapture(event.pointerId);
        if (!drag.pan) commitSelection(cell.row, cell.column, cell.row, cell.column);
    });
    canvas.addEventListener('pointermove', (event) => {
        if (!drag) return;
        if (drag.pan) {
            offsetX = drag.offsetX + event.clientX - drag.startX;
            offsetY = drag.offsetY + event.clientY - drag.startY;
            clamp();
            draw();
            return;
        }
        const cell = toCell(event.clientX, event.clientY);
        commitSelection(drag.startRow, drag.startColumn, cell.row, cell.column);
    });
    const endDrag = () => { drag = null; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        const column = (pointerX - offsetX) / scale;
        const row = (pointerY - offsetY) / scale;
        scale = Math.max(.25, Math.min(48, scale * Math.exp(-event.deltaY * .0015)));
        offsetX = pointerX - column * scale;
        offsetY = pointerY - row * scale;
        clamp();
        draw();
    }, { passive: false });
    form.querySelector<HTMLButtonElement>('[data-admin-fit]')?.addEventListener('click', () => {
        fit();
        draw();
    });
    window.addEventListener('resize', resize);
    request.get(form.dataset.stateUrl || '/oi33/arena/state').then((state: MapState) => {
        state.cells.forEach(([x, y, color]) => {
            layerContext.fillStyle = paletteColor(color);
            layerContext.fillRect(x, y, 1, 1);
        });
        draw();
    }).catch((e) => {
        if (selectionText) selectionText.textContent = `地图加载失败：${e.message || e}`;
    });
    window.requestAnimationFrame(resize);
}

function mountMap() {
    mountPalettes();
    mountAdminPaintForm();
    const viewport = document.querySelector<HTMLElement>('.oi33-map-viewport');
    const canvas = viewport?.querySelector<HTMLCanvasElement>('.oi33-map-canvas');
    if (!viewport || !canvas || viewport.dataset.mounted) return;
    viewport.dataset.mounted = '1';

    const context = canvas.getContext('2d');
    if (!context) return;
    const userId = Number(viewport.dataset.userId) || 0;
    const focusUserId = Number(new URLSearchParams(window.location.search).get('focusUid')) || 0;
    const stateUrl = viewport.dataset.stateUrl || '/oi33/arena/state';
    const joinUrl = viewport.dataset.joinUrl || '/oi33/arena/join';
    const moveUrl = viewport.dataset.moveUrl || '/oi33/arena/move';
    const colorUrl = viewport.dataset.colorUrl || '/oi33/arena/color';
    const connectionUrl = viewport.dataset.connUrl || '/oi33/arena/conn';
    const loading = viewport.querySelector<HTMLElement>('.oi33-map-loading');
    const coordinate = document.querySelector<HTMLElement>('[data-map-coordinate]');
    const live = document.querySelector<HTMLElement>('[data-map-live]');
    const catCount = document.querySelector<HTMLElement>('[data-map-cat-count]');
    const meStatus = document.querySelector<HTMLElement>('[data-map-me-status]');
    const fullscreenRoot = viewport.closest<HTMLElement>('.oi33-map-body');
    const fullscreenButton = document.querySelector<HTMLButtonElement>('[data-map-fullscreen]');
    const cellDialog = document.querySelector<HTMLDialogElement>('[data-map-cell-dialog]');
    const actionDialog = document.querySelector<HTMLDialogElement>('[data-map-action-dialog]');
    const colorDialog = document.querySelector<HTMLDialogElement>('[data-map-color-dialog]');

    let state: MapState = { width: MAP_WIDTH, height: MAP_HEIGHT, players: [], cells: [], me: null, canJoin: false, serverTime: Date.now() };
    const players = new Map<number, MapPlayer>();
    const playerBuckets = new Map<string, Set<number>>();
    const playersByCell = new Map<string, Set<number>>();
    const labelMetrics = new Map<number, { text: string; width: number }>();
    const cellColors = new Int16Array(MAP_WIDTH * MAP_HEIGHT);
    cellColors.fill(-1);
    const overviewLayer = document.createElement('canvas');
    overviewLayer.width = MAP_WIDTH;
    overviewLayer.height = MAP_HEIGHT;
    const overviewContext = overviewLayer.getContext('2d')!;
    overviewContext.fillStyle = '#ffffff';
    overviewContext.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    const animations = new Map<number, { fromX: number; fromY: number; toX: number; toY: number; start: number; teleport: boolean }>();
    let showGrid = false;
    let showCats = true;
    let showNames = true;
    let viewScale = DEFAULT_GRID_SCALE;
    let viewCenterX = MAP_WIDTH / 2;
    let viewCenterY = MAP_HEIGHT / 2;
    let drag: {
        x: number; y: number; centerX: number; centerY: number; moved: boolean;
    } | null = null;
    const activePointers = new Map<number, { x: number; y: number }>();
    let pinch: { distance: number; scale: number; mapX: number; mapY: number } | null = null;
    let gestureMoved = false;
    const heldKeys = new Set<string>();
    let keyboardVelocityX = 0;
    let keyboardVelocityY = 0;
    let lastRenderAt = performance.now();
    let selectedTarget: { x: number; y: number } | null = null;
    let selectedColorCell: { x: number; y: number } | null = null;
    let clockOffset = 0;
    let renderDirty = true;
    let lastIdleFrame = -1;
    let lastStatusSecond = -1;
    let devicePixelRatio = window.devicePixelRatio || 1;

    const now = () => Date.now() + clockOffset;
    const invalidate = () => { renderDirty = true; };
    const cellKey = (x: number, y: number) => `${x}:${y}`;
    const bucketKey = (x: number, y: number) => `${Math.floor(x / PLAYER_BUCKET_SIZE)}:${Math.floor(y / PLAYER_BUCKET_SIZE)}`;
    const removePlayerFromIndex = (player: MapPlayer) => {
        const key = bucketKey(player.x, player.y);
        const bucket = playerBuckets.get(key);
        bucket?.delete(player.uid);
        if (!bucket?.size) playerBuckets.delete(key);
        const cell = playersByCell.get(cellKey(player.x, player.y));
        cell?.delete(player.uid);
        if (!cell?.size) playersByCell.delete(cellKey(player.x, player.y));
    };
    const storePlayer = (player: MapPlayer) => {
        const previous = players.get(player.uid);
        if (previous) removePlayerFromIndex(previous);
        players.set(player.uid, player);
        const key = bucketKey(player.x, player.y);
        const bucket = playerBuckets.get(key) || new Set<number>();
        bucket.add(player.uid);
        playerBuckets.set(key, bucket);
        const cell = playersByCell.get(cellKey(player.x, player.y)) || new Set<number>();
        cell.add(player.uid);
        playersByCell.set(cellKey(player.x, player.y), cell);
        invalidate();
    };
    const playersAtCell = (x: number, y: number) => Array.from(playersByCell.get(cellKey(x, y)) || [])
        .map((uid) => players.get(uid))
        .filter((player): player is MapPlayer => !!player)
        .sort((a, b) => b.cans - a.cans || a.uid - b.uid);
    const deletePlayer = (uid: number) => {
        const player = players.get(uid);
        if (player) removePlayerFromIndex(player);
        players.delete(uid);
        labelMetrics.delete(uid);
        invalidate();
    };
    const playersInView = (firstX: number, firstY: number, lastX: number, lastY: number) => {
        const visible: MapPlayer[] = [];
        const firstBucketX = Math.max(0, Math.floor(firstX / PLAYER_BUCKET_SIZE));
        const firstBucketY = Math.max(0, Math.floor(firstY / PLAYER_BUCKET_SIZE));
        const lastBucketX = Math.floor(Math.min(MAP_WIDTH - 1, lastX) / PLAYER_BUCKET_SIZE);
        const lastBucketY = Math.floor(Math.min(MAP_HEIGHT - 1, lastY) / PLAYER_BUCKET_SIZE);
        for (let bucketY = firstBucketY; bucketY <= lastBucketY; bucketY++) {
            for (let bucketX = firstBucketX; bucketX <= lastBucketX; bucketX++) {
                const bucket = playerBuckets.get(`${bucketX}:${bucketY}`);
                if (!bucket) continue;
                bucket.forEach((uid) => {
                    const player = players.get(uid);
                    if (player && player.x >= firstX && player.x <= lastX && player.y >= firstY && player.y <= lastY) visible.push(player);
                });
            }
        }
        return visible;
    };
    const setCell = (x: number, y: number, color: number) => {
        cellColors[y * MAP_WIDTH + x] = color;
        overviewContext.fillStyle = paletteColor(color);
        overviewContext.fillRect(x, y, 1, 1);
        invalidate();
    };
    const setRect = (rowStart: number, columnStart: number, rowEnd: number, columnEnd: number, color: number) => {
        overviewContext.fillStyle = paletteColor(color);
        overviewContext.fillRect(
            columnStart,
            rowStart,
            columnEnd - columnStart + 1,
            rowEnd - rowStart + 1,
        );
        for (let row = rowStart; row <= rowEnd; row++) {
            cellColors.fill(color, row * MAP_WIDTH + columnStart, row * MAP_WIDTH + columnEnd + 1);
        }
        invalidate();
    };
    const viewSize = () => ({ width: canvas.clientWidth, height: canvas.clientHeight });
    const viewOrigin = () => {
        const view = viewSize();
        return {
            x: view.width / 2 - viewCenterX * viewScale,
            y: view.height / 2 - viewCenterY * viewScale,
        };
    };
    const clampView = () => {
        const view = viewSize();
        const margin = 70;
        const mapWidth = MAP_WIDTH * viewScale;
        const mapHeight = MAP_HEIGHT * viewScale;
        const origin = viewOrigin();
        const originX = Math.min(view.width - margin, Math.max(margin - mapWidth, origin.x));
        const originY = Math.min(view.height - margin, Math.max(margin - mapHeight, origin.y));
        viewCenterX = (view.width / 2 - originX) / viewScale;
        viewCenterY = (view.height / 2 - originY) / viewScale;
        invalidate();
    };
    const centerAt = (x: number, y: number) => {
        viewCenterX = x + .5;
        viewCenterY = y + .5;
        clampView();
    };
    const resize = () => {
        const ratio = window.devicePixelRatio || 1;
        devicePixelRatio = ratio;
        const rect = viewport.getBoundingClientRect();
        canvas.width = Math.max(1, Math.round(rect.width * ratio));
        canvas.height = Math.max(1, Math.round(rect.height * ratio));
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        clampView();
    };
    const updateStats = () => {
        if (catCount) catCount.textContent = String(players.size);
    };
    const updateMeStatus = () => {
        if (!meStatus || !userId) return;
        if (!state.me) {
            meStatus.textContent = state.canJoin ? '点击任意格免费加入' : '完成认证后可参与';
            return;
        }
        const remaining = Math.max(0, state.me.availableAt - now());
        const totalSeconds = Math.ceil(remaining / 1000);
        const cooldown = totalSeconds
            ? `冷却 ${String(Math.floor(totalSeconds / 3600)).padStart(2, '0')}:${String(Math.floor(totalSeconds / 60) % 60).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`
            : '现在可操作';
        const freeColor = state.me.freeColorAvailable ? ' · 免冷却染色 1 次' : '';
        const text = `猫粮余额 ${state.me.food}g · 猫罐头余额 ${state.me.cans} 个 · ${cooldown}${freeColor}`;
        if (meStatus.textContent !== text) meStatus.textContent = text;
    };

    const drawCat = (player: MapPlayer, px: number, py: number, walking: boolean) => {
        const phase = Math.floor(now() / CAT_IDLE_FRAME_MS + player.uid) % 3;
        let frameX = phase === 1 ? 1 : 0;
        let frameY = phase === 2 ? 1 : 0;
        if (walking) {
            frameX = Math.floor(now() / 240) % 2;
            frameY = 1;
        }
        const catSize = Math.max(MIN_CAT_SIZE, viewScale * .72);
        const catX = px + (viewScale - catSize) / 2;
        const catY = py + viewScale - catSize - Math.max(2, viewScale * .04);
        context.save();
        context.fillStyle = player.uid === userId ? 'rgba(255,215,94,.32)' : 'rgba(0,0,0,.2)';
        context.beginPath();
        context.ellipse(px + viewScale / 2, py + viewScale - Math.max(2, viewScale * .05), catSize * .36, catSize * .11, 0, 0, Math.PI * 2);
        context.fill();
        const frame = CAT_FRAMES[frameY * 2 + frameX];
        for (let row = 0; row < 8; row++) {
            const top = Math.round((catY + row * catSize / 8) * devicePixelRatio) / devicePixelRatio;
            const bottom = Math.round((catY + (row + 1) * catSize / 8) * devicePixelRatio) / devicePixelRatio;
            for (let column = 0; column < 8; column++) {
                const color = frame[row][column];
                const fillStyle = CAT_PIXEL_COLORS[color];
                if (!fillStyle) continue;
                const left = Math.round((catX + column * catSize / 8) * devicePixelRatio) / devicePixelRatio;
                const right = Math.round((catX + (column + 1) * catSize / 8) * devicePixelRatio) / devicePixelRatio;
                context.fillStyle = fillStyle;
                context.fillRect(left, top, right - left, bottom - top);
            }
        }
        context.restore();
    };

    const catLabelRect = (player: MapPlayer, px: number, py: number) => {
        const label = `${player.uname}🥫${player.cans}`;
        let metrics = labelMetrics.get(player.uid);
        if (!metrics || metrics.text !== label) {
            context.font = 'bold 11px sans-serif';
            metrics = { text: label, width: Math.min(150, context.measureText(label).width + 9) };
            labelMetrics.set(player.uid, metrics);
        }
        const showEveryName = viewScale >= MAX_VIEW_SCALE - .01;
        const labelWidth = showEveryName ? Math.min(metrics.width, Math.max(24, viewScale - 4)) : metrics.width;
        // 名字写在小猫脚下，不遮住小猫。
        return { label, x: px + viewScale / 2 - labelWidth / 2, y: py + viewScale + 2, width: labelWidth, height: 16 };
    };

    const drawCatLabel = (player: MapPlayer, px: number, py: number) => {
        const rect = catLabelRect(player, px, py);
        context.save();
        context.fillStyle = player.uid === userId ? 'rgba(111,75,9,.9)' : 'rgba(13,27,18,.82)';
        context.fillRect(rect.x, rect.y, rect.width, rect.height);
        context.fillStyle = '#fff';
        context.font = 'bold 11px sans-serif';
        context.textAlign = 'center';
        context.fillText(rect.label, rect.x + rect.width / 2, rect.y + 12, rect.width - 5);
        context.restore();
    };

    const renderMap = (width: number, height: number) => {
        context.fillStyle = paletteColor(238);
        context.fillRect(0, 0, width, height);
        const origin = viewOrigin();
        // All layers share the same device-pixel aligned geometry.  Without
        // this, the scaled bitmap and 1px grid lines can land on different
        // physical pixels (especially on DPR 1.25/1.5 displays).
        const snap = (value: number) => Math.round(value * devicePixelRatio) / devicePixelRatio;
        origin.x = snap(origin.x);
        origin.y = snap(origin.y);
        const mapWidth = snap(MAP_WIDTH * viewScale);
        const mapHeight = snap(MAP_HEIGHT * viewScale);
        context.imageSmoothingEnabled = false;
        context.drawImage(overviewLayer, origin.x, origin.y, mapWidth, mapHeight);
        if (showGrid) {
            context.strokeStyle = 'rgba(0,0,0,.72)';
            context.lineWidth = 1;
            const gridStep = Math.max(1, Math.ceil(MIN_GRID_SPACING / viewScale));
            const firstColumn = Math.max(0, Math.floor((-origin.x / viewScale) / gridStep) * gridStep);
            const lastColumn = Math.min(MAP_WIDTH, Math.ceil((width - origin.x) / viewScale));
            const firstRow = Math.max(0, Math.floor((-origin.y / viewScale) / gridStep) * gridStep);
            const lastRow = Math.min(MAP_HEIGHT, Math.ceil((height - origin.y) / viewScale));
            context.beginPath();
            for (let column = firstColumn; column <= lastColumn; column += gridStep) {
                const x = snap(origin.x + column * viewScale) + 0.5 / devicePixelRatio;
                context.moveTo(x, Math.max(0, origin.y));
                context.lineTo(x, Math.min(height, origin.y + mapHeight));
            }
            for (let row = firstRow; row <= lastRow; row += gridStep) {
                const y = snap(origin.y + row * viewScale) + 0.5 / devicePixelRatio;
                context.moveTo(Math.max(0, origin.x), y);
                context.lineTo(Math.min(width, origin.x + mapWidth), y);
            }
            context.stroke();
        }
        context.strokeStyle = showGrid ? 'rgba(0,0,0,.72)' : 'rgba(255,255,255,.12)';
        context.strokeRect(origin.x + .5, origin.y + .5, mapWidth - 1, mapHeight - 1);
        const renderCats = showCats && viewScale >= MIN_CAT_RENDER_SCALE;
        if (!renderCats && !showNames) return;
        const firstX = Math.max(0, Math.floor(-origin.x / viewScale));
        const firstY = Math.max(0, Math.floor(-origin.y / viewScale));
        const lastX = Math.min(MAP_WIDTH - 1, Math.ceil((width - origin.x) / viewScale));
        const lastY = Math.min(MAP_HEIGHT - 1, Math.ceil((height - origin.y) / viewScale));
        const currentTime = performance.now();
        const labelCandidates: Array<{ player: MapPlayer; px: number; py: number }> = [];
        const visibleByCell = new Map<string, MapPlayer>();
        playersInView(firstX - 2, firstY - 2, lastX + 2, lastY + 2).forEach((player) => {
            const key = cellKey(player.x, player.y);
            const current = visibleByCell.get(key);
            if (!current || player.cans > current.cans || (player.cans === current.cans && player.uid < current.uid)) {
                visibleByCell.set(key, player);
            }
        });
        const visiblePlayers = Array.from(visibleByCell.values());
        visiblePlayers.forEach((player) => {
            let drawX = player.x;
            let drawY = player.y;
            let walking = false;
            const animation = animations.get(player.uid);
            if (animation) {
                const elapsed = currentTime - animation.start;
                if (animation.teleport) {
                    if (elapsed < 700 && renderCats) {
                        context.save();
                        context.strokeStyle = `rgba(118,220,255,${1 - elapsed / 700})`;
                        context.lineWidth = 4;
                        context.beginPath();
                        context.arc(origin.x + (animation.toX + .5) * viewScale, origin.y + (animation.toY + .5) * viewScale, 10 + elapsed / 28, 0, Math.PI * 2);
                        context.stroke();
                        context.restore();
                    } else animations.delete(player.uid);
                } else if (elapsed < 720) {
                    const progress = Math.min(1, elapsed / 720);
                    drawX = animation.fromX + (animation.toX - animation.fromX) * progress;
                    drawY = animation.fromY + (animation.toY - animation.fromY) * progress;
                    walking = true;
                } else animations.delete(player.uid);
            }
            const px = origin.x + drawX * viewScale;
            const py = origin.y + drawY * viewScale;
            if (renderCats) drawCat(player, px, py, walking);
            if (showNames) labelCandidates.push({ player, px, py });
        });
        if (viewScale >= MAX_VIEW_SCALE - .01) {
            labelCandidates.forEach((candidate) => drawCatLabel(candidate.player, candidate.px, candidate.py));
            return;
        }
        const labelBuckets = new Map<string, Array<{ x: number; y: number; width: number; height: number }>>();
        labelCandidates.sort((a, b) => b.player.cans - a.player.cans || a.player.uid - b.player.uid).forEach((candidate) => {
            const rect = catLabelRect(candidate.player, candidate.px, candidate.py);
            const firstBucketX = Math.floor(rect.x / LABEL_BUCKET_WIDTH);
            const lastBucketX = Math.floor((rect.x + rect.width) / LABEL_BUCKET_WIDTH);
            const firstBucketY = Math.floor(rect.y / LABEL_BUCKET_HEIGHT);
            const lastBucketY = Math.floor((rect.y + rect.height) / LABEL_BUCKET_HEIGHT);
            let overlaps = false;
            for (let bucketY = firstBucketY; bucketY <= lastBucketY && !overlaps; bucketY++) {
                for (let bucketX = firstBucketX; bucketX <= lastBucketX && !overlaps; bucketX++) {
                    overlaps = (labelBuckets.get(`${bucketX}:${bucketY}`) || []).some((other) => !(
                        rect.x + rect.width + 2 < other.x
                        || other.x + other.width + 2 < rect.x
                        || rect.y + rect.height + 2 < other.y
                        || other.y + other.height + 2 < rect.y
                    ));
                }
            }
            if (overlaps) return;
            for (let bucketY = firstBucketY; bucketY <= lastBucketY; bucketY++) {
                for (let bucketX = firstBucketX; bucketX <= lastBucketX; bucketX++) {
                    const key = `${bucketX}:${bucketY}`;
                    const bucket = labelBuckets.get(key) || [];
                    bucket.push(rect);
                    labelBuckets.set(key, bucket);
                }
            }
            drawCatLabel(candidate.player, candidate.px, candidate.py);
        });
    };

    const render = () => {
        if (!canvas.isConnected) return;
        const frameAt = performance.now();
        const elapsed = Math.min(.05, Math.max(0, (frameAt - lastRenderAt) / 1000));
        lastRenderAt = frameAt;
        const keyboardActive = document.fullscreenElement === fullscreenRoot
            && !cellDialog?.open && !actionDialog?.open && !colorDialog?.open;
        const directionX = keyboardActive
            ? Number(heldKeys.has('ArrowRight')) - Number(heldKeys.has('ArrowLeft'))
            : 0;
        const directionY = keyboardActive
            ? Number(heldKeys.has('ArrowDown')) - Number(heldKeys.has('ArrowUp'))
            : 0;
        const directionLength = Math.hypot(directionX, directionY) || 1;
        const speed = heldKeys.has('Shift') ? 960 : 520;
        const targetVelocityX = directionX / directionLength * speed;
        const targetVelocityY = directionY / directionLength * speed;
        const smoothing = 1 - Math.exp(-elapsed * (directionX || directionY ? 14 : 10));
        keyboardVelocityX += (targetVelocityX - keyboardVelocityX) * smoothing;
        keyboardVelocityY += (targetVelocityY - keyboardVelocityY) * smoothing;
        const keyboardMoving = Math.abs(keyboardVelocityX) + Math.abs(keyboardVelocityY) > .2;
        if (keyboardMoving) {
            viewCenterX += keyboardVelocityX * elapsed / viewScale;
            viewCenterY += keyboardVelocityY * elapsed / viewScale;
            clampView();
        }
        let animationActive = false;
        animations.forEach((animation, uid) => {
            if (frameAt - animation.start < 720) animationActive = true;
            else animations.delete(uid);
        });
        const statusSecond = Math.floor(now() / 1000);
        if (statusSecond !== lastStatusSecond) {
            lastStatusSecond = statusSecond;
            updateMeStatus();
        }
        const idleFrame = Math.floor(now() / CAT_IDLE_FRAME_MS);
        const shouldDraw = renderDirty
            || keyboardMoving
            || (animationActive && (showCats || showNames))
            || (showCats && idleFrame !== lastIdleFrame);
        if (shouldDraw) {
            const { width, height } = viewSize();
            context.clearRect(0, 0, width, height);
            renderMap(width, height);
            renderDirty = false;
            lastIdleFrame = idleFrame;
        }
        window.requestAnimationFrame(render);
    };

    const applyPlayerUpdate = (incoming: any) => {
        const previous = players.get(Number(incoming.uid));
        if (!previous) {
            const added: MapPlayer = {
                uid: Number(incoming.uid),
                uname: incoming.uname || `UID ${incoming.uid}`,
                x: Number(incoming.x),
                y: Number(incoming.y),
                cans: Math.max(0, Number(incoming.cans) || 0),
                food: Math.max(0, Number(incoming.food) || 0),
                availableAt: incoming.availableAt ? new Date(incoming.availableAt).getTime() : 0,
                freeColorAvailable: !!incoming.freeColorAvailable,
            };
            storePlayer(added);
            if (added.uid === userId) state.me = added;
            updateStats();
            updateMeStatus();
            return;
        }
        const next: MapPlayer = {
            ...previous,
            ...incoming,
            uid: Number(incoming.uid),
            x: Number(incoming.x),
            y: Number(incoming.y),
            availableAt: incoming.availableAt ? new Date(incoming.availableAt).getTime() : 0,
            freeColorAvailable: incoming.freeColorAvailable === undefined
                ? previous.freeColorAvailable
                : !!incoming.freeColorAvailable,
        };
        const positionChanged = previous.x !== next.x || previous.y !== next.y;
        if (positionChanged && next.uid === userId && incoming.food === undefined) {
            next.food = Math.max(0, previous.food - Math.max(0, Number(incoming.foodCost) || 0));
        }
        if (positionChanged) {
            const adjacent = Math.abs(previous.x - next.x) + Math.abs(previous.y - next.y) === 1;
            animations.set(next.uid, {
                fromX: previous.x, fromY: previous.y, toX: next.x, toY: next.y,
                start: performance.now(), teleport: !adjacent,
            });
        }
        storePlayer(next);
        if (next.uid === userId) {
            state.me = next;
            if (positionChanged) centerAt(next.x, next.y);
        }
        updateStats();
        updateMeStatus();
    };

    const openColorDialog = (x: number, y: number) => {
        if (!colorDialog) return;
        if (state.me && state.me.availableAt > now() && !state.me.freeColorAvailable) {
            Notification.error(`所有地图操作共享冷却，请在 ${new Date(state.me.availableAt).toLocaleString('zh-CN')} 后再换颜色。`);
            return;
        }
        selectedColorCell = { x, y };
        const input = colorDialog.querySelector<HTMLInputElement>('[data-color-input]');
        if (input) {
            const currentColor = cellColors[y * MAP_WIDTH + x];
            input.value = String(currentColor >= 0 ? currentColor : 34);
            input.dispatchEvent(new Event('input'));
        }
        colorDialog.showModal();
    };

    const openActionDialog = (x: number, y: number) => {
        if (!actionDialog) return;
        selectedTarget = { x, y };
        const joining = !state.me && state.canJoin;
        if (!state.me && !joining) return;
        const me = state.me;
        const distance = me ? Math.abs(me.x - x) + Math.abs(me.y - y) : 0;
        const adjacent = distance === 1;
        const title = actionDialog.querySelector<HTMLElement>('[data-action-title]');
        const message = actionDialog.querySelector<HTMLElement>('[data-action-message]');
        const confirm = actionDialog.querySelector<HTMLButtonElement>('[data-action-confirm]');
        const cooling = !!me && me.availableAt > now();
        const lacksResource = !!me && (adjacent ? me.food < 3 : me.cans < 3);
        if (title) title.textContent = joining ? '加入猫猫广场' : adjacent ? '移动到相邻格' : '传送到目标格';
        if (message) {
            if (joining) message.textContent = `是否免费选择（行 ${y}, 列 ${x}）作为小猫的初始位置？首次加入不消耗资源，也不触发冷却。`;
            else if (cooling) message.textContent = `目标（行 ${y}, 列 ${x}）。所有操作共享冷却，可用时间：${new Date(me!.availableAt).toLocaleString('zh-CN')}。`;
            else if (adjacent) message.textContent = `是否使用 3g 猫粮移动到（行 ${y}, 列 ${x}）？当前余额 ${me!.food}g。`;
            else message.textContent = `是否使用 3 个猫罐头传送到（行 ${y}, 列 ${x}）？当前持有 ${me!.cans} 个猫罐头。`;
        }
        if (confirm) confirm.disabled = cooling || lacksResource;
        actionDialog.showModal();
    };

    const openCellDialog = (x: number, y: number) => {
        if (!cellDialog) return;
        selectedTarget = { x, y };
        const occupants = playersAtCell(x, y);
        const title = cellDialog.querySelector<HTMLElement>('[data-cell-title]');
        const summary = cellDialog.querySelector<HTMLElement>('[data-cell-summary]');
        const list = cellDialog.querySelector<HTMLElement>('[data-cell-players]');
        const action = cellDialog.querySelector<HTMLButtonElement>('[data-cell-action]');
        const color = cellDialog.querySelector<HTMLButtonElement>('[data-cell-color]');
        if (title) title.textContent = `格子（行 ${y}，列 ${x}）`;
        if (summary) summary.textContent = occupants.length
            ? `这里有 ${occupants.length} 只小猫；地图显示猫罐头最多的 ${occupants[0].uname}。`
            : '这里暂时没有小猫。';
        if (list) {
            list.replaceChildren();
            occupants.forEach((player, index) => {
                const item = document.createElement('li');
                const name = document.createElement('strong');
                name.textContent = `${player.uname}（UID ${player.uid}）`;
                const balance = document.createElement('span');
                balance.textContent = `猫粮 ${player.food}g · 猫罐头 ${player.cans} 个${index === 0 ? ' · 当前显示' : ''}`;
                item.append(name, balance);
                list.append(item);
            });
        }
        const me = state.me;
        const sameCell = !!me && me.x === x && me.y === y;
        if (color) color.hidden = !sameCell;
        if (action) {
            const joining = !me && state.canJoin;
            const canAct = !!me || joining;
            const distance = me ? Math.abs(me.x - x) + Math.abs(me.y - y) : 0;
            const adjacent = distance === 1;
            action.hidden = !canAct || sameCell;
            action.textContent = joining ? '免费加入这里' : adjacent ? '移动到这里（3g）' : '传送到这里（3 个罐头）';
            action.disabled = false;
        }
        cellDialog.showModal();
    };

    const clickCell = (x: number, y: number) => {
        if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) return;
        openCellDialog(x, y);
    };

    const pointToCell = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const origin = viewOrigin();
        return {
            x: Math.floor((px - origin.x) / viewScale),
            y: Math.floor((py - origin.y) / viewScale),
        };
    };

    const pointerDistance = () => {
        const points = Array.from(activePointers.values());
        return points.length >= 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
    };
    const pointerMidpoint = () => {
        const points = Array.from(activePointers.values());
        return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    };
    const beginPinch = () => {
        if (activePointers.size < 2) {
            pinch = null;
            return;
        }
        const midpoint = pointerMidpoint();
        const rect = viewport.getBoundingClientRect();
        const view = viewSize();
        const pointerX = midpoint.x - rect.left;
        const pointerY = midpoint.y - rect.top;
        pinch = {
            distance: Math.max(1, pointerDistance()),
            scale: viewScale,
            mapX: viewCenterX + (pointerX - view.width / 2) / viewScale,
            mapY: viewCenterY + (pointerY - view.height / 2) / viewScale,
        };
        drag = null;
        gestureMoved = true;
        viewport.classList.add('is-dragging');
    };
    viewport.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        viewport.setPointerCapture(event.pointerId);
        if (activePointers.size >= 2) {
            beginPinch();
            return;
        }
        gestureMoved = false;
        drag = {
            x: event.clientX, y: event.clientY,
            centerX: viewCenterX, centerY: viewCenterY, moved: false,
        };
        viewport.classList.add('is-dragging');
    });
    viewport.addEventListener('pointermove', (event) => {
        if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pinch && activePointers.size >= 2) {
            const midpoint = pointerMidpoint();
            const rect = viewport.getBoundingClientRect();
            const view = viewSize();
            const pointerX = midpoint.x - rect.left;
            const pointerY = midpoint.y - rect.top;
            viewScale = Math.max(MIN_VIEW_SCALE, Math.min(MAX_VIEW_SCALE, pinch.scale * pointerDistance() / pinch.distance));
            viewCenterX = pinch.mapX - (pointerX - view.width / 2) / viewScale;
            viewCenterY = pinch.mapY - (pointerY - view.height / 2) / viewScale;
            clampView();
            gestureMoved = true;
            return;
        }
        const cell = pointToCell(event.clientX, event.clientY);
        if (coordinate) coordinate.textContent = cell.x >= 0 && cell.x < MAP_WIDTH && cell.y >= 0 && cell.y < MAP_HEIGHT ? `格子：（行 ${cell.y}, 列 ${cell.x}）` : '格子：—';
        if (!drag) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (Math.hypot(dx, dy) > 5) drag.moved = true;
        viewCenterX = drag.centerX - dx / viewScale;
        viewCenterY = drag.centerY - dy / viewScale;
        clampView();
    });
    const finishPointer = (event: PointerEvent, cancelled: boolean) => {
        const wasDrag = cancelled || gestureMoved || !!drag?.moved || activePointers.size > 1;
        activePointers.delete(event.pointerId);
        if (activePointers.size >= 2) {
            beginPinch();
            return;
        }
        pinch = null;
        if (activePointers.size === 1) {
            const remaining = Array.from(activePointers.values())[0];
            drag = {
                x: remaining.x,
                y: remaining.y,
                centerX: viewCenterX,
                centerY: viewCenterY,
                moved: true,
            };
            gestureMoved = true;
            return;
        }
        drag = null;
        gestureMoved = false;
        viewport.classList.remove('is-dragging');
        if (!wasDrag && !cancelled) {
            const cell = pointToCell(event.clientX, event.clientY);
            clickCell(cell.x, cell.y);
        }
    };
    viewport.addEventListener('pointerup', (event) => finishPointer(event, false));
    viewport.addEventListener('pointercancel', (event) => finishPointer(event, true));
    viewport.addEventListener('wheel', (event) => {
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        const factor = Math.exp(-event.deltaY * 0.0015);
        const view = viewSize();
        const mapX = viewCenterX + (pointerX - view.width / 2) / viewScale;
        const mapY = viewCenterY + (pointerY - view.height / 2) / viewScale;
        viewScale = Math.max(MIN_VIEW_SCALE, Math.min(MAX_VIEW_SCALE, viewScale * factor));
        viewCenterX = mapX - (pointerX - view.width / 2) / viewScale;
        viewCenterY = mapY - (pointerY - view.height / 2) / viewScale;
        clampView();
    }, { passive: false });

    document.querySelectorAll<HTMLButtonElement>('[data-map-layer]').forEach((button) => button.addEventListener('click', () => {
        const layer = button.dataset.mapLayer;
        if (layer === 'grid') showGrid = !showGrid;
        if (layer === 'cats') showCats = !showCats;
        if (layer === 'names') showNames = !showNames;
        const active = layer === 'grid' ? showGrid : layer === 'cats' ? showCats : showNames;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
        invalidate();
    }));
    const updateFullscreen = () => {
        const active = document.fullscreenElement === fullscreenRoot;
        if (!active) {
            heldKeys.clear();
            keyboardVelocityX = 0;
            keyboardVelocityY = 0;
        }
        if (fullscreenButton) {
            fullscreenButton.textContent = active ? '退出全屏' : '全屏';
            fullscreenButton.setAttribute('aria-pressed', String(active));
        }
        window.requestAnimationFrame(resize);
    };
    if (!fullscreenRoot || !fullscreenButton || !document.fullscreenEnabled) {
        if (fullscreenButton) fullscreenButton.hidden = true;
    } else {
        fullscreenButton.addEventListener('click', async () => {
            try {
                if (document.fullscreenElement === fullscreenRoot) await document.exitFullscreen();
                else await fullscreenRoot.requestFullscreen();
            } catch (e: any) {
                Notification.error(e.message || '无法进入全屏模式。');
            }
        });
        document.addEventListener('fullscreenchange', updateFullscreen);
    }
    document.addEventListener('keydown', (event) => {
        if (!canvas.isConnected || document.fullscreenElement !== fullscreenRoot || event.defaultPrevented) return;
        if (event.altKey || event.ctrlKey || event.metaKey || cellDialog?.open || actionDialog?.open || colorDialog?.open) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift'].includes(event.key)) return;
        heldKeys.add(event.key);
        if (event.key === 'Shift') return;
        event.preventDefault();
    });
    document.addEventListener('keyup', (event) => heldKeys.delete(event.key));
    window.addEventListener('blur', () => heldKeys.clear());
    document.querySelector<HTMLButtonElement>('[data-map-find-me]')?.addEventListener('click', () => {
        if (!state.me) return Notification.error('当前账号还没有可定位的小猫。');
        centerAt(state.me.x, state.me.y);
    });
    document.querySelector<HTMLButtonElement>('[data-map-jump]')?.addEventListener('click', () => {
        const rowInput = document.querySelector<HTMLInputElement>('[data-map-jump-row]');
        const columnInput = document.querySelector<HTMLInputElement>('[data-map-jump-column]');
        const row = Number(rowInput?.value);
        const column = Number(columnInput?.value);
        if (!rowInput?.value || !columnInput?.value || !Number.isInteger(row) || row < 0 || row >= MAP_HEIGHT || !Number.isInteger(column) || column < 0 || column >= MAP_WIDTH) {
            Notification.error('请输入有效坐标：行 0～479，列 0～639。');
            return;
        }
        centerAt(column, row);
        if (coordinate) coordinate.textContent = `格子：（行 ${row}, 列 ${column}）`;
    });
    cellDialog?.querySelector<HTMLButtonElement>('[data-cell-action]')?.addEventListener('click', () => {
        if (!selectedTarget) return;
        const { x, y } = selectedTarget;
        cellDialog.close();
        openActionDialog(x, y);
    });
    cellDialog?.querySelector<HTMLButtonElement>('[data-cell-color]')?.addEventListener('click', () => {
        if (!selectedTarget) return;
        const { x, y } = selectedTarget;
        cellDialog.close();
        openColorDialog(x, y);
    });
    actionDialog?.querySelector<HTMLButtonElement>('[data-action-confirm]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        if (!selectedTarget) return;
        button.disabled = true;
        try {
            const joining = !state.me && state.canJoin;
            const result = await request.post(joining ? joinUrl : moveUrl, selectedTarget);
            applyPlayerUpdate({ ...result, uid: userId });
            if (joining) state.canJoin = false;
            Notification.success(result.action === 'join'
                ? '加入成功，首次选择位置免费且没有触发冷却。'
                : result.action === 'move'
                    ? '移动成功，已销毁 3g 猫粮，并获得 1 次免冷却染色。'
                    : '传送成功，3 个猫罐头已回到虚拟储备池，并获得 1 次免冷却染色。');
            actionDialog.close();
        } catch (e: any) {
            Notification.error(e.message || String(e));
        } finally {
            button.disabled = false;
        }
    });
    colorDialog?.querySelector<HTMLButtonElement>('[data-color-confirm]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        const input = colorDialog.querySelector<HTMLInputElement>('[data-color-input]');
        if (!selectedColorCell || !input) return;
        button.disabled = true;
        try {
            const color = Number(input.value);
            const result = await request.post(colorUrl, { ...selectedColorCell, color });
            setCell(result.x, result.y, result.color);
            if (state.me) {
                state.me.availableAt = result.availableAt ? new Date(result.availableAt).getTime() : 0;
                state.me.freeColorAvailable = !!result.freeColorAvailable;
            }
            Notification.success(`格子（行 ${result.y}, 列 ${result.x}）已设置为颜色码 ${result.color}。`);
            colorDialog.close();
        } catch (e: any) {
            Notification.error(e.message || String(e));
        } finally {
            button.disabled = false;
        }
    });

    const socket = new Socket(connectionUrl);
    socket.on('open', () => {
        if (live) {
            live.textContent = '实时同步已连接';
            live.classList.add('is-online');
        }
    });
    socket.on('close', () => {
        if (live) {
            live.textContent = '连接中断，正在重连';
            live.classList.remove('is-online');
        }
    });
    socket.on('message', (_event, data) => {
        const payload = JSON.parse(data);
        if (payload.type === 'player') applyPlayerUpdate(payload.player);
        if (payload.type === 'remove') {
            const uid = Number(payload.uid);
            deletePlayer(uid);
            animations.delete(uid);
            if (uid === userId) {
                state.me = null;
                state.canJoin = false;
            }
            updateStats();
            updateMeStatus();
        }
        if (payload.type === 'cell' && Array.isArray(payload.cell)) setCell(payload.cell[0], payload.cell[1], payload.cell[2]);
        if (payload.type === 'rect' && Array.isArray(payload.rect)) {
            setRect(payload.rect[0], payload.rect[1], payload.rect[2], payload.rect[3], payload.rect[4]);
        }
        if (payload.type === 'cooldown' && Number(payload.uid) === userId && state.me) {
            state.me.availableAt = payload.availableAt ? new Date(payload.availableAt).getTime() : 0;
            state.me.freeColorAvailable = !!payload.freeColorAvailable;
        }
    });

    window.addEventListener('resize', resize);
    request.get(stateUrl).then((incoming: MapState) => {
        state = incoming;
        clockOffset = incoming.serverTime - Date.now();
        players.clear();
        playerBuckets.clear();
        playersByCell.clear();
        labelMetrics.clear();
        incoming.players.forEach((player) => storePlayer({
            ...player,
            availableAt: Number(player.availableAt) || 0,
            freeColorAvailable: !!player.freeColorAvailable,
        }));
        cellColors.fill(-1);
        overviewContext.fillStyle = '#ffffff';
        overviewContext.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
        incoming.cells.forEach(([x, y, color]) => setCell(x, y, color));
        state.me = userId ? players.get(userId) || null : null;
        const focusedPlayer = focusUserId ? players.get(focusUserId) : null;
        if (focusedPlayer) {
            centerAt(focusedPlayer.x, focusedPlayer.y);
            if (coordinate) coordinate.textContent = `格子：（行 ${focusedPlayer.y}, 列 ${focusedPlayer.x}）`;
        } else if (state.me) centerAt(state.me.x, state.me.y);
        else centerAt(MAP_WIDTH / 2, MAP_HEIGHT / 2);
        updateStats();
        updateMeStatus();
        loading?.classList.add('is-hidden');
        if (focusUserId && !focusedPlayer) Notification.error('该用户的小猫尚未加入猫猫广场。');
    }).catch((e) => {
        if (loading) loading.textContent = `地图加载失败：${e.message || e}`;
    });
    resize();
    render();
}

addPage(new NamedPage(['oi33_cat_can_arena', 'oi33_cat_can_arena_admin'], mountMap));
