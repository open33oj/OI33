import { randomInt } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { db, ObjectId } from 'hydrooj';
import { catCanPoolColl } from './cat-can';
import { addLog } from './log';
import type { Oi33School } from './types';
import { userColl } from './user';

export const SCHOOL_CAT_FEED_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const SCHOOL_CAT_PAGE_SIZE = 50;
export const SCHOOL_CAT_COLOR_MAX = 0xFFFFFF;

const TIME_ZONE = 'Asia/Shanghai';

export const schoolCatColl = db.collection('oi33_school_cat');
export const schoolFeedHistoryColl = db.collection('oi33_school_feed_history');

// Cell ownership uses 0 as the explicit "no big cat" sentinel. OIerDB has a
// real school #0, so persisted cat ids are encoded as schoolId + 1.
export function schoolCatKey(schoolId: number) {
    return Number.isSafeInteger(schoolId) && schoolId >= 0 ? schoolId + 1 : 0;
}

export function schoolIdFromCatKey(catId: number) {
    return Number.isSafeInteger(catId) && catId > 0 ? catId - 1 : null;
}

export function schoolCatColorCss(color: number) {
    const safe = Math.max(0, Math.min(SCHOOL_CAT_COLOR_MAX, Math.floor(Number(color) || 0)));
    return `#${safe.toString(16).padStart(6, '0')}`;
}

export function schoolDisplay(school: { _id: number; prov: string; abbr: string }) {
    return `${school.abbr}#${school._id}`;
}

export function schoolUrl(schoolId: number) {
    return `https://oier.baoshuo.dev/school/${schoolId}`;
}

function shanghaiMonthKey(now = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}`;
}

const schoolDataFile = path.join(__dirname, 'school-cat-data.json');
const schoolData = JSON.parse(readFileSync(schoolDataFile, 'utf-8'));
const schools: Oi33School[] = (schoolData.schools || [])
    .map(([code, prov, abbr]: [number, string, string]) => ({ _id: code, prov, abbr }))
    .sort((a: Oi33School, b: Oi33School) => a._id - b._id);
const schoolById = new Map<number, Oi33School>(schools.map((school) => [school._id, school]));

function validTerritoryColor(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= SCHOOL_CAT_COLOR_MAX;
}

function unusedRandomColor(used: Set<number>) {
    for (let attempt = 0; attempt < 1000; attempt++) {
        const color = randomInt(SCHOOL_CAT_COLOR_MAX + 1);
        if (!used.has(color)) return color;
    }
    for (let color = 0; color <= SCHOOL_CAT_COLOR_MAX; color++) {
        if (!used.has(color)) return color;
    }
    throw new Error('没有可分配的大猫领地颜色。');
}

export async function ensureSchoolCatRecord(schoolId: number, now = new Date()) {
    if (!schoolById.has(schoolId)) throw new Error('该学校不存在。');
    await schoolCatColl.updateOne(
        { _id: schoolId } as any,
        {
            $setOnInsert: {
                currentWeight: 0,
                historyWeight: 0,
                territoryCount: 0,
                spawnedAt: now,
                updatedAt: now,
            },
        } as any,
        { upsert: true },
    );
    for (let attempt = 0; attempt < 64; attempt++) {
        const current: any = await schoolCatColl.findOne({ _id: schoolId } as any);
        if (validTerritoryColor(current?.territoryColor)) return current;
        const territoryColor = randomInt(SCHOOL_CAT_COLOR_MAX + 1);
        const colorFilter = current && Object.prototype.hasOwnProperty.call(current, 'territoryColor')
            ? { territoryColor: current.territoryColor }
            : { territoryColor: { $exists: false } };
        try {
            const assigned = await schoolCatColl.updateOne(
                { _id: schoolId, ...colorFilter } as any,
                { $set: { territoryColor, updatedAt: now } } as any,
            );
            if (assigned.modifiedCount) return await schoolCatColl.findOne({ _id: schoolId } as any);
        } catch (e: any) {
            if (e?.code !== 11000) throw e;
        }
    }
    throw new Error('分配大猫领地颜色失败，请重试。');
}

export async function ensureSchoolCatIndexes() {
    const now = new Date();
    // Position fields belonged to the retired sprite-placement implementation.
    await schoolCatColl.updateMany({
        $or: [
            { x: { $exists: true } },
            { y: { $exists: true } },
            { positionAt: { $exists: true } },
        ],
    }, { $unset: { x: '', y: '', positionAt: '' } } as any);
    await schoolCatColl.updateMany(
        { territoryCount: { $exists: false } },
        { $set: { territoryCount: 0 } } as any,
    );

    // Repair missing/duplicate legacy colors before enforcing uniqueness.
    const colorDocs: any[] = await schoolCatColl.find({}).sort({ _id: 1 })
        .project({ territoryColor: 1 }).toArray();
    const used = new Set<number>();
    const needsColor: any[] = [];
    // Reserve every valid first occurrence before assigning replacements.
    // This also works when the unique index already exists: a replacement
    // can never collide with a valid color later in the sorted result set.
    for (const cat of colorDocs) {
        if (validTerritoryColor(cat.territoryColor) && !used.has(cat.territoryColor)) {
            used.add(cat.territoryColor);
        } else needsColor.push(cat);
    }
    const colorOps: any[] = [];
    for (const cat of needsColor) {
        const territoryColor = unusedRandomColor(used);
        used.add(territoryColor);
        colorOps.push({
            updateOne: {
                filter: { _id: cat._id },
                update: { $set: { territoryColor, updatedAt: now } },
            },
        });
    }
    if (colorOps.length) await schoolCatColl.bulkWrite(colorOps, { ordered: false });
    await Promise.all([
        schoolCatColl.createIndex({ currentWeight: -1 }),
        schoolCatColl.createIndex({ territoryCount: -1 }),
        schoolCatColl.createIndex({ territoryColor: 1 }, { unique: true, sparse: true }),
        schoolFeedHistoryColl.createIndex({ schoolId: 1, uid: 1 }),
        schoolFeedHistoryColl.createIndex({ uid: 1, createdAt: -1 }),
        userColl.createIndex({ school_cat: 1, school_cat_food: -1, _id: 1 }),
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
    return schoolById.get(schoolId) || null;
}

export async function searchSchools(query: string, limit = 20) {
    const trimmed = (query || '').trim();
    const capped = Math.max(1, Math.min(50, limit));
    if (!trimmed) return schools.slice(0, capped).map(withDisplay);
    if (/^\d+$/.test(trimmed)) {
        const school = schoolById.get(Number(trimmed));
        return school ? [withDisplay(school)] : [];
    }
    const upper = trimmed.toUpperCase();
    let matched: Oi33School[];
    if (upper.includes('#')) {
        // 省份代码#缩写前缀（JX#JJSDYZX、JX#JJ）或 缩写#编号（JJSDYZX#13396）。
        const [rawLeft, ...rest] = upper.split('#');
        const left = rawLeft.trim();
        const right = rest.join('#').trim();
        if (left && right && !/^\d+$/.test(right)) {
            matched = schools.filter((school) => (school.prov === left && school.abbr.startsWith(right))
                || school.abbr.startsWith(left));
        } else if (left && /^\d+$/.test(right)) {
            const school = schoolById.get(Number(right));
            matched = school && school.abbr.startsWith(left) ? [school] : [];
        } else if (left) {
            matched = schools.filter((school) => school.abbr.startsWith(left) || school.prov.startsWith(left));
        } else matched = schools;
    } else {
        // 普通文本：缩写子串（JJSD）或省份代码前缀（JX）。
        matched = schools.filter((school) => school.abbr.includes(upper) || school.prov.startsWith(upper));
    }
    return matched.slice(0, capped).map(withDisplay);
}

export async function listSchools(page = 1, pageSize = SCHOOL_CAT_PAGE_SIZE) {
    const size = Math.max(1, Math.min(200, pageSize));
    const total = schools.length;
    const current = Math.max(1, Math.min(Math.ceil(total / size) || 1, Math.floor(page) || 1));
    const pageRows = schools.slice((current - 1) * size, current * size);
    return {
        schools: pageRows.map(withDisplay),
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
        catId: schoolCatKey(cat._id),
        display: school ? schoolDisplay(school) : `#${cat._id}`,
        url: schoolUrl(cat._id),
        color: Math.max(0, Math.floor(Number(cat.territoryColor) || 0)),
        weight,
        historyWeight: Math.max(0, Math.floor(Number(cat.historyWeight) || 0)),
        territoryCount: Math.max(0, Math.floor(Number(cat.territoryCount) || 0)),
    };
}

export async function getBigCatWorldState(viewerUid = 0) {
    const [cats, viewer]: any[] = await Promise.all([
        schoolCatColl.find({
            $or: [
                { currentWeight: { $gt: 0 } },
                { historyWeight: { $gt: 0 } },
                { territoryCount: { $gt: 0 } },
            ],
        }).toArray(),
        viewerUid
            ? userColl.findOne({ _id: viewerUid, realname_flag: { $gte: 1 } })
            : Promise.resolve(null),
    ]);
    const boundId = viewer && Number.isSafeInteger(viewer.school_cat) ? viewer.school_cat : null;
    const visible = cats.map((cat: any) => publicCat(cat, schoolById.get(cat._id)))
        .sort((a: any, b: any) => b.weight - a.weight
            || b.territoryCount - a.territoryCount || a.id - b.id);
    let me: any = null;
    if (viewer) {
        const boundSchool = boundId === null ? null : schoolById.get(boundId);
        const boundCat: any = boundId === null
            ? null
            : cats.find((cat: any) => cat._id === boundId)
                || await schoolCatColl.findOne({ _id: boundId } as any);
        me = {
            food: Math.max(0, Number(viewer.cat_food) || 0),
            boundId,
            boundCatId: boundId === null ? 0 : schoolCatKey(boundId),
            boundDisplay: boundSchool ? schoolDisplay(boundSchool) : null,
            boundUrl: boundId === null ? null : schoolUrl(boundId),
            boundColor: validTerritoryColor(boundCat?.territoryColor) ? boundCat.territoryColor : null,
            contribution: Math.max(0, Math.floor(Number(viewer.school_cat_food) || 0)),
            canChange: (viewer.school_cat_month || '') !== shanghaiMonthKey(),
            nextFeedAt: viewer.school_cat_feed_at
                ? new Date(viewer.school_cat_feed_at).getTime() + SCHOOL_CAT_FEED_COOLDOWN_MS
                : 0,
        };
    }
    return {
        cats: visible,
        ranking: visible.slice(0, 100).map((cat: any) => ({
            id: cat.id,
            catId: cat.catId,
            display: cat.display,
            url: cat.url,
            color: cat.color,
            weight: cat.weight,
            territoryCount: cat.territoryCount,
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
        boundCatId: schoolCatKey(schoolId),
        boundDisplay: schoolDisplay(school),
        boundUrl: schoolUrl(schoolId),
        boundColor: targetCat.territoryColor,
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

export async function setSchoolCatTerritoryColor(
    uid: number, schoolId: number, territoryColor: number, now = new Date(),
) {
    if (!validTerritoryColor(territoryColor)) throw new Error('领地颜色必须是有效的 #RRGGBB 颜色。');
    const user: any = await getEligibleUser(uid);
    if (!user) throw new Error('只有已认证用户可以修改大猫领地颜色。');
    if (!Number.isSafeInteger(user.school_cat) || user.school_cat !== schoolId) {
        throw new Error('只能修改自己当前绑定的大猫颜色。');
    }
    const school: any = await getSchool(schoolId);
    if (!school) throw new Error('该学校不存在。');
    const cat: any = await ensureSchoolCatRecord(schoolId, now);
    const top = await getTopFeeder(schoolId);
    if (!top || top._id !== uid) throw new Error('只有当前贡献最多的用户可以修改这只大猫的领地颜色。');
    if (cat.territoryColor === territoryColor) return {
        schoolId, catId: schoolCatKey(schoolId), color: territoryColor,
    };
    try {
        await schoolCatColl.updateOne(
            { _id: schoolId } as any,
            { $set: { territoryColor, updatedAt: now } } as any,
        );
    } catch (e: any) {
        if (e?.code === 11000) throw new Error('这个颜色已被其他大猫使用，请换一个颜色。');
        throw e;
    }
    try {
        await addLog({
            type: 'school_cat',
            userId: uid,
            sender: uid,
            action: 'territory_color',
            color: territoryColor,
            reason: `将 ${schoolDisplay(school)} 的领地颜色改为 ${schoolCatColorCss(territoryColor)}`,
        } as any);
    } catch (e) {
        console.error('[oi33] failed to log school cat territory color:', e);
    }
    return {
        schoolId,
        catId: schoolCatKey(schoolId),
        color: territoryColor,
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
        catId: schoolCatKey(schoolId),
        color: validTerritoryColor(cat?.territoryColor) ? cat.territoryColor : null,
        territoryCount: Math.max(0, Math.floor(Number(cat?.territoryCount) || 0)),
        canSetColor: !!viewerUid
            && currentRows.length > 0
            && currentRows[0]._id === viewerUid,
        current: currentRows.map((row: any) => ({ uid: row._id, amount: Math.max(0, Math.floor(Number(row.school_cat_food) || 0)) })),
        history: historyRows.map((row: any) => ({ uid: row._id, amount: Math.max(0, Math.floor(Number(row.amount) || 0)) })),
        mine,
    };
}
