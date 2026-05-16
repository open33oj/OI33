import { db } from 'hydrooj';

const userColl = db.collection('oi33_user');
const ONE_HOUR = 60 * 60 * 1000;

function isWithinHour(dateStr: string | undefined): boolean {
    if (!dateStr) return false;
    return Date.now() - new Date(dateStr).getTime() < ONE_HOUR;
}

async function fetchAtCoderRating(handle: string): Promise<{ rating: number | null; error?: string }> {
    try {
        // 使用 AtCoder 的 contest history JSON 接口，比解析 HTML 更稳定
        const res = await fetch(
            `https://atcoder.jp/users/${encodeURIComponent(handle)}/history/json`,
            { signal: AbortSignal.timeout(15000) },
        );
        if (!res.ok) {
            // 用户不存在时 AtCoder 返回 404 或非 JSON 页面
            if (res.status === 404) return { rating: null, error: 'user_not_found' };
            const text = await res.text().catch(() => '');
            // HTML 响应说明被 CF 拦截了
            if (text.startsWith('<!')) return { rating: null, error: 'cf_blocked' };
            return { rating: null, error: `HTTP ${res.status}` };
        }
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) {
            return { rating: null, error: 'no_contest_history' };
        }
        // 最后一场比赛的 NewRating 即为当前 rating
        const last = data[data.length - 1];
        if (typeof last.NewRating === 'number') {
            return { rating: last.NewRating };
        }
        return { rating: null, error: 'no_rating_in_history' };
    } catch (e: any) {
        return { rating: null, error: e.message || e.name };
    }
}

export async function runUpdateRatings() {
    const users = await userColl.find({
        $or: [
            { atcoder: { $exists: true, $ne: '' } },
            { codeforces: { $exists: true, $ne: '' } },
        ],
    }).toArray();

    console.log(`总计 ${users.length} 个用户`);

    const atcoder = { total: 0, updated: 0, skipped: 0, failed: 0 };
    const codeforces = { total: 0, updated: 0, skipped: 0, failed: 0 };
    const errors: string[] = [];

    // --- Codeforces: 批量查询 ---
    const cfUsers = users.filter((u) => u.codeforces);
    codeforces.total = cfUsers.length;
    const BATCH_SIZE = 100;
    for (let i = 0; i < cfUsers.length; i += BATCH_SIZE) {
        const batch = cfUsers.slice(i, i + BATCH_SIZE);
        const pending = batch.filter((u) => !isWithinHour(u.codeforces_updated_at));

        for (const u of batch) {
            if (isWithinHour(u.codeforces_updated_at)) codeforces.skipped++;
        }

        if (!pending.length) continue;

        const handlesParam = pending.map((u) => u.codeforces).join(';');
        try {
            const res = await fetch(
                `https://codeforces.com/api/user.info?handles=${encodeURIComponent(handlesParam)}`,
                { signal: AbortSignal.timeout(30000) },
            );
            const data = await res.json();
            if (data.status === 'OK' && Array.isArray(data.result)) {
                for (const info of data.result) {
                    const user = pending.find((u) => u.codeforces === info.handle);
                    if (!user) continue;
                    const rating = info.rating ?? null;
                    if (rating !== null) {
                        await userColl.updateOne(
                            { _id: user._id },
                            {
                                $set: {
                                    codeforces_rating: rating,
                                    codeforces_updated_at: new Date().toISOString(),
                                },
                            },
                        );
                        codeforces.updated++;
                    }
                }
            } else {
                for (const u of pending) {
                    codeforces.failed++;
                    errors.push(`Codeforces ${u.codeforces}: ${data.comment || 'api_error'}`);
                }
            }
        } catch (e: any) {
            for (const u of pending) {
                codeforces.failed++;
                errors.push(`Codeforces ${u.codeforces}: ${e.message || 'network_error'}`);
            }
        }
        await new Promise((r) => setTimeout(r, 2000));
    }

    // --- AtCoder: 逐个查询 ---
    const atUsers = users.filter((u) => u.atcoder);
    atcoder.total = atUsers.length;
    for (const user of atUsers) {
        if (isWithinHour(user.atcoder_updated_at)) {
            atcoder.skipped++;
            continue;
        }
        const result = await fetchAtCoderRating(user.atcoder);
        if (result.rating !== null) {
            await userColl.updateOne(
                { _id: user._id },
                {
                    $set: {
                        atcoder_rating: result.rating,
                        atcoder_updated_at: new Date().toISOString(),
                    },
                },
            );
            atcoder.updated++;
        } else {
            atcoder.failed++;
            errors.push(`AtCoder ${user.atcoder}: ${result.error || 'unknown'}`);
        }
        await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(
        `AT ${atcoder.updated}+${atcoder.skipped}/${atcoder.total}, CF ${codeforces.updated}+${codeforces.skipped}/${codeforces.total}`,
    );

    return {
        atcoder,
        codeforces,
        errors: errors.slice(0, 50),
    };
}
