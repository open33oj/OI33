import './cat.css';

type CatFrame = 'sit' | 'sit-tail' | 'walk-a' | 'walk-b';

function mixSeed(uid: number, salt = 0) {
    let value = ((uid >>> 0) ^ 0x9e3779b9 ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
    return (value ^ (value >>> 16)) >>> 0;
}

function seededRandom(seed: number) {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function mountCat(stage: HTMLElement) {
    const uid = Number.parseInt(stage.dataset.uid || '0', 10) || 0;
    const actor = stage.querySelector<HTMLButtonElement>('.oi33-cat-actor');
    const sprite = stage.querySelector<HTMLElement>('.oi33-cat-sprite');
    const message = stage.parentElement?.querySelector<HTMLElement>('.oi33-cat-message');
    if (!actor || !sprite) return;

    const spriteUrl = stage.dataset.spriteUrl || '/oi33-cat-sprites.svg';
    sprite.style.backgroundImage = `url("${spriteUrl.replace(/"/g, '%22')}")`;

    const random = seededRandom(mixSeed(uid, Date.now() & 0xffff));
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const CAT_SIZE = 80;
    const SIDE_PADDING = 10;
    let x = 0;
    let state: CatFrame = 'sit';
    let active = false;
    let inViewport = true;
    let destroyed = false;
    let actionTimer = 0;
    let tailTimer = 0;
    let animationFrame = 0;

    const setFrame = (frame: CatFrame) => {
        state = frame;
        const walking = frame === 'walk-a' || frame === 'walk-b';
        stage.dataset.catState = frame;
        stage.classList.toggle('is-walking', walking);
        actor.disabled = walking || reducedMotion;
    };

    const maxX = () => Math.max(SIDE_PADDING, stage.clientWidth - CAT_SIZE - SIDE_PADDING);
    const clampX = (value: number) => Math.min(maxX(), Math.max(SIDE_PADDING, value));
    const renderPosition = () => {
        actor.style.transform = `translate3d(${Math.round(x)}px, 0, 0)`;
    };

    const clearMotion = () => {
        window.clearTimeout(actionTimer);
        window.clearTimeout(tailTimer);
        window.cancelAnimationFrame(animationFrame);
        actionTimer = 0;
        tailTimer = 0;
        animationFrame = 0;
    };

    const setMessage = (text: string) => {
        if (message) message.textContent = text;
    };

    const wagTail = () => {
        if (!active || state !== 'sit') return;
        setFrame('sit-tail');
        setMessage('小猫竖起尾巴看了看四周');
        tailTimer = window.setTimeout(() => {
            if (!active || state !== 'sit-tail') return;
            setFrame('sit');
            setMessage('小猫安静地坐着');
        }, 360 + Math.floor(random() * 280));
    };

    function sit(shortRest = false) {
        if (!active || destroyed) return;
        setFrame('sit');
        actor.disabled = reducedMotion;
        delete stage.dataset.catDirection;
        setMessage('小猫坐下来休息了');
        const restTime = shortRest
            ? 1000 + random() * 900
            : 2200 + random() * 3600;
        if (!shortRest && random() < 0.72) {
            tailTimer = window.setTimeout(wagTail, 450 + random() * Math.max(500, restTime - 1100));
        }
        actionTimer = window.setTimeout(walkRandomly, restTime);
    }

    const walkTo = (targetValue: number, clicked = false) => {
        if (!active || destroyed || reducedMotion) return;
        clearMotion();
        const target = clampX(targetValue);
        const startX = x;
        const distance = Math.abs(target - startX);
        if (distance < 4) {
            sit(true);
            return;
        }

        const direction = target < startX ? -1 : 1;
        const startedAt = performance.now();
        const speed = clicked ? 52 : 25 + random() * 14;
        const duration = Math.max(500, distance / speed * 1000);
        let lastFrame: CatFrame = 'walk-a';

        stage.dataset.catDirection = direction < 0 ? 'left' : 'right';
        setFrame(lastFrame);
        setMessage(clicked
            ? (direction < 0 ? '小猫听见你了，正走向左边' : '小猫听见你了，正走向右边')
            : (direction < 0 ? '小猫向左边溜达' : '小猫向右边溜达'));

        const step = (now: number) => {
            if (!active || destroyed) return;
            const progress = Math.min(1, (now - startedAt) / duration);
            const eased = progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;
            const nextFrame: CatFrame = Math.floor((now - startedAt) / 210) % 2 ? 'walk-b' : 'walk-a';
            if (nextFrame !== lastFrame) {
                lastFrame = nextFrame;
                setFrame(nextFrame);
            }
            x = startX + (target - startX) * eased;
            renderPosition();
            if (progress < 1) {
                animationFrame = window.requestAnimationFrame(step);
            } else {
                sit();
            }
        };
        animationFrame = window.requestAnimationFrame(step);
    };

    function walkRandomly() {
        if (!active || destroyed) return;
        const rightEdge = maxX();
        if (rightEdge <= SIDE_PADDING + 12) return;

        let direction = random() < 0.5 ? -1 : 1;
        if (x < SIDE_PADDING + 24) direction = 1;
        if (x > rightEdge - 24) direction = -1;
        const available = direction > 0 ? rightEdge - x : x - SIDE_PADDING;
        const distance = Math.min(available, 55 + random() * 125);
        if (distance < 18) direction *= -1;
        const correctedAvailable = direction > 0 ? rightEdge - x : x - SIDE_PADDING;
        const correctedDistance = Math.min(correctedAvailable, Math.max(24, distance));
        walkTo(x + direction * correctedDistance);
    }

    const walkToOtherSide = () => {
        if (!active || destroyed || reducedMotion || actor.disabled) return;
        const middle = (SIDE_PADDING + maxX()) / 2;
        walkTo(x <= middle ? maxX() : SIDE_PADDING, true);
    };

    const pause = () => {
        if (!active) return;
        active = false;
        clearMotion();
        setFrame('sit');
        delete stage.dataset.catDirection;
        setMessage('小猫正在休息');
    };

    const resume = () => {
        if (active || destroyed || reducedMotion || document.hidden || !inViewport) return;
        active = true;
        sit(true);
    };

    actor.addEventListener('click', walkToOtherSide);

    const visibility = () => {
        if (document.hidden) pause();
        else resume();
    };
    document.addEventListener('visibilitychange', visibility);

    const intersection = new IntersectionObserver((entries) => {
        inViewport = entries[0]?.isIntersecting ?? true;
        if (inViewport) resume();
        else pause();
    }, { threshold: 0.05 });
    intersection.observe(stage);

    const resize = () => {
        x = clampX(x);
        renderPosition();
    };
    window.addEventListener('resize', resize);

    const removalObserver = new MutationObserver(() => {
        if (stage.isConnected) return;
        destroyed = true;
        clearMotion();
        intersection.disconnect();
        removalObserver.disconnect();
        document.removeEventListener('visibilitychange', visibility);
        window.removeEventListener('resize', resize);
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });

    window.requestAnimationFrame(() => {
        x = clampX(SIDE_PADDING + random() * Math.max(0, maxX() - SIDE_PADDING));
        renderPosition();
        setFrame('sit');
        if (reducedMotion) setMessage('小猫安静地坐着');
        else resume();
    });
}

export function mountCats() {
    document.querySelectorAll<HTMLElement>('.oi33-cat-stage').forEach((stage) => {
        if (stage.dataset.nativeCatMounted === 'true') return;
        stage.dataset.nativeCatMounted = 'true';
        mountCat(stage);
    });
}
