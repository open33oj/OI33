// 猫罐头「买入价」（用户从池子买罐头的价格）的纯规则。
//
// 卖出价（用户把罐头卖回池子）仍由 can.ts 按 min(AMM, 储备支撑价) 计算，
// 并受 ±3%/8h 限制——那是池子的偿付上限，不能向 AMM 靠拢。这里只计算
// 池子卖罐头时的价格：它从上一期价格出发，向 AMM 与卖出价之间的目标靠拢，
// 从而在池内罐头稀缺时把「稀缺租金」留给池子，而不是按固定 5%/10% 贱卖。
//
// 参数：
//   sellPrice       页面「卖出价」= 池子买入价 = 偿付上限
//   ammPrice        系统猫粮总量 / 池内罐头
//   previousBuyPrice 上一期「买入价」（价格点里存的 buyPrice）
//   alphaPercent    向 AMM 靠拢的比例：0 = 只按最低价差，100 = 完全按 AMM
//   maxTickPercent  每 8 小时最多变动百分比
//   maxMultiple     买入价最高为卖出价的多少倍
//   minSpreadPercent 买入价相对卖出价的最低百分比价差（默认 10%）
//
// 纯函数，不 import hydrooj / DB / DOM；单测见 can-price-rules.test.ts。

export const SALE_TARGET_ALPHA_PERCENT = 25;
export const SALE_MAX_TICK_PERCENT = 10;
export const SALE_MAX_MULTIPLE = 5;
export const SALE_MIN_SPREAD_PERCENT = 10;

function ceilDivide(numerator: number, denominator: number) {
    return Math.floor((numerator + denominator - 1) / denominator);
}

export interface CatCanBuyPriceInput {
    sellPrice: number;
    ammPrice: number;
    previousBuyPrice?: number;
    alphaPercent?: number;
    maxTickPercent?: number;
    maxMultiple?: number;
    minSpreadPercent?: number;
}

export interface CatCanBuyPriceResult {
    buyPrice: number;
    targetSale: number;
    minSale: number;
    maxSale: number;
    previousSale: number;
    alphaPercent: number;
    maxTickPercent: number;
    maxMultiple: number;
}

export function nextCatCanBuyPrice(input: CatCanBuyPriceInput): CatCanBuyPriceResult {
    const sellPrice = Math.max(1, Math.floor(Number(input.sellPrice) || 1));
    const ammPrice = Math.max(1, Number(input.ammPrice) || 1);
    const alphaPercent = Math.min(100, Math.max(0, Number(input.alphaPercent ?? SALE_TARGET_ALPHA_PERCENT)));
    const maxTickPercent = Math.min(100, Math.max(0, Number(input.maxTickPercent ?? SALE_MAX_TICK_PERCENT)));
    const maxMultiple = Math.max(1, Number(input.maxMultiple ?? SALE_MAX_MULTIPLE));
    const minSpreadPercent = Math.max(0, Number(input.minSpreadPercent ?? SALE_MIN_SPREAD_PERCENT));

    // 至少比卖出价高 1 个猫粮，同时保证最低百分比价差。
    const minSale = Math.max(sellPrice + 1, ceilDivide(sellPrice * (100 + minSpreadPercent), 100));
    // 最高不超过卖出价的 maxMultiple 倍，也不超过 AMM；若两者都低于
    // minSale（严重超储），仍以 minSale 作为下限，避免买入价低于卖出价。
    const maxSale = Math.max(minSale, Math.min(
        Math.floor(sellPrice * maxMultiple),
        Math.floor(ammPrice),
    ));
    const rawTarget = sellPrice + (alphaPercent / 100) * (ammPrice - sellPrice);
    const targetSale = Math.max(minSale, Math.min(maxSale, Math.round(rawTarget)));

    const previousSale = Math.max(1, Math.floor(Number(input.previousBuyPrice) || minSale));
    const step = Math.max(1, Math.ceil((previousSale * maxTickPercent) / 100));
    let buyPrice: number;
    if (previousSale < targetSale) {
        buyPrice = Math.min(targetSale, previousSale + step);
    } else {
        buyPrice = Math.max(targetSale, previousSale - step);
    }
    buyPrice = Math.max(minSale, Math.min(maxSale, buyPrice));

    return {
        buyPrice, targetSale, minSale, maxSale, previousSale,
        alphaPercent, maxTickPercent, maxMultiple,
    };
}
