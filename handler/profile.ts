import {
    Handler, PRIV, Types, param, NotFoundError, ValidationError, ObjectId, ForbiddenError,
    UserModel, Context,
} from 'hydrooj';
import { oi33Model, Oi33RequestPayload, Oi33RequestKind } from '../model';

const COLOR_RE = /(^#?[0-9A-Fa-f]{6}$)|(^#?[0-9A-Fa-f]{3}$)/;
const KINDS: Oi33RequestKind[] = ['birthday', 'realname', 'badge', 'atcoder', 'codeforces'];

async function getIdentityRole(uid: number) {
    const doc = (await oi33Model.getUserDataByUids([uid]))[uid];
    return doc?.realname_flag ?? 0;
}

function canApproveRequest(role: number, request: any) {
    if (role < 2) return false;
    if (request.kind !== 'realname') return true;
    const targetRole = Number(request.realname_flag);
    return Number.isInteger(targetRole) && targetRole >= 0 && targetRole < role;
}

function buildPayload(
    kind: Oi33RequestKind,
    birthday_date: string, realname_flag: number, realname_name: string,
    badge_text: string, badge_color: string, badge_textColor: string,
    atcoder?: string, codeforces?: string,
): Oi33RequestPayload {
    if (kind === 'birthday') {
        if (birthday_date && !/^\d{4}-\d{2}-\d{2}$/.test(birthday_date)) {
            throw new ValidationError('birthday_date');
        }
        return { birthday_date };
    }
    if (kind === 'realname') {
        if (![0, 1, 2, 3].includes(realname_flag)) {
            throw new ValidationError('realname_flag');
        }
        return { realname_flag, realname_name };
    }
    if (kind === 'atcoder') {
        return { atcoder: atcoder || '' };
    }
    if (kind === 'codeforces') {
        return { codeforces: codeforces || '' };
    }
    // badge
    const cleanText = badge_text.replace(/'/g, '').replace(/"/g, '');
    if (cleanText) {
        if (!COLOR_RE.test(badge_color) || !COLOR_RE.test(badge_textColor)) {
            throw new ValidationError('badge_color');
        }
        return {
            badge_text: cleanText,
            badge_color: badge_color.replace('#', ''),
            badge_textColor: badge_textColor.replace('#', ''),
        };
    }
    return { badge_text: '' };
}

class ProfileEditHandler extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        const editorRole = await getIdentityRole(this.user._id);
        const isHydroSuperAdmin = this.user.hasPriv(PRIV.PRIV_ALL);
        if (uid !== this.user._id && editorRole < 2 && !isHydroSuperAdmin) throw new ForbiddenError('无权编辑其他用户。');
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new NotFoundError(uid);
        const oi33Doc: any = (await oi33Model.getUserDataByUids([uid]))[uid] || {};
        const pendingMap = await oi33Model.getUserPendingRequests(uid);
        const targetRole = oi33Doc.realname_flag ?? 0;
        const canEditRealname = isHydroSuperAdmin || editorRole !== 2 || uid === this.user._id || targetRole < 2;
        const maxRealnameFlag = isHydroSuperAdmin || editorRole >= 3
            ? 3
            : editorRole === 2 && uid === this.user._id ? 2 : editorRole === 2 ? 1 : 2;
        if (udoc.oi33_profile_hidden) oi33Model.anonymizeOi33Identity(udoc);
        this.response.template = 'oi33_profile_edit.html';
        this.response.body = {
            udoc, oi33Doc, pendingMap,
            isSelf: uid === this.user._id,
            canDirect: isHydroSuperAdmin || editorRole >= 2,
            canEditRealname,
            maxRealnameFlag,
        };
    }

    @param('uid', Types.Int)
    @param('kind', Types.String)
    @param('birthday_date', Types.String, true)
    @param('realname_flag', Types.Int, true)
    @param('realname_name', Types.String, true)
    @param('badge_text', Types.String, true)
    @param('badge_color', Types.String, true)
    @param('badge_textColor', Types.String, true)
    @param('atcoder', Types.String, true)
    @param('codeforces', Types.String, true)
    async post(
        domainId: string, uid: number, kind: string,
        birthday_date = '', realname_flag = 0, realname_name = '',
        badge_text = '', badge_color = '', badge_textColor = '',
        atcoder = '', codeforces = '',
    ) {
        const editorRole = await getIdentityRole(this.user._id);
        const isHydroSuperAdmin = this.user.hasPriv(PRIV.PRIV_ALL);
        if (uid !== this.user._id && editorRole < 2 && !isHydroSuperAdmin) throw new ForbiddenError('无权编辑其他用户。');
        if (!KINDS.includes(kind as Oi33RequestKind)) throw new ValidationError('kind');
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc) throw new NotFoundError(uid);

        const payload = buildPayload(
            kind as Oi33RequestKind,
            birthday_date, realname_flag, realname_name,
            badge_text, badge_color, badge_textColor,
            atcoder, codeforces,
        );

        if (!isHydroSuperAdmin && editorRole === 2 && kind === 'realname') {
            const targetRole = await getIdentityRole(uid);
            if (uid !== this.user._id && targetRole >= 2) {
                throw new ForbiddenError('管理员不能修改其他管理员或行政管理员的认证身份。');
            }
            if (realname_flag > (uid === this.user._id ? 2 : 1)) {
                throw new ForbiddenError('管理员无权设置该认证等级。');
            }
        }
        if (!isHydroSuperAdmin && editorRole < 2 && kind === 'realname' && realname_flag > 2) {
            throw new ForbiddenError('无权申请管理员身份。');
        }

        if (isHydroSuperAdmin || editorRole >= 2) {
            await oi33Model.directUpdate(uid, kind as Oi33RequestKind, this.user._id, payload);
            if (kind === 'realname' && realname_flag < 1) {
                (this.ctx as any).broadcast('oi33/cat-map-change', { type: 'remove', uid });
            }
        } else {
            await oi33Model.submitRequest(uid, kind as Oi33RequestKind, this.user._id, payload);
        }
        this.response.redirect = this.url('oi33_profile_edit', { uid });
    }
}

class RequestListHandler extends Handler {
    async get() {
        const approverRole = await getIdentityRole(this.user._id);
        if (approverRole < 2) throw new ForbiddenError('仅管理员和行政管理员可以处理审批。');
        const requests = await oi33Model.getPendingRequests();
        const uidSet = new Set<number>();
        for (const r of requests) {
            uidSet.add(r.uid);
            uidSet.add(r.requester);
        }
        const uids = Array.from(uidSet);
        const udict = await UserModel.getList('', uids);
        const oi33Dict = await oi33Model.getUserDataByUids(uids);
        this.response.template = 'oi33_requests.html';
        this.response.body = { requests, udict, oi33Dict, approverRole };
    }
}

class RequestApproveHandler extends Handler {
    @param('id', Types.ObjectId)
    async post(domainId: string, id: ObjectId) {
        const [approverRole, request] = await Promise.all([
            getIdentityRole(this.user._id),
            oi33Model.getRequestById(id),
        ]);
        if (!request || request.status !== 'pending') throw new ForbiddenError('申请不存在或已处理。');
        if (!canApproveRequest(approverRole, request)) {
            throw new ForbiddenError('当前身份无权批准该认证等级。');
        }
        const ok = await oi33Model.approveRequest(id, this.user._id);
        if (!ok) throw new ForbiddenError('申请不存在或已处理。');
        if (request.kind === 'realname' && request.realname_flag !== undefined && request.realname_flag < 1) {
            (this.ctx as any).broadcast('oi33/cat-map-change', { type: 'remove', uid: request.uid });
        }
        this.response.redirect = this.url('oi33_requests');
    }
}

class RequestRejectHandler extends Handler {
    @param('id', Types.ObjectId)
    async post(domainId: string, id: ObjectId) {
        const approverRole = await getIdentityRole(this.user._id);
        if (approverRole < 2) throw new ForbiddenError('仅管理员和行政管理员可以处理审批。');
        await oi33Model.rejectRequest(id, this.user._id);
        this.response.redirect = this.url('oi33_requests');
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_profile_edit', '/oi33/profile/edit/:uid', ProfileEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_requests', '/oi33/requests', RequestListHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_request_approve', '/oi33/requests/:id/approve', RequestApproveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_request_reject', '/oi33/requests/:id/reject', RequestRejectHandler, PRIV.PRIV_USER_PROFILE);
}
