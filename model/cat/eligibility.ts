import { userColl } from '../user';

// 猫咪地图 / 大猫 / 交易等玩法的统一准入判定：只有已实名（realname_flag ≥ 1）
// 的用户可以参与。地图与大猫两个子系统原先各有一份实现，合并到这里。
export async function getEligibleUser(uid: number) {
    return await userColl.findOne({ _id: uid, realname_flag: { $gte: 1 } });
}
