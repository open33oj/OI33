import {
    avatar, Context, ForbiddenError, Handler, PRIV, Types, UserModel, param, query,
} from 'hydrooj';
import { oi33Model } from '../model';
import { checkUserFlag } from './utils';

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

async function evaluateWeeklyRewardAchievements(uids: number[]) {
    for (let offset = 0; offset < uids.length; offset += 20) {
        await Promise.all(uids.slice(offset, offset + 20).map((uid: number) => (
            oi33Model.achievementEvaluateUser(uid, { ruleTypes: ['cat_can_balance'] })
                .catch((e) => console.error('[oi33] weekly big-cat reward achievement evaluation failed:', e))
        )));
    }
}

async function decorateRewardSchools(detail: any) {
    if (!detail) return detail;
    const ids = new Set<number>();
    for (const cat of detail.cats || []) ids.add(Number(cat.schoolId));
    for (const row of detail.allocations || []) ids.add(Number(row.schoolId));
    const schoolRows = await Promise.all(Array.from(ids)
        .filter((id) => Number.isSafeInteger(id) && id >= 0)
        .map(async (id) => [id, await oi33Model.getSchool(id)] as const));
    const schools = new Map(schoolRows);
    const decorate = (row: any) => {
        const school: any = schools.get(Number(row.schoolId));
        return {
            ...row,
            schoolDisplay: school ? oi33Model.schoolDisplay(school) : `#${row.schoolId}`,
            schoolUrl: oi33Model.schoolUrl(Number(row.schoolId)),
        };
    };
    return {
        ...detail,
        cats: (detail.cats || []).map(decorate),
        allocations: (detail.allocations || []).map(decorate),
    };
}

class SchoolCatStateHandler extends Handler {
    async get() {
        this.response.type = 'application/json';
        this.response.body = await oi33Model.getBigCatWorldState(this.user._id || 0);
    }
}

class SchoolCatRankingHandler extends Handler {
    async get() {
        const canManage = !!this.user._id && await checkUserFlag(this.user._id) >= 3;
        const [ranking, rewardStatus] = await Promise.all([
            oi33Model.getSchoolCatRanking(),
            oi33Model.getSchoolCatWeeklyRewardStatus(),
        ]);
        this.response.template = 'oi33_school_cat_ranking.html';
        this.response.body = {
            ranking,
            rewardStatus,
            canManage,
        };
    }
}

class SchoolCatAdminToggleHandler extends Handler {
    @param('schoolId', Types.Int)
    @param('enabled', Types.Int)
    async post(domainId: string, schoolId: number, enabled: number) {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以设置管理员大猫。');
        if (enabled !== 0 && enabled !== 1) throw new ForbiddenError('管理员大猫状态无效。');
        try {
            const result = await oi33Model.setSchoolCatAdminCat(this.user._id, schoolId, enabled === 1);
            (this.ctx as any).broadcast('oi33/cat-map-change', {
                type: 'bigcat',
                cat: { id: schoolId, isAdminCat: result.isAdminCat },
            });
            this.response.redirect = this.url('oi33_school_cat_ranking', {
                query: {
                    notification: `${result.display} 已${result.isAdminCat ? '设为' : '取消'}管理员大猫。`,
                },
            });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '设置管理员大猫失败。');
        }
    }
}

class SchoolCatMoveBackfillHandler extends Handler {
    async post() {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以回算历史移动贡献。');
        try {
            const result = await oi33Model.backfillSchoolCatMoveContributions(this.user._id);
            for (const id of result.affectedCatIds) {
                (this.ctx as any).broadcast('oi33/cat-map-change', { type: 'bigcat', cat: { id } });
            }
            this.response.redirect = this.url('oi33_school_cat_ranking', {
                query: {
                    notification: `已回算 ${result.moves} 次历史移动，共计 ${result.contribution}g 大猫贡献；`
                        + `另有 ${result.pendingMoves} 次因用户未认证或未绑定而暂不处理。`,
                },
            });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '回算历史移动贡献失败。');
        }
    }
}

class SchoolCatWeeklyRewardHandler extends Handler {
    async post() {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以手动触发每周大猫奖励。');
        try {
            const result = await oi33Model.settleSchoolCatWeeklyRewards(this.user._id);
            if (result.newlyCompleted && result.awardedUids.length) {
                await evaluateWeeklyRewardAchievements(result.awardedUids);
            }
            const notification = result.running
                ? `${result.period} 的每周奖励正在由另一个进程结算，请稍后刷新。`
                : result.newlyCompleted
                    ? `${result.period} 每周奖励结算完成：${result.users} 位用户，共发放 ${result.cans} 个猫罐头。`
                    : `${result.period} 每周奖励已经结算：${result.users} 位用户，共发放 ${result.cans} 个猫罐头。`;
            this.response.redirect = this.url('oi33_school_cat_ranking', { query: { notification } });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '每周大猫奖励结算失败。');
        }
    }
}

class SchoolCatRewardAdminHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('period', Types.String, true)
    @query('allocationPage', Types.PositiveInt, true)
    async get(domainId: string, page = 1, period = '', allocationPage = 1) {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以管理每周大猫奖励。');
        const currentPeriod = oi33Model.schoolCatRewardPeriod();
        const listing = await oi33Model.listSchoolCatWeeklyRewards(page);
        if (listing.page === 1 && !listing.rewards.some((row: any) => row._id === currentPeriod)) {
            listing.rewards.unshift({
                _id: currentPeriod, status: 'pending', revision: 1,
                plannedUsers: 0, plannedCans: 0,
            });
        }
        const selectedPeriod = String(period || listing.rewards[0]?._id || currentPeriod);
        let detail: any;
        try {
            detail = await oi33Model.getSchoolCatWeeklyRewardDetail(selectedPeriod, allocationPage);
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '结算周期无效。');
        }
        if (!detail && selectedPeriod === currentPeriod) {
            detail = {
                _id: currentPeriod, status: 'pending', revision: 1,
                plannedUsers: 0, plannedCans: 0, cats: [], allocations: [],
                allocationPage: 1, allocationPages: 1, allocationTotal: 0,
            };
        }
        if (!detail) throw new ForbiddenError('该结算批次不存在。');
        detail = await decorateRewardSchools(detail);
        let rollbackCheck: any = null;
        let rollbackCheckError = '';
        if (['completed', 'rolling_back', 'rollback_failed'].includes(detail.status)) {
            try {
                rollbackCheck = await oi33Model.getSchoolCatWeeklyRewardRollbackCheck(selectedPeriod);
            } catch (e: any) {
                rollbackCheckError = e?.message || String(e);
            }
        }
        this.response.template = 'oi33_school_cat_rewards.html';
        this.response.body = {
            ...listing, detail, selectedPeriod, currentPeriod,
            rollbackCheck, rollbackCheckError,
        };
    }
}

class SchoolCatRewardSettleHandler extends Handler {
    @param('period', Types.String)
    async post(domainId: string, period: string) {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以结算每周大猫奖励。');
        try {
            const result = await oi33Model.settleSchoolCatWeeklyRewards(this.user._id, new Date(), period);
            if (result.newlyCompleted && result.awardedUids.length) {
                await evaluateWeeklyRewardAchievements(result.awardedUids);
            }
            const notification = result.running
                ? `${result.period} 第 ${result.revision} 版正在由另一个进程结算。`
                : `${result.period} 第 ${result.revision} 版结算完成：${result.users} 位用户，共 ${result.cans} 个猫罐头。`;
            this.response.redirect = this.url('oi33_school_cat_rewards', {
                query: { period: result.period, notification },
            });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '每周大猫奖励结算失败。');
        }
    }
}

class SchoolCatRewardRollbackHandler extends Handler {
    @param('period', Types.String)
    @param('reason', Types.String)
    async post(domainId: string, period: string, reason: string) {
        if (await checkUserFlag(this.user._id) < 3) throw new ForbiddenError('仅行政管理员可以回滚每周大猫奖励。');
        try {
            const result = await oi33Model.rollbackSchoolCatWeeklyRewards(
                this.user._id, period, reason,
            );
            const notification = result.newlyRolledBack
                ? `${result.period} 第 ${result.revision} 版已回滚：从 ${result.users} 位用户扣回 ${result.cans} 个猫罐头。`
                : `${result.period} 第 ${result.revision} 版此前已经回滚。`;
            this.response.redirect = this.url('oi33_school_cat_rewards', {
                query: { period: result.period, notification },
            });
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '每周大猫奖励回滚失败。');
        }
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

class SchoolCatUnbindHandler extends Handler {
    async post() {
        try {
            const result = await oi33Model.unbindSchoolCat(this.user._id);
            if (result.cat) {
                (this.ctx as any).broadcast('oi33/cat-map-change', {
                    type: 'bigcat', cat: result.cat,
                });
            }
            this.response.type = 'application/json';
            this.response.body = { ok: true, ...result };
        } catch (e: any) {
            throw new ForbiddenError(e?.message || '取消绑定大猫失败。');
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
                    isAdminCat: result.isAdminCat,
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
    ctx.Route('oi33_school_cat_ranking', '/oi33/arena/big/ranking', SchoolCatRankingHandler);
    ctx.Route('oi33_school_cat_admin_toggle', '/oi33/arena/big/ranking/:schoolId/admin', SchoolCatAdminToggleHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_move_backfill', '/oi33/arena/big/ranking/backfill-moves', SchoolCatMoveBackfillHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_weekly_reward', '/oi33/arena/big/ranking/weekly-reward', SchoolCatWeeklyRewardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_rewards', '/oi33/admin/school-cat-rewards', SchoolCatRewardAdminHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_reward_settle', '/oi33/admin/school-cat-rewards/:period/settle', SchoolCatRewardSettleHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_reward_rollback', '/oi33/admin/school-cat-rewards/:period/rollback', SchoolCatRewardRollbackHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_schools', '/oi33/arena/big/schools', SchoolCatSchoolsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_bind', '/oi33/arena/big/bind', SchoolCatBindHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_unbind', '/oi33/arena/big/unbind', SchoolCatUnbindHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_feed', '/oi33/arena/big/feed', SchoolCatFeedHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_color', '/oi33/arena/big/cat/:schoolId/color', SchoolCatColorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_school_cat_detail', '/oi33/arena/big/cat/:schoolId', SchoolCatDetailHandler);
}
