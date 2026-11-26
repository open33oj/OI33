import { db } from 'hydrooj';
import { addLog } from '../log';
import { userColl } from '../user';
import {
    ensureSchoolCatRecord, getSchoolView, schoolCatColl,
    schoolCatKey, schoolDisplay, schoolFeedHistoryColl,
} from './school-shared';
import { getEligibleUser } from './eligibility';
import { syncUserSchoolCatCells } from './school-player';

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
    const toCatKey = schoolCatKey(toId);
    const fromCatKey = schoolCatKey(fromId);
    // 先记下要改绑的用户：除了把格子按 catId 整体转走，还要把这些用户
    // 散落在其它大猫名下的个人贡献一起归到目标大猫（历史上被拆开的数据）。
    const affectedUids: number[] = await userColl.distinct('_id', { school_cat: fromId } as any);
    const users = await userColl.updateMany({ school_cat: fromId } as any, { $set: { school_cat: toId } });
    const history = await schoolFeedHistoryColl.updateMany(
        { schoolId: fromId } as any, { $set: { schoolId: toId } },
    );
    let cells = (await catMapCellColl.updateMany(
        { catId: fromCatKey } as any,
        { $set: { catId: toCatKey } },
    )).modifiedCount;
    for (let offset = 0; offset < affectedUids.length; offset += 500) {
        const chunk = affectedUids.slice(offset, offset + 500);
        const moved = await catMapCellColl.updateMany(
            { updatedBy: { $in: chunk }, color: { $exists: true }, catId: { $ne: toCatKey } } as any,
            { $set: { catId: toCatKey } },
        );
        cells += moved.modifiedCount;
        // 转移期间有人并发改绑（CAS 已保证只有一次成功）：以他们现在的
        // 绑定为准重新同步，避免这次批量转移把最新贡献又写回目标大猫。
        const rows: any[] = await userColl.find(
            { _id: { $in: chunk } } as any,
            { projection: { school_cat: 1 } },
        ).toArray();
        for (const row of rows) {
            if (Number(row.school_cat) !== toId) {
                // 并发改绑的贡献不归目标大猫；按他们现在的绑定重新同步即可。
                await syncUserSchoolCatCells(row._id, now);
            }
        }
    }
    await recountSchoolCatTerritoryFor([fromId, toId], now);
    await addLog({
        type: 'school_cat',
        userId: operator,
        sender: operator,
        action: 'school_cat_transfer',
        catId: toCatKey,
        reason: `将大猫 #${fromId} 的记录转移到 ${schoolDisplay(toView)}：${users.modifiedCount} 位用户改绑、`
            + `${history.modifiedCount} 条投喂历史、${cells} 格领地`,
    } as any);
    return {
        fromId,
        toId,
        display: schoolDisplay(toView),
        users: users.modifiedCount,
        history: history.modifiedCount,
        cells,
    };
}
