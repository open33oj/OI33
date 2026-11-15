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
- **卖价**（用户卖回池子）由储备池动态计算，单期涨跌上限 ±3%，且不超过 `储备粮 ÷ 流通罐头` 的偿付上限；**买价**（用户从池子买）从上一期买价向 `卖价 + 25% × (AMM − 卖价)` 靠拢，每 8 小时最多 ±10%，最低为卖价的 110%，最高为 `min(卖价 × 5, AMM)`。规则在 `model/cat/can-price-rules.ts`，纯函数有单测。
- 交易手续费 = `ceil(金额 × 25 / 100000)`（即 0.025%，最少 1g）。
- 每个用户 2 小时交易冷却（`cat_can_trade_available_at`），买卖都受。
- 历史价格保留 90 个点；`getCurrentQuote` / `getCatCanDayChange` / `getCatCanPage` /
  `getCatCanEconomy` 出页面与统计。
- 管理员校准：`calibrateCatCanPool(operator)` 按账本重算流通/供应/储备。

## 拍卖（可售卖奖章）

- 集合：`oi33_auction`、`oi33_auction_bid`；奖章以 `medalId` 引用，只有可售卖奖章可上架。
- 两种来源：
  - **管理员拍卖**：从未拍出的可售卖奖章，时长 1–720 小时；成交后罐头回流罐头池并销毁等值储备粮。
  - **用户拍卖**：持有「可交易成就」（`source` 为 `auction` / `contract` 的可售卖奖章）的用户可上架，
    固定 7 天、只收猫罐头；上架时奖章托管，**不可取消**（卖家和管理员都不行），
    到期无人出价自动流拍并退回奖章。
- **上架托管费**：用户拍卖上架时按起拍价收取 5%（`ceil`，至少 1 个，见
  `model/auction-rules.ts` 的 `auctionListingDeposit`）罐头，从卖家余额托管扣除。
  成交后全额退回卖家；流拍则托管费回流市场储备（`circulatingCans` 减少，
  `virtualCanSupply` 不变），奖章退还给卖家。旧上架（无 `listingDeposit` 字段）
  没有托管费可退，但仍照常结算。
- **成交手续费**：用户拍卖成交时另按成交价的 5%（`ceil`，至少 1 个，见
  `auctionSellerFee`）收取手续费，从卖家所得中扣除并销毁；卖家实收
  `auctionSellerProceeds(成交价) + 托管费`。管理员拍卖不收取托管费与成交手续费。
- 出价即托管罐头；被超越/取消退款；`auctionSaleableShowcase` 出展示视图，
  `remainText` 在 `model/auction.ts`。
- 成交后奖章转移、罐头结算、双方记账；操作都写审计日志（`auction_deposit` /
  `auction_deposit_refund` / `auction_deposit_forfeit` / `delist_unbid`）。
- **经济面板口径**（`model/cat/can-flow-rules.ts`，纯函数有单测）：只有 `settle` 日志
  影响罐头流动——管理员拍卖的托管罐头回池并销毁等值储备粮；用户拍卖的成交价是买家托管 →
  卖家的点对点转移（`cat_account:auction_sale`），不进池子，只有 5% 手续费计入
  「拍卖成交手续费销毁」。出价 / 上架托管费 / 退款 / 流拍托管费按托管或回池分别统计。
- **规则升级清理**：新拍卖会写入 `rulesVersion: 2`。`/oi33/migrate` 第 20 步（或运维页
  `delist_legacy_unbid_auctions`）把没有版本标记、仍在进行且一次出价都没有的旧拍卖
  统一改为 `cancelled`（用户拍卖退回奖章）；有出价的旧拍卖保留，按新成交手续费结算。
  该清理只命中旧上架，重复执行不会影响新拍卖。

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
  2. `payCatCansToPool` 扣款（**回流市场**，不是销毁）
  3. 整组按权重抽（允许重复）
  4. `medalGrant(source:'blindbox')`：一般奖章累加 `count`，星级由 `medalStarLevel` 派生
- **罐头的去向是回池**：扣款走 `payCatCansToPool`，账本动作 `can_blindbox`——余额与
  `circulatingCans` 一起减少，`virtualCanSupply` 与储备粮不变，等于把罐头放回池内库存
  （别人仍可按市价买走），和喵喵付费发帖同一口径；发奖失败用 `refundCatCansFromPool`
  （`can_blindbox_refund`）原路退回。经济面板把这两类算进「其他回池」，市场校准也不会
  把它们当销毁。
- **历史回算**：改口径前购买盲盒的账本动作是 `can_deduct`（销毁）。
  `migrate.ts` 第 19 步 `blindboxReconcilePoolReturns()` 把这些动作改判成
  `can_blindbox` / `can_blindbox_refund`，再用 `recomputeCanSupplyFromLedger()` 按账本
  重算虚拟供应，把多扣的供应补回来。改判时保留 `reclassifiedFrom` / `reclassifiedAt`
  字段，账本仍可追溯（金额、用户、时间不动）。改判与重算都幂等（改判后匹配不到旧动作、
  重算写回同一个值），因此不需要「只执行一次」标记；预览会显示待改判笔数与净回补罐头数。
- 页面：`/oi33/blindbox`（卡片墙 + 最近 10 次）、`/oi33/blindbox/logs`、
  `/oi33/blindbox/manage`（flag≥2，路径参数 `:id` 编辑，`?edit=` 兼容）。

## 经济平衡的约定

- 新功能如果产出猫粮/罐头，先问三个问题：来源是否可无限刷？有没有冷却/上限？
  失败会不会重复发放？——三个都答清楚再加。
- 周奖励、市场、拍卖、合同、盲盒的写路径全部要**幂等 + 可回滚**，并写 `oi33_log`。
- 高频状态（价格、池子、额度）不要写 `SystemModel`，一律 `oi33_*` 集合。
- 调整余额必须走 `adjustCatCans` / `grantCatFood`，不要直接 `$inc` 用户文档。
