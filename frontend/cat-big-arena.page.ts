import {
    addPage, NamedPage, Notification, request, Socket,
} from '@hydrooj/ui-default';
import { CAT_FRAMES, CAT_PIXEL_COLORS } from './cat-sprites';

const MAP_WIDTH = 640;
const MAP_HEIGHT = 480;
const DEFAULT_GRID_SCALE = 24;
const MIN_VIEW_SCALE = 0.25;
const MAX_VIEW_SCALE = 110;
const MIN_GRID_SPACING = 4;
const CAT_IDLE_FRAME_MS = 3200;

interface BigCat {
    id: number;
    display: string;
    url: string;
    x: number;
    y: number;
    fx: number | null;
    fy: number | null;
    size: number;
    weight: number;
    historyWeight?: number;
    positioned?: boolean;
}

interface BigCatMe {
    food: number;
    boundId: number | null;
    boundDisplay: string | null;
    boundUrl: string | null;
    contribution: number;
    canChange: boolean;
    nextFeedAt: number;
}

interface BigCatState {
    cats: BigCat[];
    ranking: Array<{ id: number; display: string; url: string; weight: number }>;
    me: BigCatMe | null;
    minWeight: number;
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

function formatWeight(value: number) {
    const amount = Math.max(0, Math.floor(Number(value) || 0));
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)} t`;
    if (amount >= 1_000) return `${(amount / 1_000).toFixed(2)} kg`;
    return `${amount} g`;
}

function seededRandom(seed: number) {
    let a = (seed >>> 0) || 1;
    return () => {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function mountTabs() {
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-panel-tab]'));
    if (!tabs.length) return;
    tabs.forEach((tab) => tab.addEventListener('click', () => {
        tabs.forEach((other) => {
            const active = other === tab;
            other.classList.toggle('is-active', active);
            other.setAttribute('aria-selected', String(active));
        });
        document.querySelectorAll<HTMLElement>('[data-panel]').forEach((panel) => {
            panel.hidden = panel.dataset.panel !== tab.dataset.panelTab;
        });
        // 让小猫世界的画布在重新显示时也能恢复尺寸。
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('oi33:bigcat-tab-shown'));
    }));
}

function mountBigCatWorld() {
    const viewport = document.querySelector<HTMLElement>('.oi33-bigcat-viewport');
    const canvas = viewport?.querySelector<HTMLCanvasElement>('.oi33-bigcat-canvas');
    if (!viewport || !canvas || viewport.dataset.mounted) return;
    viewport.dataset.mounted = '1';

    const context = canvas.getContext('2d');
    if (!context) return;
    const loggedIn = viewport.dataset.loggedIn === '1';
    const stateUrl = viewport.dataset.stateUrl || '/oi33/arena/big/state';
    const cellsUrl = viewport.dataset.cellsUrl || '/oi33/arena/state';
    const schoolsUrl = viewport.dataset.schoolsUrl || '/oi33/arena/big/schools';
    const bindUrl = viewport.dataset.bindUrl || '/oi33/arena/big/bind';
    const feedUrl = viewport.dataset.feedUrl || '/oi33/arena/big/feed';
    const detailBaseUrl = viewport.dataset.detailBaseUrl || '/oi33/arena/big/cat';
    const connectionUrl = viewport.dataset.connUrl || '/oi33/arena/conn';
    const loading = viewport.querySelector<HTMLElement>('.oi33-map-loading');
    const coordinate = document.querySelector<HTMLElement>('[data-bigcat-coordinate]');
    const live = document.querySelector<HTMLElement>('[data-bigcat-live]');
    const catCount = document.querySelector<HTMLElement>('[data-bigcat-count]');
    const meStatus = document.querySelector<HTMLElement>('[data-bigcat-me-status]');
    const rankingList = document.querySelector<HTMLElement>('[data-bigcat-ranking]');
    const fullscreenRoot = viewport.closest<HTMLElement>('.oi33-bigcat-body');
    const fullscreenButton = document.querySelector<HTMLButtonElement>('[data-bigcat-fullscreen]');
    const detailDialog = document.querySelector<HTMLDialogElement>('[data-bigcat-detail-dialog]');
    const pickerDialog = document.querySelector<HTMLDialogElement>('[data-bigcat-picker-dialog]');

    detailDialog?.querySelectorAll<HTMLButtonElement>('[data-bigcat-board-tab]').forEach((tab) => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.bigcatBoardTab || 'current';
            detailDialog.querySelectorAll<HTMLButtonElement>('[data-bigcat-board-tab]').forEach((other) => {
                const active = other === tab;
                other.classList.toggle('is-active', active);
                other.setAttribute('aria-selected', String(active));
            });
            const boardCurrent = detailDialog.querySelector<HTMLElement>('[data-bigcat-board-current]');
            const boardHistory = detailDialog.querySelector<HTMLElement>('[data-bigcat-board-history]');
            if (boardCurrent) boardCurrent.hidden = target !== 'current';
            if (boardHistory) boardHistory.hidden = target !== 'history';
        });
    });

    let me: BigCatMe | null = null;
    const cats = new Map<number, BigCat>();
    const overviewLayer = document.createElement('canvas');
    overviewLayer.width = MAP_WIDTH;
    overviewLayer.height = MAP_HEIGHT;
    const overviewContext = overviewLayer.getContext('2d')!;
    overviewContext.fillStyle = '#ffffff';
    overviewContext.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    let showGrid = false;
    let showNames = true;
    let viewScale = DEFAULT_GRID_SCALE;
    let viewCenterX = MAP_WIDTH / 2;
    let viewCenterY = MAP_HEIGHT / 2;
    let drag: { x: number; y: number; centerX: number; centerY: number; moved: boolean } | null = null;
    const activePointers = new Map<number, { x: number; y: number }>();
    let pinch: { distance: number; scale: number; mapX: number; mapY: number } | null = null;
    let gestureMoved = false;
    let clockOffset = 0;
    let renderDirty = true;
    let lastIdleFrame = -1;
    let devicePixelRatio = window.devicePixelRatio || 1;
    let stateLoaded = false;

    const now = () => Date.now() + clockOffset;
    const invalidate = () => { renderDirty = true; };
    const viewSize = () => ({ width: canvas.clientWidth, height: canvas.clientHeight });
    const viewOrigin = () => {
        const view = viewSize();
        return { x: view.width / 2 - viewCenterX * viewScale, y: view.height / 2 - viewCenterY * viewScale };
    };
    const clampView = () => {
        const view = viewSize();
        const margin = 70;
        const origin = viewOrigin();
        const originX = Math.min(view.width - margin, Math.max(margin - MAP_WIDTH * viewScale, origin.x));
        const originY = Math.min(view.height - margin, Math.max(margin - MAP_HEIGHT * viewScale, origin.y));
        viewCenterX = (view.width / 2 - originX) / viewScale;
        viewCenterY = (view.height / 2 - originY) / viewScale;
        invalidate();
    };
    const centerAt = (x: number, y: number) => {
        viewCenterX = x;
        viewCenterY = y;
        clampView();
    };
    const resize = () => {
        const ratio = window.devicePixelRatio || 1;
        devicePixelRatio = ratio;
        const rect = viewport.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        canvas.width = Math.max(1, Math.round(rect.width * ratio));
        canvas.height = Math.max(1, Math.round(rect.height * ratio));
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        clampView();
    };

    const setCell = (x: number, y: number, color: number) => {
        overviewContext.fillStyle = paletteColor(color);
        overviewContext.fillRect(x, y, 1, 1);
        invalidate();
    };
    const setRect = (rowStart: number, columnStart: number, rowEnd: number, columnEnd: number, color: number) => {
        overviewContext.fillStyle = paletteColor(color);
        overviewContext.fillRect(columnStart, rowStart, columnEnd - columnStart + 1, rowEnd - rowStart + 1);
        invalidate();
    };

    const updateMeStatus = () => {
        if (!meStatus || !loggedIn) return;
        if (!me) {
            meStatus.textContent = '完成认证后可绑定并投喂大猫';
            return;
        }
        const bound = me.boundId === null
            ? '尚未绑定大猫'
            : `已绑定 ${me.boundDisplay}（当前投喂 ${formatWeight(me.contribution)}）`;
        const change = me.boundId === null ? '' : me.canChange ? ' · 本月可改绑' : ' · 本月已改绑';
        const remaining = Math.max(0, (me.nextFeedAt || 0) - now());
        const cooldownSeconds = Math.ceil(remaining / 1000);
        const cooldown = cooldownSeconds
            ? ` · 投喂冷却 ${String(Math.floor(cooldownSeconds / 3600)).padStart(2, '0')}:${String(Math.floor(cooldownSeconds / 60) % 60).padStart(2, '0')}:${String(cooldownSeconds % 60).padStart(2, '0')}`
            : '';
        const text = `猫粮余额 ${formatWeight(me.food)} · ${bound}${change}${cooldown}`;
        if (meStatus.textContent !== text) meStatus.textContent = text;
    };
    window.setInterval(updateMeStatus, 1000);

    const RANKING_COLLAPSED_COUNT = 32;
    let rankingExpanded = false;
    let latestRanking: BigCatState['ranking'] = [];
    const renderRanking = (ranking: BigCatState['ranking']) => {
        latestRanking = ranking;
        if (!rankingList) return;
        rankingList.replaceChildren();
        if (!ranking.length) {
            const empty = document.createElement('li');
            empty.className = 'oi33-bigcat-ranking-empty';
            empty.textContent = '还没有体重达标的大猫。';
            rankingList.append(empty);
            return;
        }
        const shown = rankingExpanded ? ranking : ranking.slice(0, RANKING_COLLAPSED_COUNT);
        shown.forEach((entry, index) => {
            const item = document.createElement('li');
            if (me?.boundId === entry.id) item.classList.add('is-bound');
            const rank = document.createElement('span');
            rank.className = 'oi33-bigcat-ranking-rank';
            rank.textContent = String(index + 1);
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = entry.display;
            button.addEventListener('click', () => {
                const cat = cats.get(entry.id);
                if (cat) centerAt(cat.x + cat.size / 2, cat.y + cat.size / 2);
                openDetail(entry.id);
            });
            const weight = document.createElement('span');
            weight.className = 'oi33-bigcat-ranking-weight';
            weight.textContent = formatWeight(entry.weight);
            weight.title = `${entry.weight} g`;
            item.append(rank, button, weight);
            rankingList.append(item);
        });
        if (ranking.length > RANKING_COLLAPSED_COUNT) {
            const more = document.createElement('li');
            more.className = 'oi33-bigcat-ranking-more';
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.textContent = rankingExpanded ? '收起榜单' : `查看完整榜单（共 ${ranking.length} 只）`;
            toggle.addEventListener('click', () => {
                rankingExpanded = !rankingExpanded;
                renderRanking(latestRanking);
            });
            more.append(toggle);
            rankingList.append(more);
        }
    };

    const upsertCat = (incoming: any) => {
        const id = Number(incoming.id);
        const previous = cats.get(id);
        const next: BigCat = {
            id,
            display: incoming.display ?? previous?.display ?? `#${id}`,
            url: incoming.url ?? previous?.url ?? `https://oier.baoshuo.dev/school/${id}`,
            x: previous?.x ?? 0,
            y: previous?.y ?? 0,
            fx: 'x' in incoming ? (Number.isInteger(incoming.x) ? incoming.x : null) : previous?.fx ?? null,
            fy: 'y' in incoming ? (Number.isInteger(incoming.y) ? incoming.y : null) : previous?.fy ?? null,
            size: Math.max(0, Number(incoming.size ?? previous?.size ?? 0)),
            weight: Math.max(0, Number(incoming.weight ?? previous?.weight ?? 0)),
            historyWeight: Math.max(0, Number(incoming.historyWeight ?? previous?.historyWeight ?? 0)),
            positioned: previous?.positioned ?? false,
        };
        cats.set(id, next);
        if (catCount) catCount.textContent = String(cats.size);
        invalidate();
    };

    // 大猫位置只是画板上的展示：榜一玩家摆过的用固定位置，
    // 其余的按编号播种生成伪随机位置，尽量互不重叠。
    // 已摆好的大猫在位置仍然有效（在界内且不重叠）时保持不动，
    // 避免每次投喂广播刷新后所有大猫重新随机、突然跳到视野中央。
    const layoutCats = () => {
        const placed: Array<{ x: number; y: number; size: number }> = [];
        const ordered = Array.from(cats.values())
            .filter((cat) => cat.size > 0)
            .sort((a, b) => b.size - a.size || a.id - b.id);
        const overlaps = (x: number, y: number, size: number) => placed.some((other) => x < other.x + other.size && other.x < x + size
            && y < other.y + other.size && other.y < y + size);
        ordered.forEach((cat) => {
            if (cat.fx === null || cat.fy === null) return;
            cat.x = Math.max(0, Math.min(MAP_WIDTH - cat.size, cat.fx));
            cat.y = Math.max(0, Math.min(MAP_HEIGHT - cat.size, cat.fy));
            cat.positioned = true;
            placed.push({ x: cat.x, y: cat.y, size: cat.size });
        });
        ordered.forEach((cat) => {
            if (cat.fx !== null && cat.fy !== null) return;
            const keep = cat.positioned
                && cat.x >= 0 && cat.y >= 0
                && cat.x + cat.size <= MAP_WIDTH && cat.y + cat.size <= MAP_HEIGHT
                && !overlaps(cat.x, cat.y, cat.size);
            if (!keep) {
                const rand = seededRandom(cat.id + 1);
                let fallback: { x: number; y: number } | null = null;
                for (let attempt = 0; attempt < 80; attempt++) {
                    const x = Math.floor(rand() * (MAP_WIDTH - cat.size + 1));
                    const y = Math.floor(rand() * (MAP_HEIGHT - cat.size + 1));
                    fallback = { x, y };
                    if (!overlaps(x, y, cat.size)) break;
                }
                cat.x = fallback!.x;
                cat.y = fallback!.y;
            }
            cat.positioned = true;
            placed.push({ x: cat.x, y: cat.y, size: cat.size });
        });
        invalidate();
    };

    const drawBigCat = (cat: BigCat, px: number, py: number, sizePx: number) => {
        const phase = Math.floor(now() / CAT_IDLE_FRAME_MS + cat.id) % 3;
        const frameX = phase === 1 ? 1 : 0;
        const frameY = phase === 2 ? 1 : 0;
        const frame = CAT_FRAMES[frameY * 2 + frameX];
        context.save();
        context.fillStyle = 'rgba(0,0,0,.2)';
        context.beginPath();
        context.ellipse(px + sizePx / 2, py + sizePx - Math.max(2, sizePx * .04), sizePx * .36, sizePx * .11, 0, 0, Math.PI * 2);
        context.fill();
        for (let row = 0; row < 8; row++) {
            const top = Math.round((py + row * sizePx / 8) * devicePixelRatio) / devicePixelRatio;
            const bottom = Math.round((py + (row + 1) * sizePx / 8) * devicePixelRatio) / devicePixelRatio;
            for (let column = 0; column < 8; column++) {
                const color = frame[row][column];
                const fillStyle = CAT_PIXEL_COLORS[color];
                if (!fillStyle) continue;
                const left = Math.round((px + column * sizePx / 8) * devicePixelRatio) / devicePixelRatio;
                const right = Math.round((px + (column + 1) * sizePx / 8) * devicePixelRatio) / devicePixelRatio;
                context.fillStyle = fillStyle;
                context.fillRect(left, top, right - left, bottom - top);
            }
        }
        context.restore();
    };

    const renderMap = (width: number, height: number) => {
        context.fillStyle = paletteColor(238);
        context.fillRect(0, 0, width, height);
        const origin = viewOrigin();
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
        const ordered = Array.from(cats.values()).sort((a, b) => b.weight - a.weight || a.id - b.id);
        ordered.forEach((cat) => {
            if (!cat.size) return;
            const px = origin.x + cat.x * viewScale;
            const py = origin.y + cat.y * viewScale;
            const sizePx = cat.size * viewScale;
            if (px + sizePx < 0 || py + sizePx < 0 || px > width || py > height) return;
            drawBigCat(cat, px, py, sizePx);
            if (showNames) {
                const label = `${cat.display}#${formatWeight(cat.weight).replace(/\s/g, '')}`;
                context.save();
                context.font = `bold ${Math.max(10, Math.min(14, sizePx / 8))}px sans-serif`;
                const labelWidth = Math.min(220, context.measureText(label).width + 9);
                const labelX = Math.max(0, Math.min(width - labelWidth, px + sizePx / 2 - labelWidth / 2));
                // 名字写在大猫脚下，不遮住大猫。
                const labelY = Math.max(0, Math.min(height - 16, py + sizePx + 2));
                context.fillStyle = cat.id === me?.boundId ? 'rgba(111,75,9,.9)' : 'rgba(13,27,18,.82)';
                context.fillRect(labelX, labelY, labelWidth, 16);
                context.fillStyle = '#fff';
                context.textAlign = 'center';
                context.fillText(label, labelX + labelWidth / 2, labelY + 12, labelWidth - 5);
                context.restore();
            }
        });
    };

    const render = () => {
        if (!canvas.isConnected) return;
        const idleFrame = Math.floor(now() / CAT_IDLE_FRAME_MS);
        if (renderDirty || idleFrame !== lastIdleFrame) {
            const { width, height } = viewSize();
            if (width > 1 && height > 1) {
                context.clearRect(0, 0, width, height);
                renderMap(width, height);
                renderDirty = false;
                lastIdleFrame = idleFrame;
            }
        }
        window.requestAnimationFrame(render);
    };

    const catAtPoint = (mapX: number, mapY: number) => {
        const ordered = Array.from(cats.values()).sort((a, b) => b.weight - a.weight || a.id - b.id);
        return ordered.find((cat) => cat.size
            && mapX >= cat.x && mapX < cat.x + cat.size
            && mapY >= cat.y && mapY < cat.y + cat.size) || null;
    };

    const BOARD_COLLAPSED_COUNT = 32;
    const renderBoard = (element: HTMLElement | null, rows: Array<{
        uid: number; uname: string; avatarUrl?: string; amount: number;
    }>) => {
        if (!element) return;
        element.replaceChildren();
        if (!rows.length) {
            const empty = document.createElement('li');
            empty.className = 'oi33-bigcat-board-empty';
            empty.textContent = '暂无记录。';
            element.append(empty);
            return;
        }
        rows.forEach((row, index) => {
            const item = document.createElement('li');
            if (index >= BOARD_COLLAPSED_COUNT) item.hidden = true;
            const rank = document.createElement('span');
            rank.className = 'oi33-bigcat-board-rank';
            rank.textContent = String(index + 1);
            const img = document.createElement('img');
            img.className = 'oi33-bigcat-board-avatar';
            img.src = row.avatarUrl || '/img/avatar.png';
            img.width = 24;
            img.height = 24;
            img.loading = 'lazy';
            img.alt = '';
            const link = document.createElement('a');
            link.href = `/user/${row.uid}`;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = row.uname;
            const amount = document.createElement('span');
            amount.className = 'oi33-bigcat-board-amount';
            amount.textContent = formatWeight(row.amount);
            amount.title = `${row.amount} g`;
            item.append(rank, img, link, amount);
            element.append(item);
        });
        if (rows.length > BOARD_COLLAPSED_COUNT) {
            const more = document.createElement('li');
            more.className = 'oi33-bigcat-board-empty oi33-bigcat-board-more';
            const link = document.createElement('a');
            link.href = '#';
            link.textContent = `查看完整榜单（共 ${rows.length} 人）`;
            link.addEventListener('click', (event) => {
                event.preventDefault();
                element.querySelectorAll<HTMLElement>('li[hidden]').forEach((item) => { item.hidden = false; });
                more.remove();
            });
            more.append(link);
            element.append(more);
        }
    };

    const feedBoundCat = async (amount: number, button: HTMLButtonElement) => {
        if (!me || me.boundId === null) {
            Notification.error('请先绑定一只大猫再投喂。');
            return null;
        }
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            Notification.error('投喂量必须是正整数。');
            return null;
        }
        if ((me.nextFeedAt || 0) > now()) {
            Notification.error(`投喂冷却中，请在 ${new Date(me.nextFeedAt).toLocaleString('zh-CN')} 后再投喂（冷却固定 2 小时）。`);
            return null;
        }
        button.disabled = true;
        try {
            const schoolId = me.boundId;
            const result = await request.post(feedUrl, { amount });
            upsertCat({
                id: schoolId, weight: result.weight, size: result.size,
                historyWeight: result.historyWeight,
            });
            layoutCats();
            if (me) {
                me.food = Math.max(0, Number(result.balance) || 0);
                me.contribution = Math.max(0, Number(result.contribution) || 0);
                me.nextFeedAt = Number(result.nextFeedAt) || 0;
            }
            updateMeStatus();
            Notification.success(`投喂成功，${result.display} 当前体重 ${formatWeight(result.weight)}；2 小时后可再次投喂。`);
            return result;
        } catch (e: any) {
            Notification.error(e.message || String(e));
            return null;
        } finally {
            button.disabled = false;
        }
    };

    const openDetail = async (schoolId: number) => {
        if (!detailDialog) return;
        const name = detailDialog.querySelector<HTMLElement>('[data-bigcat-detail-name]');
        const link = detailDialog.querySelector<HTMLAnchorElement>('[data-bigcat-detail-link]');
        const summary = detailDialog.querySelector<HTMLElement>('[data-bigcat-detail-summary]');
        const feedBox = detailDialog.querySelector<HTMLElement>('[data-bigcat-detail-feed]');
        const feedAmount = detailDialog.querySelector<HTMLInputElement>('[data-bigcat-feed-amount]');
        const feedConfirm = detailDialog.querySelector<HTMLButtonElement>('[data-bigcat-feed-confirm]');
        const moveBox = detailDialog.querySelector<HTMLElement>('[data-bigcat-detail-move]');
        const moveRow = detailDialog.querySelector<HTMLInputElement>('[data-bigcat-move-row]');
        const moveCol = detailDialog.querySelector<HTMLInputElement>('[data-bigcat-move-col]');
        const moveConfirm = detailDialog.querySelector<HTMLButtonElement>('[data-bigcat-move-confirm]');
        const moveTip = detailDialog.querySelector<HTMLElement>('[data-bigcat-move-tip]');
        const boardCurrent = detailDialog.querySelector<HTMLElement>('[data-bigcat-board-current]');
        const boardHistory = detailDialog.querySelector<HTMLElement>('[data-bigcat-board-history]');
        const cat = cats.get(schoolId);
        if (name) name.textContent = cat?.display || `#${schoolId}`;
        if (link) link.href = cat?.url || `https://oier.baoshuo.dev/school/${schoolId}`;
        if (summary) summary.textContent = '正在读取榜单…';
        renderBoard(boardCurrent, []);
        renderBoard(boardHistory, []);
        if (feedBox) feedBox.hidden = !(loggedIn && me && me.boundId === schoolId);
        if (moveBox) moveBox.hidden = true;
        if (moveConfirm) {
            moveConfirm.onclick = async () => {
                const row = Math.floor(Number(moveRow?.value));
                const col = Math.floor(Number(moveCol?.value));
                const catSize = cats.get(schoolId)?.size || 0;
                if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col)
                    || row < 0 || row > MAP_HEIGHT - catSize || col < 0 || col > MAP_WIDTH - catSize) {
                    Notification.error(`请输入有效坐标：行 0～${MAP_HEIGHT - catSize}，列 0～${MAP_WIDTH - catSize}（大猫左上角，体型 ${catSize}×${catSize}）。`);
                    return;
                }
                moveConfirm.disabled = true;
                try {
                    const result = await request.post(`${detailBaseUrl}/${schoolId}/position`, { x: col, y: row });
                    const cat = cats.get(schoolId);
                    if (cat) {
                        cat.fx = result.x;
                        cat.fy = result.y;
                        layoutCats();
                    }
                    Notification.success(`已把大猫摆放到（行 ${result.y}, 列 ${result.x}），2 小时后可再次改变。`);
                    detailDialog.close();
                    openDetail(schoolId);
                } catch (e: any) {
                    Notification.error(e.message || String(e));
                    moveConfirm.disabled = false;
                }
            };
        }
        if (feedConfirm) {
            feedConfirm.onclick = async () => {
                const result = await feedBoundCat(Math.floor(Number(feedAmount?.value)), feedConfirm);
                if (result) {
                    detailDialog.close();
                    openDetail(schoolId);
                }
            };
        }
        detailDialog.showModal();
        try {
            const detail = await request.get(`${detailBaseUrl}/${schoolId}`);
            if (name) name.textContent = detail.school.display;
            if (link) link.href = detail.school.url;
            const exact = (label: string, grams: number) => {
                const span = document.createElement('span');
                span.className = 'oi33-bigcat-exact';
                span.textContent = `${label} ${formatWeight(grams)}`;
                span.title = `${grams} g`;
                return span;
            };
            const parts: Array<Node | string> = [
                exact('当前体重', detail.weight),
                exact('历史投喂', detail.historyWeight),
            ];
            if (detail.visible) parts.push(`体型 ${detail.size}×${detail.size} 格`);
            else parts.push(`再投喂 ${formatWeight(Math.max(0, 1024 - detail.weight))} 即可出现在大猫世界`);
            if (detail.mine) {
                // 当前投喂与历史投喂互斥（绑定恢复后历史即清零），只显示适用的那一项。
                if (detail.mine.bound) parts.push(exact('我的当前投喂', detail.mine.current));
                else if (detail.mine.history > 0) {
                    parts.push(exact('我的历史投喂', detail.mine.history), '重新绑定后可恢复');
                }
            }
            if (summary) {
                summary.replaceChildren();
                parts.forEach((part, index) => {
                    if (index) summary.append(document.createTextNode(' · '));
                    summary.append(typeof part === 'string' ? document.createTextNode(part) : part);
                });
            }
            if (moveBox) {
                moveBox.hidden = !detail.canMove;
                if (detail.canMove) {
                    if (moveRow) moveRow.value = detail.position ? String(detail.position.y) : '';
                    if (moveCol) moveCol.value = detail.position ? String(detail.position.x) : '';
                    const wait = Math.max(0, (Number(detail.nextMoveAt) || 0) - now());
                    if (moveTip) {
                        moveTip.textContent = wait > 0
                            ? `每 2 小时可以改变一次位置，下次可摆放：${new Date(detail.nextMoveAt).toLocaleString('zh-CN')}。`
                            : '当前投喂榜第一名可以选择大猫左上角所在格子，每 2 小时可以改变一次。';
                    }
                    if (moveConfirm) moveConfirm.disabled = wait > 0;
                }
            }
            renderBoard(boardCurrent, detail.current || []);
            renderBoard(boardHistory, detail.history || []);
        } catch (e: any) {
            if (summary) summary.textContent = `读取失败：${e.message || e}`;
        }
    };

    const pickerState = { page: 1, upcount: 1, query: '' };
    const renderPickerList = (schools: Array<{ id: number; display: string; prov?: string; url: string }>) => {
        const list = pickerDialog?.querySelector<HTMLElement>('[data-bigcat-picker-list]');
        if (!list) return;
        list.replaceChildren();
        if (!schools.length) {
            const empty = document.createElement('li');
            empty.textContent = '没有匹配的学校。';
            list.append(empty);
            return;
        }
        schools.forEach((school) => {
            const item = document.createElement('li');
            const label = document.createElement('span');
            label.className = 'oi33-bigcat-picker-label';
            if (school.prov) {
                const prov = document.createElement('em');
                prov.textContent = school.prov;
                label.append(prov);
            }
            label.append(document.createTextNode(school.display));
            const link = document.createElement('a');
            link.href = school.url;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = 'OIerDB';
            const bind = document.createElement('button');
            bind.type = 'button';
            bind.className = 'primary rounded button';
            const isCurrent = me?.boundId === school.id;
            const locked = !!me && me.boundId !== null && !me.canChange && !isCurrent;
            bind.textContent = isCurrent ? '当前绑定' : '绑定';
            bind.disabled = isCurrent || locked;
            if (locked) bind.title = '本月已修改过绑定，下个月才能改绑。';
            bind.addEventListener('click', async () => {
                bind.disabled = true;
                try {
                    const result = await request.post(bindUrl, { schoolId: school.id });
                    const restored = Math.max(0, Number(result.restoredFromHistory) || 0);
                    me = {
                        food: me?.food || 0,
                        boundId: result.boundId,
                        boundDisplay: result.boundDisplay,
                        boundUrl: result.boundUrl,
                        contribution: restored,
                        canChange: result.canChange !== false,
                        nextFeedAt: me?.nextFeedAt || 0,
                    };
                    updateMeStatus();
                    const restoredNote = restored ? `，历史投喂 ${formatWeight(restored)} 已恢复为当前投喂` : '';
                    Notification.success(result.movedToHistory
                        ? `已改绑 ${result.boundDisplay}，原大猫的 ${formatWeight(result.movedToHistory)} 投喂已转入历史投喂${restoredNote}。`
                        : `已绑定 ${result.boundDisplay}${restoredNote}，现在可以投喂了。`);
                    pickerDialog?.close();
                } catch (e: any) {
                    Notification.error(e.message || String(e));
                    bind.disabled = false;
                }
            });
            item.append(label, link, bind);
            list.append(item);
        });
    };
    const loadPicker = async () => {
        const pager = pickerDialog?.querySelector<HTMLElement>('[data-bigcat-picker-pager]');
        const pageText = pickerDialog?.querySelector<HTMLElement>('[data-bigcat-picker-page]');
        try {
            if (pickerState.query) {
                const result = await request.get(schoolsUrl, { q: pickerState.query });
                renderPickerList(result.schools || []);
                if (pager) pager.hidden = true;
            } else {
                const result = await request.get(schoolsUrl, { page: pickerState.page });
                pickerState.upcount = Math.max(1, Number(result.upcount) || 1);
                pickerState.page = Math.max(1, Number(result.page) || 1);
                renderPickerList(result.schools || []);
                if (pager) pager.hidden = false;
                if (pageText) pageText.textContent = `${pickerState.page} / ${pickerState.upcount}`;
            }
        } catch (e: any) {
            Notification.error(e.message || String(e));
        }
    };
    document.querySelector<HTMLButtonElement>('[data-bigcat-bind]')?.addEventListener('click', () => {
        if (!pickerDialog) return;
        const hint = pickerDialog.querySelector<HTMLElement>('[data-bigcat-picker-hint]');
        if (hint) {
            hint.textContent = me?.boundId !== null && me?.boundId !== undefined
                ? me.canChange
                    ? '改绑后，之前对大猫的投喂会进入原大猫的历史投喂；重新绑定回去时会恢复为当前投喂。每个月只能修改一次绑定。'
                    : '本月已经修改过绑定，下个月才能改绑；仍可查看学校列表。'
                : '首次绑定随时可以进行；之后每个月只能修改一次绑定，绑定回以前投喂过的大猫会恢复历史投喂。';
        }
        pickerDialog.showModal();
        loadPicker();
    });
    pickerDialog?.querySelector<HTMLButtonElement>('[data-bigcat-picker-search]')?.addEventListener('click', () => {
        pickerState.query = pickerDialog.querySelector<HTMLInputElement>('[data-bigcat-picker-q]')?.value.trim() || '';
        loadPicker();
    });
    pickerDialog?.querySelector<HTMLInputElement>('[data-bigcat-picker-q]')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        pickerState.query = (event.target as HTMLInputElement).value.trim();
        loadPicker();
    });
    pickerDialog?.querySelector<HTMLButtonElement>('[data-bigcat-picker-prev]')?.addEventListener('click', () => {
        if (pickerState.page > 1) {
            pickerState.page -= 1;
            loadPicker();
        }
    });
    pickerDialog?.querySelector<HTMLButtonElement>('[data-bigcat-picker-next]')?.addEventListener('click', () => {
        if (pickerState.page < pickerState.upcount) {
            pickerState.page += 1;
            loadPicker();
        }
    });

    document.querySelector<HTMLButtonElement>('[data-bigcat-find]')?.addEventListener('click', () => {
        if (!me?.boundId) {
            pickerDialog?.showModal();
            loadPicker();
            return;
        }
        const cat = cats.get(me.boundId);
        if (cat) centerAt(cat.x + cat.size / 2, cat.y + cat.size / 2);
        openDetail(me.boundId);
    });
    document.querySelectorAll<HTMLButtonElement>('[data-bigcat-layer]').forEach((button) => button.addEventListener('click', () => {
        const layer = button.dataset.bigcatLayer;
        if (layer === 'grid') showGrid = !showGrid;
        if (layer === 'names') showNames = !showNames;
        const active = layer === 'grid' ? showGrid : showNames;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
        invalidate();
    }));
    const updateFullscreen = () => {
        const active = document.fullscreenElement === fullscreenRoot;
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

    const pointToCell = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        const origin = viewOrigin();
        return {
            x: (clientX - rect.left - origin.x) / viewScale,
            y: (clientY - rect.top - origin.y) / viewScale,
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
        drag = { x: event.clientX, y: event.clientY, centerX: viewCenterX, centerY: viewCenterY, moved: false };
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
        if (coordinate) {
            const inside = cell.x >= 0 && cell.x < MAP_WIDTH && cell.y >= 0 && cell.y < MAP_HEIGHT;
            coordinate.textContent = inside ? `格子：（行 ${Math.floor(cell.y)}, 列 ${Math.floor(cell.x)}）` : '格子：—';
        }
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
            drag = { x: remaining.x, y: remaining.y, centerX: viewCenterX, centerY: viewCenterY, moved: true };
            gestureMoved = true;
            return;
        }
        drag = null;
        gestureMoved = false;
        viewport.classList.remove('is-dragging');
        if (!wasDrag && !cancelled) {
            const cell = pointToCell(event.clientX, event.clientY);
            const cat = catAtPoint(cell.x, cell.y);
            if (cat) openDetail(cat.id);
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
        if (payload.type === 'bigcat' && payload.cat) {
            if (stateLoaded) refreshState();
            else upsertCat(payload.cat);
        }
        if (payload.type === 'cell' && Array.isArray(payload.cell)) setCell(payload.cell[0], payload.cell[1], payload.cell[2]);
        if (payload.type === 'rect' && Array.isArray(payload.rect)) {
            setRect(payload.rect[0], payload.rect[1], payload.rect[2], payload.rect[3], payload.rect[4]);
        }
    });

    const refreshState = () => request.get(stateUrl).then((incoming: BigCatState) => {
        clockOffset = incoming.serverTime - Date.now();
        // 不清空重建，保留已有大猫的摆放位置，只有消失的大猫才移除。
        const incomingIds = new Set((incoming.cats || []).map((cat) => Number(cat.id)));
        Array.from(cats.keys()).forEach((id) => {
            if (!incomingIds.has(id)) cats.delete(id);
        });
        incoming.cats.forEach((cat) => upsertCat(cat));
        layoutCats();
        me = incoming.me;
        updateMeStatus();
        renderRanking(incoming.ranking || []);
        if (catCount) catCount.textContent = String(cats.size);
        stateLoaded = true;
        loading?.classList.add('is-hidden');
    });

    window.addEventListener('resize', resize);
    window.addEventListener('oi33:bigcat-tab-shown', () => {
        window.requestAnimationFrame(resize);
    });
    request.get(cellsUrl).then((incoming: any) => {
        (incoming.cells || []).forEach(([x, y, color]: [number, number, number]) => setCell(x, y, color));
    }).catch(() => { });
    refreshState().catch((e) => {
        if (loading) loading.textContent = `大猫世界加载失败：${e.message || e}`;
    });
    window.requestAnimationFrame(resize);
    render();
}

addPage(new NamedPage('oi33_cat_can_arena', () => {
    mountTabs();
    mountBigCatWorld();
}));
