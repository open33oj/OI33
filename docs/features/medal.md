# 奖章

> 代码：`model/medal/`、`handler/medal/`、`templates/oi33_medal_*.html`、
> `frontend/medal-showcase.page.ts`、`shared/medal-showcase.ts`。
> 集合：`oi33_medal`（定义）、`oi33_user_medal`（持有）。

## 四个系列

系列由定义本身**派生**（`medalCategoryOf`），不存库：

| 系列 | 判定 | 发放方式 |
| --- | --- | --- |
| 一般（`manual`） | `ruleType: 'manual'` 且不可售卖 | 管理员手动 / 盲盒；可重复获得 |
| 可售卖（`saleable`） | `saleable: true` | 全服唯一，经拍卖/合同转手，不上架时可手动发放 |
| 奖项认证（`certification`） | `ruleType: 'certification'` | 管理员按等级阶梯授予/升级 |
| OJ 成就（`oj`） | 自动规则类型（`accepted_problems` / `checkin_streak` / `checkin_total` / `cat_food_balance` / `cat_can_balance` / `special_medals`） | 规则评估自动升级 |

奖项认证与 OJ 成就共用 `levels` 阶梯：每级有 `level`、`name`、`description`、
`imageData`/`imageSize`，OJ 系列每级另有 `threshold`。一般奖章可重复获得，
`oi33_user_medal.count` 记数量，星级 `⌊log₂ count⌋` 由 `medalStarLevel` 派生、不存库
（旧记录视为 1 枚）。

## 关键规则函数（纯函数在 `model/medal/rules.ts`）

- `medalCategoryOf` / `medalCategoryName` / `medalGroupByCategory` / `medalCategoryRank`
- `medalLevelOf`（严格，写路径用）vs `medalDisplayRung`（宽松，渲染用：等级被删后回退到最近的存活等级）
- `medalSortedLevels` / `medalThresholdLevel` / `medalIsLevelSeries` / `medalAwardView`
- `medalLevelLabel`（去掉历史 `Lv.N` 前缀，无名回退「第 N 级」）
- `medalAutomaticRuleText` / `AUTOMATIC_RULE_TYPES` / `MEDAL_AUTOMATIC_SERIES`
- 展示墙：`medalShowcasePieces` / `medalShowcaseCopyLimit` / `medalShowcaseTrim` /
  `medalShowcaseScale` / `MEDAL_SHOWCASE_*`（几何常量在 `shared/medal-showcase.ts`）

## 写入 API

- `medalSave` / `medalDelete` / `medalGet` / `medalList` / `medalCatalogue`
- `medalGrant(uid, medalId, grantedBy, source, level?)`：一般奖章重复发放累加 `count`，
  其它系列只记一枚；非 OJ 奖章会触发 `special_medals` 指标重算（不会递归）。
- `medalSetLevel`（管理员升降级，可降）/ `medalRevoke`
- `medalEvaluateUser` / `medalEvaluateAll`：只评估自动规则；OJ 阶梯只升不降；
  未实名用户不触发。
- `medalMigrateAutomaticLevels`：扁平 OJ 定义 → 等级系列的一次性迁移
- `medalImportInitialDefinitions`：导入内置五个 OJ 系列（题海/长明/足迹/粮仓/罐藏，
  各 12 级），只补缺失、不覆盖已编辑的阶梯。
- 接受题目域：`medalGetAcceptedDomains` / `medalSetAcceptedDomains` /
  `medalAcceptedDomainIncluded`，存 core `SystemModel`（低频写、热路径读，靠内存缓存）。

## 查询 API

`medalList`、`medalCatalogue`、`medalGetUserAwards`、`medalListRecentAwards`、
`medalListAwardsPaginated`（返回 `{awards,total,tpcount}`）、`medalAwardStats`
（持有人数 + 总持有数量 + 各级人数）、`medalListLevelHolders`、`medalListHolders`。

## 定义导入导出

`medalExportDefinitions` / `medalImportDefinitions`，格式 `oi33-medals` v1，
**只含定义、不含持有记录**；`mode=merge` 补/改，`mode=insert` 只新增。

## 展示墙

`/oi33/medals/showcase` 是一块 320×128 的像素画布（10×4 个 32×32 奖章）：

- 摆放存 `oi33_user.medal_showcase: { id, x, y }[]`（像素坐标，最多 40 个）；
  旧 4×4/6×3 槽位数组在读取时按 10 列铺回网格，无需迁移。
- 编辑页按整数倍缩放（上限 6），个人页按卡片宽度等比铺满（上限 4）；
  半格吸附 16px，Alt 1px 微调，落到已有奖章上会替换/互换。
- 一般奖章按星级可摆多份（`medalShowcaseCopyLimit`），其它系列 1 份；
  读取时 `medalShowcaseTrim` 丢掉超限或已不持有的。
- POST 只收 `slots`（JSON 数组）；个人页由 `handler/after/UserDetail` 注入的
  `oi33MedalPanel.showcasePieces/showcaseWall` 渲染。

## 页面与路由（`handler/medal/index.ts` 是唯一路由表）

- 管理：`/oi33/medals`、`/oi33/medals/:id/edit`、`save`、`config`、`export`、`import`、
  `grant`、`level`、`revoke`、`scan`（flag ≥ 2）。
- 公开：`/oi33/medals/catalogue`（四类标签页：一般 → 可售卖 → 奖项认证 → OJ）、
  `/oi33/medals/catalogue/:id/level/:level`、`/oi33/medals/catalogue/:id/holders`、
  `/oi33/medals/user/:uid`。
- 单用户管理：`/oi33/medals/user/:uid/manage`（flag ≥ 2）。
- 旧 `/oi33/achievements*` 四条 GET 重定向。

## 坑

- 新建奖章若同 ID 已存在必须报错，不能静默覆盖（`MedalSaveHandler` 检查）。
- 保存表单带 `editing` 隐藏字段；编辑时目标必须存在。
- 等级名不再自动生成 `Lv.N`；导入时默认名也不要写 `Lv.N`。
- 证书/OJ 阶梯的等级 id 是 1..N 连续整数；删除中间等级后旧持有者靠
  `medalDisplayRung` 回退渲染。
- 一般奖章重复获得的 `count` 是唯一存储，星级是派生值；展示墙份数上限也由星级决定。
