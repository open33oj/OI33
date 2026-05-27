import { Handler, PRIV, Context } from 'hydrooj';

class PermissionsShowHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_MOD_BADGE);
        this.response.template = 'oi33_permissions.html';
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_permissions', '/oi33/permissions', PermissionsShowHandler, PRIV.PRIV_MOD_BADGE);
}
