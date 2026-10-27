import { addLog } from '../log';
import { userColl } from '../user';
import { catCanPoolColl } from './can';
import {
    SCHOOL_CAT_FEED_COOLDOWN_MS, SCHOOL_CAT_FEED_ENABLED, TIME_ZONE, ensureSchoolCatRecord, getSchool,
    getSchoolView, isAdminSchoolCatRecord, publicCat, schoolCatColl, schoolCatKey,
    schoolDisplay, schoolUrl, shanghaiMonthKey,
} from './school-shared';
import { getEligibleUser } from './eligibility';
import { catMapCellColl, recountSchoolCatTerritories } from './map';

// 玩家与大猫：绑定/解绑（携带旧领地 + 7 天内撤销）、转移清理。
// 主动投喂已永久关闭；领地只能通过地图染色获得。整只大猫的行政转移在 school-transfer.ts。

export async function bindSchoolCat(uid: number, schoolId: number, now = new Date()) {
    if (!Number.isSafeInteger(schoolId)) throw new Error('学校编号无效。');
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以选择投喂的大猫。');
    let school: any;
    if (schoolId < 0) {
        // 特殊大猫不对应真实学校，记录必须已存在，且仅管理员可以绑定。
        if ((Number(user.realname_flag) || 0) < 2) throw new Error('特殊大猫仅管理员可以绑定。');
        school = await getSchoolView(schoolId);
        if (!school) throw new Error('该特殊大猫不存在。');
    } else {
        school = await getSchool(schoolId);
        if (!school) throw new Error('该学校不存在。');
    }
    const previousId = Number.isSafeInteger(user.school_cat) ? user.school_cat : null;
    if (previousId === schoolId) throw new Error('你已经绑定了这只大猫。');
    const monthKey = shanghaiMonthKey(now);
    if ((user.school_cat_month || '') === monthKey) {
        throw new Error('每个月只能修改一次绑定的大猫，请下个月再修改。');
    }
    // The first-ever binding is free. Binding again after a user-initiated
    // cancellation is a monthly change even though there is no current cat.
    const isInitialBinding = previousId === null && !String(user.school_cat_month || '');
    const targetCat: any = await ensureSchoolCatRecord(schoolId, now);

    // 换绑时把该用户画过的所有格子一起带过去（包括之前无主的格子）。
    // 只改归属，不改颜色 / updatedBy / updatedAt，这样个人占格数不受影响。
    const carried = await catMapCellColl.updateMany(
        { updatedBy: uid, color: { $exists: true } } as any,
        { $set: { catId: schoolCatKey(schoolId) } } as any,
    );
    if (carried.modifiedCount) await recountSchoolCatTerritories(now);

    const previousMonth = String(user.school_cat_month || '');
    const set: any = {
        school_cat: schoolId,
        // 7 天内可撤销这次换绑；记录旧绑定与旧月份。
        school_cat_rebind_prev: previousId,
        school_cat_rebind_prev_month: previousMonth || null,
        school_cat_rebind_at: now,
    };
    if (!isInitialBinding) set.school_cat_month = monthKey;
    await userColl.updateOne(
        { _id: uid } as any,
        {
            $set: set,
            $unset: { school_cat_food: '', school_cat_feed_at: '' },
        } as any,
    );
    try {
        await addLog({
            type: 'school_cat',
            userId: uid,
            sender: uid,
            action: isInitialBinding ? 'bind' : 'rebind',
            catId: schoolCatKey(schoolId),
            reason: isInitialBinding
                ? `绑定大猫 ${schoolDisplay(school)}，携带 ${carried.modifiedCount} 格领地`
                : `从 ${previousId === null ? '无主' : `#${previousId}`} 改绑 ${schoolDisplay(school)}，`
                    + `携带 ${carried.modifiedCount} 格领地归顺；7 天内可撤销`,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log school cat bind:', e);
    }
    return {
        boundId: schoolId,
        boundCatId: schoolCatKey(schoolId),
        boundDisplay: schoolDisplay(school),
        boundUrl: schoolUrl(schoolId),
        boundColor: targetCat.territoryColor,
        carriedCells: carried.modifiedCount,
        canUndoRebind: true,
        canChange: isInitialBinding,
        movedToHistory: 0,
        restoredFromHistory: 0,
    };
}

export async function undoSchoolCatRebind(uid: number, now = new Date()) {
    const user: any = await userColl.findOne({ _id: uid } as any);
    if (!user) throw new Error('用户不存在。');
    if (!Object.prototype.hasOwnProperty.call(user, 'school_cat_rebind_prev')) {
        throw new Error('没有可撤销的换绑记录。');
    }
    const at = user.school_cat_rebind_at ? new Date(user.school_cat_rebind_at) : null;
    if (!at || Number.isNaN(at.getTime())) throw new Error('换绑时间缺失，无法撤销。');
    if (now.getTime() - at.getTime() > 7 * 24 * 60 * 60 * 1000) {
        throw new Error('换绑已超过 7 天，不能撤销。');
    }
    const previousId = Number.isSafeInteger(user.school_cat_rebind_prev)
        ? Number(user.school_cat_rebind_prev)
        : null;
    const previousMonth = String(user.school_cat_rebind_prev_month || '');
    const previousCatKey = previousId === null ? 0 : schoolCatKey(previousId);

    // 只回滚换绑时已经存在的格子；换绑后新画的格子留在新大猫。
    const restored = await catMapCellColl.updateMany(
        {
            updatedBy: uid,
            color: { $exists: true },
            updatedAt: { $lte: at },
        } as any,
        { $set: { catId: previousCatKey } } as any,
    );
    if (restored.modifiedCount) await recountSchoolCatTerritories(now);

    const set: any = {};
    const unset: any = {
        school_cat_rebind_prev: '',
        school_cat_rebind_prev_month: '',
        school_cat_rebind_at: '',
    };
    if (previousId === null) unset.school_cat = '';
    else set.school_cat = previousId;
    if (previousMonth) set.school_cat_month = previousMonth;
    else unset.school_cat_month = '';
    await userColl.updateOne({ _id: uid } as any, { $set: set, $unset: unset } as any);

    let display = previousId === null ? '无主' : `#${previousId}`;
    if (previousId !== null) {
        const school: any = await getSchoolView(previousId);
        if (school) display = schoolDisplay(school);
    }
    try {
        await addLog({
            type: 'school_cat',
            userId: uid,
            sender: uid,
            action: 'rebind_undo',
            catId: previousCatKey,
            reason: `撤销换绑，恢复到 ${display}；${restored.modifiedCount} 格领地回到原归属`,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log school cat rebind undo:', e);
    }
    return {
        restoredId: previousId,
        display,
        cells: restored.modifiedCount,
        canChange: true,
    };
}

export async function unbindSchoolCat(uid: number, now = new Date()) {
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以取消绑定大猫。');
    const schoolId = Number.isSafeInteger(user.school_cat) ? user.school_cat : null;
    if (schoolId === null) throw new Error('你当前没有绑定大猫。');
    const monthKey = shanghaiMonthKey(now);
    if ((user.school_cat_month || '') === monthKey) {
        throw new Error('每个月只能修改一次绑定的大猫，请下个月再取消绑定。');
    }
    const school: any = await getSchoolView(schoolId);
    const updated = await userColl.updateOne(
        { _id: uid, school_cat: schoolId } as any,
        {
            $set: { school_cat_month: monthKey },
            $unset: {
                school_cat: '', school_cat_food: '', school_cat_feed_at: '',
                school_cat_rebind_prev: '', school_cat_rebind_prev_month: '', school_cat_rebind_at: '',
            },
        } as any,
    );
    if (!updated.modifiedCount) throw new Error('大猫绑定刚刚发生变化，请刷新后重试。');
    // 解绑后这些格子变成无主领地，个人占格数不变。
    const released = await catMapCellColl.updateMany(
        { updatedBy: uid, color: { $exists: true } } as any,
        { $set: { catId: 0 } } as any,
    );
    if (released.modifiedCount) await recountSchoolCatTerritories(now);
    await addLog({
        type: 'school_cat', userId: uid, sender: uid, action: 'unbind',
        catId: schoolCatKey(schoolId),
        reason: `取消绑定 ${school ? schoolDisplay(school) : `#${schoolId}`}，`
            + `${released.modifiedCount} 格领地转为无主`,
    } as any);
    const cat: any = await schoolCatColl.findOne({ _id: schoolId } as any);
    return {
        previousId: schoolId,
        previousDisplay: school ? schoolDisplay(school) : `#${schoolId}`,
        movedToHistory: 0,
        releasedCells: released.modifiedCount,
        canChange: false,
        cat: cat ? publicCat(cat, school) : null,
    };
}

export async function removeSchoolCatBinding(uid: number, now = new Date()) {
    const user: any = await userColl.findOne({ _id: uid } as any);
    const schoolId = Number.isSafeInteger(user?.school_cat) ? user.school_cat : null;
    if (schoolId === null) return;
    await userColl.updateOne({ _id: uid } as any, {
        $unset: {
            school_cat: '', school_cat_food: '', school_cat_feed_at: '',
            school_cat_rebind_prev: '', school_cat_rebind_prev_month: '', school_cat_rebind_at: '',
        },
    } as any);
    const released = await catMapCellColl.updateMany(
        { updatedBy: uid, color: { $exists: true } } as any,
        { $set: { catId: 0 } } as any,
    );
    if (released.modifiedCount) await recountSchoolCatTerritories(now);
}

export async function feedSchoolCat(uid: number, amount: number, now = new Date()) {
    if (!SCHOOL_CAT_FEED_ENABLED) {
        throw new Error('大猫主动投喂已关闭；领地请在地图上通过染色获得。');
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('投喂量必须是正整数。');
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以投喂大猫。');
    const schoolId = Number.isSafeInteger(user.school_cat) ? user.school_cat : null;
    if (schoolId === null) throw new Error('请先绑定一只大猫再投喂。');
    const school: any = await getSchoolView(schoolId);
    if (!school) throw new Error('绑定的学校不存在，请重新绑定。');
    await ensureSchoolCatRecord(schoolId, now);
    const display = schoolDisplay(school);
    const nextFeedAt = user.school_cat_feed_at
        ? new Date(user.school_cat_feed_at).getTime() + SCHOOL_CAT_FEED_COOLDOWN_MS
        : 0;
    if (nextFeedAt > now.getTime()) {
        throw new Error(`投喂冷却中，请在 ${new Date(nextFeedAt).toLocaleString('zh-CN', { timeZone: TIME_ZONE })} 后再投喂。`);
    }

    const deducted = await userColl.updateOne(
        {
            _id: uid,
            realname_flag: { $gte: 1 },
            school_cat: schoolId,
            cat_food: { $gte: amount },
            $or: [
                { school_cat_feed_at: { $exists: false } },
                { school_cat_feed_at: { $lte: new Date(now.getTime() - SCHOOL_CAT_FEED_COOLDOWN_MS) } },
            ],
        },
        { $inc: { cat_food: -amount, school_cat_food: amount }, $set: { school_cat_feed_at: now } },
    );
    if (!deducted.modifiedCount) throw new Error(`猫粮不足，本次投喂需要 ${amount}g 猫粮（或投喂仍在冷却中）。`);

    let poolUpdated = false;
    try {
        const poolResult = await catCanPoolColl.updateOne(
            { _id: 'main' } as any,
            { $inc: { userFoodTotal: -amount }, $set: { updatedAt: now } } as any,
        );
        poolUpdated = !!poolResult.modifiedCount;
        await addLog({
            type: 'cat_account',
            userId: uid,
            sender: uid,
            action: 'school_feed',
            amount: -amount,
            // 记录到具体大猫，管理员撤回盗号投喂时不用再从文案里猜。
            catId: schoolCatKey(schoolId),
            schoolId,
            reason: `投喂大猫 ${display}`,
        } as any);
    } catch (e) {
        const rollbackFeedAt: any = user.school_cat_feed_at
            ? { $set: { school_cat_feed_at: user.school_cat_feed_at } }
            : { $unset: { school_cat_feed_at: '' } };
        const rollback = [
            userColl.updateOne({ _id: uid }, {
                $inc: { cat_food: amount, school_cat_food: -amount },
                ...rollbackFeedAt,
            }),
        ];
        if (poolUpdated) rollback.push(catCanPoolColl.updateOne({ _id: 'main' } as any, { $inc: { userFoodTotal: amount } } as any) as any);
        await Promise.all(rollback);
        throw e;
    }
    const [updatedUser, updatedCat]: any[] = await Promise.all([
        userColl.findOne({ _id: uid }),
        schoolCatColl.findOne({ _id: schoolId } as any),
    ]);
    return {
        schoolId,
        display,
        url: schoolUrl(schoolId),
        territoryCount: Math.max(0, Math.floor(Number(updatedCat?.territoryCount) || 0)),
        color: Math.max(0, Math.floor(Number(updatedCat?.territoryColor) || 0)),
        isAdminCat: isAdminSchoolCatRecord(updatedCat),
        contribution: Math.max(0, Math.floor(Number(updatedUser?.school_cat_food) || 0)),
        balance: Math.max(0, Number(updatedUser?.cat_food) || 0),
        nextFeedAt: now.getTime() + SCHOOL_CAT_FEED_COOLDOWN_MS,
    };
}

