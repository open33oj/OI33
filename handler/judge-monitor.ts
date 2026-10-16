import {
    Context, Handler, PRIV, Types, db, param,
} from 'hydrooj';
import { oi33Model } from '../model';
import type { Oi33JudgeMonitorDoc } from '../model/types';
import { checkOi33Admin } from './utils';

const statusColl = db.collection('status');

// hydrojudge 每 20 分钟心跳一次（packages/hydrojudge/src/hosts/hydro.ts: 1200000ms），
// 留 2 分钟容忍网络抖动，judge 22 分钟未上报即判定离线。
// type:'server' 即嵌入式部署下的 OJ 自身（同时承担评测），心跳 30 分钟一次（service/monitor.ts: 1800000ms），
// 阈值放宽到 32 分钟。
const JUDGE_THRESHOLD_MS = 22 * 60 * 1000;
const SERVER_THRESHOLD_MS = 32 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// 监控配置与状态都存在 oi33_judge_monitor 单文档里（model/judge-monitor.ts）。
// 注意不要改回 SystemModel.set：那会广播 system/setting，触发 ui-default 全量
// 重建前端 bundle（每 5 分钟一次的 esbuild），并让每个带 config 的插件重新解析
// 配置、给评测机重推语言配置。

interface JudgeStatus {
    mid: string;
    type: 'judge' | 'server';
    updateAt: Date;
    online: boolean;
    minutesSince: number;
    name?: string;
    ip?: string;
}

async function getJudgeStatuses(includeServer: boolean): Promise<JudgeStatus[]> {
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

// One scheduled (or manual) check. Everything it persists goes into a single
// oi33_judge_monitor write at the end, so a tick costs one findOne + one
// updateOne and emits no events at all.
async function runScheduledCheck(force = false) {
    const state = await oi33Model.judgeMonitorGet();
    if (!force && !state.enabled) return;

    const statuses = await getJudgeStatuses(state.includeServer);
    const onlineMids = statuses.filter((s) => s.online).map((s) => s.mid);
    const onlineCount = onlineMids.length;
    const now = new Date();
    const patch: Partial<Omit<Oi33JudgeMonitorDoc, '_id' | 'updatedAt'>> = {
        lastCheckAt: now,
        lastCheckTotal: statuses.length,
        lastCheckOnline: onlineCount,
    };

    const webhookUrl = state.webhook;
    if (!webhookUrl || !statuses.length) {
        await oi33Model.judgeMonitorPatch(patch, now);
        return;
    }

    // The last check result is only meaningful once we have one; `null` marks
    // "never checked" and must not be confused with "everything was offline".
    if (state.lastOnlineMids === null) {
        patch.lastOnlineMids = onlineMids;
        await oi33Model.judgeMonitorPatch(patch, now);
        return;
    }

    const { joined: joinedMids, left: leftMids } = oi33Model.judgeMonitorOnlineDiff(
        state.lastOnlineMids, onlineMids,
    );
    if (!joinedMids.length && !leftMids.length) {
        await oi33Model.judgeMonitorPatch(patch, now);
        return;
    }

    const joined = statuses.filter((s) => joinedMids.includes(s.mid));
    const left = leftMids.map((mid) => {
        const found = statuses.find((s) => s.mid === mid);
        return found || { mid, type: 'judge' as const, updateAt: new Date(0), online: false, minutesSince: 0, name: mid };
    });

    const allOffline = onlineCount === 0;
    const wasAllOffline = state.lastOnlineMids.length === 0;

    let message: string;
    let kind: Oi33JudgeMonitorDoc['lastNotifyKind'];
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
    patch.lastOnlineMids = onlineMids;
    patch.lastNotifyKind = kind;
    patch.lastNotifyAt = now;
    await oi33Model.judgeMonitorPatch(patch, now);
}

function buildBody(statuses: JudgeStatus[], state: Oi33JudgeMonitorDoc) {
    const onlineCount = statuses.filter((s) => s.online).length;
    const liveState = statuses.length === 0
        ? 'no_judges'
        : onlineCount === 0
            ? 'offline'
            : 'online';
    return {
        statuses,
        onlineCount,
        liveState,
        enabled: state.enabled,
        includeServer: state.includeServer,
        webhookUrl: state.webhook,
        lastState: oi33Model.judgeMonitorNotifyState(state.lastOnlineMids),
        lastCheckAt: state.lastCheckAt,
        lastCheckTotal: state.lastCheckTotal,
        lastCheckOnline: state.lastCheckOnline,
        lastNotifyAt: state.lastNotifyAt,
        lastNotifyKind: state.lastNotifyKind,
        judgeThresholdMinutes: Math.floor(JUDGE_THRESHOLD_MS / 60000),
        serverThresholdMinutes: Math.floor(SERVER_THRESHOLD_MS / 60000),
        checkIntervalMinutes: Math.floor(CHECK_INTERVAL_MS / 60000),
    };
}

class JudgeMonitorHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        const state = await oi33Model.judgeMonitorGet();
        const statuses = await getJudgeStatuses(state.includeServer);
        this.response.template = 'oi33_judge_monitor.html';
        this.response.body = buildBody(statuses, state);
    }

    @param('action', Types.String)
    @param('webhook', Types.String, true)
    @param('enabled', Types.String, true)
    @param('include_server', Types.String, true)
    async post(domainId: string, action: string, webhook = '', enabled = '', include_server = '') {
        await checkOi33Admin(this.user._id);
        if (action === 'save') {
            await oi33Model.judgeMonitorSaveConfig(
                { webhook: webhook.trim(), enabled, includeServer: include_server },
                this.user._id,
            );
            this.response.redirect = this.url('oi33_judge_monitor');
            return;
        }
        const state = await oi33Model.judgeMonitorGet();
        const webhookUrl = state.webhook;
        let sendResult: { ok: boolean; error?: string } | undefined;
        let checkResult: { triggered: boolean; pushedKind?: string } | undefined;
        if (action === 'send_status') {
            const statuses = await getJudgeStatuses(state.includeServer);
            sendResult = await sendWecom(webhookUrl, buildManualMessage(statuses));
        } else if (action === 'test') {
            const msg = `## 🧪 Webhook 测试\n\nOI33 评测机监控 Webhook 测试消息。\n\n> 发送时间：${fmtDate(new Date())}`;
            sendResult = await sendWecom(webhookUrl, msg);
        } else if (action === 'run_check') {
            const prevNotifyAt = state.lastNotifyAt ? state.lastNotifyAt.getTime() : null;
            await runScheduledCheck(true);
            const after = await oi33Model.judgeMonitorGet();
            const pushed = !!after.lastNotifyAt
                && (prevNotifyAt === null || after.lastNotifyAt.getTime() !== prevNotifyAt);
            checkResult = { triggered: true, pushedKind: pushed ? after.lastNotifyKind : undefined };
        }
        const statuses = await getJudgeStatuses(state.includeServer);
        this.response.template = 'oi33_judge_monitor.html';
        this.response.body = {
            ...buildBody(statuses, state),
            sendResult,
            checkResult,
            action,
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_judge_monitor', '/oi33/judge-monitor', JudgeMonitorHandler, PRIV.PRIV_USER_PROFILE);
    if (process.env.NODE_APP_INSTANCE !== '0') return;
    ctx.interval(() => {
        runScheduledCheck().catch((e) => {
            console.error('[oi33] judge monitor check failed:', e);
        });
    }, CHECK_INTERVAL_MS);
}
