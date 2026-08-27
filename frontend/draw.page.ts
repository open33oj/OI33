import { addPage, NamedPage } from '@hydrooj/ui-default';
import './draw.css';

function mountDrawEditor() {
    const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
    const canvas = el<HTMLCanvasElement>('board');
    if (!canvas) return () => { };

    // ---------- 状态 ----------
    let W = 16; let H = 16;
    let pixels: (string | null)[][] = []; // pixels[y][x] = '#rrggbb' 或 null（透明）
    let tool = 'pencil';
    let color = '#e64545';
    let showGrid = true;
    let drawing = false;
    let undoStack: string[] = []; let redoStack: string[] = [];
    let sel: { x: number, y: number, w: number, h: number } | null = null;
    let selDrag: { x0: number, y0: number } | null = null;
    let clipboard: { w: number, h: number, rows: (string | null)[][] } | null = null;
    let floating: { w: number, h: number, rows: (string | null)[][], x: number, y: number } | null = null;
    let floatDrag: { dx: number, dy: number } | null = null;

    const ctx = canvas.getContext('2d')!;
    const canvasWrapEl = el('canvasWrap');
    const stageEl = canvasWrapEl.parentElement as HTMLElement;
    const RULER = 20; // 坐标标尺宽度（上：列号，左：行号）
    const MAX_RECENT = 18; // 最近使用颜色数量上限
    const LS_KEY = 'pixelArtHistory.v1';

    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

    const PRESET_COLORS = [
        '#000000', '#ffffff', '#e64545', '#f26d6d', '#f9a03f', '#f9d423', '#a6e3a1', '#40a02b',
        '#179299', '#04a5e5', '#1e66f5', '#7287fd', '#8839ef', '#ea76cb', '#dd7878', '#fe640b',
        '#df8e1d', '#6c6f85', '#9ca0b0', '#4c4f69', '#8c5a3c', '#c9a227', '#209fb5', '#dc8a78',
    ];

    // 标尺跟随 Hydro 明暗主题
    const isDarkTheme = () => document.body.classList.contains('theme--dark')
        || document.documentElement.getAttribute('data-mantine-color-scheme') === 'dark';

    // ---------- 背景模式 ----------
    const BG_MODES: Record<string, string> = {
        dark: 'repeating-conic-gradient(#585b70 0% 25%, #45475a 0% 50%) 0 0 / 20px 20px',
        light: 'repeating-conic-gradient(#ffffff 0% 25%, #c8c8c8 0% 50%) 0 0 / 20px 20px',
        'dark-sm': 'repeating-conic-gradient(#585b70 0% 25%, #45475a 0% 50%) 0 0 / 10px 10px',
        'light-sm': 'repeating-conic-gradient(#ffffff 0% 25%, #c8c8c8 0% 50%) 0 0 / 10px 10px',
        'solid-dark': '#45475a',
        'solid-light': '#c8c8c8',
        'solid-white': '#ffffff',
        none: 'transparent',
    };
    el<HTMLSelectElement>('bgSelect').onchange = (e) => {
        canvas.style.background = BG_MODES[(e.target as HTMLSelectElement).value] || BG_MODES.dark;
    };

    // ---------- 初始化画布尺寸 ----------
    // 全新空画布（仅启动时用；改尺寸请用 resizeGrid 保留内容）
    function newGrid(w: number, h: number) {
        W = w; H = h;
        pixels = Array.from({ length: h }, () => Array<string | null>(w).fill(null));
        undoStack = []; redoStack = [];
        sel = null; selDrag = null; floating = null; floatDrag = null;
        resizeCanvas();
        render();
    }

    // 动态调整尺寸：保留内容，按锚点方向裁去或添加（anchorX/Y：0=左/上，0.5=居中，1=右/下）
    let anchorX = 0.5; let anchorY = 0.5;
    function resizeGrid(w: number, h: number) {
        if (w === W && h === H) return;
        snapshot();
        const dx = Math.round((w - W) * anchorX);
        const dy = Math.round((h - H) * anchorY);
        const next = Array.from({ length: h }, () => Array<string | null>(w).fill(null));
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const nx = x + dx; const ny = y + dy;
                if (nx >= 0 && nx < w && ny >= 0 && ny < h) next[ny][nx] = pixels[y][x];
            }
        }
        W = w; H = h;
        pixels = next;
        sel = null; selDrag = null; floating = null; floatDrag = null;
        resizeCanvas();
        render();
        fixPanelOverlap(); // 画布变大后别被面板挡住
    }

    document.querySelectorAll<HTMLElement>('#anchorGrid button').forEach((b) => {
        b.onclick = () => {
            anchorX = +b.dataset.ax!;
            anchorY = +b.dataset.ay!;
            document.querySelectorAll<HTMLElement>('#anchorGrid button').forEach((x) => x.classList.toggle('active', x === b));
        };
    });

    // cell 随工作区宽度自适应，让画布尽量占满横向空间（4~64px）
    function resizeCanvas() {
        const avail = stageEl.clientWidth - 24 - RULER; // 减去卡片内边距和标尺
        const cell = clamp(Math.floor(avail / Math.max(W, H)), 4, 64);
        canvas.width = W * cell + RULER;
        canvas.height = H * cell + RULER;
        canvas.dataset.cell = String(cell);
    }

    // ---------- 渲染 ----------
    function outlineRect(rx: number, ry: number, rw: number, rh: number) {
        const cell = +canvas.dataset.cell!;
        const px = rx * cell; const py = ry * cell; const pw = rw * cell; const ph = rh * cell;
        ctx.save();
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
        ctx.lineDashOffset = 6;
        ctx.strokeStyle = '#ffffff';
        ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
        ctx.restore();
    }

    // 标尺：上面标列号，左边标行号（从 1 开始）
    function renderRulers() {
        const cell = +canvas.dataset.cell!;
        // 格子太小时每隔几个标一个，避免挤在一起
        const fs = Math.min(11, Math.max(7, cell * 0.55));
        let step = 1;
        while (cell * step < fs * 2.4) step *= 5;
        const dark = isDarkTheme();
        ctx.fillStyle = dark ? '#2a2a2c' : '#f2f3f5';
        ctx.fillRect(0, 0, canvas.width, RULER);
        ctx.fillRect(0, 0, RULER, canvas.height);
        ctx.strokeStyle = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, RULER + 0.5); ctx.lineTo(canvas.width, RULER + 0.5);
        ctx.moveTo(RULER + 0.5, 0); ctx.lineTo(RULER + 0.5, canvas.height);
        ctx.stroke();
        ctx.fillStyle = dark ? '#b0b6c8' : '#555a66';
        ctx.font = `${fs}px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let x = 0; x < W; x += step) ctx.fillText(String(x + 1), RULER + x * cell + cell / 2, RULER / 2 + 1);
        for (let y = 0; y < H; y += step) ctx.fillText(String(y + 1), RULER / 2, RULER + y * cell + cell / 2);
    }

    function render() {
        const cell = +canvas.dataset.cell!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(RULER, RULER); // 像素区整体右下偏移，给标尺留边
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                if (pixels[y][x]) {
                    ctx.fillStyle = pixels[y][x]!;
                    ctx.fillRect(x * cell, y * cell, cell, cell);
                }
            }
        }
        // 浮动粘贴块画在原内容之上
        if (floating) {
            for (let y = 0; y < floating.h; y++) {
                for (let x = 0; x < floating.w; x++) {
                    const v = floating.rows[y][x];
                    if (v && inBounds(floating.x + x, floating.y + y)) {
                        ctx.fillStyle = v;
                        ctx.fillRect((floating.x + x) * cell, (floating.y + y) * cell, cell, cell);
                    }
                }
            }
        }
        if (showGrid) {
            // 普通细网格（格子太小时省略，靠红色粗线分区）
            if (cell >= 6) {
                ctx.strokeStyle = 'rgba(0,0,0,0.25)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (let x = 0; x <= W; x++) { ctx.moveTo(x * cell + 0.5, 0); ctx.lineTo(x * cell + 0.5, H * cell); }
                for (let y = 0; y <= H; y++) { ctx.moveTo(0, y * cell + 0.5); ctx.lineTo(W * cell, y * cell + 0.5); }
                ctx.stroke();
            }
            // 每 5×5 格一条红色加粗线（含外框）
            ctx.strokeStyle = '#e64545';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let x = 0; x <= W; x += 5) { ctx.moveTo(x * cell, 0); ctx.lineTo(x * cell, H * cell); }
            for (let y = 0; y <= H; y += 5) { ctx.moveTo(0, y * cell); ctx.lineTo(W * cell, y * cell); }
            if (W % 5) { ctx.moveTo(W * cell, 0); ctx.lineTo(W * cell, H * cell); }
            if (H % 5) { ctx.moveTo(0, H * cell); ctx.lineTo(W * cell, H * cell); }
            ctx.stroke();
        }
        if (sel) outlineRect(sel.x, sel.y, sel.w, sel.h);
        if (floating) outlineRect(floating.x, floating.y, floating.w, floating.h);
        ctx.restore();
        renderRulers();
    }

    // ---------- 撤销 / 重做 ----------
    // 快照带上画布尺寸，撤销/重做可以跨过"调整尺寸"操作
    function serialize() { return JSON.stringify({ w: W, h: H, pixels }); }
    function snapshot() {
        undoStack.push(serialize());
        if (undoStack.length > 100) undoStack.shift();
        redoStack = [];
    }
    function restore(json: string) {
        const d = JSON.parse(json);
        pixels = d.pixels;
        if (d.w !== W || d.h !== H) { // 尺寸也变了：连同尺寸一起恢复
            W = d.w; H = d.h;
            sel = null; selDrag = null; floating = null; floatDrag = null;
            el<HTMLInputElement>('customW').value = String(W);
            el<HTMLInputElement>('customH').value = String(H);
            document.querySelectorAll<HTMLElement>('.size-btn').forEach((b) => b.classList.toggle('active', b.dataset.size === String(W) && W === H));
            resizeCanvas();
            fixPanelOverlap(); // 画布变大后别被面板挡住
        }
        render();
    }
    el('undoBtn').onclick = () => {
        if (!undoStack.length) return;
        redoStack.push(serialize());
        restore(undoStack.pop()!);
    };
    el('redoBtn').onclick = () => {
        if (!redoStack.length) return;
        undoStack.push(serialize());
        restore(redoStack.pop()!);
    };
    el('clearBtn').onclick = () => {
        if (!confirm('确定清空画布？')) return;
        snapshot();
        pixels = Array.from({ length: H }, () => Array<string | null>(W).fill(null));
        sel = null; floating = null;
        render();
    };

    // ---------- 坐标换算 ----------
    function cellFromEvent(e: PointerEvent) {
        const rect = canvas.getBoundingClientRect();
        const cell = +canvas.dataset.cell!;
        // 减去标尺宽度；点在标尺上会算出负数，被 inBounds 挡掉
        const x = Math.floor(((e.clientX - rect.left) * (canvas.width / rect.width) - RULER) / cell);
        const y = Math.floor(((e.clientY - rect.top) * (canvas.height / rect.height) - RULER) / cell);
        return { x, y };
    }
    const inBounds = (x: number, y: number) => x >= 0 && x < W && y >= 0 && y < H;

    // ---------- 工具动作 ----------
    function paint(x: number, y: number) {
        if (!inBounds(x, y)) return;
        const v = tool === 'eraser' ? null : color;
        if (pixels[y][x] !== v) { pixels[y][x] = v; render(); }
    }

    function floodFill(x: number, y: number, target: string | null, replacement: string) {
        if (target === replacement) return;
        const stack: [number, number][] = [[x, y]];
        while (stack.length) {
            const [cx, cy] = stack.pop()!;
            if (!inBounds(cx, cy) || pixels[cy][cx] !== target) continue;
            pixels[cy][cx] = replacement;
            stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
        }
        render();
    }

    // 取色：成功返回 true；点到透明像素返回 false
    function pickColor(x: number, y: number) {
        if (!inBounds(x, y) || !pixels[y][x]) return false;
        color = pixels[y][x]!.toLowerCase();
        el<HTMLInputElement>('colorPicker').value = color;
        pushRecent(color);
        refreshSwatchSelection();
        return true;
    }

    function applyTool(x: number, y: number) {
        if (!inBounds(x, y)) return;
        if (tool === 'pencil' || tool === 'eraser') {
            paint(x, y);
            if (tool === 'pencil') pushRecent(color);
        } else if (tool === 'fill') {
            floodFill(x, y, pixels[y][x], color);
            pushRecent(color);
        } else if (tool === 'picker') {
            if (pickColor(x, y)) setTool('pencil'); // 取到颜色后自动切回画笔
            // 点到透明像素时保持取色工具，方便继续点
        }
    }

    canvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        const { x, y } = cellFromEvent(e);
        // 有浮动粘贴块时：点框内拖动，点框外确认落笔
        if (floating) {
            if (x >= floating.x && x < floating.x + floating.w
                && y >= floating.y && y < floating.y + floating.h) {
                floatDrag = { dx: x - floating.x, dy: y - floating.y };
                return;
            }
            commitFloat();
        }
        // Alt + 点击 = 快速取色（任何工具下都可用）
        if (e.altKey) { pickColor(x, y); return; }
        if (tool === 'select') {
            if (!inBounds(x, y)) return;
            selDrag = { x0: x, y0: y };
            sel = { x, y, w: 1, h: 1 };
            render();
            return;
        }
        if (tool === 'pencil' || tool === 'eraser') { drawing = true; snapshot(); } else if (tool === 'fill') snapshot();
        applyTool(x, y);
    });
    canvas.addEventListener('pointermove', (e) => {
        const { x, y } = cellFromEvent(e);
        if (floatDrag && floating) {
            floating.x = clamp(x - floatDrag.dx, 0, Math.max(0, W - floating.w));
            floating.y = clamp(y - floatDrag.dy, 0, Math.max(0, H - floating.h));
            render();
            return;
        }
        if (selDrag) {
            const cx = clamp(x, 0, W - 1); const cy = clamp(y, 0, H - 1);
            sel = {
                x: Math.min(selDrag.x0, cx),
                y: Math.min(selDrag.y0, cy),
                w: Math.abs(cx - selDrag.x0) + 1,
                h: Math.abs(cy - selDrag.y0) + 1,
            };
            render();
            return;
        }
        if (!drawing) return;
        paint(x, y);
    });
    canvas.addEventListener('pointerup', () => {
        drawing = false;
        selDrag = null;
        floatDrag = null;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // ---------- 选区：复制 / 剪切 / 粘贴 ----------
    function copySel() {
        if (!sel) return;
        clipboard = {
            w: sel.w,
            h: sel.h,
            rows: Array.from({ length: sel.h }, (_, dy) => Array.from({ length: sel!.w }, (_, dx) => pixels[sel!.y + dy][sel!.x + dx])),
        };
    }

    function clearSelPixels() {
        for (let y = sel!.y; y < sel!.y + sel!.h; y++) {
            for (let x = sel!.x; x < sel!.x + sel!.w; x++) pixels[y][x] = null;
        }
    }

    function cutSel() {
        if (!sel) return;
        copySel();
        snapshot();
        clearSelPixels();
        sel = null;
        render();
    }

    function pasteClip() {
        if (!clipboard) return;
        if (floating) commitFloat();
        floating = {
            w: clipboard.w,
            h: clipboard.h,
            rows: clipboard.rows.map((r) => r.slice()),
            x: sel ? clamp(sel.x, 0, Math.max(0, W - clipboard.w)) : 0,
            y: sel ? clamp(sel.y, 0, Math.max(0, H - clipboard.h)) : 0,
        };
        render();
    }

    function commitFloat() {
        if (!floating) return;
        snapshot();
        for (let y = 0; y < floating.h; y++) {
            for (let x = 0; x < floating.w; x++) {
                const v = floating.rows[y][x];
                const fx = floating.x + x; const fy = floating.y + y;
                if (v && inBounds(fx, fy)) pixels[fy][fx] = v; // 透明像素不覆盖原图
            }
        }
        floating = null; floatDrag = null;
        render();
    }

    function deselect() {
        if (floating) { floating = null; floatDrag = null; }
        sel = null; selDrag = null;
        render();
    }

    el('copyBtn').onclick = copySel;
    el('cutBtn').onclick = cutSel;
    el('pasteBtn').onclick = pasteClip;
    el('deselectBtn').onclick = deselect;

    // ---------- 工具与颜色 UI ----------
    function setTool(t: string) {
        if (floating && t !== tool) commitFloat(); // 切换工具前先落定粘贴块
        tool = t;
        document.querySelectorAll<HTMLElement>('.tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    }
    document.querySelectorAll<HTMLElement>('.tool-btn').forEach((b) => {
        b.onclick = () => setTool(b.dataset.tool!);
    });

    el<HTMLInputElement>('colorPicker').oninput = (e) => {
        color = (e.target as HTMLInputElement).value;
        if (tool === 'eraser' || tool === 'picker') setTool('pencil');
        refreshSwatchSelection();
    };
    // 选择完成后记入"最近使用"
    el<HTMLInputElement>('colorPicker').onchange = (e) => pushRecent((e.target as HTMLInputElement).value);

    function makeSwatch(c: string) {
        const s = document.createElement('div');
        s.className = 'swatch';
        s.style.background = c;
        s.dataset.color = c;
        s.title = c;
        s.onclick = () => {
            color = c;
            el<HTMLInputElement>('colorPicker').value = c;
            if (tool === 'eraser' || tool === 'picker') setTool('pencil');
            refreshSwatchSelection();
        };
        return s;
    }

    const paletteEl = el('palette');
    function addPaletteColor(c: string) {
        c = c.toLowerCase();
        if (paletteEl.querySelector(`[data-color='${c}']`)) return;
        paletteEl.appendChild(makeSwatch(c));
    }
    PRESET_COLORS.forEach(addPaletteColor);

    // ---------- 最近使用（临时调色盘） ----------
    const recentEl = el('recentPalette');
    let recentColors: string[] = [];
    function pushRecent(c: string) {
        c = c.toLowerCase();
        recentColors = [c, ...recentColors.filter((v) => v !== c)].slice(0, MAX_RECENT);
        recentEl.innerHTML = '';
        recentColors.forEach((v) => recentEl.appendChild(makeSwatch(v)));
        refreshSwatchSelection();
    }

    function refreshSwatchSelection() {
        document.querySelectorAll<HTMLElement>('.swatch').forEach((s) => s.classList.toggle('selected', s.dataset.color === color));
    }
    refreshSwatchSelection();

    // ---------- 尺寸切换（保留内容，按方向锚点裁剪/扩展） ----------
    function markSizeBtn(size: number) {
        document.querySelectorAll<HTMLElement>('.size-btn').forEach((b) => b.classList.toggle('active', b.dataset.size === String(size)));
    }
    document.querySelectorAll<HTMLElement>('.size-btn').forEach((b) => {
        b.onclick = () => {
            const n = +b.dataset.size!;
            el<HTMLInputElement>('customW').value = String(n);
            el<HTMLInputElement>('customH').value = String(n);
            markSizeBtn(n);
            resizeGrid(n, n);
        };
    });
    el('applyCustom').onclick = () => {
        const w = Math.min(128, Math.max(1, +el<HTMLInputElement>('customW').value || 16));
        const h = Math.min(128, Math.max(1, +el<HTMLInputElement>('customH').value || 16));
        document.querySelectorAll<HTMLElement>('.size-btn').forEach((b) => b.classList.remove('active'));
        if (w === h && [8, 16, 32].includes(w)) markSizeBtn(w);
        resizeGrid(w, h);
    };

    el<HTMLInputElement>('gridToggle').onchange = (e) => { showGrid = (e.target as HTMLInputElement).checked; render(); };

    // ---------- 导出 PNG ----------
    el('exportPng').onclick = () => {
        const off = document.createElement('canvas');
        off.width = W; off.height = H;
        const octx = off.getContext('2d')!;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                if (pixels[y][x]) {
                    octx.fillStyle = pixels[y][x]!;
                    octx.fillRect(x, y, 1, 1);
                }
            }
        }
        const a = document.createElement('a');
        a.download = `pixel-art-${W}x${H}.png`;
        a.href = off.toDataURL('image/png');
        a.click();
    };

    // ---------- 导出 SVG ----------
    el('exportSvg').onclick = () => {
        const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">`];
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                if (pixels[y][x]) parts.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${pixels[y][x]}"/>`);
            }
        }
        parts.push('</svg>');
        const blob = new Blob([parts.join('\n')], { type: 'image/svg+xml' });
        const a = document.createElement('a');
        a.download = `pixel-art-${W}x${H}.svg`;
        a.href = URL.createObjectURL(blob);
        a.click();
        URL.revokeObjectURL(a.href);
    };

    // ---------- 载入一份数据（PNG 导入 / 历史加载共用） ----------
    function loadData(data: any) {
        const rows = data.rows || data.pixels;
        if (!data.width || !data.height || !Array.isArray(rows)) throw new Error('bad format');
        W = data.width; H = data.height;
        pixels = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => {
            const v = rows[y] && rows[y][x];
            return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
        }));
        undoStack = []; redoStack = [];
        sel = null; selDrag = null; floating = null; floatDrag = null;
        el<HTMLInputElement>('customW').value = String(W);
        el<HTMLInputElement>('customH').value = String(H);
        document.querySelectorAll<HTMLElement>('.size-btn').forEach((b) => b.classList.toggle('active', b.dataset.size === String(W) && W === H));
        resizeCanvas();
        render();
        fixPanelOverlap(); // 画布变大后别被面板挡住
    }

    // ---------- 导入 PNG（本地逐像素拆解，最大 128×128） ----------
    const importPngFile = el<HTMLInputElement>('importPngFile');
    el('importPng').onclick = () => importPngFile.click();
    importPngFile.onchange = () => {
        const file = importPngFile.files && importPngFile.files[0];
        importPngFile.value = ''; // 允许重复选同一文件
        if (!file) return;
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(img.src);
            const w = img.naturalWidth; const h = img.naturalHeight;
            if (!w || !h || w > 128 || h > 128) {
                alert(`图片尺寸 ${w}×${h} 不符合要求：仅支持 1×1 ~ 128×128 的 PNG。`);
                return;
            }
            const off = document.createElement('canvas');
            off.width = w; off.height = h;
            const octx = off.getContext('2d')!;
            octx.drawImage(img, 0, 0);
            const data = octx.getImageData(0, 0, w, h).data;
            const rows = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => {
                const i = (y * w + x) * 4;
                if (data[i + 3] < 128) return null; // 半透明/全透明像素视为透明
                const hex = (v: number) => v.toString(16).padStart(2, '0');
                return `#${hex(data[i])}${hex(data[i + 1])}${hex(data[i + 2])}`;
            }));
            try {
                loadData({ width: w, height: h, rows });
                alert(`已导入 ${w}×${h} 的 PNG！`);
            } catch {
                alert('导入失败：图片数据解析出错。');
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(img.src);
            alert('导入失败：无法解析该图片文件，请选择 PNG。');
        };
        img.src = URL.createObjectURL(file);
    };

    // ---------- 历史记录（localStorage） ----------
    interface HistoryItem { name: string, time: number, width: number, height: number, rows: (string | null)[][] }
    const historyListEl = el('historyList');

    function readHistory(): HistoryItem[] {
        try {
            const list = JSON.parse(localStorage.getItem(LS_KEY)!);
            return Array.isArray(list) ? list : [];
        } catch { return []; }
    }
    function writeHistory(list: HistoryItem[]) {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(list));
            return true;
        } catch {
            alert('保存失败：浏览器本地存储不可用或已满。');
            return false;
        }
    }

    el('saveLocal').onclick = () => {
        const nameInput = el<HTMLInputElement>('saveName');
        const name = nameInput.value.trim()
            || `未命名 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
        const list = readHistory();
        const exist = list.findIndex((it) => it.name === name);
        if (exist >= 0 && !confirm(`已存在同名作品「${name}」，覆盖它？`)) return;
        const record: HistoryItem = {
            name, time: Date.now(), width: W, height: H, rows: pixels,
        };
        if (exist >= 0) list[exist] = record; else list.unshift(record);
        if (writeHistory(list)) {
            nameInput.value = '';
            renderHistory();
        }
    };

    function renderHistory() {
        const list = readHistory();
        historyListEl.innerHTML = '';
        if (!list.length) {
            const p = document.createElement('p');
            p.className = 'oi33-draw-hint';
            p.textContent = '暂无保存记录。保存后即使关闭页面也能再次加载。';
            historyListEl.appendChild(p);
            return;
        }
        list.forEach((item) => {
            const div = document.createElement('div');
            div.className = 'history-item';

            const label = document.createElement('span');
            label.className = 'name';
            const date = new Date(item.time).toLocaleString('zh-CN', { hour12: false });
            label.textContent = `${item.name}（${item.width}×${item.height}，${date}）`;
            label.title = label.textContent;

            const loadBtn = document.createElement('button');
            loadBtn.className = 'dbtn';
            loadBtn.textContent = '加载';
            loadBtn.onclick = () => {
                try {
                    loadData(item);
                } catch {
                    alert('加载失败：这条记录的数据已损坏。');
                }
            };

            const delBtn = document.createElement('button');
            delBtn.className = 'dbtn';
            delBtn.textContent = '删除';
            delBtn.onclick = () => {
                if (!confirm(`删除作品「${item.name}」？`)) return;
                writeHistory(readHistory().filter((it) => it !== item));
                renderHistory();
            };

            div.append(label, loadBtn, delBtn);
            historyListEl.appendChild(div);
        });
    }
    renderHistory();

    // ---------- 快捷键 ----------
    const onKeydown = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement;
        const tag = target.tagName;
        // 只豁免真正的文本输入场景；颜色/复框/按钮类控件留着焦点时快捷键仍应生效
        if (tag === 'TEXTAREA') return;
        if (tag === 'INPUT' && /^(text|number|search|password|url|email)$/.test((target as HTMLInputElement).type)) return;
        if (e.ctrlKey && e.key === 'z') { e.preventDefault(); el('undoBtn').click(); return; }
        if (e.ctrlKey && e.key === 'y') { e.preventDefault(); el('redoBtn').click(); return; }
        if (e.ctrlKey && e.key === 'c') { e.preventDefault(); copySel(); return; }
        if (e.ctrlKey && e.key === 'x') { e.preventDefault(); cutSel(); return; }
        if (e.ctrlKey && e.key === 'v') { e.preventDefault(); pasteClip(); return; }
        if (e.key === 'Enter') { commitFloat(); return; }
        if (e.key === 'Escape') { deselect(); return; }
        if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
            e.preventDefault();
            snapshot();
            clearSelPixels();
            render();
            return;
        }
        if (e.key === 'b') setTool('pencil');
        if (e.key === 'e') setTool('eraser');
        if (e.key === 'g') setTool('fill');
        if (e.key === 'i') setTool('picker');
        if (e.key === 'm') setTool('select');
    };
    document.addEventListener('keydown', onKeydown);

    // ---------- 浮动面板（调色盘）：拖动 / 缩放 / 位置记忆 ----------
    const palettePanel = el('palettePanel');
    const workspaceEl = document.querySelector<HTMLElement>('.oi33-editor')!;
    const PAL_POS_KEY = 'pixelArtPalettePos.v3';

    function dockPalette() {
        // 复位：清除自定义尺寸，停靠到工作区（画布+右侧栏）旁边。优先放右侧（放不下时
        // 宁可超出窗口右缘，也不能盖住画布，否则画布被挡住点不到）；右侧太窄才放左侧。
        palettePanel.style.width = '';
        palettePanel.style.height = '';
        const r = workspaceEl.getBoundingClientRect();
        const pw = palettePanel.offsetWidth || 220;
        const roomR = window.innerWidth - r.right - 12; // 画布右侧可用空间
        const roomL = r.left - 12; // 画布左侧可用空间
        let left: number;
        if (roomR >= 120 || roomR >= roomL) {
            left = r.right + 12; // 右侧：可能略超出窗口右缘，可拖回
        } else {
            left = Math.max(8, r.left - 12 - pw); // 左侧
        }
        palettePanel.style.left = `${left}px`;
        palettePanel.style.top = `${Math.max(r.top, 8)}px`;
    }

    function savePalettePos() {
        try {
            localStorage.setItem(PAL_POS_KEY, JSON.stringify({
                left: palettePanel.style.left,
                top: palettePanel.style.top,
                width: palettePanel.style.width,
                height: palettePanel.style.height,
            }));
        } catch { /* 存储不可用时仅本次有效 */ }
    }

    // 面板若跑出屏幕或压住画布（比如画布尺寸变化后），自动复位，避免挡住画布点击
    function fixPanelOverlap() {
        const pr = palettePanel.getBoundingClientRect();
        const cr = canvasWrapEl.getBoundingClientRect();
        const offScreen = pr.left > window.innerWidth - 60 || pr.top > window.innerHeight - 40
            || pr.right < 60 || pr.bottom < 40;
        const coversCanvas = pr.left < cr.right && pr.right > cr.left
            && pr.top < cr.bottom && pr.bottom > cr.top;
        if (offScreen || coversCanvas) dockPalette();
    }

    const onWindowResize = () => {
        resizeCanvas();
        render();
        fixPanelOverlap();
    };

    // 面板内容随宽度按比例缩放：调小后按钮/文字/色块一起缩小，而不是出滚动条
    const paletteBody = el('paletteBody');
    const PANEL_BASE_W = 264;
    function fitPaletteBody() {
        // 用 offsetWidth（不含滚动条）而非 clientWidth：滚动条出现/消失不会改变它，
        // 否则"滚动条出现→变窄→缩小→滚动条消失→变宽"会循环抖动
        const z = clamp(palettePanel.offsetWidth / PANEL_BASE_W, 0.45, 2);
        if ((paletteBody.style as any).zoom !== String(z)) (paletteBody.style as any).zoom = z;
    }

    function initPalettePanel() {
        let saved: any = null;
        try { saved = JSON.parse(localStorage.getItem(PAL_POS_KEY)!); } catch { /* 忽略 */ }
        if (saved && saved.left && saved.top) {
            palettePanel.style.left = saved.left;
            palettePanel.style.top = saved.top;
            if (saved.width) palettePanel.style.width = saved.width;
            if (saved.height) palettePanel.style.height = saved.height;
        } else {
            dockPalette();
        }
        fixPanelOverlap();
        fitPaletteBody();

        // 拖动标题栏移动
        const dragBar = el('paletteDrag');
        dragBar.addEventListener('pointerdown', (e) => {
            if ((e.target as HTMLElement).tagName === 'BUTTON') return;
            e.preventDefault();
            dragBar.setPointerCapture(e.pointerId);
            const rect = palettePanel.getBoundingClientRect();
            const offX = e.clientX - rect.left; const offY = e.clientY - rect.top;
            const onMove = (ev: PointerEvent) => {
                palettePanel.style.left = `${clamp(ev.clientX - offX, 0, window.innerWidth - 60)}px`;
                palettePanel.style.top = `${clamp(ev.clientY - offY, 0, window.innerHeight - 40)}px`;
            };
            const onUp = () => {
                dragBar.removeEventListener('pointermove', onMove);
                dragBar.removeEventListener('pointerup', onUp);
                savePalettePos();
            };
            dragBar.addEventListener('pointermove', onMove);
            dragBar.addEventListener('pointerup', onUp);
        });

        // 缩放（右下角原生手柄）：宽度变化时固化宽度、高度交给内容自适应，并同步内容缩放
        if (typeof ResizeObserver !== 'undefined') {
            let lastW = 0;
            new ResizeObserver(() => {
                const w = palettePanel.offsetWidth;
                if (w !== lastW) {
                    lastW = w;
                    palettePanel.style.width = `${w}px`;
                    palettePanel.style.height = ''; // 高度随缩放后的内容自适应
                }
                fitPaletteBody();
                savePalettePos();
            }).observe(palettePanel);
        }

        // 窗口尺寸变化时重算画布 cell，并检查面板是否压住画布
        window.addEventListener('resize', onWindowResize);

        el('paletteReset').onclick = () => {
            dockPalette();
            savePalettePos();
        };
    }

    // ---------- 启动 ----------
    // 按钮点击后立刻失焦：避免焦点残留导致样式卡住（active 被 focus 样式盖住）
    const pageRoot = document.querySelector<HTMLElement>('.oi33-draw-page')!;
    pageRoot.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('button');
        if (btn && pageRoot.contains(btn)) btn.blur();
    });
    newGrid(16, 16);
    initPalettePanel();

    // 页面卸载（pjax 跳转）时清理全局监听
    return () => {
        document.removeEventListener('keydown', onKeydown);
        window.removeEventListener('resize', onWindowResize);
    };
}

// beforeLoading 在任何页面加载前触发：用它拆掉上一次挂载的全局监听，避免 pjax 跳转后残留
let disposeDraw: (() => void) | null = null;
addPage(new NamedPage('oi33_draw', () => {
    disposeDraw = mountDrawEditor();
}, () => {
    disposeDraw?.();
    disposeDraw = null;
}));
