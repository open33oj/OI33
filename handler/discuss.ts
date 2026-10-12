import {
    Context, DiscussionModel, DocumentModel, Handler, PERM, Types, UserModel, query,
} from 'hydrooj';

// 题目讨论（parentType = TYPE_PROBLEM）不再混进 /discuss 的「全部讨论」，
// 而是集中在本插件的「题目讨论」板块页。板块本身仍是一个普通概念：它只
// 聚合所有题目下的讨论，题目内的讨论依旧挂在各自题目上。
const PROBLEM_TYPE = DocumentModel.TYPE_PROBLEM;
const MAIN_LIST_TYPES = [
    DocumentModel.TYPE_CONTEST,
    DocumentModel.TYPE_DISCUSSION_NODE,
    DocumentModel.TYPE_TRAINING,
];

class Oi33ProblemDiscussionsHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        const [ddocs, dpcount] = await this.paginate(
            DiscussionModel.getMulti(domainId, { parentType: PROBLEM_TYPE, hidden: false }),
            page,
            'discussion',
        );
        const uids = [...new Set(ddocs.map((ddoc: any) => Number(ddoc.owner))
            .filter((uid) => Number.isSafeInteger(uid)))];
        const [udict, vndict, vnodes] = await Promise.all([
            uids.length ? UserModel.getList(domainId, uids) : {},
            DiscussionModel.getListVnodes(
                domainId, ddocs, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), this.user.group,
            ),
            DiscussionModel.getNodes(domainId),
        ]);
        this.response.template = 'oi33_problem_discussions.html';
        this.response.body = {
            ddocs, udict, vndict, vnodes, page, dpcount,
        };
    }
}

// 把 /discuss 的主列表改成只列「非题目」讨论。核心 DiscussionMainHandler 没有
// 导出，且查询条件写死在方法里，所以用 withHandlerClass 拿到类并整体替换 get
// （和 core 的实现保持逐行一致，只把 TYPE_PROBLEM 从 parentType $in 里去掉）。
export function applyDiscussionPatches(ctx: Context) {
    (ctx as any).withHandlerClass('DiscussionMain', (H: any) => {
        H.prototype.get = async function patchedDiscussionMain(this: any, rawArgs: any) {
            const domainId = rawArgs?.domainId || this.args?.domainId;
            const page = Math.max(1, Math.floor(Number(rawArgs?.page) || 1));
            // 与 @param('all', Types.Boolean) 等价的宽松解析。
            const rawAll = rawArgs?.all;
            let all = !!rawAll;
            if (typeof rawAll === 'string' && ['false', 'off', 'no', '0'].includes(rawAll.toLowerCase())) {
                all = false;
            }
            all &&= this.user.hasPerm(PERM.PERM_MOD_BADGE);
            const [ddocs, dpcount] = await this.paginate(
                DiscussionModel.getMulti(domainId, {
                    parentType: { $in: MAIN_LIST_TYPES },
                    ...(all ? {} : { hidden: false }),
                }).hint('discussionSort'),
                page,
                'discussion',
            );
            const udict = await UserModel.getList(domainId, ddocs.map((ddoc: any) => ddoc.owner));
            const [vndict, vnodes] = await Promise.all([
                DiscussionModel.getListVnodes(
                    domainId, ddocs, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), this.user.group,
                ),
                DiscussionModel.getNodes(domainId),
            ]);
            this.response.template = 'discussion_main_or_node.html';
            this.response.body = {
                ddocs,
                dpcount,
                udict,
                page,
                page_name: 'discussion_main',
                vndict,
                vnode: {},
                vnodes,
            };
        };
    });
}

export async function apply(ctx: Context) {
    applyDiscussionPatches(ctx);
    ctx.Route('oi33_problem_discussions', '/oi33/discuss/problem', Oi33ProblemDiscussionsHandler, PERM.PERM_VIEW_DISCUSSION);
}
