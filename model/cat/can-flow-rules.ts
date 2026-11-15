// 拍卖结算对「罐头流动」面板的净影响。
//
// 只有 `action === 'settle'` 的 auction 日志会动到池子：
//   - 管理员拍卖：赢家托管的成交价全部收回池内库存，同时销毁等值储备粮；
//   - 用户拍卖：成交价是买家 → 卖家的点对点转移（出价时就已托管），池子一分钱
//     没拿到，只有 5% 成交手续费被销毁。
// 出价、上架托管费、退款、上架 / 取消 / 流拍等 auction 日志都只改变「托管」，
// 不进池子（流拍托管费的回池由对应的 cat_account:auction_deposit_forfeit 记账）。
//
// 纯函数（不 import hydrooj / DB），供 model/cat/can.ts 的 7/30 天经济面板使用。

export interface AuctionSettleCanFlow {
    // 回到池内库存的罐头。
    otherBack: number;
    // 直接销毁的罐头（用户拍卖成交手续费）。
    feeBurned: number;
    // 销毁的储备粮（管理员拍卖，按结算时卖价折算）。
    foodBurned: number;
}

export function auctionSettleCanFlow(log: any): AuctionSettleCanFlow {
    if (log?.action !== 'settle') return { otherBack: 0, feeBurned: 0, foodBurned: 0 };
    const fee = Math.max(0, Math.floor(Number(log.fee) || 0));
    // 用户拍卖才收成交手续费；有手续费就说明成交价打给了卖家，池子不回池。
    if (fee > 0) return { otherBack: 0, feeBurned: fee, foodBurned: 0 };
    return {
        otherBack: Math.max(0, Math.floor(Number(log.amount) || 0)),
        feeBurned: 0,
        foodBurned: Math.max(0, Math.floor(Number(log.foodBurn) || 0)),
    };
}
