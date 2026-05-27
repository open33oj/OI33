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
| 实名 | 身份标签 4 级（未实名/已实名/老师/管理员），实名展示 | `/oi33/realname/*` |
| 签到 | 每日打卡+运势、连续签到统计 | `/oi33/checkin` |
| 倒计时 | 首页倒计时组件（配置驱动） | 首页 partial |
| 剪贴板 | Markdown 剪贴板 CRUD、公有/私有（已实名才能发布公开粘贴） | `/oi33/paste/*` |
| 前端覆盖 | Logo、favicon、模板覆盖 | 静态资源 |
| 管理仪表盘 | 统一查看所有数据 + 操作日志 | `/oi33/admin` |
| 数据迁移 | 从老插件迁移数据到新集合 | `/oi33/migrate` |
| Wiki 百科 | 分类目录、Markdown 页面 CRUD、JSON 批量导入/导出（仅管理员可编辑） | `/oi33/wiki/*` |
| AT/CF 用户名 | 设置 AtCoder / Codeforces 用户名（走审批流程），rating 字段由后台脚本自动更新 | `/oi33/profile/edit/:uid` |
| AT/CF Rating 排名 | 公开展示已绑定 AT/CF 用户的信息及 rating，支持按任意 rating 排序 | `/oi33/at-cf-rating` |
| 统一资料审批 | 生日、实名、徽章、AT/CF 用户名 均走提交→审批流 | `/oi33/requests` |
| MCP / Agent API 令牌 | 供外部 MCP 工具或 AI Agent 调用的只读 Bearer Token，可限定域和过期时间 | `/oi33/tokens` |
| 评测机监控 | 每 5 分钟检查心跳，离线/恢复时通过企业微信 Webhook 推送通知 | `/oi33/judge-monitor` |
| 权限速查表 | 按角色列出各功能权限矩阵 | `/oi33/permissions` |

## 数据库

新插件使用 `oi33_*` 前缀的 7 个集合，与 Hydro 核心的 `user` 集合解耦：

| 集合 | 用途 |
|------|------|
| `oi33_user` | 用户属性：硬币余额、生日、徽章、实名、签到数据、AT/CF 用户名及 rating |
| `oi33_coin_bill` | 硬币交易流水 |
| `oi33_paste` | 剪贴板文档 |
| `oi33_wiki` | Wiki 百科页面（含 `index` 页作为首页公告） |
| `oi33_wiki_category` | Wiki 分类目录（默认：算法、公告） |
| `oi33_request` | 资料修改审批（生日、实名、徽章、AT/CF 用户名） |
| `oi33_token` | MCP / Agent API 令牌（SHA-256 哈希存储，只读） |
| `oi33_log` | 操作日志（硬币、生日、徽章、实名、剪贴板、Wiki、审批） |

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
| `/oi33/rating` | 公开 | Rating （旧路由，已弃用） |
| `/oi33/wiki/create` | `PRIV_USER_PROFILE`（且 `realname_flag === 3`） | 创建 Wiki 页面 |
| `/oi33/wiki/:id/edit` | `PRIV_USER_PROFILE`（且 `realname_flag === 3`） | 编辑 Wiki 页面 |
| `/oi33/checkin` | `PRIV_USER_PROFILE` | 每日签到 |
| `/oi33/coin/show` | `PRIV_USER_PROFILE` | 查看硬币排行 |
| `/oi33/coin/bill/:uid` | `PRIV_USER_PROFILE` | 查看自己账单（查看他人需 `PRIV_MOD_BADGE`） |
| `/oi33/birthday/all` | `PRIV_USER_PROFILE` | 查看所有用户生日 |
| `/oi33/badge` | `PRIV_USER_PROFILE` | 查看徽章 |
| `/oi33/paste/create` | `PRIV_USER_PROFILE`（公开粘贴需 `realname_flag >= 1`） | 创建剪贴板 |
| `/oi33/paste/manage` | `PRIV_USER_PROFILE` | 管理自己的剪贴板 |
| `/oi33/paste/show/:id/edit` | `PRIV_USER_PROFILE` | 编辑自己剪贴板（编辑他人需 `PRIV_MOD_BADGE`） |
| `/oi33/paste/show/:id/delete` | `PRIV_USER_PROFILE` | 删除自己剪贴板（删除他人需 `PRIV_MOD_BADGE`） |
| `/oi33/profile/edit/:uid` | `PRIV_USER_PROFILE`（自己）/ `PRIV_MOD_BADGE`（他人） | 统一资料编辑（生日、实名、徽章、AT/CF） |
| `/oi33/tokens` | `PRIV_USER_PROFILE`（管理员可查看全部） | 查看自己的令牌 |
| `/oi33/wiki/import` | `PRIV_MOD_BADGE` | Wiki 导入页面 |
| `/oi33/wiki/import/submit` | `PRIV_MOD_BADGE` | 执行 Wiki JSON 导入 |
| `/oi33/wiki/categories` | `PRIV_MOD_BADGE` | 管理 Wiki 分类 |
| `/oi33/wiki/:id/delete` | `PRIV_MOD_BADGE` | 删除 Wiki 页面 |
| `/oi33/judge-monitor` | `PRIV_MOD_BADGE` | 评测机监控面板 |
| `/oi33/permissions` | `PRIV_MOD_BADGE` | 权限速查表 |
| `/oi33/coin/inc` | `PRIV_MOD_BADGE` | 发放硬币 |
| `/oi33/badge/manage` | `PRIV_MOD_BADGE` | 管理徽章 |
| `/oi33/badge/manage/:uid/del` | `PRIV_MOD_BADGE` | 删除徽章 |
| `/oi33/paste/all` | `PRIV_MOD_BADGE` | 查看所有剪贴板 |
| `/oi33/admin` | `PRIV_MOD_BADGE` | 管理仪表盘 |
| `/oi33/migrate` | `PRIV_MOD_BADGE` | 执行数据迁移 |
| `/oi33/users` | `PRIV_MOD_BADGE` | 查看全部用户数据 + 身份筛选 |
| `/oi33/requests` | `PRIV_MOD_BADGE` | 审批列表 |
| `/oi33/tokens/create` | `PRIV_ALL` | 创建 MCP / Agent API 令牌 |
| `/oi33/tokens/:id/delete` | `PRIV_ALL` | 删除令牌 |
| `/record` | 导航默认跳转 `?uidOrName=自己`（登录用户） | 评测记录页（覆盖模板） |

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

## 数据导出脚本

`scripts/export-hydro-data.ts` —— 以 **提交记录（record）** 为核心驱动，导出指定日期区间内的提交记录，并关联提取涉及的用户、题目、比赛及比赛成绩，用于 AI 分析。

### 导出逻辑

1. **查询 record**：以日期区间筛选提交记录（主要驱动）
2. **提取关联 ID**：从 record 中抽取出 `uid`、`pid`、`contestId`
3. **查询关联用户**：仅导出存在提交记录的用户（去敏）
4. **查询关联题目**：仅导出被提交过的题目
5. **查询关联比赛**：仅导出被提交涉及的比赛
6. **聚合比赛成绩**：按 `(比赛, 用户)` 分组，聚合每场比赛的得分、AC 数、各题提交详情

### 导出内容

| 数据 | 来源 | 说明 |
|------|------|------|
| `records` | `record` | 日期区间内的所有提交记录 |
| `users` | `user` | 存在提交记录的用户（去敏） |
| `problems` | `document` (`docType=10`) | 被提交过的题目 |
| `contests` | `document` (`docType=30`) | 被提交涉及的比赛 |
| `contestResults` | `record` 聚合 | 每场比赛每个用户的成绩汇总 |

### 使用方法

**Hydro 控制面板 → 脚本管理**

1. 进入 Hydro 控制面板「脚本管理」
2. 找到 `exportHydroData` 脚本（插件注册后会自动显示在列表中）
3. 填入参数后运行：

| 参数 | 必填 | 说明 | 示例 |
|------|------|------|------|
| `startDate` | 是 | 开始日期 | `2026-01-01` |
| `endDate` | 是 | 结束日期 | `2026-05-15` |
| `outputDir` | 否 | 输出目录，默认 `/tmp` | `/tmp` |
| `includeCode` | 否 | 是否包含提交代码，默认 `true` | `true` |
| `domainId` | 否 | 限定域列表，默认全部域；可填多个域 ID | `["system"]` |

4. 运行后到服务器 `outputDir` 目录下取 `hydro-export-YYYY-MM-DD_to_YYYY-MM-DD_YYYY-MM-DD_HH-mm-ss.json`（末尾为导出时刻 UTC 时间戳，避免覆盖同段内容的多次导出）

### 参数示例（可直接复制到脚本管理参数框）

```json
{"startDate":"2026-01-01","endDate":"2026-05-15","outputDir":"/tmp","includeCode":true,"domainId":["system"]}
```

> 输出文件示例：`/tmp/hydro-export-2026-01-01_to_2026-05-15_2026-05-15_14-41-01.json`

### 输出格式

```json
{
  "meta": {
    "version": "1.0",
    "exportedAt": "2026-05-15T...",
    "dateRange": { "start": "2026-01-01", "end": "2026-05-15" },
    "recordCounts": {
      "records": 1280,
      "users": 156,
      "problems": 45,
      "contests": 3,
      "contestResults": 89
    }
  },
  "records": [
    {
      "_id": "...", "domainId": "system", "uid": 1, "pid": 1,
      "status": 1, "score": 100, "time": 100, "memory": 65536,
      "lang": "cc.cc14o2", "contest": "...", "judgeAt": "..."
    }
  ],
  "users": [
    { "uid": 1, "uname": "...", "mail": "...", "priv": 3 }
  ],
  "problems": [
    { "domainId": "system", "docId": 1, "title": "...", "difficulty": 3 }
  ],
  "contests": [
    { "_id": "...", "title": "...", "beginAt": "...", "endAt": "...", "rule": "oi", "pids": [1, 2] }
  ],
  "contestResults": [
    {
      "domainId": "system",
      "contestId": "...",
      "uid": 1,
      "totalScore": 300,
      "acCount": 3,
      "problemCount": 5,
      "submissions": [
        { "pid": 1, "score": 100, "status": 1, "time": 100, "memory": 65536, "lang": "cc.cc14o2" }
      ]
    }
  ]
}
```

## 身份标签（`realname_flag`）

| 值 | 标签 | 公开剪贴板 | Wiki 编辑 |
|----|------|-----------|----------|
| 0 | 未实名 | ❌ | ❌ |
| 1 | 已实名 | ✅ | ❌ |
| 2 | 老师 | ✅ | ❌ |
| 3 | 管理员 | ✅ | ✅ |

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
- 创建/编辑：`realname_flag === 3`（管理员）
- 删除/导入/分类管理：`PRIV_MOD_BADGE`
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

令牌认证通过 `handler/before` 事件钩子拦截，在 Hydro v5 的 handler 生命周期中（`prepare()` 之后、`get()`/`post()` 之前）执行。认证成功后，请求将以令牌所属用户的身份执行，但写操作会被强制拦截。

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
- `/problem/*`, `/p/*` — 题目
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

1. **HTTP 方法拦截**：`POST` / `PUT` / `DELETE` / `PATCH` 在 `handler/before` 阶段直接抛出 `Read-only token cannot perform write operations`
2. **路由白名单拦截**：不在白名单中的路径抛出 `This route is not available via token`
3. 双重拦截均在 handler 方法体执行之前，不会触及任何数据库写操作

### 典型场景

- **AI Agent 数据接入**：让 AI Agent 通过 Token 拉取题目、提交记录、排行榜等数据进行分析
- **MCP 工具集成**：为 MCP Server 提供安全的只读凭证，避免暴露账号密码
- **自动化报表脚本**：定时脚本通过 Token 读取 OJ 数据生成统计报表
- **第三方数据同步**：与其他系统对接时仅暴露只读权限

