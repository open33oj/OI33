import { addLog } from '../log';
import { userColl } from '../user';
import { catCanPoolColl } from './can';
import {
    SCHOOL_CAT_FEED_COOLDOWN_MS, SCHOOL_CAT_FEED_ENABLED, TIME_ZONE, ensureSchoolCatRecord, getSchool,
    getSchoolView, isAdminSchoolCatRecord, publicCat, schoolCatColl, schoolCatKey,
    schoolDisplay, schoolUrl, shanghaiMonthKey,
} from './school-shared';
import { getEligibleUser } from './eligibility';
import { boundCatIdOf, catMapCellColl, recountSchoolCatTerritories } from './map';

// 玩家与大猫：绑定/解绑（携带旧领地 + 7 天内撤销）、转移清理。
// 主动投喂已永久关闭；领地只能通过地图染色获得。整只大猫的行政转移在 school-transfer.ts。

const REBIND_UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function canUndoRebindOf(user: any, now: Date) {
    const at = user?.school_cat_rebind_at ? new Date(user.school_cat_rebind_at) : null;
    return !!at && !Number.isNaN(at.getTime())
        && now.getTime() - at.getTime() <= REBIND_UNDO_WINDOW_MS
        && Object.prototype.hasOwnProperty.call(user, 'school_cat_rebind_prev');
}

// 把该用户画过的所有格子归到其**当前**绑定的大猫（未绑定则归 0）。
// 用户文档是归属的唯一事实来源：并发改绑、撤销换绑、管理员转移都可能让
// 格子短暂留在旧大猫；循环读取直到「读到的绑定」与刚写入的归属一致为止，
// 这样最后一次成功的绑定总是拥有这个人的全部贡献。
export async function syncUserSchoolCatCells(uid: number, now = new Date()) {
    let cells = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
        const before: any = await userColl.findOne(
            { _id: uid } as any,
            { projection: { school_cat: 1 } },
        );
        const catId = boundCatIdOf(before);
        const moved = await catMapCellColl.updateMany(
            { updatedBy: uid, color: { $exists: true }, catId: { $ne: catId } } as any,
            { $set: { catId } } as any,
        );
        if (moved.modifiedCount) {
            cells += moved.modifiedCount;
            await recountSchoolCatTerritories(now);
        }
        const after: any = await userColl.findOne(
            { _id: uid } as any,
            { projection: { school_cat: 1 } },
        );
        if (boundCatIdOf(after) === catId) return { catId, cells };
    }
    // 绑定在这几轮里持续变化（只可能来自并发改绑）；最后再按最新绑定写一次。
    const latest: any = await userColl.findOne(
        { _id: uid } as any,
        { projection: { school_cat: 1 } },
    );
    const catId = boundCatIdOf(latest);
    const moved = await catMapCellColl.updateMany(
        { updatedBy: uid, color: { $exists: true }, catId: { $ne: catId } } as any,
        { $set: { catId } } as any,
    );
    if (moved.modifiedCount) {
        cells += moved.modifiedCount;
        await recountSchoolCatTerritories(now);
    }
    return { catId, cells };
}

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
    const monthKey = shanghaiMonthKey(now);
    if (previousId === schoolId) {
        // 重复提交 / 上次绑定在携带领地时中断：绑定已是目标，只补齐贡献。
        const synced = await syncUserSchoolCatCells(uid, now);
        const targetCat: any = await ensureSchoolCatRecord(schoolId, now);
        return {
            boundId: schoolId,
            boundCatId: schoolCatKey(schoolId),
            boundDisplay: schoolDisplay(school),
            boundUrl: schoolUrl(schoolId),
            boundColor: targetCat.territoryColor,
            carriedCells: synced.cells,
            canUndoRebind: canUndoRebindOf(user, now),
            canChange: (user.school_cat_month || '') !== monthKey,
            movedToHistory: 0,
            restoredFromHistory: 0,
        };
    }
    if ((user.school_cat_month || '') === monthKey) {
        throw new Error('每个月只能修改一次绑定的大猫，请下个月再修改。');
    }
    // The first-ever binding is free. Binding again after a user-initiated
    // cancellation is a monthly change even though there is no current cat.
    const isInitialBinding = previousId === null && !String(user.school_cat_month || '');
    const targetCat: any = await ensureSchoolCatRecord(schoolId, now);

    // 先以「读到的旧绑定 + 本月未改绑」为条件原子地写入新绑定；并发的两次
    // 改绑只有一次能成功，另一次会失败重试，不会出现「绑定 A、贡献在 B」。
    const previousMonth = String(user.school_cat_month || '');
    const set: any = {
        school_cat: schoolId,
        // 7 天内可撤销这次换绑；记录旧绑定与旧月份。
        school_cat_rebind_prev: previousId,
        school_cat_rebind_prev_month: previousMonth || null,
        school_cat_rebind_at: now,
    };
    if (!isInitialBinding) set.school_cat_month = monthKey;
    const filter: any = {
        _id: uid,
        realname_flag: { $gte: 1 },
        school_cat_month: { $ne: monthKey },
        school_cat: previousId === null ? { $in: [null] } : previousId,
    };
    const bound = await userColl.updateOne(
        filter,
        {
            $set: set,
            $unset: { school_cat_food: '', school_cat_feed_at: '' },
        } as any,
    );
    if (!bound.modifiedCount) throw new Error('大猫绑定刚刚发生变化，请刷新后重试。');

    // 换绑时把该用户画过的所有格子一起带过去（包括之前无主的格子）。
    // 只改归属，不改颜色 / updatedBy / updatedAt，这样个人占格数不受影响。
    const carried = await syncUserSchoolCatCells(uid, now);
    try {
        await addLog({
            type: 'school_cat',
            userId: uid,
            sender: uid,
            action: isInitialBinding ? 'bind' : 'rebind',
            catId: schoolCatKey(schoolId),
            reason: isInitialBinding
                ? `绑定大猫 ${schoolDisplay(school)}，携带 ${carried.cells} 格领地`
                : `从 ${previousId === null ? '无主' : `#${previousId}`} 改绑 ${schoolDisplay(school)}，`
                    + `携带 ${carried.cells} 格领地归顺；7 天内可撤销`,
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
        carriedCells: carried.cells,
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
    if (now.getTime() - at.getTime() > REBIND_UNDO_WINDOW_MS) {
        throw new Error('换绑已超过 7 天，不能撤销。');
    }
    const previousId = Number.isSafeInteger(user.school_cat_rebind_prev)
        ? Number(user.school_cat_rebind_prev)
        : null;
    const previousMonth = String(user.school_cat_rebind_prev_month || '');
    const currentId = Number.isSafeInteger(user.school_cat) ? user.school_cat : null;

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
    // 与改绑相同的 CAS：只撤销「读到的那次换绑」，并发请求不会重复回滚。
    const filter: any = {
        _id: uid,
        school_cat_rebind_at: at,
        school_cat: currentId === null ? { $in: [null] } : currentId,
        // 撤销成功后这两个字段会被移除，第二个并发撤销因此匹配不到。
        school_cat_rebind_prev: previousId === null
            ? { $exists: true, $in: [null] }
            : previousId,
    };
    const restoredBinding = await userColl.updateOne(
        filter,
        { $set: set, $unset: unset } as any,
    );
    if (!restoredBinding.modifiedCount) {
        throw new Error('换绑记录刚刚发生变化，请刷新后重试。');
    }

    // 撤销后「最新绑定」就是原来的大猫：把这个人画过的全部格子都带回去，
    // 包括换绑后新画的格子（贡献永远跟随当前绑定，不在两只大猫之间拆分）。
    const restored = await syncUserSchoolCatCells(uid, now);
    const previousCatKey = previousId === null ? 0 : schoolCatKey(previousId);

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
            reason: `撤销换绑，恢复到 ${display}；${restored.cells} 格领地回到原归属`,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log school cat rebind undo:', e);
    }
    return {
        restoredId: previousId,
        display,
        cells: restored.cells,
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
        {
            _id: uid,
            realname_flag: { $gte: 1 },
            school_cat: schoolId,
            school_cat_month: { $ne: monthKey },
        } as any,
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
    const released = await syncUserSchoolCatCells(uid, now);
    await addLog({
        type: 'school_cat', userId: uid, sender: uid, action: 'unbind',
        catId: schoolCatKey(schoolId),
        reason: `取消绑定 ${school ? schoolDisplay(school) : `#${schoolId}`}，`
            + `${released.cells} 格领地转为无主`,
    } as any);
    const cat: any = await schoolCatColl.findOne({ _id: schoolId } as any);
    return {
        previousId: schoolId,
        previousDisplay: school ? schoolDisplay(school) : `#${schoolId}`,
        movedToHistory: 0,
        releasedCells: released.cells,
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
    await syncUserSchoolCatCells(uid, now);
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

