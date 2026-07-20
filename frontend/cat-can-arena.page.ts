import {
    addPage, NamedPage, Notification, request, Socket,
} from '@hydrooj/ui-default';
import './cat-can-arena.css';

const MAP_WIDTH = 640;
const MAP_HEIGHT = 480;
const DEFAULT_GRID_SCALE = 52;

interface MapPlayer {
    uid: number;
    uname: string;
    x: number;
    y: number;
    cans: number;
    food: number;
    availableAt: number;
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
    const actionDialog = document.querySelector<HTMLDialogElement>('[data-map-action-dialog]');
    const colorDialog = document.querySelector<HTMLDialogElement>('[data-map-color-dialog]');
    const sprite = new Image();
    const spriteSheet = document.createElement('canvas');
    spriteSheet.width = 100;
    spriteSheet.height = 100;
    sprite.src = viewport.dataset.spriteUrl || '/oi33-cat-sprites.svg';
    sprite.addEventListener('load', () => spriteSheet.getContext('2d')?.drawImage(sprite, 0, 0, 100, 100));

    let state: MapState = { width: MAP_WIDTH, height: MAP_HEIGHT, players: [], cells: [], me: null, canJoin: false, serverTime: Date.now() };
    const players = new Map<number, MapPlayer>();
    const cells = new Map<string, number>();
    const overviewLayer = document.createElement('canvas');
    overviewLayer.width = MAP_WIDTH;
    overviewLayer.height = MAP_HEIGHT;
    const overviewContext = overviewLayer.getContext('2d')!;
    overviewContext.fillStyle = '#ffffff';
    overviewContext.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    const animations = new Map<number, { fromX: number; fromY: number; toX: number; toY: number; start: number; teleport: boolean }>();
    let mode: 'near' | 'pixel' = 'near';
    let gridScale = DEFAULT_GRID_SCALE;
    let cameraX = MAP_WIDTH / 2;
    let cameraY = MAP_HEIGHT / 2;
    let pixelScale = 1;
    let pixelOffsetX = 0;
    let pixelOffsetY = 0;
    let pixelInitialized = false;
    let drag: {
        x: number; y: number; cameraX: number; cameraY: number;
        pixelOffsetX: number; pixelOffsetY: number; moved: boolean;
    } | null = null;
    let selectedTarget: { x: number; y: number } | null = null;
    let selectedColorCell: { x: number; y: number } | null = null;
    let clockOffset = 0;

    const now = () => Date.now() + clockOffset;
    const cellKey = (x: number, y: number) => `${x}:${y}`;
    const setCell = (x: number, y: number, color: number) => {
        cells.set(cellKey(x, y), color);
        overviewContext.fillStyle = paletteColor(color);
        overviewContext.fillRect(x, y, 1, 1);
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
            for (let column = columnStart; column <= columnEnd; column++) {
                cells.set(cellKey(column, row), color);
            }
        }
    };
    const resize = () => {
        const ratio = window.devicePixelRatio || 1;
        const rect = viewport.getBoundingClientRect();
        canvas.width = Math.max(1, Math.round(rect.width * ratio));
        canvas.height = Math.max(1, Math.round(rect.height * ratio));
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        clampCamera();
        if (!pixelInitialized) fitPixelView();
        else clampPixelView();
    };
    const viewSize = () => ({ width: canvas.clientWidth, height: canvas.clientHeight });
    const clampCamera = () => {
        const view = viewSize();
        const visibleColumns = view.width / gridScale;
        const visibleRows = view.height / gridScale;
        cameraX = Math.max(0, Math.min(MAP_WIDTH - visibleColumns, cameraX));
        cameraY = Math.max(0, Math.min(MAP_HEIGHT - visibleRows, cameraY));
    };
    const centerAt = (x: number, y: number) => {
        const view = viewSize();
        cameraX = x + .5 - view.width / gridScale / 2;
        cameraY = y + .5 - view.height / gridScale / 2;
        clampCamera();
    };
    const clampPixelView = () => {
        const view = viewSize();
        const margin = 70;
        const mapWidth = MAP_WIDTH * pixelScale;
        const mapHeight = MAP_HEIGHT * pixelScale;
        pixelOffsetX = Math.min(view.width - margin, Math.max(margin - mapWidth, pixelOffsetX));
        pixelOffsetY = Math.min(view.height - margin, Math.max(margin - mapHeight, pixelOffsetY));
    };
    const fitPixelView = () => {
        const view = viewSize();
        pixelScale = Math.min(view.width / MAP_WIDTH, view.height / MAP_HEIGHT);
        pixelOffsetX = (view.width - MAP_WIDTH * pixelScale) / 2;
        pixelOffsetY = (view.height - MAP_HEIGHT * pixelScale) / 2;
        pixelInitialized = true;
    };
    const centerPixelAt = (column: number, row: number) => {
        const view = viewSize();
        pixelOffsetX = view.width / 2 - (column + .5) * pixelScale;
        pixelOffsetY = view.height / 2 - (row + .5) * pixelScale;
        clampPixelView();
    };
    const updateStats = () => {
        if (catCount) catCount.textContent = String(players.size);
    };
    const updateMeStatus = () => {
        if (!meStatus || !userId) return;
        if (!state.me) {
            meStatus.textContent = state.canJoin ? '点击任意空格免费加入' : '完成认证后可参与';
            return;
        }
        const remaining = Math.max(0, state.me.availableAt - now());
        const totalSeconds = Math.ceil(remaining / 1000);
        const cooldown = totalSeconds
            ? `冷却 ${String(Math.floor(totalSeconds / 3600)).padStart(2, '0')}:${String(Math.floor(totalSeconds / 60) % 60).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`
            : '现在可操作';
        const text = `我的猫粮 ${state.me.food}g · 🥫${state.me.cans} · ${cooldown}`;
        if (meStatus.textContent !== text) meStatus.textContent = text;
    };

    const drawCat = (player: MapPlayer, px: number, py: number, walking: boolean) => {
        const phase = Math.floor(now() / 1700 + player.uid) % 3;
        let frameX = phase === 1 ? 1 : 0;
        let frameY = phase === 2 ? 1 : 0;
        if (walking) {
            frameX = Math.floor(now() / 180) % 2;
            frameY = 1;
        }
        const catSize = gridScale * .72;
        const catX = px + (gridScale - catSize) / 2;
        const catY = py + gridScale - catSize - Math.max(2, gridScale * .04);
        context.save();
        context.fillStyle = player.uid === userId ? 'rgba(255,215,94,.32)' : 'rgba(0,0,0,.2)';
        context.beginPath();
        context.ellipse(px + gridScale / 2, py + gridScale - Math.max(2, gridScale * .05), catSize * .36, catSize * .11, 0, 0, Math.PI * 2);
        context.fill();
        if (sprite.complete && sprite.naturalWidth) {
            context.imageSmoothingEnabled = false;
            context.drawImage(spriteSheet, frameX * 50, frameY * 50, 50, 50, catX, catY, catSize, catSize);
        } else {
            context.font = `${catSize * .8}px sans-serif`;
            context.fillText('🐈', catX, catY + catSize * .8);
        }
        context.restore();
    };

    const catLabelRect = (player: MapPlayer, px: number, py: number) => {
        const label = `${player.uname} · 🥫${player.cans}`;
        context.font = 'bold 11px sans-serif';
        const labelWidth = Math.min(150, context.measureText(label).width + 9);
        return { label, x: px + gridScale / 2 - labelWidth / 2, y: py - 7, width: labelWidth, height: 16 };
    };

    const drawCatLabel = (player: MapPlayer, px: number, py: number) => {
        const rect = catLabelRect(player, px, py);
        context.save();
        context.fillStyle = player.uid === userId ? 'rgba(111,75,9,.9)' : 'rgba(13,27,18,.82)';
        context.fillRect(rect.x, rect.y, rect.width, rect.height);
        context.fillStyle = '#fff';
        context.font = 'bold 11px sans-serif';
        context.textAlign = 'center';
        context.fillText(rect.label, rect.x + rect.width / 2, py + 5, rect.width - 5);
        context.restore();
    };

    const renderOverview = (width: number, height: number) => {
        context.fillStyle = '#eef1ee';
        context.fillRect(0, 0, width, height);
        const mapWidth = MAP_WIDTH * pixelScale;
        const mapHeight = MAP_HEIGHT * pixelScale;
        context.imageSmoothingEnabled = false;
        context.drawImage(overviewLayer, pixelOffsetX, pixelOffsetY, mapWidth, mapHeight);
        context.strokeStyle = 'rgba(255,255,255,.12)';
        context.strokeRect(pixelOffsetX + .5, pixelOffsetY + .5, mapWidth - 1, mapHeight - 1);
    };

    const renderNear = (width: number, height: number) => {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        const firstX = Math.max(0, Math.floor(cameraX));
        const firstY = Math.max(0, Math.floor(cameraY));
        const lastX = Math.min(MAP_WIDTH - 1, Math.ceil(cameraX + width / gridScale));
        const lastY = Math.min(MAP_HEIGHT - 1, Math.ceil(cameraY + height / gridScale));
        for (let y = firstY; y <= lastY; y++) {
            for (let x = firstX; x <= lastX; x++) {
                const px = (x - cameraX) * gridScale;
                const py = (y - cameraY) * gridScale;
                context.fillStyle = cells.has(cellKey(x, y)) ? paletteColor(cells.get(cellKey(x, y))!) : '#ffffff';
                context.fillRect(px, py, gridScale, gridScale);
                context.strokeStyle = 'rgba(0,0,0,.72)';
                context.lineWidth = 1;
                context.strokeRect(Math.round(px) + .5, Math.round(py) + .5, gridScale, gridScale);
            }
        }
        const stacks = new Map<string, MapPlayer[]>();
        Array.from(players.values()).sort((a, b) => a.cans - b.cans || b.uid - a.uid).forEach((player) => {
            const key = cellKey(player.x, player.y);
            const group = stacks.get(key) || [];
            group.push(player);
            stacks.set(key, group);
        });
        const currentTime = performance.now();
        const labelCandidates: Array<{ player: MapPlayer; px: number; py: number }> = [];
        players.forEach((player) => {
            let drawX = player.x;
            let drawY = player.y;
            let walking = false;
            const animation = animations.get(player.uid);
            if (animation) {
                const elapsed = currentTime - animation.start;
                if (animation.teleport) {
                    if (elapsed < 700) {
                        context.save();
                        context.strokeStyle = `rgba(118,220,255,${1 - elapsed / 700})`;
                        context.lineWidth = 4;
                        context.beginPath();
                        context.arc((animation.toX - cameraX + .5) * gridScale, (animation.toY - cameraY + .5) * gridScale, 10 + elapsed / 28, 0, Math.PI * 2);
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
            if (drawX < firstX - 2 || drawX > lastX + 2 || drawY < firstY - 2 || drawY > lastY + 2) return;
            const stack = stacks.get(cellKey(player.x, player.y)) || [player];
            const stackIndex = stack.findIndex((item) => item.uid === player.uid);
            const offset = (stackIndex - (stack.length - 1) / 2) * 10;
            const px = (drawX - cameraX) * gridScale + offset;
            const py = (drawY - cameraY) * gridScale - Math.abs(offset) * .3;
            drawCat(player, px, py, walking);
            labelCandidates.push({ player, px, py });
        });
        const visibleLabels: Array<{ x: number; y: number; width: number; height: number }> = [];
        labelCandidates.sort((a, b) => b.player.cans - a.player.cans || a.player.uid - b.player.uid).forEach((candidate) => {
            const rect = catLabelRect(candidate.player, candidate.px, candidate.py);
            const overlaps = visibleLabels.some((other) => !(
                rect.x + rect.width + 2 < other.x
                || other.x + other.width + 2 < rect.x
                || rect.y + rect.height + 2 < other.y
                || other.y + other.height + 2 < rect.y
            ));
            if (overlaps) return;
            visibleLabels.push(rect);
            drawCatLabel(candidate.player, candidate.px, candidate.py);
        });
    };

    const render = () => {
        if (!canvas.isConnected) return;
        const { width, height } = viewSize();
        context.clearRect(0, 0, width, height);
        if (mode === 'pixel') renderOverview(width, height);
        else renderNear(width, height);
        updateMeStatus();
        window.requestAnimationFrame(render);
    };

    const setMode = (next: 'near' | 'pixel') => {
        mode = next;
        document.querySelectorAll<HTMLElement>('[data-map-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.mapMode === mode));
        if (mode === 'near' && state.me) centerAt(state.me.x, state.me.y);
        if (mode === 'pixel' && !pixelInitialized) fitPixelView();
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
            };
            players.set(added.uid, added);
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
        players.set(next.uid, next);
        if (next.uid === userId) {
            state.me = next;
            if (positionChanged && mode === 'near') centerAt(next.x, next.y);
        }
        updateStats();
        updateMeStatus();
    };

    const openColorDialog = (x: number, y: number) => {
        if (!colorDialog) return;
        if (state.me && state.me.availableAt > now()) {
            Notification.error(`所有地图操作共享冷却，请在 ${new Date(state.me.availableAt).toLocaleString('zh-CN')} 后再换颜色。`);
            return;
        }
        selectedColorCell = { x, y };
        const input = colorDialog.querySelector<HTMLInputElement>('[data-color-input]');
        if (input) {
            input.value = String(cells.get(cellKey(x, y)) ?? 34);
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
        const lacksResource = !!me && (adjacent ? me.food < 33 : me.cans < 1);
        if (title) title.textContent = joining ? '加入猫猫广场' : adjacent ? '移动到相邻格' : '传送到目标格';
        if (message) {
            if (joining) message.textContent = `是否免费选择（行 ${y}, 列 ${x}）作为小猫的初始位置？首次加入不消耗资源，也不触发冷却。`;
            else if (cooling) message.textContent = `目标（行 ${y}, 列 ${x}）。所有操作共享冷却，可用时间：${new Date(me!.availableAt).toLocaleString('zh-CN')}。`;
            else if (adjacent) message.textContent = `是否移动到（行 ${y}, 列 ${x}）？将销毁 33g 猫粮；当前余额 ${me!.food}g。`;
            else message.textContent = `是否传送到（行 ${y}, 列 ${x}）？将消耗 1 个猫罐头并退回虚拟储备池；当前持有 ${me!.cans} 个。`;
        }
        if (confirm) confirm.disabled = cooling || lacksResource;
        actionDialog.showModal();
    };

    const clickCell = (x: number, y: number) => {
        if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) return;
        const occupants = Array.from(players.values()).filter((player) => player.x === x && player.y === y);
        const own = occupants.find((player) => player.uid === userId);
        if (own) {
            openColorDialog(x, y);
            return;
        }
        if (!userId) {
            Notification.error('登录并完成认证后，才能加入猫猫广场。');
            return;
        }
        if (occupants.length) {
            Notification.error(`格子（行 ${y}, 列 ${x}）已经有 ${occupants[0].uname} 的小猫了。`);
            return;
        }
        if (!state.me && !state.canJoin) {
            Notification.error('只有已认证用户才能加入猫猫广场。');
            return;
        }
        openActionDialog(x, y);
    };

    const pointToCell = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        if (mode === 'near') return { x: Math.floor(cameraX + px / gridScale), y: Math.floor(cameraY + py / gridScale) };
        return {
            x: Math.floor((px - pixelOffsetX) / pixelScale),
            y: Math.floor((py - pixelOffsetY) / pixelScale),
        };
    };

    viewport.addEventListener('pointerdown', (event) => {
        drag = {
            x: event.clientX, y: event.clientY, cameraX, cameraY,
            pixelOffsetX, pixelOffsetY, moved: false,
        };
        viewport.setPointerCapture(event.pointerId);
        viewport.classList.add('is-dragging');
    });
    viewport.addEventListener('pointermove', (event) => {
        const cell = pointToCell(event.clientX, event.clientY);
        if (coordinate) coordinate.textContent = cell.x >= 0 && cell.x < MAP_WIDTH && cell.y >= 0 && cell.y < MAP_HEIGHT ? `格子：（行 ${cell.y}, 列 ${cell.x}）` : '格子：—';
        if (!drag) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (Math.hypot(dx, dy) > 5) drag.moved = true;
        if (mode === 'near') {
            cameraX = drag.cameraX - dx / gridScale;
            cameraY = drag.cameraY - dy / gridScale;
            clampCamera();
        } else {
            pixelOffsetX = drag.pixelOffsetX + dx;
            pixelOffsetY = drag.pixelOffsetY + dy;
            clampPixelView();
        }
    });
    viewport.addEventListener('pointerup', (event) => {
        const wasDrag = drag?.moved;
        drag = null;
        viewport.classList.remove('is-dragging');
        if (!wasDrag && mode === 'near') {
            const cell = pointToCell(event.clientX, event.clientY);
            clickCell(cell.x, cell.y);
        }
    });
    viewport.addEventListener('pointercancel', () => {
        drag = null;
        viewport.classList.remove('is-dragging');
    });
    viewport.addEventListener('wheel', (event) => {
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        const factor = Math.exp(-event.deltaY * 0.0015);
        if (mode === 'near') {
            const mapX = cameraX + pointerX / gridScale;
            const mapY = cameraY + pointerY / gridScale;
            gridScale = Math.max(28, Math.min(110, gridScale * factor));
            cameraX = mapX - pointerX / gridScale;
            cameraY = mapY - pointerY / gridScale;
            clampCamera();
            return;
        }
        const mapX = (pointerX - pixelOffsetX) / pixelScale;
        const mapY = (pointerY - pixelOffsetY) / pixelScale;
        pixelScale = Math.max(0.25, Math.min(48, pixelScale * factor));
        pixelOffsetX = pointerX - mapX * pixelScale;
        pixelOffsetY = pointerY - mapY * pixelScale;
        clampPixelView();
    }, { passive: false });

    document.querySelectorAll<HTMLButtonElement>('[data-map-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mapMode as any)));
    document.querySelector<HTMLButtonElement>('[data-map-find-me]')?.addEventListener('click', () => {
        if (!state.me) return Notification.error('当前账号还没有可定位的小猫。');
        setMode('near');
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
        if (mode === 'near') centerAt(column, row);
        else centerPixelAt(column, row);
        if (coordinate) coordinate.textContent = `格子：（行 ${row}, 列 ${column}）`;
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
                : result.action === 'move' ? '移动成功，已销毁 33g 猫粮。' : '传送成功，1 个猫罐头已回到虚拟储备池。');
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
            if (state.me) state.me.availableAt = result.availableAt ? new Date(result.availableAt).getTime() : 0;
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
            players.delete(uid);
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
        }
    });

    window.addEventListener('resize', resize);
    request.get(stateUrl).then((incoming: MapState) => {
        state = incoming;
        clockOffset = incoming.serverTime - Date.now();
        players.clear();
        incoming.players.forEach((player) => players.set(player.uid, { ...player, availableAt: Number(player.availableAt) || 0 }));
        cells.clear();
        overviewContext.fillStyle = '#ffffff';
        overviewContext.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
        incoming.cells.forEach(([x, y, color]) => setCell(x, y, color));
        state.me = userId ? players.get(userId) || null : null;
        if (state.me) centerAt(state.me.x, state.me.y);
        else centerAt(MAP_WIDTH / 2, MAP_HEIGHT / 2);
        updateStats();
        updateMeStatus();
        loading?.classList.add('is-hidden');
    }).catch((e) => {
        if (loading) loading.textContent = `地图加载失败：${e.message || e}`;
    });
    resize();
    render();
}

addPage(new NamedPage(['oi33_cat_can_arena', 'oi33_cat_can_arena_admin'], mountMap));
