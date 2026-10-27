import { Context } from 'hydrooj';
import { applyPatches } from './handler/patches';
import { apply as applyUser } from './handler/user';
import { apply as applyContent } from './handler/content';
import { apply as applyAdmin } from './handler/admin';
import { apply as applyProfile } from './handler/profile';
import { apply as applyJudgeMonitor } from './handler/judge-monitor';
import { apply as applyToken } from './handler/token';
import { apply as applyWiki } from './handler/wiki';
import { apply as applyPermissions } from './handler/permissions';
import { apply as applyOAuth } from './handler/oauth';
import { apply as applyCat } from './handler/cat';
import { apply as applyAi } from './handler/ai';
import { apply as applyModerate } from './handler/moderate';
import { apply as applyBio } from './handler/bio';
import { apply as applyMeow } from './handler/meow';
import { apply as applyMedal } from './handler/medal';
import { apply as applyAuction } from './handler/auction';
import { apply as applyContract } from './handler/contract';
import { apply as applyContest } from './handler/contest';
import { apply as applyDraw } from './handler/draw';
import { apply as applyAlgorithm } from './handler/algorithm';
import { apply as applySolution } from './handler/solution';
import { apply as applyBlindbox } from './handler/blindbox';
import { apply as applyDiscuss } from './handler/discuss';
import { apply as applyOps } from './handler/ops';
import { backfillAllCatFood } from './model/user';
import { ensureModerationIndexes } from './model/moderate';
import {
    ensureCatAccountIndexes, ensureCatCanIndexes, ensureCatMapIndexes, ensureCurrentCatCanPrice,
    ensureSchoolCatIndexes, recountSchoolCatTerritories, runCatMapPlansDue,
    settleSchoolCatWeeklyRewards,
} from './model/cat';
import { ensureMeowIndexes } from './model/meow';
import { medalEvaluateUser, ensureMedalIndexes } from './model/medal';
import { ensureAuctionIndexes } from './model/auction';
import { ensureContractIndexes } from './model/contract';
import { ensureLogIndexes } from './model/log';
import { ensureAlgorithmIndexes } from './model/algorithm';
import { ensureBlindboxIndexes } from './model/blindbox';
import {
    markTaskError, markTaskStart, markTaskSuccess, recordApplyFailure,
} from './model/ops-status';

let catCanTimer: NodeJS.Timeout | undefined;
let catCanMaintenanceRunning = false;
let schoolCatRewardRunning = false;
let catMapPlanTimer: NodeJS.Timeout | undefined;
let catMapPlanRunning = false;

// Cat map plans: advance the plans whose cooldown has expired. The step itself
// (move + paint, costs, cooldown, auto-stop) lives in the model; here we only
// run the tick and fan the resulting events out over the socket channel. Only
// instance 0 runs it (see the NODE_APP_INSTANCE guard below) and the per-plan
// database lease keeps a plan from being executed twice. The tick is the only
// source of execution latency, so it stays small (5s): the due scan is an
// indexed lookup, and the client re-syncs a few seconds after nextAt anyway.
const CAT_MAP_PLAN_TICK_MS = 5 * 1000;

async function maintainCatMapPlans(ctx: Context) {
    if (catMapPlanRunning) return;
    catMapPlanRunning = true;
    markTaskStart('catMapPlans');
    try {
        const result = await runCatMapPlansDue();
        for (const event of result.events) (ctx as any).broadcast('oi33/cat-map-change', event);
        if (result.advanced) console.info(`[oi33] cat map plans advanced: ${result.advanced}`);
        markTaskSuccess('catMapPlans', result.advanced ? `推进 ${result.advanced} 步` : '没有到期的计划');
    } catch (e) {
        markTaskError('catMapPlans', e);
        throw e;
    } finally {
        catMapPlanRunning = false;
    }
}

async function maintainCatCanMarket() {
    if (catCanMaintenanceRunning) return;
    catCanMaintenanceRunning = true;
    markTaskStart('catCanMarket');
    try {
        await ensureCurrentCatCanPrice();
        markTaskSuccess('catCanMarket', '价格与储备已刷新');
    } catch (e) {
        markTaskError('catCanMarket', e);
        throw e;
    } finally {
        catCanMaintenanceRunning = false;
    }
}

async function maintainSchoolCatRewards() {
    if (schoolCatRewardRunning) return;
    schoolCatRewardRunning = true;
    markTaskStart('schoolCatRewards');
    try {
        const result = await settleSchoolCatWeeklyRewards(0);
        if (!result.newlyCompleted) {
            markTaskSuccess('schoolCatRewards', '本周未到结算点');
            return;
        }
        for (let offset = 0; offset < result.awardedUids.length; offset += 20) {
            await Promise.all(result.awardedUids.slice(offset, offset + 20).map((uid) => (
                medalEvaluateUser(uid, { ruleTypes: ['cat_can_balance'] })
                    .catch((e) => console.error('[oi33] weekly big-cat reward medal evaluation failed:', e))
            )));
        }
        console.info(`[oi33] weekly big-cat reward ${result.period}: ${result.users} users, ${result.cans} cans`);
        markTaskSuccess('schoolCatRewards', `${result.period}：${result.users} 人 / ${result.cans} 个罐头`);
    } catch (e) {
        markTaskError('schoolCatRewards', e);
        throw e;
    } finally {
        schoolCatRewardRunning = false;
    }
}

// A failure inside one sub-apply must not take the whole addon down: without
// this guard a single throw (e.g. a bad cordis `inject` in a patch, which is
// what `cannot get property "x" without inject` means) aborts `apply()` and NO
// oi33 route gets registered at all. Log loudly and keep the remaining,
// independent features working.
async function applyPart(name: string, ctx: Context, fn: (ctx: Context) => any) {
    try {
        await fn(ctx);
    } catch (e) {
        recordApplyFailure(name, e);
        console.error(`[oi33] "${name}" failed to apply; oi33 keeps running without it:`, e);
    }
}

export async function apply(ctx: Context) {
    await applyPart('patches', ctx, applyPatches);
    ctx.injectUI('UserDropdown', 'oi33_admin', {
        icon: 'crown',
        displayName: 'oi33_admin',
    }, (handler: any) => (handler.user.realname_flag || 0) >= 2);
    const parts: Array<[string, (ctx: Context) => any]> = [
        ['user', applyUser],
        ['content', applyContent],
        ['admin', applyAdmin],
        ['profile', applyProfile],
        ['judgeMonitor', applyJudgeMonitor],
        ['token', applyToken],
        ['wiki', applyWiki],
        ['permissions', applyPermissions],
        ['oauth', applyOAuth],
        ['cat', applyCat],
        ['ai', applyAi],
        ['moderate', applyModerate],
        ['bio', applyBio],
        ['meow', applyMeow],
        ['medal', applyMedal],
        ['auction', applyAuction],
        ['contract', applyContract],
        ['contest', applyContest],
        ['draw', applyDraw],
        ['algorithm', applyAlgorithm],
        ['solution', applySolution],
        ['blindbox', applyBlindbox],
        ['discuss', applyDiscuss],
        ['ops', applyOps],
    ];
    for (const [name, fn] of parts) {
        await applyPart(name, ctx, fn);
    }
    if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0') {
        ctx.on('app/started', async () => {
            markTaskStart('startup');
            try {
                const result = await backfillAllCatFood();
                if (result.users) {
                    console.info(`[oi33] cat food backfill: ${result.users} users, ${result.amount} granted`);
                }
            } catch (e) {
                console.error('[oi33] cat food backfill failed:', e);
            }
            try {
                await ensureCatCanIndexes();
                await ensureCatAccountIndexes();
                await ensureSchoolCatIndexes();
                await ensureCatMapIndexes();
                // Territory counters are incrementally maintained. Recount
                // once at startup to repair the only remaining inconsistency
                // window: a process crash between a cell write and its delta.
                await recountSchoolCatTerritories();
                await ensureModerationIndexes();
                await ensureMeowIndexes();
                await ensureMedalIndexes();
                await ensureBlindboxIndexes();
                await ensureAuctionIndexes();
                await ensureContractIndexes();
                await ensureAlgorithmIndexes();
                await ensureLogIndexes();
                await maintainCatCanMarket();
                await maintainSchoolCatRewards().catch((e) => console.error('[oi33] weekly big-cat reward failed:', e));
                await maintainCatMapPlans(ctx).catch((e) => console.error('[oi33] cat map plans failed:', e));
                if (catCanTimer) clearInterval(catCanTimer);
                catCanTimer = setInterval(() => {
                    maintainCatCanMarket().catch((e) => console.error('[oi33] cat can maintenance failed:', e));
                    maintainSchoolCatRewards().catch((e) => console.error('[oi33] weekly big-cat reward failed:', e));
                }, 10 * 60 * 1000);
                catCanTimer.unref();
                if (catMapPlanTimer) clearInterval(catMapPlanTimer);
                catMapPlanTimer = setInterval(() => {
                    maintainCatMapPlans(ctx).catch((e) => console.error('[oi33] cat map plans failed:', e));
                }, CAT_MAP_PLAN_TICK_MS);
                catMapPlanTimer.unref();
                markTaskSuccess('startup', '初始化完成');
            } catch (e) {
                markTaskError('startup', e);
                console.error('[oi33] cat can initialization failed:', e);
            }
        });
    }
}
