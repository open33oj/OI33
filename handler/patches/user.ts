import { Context, UserModel, avatar } from 'hydrooj';
import { oi33Model } from '../../model';
import { cloneUserForDisplay } from './shared';

// UserModel.getList / getListForRender / getById and User.prototype.private:
// merge oi33_user fields into every user object that reaches a template or the
// JSON serializer. The `users` API gets real-name search for OI33 admins.
export function applyUserPatches(ctx: Context) {
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
                value: (u as any).realname_name || '',
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

    // (b4) `user.users` API — let OI33 admins (flag >= 2) search by real name.
    // The core autocomplete (used by the record filter and every OI33 user
    // picker) only matches uid/uname/displayName/mail, so an admin who knows
    // only a student's real name cannot find the account. The viewer's flag
    // lives on the calling handler (`context.user`), which the model layer
    // cannot see, so wrap the api service instead of getPrefixList. Real-name
    // hits are appended to (never replace) the core results and the matched
    // user's real name is shown as the item's displayName so the admin can tell
    // same-name accounts apart; non-admin viewers never reach this path.
    // `ctx.inject(deps, cb)` hands the callback the *injected context*, not the
    // service itself (same shape as `inject(['template'], (c) => c.template)`),
    // so pull `api` off the argument before touching it.
    (ctx as any).inject(['api'], (injected: any) => {
        const api = injected?.api;
        if (!api || api.__oi33RealnameSearch) return;
        api.__oi33RealnameSearch = true;
        const origExecute = api.execute.bind(api);
        api.execute = async function patchedExecute(context: any, callOrName: any, rawArgs: any, ...rest: any[]) {
            const result = await origExecute(context, callOrName, rawArgs, ...rest);
            try {
                if (callOrName !== 'users' || !Array.isArray(result)) return result;
                if ((Number(context?.user?.realname_flag) || 0) < 2) return result;
                const search = typeof rawArgs?.search === 'string' ? rawArgs.search.trim() : '';
                const hasAuto = (Array.isArray(rawArgs?.auto) && rawArgs.auto.length > 0)
                    || (Array.isArray(rawArgs?.ids) && rawArgs.ids.length > 0);
                if (!search || hasAuto) return result;
                const limit = Math.max(1, Math.min(10, Number(rawArgs?.limit) || 10));
                const seen = new Set(result.map((row: any) => Number(row?._id)));
                const matched = (await oi33Model.searchUserIdsByRealname(search, limit, !!rawArgs?.exact))
                    .filter((uid) => !seen.has(uid));
                if (!matched.length) return result;
                const domainId = String(rawArgs?.domainId || context?.args?.domainId || 'system');
                const udict: any = await UserModel.getList(domainId, matched);
                // The response was already projected by the core call; mirror
                // whichever keys the caller asked for (the UI asks for
                // _id/uname/displayName/avatarUrl).
                const keys = result.length
                    ? Object.keys(result[0])
                    : ['_id', 'uname', 'displayName', 'avatarUrl'];
                const extra = matched.map((uid) => {
                    const udoc: any = udict[uid];
                    if (!udoc) return null;
                    const row: any = {};
                    for (const key of keys) {
                        if (key === 'avatarUrl') row[key] = avatar(udoc.avatar || '');
                        else if (key === 'displayName') row[key] = udoc.realname_name || udoc.displayName || '';
                        else row[key] = udoc[key];
                    }
                    return row;
                }).filter(Boolean);
                return extra.length ? result.concat(extra) : result;
            } catch (e) {
                // A failed real-name side query must never break the core search.
                console.error('[oi33] real-name user search failed:', e);
                return result;
            }
        };
    });
}
