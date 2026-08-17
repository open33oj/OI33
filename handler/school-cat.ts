import {
    avatar, Context, ForbiddenError, Handler, PRIV, Types, UserModel, param, query,
} from 'hydrooj';
import { oi33Model } from '../model';

async function resolveUsernames(entries: Array<{ uid: number; amount: number }>) {
    const uids = entries.map((entry) => entry.uid);
    const udict = uids.length ? await UserModel.getList('', uids) : {};
    return entries.map((entry) => {
        const udoc: any = udict[entry.uid];
        const verified = (Number(udoc?.realname_flag) || 0) >= 1;
        return {
            uid: entry.uid,
            uname: verified && udoc?.uname ? udoc.uname : `UID ${entry.uid}`,
            // 未认证用户不暴露头像，统一用默认头像占位。
            avatarUrl: avatar(verified ? (udoc?.avatar || '') : '', 64),
            amount: entry.amount,
        };
    });
}

class SchoolCatStateHandler extends Handler {
    async get() {
        this.response.type = 'application/json';
        this.response.body = await oi33Model.getBigCatWorldState(this.user._id || 0);
    }
}

class SchoolCatSchoolsHandler extends Handler {
    @query('q', Types.String, true)
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, q?: string, page?: number) {
        this.response.type = 'application/json';
        if (q !== undefined && q.trim()) {
            this.response.body = { schools: await oi33Model.searchSchools(q) };
            return;
        }
        this.response.body = await oi33Model.listSchools(page || 1);
    }
}

class SchoolCatBindHandler extends Handler {
    @param('schoolId', Types.Int)
    async post(domainId: string, schoolId: number) {
        try {
            const result = await oi33Model.bindSchoolCat(this.user._id, schoolId);
            this.response.type = 'application/json';
            this.response.body = { ok: true, ...result };
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '绑定大猫失败。');
        }
    }
}

class SchoolCatFeedHandler extends Handler {
    @param('amount', Types.PositiveInt)
    async post(domainId: string, amount: number) {
        try {
            const result = await oi33Model.feedSchoolCat(this.user._id, amount);
            (this.ctx as any).broadcast('oi33/cat-map-change', {
                type: 'bigcat',
                cat: {
                    id: result.schoolId,
                    display: result.display,
                    url: result.url,
                    weight: result.weight,
                    territoryCount: result.territoryCount,
                    color: result.color,
                },
            });
            this.response.type = 'application/json';
            this.response.body = { ok: true, ...result };
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '投喂失败。');
        }
    }
}

class SchoolCatDetailHandler extends Handler {
    @param('schoolId', Types.Int)
    async get(domainId: string, schoolId: number) {
        try {
            const detail = await oi33Model.getSchoolCatDetail(schoolId, this.user._id || 0);
            this.response.type = 'application/json';
            this.response.body = {
                ...detail,
                current: await resolveUsernames(detail.current),
                history: await resolveUsernames(detail.history),
            };
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '读取大猫详情失败。');
        }
    }
}

class SchoolCatColorHandler extends Handler {
    @param('schoolId', Types.Int)
    @param('color', Types.String)
    async post(domainId: string, schoolId: number, color: string) {
        try {
            const normalized = String(color || '').trim();
            if (!/^#[0-9a-f]{6}$/i.test(normalized)) throw new Error('领地颜色必须使用 #RRGGBB 格式。');
            const result = await oi33Model.setSchoolCatTerritoryColor(
                this.user._id, schoolId, Number.parseInt(normalized.slice(1), 16),
            );
            (this.ctx as any).broadcast('oi33/cat-map-change', {
                type: 'bigcat',
                cat: { id: schoolId, catId: result.catId, color: result.color },
            });
            this.response.type = 'application/json';
            this.response.body = { ok: true, ...result };
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '修改大猫领地颜色失败。');
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_school_cat_state', '/oi33/arena/big/state', SchoolCatStateHandler);
    ctx.Route('oi33_school_cat_schools', '/oi33/arena/big/schools', SchoolCatSchoolsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_bind', '/oi33/arena/big/bind', SchoolCatBindHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_feed', '/oi33/arena/big/feed', SchoolCatFeedHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_color', '/oi33/arena/big/cat/:schoolId/color', SchoolCatColorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_detail', '/oi33/arena/big/cat/:schoolId', SchoolCatDetailHandler);
}
