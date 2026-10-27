import { ValidationError } from 'hydrooj';
import type { Oi33MedalImageSize, Oi33MedalLevel, Oi33MedalRuleType } from '../types';
import { addLog } from '../log';
import { medalColl } from './definition';
import { INITIAL_MEDAL_IMAGES } from './initial';
import { isAutomaticRuleType, medalAutomaticRuleText, medalSortedLevels } from './rules';

// --- Definition import / export -------------------------------------------
//
// The payload carries definitions only: names, rules, pixel art and level
// ladders. Awards, announcements and moderation state are deliberately
// excluded, so a file can be moved to another installation — or another OJ's
// medal set can be loaded here — without touching who holds what.

const MEDAL_EXPORT_FORMAT = 'oi33-medals';
const MEDAL_EXPORT_VERSION = 1;
const MAX_IMPORT_MEDALS = 500;
const MAX_MEDAL_IMAGE_BYTES = 256 * 1024;
const MAX_MEDAL_LEVELS = 24;
const MEDAL_IMAGE_SIZES = new Set([8, 16, 24, 32]);
const MEDAL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MEDAL_RULE_TYPES = new Set<Oi33MedalRuleType>([
    'manual', 'accepted_problems', 'checkin_streak', 'checkin_total',
    'cat_food_balance', 'cat_can_balance', 'certification',
]);

export interface MedalDefinitionExport {
    format: string;
    version: number;
    exportedAt: string;
    count: number;
    medals: any[];
}

export async function medalExportDefinitions(): Promise<MedalDefinitionExport> {
    const medals = await medalColl.find().sort({ order: 1, _id: 1 }).toArray();
    return {
        format: MEDAL_EXPORT_FORMAT,
        version: MEDAL_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        count: medals.length,
        medals: medals.map((medal) => {
            const levels = medalSortedLevels(medal);
            return {
                id: medal._id,
                name: medal.name,
                description: medal.description,
                rule: medal.rule,
                ruleType: medal.ruleType,
                ...(Number(medal.threshold) > 0 ? { threshold: Number(medal.threshold) } : {}),
                imageData: medal.imageData,
                imageSize: medal.imageSize,
                ...(levels.length
                    ? {
                        levels: levels.map((level) => ({
                            level: level.level,
                            name: level.name,
                            ...(level.description ? { description: level.description } : {}),
                            imageData: level.imageData,
                            imageSize: level.imageSize,
                            ...(Number(level.threshold) > 0 ? { threshold: Number(level.threshold) } : {}),
                        })),
                    }
                    : {}),
                order: Number(medal.order) || 0,
                saleable: medal.saleable === true,
            };
        }),
    };
}

// A base64 PNG data URL of one of the four allowed square sizes, or null.
function normalizeMedalImage(raw: unknown): { imageData: string; imageSize: Oi33MedalImageSize } | null {
    const value = String(raw ?? '').trim();
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
    if (!match) return null;
    let data: Buffer;
    try {
        data = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
    } catch {
        return null;
    }
    if (data.length < 24 || data.length > MAX_MEDAL_IMAGE_BYTES) return null;
    if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || data.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (width !== height || !MEDAL_IMAGE_SIZES.has(width)) return null;
    return { imageData: value, imageSize: width as Oi33MedalImageSize };
}

function normalizeImportedLevel(
    raw: any,
    index: number,
    fallback: { imageData: string; imageSize: Oi33MedalImageSize },
    medalId: string,
    warnings: string[],
): Oi33MedalLevel {
    // 不再用「Lv.N」作为默认名：等级在界面上直接显示名称，序号只是排序。
    const name = String(raw?.name ?? '').trim().slice(0, 50) || `第 ${index + 1} 级`;
    const description = String(raw?.description ?? '').trim().slice(0, 200);
    const image = normalizeMedalImage(raw?.imageData);
    if (!image && raw?.imageData) {
        warnings.push(`${medalId}: 等级「${name}」的像素图无效，已改用系列图标。`);
    }
    const threshold = Number.parseInt(String(raw?.threshold ?? ''), 10);
    return {
        level: index + 1,
        name,
        ...(description ? { description } : {}),
        imageData: (image || fallback).imageData,
        imageSize: (image || fallback).imageSize,
        ...(Number.isSafeInteger(threshold) && threshold > 0 ? { threshold } : {}),
    };
}

interface NormalizedMedalDefinition {
    _id: string;
    fields: Record<string, any>;
    warnings: string[];
}

// Turn one foreign definition into the fields this plugin stores. IDs are
// lower-cased and stripped of characters the plugin cannot address, and an
// optional prefix can be prepended to avoid collisions with local medals.
function normalizeImportedMedal(raw: any, index: number, idPrefix: string): NormalizedMedalDefinition {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`第 ${index + 1} 项不是一个奖章对象。`);
    }
    const warnings: string[] = [];
    const rawId = String(raw.id ?? raw._id ?? raw.medalId ?? '').trim();
    const id = `${idPrefix}${rawId}`
        .trim().toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    if (!id || !MEDAL_ID_RE.test(id)) {
        throw new Error(`第 ${index + 1} 项缺少可用的奖章 ID（原始值：${rawId || '空'}）。`);
    }
    const name = String(raw.name ?? '').trim().slice(0, 50);
    if (!name) throw new Error(`奖章「${id}」缺少名称。`);

    const rawType = String(raw.ruleType ?? '').trim();
    let ruleType: Oi33MedalRuleType;
    if (MEDAL_RULE_TYPES.has(rawType as Oi33MedalRuleType)) {
        ruleType = rawType as Oi33MedalRuleType;
    } else {
        ruleType = 'manual';
        warnings.push(`${id}: 未知 ruleType「${rawType || '空'}」，已按一般奖章导入。`);
    }

    const image = normalizeMedalImage(raw.imageData);
    if (!image && raw.imageData) warnings.push(`${id}: 像素图无效，已改用默认奖章图标。`);
    const base = image || { imageData: INITIAL_MEDAL_IMAGES[0], imageSize: 24 as Oi33MedalImageSize };

    const isLeveled = ruleType === 'certification' || isAutomaticRuleType(ruleType);
    let levels: Oi33MedalLevel[] | undefined;
    if (isLeveled && Array.isArray(raw.levels) && raw.levels.length) {
        const rows = raw.levels
            .filter((item: any) => item && typeof item === 'object')
            .slice(0, MAX_MEDAL_LEVELS)
            .map((item: any, i: number) => normalizeImportedLevel(item, i, base, id, warnings));
        if (raw.levels.length > MAX_MEDAL_LEVELS) {
            warnings.push(`${id}: 等级过多，只保留前 ${MAX_MEDAL_LEVELS} 级。`);
        }
        if (ruleType === 'certification') {
            levels = rows;
        } else {
            // OJ rungs are driven by their thresholds; a rung without one can
            // never be reached, so it is dropped rather than silently kept.
            const withThreshold = rows.filter((item) => Number(item.threshold) > 0);
            if (withThreshold.length !== rows.length) {
                warnings.push(`${id}: 忽略了 ${rows.length - withThreshold.length} 个没有阈值的等级。`);
            }
            levels = withThreshold
                .sort((a, b) => Number(a.threshold) - Number(b.threshold))
                .map((item, i) => ({ ...item, level: i + 1 }));
        }
    }

    const flatThreshold = Number.parseInt(String(raw.threshold ?? ''), 10);
    const topThreshold = levels && levels.length
        ? Number(levels[levels.length - 1].threshold) || 0
        : (Number.isSafeInteger(flatThreshold) && flatThreshold > 0 ? flatThreshold : 0);
    const automatic = isAutomaticRuleType(ruleType);
    if (automatic && topThreshold <= 0) {
        warnings.push(`${id}: 自动奖章没有任何可用阈值，导入后不会自动发放。`);
    }

    let rule = String(raw.rule ?? '').trim().slice(0, 500);
    if (!rule) {
        if (ruleType === 'certification') {
            rule = levels && levels.length
                ? `${levels.length} 级认证：${levels.map((item) => item.name).join(' < ')}`
                : '奖项认证奖章';
        } else if (automatic) {
            rule = topThreshold > 0
                ? `${medalAutomaticRuleText(ruleType, topThreshold)} 起逐级自动升级`
                : '由系统按指标自动升级';
        } else {
            rule = '由管理员根据活动结果发放';
        }
    }

    // Only 一般奖章 may be marked saleable: the evaluator skips saleable
    // definitions and certification ignores the flag.
    if (raw.saleable === true && ruleType !== 'manual') {
        warnings.push(`${id}: 只有一般奖章可以标记为可售卖，已忽略 saleable。`);
    }

    const fields: Record<string, any> = {
        name,
        description: String(raw.description ?? '').trim().slice(0, 500) || name,
        rule,
        ruleType,
        imageData: base.imageData,
        imageSize: base.imageSize,
        order: Number.isSafeInteger(Number(raw.order)) ? Number(raw.order) : 0,
        saleable: raw.saleable === true && ruleType === 'manual',
    };
    if (isLeveled && levels && levels.length) fields.levels = levels;
    if (automatic && topThreshold > 0) fields.threshold = topThreshold;
    return { _id: id, fields, warnings };
}

export interface MedalImportOptions {
    // 'merge' overwrites an existing definition with the same id; 'insert'
    // keeps the local one and counts the import as skipped.
    mode?: 'merge' | 'insert';
    idPrefix?: string;
    operator: number;
}

export interface MedalImportResult {
    total: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    warnings: string[];
    errors: string[];
}

export async function medalImportDefinitions(
    payload: unknown,
    options: MedalImportOptions,
): Promise<MedalImportResult> {
    const list = Array.isArray(payload)
        ? payload
        : (Array.isArray((payload as any)?.medals) ? (payload as any).medals : null);
    if (!list) {
        throw new ValidationError('导入内容格式无效：应为奖章数组，或包含 medals 数组的导出文件。');
    }
    if (!list.length) throw new ValidationError('导入内容里没有任何奖章定义。');
    if (list.length > MAX_IMPORT_MEDALS) {
        throw new ValidationError(`单次最多导入 ${MAX_IMPORT_MEDALS} 枚奖章。`);
    }
    const mode = options.mode === 'insert' ? 'insert' : 'merge';
    const idPrefix = String(options.idPrefix ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    const now = new Date();
    const result: MedalImportResult = {
        total: list.length, created: 0, updated: 0, skipped: 0, failed: 0,
        warnings: [], errors: [],
    };
    const seen = new Set<string>();
    for (let index = 0; index < list.length; index++) {
        try {
            const normalized = normalizeImportedMedal(list[index], index, idPrefix);
            if (seen.has(normalized._id)) {
                result.skipped++;
                result.warnings.push(`${normalized._id}: 文件内重复，已保留最先出现的一条。`);
                continue;
            }
            seen.add(normalized._id);
            const existing = await medalColl.findOne({ _id: normalized._id });
            if (existing && mode === 'insert') {
                result.skipped++;
                continue;
            }
            const unset: Record<string, ''> = {};
            if (!normalized.fields.levels) unset.levels = '';
            if (!('threshold' in normalized.fields)) unset.threshold = '';
            await medalColl.updateOne(
                { _id: normalized._id },
                {
                    $set: { ...normalized.fields, updatedAt: now },
                    $setOnInsert: { createdAt: now, createdBy: options.operator },
                    ...(Object.keys(unset).length ? { $unset: unset } : {}),
                },
                { upsert: true },
            );
            if (existing) result.updated++; else result.created++;
            result.warnings.push(...normalized.warnings);
        } catch (e: any) {
            result.failed++;
            result.errors.push(e?.message || `第 ${index + 1} 项导入失败。`);
        }
    }
    await addLog({
        type: 'medal', userId: options.operator, action: 'definition_import',
        reason: `total=${result.total} created=${result.created} updated=${result.updated} `
            + `skipped=${result.skipped} failed=${result.failed}`,
    });
    return result;
}
