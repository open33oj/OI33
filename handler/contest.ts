import {
    ContestModel, ContestNotLiveError, Context, ObjectId, STATUS,
} from 'hydrooj';
import type {
    ContestJournalEntry, ScoreboardNode, ScoreboardRow, Tdoc,
} from 'hydrooj/src/interface';
import { ProblemDetailHandler, ProblemSubmitHandler } from 'hydrooj/src/handler/problem';

// One Chance (OC): same options as IOI, but each problem is scored by the
// FIRST submission inside the participant's personal window (for duration
// contests: startAt + duration, also capped by the contest end and by an
// early manual finish; otherwise just the contest window). The scoreboard
// shows, next to every score, the highest score across ALL in-contest
// submissions for that problem (and the highest total) in parentheses.
//
// Make-up submissions (补题): after the personal window closes — regardless
// of whether the contest itself is still running — participants may keep
// submitting inside the contest. Those records stay journaled in the contest
// but are flagged `late` and never touch the ranking score; they only feed
// the parenthesized best scores. Post-contest practice scores (the "x / y"
// display) are never shown.
const ocRule = ContestModel.buildContestRule({
    TEXT: 'One Chance',
    stat(tdoc: Tdoc, journal: ContestJournalEntry[]) {
        const npending: Record<number, number> = {};
        const detail: Record<number, any> = {};
        const display: Record<number, any> = {};
        let score = 0;
        const lockAt = ContestModel.isLocked(tdoc) ? tdoc.lockAt : null;
        for (const j of journal.filter((i) => tdoc.pids.includes(i.pid))) {
            // Make-up submission: parenthesized best score only, never the
            // ranking score and never a freeze-period pending marker.
            if ((j as any).late) continue;
            if (lockAt && j.rid.getTimestamp() > lockAt) {
                npending[j.pid] = (npending[j.pid] || 0) + 1;
                display[j.pid] ||= {};
                display[j.pid].npending = npending[j.pid];
                continue;
            }
            if (!detail[j.pid]) {
                detail[j.pid] = { ...j };
                display[j.pid] = { ...j };
            }
        }
        for (const i in display) {
            score += ((tdoc.score?.[i] || 100) * (display[i].score || 0)) / 100;
        }
        return { score, detail, display };
    },
    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta) {
        const row: ScoreboardRow = [
            { type: 'rank', value: rank.toString() },
            { type: 'user', value: udoc.uname, raw: tsdoc.uid },
        ];
        const rate = (pid: number) => (tdoc.score?.[pid] || 100) / 100;
        const displayScore = (pid: number, score?: number) => {
            if (typeof score !== 'number') return '-';
            return score * rate(pid);
        };
        const parens = (val: string | number) => (config.isExport ? `(${val})` : `\n<small>(${val})</small>`);
        if (config.isExport && config.showDisplayName) {
            row.push({ type: 'email', value: udoc.mail });
            row.push({ type: 'string', value: udoc.school || '' });
            row.push({ type: 'string', value: udoc.displayName || '' });
            row.push({ type: 'string', value: udoc.studentId || '' });
        }
        // Highest score per problem across ALL in-contest submissions —
        // including make-up submissions after the personal window — while
        // respecting the scoreboard freeze just like the submit counter does.
        const maxScore: Record<number, number> = {};
        const accepted: Record<number, boolean> = {};
        for (const s of tsdoc.journal || []) {
            if (!pdict[s.pid]) continue;
            if (config.lockAt && s.rid.getTimestamp() > config.lockAt) continue;
            pdict[s.pid].nSubmit++;
            if (s.status === STATUS.STATUS_ACCEPTED && !accepted[s.pid]) {
                pdict[s.pid].nAccept++;
                accepted[s.pid] = true;
            }
            if (maxScore[s.pid] === undefined || maxScore[s.pid] < (s.score || 0)) maxScore[s.pid] = s.score || 0;
        }
        const maxTotal = tdoc.pids.reduce((acc, pid) => acc + (maxScore[pid] ?? 0) * rate(pid), 0);
        row.push({
            type: 'total_score',
            value: `${tsdoc.score || 0}${parens(maxTotal)}`,
        });
        const tsddict = ((config.lockAt && ContestModel.isLocked(tdoc, new Date())) ? tsdoc.display : tsdoc.detail) || {};
        const useRelativeTime = !!tdoc.duration;
        for (const pid of tdoc.pids) {
            const first = displayScore(pid, tsddict[pid]?.score);
            let value = `${first}`;
            // Show the best score in parentheses even when there is no ranking
            // score at all (the participant only made make-up submissions).
            if (maxScore[pid] !== undefined) {
                value += parens(displayScore(pid, maxScore[pid]));
            }
            if (!config.isExport && tsddict[pid]?.npending) {
                value += `<span style="color:orange">+${tsddict[pid].npending}</span>`;
            }
            const node: ScoreboardNode = {
                type: 'record',
                value,
                raw: tsddict[pid]?.rid || null,
                score: tsddict[pid]?.score,
            };
            if (tsddict[pid]?.status === STATUS.STATUS_ACCEPTED) {
                const startAt = (useRelativeTime ? tsdoc.startAt || tdoc.beginAt : tdoc.beginAt).getTime();
                if (tsddict[pid].rid.getTimestamp().getTime() - startAt === meta?.first?.[pid]) {
                    node.style = 'background-color: rgb(217, 240, 199);';
                }
            }
            row.push(node);
        }
        return row;
    },
}, ContestModel.RULES.ioi);

// Personal ranking deadline for an OC participant: the contest end, further
// capped by the personal window (duration contests) and by an early manual
// finish (tsdoc.endAt is only persisted by postEarlyEnd).
function ocDeadline(tdoc: Tdoc, tsdoc: any): number {
    const bounds = [tdoc.endAt.getTime()];
    if (tdoc.duration && tsdoc?.startAt) {
        bounds.push(new Date(tsdoc.startAt).getTime() + tdoc.duration * 3600 * 1000);
    }
    if (tsdoc?.endAt) bounds.push(new Date(tsdoc.endAt).getTime());
    return Math.min(...bounds);
}

// Recompute one participant's OC status: flag every journal entry past the
// personal deadline as a make-up (`late`) and rewrite score/detail/display.
// Core's updateStatus/revPushStatus knows nothing about the deadline and
// re-creates judged entries without the flag, so this must re-run after every
// submit and judge. The persisted `late` flags keep later core recomputes
// (contest edit / setScore recalc, unlockScoreboard) correct on their own.
// Idempotent.
async function recalcOcStatus(domainId: string, tid: any, uid: number) {
    const [tdoc, tsdoc] = await Promise.all([
        ContestModel.get(domainId, tid),
        ContestModel.getStatus(domainId, tid, uid),
    ]);
    if (!tdoc || tdoc.rule !== 'oc' || !tsdoc?.journal?.length) return;
    const deadline = ocDeadline(tdoc, tsdoc);
    const journal = tsdoc.journal
        .map((j: any) => ({ ...j, late: j.rid.getTimestamp().getTime() > deadline }))
        .sort((a: any, b: any) => a.rid.getTimestamp().getTime() - b.rid.getTimestamp().getTime());
    const stats = ContestModel.RULES.oc.stat(tdoc, journal);
    await ContestModel.setStatus(domainId, tid, uid, { journal, ...stats });
}

export function apply(ctx: Context) {
    ContestModel.RULES.oc = ocRule;

    // Gate 1: ProblemSubmitHandler.prepare rejects submissions once
    // isOngoing() is false (personal window over, or contest ended). Re-allow
    // for OC participants who actually started the contest; their submissions
    // become make-ups (parenthesized scores only).
    const origSubmitPrepare = ProblemSubmitHandler.prototype.prepare;
    ProblemSubmitHandler.prototype.prepare = async function prepare(rawArgs: any) {
        try {
            await origSubmitPrepare.call(this, rawArgs);
        } catch (e) {
            if (!(e instanceof ContestNotLiveError)) throw e;
            const { tdoc, tsdoc } = this as any;
            if (tdoc?.rule !== 'oc') throw e;
            if (ContestModel.isNotStarted(tdoc)) throw e;
            if (!tsdoc?.attend || !tsdoc.startAt) throw e;
        }
    };

    // Gate 2: once the contest ends, the problem page switches to 'correction'
    // mode and the submit URL loses ?tid=, turning submissions into practice
    // records. Keep attended OC participants in 'contest' mode so make-up
    // submissions stay journaled in the contest.
    const origDetailPrepare = ProblemDetailHandler.prototype._prepare;
    ProblemDetailHandler.prototype._prepare = async function _prepare(rawArgs: any) {
        await origDetailPrepare.call(this, rawArgs);
        const { tdoc, tsdoc, response } = this as any;
        const mode = response?.body?.mode;
        if (tdoc?.rule !== 'oc' || (mode !== 'correction' && mode !== 'none')) return;
        if (tsdoc?.attend && tsdoc.startAt && !ContestModel.isNotStarted(tdoc)) {
            response.body.mode = 'contest';
        }
    };

    // Fix-up triggers: re-flag and recompute after each in-contest submit
    // (the WAITING journal entry) and each finished judge (the entry core
    // recreates without the `late` flag).
    ctx.on('handler/after/ProblemSubmit#post', async (h: any) => {
        if (h.args?.pretest) return;
        // h.args holds raw (unconverted) params: tid is still a string here.
        const tid = h.args?.tid;
        if (tid && h.tdoc?.rule === 'oc' && h.user?._id) {
            await recalcOcStatus(h.args.domainId, new ObjectId(tid), h.user._id);
        }
    });
    ctx.on('record/judge', async (rdoc: any) => {
        if (rdoc?.contest && rdoc.domainId && rdoc.uid) {
            await recalcOcStatus(rdoc.domainId, rdoc.contest, rdoc.uid);
        }
    });
}
