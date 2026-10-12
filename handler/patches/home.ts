import { DiscussionModel, DocumentModel, PERM, moment } from 'hydrooj';
import { HomeHandler } from 'hydrooj/src/handler/home';
import { oi33Model } from '../../model';

// Homepage section data: checkin/countdown payloads, the "latest discussions"
// widget (problem discussions excluded) and the trimmed contest payload.
export function applyHomePatches() {
    // (c) HomeHandler.prototype.getCheckin — inject checkin data into homepage
    (HomeHandler.prototype as any).getCheckin = async function (domainId: string, payload: any) {
        const today = moment().format('YYYY-MM-DD');
        payload.luck_today = today;
        if (this.user && this.user._id) {
            const oi33User = await oi33Model.getCheckinUser(this.user._id);
            payload.oi33_checkin_flag = oi33User ? (oi33User.realname_flag ?? 0) : 0;
            if (oi33User && oi33User.checkin_time) {
                payload.oi33_checkin = {
                    time: oi33User.checkin_time,
                    luck: oi33User.checkin_luck ?? 0,
                    cnt_now: oi33User.checkin_cnt_now ?? 0,
                    cnt_all: oi33User.checkin_cnt_all ?? 0,
                };
            }
        }
        return payload;
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

        const content: any[] = [];
        const dateToday = formatDate(new Date());
        const dates: any[] = payload.dates || [];
        dates.forEach(function (val: any) {
            if (content.length < (payload.max_dates || 10)) {
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
        payload.dates = content;
        return payload;
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
