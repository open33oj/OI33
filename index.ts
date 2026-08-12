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
import { apply as applyCatCan } from './handler/cat-can';
import { apply as applyCatAccount } from './handler/cat-account';
import { apply as applySchoolCat } from './handler/school-cat';
import { apply as applyAi } from './handler/ai';
import { apply as applyModerate } from './handler/moderate';
import { apply as applyMeow } from './handler/meow';
import { apply as applyAchievement } from './handler/achievement';
import { apply as applyAuction } from './handler/auction';
import { apply as applyContract } from './handler/contract';
import { backfillAllCatFood } from './model/user';
import { ensureModerationIndexes } from './model/moderate';
import { ensureCatCanIndexes, ensureCurrentCatCanPrice } from './model/cat-can';
import { ensureCatAccountIndexes } from './model/cat-account';
import { ensureCatMapIndexes } from './model/cat-map';
import { ensureSchoolCatIndexes } from './model/school-cat';
import { ensureMeowIndexes } from './model/meow';
import { ensureAchievementIndexes } from './model/achievement';
import { ensureAuctionIndexes } from './model/auction';
import { ensureContractIndexes } from './model/contract';

let catCanTimer: NodeJS.Timeout | undefined;
let catCanMaintenanceRunning = false;

async function maintainCatCanMarket() {
    if (catCanMaintenanceRunning) return;
    catCanMaintenanceRunning = true;
    try {
        await ensureCurrentCatCanPrice();
    } finally {
        catCanMaintenanceRunning = false;
    }
}

export async function apply(ctx: Context) {
    applyPatches(ctx);
    ctx.injectUI('UserDropdown', 'oi33_admin', {
        icon: 'crown',
        displayName: 'oi33_admin',
    }, (handler: any) => (handler.user.realname_flag || 0) >= 2);
    await applyUser(ctx);
    await applyContent(ctx);
    await applyAdmin(ctx);
    await applyProfile(ctx);
    await applyJudgeMonitor(ctx);
    await applyToken(ctx);
    await applyWiki(ctx);
    await applyPermissions(ctx);
    await applyOAuth(ctx);
    await applyCatCan(ctx);
    await applyCatAccount(ctx);
    await applySchoolCat(ctx);
    await applyAi(ctx);
    await applyModerate(ctx);
    await applyMeow(ctx);
    await applyAchievement(ctx);
    await applyAuction(ctx);
    await applyContract(ctx);
    if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0') {
        ctx.on('app/started', async () => {
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
                await ensureCatMapIndexes();
                await ensureSchoolCatIndexes();
                await ensureModerationIndexes();
                await ensureMeowIndexes();
                await ensureAchievementIndexes();
                await ensureAuctionIndexes();
                await ensureContractIndexes();
                await maintainCatCanMarket();
                if (catCanTimer) clearInterval(catCanTimer);
                catCanTimer = setInterval(() => {
                    maintainCatCanMarket().catch((e) => console.error('[oi33] cat can maintenance failed:', e));
                }, 10 * 60 * 1000);
                catCanTimer.unref();
            } catch (e) {
                console.error('[oi33] cat can initialization failed:', e);
            }
        });
    }
}
