import { Handler, PRIV, Context } from 'hydrooj';
import { checkOi33Admin } from './utils';

class PermissionsShowHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        this.response.template = 'oi33_permissions.html';
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_permissions', '/oi33/permissions', PermissionsShowHandler, PRIV.PRIV_USER_PROFILE);
}
