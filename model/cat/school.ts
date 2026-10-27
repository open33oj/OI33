import { addLog } from '../log';
import type { Oi33School } from '../types';
import { userColl } from '../user';
import { SCHOOL_CAT_PAGE_SIZE, SCHOOL_CAT_SIDEBAR_RANKING_SIZE, activeSchoolCatFilter, ensureSchoolCatRecord, getSchoolView, isAdminSchoolCatRecord, publicCat, schoolById, schoolCatColl, schoolCatColorCss, schoolCatKey, schoolDisplay, schoolUrl, schoolViewFor, schools, shanghaiMonthKey, validTerritoryColor, withDisplay } from './school-shared';
import { getEligibleUser } from './eligibility';
import { countUserCatCells, listCatCellRanking } from './map';
import { catCellRewardCans } from './cell-reward-rules';

// 大猫页面视图与管理员操作：学校/大猫搜索与列表、侧栏排行、大猫世界状态、
// 特殊大猫的创建/改名、领地颜色与详情页。
// 绑定/投喂在 school-player.ts，转移/历史贡献回填在 school-transfer.ts。
//
// 从旧 `model/school-cat.ts` 搬到这里的周奖励再导出，保证既有调用方不变。

// The weekly reward subsystem lives in ./school-cat-reward; re-exported here so
// the barrel spread and direct importers keep resolving these names unchanged.
export {
    getSchoolCatWeeklyRewardDetail, getSchoolCatWeeklyRewardRollbackCheck,
    getSchoolCatWeeklyRewardStatus, listSchoolCatWeeklyRewards,
    rollbackSchoolCatWeeklyRewards, settleSchoolCatWeeklyRewards,
} from './school-reward';

// Cell ownership uses 0 as the explicit "no big cat" sentinel. OIerDB has a
// real school #0, so persisted cat ids for schools are encoded as schoolId + 1.
// Special big cats use their negative id directly and can never collide with
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

export async function getSchoolCatRanking() {
    const cats: any[] = await schoolCatColl.find(activeSchoolCatFilter as any).toArray();
    const rows = cats.map((cat: any) => ({ cat, view: publicCat(cat, schoolViewFor(cat)) }));
    rows.sort((a: any, b: any) => b.view.territoryCount - a.view.territoryCount
        || a.view.id - b.view.id);
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
        const cells = await countUserCatCells(viewerUid);
        const rebindAt = viewer.school_cat_rebind_at;
        const canUndoRebind = !!rebindAt
            && Date.now() - new Date(rebindAt).getTime() <= 7 * 24 * 60 * 60 * 1000
            && Object.prototype.hasOwnProperty.call(viewer, 'school_cat_rebind_prev');
        me = {
            food: Math.max(0, Number(viewer.cat_food) || 0),
            boundId,
            boundCatId: boundId === null ? 0 : schoolCatKey(boundId),
            boundDisplay: boundSchool ? schoolDisplay(boundSchool) : null,
            boundUrl: boundId === null ? null : schoolUrl(boundId),
            boundColor: validTerritoryColor(boundColor) ? boundColor : null,
            cells,
            contribution: cells,
            estimatedCans: catCellRewardCans(cells),
            canChange: (viewer.school_cat_month || '') !== shanghaiMonthKey(),
            canUndoRebind,
            rebindAt: rebindAt || null,
            nextFeedAt: 0,
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

// map.ts / map-player.ts import this module, so the cell collection is referenced
// directly here instead of importing it back (which would be circular).
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
    const [top] = await listCatCellRanking(1, schoolCatKey(schoolId));
    if (!top || top.uid !== uid) throw new Error('只有当前占领格子最多的用户可以修改这只大猫的领地颜色。');
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
    const catId = schoolCatKey(schoolId);
    const cells = await listCatCellRanking(50, catId);
    let mine: any = null;
    if (viewerUid) {
        const viewer: any = await userColl.findOne({ _id: viewerUid });
        mine = {
            bound: Number.isSafeInteger(viewer?.school_cat) && viewer.school_cat === schoolId,
            cells: await countUserCatCells(viewerUid),
        };
    }
    return {
        school: withDisplay(school),
        catId,
        color: validTerritoryColor(cat?.territoryColor) ? cat.territoryColor : null,
        territoryCount: Math.max(0, Math.floor(Number(cat?.territoryCount) || 0)),
        isAdminCat: isAdminSchoolCatRecord(cat),
        canSetColor: !!viewerUid && cells.length > 0 && cells[0].uid === viewerUid,
        cells,
        current: cells,
        history: [] as any[],
        mine,
    };
}

// 学校子系统的统一入口：共享底座与玩家/管理操作一并再导出，调用方只认
// `model/cat/school`。
export * from './school-shared';
export * from './school-player';
export * from './school-transfer';
