import {
    moment, UserModel,
    Handler, PRIV, Types, param, query, NotFoundError, Context,
} from 'hydrooj';
import { oi33Model } from '../model';

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

export async function apply(ctx: Context) {
    ctx.Route('oi33_users', '/oi33/users', UsersShowHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_coin_show', '/oi33/coin/show', CoinShowHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_coin_inc', '/oi33/coin/inc', CoinIncHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_coin_bill', '/oi33/coin/bill/:uid', CoinBillHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_birthday_show', '/oi33/birthday', BirthdayShowHandler);
    ctx.Route('oi33_birthday_all', '/oi33/birthday/all', BirthdayAllHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_badge_show', '/oi33/badge', BadgeShowHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_badge_manage', '/oi33/badge/manage', BadgeManageHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_badge_del', '/oi33/badge/manage/:uid/del', BadgeDelHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_checkin', '/oi33/checkin', CheckinHandler, PRIV.PRIV_USER_PROFILE);
}
