import {
    Context, Handler, NotFoundError, ObjectId, PRIV, Types, ValidationError, param, query,
} from 'hydrooj';
import { oi33Model } from '../model';
import { checkOi33Admin } from './utils';

// 盲盒奖章：管理员在一组奖章上设置开放时间、价格与每个奖章的出现几率（整数，
// 总和 100）；用户每次购买按几率获得其中一个，每天最多购买 3 次（跨组共用额度）。
// 纯规则与存储在 model/blindbox-rules.ts 与 model/blindbox.ts。

// 表单字段转成字符串（同名多值时取第一个），空值统一成 ''。
function fieldText(body: any, name: string): string {
    const value = body?.[name];
    return String(Array.isArray(value) ? value[0] : value ?? '').trim();
}

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
    // 编辑旧盲盒时，池子里可能还引用着已经不能放进盲盒的奖章（规则收紧前创建的）。
    // 这些奖章也必须出现在下拉框里并保持选中，否则页面看起来像「没有预填充」，
    // 一保存还会把这一行静默丢掉；管理员可以在此基础上替换成当前允许的奖章。
    const referenced = new Set<string>(
        (editing?.items || []).map((item: any) => String(item.medalId)),
    );
    const candidates = medals.filter((medal: any) => (
        !oi33Model.blindboxMedalIssue(medal) || referenced.has(String(medal._id))
    ));
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
        // `@query` 正常会注入 edit；这里再从原始 query 兜一层，避免装饰器/框架
        // 版本差异导致 ?edit=... 被丢掉时页面悄悄退回空白新建表单。
        const rawEdit = (this.request as any)?.query?.edit;
        this.response.template = 'oi33_blindbox_manage.html';
        this.response.body = await buildManageView(String(edit || rawEdit || ''));
    }
}

// 编辑页专用路由：id 放在路径里（/oi33/blindbox/manage/:id），不依赖查询串。
// 旧链接 ?edit=<id> 仍然保留，但页面内的「编辑」按钮走这条更稳的路。
class BlindboxEditHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        await checkOi33Admin(this.user._id);
        this.response.template = 'oi33_blindbox_manage.html';
        this.response.body = await buildManageView(String(id || ''));
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
        // 看起来像是「设置丢了」。id 用 field() 读取（表单值可能是数组），并且
        // 只要页面处于编辑态就要求解析出有效 id：绝不能在 id 丢失时静默新建一份。
        const submittedId = fieldText(body, 'id');
        const parsedId = submittedId ? oi33Model.toBlindboxId(submittedId) : null;
        const editing = fieldText(body, 'editing') === '1';
        if (submittedId && !parsedId) throw new ValidationError('盲盒不存在或已删除。');
        if (editing && !parsedId) throw new ValidationError('盲盒不存在或已删除。');
        const editId = parsedId ? parsedId.toHexString() : '';
        try {
            await oi33Model.blindboxSave({
                id: editId,
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
        this.response.redirect = editId
            ? this.url('oi33_blindbox_edit', { id: editId, query: { notification: '盲盒已保存。' } })
            : this.url('oi33_blindbox_manage', { query: { notification: '盲盒已创建。' } });
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
    // 放在 :id/toggle、:id/delete 之前，路径里的 manage/:id 不会与它们混淆。
    ctx.Route('oi33_blindbox_edit', '/oi33/blindbox/manage/:id', BlindboxEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_blindbox_save', '/oi33/blindbox/save', BlindboxSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_blindbox_toggle', '/oi33/blindbox/:id/toggle', BlindboxToggleHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_blindbox_delete', '/oi33/blindbox/:id/delete', BlindboxDeleteHandler, PRIV.PRIV_USER_PROFILE);
}
