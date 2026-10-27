// 地图尺寸/分区与地图状态类型。尺寸来自 shared/cat-map.ts（服务端与浏览器
// 同一份），不要再在这里写死数字。
export {
    CAT_MAP_CORE_MAX as CORE_ZONE_MAX,
    CAT_MAP_CORE_MIN as CORE_ZONE_MIN,
    CAT_MAP_HEIGHT as MAP_HEIGHT,
    CAT_MAP_WIDTH as MAP_WIDTH,
    isCatMapCoreZone,
} from '../shared/cat-map';

export interface MapPlayer {
    uid: number;
    uname: string;
    x: number;
    y: number;
    cans: number;
    food: number;
    availableAt: number;
    freeColorAvailable: boolean;
    wildcat?: boolean;
    wildcatNextAt?: number;
}

export interface MapPlanStep {
    index: number;
    x: number;
    y: number;
    color: number;
    executed: boolean;
}

export interface MapPlan {
    status: 'active' | 'done' | 'stopped';
    cursor: number;
    steps: MapPlanStep[];
    maxSteps: number;
    originX: number;
    originY: number;
    nextAt: number;
    failReason: string;
    updatedAt: number;
}

export interface MapState {
    width: number;
    height: number;
    players: MapPlayer[];
    cells: [number, number, number, number][];
    me: MapPlayer | null;
    canJoin: boolean;
    plan?: MapPlan | null;
    planMaxSteps?: number;
    serverTime: number;
}
