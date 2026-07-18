import { ForbiddenError } from 'hydrooj';
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
