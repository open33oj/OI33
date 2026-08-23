import {
    Context, ContestModel, ForbiddenError, Handler, NotFoundError, ObjectId, PRIV, Types, UserModel, param, query,
} from 'hydrooj';
import { oi33Model } from '../model';
import { checkOi33Admin, checkUserFlag } from './utils';

const MAX_BATCH_ITEMS = 200;
const MAX_GRANT_AMOUNT = 1_000_000_000;

function parseBatchJson(text: string) {
    let raw: any;
    try { raw = JSON.parse(text); } catch { throw new ForbiddenError('JSON 格式不正确。'); }
    if (!Array.isArray(raw) || !raw.length) throw new ForbiddenError('JSON 必须是非空数组。');
    if (raw.length > MAX_BATCH_ITEMS) throw new ForbiddenError(`一次最多发放 ${MAX_BATCH_ITEMS} 位用户。`);
    const seen = new Set<number>();
    return raw.map((item, index) => {
        const uid = Number(item?.uid);
        const amount = Number(item?.amount);
        const reason = String(item?.reason || '批量发放猫粮').trim();
        if (!Number.isSafeInteger(uid) || uid <= 0) throw new ForbiddenError(`第 ${index + 1} 项 uid 无效。`);
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_GRANT_AMOUNT) {
            throw new ForbiddenError(`第 ${index + 1} 项 amount 必须是 1～${MAX_GRANT_AMOUNT} 的整数。`);
        }
        if (!reason || reason.length > 100) throw new ForbiddenError(`第 ${index + 1} 项 reason 不能为空且不能超过 100 字。`);
        if (seen.has(uid)) throw new ForbiddenError(`UID ${uid} 重复出现，请合并为一项。`);
        seen.add(uid);
        return { uid, amount, reason };
    });
}

async function resolveAccountTarget(domainId: string, uidOrName: string) {
    const anonymousUid = /^UID\s+(\d+)$/i.exec(uidOrName.trim());
    const lookup = anonymousUid ? anonymousUid[1] : uidOrName.trim();
    const udoc = await UserModel.getById(domainId, +lookup)
        || await UserModel.getByUname(domainId, lookup)
        || await UserModel.getByEmail(domainId, lookup);
    if (!udoc) throw new NotFoundError(lookup);
    return udoc;
}

class CatAccountHandler extends Handler {
    @param('uid', Types.Int)
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, uid: number, page = 1) {
        const viewerRole = uid === this.user._id
            ? await checkUserFlag(this.user._id)
            : await checkOi33Admin(this.user._id);
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new NotFoundError(String(uid));
        const data = await oi33Model.getCatAccountPage(uid, page);
        this.response.template = 'oi33_cat_account.html';
        this.response.body = { ...data, uid, udoc, page, canManage: viewerRole >= 2, canBatchGrant: viewerRole >= 3 };
    }
}

class CatFoodGrantHandler extends Handler {
    async get() {
        const role = await checkOi33Admin(this.user._id);
        this.response.template = 'oi33_cat_food_grant.html';
        this.response.body = { canBatchGrant: role >= 3 };
    }

    @param('uidOrName', Types.UidOrName)
    @param('amount', Types.Int)
    @param('reason', Types.String)
    async post(domainId: string, uidOrName: string, amount: number, reason: string) {
        await checkOi33Admin(this.user._id);
        if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > MAX_GRANT_AMOUNT) {
            throw new ForbiddenError(`调整数量必须是 -${MAX_GRANT_AMOUNT}～-1 或 1～${MAX_GRANT_AMOUNT} 的整数。`);
        }
        if (!reason.trim() || reason.trim().length > 100) throw new ForbiddenError('调整原因不能为空且不能超过 100 字。');
        const udoc = await resolveAccountTarget(domainId, uidOrName);
        let result: Awaited<ReturnType<typeof oi33Model.grantCatFood>>;
        try {
            result = await oi33Model.grantCatFood(
                udoc._id, this.user._id, amount, reason.trim(), amount < 0 ? 'deduct' : 'grant',
            );
            if (amount > 0) {
                await oi33Model.achievementEvaluateUser(udoc._id, {
                    ruleTypes: ['cat_food_balance'],
                }).catch((e) => console.error('[oi33] cat-food achievement evaluation failed:', e));
            }
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '猫粮调整失败。');
        }
        const notification = amount < 0
            ? `已从 UID ${udoc._id} 扣除 ${oi33Model.formatCatFood(-amount)}，当前余额 ${oi33Model.formatCatFood(result.balance)}`
            : `已向 UID ${udoc._id} 发放 ${oi33Model.formatCatFood(amount)}，当前余额 ${oi33Model.formatCatFood(result.balance)}`;
        this.response.redirect = this.url('oi33_cat_account', { uid: udoc._id, query: { notification } });
    }
}

class CatCanGrantHandler extends Handler {
    async get() {
        const role = await checkOi33Admin(this.user._id);
        this.response.template = 'oi33_cat_food_grant.html';
        this.response.body = { canBatchGrant: role >= 3 };
    }

    @param('canUidOrName', Types.UidOrName)
    @param('canAmount', Types.Int)
    @param('canReason', Types.String)
    async post(domainId: string, canUidOrName: string, canAmount: number, canReason: string) {
        await checkOi33Admin(this.user._id);
        const udoc = await resolveAccountTarget(domainId, canUidOrName);
        try {
            const result = await oi33Model.adjustCatCans(
                udoc._id, this.user._id, canAmount, canReason,
            );
            if (canAmount > 0) {
                await oi33Model.achievementEvaluateUser(udoc._id, {
                    ruleTypes: ['cat_can_balance'],
                }).catch((e) => console.error('[oi33] cat-can achievement evaluation failed:', e));
            }
            const notification = canAmount < 0
                ? `已从 UID ${udoc._id} 扣除 ${-canAmount} 个猫罐头，当前余额 ${result.balance} 个`
                : `已向 UID ${udoc._id} 发放 ${canAmount} 个猫罐头，当前余额 ${result.balance} 个`;
            this.response.redirect = this.url('oi33_cat_account', { uid: udoc._id, query: { notification } });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '猫罐头调整失败。');
        }
    }
}

const CONTEST_URL_RE = /(?:\/d\/([\w-]+))?\/(?:contest|homework)\/([0-9a-fA-F]{24})(?:[/?#]|$)/;

// Accepts a contest/homework page URL (with or without /d/<domain> prefix) or a bare tid.
function parseContestInput(input: string): { domainId?: string, tid: string } {
    const text = input.trim();
    const bare = /^([0-9a-fA-F]{24})$/.exec(text);
    if (bare) return { tid: bare[1] };
    const matched = CONTEST_URL_RE.exec(text);
    if (matched) return { domainId: matched[1], tid: matched[2] };
    throw new ForbiddenError('无法识别的比赛链接，请粘贴比赛页面 URL 或比赛 ID。');
}

// Contest reward settlement: read a contest's scoreboard and generate the JSON
// for the bulk cat-food grant page. This page never touches any balance.
class CatFoodContestRewardHandler extends Handler {
    async get() {
        const role = await checkOi33Admin(this.user._id);
        this.response.template = 'oi33_cat_food_contest_reward.html';
        this.response.body = { canBatchGrant: role >= 3 };
    }

    @param('contestUrl', Types.String)
    @param('multiplier', Types.Float)
    @param('reason', Types.String, true)
    async post(domainId: string, contestUrl: string, multiplier: number, reason = '') {
        const role = await checkOi33Admin(this.user._id);
        if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1_000_000) {
            throw new ForbiddenError('分数倍率必须是 0～1000000 之间的正数。');
        }
        const reasonInput = reason.trim();
        if (reasonInput.length > 100) throw new ForbiddenError('发放原因不能超过 100 字。');
        const parsed = parseContestInput(contestUrl);
        const tdoc = await ContestModel.get(parsed.domainId || domainId, new ObjectId(parsed.tid));
        const tsdocs = await ContestModel.getMultiStatus(
            parsed.domainId || domainId, { docId: tdoc.docId, attend: 1 },
        ).toArray();
        const grantReason = reasonInput || `《${tdoc.title}》比赛奖励`.slice(0, 100);
        const rows: any[] = tsdocs
            .filter((tsdoc: any) => (tsdoc.score || 0) > 0)
            .map((tsdoc: any) => ({
                uid: tsdoc.uid,
                score: tsdoc.score || 0,
                amount: Math.round((tsdoc.score || 0) * multiplier),
            }))
            .filter((row) => row.amount >= 1)
            .sort((a, b) => b.score - a.score || a.uid - b.uid);
        if (!rows.length) throw new ForbiddenError('该比赛没有可结算的正分参赛记录。');
        if (rows.length > MAX_BATCH_ITEMS) {
            throw new ForbiddenError(`正分参赛者超过批量发放上限 ${MAX_BATCH_ITEMS} 人，请先缩小范围。`);
        }
        if (rows.some((row) => row.amount > MAX_GRANT_AMOUNT)) {
            throw new ForbiddenError('结算金额超出单次发放上限，请降低分数倍率。');
        }
        const udict = await UserModel.getList(domainId, rows.map((row) => row.uid));
        for (const row of rows) {
            row.displayName = (udict[row.uid] as any)?.oi33_original_uname
                || udict[row.uid]?.uname || `UID ${row.uid}`;
        }
        const jsonText = JSON.stringify(
            rows.map((row) => ({ uid: row.uid, amount: row.amount, reason: grantReason })), null, 2,
        );
        this.response.template = 'oi33_cat_food_contest_reward.html';
        this.response.body = {
            canBatchGrant: role >= 3,
            tdoc,
            rows,
            jsonText,
            grantReason,
            contestUrl,
            multiplier,
            reasonInput,
            total: rows.reduce((sum, row) => sum + row.amount, 0),
        };
    }
}

class CatFoodBulkGrantHandler extends Handler {
    async get() {
        const role = await checkOi33Admin(this.user._id);
        if (role < 3) throw new ForbiddenError('仅行政管理员可以批量发放猫粮。');
        this.response.template = 'oi33_cat_food_bulk.html';
        this.response.body = {};
    }

    @param('jsonText', Types.String)
    async post(domainId: string, jsonText: string) {
        const role = await checkOi33Admin(this.user._id);
        if (role < 3) throw new ForbiddenError('仅行政管理员可以批量发放猫粮。');
        const items = parseBatchJson(jsonText);
        const uids = items.map((item) => item.uid);
        const udict = await UserModel.getList(domainId, uids);
        const missing = uids.filter((uid) => !udict[uid]);
        if (missing.length) throw new ForbiddenError(`以下 UID 不存在：${missing.join('、')}`);
        const oi33Data = await oi33Model.getUserDataByUids(uids);
        const isVerified = (uid: number) => (oi33Data[uid]?.realname_flag ?? 0) >= 1;
        const eligible = items.filter((item) => isVerified(item.uid));
        const skippedRows = items.filter((item) => !isVerified(item.uid)).map((item) => ({
            ...item,
            displayName: (udict[item.uid] as any)?.oi33_original_uname || udict[item.uid]?.uname || `UID ${item.uid}`,
        }));
        if (!eligible.length) throw new ForbiddenError('名单中的所有用户都未通过认证，无法发放猫粮。');
        const preview = await oi33Model.createCatFoodBatchPreview(this.user._id, eligible);
        const rows = eligible.map((item) => ({
            ...item,
            displayName: (udict[item.uid] as any)?.oi33_original_uname || udict[item.uid]?.uname || `UID ${item.uid}`,
        }));
        this.response.template = 'oi33_cat_food_bulk.html';
        this.response.body = {
            preview, rows, skippedRows, jsonText,
            total: eligible.reduce((sum, item) => sum + item.amount, 0),
        };
    }
}

class CatFoodBulkConfirmHandler extends Handler {
    @param('previewId', Types.String)
    async post(domainId: string, previewId: string) {
        const role = await checkOi33Admin(this.user._id);
        if (role < 3) throw new ForbiddenError('仅行政管理员可以批量发放猫粮。');
        try {
            const preview = await oi33Model.getCatFoodBatchPreview(previewId, this.user._id);
            if (!preview || preview.status !== 'pending') throw new Error('该预览不存在、已确认或已失效。');
            const uids = preview.items.map((item: any) => Number(item.uid));
            const udict = await UserModel.getList(domainId, uids);
            const missing = uids.filter((uid: number) => !udict[uid]);
            if (missing.length) throw new Error(`以下 UID 已不存在：${missing.join('、')}`);
            const result = await oi33Model.confirmCatFoodBatchPreview(previewId, this.user._id);
            await Promise.all(uids.map((uid: number) => (
                oi33Model.achievementEvaluateUser(uid, {
                    ruleTypes: ['cat_food_balance'],
                }).catch((e) => console.error('[oi33] bulk cat-food achievement evaluation failed:', e))
            )));
            const notification = `批量发放完成：${result.users} 位用户，共 ${oi33Model.formatCatFood(result.total)}`
                + (result.skipped ? `；${result.skipped} 位未认证用户已自动跳过` : '');
            this.response.redirect = this.url('oi33_cat_food_bulk', { query: { notification } });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '批量发放失败。');
        }
    }
}

class CatCanReverseHandler extends Handler {
    @param('id', Types.String)
    @param('reason', Types.String)
    async post(domainId: string, id: string, reason: string) {
        await checkOi33Admin(this.user._id);
        if (!reason.trim() || reason.trim().length > 100) throw new ForbiddenError('撤销原因不能为空且不能超过 100 字。');
        try {
            const result = await oi33Model.reverseCatCanTransaction(id, this.user._id, reason.trim());
            await oi33Model.achievementEvaluateUser(result.uid, {
                ruleTypes: ['cat_food_balance', 'cat_can_balance'],
            }).catch((e) => console.error('[oi33] reversal achievement evaluation failed:', e));
            const notification = `交易已撤销：猫粮 ${result.foodDelta >= 0 ? '+' : ''}${oi33Model.formatCatFood(result.foodDelta)}，罐头 ${result.canDelta >= 0 ? '+' : ''}${result.canDelta} 个`;
            this.response.redirect = this.url('oi33_cat_account', { uid: result.uid, query: { notification } });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '撤销交易失败。');
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_cat_can_reverse', '/oi33/cat-account/transaction/:id/reverse', CatCanReverseHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_account', '/oi33/cat-account/:uid', CatAccountHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_food_grant', '/oi33/cat-food/grant', CatFoodGrantHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_food_contest_reward', '/oi33/cat-food/grant/contest-reward', CatFoodContestRewardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_can_grant', '/oi33/cat-can/grant', CatCanGrantHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_food_bulk', '/oi33/cat-food/grant/bulk', CatFoodBulkGrantHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_food_bulk_confirm', '/oi33/cat-food/grant/bulk/confirm', CatFoodBulkConfirmHandler, PRIV.PRIV_USER_PROFILE);
}
