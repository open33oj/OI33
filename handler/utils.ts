import { ForbiddenError, UserModel } from 'hydrooj';
import { oi33Model } from '../model';

export async function checkUserFlag(uid: number): Promise<number> {
    const oi33 = (await oi33Model.getUserDataByUids([uid]))[uid];
    return oi33 ? (oi33.realname_flag ?? 0) : 0;
}

export function canPublish(flag: number): boolean {
    return flag >= 1;
}

export async function checkOi33Admin(uid: number): Promise<number> {
    const flag = await checkUserFlag(uid);
    if (flag < 2) throw new ForbiddenError('仅管理员和行政管理员可以使用此功能。');
    return flag;
}

// The one place that turns a list of uids into renderable user docs: core
// getList (patched to merge oi33 fields) + a defensive merge for callers that
// pass raw docs, + the viewer-facing anonymity rules. Centralizing this removes
// the repeated "forgot to merge / forgot to hide real names" loops that had
// accumulated in every list handler.
export async function loadOi33Users(
    domainId: string,
    uids: number[],
    opts: { viewerFlag?: number; fields?: string[] } = {},
): Promise<Record<number, any>> {
    const unique = [...new Set(uids.map(Number).filter((uid) => Number.isFinite(uid)))];
    if (!unique.length) return {};
    const udict: Record<number, any> = await UserModel.getList(domainId, unique);
    const oi33Dict = await oi33Model.getUserDataByUids(unique);
    // Only blank real names when the caller tells us the viewer's role; callers
    // that omit it keep the previous behaviour (templates gate on the viewer).
    const hideRealNames = opts.viewerFlag !== undefined && opts.viewerFlag < 2;
    for (const uid of unique) {
        const udoc = udict[uid];
        if (!udoc) continue;
        oi33Model.mergeOi33Fields(udoc, oi33Dict[uid], opts.fields);
        if (hideRealNames) udoc.realname_name = '';
        oi33Model.anonymizeOi33Identity(udoc);
    }
    return udict;
}

