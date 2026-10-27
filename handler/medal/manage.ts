import { readFileSync } from 'fs';
import { Handler, NotFoundError, Types, UserModel, ValidationError, param, query } from 'hydrooj';
import { oi33Model, auctionColl } from '../../model';
import type { Oi33MedalCategory, Oi33MedalLevel, Oi33MedalRuleType } from '../../model/types';
import { checkOi33Admin } from '../utils';

import {
    RULE_OPTIONS, CATEGORY_OPTIONS, CATEGORY_SET, RULE_TYPE_SET,
    buildLevels, field, fileOf, hasUpload, parseLevelRows, readPixelPng,
    type MedalManageViewParams,
} from './shared';

// 奖章管理页：目录管理、新建/编辑、全局配置、定义导入导出、最近授予。

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
        // 发放表单用经典用户选择器：先回填用户名，选中后提交 uidOrName。
        targetUname: targetUid ? (udict[targetUid]?.uname || '') : '',
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

export class MedalManageHandler extends Handler {
    @query('edit', Types.String, true)
    @query('uid', Types.Int, true)
    @query('category', Types.String, true)
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, edit = '', targetUid?: number, preselect = '', page = 1) {
        await checkOi33Admin(this.user._id);
        // `@query` 正常会注入 edit；这里再从原始 query 兜一层，避免装饰器/框架
        // 版本差异导致 ?edit=... 被丢掉时页面悄悄退回空白新建表单。
        const rawEdit = (this.request as any)?.query?.edit;
        this.response.template = 'oi33_medal_manage.html';
        this.response.body = await buildMedalManageView(domainId, {
            edit: edit || String(rawEdit || ''), targetUid, preselect, page,
        });
    }
}

// 编辑页专用路由：id 放在路径里（/oi33/medals/edit/:id），不依赖查询串。
// 旧链接 ?edit=<id> 仍然保留，但页面里的「编辑」按钮走这条更稳的路。
export class MedalEditHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        await checkOi33Admin(this.user._id);
        this.response.template = 'oi33_medal_manage.html';
        this.response.body = await buildMedalManageView(domainId, { edit: String(id || '') });
    }
}

export class MedalConfigHandler extends Handler {
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

export class MedalExportHandler extends Handler {
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

export class MedalImportHandler extends Handler {
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

export class MedalSaveHandler extends Handler {
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

export class MedalDeleteHandler extends Handler {
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
