import { Context, UserModel, moment } from 'hydrooj';
import { createHash } from 'crypto';
import { HomeHandler } from 'hydrooj/src/handler/home';
import { oi33Model } from '../model';

export function applyPatches(_ctx: Context) {
    // (a) UserModel.getList — merge oi33_user fields into udoc
    // getList returns User instances with hasPriv(), used by pages that render user.html
    const origGetList = UserModel.getList;
    UserModel.getList = async function (domainId: string, uids: number[]) {
        const udict = await origGetList.call(UserModel, domainId, uids);
        if (!uids.length) return udict;
        const oi33Dict = await oi33Model.getUserDataByUids(uids);
        for (const uid of uids) {
            const oi33 = oi33Dict[uid];
            if (!oi33) continue;
            const u = udict[uid];
            if (!u) continue;
            oi33Model.mergeOi33Fields(u, oi33);
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
            if (!oi33) continue;
            const u = udict[uid];
            if (!u) continue;
            oi33Model.mergeOi33Fields(u, oi33);
        }
        return udict;
    };

    // (b2) UserModel.getById — merge oi33_user fields so user_detail.html sees them
    // user_detail handler uses getById, which is NOT covered by getList patch
    const origGetById = UserModel.getById;
    UserModel.getById = async function (domainId: string, _id: number, scope?: any) {
        const udoc = await origGetById.call(UserModel, domainId, _id, scope);
        if (!udoc) return udoc;
        const oi33 = (await oi33Model.getUserDataByUids([_id]))[_id];
        if (oi33) oi33Model.mergeOi33Fields(udoc, oi33);
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
