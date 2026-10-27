import { logColl } from '../log';
import { meowPostColl } from '../meow';
import { medalColl, userMedalColl } from './definition';
import { automaticLevelsFromFlat, automaticSeriesRuleText } from './initial';
import {
    AUTOMATIC_RULE_TYPES, MEDAL_AUTOMATIC_SERIES, medalSortedLevels, medalThresholdLevel,
} from './rules';

// One-shot data migrations for the medal feature: flat OJ definitions →
// upgradable level series, and the old 成就 collection names → 奖章 names.
// These are only called from migrate.ts; keep them out of the request path.

export interface MedalAutomaticMigrationResult {
    ruleTypes: number;
    seriesCreated: number;
    definitionsMerged: number;
    awardsRewritten: number;
    awardsRemoved: number;
    logsRewritten: number;
    meowRewritten: number;
    // One entry per indicator that failed; the others still migrate because the
    // step is idempotent and is meant to be re-runnable.
    errors: string[];
}

// Idempotent migration from the pre-upgrade layout — one automatic definition
// per threshold — to one upgradable series per indicator. Every user's awards
// collapse to the highest rung they reached, and the retired definition ids are
// rewritten in logs and medal announcements. Called by /oi33/migrate.
export async function medalMigrateAutomaticLevels(): Promise<MedalAutomaticMigrationResult> {
    const result: MedalAutomaticMigrationResult = {
        ruleTypes: 0, seriesCreated: 0, definitionsMerged: 0,
        awardsRewritten: 0, awardsRemoved: 0, logsRewritten: 0, meowRewritten: 0,
        errors: [],
    };
    for (const ruleType of AUTOMATIC_RULE_TYPES) {
        // Each indicator is independent: a failure on one (e.g. a legacy
        // duplicate the dedupe below could not resolve) must not stop the rest,
        // and re-running the step continues where it left off.
        try {
        const defs = await medalColl.find({
            ruleType,
            saleable: { $ne: true },
        }).toArray();
        const flat = defs.filter(
            (def) => medalSortedLevels(def).length === 0 && Number(def.threshold) > 0,
        );
        // Nothing to fold once the series has no flat definitions left.
        if (!flat.length) continue;
        result.ruleTypes++;
        const meta = MEDAL_AUTOMATIC_SERIES[ruleType];
        let series: any = defs.find((def) => medalSortedLevels(def).length > 0) || null;
        if (!series) {
            // Reuse the flat definition already carrying the canonical id when
            // possible so an existing public medal id keeps working; otherwise
            // create the canonical series.
            const canonical = flat.find((def) => def._id === meta.id) || null;
            if (canonical) {
                series = canonical;
            } else {
                const levels = automaticLevelsFromFlat(ruleType, flat);
                const top = levels[levels.length - 1];
                const now = new Date();
                await medalColl.insertOne({
                    _id: meta.id,
                    name: meta.name,
                    description: meta.description,
                    rule: automaticSeriesRuleText(ruleType, levels),
                    ruleType,
                    imageData: top.imageData,
                    imageSize: top.imageSize,
                    levels,
                    threshold: top.threshold,
                    order: Math.min(...flat.map((def) => Number(def.order) || 0)),
                    saleable: false,
                    createdAt: now,
                    updatedAt: now,
                    createdBy: 0,
                } as any);
                series = await medalColl.findOne({ _id: meta.id });
                result.seriesCreated++;
            }
        }
        if (!series) continue;
        let levels = medalSortedLevels(series);
        if (!levels.length) {
            // The canonical id was one of the flat medals: give it the ladder
            // built from the whole group and turn it into the series.
            levels = automaticLevelsFromFlat(ruleType, flat);
            const top = levels[levels.length - 1];
            await medalColl.updateOne(
                { _id: series._id },
                {
                    $set: {
                        name: meta.name,
                        description: meta.description,
                        rule: automaticSeriesRuleText(ruleType, levels),
                        imageData: top.imageData,
                        imageSize: top.imageSize,
                        levels,
                        threshold: top.threshold,
                        updatedAt: new Date(),
                    },
                },
            );
            series.levels = levels;
            result.seriesCreated++;
        }
        // Each retired definition maps to the highest series rung it qualifies
        // for; a threshold below the first rung still counts as rung 1.
        const flatLevel = new Map<string, number>();
        for (const def of flat) {
            const rung = medalThresholdLevel(series, Number(def.threshold) || 0);
            flatLevel.set(String(def._id), rung ? Number(rung.level) : 1);
        }
        const seriesId = String(series._id);
        const flatIds = flat.map((def) => String(def._id)).filter((id) => id !== seriesId);
        const awards = await userMedalColl.find({
            medalId: { $in: [...flatIds, seriesId] },
        }).toArray();
        const byUid = new Map<number, any[]>();
        for (const award of awards) {
            const list = byUid.get(Number(award.uid)) || [];
            list.push(award);
            byUid.set(Number(award.uid), list);
        }
        for (const list of byUid.values()) {
            const seriesAward = list.find((award) => String(award.medalId) === seriesId) || null;
            // A series award may itself be a converted flat award (the canonical
            // id was one of the old medals), so seed from its mapped rung too.
            let target = seriesAward
                ? Math.max(Number(seriesAward.level) || 0, flatLevel.get(seriesId) || 0)
                : 0;
            for (const award of list) {
                if (String(award.medalId) === seriesId) continue;
                target = Math.max(target, flatLevel.get(String(award.medalId)) || 0);
            }
            if (target <= 0) target = 1;
            const keeper = seriesAward || list
                .filter((award) => String(award.medalId) !== seriesId)
                .sort((a, b) => (
                    (flatLevel.get(String(b.medalId)) || 0) - (flatLevel.get(String(a.medalId)) || 0)
                ))[0];
            if (!keeper) continue;
            if (String(keeper.medalId) !== seriesId || Number(keeper.level) !== target) {
                await userMedalColl.updateOne(
                    { _id: keeper._id },
                    { $set: { medalId: seriesId, level: target } },
                );
                result.awardsRewritten++;
            }
            const removeIds = list
                .filter((award) => !award._id.equals(keeper._id))
                .map((award) => award._id);
            if (removeIds.length) {
                const removed = await userMedalColl.deleteMany({ _id: { $in: removeIds } });
                result.awardsRemoved += removed.deletedCount || 0;
            }
        }
        // Retire the flat definitions only after every award points at the
        // series; references in logs and medal announcements are rewritten too.
        for (const oldId of flatIds) {
            const level = flatLevel.get(oldId);
            const logs = await logColl.updateMany(
                { medalId: oldId },
                { $set: { medalId: seriesId, ...(level ? { level } : {}) } },
            );
            result.logsRewritten += logs.modifiedCount || 0;
        }
        // `oi33_meow_post` has a unique (uid, medalId) index for medal
        // announcements, so a user holding announcements for several old rungs
        // cannot keep them all once they map to the same series. Collapse each
        // user to one series announcement (a post already on the series wins,
        // otherwise the highest rung) and delete the rest BEFORE rewriting the
        // winner's medalId — a per-id updateMany would fail with E11000.
        const meowPosts = await meowPostColl.find({
            medalId: { $in: [...flatIds, seriesId] },
        }).toArray();
        const meowsByUid = new Map<number, any[]>();
        for (const post of meowPosts) {
            const list = meowsByUid.get(Number(post.uid)) || [];
            list.push(post);
            meowsByUid.set(Number(post.uid), list);
        }
        for (const list of meowsByUid.values()) {
            const seriesPost = list.find((post) => String(post.medalId) === seriesId) || null;
            const keeper = seriesPost || [...list].sort((a, b) => (
                (flatLevel.get(String(b.medalId)) || 0) - (flatLevel.get(String(a.medalId)) || 0)
            ))[0];
            if (!keeper) continue;
            const removeIds = list
                .filter((post) => !post._id.equals(keeper._id))
                .map((post) => post._id);
            if (removeIds.length) {
                await meowPostColl.deleteMany({ _id: { $in: removeIds } });
                result.meowRewritten += removeIds.length;
            }
            if (String(keeper.medalId) !== seriesId) {
                await meowPostColl.updateOne(
                    { _id: keeper._id },
                    { $set: { medalId: seriesId } },
                );
                result.meowRewritten++;
            }
        }
        if (flatIds.length) {
            const removed = await medalColl.deleteMany({ _id: { $in: flatIds } });
            result.definitionsMerged += removed.deletedCount || 0;
        }
        } catch (e: any) {
            result.errors.push(`${ruleType}: ${e?.message || e}`);
        }
    }
    return result;
}

// This is the only entry point automatic rule evaluators should call. The
// unique index makes it safe for several evaluators/processes to race.
