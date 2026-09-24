import { db, ObjectId } from 'hydrooj';
import { backfillAllCatFood, previewCatFoodBackfill } from './model/user';
import { dropLegacyAi33Collections } from './model/ai';
import {
    medalMigrateAcceptedDomains, medalMigrateAutomaticLevels, ensureMedalIndexes,
    AUTOMATIC_RULE_TYPES,
} from './model/medal';
import { ensureAuctionIndexes } from './model/auction';
import { ensureContractIndexes } from './model/contract';
import { ensureMeowIndexes } from './model/meow';
import { algorithmEnsureOutlineImported, algorithmMigrateOutlineIds, algorithmOutlineMeta } from './model/algorithm';

// hydrooj's `db` export is a Proxy over MongoService, which only exposes
// `collection()` etc. — the raw mongodb Db (with listCollections / admin) is
// reachable through any collection handle.
const rawDb = db.collection('oi33_log').db as any;

async function collectionExists(name: string) {
    try {
        return (await rawDb.listCollections({ name }).toArray()).length > 0;
    } catch {
        return false;
    }
}

// Document-level fallback for the collection renames: used when the target
// namespace already holds data (a previous run that copied but did not drop),
// so the migration stays idempotent instead of silently skipping.
async function copyDocuments(from: string, to: string) {
    let copied = 0;
    const cursor = rawDb.collection(from).find({});
    while (await cursor.hasNext()) {
        const doc = await cursor.next();
        if (!doc) break;
        await rawDb.collection(to).replaceOne({ _id: doc._id }, doc, { upsert: true });
        copied++;
    }
    return copied;
}

// Indexes keyed by the pre-rename field names have to go BEFORE the fields are
// renamed: `oi33_user_achievement` carries a non-sparse unique index on
// (uid, achievementId), and once `achievementId` disappears every document of
// the same user collapses to the key (uid, null) — the rename would abort with
// a duplicate-key error for anyone holding two or more medals. The medal-keyed
// indexes are recreated right after the rename (and by the models at startup).
const LEGACY_MEDAL_INDEX_COLLECTIONS = [
    'oi33_user_medal', 'oi33_medal_contract', 'oi33_auction', 'oi33_meow_post', 'oi33_user',
];

async function dropLegacyMedalIndexes() {
    let dropped = 0;
    for (const name of LEGACY_MEDAL_INDEX_COLLECTIONS) {
        if (!(await collectionExists(name))) continue;
        let indexes: any[] = [];
        try {
            indexes = await rawDb.collection(name).listIndexes().toArray();
        } catch {
            continue;
        }
        for (const index of indexes) {
            const keys = Object.keys(index?.key || {});
            if (!keys.some((key) => key === 'achievementId' || key === 'achievement_showcase')) continue;
            await rawDb.collection(name).dropIndex(index.name).catch(() => {});
            dropped++;
        }
    }
    return dropped;
}

export async function previewMigration() {
    const [
        billCount,
        pasteCount,
        birthdayCount,
        userCount,
        oauthLogCount,
        legacyCatCanBatchCount,
        legacySchoolCount,
        legacyMedalCollections,
        legacyAutomaticMedals,
        catFoodPreview,
        algorithmItems,
        algorithmLegacyIds,
    ] = await Promise.all([
        db.collection('coin').countDocuments(),
        db.collection('paste').countDocuments(),
        db.collection('birthday').countDocuments(),
        db.collection('user').countDocuments({
            $or: [
                { coin_now: { $exists: true } },
                { coin_all: { $exists: true } },
                { badge: { $exists: true, $ne: '' } },
                { realname_flag: { $exists: true } },
                { checkin_time: { $exists: true } },
            ],
        }),
        db.collection('oi33_log').countDocuments({ type: 'oauth' }),
        db.collection('oi33_cat_can_batch').countDocuments(),
        rawDb.collection('oi33_school').countDocuments(),
        // Legacy 成就 collections still waiting for the 奖章 rename.
        Promise.all([
            'oi33_achievement', 'oi33_user_achievement', 'oi33_achievement_contract',
        ].map(async (name) => ((await collectionExists(name)) ? name : null))),
        // Old one-medal-per-threshold automatic definitions waiting to be
        // folded into upgradable series.
        db.collection('oi33_medal').countDocuments({
            ruleType: { $in: AUTOMATIC_RULE_TYPES },
            saleable: { $ne: true },
            threshold: { $gt: 0 },
            $or: [{ levels: { $exists: false } }, { levels: { $size: 0 } }],
        } as any),
        previewCatFoodBackfill(),
        db.collection('oi33_algorithm_item').countDocuments(),
        // Algorithm items not yet marked with the normalized id format.
        db.collection('oi33_algorithm_item').countDocuments({ idVersion: { $ne: 2 } } as any),
    ]);
    return {
        billCount, pasteCount, birthdayCount, userCount, oauthLogCount, legacyCatCanBatchCount,
        legacySchoolCount,
        legacyMedalCollections: legacyMedalCollections.filter(Boolean),
        legacyAutomaticMedals: Number(legacyAutomaticMedals) || 0,
        catFoodUsers: catFoodPreview.users,
        catFoodAmount: catFoodPreview.amount,
        algorithmItems: Number(algorithmItems) || 0,
        algorithmOutlineItems: algorithmOutlineMeta().itemCount,
        algorithmLegacyIds: Number(algorithmLegacyIds) || 0,
    };
}

export async function migrate() {
    const result = {
        bills: 0,
        pastes: 0,
        users: 0,
        logs: 0,
        oauthLogsDeleted: 0,
        legacyCatCanBatchesDeleted: 0,
        legacyCatCanBatchCollectionDropped: false,
        legacyAi33CollectionsDropped: 0,
        meowCollectionsRenamed: 0,
        legacySchoolRecordsDeleted: 0,
        legacySchoolCollectionDropped: false,
        legacyAdminCatFlagsCleared: 0,
        medalCollectionsRenamed: 0,
        medalDocumentsCopied: 0,
        medalFieldsRenamed: 0,
        medalLogsRenamed: 0,
        medalLegacyIndexesDropped: 0,
        medalDomainsMigrated: 0,
        medalAutomaticRuleTypes: 0,
        medalAutomaticSeriesCreated: 0,
        medalAutomaticDefinitionsMerged: 0,
        medalAutomaticAwardsRewritten: 0,
        medalAutomaticAwardsRemoved: 0,
        medalAutomaticLogsRewritten: 0,
        medalAutomaticMeowsRewritten: 0,
        catFoodUsers: 0,
        catFoodAmount: 0,
        algorithmItemsImported: 0,
        algorithmIdsNormalized: 0,
        algorithmRatingsRenamed: 0,
        errors: [] as string[],
    };

    try {
        // Step 1: Coin bills: coin → oi33_coin_bill
        const oldBills = await db.collection('coin').find({}).toArray();
        for (const bill of oldBills) {
            try {
                const exists = await db.collection('oi33_coin_bill').findOne({ _id: bill._id });
                if (!exists) {
                    await db.collection('oi33_coin_bill').insertOne({
                        _id: bill._id,
                        userId: bill.userId,
                        rootId: bill.rootId,
                        amount: bill.amount,
                        text: bill.text,
                    });
                    result.bills++;
                }
            } catch (e: any) {
                result.errors.push(`Bill ${bill._id}: ${e.message}`);
            }
        }
    } catch (e: any) {
        result.errors.push(`Step 1 (bills): ${e.message}`);
    }

    try {
        // Step 2: Pastes: paste → oi33_paste
        const oldPastes = await db.collection('paste').find({}).toArray();
        for (const paste of oldPastes) {
            try {
                const exists = await db.collection('oi33_paste').findOne({ _id: paste._id });
                if (!exists) {
                    await db.collection('oi33_paste').insertOne({
                        _id: paste._id,
                        updateAt: paste.updateAt || new Date(),
                        title: paste.title,
                        owner: paste.owner,
                        content: paste.content,
                        isprivate: paste.isprivate || false,
                    });
                    result.pastes++;
                }
            } catch (e: any) {
                result.errors.push(`Paste ${paste._id}: ${e.message}`);
            }
        }
    } catch (e: any) {
        result.errors.push(`Step 2 (pastes): ${e.message}`);
    }

    // Step 3 & 4 & 5: Merge user data from birthday collection + user collection → oi33_user
    try {
        // Collect all user data into a map: userId → partial Oi33User
        const userMap: Record<number, Record<string, any>> = {};

        function ensure(userId: number) {
            if (!userMap[userId]) userMap[userId] = {};
        }

        // 3a: Birthdays from birthday collection
        try {
            const birthdays = await db.collection('birthday').find({}).toArray();
            for (const b of birthdays) {
                const uid = b.userId;
                if (!uid) continue;
                ensure(uid);
                userMap[uid].birthday_date = b.date;
                userMap[uid].birthday_monthDay = b.monthDay;
            }
        } catch (e: any) {
            result.errors.push(`Step 3 (birthdays): ${e.message}`);
        }

        // 3b: Fields from user collection
        try {
            const users = await db.collection('user').find({
                $or: [
                    { coin_now: { $exists: true } },
                    { coin_all: { $exists: true } },
                    { badge: { $exists: true, $ne: '' } },
                    { realname_flag: { $exists: true } },
                    { checkin_time: { $exists: true } },
                ],
            }).project({
                coin_now: 1,
                coin_all: 1,
                badge: 1,
                realname_flag: 1,
                realname_name: 1,
                checkin_time: 1,
                checkin_luck: 1,
                checkin_cnt_now: 1,
                checkin_cnt_all: 1,
            }).toArray();

            for (const u of users) {
                const uid = u._id;
                ensure(uid);

                if (u.coin_now !== undefined) userMap[uid].coin_now = u.coin_now;
                if (u.coin_all !== undefined) userMap[uid].coin_all = u.coin_all;

                if (u.badge) {
                    const parts = (u.badge as string).split('#');
                    if (parts.length >= 3) {
                        userMap[uid].badge_text = parts[0];
                        userMap[uid].badge_color = parts[1];
                        userMap[uid].badge_textColor = parts[2];
                    }
                }

                if (u.realname_flag !== undefined) userMap[uid].realname_flag = u.realname_flag;
                if (u.realname_name !== undefined) userMap[uid].realname_name = u.realname_name;

                if (u.checkin_time !== undefined) userMap[uid].checkin_time = u.checkin_time;
                if (u.checkin_luck !== undefined) userMap[uid].checkin_luck = u.checkin_luck;
                if (u.checkin_cnt_now !== undefined) userMap[uid].checkin_cnt_now = u.checkin_cnt_now;
                if (u.checkin_cnt_all !== undefined) userMap[uid].checkin_cnt_all = u.checkin_cnt_all;
            }
        } catch (e: any) {
            result.errors.push(`Step 3 (user fields): ${e.message}`);
        }

        // Step 4: Write merged data to oi33_user
        for (const uid of Object.keys(userMap)) {
            try {
                const data = userMap[+uid];
                data._id = +uid;
                await db.collection('oi33_user').updateOne(
                    { _id: +uid },
                    { $set: data },
                    { upsert: true },
                );
                result.users++;
            } catch (e: any) {
                result.errors.push(`User ${uid}: ${e.message}`);
            }
        }
    } catch (e: any) {
        result.errors.push(`Step 4 (merge users): ${e.message}`);
    }

    try {
        // Step 5: Backfill createdAt for old log entries (from _id when it was Date)
        const logsToFix = await db.collection('oi33_log').find({
            createdAt: { $exists: false },
        }).toArray();
        for (const log of logsToFix) {
            try {
                const ct = log._id instanceof Date ? log._id : new ObjectId(log._id).getTimestamp();
                await db.collection('oi33_log').updateOne(
                    { _id: log._id },
                    { $set: { createdAt: ct } },
                );
                result.logs++;
            } catch (e: any) {
                result.errors.push(`Log createdAt backfill ${log._id}: ${e.message}`);
            }
        }
    } catch (e: any) {
        result.errors.push(`Step 5 (log createdAt backfill): ${e.message}`);
    }

    try {
        // Step 6: Delete orphan OAuth log entries (admin template has no rendering for type='oauth')
        const delResult = await db.collection('oi33_log').deleteMany({ type: 'oauth' });
        result.oauthLogsDeleted = delResult.deletedCount;
    } catch (e: any) {
        result.errors.push(`Step 6 (delete oauth logs): ${e.message}`);
    }

    try {
        // Step 7: One-time cat food grant for all check-in days accumulated before launch.
        const backfill = await backfillAllCatFood();
        result.catFoodUsers = backfill.users;
        result.catFoodAmount = backfill.amount;
    } catch (e: any) {
        result.errors.push(`Step 7 (cat food backfill): ${e.message}`);
    }

    try {
        // Step 8: Remove the obsolete lot-based cat-can inventory. oi33_user.cat_can is authoritative.
        const legacyBatchColl = db.collection('oi33_cat_can_batch');
        result.legacyCatCanBatchesDeleted = await legacyBatchColl.countDocuments();
        try {
            await legacyBatchColl.drop();
            result.legacyCatCanBatchCollectionDropped = true;
        } catch (e: any) {
            if (e?.code !== 26 && e?.codeName !== 'NamespaceNotFound') throw e;
        }
    } catch (e: any) {
        result.errors.push(`Step 8 (drop legacy cat-can batches): ${e.message}`);
    }

    try {
        // Step 9: Drop legacy ai33_* collections (superseded by oi33_ai_*).
        // Deliberately NOT run at startup — admins opt in via /oi33/migrate.
        const legacyNames = [
            'ai33_analysis', 'ai33_config', 'ai33_problem_summary',
            'ai33_provider', 'ai33_access', 'ai33_usage',
        ];
        const present = (await Promise.all(legacyNames.map(async (name) => {
            try { return (await rawDb.listCollections({ name }).toArray()).length > 0; }
            catch { return false; }
        }))).filter(Boolean).length;
        result.legacyAi33CollectionsDropped = present;
        await dropLegacyAi33Collections();
    } catch (e: any) {
        result.errors.push(`Step 9 (drop legacy ai33 collections): ${e.message}`);
    }

    try {
        // Step 10: Rename oi33_stream_* collections → oi33_meow_* (the 喵喵
        // feature was renamed from "stream"). Safe to re-run: collections that
        // are already gone or already renamed are skipped.
        const renames = [
            ['oi33_stream_post', 'oi33_meow_post'],
            ['oi33_stream_follow', 'oi33_meow_follow'],
            ['oi33_stream_like', 'oi33_meow_like'],
        ];
        for (const [from, to] of renames) {
            const exists = (await rawDb.listCollections({ name: from }).toArray()).length > 0;
            if (!exists) continue;
            try {
                await rawDb.admin().command({ renameCollection: `${rawDb.databaseName}.${from}`, to: `${rawDb.databaseName}.${to}` });
                result.meowCollectionsRenamed++;
            } catch (e: any) {
                // Already renamed / target exists → skip silently.
                if (e?.codeName === 'NamespaceNotFound') continue;
                if (e?.codeName === 'NamespaceExists') continue;
                throw e;
            }
        }
        // Rewrite legacy log entries created under the old "stream" naming.
        await db.collection('oi33_log').updateMany(
            { type: 'stream' }, { $set: { type: 'meow' } },
        );
        await db.collection('oi33_log').updateMany(
            { type: 'cat_account', action: 'stream_post' }, { $set: { action: 'meow_post' } },
        );
    } catch (e: any) {
        result.errors.push(`Step 10 (rename stream → meow collections): ${e.message}`);
    }

    try {
        // Step 11: school-cat-data.json is now the read-only source. The old
        // Mongo copy duplicated the bundled data and is safe to remove.
        const legacySchoolColl = rawDb.collection('oi33_school');
        result.legacySchoolRecordsDeleted = await legacySchoolColl.countDocuments();
        try {
            await legacySchoolColl.drop();
            result.legacySchoolCollectionDropped = true;
        } catch (e: any) {
            if (e?.code !== 26 && e?.codeName !== 'NamespaceNotFound') throw e;
        }
    } catch (e: any) {
        result.errors.push(`Step 11 (drop redundant school cache): ${e.message}`);
    }

    try {
        // Step 12: Legacy manually-flagged admin cats (isAdminCat) are plain
        // cats now — only special big cats (negative _id) get admin treatment.
        // Idempotent: records without the flag are untouched.
        const cleared = await db.collection('oi33_school_cat').updateMany(
            { isAdminCat: { $exists: true } } as any,
            { $unset: { isAdminCat: '' } } as any,
        );
        result.legacyAdminCatFlagsCleared = cleared.modifiedCount;
    } catch (e: any) {
        result.errors.push(`Step 12 (clear legacy isAdminCat flags): ${e.message}`);
    }

    try {
        // Step 13: the 成就 (achievement) system is now the 奖章 (medal) system.
        // Rename the collections, then rewrite the document field names.
        // Startup index creation may have already created the (empty) target
        // collections, so an empty target is dropped before renaming; a target
        // that already holds data falls back to a document-level copy.
        const renames = [
            ['oi33_achievement', 'oi33_medal'],
            ['oi33_user_achievement', 'oi33_user_medal'],
            ['oi33_achievement_contract', 'oi33_medal_contract'],
        ];
        for (const [from, to] of renames) {
            if (!(await collectionExists(from))) continue;
            if (await collectionExists(to)) {
                const targetCount = await rawDb.collection(to).countDocuments();
                if (targetCount) {
                    result.medalDocumentsCopied += await copyDocuments(from, to);
                    await rawDb.collection(from).drop();
                    result.medalCollectionsRenamed++;
                    continue;
                }
                await rawDb.collection(to).drop();
            }
            try {
                await rawDb.admin().command({
                    renameCollection: `${rawDb.databaseName}.${from}`,
                    to: `${rawDb.databaseName}.${to}`,
                });
                result.medalCollectionsRenamed++;
            } catch (e: any) {
                if (e?.codeName !== 'NamespaceExists') throw e;
                result.medalDocumentsCopied += await copyDocuments(from, to);
                await rawDb.collection(from).drop();
                result.medalCollectionsRenamed++;
            }
        }

        // Rename the medal reference fields inside every collection that
        // carries one. `$rename` is a no-op when the field is already gone,
        // which keeps this step idempotent. The legacy indexes must be dropped
        // first (see dropLegacyMedalIndexes) or the unique (uid, achievementId)
        // index would reject the second medal of every user.
        result.medalLegacyIndexesDropped = await dropLegacyMedalIndexes();
        const fieldRenames: Array<[string, Record<string, string>]> = [
            ['oi33_user_medal', { achievementId: 'medalId' }],
            ['oi33_medal_contract', { achievementId: 'medalId' }],
            ['oi33_auction', { achievementId: 'medalId' }],
            ['oi33_meow_post', { achievementId: 'medalId' }],
            ['oi33_log', { achievementId: 'medalId' }],
            ['oi33_user', { achievement_showcase: 'medal_showcase' }],
        ];
        for (const [name, rename] of fieldRenames) {
            if (!(await collectionExists(name))) continue;
            const updated = await rawDb.collection(name).updateMany({}, { $rename: rename });
            result.medalFieldsRenamed += updated.modifiedCount || 0;
        }

        // Log/source discriminators that named the old feature.
        const logType = await db.collection('oi33_log').updateMany(
            { type: 'achievement' } as any, { $set: { type: 'medal' } } as any,
        );
        result.medalLogsRenamed += logType.modifiedCount || 0;
        const logAction = await db.collection('oi33_log').updateMany(
            { type: 'meow', action: 'achievement' } as any, { $set: { action: 'medal' } } as any,
        );
        result.medalLogsRenamed += logAction.modifiedCount || 0;
        const meowSource = await db.collection('oi33_meow_post').updateMany(
            { source: 'achievement' } as any, { $set: { source: 'medal' } } as any,
        );
        result.medalLogsRenamed += meowSource.modifiedCount || 0;
        // Recreate the medal-keyed indexes immediately: the dropped legacy
        // indexes included the uniqueness guard on (uid, medalId).
        await ensureMedalIndexes();
        await ensureAuctionIndexes();
        await ensureContractIndexes();
        await ensureMeowIndexes();
        // The AC-statistics domain list lives in the global system settings
        // under the old 成就 key; copy it across so the configuration survives.
        result.medalDomainsMigrated = await medalMigrateAcceptedDomains();
    } catch (e: any) {
        result.errors.push(`Step 13 (rename achievement → medal): ${e.message}`);
    }

    try {
        // Step 14: OJ 成就奖章 become upgradable level series. The old layout
        // stored one definition per threshold; fold each indicator's
        // definitions into one series and collapse every user's awards to the
        // highest rung they reached. Idempotent: once a series has no flat
        // definitions left the step is a no-op.
        const automatic = await medalMigrateAutomaticLevels();
        result.medalAutomaticRuleTypes = automatic.ruleTypes;
        result.medalAutomaticSeriesCreated = automatic.seriesCreated;
        result.medalAutomaticDefinitionsMerged = automatic.definitionsMerged;
        result.medalAutomaticAwardsRewritten = automatic.awardsRewritten;
        result.medalAutomaticAwardsRemoved = automatic.awardsRemoved;
        result.medalAutomaticLogsRewritten = automatic.logsRewritten;
        result.medalAutomaticMeowsRewritten = automatic.meowRewritten;
        // Per-indicator failures are reported instead of thrown so the other
        // indicators still migrate; the step is idempotent and re-runnable.
        for (const message of automatic.errors) {
            result.errors.push(`Step 14 (automatic medals → level series) ${message}`);
        }
    } catch (e: any) {
        result.errors.push(`Step 14 (automatic medals → level series): ${e.message}`);
    }

    try {
        // Step 15: Import the bundled NOI 2025 outline as editable algorithm
        // items, so the mastery panel has content out of the box. Idempotent:
        // an install that already configured items is left untouched, and the
        // admin page can re-import/refresh at any time.
        const algorithm = await algorithmEnsureOutlineImported(0);
        result.algorithmItemsImported = algorithm.inserted;
    } catch (e: any) {
        result.errors.push(`Step 15 (import NOI algorithm outline): ${e.message}`);
    }

    try {
        // Step 16: normalise algorithm ids imported before the format change
        // (`2.1.1-12` -> `1.1.12`, level/section/subsection ids lose the `2.`
        // document prefix) and move user ratings onto the new item ids.
        // Idempotent: already-normalised ids pass through untouched.
        const ids = await algorithmMigrateOutlineIds();
        result.algorithmIdsNormalized = ids.itemsRenamed;
        result.algorithmRatingsRenamed = ids.ratingsRenamed;
    } catch (e: any) {
        result.errors.push(`Step 16 (normalize algorithm ids): ${e.message}`);
    }

    return result;
}
