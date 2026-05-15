import {
    _, db, UserModel, SettingModel, DomainModel, moment,
    Handler, PRIV, Types, param, query, NotFoundError, Context,
} from 'hydrooj';
import { HomeHandler } from 'hydrooj/src/handler/home';
import { oi33Model } from './model';
import { migrate, previewMigration } from './migrate';
import Schema from 'schemastery';
import { runExport } from './scripts/export-hydro-data';

// --- Monkey-patches (run at import time) ---

// (a) UserModel.getList — merge oi33_user fields into udoc
// getList returns User instances with hasPriv(), used by pages that render user.html
const origGetList = UserModel.getList;
UserModel.getList = async function (domainId: string, uids: number[]) {
    const udict = await origGetList.call(UserModel, domainId, uids);
    if (!uids.length) return udict;
    const oi33Dict = await oi33Model.getUserDataByUids(uids);
    for (const uid of uids) {
        const oi33 = oi33Dict[uid];
        if (!oi33) continue;
        const u = udict[uid];
        if (!u) continue;
        oi33Model.mergeOi33Fields(u, oi33);
    }
    return udict;
};

// (b) UserModel.getListForRender — merge oi33_user fields into udoc
// getListForRender returns plain objects without hasPriv(); used for lightweight rendering
const origGetListForRender = UserModel.getListForRender;
UserModel.getListForRender = async function (domainId: string, uids: number[]) {
    const udict = await origGetListForRender.call(UserModel, domainId, uids);
    if (!uids.length) return udict;
    const oi33Dict = await oi33Model.getUserDataByUids(uids);
    for (const uid of uids) {
        const oi33 = oi33Dict[uid];
        if (!oi33) continue;
        const u = udict[uid];
        if (!u) continue;
        oi33Model.mergeOi33Fields(u, oi33);
    }
    return udict;
};

// (c) HomeHandler.prototype.getCheckin — inject checkin data into homepage
HomeHandler.prototype.getCheckin = async function (domainId: string, payload: any) {
    const today = moment().format('YYYY-MM-DD');
    payload.luck_today = today;
    if (this.user && this.user._id) {
        const oi33User = await oi33Model.getCheckinUser(this.user._id);
        if (oi33User && oi33User.checkin_time) {
            payload.oi33_checkin = {
                time: oi33User.checkin_time,
                luck: oi33User.checkin_luck ?? 0,
                cnt_now: oi33User.checkin_cnt_now ?? 0,
                cnt_all: oi33User.checkin_cnt_all ?? 0,
            };
        }
    }
    return payload;
};

// (d) HomeHandler.prototype.getCountdown — inject countdown data into homepage
HomeHandler.prototype.getCountdown = async function (domainId: string, payload: any) {
    function formatDate(date: Date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function calculateDiffDays(targetDate: Date) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const timeDiff = targetDate.getTime() - today.getTime();
        return Math.floor(timeDiff / (1000 * 60 * 60 * 24));
    }

    const content: any[] = [];
    const dateToday = formatDate(new Date());
    const dates: any[] = payload.dates || [];
    dates.forEach(function (val: any) {
        if (content.length < (payload.max_dates || 10)) {
            const targetDate = new Date(val.date);
            targetDate.setHours(0, 0, 0, 0);
            const todayDate = new Date(dateToday);
            todayDate.setHours(0, 0, 0, 0);
            if (targetDate >= todayDate) {
                const diffTime = calculateDiffDays(targetDate);
                content.push({ name: val.name, diff: diffTime });
            }
        }
    });
    payload.dates = content;
    return payload;
};

// --- Coin handlers ---

class CoinShowHandler extends Handler {
    async get() {
        this.response.redirect = '/oi33/users';
    }
}

class CoinIncHandler extends Handler {
    async get() {
        this.response.template = 'oi33_coin_inc.html';
    }

    @param('uidOrName', Types.UidOrName)
    @param('amount', Types.Int)
    @param('text', Types.String)
    async post(domainId: string, uidOrName: string, amount: number, text: string) {
        let udoc = await UserModel.getById(domainId, +uidOrName)
            || await UserModel.getByUname(domainId, uidOrName)
            || await UserModel.getByEmail(domainId, uidOrName);
        if (!udoc) throw new NotFoundError(uidOrName);
        await oi33Model.coinInc(udoc._id, this.user._id, amount, text);
        this.response.redirect = this.url('oi33_coin_bill', { uid: udoc._id });
    }
}

class CoinBillHandler extends Handler {
    @param('uid', Types.Int)
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, uid: number, page = 1) {
        if (uid !== this.user._id) this.checkPriv(PRIV.PRIV_MOD_BADGE);
        let ucount: number;
        let upcount: number;
        let bills: any[];
        if (uid === 0) {
            ucount = await oi33Model.coinBillCount();
            upcount = Math.ceil(ucount / 50);
            bills = await oi33Model.coinGetAll(50, page);
        } else {
            ucount = await oi33Model.coinUserBillCount(uid);
            upcount = Math.ceil(ucount / 50);
            bills = await oi33Model.coinGetUser(uid, 50, page);
        }
        this.response.template = 'oi33_coin_bill.html';
        this.response.body = { uid, bills, upcount, ucount, page };
    }
}

// --- Birthday handlers ---

class BirthdaySetHandler extends Handler {
    async get() {
        this.response.template = 'oi33_birthday_set.html';
    }

    @param('uidOrName', Types.UidOrName)
    @param('date', Types.String)
    async post(domainId: string, uidOrName: string, date: string) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw new Error('日期格式错误，请使用 YYYY-MM-DD 格式');
        }
        let udoc = await UserModel.getById(domainId, +uidOrName)
            || await UserModel.getByUname(domainId, uidOrName)
            || await UserModel.getByEmail(domainId, uidOrName);
        if (!udoc) throw new NotFoundError(uidOrName);
        await oi33Model.setBirthday(udoc._id, date);
        this.response.redirect = this.url('oi33_birthday_show');
    }
}

class BirthdayShowHandler extends Handler {
    async get() {
        const records = await oi33Model.getTodayBirthdays();
        const userIds = records.map((r: any) => r._id);
        const udict = await UserModel.getList('', userIds);
        const oi33Dict = await oi33Model.getUserDataByUids(userIds);
        const udocs = userIds.map((id: number) => {
            const u = udict[id];
            if (!u) return null;
            oi33Model.mergeOi33Fields(u, oi33Dict[id]);
            return u;
        }).filter((u: any) => u);
        this.response.template = 'oi33_birthday_show.html';
        this.response.body = { udocs, records };
    }
}

class BirthdayAllHandler extends Handler {
    async get() {
        this.response.redirect = '/oi33/users';
    }
}

// --- Badge handlers ---

class BadgeShowHandler extends Handler {
    async get() {
        const oi33Docs = await oi33Model.getBadgedUsers();
        const uids = oi33Docs.map((d: any) => d._id);
        const udict = await UserModel.getList('', uids);
        const oi33Dict = await oi33Model.getUserDataByUids(uids);
        const udocs = uids.map((id: number) => {
            const u = udict[id];
            if (!u) return null;
            oi33Model.mergeOi33Fields(u, oi33Dict[id], ['badge']);
            return u;
        }).filter((u: any) => u);
        this.response.template = 'oi33_badge_show.html';
        this.response.body = { udocs };
    }
}

class BadgeCreateHandler extends Handler {
    async get() {
        this.response.template = 'oi33_badge_create.html';
    }

    @param('uidOrName', Types.UidOrName)
    @param('text', Types.String)
    @param('color', Types.String)
    @param('textColor', Types.String)
    async post(domainId: string, uidOrName: string, text: string, color: string, textColor: string) {
        let udoc = await UserModel.getById(domainId, +uidOrName)
            || await UserModel.getByUname(domainId, uidOrName)
            || await UserModel.getByEmail(domainId, uidOrName);
        if (!udoc) throw new NotFoundError(uidOrName);
        text = text.replace(/'/g, '').replace(/"/g, '');
        if (!text) throw new Error('Badge text is required');
        if (!/(^#[0-9A-F]{6}$)|(^#[0-9A-F]{3}$)/i.test(color)
            || !/(^#[0-9A-F]{6}$)|(^#[0-9A-F]{3}$)/i.test(textColor))
            throw new Error('Invalid color code, expected hex format like #569CD6');
        await oi33Model.setBadge(udoc._id, text, color.replace('#', ''), textColor.replace('#', ''));
        this.response.redirect = '/oi33/badge';
    }
}

class BadgeManageHandler extends Handler {
    async get() {
        const oi33Docs = await oi33Model.getBadgedUsers();
        const uids = oi33Docs.map((d: any) => d._id);
        const udict = await UserModel.getList('', uids);
        const oi33Dict = await oi33Model.getUserDataByUids(uids);
        const udocs = uids.map((id: number) => {
            const u = udict[id];
            if (!u) return null;
            oi33Model.mergeOi33Fields(u, oi33Dict[id], ['badge']);
            return u;
        }).filter((u: any) => u);
        this.response.template = 'oi33_badge_manage.html';
        this.response.body = { udocs };
    }
}

class BadgeDelHandler extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        await oi33Model.removeBadge(uid);
        this.response.redirect = '/oi33/badge/manage';
    }
}

// --- Realname handlers ---

class RealnameSetHandler extends Handler {
    async get() {
        this.response.template = 'oi33_realname_set.html';
    }

    @param('uidOrName', Types.UidOrName)
    @param('flag', Types.Int)
    @param('name', Types.String)
    async post(domainId: string, uidOrName: string, flag: number, name: string) {
        flag = parseInt(String(flag));
        let udoc = await UserModel.getById(domainId, +uidOrName)
            || await UserModel.getByUname(domainId, uidOrName)
            || await UserModel.getByEmail(domainId, uidOrName);
        if (!udoc) throw new NotFoundError(uidOrName);
        await oi33Model.setRealname(udoc._id, flag, name);
        this.response.redirect = '/oi33/users';
    }
}

class RealnameShowHandler extends Handler {
    async get() {
        this.response.redirect = '/oi33/users';
    }
}

// --- Combined users page ---

class UsersShowHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const { docs, upcount } = await oi33Model.getAllUsersData(page, 50);
        const uids = docs.map((d: any) => d._id);
        const udict = await UserModel.getList(domainId, uids);
        const oi33Dict = await oi33Model.getUserDataByUids(uids);
        const udocs = uids.map((id: number) => {
            const u = udict[id];
            if (!u) return null;
            oi33Model.mergeOi33Fields(u, oi33Dict[id]);
            return u;
        }).filter((u: any) => u);
        this.response.template = 'oi33_users.html';
        this.response.body = { udocs, page, upcount };
    }
}

// --- Checkin handler ---

class CheckinHandler extends Handler {
    async get() {
        const uid = this.user._id;
        const now = moment().format('YYYY-MM-DD');
        const oi33User = await oi33Model.getCheckinUser(uid);
        if (!oi33User || oi33User.checkin_time !== now) {
            await oi33Model.doCheckin(uid, now);
        }
        this.response.redirect = '/';
    }
}

// --- Pastebin handlers ---

class PasteCreateHandler extends Handler {
    async get() {
        this.response.template = 'oi33_paste_create.html';
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('isprivate', Types.Boolean)
    async post(domainId: string, title: string, content: string, isprivate = false) {
        const pasteid = await oi33Model.pasteAdd(this.user._id, title, content, !!isprivate);
        this.response.redirect = this.url('oi33_paste_show', { id: pasteid });
    }
}

class PasteEditHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        const doc = await oi33Model.pasteGet(id);
        if (!doc) throw new NotFoundError(id);
        if (this.user._id !== doc.owner) this.checkPriv(PRIV.PRIV_MOD_BADGE);
        this.response.body = { doc };
        this.response.template = 'oi33_paste_edit.html';
    }

    @param('pasteId', Types.String)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('isprivate', Types.Boolean)
    async post(domainId: string, pasteId: string, title: string, content: string, isprivate = false) {
        const doc = await oi33Model.pasteGet(pasteId);
        if (!doc) throw new NotFoundError(pasteId);
        if (this.user._id !== doc.owner) this.checkPriv(PRIV.PRIV_MOD_BADGE);
        await oi33Model.pasteEdit(pasteId, doc.owner, title, content, !!isprivate);
        this.response.redirect = this.url('oi33_paste_show', { id: pasteId });
    }
}

class PasteShowHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        const doc = await oi33Model.pasteGet(id);
        if (!doc) throw new NotFoundError(id);
        if (doc.isprivate && this.user._id !== doc.owner) this.checkPriv(PRIV.PRIV_MOD_BADGE);
        const udoc = await UserModel.getById(domainId, doc.owner);
        this.response.body = { doc, udoc };
        this.response.template = 'oi33_paste_show.html';
    }
}

class PasteDeleteHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        const doc = await oi33Model.pasteGet(id);
        if (!doc) throw new NotFoundError(id);
        if (this.user._id !== doc.owner) this.checkPriv(PRIV.PRIV_MOD_BADGE);
        this.response.body = { doc };
        this.response.template = 'oi33_paste_delete.html';
    }

    @param('pasteId', Types.String)
    async post(domainId: string, pasteId: string) {
        const doc = await oi33Model.pasteGet(pasteId);
        if (!doc) throw new NotFoundError(pasteId);
        if (this.user._id !== doc.owner) this.checkPriv(PRIV.PRIV_MOD_BADGE);
        await oi33Model.pasteDel(pasteId);
        this.response.redirect = this.url('oi33_paste_manage');
    }
}

class PasteManageHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const dcount = await oi33Model.pasteCountUser(this.user._id);
        const upcount = Math.ceil(dcount / 20);
        const doc = await oi33Model.pasteGetUser(this.user._id, 20, page);
        this.response.body = { doc, all: false, page, upcount };
        this.response.template = 'oi33_paste_manage.html';
    }
}

class PasteAllHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const dcount = await oi33Model.pasteCountUser(0);
        const upcount = Math.ceil(dcount / 20);
        const doc = await oi33Model.pasteGetUser(0, 20, page);
        this.response.body = { doc, all: true, page, upcount };
        this.response.template = 'oi33_paste_manage.html';
    }
}

// --- Admin dashboard ---

class Oi33AdminHandler extends Handler {
    async get() {
        const activities = await oi33Model.getRecentActivities(40);
        this.response.template = 'oi33_admin.html';
        this.response.body = { activities };
    }
}

// --- Migration handler ---

class MigrateHandler extends Handler {
    async get() {
        const preview = await previewMigration();
        this.response.template = 'oi33_migrate.html';
        this.response.body = { preview };
    }

    async post() {
        const result = await migrate();
        this.response.template = 'oi33_migrate.html';
        this.response.body = { result, done: true };
    }
}

// --- apply ---

export async function apply(ctx: Context) {
    ctx.Route('oi33_users', '/oi33/users', UsersShowHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_coin_show', '/oi33/coin/show', CoinShowHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_coin_inc', '/oi33/coin/inc', CoinIncHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_coin_bill', '/oi33/coin/bill/:uid', CoinBillHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_birthday_set', '/oi33/birthday/set', BirthdaySetHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_birthday_show', '/oi33/birthday', BirthdayShowHandler);
    ctx.Route('oi33_birthday_all', '/oi33/birthday/all', BirthdayAllHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_badge_show', '/oi33/badge', BadgeShowHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_badge_create', '/oi33/badge/create', BadgeCreateHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_badge_manage', '/oi33/badge/manage', BadgeManageHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_badge_del', '/oi33/badge/manage/:uid/del', BadgeDelHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_realname_set', '/oi33/realname/set', RealnameSetHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_realname_show', '/oi33/realname/show', RealnameShowHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_checkin', '/oi33/checkin', CheckinHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_paste_create', '/oi33/paste/create', PasteCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_paste_manage', '/oi33/paste/manage', PasteManageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_paste_all', '/oi33/paste/all', PasteAllHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_paste_show', '/oi33/paste/show/:id', PasteShowHandler);
    ctx.Route('oi33_paste_edit', '/oi33/paste/show/:id/edit', PasteEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_paste_del', '/oi33/paste/show/:id/delete', PasteDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_admin', '/oi33/admin', Oi33AdminHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_migrate', '/oi33/migrate', MigrateHandler, PRIV.PRIV_MOD_BADGE);

    // Register Hydro script
    ctx.addScript(
        'exportHydroData',
        'Export problems, contests, records and user snapshots within date range for AI analysis',
        Schema.object({
            startDate: Schema.string(),
            endDate: Schema.string(),
            outputDir: Schema.string(),
            includeCode: Schema.boolean(),
            domainId: Schema.string(),
        }),
        runExport,
    );
}
