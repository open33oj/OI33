# 经济系统（猫粮 / 猫罐头 / 拍卖 / 合同 / 盲盒）

> 代码：`model/cat/can.ts`（市场）、`model/cat/account.ts`（猫粮账本）、
> `model/auction.ts`、`model/contract.ts`、`model/blindbox.ts` + `blindbox-rules.ts`、
> `handler/cat/{can,account}.ts`、`handler/auction.ts`、`handler/contract.ts`、
> `handler/blindbox.ts`。

## 两种货币

| 货币 | 字段 | 定位 | 主要来源 | 主要去向 |
| --- | --- | --- | --- | --- |
| 猫粮（g） | `oi33_user.cat_food` | 软货币 | 签到、管理员发放、周奖励、题解加精奖励 | 喂猫、移动/传送、买罐头 |
| 猫罐头（个） | `oi33_user.cat_can` | 硬通货 | 签到奖励、管理员发放、卖出/交易 | 拍卖、合同、盲盒、领地传送 |

账本：`oi33_coin_bill`（猫粮/硬币）、`oi33_cat_can_bill`（罐头买卖与调整）。
**每一次增减都要 `addLog`**（审计），页面上的「硬币账单」走 `/oi33/coin/bill/:uid`。

核心 API：`adjustCatCans(uid, operator, delta, reason)`、`grantCatFood(...)`、
`formatCatFood`、`backfillAllCatFood`（启动时一次性补发）。

## 猫罐头市场

- 集合：`oi33_cat_can_pool`（单文档 `main`）、`oi33_cat_can_price`（每日价格点）。
- **卖价**由储备池动态计算，单日涨跌上限 ±3%；**买价** = 卖价 × 105%（5% 价差）。
- 交易手续费 = `ceil(金额 × 25 / 100000)`（即 0.025%，最少 1g）。
- 每个用户 2 小时交易冷却（`cat_can_trade_available_at`），买卖都受。
- 历史价格保留 90 个点；`getCurrentQuote` / `getCatCanDayChange` / `getCatCanPage` /
  `getCatCanEconomy` 出页面与统计。
- 管理员校准：`calibrateCatCanPool(operator)` 按账本重算流通/供应/储备。

## 拍卖（可售卖奖章）

- 集合：`oi33_auction`、`oi33_auction_bid`；奖章以 `medalId` 引用，只有可售卖奖章可上架。
- 出价即托管罐头；取消/流拍退还；`auctionSaleableShowcase` 出展示视图，
  `remainText` 在 `model/auction.ts`。
- 成交后奖章转移、罐头结算、双方记账；操作都写审计日志。

## 合同（点对点交易）

- 集合：`oi33_medal_contract`；发起人锁定奖章/罐头，接受方支付后转移。
- `contractDelete` **只允许发起人删除已取消的合同**，避免单方面撕毁进行中的交易。
- 所有状态变化幂等，失败回滚托管。

## 盲盒（一般奖章的售卖形式）

- 集合：`oi33_medal_blindbox`（组）+ `oi33_medal_blindbox_log`（开盒记录）。
- 规则（`model/blindbox-rules.ts`，纯函数、有单测）：1–10 项，每项概率 1–100，
  总和必须 100；只有一般奖章可入池；开放时间按 `Asia/Shanghai` 解析。
- 购买顺序（任何一步失败都回滚额度和罐头）：
  1. 原子占每日额度（`oi33_user.blindbox_day/blindbox_count`，**每天 3 次、跨组共用**）
  2. `adjustCatCans` 扣款
  3. 整组按权重抽（允许重复）
  4. `medalGrant(source:'blindbox')`：一般奖章累加 `count`，星级由 `medalStarLevel` 派生
- 页面：`/oi33/blindbox`（卡片墙 + 最近 10 次）、`/oi33/blindbox/logs`、
  `/oi33/blindbox/manage`（flag≥2，路径参数 `:id` 编辑，`?edit=` 兼容）。

## 经济平衡的约定

- 新功能如果产出猫粮/罐头，先问三个问题：来源是否可无限刷？有没有冷却/上限？
  失败会不会重复发放？——三个都答清楚再加。
- 周奖励、市场、拍卖、合同、盲盒的写路径全部要**幂等 + 可回滚**，并写 `oi33_log`。
- 高频状态（价格、池子、额度）不要写 `SystemModel`，一律 `oi33_*` 集合。
- 调整余额必须走 `adjustCatCans` / `grantCatFood`，不要直接 `$inc` 用户文档。
