import {
    UserModel,
    Handler, PRIV, Types, param, query, NotFoundError, Context,
} from 'hydrooj';
import { oi33Model } from '../model';

// --- Pastebin handlers ---

class PasteCreateHandler extends Handler {
    async get() {
        this.response.template = 'oi33_paste_create.html';
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('isprivate', Types.Boolean)
    async post(domainId: string, title: string, content: string, isprivate = false) {
        const pasteid = await oi33Model.pasteAdd(this.user._id, title, content, !!isprivate);
        this.response.redirect = this.url('oi33_paste_show', { id: pasteid });
    }
}

class PasteEditHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        const doc = await oi33Model.pasteGet(id);
        if (!doc) throw new NotFoundError(id);
        if (this.user._id !== doc.owner) this.checkPriv(PRIV.PRIV_MOD_BADGE);
        this.response.body = { doc };
        this.response.template = 'oi33_paste_edit.html';
    }

    @param('pasteId', Types.String)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('isprivate', Types.Boolean)
    async post(domainId: string, pasteId: string, title: string, content: string, isprivate = false) {
        const doc = await oi33Model.pasteGet(pasteId);
        if (!doc) throw new NotFoundError(pasteId);
        if (this.user._id !== doc.owner) this.checkPriv(PRIV.PRIV_MOD_BADGE);
        await oi33Model.pasteEdit(pasteId, doc.owner, title, content, !!isprivate);
        this.response.redirect = this.url('oi33_paste_show', { id: pasteId });
    }
}

class PasteShowHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        const doc = await oi33Model.pasteGet(id);
        if (!doc) throw new NotFoundError(id);
        if (doc.isprivate && this.user._id !== doc.owner) this.checkPriv(PRIV.PRIV_MOD_BADGE);
        const udoc = await UserModel.getById(domainId, doc.owner);
        this.response.body = { doc, udoc };
        this.response.template = 'oi33_paste_show.html';
    }
}

class PasteDeleteHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        const doc = await oi33Model.pasteGet(id);
        if (!doc) throw new NotFoundError(id);
        if (this.user._id !== doc.owner) this.checkPriv(PRIV.PRIV_MOD_BADGE);
        this.response.body = { doc };
        this.response.template = 'oi33_paste_delete.html';
    }

    @param('pasteId', Types.String)
    async post(domainId: string, pasteId: string) {
        const doc = await oi33Model.pasteGet(pasteId);
        if (!doc) throw new NotFoundError(pasteId);
        if (this.user._id !== doc.owner) this.checkPriv(PRIV.PRIV_MOD_BADGE);
        await oi33Model.pasteDel(pasteId);
        this.response.redirect = this.url('oi33_paste_manage');
    }
}

class PasteManageHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const dcount = await oi33Model.pasteCountUser(this.user._id);
        const upcount = Math.ceil(dcount / 20);
        const doc = await oi33Model.pasteGetUser(this.user._id, 20, page);
        this.response.body = { doc, all: false, page, upcount };
        this.response.template = 'oi33_paste_manage.html';
    }
}

class PasteAllHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const dcount = await oi33Model.pasteCountUser(0);
        const upcount = Math.ceil(dcount / 20);
        const doc = await oi33Model.pasteGetUser(0, 20, page);
        this.response.body = { doc, all: true, page, upcount };
        this.response.template = 'oi33_paste_manage.html';
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_paste_create', '/oi33/paste/create', PasteCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_paste_manage', '/oi33/paste/manage', PasteManageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_paste_all', '/oi33/paste/all', PasteAllHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_paste_show', '/oi33/paste/show/:id', PasteShowHandler);
    ctx.Route('oi33_paste_edit', '/oi33/paste/show/:id/edit', PasteEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_paste_del', '/oi33/paste/show/:id/delete', PasteDeleteHandler, PRIV.PRIV_USER_PROFILE);
}
