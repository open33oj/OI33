// 猫咪地图的几何常量与分区判定。前后端共用（服务端 `model/cat/*`、浏览器
// `frontend/cat-can-arena.page.ts`），所以这里**不得** import hydrooj / DB / DOM。
//
// 地图 1000×1000：距边框 250 格的环形是帝国区，中央 500×500（坐标 250~749）
// 是 00区。00区内上下左右四邻全归属同一大猫的格子是「领地核心」。
export const CAT_MAP_WIDTH = 1000;
export const CAT_MAP_HEIGHT = 1000;
export const CAT_MAP_CORE_MIN = 250;
export const CAT_MAP_CORE_MAX = CAT_MAP_WIDTH - CAT_MAP_CORE_MIN - 1;

export function isCatMapCoreZone(x: number, y: number) {
    return x >= CAT_MAP_CORE_MIN && x <= CAT_MAP_CORE_MAX
        && y >= CAT_MAP_CORE_MIN && y <= CAT_MAP_CORE_MAX;
}

// 256 色地图调色板（xterm-256）。野猫模式走到从没染过色的格子时，需要给
// 它一个可见颜色：取该大猫领地颜色的最近调色板色，这样原始视图和「大猫
// 视角」都不会出现「有归属但没颜色」的格子。
function paletteColorValue(code: number): number {
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

export function nearestCatMapPaletteCode(rgb: number): number {
    const red = (rgb >> 16) & 0xFF;
    const green = (rgb >> 8) & 0xFF;
    const blue = rgb & 0xFF;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let code = 0; code < 256; code++) {
        const value = paletteColorValue(code);
        const dr = ((value >> 16) & 0xFF) - red;
        const dg = ((value >> 8) & 0xFF) - green;
        const db = (value & 0xFF) - blue;
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = code;
        }
    }
    return best;
}
