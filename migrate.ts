import { db } from 'hydrooj';

export async function previewMigration() {
    const [
        billCount,
        pasteCount,
        birthdayCount,
        userCount,
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
    ]);
    return { billCount, pasteCount, birthdayCount, userCount };
}

export async function migrate() {
    const result = {
        bills: 0,
        pastes: 0,
        users: 0,
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

    return result;
}
