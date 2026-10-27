// 进程内运行状态：启动时哪些功能部件没挂上、定时任务最近一次成功/失败、
// 本次进程内执行过的运维动作。刻意不落库：它描述的是「这个进程」的健康，
// 重启即重置；页面在 `/oi33/admin/ops`。
export interface OpsTaskState {
    lastRunAt?: Date;
    lastSuccessAt?: Date;
    lastError?: string;
    lastMessage?: string;
    runs: number;
    failures: number;
}

export interface OpsActionRecord {
    action: string;
    operator: number;
    at: Date;
    ok: boolean;
    message: string;
}

export interface ApplyFailure {
    name: string;
    message: string;
    at: Date;
}

const startedAt = new Date();
const tasks = new Map<string, OpsTaskState>();
const applyFailures: ApplyFailure[] = [];
const actions: OpsActionRecord[] = [];

const MAX_RECORDS = 20;
const messageOf = (error: unknown) => String((error as any)?.message || error || 'unknown error');

function stateOf(name: string): OpsTaskState {
    let state = tasks.get(name);
    if (!state) {
        state = { runs: 0, failures: 0 };
        tasks.set(name, state);
    }
    return state;
}

export function markTaskStart(name: string) {
    const state = stateOf(name);
    state.lastRunAt = new Date();
    state.runs++;
}

export function markTaskSuccess(name: string, message?: string) {
    const state = stateOf(name);
    state.lastSuccessAt = new Date();
    state.lastError = '';
    if (message) state.lastMessage = message;
}

export function markTaskError(name: string, error: unknown) {
    const state = stateOf(name);
    state.failures++;
    state.lastError = messageOf(error);
}

export function recordApplyFailure(name: string, error: unknown) {
    applyFailures.unshift({ name, message: messageOf(error), at: new Date() });
    if (applyFailures.length > MAX_RECORDS) applyFailures.length = MAX_RECORDS;
}

export function recordOpsAction(action: string, operator: number, ok: boolean, message: string) {
    actions.unshift({ action, operator, ok, message, at: new Date() });
    if (actions.length > MAX_RECORDS) actions.length = MAX_RECORDS;
}

export function getOpsStatus() {
    return {
        startedAt,
        tasks: Array.from(tasks, ([name, state]) => ({ name, ...state })),
        applyFailures: [...applyFailures],
        actions: [...actions],
    };
}
