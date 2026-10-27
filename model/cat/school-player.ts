import { ObjectId } from 'hydrooj';
import { addLog } from '../log';
import { userColl } from '../user';
import { catCanPoolColl } from './can';
import {
    SCHOOL_CAT_FEED_COOLDOWN_MS, TIME_ZONE, ensureSchoolCatRecord, getSchool,
    getSchoolView, isAdminSchoolCatRecord, publicCat, schoolCatColl, schoolCatKey,
    schoolDisplay, schoolFeedHistoryColl, schoolUrl, shanghaiMonthKey,
} from './school-shared';
import { getEligibleUser } from './eligibility';

// 玩家与大猫：绑定/解绑/转移清理，以及投喂（冷却、历史、贡献、猫粮池收支）。
// 整只大猫的行政转移在 school-transfer.ts。

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
    const contribution = Math.max(0, Math.floor(Number(user.school_cat_food) || 0));
    if (previousId !== null && contribution > 0) {
        await schoolCatColl.updateOne(
            { _id: previousId } as any,
            {
                $inc: { currentWeight: -contribution, historyWeight: contribution },
                $set: { updatedAt: now },
                $setOnInsert: { spawnedAt: now },
            } as any,
            { upsert: true },
        );
        await schoolFeedHistoryColl.insertOne({
            _id: new ObjectId(),
            uid,
            schoolId: previousId,
            amount: contribution,
            createdAt: now,
        } as any);
    }
    // 绑定回以前投喂过的大猫时，把历史投喂恢复为当前投喂。
    const historyRows = await schoolFeedHistoryColl.find({ schoolId, uid }).toArray();
    const restored = historyRows.reduce((sum, row: any) => sum + Math.max(0, Math.floor(Number(row.amount) || 0)), 0);
    if (restored > 0) {
        await schoolFeedHistoryColl.deleteMany({ schoolId, uid });
        await schoolCatColl.updateOne(
            { _id: schoolId } as any,
            {
                $inc: { currentWeight: restored, historyWeight: -restored },
                $set: { updatedAt: now },
                $setOnInsert: { spawnedAt: now },
            } as any,
            { upsert: true },
        );
    }
    await userColl.updateOne(
        { _id: uid },
        {
            $set: isInitialBinding
                // 首次绑定不占每月一次的修改额度；改绑和取消后的重新绑定都会记录月份。
                ? { school_cat: schoolId, school_cat_food: restored }
                : { school_cat: schoolId, school_cat_food: restored, school_cat_month: monthKey },
        },
    );
    try {
        await addLog({
            type: 'school_cat',
            userId: uid,
            sender: uid,
            action: isInitialBinding ? 'bind' : 'rebind',
            reason: isInitialBinding
                ? `绑定大猫 ${schoolDisplay(school)}${restored ? `，恢复历史投喂 ${restored}g` : ''}`
                : previousId === null
                    ? `取消绑定后重新绑定 ${schoolDisplay(school)}${restored ? `，恢复历史投喂 ${restored}g` : ''}`
                    : `从 #${previousId} 改绑 ${schoolDisplay(school)}，${contribution}g 转入历史投喂${restored ? `，恢复历史投喂 ${restored}g` : ''}`,
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
        movedToHistory: previousId === null ? 0 : contribution,
        restoredFromHistory: restored,
        canChange: isInitialBinding,
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
    const contribution = Math.max(0, Math.floor(Number(user.school_cat_food) || 0));
    const hadContributionField = Object.prototype.hasOwnProperty.call(user, 'school_cat_food');
    const hadMonthField = Object.prototype.hasOwnProperty.call(user, 'school_cat_month');
    const updated = await userColl.updateOne(
        {
            _id: uid, school_cat: schoolId,
            ...(Object.prototype.hasOwnProperty.call(user, 'school_cat_food')
                ? { school_cat_food: user.school_cat_food }
                : { school_cat_food: { $exists: false } }),
        } as any,
        {
            $set: { school_cat_month: monthKey },
            $unset: { school_cat: '', school_cat_food: '' },
        } as any,
    );
    if (!updated.modifiedCount) throw new Error('大猫绑定刚刚发生变化，请刷新后重试。');
    const historyId = new ObjectId();
    let catUpdated = false;
    let historyInserted = false;
    try {
        if (contribution > 0) {
            const catResult = await schoolCatColl.updateOne(
                { _id: schoolId, currentWeight: { $gte: contribution } } as any,
                {
                    $inc: { currentWeight: -contribution, historyWeight: contribution },
                    $set: { updatedAt: now },
                } as any,
            );
            if (!catResult.modifiedCount) throw new Error('大猫体重更新失败。');
            catUpdated = true;
            await schoolFeedHistoryColl.insertOne({
                _id: historyId, uid, schoolId, amount: contribution, createdAt: now,
            } as any);
            historyInserted = true;
        }
        await addLog({
            type: 'school_cat', userId: uid, sender: uid, action: 'unbind',
            catId: schoolCatKey(schoolId),
            reason: `取消绑定 ${school ? schoolDisplay(school) : `#${schoolId}`}，${contribution}g 转入历史投喂；既有绘图归属保持不变`,
        } as any);
    } catch (e) {
        if (historyInserted) await schoolFeedHistoryColl.deleteOne({ _id: historyId } as any);
        if (catUpdated) await schoolCatColl.updateOne(
            { _id: schoolId } as any,
            { $inc: { currentWeight: contribution, historyWeight: -contribution } } as any,
        );
        const restore: any = { school_cat: schoolId };
        if (hadContributionField) restore.school_cat_food = user.school_cat_food;
        const restoreUnset: any = {};
        if (!hadContributionField) restoreUnset.school_cat_food = '';
        if (hadMonthField) {
            restore.school_cat_month = user.school_cat_month;
        } else {
            restoreUnset.school_cat_month = '';
        }
        const restoreUpdate: any = { $set: restore };
        if (Object.keys(restoreUnset).length) restoreUpdate.$unset = restoreUnset;
        await userColl.updateOne(
            { _id: uid, school_cat: { $exists: false }, school_cat_month: monthKey } as any,
            restoreUpdate,
        );
        throw e;
    }
    const cat: any = await schoolCatColl.findOne({ _id: schoolId } as any);
    return {
        previousId: schoolId,
        previousDisplay: school ? schoolDisplay(school) : `#${schoolId}`,
        movedToHistory: contribution,
        canChange: false,
        cat: cat ? publicCat(cat, school) : null,
    };
}

export async function removeSchoolCatBinding(uid: number, now = new Date()) {
    const user: any = await userColl.findOne({ _id: uid });
    const schoolId = Number.isSafeInteger(user?.school_cat) ? user.school_cat : null;
    if (schoolId === null) return;
    const contribution = Math.max(0, Math.floor(Number(user.school_cat_food) || 0));
    if (contribution > 0) {
        await schoolCatColl.updateOne(
            { _id: schoolId } as any,
            {
                $inc: { currentWeight: -contribution, historyWeight: contribution },
                $set: { updatedAt: now },
            } as any,
        );
        await schoolFeedHistoryColl.insertOne({
            _id: new ObjectId(),
            uid,
            schoolId,
            amount: contribution,
            createdAt: now,
        } as any);
    }
    await userColl.updateOne({ _id: uid }, { $unset: { school_cat: '', school_cat_food: '' } });
}

export async function feedSchoolCat(uid: number, amount: number, now = new Date()) {
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
    let catUpdated = false;
    try {
        const poolResult = await catCanPoolColl.updateOne(
            { _id: 'main' } as any,
            { $inc: { userFoodTotal: -amount }, $set: { updatedAt: now } } as any,
        );
        poolUpdated = !!poolResult.modifiedCount;
        const catResult = await schoolCatColl.updateOne(
            { _id: schoolId } as any,
            {
                $inc: { currentWeight: amount },
                $set: { updatedAt: now },
                $setOnInsert: { historyWeight: 0, spawnedAt: now },
            } as any,
            { upsert: true },
        );
        catUpdated = !!catResult.modifiedCount || !!catResult.upsertedCount;
        await addLog({
            type: 'cat_account',
            userId: uid,
            sender: uid,
            action: 'school_feed',
            amount: -amount,
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
        if (catUpdated) rollback.push(schoolCatColl.updateOne({ _id: schoolId } as any, { $inc: { currentWeight: -amount } } as any) as any);
        await Promise.all(rollback);
        throw e;
    }
    const [updatedUser, updatedCat]: any[] = await Promise.all([
        userColl.findOne({ _id: uid }),
        schoolCatColl.findOne({ _id: schoolId } as any),
    ]);
    const weight = Math.max(0, Math.floor(Number(updatedCat?.currentWeight) || 0));
    return {
        schoolId,
        display,
        url: schoolUrl(schoolId),
        weight,
        historyWeight: Math.max(0, Math.floor(Number(updatedCat?.historyWeight) || 0)),
        territoryCount: Math.max(0, Math.floor(Number(updatedCat?.territoryCount) || 0)),
        color: Math.max(0, Math.floor(Number(updatedCat?.territoryColor) || 0)),
        isAdminCat: isAdminSchoolCatRecord(updatedCat),
        contribution: Math.max(0, Math.floor(Number(updatedUser?.school_cat_food) || 0)),
        balance: Math.max(0, Number(updatedUser?.cat_food) || 0),
        nextFeedAt: now.getTime() + SCHOOL_CAT_FEED_COOLDOWN_MS,
    };
}

