import { Context, Handler } from 'hydrooj';

class DrawHandler extends Handler {
    async get() {
        this.response.template = 'oi33_draw.html';
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_draw', '/oi33/draw', DrawHandler);
}
