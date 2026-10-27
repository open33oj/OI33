// Pure cat-map grid / path-planning rules. No hydrooj or DB imports, so this
// module is unit-testable with plain `node --test`. The plan executor
// (model/cat/map-plan.ts) and the map model (model/cat/map.ts) both build on
// these so the bounds and the step limit can never drift apart.

import { CAT_MAP_HEIGHT, CAT_MAP_WIDTH } from '../../shared/cat-map.ts';

// 尺寸与分区定义在 shared/cat-map.ts（前后端共用）；这里再导出一次，保持
// `model/cat/map-plan-rules` 的公开 API 不变。显式 .ts 后缀是 node --test
// 的原生 type-stripping 要求的。
export { CAT_MAP_HEIGHT, CAT_MAP_WIDTH } from '../../shared/cat-map.ts';

// 路径规划：一步 = 移动到相邻格 + 涂抹该格。步数上限是可配置项
// （oi33_cat_map_config.planMaxSteps），这里是默认值与硬上限。
export const CAT_MAP_PLAN_MAX_STEPS_DEFAULT = 10;
export const CAT_MAP_PLAN_MAX_STEPS_LIMIT = 50;

export function validCoordinate(x: number, y: number) {
    return Number.isSafeInteger(x) && Number.isSafeInteger(y)
        && x >= 0 && x < CAT_MAP_WIDTH && y >= 0 && y < CAT_MAP_HEIGHT;
}

export function validColor(color: number) {
    return Number.isSafeInteger(color) && color >= 0 && color <= 255;
}

export function normalizeCatMapPlanMaxSteps(value: unknown): number {
    const steps = Math.floor(Number(value) || 0);
    if (!Number.isFinite(steps) || steps < 1) return CAT_MAP_PLAN_MAX_STEPS_DEFAULT;
    return Math.min(steps, CAT_MAP_PLAN_MAX_STEPS_LIMIT);
}

// 纯校验（无数据库访问，便于单测）：数量、坐标、颜色，以及「路径必须连续」——
// 第一步必须与 base 相邻，之后每一步都必须与上一步相邻（曼哈顿距离为 1）。
export function validateCatMapPlanShape(
    steps: unknown,
    base: { x: number; y: number },
    maxSteps = CAT_MAP_PLAN_MAX_STEPS_DEFAULT,
): Array<{ x: number; y: number; color: number }> {
    if (!Array.isArray(steps) || !steps.length) throw new Error('计划至少需要 1 步。');
    if (steps.length > maxSteps) throw new Error(`计划最多 ${maxSteps} 步。`);
    const normalized: Array<{ x: number; y: number; color: number }> = [];
    let previous = { x: Number(base?.x), y: Number(base?.y) };
    steps.forEach((raw: any, index: number) => {
        const x = Number(raw?.x);
        const y = Number(raw?.y);
        const color = Number(raw?.color);
        if (!validCoordinate(x, y)) throw new Error(`第 ${index + 1} 步的坐标超出地图范围。`);
        if (!validColor(color)) throw new Error(`第 ${index + 1} 步的颜色码必须是 0～255 的整数。`);
        const distance = Math.abs(previous.x - x) + Math.abs(previous.y - y);
        if (distance !== 1) {
            throw new Error(`第 ${index + 1} 步必须与上一步相邻（只能走到上下左右一格），计划路径必须连续。`);
        }
        normalized.push({ x, y, color });
        previous = { x, y };
    });
    return normalized;
}
