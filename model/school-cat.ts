import { randomInt } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { db, ObjectId } from 'hydrooj';
import { catCanPoolColl } from './cat-can';
import { addLog, logColl } from './log';
import type { Oi33School } from './types';
import { userColl } from './user';

export const SCHOOL_CAT_FEED_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const SCHOOL_CAT_PAGE_SIZE = 50;
export const SCHOOL_CAT_COLOR_MAX = 0xFFFFFF;
export const SCHOOL_CAT_SIDEBAR_RANKING_SIZE = 32;
export const SCHOOL_CAT_WEEKLY_MIN_TERRITORY = 64;
export const SCHOOL_CAT_WEEKLY_MAX_BASE_CANS = 12;
export const SCHOOL_CAT_ADMIN_CANS_PER_FEEDER = 5;
export const SCHOOL_CAT_REWARD_PAGE_SIZE = 20;
export const SCHOOL_CAT_REWARD_ALLOCATION_PAGE_SIZE = 100;

const TIME_ZONE = 'Asia/Shanghai';

export const schoolCatColl = db.collection('oi33_school_cat');
export const schoolFeedHistoryColl = db.collection('oi33_school_feed_history');
export const schoolCatRewardColl = db.collection('oi33_school_cat_reward');

// The weekly reward subsystem lives in ./school-cat-reward; re-exported here so
// the barrel spread and direct importers keep resolving these names unchanged.
export {
    getSchoolCatWeeklyRewardDetail, getSchoolCatWeeklyRewardRollbackCheck,
    getSchoolCatWeeklyRewardStatus, listSchoolCatWeeklyRewards,
    rollbackSchoolCatWeeklyRewards, settleSchoolCatWeeklyRewards,
} from './school-cat-reward';

// Cell ownership uses 0 as the explicit "no big cat" sentinel. OIerDB has a
// real school #0, so persisted cat ids for schools are encoded as schoolId + 1.
// Special big cats use their negative id directly and can never collide with
// a real school key.
export function schoolCatKey(schoolId: number) {
    if (!Number.isSafeInteger(schoolId)) return 0;
    return schoolId >= 0 ? schoolId + 1 : schoolId;
}

export function schoolIdFromCatKey(catId: number) {
    if (!Number.isSafeInteger(catId) || catId === 0) return null;
    return catId > 0 ? catId - 1 : catId;
}

export function schoolCatColorCss(color: number) {
    const safe = Math.max(0, Math.min(SCHOOL_CAT_COLOR_MAX, Math.floor(Number(color) || 0)));
    return `#${safe.toString(16).padStart(6, '0')}`;
}

export function schoolDisplay(school: { _id: number; prov: string; abbr: string }) {
    return `${school.abbr}#${school._id}`;
}

export function schoolUrl(schoolId: number) {
    if (!Number.isSafeInteger(schoolId) || schoolId < 0) return null;
    return `https://oier.baoshuo.dev/school/${schoolId}`;
}

// Only special big cats (negative ids) get the admin treatment: a star
// instead of a numeric rank and fixed weekly rewards. The legacy isAdminCat
// flag is gone — /oi33/migrate strips it from old records.
export function isAdminSchoolCatRecord(cat: any) {
    return Number(cat?._id) < 0;
}

function shanghaiMonthKey(now = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}`;
}

export function schoolCatRewardPeriod(now = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
    const localDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
    const daysSinceMonday = (localDate.getUTCDay() + 6) % 7;
    localDate.setUTCDate(localDate.getUTCDate() - daysSinceMonday);
    return localDate.toISOString().slice(0, 10);
}

export function schoolCatTerritoryBaseReward(territoryCount: number) {
    const cells = Math.max(0, Math.floor(Number(territoryCount) || 0));
    if (cells < SCHOOL_CAT_WEEKLY_MIN_TERRITORY) return 0;
    return Math.min(
        SCHOOL_CAT_WEEKLY_MAX_BASE_CANS,
        1 + Math.floor(Math.log2(cells / SCHOOL_CAT_WEEKLY_MIN_TERRITORY)),
    );
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
    if (!Number.isSafeInteger(schoolId)) throw new Error('该学校不存在。');
    if (schoolId >= 0) {
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
    }
    for (let attempt = 0; attempt < 64; attempt++) {
        const current: any = await schoolCatColl.findOne({ _id: schoolId } as any);
        if (!current) throw new Error(schoolId < 0 ? '该特殊大猫不存在。' : '该学校不存在。');
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
        schoolCatColl.createIndex({ name: 1 }, { unique: true, sparse: true }),
        schoolFeedHistoryColl.createIndex({ schoolId: 1, uid: 1 }),
        schoolFeedHistoryColl.createIndex({ uid: 1, createdAt: -1 }),
        userColl.createIndex({ school_cat: 1, school_cat_food: -1, _id: 1 }),
        userColl.createIndex({ school_cat_reward_period: 1 }),
        schoolCatRewardColl.createIndex({ createdAt: -1 }),
        schoolCatRewardColl.createIndex({ status: 1, createdAt: -1 }),
    ]);
}

function withDisplay(school: any) {
    return {
        id: school._id,
        display: schoolDisplay(school),
        prov: school.prov,
        url: schoolUrl(school._id),
        special: school.special === true,
    };
}

export async function getSchool(schoolId: number) {
    if (!Number.isSafeInteger(schoolId) || schoolId < 0) return null;
    return schoolById.get(schoolId) || null;
}

// Unified display view: real schools come from the static OIerDB table,
// special big cats (negative ids) from their oi33_school_cat record.
export async function getSchoolView(schoolId: number) {
    if (!Number.isSafeInteger(schoolId)) return null;
    if (schoolId >= 0) {
        const school = schoolById.get(schoolId);
        return school ? { ...school, special: false } : null;
    }
    const cat: any = await schoolCatColl.findOne({ _id: schoolId } as any);
    if (!cat || !cat.name) return null;
    return {
        _id: schoolId,
        prov: '',
        abbr: String(cat.name),
        special: true,
        name: String(cat.name),
    };
}

// Synchronous view for a cat record already loaded from oi33_school_cat.
function schoolViewFor(cat: any) {
    if (Number(cat?._id) < 0) {
        return cat?.name
            ? { _id: cat._id, prov: '', abbr: String(cat.name), special: true, name: String(cat.name) }
            : null;
    }
    const school = schoolById.get(Number(cat?._id));
    return school ? { ...school, special: false } : null;
}

async function searchSpecialSchoolCats(query: string, limit = 20) {
    const cats: any[] = await schoolCatColl.find({ _id: { $lt: 0 } } as any).sort({ _id: -1 }).toArray();
    const upper = (query || '').trim().toUpperCase();
    const matched = upper
        ? cats.filter((cat) => String(cat.name || '').toUpperCase().includes(upper))
        : cats;
    return matched.slice(0, limit).map((cat) => ({
        ...withDisplay(schoolViewFor(cat)),
        name: String(cat.name || ''),
    }));
}

export async function searchSchools(query: string, limit = 20, includeSpecial = false) {
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
    const rows = matched.slice(0, capped).map(withDisplay);
    // Special big cats are only searchable by administrators (flag >= 2),
    // enforced by the route handler passing includeSpecial.
    return includeSpecial ? rows.concat(await searchSpecialSchoolCats(trimmed, capped)) : rows;
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
    const color = Math.max(0, Math.floor(Number(cat.territoryColor) || 0));
    return {
        id: cat._id,
        catId: schoolCatKey(cat._id),
        display: school ? schoolDisplay(school) : `#${cat._id}`,
        url: schoolUrl(cat._id),
        color,
        colorCss: schoolCatColorCss(color),
        weight,
        historyWeight: Math.max(0, Math.floor(Number(cat.historyWeight) || 0)),
        territoryCount: Math.max(0, Math.floor(Number(cat.territoryCount) || 0)),
        isAdminCat: isAdminSchoolCatRecord(cat),
    };
}

const activeSchoolCatFilter = {
    $or: [
        { currentWeight: { $gt: 0 } },
        { territoryCount: { $gt: 0 } },
    ],
};

export async function getSchoolCatRanking() {
    const cats: any[] = await schoolCatColl.find(activeSchoolCatFilter as any).toArray();
    const rows = cats.map((cat: any) => ({ cat, view: publicCat(cat, schoolViewFor(cat)) }));
    rows.sort((a: any, b: any) => b.view.territoryCount - a.view.territoryCount
        || b.view.weight - a.view.weight || a.view.id - b.view.id);
    let numericRank = 0;
    return rows.map(({ cat, view }: any) => ({
        ...view,
        // Administrative cats stay visible at their territory-sorted position,
        // but do not consume a numeric place in the public ranking.
        rank: isAdminSchoolCatRecord(cat) ? null : ++numericRank,
    }));
}

export async function getBigCatWorldState(viewerUid = 0) {
    const [ranking, viewer]: any[] = await Promise.all([
        getSchoolCatRanking(),
        viewerUid
            ? userColl.findOne({ _id: viewerUid, realname_flag: { $gte: 1 } })
            : Promise.resolve(null),
    ]);
    const boundId = viewer && Number.isSafeInteger(viewer.school_cat) ? viewer.school_cat : null;
    let me: any = null;
    if (viewer) {
        const boundSchool = boundId === null ? null : await getSchoolView(boundId);
        const boundCat: any = boundId === null
            ? null
            : ranking.find((cat: any) => cat.id === boundId)
                || await schoolCatColl.findOne({ _id: boundId } as any);
        const boundColor = boundCat?.color ?? boundCat?.territoryColor;
        me = {
            food: Math.max(0, Number(viewer.cat_food) || 0),
            boundId,
            boundCatId: boundId === null ? 0 : schoolCatKey(boundId),
            boundDisplay: boundSchool ? schoolDisplay(boundSchool) : null,
            boundUrl: boundId === null ? null : schoolUrl(boundId),
            boundColor: validTerritoryColor(boundColor) ? boundColor : null,
            contribution: Math.max(0, Math.floor(Number(viewer.school_cat_food) || 0)),
            canChange: (viewer.school_cat_month || '') !== shanghaiMonthKey(),
            nextFeedAt: viewer.school_cat_feed_at
                ? new Date(viewer.school_cat_feed_at).getTime() + SCHOOL_CAT_FEED_COOLDOWN_MS
                : 0,
        };
    }
    return {
        cats: ranking,
        ranking: ranking.slice(0, SCHOOL_CAT_SIDEBAR_RANKING_SIZE).map((cat: any) => ({
            id: cat.id,
            catId: cat.catId,
            display: cat.display,
            url: cat.url,
            color: cat.color,
            weight: cat.weight,
            territoryCount: cat.territoryCount,
            isAdminCat: cat.isAdminCat,
            rank: cat.rank,
        })),
        rankingTotal: ranking.length,
        me,
        serverTime: Date.now(),
    };
}

export const SCHOOL_CAT_SPECIAL_NAME_MAX = 30;

export async function createSpecialSchoolCat(operator: number, name: string, now = new Date()) {
    const admin: any = await getEligibleUser(operator);
    if (!admin || (Number(admin.realname_flag) || 0) < 3) {
        throw new Error('仅行政管理员可以创建特殊大猫。');
    }
    const trimmed = String(name || '').trim();
    if (!trimmed || trimmed.length > SCHOOL_CAT_SPECIAL_NAME_MAX) {
        throw new Error(`特殊大猫名字必须是 1～${SCHOOL_CAT_SPECIAL_NAME_MAX} 个字符。`);
    }
    if (await schoolCatColl.findOne({ _id: { $lt: 0 }, name: trimmed } as any)) {
        throw new Error('已存在同名的特殊大猫。');
    }
    let schoolId = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
        // Special big cats take the next free negative id, starting at -1.
        const lowest: any[] = await schoolCatColl.find({ _id: { $lt: 0 } } as any)
            .sort({ _id: 1 }).limit(1).project({ _id: 1 }).toArray();
        schoolId = (Number(lowest[0]?._id) || 0) - 1;
        try {
            await schoolCatColl.insertOne({
                _id: schoolId,
                name: trimmed,
                currentWeight: 0,
                historyWeight: 0,
                territoryCount: 0,
                spawnedAt: now,
                updatedAt: now,
            } as any);
            break;
        } catch (e: any) {
            if (e?.code !== 11000) throw e;
            if (await schoolCatColl.findOne({ _id: { $lt: 0 }, name: trimmed } as any)) {
                throw new Error('已存在同名的特殊大猫。');
            }
            if (attempt === 7) throw new Error('分配特殊大猫编号失败，请重试。');
        }
    }
    const cat: any = await ensureSchoolCatRecord(schoolId, now);
    await addLog({
        type: 'school_cat',
        userId: operator,
        sender: operator,
        action: 'special_cat_create',
        catId: schoolCatKey(schoolId),
        reason: `创建特殊大猫 ${trimmed}#${schoolId}`,
    } as any);
    return publicCat(cat, schoolViewFor(cat));
}

export async function renameSpecialSchoolCat(
    operator: number, schoolId: number, name: string, now = new Date(),
) {
    const admin: any = await getEligibleUser(operator);
    if (!admin || (Number(admin.realname_flag) || 0) < 3) {
        throw new Error('仅行政管理员可以重命名特殊大猫。');
    }
    if (!Number.isSafeInteger(schoolId) || schoolId >= 0) throw new Error('只有特殊大猫可以改名。');
    const trimmed = String(name || '').trim();
    if (!trimmed || trimmed.length > SCHOOL_CAT_SPECIAL_NAME_MAX) {
        throw new Error(`特殊大猫名字必须是 1～${SCHOOL_CAT_SPECIAL_NAME_MAX} 个字符。`);
    }
    const cat: any = await schoolCatColl.findOne({ _id: schoolId } as any);
    if (!cat) throw new Error('该特殊大猫不存在。');
    const previous = String(cat.name || '');
    if (previous === trimmed) return { ...publicCat(cat, schoolViewFor(cat)), changed: false };
    if (await schoolCatColl.findOne({ _id: { $lt: 0, $ne: schoolId }, name: trimmed } as any)) {
        throw new Error('已存在同名的特殊大猫。');
    }
    const stateFilter = Object.prototype.hasOwnProperty.call(cat, 'name')
        ? { name: cat.name }
        : { name: { $exists: false } };
    try {
        const result = await schoolCatColl.updateOne(
            { _id: schoolId, ...stateFilter } as any,
            { $set: { name: trimmed, updatedAt: now } } as any,
        );
        if (!result.modifiedCount) throw new Error('特殊大猫刚刚发生变化，请刷新后重试。');
    } catch (e: any) {
        if (e?.code === 11000) throw new Error('已存在同名的特殊大猫。');
        throw e;
    }
    await addLog({
        type: 'school_cat',
        userId: operator,
        sender: operator,
        action: 'special_cat_rename',
        catId: schoolCatKey(schoolId),
        reason: `将特殊大猫 #${schoolId} 从「${previous}」改名为「${trimmed}」`,
    } as any);
    const updated: any = await schoolCatColl.findOne({ _id: schoolId } as any);
    return { ...publicCat(updated, schoolViewFor(updated)), changed: true };
}

export async function listSpecialSchoolCats() {
    const cats: any[] = await schoolCatColl.find({ _id: { $lt: 0 } } as any).sort({ _id: -1 }).toArray();
    return cats.map((cat: any) => ({ ...publicCat(cat, schoolViewFor(cat)), name: String(cat.name || '') }));
}

// model/cat-map.ts imports this module, so the cell collection is referenced
// directly here instead of importing it back (which would be circular).
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
    const currentWeight = Math.max(0, Math.floor(Number(fromCat.currentWeight) || 0));
    const historyWeight = Math.max(0, Math.floor(Number(fromCat.historyWeight) || 0));
    const users = await userColl.updateMany({ school_cat: fromId } as any, { $set: { school_cat: toId } });
    const history = await schoolFeedHistoryColl.updateMany(
        { schoolId: fromId } as any, { $set: { schoolId: toId } },
    );
    await schoolCatColl.updateOne(
        { _id: toId } as any,
        { $inc: { currentWeight, historyWeight }, $set: { updatedAt: now } } as any,
    );
    await schoolCatColl.updateOne(
        { _id: fromId } as any,
        { $set: { currentWeight: 0, historyWeight: 0, updatedAt: now } } as any,
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
            + `${history.modifiedCount} 条投喂历史、${cells.modifiedCount} 格领地、`
            + `体重 ${currentWeight}g（历史 ${historyWeight}g）`,
    } as any);
    return {
        fromId,
        toId,
        display: schoolDisplay(toView),
        users: users.modifiedCount,
        history: history.modifiedCount,
        cells: cells.modifiedCount,
        currentWeight,
        historyWeight,
    };
}

const uncountedMoveContributionFilter = {
    type: 'cat_account',
    action: { $in: ['cat_map_move', 'cat_map_territory_teleport'] },
    amount: { $lt: 0 },
    schoolCatContributionCounted: { $ne: true },
};

// Legacy movement logs predate per-move big-cat attribution. This operation
// claims them per user, aggregates inside MongoDB, then attributes the exact
// burned food to that user's current binding. Bound/verified users are handled
// without loading individual movement rows into the application process.
export async function backfillSchoolCatMoveContributions(operator: number, now = new Date()) {
    const admin: any = await getEligibleUser(operator);
    if (!admin || (Number(admin.realname_flag) || 0) < 3) {
        throw new Error('仅行政管理员可以回算历史移动贡献。');
    }
    const candidateValues = await logColl.distinct('userId', uncountedMoveContributionFilter as any);
    const candidateUids = candidateValues.filter((uid: any): uid is number => Number.isSafeInteger(uid));
    const eligibleByUid = new Map<number, any>();
    for (let offset = 0; offset < candidateUids.length; offset += 2000) {
        const chunk = candidateUids.slice(offset, offset + 2000);
        const rows: any[] = await userColl.find({
            _id: { $in: chunk },
            realname_flag: { $gte: 1 },
            school_cat: { $exists: true },
        } as any, { projection: { school_cat: 1 } }).toArray();
        rows.forEach((row: any) => {
            if (Number.isSafeInteger(row.school_cat)) eligibleByUid.set(row._id, row);
        });
    }

    let moves = 0;
    let contribution = 0;
    const affectedCatIds = new Set<number>();
    for (const uid of candidateUids) {
        const user = eligibleByUid.get(uid);
        if (!user) continue;
        const schoolId = Number(user.school_cat);
        await ensureSchoolCatRecord(schoolId, now);
        const batchId = new ObjectId();
        const claimed = await logColl.updateMany({
            ...uncountedMoveContributionFilter,
            userId: uid,
            schoolCatContributionBatch: { $exists: false },
        } as any, {
            $set: { schoolCatContributionBatch: batchId, catId: schoolCatKey(schoolId) },
        } as any);
        if (!claimed.modifiedCount) continue;

        const summary: any[] = await logColl.aggregate([
            { $match: { schoolCatContributionBatch: batchId } },
            {
                $group: {
                    _id: null,
                    amount: { $sum: { $multiply: ['$amount', -1] } },
                    moves: { $sum: 1 },
                },
            },
        ]).toArray();
        const amount = Math.max(0, Math.floor(Number(summary[0]?.amount) || 0));
        const moveCount = Math.max(0, Math.floor(Number(summary[0]?.moves) || 0));
        let userApplied = false;
        let catApplied = false;
        try {
            if (!amount || !moveCount) throw new Error('历史移动日志金额无效。');
            const userResult = await userColl.updateOne({
                _id: uid,
                realname_flag: { $gte: 1 },
                school_cat: schoolId,
            }, { $inc: { school_cat_food: amount } });
            if (!userResult.modifiedCount) throw new Error(`UID ${uid} 的大猫绑定刚刚发生变化，请重试。`);
            userApplied = true;
            const catResult = await schoolCatColl.updateOne(
                { _id: schoolId } as any,
                { $inc: { currentWeight: amount }, $set: { updatedAt: now } } as any,
            );
            if (!catResult.modifiedCount) throw new Error(`大猫 #${schoolId} 的历史贡献更新失败。`);
            catApplied = true;
            const marked = await logColl.updateMany(
                { schoolCatContributionBatch: batchId } as any,
                {
                    $set: { schoolCatContributionCounted: true },
                    $unset: { schoolCatContributionBatch: '' },
                } as any,
            );
            if (marked.modifiedCount !== moveCount) throw new Error(`UID ${uid} 的历史移动标记不完整。`);
        } catch (e) {
            if (catApplied) {
                await schoolCatColl.updateOne(
                    { _id: schoolId } as any,
                    { $inc: { currentWeight: -amount }, $set: { updatedAt: now } } as any,
                );
            }
            if (userApplied) await userColl.updateOne({ _id: uid }, { $inc: { school_cat_food: -amount } });
            await logColl.updateMany(
                { schoolCatContributionBatch: batchId } as any,
                { $unset: { schoolCatContributionBatch: '', catId: '', schoolCatContributionCounted: '' } } as any,
            );
            throw e;
        }
        moves += moveCount;
        contribution += amount;
        affectedCatIds.add(schoolId);
    }
    const pendingMoves = await logColl.countDocuments(uncountedMoveContributionFilter as any);
    await addLog({
        type: 'school_cat',
        userId: operator,
        sender: operator,
        action: 'move_contribution_backfill',
        amount: contribution,
        reason: `按用户当前绑定回算 ${moves} 次历史猫粮移动，共 ${contribution}g；仍有 ${pendingMoves} 次因未认证或未绑定而待处理`,
    } as any);
    return {
        moves,
        contribution,
        pendingMoves,
        affectedCatIds: Array.from(affectedCatIds),
    };
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
    const school: any = await getSchoolView(schoolId);
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
    const school: any = await getSchoolView(schoolId);
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
        isAdminCat: isAdminSchoolCatRecord(cat),
        canSetColor: !!viewerUid
            && currentRows.length > 0
            && currentRows[0]._id === viewerUid,
        current: currentRows.map((row: any) => ({ uid: row._id, amount: Math.max(0, Math.floor(Number(row.school_cat_food) || 0)) })),
        history: historyRows.map((row: any) => ({ uid: row._id, amount: Math.max(0, Math.floor(Number(row.amount) || 0)) })),
        mine,
    };
}
