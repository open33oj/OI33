import {
    Context, Handler, NotFoundError, PRIV, STATUS, Types, UserModel, ValidationError,
    param, query,
} from 'hydrooj';
import { readFileSync } from 'fs';
import { oi33Model } from '../model';
import type { Oi33AchievementImageSize } from '../model/types';
import type { Oi33AchievementRuleType } from '../model/types';
import { checkOi33Admin, checkUserFlag } from './utils';

const IMAGE_SIZES = new Set([8, 16, 24, 32]);
const MAX_IMAGE_BYTES = 256 * 1024;
const RULE_OPTIONS: Array<{ value: Oi33AchievementRuleType; label: string }> = [
    { value: 'manual', label: '手动发放' },
    { value: 'accepted_problems', label: '通过 x 道不重复的题目' },
    { value: 'checkin_streak', label: '连续登录 x 天' },
    { value: 'checkin_total', label: '累计登录 x 天' },
    { value: 'cat_food_balance', label: '猫粮达到 x g' },
    { value: 'cat_can_balance', label: '猫罐头持有 x 个' },
];
const RULE_TYPE_SET = new Set(RULE_OPTIONS.map((item) => item.value));
const PROFILE_GROUPS: Array<{ ruleType: Oi33AchievementRuleType; label: string }> = [
    { ruleType: 'accepted_problems', label: '通过题目' },
    { ruleType: 'checkin_streak', label: '连续登录' },
    { ruleType: 'checkin_total', label: '累计登录' },
    { ruleType: 'cat_food_balance', label: '猫粮' },
    { ruleType: 'cat_can_balance', label: '猫罐头' },
    { ruleType: 'manual', label: '其他成就' },
];

function automaticRuleText(type: Oi33AchievementRuleType, threshold: number): string {
    if (type === 'accepted_problems') return `通过 ${threshold} 道题号不同的题目`;
    if (type === 'checkin_streak') return `连续登录 ${threshold} 天`;
    if (type === 'checkin_total') return `累计登录 ${threshold} 天`;
    if (type === 'cat_food_balance') {
        const amount = threshold % 1000 === 0 ? `${threshold / 1000} kg` : `${threshold} g`;
        return `猫粮余额曾达到 ${amount}`;
    }
    if (type === 'cat_can_balance') return `猫罐头持有 ${threshold} 个`;
    return '';
}

function field(body: any, name: string): string {
    const value = body?.[name];
    return String(Array.isArray(value) ? value[0] : value ?? '').trim();
}

function readPixelPng(file: any): { imageData: string; imageSize: Oi33AchievementImageSize } {
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
        imageSize: width as Oi33AchievementImageSize,
    };
}

class AchievementManageHandler extends Handler {
    @query('edit', Types.String, true)
    @query('uid', Types.Int, true)
    async get(domainId: string, edit = '', targetUid?: number) {
        await checkOi33Admin(this.user._id);
        const [achievements, recentAwards] = await Promise.all([
            oi33Model.achievementList(),
            oi33Model.achievementListRecentAwards(),
        ]);
        const acceptedDomains = oi33Model.achievementGetAcceptedDomains();
        const editing = edit ? await oi33Model.achievementGet(edit) : null;
        if (edit && !editing) throw new NotFoundError(edit);
        const uids = [...new Set([
            ...recentAwards.map((award) => award.uid),
            ...(targetUid ? [targetUid] : []),
        ])];
        const udict = uids.length ? await UserModel.getList(domainId, uids) : {};
        const achievementDict = Object.fromEntries(
            achievements.map((achievement) => [achievement._id, achievement]),
        );
        this.response.template = 'oi33_achievement_manage.html';
        this.response.body = {
            achievements, achievementDict, recentAwards, udict, editing,
            targetUid: targetUid || '', ruleOptions: RULE_OPTIONS,
            acceptedDomainsText: acceptedDomains.join('\n'),
        };
    }
}

class AchievementConfigHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const raw = field(this.request.body as any, 'acceptedDomains');
        const domains = [...new Set(raw.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean))];
        if (domains.length > 100) throw new ValidationError('参与统计的域不能超过 100 个。');
        if (domains.some((domain) => domain.length > 64)) {
            throw new ValidationError('domainId 长度不能超过 64 个字符。');
        }
        await oi33Model.achievementSetAcceptedDomains(domains, this.user._id);
        this.response.redirect = this.url('oi33_achievement_manage', {
            query: { notification: '成就全局配置已保存' },
        });
    }
}

class AchievementSaveHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const id = field(body, 'id').toLowerCase();
        const name = field(body, 'name');
        const description = field(body, 'description');
        const rawRuleType = field(body, 'ruleType') || 'manual';
        if (!RULE_TYPE_SET.has(rawRuleType as Oi33AchievementRuleType)) {
            throw new ValidationError('自动发放指标无效。');
        }
        const ruleType = rawRuleType as Oi33AchievementRuleType;
        const threshold = Number.parseInt(field(body, 'threshold') || '0', 10);
        const rule = ruleType === 'manual'
            ? field(body, 'rule')
            : automaticRuleText(ruleType, threshold);
        const order = Number.parseInt(field(body, 'order') || '0', 10);
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
            throw new ValidationError('成就 ID 只能包含小写字母、数字、下划线和连字符，最长 64 位。');
        }
        if (!name || [...name].length > 50) throw new ValidationError('成就名称应为 1–50 字。');
        if (!description || [...description].length > 500) {
            throw new ValidationError('成就描述应为 1–500 字。');
        }
        if (ruleType === 'manual' && (!rule || [...rule].length > 500)) {
            throw new ValidationError('手动成就的达成规则应为 1–500 字。');
        }
        if (ruleType !== 'manual'
            && (!Number.isSafeInteger(threshold) || threshold <= 0 || threshold > 1000000000)) {
            throw new ValidationError('自动发放指标 x 应为 1–1000000000 的整数。');
        }
        if (!Number.isSafeInteger(order) || Math.abs(order) > 1000000) {
            throw new ValidationError('排序值无效。');
        }

        const existing = await oi33Model.achievementGet(id);
        const files = (this.request as any).files || {};
        const upload = Array.isArray(files.image) ? files.image[0] : files.image;
        const hasUpload = upload && (Number(upload.size) > 0 || upload.originalFilename);
        const image = hasUpload
            ? readPixelPng(upload)
            : existing
                ? { imageData: existing.imageData, imageSize: existing.imageSize }
                : null;
        if (!image) throw new ValidationError('新建成就时必须上传 PNG 像素图。');
        await oi33Model.achievementSave({
            id, name, description, rule, ruleType, order,
            ...(ruleType === 'manual' ? {} : { threshold }),
            imageData: image.imageData,
            imageSize: image.imageSize,
            operator: this.user._id,
        });
        this.response.redirect = this.url('oi33_achievement_manage');
    }
}

class AchievementDeleteHandler extends Handler {
    @param('id', Types.String)
    async post(domainId: string, id: string) {
        await checkOi33Admin(this.user._id);
        if (!(await oi33Model.achievementDelete(id, this.user._id))) {
            throw new NotFoundError(id);
        }
        this.response.redirect = this.url('oi33_achievement_manage');
    }
}

class AchievementGrantHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const uid = Number(field(body, 'uid'));
        const achievementId = field(body, 'achievementId');
        if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidationError('用户 UID 无效。');
        if (!(await UserModel.getById('', uid))) throw new NotFoundError(uid);
        const result = await oi33Model.achievementGrant(
            uid, achievementId, this.user._id, 'manual',
        );
        if (!result.created) throw new ValidationError('该用户已经获得这个成就。');
        this.response.redirect = `/oi33/achievements?uid=${uid}`;
    }
}

class AchievementRevokeHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const uid = Number(field(body, 'uid'));
        const achievementId = field(body, 'achievementId');
        if (!(await oi33Model.achievementRevoke(uid, achievementId, this.user._id))) {
            throw new ValidationError('该用户没有这个成就。');
        }
        this.response.redirect = `/oi33/achievements?uid=${uid}`;
    }
}

let achievementScanRunning = false;

class AchievementScanHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        if (achievementScanRunning) throw new ValidationError('自动成就扫描正在进行中。');
        achievementScanRunning = true;
        oi33Model.achievementEvaluateAll()
            .then((result) => {
                console.info(
                    `[oi33] achievement scan: ${result.users} users, `
                    + `${result.matched} matched, ${result.granted} granted`,
                );
            })
            .catch((e) => console.error('[oi33] achievement scan failed:', e))
            .finally(() => { achievementScanRunning = false; });
        this.response.redirect = this.url('oi33_achievement_manage', {
            query: { notification: '自动成就扫描已开始' },
        });
    }
}

function registerAchievementUserPanel(ctx: Context) {
    ctx.on('handler/after/UserDetail', async (h: any) => {
        try {
            const body = h.response?.body;
            const uid = Number(body?.udoc?._id);
            if (!Number.isSafeInteger(uid) || uid <= 0) return;
            const targetFlag = await checkUserFlag(uid);
            if (targetFlag < 1) return;
            const viewerUid = Number(h.user?._id) || 0;
            const [awards, viewerFlag] = await Promise.all([
                oi33Model.achievementGetUserAwards(uid),
                viewerUid ? checkUserFlag(viewerUid) : Promise.resolve(0),
            ]);
            const categoryGroups = PROFILE_GROUPS.map((group) => ({
                ...group,
                awards: awards.filter((award: any) => (
                    (award.achievement.ruleType || 'manual') === group.ruleType
                )),
            })).filter((group) => group.awards.length);
            const featuredMap = new Map<string, { award: any; labels: string[] }>();
            const addFeatured = (award: any, label: string) => {
                const key = String(award.achievementId);
                const existing = featuredMap.get(key);
                if (existing) {
                    if (!existing.labels.includes(label)) existing.labels.push(label);
                } else featuredMap.set(key, { award, labels: [label] });
            };
            for (const group of categoryGroups) {
                if (group.ruleType === 'manual') continue;
                const highest = group.awards.reduce((best: any, award: any) => {
                    const bestThreshold = Number(best.achievement.threshold) || 0;
                    const threshold = Number(award.achievement.threshold) || 0;
                    if (threshold !== bestThreshold) return threshold > bestThreshold ? award : best;
                    return Number(award.achievement.order) > Number(best.achievement.order)
                        ? award : best;
                });
                addFeatured(highest, `${group.label}最高`);
            }
            for (const award of awards as any[]) {
                if (award.source === 'manual') addFeatured(award, '手动授予');
            }
            const featuredAwards = [...featuredMap.values()].map(({ award, labels }) => ({
                ...award,
                featureLabel: labels.join(' · '),
            }));
            const groups = featuredAwards.length
                ? [{ label: '代表成就', awards: featuredAwards, featured: true }, ...categoryGroups]
                : categoryGroups;
            body.oi33AchievementPanel = {
                awards, groups,
                canManage: viewerFlag >= 2,
            };
        } catch (e) {
            console.error('[oi33] achievement profile panel failed:', e);
        }
    });
}

export async function apply(ctx: Context) {
    ctx.Route(
        'oi33_achievement_manage',
        '/oi33/achievements',
        AchievementManageHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_achievement_save',
        '/oi33/achievements/save',
        AchievementSaveHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_achievement_config',
        '/oi33/achievements/config',
        AchievementConfigHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_achievement_delete',
        '/oi33/achievements/:id/delete',
        AchievementDeleteHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_achievement_grant',
        '/oi33/achievements/grant',
        AchievementGrantHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_achievement_revoke',
        '/oi33/achievements/revoke',
        AchievementRevokeHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_achievement_scan',
        '/oi33/achievements/scan',
        AchievementScanHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.on('record/judge', async (rdoc: any, updated: boolean) => {
        if (!updated || rdoc?.status !== STATUS.STATUS_ACCEPTED) return;
        if (!oi33Model.achievementAcceptedDomainIncluded(String(rdoc.domainId ?? ''))) return;
        try {
            await oi33Model.achievementEvaluateUser(rdoc.uid, {
                ruleTypes: ['accepted_problems'],
            });
        } catch (e) {
            console.error('[oi33] accepted-problem achievement evaluation failed:', e);
        }
    });
    registerAchievementUserPanel(ctx);
}
