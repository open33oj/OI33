import { Context } from 'hydrooj';
import { apply as applyCatCan } from './can';
import { apply as applyCatAccount } from './account';
import { apply as applySchoolCat } from './school';

// 猫咪子系统的唯一入口：市场/竞技场（can.ts）、猫账户与批量发放（account.ts）、
// 大猫世界（school.ts）各自注册路由。逐个隔离，某个子模块启动失败不会带走其它
// 两个——和根 index.ts 的 applyPart 是同一套容错思路。
export async function apply(ctx: Context) {
    const parts: Array<[string, (ctx: Context) => any]> = [
        ['cat/can', applyCatCan],
        ['cat/account', applyCatAccount],
        ['cat/school', applySchoolCat],
    ];
    for (const [name, fn] of parts) {
        try {
            await fn(ctx);
        } catch (e) {
            console.error(`[oi33] "${name}" failed to apply; the rest of the cat feature keeps running:`, e);
        }
    }
}
