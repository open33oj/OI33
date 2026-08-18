# OI33 — 33OJ 统一插件

> ⚠️ **使用前必读**
>
> 本插件对 HydroOJ 做了大量魔改（monkey-patch、模板覆盖、自定义集合、统一审批流、Bearer Token 认证拦截等），其中**多处设计涉及敏感信息的读取与访问控制**。请务必完整阅读本 README 及 [API.md](API.md)，理解每一项功能的权限模型和安全边界后再部署使用。
>
> 强烈建议在熟悉 Hydro 源码的开发者或 AI 助手的协助下进行二次修改与适配，切勿直接复制到生产环境。

整合了 8 个独立 Hydro 插件：硬币、生日、徽章、实名、签到、倒计时、剪贴板、前端覆盖。

## 功能

| 功能 | 说明 | 路由 |
|------|------|------|
| 硬币 | 余额排行、发放/扣除、交易流水 | `/oi33/coin/*` |
| 生日 | 设置生日、今日寿星展示（含动画）、全部生日列表 | `/oi33/birthday/*` |
| 徽章 | 创建/编辑/删除徽章 | `/oi33/badge/*` |
| 实名 | 身份标签 4 级（未认证/已认证/管理员/行政管理员），认证信息展示 | `/oi33/realname/*` |
| 签到 | 每日打卡+运势、连续签到统计；签到奖励猫粮（仅已认证用户可签到） | `/oi33/checkin` |
| 猫粮与罐头账户 | 签到奖励、管理员增减猫粮/罐头、每周大猫奖励、罐头交易、统一账本与 7 天余额曲线 | `/oi33/cat-account/:uid` |
| 猫罐头市场 | 储备池动态定价、每日买卖、永久持有与简洁交易界面 | `/oi33/cat-can` |
| 猫猫广场 | 1000×1000 实时网格世界，保留旧 640×480 画作；小猫移动、普通/领地传送与 8-bit 公共像素涂色 | `/oi33/arena` |
| 大猫世界 | 每所学校一只大猫：绑校、直接投喂与移动投喂，按每格绘图时的用户绑定归属领地；独立领地色、领地榜与当前/历史投喂双榜 | `/oi33/arena` |
| 倒计时 | 首页倒计时组件（配置驱动） | 首页 partial |
| 剪贴板 | Markdown 剪贴板 CRUD、公有/私有（已认证才能发布公开粘贴） | `/oi33/paste/*` |
| 前端覆盖 | Logo、favicon、模板覆盖 | 静态资源 |
| 洛谷难度徽章 | 题目页/题目列表/训练计划按洛谷 0-8 体系展示彩色难度徽章；默认遮挡为灰色「显示难度」，点击纯前端切换显隐 | 题目页/列表 |
| 管理仪表盘 | 统一查看所有数据 + 操作日志 | `/oi33/admin` |
| 数据迁移 | 从老插件迁移数据到新集合 | `/oi33/migrate` |
| Wiki 百科 | 分类目录、Markdown 页面 CRUD、JSON 批量导入/导出（仅管理员可编辑） | `/oi33/wiki/*` |
| AT/CF 用户名 | 设置 AtCoder / Codeforces 用户名（走审批流程），rating 字段由后台脚本自动更新 | `/oi33/profile/edit/:uid` |
| AT/CF Rating 排名 | 公开展示已绑定 AT/CF 用户的信息及 rating，支持按任意 rating 排序 | `/oi33/at-cf-rating` |
| 统一资料审批 | 生日、实名、徽章、AT/CF 用户名 均走提交→审批流；未认证用户只能提交认证申请 | `/oi33/requests` |
| MCP / Agent API 令牌 | 供外部 MCP 工具或 AI Agent 调用的只读 Bearer Token，可限定域和过期时间 | `/oi33/tokens` |
| OAuth2 登录 | 33OJ 作为 OAuth2 身份提供方，让其他网站实现「使用 33OJ 登录」 | `/oi33/oauth/*` |
| 评测机监控 | 每 5 分钟检查心跳，离线/恢复时通过企业微信 Webhook 推送通知 | `/oi33/judge-monitor` |
| AI 代码分析 | DeepSeek 思考模型流式点评提交代码，学生引导/教师诊断双 prompt，精简题意缓存，按 token 计费 | `/oi33/ai/*` |
| AI 讨论审核 | 讨论区仅实名用户可用；规则层 + AI 双层审核（结构化裁决、fail-closed），存疑进人工队列 | `/oi33/ai/moderation` |
| 个人简介审核 | 已认证用户简介展示在个人页首个标签；每次修改（2 小时冷却）自动 AI 审核，失败隐藏并私信通知，存疑进人工队列 | `/oi33/ai/bio-review` |
| 喵喵时间线 | 犇犇式短博客：仅实名用户可发，每天首条免费、后续每条 1 猫罐头，上一条后 2 小时冷却；单向关注/粉丝、点赞、纯文字转发、AI+人工审核，首页模块 | `/oi33/meow/*` |
| 成就系统 | 8/16/24/32 像素 PNG；支持通过题数、连续/累计登录、猫粮/罐头余额五类阈值自动发放；AC 统计域可全局配置并按题号跨域去重；个人页提供 4×4 成就展示柜（用户自选最多 16 个徽章，可自由排序）和紧凑成就列表面板（最多 50 条，可跳全部成就页）；实时达成和手动授予时自动发布个人喵喵 | `/oi33/achievements` |
| 成就拍卖 | 管理员上架成就拍卖（时长 1–720 小时 + 起拍价），有效出价至少保留 1 分钟竞价时间；出价托管扣款、被超越自动退款、成交后赢家获得成就且罐头回流罐头池 | `/oi33/auction` |
| 成就交易合同 | 标记为「可售卖」的成就被拍卖或合同交易获得后，可挂给指定用户按约定猫粮数量转售；对方接受即成交（成就转让、猫粮转账） | `/oi33/contracts` |
| 权限速查表 | 按角色列出各功能权限矩阵 | `/oi33/permissions` |
| 邮箱黑名单 | 屏蔽指定邮箱域名注册（含 OAuth 首次登录）与换绑邮箱，基于 Hydro 内核自带的黑名单检查 | `/oi33/admin/mail-blacklist` |
| 未认证资产清理 | 一键销毁未认证用户的猫粮（记管理员扣除）、罐头回流储备池、小猫移出猫猫广场、清空大猫贡献（含历史投喂记录） | `/oi33/admin` |

## 数据库

新插件使用 `oi33_*` 前缀的集合，与 Hydro 核心的 `user` 集合解耦：

| 集合 | 用途 |
|------|------|
| `oi33_user` | 用户属性：硬币余额、生日、徽章、实名、签到数据、猫粮余额、AT/CF 用户名及 rating、成就展示柜（`achievement_showcase`） |
| `oi33_coin_bill` | 硬币交易流水 |
| `oi33_paste` | 剪贴板文档 |
| `oi33_wiki` | Wiki 百科页面（含 `index` 页作为首页公告） |
| `oi33_wiki_category` | Wiki 分类目录（默认：算法、公告） |
| `oi33_request` | 资料修改审批（生日、实名、徽章、AT/CF 用户名） |
| `oi33_token` | MCP / Agent API 令牌（SHA-256 哈希存储，只读） |
| `oi33_oauth_client` | OAuth2 客户端应用注册（client_id、secret hash、回调 URI、是否公开客户端） |
| `oi33_oauth_code` | OAuth2 授权码（10 分钟有效，一次性） |
| `oi33_oauth_token` | OAuth2 访问令牌（`33oat_` 前缀，SHA-256 哈希存储） |
| `oi33_oauth_refresh` | OAuth2 刷新令牌（`33ojrt_` 前缀） |
| `oi33_log` | 操作日志（硬币、生日、徽章、实名、签到、猫粮、猫咪地图、剪贴板、Wiki、审批、OAuth） |
| `oi33_cat_can_bill` | 买入、卖出和撤销明细（含交易本金、手续费及两种余额变化） |
| `oi33_cat_can_pool` | 真实储备、虚拟供应量、累计手续费及按账本增量维护的全站余额计数器 |
| `oi33_cat_can_price` | 每 8 小时保存一次的精简买入/卖出价格历史 |
| `oi33_cat_food_batch_preview` | 行政管理员批量发放猫粮的 30 分钟预览（确认一次后失效） |
| `oi33_cat_map_player` | 已认证用户的小猫坐标、移动冷却、免冷却染色额度和并发移动锁 |
| `oi33_cat_map_cell` | 公共地图中已设置的持久化 8-bit 颜色、最后绘图者与绘图时的大猫归属（`catId=0` 表示无大猫） |
| `oi33_school_cat` | 已出现的学校大猫：当前/历史重量、不重复的领地颜色、占领格数、管理员大猫标记 |
| `oi33_school_feed_history` | 改绑时归档的用户投喂历史（`uid` + `schoolId` + `amount`） |
| `oi33_school_cat_reward` | 每周大猫奖励的逐版本不可变快照、用户分配计划、回滚记录与幂等结算状态 |
| `oi33_ai_access` | AI 分析白名单：发放额度、是否不限（教师不受限） |
| `oi33_ai_analysis` | 已保存的 AI 分析结果（按提交 rid 一份，学生侧锁定） |
| `oi33_ai_config` | AI 全局配置：各角色默认模型、prompt 覆盖、思考强度 |
| `oi33_ai_problem_summary` | 题目精简题意缓存（首次分析时后台生成） |
| `oi33_ai_provider` | AI 提供商（Base URL、API Key）及各模型 token 单价 |
| `oi33_ai_usage` | AI 用量流水（分析与精简题意，含 token 数、缓存命中、费用） |
| `oi33_ai_moderation` | 讨论审核记录：内容 hash、裁决、来源、待人工队列（含回放所需的原始参数） |
| `oi33_meow_post` | 喵喵信息：内容（纯文字，≤256 字）、审核状态、点赞数、转发路径文本、AI 裁决字段 |
| `oi33_meow_follow` | 单向关注关系（`follower` → `following`，唯一索引） |
| `oi33_meow_like` | 点赞记录（`uid` + `postId` 唯一索引） |
| `oi33_achievement` | 成就定义：名称、描述、规则类型、阈值、PNG 像素图原始尺寸与排序 |
| `oi33_user_achievement` | 用户已获成就（`uid` + `achievementId` 唯一）及自动公告喵喵引用 |
| `oi33_auction` | 成就拍卖：起拍价、设定/实际结束时间、最后出价时间、状态、最高价/领先者、赢家与成交价 |
| `oi33_auction_bid` | 拍卖出价记录（`auctionId` + `uid` + `amount`） |
| `oi33_achievement_contract` | 成就交易合同：卖家、买家、猫粮价格、状态（待处理/已成交/已拒绝/已取消） |

## 权限配置

| 路由 | 所需权限 | 说明 |
|------|---------|------|
| `/oi33/wiki` | 公开 | Wiki 首页（分类浏览 + 公告） |
| `/oi33/wiki/:id` | 公开 | 查看 Wiki 页面 |
| `/oi33/wiki/export` | 公开 | 批量导出 Wiki 为 JSON |
| `/oi33/wiki/:id/export` | 公开 | 导出单页 Wiki 为 JSON |
| `/oi33/birthday` | 公开 | 查看今日生日 |
| `/oi33/paste/show/:id` | 公开 | 查看公开剪贴板 |
| `/oi33/at-cf-rating` | 公开 | AT/CF Rating 排名 |
| `/oi33/cat-can` | `PRIV_USER_PROFILE` | 猫罐头市场与简洁买卖界面 |
| `/oi33/arena` | 公开 | 1000×1000 猫猫广场（旧画作原位保留） |
| `/oi33/arena/join` | `PRIV_USER_PROFILE` + 已认证 | 首次免费选择位置加入广场（POST） |
| `/oi33/arena/move` | `PRIV_USER_PROFILE` + 已认证 | 相邻移动 3g；同一当前大猫领地内任意传送 3g；其他传送 3 罐头；猫粮费用同时计入当前大猫贡献（POST） |
| `/oi33/arena/color` | `PRIV_USER_PROFILE` + 已认证 | 设置当前格的 8-bit 颜色并记录绘图时的大猫归属（POST） |
| `/oi33/arena/big/schools` | `PRIV_USER_PROFILE` + 已认证 | 大猫学校列表 / 搜索 |
| `/oi33/arena/big/bind` | `PRIV_USER_PROFILE` + 已认证 | 绑定 / 改绑学校大猫（POST，首次免费，之后每自然月一次） |
| `/oi33/arena/big/unbind` | `PRIV_USER_PROFILE` + 已认证 | 取消当前大猫绑定；贡献转入历史且既有绘图归属不变（POST，计入每月一次修改额度） |
| `/oi33/arena/big/feed` | `PRIV_USER_PROFILE` + 已认证 | 烧猫粮投喂大猫（POST，2 小时冷却） |
| `/oi33/arena/big/cat/:schoolId` | 公开 | 大猫详情与当前/历史投喂榜 |
| `/oi33/arena/big/cat/:schoolId/color` | `PRIV_USER_PROFILE` + 已认证（仅当前投喂榜首） | 修改当前绑定大猫的唯一领地颜色（POST） |
| `/oi33/arena/big/ranking` | 公开 | 完整大猫领地榜；只列当前有体重或格子的大猫，按格子数排序 |
| `/oi33/arena/big/ranking/:schoolId/admin` | OI33 身份 = 3 | 设置或取消管理员大猫；管理员大猫以 ★ 展示且不占数字名次（POST） |
| `/oi33/arena/big/ranking/backfill-moves` | OI33 身份 = 3 | 将尚未计入的历史猫粮移动按用户当前绑定回算为大猫贡献（POST） |
| `/oi33/arena/big/ranking/weekly-reward` | OI33 身份 = 3 | 幂等触发/恢复本周大猫罐头奖励结算（POST；系统也会自动执行） |
| `/oi33/admin/school-cat-rewards` | OI33 身份 = 3 | 查看每周结算批次、领地/用户分配快照、回滚条件与旧版本记录 |
| `/oi33/admin/school-cat-rewards/:period/settle` | OI33 身份 = 3 | 结算、重试，或在回滚后按当前数据生成新版本并重新结算（POST） |
| `/oi33/admin/school-cat-rewards/:period/rollback` | OI33 身份 = 3 | 按原始账户日志幂等扣回奖励并修正市场供应（POST，余额不足时拒绝） |
| `/oi33/cat-arena/admin` | OI33 身份 = 3 | 按（行,列）进行矩形绘图 |
| `/oi33/cat-arena/admin/relocate` | OI33 身份 = 3 | 按 UID 将小猫强制迁移到随机位置（POST） |
| `/oi33/cat-arena/admin/refresh-territories` | OI33 身份 = 3 | 将所有有色格子归属刷新为最后绘图者当前绑定的大猫（POST） |
| `/oi33/cat-can/buy` | `PRIV_USER_PROFILE` | 买入猫罐头（POST） |
| `/oi33/cat-can/sell` | `PRIV_USER_PROFILE` | 卖出猫罐头（POST） |
| `/oi33/cat-account/:uid` | `PRIV_USER_PROFILE` | 猫粮与罐头统一账本及最近 7 天余额曲线；查看他人需 OI33 身份 ≥ 2 |
| `/oi33/cat-food/grant` | OI33 身份 ≥ 2 | 给其他用户单人发放猫粮（未认证用户会被拒绝） |
| `/oi33/cat-can/grant` | OI33 身份 ≥ 2 | 手动发放或扣除用户猫罐头；正数发放、负数扣除（POST） |
| `/oi33/cat-food/grant/bulk` | OI33 身份 = 3 | 粘贴 JSON、预览批量发放名单（未认证用户自动列入跳过名单） |
| `/oi33/cat-food/grant/bulk/confirm` | OI33 身份 = 3 | 确认一次性批量发放（POST；确认时再次跳过未认证用户） |
| `/oi33/cat-account/transaction/:id/reverse` | OI33 身份 ≥ 2 | 撤销单笔罐头买入/卖出交易（POST） |
| `/oi33/rating` | 公开 | Rating （旧路由，已弃用） |
| `/oi33/wiki/create` | `PRIV_USER_PROFILE`（且 `realname_flag === 3`） | 创建 Wiki 页面 |
| `/oi33/wiki/:id/edit` | `PRIV_USER_PROFILE`（且 `realname_flag === 3`） | 编辑 Wiki 页面 |
| `/oi33/checkin` | `PRIV_USER_PROFILE` + 已认证 | 每日签到（未认证用户不能签到） |
| `/oi33/cat-food/bill/:uid` | `PRIV_USER_PROFILE` | 旧入口，重定向到猫粮与罐头统一账本 |
| `/oi33/coin/show` | `PRIV_USER_PROFILE` | 查看硬币排行 |
| `/oi33/coin/bill/:uid` | `PRIV_USER_PROFILE` | 查看自己账单（查看他人需 OI33 身份 ≥ 2） |
| `/oi33/birthday/all` | `PRIV_USER_PROFILE` | 查看所有用户生日 |
| `/oi33/badge` | `PRIV_USER_PROFILE` | 查看徽章 |
| `/oi33/paste/create` | `PRIV_USER_PROFILE`（公开粘贴需 `realname_flag >= 1`） | 创建剪贴板 |
| `/oi33/paste/manage` | `PRIV_USER_PROFILE` | 管理自己的剪贴板 |
| `/oi33/paste/show/:id/edit` | `PRIV_USER_PROFILE` | 编辑自己剪贴板（编辑他人需 OI33 身份 ≥ 2） |
| `/oi33/paste/show/:id/delete` | `PRIV_USER_PROFILE` | 删除自己剪贴板（删除他人需 OI33 身份 ≥ 2） |
| `/oi33/profile/edit/:uid` | `PRIV_USER_PROFILE`（自己）/ OI33 管理员或行政管理员（他人） | 统一资料编辑；管理员不能修改其他管理员/行政管理员的认证身份 |
| `/oi33/tokens` | `PRIV_USER_PROFILE`（管理员可查看全部） | 查看自己的令牌 |
| `/oi33/wiki/import` | OI33 身份 ≥ 2 | Wiki 导入页面 |
| `/oi33/wiki/import/submit` | OI33 身份 ≥ 2 | 执行 Wiki JSON 导入 |
| `/oi33/wiki/categories` | OI33 身份 ≥ 2 | 管理 Wiki 分类 |
| `/oi33/wiki/:id/delete` | OI33 身份 ≥ 2 | 删除 Wiki 页面 |
| `/oi33/judge-monitor` | OI33 身份 ≥ 2 | 评测机监控面板 |
| `/oi33/ai/analyze/:rid` | `PRIV_USER_PROFILE` + 已开通额度（教师不限） | AI 分析页面（仅本人提交；教师可分析任何人，含比赛提交） |
| `/oi33/ai/analyze-stream/:rid` | 同上 | AI 流式分析（WebSocket，最多 3 并发，超出排队） |
| `/oi33/ai/can-analyze`、`/oi33/ai/balance`、`/oi33/ai/analysis/:rid` | `PRIV_USER_PROFILE` | 查询分析权限、余额与已保存分析 |
| `/oi33/ai/analysis/:rid/delete` | OI33 身份 ≥ 2 | 清除已保存分析（解锁学生重新分析） |
| `/oi33/ai/admin` | OI33 身份 ≥ 2 | AI 用量与费用统计 |
| `/oi33/ai/access` | OI33 身份 ≥ 2 | AI 白名单与额度管理 |
| `/oi33/ai/models` | OI33 身份 ≥ 2 | Provider / 模型价格 / 默认模型 / prompt / 思考强度配置 |
| `/oi33/ai/summary` | OI33 身份 ≥ 2 | 精简题意查看与重新生成 |
| `/oi33/ai/moderation` | OI33 身份 ≥ 2 | 讨论/简介审核队列（人工通过/拒绝）与审核设置（模型、prompt、违禁词、预算、限流） |
| `/oi33/ai/bio-review` | OI33 身份 ≥ 2 | 个人简介批量审查：对所有简介非空用户跑一次 AI 审核（幂等，可重跑） |
| `/oi33/meow` | `PRIV_USER_PROFILE`（已认证） | 喵喵时间线（自己 + 关注 + 管理员的信息） |
| `/oi33/meow/post` | `PRIV_USER_PROFILE` + 已认证 | 发布喵喵（每日首条免费，后续 1 猫罐头；上一条后 2 小时冷却）（POST） |
| `/oi33/meow/user/:uid` | `PRIV_USER_PROFILE` | 查看某用户的喵喵（本人见全部含状态，粉丝/管理员见已通过） |
| `/oi33/meow/follow/:uid`、`/oi33/meow/unfollow/:uid` | `PRIV_USER_PROFILE` | 关注 / 取消关注（POST） |
| `/oi33/meow/like/:postId` | `PRIV_USER_PROFILE` | 点赞 / 取消点赞（POST，前端 AJAX 保持停留在原页面） |
| `/oi33/meow/following`、`/oi33/meow/followers` | `PRIV_USER_PROFILE` | 关注列表 / 粉丝列表（可带 `?uid=` 查看他人） |
| `/oi33/meow/admin` | OI33 身份 ≥ 2 | 喵喵审核（今日统计 / 待审队列 / 全部喵喵列表，可按状态筛选、分页） |
| `/oi33/meow/admin/:postId/delete` | OI33 身份 ≥ 2 | 删除喵喵（POST；管理员在信息卡上看到删除按钮） |
| `/oi33/achievements` | OI33 身份 ≥ 2 | 成就定义、自动指标、像素图、手动授予与撤销管理 |
| `/oi33/achievements/save` | OI33 身份 ≥ 2 | 创建/修改成就定义（POST，PNG 原始尺寸仅 8/16/24/32） |
| `/oi33/achievements/config` | OI33 身份 ≥ 2 | 保存 AC 统计域全局配置（POST；留空为全部域，不同域按题目 `sort` 跨域去重） |
| `/oi33/achievements/grant`、`/oi33/achievements/revoke` | OI33 身份 ≥ 2 | 授予/撤销用户成就（POST） |
| `/oi33/achievements/scan` | OI33 身份 ≥ 2 | 逐用户扫描并补发自动成就；猫粮读取账户明细历史峰值，扫描补发不发布喵喵（POST） |
| `/oi33/achievements/showcase` | `PRIV_USER_PROFILE` + 已认证 | 编辑自己的成就展示柜（最多 16 个徽章，GET/POST） |
| `/oi33/achievements/user/:uid` | 公开 | 查看某用户的全部成就列表 |
| `/oi33/auction` | 公开 | 成就拍卖列表（管理员在此上架，时长 1–720 小时 + 起拍价） |
| `/oi33/auction/:id` | 公开 | 拍卖详情与出价记录 |
| `/oi33/auction/:id/bid` | `PRIV_USER_PROFILE` + 已认证 | 出价（POST，每次至少加 1 罐头，有效出价后至少留 1 分钟） |
| `/oi33/auction/create`、`/oi33/auction/:id/cancel` | OI33 身份 ≥ 2 | 上架 / 取消拍卖（POST，取消退还当前最高出价） |
| `/oi33/contracts` | `PRIV_USER_PROFILE` | 我的成就交易合同（待接受 / 我发起的 / 已结束） |
| `/oi33/contracts/create` | `PRIV_USER_PROFILE` + 已认证 | 创建合同：选择可转售成就 + 买家 UID + 猫粮价格（POST） |
| `/oi33/contracts/:id/accept`、`/oi33/contracts/:id/decline` | `PRIV_USER_PROFILE`（接受需已认证；仅合同指定买家） | 接受 / 拒绝合同（POST） |
| `/oi33/contracts/:id/cancel` | `PRIV_USER_PROFILE`（仅卖家） | 取消待处理合同（POST） |

迁移页的“导入初始成就”按钮使用插件内置的十二档像素图，空库即可幂等导入
通过题目、连续/累计登录、猫粮和猫罐头五组共 60 项定义。
该动作不会扫描用户或发布成就喵喵。
| `/oi33/permissions` | OI33 身份 ≥ 2 | 权限速查表 |
| `/oi33/coin/inc` | OI33 身份 ≥ 2 | 发放硬币 |
| `/oi33/badge/manage` | OI33 身份 ≥ 2 | 管理徽章 |
| `/oi33/badge/manage/:uid/del` | OI33 身份 ≥ 2 | 删除徽章 |
| `/oi33/paste/all` | OI33 身份 ≥ 2 | 查看所有剪贴板 |
| `/oi33/admin` | OI33 身份 ≥ 2 | 管理仪表盘 |
| `/oi33/admin/cat-assets/purge` | OI33 身份 = 3 | 清理未认证用户猫资产（POST，不可撤销） |
| `/oi33/admin/mail-blacklist` | OI33 身份 ≥ 2 | 邮箱黑名单列表与添加（GET/POST） |
| `/oi33/admin/mail-blacklist/:domain/delete` | OI33 身份 ≥ 2 | 解除邮箱域名屏蔽（POST） |
| `/oi33/migrate` | OI33 身份 ≥ 2 | 执行数据迁移 |
| `/oi33/users` | OI33 身份 ≥ 2 | 查看全部用户数据 + 身份筛选 |
| `/oi33/requests` | 已登录且身份为管理员/行政管理员 | 审批列表；管理员可批准 0-1，行政管理员可批准 0-2 |
| `/oi33/tokens/create` | `PRIV_ALL` | 创建 MCP / Agent API 令牌 |
| `/oi33/tokens/:id/delete` | `PRIV_ALL` | 删除令牌 |
| `/oi33/oauth/authorize` | `PRIV_USER_PROFILE` | OAuth2 授权页面（用户同意/拒绝） |
| `/oi33/oauth/token` | 公开（客户端凭据认证） | OAuth2 换取/刷新访问令牌 |
| `/oi33/oauth/userinfo` | 公开（Bearer 令牌认证） | OAuth2 获取用户信息 |
| `/oi33/oauth/revoke` | 公开 | OAuth2 吊销令牌 |
| `/oi33/oauth/clients` | OI33 身份 ≥ 2 | OAuth2 应用管理列表 |
| `/oi33/oauth/clients/create` | OI33 身份 ≥ 2 | 注册新 OAuth2 应用 |
| `/oi33/oauth/clients/:id` | OI33 身份 ≥ 2 | 查看应用详情 + 接入指南 |
| `/oi33/oauth/clients/:id/delete` | OI33 身份 ≥ 2 | 删除 OAuth2 应用（吊销其所有令牌） |
| `/record` | 导航默认跳转 `?uidOrName=自己`（登录用户） | 评测记录页（覆盖模板） |

Hydro `PRIV_ALL` 超级管理员拥有 OI33 身份引导权限：即使当前尚未取得 OI33 管理身份，也可以在资料编辑页直接将自己或其他用户设为行政管理员。

## 安装与迁移

```bash
# 0. 进入插件目录安装依赖
cd /path/to/oi33
yarn

# 1. 安装插件
hydrooj addon add /path/to/oi33
pm2 restart hydrooj

# 2. 管理员访问 /oi33/migrate 执行数据迁移（幂等，可重复执行）
#    迁移来源：
#    - coin 集合 → oi33_coin_bill
#    - paste 集合 → oi33_paste
#    - birthday 集合 → oi33_user
#    - user 集合字段 (coin_*, badge, realname_*, checkin_*) → oi33_user
#    - 按历史 checkin_cnt_all * 100 一次性补发猫粮；上线当天已连续签到者再补 50

# 3. 确认迁移数据正确后，移除老插件
hydrooj addon remove coin-33oj
hydrooj addon remove birthday-33oj
hydrooj addon remove badge-33oj
hydrooj addon remove realname-33oj
hydrooj addon remove checkin-33oj
hydrooj addon remove countdown-33oj
hydrooj addon remove pastebin-33oj
hydrooj addon remove frontend-33oj

# 4. 清理老数据（可选）
#    db.birthday.drop()
#    db.coin.drop()
#    db.paste.drop()
#    db.user.updateMany({}, { $unset: { coin_now:"", coin_all:"", badge:"", realname_flag:"", realname_name:"", checkin_time:"", checkin_luck:"", checkin_cnt_now:"", checkin_cnt_all:"" } })
```

## 猫粮规则

- **未认证用户（`realname_flag < 1`）无法以任何方式获取猫粮**：不能签到；管理员单人发放会被拒绝；批量发放在预览和确认两个环节都会自动跳过未认证用户；上线一次性补发也只标记不发放。
- **猫粮与罐头只统计已认证用户参与市场定价**：储备池的全站余额计数（`userFoodTotal` / `circulatingCans`）不含未认证用户；管理仪表盘的「清理未认证猫资产」按钮（仅行政管理员，不可撤销）可一键清理历史遗留：销毁未认证用户的猫粮（逐用户记管理员扣除日志）、猫罐头回流储备池、小猫移出猫猫广场，并清空其对大猫的贡献（当前贡献直接减重不转历史，历史投喂记录一并删除并扣减对应大猫的历史重量）。已认证用户被降级不会自动清理，需要时再次执行该按钮即可。
- 管理员扣除猫粮时**允许余额变为负数**（例如追回误发的猫粮），后续签到、发放等获得的猫粮会自然抵消负债逐渐回正；消耗猫粮的功能（买罐头、小猫移动、投喂大猫等）仍要求余额充足。
- 功能上线后立即生效：普通签到奖励 100 猫粮；若承接前一天的连续签到，则奖励 150 猫粮。
- 上线时按已有累计签到天数 `checkin_cnt_all * 100` 一次性补发；若上线当天已经连续签到，再额外补发 50。补发带版本标记，并按应得余额补差，不会重复执行。
- 猫粮余额显示在用户详情页的小猫组件下方；签到成功后会显示“签到成功，猫粮+X”。
- 猫粮余额旁提供明细入口，可查看历史补发和每次签到奖励记录。

## 猫罐头市场

- 市场使用有真实猫粮储备的自动定价池。买入本金全部进入储备池，卖出本金只能从储备池支出，因此交易本身不会增发猫粮；手续费不进入储备池，直接从流通中销毁。
- 每天 00:00、08:00、16:00（Asia/Shanghai）根据全站已认证用户的猫粮、有效罐头、真实储备和虚拟可用罐头重新计算卖出目标价。目标价不会高于“储备 ÷ 流通罐头”的全额兑付上限，每个 8 小时时段最多变动 3%。
- 猫罐头交易全天开放。买入单价为 `ceil(卖出单价 × 105%)`。买入和卖出都额外收取 `ceil(交易本金 × 25 / 100000)` 猫粮手续费，即万分之 2.5。
- 每次交易最少 1 个，所有正整数数量都允许。买入和卖出共用 2 小时冷却，提交前会二次确认并显示下次允许交易时间；市场页持续显示冷却倒计时。
- 猫罐头不设保质期，不会自动过期或销毁；`oi33_user.cat_can` 是唯一库存余额，买入、卖出、传送和撤销都直接对总余额记账。
- 每个 8 小时价格快照仍会保存到 `oi33_cat_can_price`，用于后台定价与审计，但不在普通市场页面展示内部机制。
- 市场页面展示买入价格、卖出价格、当前罐头和猫粮余额。买入数量变化时，页面直接提示包含手续费的最终总价。
- 猫粮与罐头共用一个账户明细页：签到、历史补发、管理员发放、罐头买卖和交易撤销按时间合并显示，并用双轴双折线展示最近 7 个自然日的两种余额。
- 管理员可给其他用户单人增减猫粮或猫罐头（罐头正数发放、负数扣除，扣除后不能为负）；行政管理员可粘贴 `[{"uid":123,"amount":500,"reason":"奖励"}]` 格式的 JSON，先生成 30 分钟有效预览，再确认一次性批量发放猫粮。手动新增罐头会同步增加虚拟总供应与流通量（增发）；扣除则同时减少虚拟总供应与流通量（销毁，不回市场池）。
- 经济面板的「系统增发」统计管理员发放与每周大猫奖励（新增），「系统销毁」统计管理员扣除与每周大猫奖励回滚（销毁），「其他回池」只统计传送、喵喵与拍卖结算。行政管理员可在市场页点击「校准经济指标」，按账本重放全部增发/销毁记录并重算流通、供应、储备与手续费计数器，修正历史漂移；该操作幂等且可重复执行。
- 管理员可以撤销一次尚未撤销的罐头买入或卖出。撤销采用反向记账并保留原记录、撤销人和原因；为完整追回被盗交易，罐头余额允许暂时变为负数。
- 猫粮以 `g` 为基本单位；达到 `1000 g` 后显示为保留两位小数的 `kg`，达到 `1000000 g` 后显示为保留两位小数的 `t`，悬停可查看精确的 `g` 数值。
- 全站猫粮和罐头总量只在储备池首次升级时汇总一次，之后由签到、发放、交易和撤销的账本增量维护；普通市场访问和交易不会扫描全站用户。每 8 小时价格历史只保存价格与时间。
- 旧版本的 `oi33_cat_can_batch` 集合不再参与任何库存判断或写入；访问并执行 `/oi33/migrate` 会预览记录数并幂等清除该遗留集合。

## 成就拍卖

- 管理员（OI33 身份 ≥ 2）在 `/oi33/auction` 上架某个成就的拍卖，填写拍卖时长（1–720 小时）和起拍价（≥ 1 个猫罐头）；同一成就同时只能有一个进行中的拍卖。
- 已认证用户可出价：首个出价达到起拍价即可，之后每次出价至少比当前最高价多 1 个罐头。出价立即托管扣除罐头；被更高出价超越时自动全额退款。已拥有该成就的用户和当前领先者不能出价。
- 实际结束时间始终为 `max(管理员设定时间, 最后一次有效出价时间 + 1 分钟)`。更新出价与延长截止时间在同一次原子写入中完成，结算也会重新校验实际截止时间。
- 到期后惰性结算（有人访问拍卖列表/详情或出价时触发）：赢家直接获得成就（照常发布成就喵喵公告），其支付的罐头回流罐头池（不返还猫粮）；无人出价则流拍。管理员可取消进行中的拍卖并退还当前最高出价。
- 删除成就定义时会先自动取消其所有进行中的拍卖（照常退还当前最高出价），不会出现指向已删除成就的活跃拍卖；已被删除成就的历史拍卖仍可打开详情页（显示为「已删除」占位信息），管理员也可照常取消。
- 猫猫广场（`/oi33/arena`）地图下方展示实时罐头买入/卖出价（含 24 小时涨跌百分比）和最多 4 个进行中的拍卖，点击进入对应页面。

### 成就交易合同

- 成就管理页可为成就勾选「可售卖」。只有**通过拍卖或交易合同获得**（`source: 'auction'` 或 `'contract'`）且被标记可售卖的成就才能转售；合同买来的成就可以继续转售，交易链条不设上限。
- 卖家在 `/oi33/contracts` 创建合同：选择成就、填写买家 UID 和猫粮价格（g）。同一成就同时只能有一份待处理合同。
- 买家接受后：猫粮从买家转给卖家（余额不足会拒绝，不允许因此变负），卖家的成就删除并重新授予买家（照常发布成就喵喵公告）。买家可拒绝、卖家可取消，均无费用。
- 成交、拒绝、取消都记录在 `oi33_log`（`type: 'contract'`），管理后台可按类型筛选。

## 猫咪像素地图

- 地图为 1000×1000 个格子，扩容只增加可用坐标：原 640×480 区域的所有格子文档和坐标都原位保留。用户初始不会自动加入广场；已认证用户第一次可自行选择任意位置免费加入，这次不消耗资源也不触发冷却。多个用户可以位于同一格。未认证用户不会出现在地图中，也不能加入或操作；身份降为未认证时会立即移除其位置，再次认证后需要重新加入。
- 向上下左右相邻格移动销毁 3g 猫粮。非相邻移动时，如果起点和终点都属于用户**当前绑定的同一只大猫**，则领地传送只销毁 3g 猫粮；其他传送消耗 3 个猫罐头，罐头从用户库存和流通量中扣除并回到虚拟储备池。普通移动与领地传送消耗的猫粮会同时计入用户当前大猫的投喂贡献；未绑定时仍会消耗，但没有可归属的大猫。
- 每次移动或传送成功后获得 1 次免冷却染色；额度不会累积，未使用时再次移动或传送仍只有 1 次。使用后下一次染色需等待共享冷却。
- 移动、传送和修改当前格颜色共用冷却：`ceil(max(50, 120 × 0.95^sqrt(罐头数)))` 分钟。最低为 50 分钟；传送按扣除罐头后的余额计算。
- 点击任意格会弹出格子详情，列出位于该格的全部小猫及猫粮、猫罐头数量，并提供加入、移动或传送按钮；点击自己所在格时还可使用 0～255 的 xterm 8-bit 调色板设置当前格颜色。改色不消耗猫粮或罐头，但会触发共享冷却；颜色在小猫离开后永久保留。
- 所有小猫适用完全相同的消耗和共享冷却规则，管理员小猫没有移动特权；位置允许重叠，同一格只绘制猫罐头最多的小猫（猫罐头相同时 UID 较小者优先）。管理员绘图权限仅在独立后台使用，可按（行,列）指定单像素或包含边界的矩形范围；坐标从左上角 `(0,0)` 到右下角 `(999,999)`。
- 未涂色地图使用纯白背景。
- 地图使用统一的公共颜色底图和连续缩放视野，前端提供“格线”“大猫视角”“小猫”“名字”四个独立显示开关。“大猫视角”会使用每只大猫唯一的领地色重新着色有色格子，不改变原 8-bit 颜色或点击操作。定位和全屏位于单独的导航工具栏。低倍率下格线会自动按间隔抽样，避免线条挤成色块；发生名字遮挡时优先显示猫罐头更多的用户。桌面端可拖动、滚轮缩放，并在全屏后平滑使用方向键浏览；移动端支持单指拖动和双指缩放。
- 小猫按地图空间分桶，只查询并绘制当前视野附近的对象；名字通常使用屏幕网格完成碰撞避让，放大到最大倍率后则显示视野内所有名字，并将标签限制在各自格子内。画面静止时采用按需重绘，移动动画和交互期间才恢复连续刷新；颜色缓存使用定长数值数组，避免大面积绘图产生大量字符串键。
- 前台工具栏以 `时:分:秒` 实时显示共享冷却剩余时间，不再单独展示地图规则栏目。
- 仅行政管理员可使用绘图后台。后台统一使用矩形工具：点击得到起点等于终点的 1×1 矩形，拖动得到更大范围；按住 Alt 拖动可平移，滚轮可连续缩放。精确的行列输入会随画布选择自动更新，颜色表与固定绘图工具栏位于画布上方。
- 行政管理员可显式执行“按最后绘图者刷新全图大猫归属”。实现按不同绘图者分批在 MongoDB 内部 `updateMany`，然后一次聚合重算领地格数，不会在应用层逐格读写。
- 行政管理员可在绘图后台按 UID 将指定用户的小猫强制迁移到随机位置；该操作不消耗用户资源，也不会改变其共享冷却或免冷却染色额度。
- 位置和颜色变化通过 WebSocket 在在线访客间实时同步。移动消耗会进入猫粮统一账本，管理员改色会进入活动日志。

## 大猫世界

猫猫广场的“大猫视角”以领地底图取代了旧的大猫精灵摆放：每只大猫代表 OIerDB 的一所学校，公开标签为 `<拼音缩写>#<OIerDB编号>`（如 `CSSYLZX#0`），详情中可跳转到 `oier.baoshuo.dev` 对应学校页面。学校数据来自 OIerDB（`scripts/school.txt`），用 `python scripts/build-school-cat-data.py`（需 `pypinyin`）重新生成 `model/school-cat-data.json`；运行时只在内存中索引该文件，不再复制到 `oi33_school`。执行 `/oi33/migrate` 会幂等删除该冗余旧集合。

### 绑定与投喂

- 参与要求与小猫地图一致（`realname_flag ≥ 1`）。投喂后被降级的用户保留绑定和贡献，只是恢复认证前不能再投喂/改绑。
- 每个用户绑定一只学校大猫；**首次绑定免费**，之后每个自然月（Asia/Shanghai）可改绑或取消绑定一次。改绑/取消时，你在旧猫上的累计贡献从「当前重量」移入「历史重量」并归档一条投喂历史；重新绑回投喂过的猫时，历史贡献会恢复为当前贡献。取消绑定不会改动任何既有格子的领地归属。
- 投喂**销毁猫粮**：你的猫粮余额减少，大猫当前重量和你的个人贡献同步增加，并写入猫粮统一账本。投喂有固定 2 小时冷却。

### 领地、颜色与排行榜

- 每次染色同时把该格归属到绘图者**当时**绑定的大猫；没有绑定则记为大猫 0 号。用户之后改绑不会改动旧画作归属。由于 OIerDB 本身存在学校 0 号，数据库中实际使用 `catId = schoolId + 1`，从而保留 `catId=0` 作为“无大猫”哨兵值。
- 大猫第一次出现时会分配一个未被其他大猫使用的随机 `#RRGGBB` 领地色，数据库唯一索引防止并发重复。该猫当前投喂贡献最多的用户可修改领地色；并列时 UID 较小者优先。
- `oi33_school_cat` 除当前/历史重量外，会按格子归属增量维护 `territoryCount`。公开大猫榜只显示当前体重或占领格数大于 0 的大猫，按占领格数、当前体重、学校编号依次排序；行政管理员可把大猫标成管理员大猫，其位置显示 ★ 且不占数字名次。广场侧栏显示前 32 项，完整榜单在独立页面。
- 普通移动和领地传送销毁的猫粮都视作对用户当前绑定大猫的投喂，不受手动投喂的 2 小时冷却限制。新移动日志带幂等计入标记；行政管理员可在完整榜单页回算旧日志，按执行时用户的当前绑定归属，未认证或未绑定的记录保留到以后重跑。
- 每个 Asia/Shanghai 自然周使用周一日期作为结算期。系统启动后及每 10 分钟检查一次，同一周期的每个版本只会生成并执行一份不可变快照；进程中断后可自动恢复，不会重复发放。行政管理员可在独立结算页核对大猫/用户分配，安全回滚后按当前数据生成递增版本重新结算；回滚要求原获奖用户仍有足额罐头，且会同步写负向账户日志和修正市场供应。已回滚的当周批次会暂停自动重发，等待管理员确认重算。
- 普通大猫的周奖池为 `base(领地格数) × floor(当前有效投喂人数 / 3)`：少于 64 格为 0，从 64 格起为 1 个，领地每翻倍增加 1 个，基础值最高 12 个。奖池按每人的 `floor(log2(当前投喂猫粮数))` 权重使用最大余数法完整分配；权重相同的小数余数按“周期 + 大猫 + UID”稳定轮换。管理员大猫忽略领地和权重，向每位当前有效投喂者固定发放 5 个罐头。只有结算快照时已认证、当前绑定且当前贡献大于 0 的用户计入。
- 每只猫提供「当前投喂榜」和「历史投喂榜」，其中移动投喂与手动投喂合并计算；用户改绑时仍统一转入历史贡献。
- 领地颜色、格子归属和计数变化通过 WebSocket 实时同步；原始 8-bit 底图与领地底图使用定长数值数组和 `ImageData` 批量生成，避免在 1000×1000 地图上创建百万个 JS 对象或逐格 canvas 调用。
- 「清理未认证猫资产」操作会同时清空未认证用户的大猫贡献：当前贡献直接为大猫减重（不转历史），历史投喂记录删除并扣减对应大猫的历史重量（见「猫粮规则」）。

## 系统设置

在 Hydro 后台「系统设置」→ `hydrooj` → `homepage` 中配置。以下为完整示例：

```yaml
- width: 9
  bulletin: true
  contest: 5
  homework: 10
  training: 10
  ranking: 10
  discussion: 20
- width: 3
  checkin:
    luck_type:
      - text: "大吉"
        color: "#ED5A65"
      - text: "吉"
        color: "#ED5A65"
      - text: "小吉"
        color: "#ED5A65"
      - text: "平"
        color: "#161823"
      - text: "小凶"
        color: "#161823"
      - text: "小凶"
        color: "#161823"
      - text: "大凶"
        color: "#161823"
    luck_template:
      - text: "大吉"
        color: "#ED5A65"
      - text: "吉"
        color: "#ED5A65"
      - text: "小吉"
        color: "#ED5A65"
      - text: "平"
        color: "#161823"
      - text: "小凶"
        color: "#161823"
      - text: "小凶"
        color: "#161823"
      - text: "大凶"
        color: "#161823"
    luck_vip:
      - 1, 2
  countdown:
    title: 倒计时
    max_dates: 5
    dates:
      - name: APIO 2026
        date: 2026-05-07
      - name: NOI 2026
        date: 2026-07-18
      - name: IOI 2026
        date: 2026-08-09
      - name: CSP-J/S 第一轮
        date: 2026-09-19
      - name: CSP-J/S 第二轮
        date: 2026-10-31
      - name: NOIP & 女生赛
        date: 2026-11-28
  sidebar_nav:
    - title: 常用功能
      urls:
        - name: 软件下载
          url: /p/SOFTWARE
        - name: "三三百科"
          url: https://wiki.example.com
        - name: 初学者常用内容
          url: https://wiki.example.com/w/beginner
        - name: 题目分享
          url: https://pan.baidu.com/s/xxxxxxxx
        - name: 打字练习
          url: https://type.example.com
    - title: 33OJ
      urls:
        - name: 生日快乐
          url: /oi33/birthday
        - name: 管理后台
          url: /oi33/admin
        - name: 云剪贴板
          url: /oi33/paste/manage
    - title: 常用 OJ
      urls:
        - name: HydroOJ
          url: https://hydro.ac/
        - name: 洛谷
          url: https://www.luogu.com.cn/
        - name: AtCoder
          url: https://atcoder.jp/
        - name: CodeForces
          url: https://codeforces.com/
  hitokoto: true
  starred_problems: 50
  recent_problems: 10
  discussion_nodes: true
  suggestion: true
```

### checkin 配置项

| 字段 | 说明 |
|------|------|
| `luck_type` | 7 级运势的文字和颜色，对应 checkin_luck 0-6 |
| `luck_template` | 预留，当前与 luck_type 保持一致 |
| `luck_vip` | VIP 用户 UID 列表，始终显示「大吉」 |

### countdown 配置项

| 字段 | 说明 |
|------|------|
| `title` | 倒计时组件标题 |
| `max_dates` | 最多显示几条倒计时 |
| `dates` | 倒计时列表，每条含 `name`（名称）和 `date`（日期 YYYY-MM-DD），已过日期自动隐藏 |

### sidebar_nav 配置项

| 字段 | 说明 |
|------|------|
| `title` | 链接分组标题 |
| `urls` | 链接列表，每条含 `name`（显示名）和 `url`（链接地址） |

### meow 配置项

喵喵模块**不会自动注入首页**，需要手动在 `hydrooj.homepage` 配置里放到你想展示的位置：

```yaml
- width: 3
  meow: 10          # 数字为展示条数（默认 10，最大 50）
```

- 放在哪个 `column` 里，就渲染在那一列的那个位置（模块会按配置顺序出现）。
- 未配置时不展示；同一个首页配置只出现一次，重复配置不会重复渲染。
- 对应页面 `/oi33/meow`，模块数据来自 `meowHomeFeed`（管理员 + 关注的人 + 自己）。

## AI 代码分析

在提交记录页面对单份代码调用 DeepSeek 思考模型进行流式点评。学生看到引导式分析（只提问和提示，不给完整答案），教师（OI33 身份 ≥ 2）看到诊断式分析（结论 + 定位 + 修改方向），两套 prompt 均要求模型全程使用中文且思考简明扼要。

### 使用规则

- 学生只能分析自己的提交，且需在 `/oi33/ai/access` 白名单内并有余额；教师不受限、不计费（仍记录用量），可分析任何人的提交。
- 比赛/作业提交仅教师可分析（比赛结束后学生也不可）。
- 分析完成后结果对学生锁定；教师在分析页清除结果后，学生才能重新分析。
- 全站最多 3 个并发分析，超出的连接排队并实时显示队列位置。

### 精简题意缓存

- 某题首次分析时，后台自动生成「精简题意」（压缩题面，保留定义/格式/数据范围/特判）并缓存到 `oi33_ai_problem_summary`，后续分析直接复用以降低成本。
- 缓存未就绪时不阻塞分析：本次先用完整题面，缓存生成供下次使用。
- 管理员可在 `/oi33/ai/summary` 查看任意题的精简题意，或手动重新生成（使用 `/oi33/ai/models` 配置的精简题意模型，一次调用同时产出精简题意和 AI 参考难度）；生成费用计入全局统计，不扣用户余额。

### AI 参考难度与批量生成

- `/oi33/ai/summary`：查看/重新生成精简题意，WebSocket 流式输出（实时显示思考过程与题意 markdown）；一次调用同时产出精简题意和难度（模型在末尾输出 `[[难度]]N` 标记，入库前剥离，不会混入缓存）。
- `/oi33/ai/summary/batch`：按 sort 题号区间批量补齐，可指定域（默认 `system`），支持纯数字（`1000 ~ 1500`）和字母数字混合（`ABC123A ~ ABC200D`，按前缀→数字→后缀比较）两种格式；单次最多 500 题，后台顺序执行、只补缺口、可重复跑，页面每 10 秒自动刷新进度。
- 题目未评级（难度为 0/未设置）时 AI 难度直接写入题目；已评级题目保留原评级，AI 参考难度仅在 `/oi33/ai/summary` 展示。
- 难度评判的 system prompt 可在 `/oi33/ai/models` 配置（`difficulty_prompt`，留空用内置默认；仅对单独评判路径生效，合并生成使用内置难度说明）。
- 后台分析时自动生成的精简题意不评判难度，可在 summary 页用「生成 AI 参考难度」单独补判。

### 计费

- 按各模型在 `/oi33/ai/models` 配置的 token 单价（区分缓存命中/未命中的输入价与输出价）× 实际用量扣费。
- 学生在白名单内的「发放额度 − 已用」即余额；余额不足无法发起分析。教师与勾选「不限」的账户不扣费。
- 每次分析与精简题意生成都记录到 `oi33_ai_usage`，`/oi33/ai/admin` 汇总展示 token 用量与费用。

### 模型与 prompt 配置（`/oi33/ai/models`）

| 配置项 | 说明 |
|--------|------|
| Provider | Base URL + API Key（API Key 留空表示不修改）；未配置时回退到环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` |
| 模型价格 | 每个模型的输入（缓存未命中/命中）与输出单价（元 / 1M token） |
| 默认模型 | 学生、教师、精简题意三个角色各自的模型（默认 `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash`） |
| 思考强度 | 每个角色（学生/教师/精简题意）单独配置 DeepSeek 思考模式的 `reasoning_effort`：留空用官方默认 high，可填 low（更快、省 token）或 max；精简题意强度对手动重新生成、批量生成和难度评判生效（难题生成题意失败时建议调 low） |
| System Prompts | 学生、教师、精简题意三个 prompt 的查看与修改；清空保存即恢复内置默认 |

### 请求预算

- 流式分析：`max_tokens 16384`，超时 180 秒（思考模型会把 completion 额度消耗在思维链上，避免难题思考被截断）。
- 精简题意：`max_tokens 8192`，超时 120 秒（流式 180 秒）；手动重新生成放宽到 `max_tokens 16384`、超时 300 秒；被长度截断的结果不会写入缓存。

## AI 讨论审核

讨论区重新开放后仅对 **实名认证用户（`realname_flag ≥ 1`）** 可写；学生的主题、回复、评论及其编辑在写入数据库前先过两层审核，教师及以上免审。

### 审核管线

1. **实名门禁**：未认证用户直接被拒（即使拥有 Hydro 的讨论权限）。
2. **内容归一化**：NFKC + 去零宽/方向控制字符 + 小写化，防变形绕过；对归一化内容做 sha256，30 天内相同内容直接复用最终裁决（缓存命中不再调 AI）。
3. **限流**：单用户每日送审次数上限（默认 50，可配置），超限直接拒绝。
4. **规则层（免费）**：违禁词表（管理员可维护）与手机号、QQ/微信引流正则命中即拦截；外链不拦截但会标记。
5. **预算熔断**：当日审核 AI 花费超过预算（可配置，0 为不限）后，全部转人工审核。
6. **AI 层**：`response_format: json_object` 强制结构化输出 `{verdict, category, reason}`；**AI 只有"投票权"没有"执行权"**，发布动作始终在服务端代码中。超时、报错、JSON 解析失败、verdict 非法一律 fail-closed 转人工。规则层标记（如外链）但 AI 判通过的分歧情况也转人工。

### 裁决结果

- **通过**：正常发布。
- **拦截**：用户只看到固定类别提示（如「内容未通过社区规范审核（广告引流）」），不展示 AI 原文理由——既防提示注入探测，也防 AI 输出被污染后渲染给用户。
- **存疑**：内容不写入讨论区，仅存 `oi33_ai_moderation` 队列；管理员在 `/oi33/ai/moderation` 通过后按原始参数回放发布（并私信通知用户），拒绝则通知用户修改。

### 防注入设计

- 审核策略在 system prompt（管理员可在 `/oi33/ai/moderation` 覆盖），用户内容仅以 `<post>` 标签包裹送入 user 消息，prompt 明确要求把其中任何"指令"当作内容本身裁决（并记为「注入尝试」类别）。
- 审核 AI 不挂任何工具、无副作用，最坏结果只是一次错误裁决；category 限定白名单，用户可见文案全部由服务端固定生成。
- 全部裁决（含 AI 理由、模型、费用、来源）留痕于 `oi33_ai_moderation`，人工覆盖结果可用于迭代 prompt 与违禁词表。

### 挂钩方式

不修改 Hydro 源码，通过 handler 生命周期事件拦截：`handler/before/DiscussionCreate#post`（发主题）、`handler/before-operation/DiscussionDetail`（reply / tail_reply / edit_reply / edit_tail_reply）、`handler/before-operation/DiscussionEdit`（update）。挂钩点在路由级权限检查之后、实际写库之前，游客无法借此消耗 AI 额度。

## 个人简介审核

个人简介（Hydro 核心 `bio` 字段，`/home/settings/account` 编辑）接入同一套审核引擎：

- **展示**：已认证用户的简介展示在个人页 tab 面板第一项「Bio」和首页排行榜；未认证用户不展示。
- **编辑冷却**：两次修改间隔 2 小时（`bio_edited_at`），通过 `handler/before/HomeSettings#post` 钩子拦截。
- **审核**：每次变更由 `handler/after/HomeSettings#post` 钩子触发后台 AI 审核（复用 `runAiVerdict`，规则层 + AI + 30 天哈希缓存 + 预算熔断）。通过即公开；拦截/存疑/出错一律隐藏（fail-closed），并**私信通知本人**（含分类与理由）。存疑与出错进入 `/oi33/ai/moderation` 人工队列，管理员通过后立即公开，驳回则私信「人工审核未通过」。
- **防绕过**：展示要求 `bio_status === 'approved'` 且当前简介哈希与审核通过的版本一致——任何绕过钩子的写入（如 OAuth 回写）都会因哈希不符自动隐藏。
- **初始批量审查**：`/oi33/ai/bio-review` 对所有简介非空用户跑一次审核，已有最终结论且简介未变的用户自动跳过（幂等，可重跑）。

## 喵喵时间线

犇犇式短博客，主页面 `/oi33/meow`（标题「喵喵时间线」）。每条信息为**纯文字**（≤ 256 字），未认证用户（`realname_flag < 1`）不能发布、点赞或转发。

### 发布规则

- **仅已认证用户可发送**（`realname_flag ≥ 1`）；教师及以上免审核直接展示。
- **每天首条免费**（Asia/Shanghai 自然日）；同日后续信息每条消耗 1 个猫罐头，并写入统一猫粮账户流水。
- **冷却**：上一条信息（任意状态）之后 2 小时才可再发，页面实时显示剩余时间。
- **审核**：学生发布先经规则层 + AI 双层审核（复用讨论区同一套引擎）：通过自动展示；拦截则重置冷却，付费信息退还猫罐头、免费信息恢复当日免费次数；存疑进入 `/oi33/meow/admin` 人工队列，人工驳回同样处理。
- **系统成就公告**：授予成就时直接生成一条已通过的个人喵喵，不扣罐头、不占每日免费次数，也不触发两小时冷却。
- 时间线 = 自己 + 关注的人 + 所有管理员/行政管理员的信息；如需在首页展示喵喵模块，在 `hydrooj.homepage` 配置中手动加入 `meow: 10`（见「系统设置」，默认不会自动注入首页）。

### 转发

转发是**纯文字**：点击卡片上的「🔁 转发」→ 跳到时间线，发布框自动填充转发路径（如 ` || @billtun : 666 || @L_Merengues : ...`），在 `||` 前写自己的话后直接发布即可，内容按原样保存，无结构化的转发关系。

### 关注与点赞

- 单向关注（Twitter 式）：关注后对方已通过的信息进入你的时间线；关注/粉丝列表页（`?uid=` 可看他人）带互相关注标识。
- 点赞为切换式，信息卡以 `👍 赞`、`🔁 转发` 链接展示；用户详情页的喵喵面板只读展示「赞 / 转发」数量。
- 内容中 `@用户名` 会渲染为对应用户主页的链接。

### 活动日志

管理后台「最近动态」中，喵喵只记录**已通过 / 已驳回**的最终结果（以及关注、取关、审核操作），待审批的过程不出现。

## 身份标签（`realname_flag`）

| 值 | 标签 | 公开剪贴板 | Wiki 编辑 |
|----|------|-----------|----------|
| 0 | 未认证 | ❌ | ❌ |
| 1 | 已认证 | ✅ | ❌ |
| 2 | 管理员 | ✅ | ✅ |
| 3 | 行政管理员 | ✅ | ✅ |

未认证用户在全站用户展示中仅显示 `UID <id>` 和默认空白头像，不展示自定义用户名、头像或实名名称。只有管理员或行政管理员访问该用户的个人页时，才能看到其自定义用户名和头像。

认证身份与实名信息相互独立：认证通过仅恢复公开用户名和头像；`realname_name` 属于敏感实名信息，中括号实名及实名字段只对管理员和行政管理员显示。

## Wiki 百科系统

OI33 内置 Wiki 百科，支持 Markdown 页面 CRUD、多级分类目录和 JSON 批量导入导出。

### 数据库

| 集合 | 说明 |
|------|------|
| `oi33_wiki` | 页面文档（`_id` 为随机 slug，`title`、`content`、`category`、`order`、`createdAt`、`updatedAt`） |
| `oi33_wiki_category` | 分类目录（`_id` 为 slug，`name` 为显示名，`order` 排序） |

- 默认分类：`algorithm`（算法）、`announcement`（公告）
- 特殊页面 `_id: "index"` 为首页公告，不可删除

### 权限

- 查看：公开
- 创建/编辑：`realname_flag >= 2`（管理员或行政管理员）
- 删除/导入/分类管理：`realname_flag >= 2`
- 导出：公开

### JSON 导入格式

访问 `/oi33/wiki/import`，将 JSON 数组粘贴到文本框提交即可：

```json
[
  {
    "title": "快速排序",
    "content": "# 快速排序\n\n快速排序是一种...",
    "category": "algorithm"
  },
  {
    "title": "OI 赛前须知",
    "content": "# OI 赛前须知\n\n1. 关闭...",
    "category": "announcement"
  }
]
```

- 必填字段：`title`、`content`
- 可选字段：`category`（不填默认为 `other`）
- 遇到不存在的分类会自动创建
- 可提交单个对象或数组
- 通过 `/oi33/wiki/export` 导出的 JSON 可直接重新导入

## 评测机监控

每 5 分钟检查一次 `status` 集合的心跳记录。评测机超过 22 分钟未上报视为离线，服务器（嵌入式部署）超过 32 分钟未上报视为离线。

当状态发生变化（在线→离线 / 全部离线 / 离线→在线）时，通过企业微信 Webhook 自动推送通知。

### 配置

在 `/oi33/judge-monitor` 面板中设置：

| 配置项 | 说明 |
|--------|------|
| Webhook URL | 企业微信群机器人 Webhook 地址 |
| 启用监控 | 开关 |
| 包含服务器 | 是否同时监控服务器类型节点 |

### 状态通知类型

| 类型 | 触发条件 |
|------|---------|
| `delta` | 部分机器状态发生变化（上下线混合） |
| `offline` | 全部在线 → 全部离线 |
| `recovery` | 全部离线 → 任意机器恢复在线 |

## 权限速查表

`/oi33/permissions` 提供按角色（Guest / flag 0~3）列出的功能权限矩阵，包括剪贴板、Wiki、资料编辑、硬币/徽章/签到、管理工具等。

## MCP / Agent API 令牌

为外部 MCP 工具、AI Agent 或自动化脚本提供 **只读** 的 Bearer Token 认证机制，使其能够绕过登录直接访问 33OJ 的公开数据。

### 核心设计

| 特性 | 说明 |
|------|------|
| **Token 格式** | `33tok_<base64url>`（约 50 字符），创建时仅显示一次 |
| **存储方式** | 数据库存 SHA-256 hash，不存原始值，泄漏后可立即吊销 |
| **权限模型** | 只读 — 双重拦截：HTTP 方法限制 + 路由白名单 |
| **方法限制** | 仅允许 `GET` / `HEAD` / `OPTIONS`，其余方法直接拒绝 |
| **路由白名单** | 仅允许访问明确列入白名单的路由（见下方列表） |
| **域限制** | 可限定允许访问的域（`"*"` 表示所有域），未授权的域返回 403 |
| **过期机制** | 支持设置过期时间，过期后自动失效 |
| **创建权限** | 仅 `PRIV_ALL`（超级管理员）可创建和删除令牌 |

### 使用方法

在 HTTP 请求 Header 中携带：

```
Authorization: Bearer 33tok_xxxxxxxx...
```

令牌认证通过 `handler/create` 事件钩子拦截，在 Hydro v5 的 handler 生命周期中最早执行（早于 `handler/create/http` 的 `PERM_VIEW` 闸门、路由级 `checkPriv`/`checkPerm` 以及 `prepare()`），因此在游客无查看权限的私有域中也能正常注入令牌用户，而不会被先重定向到登录页。认证成功后，请求将以令牌所属用户的身份执行，但写操作会被强制拦截。

### 管理入口

管理员访问 `/oi33/tokens` 创建令牌，可指定：

- **名称**：便于识别的备注（如 `"MCP-Data-Exporter"`）
- **所属用户 UID**：令牌代表谁的身份（留空为自己）
- **允许域**：逗号分隔的域 ID（如 `"system,contest"`，`*` 为全部）
- **过期时间**：可选的到期时间

创建成功后页面会**一次性显示原始令牌**，务必立即复制保存，之后无法再次查看。

### 白名单路由

Token 仅允许访问以下路由（精确匹配或前缀匹配）：

**Hydro 核心**
- `/record/*` — 提交记录、代码下载
- `/p`, `/p/*` — 题目（列表路由是 `/p`，不是 `/problem`）
- `/contest/*`, `/homework/*` — 比赛、作业
- `/user/*`, `/ranking` — 用户、排名
- `/discuss/*`, `/training/*` — 讨论、训练

**OI33 插件**
- `/oi33/users` — 全部用户数据
- `/oi33/birthday` — 今日生日
- `/oi33/badge` — 徽章展示
- `/oi33/badge/manage` — 徽章管理
- `/oi33/at-cf-rating` — Rating 排名
- `/oi33/paste/show/*` — 剪贴板内容
- `/oi33/paste/manage` — 我的剪贴板
- `/oi33/paste/all` — 全部剪贴板
- `/oi33/coin/bill/*` — 硬币账单
- `/oi33/admin` — 管理仪表盘
- `/oi33/requests` — 审批列表
- `/oi33/tokens` — Token 管理

**明确禁止**（即使 GET 也会触发写入）：
- `/oi33/checkin` — GET 内部会写入签到记录
- `/oi33/badge/manage/*/del` — GET 内部会删除徽章
- 所有未列出的路径

### 只读保证

1. **HTTP 方法拦截**：`POST` / `PUT` / `DELETE` / `PATCH` 在 `handler/create` 阶段直接抛出 `Read-only token cannot perform write operations`
2. **路由白名单拦截**：不在白名单中的路径抛出 `This route is not available via token`
3. 双重拦截均在 handler 方法体执行之前，不会触及任何数据库写操作

### 典型场景

- **AI Agent 数据接入**：让 AI Agent 通过 Token 拉取题目、提交记录、排行榜等数据进行分析
- **MCP 工具集成**：为 MCP Server 提供安全的只读凭证，避免暴露账号密码
- **自动化报表脚本**：定时脚本通过 Token 读取 OJ 数据生成统计报表
- **第三方数据同步**：与其他系统对接时仅暴露只读权限

## OAuth2 登录（33OJ 作为身份提供方）

33OJ 可作为 OAuth2 身份提供方（IdP），让你的其他网站、博客、工具实现「使用 33OJ 登录」——类似「使用 GitHub 登录」。实现的是标准 OAuth2 **Authorization Code** 流程（RFC 6749），支持 PKCE（RFC 7636）和刷新令牌。

### 快速接入

#### 1. 在 33OJ 注册应用

管理员访问 `/oi33/oauth/clients` → 填写：

| 字段 | 说明 |
|------|------|
| 应用名称 | 显示在授权页上的名字（如「我的博客」） |
| 回调 URI | 你的网站接收授权码的地址，需精确匹配，多个用逗号或空格分隔（如 `https://blog.example.com/auth/callback`） |
| 公开客户端 (PKCE) | **No** = 有后端的机密应用（用 client_secret）；**Yes** = 纯前端 SPA/移动端（用 PKCE，无 secret） |
| Access/Refresh Token TTL | 令牌有效期（秒），留空用默认值（1 小时 / 30 天） |

创建后会**一次性显示 `client_secret`**，立即复制保存（之后只能看到前缀）。应用详情页 `/oi33/oauth/clients/:id` 自带完整的接入指南和端点 URL。

#### 2. 端点

| 端点 | URL | 说明 |
|------|-----|------|
| 授权 | `GET /oi33/oauth/authorize` | 引导用户前往，展示授权同意页 |
| 换令牌 | `POST /oi33/oauth/token` | 用授权码换 access_token / refresh_token |
| 用户信息 | `GET /oi33/oauth/userinfo` | 用 access_token 换用户信息 |
| 吊销 | `POST /oi33/oauth/revoke` | 吊销 access/refresh token |

> 完整 URL 前缀为你的 33OJ 站点地址（如 `https://oj.33dai.top`），可在应用详情页直接复制。

#### 3. 授权码流程

```
你的网站                   33OJ                    用户浏览器
   │                         │                         │
   │  1. 重定向到 authorize  │◄────────────────────────│
   │                         │  展示授权同意页          │
   │                         │────────────────────────►│ 用户点「授权」
   │  2. 回调带 code         │◄────────────────────────│
   │                         │                         │
   │  3. POST /token 换令牌  │────────────────────────►│
   │     (服务端，带 secret)  │  返回 access_token       │
   │◄────────────────────────│                         │
   │                         │                         │
   │  4. GET /userinfo       │                         │
   │     (带 Bearer token)   │                         │
   │  返回用户信息            │                         │
   │◄────────────────────────│                         │
```

**第 1 步：引导用户授权**

将用户重定向到：

```
GET /oi33/oauth/authorize?
    response_type=code
    &client_id=YOUR_CLIENT_ID
    &redirect_uri=YOUR_REDIRECT_URI
    &state=RANDOM_STRING
```

- 未登录用户会先跳转到 33OJ 登录页，登录后自动回到授权页
- `state` 是你生成的随机串，用于防 CSRF，回调时原样带回，务必校验
- 公开客户端（PKCE）额外传 `code_challenge` 和 `code_challenge_method=S256`

**第 2 步：接收回调**

用户授权后，33OJ 重定向回你的 `redirect_uri`：

```
https://your-site/callback?code=AUTH_CODE&state=RANDOM_STRING
```

校验 `state` 与第 1 步一致后，用 `code` 换令牌。

**第 3 步：换令牌（服务端）**

```
POST /oi33/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=AUTH_CODE
&redirect_uri=YOUR_REDIRECT_URI
&client_id=YOUR_CLIENT_ID
&client_secret=YOUR_CLIENT_SECRET
```

> 公开客户端（PKCE）不传 `client_secret`，改传 `code_verifier`（第 1 步 `code_challenge` 的原文）。
>
> 也可用 HTTP Basic Auth 头传客户端凭据：`Authorization: Basic base64(client_id:client_secret)`

响应：

```json
{
  "access_token": "33oat_...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "33ojrt_...",
  "scope": "profile"
}
```

**第 4 步：获取用户信息**

```
GET /oi33/oauth/userinfo
Authorization: Bearer 33oat_...
```

响应：

```json
{
  "sub": "2",
  "uname": "alice"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `sub` | string | 用户唯一标识（即 33OJ 的 uid，字符串形式，**不会变**，适合作为主键） |
| `uname` | string | 用户名（可能改名，不建议作为主键） |

> 只暴露这两个字段。不包含邮箱、硬币、生日等任何 OI33 业务数据。

**第 5 步（可选）：刷新令牌**

access_token 过期后，用 refresh_token 换新的（机密客户端需带 secret）：

```
POST /oi33/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=33ojrt_...
&client_id=YOUR_CLIENT_ID
&client_secret=YOUR_CLIENT_SECRET
```

**吊销令牌**

```
POST /oi33/oauth/revoke
Content-Type: application/x-www-form-urlencoded

token=33oat_...   (或 33ojrt_...)
```

### 代码示例（Node.js / Express）

```javascript
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(session({ secret: 'your-session-secret', resave: false, saveUninitialized: true }));

const OJ_BASE = 'https://oj.33dai.top';
const CLIENT_ID = '33oj_xxxxxxxx';
const CLIENT_SECRET = '33ojcs_xxxxxxxx';
const REDIRECT_URI = 'https://your-site/auth/callback';

// 第 1 步：跳转到 33OJ 授权
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  res.redirect(`${OJ_BASE}/oi33/oauth/authorize?response_type=code`
    + `&client_id=${CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&state=${state}`);
});

// 第 2-4 步：回调 → 换令牌 → 取用户信息
app.get('/auth/callback', async (req, res) => {
  if (req.query.state !== req.session.oauthState) return res.status(403).send('State mismatch');

  // 换令牌
  const tokenRes = await axios.post(`${OJ_BASE}/oi33/oauth/token`, new URLSearchParams({
    grant_type: 'authorization_code',
    code: req.query.code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  // 取用户信息
  const userInfo = await axios.get(`${OJ_BASE}/oi33/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
  });

  // 用 sub 作为唯一标识登录/注册用户
  req.session.user = { sub: userInfo.data.sub, uname: userInfo.data.uname };
  res.redirect('/');
});

app.listen(3000);
```

### 客户端类型对比

| | 机密客户端 (Confidential) | 公开客户端 (Public / PKCE) |
|---|---|---|
| 适用场景 | 有后端的服务器应用 | SPA、移动端、桌面软件 |
| 认证方式 | `client_secret` | PKCE（`code_challenge`/`code_verifier`） |
| secret 安全性 | 存在服务器，不暴露 | 无 secret，靠 PKCE 防截获 |
| 注册时选 | Public Client (PKCE) = **No** | Public Client (PKCE) = **Yes** |

### 安全说明

- `client_secret` 仅在创建时显示一次，数据库存 SHA-256 hash，无法找回
- 授权码 10 分钟有效且一次性，使用后即作废
- access_token / refresh_token 均哈希存储，泄漏后可在应用管理页删除客户端吊销其所有令牌
- `redirect_uri` 必须与注册的完全匹配，防止授权码被发到错误地址
- `state` 参数防 CSRF，务必校验
- 所有 OAuth 操作（授权/拒绝/换令牌/刷新/吊销/应用增删）记录在 `oi33_log`，可在管理仪表盘查看
