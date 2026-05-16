import { Context } from 'hydrooj';
import { applyPatches } from './handler/patches';
import { apply as applyUser } from './handler/user';
import { apply as applyContent } from './handler/content';
import { apply as applyAdmin } from './handler/admin';
import { apply as applyProfile } from './handler/profile';

export async function apply(ctx: Context) {
    applyPatches(ctx);
    await applyUser(ctx);
    await applyContent(ctx);
    await applyAdmin(ctx);
    await applyProfile(ctx);
}
