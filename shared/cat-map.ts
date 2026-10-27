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
