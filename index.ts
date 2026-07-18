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
import { backfillAllCatFood } from './model/user';

export async function apply(ctx: Context) {
    applyPatches(ctx);
    await applyUser(ctx);
    await applyContent(ctx);
    await applyAdmin(ctx);
    await applyProfile(ctx);
    await applyJudgeMonitor(ctx);
    await applyToken(ctx);
    await applyWiki(ctx);
    await applyPermissions(ctx);
    await applyOAuth(ctx);
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
        });
    }
}
