import { ValidationError } from 'hydrooj';
import { readFileSync } from 'fs';
import { oi33Model } from '../../model';
import type {
    Oi33MedalImageSize, Oi33MedalLevel, Oi33MedalRuleType, Oi33MedalCategory,
} from '../../model/types';

// Form parsing / validation shared by the medal management routes: the option
// lists the manage template renders, the pixel-PNG reader, and the level-ladder
// editor input. Pure helpers only — no routes live here.

const IMAGE_SIZES = new Set([8, 16, 24, 32]);
const MAX_IMAGE_BYTES = 256 * 1024;
// A certification series is a ladder, not a catalogue: keep the rungs few
// enough that the enrolment form stays usable.
const MAX_LEVELS = 24;
const MAX_LEVEL_NAME = 30;
const MAX_LEVEL_DESCRIPTION = 200;

// Only the automatic indicators belong to the OJ 成就奖章 family. `manual`,
// `saleable` and `certification` are decided by the category the administrator
// picks, not by this list.
export const RULE_OPTIONS: Array<{ value: Oi33MedalRuleType; label: string }> = [
    { value: 'accepted_problems', label: '通过 x 道不重复的题目' },
    { value: 'checkin_streak', label: '连续登录 x 天' },
    { value: 'checkin_total', label: '累计登录 x 天' },
    { value: 'cat_food_balance', label: '猫粮达到 x g' },
    { value: 'cat_can_balance', label: '猫罐头持有 x 个' },
    { value: 'special_medals', label: '获得 x 枚特殊奖章（一般 / 可售卖 / 奖项认证）' },
];
export const RULE_TYPE_SET = new Set(RULE_OPTIONS.map((item) => item.value));

export const CATEGORY_OPTIONS: Array<{ value: Oi33MedalCategory; label: string; hint: string }> = [
    {
        value: 'saleable',
        label: '可售卖奖章',
        hint: '全服唯一，通过拍卖上架、只能经交易合同转手；不上架时可由管理员手动发放。',
    },
    {
        value: 'certification',
        label: '奖项认证奖章',
        hint: '每类比赛一个可升级系列：先建好等级阶梯（名称 + 各级像素画），再给用户发放或升级。',
    },
    {
        value: 'manual',
        label: '一般奖章',
        hint: '管理员按活动、贡献等规则手动发放的普通奖章。',
    },
    {
        value: 'oj',
        label: 'OJ 成就奖章',
        hint: '每类指标一个可升级系列（通过题目、连续/累计登录、猫粮、猫罐头）：给每个等级填写阈值，系统达标后自动升级。',
    },
];
export const CATEGORY_SET = new Set(CATEGORY_OPTIONS.map((item) => item.value));

export function field(body: any, name: string): string {
    const value = body?.[name];
    return String(Array.isArray(value) ? value[0] : value ?? '').trim();
}

export function fileOf(files: any, name: string): any {
    const file = files?.[name];
    return Array.isArray(file) ? file[0] : file;
}

export function hasUpload(file: any): boolean {
    return !!file && (Number(file.size) > 0 || file.originalFilename);
}

export function readPixelPng(file: any): { imageData: string; imageSize: Oi33MedalImageSize } {
    const filepath = file?.filepath || file?.path;
    if (!filepath) throw new ValidationError('请选择 PNG 像素图。');
    const data = readFileSync(filepath);
    if (!data.length || data.length > MAX_IMAGE_BYTES) {
        throw new ValidationError('PNG 图片大小必须在 256 KiB 以内。');
    }
    const signature = '89504e470d0a1a0a';
    if (data.length < 24 || data.subarray(0, 8).toString('hex') !== signature
        || data.subarray(12, 16).toString('ascii') !== 'IHDR') {
        throw new ValidationError('图片必须是有效的 PNG 文件。');
    }
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (width !== height || !IMAGE_SIZES.has(width)) {
        throw new ValidationError('像素图原始尺寸只能是 8×8、16×16、24×24 或 32×32。');
    }
    return {
        imageData: `data:image/png;base64,${data.toString('base64')}`,
        imageSize: width as Oi33MedalImageSize,
    };
}

interface LevelRowInput {
    key: string;
    name: string;
    description: string;
    // Raw threshold text; only the OJ 成就奖章 branch reads it.
    threshold: string;
}

// The levels editor submits an ordered `levels_json` (key/name/description and,
// for OJ 成就奖章, threshold per rung) plus one file input per row named
// `level_image_<key>`. Existing rungs are identified by their old level number
// as the key, so their pixel art is reused unless a replacement PNG is
// uploaded; rows created in the browser use a synthetic `new-N` key and must
// carry an upload.
export function parseLevelRows(body: any): LevelRowInput[] {
    const raw = field(body, 'levels_json');
    if (!raw) return [];
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new ValidationError('等级数据格式无效，请重新填写。');
    }
    if (!Array.isArray(parsed)) throw new ValidationError('等级数据格式无效，请重新填写。');
    if (parsed.length > MAX_LEVELS) throw new ValidationError(`奖章系列最多 ${MAX_LEVELS} 个等级。`);
    const seen = new Set<string>();
    return parsed.map((item: any) => {
        const key = String(item?.key ?? '').trim();
        const name = String(item?.name ?? '').trim();
        const description = String(item?.description ?? '').trim();
        const threshold = String(item?.threshold ?? '').trim();
        if (!key) throw new ValidationError('等级数据缺少标识，请刷新页面后重试。');
        if (seen.has(key)) throw new ValidationError('等级数据出现重复项，请刷新页面后重试。');
        seen.add(key);
        if (!name || [...name].length > MAX_LEVEL_NAME) {
            throw new ValidationError(`每个等级的名称应为 1–${MAX_LEVEL_NAME} 字。`);
        }
        if ([...description].length > MAX_LEVEL_DESCRIPTION) {
            throw new ValidationError(`等级说明不能超过 ${MAX_LEVEL_DESCRIPTION} 字。`);
        }
        return { key, name, description, threshold };
    });
}

// Renumbers the submitted rows into a 1..N ladder, reusing the pixel art of
// the rung each row was loaded from (or the fresh upload). `withThreshold`
// stores each OJ rung's indicator threshold on the level itself.
export function buildLevels(
    rows: LevelRowInput[],
    files: any,
    existingLevels: Oi33MedalLevel[],
    withThreshold = false,
    ruleType?: Oi33MedalRuleType,
): Oi33MedalLevel[] {
    const previous = new Map(existingLevels.map((item) => [String(item.level), item]));
    return rows.map((row, index) => {
        const upload = fileOf(files, `level_image_${row.key}`);
        const carried = previous.get(row.key);
        const image = hasUpload(upload)
            ? readPixelPng(upload)
            : carried
                ? { imageData: carried.imageData, imageSize: carried.imageSize }
                : null;
        if (!image) {
            throw new ValidationError(`等级「${row.name}」必须上传 PNG 像素图。`);
        }
        const threshold = withThreshold ? Number.parseInt(row.threshold || '0', 10) : undefined;
        return {
            level: index + 1,
            name: row.name,
            ...(row.description
                ? { description: row.description }
                : withThreshold && ruleType && Number.isSafeInteger(threshold) && threshold
                    ? { description: `${oi33Model.medalAutomaticRuleText(ruleType, threshold)}。` }
                    : {}),
            imageData: image.imageData,
            imageSize: image.imageSize,
            ...(withThreshold ? { threshold } : {}),
        };
    });
}

export interface MedalManageViewParams {
    edit?: string;
    targetUid?: number;
    preselect?: string;
    page?: number;
    importResult?: any;
}

// Shared by the management page and the import POST so both render the same
