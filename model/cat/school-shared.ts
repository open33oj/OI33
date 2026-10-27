import { randomInt } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { db } from 'hydrooj';
import type { Oi33School } from '../types';
import { userColl } from '../user';

// 大猫世界的共享底座：集合、OIerDB 静态学校表、学校 id ↔ 格子 catId 的编解码、
// 展示字段、随机颜色、周奖励的周期与领地基础奖励，以及所有模块共用的
// `getEligibleUser` / `publicCat` / `withDisplay` / `getSchoolView` / `getTopFeeder`。
// 本模块不依赖 school.ts 的页面视图，避免循环。

export const SCHOOL_CAT_FEED_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const SCHOOL_CAT_PAGE_SIZE = 50;
export const SCHOOL_CAT_COLOR_MAX = 0xFFFFFF;
export const SCHOOL_CAT_SIDEBAR_RANKING_SIZE = 32;
export const SCHOOL_CAT_WEEKLY_MIN_TERRITORY = 64;
export const SCHOOL_CAT_WEEKLY_MAX_BASE_CANS = 12;
export const SCHOOL_CAT_ADMIN_CANS_PER_FEEDER = 5;
export const SCHOOL_CAT_REWARD_PAGE_SIZE = 20;
export const SCHOOL_CAT_REWARD_ALLOCATION_PAGE_SIZE = 100;

export const TIME_ZONE = 'Asia/Shanghai';

export const schoolCatColl = db.collection('oi33_school_cat');
export const schoolFeedHistoryColl = db.collection('oi33_school_feed_history');
export const schoolCatRewardColl = db.collection('oi33_school_cat_reward');
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

export function shanghaiMonthKey(now = new Date()) {
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
export const schoolDataFile = path.join(__dirname, '../../data/school-cat-data.json');
export const schoolData = JSON.parse(readFileSync(schoolDataFile, 'utf-8'));
export const schools: Oi33School[] = (schoolData.schools || [])
    .map(([code, prov, abbr]: [number, string, string]) => ({ _id: code, prov, abbr }))
    .sort((a: Oi33School, b: Oi33School) => a._id - b._id);
export const schoolById = new Map<number, Oi33School>(schools.map((school) => [school._id, school]));

export function validTerritoryColor(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= SCHOOL_CAT_COLOR_MAX;
}

export function unusedRandomColor(used: Set<number>) {
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

export function withDisplay(school: any) {
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
export function schoolViewFor(cat: any) {
    if (Number(cat?._id) < 0) {
        return cat?.name
            ? { _id: cat._id, prov: '', abbr: String(cat.name), special: true, name: String(cat.name) }
            : null;
    }
    const school = schoolById.get(Number(cat?._id));
    return school ? { ...school, special: false } : null;
}

export function publicCat(cat: any, school: any) {
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

export const activeSchoolCatFilter = {
    $or: [
        { currentWeight: { $gt: 0 } },
        { territoryCount: { $gt: 0 } },
    ],
};

export async function getTopFeeder(schoolId: number) {
    const rows = await userColl.find(
        { school_cat: schoolId, school_cat_food: { $gt: 0 } },
    ).sort({ school_cat_food: -1, _id: 1 }).limit(1)
        .project({ _id: 1, school_cat_food: 1 }).toArray();
    return rows[0] || null;
}

