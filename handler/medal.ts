import {
    Context, ForbiddenError, Handler, NotFoundError, PRIV, STATUS, Types, UserModel, ValidationError,
    param, query,
} from 'hydrooj';
import { readFileSync } from 'fs';
import { oi33Model, auctionColl, userColl } from '../model';
import { addLog } from '../model/log';
import { remainText } from '../model/auction';
import type {
    Oi33MedalCategory, Oi33MedalImageSize, Oi33MedalLevel, Oi33MedalRuleType,
} from '../model/types';
import { checkOi33Admin, checkUserFlag } from './utils';

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
const RULE_OPTIONS: Array<{ value: Oi33MedalRuleType; label: string }> = [
    { value: 'accepted_problems', label: '通过 x 道不重复的题目' },
    { value: 'checkin_streak', label: '连续登录 x 天' },
    { value: 'checkin_total', label: '累计登录 x 天' },
    { value: 'cat_food_balance', label: '猫粮达到 x g' },
    { value: 'cat_can_balance', label: '猫罐头持有 x 个' },
];
const RULE_TYPE_SET = new Set(RULE_OPTIONS.map((item) => item.value));

const CATEGORY_OPTIONS: Array<{ value: Oi33MedalCategory; label: string; hint: string }> = [
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
const CATEGORY_SET = new Set(CATEGORY_OPTIONS.map((item) => item.value));

function field(body: any, name: string): string {
    const value = body?.[name];
    return String(Array.isArray(value) ? value[0] : value ?? '').trim();
}

function fileOf(files: any, name: string): any {
    const file = files?.[name];
    return Array.isArray(file) ? file[0] : file;
}

function hasUpload(file: any): boolean {
    return !!file && (Number(file.size) > 0 || file.originalFilename);
}

function readPixelPng(file: any): { imageData: string; imageSize: Oi33MedalImageSize } {
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
function parseLevelRows(body: any): LevelRowInput[] {
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
function buildLevels(
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

interface MedalManageViewParams {
    edit?: string;
    targetUid?: number;
    preselect?: string;
    page?: number;
    importResult?: any;
}

// Shared by the management page and the import POST so both render the same
// definition lists; an import re-renders here with its per-medal result.
async function buildMedalManageView(domainId: string, params: MedalManageViewParams = {}) {
    const edit = params.edit || '';
    const targetUid = params.targetUid;
    const preselect = params.preselect || '';
    const page = params.page && params.page > 0 ? params.page : 1;
    const [medals, awardPage] = await Promise.all([
        oi33Model.medalList(),
        oi33Model.medalListAwardsPaginated(page),
    ]);
    const recentAwards = awardPage.awards;
    const acceptedDomains = oi33Model.medalGetAcceptedDomains();
    const editing = edit ? await oi33Model.medalGet(edit) : null;
    if (edit && !editing) throw new NotFoundError(edit);
    const uids = [...new Set([
        ...recentAwards.map((award) => award.uid),
        ...(targetUid ? [targetUid] : []),
    ])];
    const udict = uids.length ? await UserModel.getList(domainId, uids) : {};
    const medalDict = Object.fromEntries(
        medals.map((medal) => [medal._id, medal]),
    );
    // A definition is a level series when it belongs to an upgradable
    // family and actually carries a ladder; everything else (including a
    // not-yet-migrated flat OJ medal) is a plain definition.
    const leveled = medals.filter((medal) => oi33Model.medalIsLevelSeries(medal));
    const plain = medals.filter((medal) => !oi33Model.medalIsLevelSeries(medal));
    const ojMedals = leveled.filter((medal) => medal.category === 'oj');
    const certificationMedals = leveled.filter((medal) => medal.category === 'certification');
    // Plain definitions are split by family so the page can list them in the
    // global order 可售卖 → 奖项认证 → 一般 → OJ 自动.
    const saleableMedals = plain.filter((medal) => medal.category === 'saleable');
    const manualMedals = plain.filter((medal) => medal.category === 'manual');
    const legacyOjMedals = plain.filter((medal) => medal.category === 'oj');
    // The level picker on the grant form needs every upgradable series and
    // its ladder; shipped as one JSON blob so the client can switch without
    // a round trip.
    const medalLevels = Object.fromEntries(leveled.map((medal) => [medal._id,
        oi33Model.medalSortedLevels(medal).map((level) => ({
            level: level.level,
            name: level.name,
            ...(Number(level.threshold) > 0 ? { threshold: Number(level.threshold) } : {}),
        }))]));
    return {
        medalTotal: medals.length,
        medals: plain,
        saleableMedals,
        manualMedals,
        legacyOjMedals,
        ojMedals,
        certificationMedals,
        medalDict, recentAwards, udict, editing,
        awardPage: page,
        awardPageCount: awardPage.tpcount,
        awardTotal: awardPage.total,
        targetUid: targetUid || '',
        ruleOptions: RULE_OPTIONS,
        categoryOptions: CATEGORY_OPTIONS,
        medalLevels,
        preselectCategory: CATEGORY_SET.has(preselect as Oi33MedalCategory)
            ? preselect
            : 'oj',
        acceptedDomainsText: acceptedDomains.join(', '),
        ...(params.importResult ? { importResult: params.importResult } : {}),
    };
}

class MedalManageHandler extends Handler {
    @query('edit', Types.String, true)
    @query('uid', Types.Int, true)
    @query('category', Types.String, true)
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, edit = '', targetUid?: number, preselect = '', page = 1) {
        await checkOi33Admin(this.user._id);
        this.response.template = 'oi33_medal_manage.html';
        this.response.body = await buildMedalManageView(domainId, {
            edit, targetUid, preselect, page,
        });
    }
}

class MedalConfigHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const raw = field(this.request.body as any, 'acceptedDomains');
        const domains = [...new Set(raw.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean))];
        if (domains.length > 100) throw new ValidationError('参与统计的域不能超过 100 个。');
        if (domains.some((domain) => domain.length > 64)) {
            throw new ValidationError('domainId 长度不能超过 64 个字符。');
        }
        await oi33Model.medalSetAcceptedDomains(domains, this.user._id);
        this.response.redirect = this.url('oi33_medal_manage', {
            query: { notification: '奖章全局配置已保存' },
        });
    }
}

class MedalExportHandler extends Handler {
    // Definition-only download: award / announcement state is never exported.
    async get() {
        await checkOi33Admin(this.user._id);
        const payload = await oi33Model.medalExportDefinitions();
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        this.response.disposition = `attachment; filename="oi33-medals-${stamp}.json"`;
        this.response.type = 'application/json';
        this.response.body = JSON.stringify(payload, null, 2);
    }
}

class MedalImportHandler extends Handler {
    // Accepts the exported JSON either as an upload or pasted into the form.
    // Existing awards are never touched; only definitions are written.
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const files = (this.request as any).files || {};
        const mode = field(body, 'mode') === 'insert' ? 'insert' : 'merge';
        const idPrefix = field(body, 'idPrefix');
        const file = fileOf(files, 'file');
        let raw = field(body, 'json');
        if (hasUpload(file)) {
            const filepath = file?.filepath || file?.path;
            if (!filepath) throw new ValidationError('无法读取上传的文件。');
            if (Number(file.size) > 8 * 1024 * 1024) {
                throw new ValidationError('导入文件不能超过 8 MiB。');
            }
            raw = readFileSync(filepath, 'utf8');
        }
        if (!raw.trim()) throw new ValidationError('请选择 JSON 文件，或直接粘贴 JSON 内容。');
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new ValidationError('JSON 解析失败，请检查文件内容是否为合法 JSON。');
        }
        const importResult = await oi33Model.medalImportDefinitions(parsed, {
            mode: mode as 'merge' | 'insert',
            idPrefix,
            operator: this.user._id,
        });
        // Re-render the management page so per-medal errors / warnings stay
        // visible instead of being lost behind a redirect.
        this.response.template = 'oi33_medal_manage.html';
        this.response.body = await buildMedalManageView('', { importResult });
    }
}

class MedalSaveHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const files = (this.request as any).files || {};
        const id = field(body, 'id').toLowerCase();
        const name = field(body, 'name');
        const description = field(body, 'description');
        const rawCategory = field(body, 'category') || 'oj';
        if (!CATEGORY_SET.has(rawCategory as Oi33MedalCategory)) {
            throw new ValidationError('奖章类型无效。');
        }
        const category = rawCategory as Oi33MedalCategory;
        const order = Number.parseInt(field(body, 'order') || '0', 10);
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
            throw new ValidationError('奖章 ID 只能包含小写字母、数字、下划线和连字符，最长 64 位。');
        }
        if (!name || [...name].length > 50) throw new ValidationError('奖章名称应为 1–50 字。');
        if (!description || [...description].length > 500) {
            throw new ValidationError('奖章描述应为 1–500 字。');
        }
        if (!Number.isSafeInteger(order) || Math.abs(order) > 1000000) {
            throw new ValidationError('排序值无效。');
        }

        const existing = await oi33Model.medalGet(id);
        const upload = fileOf(files, 'image');
        const image = hasUpload(upload)
            ? readPixelPng(upload)
            : existing
                ? { imageData: existing.imageData, imageSize: existing.imageSize }
                : null;
        if (!image) throw new ValidationError('新建奖章时必须上传 PNG 像素图。');

        // Each family keeps its own rule fields:
        //   oj            → one automatic indicator + a ladder with thresholds
        //   saleable      → manual rule text, flagged saleable
        //   manual        → manual rule text
        //   certification → no rule text (the ladder is the rule), real levels
        let ruleType: Oi33MedalRuleType;
        let rule = '';
        let levels: Oi33MedalLevel[] | undefined;
        if (category === 'oj') {
            const rawRuleType = field(body, 'ruleType') || RULE_OPTIONS[0].value;
            if (!RULE_TYPE_SET.has(rawRuleType as Oi33MedalRuleType)) {
                throw new ValidationError('自动发放指标无效。');
            }
            ruleType = rawRuleType as Oi33MedalRuleType;
            const rows = parseLevelRows(body);
            if (!rows.length) throw new ValidationError('OJ 成就奖章至少需要一个等级。');
            // The row order defines the rung order, so the thresholds must
            // strictly ascend; otherwise a higher rung could unlock earlier.
            let previousThreshold = 0;
            for (const row of rows) {
                const value = Number.parseInt(row.threshold || '0', 10);
                if (!Number.isSafeInteger(value) || value <= 0 || value > 1000000000) {
                    throw new ValidationError(`等级「${row.name}」的阈值应为 1–1000000000 的整数。`);
                }
                if (value <= previousThreshold) {
                    throw new ValidationError('等级阈值必须由低到高严格递增，请调整后再保存。');
                }
                previousThreshold = value;
            }
            levels = buildLevels(rows, files, existing?.levels || [], true, ruleType);
            const top = levels[levels.length - 1];
            rule = `${oi33Model.medalAutomaticRuleText(ruleType, Number(top.threshold) || 0)} 起逐级自动升级`;
        } else if (category === 'certification') {
            ruleType = 'certification';
            const rows = parseLevelRows(body);
            if (!rows.length) throw new ValidationError('奖项认证奖章至少需要一个等级。');
            levels = buildLevels(rows, files, existing?.levels || []);
            rule = `${levels.length} 级认证：${levels.map((item) => item.name).join(' < ')}`;
        } else {
            ruleType = 'manual';
            rule = field(body, 'rule');
            if (!rule || [...rule].length > 500) {
                throw new ValidationError('奖章的达成规则应为 1–500 字。');
            }
        }

        await oi33Model.medalSave({
            id, name, description, rule, ruleType, order,
            ...(levels === undefined ? {} : { levels }),
            imageData: image.imageData,
            imageSize: image.imageSize,
            saleable: category === 'saleable',
            operator: this.user._id,
        });
        this.response.redirect = this.url('oi33_medal_manage', {
            query: { notification: existing ? '奖章已保存' : '奖章已创建' },
        });
    }
}

class MedalDeleteHandler extends Handler {
    @param('id', Types.String)
    async post(domainId: string, id: string) {
        await checkOi33Admin(this.user._id);
        // 有进行中的拍卖时先取消（自动退回领先者的托管罐头），
        // 避免残留指向已删除奖章的拍卖。
        const activeAuctions = await auctionColl.find({ medalId: id, status: 'active' }).toArray();
        for (const auction of activeAuctions) {
            await oi33Model.auctionCancel(auction._id, this.user._id);
        }
        if (!(await oi33Model.medalDelete(id, this.user._id))) {
            throw new NotFoundError(id);
        }
        this.response.redirect = this.url('oi33_medal_manage');
    }
}

class MedalGrantHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const uid = Number(field(body, 'uid'));
        const medalId = field(body, 'medalId');
        if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidationError('用户 UID 无效。');
        if (!(await UserModel.getById('', uid))) throw new NotFoundError(uid);
        const medal = await oi33Model.medalGet(medalId);
        if (!medal) throw new ValidationError('奖章不存在。');
        // Upgradable series are granted through the level ladder: the same
        // action creates the award or moves an existing one to the new rung.
        if (oi33Model.medalIsLevelSeries(medal)) {
            const level = Number.parseInt(field(body, 'level') || '0', 10);
            if (!Number.isSafeInteger(level) || level <= 0) {
                throw new ValidationError('请选择要发放的等级。');
            }
            const result = await oi33Model.medalSetLevel(uid, medalId, level, this.user._id);
            this.response.redirect = `/oi33/medals/user/${uid}?notification=${
                encodeURIComponent(result.created ? '奖章已发放' : '奖章等级已更新')}`;
            return;
        }
        const result = await oi33Model.medalGrant(
            uid, medalId, this.user._id, 'manual',
        );
        if (!result.created) throw new ValidationError('该用户已经获得这个奖章。');
        this.response.redirect = `/oi33/medals/user/${uid}?notification=奖章已发放`;
    }
}

class MedalLevelHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const uid = Number(field(body, 'uid'));
        const medalId = field(body, 'medalId');
        const level = Number.parseInt(field(body, 'level') || '0', 10);
        if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidationError('用户 UID 无效。');
        if (!Number.isSafeInteger(level) || level <= 0) throw new ValidationError('奖章等级无效。');
        if (!(await UserModel.getById('', uid))) throw new NotFoundError(uid);
        const result = await oi33Model.medalSetLevel(uid, medalId, level, this.user._id);
        const notification = result.created
            ? '奖章已发放'
            : result.previousLevel === result.level
                ? '该用户已经是这个等级'
                : `奖章等级已从 Lv.${result.previousLevel ?? '-'} 更新为 Lv.${result.level}`;
        const back = field(body, 'back');
        const target = back === 'manage' ? this.url('oi33_medal_manage', { query: { uid } }) : `/oi33/medals/user/${uid}`;
        this.response.redirect = `${target}${target.includes('?') ? '&' : '?'}notification=${encodeURIComponent(notification)}`;
    }
}

class MedalRevokeHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const uid = Number(field(body, 'uid'));
        const medalId = field(body, 'medalId');
        if (!(await oi33Model.medalRevoke(uid, medalId, this.user._id))) {
            throw new ValidationError('该用户没有这个奖章。');
        }
        this.response.redirect = `/oi33/medals/user/${uid}?notification=奖章已撤销`;
    }
}

let medalScanRunning = false;

class MedalScanHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        if (medalScanRunning) throw new ValidationError('OJ 成就奖章扫描正在进行中。');
        medalScanRunning = true;
        oi33Model.medalEvaluateAll()
            .then((result) => {
                console.info(
                    `[oi33] medal scan: ${result.users} users, `
                    + `${result.matched} matched, ${result.granted} granted`,
                );
            })
            .catch((e) => console.error('[oi33] medal scan failed:', e))
            .finally(() => { medalScanRunning = false; });
        this.response.redirect = this.url('oi33_medal_manage', {
            query: { notification: 'OJ 成就奖章扫描已开始' },
        });
    }
}

const SHOWCASE_MAX = 16;

class MedalShowcaseHandler extends Handler {
    async get() {
        if ((await checkUserFlag(this.user._id)) < 1) {
            throw new ForbiddenError('只有通过认证的用户才能编辑奖章展示柜。');
        }
        const [awards, oi33Data] = await Promise.all([
            oi33Model.medalGetUserAwards(this.user._id),
            oi33Model.getUserDataByUids([this.user._id]),
        ]);
        const selected: string[] = oi33Data[this.user._id]?.medal_showcase || [];
        // Show current selection first, in the saved order, so the existing
        // arrangement is editable without hunting through the full list.
        const awardMap = new Map(awards.map((award: any) => [String(award.medalId), award]));
        const selectedAwards = selected.map((id) => awardMap.get(String(id))).filter(Boolean);
        const rest = awards.filter((award: any) => !selected.includes(String(award.medalId)));
        const positions = Object.fromEntries(selected.map((id, index) => [id, index + 1]));
        this.response.template = 'oi33_medal_showcase.html';
        this.response.body = {
            awards: [...selectedAwards, ...rest],
            selected,
            positions,
            max: SHOWCASE_MAX,
        };
    }

    async post() {
        if ((await checkUserFlag(this.user._id)) < 1) {
            throw new ForbiddenError('只有通过认证的用户才能编辑奖章展示柜。');
        }
        const body = this.request.body as any;
        const raw = body?.ids;
        const checked = [...new Set(
            (Array.isArray(raw) ? raw : raw ? [raw] : []).map((value) => String(value).trim()).filter(Boolean),
        )];
        // Each checked medal carries a position number; sort by it, ties keep
        // the checkbox order. Missing/invalid numbers sink to the end.
        const ids = checked
            .map((id, index) => ({ id, index, pos: Number(field(body, `pos_${id}`)) }))
            .sort((a, b) => (
                (Number.isSafeInteger(a.pos) && a.pos >= 1 ? a.pos : Infinity)
                - (Number.isSafeInteger(b.pos) && b.pos >= 1 ? b.pos : Infinity)
            ) || a.index - b.index)
            .map((item) => item.id);
        if (ids.length > SHOWCASE_MAX) {
            throw new ValidationError(`展示柜最多展示 ${SHOWCASE_MAX} 个奖章。`);
        }
        const awards = await oi33Model.medalGetUserAwards(this.user._id);
        const earned = new Set(awards.map((award: any) => String(award.medalId)));
        if (ids.some((id) => !earned.has(id))) {
            throw new ValidationError('只能展示自己已经获得的奖章。');
        }
        await userColl.updateOne(
            { _id: this.user._id },
            ids.length ? { $set: { medal_showcase: ids } } : { $unset: { medal_showcase: '' } },
            { upsert: true },
        );
        await addLog({
            type: 'medal', userId: this.user._id, action: 'showcase_update',
            reason: ids.join(', '),
        });
        this.response.redirect = this.url('oi33_medal_showcase', {
            query: { notification: '奖章展示柜已保存' },
        });
    }
}

// Public catalogue: every family, with each certification series showing its
// full ladder and how many users sit on each rung.
class MedalCatalogueHandler extends Handler {
    async get() {
        await oi33Model.auctionSettleExpired();
        const now = new Date();
        const [groups, saleableRows, stats] = await Promise.all([
            oi33Model.medalCatalogue(),
            oi33Model.auctionSaleableShowcase(),
            oi33Model.medalAwardStats(),
        ]);
        const uids = saleableRows.filter((row) => row.award).map((row) => row.award!.uid);
        const udict = await buildUserDict('', uids);
        this.response.template = 'oi33_medal_catalogue.html';
        this.response.body = {
            groups,
            stats,
            rows: saleableRows.map((row) => ({
                ...row,
                remainText: row.activeAuction ? remainText(row.activeAuction.endAt, now) : '',
            })),
            udict,
        };
    }
}

class MedalUserHandler extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new NotFoundError(uid);
        const targetFlag = await checkUserFlag(uid);
        const viewerFlag = this.user._id ? await checkUserFlag(this.user._id) : 0;
        const awards = targetFlag >= 1 ? await oi33Model.medalGetUserAwards(uid) : [];
        this.response.template = 'oi33_medal_user.html';
        this.response.body = {
            udoc, awards, canManage: viewerFlag >= 2,
            levels: Object.fromEntries(awards
                .filter((award: any) => award.view.leveled)
                .map((award: any) => [award.medalId, oi33Model.medalSortedLevels(award.medal)])),
        };
    }
}

// Public page backing a certification level in the catalogue: everybody who
// currently holds that exact rung. The catalogue links each rung here so the
// holder count is not a dead end.
class MedalLevelUsersHandler extends Handler {
    @param('id', Types.String)
    @param('level', Types.Int)
    async get(domainId: string, id: string, level: number) {
        const medal = await oi33Model.medalGet(id);
        if (!medal || oi33Model.medalCategoryOf(medal) !== 'certification') {
            throw new NotFoundError(id);
        }
        const rung = oi33Model.medalLevelOf(medal, level);
        if (!rung) throw new NotFoundError(String(level));
        const awards = await oi33Model.medalListLevelHolders(id, Number(rung.level));
        const udict = await buildUserDict(domainId, awards.map((award) => award.uid));
        this.response.template = 'oi33_medal_level_users.html';
        this.response.body = {
            medal,
            rung,
            awards,
            udict,
            levels: oi33Model.medalSortedLevels(medal),
        };
    }
}

async function buildUserDict(domainId: string, uids: number[]) {
    const unique = [...new Set(uids.filter((uid) => Number.isSafeInteger(uid) && uid > 0))];
    if (!unique.length) return {};
    const udict = await UserModel.getList(domainId, unique);
    const oi33Data = await oi33Model.getUserDataByUids(unique);
    for (const uid of unique) {
        if (udict[uid] && oi33Data[uid]) oi33Model.mergeOi33Fields(udict[uid], oi33Data[uid]);
    }
    return udict;
}

function registerMedalUserPanel(ctx: Context) {
    ctx.on('handler/after/UserDetail', async (h: any) => {
        try {
            const body = h.response?.body;
            const uid = Number(body?.udoc?._id);
            if (!Number.isSafeInteger(uid) || uid <= 0) return;
            const targetData = (await oi33Model.getUserDataByUids([uid]))[uid];
            if ((targetData?.realname_flag ?? 0) < 1) return;
            const viewerUid = Number(h.user?._id) || 0;
            const [awards, viewerFlag] = await Promise.all([
                oi33Model.medalGetUserAwards(uid),
                viewerUid ? checkUserFlag(viewerUid) : Promise.resolve(0),
            ]);
            const rawShowcase = targetData?.medal_showcase;
            const showcaseIds = Array.isArray(rawShowcase) ? rawShowcase : [];
            // The stored array order is the display order chosen by the user.
            const awardMap = new Map(awards.map((award: any) => [String(award.medalId), award]));
            const showcaseAwards = showcaseIds.map((id) => awardMap.get(String(id))).filter(Boolean);
            body.oi33MedalPanel = {
                awards, showcaseAwards,
                showcaseConfigured: showcaseIds.length > 0,
                isSelf: viewerUid === uid,
                canManage: viewerFlag >= 2,
            };
        } catch (e) {
            console.error('[oi33] medal profile panel failed:', e);
        }
    });
}

// The medal pages moved from /oi33/achievements to the 奖章 naming. These four
// permanent redirects keep old bookmarks and chat links working; the POST
// endpoints are internal form targets and simply moved with the pages.
class LegacyMedalManageRedirect extends Handler {
    async get() {
        this.response.redirect = this.url('oi33_medal_manage');
    }
}

class LegacyMedalCatalogueRedirect extends Handler {
    async get() {
        this.response.redirect = this.url('oi33_medal_catalogue');
    }
}

class LegacyMedalShowcaseRedirect extends Handler {
    async get() {
        this.response.redirect = this.url('oi33_medal_showcase');
    }
}

class LegacyMedalUserRedirect extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        this.response.redirect = this.url('oi33_medal_user', { uid });
    }
}

function registerLegacyRedirects(ctx: Context) {
    ctx.Route('oi33_legacy_medal_manage', '/oi33/achievements', LegacyMedalManageRedirect);
    ctx.Route('oi33_legacy_medal_catalogue', '/oi33/achievements/rare', LegacyMedalCatalogueRedirect);
    ctx.Route('oi33_legacy_medal_showcase', '/oi33/achievements/showcase', LegacyMedalShowcaseRedirect);
    ctx.Route('oi33_legacy_medal_user', '/oi33/achievements/user/:uid', LegacyMedalUserRedirect);
}

export async function apply(ctx: Context) {
    ctx.Route(
        'oi33_medal_manage',
        '/oi33/medals',
        MedalManageHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_save',
        '/oi33/medals/save',
        MedalSaveHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_config',
        '/oi33/medals/config',
        MedalConfigHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_export',
        '/oi33/medals/export',
        MedalExportHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_import',
        '/oi33/medals/import',
        MedalImportHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_delete',
        '/oi33/medals/:id/delete',
        MedalDeleteHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_grant',
        '/oi33/medals/grant',
        MedalGrantHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_level',
        '/oi33/medals/level',
        MedalLevelHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_revoke',
        '/oi33/medals/revoke',
        MedalRevokeHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_scan',
        '/oi33/medals/scan',
        MedalScanHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_catalogue',
        '/oi33/medals/catalogue',
        MedalCatalogueHandler,
    );
    ctx.Route(
        'oi33_medal_level_users',
        '/oi33/medals/catalogue/:id/level/:level',
        MedalLevelUsersHandler,
    );
    ctx.Route(
        'oi33_medal_showcase',
        '/oi33/medals/showcase',
        MedalShowcaseHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_user',
        '/oi33/medals/user/:uid',
        MedalUserHandler,
    );
    ctx.on('record/judge', async (rdoc: any, updated: boolean) => {
        if (!updated || rdoc?.status !== STATUS.STATUS_ACCEPTED) return;
        if (!oi33Model.medalAcceptedDomainIncluded(String(rdoc.domainId ?? ''))) return;
        try {
            await oi33Model.medalEvaluateUser(rdoc.uid, {
                ruleTypes: ['accepted_problems'],
            });
        } catch (e) {
            console.error('[oi33] accepted-problem medal evaluation failed:', e);
        }
    });
    registerMedalUserPanel(ctx);
    registerLegacyRedirects(ctx);
}
