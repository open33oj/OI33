import { db, ObjectId } from 'hydrooj';
import { logColl } from './log';
import { userColl } from './user';

export const catCanBillColl = db.collection('oi33_cat_can_bill');
export const catCanPoolColl = db.collection('oi33_cat_can_pool');
export const catCanPriceColl = db.collection('oi33_cat_can_price');

const TIME_ZONE = 'Asia/Shanghai';
const MIN_TRADE_QUANTITY = 1;
const TRADE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const BALANCE_COUNTER_VERSION = 1;
const FEE_NUMERATOR = 25;
const FEE_DENOMINATOR = 100000;
const INITIAL_PRICE = 100;
// A single 8-hour tick cannot erase the 5% buy spread. This keeps short-term
// speculation modest while still allowing supply and demand to move the price.
const MAX_TICK_PERCENT = 3;
const PRICE_HISTORY_POINTS = 90;

interface ShanghaiParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

function shanghaiParts(date = new Date()): ShanghaiParts {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
    return {
        year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
        hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    };
}

function priceSlotFor(parts: ShanghaiParts) {
    const slotHour = Math.floor(parts.hour / 8) * 8;
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, slotHour - 8));
}

async function getGlobalBalances() {
    // 只统计已认证用户：未认证用户的猫粮/罐头不参与定价计数。
    const verifiedMatch = { $match: { realname_flag: { $gte: 1 } } };
    const [foodRows, canRows] = await Promise.all([
        userColl.aggregate([
            verifiedMatch,
            { $group: { _id: null, total: { $sum: { $max: [{ $ifNull: ['$cat_food', 0] }, 0] } }, users: { $sum: 1 } } },
        ]).toArray(),
        userColl.aggregate([
            verifiedMatch,
            { $group: { _id: null, total: { $sum: { $max: [{ $ifNull: ['$cat_can', 0] }, 0] } } } },
        ]).toArray(),
    ]);
    return {
        userFood: Number(foodRows[0]?.total) || 0,
        users: Number(foodRows[0]?.users) || 0,
        userCans: Number(canRows[0]?.total) || 0,
    };
}

async function getOrCreatePool(now = new Date()) {
    const existing: any = await catCanPoolColl.findOne({ _id: 'main' });
    if (existing) {
        if (existing.balanceCounterVersion === BALANCE_COUNTER_VERSION) return existing;
        // One-time migration from the old pool. Normal page views and trades use
        // these incremental counters and no longer scan every user.
        const balances = await getGlobalBalances();
        await catCanPoolColl.updateOne(
            { _id: 'main', balanceCounterVersion: { $ne: BALANCE_COUNTER_VERSION } },
            { $set: {
                userFoodTotal: balances.userFood,
                circulatingCans: balances.userCans,
                balanceCounterVersion: BALANCE_COUNTER_VERSION,
                updatedAt: now,
            } },
        );
        return await catCanPoolColl.findOne({ _id: 'main' });
    }
    const balances = await getGlobalBalances();
    const bills = await catCanBillColl.find({ action: { $in: ['buy', 'sell', 'reverse'] } }).toArray();
    let feesBurned = 0;
    const reserveFood = bills.reduce((sum, bill) => {
        const fee = Number(bill.fee) || 0;
        feesBurned += fee;
        const delta = Number(bill.catFoodDelta) || 0;
        const recorded = Number(bill.tradeAmount);
        const principal = Math.abs(recorded) || (bill.action === 'buy'
            ? Math.max(0, -delta - fee)
            : bill.action === 'sell' ? Math.max(0, delta + fee) : 0);
        if (bill.action === 'reverse') return sum + (bill.originalAction === 'buy' ? -principal : principal);
        return sum + (bill.action === 'buy' ? principal : -principal);
    }, 0);
    const systemFood = balances.userFood + reserveFood;
    const virtualCanSupply = Math.max(
        1000,
        balances.userCans + Math.ceil(Math.max(systemFood, INITIAL_PRICE * 1000) / INITIAL_PRICE),
    );
    const doc = {
        _id: 'main', reserveFood, virtualCanSupply,
        feesBurned,
        userFoodTotal: balances.userFood,
        circulatingCans: balances.userCans,
        balanceCounterVersion: BALANCE_COUNTER_VERSION,
        createdAt: now, updatedAt: now,
    };
    try {
        await catCanPoolColl.insertOne(doc as any);
        return doc;
    } catch (e: any) {
        if (e?.code !== 11000) throw e;
        return await catCanPoolColl.findOne({ _id: 'main' });
    }
}

function ceilDivide(numerator: number, denominator: number) {
    return Math.floor((numerator + denominator - 1) / denominator);
}

function calculateFee(amount: number) {
    return ceilDivide(amount * FEE_NUMERATOR, FEE_DENOMINATOR);
}

function calculateBuyPrice(sellPrice: number) {
    return ceilDivide(sellPrice * 105, 100);
}

// All inputs and intermediate values behind a price tick, so both the tick
// writer and the market page work from the exact same numbers.
function computeCatCanPriceParams(pool: any, previousSellPrice?: number) {
    const reserveFood = Math.max(0, Number(pool?.reserveFood) || 0);
    const userFood = Math.max(0, Number(pool?.userFoodTotal) || 0);
    const userCans = Math.max(0, Number(pool?.circulatingCans) || 0);
    const supply = Math.max(userCans + 1, Number(pool?.virtualCanSupply) || 1000);
    const poolCans = Math.max(1, supply - userCans);
    const systemFood = Math.max(1, userFood + reserveFood);
    const ammPrice = systemFood / poolCans;
    const backingPrice = userCans > 0 ? reserveFood / userCans : ammPrice;
    const rawTarget = Math.max(1, Math.min(ammPrice, backingPrice));
    const previousPrice = Math.max(1, Math.floor(previousSellPrice || INITIAL_PRICE));
    const lowerBound = ceilDivide(previousPrice * (100 - MAX_TICK_PERCENT), 100);
    const upperBound = Math.floor(previousPrice * (100 + MAX_TICK_PERCENT) / 100);
    const boundedTarget = Math.max(lowerBound, Math.min(upperBound, Math.floor(rawTarget)));
    const backingCap = userCans > 0 ? Math.floor(backingPrice) : boundedTarget;
    const sellPrice = Math.max(1, Math.min(boundedTarget, backingCap));
    const buyPrice = calculateBuyPrice(sellPrice);
    return {
        reserveFood, userFood, userCans, supply, poolCans, systemFood,
        ammPrice, backingPrice, rawTarget,
        previousPrice, lowerBound, upperBound, boundedTarget, backingCap,
        sellPrice, buyPrice,
    };
}

export async function ensureCurrentCatCanPrice(now = new Date()) {
    const parts = shanghaiParts(now);
    const slotAt = priceSlotFor(parts);
    const existing = await catCanPriceColl.findOne({ _id: slotAt });
    if (existing) return existing;
    const [pool, previous] = await Promise.all([
        getOrCreatePool(now),
        catCanPriceColl.find({ _id: { $lt: slotAt } }).sort({ _id: -1 }).limit(1).next(),
    ]);
    const { sellPrice, buyPrice } = computeCatCanPriceParams(pool, Number(previous?.sellPrice) || 0);
    const snapshot = {
        _id: slotAt,
        sellPrice,
        buyPrice,
        createdAt: now,
    };
    try {
        await catCanPriceColl.insertOne(snapshot as any);
        return snapshot;
    } catch (e: any) {
        if (e?.code !== 11000) throw e;
        return await catCanPriceColl.findOne({ _id: slotAt });
    }
}

export async function ensureCatCanIndexes() {
    await Promise.all([
        catCanBillColl.createIndex({ uid: 1, createdAt: -1 }),
        catCanBillColl.createIndex({ createdAt: 1 }),
        catCanPriceColl.createIndex({ createdAt: -1 }),
    ]);
}

export async function getOrCreateCurrentMarket(now = new Date()) {
    return await ensureCurrentCatCanPrice(now);
}

export async function getCurrentQuote(now = new Date()) {
    const market: any = await ensureCurrentCatCanPrice(now);
    const sellPrice = Number(market.sellPrice) || 1;
    return {
        isOpen: true,
        sellPrice,
        buyPrice: Number(market.buyPrice) || calculateBuyPrice(sellPrice),
    };
}

// 24h change is measured on the AMM anchor (sell) price against the newest
// price slot recorded at or before now-24h. Null when no baseline exists.
export async function getCatCanDayChange(now = new Date()) {
    const quote = await getCurrentQuote(now);
    const baseline: any = await catCanPriceColl
        .find({ _id: { $lte: new Date(now.getTime() - 24 * 3600 * 1000) } } as any)
        .sort({ _id: -1 }).limit(1).next();
    const basePrice = Number(baseline?.sellPrice) || 0;
    return {
        ...quote,
        changePercent: basePrice > 0 ? ((quote.sellPrice - basePrice) / basePrice) * 100 : null,
        baselineAt: baseline?._id || null,
    };
}

function buildPriceHistory(rows: any[]) {
    const plot = { left: 62, right: 838, top: 20, bottom: 214 };
    if (!rows.length) return { nodes: [], sellPoints: '', min: 0, max: 0 };
    const prices = rows.map((row) => Number(row.sellPrice) || 0);
    const rawMin = Math.min(...prices);
    const rawMax = Math.max(...prices);
    const padding = Math.max(1, Math.ceil((rawMax - rawMin || rawMax || 1) * 0.08));
    const min = Math.max(0, rawMin - padding);
    const max = rawMax + padding;
    const range = Math.max(1, max - min);
    const y = (value: number) => Math.round((plot.bottom - (plot.bottom - plot.top) * (value - min) / range) * 10) / 10;
    const labelEvery = Math.max(1, Math.ceil(rows.length / 7));
    const formatter = new Intl.DateTimeFormat('zh-CN', {
        timeZone: TIME_ZONE, month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    });
    const nodes = rows.map((row, index) => {
        const at = new Date(row._id || row.createdAt);
        const sellPrice = Number(row.sellPrice) || 0;
        return {
            x: Math.round((plot.left + (plot.right - plot.left) * index / Math.max(1, rows.length - 1)) * 10) / 10,
            sellY: y(sellPrice), sellPrice,
            label: formatter.format(at),
            showLabel: index === 0 || index === rows.length - 1 || index % labelEvery === 0,
        };
    });
    return {
        nodes,
        sellPoints: nodes.map((node) => `${node.x},${node.sellY}`).join(' '),
        min, max,
    };
}

async function getCatCanPriceHistory() {
    const rows = await catCanPriceColl.find({})
        .sort({ _id: -1 }).limit(PRICE_HISTORY_POINTS).toArray();
    rows.reverse();
    return buildPriceHistory(rows);
}

function validateTrade(quantity: number) {
    if (!Number.isSafeInteger(quantity) || quantity < MIN_TRADE_QUANTITY) {
        throw new Error(`交易数量必须是大于等于 ${MIN_TRADE_QUANTITY} 的整数。`);
    }
}

function cooldownMatch(user: any) {
    return user?.cat_can_trade_available_at
        ? { cat_can_trade_available_at: user.cat_can_trade_available_at }
        : { cat_can_trade_available_at: { $exists: false } };
}

function getCooldownUntil(user: any) {
    const value = user?.cat_can_trade_available_at;
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function assertTradeCooldown(user: any, now: Date) {
    const until = getCooldownUntil(user);
    if (until && until.getTime() > now.getTime()) {
        const display = new Intl.DateTimeFormat('zh-CN', {
            timeZone: TIME_ZONE, month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }).format(until);
        throw new Error(`交易冷却中，下一次允许交易时间：${display}。`);
    }
}

async function rollbackUserTrade(uid: number, nextTradeAt: Date, previousCooldown: Date | null, deltas: { food: number; cans: number }) {
    const update: any = { $inc: { cat_food: deltas.food, cat_can: deltas.cans } };
    if (previousCooldown) update.$set = { cat_can_trade_available_at: previousCooldown };
    else update.$unset = { cat_can_trade_available_at: '' };
    await userColl.updateOne({ _id: uid, cat_can_trade_available_at: nextTradeAt }, update);
}

async function throwTradeUpdateFailure(uid: number, now: Date, fallback: string): Promise<never> {
    const current = await userColl.findOne({ _id: uid });
    assertTradeCooldown(current, now);
    throw new Error(fallback);
}

export async function buyCatCans(uid: number, quantity: number, now = new Date()) {
    const quote = await getCurrentQuote(now);
    validateTrade(quantity);
    const [pool, previousUser] = await Promise.all([getOrCreatePool(now), userColl.findOne({ _id: uid })]);
    assertTradeCooldown(previousUser, now);
    const cost = quote.buyPrice * quantity;
    const fee = calculateFee(cost);
    const total = cost + fee;
    if (!Number.isSafeInteger(cost) || !Number.isSafeInteger(total)) throw new Error('本次交易数量过大。');
    const nextTradeAt = new Date(now.getTime() + TRADE_COOLDOWN_MS);
    const previousCooldown = getCooldownUntil(previousUser);
    const updated = await userColl.updateOne(
        { _id: uid, cat_food: { $gte: total }, ...cooldownMatch(previousUser) },
        {
            $inc: { cat_food: -total, cat_can: quantity },
            $set: { cat_can_trade_available_at: nextTradeAt },
        },
    );
    if (!updated.modifiedCount) return await throwTradeUpdateFailure(uid, now, '猫粮不足，无法完成购买。');
    const maxBeforeBuy = Number((pool as any)?.virtualCanSupply || 0) - quantity - 1;
    const poolUpdated = await catCanPoolColl.updateOne(
        { _id: 'main', circulatingCans: { $lte: maxBeforeBuy } },
        { $inc: {
            reserveFood: cost, feesBurned: fee,
            userFoodTotal: -total, circulatingCans: quantity,
        }, $set: { updatedAt: now } },
    );
    if (!poolUpdated.modifiedCount) {
        await rollbackUserTrade(uid, nextTradeAt, previousCooldown, { food: total, cans: -quantity });
        throw new Error('市场可用猫罐头不足，请等待下一次价格调整。');
    }
    try {
        const user: any = await userColl.findOne({ _id: uid });
        await catCanBillColl.insertOne({
            _id: new ObjectId(), uid, action: 'buy', quantity,
            unitPrice: quote.buyPrice, tradeAmount: cost, fee, catFoodDelta: -total,
            balanceAfter: user?.cat_food ?? 0, inventoryAfter: user?.cat_can ?? quantity,
            createdAt: now,
        });
    } catch (e) {
        await Promise.all([
            rollbackUserTrade(uid, nextTradeAt, previousCooldown, { food: total, cans: -quantity }),
            catCanPoolColl.updateOne({ _id: 'main' }, { $inc: {
                reserveFood: -cost, feesBurned: -fee,
                userFoodTotal: total, circulatingCans: -quantity,
            } }),
        ]);
        throw e;
    }
    return { quantity, price: quote.buyPrice, amount: cost, fee, total, nextTradeAt };
}

export async function sellCatCans(uid: number, quantity: number, now = new Date()) {
    const quote = await getCurrentQuote(now);
    validateTrade(quantity);
    const previousUser: any = await userColl.findOne({ _id: uid });
    assertTradeCooldown(previousUser, now);
    if ((Number(previousUser?.cat_can) || 0) < quantity) throw new Error('猫罐头库存不足。');
    const revenue = quote.sellPrice * quantity;
    const fee = calculateFee(revenue);
    const received = Math.max(0, revenue - fee);
    if (!Number.isSafeInteger(revenue) || !Number.isSafeInteger(received)) throw new Error('本次交易数量过大。');
    const nextTradeAt = new Date(now.getTime() + TRADE_COOLDOWN_MS);
    const previousCooldown = getCooldownUntil(previousUser);
    const updated = await userColl.updateOne(
        { _id: uid, cat_can: { $gte: quantity }, ...cooldownMatch(previousUser) },
        {
            $inc: { cat_food: received, cat_can: -quantity },
            $set: { cat_can_trade_available_at: nextTradeAt },
        },
    );
    if (!updated.modifiedCount) return await throwTradeUpdateFailure(uid, now, '猫罐头库存不足。');
    const poolUpdated = await catCanPoolColl.updateOne(
        { _id: 'main', reserveFood: { $gte: revenue } },
        { $inc: {
            reserveFood: -revenue, feesBurned: fee,
            userFoodTotal: received, circulatingCans: -quantity,
        }, $set: { updatedAt: now } },
    );
    if (!poolUpdated.modifiedCount) {
        await rollbackUserTrade(uid, nextTradeAt, previousCooldown, { food: -received, cans: quantity });
        throw new Error('市场储备不足，当前无法完成这笔卖出。');
    }
    try {
        const user: any = await userColl.findOne({ _id: uid });
        await catCanBillColl.insertOne({
            _id: new ObjectId(), uid, action: 'sell', quantity: -quantity,
            unitPrice: quote.sellPrice, tradeAmount: revenue, fee, catFoodDelta: received,
            balanceAfter: user?.cat_food ?? received, inventoryAfter: user?.cat_can ?? 0,
            createdAt: now,
        });
    } catch (e) {
        await Promise.all([
            rollbackUserTrade(uid, nextTradeAt, previousCooldown, { food: -received, cans: quantity }),
            catCanPoolColl.updateOne({ _id: 'main' }, { $inc: {
                reserveFood: revenue, feesBurned: -fee,
                userFoodTotal: -received, circulatingCans: quantity,
            } }),
        ]);
        throw e;
    }
    return { quantity, price: quote.sellPrice, amount: revenue, fee, received, nextTradeAt };
}

interface CatCanEconomyWindow {
    checkinMint: number; // 签到发放（含上线补发）
    adminMint: number; // 管理员/比赛发放（单个 + 批量）
    tradeFeeBurn: number; // 交易手续费销毁
    feedBurn: number; // 投喂大猫销毁
    moveBurn: number; // 地图移动销毁
    contractFeeBurn: number; // 合同中介费销毁
    deductBurn: number; // 管理员扣减
    auctionFoodBurn: number; // 拍卖结算销毁的储备粮（不来自用户余额，不计入净增发）
    mintTotal: number;
    burnTotal: number;
    net: number; // 净增发 = 发放 - 销毁
    cansBought: number; // 买入（池子售出）
    cansSoldBack: number; // 卖出回池（撤销单按负数量自动冲抵）
    cansOtherBack: number; // 传送/喵喵/拍卖结算回池
    cansNetOut: number; // 池子净售出（负值 = 净回收）
}

function emptyEconomyWindow(): CatCanEconomyWindow {
    return {
        checkinMint: 0, adminMint: 0,
        tradeFeeBurn: 0, feedBurn: 0, moveBurn: 0, contractFeeBurn: 0, deductBurn: 0,
        auctionFoodBurn: 0,
        mintTotal: 0, burnTotal: 0, net: 0,
        cansBought: 0, cansSoldBack: 0, cansOtherBack: 0, cansNetOut: 0,
    };
}

function finalizeEconomyWindow(w: CatCanEconomyWindow) {
    w.mintTotal = w.checkinMint + w.adminMint;
    w.burnTotal = w.tradeFeeBurn + w.feedBurn + w.moveBurn + w.contractFeeBurn + w.deductBurn;
    w.net = w.mintTotal - w.burnTotal;
    w.cansNetOut = w.cansBought - w.cansSoldBack - w.cansOtherBack;
}

// 7d/30d cat-food mint vs burn plus can-flow stats, sourced from oi33_log
// (every food/can flow writes one) and the trade bill ledger.
async function getCatCanEconomy(now = new Date()) {
    const since30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const since7 = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const [logs, bills] = await Promise.all([
        logColl.find({
            createdAt: { $gte: since30 },
            $or: [
                { type: 'checkin' },
                { type: 'cat_account' },
                { type: 'contract', action: 'accept' },
                { type: 'auction', action: 'settle' },
            ],
        } as any, {
            projection: { type: 1, action: 1, amount: 1, canAmount: 1, fee: 1, foodBurn: 1, createdAt: 1 },
        }).toArray(),
        catCanBillColl.find(
            { createdAt: { $gte: since30 } },
            { projection: { quantity: 1, fee: 1, createdAt: 1 } },
        ).toArray(),
    ]);
    const w7 = emptyEconomyWindow();
    const w30 = emptyEconomyWindow();
    const windowsFor = (at: Date) => (new Date(at).getTime() >= since7.getTime() ? [w7, w30] : [w30]);
    for (const log of logs) {
        const amount = Number((log as any).amount) || 0;
        const canAmount = Number((log as any).canAmount) || 0;
        for (const w of windowsFor((log as any).createdAt)) {
            if ((log as any).type === 'checkin') {
                if (amount > 0) w.checkinMint += amount;
            } else if ((log as any).type === 'cat_account') {
                const action = (log as any).action;
                if ((action === 'grant' || action === 'bulk_grant') && amount > 0) w.adminMint += amount;
                else if (action === 'school_feed') w.feedBurn += Math.max(0, -amount);
                else if (action === 'cat_map_move' || action === 'cat_map_territory_teleport') {
                    w.moveBurn += Math.max(0, -amount);
                }
                else if (action === 'deduct') w.deductBurn += Math.max(0, -amount);
                // Teleports and meow posts return cans to the pool; refunds take them back.
                w.cansOtherBack -= canAmount;
            } else if ((log as any).type === 'contract') {
                w.contractFeeBurn += Math.max(0, Number((log as any).fee) || 0);
            } else if ((log as any).type === 'auction') {
                // Settled bids return the escrowed cans to the pool; the
                // equivalent reserve food is burned (legacy settles have no
                // foodBurn and simply contribute nothing here).
                w.cansOtherBack += Math.max(0, amount);
                w.auctionFoodBurn += Math.max(0, Number((log as any).foodBurn) || 0);
            }
        }
    }
    for (const bill of bills) {
        const quantity = Number((bill as any).quantity) || 0;
        const fee = Number((bill as any).fee) || 0; // reversal bills carry negative fees
        for (const w of windowsFor((bill as any).createdAt)) {
            w.tradeFeeBurn += fee;
            if (quantity > 0) w.cansBought += quantity;
            else w.cansSoldBack += -quantity;
        }
    }
    finalizeEconomyWindow(w7);
    finalizeEconomyWindow(w30);
    return { days7: w7, days30: w30 };
}

export async function getCatCanPage(uid: number, now = new Date()) {
    const quote = await getCurrentQuote(now);
    const slotAt = priceSlotFor(shanghaiParts(now));
    const [user, pool, priceHistory, previous, economy] = await Promise.all([
        userColl.findOne({ _id: uid }),
        getOrCreatePool(now),
        getCatCanPriceHistory(),
        catCanPriceColl.find({ _id: { $lt: slotAt } }).sort({ _id: -1 }).limit(1).next(),
        getCatCanEconomy(now),
    ]);
    const params = computeCatCanPriceParams(pool, Number(previous?.sellPrice) || 0);
    const virtualCanSupply = Math.max(1, Number((pool as any)?.virtualCanSupply) || 1);
    const circulatingCans = Math.max(0, Number((pool as any)?.circulatingCans) || 0);
    const cooldownUntil = getCooldownUntil(user);
    const isCoolingDown = !!cooldownUntil && cooldownUntil.getTime() > now.getTime();
    return {
        quote: {
            isOpen: quote.isOpen,
            sellPrice: quote.sellPrice,
            buyPrice: quote.buyPrice,
            availableCans: Math.max(0, virtualCanSupply - circulatingCans - 1),
        },
        market: {
            ...params,
            feesBurned: Math.max(0, Number((pool as any)?.feesBurned) || 0),
            initialPrice: INITIAL_PRICE,
            maxTickPercent: MAX_TICK_PERCENT,
        },
        balance: Number((user as any)?.cat_food) || 0,
        inventory: Number((user as any)?.cat_can) || 0,
        feeNumerator: FEE_NUMERATOR,
        feeDenominator: FEE_DENOMINATOR,
        minQuantity: MIN_TRADE_QUANTITY,
        inputStep: 1,
        tradeCooldownMs: TRADE_COOLDOWN_MS,
        cooldownUntilMs: isCoolingDown ? cooldownUntil!.getTime() : 0,
        isCoolingDown,
        priceHistory,
        economy7: economy.days7,
        economy30: economy.days30,
    };
}
