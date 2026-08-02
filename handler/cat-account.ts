import {
    Context, ForbiddenError, Handler, NotFoundError, PRIV, Types, UserModel, param, query,
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
        const anonymousUid = /^UID\s+(\d+)$/i.exec(uidOrName.trim());
        const lookup = anonymousUid ? anonymousUid[1] : uidOrName.trim();
        const udoc = await UserModel.getById(domainId, +lookup)
            || await UserModel.getByUname(domainId, lookup)
            || await UserModel.getByEmail(domainId, lookup);
        if (!udoc) throw new NotFoundError(lookup);
        let result: Awaited<ReturnType<typeof oi33Model.grantCatFood>>;
        try {
            result = await oi33Model.grantCatFood(
                udoc._id, this.user._id, amount, reason.trim(), amount < 0 ? 'deduct' : 'grant',
            );
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '猫粮调整失败。');
        }
        const notification = amount < 0
            ? `已从 UID ${udoc._id} 扣除 ${oi33Model.formatCatFood(-amount)}，当前余额 ${oi33Model.formatCatFood(result.balance)}`
            : `已向 UID ${udoc._id} 发放 ${oi33Model.formatCatFood(amount)}，当前余额 ${oi33Model.formatCatFood(result.balance)}`;
        this.response.redirect = this.url('oi33_cat_account', { uid: udoc._id, query: { notification } });
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
        const preview = await oi33Model.createCatFoodBatchPreview(this.user._id, items);
        const rows = items.map((item) => ({
            ...item,
            displayName: (udict[item.uid] as any)?.oi33_original_uname || udict[item.uid]?.uname || `UID ${item.uid}`,
        }));
        this.response.template = 'oi33_cat_food_bulk.html';
        this.response.body = {
            preview, rows, jsonText,
            total: items.reduce((sum, item) => sum + item.amount, 0),
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
            const notification = `批量发放完成：${result.users} 位用户，共 ${oi33Model.formatCatFood(result.total)}`;
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
    ctx.Route('oi33_cat_food_bulk', '/oi33/cat-food/grant/bulk', CatFoodBulkGrantHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_food_bulk_confirm', '/oi33/cat-food/grant/bulk/confirm', CatFoodBulkConfirmHandler, PRIV.PRIV_USER_PROFILE);
}
