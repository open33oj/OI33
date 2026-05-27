import {
    Context, Handler, PRIV, SystemModel, Types, db, param,
} from 'hydrooj';

const statusColl = db.collection('status');

const KEY_ENABLED = 'oi33.judge_monitor.enabled';
const KEY_INCLUDE_SERVER = 'oi33.judge_monitor.include_server';
const KEY_WEBHOOK = 'oi33.judge_monitor.webhook';
const KEY_LAST_STATE = 'oi33.judge_monitor.last_state';
const KEY_LAST_CHECK_AT = 'oi33.judge_monitor.last_check_at';
const KEY_LAST_CHECK_TOTAL = 'oi33.judge_monitor.last_check_total';
const KEY_LAST_CHECK_ONLINE = 'oi33.judge_monitor.last_check_online';
const KEY_LAST_NOTIFY_AT = 'oi33.judge_monitor.last_notify_at';
const KEY_LAST_NOTIFY_KIND = 'oi33.judge_monitor.last_notify_kind';

// hydrojudge 每 20 分钟心跳一次（packages/hydrojudge/src/hosts/hydro.ts: 1200000ms），
// 留 2 分钟容忍网络抖动，judge 22 分钟未上报即判定离线。
// type:'server' 即嵌入式部署下的 OJ 自身（同时承担评测），心跳 30 分钟一次（service/monitor.ts: 1800000ms），
// 阈值放宽到 32 分钟。
const JUDGE_THRESHOLD_MS = 22 * 60 * 1000;
const SERVER_THRESHOLD_MS = 32 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

interface JudgeStatus {
    mid: string;
    type: 'judge' | 'server';
    updateAt: Date;
    online: boolean;
    minutesSince: number;
    name?: string;
    ip?: string;
}

async function getJudgeStatuses(): Promise<JudgeStatus[]> {
    const includeServer = SystemModel.get(KEY_INCLUDE_SERVER) as boolean | undefined;
    const types: string[] = includeServer ? ['judge', 'server'] : ['judge'];
    const docs = await statusColl.find({ type: { $in: types } }).sort({ updateAt: -1 }).toArray();
    const now = Date.now();
    return docs.map((d: any) => {
        const updateAt = new Date(d.updateAt);
        const elapsed = now - updateAt.getTime();
        const type = d.type === 'judge' ? 'judge' : 'server';
        const threshold = type === 'judge' ? JUDGE_THRESHOLD_MS : SERVER_THRESHOLD_MS;
        return {
            mid: d.mid || String(d._id),
            type,
            updateAt,
            online: elapsed < threshold,
            minutesSince: Math.floor(elapsed / 60000),
            name: d.name,
            ip: d.ip,
        };
    });
}

function fmtDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtElapsed(minutes: number): string {
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟前`;
    const days = Math.floor(hours / 24);
    return `${days} 天 ${hours % 24} 小时前`;
}

async function sendWecom(webhookUrl: string, content: string): Promise<{ ok: boolean; error?: string }> {
    if (!webhookUrl) return { ok: false, error: 'webhook_url_not_configured' };
    try {
        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const data = await res.json().catch(() => ({}));
        if (data.errcode && data.errcode !== 0) {
            return { ok: false, error: `errcode=${data.errcode} ${data.errmsg || ''}` };
        }
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e.message || String(e) };
    }
}

function buildStatusReport(statuses: JudgeStatus[]): string {
    if (!statuses.length) return '当前没有任何评测机注册过心跳。';
    const lines = statuses.map((s) => {
        const tag = s.online ? '<font color="info">在线</font>' : '<font color="warning">离线</font>';
        const typeLabel = s.type === 'judge' ? 'judge' : 'server';
        const label = s.name || s.mid;
        return `> ${tag} **${label}** \`${typeLabel}\` — 最后心跳 ${fmtDate(s.updateAt)}（${fmtElapsed(s.minutesSince)}）`;
    });
    return lines.join('\n');
}

function buildOfflineMessage(statuses: JudgeStatus[]): string {
    return [
        '## ⚠️ 评测机全部离线告警',
        '',
        `所有评测机心跳均已超过判定阈值（judge ${Math.floor(JUDGE_THRESHOLD_MS / 60000)} 分钟 / server ${Math.floor(SERVER_THRESHOLD_MS / 60000)} 分钟）。`,
        '',
        buildStatusReport(statuses),
        '',
        `> 检测时间：${fmtDate(new Date())}`,
    ].join('\n');
}

function buildRecoveryMessage(statuses: JudgeStatus[]): string {
    const onlineCount = statuses.filter((s) => s.online).length;
    return [
        '## ✅ 评测机已恢复',
        '',
        `当前有 ${onlineCount} 台评测机在线。`,
        '',
        buildStatusReport(statuses),
        '',
        `> 检测时间：${fmtDate(new Date())}`,
    ].join('\n');
}

function buildManualMessage(statuses: JudgeStatus[]): string {
    const onlineCount = statuses.filter((s) => s.online).length;
    return [
        `## 评测机状态（手动推送）`,
        '',
        `共 ${statuses.length} 台评测机，其中 ${onlineCount} 台在线。`,
        '',
        buildStatusReport(statuses),
        '',
        `> 检测时间：${fmtDate(new Date())}`,
    ].join('\n');
}

function buildDeltaMessage(
    joined: JudgeStatus[], left: JudgeStatus[], allStatuses: JudgeStatus[],
): string {
    const lines: string[] = ['## 🔔 评测机状态变更', ''];
    if (joined.length) {
        lines.push(`**新增在线** (${joined.length} 台)：`);
        for (const s of joined) {
            const typeLabel = s.type === 'judge' ? 'judge' : 'server';
            lines.push(`> 🟢 **${s.name || s.mid}** \`${typeLabel}\``);
        }
        lines.push('');
    }
    if (left.length) {
        lines.push(`**掉线** (${left.length} 台)：`);
        for (const s of left) {
            const typeLabel = s.type === 'judge' ? 'judge' : 'server';
            lines.push(`> 🔴 **${s.name || s.mid}** \`${typeLabel}\` — 最后心跳 ${fmtDate(s.updateAt)}（${fmtElapsed(s.minutesSince)}）`);
        }
        lines.push('');
    }
    lines.push('---');
    lines.push('**当前状态**：');
    lines.push(buildStatusReport(allStatuses));
    lines.push('');
    lines.push(`> 检测时间：${fmtDate(new Date())}`);
    return lines.join('\n');
}

async function runScheduledCheck(force = false) {
    if (!force && !SystemModel.get(KEY_ENABLED)) return;
    const statuses = await getJudgeStatuses();
    const onlineMids = statuses.filter((s) => s.online).map((s) => s.mid);
    const onlineCount = onlineMids.length;
    const now = new Date();

    await SystemModel.set(KEY_LAST_CHECK_AT, now.toISOString());
    await SystemModel.set(KEY_LAST_CHECK_TOTAL, statuses.length);
    await SystemModel.set(KEY_LAST_CHECK_ONLINE, onlineCount);

    const webhookUrl = SystemModel.get(KEY_WEBHOOK) as string;
    if (!webhookUrl) return;
    if (!statuses.length) return;

    const prevStateRaw = SystemModel.get(KEY_LAST_STATE) as string | undefined;
    if (!prevStateRaw) {
        await SystemModel.set(KEY_LAST_STATE, JSON.stringify(onlineMids));
        return;
    }

    let prevOnlineMids: string[];
    try {
        prevOnlineMids = JSON.parse(prevStateRaw);
        if (!Array.isArray(prevOnlineMids) || !prevOnlineMids.every((m) => typeof m === 'string')) {
            throw new Error('Invalid state format');
        }
    } catch {
        await SystemModel.set(KEY_LAST_STATE, JSON.stringify(onlineMids));
        return;
    }
    const currentSet = new Set(onlineMids);
    const prevSet = new Set(prevOnlineMids);
    const joinedMids = [...currentSet].filter((m) => !prevSet.has(m));
    const leftMids = [...prevSet].filter((m) => !currentSet.has(m));

    if (joinedMids.length === 0 && leftMids.length === 0) return;

    const joined = statuses.filter((s) => joinedMids.includes(s.mid));
    const left = leftMids.map((mid) => {
        const found = statuses.find((s) => s.mid === mid);
        return found || { mid, type: 'judge' as const, updateAt: new Date(0), online: false, minutesSince: 0, name: mid };
    });

    const allOffline = onlineCount === 0;
    const wasAllOffline = prevOnlineMids.length === 0;

    let message: string;
    let kind: string;
    if (allOffline && !wasAllOffline) {
        message = buildOfflineMessage(statuses);
        kind = 'offline';
    } else if (!allOffline && wasAllOffline) {
        message = buildRecoveryMessage(statuses);
        kind = 'recovery';
    } else {
        message = buildDeltaMessage(joined, left, statuses);
        kind = 'delta';
    }

    await sendWecom(webhookUrl, message);
    await SystemModel.set(KEY_LAST_STATE, JSON.stringify(onlineMids));
    await SystemModel.set(KEY_LAST_NOTIFY_KIND, kind);
    await SystemModel.set(KEY_LAST_NOTIFY_AT, now.toISOString());
}

function buildBody(statuses: JudgeStatus[]) {
    const onlineCount = statuses.filter((s) => s.online).length;
    const liveState = statuses.length === 0
        ? 'no_judges'
        : onlineCount === 0
            ? 'offline'
            : 'online';
    const lastCheckAt = SystemModel.get(KEY_LAST_CHECK_AT) as string | undefined;
    const lastCheckTotal = SystemModel.get(KEY_LAST_CHECK_TOTAL) as number | undefined;
    const lastCheckOnline = SystemModel.get(KEY_LAST_CHECK_ONLINE) as number | undefined;
    const lastNotifyAt = SystemModel.get(KEY_LAST_NOTIFY_AT) as string | undefined;
    const lastNotifyKind = SystemModel.get(KEY_LAST_NOTIFY_KIND) as string | undefined;
    const lastStateRaw = SystemModel.get(KEY_LAST_STATE) as string | undefined;
    let lastState: string;
    if (lastStateRaw) {
        try {
            const mids: string[] = JSON.parse(lastStateRaw);
            lastState = mids.length === 0 ? 'offline' : 'online';
        } catch {
            lastState = lastStateRaw;
        }
    } else {
        lastState = '';
    }
    return {
        statuses,
        onlineCount,
        liveState,
        enabled: !!SystemModel.get(KEY_ENABLED),
        includeServer: !!SystemModel.get(KEY_INCLUDE_SERVER),
        webhookUrl: (SystemModel.get(KEY_WEBHOOK) as string) || '',
        lastState: lastState || '',
        lastCheckAt: lastCheckAt ? new Date(lastCheckAt) : null,
        lastCheckTotal: lastCheckTotal ?? null,
        lastCheckOnline: lastCheckOnline ?? null,
        lastNotifyAt: lastNotifyAt ? new Date(lastNotifyAt) : null,
        lastNotifyKind: lastNotifyKind || '',
        judgeThresholdMinutes: Math.floor(JUDGE_THRESHOLD_MS / 60000),
        serverThresholdMinutes: Math.floor(SERVER_THRESHOLD_MS / 60000),
        checkIntervalMinutes: Math.floor(CHECK_INTERVAL_MS / 60000),
    };
}

class JudgeMonitorHandler extends Handler {
    async get() {
        const statuses = await getJudgeStatuses();
        this.response.template = 'oi33_judge_monitor.html';
        this.response.body = buildBody(statuses);
    }

    @param('action', Types.String)
    @param('webhook', Types.String, true)
    @param('enabled', Types.String, true)
    @param('include_server', Types.String, true)
    async post(domainId: string, action: string, webhook = '', enabled = '', include_server = '') {
        if (action === 'save') {
            await SystemModel.set(KEY_WEBHOOK, webhook.trim());
            await SystemModel.set(KEY_ENABLED, enabled === 'on' || enabled === 'true');
            await SystemModel.set(KEY_INCLUDE_SERVER, include_server === 'on' || include_server === 'true');
            this.response.redirect = this.url('oi33_judge_monitor');
            return;
        }
        const webhookUrl = (SystemModel.get(KEY_WEBHOOK) as string) || '';
        let sendResult: { ok: boolean; error?: string } | undefined;
        let checkResult: { triggered: boolean; pushedKind?: string } | undefined;
        if (action === 'send_status') {
            const statuses = await getJudgeStatuses();
            sendResult = await sendWecom(webhookUrl, buildManualMessage(statuses));
        } else if (action === 'test') {
            const msg = `## 🧪 Webhook 测试\n\nOI33 评测机监控 Webhook 测试消息。\n\n> 发送时间：${fmtDate(new Date())}`;
            sendResult = await sendWecom(webhookUrl, msg);
        } else if (action === 'run_check') {
            const prevNotifyAt = SystemModel.get(KEY_LAST_NOTIFY_AT) as string | undefined;
            await runScheduledCheck(true);
            const newNotifyAt = SystemModel.get(KEY_LAST_NOTIFY_AT) as string | undefined;
            const pushed = newNotifyAt && newNotifyAt !== prevNotifyAt;
            checkResult = {
                triggered: true,
                pushedKind: pushed ? (SystemModel.get(KEY_LAST_NOTIFY_KIND) as string) : undefined,
            };
        }
        const statuses = await getJudgeStatuses();
        this.response.template = 'oi33_judge_monitor.html';
        this.response.body = {
            ...buildBody(statuses),
            sendResult,
            checkResult,
            action,
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_judge_monitor', '/oi33/judge-monitor', JudgeMonitorHandler, PRIV.PRIV_MOD_BADGE);
    if (process.env.NODE_APP_INSTANCE !== '0') return;
    ctx.interval(() => {
        runScheduledCheck().catch((e) => {
            console.error('[oi33] judge monitor check failed:', e);
        });
    }, CHECK_INTERVAL_MS);
}
