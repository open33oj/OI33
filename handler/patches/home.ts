import {
    DiscussionModel, DocumentModel, PERM, SystemModel, moment, yaml,
} from 'hydrooj';
import { HomeHandler } from 'hydrooj/src/handler/home';
import { oi33Model } from '../../model';

// The homepage side card (今日运势 / 倒计时 / 猫罐头价格 / 拍卖) is configured on
// /oi33/admin/home and stored in `oi33_home_config`. The legacy
// `hydrooj.homepage` YAML is only used to seed that document (and to top up a
// document that is still a pure seed), plus as a fallback if the database read
// fails. Cached per request (the handler instance is per request).
function readLegacyHomepage(handler: any): any {
    try {
        let raw: any = handler?.ctx?.setting?.get?.('hydrooj.homepage');
        if (!raw) {
            try {
                raw = SystemModel.get('hydrooj.homepage');
            } catch {
                // ignore: fall through with whatever the setting service gave us
            }
        }
        if (!raw) return {};
        const parsed = typeof raw === 'string' ? yaml.load(raw) : raw;
        return oi33Model.legacyHomeConfigFromHomepage(parsed);
    } catch (e) {
        console.error('[oi33] homepage legacy config parse failed:', e);
        return {};
    }
}

async function loadHomeConfig(handler: any): Promise<any | null> {
    if (handler.__oi33HomeConfig !== undefined) return handler.__oi33HomeConfig;
    try {
        handler.__oi33HomeConfig = await oi33Model.ensureHomeConfig(readLegacyHomepage(handler));
    } catch (e) {
        console.error('[oi33] home config load failed:', e);
        handler.__oi33HomeConfig = null;
    }
    return handler.__oi33HomeConfig;
}

// Homepage section data: checkin/countdown payloads (merged into one sidebar
// card by the HomeHandler.get patch below), the "latest discussions" widget
// (problem discussions excluded) and the trimmed contest payload.
export function applyHomePatches() {
    // (c) HomeHandler.prototype.getCheckin — inject checkin data into homepage
    (HomeHandler.prototype as any).getCheckin = async function (domainId: string, payload: any) {
        const config = await loadHomeConfig(this);
        const base = payload && typeof payload === 'object' ? payload : {};
        const out: any = { ...base };
        if (config) {
            out.luck_type = config.luck_type;
            out.luck_vip = config.luck_vip;
        }
        out.luck_today = moment().format('YYYY-MM-DD');
        if (this.user && this.user._id) {
            const oi33User = await oi33Model.getCheckinUser(this.user._id);
            out.oi33_checkin_flag = oi33User ? (oi33User.realname_flag ?? 0) : 0;
            if (oi33User && oi33User.checkin_time) {
                out.oi33_checkin = {
                    time: oi33User.checkin_time,
                    luck: oi33User.checkin_luck ?? 0,
                    cnt_now: oi33User.checkin_cnt_now ?? 0,
                    cnt_all: oi33User.checkin_cnt_all ?? 0,
                };
            }
        }
        return out;
    };

    // (d) HomeHandler.prototype.getCountdown — inject countdown data into homepage
    (HomeHandler.prototype as any).getCountdown = async function (domainId: string, payload: any) {
        function formatDate(date: Date) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        function calculateDiffDays(targetDate: Date) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const timeDiff = targetDate.getTime() - today.getTime();
            return Math.floor(timeDiff / (1000 * 60 * 60 * 24));
        }

        const config = await loadHomeConfig(this);
        const source = config
            ? config.countdown
            : (payload && typeof payload === 'object' ? payload : {});
        const content: any[] = [];
        const dateToday = formatDate(new Date());
        const dates: any[] = source.dates || [];
        dates.forEach(function (val: any) {
            if (content.length < (source.max_dates || 10)) {
                const targetDate = new Date(val.date);
                targetDate.setHours(0, 0, 0, 0);
                const todayDate = new Date(dateToday);
                todayDate.setHours(0, 0, 0, 0);
                if (targetDate >= todayDate) {
                    const diffTime = calculateDiffDays(targetDate);
                    content.push({ name: val.name, diff: diffTime });
                }
            }
        });
        return { ...source, dates: content };
    };

    // (d3) HomeHandler.prototype.get — render the card as a single `oi33_side`
    // section. When the legacy `checkin` / `countdown` keys are present in the
    // `hydrooj.homepage` YAML their position is preserved; otherwise, if the
    // OI33 config has the card enabled, it is injected into the configured
    // column. Either way the payload is built from `oi33_home_config`, and the
    // live cat-can quote plus the number of running medal auctions are appended.
    // Core's main.html resolves the section name to
    // partials/homepage/oi33_side.html.
    const origHomeGet = HomeHandler.prototype.get;
    (HomeHandler.prototype as any).get = async function get(this: any, ...args: any[]) {
        const result = await origHomeGet.apply(this, args);
        const body = this?.response?.body as any;
        if (!body || !Array.isArray(body.contents)) return result;
        const domainId = String(args?.[0]?.domainId || 'system');

        // Pull every checkin/countdown section out of its column, remembering
        // where the first one sat so the merged card keeps its position.
        const merged: { checkin: any, countdown: any } = { checkin: null, countdown: null };
        let targetColumn: any = null;
        let targetIndex = 0;
        for (const column of body.contents) {
            const kept: any[] = [];
            for (const section of (column.sections || [])) {
                if (section[0] === 'checkin' || section[0] === 'countdown') {
                    merged[section[0]] = section[1];
                    if (!targetColumn) {
                        targetColumn = column;
                        targetIndex = kept.length;
                    }
                    continue;
                }
                kept.push(section);
            }
            column.sections = kept;
        }

        const config = await loadHomeConfig(this);
        if (!targetColumn) {
            if (!config?.enabled) return result;
            const columns: any[] = body.contents;
            const picked = config.column === 'main'
                ? columns.find((column) => Number(column.width) >= 6) || columns[0]
                : [...columns].reverse().find((column) => Number(column.width) <= 4) || columns[columns.length - 1];
            if (!picked) return result;
            targetColumn = picked;
            targetIndex = 0;
        }

        const now = new Date();
        // The market/auction block is decorative: a failure here must never
        // take down the homepage, so degrade to hiding that part instead.
        let market: { quote: any, auctionCount: number, blindboxCount: number } | null = null;
        try {
            // Settle anything whose deadline passed while nobody was watching,
            // so the widget never advertises a finished auction as live.
            await oi33Model.auctionSettleExpired(now);
            const [quote, activeAuctions, blindboxCount] = await Promise.all([
                oi33Model.getCatCanDayChange(now),
                oi33Model.auctionListActive(now),
                oi33Model.blindboxOpenCount(now).catch(() => 0),
            ]);
            market = { quote, auctionCount: activeAuctions.length, blindboxCount };
        } catch (e) {
            console.error('[oi33] homepage side widget market/auction failed:', e);
        }
        const checkin = merged.checkin ?? await this.getCheckin(domainId, {});
        const countdown = merged.countdown ?? await this.getCountdown(domainId, {});
        // Server-rendered fallback for the card's clock line; the frontend script
        // immediately replaces it with the browser's own local time and ticks it.
        const payload = { checkin, countdown, market, nowText: moment().format('YYYY-MM-DD HH:mm:ss') };
        targetColumn.sections.splice(targetIndex, 0, ['oi33_side', payload]);
        return result;
    };

    // (d2) HomeHandler.prototype.getDiscussion — the homepage "latest
    // discussions" widget follows the same rule as /discuss: problem discussions
    // live in their own board. Filtering at the query keeps the widget full and
    // avoids core resolving vnodes for rows that are then dropped.
    (HomeHandler.prototype as any).getDiscussion = async function (domainId: string, limit = 20) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_DISCUSSION)) return [[], {}];
        const ddocs = await DiscussionModel.getMulti(
            domainId, { parentType: { $ne: DocumentModel.TYPE_PROBLEM } },
        ).limit(limit).toArray();
        const vndict = await DiscussionModel.getListVnodes(
            domainId, ddocs, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), this.user.group,
        );
        this.collectUser(ddocs.map((ddoc: any) => ddoc.owner));
        return [ddocs, vndict];
    };

    // (f2) HomeHandler.prototype.getContest — trim the homepage section payload
    // to the tdoc list. The oi33 override of partials/homepage/contest.html
    // renders every row from the tdoc alone (whole-contest status plus
    // tdoc.beginAt~endAt, see partials/oi33_contest_table.html), so core's
    // per-user status dict (payload[1]) is dead payload here. Core's own
    // partial tolerates its absence as well — nunjucks resolves the missing
    // tsdict lookup to undefined, it only drops the "Attended" badge — so the
    // startup window where core's partial may still be the compiled one (guard
    // in ./template-guard) stays safe. Core's getContest is still called rather
    // than reimplemented, so its getListStatus query still runs; duplicating its
    // permission and group query here would only let it drift from core.
    const origGetContest = HomeHandler.prototype.getContest;
    HomeHandler.prototype.getContest = async function getContest(this: any, domainId: string, limit = 10) {
        const res: any = await origGetContest.call(this, domainId, limit);
        return Array.isArray(res) ? [res[0]] : res;
    };
}
