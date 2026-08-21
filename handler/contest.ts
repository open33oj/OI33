import { ContestModel, Context, STATUS } from 'hydrooj';
import type {
    ContestJournalEntry, ScoreboardNode, ScoreboardRow, Tdoc,
} from 'hydrooj/src/interface';

// One Chance (OC): same options as IOI, but each problem is scored by the
// FIRST in-contest submission. The scoreboard shows, next to every score,
// the highest score across all in-contest submissions for that problem
// (and the highest total) in parentheses. Post-contest practice scores
// (the "x / y" display) are never shown.
const ocRule = ContestModel.buildContestRule({
    TEXT: 'One Chance',
    stat(tdoc: Tdoc, journal: ContestJournalEntry[]) {
        const npending: Record<number, number> = {};
        const detail: Record<number, any> = {};
        const display: Record<number, any> = {};
        let score = 0;
        const lockAt = ContestModel.isLocked(tdoc) ? tdoc.lockAt : null;
        for (const j of journal.filter((i) => tdoc.pids.includes(i.pid))) {
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
        // Highest score per problem across all in-contest submissions,
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
            if (typeof tsddict[pid]?.score === 'number' && maxScore[pid] !== undefined) {
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

export function apply(ctx: Context) {
    ContestModel.RULES.oc = ocRule;
}
