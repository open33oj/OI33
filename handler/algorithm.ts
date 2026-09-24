import {
    Context, ForbiddenError, Handler, NotFoundError, PRIV, Types, UserModel, ValidationError,
    param, query,
} from 'hydrooj';
import { oi33Model } from '../model';
import { checkOi33Admin, checkUserFlag } from './utils';

function field(body: any, name: string): string {
    const value = body?.[name];
    return String(Array.isArray(value) ? value[0] : value ?? '').trim();
}

function checked(body: any, name: string): boolean {
    const value = body?.[name];
    const first = Array.isArray(value) ? value[0] : value;
    return first === true || first === 'true' || first === 'on' || first === '1';
}

// Only same-site relative redirects are honoured, so a crafted `redirect`
// field cannot turn the save endpoint into an open redirect. Protocol-relative
// targets (`//evil.example`) and backslash variants (browsers normalise `\` to
// `/`) are rejected too.
function safeRedirect(raw: string, fallback: string): string {
    const value = String(raw || '').trim();
    return /^\/(?!\/)[^\s\\]*$/.test(value) ? value : fallback;
}

function withNotification(target: string, message: string): string {
    return `${target}${target.includes('?') ? '&' : '?'}notification=${encodeURIComponent(message)}`;
}

async function resolveViewer(h: Handler, uid: number) {
    const viewerUid = h.user._id;
    const viewerFlag = viewerUid ? await checkUserFlag(viewerUid) : 0;
    const isSelf = viewerUid === uid;
    const isTeacher = viewerFlag >= 2;
    return { viewerUid, viewerFlag, isSelf, isTeacher };
}

// The mastery panel plus the once-per-month self-assessment status. Students
// may submit their own panel once per Asia/Shanghai calendar month; teachers
// (flag >= 2) may write any student's panel at any time.
async function buildAlgorithmPanel(uid: number, viewerUid: number, viewerFlag: number) {
    const isSelf = viewerUid === uid;
    const isTeacher = viewerFlag >= 2;
    const [panel, quota] = await Promise.all([
        oi33Model.algorithmProfileView(uid, viewerUid),
        oi33Model.algorithmGetSelfQuota(uid),
    ]);
    const quotaApplies = isSelf && !isTeacher;
    return {
        ...panel,
        isSelf,
        isTeacher,
        // True when the once-per-month rule applies to this viewer.
        quotaApplies,
        // For a student: the month's submit is still available.
        canSelfUpdate: !quotaApplies || quota.canUpdate,
        selfMonth: quota.month,
        selfAt: quota.at,
        currentMonth: quota.currentMonth,
        nextUpdateAt: quota.nextUpdateAt,
        canEdit: isTeacher || (isSelf && panel.selfEdit && quota.canUpdate),
    };
}

class AlgorithmIndexHandler extends Handler {
    @query('uid', Types.Int, true)
    async get(domainId: string, uid?: number) {
        const viewerUid = this.user._id;
        if (!viewerUid) throw new ForbiddenError('请先登录。');
        let target = viewerUid;
        if (uid && uid !== viewerUid) {
            if ((await checkUserFlag(viewerUid)) < 2) {
                throw new ForbiddenError('只能查看自己的算法掌握面板。');
            }
            if (!(await UserModel.getById(domainId, uid))) throw new NotFoundError(uid);
            target = uid;
        }
        this.response.redirect = this.url('oi33_algorithm_user', { uid: target });
    }
}

class AlgorithmUserHandler extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new NotFoundError(uid);
        const { viewerUid, viewerFlag, isSelf, isTeacher } = await resolveViewer(this, uid);
        if (!isSelf && !isTeacher) throw new ForbiddenError('算法掌握面板仅本人和老师可见。');
        this.response.template = 'oi33_algorithm_user.html';
        this.response.body = {
            udoc,
            uid,
            viewerFlag,
            panel: await buildAlgorithmPanel(uid, viewerUid, viewerFlag),
        };
    }
}

class AlgorithmSetHandler extends Handler {
    // 无 @param/@query 装饰器：框架不会注入 domainId，用户查询统一用空域（与奖章一致）。
    // 整份面板一次提交：学生每次提交消耗当月唯一额度，老师不受限。
    async post() {
        const body = this.request.body as any;
        const uid = Number(field(body, 'uid'));
        if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidationError('用户 UID 无效。');
        if (!(await UserModel.getById('', uid))) throw new NotFoundError(uid);
        const { viewerUid, isSelf, isTeacher } = await resolveViewer(this, uid);
        if (!isSelf && !isTeacher) throw new ForbiddenError('算法掌握面板仅本人和老师可见。');

        const quotaApplies = isSelf && !isTeacher;
        if (quotaApplies) {
            const config = await oi33Model.algorithmGetConfig();
            if (!config.selfEdit) throw new ForbiddenError('管理员已关闭学生自评，请联系老师为你设置。');
        }

        // One `lv_<idx>` select plus its `id_<idx>` (item id) and `orig_<idx>`
        // (value rendered on the page) hidden fields per item; indices are
        // assigned by the profile view.
        const entries: Array<{ itemId: string; level: unknown; original?: unknown }> = [];
        for (const key of Object.keys(body || {})) {
            const match = /^lv_(\d+)$/.exec(key);
            if (!match) continue;
            const id = field(body, `id_${match[1]}`);
            if (!id) continue;
            const origKey = `orig_${match[1]}`;
            entries.push({
                itemId: id,
                level: field(body, key),
                ...(Object.prototype.hasOwnProperty.call(body, origKey)
                    ? { original: field(body, origKey) }
                    : {}),
            });
        }
        if (!entries.length) throw new ValidationError('没有要提交的掌握程度。');

        // Claim the month first (atomic), then write; roll the claim back if
        // the write fails or nothing actually changed, so a failed or no-op
        // submit never burns the student's only chance this month.
        const month = oi33Model.algorithmMonthKey();
        let claimed = false;
        if (quotaApplies) {
            claimed = await oi33Model.algorithmClaimSelfQuota(uid, month);
            if (!claimed) {
                const quota = await oi33Model.algorithmGetSelfQuota(uid);
                throw new ForbiddenError(`本月自评已提交，下次可更新：${quota.nextUpdateAt}。`);
            }
        }
        let result;
        try {
            result = await oi33Model.algorithmSetLevels(uid, entries, viewerUid, { onlyChanges: true });
        } catch (e) {
            if (claimed) await oi33Model.algorithmReleaseSelfQuota(uid, month);
            throw e;
        }

        const fallback = this.url('oi33_algorithm_user', { uid });
        const target = safeRedirect(field(body, 'redirect'), fallback);
        if (quotaApplies && result.updated + result.cleared === 0) {
            await oi33Model.algorithmReleaseSelfQuota(uid, month);
            this.response.redirect = withNotification(target, '没有检测到改动，未消耗本月自评额度');
            return;
        }
        const parts = [`已保存 ${result.updated} 项掌握程度`];
        if (result.cleared) parts.push(`清除 ${result.cleared} 项评定`);
        if (result.unchanged) parts.push(`${result.unchanged} 项未改动`);
        if (result.skipped.length) parts.push(`${result.skipped.length} 项无效已跳过`);
        if (quotaApplies) parts.push(`下次可更新 ${oi33Model.algorithmNextUpdateDate()}`);
        this.response.redirect = withNotification(target, parts.join('；'));
    }
}

// Teacher-only: give one student this month's self-assessment submit back.
class AlgorithmResetMonthHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const uid = Number(field(body, 'uid'));
        if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidationError('用户 UID 无效。');
        if (!(await UserModel.getById('', uid))) throw new NotFoundError(uid);
        await oi33Model.algorithmResetSelfQuota(uid, this.user._id);
        const fallback = this.url('oi33_algorithm_user', { uid });
        const target = safeRedirect(field(body, 'redirect'), fallback);
        this.response.redirect = withNotification(target, '已重置该学生本月的自评额度');
    }
}

// --- Administration ---

class AlgorithmManageHandler extends Handler {
    @query('edit', Types.String, true)
    async get(domainId: string, edit = '') {
        await checkOi33Admin(this.user._id);
        const [items, config] = await Promise.all([
            oi33Model.algorithmListItems(),
            oi33Model.algorithmGetConfig(),
        ]);
        const editing = edit ? await oi33Model.algorithmGetItem(edit) : null;
        if (edit && !editing) throw new NotFoundError(edit);
        const maxOrder = items.reduce((max, item) => Math.max(max, Number(item.order) || 0), 0);
        this.response.template = 'oi33_algorithm_manage.html';
        this.response.body = {
            groups: oi33Model.algorithmGroupItems(items),
            editing,
            config,
            meta: oi33Model.algorithmOutlineMeta(),
            stats: {
                total: items.length,
                enabled: items.filter((item) => item.enabled !== false).length,
            },
            levelNames: [...new Set(items.map((item) => item.levelName).filter(Boolean))],
            sectionNames: [...new Set(items.map((item) => item.sectionName).filter(Boolean))],
            subsectionNames: [...new Set(items.map((item) => item.subsectionName).filter(Boolean))],
            nextOrder: Math.floor(maxOrder) + 1,
            maxDifficulty: 10,
        };
    }
}

class AlgorithmItemSaveHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const item = await oi33Model.algorithmSaveItem({
            id: field(body, 'id') || undefined,
            text: field(body, 'text'),
            note: field(body, 'note'),
            levelName: field(body, 'levelName'),
            sectionName: field(body, 'sectionName'),
            subsectionName: field(body, 'subsectionName'),
            difficulty: field(body, 'difficulty'),
            order: field(body, 'order'),
            enabled: checked(body, 'enabled'),
        }, this.user._id);
        this.response.redirect = this.url('oi33_algorithm_manage', {
            query: { notification: `已保存算法项目「${item.text}」` },
        });
    }
}

class AlgorithmItemDeleteHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const id = field(this.request.body as any, 'id');
        if (!id) throw new ValidationError('缺少要删除的算法项目。');
        if (!(await oi33Model.algorithmDeleteItem(id, this.user._id))) throw new NotFoundError(id);
        this.response.redirect = this.url('oi33_algorithm_manage', {
            query: { notification: '算法项目已删除' },
        });
    }
}

class AlgorithmItemToggleHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const id = field(body, 'id');
        const enabled = checked(body, 'enabled');
        if (!id) throw new ValidationError('缺少算法项目。');
        if (!(await oi33Model.algorithmSetItemEnabled(id, enabled, this.user._id))) {
            throw new NotFoundError(id);
        }
        this.response.redirect = this.url('oi33_algorithm_manage', {
            query: { notification: enabled ? '算法项目已启用' : '算法项目已停用' },
        });
    }
}

class AlgorithmBulkHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const levelId = field(body, 'levelId');
        const sectionId = field(body, 'sectionId');
        const enabled = checked(body, 'enabled');
        const count = await oi33Model.algorithmBulkSetEnabled(
            { levelId: levelId || undefined, sectionId: sectionId || undefined },
            enabled, this.user._id,
        );
        this.response.redirect = this.url('oi33_algorithm_manage', {
            query: { notification: `${enabled ? '已启用' : '已停用'} ${count} 个算法项目` },
        });
    }
}

class AlgorithmImportHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const overwrite = checked(this.request.body as any, 'overwrite');
        const result = await oi33Model.algorithmImportOutline(this.user._id, { overwrite });
        const notification = `NOI 大纲（${result.edition}）导入完成：新增 ${result.inserted} 项，`
            + `更新 ${result.updated} 项，跳过 ${result.skipped} 项，共 ${result.total} 项。`;
        this.response.redirect = this.url('oi33_algorithm_manage', { query: { notification } });
    }
}

class AlgorithmConfigHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        await oi33Model.algorithmSaveConfig(
            { selfEdit: checked(this.request.body as any, 'selfEdit') }, this.user._id,
        );
        this.response.redirect = this.url('oi33_algorithm_manage', {
            query: { notification: '算法掌握设置已保存' },
        });
    }
}

// Attach the mastery panel to the profile page for the owner and for teachers
// (OI33 flag >= 2). Everyone else never sees the tab.
function registerAlgorithmPanel(ctx: Context) {
    ctx.on('handler/after/UserDetail', async (h: any) => {
        try {
            const body = h.response?.body;
            const uid = Number(body?.udoc?._id);
            if (!Number.isSafeInteger(uid) || uid <= 0) return;
            const viewerUid = Number(h.user?._id) || 0;
            const viewerFlag = viewerUid ? await checkUserFlag(viewerUid) : 0;
            if (viewerUid !== uid && viewerFlag < 2) return;
            body.oi33AlgorithmPanel = await buildAlgorithmPanel(uid, viewerUid, viewerFlag);
        } catch (e) {
            console.error('[oi33] algorithm profile panel failed:', e);
        }
    });
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_algorithm', '/oi33/algorithm', AlgorithmIndexHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_algorithm_user', '/oi33/algorithm/user/:uid', AlgorithmUserHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_algorithm_set', '/oi33/algorithm/set', AlgorithmSetHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_algorithm_reset_month', '/oi33/algorithm/reset-month', AlgorithmResetMonthHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_algorithm_manage', '/oi33/algorithm/manage', AlgorithmManageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_algorithm_item_save', '/oi33/algorithm/manage/save', AlgorithmItemSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_algorithm_item_delete', '/oi33/algorithm/manage/delete', AlgorithmItemDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_algorithm_item_toggle', '/oi33/algorithm/manage/toggle', AlgorithmItemToggleHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_algorithm_bulk', '/oi33/algorithm/manage/bulk', AlgorithmBulkHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_algorithm_import', '/oi33/algorithm/manage/import', AlgorithmImportHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_algorithm_config', '/oi33/algorithm/manage/config', AlgorithmConfigHandler, PRIV.PRIV_USER_PROFILE);
    registerAlgorithmPanel(ctx);
}
