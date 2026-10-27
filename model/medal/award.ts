import {
    DocumentModel, ObjectId, STATUS, ValidationError,
} from 'hydrooj';
import type {
    Oi33MedalRuleType, Oi33UserMedal,
} from '../types';
import { addLog, logColl } from '../log';
import { meowDelete } from '../meow';
import { userColl } from '../user';
import { medalColl, userMedalColl, medalGetAcceptedDomains } from './definition';
import {
    AUTOMATIC_RULE_TYPES, isAutomaticRuleType, medalAwardView, medalCategoryOf,
    medalCategoryRank, medalIsLevelSeries, medalLevelOf, medalSortedLevels,
    medalThresholdLevel, medalView,
} from './rules';

// Medal awards: the read models the pages need (awards, holders, statistics),
// the automatic rule evaluator, and the write paths (grant / set level /
// revoke). Granting a 一般/可售卖/认证 medal refreshes the `special_medals`
// indicator, which is why the evaluator lives in the same module: the two call
// each other on purpose and keeping them together avoids a module cycle.

export async function medalGetUserAwards(uid: number) {
    const grants = await userMedalColl.find({ uid }).sort({ earnedAt: -1 }).toArray();
    if (!grants.length) return [];
    const definitions = await medalColl.find({
        _id: { $in: grants.map((grant) => grant.medalId) },
    }).toArray();
    const definitionMap = new Map(definitions.map((definition) => [definition._id, definition]));
    return grants
        .map((grant) => {
            const raw = definitionMap.get(grant.medalId);
            if (!raw) return null;
            const medal = medalView(raw);
            // `view` is the resolved display record: awards of an upgradable
            // series render their current rung's name, text and pixel art.
            return { ...grant, medal, view: medalAwardView(grant, medal) };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => (
            medalCategoryRank(a.medal) - medalCategoryRank(b.medal)
            || a.medal.order - b.medal.order
            || a.earnedAt.getTime() - b.earnedAt.getTime()
        ));
}

export async function medalListRecentAwards(limit = 50) {
    return await userMedalColl.find().sort({ earnedAt: -1 }).limit(limit).toArray();
}

// Paginated award history for the management page: newest first, with the
// total count and page count returned so the pager can render without a
// second query.
export async function medalListAwardsPaginated(page: number, pageSize = 50) {
    const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
    const total = await userMedalColl.countDocuments({});
    const awards = await userMedalColl.find({})
        .sort({ earnedAt: -1, _id: -1 })
        .skip((safePage - 1) * pageSize)
        .limit(pageSize)
        .toArray();
    return { awards, total, tpcount: Math.ceil(total / pageSize) };
}

// Every user currently sitting on one rung of an upgradable series. The
// catalogue links each level here; earliest achievers render first so the page
// reads like a hall of fame.
export async function medalListLevelHolders(medalId: string, level: number) {
    return await userMedalColl.find({ medalId, level })
        .sort({ earnedAt: 1, _id: 1 })
        .toArray();
}

// Every holder of a definition, whatever its family (一般奖章, OJ 成就 series
// and their rungs, or the single owner of a 可售卖奖章). The catalogue links
// each medal here so no medal's holder list is a dead end; level series keep
// their rung on the award so the page can group them in ladder order.
export async function medalListHolders(medalId: string) {
    return await userMedalColl.find({ medalId })
        .sort({ earnedAt: 1, _id: 1 })
        .toArray();
}

export interface MedalAwardStat {
    // Number of distinct holders (one award row per holder and definition).
    total: number;
    // Total number of medals held: 一般奖章 sums `count`, every other family
    // holds exactly one per holder.
    copies: number;
    // Upgradable series only: how many holders sit on each rung.
    byLevel: Record<string, number>;
}

// Holder and copy counts for the public catalogue. One pass over the award
// collection; `total` is the holder count, `copies` sums the duplicate count
// stored on 一般奖章 awards, and `byLevel` is only meaningful for upgradable
// series (where the award carries its rung).
export async function medalAwardStats(): Promise<Record<string, MedalAwardStat>> {
    const rows = await userMedalColl.aggregate([
        {
            $group: {
                _id: { medalId: '$medalId', level: '$level' },
                holders: { $sum: 1 },
                // Only 一般奖章 awards carry `count`; legacy rows fall back to 1.
                copies: { $sum: { $max: [1, { $ifNull: ['$count', 1] }] } },
            },
        },
    ]).toArray();
    const stats: Record<string, MedalAwardStat> = {};
    for (const row of rows as any[]) {
        const medalId = String(row._id?.medalId ?? '');
        if (!medalId) continue;
        const stat = stats[medalId] || (stats[medalId] = { total: 0, copies: 0, byLevel: {} });
        const holders = Number(row.holders) || 0;
        const copies = Number(row.copies) || 0;
        stat.total += holders;
        stat.copies += copies;
        if (row._id?.level !== undefined && row._id?.level !== null) {
            stat.byLevel[String(row._id.level)] = holders;
        }
    }
    return stats;
}

// Number of distinct special medals (一般 / 可售卖 / 奖项认证) a user holds. OJ
// 成就 awards are excluded, so this indicator cannot feed on itself.
async function medalCountSpecialAwards(uid: number): Promise<number> {
    const grants = await userMedalColl.find({ uid }, { projection: { medalId: 1 } }).toArray();
    if (!grants.length) return 0;
    const medals = await medalColl.find({
        _id: { $in: [...new Set(grants.map((grant) => String(grant.medalId)))] },
    }, { projection: { ruleType: 1, saleable: 1 } }).toArray();
    const byId = new Map(medals.map((medal) => [String(medal._id), medal]));
    return grants.reduce((count, grant) => {
        const medal = byId.get(String(grant.medalId));
        return count + (medal && medalCategoryOf(medal) !== 'oj' ? 1 : 0);
    }, 0);
}

export interface MedalEvaluateOptions {
    ruleTypes?: Oi33MedalRuleType[];
    historicalCatFood?: boolean;
    source?: string;
}

async function medalGetHistoricalCatFoodPeak(uid: number, currentBalance: number) {
    let balance = currentBalance;
    let peak = currentBalance;
    const cursor = logColl.find({
        userId: uid,
        type: { $in: ['checkin', 'cat_account'] },
        amount: { $exists: true, $ne: 0 },
    }, {
        projection: { amount: 1 },
    }).sort({ createdAt: -1, _id: -1 });
    try {
        while (await cursor.hasNext()) {
            const entry = await cursor.next();
            if (!entry) break;
            // Walking newest to oldest: subtracting a transaction delta gives
            // the balance immediately before that transaction.
            balance -= Number(entry.amount) || 0;
            if (balance > peak) peak = balance;
        }
    } finally {
        await cursor.close();
    }
    return Math.max(0, peak);
}

export async function medalEvaluateUser(
    uid: number,
    options: MedalEvaluateOptions = {},
) {
    // Only the automatic (OJ 成就奖章) rule types are ever evaluated;
    // `manual` and `certification` definitions are exempt by construction.
    const ruleTypes = (options.ruleTypes || AUTOMATIC_RULE_TYPES)
        .filter((type) => isAutomaticRuleType(type));
    if (!ruleTypes.length) return { checked: 0, matched: 0, granted: [] as string[] };
    const allDefinitions = await medalColl.find({
        ruleType: { $in: ruleTypes },
        // Auction/trade medals are exclusive to the 可售卖奖章 family: even a
        // legacy definition carrying both an automatic rule and the saleable
        // flag must not be handed out by a rule evaluator.
        saleable: { $ne: true },
    }).sort({ order: 1, threshold: 1, _id: 1 }).toArray();
    // A definition is actionable when it carries either an upgradable ladder
    // with per-rung thresholds or a legacy flat threshold.
    const definitions = allDefinitions.filter((item) => (
        medalSortedLevels(item).some((level) => Number(level.threshold) > 0)
        || Number(item.threshold) > 0
    ));
    if (!definitions.length) return { checked: 0, matched: 0, granted: [] as string[] };

    const needsAccepted = definitions.some((item) => item.ruleType === 'accepted_problems');
    const needsSpecial = definitions.some((item) => item.ruleType === 'special_medals');
    const user = await userColl.findOne({ _id: uid });
    // Unverified users never trigger automatic medals.
    if ((Number(user?.realname_flag) || 0) < 1) return { checked: 0, matched: 0, granted: [] as string[] };
    const acceptedDomains = needsAccepted ? medalGetAcceptedDomains() : [];
    const acceptedFilter: Record<string, any> = {
        docType: DocumentModel.TYPE_PROBLEM,
        uid,
        status: STATUS.STATUS_ACCEPTED,
    };
    if (acceptedDomains.length) acceptedFilter.domainId = { $in: acceptedDomains };
    const acceptedStatuses = needsAccepted
        ? await DocumentModel.collStatus.find(acceptedFilter, {
            projection: { domainId: 1, docId: 1 },
        }).toArray()
        : [];
    const acceptedRefsByDomain = new Map<string, Map<string, any>>();
    for (const status of acceptedStatuses as any[]) {
        const domainId = String(status.domainId);
        if (!acceptedRefsByDomain.has(domainId)) acceptedRefsByDomain.set(domainId, new Map());
        acceptedRefsByDomain.get(domainId)!.set(String(status.docId), status.docId);
    }
    const acceptedProblems = needsAccepted
        ? (await Promise.all([...acceptedRefsByDomain].map(([domainId, refs]) => (
            DocumentModel.coll.find({
                domainId,
                docType: DocumentModel.TYPE_PROBLEM,
                docId: { $in: [...refs.values()] },
            }, {
                projection: { sort: 1 },
            }).toArray()
        )))).flat()
        : [];
    // `sort` is the public problem number. Deliberately do not include
    // domainId here: the same sort in different configured domains is one
    // distinct problem for medal purposes.
    const acceptedCount = new Set(acceptedProblems
        .map((item: any) => item.sort)
        .filter((sort: any) => sort !== undefined && sort !== null && String(sort) !== '')
        .map((sort: any) => String(sort))).size;
    const currentCatFood = Number(user?.cat_food) || 0;
    const catFoodValue = options.historicalCatFood
        && definitions.some((item) => item.ruleType === 'cat_food_balance')
        ? await medalGetHistoricalCatFoodPeak(uid, currentCatFood)
        : currentCatFood;
    const values: Partial<Record<Oi33MedalRuleType, number>> = {
        accepted_problems: acceptedCount,
        checkin_streak: Number(user?.checkin_cnt_now) || 0,
        checkin_total: Number(user?.checkin_cnt_all) || 0,
        cat_food_balance: catFoodValue,
        cat_can_balance: Number(user?.cat_can) || 0,
        special_medals: needsSpecial ? await medalCountSpecialAwards(uid) : 0,
    };
    const granted: string[] = [];
    let matched = 0;
    for (const definition of definitions) {
        const value = values[definition.ruleType] || 0;
        const sourceText = options.source
            ? `${options.source}:${definition.ruleType}`
            : `rule:${definition.ruleType}`;
        const rungs = medalSortedLevels(definition).filter(
            (item) => Number(item.threshold) > 0,
        );
        if (rungs.length) {
            // Upgradable OJ series: grant or raise the award to the highest rung
            // the user's indicator has reached. It never downgrades.
            const target = medalThresholdLevel(definition, value);
            if (!target) continue;
            matched++;
            const result = await medalUpgradeAwardLevel(
                uid, definition, Number(target.level), sourceText,
            );
            if (result.created || result.upgraded) granted.push(definition._id);
            continue;
        }
        const threshold = Number(definition.threshold) || 0;
        if (value < threshold) continue;
        matched++;
        const result = await medalGrant(uid, definition._id, 0, sourceText);
        if (result.created) granted.push(definition._id);
    }
    return { checked: definitions.length, matched, granted };
}

export async function medalEvaluateAll() {
    const cursor = userColl.find({}, { projection: { _id: 1 } }).sort({ _id: 1 });
    let users = 0;
    let granted = 0;
    let matched = 0;
    try {
        while (await cursor.hasNext()) {
            const user = await cursor.next();
            if (!user) break;
            const result = await medalEvaluateUser(user._id, {
                historicalCatFood: true,
                source: 'scan',
            });
            users++;
            granted += result.granted.length;
            matched += result.matched;
            if (users % 50 === 0) {
                console.info(
                    `[oi33] medal scan progress: ${users} users, `
                    + `${matched} matched, ${granted} granted`,
                );
            }
            // Keep the scan deliberately sequential and yield between users
            // so a large backfill cannot monopolize the Hydro process.
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    } finally {
        await cursor.close();
    }
    return { users, matched, granted };
}


export async function medalGrant(
    uid: number,
    medalId: string,
    grantedBy = 0,
    source = 'automatic',
    level?: number,
): Promise<{ grant: Oi33UserMedal; created: boolean }> {
    const medal = await medalColl.findOne({ _id: medalId });
    if (!medal) throw new ValidationError('奖章不存在。');
    const grant: Oi33UserMedal = {
        _id: new ObjectId(),
        uid,
        medalId,
        earnedAt: new Date(),
        grantedBy,
        source,
    };
    // Upgradable series carry the earned rung on the award itself. The
    // requested level must exist — granting is strict; only rendering is
    // forgiving about rungs an administrator later removed.
    if (medalIsLevelSeries(medal)) {
        const rung = medalLevelOf(medal, level);
        if (!rung) throw new ValidationError('该奖章没有这个等级。');
        grant.level = Number(rung.level);
    } else if (medalCategoryOf(medal) === 'certification') {
        throw new ValidationError('该认证奖章还没有配置任何等级。');
    }
    try {
        await userMedalColl.insertOne(grant);
    } catch (e: any) {
        if (e?.code !== 11000) throw e;
        const existing: any = await userMedalColl.findOne({ uid, medalId });
        if (!existing) throw e;
        // 一般奖章可以重复获得（盲盒开出重复的、管理员重复发放）：累加数量并
        // 由数量换算星级（floor(log2(count))）。其它系列仍然只记一枚。
        if (medalCategoryOf(medal) === 'manual') {
            // `count` is absent on awards created before this feature and means
            // "one copy", hence the $ifNull default of 1 before adding the new one.
            const updated: any = await userMedalColl.findOneAndUpdate(
                { _id: existing._id } as any,
                [{ $set: { count: { $add: [{ $ifNull: ['$count', 1] }, 1] } } }] as any,
                { returnDocument: 'after' } as any,
            );
            await addLog({
                type: 'medal', userId: uid, sender: grantedBy,
                action: 'grant', medalId, reason: `重复获得（第 ${Number(updated?.count) || 2} 枚）`,
            } as any);
            return { grant: updated || existing, created: false };
        }
        return { grant: existing, created: false };
    }

    try {
        await addLog({
            type: 'medal', userId: uid, sender: grantedBy,
            action: 'grant', medalId, level: grant.level,
        });
    } catch (e) {
        console.error('[oi33] medal grant log failed:', e);
    }
    // 一般 / 可售卖 / 奖项认证奖章会改变「特殊奖章数量」指标。OJ 发放不触发，
    // 所以评估器授予 OJ 系列时不会递归。
    if (medalCategoryOf(medal) !== 'oj') {
        medalEvaluateUser(uid, { ruleTypes: ['special_medals'], source: 'special' })
            .catch((e) => console.error('[oi33] special-medal evaluation failed:', e));
    }
    return { grant, created: true };
}

// Automatic (OJ 成就奖章) rule upgrade: raise an existing award to the rung the
// user has just reached, or create the award at that rung. It never downgrades
// and never publishes to 喵喵 (medal grants are silent since the auto-post rule
// was removed).
async function medalUpgradeAwardLevel(
    uid: number,
    medal: any,
    targetLevel: number,
    source: string,
): Promise<{ created: boolean; upgraded: boolean; previousLevel: number | null; level: number }> {
    const existing = await userMedalColl.findOne({ uid, medalId: medal._id });
    if (!existing) {
        await medalGrant(uid, medal._id, 0, source, targetLevel);
        return { created: true, upgraded: true, previousLevel: null, level: targetLevel };
    }
    const previousLevel = Number.isSafeInteger(Number(existing.level)) && Number(existing.level) > 0
        ? Number(existing.level)
        : null;
    if (previousLevel !== null && targetLevel <= previousLevel) {
        return { created: false, upgraded: false, previousLevel, level: previousLevel };
    }
    await userMedalColl.updateOne(
        { _id: existing._id },
        { $set: { level: targetLevel, earnedAt: new Date(), source } },
    );
    await addLog({
        type: 'medal', userId: uid, action: 'level_update',
        medalId: medal._id, level: targetLevel,
        reason: `第 ${previousLevel ?? '-'} 级 → 第 ${targetLevel} 级（自动升级）`,
    });
    return { created: false, upgraded: true, previousLevel, level: targetLevel };
}

// Upgradable series are a ladder: setting a level on a user who does not hold
// the series yet creates the award, and setting a new level on an existing
// award upgrades (or corrects) it in place. Administrators may move either
// direction; the automatic evaluator only ever upgrades.
export async function medalSetLevel(
    uid: number,
    medalId: string,
    level: number,
    operator: number,
): Promise<{ created: boolean; previousLevel: number | null; level: number }> {
    const medal = await medalColl.findOne({ _id: medalId });
    if (!medal) throw new ValidationError('奖章不存在。');
    if (!medalIsLevelSeries(medal)) {
        throw new ValidationError('只有可升级的奖章系列才能按等级发放。');
    }
    const rung = medalLevelOf(medal, level);
    if (!rung) throw new ValidationError('该奖章没有这个等级。');
    const target = Number(rung.level);
    const existing = await userMedalColl.findOne({ uid, medalId });
    if (!existing) {
        await medalGrant(uid, medalId, operator, 'manual', target);
        return { created: true, previousLevel: null, level: target };
    }
    const previousLevel = Number.isSafeInteger(Number(existing.level)) && existing.level
        ? Number(existing.level)
        : null;
    if (previousLevel === target) return { created: false, previousLevel, level: target };
    await userMedalColl.updateOne(
        { _id: existing._id },
        { $set: { level: target, earnedAt: new Date(), grantedBy: operator, source: 'manual' } },
    );
    await addLog({
        type: 'medal', userId: uid, sender: operator,
        action: 'level_update', medalId, level: target,
        reason: `第 ${previousLevel ?? '-'} 级 → 第 ${target} 级`,
    });
    return { created: false, previousLevel, level: target };
}

export async function medalRevoke(
    uid: number,
    medalId: string,
    operator: number,
) {
    const grant = await userMedalColl.findOne({ uid, medalId });
    if (!grant) return false;
    const medal = await medalColl.findOne({ _id: medalId });
    await userMedalColl.deleteOne({ _id: grant._id });
    // Legacy cleanup: awards handed out before the automatic-announcement rule
    // was removed may still point at a 喵喵 post; revoking the medal removes it.
    if (grant.announcementPostId) {
        await meowDelete(grant.announcementPostId, operator);
    }
    await addLog({
        type: 'medal', userId: uid, sender: operator,
        action: 'revoke', medalId,
    });
    // Losing a special medal can drop the user below an OJ threshold; refresh
    // that indicator (OJ medals themselves never trigger this).
    if (medal && medalCategoryOf(medal) !== 'oj') {
        medalEvaluateUser(uid, { ruleTypes: ['special_medals'], source: 'special' })
            .catch((e) => console.error('[oi33] special-medal evaluation failed:', e));
    }
    return true;
}
