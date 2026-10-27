# 运维与健康（/oi33/admin/ops）

> 代码：`handler/ops.ts`、`model/ops-status.ts`、`templates/oi33_admin_ops.html`。
> 入口：管理仪表盘的「外观与系统 → 运维与健康」。

这是给**单管理员长期运营**准备的一页：把「进程现在健康吗」「哪里出过问题」
「需要修的时候点哪里」放在一起，而不是散在日志、脚本和记忆里。

## 页面内容

- **运行时**：进程启动时间、运行时长、RSS 内存、`NODE_APP_INSTANCE`、Node 版本。
- **启动状态**：本次进程里哪些功能部件 `apply` 失败（`applyPart` 记录）。
  失败不会拖垮整个 addon，但对应的路由/功能在本进程内不可用，页面会红色列出。
- **定时任务**：猫罐头市场（10 分钟）、旧大猫周奖励（10 分钟，已停用）、
  占格月奖励（10 分钟检查，按月幂等）、野猫（10 分钟检查，按 2 小时节奏）、
  猫咪路径计划（5 秒）、启动初始化，各自最近运行/成功时间、次数、失败数、最近错误或摘要。
- **待处理**：审批、喵喵、AI 审核的 pending 数（带跳转）。
- **数据量**：核心 `oi33_*` 集合的文档数（大集合用 `estimatedDocumentCount`）。
- **运维动作**：可重复执行的安全修复按钮（见下）。
- **本次进程最近操作**：谁在什么时候执行了什么、成功还是失败（内存记录，重启清空）。

## 运维动作

| id | 做什么 | 幂等 | 权限 |
| --- | --- | --- | --- |
| `recount_territories` | 按格子归属重算大猫 `territoryCount` | 是 | flag≥2 |
| `calibrate_market` | 按账本重算罐头市场流通/供应/储备 | 是 | flag≥2 |
| `rebuild_indexes` | 补齐所有 `oi33_*` 索引 | 是 | flag≥2 |
| `evaluate_medals` | 重跑全部用户的 OJ 成就评估（只升不降） | 是（慢） | flag≥2 |
| `migrate_judge_monitor` | 旧 `system` 配置搬入 `oi33_judge_monitor` | 是 | flag≥2 |
| `purge_unverified_cat_assets` | 清理未实名用户的地图/猫粮/罐头/贡献 | 是 | flag≥3 |

每个动作成功后写一条 `oi33_log`（`type:'admin'`、`action:'ops_<id>'`），失败只记录到
进程内状态并回显错误，不会中断页面。

## 怎么加一个新的运维动作

1. 在 `handler/ops.ts` 的 `ACTIONS` 里加一项：`label`、`description`、`minFlag`、
   `run(operator)`；`run` 只调用 model 里**已有**的公开函数，不要在这里写业务逻辑。
2. 返回值是一句给管理员看的结果摘要（会进页面和审计日志）。
3. 如果动作慢（>2s），在描述里注明，并考虑改成后台任务。
4. 跑 `npm run check`（结构检查会验证路由、模板与页面标题）。

## 约定

- `model/ops-status.ts` 是**进程内**状态，刻意不落库：它描述“这个进程”，重启即重置。
  多实例部署时每个实例各有一份；页面显示的是当前实例。
- 运维动作必须幂等、可重跑；破坏性操作（如结算/回滚周奖励）不放在这里，仍走各自的
  业务页面（例如 `/oi33/admin/school-cat-rewards`）。
- 新增定时任务时，用 `markTaskStart/Success/Error` 包住，页面才能看到它的健康状态。
