import { db, ObjectId } from 'hydrooj';
import { backfillAllCatFood, previewCatFoodBackfill } from './model/user';
import { dropLegacyAi33Collections } from './model/ai';

// hydrooj's `db` export is a Proxy over MongoService, which only exposes
// `collection()` etc. — the raw mongodb Db (with listCollections / admin) is
// reachable through any collection handle.
const rawDb = db.collection('oi33_log').db as any;

export async function previewMigration() {
    const [
        billCount,
        pasteCount,
        birthdayCount,
        userCount,
        oauthLogCount,
        legacyCatCanBatchCount,
        catFoodPreview,
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
        previewCatFoodBackfill(),
    ]);
    return {
        billCount, pasteCount, birthdayCount, userCount, oauthLogCount, legacyCatCanBatchCount,
        catFoodUsers: catFoodPreview.users,
        catFoodAmount: catFoodPreview.amount,
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
        catFoodUsers: 0,
        catFoodAmount: 0,
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

    return result;
}
