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

const DAY_MS = 24 * 60 * 60 * 1000;

// 列表卡片需要「最后回复人」和「回复新鲜度」，而 core 的 discussion 文档只存
// 了 updateAt / nReply。这里按列表批量补一次最后一条回复，供同一个 partial 使用。
async function decorateDiscussionRows(domainId: string, ddocs: any[]) {
    const now = Date.now();
    await Promise.all(ddocs.map(async (ddoc) => {
        let lastReply: { owner: number; at: Date } | null = null;
        if (Number(ddoc.nReply) > 0) {
            const [reply]: any[] = await DiscussionModel.getMultiReply(domainId, ddoc.docId)
                .limit(1).toArray();
            if (reply) lastReply = { owner: Number(reply.owner), at: ddoc.updateAt };
        }
        const age = ddoc.updateAt ? now - new Date(ddoc.updateAt).getTime() : Number.POSITIVE_INFINITY;
        ddoc.lastReply = lastReply;
        ddoc.listStatus = !lastReply
            ? 'gray'
            : age <= 3 * DAY_MS ? 'green' : age <= 7 * DAY_MS ? 'yellow' : 'gray';
    }));
    return ddocs;
}

function discussionListUids(ddocs: any[]) {
    const uids = new Set<number>();
    for (const ddoc of ddocs) {
        if (Number.isSafeInteger(Number(ddoc.owner))) uids.add(Number(ddoc.owner));
        if (Number.isSafeInteger(Number(ddoc.lastReply?.owner))) uids.add(Number(ddoc.lastReply.owner));
    }
    return [...uids];
}

class Oi33ProblemDiscussionsHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        const [ddocs, dpcount] = await this.paginate(
            DiscussionModel.getMulti(domainId, { parentType: PROBLEM_TYPE, hidden: false }),
            page,
            'discussion',
        );
        await decorateDiscussionRows(domainId, ddocs as any[]);
        const uids = discussionListUids(ddocs as any[]);
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
            await decorateDiscussionRows(domainId, ddocs as any[]);
            const uids = discussionListUids(ddocs as any[]);
            const udict = uids.length ? await UserModel.getList(domainId, uids) : {};
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

    // 讨论节点页（/discuss/contest/... 等）同样使用新列表；core 的类没有导出，
    // 包装 get 后补最后回复信息。
    (ctx as any).withHandlerClass('DiscussionNode', (H: any) => {
        const original = H.prototype.get;
        H.prototype.get = async function patchedDiscussionNode(this: any, ...args: any[]) {
            const result = await original.apply(this, args);
            const body = this.response?.body;
            const ddocs = body?.ddocs;
            if (Array.isArray(ddocs) && ddocs.length) {
                const domainId = this.args?.domainId || this.domain?._id || 'system';
                await decorateDiscussionRows(domainId, ddocs);
                const uids = discussionListUids(ddocs);
                const missing = uids.filter((uid) => !body.udict?.[uid]);
                if (missing.length) {
                    const extra = await UserModel.getList(domainId, missing);
                    body.udict = { ...(body.udict || {}), ...extra };
                }
            }
            return result;
        };
    });
}

export async function apply(ctx: Context) {
    applyDiscussionPatches(ctx);
    ctx.Route('oi33_problem_discussions', '/oi33/discuss/problem', Oi33ProblemDiscussionsHandler, PERM.PERM_VIEW_DISCUSSION);
}
