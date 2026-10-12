// 地图尺寸与地图状态类型（与服务端 model/cat-map.ts 同步），供 cat-can-arena.page.ts
// 及其子模块共享。
export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 1000;

export interface MapPlayer {
    uid: number;
    uname: string;
    x: number;
    y: number;
    cans: number;
    food: number;
    availableAt: number;
    freeColorAvailable: boolean;
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
