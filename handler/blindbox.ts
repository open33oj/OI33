import {
    Context, Handler, NotFoundError, ObjectId, PRIV, Types, ValidationError, param, query,
} from 'hydrooj';
import { oi33Model } from '../model';
import { checkOi33Admin } from './utils';

// 盲盒奖章：管理员在一组奖章上设置开放时间、价格与每个奖章的出现几率（整数，
// 总和 100）；用户每次购买按几率获得其中一个，每天最多购买 3 次（跨组共用额度）。
// 纯规则与存储在 model/blindbox-rules.ts 与 model/blindbox.ts。

function buyNotification(name: string, medal: string, copies: number, stars: number, remaining: number) {
    const upgrade = copies > 1 ? `（第 ${copies} 枚，★${stars}）` : '';
    return `盲盒「${name}」开出了奖章「${medal}」${upgrade}，今天还可以购买 ${remaining} 次。`;
}

// 表单值：优先用管理员刚提交的内容（校验失败时回填），否则用被编辑的盲盒。
function manageForm(editing: any, submitted: any) {
    if (submitted) return submitted;
    if (!editing) {
        return {
            id: '', name: '', price: '', openAt: '', enabled: true, items: [],
        };
    }
    return {
        id: String(editing._id),
        name: editing.name,
        price: String(editing.price),
        openAt: oi33Model.blindboxOpenAtInputValue(new Date(editing.openAt)),
        enabled: !!editing.enabled,
        items: editing.items || [],
    };
}

// 编辑链接带的是纯字符串 id（`blindboxList()` 里的 `id` 字段），这里再解析成
// ObjectId 直接取文档：不依赖列表查询，编辑态与列表分页 / 排序无关。
async function buildManageView(editId: string, extra: Record<string, any> = {}) {
    const editObjectId = editId ? oi33Model.toBlindboxId(editId) : null;
    if (editId && !editObjectId) throw new NotFoundError(editId);
    const [pools, medals, editing] = await Promise.all([
        oi33Model.blindboxList(),
        oi33Model.medalList(),
        editObjectId ? oi33Model.blindboxGet(editObjectId) : Promise.resolve(null),
    ]);
    if (editId && !editing) throw new NotFoundError(editId);
    const candidates = medals.filter((medal: any) => !oi33Model.blindboxMedalIssue(medal));
    return {
        pools,
        candidates,
        editing,
        form: manageForm(editing, extra.submitted),
        rowCount: oi33Model.BLINDBOX_MAX_ITEMS,
        priceMax: oi33Model.BLINDBOX_PRICE_MAX,
        dailyLimit: oi33Model.BLINDBOX_DAILY_LIMIT,
        ...(extra.error ? { error: extra.error } : {}),
    };
}

// 右侧只列最近 RECENT_LIMIT 条，更多走 /oi33/blindbox/logs 的分页页。
const RECENT_LIMIT = 10;

class BlindboxHandler extends Handler {
    async get() {
        const [view, logs] = await Promise.all([
            oi33Model.blindboxOverview(this.user._id),
            oi33Model.blindboxLogs(this.user._id, RECENT_LIMIT),
        ]);
        this.response.template = 'oi33_blindbox.html';
        this.response.body = {
            pools: view.pools,
            used: view.used,
            remaining: view.remaining,
            dailyLimit: oi33Model.BLINDBOX_DAILY_LIMIT,
            catCan: view.catCan,
            logs,
        };
    }
}

class BlindboxLogsHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const result = await oi33Model.blindboxLogPage(this.user._id, page);
        const [view] = await Promise.all([oi33Model.blindboxOverview(this.user._id)]);
        this.response.template = 'oi33_blindbox_logs.html';
        this.response.body = {
            ...result,
            dailyLimit: oi33Model.BLINDBOX_DAILY_LIMIT,
            catCan: view.catCan,
            remaining: view.remaining,
        };
    }
}

class BlindboxBuyHandler extends Handler {
    @param('poolId', Types.ObjectId)
    async post(domainId: string, poolId: ObjectId) {
        const result = await oi33Model.blindboxPurchase(this.user._id, poolId);
        const medal = await oi33Model.medalGet(result.medalId);
        this.response.redirect = this.url('oi33_blindbox', {
            query: {
                notification: buyNotification(
                    result.poolName, medal?.name || result.medalId, result.copies, result.stars, result.remaining,
                ),
            },
        });
    }
}

class BlindboxManageHandler extends Handler {
    @query('edit', Types.String, true)
    async get(domainId: string, edit = '') {
        await checkOi33Admin(this.user._id);
        this.response.template = 'oi33_blindbox_manage.html';
        this.response.body = await buildManageView(String(edit || ''));
    }
}

class BlindboxSaveHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body: any = this.request.body || {};
        const items = [];
        for (let index = 0; index < oi33Model.BLINDBOX_MAX_ITEMS; index++) {
            items.push({
                medalId: body[`medalId_${index}`],
                probability: body[`probability_${index}`],
            });
        }
        // 编辑既有盲盒时保存后仍回到它的编辑态，否则页面会退回空白的新建表单，
        // 看起来像是「设置丢了」。
        const submittedId = String(body.id || '').trim();
        const editId = submittedId && oi33Model.toBlindboxId(submittedId) ? submittedId : '';
        try {
            await oi33Model.blindboxSave({
                id: body.id,
                name: body.name,
                price: body.price,
                openAt: body.openAt,
                items,
                enabled: !!body.enabled,
            }, this.user._id);
        } catch (e: any) {
            if (!(e instanceof ValidationError)) throw e;
            this.response.template = 'oi33_blindbox_manage.html';
            const submitted = {
                id: editId,
                name: String(body.name || ''),
                price: String(body.price || ''),
                openAt: String(body.openAt || ''),
                enabled: !!body.enabled,
                items: oi33Model.normalizeBlindboxItems(items),
            };
            try {
                this.response.body = await buildManageView(editId, { error: e.message, submitted });
            } catch {
                // 被编辑的盲盒在提交后已被删除：退化成新建表单，至少把报错和输入回填出来。
                this.response.body = await buildManageView('', { error: e.message, submitted });
            }
            return;
        }
        this.response.redirect = this.url('oi33_blindbox_manage', {
            query: editId ? { edit: editId, notification: '盲盒已保存。' } : { notification: '盲盒已创建。' },
        });
    }
}

class BlindboxToggleHandler extends Handler {
    @param('id', Types.ObjectId)
    @param('enabled', Types.Int)
    async post(domainId: string, id: ObjectId, enabled: number) {
        await checkOi33Admin(this.user._id);
        await oi33Model.blindboxSetEnabled(id, !!enabled, this.user._id);
        this.response.redirect = this.url('oi33_blindbox_manage', {
            query: { notification: enabled ? '盲盒已上架。' : '盲盒已下架。' },
        });
    }
}

class BlindboxDeleteHandler extends Handler {
    @param('id', Types.ObjectId)
    async post(domainId: string, id: ObjectId) {
        await checkOi33Admin(this.user._id);
        await oi33Model.blindboxDelete(id, this.user._id);
        this.response.redirect = this.url('oi33_blindbox_manage', {
            query: { notification: '盲盒已删除（既有购买记录保留）。' },
        });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_blindbox', '/oi33/blindbox', BlindboxHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_blindbox_buy', '/oi33/blindbox/buy', BlindboxBuyHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_blindbox_logs', '/oi33/blindbox/logs', BlindboxLogsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_blindbox_manage', '/oi33/blindbox/manage', BlindboxManageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_blindbox_save', '/oi33/blindbox/save', BlindboxSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_blindbox_toggle', '/oi33/blindbox/:id/toggle', BlindboxToggleHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_blindbox_delete', '/oi33/blindbox/:id/delete', BlindboxDeleteHandler, PRIV.PRIV_USER_PROFILE);
}
