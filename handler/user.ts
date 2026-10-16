import {
    moment, UserModel,
    Handler, PRIV, Types, param, query, NotFoundError, ForbiddenError, Context,
} from 'hydrooj';
import { oi33Model } from '../model';
import { checkOi33Admin, checkUserFlag, loadOi33Users } from './utils';

// --- Coin handlers ---

class CoinShowHandler extends Handler {
    async get() {
        this.response.redirect = '/oi33/users';
    }
}

class CoinIncHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        this.response.template = 'oi33_coin_inc.html';
    }

    @param('uidOrName', Types.UidOrName)
    @param('amount', Types.Int)
    @param('text', Types.String)
    async post(domainId: string, uidOrName: string, amount: number, text: string) {
        await checkOi33Admin(this.user._id);
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
        // 管理员可看任意用户的账单；普通用户只能看自己的。
        const viewerFlag = uid !== this.user._id
            ? await checkOi33Admin(this.user._id)
            : await checkUserFlag(this.user._id);
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
        // 流水里只有 uid；这里把发送者 / 接收者（以及被查看的用户）解析成可渲染的
        // 用户文档，账单页才能显示用户名与认证信息而不是裸 uid。
        const uids = [...new Set([
            ...bills.flatMap((bill: any) => [Number(bill.rootId), Number(bill.userId)]),
            ...(uid ? [uid] : []),
        ])];
        const udict = await loadOi33Users(domainId, uids, { viewerFlag });
        this.response.template = 'oi33_coin_bill.html';
        this.response.body = {
            uid,
            bills,
            upcount,
            ucount,
            page,
            udict,
            viewerFlag,
            target: uid ? udict[uid] || null : null,
        };
    }
}

// --- Birthday handlers ---

class BirthdayShowHandler extends Handler {
    async get() {
        const records = await oi33Model.getTodayBirthdays();
        const userIds = records.map((r: any) => r._id);
        const udict = await loadOi33Users('', userIds);
        const udocs = userIds.map((id: number) => udict[id]).filter((u: any) => u);
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
        const udict = await loadOi33Users('', uids, { fields: ['badge'] });
        const udocs = uids.map((id: number) => udict[id]).filter((u: any) => u);
        this.response.template = 'oi33_badge_show.html';
        this.response.body = { udocs };
    }
}

class BadgeManageHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        const oi33Docs = await oi33Model.getBadgedUsers();
        const uids = oi33Docs.map((d: any) => d._id);
        const udict = await loadOi33Users('', uids, { fields: ['badge'] });
        const udocs = uids.map((id: number) => udict[id]).filter((u: any) => u);
        this.response.template = 'oi33_badge_manage.html';
        this.response.body = { udocs };
    }
}

class BadgeDelHandler extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        await checkOi33Admin(this.user._id);
        await oi33Model.removeBadge(uid);
        this.response.redirect = '/oi33/badge/manage';
    }
}

// --- Combined users page ---

class UsersShowHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('flag', Types.Int, true)
    async get(domainId: string, page = 1, flag?: number) {
        await checkOi33Admin(this.user._id);
        const { docs, upcount } = await oi33Model.getAllUsersData(page, 50, flag);
        const uids = docs.map((d: any) => d._id);
        const udict = await loadOi33Users(domainId, uids);
        const udocs = uids.map((id: number) => udict[id]).filter((u: any) => u);
        this.response.template = 'oi33_users.html';
        this.response.body = { udocs, page, upcount, flag };
    }
}

// --- Checkin handler ---

class CheckinHandler extends Handler {
    async post() {
        const uid = this.user._id;
        if (await checkUserFlag(uid) < 1) throw new ForbiddenError('完成实名认证后才能签到。');
        const now = moment().format('YYYY-MM-DD');
        const result = await oi33Model.doCheckin(uid, now);
        if (result.checkedIn) {
            try {
                await oi33Model.medalEvaluateUser(uid, {
                    ruleTypes: ['checkin_streak', 'checkin_total', 'cat_food_balance'],
                });
            } catch (e) {
                console.error('[oi33] checkin medal evaluation failed:', e);
            }
            const notification = result.cat_food_reward
                ? this.translate('Check-in succeeded, cat food +{0}')
                    .replace('{0}', oi33Model.formatCatFood(result.cat_food_reward))
                : this.translate('Check-in succeeded');
            this.response.redirect = this.url('homepage', { query: { notification } });
            return;
        }
        this.response.redirect = this.url('homepage');
    }
}

class CatFoodBillHandler extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        if (uid !== this.user._id) await checkOi33Admin(this.user._id);
        this.response.redirect = this.url('oi33_cat_account', { uid });
    }
}

// --- Rating page ---

class RatingShowHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('sort', Types.String, true)
    async get(domainId: string, page = 1, sort = 'atcoder') {
        if (!['atcoder', 'codeforces'].includes(sort)) sort = 'atcoder';
        const { docs, upcount } = await oi33Model.getRatedUsers(sort, page, 50);
        const uids = docs.map((d: any) => d._id);
        const udict = await loadOi33Users(domainId, uids);
        const udocs = uids.map((id: number) => udict[id]).filter((u: any) => u);
        this.response.template = 'oi33_rating.html';
        this.response.body = { udocs, page, upcount, sort };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_users', '/oi33/users', UsersShowHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_coin_show', '/oi33/coin/show', CoinShowHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_coin_inc', '/oi33/coin/inc', CoinIncHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_coin_bill', '/oi33/coin/bill/:uid', CoinBillHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_birthday_show', '/oi33/birthday', BirthdayShowHandler);
    ctx.Route('oi33_birthday_all', '/oi33/birthday/all', BirthdayAllHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_badge_show', '/oi33/badge', BadgeShowHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_badge_manage', '/oi33/badge/manage', BadgeManageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_badge_del', '/oi33/badge/manage/:uid/del', BadgeDelHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_checkin', '/oi33/checkin', CheckinHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_cat_food_bill', '/oi33/cat-food/bill/:uid', CatFoodBillHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_at_cf_rating', '/oi33/at-cf-rating', RatingShowHandler);
}
