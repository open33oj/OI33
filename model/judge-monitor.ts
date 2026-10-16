// Storage for the 评测机监控 (judge monitor) panel: one `oi33_judge_monitor`
// document holding both the admin configuration and the last check state.
//
// Why it is not a core system setting any more: `SystemModel.set` defaults to
// `broadcast = true`, which emits `system/setting`. Three things listen to that
// event, and all three are too expensive for a check that runs every 5 minutes:
//   1. @hydrooj/ui-default rebuilds the *entire* frontend bundle
//      (`backendlib/builder.ts`: `ctx.on('system/setting', () => triggerHotUpdate())`
//      — with no path argument, so its "is this a UI file?" filter is skipped
//      and even a plugin-private key triggers a full esbuild pass),
//   2. every plugin with a config re-resolves it from the database and may
//      reload itself (`hydrooj/src/loader.ts`),
//   3. Hydro re-pushes the language config to every connected judge daemon
//      (`hydrooj/src/handler/judge.ts`, `@subscribe('system/setting')`).
// Writing to an `oi33_*` collection emits nothing and also keeps the monitor
// correct on a multi-worker install without any cross-process event.
//
// Pure rules live in ./judge-monitor-rules (unit tested).

import { db } from 'hydrooj';
import {
    JUDGE_MONITOR_ID, normalizeJudgeMonitorConfig, normalizeJudgeMonitorNotifyKind, normalizeOnlineMids,
} from './judge-monitor-rules';
import type { JudgeMonitorConfigInput } from './judge-monitor-rules';
import type { Oi33JudgeMonitorDoc } from './types';

export * from './judge-monitor-rules';

export const judgeMonitorColl = db.collection('oi33_judge_monitor');

// Where the monitor used to store exactly these values, as core system
// settings. Imported once by /oi33/migrate (Step 18).
const LEGACY_KEYS = {
    enabled: 'oi33.judge_monitor.enabled',
    includeServer: 'oi33.judge_monitor.include_server',
    webhook: 'oi33.judge_monitor.webhook',
    lastState: 'oi33.judge_monitor.last_state',
    lastCheckAt: 'oi33.judge_monitor.last_check_at',
    lastCheckTotal: 'oi33.judge_monitor.last_check_total',
    lastCheckOnline: 'oi33.judge_monitor.last_check_online',
    lastNotifyAt: 'oi33.judge_monitor.last_notify_at',
    lastNotifyKind: 'oi33.judge_monitor.last_notify_kind',
};

function toDate(raw: unknown): Date | null {
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
    if (typeof raw === 'string' || typeof raw === 'number') {
        const date = new Date(raw);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
}

function toCount(raw: unknown): number | null {
    if (raw === null || raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

function viewOf(doc: any): Oi33JudgeMonitorDoc {
    return {
        _id: JUDGE_MONITOR_ID,
        ...normalizeJudgeMonitorConfig(doc),
        lastOnlineMids: normalizeOnlineMids(doc?.lastOnlineMids),
        lastCheckAt: toDate(doc?.lastCheckAt),
        lastCheckTotal: toCount(doc?.lastCheckTotal),
        lastCheckOnline: toCount(doc?.lastCheckOnline),
        lastNotifyAt: toDate(doc?.lastNotifyAt),
        lastNotifyKind: normalizeJudgeMonitorNotifyKind(doc?.lastNotifyKind),
        updatedAt: toDate(doc?.updatedAt) || new Date(0),
        ...(doc?.updatedBy === undefined ? {} : { updatedBy: Number(doc.updatedBy) || 0 }),
    };
}

// A missing document is normal: it just means the monitor has never run.
export async function judgeMonitorGet(): Promise<Oi33JudgeMonitorDoc> {
    const doc: any = await judgeMonitorColl.findOne({ _id: JUDGE_MONITOR_ID } as any);
    return viewOf(doc);
}

// Single-write state update. `judgeMonitorPatch({})` is a no-op apart from
// `updatedAt`, so callers can always hand in the fields they touched.
export async function judgeMonitorPatch(
    patch: Partial<Omit<Oi33JudgeMonitorDoc, '_id' | 'updatedAt'>>,
    now = new Date(),
): Promise<void> {
    await judgeMonitorColl.updateOne(
        { _id: JUDGE_MONITOR_ID } as any,
        { $set: { ...patch, updatedAt: now } } as any,
        { upsert: true },
    );
}

export async function judgeMonitorSaveConfig(
    raw: JudgeMonitorConfigInput,
    operator: number,
    now = new Date(),
): Promise<Oi33JudgeMonitorDoc> {
    await judgeMonitorColl.updateOne(
        { _id: JUDGE_MONITOR_ID } as any,
        {
            $set: {
                ...normalizeJudgeMonitorConfig(raw),
                updatedAt: now,
                updatedBy: operator,
            },
        } as any,
        { upsert: true },
    );
    return await judgeMonitorGet();
}

// One-shot, idempotent import of the pre-move system settings. `$setOnInsert`
// only writes the document when it does not exist yet, so re-running /oi33/migrate
// never clobbers an administrator's later edits. Returns whether values were
// actually imported.
export async function judgeMonitorMigrateFromSettings(): Promise<boolean> {
    const docs: any[] = await db
        .collection('system')
        .find({ _id: { $in: Object.values(LEGACY_KEYS) } } as any)
        .toArray();
    if (!docs.length) return false;
    const legacy: Record<string, any> = {};
    for (const doc of docs) legacy[doc._id] = doc.value;
    const config = normalizeJudgeMonitorConfig({
        enabled: legacy[LEGACY_KEYS.enabled],
        includeServer: legacy[LEGACY_KEYS.includeServer],
        webhook: legacy[LEGACY_KEYS.webhook],
    });
    const res: any = await judgeMonitorColl.updateOne(
        { _id: JUDGE_MONITOR_ID } as any,
        {
            $setOnInsert: {
                _id: JUDGE_MONITOR_ID,
                ...config,
                lastOnlineMids: normalizeOnlineMids(legacy[LEGACY_KEYS.lastState]),
                lastCheckAt: toDate(legacy[LEGACY_KEYS.lastCheckAt]),
                lastCheckTotal: toCount(legacy[LEGACY_KEYS.lastCheckTotal]),
                lastCheckOnline: toCount(legacy[LEGACY_KEYS.lastCheckOnline]),
                lastNotifyAt: toDate(legacy[LEGACY_KEYS.lastNotifyAt]),
                lastNotifyKind: normalizeJudgeMonitorNotifyKind(legacy[LEGACY_KEYS.lastNotifyKind]),
                updatedAt: new Date(),
            } as any,
        },
        { upsert: true },
    );
    return Number(res?.upsertedCount) > 0;
}
