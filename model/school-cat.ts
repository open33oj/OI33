import { readFileSync } from 'fs';
import path from 'path';
import { db, ObjectId } from 'hydrooj';
import { catCanPoolColl } from './cat-can';
import { CAT_MAP_HEIGHT, CAT_MAP_WIDTH } from './cat-map';
import { addLog } from './log';
import { userColl } from './user';

export const SCHOOL_CAT_MIN_WEIGHT = 1024;
export const SCHOOL_CAT_BASE_SIZE = 8;
export const SCHOOL_CAT_FEED_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const SCHOOL_CAT_MOVE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const SCHOOL_CAT_PAGE_SIZE = 50;

const TIME_ZONE = 'Asia/Shanghai';

export const schoolColl = db.collection('oi33_school');
export const schoolCatColl = db.collection('oi33_school_cat');
export const schoolFeedHistoryColl = db.collection('oi33_school_feed_history');

export function schoolCatSize(weight: number) {
    const safeWeight = Math.max(0, Math.floor(Number(weight) || 0));
    if (safeWeight < SCHOOL_CAT_MIN_WEIGHT) return 0;
    return SCHOOL_CAT_BASE_SIZE * (Math.floor(Math.log2(safeWeight / SCHOOL_CAT_MIN_WEIGHT)) + 1);
}

export function schoolDisplay(school: { _id: number; prov: string; abbr: string }) {
    return `${school.abbr}#${school._id}`;
}

export function schoolUrl(schoolId: number) {
    return `https://oier.baoshuo.dev/school/${schoolId}`;
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shanghaiMonthKey(now = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}`;
}

async function importSchools() {
    const file = path.join(__dirname, 'school-cat-data.json');
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const schools: Array<[number, string, string]> = parsed.schools || [];
    const meta: any = await schoolColl.findOne({ _id: 'meta' } as any);
    if (meta?.count === schools.length) return;
    let operations: any[] = [];
    for (const [code, prov, abbr] of schools) {
        operations.push({
            updateOne: {
                filter: { _id: code },
                update: { $set: { prov, abbr } },
                upsert: true,
            },
        });
        if (operations.length >= 1000) {
            await schoolColl.bulkWrite(operations, { ordered: false });
            operations = [];
        }
    }
    if (operations.length) await schoolColl.bulkWrite(operations, { ordered: false });
    await schoolColl.updateOne(
        { _id: 'meta' } as any,
        { $set: { count: schools.length, importedAt: new Date() } },
        { upsert: true },
    );
    console.info(`[oi33] imported ${schools.length} schools for big cat world`);
}

export async function ensureSchoolCatIndexes() {
    await importSchools();
    await Promise.all([
        schoolColl.createIndex({ abbr: 1 }),
        schoolColl.createIndex({ prov: 1 }),
        schoolCatColl.createIndex({ currentWeight: -1 }),
        schoolFeedHistoryColl.createIndex({ schoolId: 1, uid: 1 }),
        schoolFeedHistoryColl.createIndex({ uid: 1, createdAt: -1 }),
    ]);
}

function withDisplay(school: any) {
    return {
        id: school._id,
        display: schoolDisplay(school),
        prov: school.prov,
        url: schoolUrl(school._id),
    };
}

export async function getSchool(schoolId: number) {
    if (!Number.isSafeInteger(schoolId) || schoolId < 0) return null;
    return await schoolColl.findOne({ _id: schoolId } as any);
}

export async function searchSchools(query: string, limit = 20) {
    const trimmed = (query || '').trim();
    const capped = Math.max(1, Math.min(50, limit));
    let filter: any;
    if (!trimmed) {
        filter = { _id: { $type: 'number' } };
    } else if (/^\d+$/.test(trimmed)) {
        const school: any = await schoolColl.findOne({ _id: Number(trimmed) } as any);
        return school ? [withDisplay(school)] : [];
    } else if (trimmed.includes('#')) {
        // 省份代码#缩写前缀（JX#JJSDYZX、JX#JJ）或 缩写#编号（JJSDYZX#13396）。
        const [rawLeft, ...rest] = trimmed.toUpperCase().split('#');
        const left = escapeRegExp(rawLeft.trim());
        const right = rest.join('#').trim();
        const or: any[] = [];
        if (left && right && !/^\d+$/.test(right)) {
            or.push({ prov: rawLeft.trim().toUpperCase(), abbr: { $regex: `^${escapeRegExp(right)}` } });
            or.push({ abbr: { $regex: `^${left}` } });
        } else if (left && /^\d+$/.test(right)) {
            or.push({ abbr: { $regex: `^${left}` }, _id: Number(right) });
        } else if (left) {
            or.push({ abbr: { $regex: `^${left}` } });
            or.push({ prov: { $regex: `^${left}` } });
        }
        filter = or.length ? { _id: { $type: 'number' }, $or: or } : { _id: { $type: 'number' } };
    } else {
        // 普通文本：缩写子串（JJSD）或省份代码前缀（JX）。
        const upper = escapeRegExp(trimmed.toUpperCase());
        filter = {
            _id: { $type: 'number' },
            $or: [
                { abbr: { $regex: upper } },
                { prov: { $regex: `^${upper}` } },
            ],
        };
    }
    const schools = await schoolColl.find(filter).sort({ _id: 1 }).limit(capped).toArray();
    return schools.map(withDisplay);
}

export async function listSchools(page = 1, pageSize = SCHOOL_CAT_PAGE_SIZE) {
    const size = Math.max(1, Math.min(200, pageSize));
    const filter = { _id: { $type: 'number' } } as any;
    const total = await schoolColl.countDocuments(filter);
    const current = Math.max(1, Math.min(Math.ceil(total / size) || 1, Math.floor(page) || 1));
    const schools = await schoolColl.find(filter)
        .sort({ _id: 1 })
        .skip((current - 1) * size)
        .limit(size)
        .toArray();
    return {
        schools: schools.map(withDisplay),
        page: current,
        upcount: Math.ceil(total / size),
        total,
    };
}

async function getEligibleUser(uid: number) {
    return await userColl.findOne({ _id: uid, realname_flag: { $gte: 1 } });
}

function publicCat(cat: any, school: any) {
    const weight = Math.max(0, Math.floor(Number(cat.currentWeight) || 0));
    return {
        id: cat._id,
        display: school ? schoolDisplay(school) : `#${cat._id}`,
        url: schoolUrl(cat._id),
        x: Number.isSafeInteger(cat.x) ? cat.x : null,
        y: Number.isSafeInteger(cat.y) ? cat.y : null,
        size: schoolCatSize(weight),
        weight,
        historyWeight: Math.max(0, Math.floor(Number(cat.historyWeight) || 0)),
    };
}

export async function getBigCatWorldState(viewerUid = 0) {
    const cats = await schoolCatColl.find({ currentWeight: { $gte: SCHOOL_CAT_MIN_WEIGHT } }).toArray();
    const viewer: any = viewerUid
        ? await userColl.findOne({ _id: viewerUid, realname_flag: { $gte: 1 } })
        : null;
    const boundId = viewer && Number.isSafeInteger(viewer.school_cat) ? viewer.school_cat : null;
    const schoolIds = new Set<number>(cats.map((cat: any) => cat._id));
    if (boundId !== null) schoolIds.add(boundId);
    const schools = schoolIds.size
        ? await schoolColl.find({ _id: { $in: Array.from(schoolIds) } } as any).project({ prov: 1, abbr: 1 }).toArray()
        : [];
    const schoolMap = new Map(schools.map((school: any) => [school._id, school]));
    const visible = cats
        .map((cat: any) => publicCat(cat, schoolMap.get(cat._id)))
        .filter((cat: any) => cat.size > 0)
        .sort((a: any, b: any) => b.weight - a.weight || a.id - b.id);
    let me: any = null;
    if (viewer) {
        const boundSchool = boundId === null ? null : schoolMap.get(boundId);
        me = {
            food: Math.max(0, Number(viewer.cat_food) || 0),
            boundId,
            boundDisplay: boundSchool ? schoolDisplay(boundSchool) : null,
            boundUrl: boundId === null ? null : schoolUrl(boundId),
            contribution: Math.max(0, Math.floor(Number(viewer.school_cat_food) || 0)),
            canChange: (viewer.school_cat_month || '') !== shanghaiMonthKey(),
            nextFeedAt: viewer.school_cat_feed_at
                ? new Date(viewer.school_cat_feed_at).getTime() + SCHOOL_CAT_FEED_COOLDOWN_MS
                : 0,
        };
    }
    return {
        width: CAT_MAP_WIDTH,
        height: CAT_MAP_HEIGHT,
        minWeight: SCHOOL_CAT_MIN_WEIGHT,
        cats: visible,
        ranking: visible.slice(0, 100).map((cat: any) => ({
            id: cat.id, display: cat.display, url: cat.url, weight: cat.weight,
        })),
        me,
        serverTime: Date.now(),
    };
}

export async function bindSchoolCat(uid: number, schoolId: number, now = new Date()) {
    if (!Number.isSafeInteger(schoolId) || schoolId < 0) throw new Error('学校编号无效。');
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以选择投喂的大猫。');
    const school: any = await getSchool(schoolId);
    if (!school) throw new Error('该学校不存在。');
    const previousId = Number.isSafeInteger(user.school_cat) ? user.school_cat : null;
    if (previousId === schoolId) throw new Error('你已经绑定了这只大猫。');
    const monthKey = shanghaiMonthKey(now);
    if (previousId !== null && (user.school_cat_month || '') === monthKey) {
        throw new Error('每个月只能修改一次绑定的大猫，请下个月再修改。');
    }
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
            $set: previousId === null
                // 首次绑定不占每月一次的修改额度，只有改绑才记录月份。
                ? { school_cat: schoolId, school_cat_food: restored }
                : { school_cat: schoolId, school_cat_food: restored, school_cat_month: monthKey },
        },
    );
    try {
        await addLog({
            type: 'school_cat',
            userId: uid,
            sender: uid,
            action: previousId === null ? 'bind' : 'rebind',
            reason: previousId === null
                ? `绑定大猫 ${schoolDisplay(school)}${restored ? `，恢复历史投喂 ${restored}g` : ''}`
                : `从 #${previousId} 改绑 ${schoolDisplay(school)}，${contribution}g 转入历史投喂${restored ? `，恢复历史投喂 ${restored}g` : ''}`,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log school cat bind:', e);
    }
    return {
        boundId: schoolId,
        boundDisplay: schoolDisplay(school),
        boundUrl: schoolUrl(schoolId),
        movedToHistory: previousId === null ? 0 : contribution,
        restoredFromHistory: restored,
        canChange: previousId === null,
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
    const school: any = await getSchool(schoolId);
    if (!school) throw new Error('绑定的学校不存在，请重新绑定。');
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
        size: schoolCatSize(weight),
        visible: weight >= SCHOOL_CAT_MIN_WEIGHT,
        contribution: Math.max(0, Math.floor(Number(updatedUser?.school_cat_food) || 0)),
        balance: Math.max(0, Number(updatedUser?.cat_food) || 0),
        nextFeedAt: now.getTime() + SCHOOL_CAT_FEED_COOLDOWN_MS,
    };
}

async function getTopFeeder(schoolId: number) {
    const rows = await userColl.find(
        { school_cat: schoolId, school_cat_food: { $gt: 0 } },
    ).sort({ school_cat_food: -1, _id: 1 }).limit(1)
        .project({ _id: 1, school_cat_food: 1 }).toArray();
    return rows[0] || null;
}

export async function setSchoolCatPosition(uid: number, schoolId: number, x: number, y: number, now = new Date()) {
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以摆放大猫。');
    const school: any = await getSchool(schoolId);
    if (!school) throw new Error('该学校不存在。');
    const cat: any = await schoolCatColl.findOne({ _id: schoolId } as any);
    const weight = Math.max(0, Math.floor(Number(cat?.currentWeight) || 0));
    const size = schoolCatSize(weight);
    if (!size) throw new Error('这只大猫还没有出现在大猫世界（体重需达到 1024g）。');
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)
        || x < 0 || x > CAT_MAP_WIDTH - size || y < 0 || y > CAT_MAP_HEIGHT - size) {
        throw new Error(`左上角坐标超出范围：列 0～${CAT_MAP_WIDTH - size}，行 0～${CAT_MAP_HEIGHT - size}。`);
    }
    const top = await getTopFeeder(schoolId);
    if (!top || top._id !== uid) throw new Error('只有当前投喂榜第一名的用户可以摆放这只大猫。');
    const claimed = await schoolCatColl.updateOne(
        {
            _id: schoolId,
            $or: [
                { positionAt: { $exists: false } },
                { positionAt: { $lte: new Date(now.getTime() - SCHOOL_CAT_MOVE_COOLDOWN_MS) } },
            ],
        } as any,
        { $set: { x, y, positionAt: now, updatedAt: now } } as any,
    );
    if (!claimed.modifiedCount) {
        const nextAt = new Date(cat.positionAt).getTime() + SCHOOL_CAT_MOVE_COOLDOWN_MS;
        throw new Error(`每 2 小时只能改变一次位置，请在 ${new Date(nextAt).toLocaleString('zh-CN', { timeZone: TIME_ZONE })} 后再试。`);
    }
    try {
        await addLog({
            type: 'school_cat',
            userId: uid,
            sender: uid,
            action: 'position',
            reason: `摆放 ${schoolDisplay(school)} 到（行 ${y}, 列 ${x}）`,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log school cat position:', e);
    }
    return {
        schoolId,
        x,
        y,
        nextMoveAt: now.getTime() + SCHOOL_CAT_MOVE_COOLDOWN_MS,
    };
}

export async function getSchoolCatDetail(schoolId: number, viewerUid = 0) {
    const school: any = await getSchool(schoolId);
    if (!school) throw new Error('该学校不存在。');
    const cat: any = await schoolCatColl.findOne({ _id: schoolId } as any);
    const weight = Math.max(0, Math.floor(Number(cat?.currentWeight) || 0));
    const historyWeight = Math.max(0, Math.floor(Number(cat?.historyWeight) || 0));
    const currentRows = await userColl.find(
        { school_cat: schoolId, school_cat_food: { $gt: 0 } },
    ).sort({ school_cat_food: -1, _id: 1 }).limit(50)
        .project({ _id: 1, school_cat_food: 1 }).toArray();
    const historyRows = await schoolFeedHistoryColl.aggregate([
        { $match: { schoolId } },
        { $group: { _id: '$uid', amount: { $sum: '$amount' } } },
        { $sort: { amount: -1, _id: 1 } },
        { $limit: 50 },
    ]).toArray();
    let mine: any = null;
    if (viewerUid) {
        const viewer: any = await userColl.findOne({ _id: viewerUid });
        const historyMine = await schoolFeedHistoryColl.aggregate([
            { $match: { schoolId, uid: viewerUid } },
            { $group: { _id: null, amount: { $sum: '$amount' } } },
        ]).toArray();
        mine = {
            bound: Number.isSafeInteger(viewer?.school_cat) && viewer.school_cat === schoolId,
            current: viewer?.school_cat === schoolId ? Math.max(0, Math.floor(Number(viewer.school_cat_food) || 0)) : 0,
            history: Math.max(0, Math.floor(Number(historyMine[0]?.amount) || 0)),
        };
    }
    return {
        school: withDisplay(school),
        weight,
        historyWeight,
        size: schoolCatSize(weight),
        visible: weight >= SCHOOL_CAT_MIN_WEIGHT,
        position: Number.isSafeInteger(cat?.x) && Number.isSafeInteger(cat?.y)
            ? { x: cat.x, y: cat.y }
            : null,
        nextMoveAt: cat?.positionAt
            ? new Date(cat.positionAt).getTime() + SCHOOL_CAT_MOVE_COOLDOWN_MS
            : 0,
        canMove: weight >= SCHOOL_CAT_MIN_WEIGHT
            && !!viewerUid
            && currentRows.length > 0
            && currentRows[0]._id === viewerUid,
        current: currentRows.map((row: any) => ({ uid: row._id, amount: Math.max(0, Math.floor(Number(row.school_cat_food) || 0)) })),
        history: historyRows.map((row: any) => ({ uid: row._id, amount: Math.max(0, Math.floor(Number(row.amount) || 0)) })),
        mine,
    };
}
