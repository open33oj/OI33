// Medal showcase wall geometry, shared by the server-rendered profile and the
// browser editor (frontend/medal-showcase.page.ts imports this file directly,
// so it is bundled into entry.js).
//
// Nothing in this module may import hydrooj, the database or the DOM: it is
// the only model code the client is allowed to depend on.

// --- Showcase wall (奖章展示墙) -------------------------------------------
//
// The wall is a **320×128 pixel canvas** made of 10×4 equal 32-pixel cells: every
// medal is drawn at the same size (uniform stamps), so ten complete medals fit
// across and exactly four rows fit down. A placement stores the top-left corner
// in canvas pixels; the editor snaps to half a cell (16 px) so medals can also
// sit on row/column boundaries. The profile shows the canvas scaled up by an
// integer factor (`medalShowcaseScale`) and the sprites are upscaled from their
// 8/16/24/32 px originals with nearest-neighbour sampling, so the art stays crisp.
//
// 一般奖章可以重复获得，所以同一个 medalId 允许出现多次（份数上限见
// medalShowcaseCopyLimit）；其它系列每枚奖章最多一份。
export const MEDAL_SHOWCASE_CELL = 32;
export const MEDAL_SHOWCASE_COLUMNS = 10;
export const MEDAL_SHOWCASE_ROWS = 4;
export const MEDAL_SHOWCASE_WIDTH = MEDAL_SHOWCASE_CELL * MEDAL_SHOWCASE_COLUMNS;
export const MEDAL_SHOWCASE_HEIGHT = MEDAL_SHOWCASE_CELL * MEDAL_SHOWCASE_ROWS;
// The editor snaps to half a cell (16 px) so medals can align to a half row or
// half column; hold Alt for free 1-pixel placement.
export const MEDAL_SHOWCASE_SNAP = MEDAL_SHOWCASE_CELL / 2;
// The canvas holds exactly 10×4 medals, so that is also the placement cap.
export const MEDAL_SHOWCASE_MAX_PIECES = MEDAL_SHOWCASE_COLUMNS * MEDAL_SHOWCASE_ROWS;
export const MEDAL_SHOWCASE_MIN_SCALE = 1;
export const MEDAL_SHOWCASE_MAX_SCALE = 6;

export interface MedalShowcasePiece {
    id: string;
    x: number;
    y: number;
}

// Integer display scale for a wall rendered inside `availableWidth` CSS pixels.
// Never fractional, so the 320×128 canvas keeps square pixels when enlarged.
export function medalShowcaseScale(
    availableWidth: unknown,
    minScale = MEDAL_SHOWCASE_MIN_SCALE,
    maxScale = MEDAL_SHOWCASE_MAX_SCALE,
): number {
    const max = Math.max(1, Math.floor(Number(maxScale) || MEDAL_SHOWCASE_MAX_SCALE));
    const min = Math.min(max, Math.max(1, Math.floor(Number(minScale) || MEDAL_SHOWCASE_MIN_SCALE)));
    const width = Math.floor(Number(availableWidth) || 0);
    if (width <= 0) return min;
    return Math.min(max, Math.max(min, Math.floor(width / MEDAL_SHOWCASE_WIDTH)));
}
