import { Handler, NotFoundError, UserModel, ValidationError } from 'hydrooj';
import { oi33Model } from '../../model';
import { checkOi33Admin } from '../utils';
import { field } from './shared';

// 发放、升降级、撤销与扫描。

function withNotification(target: string, text: string) {
    return `${target}${target.includes('?') ? '&' : '?'}notification=${encodeURIComponent(text)}`;
}

function userManageTarget(handler: Handler, uid: number, back: string) {
    return back === 'manage'
        ? handler.url('oi33_medal_manage', { query: { uid } })
        : handler.url('oi33_medal_user_manage', { uid });
}

// 发放表单支持两种目标：单用户管理页的隐藏 uid，以及全局管理页的
// 经典用户选择器（提交 uidOrName，可能是 UID、用户名或「UID n」）。
async function resolveMedalTargetUid(handler: Handler, body: any): Promise<number> {
    const domainId = (handler.args as any)?.domainId || '';
    const rawUid = field(body, 'uid');
    if (rawUid) {
        const uid = Number(rawUid);
        if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidationError('用户 UID 无效。');
        if (!(await UserModel.getById(domainId, uid))) throw new NotFoundError(uid);
        return uid;
    }
    const rawName = field(body, 'uidOrName');
    if (!rawName) throw new ValidationError('请选择要发放的用户。');
    const anonymous = /^UID\s+(\d+)$/i.exec(rawName);
    const lookup = (anonymous ? anonymous[1] : rawName).trim();
    const numeric = Number(lookup);
    const udoc = (Number.isSafeInteger(numeric) && numeric > 0
        ? await UserModel.getById(domainId, numeric)
        : null)
        || await UserModel.getByUname(domainId, lookup);
    if (!udoc) throw new NotFoundError(lookup);
    return Number(udoc._id);
}

export class MedalGrantHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const uid = await resolveMedalTargetUid(this, body);
        const medalId = field(body, 'medalId');
        const target = userManageTarget(this, uid, field(body, 'back'));
        const medal = await oi33Model.medalGet(medalId);
        if (!medal) throw new ValidationError('奖章不存在。');
        // Upgradable series are granted through the level ladder: the same
        // action creates the award or moves an existing one to the new rung.
        if (oi33Model.medalIsLevelSeries(medal)) {
            const level = Number.parseInt(field(body, 'level') || '0', 10);
            if (!Number.isSafeInteger(level) || level <= 0) {
                throw new ValidationError('请选择要发放的等级。');
            }
            const result = await oi33Model.medalSetLevel(uid, medalId, level, this.user._id);
            this.response.redirect = withNotification(
                target, result.created ? '奖章已发放' : '奖章等级已更新',
            );
            return;
        }
        const result = await oi33Model.medalGrant(
            uid, medalId, this.user._id, 'manual',
        );
        if (!result.created) {
            // 一般奖章可以重复发放：数量 +1 并升星（星级 = ⌊log₂ 数量⌋）；
            // 其它系列仍然只能拥有一枚。
            const count = Math.max(1, Math.floor(Number((result.grant as any)?.count) || 1));
            if (count <= 1) throw new ValidationError('该用户已经获得这个奖章。');
            const stars = oi33Model.medalStarLevel(count);
            this.response.redirect = withNotification(
                target, `已再获得一枚「${medal.name}」（第 ${count} 枚${stars ? `，★${stars}` : ''}）`,
            );
            return;
        }
        this.response.redirect = withNotification(target, '奖章已发放');
    }
}

export class MedalLevelHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const uid = Number(field(body, 'uid'));
        const medalId = field(body, 'medalId');
        const level = Number.parseInt(field(body, 'level') || '0', 10);
        if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidationError('用户 UID 无效。');
        if (!Number.isSafeInteger(level) || level <= 0) throw new ValidationError('奖章等级无效。');
        if (!(await UserModel.getById('', uid))) throw new NotFoundError(uid);
        const result = await oi33Model.medalSetLevel(uid, medalId, level, this.user._id);
        const notification = result.created
            ? '奖章已发放'
            : result.previousLevel === result.level
                ? '该用户已经是这个等级'
                : `奖章等级已从第 ${result.previousLevel ?? '-'} 级更新为第 ${result.level} 级`;
        const target = userManageTarget(this, uid, field(body, 'back'));
        this.response.redirect = withNotification(target, notification);
    }
}

export class MedalRevokeHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        const body = this.request.body as any;
        const uid = Number(field(body, 'uid'));
        const medalId = field(body, 'medalId');
        if (!(await oi33Model.medalRevoke(uid, medalId, this.user._id))) {
            throw new ValidationError('该用户没有这个奖章。');
        }
        this.response.redirect = withNotification(
            userManageTarget(this, uid, field(body, 'back')), '奖章已撤销',
        );
    }
}

let medalScanRunning = false;

export class MedalScanHandler extends Handler {
    async post() {
        await checkOi33Admin(this.user._id);
        if (medalScanRunning) throw new ValidationError('OJ 成就奖章扫描正在进行中。');
        medalScanRunning = true;
        oi33Model.medalEvaluateAll()
            .then((result) => {
                console.info(
                    `[oi33] medal scan: ${result.users} users, `
                    + `${result.matched} matched, ${result.granted} granted`,
                );
            })
            .catch((e) => console.error('[oi33] medal scan failed:', e))
            .finally(() => { medalScanRunning = false; });
        this.response.redirect = this.url('oi33_medal_manage', {
            query: { notification: 'OJ 成就奖章扫描已开始' },
        });
    }
}

// The showcase wall is a 320×128 pixel canvas of 10×4 uniform 32px medals (see
// model/medal/rules.ts):
// a placement is `{ id, x, y }` with the sprite's top-left corner in canvas
// pixels. The editor posts the whole wall as JSON in `slots`; the profile and
// the editor both render it with an integer scale factor so the pixel art
// stays crisp. Legacy 4×4 data (id/null slots) is converted on read.
