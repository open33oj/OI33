import {
    Context, PRIV, STATUS,
} from 'hydrooj';
import { oi33Model } from '../../model';
import { registerMedalUserPanel } from './pages';
import { registerLegacyRedirects } from './redirects';
import {
    MedalConfigHandler, MedalDeleteHandler, MedalEditHandler, MedalExportHandler,
    MedalImportHandler, MedalManageHandler, MedalSaveHandler,
} from './manage';
import { MedalGrantHandler, MedalLevelHandler, MedalRevokeHandler, MedalScanHandler } from './award';
import { MedalShowcaseHandler } from './showcase';
import {
    MedalCatalogueHandler, MedalHoldersHandler, MedalLevelUsersHandler, MedalUserHandler,
    MedalUserManageHandler,
} from './pages';

// 奖章功能入口：路由表集中在这里。管理页在 manage.ts，发放/等级在 award.ts，
// 展示墙在 showcase.ts，只读页面在 pages.ts，旧链接在 redirects.ts，表单
// 校验在 shared.ts。新增路由请只改这个文件，并保持路由名 `oi33_*`。

export async function apply(ctx: Context) {
    ctx.Route(
        'oi33_medal_manage',
        '/oi33/medals',
        MedalManageHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    // 编辑页用 `/oi33/medals/:id/edit`：与 `/oi33/medals/:id/delete` 只差最后一个
    // 静态段，不会像 `/oi33/medals/edit/:id` 那样和删除 id 为 `edit` 的奖章冲突。
    ctx.Route(
        'oi33_medal_edit',
        '/oi33/medals/:id/edit',
        MedalEditHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_save',
        '/oi33/medals/save',
        MedalSaveHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_config',
        '/oi33/medals/config',
        MedalConfigHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_export',
        '/oi33/medals/export',
        MedalExportHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_import',
        '/oi33/medals/import',
        MedalImportHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_delete',
        '/oi33/medals/:id/delete',
        MedalDeleteHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_grant',
        '/oi33/medals/grant',
        MedalGrantHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_level',
        '/oi33/medals/level',
        MedalLevelHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_revoke',
        '/oi33/medals/revoke',
        MedalRevokeHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_scan',
        '/oi33/medals/scan',
        MedalScanHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_catalogue',
        '/oi33/medals/catalogue',
        MedalCatalogueHandler,
    );
    ctx.Route(
        'oi33_medal_level_users',
        '/oi33/medals/catalogue/:id/level/:level',
        MedalLevelUsersHandler,
    );
    ctx.Route(
        'oi33_medal_holders',
        '/oi33/medals/catalogue/:id/holders',
        MedalHoldersHandler,
    );
    ctx.Route(
        'oi33_medal_showcase',
        '/oi33/medals/showcase',
        MedalShowcaseHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_user_manage',
        '/oi33/medals/user/:uid/manage',
        MedalUserManageHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route(
        'oi33_medal_user',
        '/oi33/medals/user/:uid',
        MedalUserHandler,
    );
    ctx.on('record/judge', async (rdoc: any, updated: boolean) => {
        if (!updated || rdoc?.status !== STATUS.STATUS_ACCEPTED) return;
        if (!oi33Model.medalAcceptedDomainIncluded(String(rdoc.domainId ?? ''))) return;
        try {
            await oi33Model.medalEvaluateUser(rdoc.uid, {
                ruleTypes: ['accepted_problems'],
            });
        } catch (e) {
            console.error('[oi33] accepted-problem medal evaluation failed:', e);
        }
    });
    registerMedalUserPanel(ctx);
    registerLegacyRedirects(ctx);
}
