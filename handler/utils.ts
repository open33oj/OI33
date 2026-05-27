import { oi33Model } from '../model';

export async function checkUserFlag(uid: number): Promise<number> {
    const oi33 = (await oi33Model.getUserDataByUids([uid]))[uid];
    return oi33 ? (oi33.realname_flag ?? 0) : 0;
}

export function canPublish(flag: number): boolean {
    return flag >= 1;
}
