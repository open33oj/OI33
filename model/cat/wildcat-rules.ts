// 野猫模式的时间规则：只在 Asia/Shanghai 的偶数整点（00:00、02:00 … 22:00）
// 检查一次，而不是从每只野猫自己的开启时间起算。纯函数，不依赖 hydrooj/DB。

export const WILD_CAT_SLOT_HOURS = 2;
export const WILD_CAT_SLOT_MS = WILD_CAT_SLOT_HOURS * 60 * 60 * 1000;
// 走到从未染色的格子时使用的颜色：xterm-256 的 15 号白色。
export const WILD_CAT_NEW_CELL_COLOR = 15;

// 移动来源：手动操作、路径计划自动执行、野猫自动移动。野猫模式开启后
// 只允许后两者继续，手动移动必须等用户关闭野猫模式。
export type CatMoveSource = 'manual' | 'plan' | 'wildcat';

export function wildCatBlocksManualMove(
    wildcat: unknown,
    source: CatMoveSource = 'manual',
): boolean {
    return wildcat === true && source === 'manual';
}

// Asia/Shanghai 固定 UTC+8、没有夏令时，因此可以直接在 epoch 上取整。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

// `now` 所属的偶数整点槽位（该小时 :00:00.000 的 Date）。
export function wildCatSlotStart(now: Date): Date {
    const local = now.getTime() + SHANGHAI_OFFSET_MS;
    const slot = Math.floor(local / WILD_CAT_SLOT_MS) * WILD_CAT_SLOT_MS;
    return new Date(slot - SHANGHAI_OFFSET_MS);
}

// 下一次检查的偶数整点；严格晚于 `now`（在整点当下开启会等到下一个整点）。
export function nextWildCatSlot(now: Date): Date {
    return new Date(wildCatSlotStart(now).getTime() + WILD_CAT_SLOT_MS);
}
