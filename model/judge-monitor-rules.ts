// Pure rules for the 评测机监控 (judge monitor) panel: config normalisation,
// the online-machine set and the notify state derived from it. No hydrooj / DB
// imports (types only) so this module stays unit-testable with plain
// `node --test`; model/judge-monitor.ts owns the `oi33_judge_monitor` document
// and re-exports everything.

import type { Oi33JudgeMonitorConfig, Oi33JudgeMonitorNotifyKind } from './types';

export const JUDGE_MONITOR_ID = 'main';

// What the admin form (or a stored document) hands in: checkboxes arrive as
// strings ("on" / "true"), so every field is treated as unknown input.
export interface JudgeMonitorConfigInput {
    enabled?: unknown;
    includeServer?: unknown;
    webhook?: unknown;
}

// HTML checkboxes only send a value when checked; the settings form has used
// both "on" and "true" over time, so accept the usual truthy spellings.
function toBool(raw: unknown): boolean {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw === 1;
    if (typeof raw === 'string') {
        const text = raw.trim().toLowerCase();
        return text === 'on' || text === 'true' || text === '1' || text === 'yes';
    }
    return false;
}

export function normalizeJudgeMonitorConfig(raw: JudgeMonitorConfigInput | null | undefined): Oi33JudgeMonitorConfig {
    return {
        enabled: toBool(raw?.enabled),
        includeServer: toBool(raw?.includeServer),
        webhook: typeof raw?.webhook === 'string' ? raw.webhook.trim() : '',
    };
}

// `null` means "never checked yet" and is *not* the same as `[]`, which means
// "the last check found every machine offline". Both are stored states, so an
// empty list must not silently degrade into "first run" (that would re-arm the
// "all judges offline" alert on every tick while nothing is online).
// Accepts the new string[] form plus the two legacy spellings: a JSON string
// (the old `oi33.judge_monitor.last_state` setting) and separator text.
export function normalizeOnlineMids(raw: unknown): string[] | null {
    if (raw === null || raw === undefined || raw === '') return null;
    if (Array.isArray(raw)) {
        return [...new Set(raw.filter((mid): mid is string => typeof mid === 'string' && !!mid))];
    }
    if (typeof raw === 'string') {
        const text = raw.trim();
        if (!text) return null;
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) return normalizeOnlineMids(parsed);
        } catch { /* not JSON: fall through to the separator form */ }
        return [...new Set(text.split(/[,，\s]+/).filter(Boolean))];
    }
    return null;
}

export function judgeMonitorNotifyState(mids: string[] | null): '' | 'online' | 'offline' {
    if (mids === null) return '';
    return mids.length ? 'online' : 'offline';
}

export interface JudgeMonitorOnlineDiff {
    joined: string[];
    left: string[];
}

// Order-insensitive diff of two online-machine sets.
export function judgeMonitorOnlineDiff(prev: string[], current: string[]): JudgeMonitorOnlineDiff {
    const prevSet = new Set(prev);
    const currentSet = new Set(current);
    return {
        joined: [...currentSet].filter((mid) => !prevSet.has(mid)),
        left: [...prevSet].filter((mid) => !currentSet.has(mid)),
    };
}

export function normalizeJudgeMonitorNotifyKind(raw: unknown): Oi33JudgeMonitorNotifyKind {
    return raw === 'offline' || raw === 'recovery' || raw === 'delta' ? raw : '';
}
