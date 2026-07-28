import { Context, UserModel, moment } from 'hydrooj';
import { createHash } from 'crypto';
import { HomeHandler } from 'hydrooj/src/handler/home';
import { RecordMainConnectionHandler } from 'hydrooj/src/handler/record';
import { oi33Model } from '../model';

export function applyPatches(_ctx: Context) {
    function cloneUserForDisplay<T>(udoc: T): T {
        if (!udoc || typeof udoc !== 'object') return udoc;
        return Object.create(
            Object.getPrototypeOf(udoc),
            Object.getOwnPropertyDescriptors(udoc),
        );
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

    // (c) HomeHandler.prototype.getCheckin — inject checkin data into homepage
    HomeHandler.prototype.getCheckin = async function (domainId: string, payload: any) {
        const today = moment().format('YYYY-MM-DD');
        payload.luck_today = today;
        if (this.user && this.user._id) {
            const oi33User = await oi33Model.getCheckinUser(this.user._id);
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

    // Keep user-detail JSON/template data anonymous. The original username/avatar
    // are stored as non-enumerable fields for the OI33 manager template exception.
    _ctx.on('handler/after/UserDetail', (h: any) => {
        const udoc = h.response?.body?.udoc;
        if (udoc?.oi33_profile_hidden) oi33Model.anonymizeOi33Identity(udoc);
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
        const oi33Dict = await oi33Model.getUserDataByUids(udocs.map((udoc) => Number(udoc._id)));
        for (const udoc of udocs) {
            oi33Model.mergeOi33Fields(udoc, oi33Dict[Number(udoc._id)], ['realname']);
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
        /^\/problem(\/|$)/,
        /^\/p\//,
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

    _ctx.on('handler/before', async (h: any) => {
        if (h.user?._id) {
            const oi33 = (await oi33Model.getUserDataByUids([h.user._id]))[h.user._id];
            oi33Model.mergeOi33Fields(h.user, oi33);
        }

        const auth = h.request.headers.authorization;
        if (!auth || !auth.startsWith('Bearer ')) return;

        // OAuth provider endpoints manage their own Bearer auth (access tokens
        // live in oi33_oauth_token, not oi33_token). Skip the API-token check
        // so those handlers can verify tokens themselves.
        if (typeof h.request.path === 'string' && h.request.path.startsWith('/oi33/oauth/')) {
            return;
        }

        const tokenDoc = await verifyBearerToken(auth, h.domain?._id || h.domainId || '');
        if (!tokenDoc) throw new Error('Invalid or expired token');

        const udoc = await UserModel.getById('', tokenDoc.uid);
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

}
