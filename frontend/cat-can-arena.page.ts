import {
    addPage, NamedPage, Notification, request, Socket,
} from '@hydrooj/ui-default';
import './cat-can-arena.css';
import { CAT_FRAMES, CAT_PIXEL_COLORS } from './cat-sprites';
import { mountBigCatLayer } from './cat-big-arena.page';

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 1000;
// 帝国区为距边框 250 格的环形区域，中央 500×500 为 00区（与服务端 model/cat-map.ts 同步）。
const CORE_ZONE_MIN = 250;
const CORE_ZONE_MAX = MAP_WIDTH - CORE_ZONE_MIN - 1;
const LEGACY_MAP_WIDTH = 640;
const LEGACY_MAP_HEIGHT = 480;
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
// 计划到点后超过这个时间还没看到视图变化，就拉一次计划状态（调度延迟 / 推送丢失）。
const PLAN_SYNC_OVERDUE_MS = 2000;
// 兜底同步的最小间隔，避免在调度器卡住时反复请求。
const PLAN_SYNC_INTERVAL_MS = 3000;
// 连续拿不到新视图多少次后转入慢速重试。
const PLAN_SYNC_RETRY_LIMIT = 3;
const PLAN_SYNC_BACKOFF_MS = 15000;

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

interface MapPlanStep {
    index: number;
    x: number;
    y: number;
    color: number;
    executed: boolean;
}

interface MapPlan {
    status: 'active' | 'done' | 'stopped';
    cursor: number;
    steps: MapPlanStep[];
    maxSteps: number;
    originX: number;
    originY: number;
    nextAt: number;
    failReason: string;
    updatedAt: number;
}

interface MapState {
    width: number;
    height: number;
    players: MapPlayer[];
    cells: [number, number, number, number][];
    me: MapPlayer | null;
    canJoin: boolean;
    plan?: MapPlan | null;
    planMaxSteps?: number;
    serverTime: number;
}

function paletteColorValue(code: number) {
    const standard = [
        0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xC0C0C0,
        0x808080, 0xFF0000, 0x00FF00, 0xFFFF00, 0x0000FF, 0xFF00FF, 0x00FFFF, 0xFFFFFF,
    ];
    if (code < 16) return standard[code];
    if (code < 232) {
        const value = code - 16;
        const levels = [0, 95, 135, 175, 215, 255];
        return (levels[Math.floor(value / 36)] << 16)
            | (levels[Math.floor(value / 6) % 6] << 8)
            | levels[value % 6];
    }
    const gray = 8 + (code - 232) * 10;
    return (gray << 16) | (gray << 8) | gray;
}

function paletteColor(code: number) {
    return `#${paletteColorValue(code).toString(16).padStart(6, '0')}`;
}

// 计划编号要压在颜色圆圈上：按 WCAG 相对亮度取黑/白中对比度更高的那个，
// 深色底用白字、浅色底用黑字。
function paletteTextColor(code: number) {
    const value = paletteColorValue(code);
    const channel = (raw: number) => {
        const scaled = raw / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    const luminance = 0.2126 * channel((value >> 16) & 0xff)
        + 0.7152 * channel((value >> 8) & 0xff)
        + 0.0722 * channel(value & 0xff);
    const againstBlack = (luminance + 0.05) / 0.05;
    const againstWhite = 1.05 / (luminance + 0.05);
    return againstBlack >= againstWhite ? '#111111' : '#ffffff';
}

const PALETTE_VALUES = new Uint32Array(Array.from({ length: 256 }, (_, code) => paletteColorValue(code)));

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
    const planUrl = viewport.dataset.planUrl || '/oi33/arena/plan';
    const planCancelUrl = viewport.dataset.planCancelUrl || '/oi33/arena/plan/cancel';
    const planStateUrl = viewport.dataset.planStateUrl || '/oi33/arena/plan/state';
    const connectionUrl = viewport.dataset.connUrl || '/oi33/arena/conn';
    const loading = viewport.querySelector<HTMLElement>('.oi33-map-loading');
    const coordinate = document.querySelector<HTMLElement>('[data-map-coordinate]');
    const live = document.querySelector<HTMLElement>('[data-map-live]');
    const catCount = document.querySelector<HTMLElement>('[data-map-cat-count]');
    const meStatus = document.querySelector<HTMLElement>('[data-map-me-status]');
    const fullscreenRoot = viewport.closest<HTMLElement>('.oi33-map-body');
    const bigCatSide = viewport.closest<HTMLElement>('.oi33-bigcat-main')
        ?.querySelector<HTMLElement>('.oi33-bigcat-side');
    const fullscreenButton = document.querySelector<HTMLButtonElement>('[data-map-fullscreen]');
    const cellDialog = document.querySelector<HTMLDialogElement>('[data-map-cell-dialog]');
    const actionDialog = document.querySelector<HTMLDialogElement>('[data-map-action-dialog]');
    const colorDialog = document.querySelector<HTMLDialogElement>('[data-map-color-dialog]');
    const planPanel = document.querySelector<HTMLElement>('[data-map-plan]');
    const planToggle = document.querySelector<HTMLButtonElement>('[data-plan-toggle]');
    const planCloseButton = document.querySelector<HTMLButtonElement>('[data-plan-close]');
    const planStatus = document.querySelector<HTMLElement>('[data-plan-status]');
    const planCount = document.querySelector<HTMLElement>('[data-plan-count]');
    const planStepsList = document.querySelector<HTMLElement>('[data-plan-steps]');
    const planHint = document.querySelector<HTMLElement>('[data-plan-hint]');
    const planAddButton = document.querySelector<HTMLButtonElement>('[data-plan-add]');
    const planUndoButton = document.querySelector<HTMLButtonElement>('[data-plan-undo]');
    const planClearButton = document.querySelector<HTMLButtonElement>('[data-plan-clear]');
    const planSaveButton = document.querySelector<HTMLButtonElement>('[data-plan-save]');
    const planCancelButton = document.querySelector<HTMLButtonElement>('[data-plan-cancel]');
    const planStepDialog = document.querySelector<HTMLDialogElement>('[data-map-plan-step-dialog]');

    let state: MapState = {
        width: MAP_WIDTH, height: MAP_HEIGHT, players: [], cells: [], me: null, canJoin: false,
        plan: null, planMaxSteps: 10, serverTime: Date.now(),
    };
    const players = new Map<number, MapPlayer>();
    const playerBuckets = new Map<string, Set<number>>();
    const playersByCell = new Map<string, Set<number>>();
    const labelMetrics = new Map<number, { text: string; width: number }>();
    const cellColors = new Int16Array(MAP_WIDTH * MAP_HEIGHT);
    cellColors.fill(-1);
    const cellCatIds = new Int32Array(MAP_WIDTH * MAP_HEIGHT);
    cellCatIds.fill(-1);
    const overviewLayer = document.createElement('canvas');
    overviewLayer.width = MAP_WIDTH;
    overviewLayer.height = MAP_HEIGHT;
    const overviewContext = overviewLayer.getContext('2d')!;
    overviewContext.fillStyle = '#ffffff';
    overviewContext.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    const territoryLayer = document.createElement('canvas');
    territoryLayer.width = MAP_WIDTH;
    territoryLayer.height = MAP_HEIGHT;
    const territoryContext = territoryLayer.getContext('2d')!;
    territoryContext.fillStyle = '#ffffff';
    territoryContext.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    const animations = new Map<number, { fromX: number; fromY: number; toX: number; toY: number; start: number; teleport: boolean }>();
    let showGrid = false;
    let showCats = true;
    let showBigCats = false;
    let showNames = true;
    let showEmpireBorder = true;
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
    // 路径规划：planDraft 是尚未提交的步骤（整体替换时为新计划，运行中计划则为待追加步骤）。
    let planPicking = false;
    let planStepTarget: { x: number; y: number } | null = null;
    const planDraft: { x: number; y: number; color: number }[] = [];
    // 计划视图的兜底同步（WebSocket 推送丢失或服务端调度延迟时用）。
    let planSyncing = false;
    let planSyncedAt = 0;
    let planSyncTries = 0;
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
    let bigCats: ReturnType<typeof mountBigCatLayer> = null;
    let territoryRebuildFrame = 0;
    const rebuildOverviewLayer = () => {
        const pixels = overviewContext.createImageData(MAP_WIDTH, MAP_HEIGHT);
        const data = pixels.data;
        for (let index = 0; index < cellColors.length; index++) {
            const color = cellColors[index] < 0 ? 0xFFFFFF : PALETTE_VALUES[cellColors[index]];
            const offset = index * 4;
            data[offset] = color >> 16;
            data[offset + 1] = (color >> 8) & 0xFF;
            data[offset + 2] = color & 0xFF;
            data[offset + 3] = 0xFF;
        }
        overviewContext.putImageData(pixels, 0, 0);
    };
    const rebuildTerritoryLayer = () => {
        territoryRebuildFrame = 0;
        const pixels = territoryContext.createImageData(MAP_WIDTH, MAP_HEIGHT);
        const data = pixels.data;
        for (let index = 0; index < cellColors.length; index++) {
            const color = cellColors[index] < 0
                ? 0xFFFFFF
                // 已涂色格子的 catId 必为真实归属（0 = 无大猫，负数 = 特殊大猫）。
                : bigCats?.colorValueFor(cellCatIds[index]) ?? 0xB8BCC2;
            const offset = index * 4;
            data[offset] = color >> 16;
            data[offset + 1] = (color >> 8) & 0xFF;
            data[offset + 2] = color & 0xFF;
            data[offset + 3] = 0xFF;
        }
        territoryContext.putImageData(pixels, 0, 0);
        invalidate();
    };
    const scheduleTerritoryRebuild = () => {
        if (territoryRebuildFrame) return;
        territoryRebuildFrame = window.requestAnimationFrame(rebuildTerritoryLayer);
    };
    const setCell = (x: number, y: number, color: number, catId = 0) => {
        const index = y * MAP_WIDTH + x;
        cellColors[index] = color;
        const key = Number(catId);
        cellCatIds[index] = Number.isSafeInteger(key) ? key : 0;
        overviewContext.fillStyle = paletteColor(color);
        overviewContext.fillRect(x, y, 1, 1);
        territoryContext.fillStyle = bigCats?.colorFor(cellCatIds[index]) || '#b8bcc2';
        territoryContext.fillRect(x, y, 1, 1);
        invalidate();
    };
    const setRect = (
        rowStart: number, columnStart: number, rowEnd: number, columnEnd: number, color: number, catId = 0,
    ) => {
        overviewContext.fillStyle = paletteColor(color);
        overviewContext.fillRect(
            columnStart,
            rowStart,
            columnEnd - columnStart + 1,
            rowEnd - rowStart + 1,
        );
        territoryContext.fillStyle = bigCats?.colorFor(catId) || '#b8bcc2';
        territoryContext.fillRect(
            columnStart,
            rowStart,
            columnEnd - columnStart + 1,
            rowEnd - rowStart + 1,
        );
        for (let row = rowStart; row <= rowEnd; row++) {
            cellColors.fill(color, row * MAP_WIDTH + columnStart, row * MAP_WIDTH + columnEnd + 1);
            cellCatIds.fill(catId, row * MAP_WIDTH + columnStart, row * MAP_WIDTH + columnEnd + 1);
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
        const pixelWidth = Math.max(1, Math.round(rect.width * ratio));
        const pixelHeight = Math.max(1, Math.round(rect.height * ratio));
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        const cssWidth = `${rect.width}px`;
        const cssHeight = `${rect.height}px`;
        if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
        if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
        // The map is square in the normal desktop layout, while the old
        // sidebar used an unrelated vh cap and therefore stopped well before
        // the bottom of the canvas. Keep both columns on the exact same
        // measured height; stacked mobile layout keeps its own content cap.
        if (bigCatSide) {
            const stacked = window.matchMedia('(max-width: 760px)').matches;
            const sideHeight = stacked ? '' : cssHeight;
            if (bigCatSide.style.height !== sideHeight) bigCatSide.style.height = sideHeight;
        }
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        clampView();
    };
    const updateStats = () => {
        if (catCount) catCount.textContent = String(players.size);
    };
    bigCats = mountBigCatLayer({ invalidate, onTerritoryColorsChanged: scheduleTerritoryRebuild });
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
        // 剩余步数随执行推进，界面上的数字必须和画布上的圆圈数量一致。
        const active = activePlan();
        const planned = active ? ` · 计划剩余 ${active.steps.length - Math.min(active.cursor, active.steps.length)}/${active.steps.length} 步` : '';
        const text = `猫粮余额 ${state.me.food}g · 猫罐头余额 ${state.me.cans} 个 · ${cooldown}${freeColor}${planned}`;
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
        context.drawImage(showBigCats ? territoryLayer : overviewLayer, origin.x, origin.y, mapWidth, mapHeight);
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
        // 帝国区与 00区的分界：只画 00区外框的「口」字，由「帝国边界」开关控制。
        if (showEmpireBorder) {
            context.strokeStyle = 'rgba(122,74,10,.9)';
            context.lineWidth = Math.min(6, Math.max(2, viewScale * .12));
            const edgeStart = CORE_ZONE_MIN * viewScale;
            const edgeEnd = (MAP_WIDTH - CORE_ZONE_MIN) * viewScale;
            const clipX0 = Math.max(0, origin.x);
            const clipX1 = Math.min(width, origin.x + mapWidth);
            const clipY0 = Math.max(0, origin.y);
            const clipY1 = Math.min(height, origin.y + mapHeight);
            context.beginPath();
            for (const boundary of [CORE_ZONE_MIN, MAP_WIDTH - CORE_ZONE_MIN]) {
                const bx = snap(origin.x + boundary * viewScale);
                if (bx >= clipX0 && bx <= clipX1) {
                    context.moveTo(bx, Math.max(clipY0, origin.y + edgeStart));
                    context.lineTo(bx, Math.min(clipY1, origin.y + edgeEnd));
                }
                const by = snap(origin.y + boundary * viewScale);
                if (by >= clipY0 && by <= clipY1) {
                    context.moveTo(Math.max(clipX0, origin.x + edgeStart), by);
                    context.lineTo(Math.min(clipX1, origin.x + edgeEnd), by);
                }
            }
            context.stroke();
        }
        context.strokeStyle = showGrid ? 'rgba(0,0,0,.72)' : 'rgba(255,255,255,.12)';
        context.strokeRect(origin.x + .5, origin.y + .5, mapWidth - 1, mapHeight - 1);
        // 自己的计划路径画在底图之上、小猫之下（未开启小猫层时也要能看到）。
        drawPlanOverlay(origin);
        // 底图可在原始 8-bit 颜色与大猫领地颜色之间切换，小猫层保持独立。
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
            && !cellDialog?.open && !actionDialog?.open && !colorDialog?.open && !bigCats?.isDialogOpen();
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
            // 计划推进只由服务端调度器执行：到点后若还没收到 WebSocket 推送，
            // 拉一次计划视图，让圆圈在真正执行的几秒内消失（而不是等到推送才变）。
            syncPlanState();
        }
        const idleFrame = Math.floor(now() / CAT_IDLE_FRAME_MS);
        const shouldDraw = renderDirty
            || keyboardMoving
            || (animationActive && (showCats || showNames))
            // 大小猫都按这个节拍切换待机动画帧。
            || idleFrame !== lastIdleFrame;
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

    const isOwnTerritoryTeleport = (me: MapPlayer | null, x: number, y: number) => {
        if (!me || Math.abs(me.x - x) + Math.abs(me.y - y) <= 1) return false;
        const ownCatId = bigCats?.boundCatId() || 0;
        if (!ownCatId) return false;
        const fromIndex = me.y * MAP_WIDTH + me.x;
        const toIndex = y * MAP_WIDTH + x;
        // 未涂色格子的 cellCatIds 是 -1 哨兵，可能和特殊大猫 -1 的 key 撞车，
        // 必须确认两格都已涂色再比较归属。
        return cellColors[fromIndex] >= 0 && cellColors[toIndex] >= 0
            && cellCatIds[fromIndex] === ownCatId
            && cellCatIds[toIndex] === ownCatId;
    };

    const isCoreZone = (x: number, y: number) => x >= CORE_ZONE_MIN && x <= CORE_ZONE_MAX
        && y >= CORE_ZONE_MIN && y <= CORE_ZONE_MAX;

    // 与服务端 fortressCatIdAt 一致的前端预判：00区内上下左右均归属同一大猫的核心格。
    const fortressCatIdAt = (x: number, y: number) => {
        if (!isCoreZone(x, y)) return 0;
        const indices = [
            y * MAP_WIDTH + x,
            y * MAP_WIDTH + x - 1,
            y * MAP_WIDTH + x + 1,
            (y - 1) * MAP_WIDTH + x,
            (y + 1) * MAP_WIDTH + x,
        ];
        // 未涂色格子是 -1 哨兵，可能和特殊大猫 -1 撞车，必须确认五格都已涂色。
        if (indices.some((index) => cellColors[index] < 0)) return 0;
        const center = cellCatIds[indices[0]];
        if (!center) return 0;
        return indices.every((index) => cellCatIds[index] === center) ? center : 0;
    };

    // --- 路径规划面板 -----------------------------------------------------
    const activePlan = () => (state.plan && state.plan.status === 'active' ? state.plan : null);
    const planLimit = () => Math.max(1, Number(state.planMaxSteps) || 10);
    const planLabel = (x: number, y: number) => `（行 ${y}，列 ${x}）`;

    // 尚未执行的步骤（光标本步之前都已走过）。画布圆圈与面板列表都只看这一段：
    // 执行掉一步，它就立刻从界面上消失。
    const planPending = () => {
        const plan = activePlan();
        return plan
            ? plan.steps.slice(Math.max(0, Math.min(plan.cursor, plan.steps.length)))
            : [];
    };

    // 路径连续性的基准：接着运行中计划的最后一步（或有草稿时接草稿末步），
    // 否则从计划起点 / 小猫当前位置出发。
    const planBase = () => {
        const plan = activePlan();
        if (plan && plan.steps.length) {
            const last = plan.steps[plan.steps.length - 1];
            return { x: last.x, y: last.y };
        }
        if (planDraft.length) {
            const last = planDraft[planDraft.length - 1];
            return { x: last.x, y: last.y };
        }
        if (plan) return { x: plan.originX, y: plan.originY };
        return state.me ? { x: state.me.x, y: state.me.y } : null;
    };

    const formatPlanWait = (milliseconds: number) => {
        const total = Math.max(0, Math.ceil(milliseconds / 1000));
        return `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    };

    const planStatusText = () => {
        const plan = activePlan();
        if (plan) {
            if (plan.cursor >= plan.steps.length) return `计划已完成（${plan.steps.length} 步）`;
            const remaining = plan.nextAt - now();
            const waiting = remaining > 0 ? `等待 ${formatPlanWait(remaining)}` : '即将执行';
            const left = plan.steps.length - plan.cursor;
            return `剩余 ${left} 步 / 共 ${plan.steps.length} 步 · ${waiting}第 1 步`;
        }
        if (state.plan && state.plan.status === 'stopped') {
            return `上次计划已停止${state.plan.failReason ? `：${state.plan.failReason}` : ''}`;
        }
        if (state.plan && state.plan.status === 'done') return `上次计划已完成（${state.plan.steps.length} 步）`;
        return '尚未规划';
    };

    const renderPlanPanel = () => {
        if (!planPanel) return;
        const plan = activePlan();
        // 已执行的步骤不再占位：面板同样只列未来的步骤（从 #1 重新计数），
        // 计数里仍保留「已规划总步数 / 上限」，因为上限是按总步数校验的。
        const pending = planPending();
        const total = (plan ? plan.steps.length : 0) + planDraft.length;
        if (planStatus) planStatus.textContent = planStatusText();
        if (planCount) planCount.textContent = `${total} / ${planLimit()} 步`;
        if (planStepsList) {
            planStepsList.replaceChildren();
            const appendItem = (
                index: number, x: number, y: number, color: number, options: { next?: boolean; draft?: boolean },
            ) => {
                const item = document.createElement('li');
                if (options.next) item.classList.add('is-next');
                if (options.draft) item.classList.add('is-draft');
                const order = document.createElement('span');
                order.className = 'oi33-map-plan__order';
                order.textContent = `#${index + 1}`;
                const swatch = document.createElement('span');
                swatch.className = 'oi33-map-plan__swatch';
                swatch.style.background = paletteColor(color);
                const text = document.createElement('span');
                text.textContent = `${planLabel(x, y)} 颜色码 ${color}`;
                const note = document.createElement('span');
                note.className = 'oi33-map-plan__note';
                note.textContent = options.draft ? '待保存' : '等待执行';
                item.append(order, swatch, text, note);
                planStepsList.append(item);
            };
            pending.forEach((step, index) => appendItem(index, step.x, step.y, step.color, {
                next: index === 0,
            }));
            planDraft.forEach((step, index) => appendItem(
                pending.length + index, step.x, step.y, step.color, { draft: true },
            ));
            if (!plan && !planDraft.length) {
                const empty = document.createElement('li');
                empty.className = 'oi33-map-plan__empty';
                empty.textContent = '还没有步骤：点「添加步骤」后在地图上依次点击相邻格。';
                planStepsList.append(empty);
            }
        }
        if (planHint) {
            planHint.classList.toggle('is-picking', planPicking);
            planHint.textContent = planPicking
                ? '正在拾取：请点击地图上与上一步相邻的格子（再次点「添加步骤」或按 Esc 退出）。'
                : `每步 = 移动到相邻格并涂色（3g 猫粮，正好用掉当次免冷却染色），最多 ${planLimit()} 步且路径必须连续。`
                + '冷却结束后自动执行下一步；猫粮不足、目标格是其他大猫的领地核心、被手动操作或驱逐时会自动停止并私信通知。';
        }
        if (planSaveButton) {
            planSaveButton.textContent = plan ? '追加到运行中的计划' : '保存并开始';
            planSaveButton.disabled = !planDraft.length;
        }
        if (planAddButton) {
            planAddButton.classList.toggle('is-active', planPicking);
            planAddButton.textContent = planPicking ? '退出拾取' : '添加步骤';
            planAddButton.disabled = total >= planLimit() && !planPicking;
        }
        if (planUndoButton) planUndoButton.disabled = !planDraft.length;
        if (planClearButton) planClearButton.disabled = !planDraft.length;
        if (planCancelButton) planCancelButton.hidden = !plan;
        // 显式收起优先；显式展开次之；否则「有计划/草稿/正在拾取」时自动显示。
        if (planPanel) {
            planPanel.hidden = planPanel.dataset.closed === '1'
                ? true
                : planPanel.dataset.opened !== '1' && !plan && !planDraft.length && !planPicking;
        }
    };

    const setPlanPicking = (on: boolean) => {
        planPicking = on;
        viewport.classList.toggle('is-plan-picking', on);
        renderPlanPanel();
    };

    // 与 openActionDialog 相同的核心格判断：目标格是别的大猫的领地核心则进不去。
    const planCellBlocked = (x: number, y: number) => {
        const fortressCatId = fortressCatIdAt(x, y);
        return !!fortressCatId && fortressCatId !== (bigCats?.boundCatId() || 0);
    };

    const openPlanStepDialog = (x: number, y: number) => {
        if (!planStepDialog) return;
        const total = (activePlan()?.steps.length || 0) + planDraft.length;
        if (total >= planLimit()) {
            Notification.error(`计划最多 ${planLimit()} 步。`);
            return;
        }
        planStepTarget = { x, y };
        const title = planStepDialog.querySelector<HTMLElement>('[data-plan-step-title]');
        const summary = planStepDialog.querySelector<HTMLElement>('[data-plan-step-summary]');
        if (title) title.textContent = `添加第 ${total + 1} 步`;
        if (summary) {
            const me = state.me;
            const cost = me ? `当前猫粮 ${me.food}g` : '尚未加入广场';
            summary.textContent = `目标 ${planLabel(x, y)}（与上一步相邻）· 这一步会消耗 3g 猫粮并把该格涂成所选颜色。${cost}。`;
        }
        const input = planStepDialog.querySelector<HTMLInputElement>('[data-color-input]');
        if (input) {
            const currentColor = cellColors[y * MAP_WIDTH + x];
            input.value = String(currentColor >= 0 ? currentColor : 34);
            input.dispatchEvent(new Event('input'));
        }
        planStepDialog.showModal();
    };

    const applyPlanView = (plan: MapPlan | null) => {
        state.plan = plan;
        if (plan && typeof plan.maxSteps === 'number') state.planMaxSteps = plan.maxSteps;
        renderPlanPanel();
        updateMeStatus();
        invalidate();
    };

    const savePlan = async () => {
        if (!planDraft.length) return;
        if (!state.me) {
            Notification.error('请先加入猫猫广场再规划路线。');
            return;
        }
        const plan = activePlan();
        if (planSaveButton) planSaveButton.disabled = true;
        try {
            const response = await request.post(planUrl, {
                steps: JSON.stringify(planDraft),
                mode: plan ? 'append' : 'replace',
            });
            const executed = response?.result?.step;
            planDraft.length = 0;
            setPlanPicking(false);
            applyPlanView(response?.plan || null);
            if (executed) {
                Notification.success(`计划已开始：第 ${executed.index + 1} 步已执行——移动到${planLabel(executed.x, executed.y)}并涂色 ${executed.color}。`);
            } else {
                Notification.success('计划已保存，冷却结束后会自动执行下一步。');
            }
        } catch (e: any) {
            Notification.error(e.message || String(e));
        } finally {
            renderPlanPanel();
        }
    };

    const cancelPlan = async () => {
        if (planCancelButton) planCancelButton.disabled = true;
        try {
            const response = await request.post(planCancelUrl, {});
            planDraft.length = 0;
            setPlanPicking(false);
            applyPlanView(response?.plan || null);
            Notification.success('已取消路径计划。');
        } catch (e: any) {
            Notification.error(e.message || String(e));
        } finally {
            if (planCancelButton) planCancelButton.disabled = false;
            renderPlanPanel();
        }
    };

    // 计划叠加：不画任何连线，只在每个「尚未执行」的计划格上放一个编号圆圈——
    // 圆圈底色就是该步的颜色码，编号用黑/白中更清楚的那个（深底白字、浅底黑字）。
    // 圆圈只表示未来：已经走过的步骤会随光标本步推进立刻消失，剩下的圆圈重新从 1
    // 编号；计划全部执行完（或已停止）时不画任何圆圈。草稿步骤接在剩余步骤之后。
    // 同一个格子只显示一个编号：路径允许折返，重复编号会互相覆盖。
    const drawPlanOverlay = (origin: { x: number; y: number }) => {
        const pending = planPending();
        const points: Array<{ x: number; y: number; color: number; next: boolean; draft: boolean; label: number }> = [];
        const seen = new Set<string>();
        const push = (x: number, y: number, color: number, next: boolean, draft: boolean, label: number) => {
            const key = cellKey(x, y);
            if (seen.has(key)) return;
            seen.add(key);
            points.push({
                x, y, color, next, draft, label,
            });
        };
        pending.forEach((step, index) => push(
            step.x, step.y, step.color, index === 0, false, index + 1,
        ));
        planDraft.forEach((step, index) => push(
            step.x, step.y, step.color, false, true, pending.length + index + 1,
        ));
        if (!points.length) return;
        const radius = Math.max(6, Math.min(16, viewScale * .34));
        context.save();
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.font = `bold ${Math.max(8, radius)}px sans-serif`;
        for (const point of points) {
            const px = origin.x + (point.x + .5) * viewScale;
            const py = origin.y + (point.y + .5) * viewScale;
            context.beginPath();
            context.arc(px, py, point.next ? radius * 1.18 : radius, 0, Math.PI * 2);
            context.fillStyle = paletteColor(point.color);
            context.fill();
            context.setLineDash(point.draft ? [Math.max(2, radius * .35), Math.max(2, radius * .28)] : []);
            context.lineWidth = point.next ? 3 : Math.max(1, radius * .14);
            context.strokeStyle = point.next ? 'rgba(214,60,60,.95)' : 'rgba(0,0,0,.55)';
            context.stroke();
            context.setLineDash([]);
            context.fillStyle = paletteTextColor(point.color);
            context.fillText(String(point.label), px, py);
        }
        context.restore();
    };

    const openActionDialog = (x: number, y: number) => {
        if (!actionDialog) return;
        const joining = !state.me && state.canJoin;
        if (!state.me && !joining) return;
        const me = state.me;
        if (me && me.x === x && me.y === y) {
            Notification.error('小猫已经在这个格子里。');
            return;
        }
        selectedTarget = { x, y };
        const distance = me ? Math.abs(me.x - x) + Math.abs(me.y - y) : 0;
        const adjacent = distance === 1;
        const territoryTeleport = isOwnTerritoryTeleport(me, x, y);
        const fortressCatId = fortressCatIdAt(x, y);
        const fortressBlocked = !!fortressCatId && fortressCatId !== (bigCats?.boundCatId() || 0);
        const contributes = !!(bigCats?.boundCatId());
        const title = actionDialog.querySelector<HTMLElement>('[data-action-title]');
        const message = actionDialog.querySelector<HTMLElement>('[data-action-message]');
        const confirm = actionDialog.querySelector<HTMLButtonElement>('[data-action-confirm]');
        const cooling = !!me && me.availableAt > now();
        const lacksResource = !!me && (adjacent || territoryTeleport ? me.food < 3 : me.cans < 3);
        if (title) title.textContent = fortressBlocked
            ? '大猫领地核心'
            : joining
                ? '加入猫猫广场'
                : adjacent
                    ? '移动到相邻格'
                    : territoryTeleport
                        ? '大猫领地内传送'
                        : '传送到目标格';
        if (message) {
            if (fortressBlocked) message.textContent = `目标（行 ${y}, 列 ${x}）位于 00区大猫领地核心，上下左右均归属同一大猫，只有绑定该大猫的小猫才能进入。`;
            else if (joining) message.textContent = `是否免费选择（行 ${y}, 列 ${x}）作为小猫的初始位置？首次加入不消耗资源，也不触发冷却。`;
            else if (cooling) message.textContent = `目标（行 ${y}, 列 ${x}）。所有操作共享冷却，可用时间：${new Date(me!.availableAt).toLocaleString('zh-CN')}。`;
            else if (adjacent) message.textContent = `是否使用 3g 猫粮移动到（行 ${y}, 列 ${x}）？当前余额 ${me!.food}g。${contributes ? '这 3g 会同时计入当前大猫贡献。' : '当前未绑定大猫，本次不计入大猫贡献。'}`;
            else if (territoryTeleport) message.textContent = `起点和目标都在你当前大猫的领地内，是否使用 3g 猫粮传送到（行 ${y}, 列 ${x}）？当前余额 ${me!.food}g。这 3g 会同时计入当前大猫贡献。`;
            else message.textContent = `是否使用 3 个猫罐头传送到（行 ${y}, 列 ${x}）？当前持有 ${me!.cans} 个猫罐头。`;
        }
        if (confirm) confirm.disabled = fortressBlocked || cooling || lacksResource;
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
        const index = y * MAP_WIDTH + x;
        const zone = isCoreZone(x, y) ? '00区' : '帝国区';
        const occupation = cellColors[index] >= 0
            ? `大猫归属：${bigCats?.labelFor(cellCatIds[index]) || '正在读取'}。`
            : '该格尚未涂色，没有大猫归属。';
        const fortress = fortressCatIdAt(x, y)
            ? '该格处于大猫领地核心，非归属大猫的小猫禁止进入。'
            : '';
        if (summary) summary.textContent = (occupants.length
            ? `这里有 ${occupants.length} 只小猫；地图显示猫罐头最多的 ${occupants[0].uname}。`
            : '这里暂时没有小猫。') + `所在区域：${zone}。` + occupation + fortress;
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
            const territoryTeleport = isOwnTerritoryTeleport(me, x, y);
            const fortressBlocked = !!fortressCatIdAt(x, y)
                && fortressCatIdAt(x, y) !== (bigCats?.boundCatId() || 0);
            action.hidden = !canAct || sameCell;
            action.textContent = fortressBlocked
                ? '禁止进入（大猫领地核心）'
                : joining
                    ? '免费加入这里'
                    : adjacent
                        ? '移动到这里（3g）'
                        : territoryTeleport
                            ? '领地传送到这里（3g）'
                            : '传送到这里（3 个罐头）';
            action.disabled = fortressBlocked;
        }
        cellDialog.showModal();
    };

    const clickCell = (x: number, y: number) => {
        if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) return;
        // 规划拾取模式：点格子即添加一步；校验连续性，非法时只提示不改动。
        if (planPicking) {
            if (!state.me) {
                Notification.error('请先加入猫猫广场再规划路线。');
                return;
            }
            const base = planBase();
            if (!base) {
                Notification.error('暂时无法确定计划起点。');
                return;
            }
            if (Math.abs(base.x - x) + Math.abs(base.y - y) !== 1) {
                Notification.error(`计划路径必须连续：${planLabel(x, y)} 与上一步${planLabel(base.x, base.y)}不相邻。`);
                return;
            }
            if (planCellBlocked(x, y)) {
                Notification.error(`${planLabel(x, y)} 是其他大猫的领地核心，只有绑定该大猫的小猫才能进入。`);
                return;
            }
            openPlanStepDialog(x, y);
            return;
        }
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
            // 两种底图视角都保留格子操作，领地内传送可直接点目标格。
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
        if (layer === 'bigcats') showBigCats = !showBigCats;
        if (layer === 'names') showNames = !showNames;
        if (layer === 'empireBorder') showEmpireBorder = !showEmpireBorder;
        const active = layer === 'grid' ? showGrid
            : layer === 'cats' ? showCats
                : layer === 'bigcats' ? showBigCats
                    : layer === 'empireBorder' ? showEmpireBorder
                        : showNames;
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
        if (event.altKey || event.ctrlKey || event.metaKey || cellDialog?.open || actionDialog?.open || colorDialog?.open || planStepDialog?.open || bigCats?.isDialogOpen()) return;
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
    const openPlanPanel = (open: boolean) => {
        if (!planPanel) return;
        if (open) {
            planPanel.dataset.opened = '1';
            delete planPanel.dataset.closed;
        } else {
            planPanel.dataset.closed = '1';
            delete planPanel.dataset.opened;
        }
        planToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
        renderPlanPanel();
    };
    planToggle?.addEventListener('click', () => openPlanPanel(!!planPanel?.hidden));
    planCloseButton?.addEventListener('click', () => openPlanPanel(false));
    planAddButton?.addEventListener('click', () => {
        openPlanPanel(true);
        if (planPicking) {
            setPlanPicking(false);
            return;
        }
        if (!state.me) {
            Notification.error('请先加入猫猫广场再规划路线。');
            return;
        }
        const total = (activePlan()?.steps.length || 0) + planDraft.length;
        if (total >= planLimit()) {
            Notification.error(`计划最多 ${planLimit()} 步。`);
            return;
        }
        setPlanPicking(true);
        const base = planBase();
        if (base) {
            centerAt(base.x, base.y);
            Notification.success(`请点击${planLabel(base.x, base.y)}相邻的格子来添加第 ${total + 1} 步。`);
        }
    });
    planUndoButton?.addEventListener('click', () => {
        planDraft.pop();
        renderPlanPanel();
    });
    planClearButton?.addEventListener('click', () => {
        planDraft.length = 0;
        renderPlanPanel();
    });
    planSaveButton?.addEventListener('click', () => { savePlan(); });
    planCancelButton?.addEventListener('click', () => {
        if (!window.confirm('取消当前路径计划？已经执行的步骤不会回滚。')) return;
        cancelPlan();
    });
    planStepDialog?.querySelector<HTMLButtonElement>('[data-plan-step-confirm]')?.addEventListener('click', () => {
        const input = planStepDialog?.querySelector<HTMLInputElement>('[data-color-input]');
        if (!planStepTarget || !input) return;
        const color = Math.max(0, Math.min(255, Math.floor(Number(input.value) || 0)));
        planDraft.push({ x: planStepTarget.x, y: planStepTarget.y, color });
        planStepDialog?.close();
        renderPlanPanel();
        const total = (activePlan()?.steps.length || 0) + planDraft.length;
        if (total >= planLimit()) {
            setPlanPicking(false);
            Notification.success(`已添加第 ${total} 步，达到步数上限 ${planLimit()} 步，已退出拾取模式。`);
        } else {
            Notification.success(`已添加第 ${total} 步，请继续点击相邻格（按 Esc 退出拾取）。`);
        }
    });
    document.addEventListener('keydown', (event) => {
        if (!planPicking || event.key !== 'Escape') return;
        if (planStepDialog?.open) return;
        setPlanPicking(false);
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
            if (!joining && state.me
                && state.me.x === selectedTarget.x && state.me.y === selectedTarget.y) {
                Notification.error('小猫已经在这个格子里。');
                actionDialog.close();
                return;
            }
            const result = await request.post(joining ? joinUrl : moveUrl, selectedTarget);
            applyPlayerUpdate({ ...result, uid: userId });
            if (joining) state.canJoin = false;
            const contributionText = result.contributedCatId
                ? '这 3g 已同时计入当前大猫贡献，'
                : '当前未绑定大猫，本次未计入大猫贡献，';
            Notification.success(result.action === 'join'
                ? '加入成功，首次选择位置免费且没有触发冷却。'
                : result.action === 'move'
                    ? `移动成功，已销毁 3g 猫粮；${contributionText}并获得 1 次免冷却染色。`
                    : result.action === 'territory_teleport'
                        ? `领地内传送成功，已销毁 3g 猫粮；${contributionText}并获得 1 次免冷却染色。`
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
            setCell(result.x, result.y, result.color, result.catId);
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

    let firstMapLoad = true;
    const loadMapState = async () => {
        const incoming: MapState = await request.get(stateUrl);
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
        cellCatIds.fill(-1);
        incoming.cells.forEach(([x, y, color, catId]) => {
            if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) return;
            const index = y * MAP_WIDTH + x;
            cellColors[index] = color;
            const key = Number(catId);
        cellCatIds[index] = Number.isSafeInteger(key) ? key : 0;
        });
        rebuildOverviewLayer();
        rebuildTerritoryLayer();
        state.me = userId ? players.get(userId) || null : null;
        if (typeof incoming.planMaxSteps === 'number') state.planMaxSteps = incoming.planMaxSteps;
        // 运行中的计划可以接着追加，所以刷新状态时必须保留尚未提交的草稿。
        state.plan = incoming.plan || null;
        renderPlanPanel();
        if (firstMapLoad) {
            const focusedPlayer = focusUserId ? players.get(focusUserId) : null;
            if (focusedPlayer) {
                centerAt(focusedPlayer.x, focusedPlayer.y);
                if (coordinate) coordinate.textContent = `格子：（行 ${focusedPlayer.y}, 列 ${focusedPlayer.x}）`;
            } else if (state.me) centerAt(state.me.x, state.me.y);
            // Keep the preserved legacy artwork in view for visitors without
            // a cat position; expansion adds space to its right and bottom.
            else centerAt(LEGACY_MAP_WIDTH / 2, LEGACY_MAP_HEIGHT / 2);
            if (focusUserId && !focusedPlayer) Notification.error('该用户的小猫尚未加入猫猫广场。');
            firstMapLoad = false;
        }
        updateStats();
        updateMeStatus();
        loading?.classList.add('is-hidden');
    };

    // 路径规划的兜底实时性：计划只能由服务端推进，前端用两条路径保持圆圈准确——
    // WebSocket 的 plan 推送（正常情况），以及「计划已到点但视图还没变」时拉取计划
    // 状态（推送丢失或调度延迟）。两个请求都带 updatedAt，响应较旧时不会回退视图。
    const syncPlanState = () => {
        const plan = activePlan();
        if (!plan || plan.cursor >= plan.steps.length) return;
        // 没有 nextAt 的旧视图不值得兜底轮询（服务端下次调度会自行推进）。
        if (!plan.nextAt || now() < plan.nextAt + PLAN_SYNC_OVERDUE_MS) return;
        // 反复没拿到新视图（调度器停摆等）时退避，避免一直打服务端。
        const interval = planSyncTries >= PLAN_SYNC_RETRY_LIMIT
            ? PLAN_SYNC_BACKOFF_MS
            : PLAN_SYNC_INTERVAL_MS;
        if (planSyncing || Date.now() - planSyncedAt < interval) return;
        planSyncing = true;
        planSyncedAt = Date.now();
        request.get(planStateUrl).then((response: any) => {
            const incoming = response?.plan || null;
            const current = state.plan;
            // 只有更新的视图才能覆盖，避免迟到的响应把刚推进的计划画回去。
            if (incoming && (!current || Number(incoming.updatedAt) >= Number(current.updatedAt))) {
                if (typeof response.planMaxSteps === 'number') state.planMaxSteps = response.planMaxSteps;
                applyPlanView(incoming);
            }
            // 拉到的还是同一步就继续按退避节奏重试，视图一变就恢复高频兜底。
            planSyncTries = current && incoming && Number(incoming.updatedAt) === Number(current.updatedAt)
                ? planSyncTries + 1
                : 0;
        }).catch(() => {
            // 失败就等下一次到点再试，用户仍会在收到推送时看到正确的圆圈。
            planSyncTries += 1;
        }).finally(() => {
            planSyncing = false;
        });
    };

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
        if (payload.type === 'cell' && Array.isArray(payload.cell)) {
            setCell(payload.cell[0], payload.cell[1], payload.cell[2], payload.cell[3]);
        }
        if (payload.type === 'bigcat') bigCats?.handleSocketMessage(payload);
        if (payload.type === 'rect' && Array.isArray(payload.rect)) {
            setRect(payload.rect[0], payload.rect[1], payload.rect[2], payload.rect[3], payload.rect[4], payload.rect[5]);
        }
        if (payload.type === 'territory_refresh') {
            Promise.all([loadMapState(), bigCats?.refresh()]).catch((e) => {
                Notification.error(`大猫归属刷新失败：${e.message || e}`);
            });
        }
        if (payload.type === 'cooldown' && Number(payload.uid) === userId && state.me) {
            state.me.availableAt = payload.availableAt ? new Date(payload.availableAt).getTime() : 0;
            state.me.freeColorAvailable = !!payload.freeColorAvailable;
        }
        // 计划是私密数据：服务端只把 targetUid 的事件发给本人，这里再确认一次。
        if (payload.type === 'plan' && Number(payload.targetUid) === userId) {
            const incoming = payload.plan || null;
            const current = state.plan;
            // 只接受不更旧的视图：兜底拉取与推送可能交错到达。
            if (!incoming || !current || Number(incoming.updatedAt) >= Number(current.updatedAt)) {
                applyPlanView(incoming);
            }
            if (payload.stopped) {
                Notification.error(`路径计划已停止：${payload.reason || '未知原因'}`);
            } else if (payload.step) {
                Notification.success(`计划第 ${payload.step.index + 1} 步：已移动到${planLabel(payload.step.x, payload.step.y)}并涂色 ${payload.step.color}。`);
            }
            if (payload.finished) Notification.success('路径计划已全部执行完成。');
        }
    });

    window.addEventListener('resize', resize);
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => resize()).observe(viewport);
    }
    loadMapState().catch((e) => {
        if (loading) loading.textContent = `地图加载失败：${e.message || e}`;
    });
    resize();
    render();
}

addPage(new NamedPage(['oi33_cat_can_arena', 'oi33_cat_can_arena_admin'], mountMap));
