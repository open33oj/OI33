import { Context, UserModel, moment } from 'hydrooj';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { HomeHandler } from 'hydrooj/src/handler/home';
import { RecordMainConnectionHandler } from 'hydrooj/src/handler/record';
import { oi33Model } from '../model';

export function applyPatches(_ctx: Context) {
    // OI33 fields merged by mergeOi33Fields that should survive Hydro's JSON
    // serialization. Hydro's framework serializer calls User.serialize(), which
    // picks only getFields() (base fields + _publicFields), silently dropping
    // every oi33 field from noTemplate JSON responses (e.g. /user/:uid via API
    // token). Registering them on the clone's _publicFields makes serialize()
    // include them; templates already read them directly and are unaffected.
    const OI33_SERIALIZE_FIELDS = [
        'oi33_profile_hidden',
        'coin_now', 'coin_all',
        'cat_food', 'cat_can',
        'birthday_date',
        'realname_flag', 'realname_name',
        'badge',
        'atcoder', 'atcoder_rating', 'atcoder_updated_at',
        'codeforces', 'codeforces_rating', 'codeforces_updated_at',
    ];

    function cloneUserForDisplay<T>(udoc: T): T {
        if (!udoc || typeof udoc !== 'object') return udoc;
        const clone: T = Object.create(
            Object.getPrototypeOf(udoc),
            Object.getOwnPropertyDescriptors(udoc),
        );
        const fields = (clone as any)._publicFields;
        if (Array.isArray(fields)) {
            (clone as any)._publicFields = fields.concat(
                OI33_SERIALIZE_FIELDS.filter((f) => !fields.includes(f)),
            );
        }
        // realname_name is sensitive: templates only render it to viewers with
        // OI33 flag >= 2. Apply the same rule to JSON serialization, otherwise
        // registering it in _publicFields above would leak real names to anyone.
        // The override MUST be non-enumerable: handlers like /home/messages
        // spread the udoc ({ ...udoc, avatarUrl }) into a plain object, and an
        // enumerable serialize would be copied along; the framework JSON
        // serializer ('serialize' in v) then calls it with the plain object as
        // `this` and crashes with "this.getFields is not a function".
        const origSerialize = (clone as any).serialize;
        if (typeof origSerialize === 'function') {
            Object.defineProperty(clone, 'serialize', {
                configurable: true,
                enumerable: false,
                writable: true,
                value: function serialize(h?: any) {
                    const result = origSerialize.call(this, h);
                    if (result && (Number(h?.user?.realname_flag) || 0) < 2) {
                        delete result.realname_name;
                    }
                    return result;
                },
            });
        }
        // Likewise, once the serialize override is lost through a spread, a
        // plain-enumerable realname_name would leak real names into JSON
        // verbatim. Define it non-enumerable up front; the later
        // mergeOi33Fields assignment keeps the attributes (writable), while
        // templates and pick() inside serialize() still read it normally.
        // (Same trick as the getListForRender patch below.)
        Object.defineProperty(clone, 'realname_name', {
            configurable: true,
            enumerable: false,
            writable: true,
            value: (clone as any).realname_name || '',
        });
        return clone;
    }

    // (a) UserModel.getList — merge oi33_user fields into udoc
    // getList returns User instances with hasPriv(), used by pages that render user.html
    const origGetList = UserModel.getList;
    UserModel.getList = async function (domainId: string, uids: number[]) {
        const udict = await origGetList.call(UserModel, domainId, uids);
        if (!uids.length) return udict;
        const oi33Dict = await oi33Model.getUserDataByUids(uids);
        for (const uid of uids) {
            const oi33 = oi33Dict[uid];
            const original = udict[uid];
            if (!original) continue;
            const u = cloneUserForDisplay(original);
            udict[uid] = u;
            oi33Model.mergeOi33Fields(u, oi33);
            oi33Model.anonymizeOi33Identity(u);
        }
        return udict;
    };

    // (b) UserModel.getListForRender — merge oi33_user fields into udoc
    // getListForRender returns plain objects without hasPriv(); used for lightweight rendering
    const origGetListForRender = UserModel.getListForRender;
    UserModel.getListForRender = async function (domainId: string, uids: number[]) {
        const udict = await origGetListForRender.call(UserModel, domainId, uids);
        if (!uids.length) return udict;
        const oi33Dict = await oi33Model.getUserDataByUids(uids);
        for (const uid of uids) {
            const oi33 = oi33Dict[uid];
            const original = udict[uid];
            if (!original) continue;
            const u = cloneUserForDisplay(original);
            udict[uid] = u;
            oi33Model.mergeOi33Fields(u, oi33);
            oi33Model.anonymizeOi33Identity(u);
            // This path has no viewer context and its consumers (contest/training
            // scoreboards etc.) can be serialized as-is via ?noTemplate=1, so the
            // sensitive real name must not be enumerable: keep it readable by
            // templates (the user macro gates on the viewer's flag) but hidden
            // from JSON.stringify — the same trick as oi33_original_uname.
            Object.defineProperty(u, 'realname_name', {
                configurable: true,
                enumerable: false,
                writable: true,
                value: u.realname_name || '',
            });
        }
        return udict;
    };

    // (b2) UserModel.getById — merge oi33_user fields so user_detail.html sees them
    // user_detail handler uses getById, which is NOT covered by getList patch
    const origGetById = UserModel.getById;
    UserModel.getById = async function (domainId: string, _id: number, scope?: any) {
        const original = await origGetById.call(UserModel, domainId, _id, scope);
        if (!original) return original;
        const udoc = cloneUserForDisplay(original);
        const oi33 = (await oi33Model.getUserDataByUids([_id]))[_id];
        oi33Model.mergeOi33Fields(udoc, oi33);
        oi33Model.anonymizeOi33Identity(udoc);
        return udoc;
    };

    // (b3) User.prototype.private — the userLayer loads the session user through
    // getById and then rebuilds it with private(), which constructs a fresh User
    // from raw _udoc and therefore drops every OI33 field. The nav's admin gate
    // (`handler.user.realname_flag >= 2`) only works because handler/before
    // re-merges the fields later — but any page rendered as an error before
    // handler/before runs (route checker, prepare, pendingError) shows the
    // dropdown without the OI33 admin button. Merging here keeps the fields on
    // HydroContext.user from the start so every render path (including error
    // pages) sees them. The handler/before merge stays as an idempotent fallback
    // for objects that are replaced after creation (e.g. token users, record rows).
    const origPrivate = (UserModel as any).User?.prototype?.private;
    if (typeof origPrivate === 'function') {
        (UserModel as any).User.prototype.private = async function () {
            const user = await origPrivate.call(this);
            const uid = (this as any)._id;
            if (Number.isFinite(Number(uid))) {
                const oi33 = (await oi33Model.getUserDataByUids([Number(uid)]))[Number(uid)];
                oi33Model.mergeOi33Fields(user, oi33);
            }
            return user;
        };
    }

    // (c) HomeHandler.prototype.getCheckin — inject checkin data into homepage
    HomeHandler.prototype.getCheckin = async function (domainId: string, payload: any) {
        const today = moment().format('YYYY-MM-DD');
        payload.luck_today = today;
        if (this.user && this.user._id) {
            const oi33User = await oi33Model.getCheckinUser(this.user._id);
            payload.oi33_checkin_flag = oi33User ? (oi33User.realname_flag ?? 0) : 0;
            if (oi33User && oi33User.checkin_time) {
                payload.oi33_checkin = {
                    time: oi33User.checkin_time,
                    luck: oi33User.checkin_luck ?? 0,
                    cnt_now: oi33User.checkin_cnt_now ?? 0,
                    cnt_all: oi33User.checkin_cnt_all ?? 0,
                };
            }
        }
        return payload;
    };

    // (d) HomeHandler.prototype.getCountdown — inject countdown data into homepage
    HomeHandler.prototype.getCountdown = async function (domainId: string, payload: any) {
        function formatDate(date: Date) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        function calculateDiffDays(targetDate: Date) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const timeDiff = targetDate.getTime() - today.getTime();
            return Math.floor(timeDiff / (1000 * 60 * 60 * 24));
        }

        const content: any[] = [];
        const dateToday = formatDate(new Date());
        const dates: any[] = payload.dates || [];
        dates.forEach(function (val: any) {
            if (content.length < (payload.max_dates || 10)) {
                const targetDate = new Date(val.date);
                targetDate.setHours(0, 0, 0, 0);
                const todayDate = new Date(dateToday);
                todayDate.setHours(0, 0, 0, 0);
                if (targetDate >= todayDate) {
                    const diffTime = calculateDiffDays(targetDate);
                    content.push({ name: val.name, diff: diffTime });
                }
            }
        });
        payload.dates = content;
        return payload;
    };

    // (f) nunjucks template-cache guard for oi33 template overrides
    // Hydro's worker calls server.listen() as soon as the server service is
    // ready (entry/worker.ts), long before ui-default's TemplateService
    // finishes reading addon template files into its registry (async
    // Service.init). A page rendered in that window compiles shared template
    // names (components/user.html, layout/html5.html, ...) from ui-default's
    // original content, and the production loader (noCache: false) keeps that
    // compiled version in loader.cache for the rest of the process lifetime:
    // every oi33 template override silently stops applying until the next
    // restart (the ranking table loses the [realname] prefix, identity icons
    // and anonymization). Guard: for every template oi33 ships, drop the
    // compiled cache entry until the registry provably holds oi33's file
    // content; once verified, the guard stops touching that name.
    const oi33Templates: Record<string, string> = {};
    const walkTemplates = (dir: string, base = '') => {
        for (const entry of fs.readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (fs.statSync(full).isDirectory()) walkTemplates(full, path.join(base, entry));
            else oi33Templates[path.join(base, entry).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf-8');
        }
    };
    walkTemplates(path.resolve(__dirname, '../templates'));

    let templateService: any = null;
    (_ctx as any).inject(['template'], (c: any) => { templateService = c.template; });

    const templateGuardStart = Date.now();
    const TEMPLATE_GUARD_TIMEOUT = 120 * 1000;
    const verifiedTemplates = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nunjucks = require('nunjucks');
    const origGetTemplate = nunjucks.Environment.prototype.getTemplate;
    nunjucks.Environment.prototype.getTemplate = function getTemplate(this: any, name: any, ...rest: any[]) {
        const key = name && name.raw ? name.raw : name;
        if (typeof key === 'string' && oi33Templates[key] !== undefined && !verifiedTemplates.has(key)) {
            for (const loader of this.loaders || []) {
                if (loader.cache) delete loader.cache[key];
            }
            if (templateService?.registry?.[key] === oi33Templates[key]
                || Date.now() - templateGuardStart > TEMPLATE_GUARD_TIMEOUT) {
                verifiedTemplates.add(key);
            }
        }
        return origGetTemplate.call(this, name, ...rest);
    };

    // Keep user-detail JSON/template data anonymous. The original username/avatar
    // are stored as non-enumerable fields for the OI33 manager template exception.
    _ctx.on('handler/after/UserDetail', (h: any) => {
        const udoc = h.response?.body?.udoc;
        if (udoc?.oi33_profile_hidden) oi33Model.anonymizeOi33Identity(udoc);
        // Unapproved/unreviewed bios must not leak through the template OR the
        // ?noTemplate=1 JSON response (which serializes udoc verbatim). The
        // template uses bio_hidden_pending to show the owner a hint instead.
        if (udoc?.bio && !udoc.bio_visible) {
            udoc.bio_hidden_pending = true;
            udoc.bio = '';
        }
    });

    // /domain/user builds its user list with a raw aggregation on domain.user,
    // bypassing the patched UserModel.getList. Without oi33 fields the overridden
    // user.html macro renders everyone as "UID xxx". Hydrate identity fields here.
    // (Event names strip the "Handler" suffix: DomainUserHandler -> DomainUser.)
    _ctx.on('handler/after/DomainUser', async (h: any) => {
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
    _ctx.on('handler/after/RecordList', async (h: any) => {
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

    // (e) Bearer token auth — Hydro v5 uses event-based handler lifecycle
    // 'handler/before' is fired after prepare() but before get()/post()
    const READONLY_METHODS = new Set(['get', 'head', 'options']);

    // Route whitelist: only these paths are accessible via token.
    // Regex allows exact match or prefix match (trailing / or end-of-string).
    const READONLY_ROUTE_PATTERNS = [
        /^\/record(\/|$)/,
        /^\/p(\/|$)/,
        /^\/contest(\/|$)/,
        /^\/homework(\/|$)/,
        /^\/user\//,
        /^\/ranking(\/|$)/,
        /^\/discuss(\/|$)/,
        /^\/training(\/|$)/,
        /^\/oi33\/users(\/|$)/,
        /^\/oi33\/birthday(\/|$)/,
        /^\/oi33\/badge$/,
        /^\/oi33\/badge\/manage$/,
        /^\/oi33\/at-cf-rating(\/|$)/,
        /^\/oi33\/paste\/show\//,
        /^\/oi33\/paste\/manage(\/|$)/,
        /^\/oi33\/paste\/all(\/|$)/,
        /^\/oi33\/coin\/bill\//,
        /^\/oi33\/cat-food\/bill\//,
        /^\/oi33\/admin(\/|$)/,
        /^\/oi33\/requests(\/|$)/,
        /^\/oi33\/tokens(\/|$)/,
    ];

    function isReadonlyRoute(path: string): boolean {
        return READONLY_ROUTE_PATTERNS.some((re) => re.test(path));
    }

    async function verifyBearerToken(authHeader: string, domainId: string) {
        if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
        const rawToken = authHeader.slice(7).trim();
        if (!rawToken) return null;
        const hash = createHash('sha256').update(rawToken).digest('hex');
        const doc = await oi33Model.getTokenByHash(hash);
        if (!doc) return null;
        if (doc.expiresAt && new Date(doc.expiresAt) < new Date()) return null;
        if (!doc.domains.includes('*') && !doc.domains.includes(domainId)) return null;
        await oi33Model.touchToken(doc._id);
        return doc;
    }

    // Token user injection MUST happen at 'handler/create', not 'handler/before'.
    // Hydro's own gates run before 'handler/before' and would see a guest:
    //   handler/create/http -> PERM_VIEW gate (rejects guests on private domains,
    //                          redirecting to /login before the token is even read)
    //   route checker       -> route-level checkPriv/checkPerm
    //   prepare()           -> per-handler permission checks
    // That ordering made tokens work on the main domain (guests can view) but
    // fail on any domain where guests lack PERM_VIEW.
    _ctx.on('handler/create', async (h: any, type?: string) => {
        if (type && type !== 'http') return;

        const auth = h.request.headers.authorization;
        if (!auth || !auth.startsWith('Bearer ')) return;
        const rawToken = auth.slice(7).trim();
        // Only intercept OI33 API tokens; other Bearer values (e.g. Hydro
        // session ids) are handled by Hydro's own auth machinery.
        if (!rawToken.startsWith('33tok_')) return;

        // OAuth provider endpoints manage their own Bearer auth (access tokens
        // live in oi33_oauth_token, not oi33_token). Skip the API-token check
        // so those handlers can verify tokens themselves.
        if (typeof h.request.path === 'string' && h.request.path.startsWith('/oi33/oauth/')) {
            return;
        }

        const domainId = h.context?.HydroContext?.domain?._id
            || h.domain?._id || h.args?.domainId || 'system';
        const tokenDoc = await verifyBearerToken(auth, domainId);
        if (!tokenDoc) throw new Error('Invalid or expired token');

        // Load the token owner with the REAL domain id, otherwise dudoc/perm
        // come from domain '' and domain-level checkPerm/domain_join breaks.
        const udoc = await UserModel.getById(domainId, tokenDoc.uid);
        if (!udoc) throw new Error('Invalid token user');

        h.user = udoc;
        h.user.__oi33_token_readonly = true;
        if (h.context?.HydroContext) h.context.HydroContext.user = udoc;

        if (!READONLY_METHODS.has(h.request.method)) {
            throw new Error('Read-only token cannot perform write operations');
        }
        if (!isReadonlyRoute(h.request.path)) {
            throw new Error('This route is not available via token');
        }
    });

    _ctx.on('handler/before', async (h: any) => {
        if (h.user?._id) {
            const oi33 = (await oi33Model.getUserDataByUids([h.user._id]))[h.user._id];
            oi33Model.mergeOi33Fields(h.user, oi33);
        }
    });

}
