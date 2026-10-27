import { ForbiddenError, Handler, ValidationError } from 'hydrooj';
import { oi33Model, userColl } from '../../model';
import { addLog } from '../../model/log';
import { checkUserFlag } from '../utils';

// 奖章展示墙编辑页（10×4 像素画布）。拖动/缩放在 frontend/medal-showcase.page.ts。

const SHOWCASE_MAX = oi33Model.MEDAL_SHOWCASE_MAX_PIECES;

function showcasePiecesFromBody(body: any): Array<{ id: string; x: number; y: number }> {
    const raw = body?.slots;
    if (typeof raw !== 'string' || !raw.trim()) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new ValidationError('展示墙数据格式不正确，请刷新页面后重试。');
    }
    if (!Array.isArray(parsed)) throw new ValidationError('展示墙数据格式不正确，请刷新页面后重试。');
    if (parsed.length > SHOWCASE_MAX) {
        throw new ValidationError(`展示墙最多摆放 ${SHOWCASE_MAX} 枚奖章。`);
    }
    return oi33Model.medalShowcasePieces(parsed);
}

export class MedalShowcaseHandler extends Handler {
    async get() {
        if ((await checkUserFlag(this.user._id)) < 1) {
            throw new ForbiddenError('只有通过认证的用户才能编辑奖章展示墙。');
        }
        const [awards, oi33Data] = await Promise.all([
            oi33Model.medalGetUserAwards(this.user._id),
            oi33Model.getUserDataByUids([this.user._id]),
        ]);
        const awardMap = new Map(awards.map((award: any) => [String(award.medalId), award]));
        const limitOf = (id: string) => {
            const award = awardMap.get(String(id));
            return award ? oi33Model.medalShowcaseCopyLimit(award.view) : 0;
        };
        // Over-limit copies (or medals the user no longer holds) are dropped
        // here, so the editor always opens in a legal state and saving without
        // further edits never fails validation.
        const placed = oi33Model.medalShowcaseTrim(
            oi33Model.medalShowcasePieces(oi33Data[this.user._id]?.medal_showcase),
            limitOf,
        );
        const placedCount = new Map<string, number>();
        for (const piece of placed) placedCount.set(piece.id, (placedCount.get(piece.id) || 0) + 1);
        const editorAwards = awards.map((award: any) => ({
            ...award,
            showcaseLimit: oi33Model.medalShowcaseCopyLimit(award.view),
            showcasePlaced: placedCount.get(String(award.medalId)) || 0,
        }));
        const pieces = placed.map((piece) => ({
            ...piece,
            size: oi33Model.MEDAL_SHOWCASE_CELL,
            award: awardMap.get(piece.id) || null,
        }));
        this.response.template = 'oi33_medal_showcase.html';
        this.response.body = {
            awards: editorAwards,
            pieces,
            // Prefilled so a page whose script failed to run still submits the
            // wall it was showing instead of wiping it.
            slotsJson: JSON.stringify(placed),
            maxPieces: SHOWCASE_MAX,
            wallWidth: oi33Model.MEDAL_SHOWCASE_WIDTH,
            wallHeight: oi33Model.MEDAL_SHOWCASE_HEIGHT,
            cell: oi33Model.MEDAL_SHOWCASE_CELL,
            columns: oi33Model.MEDAL_SHOWCASE_COLUMNS,
            rows: oi33Model.MEDAL_SHOWCASE_ROWS,
            snap: oi33Model.MEDAL_SHOWCASE_SNAP,
        };
    }

    async post() {
        if ((await checkUserFlag(this.user._id)) < 1) {
            throw new ForbiddenError('只有通过认证的用户才能编辑奖章展示墙。');
        }
        const body = this.request.body as any;
        const awards = await oi33Model.medalGetUserAwards(this.user._id);
        const awardMap = new Map(awards.map((award: any) => [String(award.medalId), award]));
        const pieces = showcasePiecesFromBody(body);
        if (pieces.some((piece) => !awardMap.has(piece.id))) {
            throw new ValidationError('只能展示自己已经获得的奖章。');
        }
        // 一般奖章按星级允许摆多份，其它系列只能摆一份（见 medalShowcaseCopyLimit）。
        const copies = new Map<string, number>();
        for (const piece of pieces) copies.set(piece.id, (copies.get(piece.id) || 0) + 1);
        for (const [id, count] of copies) {
            const award: any = awardMap.get(id);
            const limit = oi33Model.medalShowcaseCopyLimit(award?.view);
            if (count > limit) {
                throw new ValidationError(`「${award.view.name}」最多只能展示 ${limit} 枚。`);
            }
        }
        await userColl.updateOne(
            { _id: this.user._id },
            pieces.length ? { $set: { medal_showcase: pieces } } : { $unset: { medal_showcase: '' } },
            { upsert: true },
        );
        await addLog({
            type: 'medal', userId: this.user._id, action: 'showcase_update',
            reason: pieces.map((piece) => `${piece.id}@${piece.x},${piece.y}`).join(', '),
        });
        this.response.redirect = this.url('oi33_medal_showcase', {
            query: { notification: '奖章展示墙已保存' },
        });
    }
}

// Public catalogue: every family, with each certification series showing its
// full ladder and how many users sit on each rung.
