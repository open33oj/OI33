import { db } from 'hydrooj';
import { addLog } from '../log';
import { userColl } from '../user';
import {
    ensureSchoolCatRecord, getSchoolView, schoolCatColl,
    schoolCatKey, schoolDisplay, schoolFeedHistoryColl,
} from './school-shared';
import { getEligibleUser } from './eligibility';

// 行政操作：领地计数重算、整只大猫的转移、历史移动贡献的一次性回填。

const catMapCellColl = db.collection('oi33_cat_map_cell');

async function recountSchoolCatTerritoryFor(schoolIds: number[], now = new Date()) {
    const keys = schoolIds.map((id) => schoolCatKey(id));
    const groups: any[] = await catMapCellColl.aggregate([
        { $match: { catId: { $in: keys } } },
        { $group: { _id: '$catId', count: { $sum: 1 } } },
    ]).toArray();
    const counts = new Map<number, number>(groups.map(
        (group: any) => [Number(group._id), Math.max(0, Math.floor(Number(group.count) || 0))],
    ));
    await schoolCatColl.bulkWrite(schoolIds.map((id) => ({
        updateOne: {
            filter: { _id: id },
            update: { $set: { territoryCount: counts.get(schoolCatKey(id)) || 0, updatedAt: now } },
        },
    })), { ordered: false });
}

export async function transferSchoolCat(
    operator: number, fromId: number, toId: number, now = new Date(),
) {
    const admin: any = await getEligibleUser(operator);
    if (!admin || (Number(admin.realname_flag) || 0) < 3) {
        throw new Error('仅行政管理员可以转移大猫记录。');
    }
    if (!Number.isSafeInteger(fromId) || !Number.isSafeInteger(toId)) throw new Error('大猫编号无效。');
    if (fromId === toId) throw new Error('来源和目标不能是同一只大猫。');
    const fromCat: any = await schoolCatColl.findOne({ _id: fromId } as any);
    if (!fromCat) throw new Error('来源大猫记录不存在。');
    const toView: any = await getSchoolView(toId);
    if (!toView) throw new Error('目标大猫不存在。');
    await ensureSchoolCatRecord(toId, now);
    const users = await userColl.updateMany({ school_cat: fromId } as any, { $set: { school_cat: toId } });
    const history = await schoolFeedHistoryColl.updateMany(
        { schoolId: fromId } as any, { $set: { schoolId: toId } },
    );
    const cells = await catMapCellColl.updateMany(
        { catId: schoolCatKey(fromId) } as any,
        { $set: { catId: schoolCatKey(toId) } },
    );
    await recountSchoolCatTerritoryFor([fromId, toId], now);
    await addLog({
        type: 'school_cat',
        userId: operator,
        sender: operator,
        action: 'school_cat_transfer',
        catId: schoolCatKey(toId),
        reason: `将大猫 #${fromId} 的记录转移到 ${schoolDisplay(toView)}：${users.modifiedCount} 位用户改绑、`
            + `${history.modifiedCount} 条投喂历史、${cells.modifiedCount} 格领地`,
    } as any);
    return {
        fromId,
        toId,
        display: schoolDisplay(toView),
        users: users.modifiedCount,
        history: history.modifiedCount,
        cells: cells.modifiedCount,
    };
}
