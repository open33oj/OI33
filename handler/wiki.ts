import {
    Handler, PRIV, Types, param, query, NotFoundError, ForbiddenError, Context,
} from 'hydrooj';
import { oi33Model } from '../model';

// --- Wiki public pages ---

class WikiMainHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const { docs, upcount } = await oi33Model.wikiGetApproved(undefined, page, 20);
        const categories = await oi33Model.wikiCatGetAll();
        const bulletinDoc = await oi33Model.wikiGetOrCreateIndex();
        this.response.template = 'oi33_wiki_main.html';
        this.response.body = {
            docs, upcount, page, categories,
            bulletin: bulletinDoc,
        };
    }
}

class WikiPagesHandler extends Handler {
    @query('category', Types.String, true)
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, category?: string, page = 1) {
        const { docs, upcount } = await oi33Model.wikiGetApproved(category, page, 20);
        const categories = await oi33Model.wikiCatGetAll();
        this.response.template = 'oi33_wiki_pages.html';
        this.response.body = { docs, upcount, page, categories, category };
    }
}

class WikiShowHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        const doc = await oi33Model.wikiGet(id);
        if (!doc) throw new NotFoundError(id);
        this.UiContext.extraTitleContent = doc.title;
        const categories = await oi33Model.wikiCatGetAll();
        const catDict: Record<string, string> = {};
        for (const c of categories) catDict[c._id] = c.name;
        this.response.template = 'oi33_wiki_show.html';
        this.response.body = { doc, catDict, categories };
    }
}

// --- Wiki editing ---

class WikiEditHandler extends Handler {
    @param('id', Types.String, true)
    async get(domainId: string, id?: string) {
        this.checkPriv(PRIV.PRIV_MOD_BADGE);
        const categories = await oi33Model.wikiCatGetAll();
        let doc: any = null;
        if (id) {
            doc = await oi33Model.wikiGet(id);
            if (!doc) throw new NotFoundError(id);
        }
        this.response.template = 'oi33_wiki_edit.html';
        this.response.body = { doc, categories };
    }

    @param('id', Types.String, true)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('category', Types.String)
    async post(domainId: string, id: string | undefined, title: string, content: string, category: string) {
        this.checkPriv(PRIV.PRIV_MOD_BADGE);
        if (id) {
            const doc = await oi33Model.wikiGet(id);
            if (!doc) throw new NotFoundError(id);
            await oi33Model.wikiEdit(id, this.user._id, title, content, category);
            this.response.redirect = this.url('oi33_wiki_show', { id });
        } else {
            const newId = await oi33Model.wikiAdd(this.user._id, title, content, category);
            this.response.redirect = this.url('oi33_wiki_show', { id: newId });
        }
    }
}

// --- Export/Import ---

class WikiExportHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        const doc = await oi33Model.wikiGet(id);
        if (!doc) throw new NotFoundError(id);
        const data = JSON.stringify({ _id: doc._id, title: doc.title, content: doc.content, category: doc.category }, null, 2);
        this.binary(data, `${doc.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')}.json`);
    }
}

class WikiBulkExportHandler extends Handler {
    @query('category', Types.String, true)
    async get(domainId: string, category?: string) {
        const { docs } = await oi33Model.wikiGetApproved(category, 1, 9999);
        const data = JSON.stringify(docs.map((d: any) => ({
            _id: d._id, title: d.title, content: d.content, category: d.category,
        })), null, 2);
        this.binary(data, `wiki_export${category ? '_' + category : ''}.json`);
    }
}

class WikiImportHandler extends Handler {
    async post() {
        this.checkPriv(PRIV.PRIV_MOD_BADGE);
        let pages: { _id?: string; title: string; content: string; category: string }[];

        // Support direct JSON body (avoids textarea copy-paste backslash loss)
        const contentType = (this.request.headers as any)?.['content-type'] || '';
        if (contentType.includes('application/json')) {
            pages = (this.request.body as any);
            if (!Array.isArray(pages)) pages = [pages];
        } else {
            const raw = (this.request.body as any).__raw_body;
            if (raw) {
                try {
                    pages = JSON.parse(raw);
                    if (!Array.isArray(pages)) pages = [pages];
                } catch (e: any) {
                    throw new Error(`Invalid JSON in textarea: ${e.message}. Paste JSON or upload a .json file.`);
                }
            }
            // Try file upload
            const files = (this.request as any).files || {};
            const file = files.file;
            if (!pages && file && file.filepath) {
                try {
                    const fs = require('fs');
                    const raw2 = fs.readFileSync(file.filepath, 'utf-8');
                    pages = JSON.parse(raw2);
                    if (!Array.isArray(pages)) pages = [pages];
                } catch (e: any) {
                    throw new Error(`Invalid JSON in uploaded file: ${e.message}`);
                }
            }
            if (!pages) {
                throw new Error('Invalid JSON. Paste JSON or upload a .json file.');
            }
        }
        const existingCats = await oi33Model.wikiCatGetAll();
        const existingSlugs = new Set(existingCats.map((c) => c._id));
        const newCats = [...new Set(pages.map((p) => p.category || 'other'))]
            .filter((s) => !existingSlugs.has(s));
        for (const slug of newCats) {
            await oi33Model.wikiCatAdd(slug, slug, 0);
        }
        let imported = 0;
        for (const p of pages) {
            if (!p.title || !p.content) continue;
            const cat = p.category || 'other';
            if (p._id) {
                await oi33Model.wikiImport(this.user._id, p._id, p.title, p.content, cat);
            } else {
                await oi33Model.wikiAdd(this.user._id, p.title, p.content, cat);
            }
            imported++;
        }
        this.response.redirect = this.url('oi33_wiki_main');
    }
}

class WikiBulkImportHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_MOD_BADGE);
        this.response.template = 'oi33_wiki_import.html';
    }
}

class WikiCategoriesHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_MOD_BADGE);
        const categories = await oi33Model.wikiCatGetAll();
        this.response.template = 'oi33_wiki_categories.html';
        this.response.body = { categories };
    }

    @param('action', Types.String)
    @param('slug', Types.String, true)
    @param('name', Types.String, true)
    @param('order', Types.Int, true)
    async post(domainId: string, action: string, slug?: string, name?: string, order?: number) {
        this.checkPriv(PRIV.PRIV_MOD_BADGE);
        if (action === 'add' && name) {
            const s = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            await oi33Model.wikiCatAdd(s, name, order || 0);
        } else if (action === 'edit' && slug && name) {
            await oi33Model.wikiCatEdit(slug, name, order || 0);
        } else if (action === 'delete' && slug) {
            const r = await oi33Model.wikiCatDelete(slug);
            if (!r.ok) throw new ForbiddenError(`Cannot delete: ${r.count} page(s) use this category.`);
        }
        this.response.redirect = this.url('oi33_wiki_categories');
    }
}

class WikiDeleteHandler extends Handler {
    @param('id', Types.String)
    async post(domainId: string, id: string) {
        this.checkPriv(PRIV.PRIV_MOD_BADGE);
        if (id === 'index') throw new ForbiddenError('Cannot delete the wiki index page.');
        const ok = await oi33Model.wikiDelete(id, this.user._id);
        if (!ok) throw new NotFoundError(id);
        this.response.redirect = this.url('oi33_wiki_main');
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_wiki_main', '/oi33/wiki', WikiMainHandler);
    ctx.Route('oi33_wiki_pages', '/oi33/wiki/pages', WikiPagesHandler);
    ctx.Route('oi33_wiki_create', '/oi33/wiki/create', WikiEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_wiki_bulk_export', '/oi33/wiki/export', WikiBulkExportHandler);
    ctx.Route('oi33_wiki_bulk_import', '/oi33/wiki/import', WikiBulkImportHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_wiki_import_submit', '/oi33/wiki/import/submit', WikiImportHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_wiki_categories', '/oi33/wiki/categories', WikiCategoriesHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_wiki_show', '/oi33/wiki/:id', WikiShowHandler);
    ctx.Route('oi33_wiki_edit', '/oi33/wiki/:id/edit', WikiEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_wiki_export_single', '/oi33/wiki/:id/export', WikiExportHandler);
    ctx.Route('oi33_wiki_delete', '/oi33/wiki/:id/delete', WikiDeleteHandler, PRIV.PRIV_MOD_BADGE);
}
