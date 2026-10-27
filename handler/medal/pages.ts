import { Context, Handler, NotFoundError, Types, UserModel, param } from 'hydrooj';
import { oi33Model } from '../../model';
import { remainText } from '../../model/auction';
import type { Oi33MedalCategory } from '../../model/types';
import { checkOi33Admin, checkUserFlag, loadOi33Users } from '../utils';

// 只读奖章页面：公开目录、等级持有者、全部持有者、用户奖章页与单用户管理页，
// 以及把展示墙注入资料页的 `handler/after/UserDetail` 钩子。

export class MedalCatalogueHandler extends Handler {
    async get() {
        await oi33Model.auctionSettleExpired();
        const now = new Date();
        const [groups, saleableRows, stats] = await Promise.all([
            oi33Model.medalCatalogue(),
            oi33Model.auctionSaleableShowcase(),
            oi33Model.medalAwardStats(),
        ]);
        // 只有一般奖章会存 `count`（重复获得）；其它系列每人恒为 1 枚，旧数据
        // 若误带 count 也不让它把「总持有数量」算大。
        const manualIds = new Set((groups.manual || []).map((medal: any) => String(medal._id)));
        for (const [id, stat] of Object.entries(stats)) {
            if (!manualIds.has(id)) stat.copies = stat.total;
        }
        const uids = saleableRows.filter((row) => row.award).map((row) => row.award!.uid);
        const udict = await buildUserDict('', uids);
        this.response.template = 'oi33_medal_catalogue.html';
        this.response.body = {
            groups,
            stats,
            rows: saleableRows.map((row) => ({
                ...row,
                remainText: row.activeAuction ? remainText(row.activeAuction.endAt, now) : '',
            })),
            udict,
        };
    }
}

export class MedalUserHandler extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new NotFoundError(uid);
        const targetFlag = await checkUserFlag(uid);
        // Display-only: management lives on /oi33/medals/user/:uid/manage,
        // reachable from the admin button on the profile card. This page never
        // receives revoke / level forms or an admin entry point of its own.
        const awards = targetFlag >= 1 ? await oi33Model.medalGetUserAwards(uid) : [];
        this.response.template = 'oi33_medal_user.html';
        this.response.body = { udoc, awards };
    }
}

// Dedicated per-user medal management: grant, revoke and level changes live
// here instead of being mixed into the public display page. Kept behind the
// same OI33 admin flag as /oi33/medals.
export class MedalUserManageHandler extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        await checkOi33Admin(this.user._id);
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new NotFoundError(uid);
        const [awards, medals] = await Promise.all([
            oi33Model.medalGetUserAwards(uid),
            oi33Model.medalList(),
        ]);
        const leveled = medals.filter((medal) => oi33Model.medalIsLevelSeries(medal));
        const plain = medals.filter((medal) => !oi33Model.medalIsLevelSeries(medal));
        const byCategory = (list: any[], category: Oi33MedalCategory) => list.filter(
            (medal: any) => medal.category === category,
        );
        // Same order as the global management page: 可售卖 → 奖项认证 → 一般 →
        // OJ 成就（含尚未迁移成阶梯的旧定义）。
        const grantMedals = [
            ...byCategory(plain, 'saleable'),
            ...byCategory(leveled, 'certification'),
            ...byCategory(plain, 'manual'),
            ...byCategory(leveled, 'oj'),
            ...byCategory(plain, 'oj'),
        ];
        const medalLevels = Object.fromEntries(leveled.map((medal) => [medal._id,
            oi33Model.medalSortedLevels(medal).map((level) => ({
                level: level.level,
                name: oi33Model.medalLevelLabel(level),
                ...(Number(level.threshold) > 0 ? { threshold: Number(level.threshold) } : {}),
            }))]));
        this.response.template = 'oi33_medal_user_manage.html';
        this.response.body = {
            udoc,
            awards,
            grantMedals,
            medalLevels,
            levels: Object.fromEntries(awards
                .filter((award: any) => award.view.leveled)
                .map((award: any) => [award.medalId, oi33Model.medalSortedLevels(award.medal)])),
        };
    }
}

// Public page backing a level in the catalogue: everybody who currently holds
// that exact rung. Certification and OJ 成就 series both have ladders, so both
// link their rungs here; the catalogue's holder counts are never a dead end.
export class MedalLevelUsersHandler extends Handler {
    @param('id', Types.String)
    @param('level', Types.Int)
    async get(domainId: string, id: string, level: number) {
        const medal = await oi33Model.medalGet(id);
        if (!medal || !oi33Model.medalIsLevelSeries(medal)) {
            throw new NotFoundError(id);
        }
        const rung = oi33Model.medalLevelOf(medal, level);
        if (!rung) throw new NotFoundError(String(level));
        const awards = await oi33Model.medalListLevelHolders(id, Number(rung.level));
        // 每个持有人的持有数量（等级系列恒为 1；仍统一走 medalAwardView，
        // 避免旧数据里的 count 字段被误当成多枚）。
        const rows = awards.map((award: any) => {
            const view = oi33Model.medalAwardView(award, medal);
            return { ...award, copies: view.count, stars: view.stars };
        });
        const totalCopies = rows.reduce((sum, award) => sum + award.copies, 0);
        const udict = await buildUserDict(domainId, rows.map((award) => award.uid));
        this.response.template = 'oi33_medal_level_users.html';
        this.response.body = {
            medal,
            rung,
            awards: rows,
            udict,
            totalCopies,
            levels: oi33Model.medalSortedLevels(medal),
        };
    }
}

// Holder list for one definition, whatever family it belongs to: the catalogue
// links every medal card here (一般奖章 / 未分级的 OJ 成就奖章 / 可售卖奖章 all
// end up as a flat list; series are grouped by rung in ladder order and offer
// the per-level switch). Awards whose rung no longer exists on the ladder fall
// back to the closest surviving one via `medalDisplayRung`.
export class MedalHoldersHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        const medal = await oi33Model.medalGet(id);
        if (!medal) throw new NotFoundError(id);
        const awards = await oi33Model.medalListHolders(id);
        // 一般奖章可以重复获得：数量与派生星级一并给模板（其它系列恒为 1 枚）。
        const rows = awards.map((award: any) => {
            const view = oi33Model.medalAwardView(award, medal);
            return { ...award, copies: view.count, stars: view.stars };
        });
        const totalCopies = rows.reduce((sum, award) => sum + award.copies, 0);
        const udict = await buildUserDict(domainId, rows.map((award: any) => award.uid));
        const leveled = oi33Model.medalIsLevelSeries(medal);
        const groups = leveled
            ? oi33Model.medalSortedLevels(medal).map((level) => {
                const levelAwards = rows.filter(
                    (award: any) => Number(oi33Model.medalDisplayRung(medal, award.level)?.level)
                        === Number(level.level),
                );
                return {
                    level,
                    awards: levelAwards,
                    copies: levelAwards.reduce((sum, award) => sum + award.copies, 0),
                };
            })
            : [];
        this.response.template = 'oi33_medal_holders.html';
        this.response.body = {
            medal,
            awards: rows,
            udict,
            count: rows.length,
            totalCopies,
            leveled,
            levels: leveled ? oi33Model.medalSortedLevels(medal) : [],
            groups,
        };
    }
}

async function buildUserDict(domainId: string, uids: number[]) {
    const unique = uids.filter((uid) => Number.isSafeInteger(uid) && uid > 0);
    return loadOi33Users(domainId, unique);
}

export function registerMedalUserPanel(ctx: Context) {
    ctx.on('handler/after/UserDetail', async (h: any) => {
        try {
            const body = h.response?.body;
            const uid = Number(body?.udoc?._id);
            if (!Number.isSafeInteger(uid) || uid <= 0) return;
            const targetData = (await oi33Model.getUserDataByUids([uid]))[uid];
            if ((targetData?.realname_flag ?? 0) < 1) return;
            const viewerUid = Number(h.user?._id) || 0;
            const [awards, viewerFlag] = await Promise.all([
                oi33Model.medalGetUserAwards(uid),
                viewerUid ? checkUserFlag(viewerUid) : Promise.resolve(0),
            ]);
            // The profile renders the same free canvas the user arranged, at an
            // integer scale (frontend/medal-showcase.page.ts fits it to the
            // card). Copies beyond the medal's allowance (or medals that no
            // longer exist) are dropped so the card stays legal.
            const awardMap = new Map(awards.map((award: any) => [String(award.medalId), award]));
            const limitOf = (id: string) => {
                const award = awardMap.get(String(id));
                return award ? oi33Model.medalShowcaseCopyLimit(award.view) : 0;
            };
            const showcasePieces = oi33Model.medalShowcaseTrim(
                oi33Model.medalShowcasePieces(targetData?.medal_showcase),
                limitOf,
            ).map((piece) => ({
                ...piece,
                size: oi33Model.MEDAL_SHOWCASE_CELL,
                award: awardMap.get(piece.id) || null,
            }));
            // The profile card only renders the showcase wall (plus the button
            // to the standalone /oi33/medals/user/:uid page), so the full award
            // list stays out of the response body — it would ship every PNG.
            body.oi33MedalPanel = {
                showcasePieces,
                showcaseConfigured: showcasePieces.length > 0,
                showcaseWall: {
                    width: oi33Model.MEDAL_SHOWCASE_WIDTH,
                    height: oi33Model.MEDAL_SHOWCASE_HEIGHT,
                    cell: oi33Model.MEDAL_SHOWCASE_CELL,
                    grid: oi33Model.MEDAL_SHOWCASE_SNAP,
                },
                isSelf: viewerUid === uid,
                canManage: viewerFlag >= 2,
            };
        } catch (e) {
            console.error('[oi33] medal profile panel failed:', e);
        }
    });
}

// The medal pages moved from /oi33/achievements to the 奖章 naming. These four
// permanent redirects keep old bookmarks and chat links working; the POST
// endpoints are internal form targets and simply moved with the pages.
