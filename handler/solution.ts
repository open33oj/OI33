import {
    Context, DocumentModel, Handler, ObjectId, PERM, PRIV, ProblemModel, SolutionModel, Types,
    UserModel, ValidationError, param, query,
} from 'hydrooj';
import { oi33Model } from '../model';
import { checkOi33Admin, checkUserFlag } from './utils';

const PAGE_SIZE = 30;
// 列表页只需要摘要字段；题解评论（reply）可能很多，显式裁掉。
const LIST_PROJECTION = ['content', 'owner', 'parentId', 'vote', 'hidden', 'featured'];

// 全站题解时间线：按发布时间倒序（_id 即 ObjectId）列出所有已发布的题解。
// 审核中的题解（hidden）不在此列表出现，它们只存在于审核队列。
class Oi33SolutionListHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const filter = { hidden: { $ne: true } };
        const total = await SolutionModel.count(domainId, filter);
        const upcount = Math.max(1, Math.ceil(total / PAGE_SIZE));
        const psdocs = await DocumentModel.getMulti(
            domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, filter, LIST_PROJECTION as any,
        ).sort({ _id: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).toArray();
        const pids = [...new Set(psdocs.map((psdoc: any) => Number(psdoc.parentId))
            .filter((pid) => Number.isSafeInteger(pid)))];
        const uids = [...new Set(psdocs.map((psdoc: any) => Number(psdoc.owner))
            .filter((uid) => Number.isSafeInteger(uid)))];
        const [pdocs, udict] = await Promise.all([
            pids.length ? ProblemModel.getList(domainId, pids, false, false) : {},
            uids.length ? UserModel.getList(domainId, uids) : {},
        ]);
        this.response.template = 'oi33_solutions.html';
        this.response.body = {
            psdocs, pdocs, udict, page, upcount, total,
        };
    }
}

// 题解加精：精华题解在题目题解列表里排在最前（组内按投票数倒序），题目页与后台
// 的「加精」按钮都提交到这里。给非管理员作者的奖励由后台配置（罐头 / 猫粮）。
class Oi33SolutionFeatureHandler extends Handler {
    @param('psid', Types.ObjectId)
    @param('featured', Types.Int)
    async post(domainId: string, psid: ObjectId, featured: number) {
        const flag = await checkUserFlag(this.user._id);
        if (flag < 2 && !this.user.hasPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION)) {
            throw new ValidationError('只有管理员可以给题解加精。');
        }
        const result = await oi33Model.setSolutionFeatured(domainId, psid, !!featured, this.user._id);
        const notification = !result.featured
            ? '已取消精华'
            : result.rewarded
                ? `已设为精华，作者获得奖励：${result.rewardText}`
                : result.rewardError
                    ? `已设为精华，但奖励发放失败：${result.rewardError}`
                    : '已设为精华（作者是管理员或未认证，不发放奖励）';
        const body: any = this.request.body || {};
        const target = String(body.redirect || '');
        // Only ever bounce back to one of our own paths.
        const safePath = /^\/[^/\\]/.test(target) ? target.split('?')[0] : '';
        this.response.redirect = safePath
            ? `${safePath}?notification=${encodeURIComponent(notification)}`
            : this.url('oi33_solutions', { query: { notification } });
    }
}

// 后台：加精奖励配置 + 题解列表（可只看精华），列表里直接加精 / 取消。
class Oi33SolutionFeaturedHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('only', Types.String, true)
    async get(domainId: string, page = 1, only = '') {
        await checkOi33Admin(this.user._id);
        const featuredOnly = only === 'featured';
        const filter: any = featuredOnly ? { featured: true } : {};
        const total = await SolutionModel.count(domainId, filter);
        const upcount = Math.max(1, Math.ceil(total / PAGE_SIZE));
        const psdocs = await DocumentModel.getMulti(
            domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, filter, LIST_PROJECTION as any,
        ).sort({ featured: -1, _id: -1 } as any).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).toArray();
        const pids = [...new Set(psdocs.map((psdoc: any) => Number(psdoc.parentId))
            .filter((pid) => Number.isSafeInteger(pid)))];
        const uids = [...new Set(psdocs.map((psdoc: any) => Number(psdoc.owner))
            .filter((uid) => Number.isSafeInteger(uid)))];
        const [pdocs, udict, config, featuredCount] = await Promise.all([
            pids.length ? ProblemModel.getList(domainId, pids, false, false) : {},
            uids.length ? UserModel.getList(domainId, uids) : {},
            oi33Model.getSolutionFeatureConfig(),
            SolutionModel.count(domainId, { featured: true }),
        ]);
        this.response.template = 'oi33_solution_featured.html';
        this.response.body = {
            psdocs,
            pdocs,
            udict,
            page,
            upcount,
            total,
            featuredOnly,
            featuredCount,
            config,
            rewardText: oi33Model.solutionRewardText(config),
            rewardTypes: [
                { value: 'none', text: '不发放奖励' },
                { value: 'can', text: '猫罐头' },
                { value: 'food', text: '猫粮' },
            ],
        };
    }
}

class Oi33SolutionFeatureConfigHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body: any = this.request.body || {};
        const config = await oi33Model.saveSolutionFeatureConfig({
            featureRewardType: body.featureRewardType,
            featureRewardAmount: body.featureRewardAmount,
        }, this.user._id);
        this.response.redirect = this.url('oi33_solutions_featured', {
            query: { notification: `加精奖励已保存：${oi33Model.solutionRewardText(config)}。` },
        });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_solutions', '/oi33/solutions', Oi33SolutionListHandler, PERM.PERM_VIEW_PROBLEM_SOLUTION);
    ctx.Route('oi33_solution_feature', '/oi33/solutions/feature', Oi33SolutionFeatureHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_solutions_featured', '/oi33/solutions/featured', Oi33SolutionFeaturedHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route(
        'oi33_solution_feature_config', '/oi33/solutions/feature/config',
        Oi33SolutionFeatureConfigHandler, PRIV.PRIV_USER_PROFILE,
    );
}
