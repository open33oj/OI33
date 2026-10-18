import { Context, UserModel } from 'hydrooj';
import { createHash } from 'crypto';
import { oi33Model } from '../../model';

// (e) Bearer token auth — Hydro v5 uses event-based handler lifecycle;
// 'handler/before' is fired after prepare() but before get()/post().
export function applyTokenPatches(ctx: Context) {
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
        // Medal catalogue / per-user medal list are read-only views. The
        // per-user management page (`/oi33/medals/user/:uid/manage`) stays off
        // the list: it is an admin editing UI even though its GET only reads.
        /^\/oi33\/medals\/catalogue$/,
        /^\/oi33\/medals\/user\/[^/]+$/,
        // Algorithm mastery display page (self or flag>=2 teacher) is read-only.
        // The `/edit` assessment page stays off the list: it is an editing UI,
        // even though its GET only reads.
        /^\/oi33\/algorithm\/user\/[^/]+$/,
        // 全站题解时间线与题目讨论板块都是只读列表页。
        /^\/oi33\/solutions(\/|$)/,
        /^\/oi33\/discuss(\/|$)/,
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
    ctx.on('handler/create', async (h: any, type?: string) => {
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

    ctx.on('handler/before', async (h: any) => {
        if (h.user?._id) {
            const oi33 = (await oi33Model.getUserDataByUids([h.user._id]))[h.user._id];
            oi33Model.mergeOi33Fields(h.user, oi33);
        }
    });
}
