import { Notification, request } from '@hydrooj/ui-default';

interface BigCat {
    id: number;
    catId: number;
    display: string;
    url: string;
    color: number;
    weight: number;
    historyWeight: number;
    territoryCount: number;
    isAdminCat: boolean;
}

interface BigCatMe {
    food: number;
    boundId: number | null;
    boundCatId: number;
    boundDisplay: string | null;
    boundUrl: string | null;
    boundColor: number | null;
    contribution: number;
    canChange: boolean;
    nextFeedAt: number;
}

interface BigCatState {
    cats: BigCat[];
    ranking: Array<{
        id: number;
        catId: number;
        display: string;
        url: string;
        color: number;
        weight: number;
        territoryCount: number;
        isAdminCat: boolean;
        rank: number | null;
    }>;
    rankingTotal: number;
    me: BigCatMe | null;
    serverTime: number;
}

export interface BigCatLayerHost {
    invalidate: () => void;
    onTerritoryColorsChanged: () => void;
}

export interface BigCatLayer {
    colorFor: (catId: number) => string;
    colorValueFor: (catId: number) => number;
    labelFor: (catId: number) => string;
    schoolIdForCatId: (catId: number) => number | null;
    boundCatId: () => number;
    openDetail: (schoolId: number) => void;
    handleSocketMessage: (payload: any) => void;
    refresh: () => Promise<void>;
    isDialogOpen: () => boolean;
}

function formatWeight(value: number) {
    const amount = Math.max(0, Math.floor(Number(value) || 0));
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)} t`;
    if (amount >= 1_000) return `${(amount / 1_000).toFixed(2)} kg`;
    return `${amount} g`;
}

function colorHex(value: number) {
    const color = Math.max(0, Math.min(0xFFFFFF, Math.floor(Number(value) || 0)));
    return `#${color.toString(16).padStart(6, '0')}`;
}

export function mountBigCatLayer(host: BigCatLayerHost): BigCatLayer | null {
    const viewport = document.querySelector<HTMLElement>('.oi33-map-viewport');
    if (!viewport?.dataset.bigStateUrl || viewport.dataset.bigcatMounted) return null;
    viewport.dataset.bigcatMounted = '1';

    const loggedIn = viewport.dataset.loggedIn === '1';
    const stateUrl = viewport.dataset.bigStateUrl;
    const schoolsUrl = viewport.dataset.schoolsUrl || '/oi33/arena/big/schools';
    const bindUrl = viewport.dataset.bindUrl || '/oi33/arena/big/bind';
    const unbindUrl = viewport.dataset.unbindUrl || '/oi33/arena/big/unbind';
    const feedUrl = viewport.dataset.feedUrl || '/oi33/arena/big/feed';
    const detailBaseUrl = viewport.dataset.detailBaseUrl || '/oi33/arena/big/cat';
    const catCount = document.querySelector<HTMLElement>('[data-bigcat-count]');
    const rankingList = document.querySelector<HTMLElement>('[data-bigcat-ranking]');
    const rankingLink = document.querySelector<HTMLAnchorElement>('[data-bigcat-ranking-link]');
    const detailDialog = document.querySelector<HTMLDialogElement>('[data-bigcat-detail-dialog]');
    const pickerDialog = document.querySelector<HTMLDialogElement>('[data-bigcat-picker-dialog]');
    const bindMenuButton = document.querySelector<HTMLButtonElement>('[data-bigcat-bind]');
    const unbindButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-bigcat-unbind]'));

    detailDialog?.querySelectorAll<HTMLButtonElement>('[data-bigcat-board-tab]').forEach((tab) => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.bigcatBoardTab || 'current';
            detailDialog.querySelectorAll<HTMLButtonElement>('[data-bigcat-board-tab]').forEach((other) => {
                const active = other === tab;
                other.classList.toggle('is-active', active);
                other.setAttribute('aria-selected', String(active));
            });
            const current = detailDialog.querySelector<HTMLElement>('[data-bigcat-board-current]');
            const history = detailDialog.querySelector<HTMLElement>('[data-bigcat-board-history]');
            if (current) current.hidden = target !== 'current';
            if (history) history.hidden = target !== 'history';
        });
    });

    let me: BigCatMe | null = null;
    const cats = new Map<number, BigCat>();
    const catsByKey = new Map<number, BigCat>();
    let clockOffset = 0;
    let refreshTimer: number | null = null;
    const now = () => Date.now() + clockOffset;

    const upsertCat = (incoming: Partial<BigCat> & { id: number }) => {
        const id = Number(incoming.id);
        const previous = cats.get(id);
        const catId = Math.max(1, Number(incoming.catId ?? previous?.catId ?? id + 1));
        const next: BigCat = {
            id,
            catId,
            display: incoming.display ?? previous?.display ?? `#${id}`,
            url: incoming.url ?? previous?.url ?? `https://oier.baoshuo.dev/school/${id}`,
            color: Math.max(0, Number(incoming.color ?? previous?.color ?? 0)),
            weight: Math.max(0, Number(incoming.weight ?? previous?.weight ?? 0)),
            historyWeight: Math.max(0, Number(incoming.historyWeight ?? previous?.historyWeight ?? 0)),
            territoryCount: Math.max(0, Number(incoming.territoryCount ?? previous?.territoryCount ?? 0)),
            isAdminCat: incoming.isAdminCat ?? previous?.isAdminCat ?? false,
        };
        const territoryColorChanged = !previous
            || previous.catId !== next.catId
            || previous.color !== next.color;
        if (previous && previous.catId !== catId) catsByKey.delete(previous.catId);
        cats.set(id, next);
        catsByKey.set(catId, next);
        if (catCount) catCount.textContent = String(cats.size);
        host.invalidate();
        // Weight/count-only updates must not rebuild a million-pixel layer.
        if (territoryColorChanged) host.onTerritoryColorsChanged();
        return next;
    };

    const renderRanking = (ranking: BigCatState['ranking']) => {
        if (!rankingList) return;
        rankingList.replaceChildren();
        if (!ranking.length) {
            const empty = document.createElement('li');
            empty.className = 'oi33-bigcat-ranking-empty';
            empty.textContent = '还没有获得体重或领地的大猫。';
            rankingList.append(empty);
            return;
        }
        ranking.forEach((entry) => {
            const item = document.createElement('li');
            if (me?.boundId === entry.id) item.classList.add('is-bound');
            if (entry.isAdminCat) item.classList.add('is-admin-cat');
            else if (entry.rank && entry.rank <= 3) item.classList.add(`is-rank-${entry.rank}`);
            const rank = document.createElement('span');
            rank.className = 'oi33-bigcat-ranking-rank';
            rank.textContent = entry.isAdminCat ? '★' : String(entry.rank || '—');
            rank.title = entry.isAdminCat ? '管理员大猫，不参与数字排名' : `领地排名第 ${entry.rank} 名`;
            const swatch = document.createElement('span');
            swatch.className = 'oi33-bigcat-ranking-swatch';
            swatch.style.background = colorHex(entry.color);
            swatch.title = `领地颜色 ${colorHex(entry.color)}`;
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = entry.display;
            button.addEventListener('click', () => { void openDetail(entry.id); });
            const stats = document.createElement('span');
            stats.className = 'oi33-bigcat-ranking-weight';
            stats.textContent = `${entry.territoryCount} 格 · ${formatWeight(entry.weight)}`;
            stats.title = `${entry.weight} g；占领 ${entry.territoryCount} 格`;
            item.append(rank, swatch, button, stats);
            rankingList.append(item);
        });
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
                id: schoolId,
                catId: schoolId + 1,
                weight: result.weight,
                historyWeight: result.historyWeight,
                territoryCount: result.territoryCount,
                color: result.color,
                isAdminCat: result.isAdminCat,
            });
            me.food = Math.max(0, Number(result.balance) || 0);
            me.contribution = Math.max(0, Number(result.contribution) || 0);
            me.nextFeedAt = Number(result.nextFeedAt) || 0;
            Notification.success(`投喂成功，${result.display} 当前体重 ${formatWeight(result.weight)}；2 小时后可再次投喂。`);
            scheduleRefresh();
            return result;
        } catch (e: any) {
            Notification.error(e.message || String(e));
            return null;
        } finally {
            button.disabled = false;
        }
    };

    async function openDetail(schoolId: number) {
        if (!detailDialog) return;
        const name = detailDialog.querySelector<HTMLElement>('[data-bigcat-detail-name]');
        const link = detailDialog.querySelector<HTMLAnchorElement>('[data-bigcat-detail-link]');
        const summary = detailDialog.querySelector<HTMLElement>('[data-bigcat-detail-summary]');
        const feedBox = detailDialog.querySelector<HTMLElement>('[data-bigcat-detail-feed]');
        const feedAmount = detailDialog.querySelector<HTMLInputElement>('[data-bigcat-feed-amount]');
        const feedConfirm = detailDialog.querySelector<HTMLButtonElement>('[data-bigcat-feed-confirm]');
        const colorBox = detailDialog.querySelector<HTMLElement>('[data-bigcat-detail-color]');
        const colorInput = detailDialog.querySelector<HTMLInputElement>('[data-bigcat-color-input]');
        const colorConfirm = detailDialog.querySelector<HTMLButtonElement>('[data-bigcat-color-confirm]');
        const detailUnbind = detailDialog.querySelector<HTMLButtonElement>('[data-bigcat-unbind]');
        const boardCurrent = detailDialog.querySelector<HTMLElement>('[data-bigcat-board-current]');
        const boardHistory = detailDialog.querySelector<HTMLElement>('[data-bigcat-board-history]');
        const cat = cats.get(schoolId);
        if (name) name.textContent = cat?.display || `#${schoolId}`;
        if (link) link.href = cat?.url || `https://oier.baoshuo.dev/school/${schoolId}`;
        if (summary) summary.textContent = '正在读取榜单…';
        renderBoard(boardCurrent, []);
        renderBoard(boardHistory, []);
        if (feedBox) feedBox.hidden = !(loggedIn && me && me.boundId === schoolId);
        if (detailUnbind) detailUnbind.hidden = !(loggedIn && me && me.boundId === schoolId);
        if (colorBox) colorBox.hidden = true;
        if (feedConfirm) {
            feedConfirm.onclick = async () => {
                const result = await feedBoundCat(Math.floor(Number(feedAmount?.value)), feedConfirm);
                if (result) {
                    detailDialog.close();
                    void openDetail(schoolId);
                }
            };
        }
        detailDialog.showModal();
        try {
            const detail = await request.get(`${detailBaseUrl}/${schoolId}`);
            if (name) name.textContent = detail.school.display;
            if (link) link.href = detail.school.url;
            const exact = (label: string, value: string, title: string) => {
                const span = document.createElement('span');
                span.className = 'oi33-bigcat-exact';
                span.textContent = `${label} ${value}`;
                span.title = title;
                return span;
            };
            const territoryColor = colorHex(detail.color);
            const parts: Array<Node | string> = [
                exact('当前体重', formatWeight(detail.weight), `${detail.weight} g`),
                exact('历史投喂', formatWeight(detail.historyWeight), `${detail.historyWeight} g`),
                exact('领地', `${detail.territoryCount} 格`, `占领 ${detail.territoryCount} 个有色格子`),
                exact('领地色', territoryColor, territoryColor),
            ];
            if (detail.mine) {
                if (detail.mine.bound) parts.push(exact('我的当前投喂', formatWeight(detail.mine.current), `${detail.mine.current} g`));
                else if (detail.mine.history > 0) {
                    parts.push(exact('我的历史投喂', formatWeight(detail.mine.history), `${detail.mine.history} g`), '重新绑定后可恢复');
                }
            }
            if (summary) {
                summary.replaceChildren();
                parts.forEach((part, index) => {
                    if (index) summary.append(document.createTextNode(' · '));
                    summary.append(typeof part === 'string' ? document.createTextNode(part) : part);
                });
            }
            if (colorBox) colorBox.hidden = !detail.canSetColor;
            if (colorInput) colorInput.value = territoryColor;
            if (colorConfirm) {
                colorConfirm.onclick = async () => {
                    if (!colorInput) return;
                    colorConfirm.disabled = true;
                    try {
                        const result = await request.post(`${detailBaseUrl}/${schoolId}/color`, { color: colorInput.value });
                        upsertCat({ id: schoolId, catId: result.catId, color: result.color });
                        Notification.success(`领地颜色已改为 ${colorHex(result.color)}。`);
                        detailDialog.close();
                        scheduleRefresh();
                    } catch (e: any) {
                        Notification.error(e.message || String(e));
                    } finally {
                        colorConfirm.disabled = false;
                    }
                };
            }
            upsertCat({
                id: schoolId,
                catId: detail.catId,
                display: detail.school.display,
                url: detail.school.url,
                color: detail.color,
                weight: detail.weight,
                historyWeight: detail.historyWeight,
                territoryCount: detail.territoryCount,
                isAdminCat: detail.isAdminCat,
            });
            renderBoard(boardCurrent, detail.current || []);
            renderBoard(boardHistory, detail.history || []);
        } catch (e: any) {
            if (summary) summary.textContent = `读取失败：${e.message || e}`;
        }
    }

    const pickerState = { page: 1, upcount: 1, query: '' };
    const renderPickerList = (schoolRows: Array<{ id: number; display: string; prov?: string; url: string }>) => {
        const list = pickerDialog?.querySelector<HTMLElement>('[data-bigcat-picker-list]');
        if (!list) return;
        list.replaceChildren();
        if (!schoolRows.length) {
            const empty = document.createElement('li');
            empty.textContent = '没有匹配的学校。';
            list.append(empty);
            return;
        }
        schoolRows.forEach((school) => {
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
            const locked = !!me && !me.canChange && !isCurrent;
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
                        boundCatId: result.boundCatId,
                        boundDisplay: result.boundDisplay,
                        boundUrl: result.boundUrl,
                        boundColor: result.boundColor,
                        contribution: restored,
                        canChange: result.canChange !== false,
                        nextFeedAt: me?.nextFeedAt || 0,
                    };
                    upsertCat({
                        id: result.boundId,
                        catId: result.boundCatId,
                        display: result.boundDisplay,
                        url: result.boundUrl,
                        color: result.boundColor,
                    });
                    const restoredNote = restored ? `，历史投喂 ${formatWeight(restored)} 已恢复为当前投喂` : '';
                    Notification.success(result.movedToHistory
                        ? `已改绑 ${result.boundDisplay}，旧画作归属保持不变；原大猫的 ${formatWeight(result.movedToHistory)} 投喂已转入历史${restoredNote}。`
                        : `已绑定 ${result.boundDisplay}${restoredNote}，今后的绘图会归属这只大猫。`);
                    pickerDialog?.close();
                    scheduleRefresh();
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

    bindMenuButton?.addEventListener('click', () => {
        if (!pickerDialog) return;
        const hint = pickerDialog.querySelector<HTMLElement>('[data-bigcat-picker-hint]');
        if (hint) hint.textContent = me?.boundId !== null && me?.boundId !== undefined
            ? `已绑定 ${me.boundDisplay}（当前投喂 ${formatWeight(me.contribution)}） · ${me.canChange ? '本月可改绑' : '本月已改绑'}`
            : '尚未绑定大猫';
        const pickerUnbind = pickerDialog.querySelector<HTMLButtonElement>('[data-bigcat-unbind]');
        if (pickerUnbind) pickerUnbind.hidden = me?.boundId === null || me?.boundId === undefined;
        pickerDialog.showModal();
        void loadPicker();
    });
    unbindButtons.forEach((unbindButton) => {
        unbindButton.addEventListener('click', async () => {
            if (!me || me.boundId === null) return;
            if (!window.confirm(`确定取消绑定 ${me.boundDisplay || `#${me.boundId}`} 吗？当前贡献会转入历史，既有绘图归属不会改变；本月不能再次修改绑定。`)) return;
            unbindButtons.forEach((button) => { button.disabled = true; });
            try {
                const result = await request.post(unbindUrl, {});
                if (result.cat) upsertCat(result.cat);
                const moved = Math.max(0, Number(result.movedToHistory) || 0);
                me = {
                    ...me,
                    boundId: null,
                    boundCatId: 0,
                    boundDisplay: null,
                    boundUrl: null,
                    boundColor: null,
                    contribution: 0,
                    canChange: false,
                };
                if (bindMenuButton) bindMenuButton.textContent = '绑定大猫';
                unbindButtons.forEach((button) => { button.hidden = true; });
                Notification.success(`已取消绑定 ${result.previousDisplay}${moved ? `，${formatWeight(moved)} 已转入历史投喂` : ''}；既有绘图归属保持不变。`);
                pickerDialog?.close();
                detailDialog?.close();
                scheduleRefresh();
            } catch (e: any) {
                Notification.error(e.message || String(e));
            } finally {
                unbindButtons.forEach((button) => { button.disabled = false; });
            }
        });
    });
    pickerDialog?.querySelector<HTMLButtonElement>('[data-bigcat-picker-search]')?.addEventListener('click', () => {
        pickerState.query = pickerDialog.querySelector<HTMLInputElement>('[data-bigcat-picker-q]')?.value.trim() || '';
        void loadPicker();
    });
    pickerDialog?.querySelector<HTMLInputElement>('[data-bigcat-picker-q]')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        pickerState.query = (event.target as HTMLInputElement).value.trim();
        void loadPicker();
    });
    pickerDialog?.querySelector<HTMLButtonElement>('[data-bigcat-picker-prev]')?.addEventListener('click', () => {
        if (pickerState.page > 1) {
            pickerState.page -= 1;
            void loadPicker();
        }
    });
    pickerDialog?.querySelector<HTMLButtonElement>('[data-bigcat-picker-next]')?.addEventListener('click', () => {
        if (pickerState.page < pickerState.upcount) {
            pickerState.page += 1;
            void loadPicker();
        }
    });
    document.querySelector<HTMLButtonElement>('[data-bigcat-find]')?.addEventListener('click', () => {
        if (me?.boundId === null || me?.boundId === undefined) {
            pickerDialog?.showModal();
            void loadPicker();
            return;
        }
        void openDetail(me.boundId);
    });

    const refresh = async () => {
        const incoming: BigCatState = await request.get(stateUrl);
        clockOffset = incoming.serverTime - Date.now();
        const seen = new Set<number>();
        (incoming.cats || []).forEach((cat) => {
            seen.add(cat.id);
            upsertCat(cat);
        });
        let removedTerritoryColor = false;
        Array.from(cats.entries()).forEach(([id, cat]) => {
            if (seen.has(id)) return;
            cats.delete(id);
            catsByKey.delete(cat.catId);
            removedTerritoryColor = true;
        });
        me = incoming.me;
        if (bindMenuButton) bindMenuButton.textContent = me?.boundId === null || me?.boundId === undefined
            ? '绑定大猫' : '更换 / 取消大猫';
        renderRanking(incoming.ranking || []);
        if (rankingLink) rankingLink.textContent = `查看完整榜单（共 ${incoming.rankingTotal ?? cats.size} 只）→`;
        if (catCount) catCount.textContent = String(cats.size);
        if (removedTerritoryColor) host.onTerritoryColorsChanged();
        host.invalidate();
    };

    function scheduleRefresh() {
        // Trailing debounce: a burst of ownership changes causes one compact
        // cat-metadata request per client, not one request every 150 ms.
        if (refreshTimer !== null) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
            refreshTimer = null;
            refresh().catch((e) => Notification.error(`大猫数据刷新失败：${e.message || e}`));
        }, 500);
    }

    refresh().catch((e) => Notification.error(`大猫数据加载失败：${e.message || e}`));

    return {
        colorFor: (catId: number) => {
            if (!catId) return '#b8bcc2';
            const cat = catsByKey.get(catId);
            return cat ? colorHex(cat.color) : '#8b9299';
        },
        colorValueFor: (catId: number) => {
            if (!catId) return 0xB8BCC2;
            return catsByKey.get(catId)?.color ?? 0x8B9299;
        },
        labelFor: (catId: number) => {
            if (!catId) return '大猫 0 号（未绑定）';
            return catsByKey.get(catId)?.display || `大猫 #${catId - 1}`;
        },
        schoolIdForCatId: (catId: number) => Number.isSafeInteger(catId) && catId > 0 ? catId - 1 : null,
        boundCatId: () => me?.boundCatId || 0,
        openDetail: (schoolId: number) => { void openDetail(schoolId); },
        handleSocketMessage: (payload: any) => {
            if (payload?.type !== 'bigcat') return;
            const incoming = payload.cat || {};
            const id = Number.isSafeInteger(Number(incoming.id))
                ? Number(incoming.id)
                : Number.isSafeInteger(Number(incoming.catId)) && Number(incoming.catId) > 0
                    ? Number(incoming.catId) - 1
                    : null;
            // A cell update may only carry catId. If this is a new cat, wait
            // for the debounced authoritative refresh instead of inventing a
            // temporary black color and rebuilding the full territory layer.
            if (id !== null && (cats.has(id) || Number.isSafeInteger(Number(incoming.color)))) {
                upsertCat({ ...incoming, id });
            }
            scheduleRefresh();
        },
        refresh,
        isDialogOpen: () => !!(detailDialog?.open || pickerDialog?.open),
    };
}
