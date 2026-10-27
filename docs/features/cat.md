# 猫咪地图与大猫世界

> 代码：`model/cat/{map,map-player,map-admin,map-plan,map-plan-rules,eligibility,
> school-shared,school,school-player,school-transfer,school-reward}.ts`、
> `handler/cat/{can,plan,account,school}.ts`、`frontend/cat-can-arena.page.ts`、
> `frontend/cat-big-arena.ts`、`data/school-cat-data.json`。

## 地图

- 画布 **1000×1000**，坐标 0~999；格子 `_id` 为 `"x:y"`，存 `color`(0-255) 与
  `catId`（大猫归属）。常量在 `shared/cat-map.ts`（前后端同一份）：
  `CAT_MAP_WIDTH/HEIGHT`、`CAT_MAP_CORE_MIN=250`、`CAT_MAP_CORE_MAX=749`。
- **分区**：距边框 250 格的环形为帝国区；中央 500×500（坐标 250~749）为 00区。
  分界线画成 00区外框的加粗「口」字，由「帝国边界」图层开关控制（默认开）。
- **catId 编码**：非负学校 id 编码为 `schoolId + 1`（OIerDB 有 0 号学校，0 表示无大猫）；
  特殊大猫直接用负数 id。
- 集合：`oi33_cat_map_player`（`_id=uid`）、`oi33_cat_map_cell`、
  `oi33_cat_map_plan`、`oi33_cat_map_config`（`_id:'main'`，`planMaxSteps` 默认 10、夹取 1~50）。
- 领地计数增量维护；启动时 `recountSchoolCatTerritories` 全量重算一次，修复
  「写格子」与「写计数」之间崩溃的窗口。

## 玩家动作

- 准入：`getEligibleUser`（`model/cat/eligibility.ts`），要求 `realname_flag ≥ 1`。
- 加入 / 移动 / 染色 / 领地传送：`joinCatMapPlayer` / `moveCatMapPlayer` /
  `setCatMapCellColor`；移动与传送消耗猫粮/罐头，冷却按持有量在 50~120 分钟之间。
- 变色会更新归属、贡献与边界；贡献记入 `school_cat_food` 与大猫体重。
- 管理员：`adminPaintCatMap`（矩形绘图）、`adminRelocateCatMapPlayer`（强制迁移）。

## 领地核心与驱逐

00区内某格与上下左右四邻全部归属同一大猫 = 「领地核心」（`fortressCatIdAt`）；
禁止绑定其他大猫的小猫移动/加入进入。染色形成核心时，滞留在核心上的小猫被
`displaceFortressIntruders` 驱逐：绑定大猫的传送到自己领地随机格，未绑定的传送到
帝国区随机位置；驱逐走 `oi33/cat-map-change` 的 player 广播。

## 路径规划

- 一人一计划（`_id=uid`）：连续步骤（每一步 = 相邻格 + 颜色码）、`cursor`、`status`、
  `failReason`、执行租约 `lockOwner/lockUntil`。
- `saveCatMapPlan`（replace/append）、`stopCatMapPlan`、`advanceCatMapPlan`
  （抢租约、目标格幂等恢复、位置校验、并发冲突重试 3 次）、`runCatMapPlansDue`。
- 纯校验：`validateCatMapPlanShape` / `normalizeCatMapPlanMaxSteps`（可单测）。
- 执行：根 `index.ts` 仅在 instance 0 上每 5 秒跑一次 tick，广播
  `{type:'plan', targetUid}`，前端按连接用户过滤（计划是私有数据）。
- 每步复用 `moveCatMapPlayer` + `setCatMapCellColor`，所以费用/冷却/贡献/驱逐/日志与
  手动操作完全一致；手动 move/color 与管理员强制迁移都会立刻停止计划（私信通知）。
- 前端只画 `cursor` 之后的步骤、编号从 1 开始；`/oi33/arena/plan/state` 提供兜底同步，
  两处响应都按 `updatedAt` 拒绝更旧视图。

## 大猫（学校）

- 学校表：`data/school-cat-data.json`（OIerDB，`scripts/build-school-cat-data.py` 生成，
  运行期只在内存索引）。
- 集合：`oi33_school_cat`、`oi33_school_feed_history`、`oi33_school_cat_reward`。
- 特殊大猫：负数 `_id`、自定义 `name`、★ 不占数字名次、周奖励走管理员规则；是**唯一**
  的管理员大猫形式（旧 `isAdminCat` 已废弃，迁移会清除）。flag≥2 可搜索/绑定，
  flag≥3 可创建/改名；`transferSchoolCat`（flag≥3）整体转移绑定用户/投喂历史/体重/
  领地格子并重算 `territoryCount`。
- 绑定/投喂/解绑：`bindSchoolCat` / `unbindSchoolCat` / `removeSchoolCatBinding` /
  `feedSchoolCat`（2 小时冷却，写 `oi33_school_feed_history`）。
- 周奖励：领地基数（≥64 格起 1，翻倍 +1，封顶 12）× `max(0, ⌊log₂体重⌋−10)`，
  按 `⌊log₂贡献⌋` 权重用最大余数法分配；结算后全体用户当前贡献与大猫体重各扣 5%
  （回滚不恢复）。`settleSchoolCatWeeklyRewards` / 回滚 / 明细查询在
  `model/cat/school-reward.ts`。
- 页面：大猫详情/排行/世界状态、`/oi33/admin/school-cat-rewards*`（flag≥3）。

## 路由

`/oi33/arena`（页面）、`/oi33/arena/state`、`join`、`move`、`color`、`plan`、
`plan/cancel`、`plan/state`、`arena/conn`（Connection）；`/oi33/arena/big/state`、
`/oi33/arena/big/ranking/weekly-reward`；`/oi33/cat-arena/admin`、`admin/settings`、
`admin/relocate`、`admin/refresh-territories`。旧 `/oi33/cat-can/arena*` 保留兼容路由。

## 坑

- `catId` 的 +1 编码只用于格子；特殊大猫负数直接使用，不能混。
- 计划模块单向依赖 `map-player/map`；不要再反向 import，避免循环。
- 前端画布与后端共享 `shared/cat-map.ts` 的尺寸/分区常量，不要再复制一份。
- 00区核心判定只看上下左右四邻，且只在该格被染色时检查。
