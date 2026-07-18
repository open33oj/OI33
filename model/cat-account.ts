import { db, ObjectId } from 'hydrooj';
import { addLog, logColl } from './log';
import { userColl } from './user';
import { catCanBatchColl, catCanBillColl, catCanPoolColl } from './cat-can';

export const catFoodBatchPreviewColl = db.collection('oi33_cat_food_batch_preview');

const TIME_ZONE = 'Asia/Shanghai';
const ACCOUNT_PAGE_SIZE = 50;
const CHART_DAYS = 7;
const PREVIEW_TTL = 30 * 60 * 1000;

export interface CatFoodGrantItem {
    uid: number;
    amount: number;
    reason: string;
}

export function formatCatFood(value: number) {
    const amount = Number(value) || 0;
    const absolute = Math.abs(amount);
    if (absolute >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)} t`;
    if (absolute >= 1_000) return `${(amount / 1_000).toFixed(2)} kg`;
    return `${amount} g`;
}

export async function ensureCatAccountIndexes() {
    await Promise.all([
        catFoodBatchPreviewColl.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        catFoodBatchPreviewColl.createIndex({ operator: 1, status: 1, createdAt: -1 }),
        logColl.createIndex({ userId: 1, type: 1, createdAt: -1 }),
    ]);
}

function accountFoodFilter(uid: number) {
    return {
        userId: uid,
        amount: { $exists: true, $ne: 0 },
        type: { $in: ['checkin', 'cat_account'] },
    };
}

function normalizeFoodLog(log: any) {
    return {
        _id: String(log._id),
        source: 'food',
        action: log.action || 'checkin',
        createdAt: new Date(log.createdAt || log._id?.getTimestamp?.() || Date.now()),
        foodDelta: Number(log.amount) || 0,
        canDelta: 0,
        reason: log.reason || '',
        operator: log.sender,
        batchId: log.batchId ? String(log.batchId) : '',
        reversible: false,
    };
}

function normalizeCanBill(bill: any) {
    return {
        _id: String(bill._id),
        source: 'can',
        action: bill.action,
        originalAction: bill.originalAction,
        createdAt: new Date(bill.createdAt || bill._id?.getTimestamp?.() || Date.now()),
        foodDelta: Number(bill.catFoodDelta) || 0,
        canDelta: Number(bill.quantity) || 0,
        reason: bill.reversalReason || '',
        unitPrice: Number(bill.unitPrice) || 0,
        tradeAmount: Number(bill.tradeAmount) || 0,
        fee: Number(bill.fee) || 0,
        reversedAt: bill.reversedAt,
        reversedBy: bill.reversedBy,
        reversalBillId: bill.reversalBillId ? String(bill.reversalBillId) : '',
        reversible: ['buy', 'sell'].includes(bill.action) && !bill.reversedAt,
    };
}

function compareEvents(a: any, b: any) {
    const time = b.createdAt.getTime() - a.createdAt.getTime();
    return time || String(b._id).localeCompare(String(a._id));
}

function shanghaiParts(date: Date) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function dateKey(year: number, month: number, day: number) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shanghaiDateKey(date: Date) {
    const parts = shanghaiParts(date);
    return dateKey(parts.year, parts.month, parts.day);
}

function chartDays(now: Date) {
    const today = shanghaiParts(now);
    const base = new Date(Date.UTC(today.year, today.month - 1, today.day));
    return Array.from({ length: CHART_DAYS }, (_, index) => {
        const date = new Date(base.getTime() + (index - CHART_DAYS + 1) * 24 * 60 * 60 * 1000);
        return {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            key: dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()),
            label: `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`,
        };
    });
}

function buildBalanceChart(days: ReturnType<typeof chartDays>, events: any[], foodBalance: number, canBalance: number) {
    const deltas: Record<string, { food: number; can: number }> = {};
    let windowFoodDelta = 0;
    let windowCanDelta = 0;
    for (const event of events) {
        const key = shanghaiDateKey(event.createdAt);
        deltas[key] ||= { food: 0, can: 0 };
        deltas[key].food += event.foodDelta;
        deltas[key].can += event.canDelta;
        windowFoodDelta += event.foodDelta;
        windowCanDelta += event.canDelta;
    }
    let food = foodBalance - windowFoodDelta;
    let cans = canBalance - windowCanDelta;
    const values = days.map((day) => {
        food += deltas[day.key]?.food || 0;
        cans += deltas[day.key]?.can || 0;
        return { ...day, food, cans };
    });

    const plot = { left: 62, right: 838, top: 20, bottom: 214 };
    const makeScale = (numbers: number[]) => {
        const rawMin = Math.min(...numbers);
        const rawMax = Math.max(...numbers);
        const padding = Math.max(1, Math.ceil((rawMax - rawMin || Math.abs(rawMax) || 1) * 0.08));
        const min = rawMin - padding;
        const max = rawMax + padding;
        const range = Math.max(1, max - min);
        return { min, max, y: (value: number) => Math.round((plot.bottom - (plot.bottom - plot.top) * (value - min) / range) * 10) / 10 };
    };
    const foodScale = makeScale(values.map((value) => value.food));
    const canScale = makeScale(values.map((value) => value.cans));
    const nodes = values.map((value, index) => ({
        ...value,
        x: Math.round((plot.left + (plot.right - plot.left) * index / Math.max(1, values.length - 1)) * 10) / 10,
        foodY: foodScale.y(value.food),
        canY: canScale.y(value.cans),
    }));
    return {
        nodes,
        foodPoints: nodes.map((node) => `${node.x},${node.foodY}`).join(' '),
        canPoints: nodes.map((node) => `${node.x},${node.canY}`).join(' '),
        foodMin: foodScale.min,
        foodMax: foodScale.max,
        foodMinLabel: formatCatFood(foodScale.min),
        foodMaxLabel: formatCatFood(foodScale.max),
        canMin: canScale.min,
        canMax: canScale.max,
    };
}

export async function getCatAccountPage(uid: number, page = 1, now = new Date()) {
    const limit = Math.max(1, page) * ACCOUNT_PAGE_SIZE;
    const days = chartDays(now);
    const first = days[0];
    const chartStart = new Date(Date.UTC(first.year, first.month - 1, first.day, -8));
    const foodFilter = accountFoodFilter(uid);
    const [user, foodCount, canCount, foodRows, canRows, chartFoodRows, chartCanRows] = await Promise.all([
        userColl.findOne({ _id: uid }),
        logColl.countDocuments(foodFilter as any),
        catCanBillColl.countDocuments({ uid }),
        logColl.find(foodFilter as any).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray(),
        catCanBillColl.find({ uid }).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray(),
        logColl.find({ ...foodFilter, createdAt: { $gte: chartStart, $lte: now } } as any).toArray(),
        catCanBillColl.find({ uid, createdAt: { $gte: chartStart, $lte: now } }).toArray(),
    ]);
    const merged = [
        ...foodRows.map(normalizeFoodLog),
        ...canRows.map(normalizeCanBill),
    ].sort(compareEvents);
    const chartEvents = [
        ...chartFoodRows.map(normalizeFoodLog),
        ...chartCanRows.map(normalizeCanBill),
    ];
    const foodBalance = Number((user as any)?.cat_food) || 0;
    const canBalance = Number((user as any)?.cat_can) || 0;
    const total = foodCount + canCount;
    return {
        balance: { food: foodBalance, cans: canBalance },
        entries: merged.slice((page - 1) * ACCOUNT_PAGE_SIZE, page * ACCOUNT_PAGE_SIZE),
        chart: buildBalanceChart(days, chartEvents, foodBalance, canBalance),
        upcount: Math.ceil(total / ACCOUNT_PAGE_SIZE),
    };
}

export async function grantCatFood(
    uid: number,
    operator: number,
    amount: number,
    reason: string,
    action: 'grant' | 'bulk_grant' = 'grant',
    meta: { batchId?: ObjectId; batchIndex?: number } = {},
) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('猫粮数量必须是正整数。');
    if (!reason.trim() || reason.trim().length > 100) throw new Error('发放原因不能为空且不能超过 100 字。');
    const result = await userColl.updateOne({ _id: uid }, { $inc: { cat_food: amount } }, { upsert: true });
    if (!result.acknowledged) throw new Error('猫粮发放失败。');
    let counterUpdated = false;
    try {
        const counterResult = await catCanPoolColl.updateOne(
            { _id: 'main' },
            { $inc: { userFoodTotal: amount }, $set: { updatedAt: new Date() } },
        );
        counterUpdated = !!counterResult.modifiedCount;
        await addLog({
            type: 'cat_account', userId: uid, sender: operator,
            action, amount, reason, ...meta,
        } as any);
    } catch (e) {
        const rollback = [userColl.updateOne({ _id: uid }, { $inc: { cat_food: -amount } })];
        if (counterUpdated) rollback.push(catCanPoolColl.updateOne({ _id: 'main' }, { $inc: { userFoodTotal: -amount } }) as any);
        await Promise.all(rollback);
        throw e;
    }
    const user = await userColl.findOne({ _id: uid });
    return { amount, balance: Number((user as any)?.cat_food) || 0 };
}

export async function createCatFoodBatchPreview(operator: number, items: CatFoodGrantItem[]) {
    const now = new Date();
    const preview = {
        _id: new ObjectId(), operator, items, status: 'pending',
        createdAt: now, expiresAt: new Date(now.getTime() + PREVIEW_TTL),
    };
    await catFoodBatchPreviewColl.insertOne(preview as any);
    return preview;
}

export async function getCatFoodBatchPreview(id: string, operator: number) {
    let _id: ObjectId;
    try { _id = new ObjectId(id); } catch { return null; }
    return await catFoodBatchPreviewColl.findOne({ _id, operator });
}

export async function confirmCatFoodBatchPreview(id: string, operator: number, now = new Date()) {
    let _id: ObjectId;
    try { _id = new ObjectId(id); } catch { throw new Error('批量发放预览不存在。'); }
    const preview: any = await catFoodBatchPreviewColl.findOne({ _id, operator });
    if (!preview || preview.status !== 'pending') throw new Error('该预览不存在、已确认或已失效。');
    if (new Date(preview.expiresAt).getTime() <= now.getTime()) throw new Error('该预览已过期，请重新预览。');
    const claimed = await catFoodBatchPreviewColl.updateOne(
        { _id, operator, status: 'pending' },
        { $set: { status: 'processing', confirmedAt: now } },
    );
    if (!claimed.modifiedCount) throw new Error('该预览已被处理。');
    let total = 0;
    try {
        for (let index = 0; index < preview.items.length; index++) {
            const item = preview.items[index];
            await grantCatFood(item.uid, operator, item.amount, item.reason, 'bulk_grant', { batchId: _id, batchIndex: index });
            total += item.amount;
        }
        await catFoodBatchPreviewColl.updateOne({ _id }, { $set: { status: 'completed', completedAt: new Date(), total } });
        return { users: preview.items.length, total };
    } catch (e: any) {
        await catFoodBatchPreviewColl.updateOne({ _id }, { $set: { status: 'failed', failedAt: new Date(), error: e?.message || String(e), total } });
        throw e;
    }
}

export async function reverseCatCanTransaction(id: string, operator: number, reason: string, now = new Date()) {
    if (!reason.trim() || reason.trim().length > 100) throw new Error('撤销原因不能为空且不能超过 100 字。');
    let _id: ObjectId;
    try { _id = new ObjectId(id); } catch { throw new Error('交易记录不存在。'); }
    const original: any = await catCanBillColl.findOne({ _id });
    if (!original || !['buy', 'sell'].includes(original.action)) throw new Error('只能撤销买入或卖出交易。');
    if (original.reversedAt) throw new Error('该交易已经撤销。');
    const claimed = await catCanBillColl.updateOne(
        { _id, reversedAt: { $exists: false } },
        { $set: { reversedAt: now, reversedBy: operator, reversalReason: reason } },
    );
    if (!claimed.modifiedCount) throw new Error('该交易已经撤销。');

    const foodDelta = -(Number(original.catFoodDelta) || 0);
    const canDelta = -(Number(original.quantity) || 0);
    const gross = Number(original.tradeAmount)
        || Math.max(0, (Number(original.unitPrice) || 0) * Math.abs(Number(original.quantity) || 0));
    const fee = Number(original.fee) || 0;
    const reserveDelta = original.action === 'buy' ? -gross : gross;
    const feeDelta = -fee;
    const reversalId = new ObjectId();
    let accountUpdated = false;
    let poolUpdated = false;
    let batchInserted = false;
    let reversalInserted = false;
    try {
        await userColl.updateOne(
            { _id: original.uid },
            { $inc: { cat_food: foodDelta, cat_can: canDelta } },
            { upsert: true },
        );
        accountUpdated = true;
        const poolResult = await catCanPoolColl.updateOne(
            { _id: 'main' },
            { $inc: {
                reserveFood: reserveDelta, feesBurned: feeDelta,
                userFoodTotal: foodDelta, circulatingCans: canDelta,
            }, $set: { updatedAt: now } },
        );
        if (!poolResult.modifiedCount) throw new Error('市场储备不存在，无法撤销。');
        poolUpdated = true;
        if (canDelta > 0) {
            await catCanBatchColl.insertOne({
                _id: new ObjectId(), uid: original.uid, quantity: canDelta, remaining: canDelta,
                unitPrice: Number(original.unitPrice) || 0, purchasedAt: now,
                adjustment: 'reversal', originalBillId: _id,
            } as any);
            batchInserted = true;
        }
        const user: any = await userColl.findOne({ _id: original.uid });
        await catCanBillColl.insertOne({
            _id: reversalId, uid: original.uid, action: 'reverse', originalAction: original.action,
            originalBillId: _id, quantity: canDelta, unitPrice: Number(original.unitPrice) || 0,
            tradeAmount: -gross, fee: feeDelta, catFoodDelta: foodDelta,
            reversalReason: reason, reversedBy: operator,
            balanceAfter: Number(user?.cat_food) || 0, inventoryAfter: Number(user?.cat_can) || 0,
            createdAt: now,
        } as any);
        reversalInserted = true;
        await catCanBillColl.updateOne({ _id }, { $set: { reversalBillId: reversalId } });
        return { uid: original.uid, foodDelta, canDelta };
    } catch (e) {
        if (reversalInserted) await catCanBillColl.deleteOne({ _id: reversalId });
        if (batchInserted) await catCanBatchColl.deleteOne({ originalBillId: _id, adjustment: 'reversal' } as any);
        if (poolUpdated) await catCanPoolColl.updateOne({ _id: 'main' }, { $inc: {
            reserveFood: -reserveDelta, feesBurned: -feeDelta,
            userFoodTotal: -foodDelta, circulatingCans: -canDelta,
        } });
        if (accountUpdated) await userColl.updateOne({ _id: original.uid }, { $inc: { cat_food: -foodDelta, cat_can: -canDelta } });
        await catCanBillColl.updateOne({ _id }, { $unset: { reversedAt: '', reversedBy: '', reversalReason: '' } });
        throw e;
    }
}
