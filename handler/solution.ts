import {
    Context, DocumentModel, Handler, PERM, ProblemModel, SolutionModel, Types, UserModel, query,
} from 'hydrooj';

const PAGE_SIZE = 30;
// 列表页只需要摘要字段；题解评论（reply）可能很多，显式裁掉。
const LIST_PROJECTION = ['content', 'owner', 'parentId', 'vote', 'hidden'];

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

export async function apply(ctx: Context) {
    ctx.Route('oi33_solutions', '/oi33/solutions', Oi33SolutionListHandler, PERM.PERM_VIEW_PROBLEM_SOLUTION);
}
