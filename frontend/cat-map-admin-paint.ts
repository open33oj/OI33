import { request } from '@hydrooj/ui-default';
import { MAP_HEIGHT, MAP_WIDTH, MapState } from './cat-map-shared';
import { paletteColor } from './cat-map-palette';

export function mountAdminPaintForm() {
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
