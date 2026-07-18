import { addPage, NamedPage } from '@hydrooj/ui-default';
import './cat-can.css';

function formatCatFood(value: number) {
    const absolute = Math.abs(value);
    if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} t`;
    if (absolute >= 1_000) return `${(value / 1_000).toFixed(2)} kg`;
    return `${value} g`;
}

function formatTime(value: Date) {
    return value.toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    });
}

function mountCatCanMarket() {
    const page = document.querySelector<HTMLElement>('.oi33-can-page');
    if (!page) return;
    const buyPrice = Number(page.dataset.buyPrice) || 0;
    const sellPrice = Number(page.dataset.sellPrice) || 0;
    const balance = Number(page.dataset.balance) || 0;
    const inventory = Number(page.dataset.inventory) || 0;
    const available = Number(page.dataset.available) || 0;
    const min = Number(page.dataset.min) || 1;
    const step = Number(page.dataset.step) || 1;
    const max = Number.MAX_SAFE_INTEGER;
    const feeNumerator = Number(page.dataset.feeNumerator) || 25;
    const feeDenominator = Number(page.dataset.feeDenominator) || 100000;
    const cooldownUntil = Number(page.dataset.cooldownUntil) || 0;
    const tradeCooldown = Number(page.dataset.tradeCooldown) || 2 * 60 * 60 * 1000;
    const feeFor = (amount: number) => Math.floor((amount * feeNumerator + feeDenominator - 1) / feeDenominator);
    const isCoolingDown = () => cooldownUntil > Date.now();
    let cooldownExpired = false;
    const renders: Array<() => void> = [];

    page.querySelectorAll<HTMLFormElement>('[data-can-form]').forEach((form) => {
        const kind = form.dataset.canForm === 'sell' ? 'sell' : 'buy';
        const baseDisabled = form.dataset.baseDisabled === '1';
        const input = form.querySelector<HTMLInputElement>('[name="quantity"]');
        const estimate = form.querySelector<HTMLElement>(`[data-estimate="${kind}"]`);
        const submit = form.querySelector<HTMLButtonElement>('[type="submit"]');
        if (!input) return;
        let submitting = false;

        let limit = kind === 'buy'
            ? Math.min(max, available, Math.floor(balance / buyPrice / step) * step)
            : Math.min(max, Math.floor(inventory / step) * step);
        limit = Math.floor(limit / step) * step;
        if (kind === 'buy') {
            while (limit >= min && limit * buyPrice + feeFor(limit * buyPrice) > balance) limit -= step;
        }
        const normalize = (value: number) => Math.min(max, Math.max(min, Math.floor(value / step) * step));
        const calculate = () => {
            const quantity = normalize(Number(input.value) || min);
            const principal = quantity * (kind === 'buy' ? buyPrice : sellPrice);
            const fee = feeFor(principal);
            const total = kind === 'buy' ? principal + fee : Math.max(0, principal - fee);
            return { quantity, principal, fee, total };
        };
        const render = () => {
            const calculation = calculate();
            input.value = String(calculation.quantity);
            input.disabled = baseDisabled || isCoolingDown() || cooldownExpired;
            if (estimate) {
                estimate.textContent = kind === 'buy'
                    ? `含手续费总价：${formatCatFood(calculation.total)}`
                    : `预计到账：${formatCatFood(calculation.total)}（扣除 ${formatCatFood(calculation.fee)} 手续费）`;
                estimate.title = kind === 'buy'
                    ? `${calculation.total} g`
                    : `到账 ${calculation.total} g，手续费 ${calculation.fee} g`;
            }
            if (submit) submit.disabled = submitting || input.disabled || calculation.quantity > limit || limit < min;
        };
        renders.push(render);

        form.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((button) => {
            button.addEventListener('click', () => {
                input.value = String(normalize((Number(input.value) || 0) + Number(button.dataset.add || min)));
                render();
            });
        });
        form.querySelector<HTMLButtonElement>('[data-fill]')?.addEventListener('click', () => {
            if (limit >= min) input.value = String(limit);
            render();
        });
        input.addEventListener('input', render);
        form.addEventListener('submit', (event) => {
            const calculation = calculate();
            const nextTime = new Date(Date.now() + tradeCooldown);
            const summary = kind === 'buy'
                ? `确认买入 ${calculation.quantity} 个猫罐头？\n含手续费总价：${formatCatFood(calculation.total)}（${calculation.total} g）`
                : `确认卖出 ${calculation.quantity} 个猫罐头？\n预计到账：${formatCatFood(calculation.total)}（扣除 ${formatCatFood(calculation.fee)} 手续费）`;
            const confirmed = window.confirm(`${summary}\n\n本次交易完成后，下一次允许交易时间：${formatTime(nextTime)}`);
            if (!confirmed) {
                event.preventDefault();
                return;
            }
            submitting = true;
            if (submit) {
                submit.disabled = true;
                submit.textContent = '处理中…';
            }
        });
        render();
    });

    const countdown = page.querySelector<HTMLElement>('[data-cooldown-countdown]');
    let cooldownTimer: number | undefined;
    const renderCooldown = () => {
        const remaining = Math.max(0, cooldownUntil - Date.now());
        if (countdown) {
            if (!remaining) {
                if (cooldownUntil) {
                    cooldownExpired = true;
                    countdown.textContent = '冷却结束，请刷新页面';
                    if (cooldownTimer !== undefined) window.clearInterval(cooldownTimer);
                } else {
                    countdown.textContent = '当前可交易';
                    countdown.removeAttribute('title');
                }
            } else {
                const seconds = Math.ceil(remaining / 1000);
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor(seconds % 3600 / 60);
                const secs = seconds % 60;
                countdown.textContent = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')} 后可交易`;
                countdown.title = `下一次允许交易时间：${formatTime(new Date(cooldownUntil))}`;
            }
        }
        for (const render of renders) render();
    };
    renderCooldown();
    if (cooldownUntil > Date.now()) cooldownTimer = window.setInterval(renderCooldown, 1000);
}

addPage(new NamedPage('oi33_cat_can', mountCatCanMarket));
