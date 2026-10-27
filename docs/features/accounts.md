# 账号、身份与杂项功能

> 代码：`model/user.ts`、`model/{oauth,token,paste,request}.ts`、`handler/{user,oauth,token,profile,content}.ts`、
> `model/judge-monitor.ts` + `-rules.ts`、`handler/judge-monitor.ts`。

## 主档 `oi33_user`

一人一档（`_id = uid`），字段包括：

- 签到：`checkin_time`、`checkin_luck`、`checkin_cnt_now/all`
- 经济：`cat_food`、`cat_can`、`blindbox_day/blindbox_count`
- 身份：`realname_flag`、`realname_name`
- 资料：`birthday_date`、`badge`、`atcoder*`、`codeforces*`
- 算法：`algorithm_self_month`、`algorithm_self_at`
- 展示墙：`medal_showcase`

`realname_flag`：0 未认证 / 1 已认证 / 2 管理员 / 3 行政管理员。未认证用户全站匿名成
`UID n`（`mergeOi33Fields` + `anonymizeOi33Identity`），禁止签到、地图、喂猫、交易、
发喵喵、收猫粮、自动奖章。**例外**：Hydro 虚拟用户（`vuser`，负数 uid）不算未认证，
不匿名化，置 `oi33_virtual`。

## 资料页与徽章

- 资料页 `user_detail.html`：简介 / 奖章展示墙 / 学习记录（默认折叠）/ 注册信息（管理员）；
  侧栏 `partials/oi33_profile.html` 的 `userCard` 内含快捷跳转。
- 生日 `/oi33/birthday`、徽章 `/oi33/badge`、`/oi33/badge/manage`（flag≥2）。
- 硬币账单 `/oi33/coin/bill/:uid`（uid=0 为全部），管理员看实名+昵称，其他人只看昵称。

## 申请与认证

`/oi33/requests`：生日/实名/徽章/AtCoder/Codeforces 的申请单；flag≥2 审批；
状态 `pending/approved/rejected/cancelled`，存在 `oi33_request`。

## OAuth2 与 API Token

- **OAuth2**：`oi33_oauth_client/code/token/refresh`；授权码 10 分钟一次性；
  `client_secret` 仅创建时显示；PKCE 支持；`/oi33/oauth/{authorize,token,userinfo,revoke}`。
- **只读 Token**：`33tok_` 前缀，Bearer 鉴权，所有写请求在 `handler/create` 阶段被拒；
  用于 MCP/Agent，文档见 [API.md](../../API.md)。跳过 `/oi33/oauth/*`。
- 页面：`/oi33/oauth/clients`、`/oi33/tokens`。

## Paste / Wiki

- Paste：`oi33_paste`，`/oi33/paste/*`；未认证不能新建/编辑。
- Wiki：见 [community.md](community.md)。

## 评测机监控

- 单文档 `oi33_judge_monitor`（`_id:'main'`）：配置 + 在线状态 + 通知去重。
- 纯规则 `judge-monitor-rules.ts`（可单测）：归一化、在线差集、通知状态机。
- 页面 `/oi33/judge-monitor`；后台每 30 分钟检查一次，掉线/恢复/数量变化私信管理员。
- 旧版写在 core `system` 里的 9 个 key 由迁移 Step 18 搬入（幂等 `$setOnInsert`）。
