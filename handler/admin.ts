import { Handler, PRIV, Types, query, param, Context, UserModel, ObjectId, UserAlreadyExistError, UserNotFoundError, ForbiddenError, ValidationError, BlackListModel, db } from 'hydrooj';
import Schema from 'schemastery';
import { oi33Model } from '../model';
import { addLog } from '../model/log';
import { migrate, previewMigration } from '../migrate';
import { runUpdateRatings } from '../scripts/update-ratings';
import { runFixLuoguDifficulty } from '../scripts/fix-luogu-difficulty';
import { checkOi33Admin, checkUserFlag } from './utils';

// --- Admin dashboard ---

class Oi33AdminHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('type', Types.String, true)
    async get(domainId: string, page = 1, type = '') {
        await checkOi33Admin(this.user._id);
        await oi33Model.compactRequestLogs();
        const { activities, tpcount } = await oi33Model.getRecentActivitiesPaginated(page, 30, type);
        const pendingCount = await oi33Model.getPendingRequestCount();
        const uidSet = new Set<number>();
        const reqIdSet = new Set<string>();
        for (const a of activities) {
            (a as any).timestamp = (a as any).createdAt instanceof Date
                ? (a as any).createdAt
                : a._id instanceof Date ? a._id : new ObjectId(a._id as any).getTimestamp();
            for (const k of ['sender', 'receiver', 'userId', 'owner', 'requester', 'uid'] as const) {
                const v = a[k];
                if (typeof v === 'number') uidSet.add(v);
            }
            if (a.type === 'request' && a.reqId) reqIdSet.add(a.reqId);
        }
        const [udict, reqDict] = await Promise.all([
            uidSet.size ? UserModel.getList(domainId, Array.from(uidSet)) : {},
            oi33Model.getRequestsByIds(Array.from(reqIdSet)),
        ]);
        this.response.template = 'oi33_admin.html';
        this.response.body = {
            activities, pendingCount, page, tpcount, udict, reqDict, logType: type,
            meowPendingCount: await oi33Model.meowListPending().then((l) => l.length),
            modPendingCount: await oi33Model.modListPending().then((l) => l.length),
        };
    }
}

// --- Admin user creation ---

class AdminUserCreateHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        this.response.template = 'oi33_user_create.html';
    }

    @param('uname', Types.Username)
    @param('password', Types.Password)
    @param('mail', Types.Email)
    async post(domainId: string, uname: string, password: string, mail: string) {
        await checkOi33Admin(this.user._id);
        if (await UserModel.getByUname('system', uname)) throw new UserAlreadyExistError(uname);
        if (await UserModel.getByEmail('system', mail)) throw new UserAlreadyExistError(mail);
        const uid = await UserModel.create(mail, uname, password, undefined, this.request.ip);
        await addLog({
            type: 'admin',
            sender: this.user._id,
            userId: uid,
            action: 'create_user',
        });
        this.response.redirect = this.url('oi33_admin', {
            query: { notification: `用户 ${uname}（UID ${uid}）创建成功。` },
        });
    }
}

// --- Admin password reset ---

class AdminUserPasswordHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        this.response.template = 'oi33_user_password.html';
    }

    @param('target', Types.String)
    @param('password', Types.Password)
    async post(domainId: string, target: string, password: string) {
        const flag = await checkOi33Admin(this.user._id);
        const trimmed = target.trim();
        const uid = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
        const udoc = Number.isFinite(uid)
            ? await UserModel.getById('system', uid)
            : await UserModel.getByUname('system', trimmed);
        if (!udoc) throw new UserNotFoundError(trimmed);
        // 管理员 (flag 2) 只能重置普通用户（含未认证/已认证）的密码；
        // 行政管理员 (flag 3) 不受限。与 profile 编辑的身份层级规则一致。
        // Hydro 超级管理员 (PRIV_ALL) 同样不允许 flag 2 重置，防止绕过
        // OI33 身份体系接管超管账号。
        const targetFlag = await checkUserFlag(udoc._id);
        if (flag < 3 && (targetFlag >= 2 || udoc.hasPriv(PRIV.PRIV_ALL))) {
            throw new ForbiddenError('不能重置管理员或行政管理员的密码。');
        }
        await UserModel.setPassword(udoc._id, password);
        await addLog({
            type: 'admin',
            sender: this.user._id,
            userId: udoc._id,
            action: 'reset_password',
        });
        this.response.redirect = this.url('oi33_admin', {
            query: { notification: `已重置用户 ${udoc.uname}（UID ${udoc._id}）的密码。` },
        });
    }
}

// --- Account registration info / IP lookup (alt detection) ---
// These pages deliberately bypass the patched UserModel.getList (which
// anonymizes unverified users): OI33 admins must see the raw registration
// data (uname, mail, IPs) for every account, including unverified ones.

const hydroUserColl = db.collection<any>('user');
const ACCOUNTS_PAGE_SIZE = 50;

async function renderAccountList(h: Handler, filter: any, page: number, ip = '') {
    const [udocs, upcount] = await Promise.all([
        hydroUserColl.find(filter).sort({ _id: 1 })
            .skip((page - 1) * ACCOUNTS_PAGE_SIZE).limit(ACCOUNTS_PAGE_SIZE).toArray(),
        hydroUserColl.countDocuments(filter),
    ]);
    const oi33Dict = await oi33Model.getUserDataByUids(udocs.map((u: any) => u._id));
    for (const udoc of udocs) {
        const oi33 = oi33Dict[udoc._id];
        udoc.oi33_flag = oi33?.realname_flag ?? 0;
        udoc.oi33_realname = oi33?.realname_name || '';
    }
    h.response.template = 'oi33_accounts.html';
    h.response.body = { udocs, page, upcount, ip };
}

class AdminAccountsHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        await checkOi33Admin(this.user._id);
        await renderAccountList(this, {}, page);
    }
}

class AdminIpHandler extends Handler {
    @query('ip', Types.String)
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, ip: string, page = 1) {
        await checkOi33Admin(this.user._id);
        await renderAccountList(this, { $or: [{ ip }, { loginip: ip }] }, page, ip);
    }
}

// --- Unverified user cat-asset purge ---

class AdminCatAssetPurgeHandler extends Handler {
    async post() {
        const flag = await checkOi33Admin(this.user._id);
        if (flag < 3) throw new ForbiddenError('仅行政管理员可以清理未认证用户猫资产。');
        const result = await oi33Model.purgeUnverifiedCatAssets(this.user._id);
        for (const uid of result.removedMapUids) {
            (this.ctx as any).broadcast('oi33/cat-map-change', { type: 'remove', uid });
        }
        for (const id of result.affectedCatIds) {
            (this.ctx as any).broadcast('oi33/cat-map-change', { type: 'bigcat', cat: { id } });
        }
        this.response.redirect = this.url('oi33_admin', {
            query: {
                notification: `已清理 ${result.users} 名未认证用户：销毁猫粮 ${result.food} g，回流猫罐头 ${result.cans} 个，`
                    + `移出猫猫广场 ${result.removedMapUids.length} 人，`
                    + `清空大猫贡献 ${result.schoolContribution} g（含历史贡献 ${result.historyContribution} g）。`,
            },
        });
    }
}

// --- Mail blacklist ---
// Hydro 内核在注册、OAuth 回跳和修改邮箱时检查 blacklist 集合里的
// `mail::<domain>` 条目，但内核没有提供管理界面，这里补上。

const blacklistColl = db.collection<any>('blacklist');
const MAIL_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function normalizeMailDomain(raw: string) {
    const domain = String(raw || '').trim().toLowerCase().replace(/^@+/, '');
    if (!MAIL_DOMAIN_RE.test(domain)) throw new ValidationError('domain');
    return domain;
}

class AdminMailBlacklistHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        const rows = await blacklistColl.find({ _id: /^mail::/ }).sort({ _id: 1 }).toArray();
        this.response.template = 'oi33_mail_blacklist.html';
        this.response.body = {
            entries: rows.map((row) => ({ domain: String(row._id).slice('mail::'.length), expireAt: row.expireAt })),
        };
    }

    @param('domain', Types.String)
    async post(domainId: string, domain: string) {
        await checkOi33Admin(this.user._id);
        const normalized = normalizeMailDomain(domain);
        // 第二参数 0 = 长期有效（BlackListModel 内部转为约 83 年）。
        await BlackListModel.add(`mail::${normalized}`, 0);
        await addLog({
            type: 'admin', sender: this.user._id,
            action: 'mail_blacklist_add', reason: normalized,
        });
        this.response.redirect = this.url('oi33_admin_mail_blacklist', {
            query: { notification: `已屏蔽邮箱域名 ${normalized}，该域名将无法注册或换绑邮箱。` },
        });
    }
}

class AdminMailBlacklistDeleteHandler extends Handler {
    @param('domain', Types.String)
    async post(domainId: string, domain: string) {
        await checkOi33Admin(this.user._id);
        const normalized = normalizeMailDomain(domain);
        await BlackListModel.del(`mail::${normalized}`);
        await addLog({
            type: 'admin', sender: this.user._id,
            action: 'mail_blacklist_del', reason: normalized,
        });
        this.response.redirect = this.url('oi33_admin_mail_blacklist', {
            query: { notification: `已解除对 ${normalized} 的屏蔽。` },
        });
    }
}

// --- Migration handler ---

class MigrateHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        const preview = await previewMigration();
        this.response.template = 'oi33_migrate.html';
        this.response.body = { preview };
    }

    async post() {
        await checkOi33Admin(this.user._id);
        const action = String((this.request.body as any)?.action || 'migrate');
        if (action === 'import_achievements') {
            const [achievementImport, preview] = await Promise.all([
                oi33Model.achievementImportInitialDefinitions(this.user._id),
                previewMigration(),
            ]);
            this.response.template = 'oi33_migrate.html';
            this.response.body = { achievementImport, achievementDone: true, preview };
            return;
        }
        const result = await migrate();
        this.response.template = 'oi33_migrate.html';
        this.response.body = { result, done: true };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_admin', '/oi33/admin', Oi33AdminHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_admin_user_create', '/oi33/admin/user/create', AdminUserCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_admin_user_password', '/oi33/admin/user/password', AdminUserPasswordHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_admin_accounts', '/oi33/admin/accounts', AdminAccountsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_admin_ip', '/oi33/admin/ip', AdminIpHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_admin_cat_asset_purge', '/oi33/admin/cat-assets/purge', AdminCatAssetPurgeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_admin_mail_blacklist', '/oi33/admin/mail-blacklist', AdminMailBlacklistHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_admin_mail_blacklist_delete', '/oi33/admin/mail-blacklist/:domain/delete', AdminMailBlacklistDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_migrate', '/oi33/migrate', MigrateHandler, PRIV.PRIV_USER_PROFILE);

    ctx.addScript(
        'updateRatings',
        'Update AtCoder / Codeforces ratings for all users with approved accounts',
        Schema.object({}),
        runUpdateRatings,
    );

    ctx.addScript(
        'fixLuoguDifficulty',
        'Restore raw Luogu difficulty (0-8) from problemset-open ndjson, undoing luogu-import-problem remap',
        Schema.object({
            path: Schema.string().default(''),
            domainId: Schema.string().default('luogu'),
            prefix: Schema.string().default(''),
        }),
        runFixLuoguDifficulty,
    );
}
