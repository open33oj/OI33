import { Context, Handler, Types, param } from 'hydrooj';

// 旧 `/oi33/achievements*` 链接的 GET 重定向。

export class LegacyMedalManageRedirect extends Handler {
    async get() {
        this.response.redirect = this.url('oi33_medal_manage');
    }
}

export class LegacyMedalCatalogueRedirect extends Handler {
    async get() {
        this.response.redirect = this.url('oi33_medal_catalogue');
    }
}

export class LegacyMedalShowcaseRedirect extends Handler {
    async get() {
        this.response.redirect = this.url('oi33_medal_showcase');
    }
}

export class LegacyMedalUserRedirect extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        this.response.redirect = this.url('oi33_medal_user', { uid });
    }
}

export function registerLegacyRedirects(ctx: Context) {
    ctx.Route('oi33_legacy_medal_manage', '/oi33/achievements', LegacyMedalManageRedirect);
    ctx.Route('oi33_legacy_medal_catalogue', '/oi33/achievements/rare', LegacyMedalCatalogueRedirect);
    ctx.Route('oi33_legacy_medal_showcase', '/oi33/achievements/showcase', LegacyMedalShowcaseRedirect);
    ctx.Route('oi33_legacy_medal_user', '/oi33/achievements/user/:uid', LegacyMedalUserRedirect);
}
