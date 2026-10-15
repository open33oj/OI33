import { Context, DocumentModel, NotFoundError, ObjectId, PERM, SolutionModel } from 'hydrooj';
import { ProblemSolutionHandler, ProblemSolutionRawHandler } from 'hydrooj/src/handler/problem';
import { RecordMainConnectionHandler } from 'hydrooj/src/handler/record';
import { oi33Model } from '../../model';
import { cloneUserForDisplay } from './shared';

// Responses that bypass the UserModel patches (raw aggregations, websocket
// pushes) still have to be anonymized / masked before they reach the client.
export function applyDisplayPatches(ctx: Context) {
    // 题解列表顺序：精华题解在前、一般题解在后，两组内部都按投票数倒序。
    // Core 的 ProblemSolutionHandler 用 SolutionModel.getMulti 分页，所以直接
    // 换掉它的 sort 即可（缺省字段在 MongoDB 里等于 null，布尔值排在 null 之后，
    // 因此 `featured: -1` 正好把精华排在前面）。
    const origSolutionGetMulti = SolutionModel.getMulti;
    SolutionModel.getMulti = function patchedSolutionGetMulti(this: any, domainId: string, pid: number, query: any = {}) {
        return origSolutionGetMulti.call(this, domainId, pid, query).sort({ featured: -1, vote: -1 });
    } as any;

    // Keep user-detail JSON/template data anonymous. The original username/avatar
    // are stored as non-enumerable fields for the OI33 manager template exception.
    ctx.on('handler/after/UserDetail', (h: any) => {
        const udoc = h.response?.body?.udoc;
        if (udoc?.oi33_profile_hidden) oi33Model.anonymizeOi33Identity(udoc);
        // Unapproved/unreviewed bios must not leak through the template OR the
        // ?noTemplate=1 JSON response (which serializes udoc verbatim). The
        // template uses bio_hidden_pending to show the owner a hint instead.
        if (udoc?.bio && !udoc.bio_visible) {
            udoc.bio_hidden_pending = true;
            udoc.bio = '';
        }
        // The profile card renders the bio through bio_display, capped at 1KB;
        // bio_truncated lets the card explain the cut when the reader expands it.
        if (udoc) {
            const capped = oi33Model.bioTruncateForDisplay(udoc.bio);
            udoc.bio_display = capped.text;
            udoc.bio_truncated = capped.truncated;
        }
        // 资料页「最近题解」：审核中的题解只对本人与 OI33 flag>=2 可见，
        // 其余访客连链接都拿不到。
        const psdocs = h.response?.body?.psdocs;
        if (Array.isArray(psdocs)) {
            const viewerUid = Number(h.user?._id) || 0;
            const viewerIsStaff = (Number(h.user?.realname_flag) || 0) >= 2;
            h.response.body.psdocs = psdocs.filter((psdoc: any) => (
                !psdoc?.hidden || viewerIsStaff || Number(psdoc.owner) === viewerUid
            ));
        }
    });

    // Problem solutions (题解) share the discussion moderation pipeline: the
    // moderation hooks publish them hidden and let the AI/human decide. Core
    // does not filter the `hidden` flag in the solution views, so mask them
    // here — pending content is served to nobody but its author and OI33 staff.
    const solutionPrivileged = (h: any) => (Number(h.user?.realname_flag) || 0) >= 2
        || !!h.user?.hasPerm?.(PERM.PERM_EDIT_PROBLEM_SOLUTION);
    const maskHiddenSolution = (doc: any, uid: number, privileged: boolean) => {
        if (!doc?.hidden) return doc;
        if (privileged) return { ...doc, content: `（审核中） ${doc.content}` };
        if (Number(doc.owner) === uid) return { ...doc, content: '（审核中，审核通过后将显示）' };
        return null;
    };
    const origSolutionGet = ProblemSolutionHandler.prototype.get;
    ProblemSolutionHandler.prototype.get = async function patchedSolutionGet(this: any, rawArgs: any) {
        const result = await origSolutionGet.call(this, rawArgs);
        const body = this.response?.body;
        if (!body || !Array.isArray(body.psdocs)) return result;
        const uid = Number(this.user?._id) || 0;
        const privileged = solutionPrivileged(this);
        body.psdocs = body.psdocs.map((psdoc: any) => {
            const doc = maskHiddenSolution(psdoc, uid, privileged);
            if (!doc) return null;
            if (Array.isArray(doc.reply)) {
                doc.reply = doc.reply
                    .map((reply: any) => maskHiddenSolution(reply, uid, privileged))
                    .filter(Boolean);
            }
            return doc;
        }).filter(Boolean);
        // A hidden solution opened by direct link must 404 for outsiders.
        if (body.sid && !body.psdocs.length) throw new NotFoundError('Solution');
        return result;
    };

    const origSolutionRawGet = ProblemSolutionRawHandler.prototype.get;
    ProblemSolutionRawHandler.prototype.get = async function patchedSolutionRawGet(this: any, rawArgs: any) {
        const domainId = rawArgs?.domainId || this.args?.domainId;
        if (rawArgs?.psid) {
            const psid = new ObjectId(String(rawArgs.psid));
            const psdoc: any = await DocumentModel.get(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid);
            if (psdoc) {
                const uid = Number(this.user?._id) || 0;
                const privileged = solutionPrivileged(this);
                if (rawArgs.psrid) {
                    const psrid = new ObjectId(String(rawArgs.psrid));
                    const reply = (psdoc.reply || []).find((r: any) => r._id.equals(psrid));
                    if (reply?.hidden && Number(reply.owner) !== uid && !privileged) {
                        throw new NotFoundError('Solution');
                    }
                } else if (psdoc.hidden && Number(psdoc.owner) !== uid && !privileged) {
                    throw new NotFoundError('Solution');
                }
            }
        }
        return (origSolutionRawGet as any).call(this, rawArgs);
    };

    // /domain/user builds its user list with a raw aggregation on domain.user,
    // bypassing the patched UserModel.getList. Without oi33 fields the overridden
    // user.html macro renders everyone as "UID xxx". Hydrate identity fields here.
    // (Event names strip the "Handler" suffix: DomainUserHandler -> DomainUser.)
    ctx.on('handler/after/DomainUser', async (h: any) => {
        const rudocs = h.response?.body?.rudocs;
        if (!rudocs || typeof rudocs !== 'object') return;
        const udocs: any[] = Object.values(rudocs).flat()
            .filter((udoc: any) => udoc && Number.isFinite(Number(udoc._id)));
        if (!udocs.length) return;
        // rudocs are plain objects: ?noTemplate=1 serializes them verbatim, so
        // only viewers with OI33 flag >= 2 may receive real names (same rule
        // as the user.html macro).
        const viewerIsAdmin = (Number(h.user?.realname_flag) || 0) >= 2;
        const oi33Dict = await oi33Model.getUserDataByUids(udocs.map((udoc) => Number(udoc._id)));
        for (const udoc of udocs) {
            oi33Model.mergeOi33Fields(udoc, oi33Dict[Number(udoc._id)], ['realname']);
            if (!viewerIsAdmin) udoc.realname_name = '';
            oi33Model.anonymizeOi33Identity(udoc);
        }
    });

    // RecordListHandler and its WebSocket connection render rows through
    // different code paths. Normalize the HTTP response explicitly so the
    // first paint cannot expose a username before the socket replaces a row.
    ctx.on('handler/after/RecordList', async (h: any) => {
        const udict = h.response?.body?.udict;
        if (!udict || typeof udict !== 'object') return;
        const viewerUid = Number(h.user?._id) || 0;
        const uids = [...new Set([
            viewerUid,
            ...Object.keys(udict).map(Number).filter(Number.isFinite),
        ].filter(Boolean))];
        if (!uids.length) return;
        const oi33Dict = await oi33Model.getUserDataByUids(uids);
        if (viewerUid && h.user) {
            const viewer = cloneUserForDisplay(h.user);
            oi33Model.mergeOi33Fields(viewer, oi33Dict[viewerUid]);
            h.user = viewer;
            if (h.context?.HydroContext) h.context.HydroContext.user = viewer;
        }
        for (const uid of uids) {
            if (!udict[uid]) continue;
            const original = udict[uid];
            const udoc = cloneUserForDisplay(original);
            oi33Model.mergeOi33Fields(udoc, oi33Dict[uid]);
            oi33Model.anonymizeOi33Identity(udoc);
            udict[uid] = udoc;
        }
    });

    // WebSocket connections do not pass through the normal HTTP user layer.
    // Hydrate both the viewer and row owner immediately before rendering a
    // pushed record row, so real-name visibility follows the same rule as the
    // initial page render.
    const origRecordConnectionRender = (RecordMainConnectionHandler.prototype as any).renderHTML;
    (RecordMainConnectionHandler.prototype as any).renderHTML = async function (template: string, body: any) {
        if (template === 'record_main_tr.html') {
            const viewerUid = Number(this.user?._id) || 0;
            const ownerUid = Number(body?.udoc?._id) || 0;
            const uids = [...new Set([viewerUid, ownerUid].filter(Boolean))];
            const oi33Dict = uids.length ? await oi33Model.getUserDataByUids(uids) : {};
            if (viewerUid && this.user) {
                const viewer = cloneUserForDisplay(this.user);
                oi33Model.mergeOi33Fields(viewer, oi33Dict[viewerUid]);
                this.user = viewer;
            }
            if (ownerUid && body?.udoc) {
                const owner = cloneUserForDisplay(body.udoc);
                oi33Model.mergeOi33Fields(owner, oi33Dict[ownerUid]);
                oi33Model.anonymizeOi33Identity(owner);
                body = { ...body, udoc: owner };
            }
        }
        return origRecordConnectionRender.call(
            this,
            template === 'record_main_tr.html' ? 'oi33_record_main_tr.html' : template,
            body,
        );
    };
}
