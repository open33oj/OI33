export function paletteColorValue(code: number) {
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

export function paletteColor(code: number) {
    return `#${paletteColorValue(code).toString(16).padStart(6, '0')}`;
}

// 计划编号要压在颜色圆圈上：按 WCAG 相对亮度取黑/白中对比度更高的那个，
// 深色底用白字、浅色底用黑字。
export function paletteTextColor(code: number) {
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

export const PALETTE_VALUES = new Uint32Array(Array.from({ length: 256 }, (_, code) => paletteColorValue(code)));

export function mountPalettes() {
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
