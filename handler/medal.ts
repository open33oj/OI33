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
import { checkOi33Admin, checkUserFlag, loadOi33Users } from './utils';

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
    { value: 'special_medals', label: '获得 x 枚特殊奖章（一般 / 可售卖 / 奖项认证）' },
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

        const editingExisting = field(body, 'editing') === '1';
        const existing = await oi33Model.medalGet(id);
        // 新建时绝不能静默覆盖同 ID 的已有奖章；编辑时目标必须还存在。
        if (!editingExisting && existing) {
            throw new ValidationError(`奖章 ID「${id}」已存在，请换一个 ID。`);
        }
        if (editingExisting && !existing) {
            throw new ValidationError('要编辑的奖章不存在，可能已被删除。');
        }
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

// Append a one-shot notification to a management redirect target. `back` lets
// the global management page keep its own forms on `/oi33/medals`; everything
// else returns to the per-user management page.
function withNotification(target: string, text: string) {
    return `${target}${target.includes('?') ? '&' : '?'}notification=${encodeURIComponent(text)}`;
}

function userManageTarget(handler: Handler, uid: number, back: string) {
    return back === 'manage'
        ? handler.url('oi33_medal_manage', { query: { uid } })
        : handler.url('oi33_medal_user_manage', { uid });
}

class MedalGrantHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const uid = Number(field(body, 'uid'));
        const medalId = field(body, 'medalId');
        const target = userManageTarget(this, uid, field(body, 'back'));
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
            this.response.redirect = withNotification(
                target, result.created ? '奖章已发放' : '奖章等级已更新',
            );
            return;
        }
        const result = await oi33Model.medalGrant(
            uid, medalId, this.user._id, 'manual',
        );
        if (!result.created) {
            // 一般奖章可以重复发放：数量 +1 并升星（星级 = ⌊log₂ 数量⌋）；
            // 其它系列仍然只能拥有一枚。
            const count = Math.max(1, Math.floor(Number((result.grant as any)?.count) || 1));
            if (count <= 1) throw new ValidationError('该用户已经获得这个奖章。');
            const stars = oi33Model.medalStarLevel(count);
            this.response.redirect = withNotification(
                target, `已再获得一枚「${medal.name}」（第 ${count} 枚${stars ? `，★${stars}` : ''}）`,
            );
            return;
        }
        this.response.redirect = withNotification(target, '奖章已发放');
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
                : `奖章等级已从第 ${result.previousLevel ?? '-'} 级更新为第 ${result.level} 级`;
        const target = userManageTarget(this, uid, field(body, 'back'));
        this.response.redirect = withNotification(target, notification);
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
        this.response.redirect = withNotification(
            userManageTarget(this, uid, field(body, 'back')), '奖章已撤销',
        );
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

// The showcase wall is a 320×128 pixel canvas of 10×4 uniform 32px medals (see
// model/medal-rules.ts):
// a placement is `{ id, x, y }` with the sprite's top-left corner in canvas
// pixels. The editor posts the whole wall as JSON in `slots`; the profile and
// the editor both render it with an integer scale factor so the pixel art
// stays crisp. Legacy 4×4 data (id/null slots) is converted on read.
const SHOWCASE_MAX = oi33Model.MEDAL_SHOWCASE_MAX_PIECES;

function showcasePiecesFromBody(body: any): Array<{ id: string; x: number; y: number }> {
    const raw = body?.slots;
    if (typeof raw !== 'string' || !raw.trim()) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new ValidationError('展示墙数据格式不正确，请刷新页面后重试。');
    }
    if (!Array.isArray(parsed)) throw new ValidationError('展示墙数据格式不正确，请刷新页面后重试。');
    if (parsed.length > SHOWCASE_MAX) {
        throw new ValidationError(`展示墙最多摆放 ${SHOWCASE_MAX} 枚奖章。`);
    }
    return oi33Model.medalShowcasePieces(parsed);
}

class MedalShowcaseHandler extends Handler {
    async get() {
        if ((await checkUserFlag(this.user._id)) < 1) {
            throw new ForbiddenError('只有通过认证的用户才能编辑奖章展示墙。');
        }
        const [awards, oi33Data] = await Promise.all([
            oi33Model.medalGetUserAwards(this.user._id),
            oi33Model.getUserDataByUids([this.user._id]),
        ]);
        const awardMap = new Map(awards.map((award: any) => [String(award.medalId), award]));
        const limitOf = (id: string) => {
            const award = awardMap.get(String(id));
            return award ? oi33Model.medalShowcaseCopyLimit(award.view) : 0;
        };
        // Over-limit copies (or medals the user no longer holds) are dropped
        // here, so the editor always opens in a legal state and saving without
        // further edits never fails validation.
        const placed = oi33Model.medalShowcaseTrim(
            oi33Model.medalShowcasePieces(oi33Data[this.user._id]?.medal_showcase),
            limitOf,
        );
        const placedCount = new Map<string, number>();
        for (const piece of placed) placedCount.set(piece.id, (placedCount.get(piece.id) || 0) + 1);
        const editorAwards = awards.map((award: any) => ({
            ...award,
            showcaseLimit: oi33Model.medalShowcaseCopyLimit(award.view),
            showcasePlaced: placedCount.get(String(award.medalId)) || 0,
        }));
        const pieces = placed.map((piece) => ({
            ...piece,
            size: oi33Model.MEDAL_SHOWCASE_CELL,
            award: awardMap.get(piece.id) || null,
        }));
        this.response.template = 'oi33_medal_showcase.html';
        this.response.body = {
            awards: editorAwards,
            pieces,
            // Prefilled so a page whose script failed to run still submits the
            // wall it was showing instead of wiping it.
            slotsJson: JSON.stringify(placed),
            maxPieces: SHOWCASE_MAX,
            wallWidth: oi33Model.MEDAL_SHOWCASE_WIDTH,
            wallHeight: oi33Model.MEDAL_SHOWCASE_HEIGHT,
            cell: oi33Model.MEDAL_SHOWCASE_CELL,
            columns: oi33Model.MEDAL_SHOWCASE_COLUMNS,
            rows: oi33Model.MEDAL_SHOWCASE_ROWS,
            snap: oi33Model.MEDAL_SHOWCASE_SNAP,
        };
    }

    async post() {
        if ((await checkUserFlag(this.user._id)) < 1) {
            throw new ForbiddenError('只有通过认证的用户才能编辑奖章展示墙。');
        }
        const body = this.request.body as any;
        const awards = await oi33Model.medalGetUserAwards(this.user._id);
        const awardMap = new Map(awards.map((award: any) => [String(award.medalId), award]));
        const pieces = showcasePiecesFromBody(body);
        if (pieces.some((piece) => !awardMap.has(piece.id))) {
            throw new ValidationError('只能展示自己已经获得的奖章。');
        }
        // 一般奖章按星级允许摆多份，其它系列只能摆一份（见 medalShowcaseCopyLimit）。
        const copies = new Map<string, number>();
        for (const piece of pieces) copies.set(piece.id, (copies.get(piece.id) || 0) + 1);
        for (const [id, count] of copies) {
            const award: any = awardMap.get(id);
            const limit = oi33Model.medalShowcaseCopyLimit(award?.view);
            if (count > limit) {
                throw new ValidationError(`「${award.view.name}」最多只能展示 ${limit} 枚。`);
            }
        }
        await userColl.updateOne(
            { _id: this.user._id },
            pieces.length ? { $set: { medal_showcase: pieces } } : { $unset: { medal_showcase: '' } },
            { upsert: true },
        );
        await addLog({
            type: 'medal', userId: this.user._id, action: 'showcase_update',
            reason: pieces.map((piece) => `${piece.id}@${piece.x},${piece.y}`).join(', '),
        });
        this.response.redirect = this.url('oi33_medal_showcase', {
            query: { notification: '奖章展示墙已保存' },
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
        // 只有一般奖章会存 `count`（重复获得）；其它系列每人恒为 1 枚，旧数据
        // 若误带 count 也不让它把「总持有数量」算大。
        const manualIds = new Set((groups.manual || []).map((medal: any) => String(medal._id)));
        for (const [id, stat] of Object.entries(stats)) {
            if (!manualIds.has(id)) stat.copies = stat.total;
        }
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
        // Display-only: management lives on /oi33/medals/user/:uid/manage,
        // reachable from the admin button on the profile card. This page never
        // receives revoke / level forms or an admin entry point of its own.
        const awards = targetFlag >= 1 ? await oi33Model.medalGetUserAwards(uid) : [];
        this.response.template = 'oi33_medal_user.html';
        this.response.body = { udoc, awards };
    }
}

// Dedicated per-user medal management: grant, revoke and level changes live
// here instead of being mixed into the public display page. Kept behind the
// same OI33 admin flag as /oi33/medals.
class MedalUserManageHandler extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        await checkOi33Admin(this.user._id);
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new NotFoundError(uid);
        const [awards, medals] = await Promise.all([
            oi33Model.medalGetUserAwards(uid),
            oi33Model.medalList(),
        ]);
        const leveled = medals.filter((medal) => oi33Model.medalIsLevelSeries(medal));
        const plain = medals.filter((medal) => !oi33Model.medalIsLevelSeries(medal));
        const byCategory = (list: any[], category: Oi33MedalCategory) => list.filter(
            (medal: any) => medal.category === category,
        );
        // Same order as the global management page: 可售卖 → 奖项认证 → 一般 →
        // OJ 成就（含尚未迁移成阶梯的旧定义）。
        const grantMedals = [
            ...byCategory(plain, 'saleable'),
            ...byCategory(leveled, 'certification'),
            ...byCategory(plain, 'manual'),
            ...byCategory(leveled, 'oj'),
            ...byCategory(plain, 'oj'),
        ];
        const medalLevels = Object.fromEntries(leveled.map((medal) => [medal._id,
            oi33Model.medalSortedLevels(medal).map((level) => ({
                level: level.level,
                name: oi33Model.medalLevelLabel(level),
                ...(Number(level.threshold) > 0 ? { threshold: Number(level.threshold) } : {}),
            }))]));
        this.response.template = 'oi33_medal_user_manage.html';
        this.response.body = {
            udoc,
            awards,
            grantMedals,
            medalLevels,
            levels: Object.fromEntries(awards
                .filter((award: any) => award.view.leveled)
                .map((award: any) => [award.medalId, oi33Model.medalSortedLevels(award.medal)])),
        };
    }
}

// Public page backing a level in the catalogue: everybody who currently holds
// that exact rung. Certification and OJ 成就 series both have ladders, so both
// link their rungs here; the catalogue's holder counts are never a dead end.
class MedalLevelUsersHandler extends Handler {
    @param('id', Types.String)
    @param('level', Types.Int)
    async get(domainId: string, id: string, level: number) {
        const medal = await oi33Model.medalGet(id);
        if (!medal || !oi33Model.medalIsLevelSeries(medal)) {
            throw new NotFoundError(id);
        }
        const rung = oi33Model.medalLevelOf(medal, level);
        if (!rung) throw new NotFoundError(String(level));
        const awards = await oi33Model.medalListLevelHolders(id, Number(rung.level));
        // 每个持有人的持有数量（等级系列恒为 1；仍统一走 medalAwardView，
        // 避免旧数据里的 count 字段被误当成多枚）。
        const rows = awards.map((award: any) => {
            const view = oi33Model.medalAwardView(award, medal);
            return { ...award, copies: view.count, stars: view.stars };
        });
        const totalCopies = rows.reduce((sum, award) => sum + award.copies, 0);
        const udict = await buildUserDict(domainId, rows.map((award) => award.uid));
        this.response.template = 'oi33_medal_level_users.html';
        this.response.body = {
            medal,
            rung,
            awards: rows,
            udict,
            totalCopies,
            levels: oi33Model.medalSortedLevels(medal),
        };
    }
}

// Holder list for one definition, whatever family it belongs to: the catalogue
// links every medal card here (一般奖章 / 未分级的 OJ 成就奖章 / 可售卖奖章 all
// end up as a flat list; series are grouped by rung in ladder order and offer
// the per-level switch). Awards whose rung no longer exists on the ladder fall
// back to the closest surviving one via `medalDisplayRung`.
class MedalHoldersHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        const medal = await oi33Model.medalGet(id);
        if (!medal) throw new NotFoundError(id);
        const awards = await oi33Model.medalListHolders(id);
        // 一般奖章可以重复获得：数量与派生星级一并给模板（其它系列恒为 1 枚）。
        const rows = awards.map((award: any) => {
            const view = oi33Model.medalAwardView(award, medal);
            return { ...award, copies: view.count, stars: view.stars };
        });
        const totalCopies = rows.reduce((sum, award) => sum + award.copies, 0);
        const udict = await buildUserDict(domainId, rows.map((award: any) => award.uid));
        const leveled = oi33Model.medalIsLevelSeries(medal);
        const groups = leveled
            ? oi33Model.medalSortedLevels(medal).map((level) => {
                const levelAwards = rows.filter(
                    (award: any) => Number(oi33Model.medalDisplayRung(medal, award.level)?.level)
                        === Number(level.level),
                );
                return {
                    level,
                    awards: levelAwards,
                    copies: levelAwards.reduce((sum, award) => sum + award.copies, 0),
                };
            })
            : [];
        this.response.template = 'oi33_medal_holders.html';
        this.response.body = {
            medal,
            awards: rows,
            udict,
            count: rows.length,
            totalCopies,
            leveled,
            levels: leveled ? oi33Model.medalSortedLevels(medal) : [],
            groups,
        };
    }
}

async function buildUserDict(domainId: string, uids: number[]) {
    const unique = uids.filter((uid) => Number.isSafeInteger(uid) && uid > 0);
    return loadOi33Users(domainId, unique);
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
            // The profile renders the same free canvas the user arranged, at an
            // integer scale (frontend/medal-showcase.page.ts fits it to the
            // card). Copies beyond the medal's allowance (or medals that no
            // longer exist) are dropped so the card stays legal.
            const awardMap = new Map(awards.map((award: any) => [String(award.medalId), award]));
            const limitOf = (id: string) => {
                const award = awardMap.get(String(id));
                return award ? oi33Model.medalShowcaseCopyLimit(award.view) : 0;
            };
            const showcasePieces = oi33Model.medalShowcaseTrim(
                oi33Model.medalShowcasePieces(targetData?.medal_showcase),
                limitOf,
            ).map((piece) => ({
                ...piece,
                size: oi33Model.MEDAL_SHOWCASE_CELL,
                award: awardMap.get(piece.id) || null,
            }));
            // The profile card only renders the showcase wall (plus the button
            // to the standalone /oi33/medals/user/:uid page), so the full award
            // list stays out of the response body — it would ship every PNG.
            body.oi33MedalPanel = {
                showcasePieces,
                showcaseConfigured: showcasePieces.length > 0,
                showcaseWall: {
                    width: oi33Model.MEDAL_SHOWCASE_WIDTH,
                    height: oi33Model.MEDAL_SHOWCASE_HEIGHT,
                    cell: oi33Model.MEDAL_SHOWCASE_CELL,
                    grid: oi33Model.MEDAL_SHOWCASE_SNAP,
                },
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
        'oi33_medal_holders',
        '/oi33/medals/catalogue/:id/holders',
        MedalHoldersHandler,
    );
    ctx.Route(
        'oi33_medal_showcase',
        '/oi33/medals/showcase',
        MedalShowcaseHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_user_manage',
        '/oi33/medals/user/:uid/manage',
        MedalUserManageHandler,
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
