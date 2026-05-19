# OI33 / Hydro API Reference for MCP / Agent

本文档供 MCP Server 开发者、AI Agent 集成者参考，说明如何通过 **Bearer Token** 程序化访问 33OJ 的全部数据。

> **只读保证**：Token 认证的用户只能执行 `GET` / `HEAD` / `OPTIONS` 请求。任何 `POST` / `PUT` / `DELETE` / `PATCH` 请求均会在 `handler/before` 阶段被拦截，抛出 `Read-only token cannot perform write operations` 错误。Token 不会、也无法修改任何数据。

---

## 认证方式

在 HTTP Header 中携带：

```
Authorization: Bearer 33tok_xxxxxxxx...
```

所有示例均以此方式发送请求。

---

## Hydro v5 通用约定

Hydro v5 移除了 GraphQL，改为 **RESTful 路由 + `?noTemplate=1`** 模式：

- 在任意 Hydro 路由后加 `?noTemplate=1`，框架会将 `response.body` 序列化为 JSON 返回
- 不加则返回渲染后的 HTML 页面
- `?download=1` 用于触发资源的直接下载（如提交代码、题目数据）

### 响应格式

加 `?noTemplate=1` 时，返回 `Content-Type: application/json; charset=utf-8`：

```json
{
  "udoc": { "_id": 2, "uname": "...", "mail": "...", "priv": -1 },
  "rdoc": { "_id": "...", "status": 6, "uid": 2, "code": "", "lang": "..." },
  "pdoc": { "_id": "...", "title": "...", "pid": "..." }
}
```

> `udoc` 是提交者/所有者信息，`rdoc` / `pdoc` 等视具体页面而定。

---

## 一、Hydro 核心 API

### 1.1 提交记录（Record）

| 端点 | 说明 |
|------|------|
| `GET /record?all=true&noTemplate=1` | 提交记录列表 |
| `GET /record?uidOrName=<uid>&noTemplate=1` | 某用户的提交记录 |
| `GET /record/:rid?noTemplate=1` | 单条记录详情 |
| `GET /record/:rid?download=1` | **下载提交代码**（纯文本） |
| `GET /record/:rid/data?noTemplate=1` | 原始提交数据 |

```bash
# 获取提交记录列表
curl -H "Authorization: Bearer 33tok_xxx" \
     "https://oj-domain/record?all=true&noTemplate=1"

# 获取单条记录详情
curl -H "Authorization: Bearer 33tok_xxx" \
     "https://oj-domain/record/6a0b367330bb99ea64b46e07?noTemplate=1"

# 下载提交代码（返回纯文本，Content-Disposition: attachment）
curl -H "Authorization: Bearer 33tok_xxx" \
     "https://oj-domain/record/6a0b367330bb99ea64b46e07?download=1"
```

> **代码查看规则**：`download=1` 能否拿到代码取决于 Hydro 内部逻辑。如果 token 所属用户是提交者本人（`rdoc.uid === this.user._id`），则一定能拿到；否则需要 `PRIV_READ_RECORD_CODE` 权限。

### 1.2 题目（Problem）

| 端点 | 说明 |
|------|------|
| `GET /problem?all=true&noTemplate=1` | 题目列表 |
| `GET /problem?pid=<pid>&noTemplate=1` | 按题目编号查 |
| `GET /p/<pid>?noTemplate=1` | 题目详情页 |
| `GET /p/<pid>/data?noTemplate=1` | 题目测试数据信息 |
| `GET /p/<pid>/solution?noTemplate=1` | 题解 |

```bash
# 题目列表
curl -H "Authorization: Bearer 33tok_xxx" \
     "https://oj-domain/problem?all=true&noTemplate=1"

# 题目详情（pid 为展示编号，如 D0672）
curl -H "Authorization: Bearer 33tok_xxx" \
     "https://oj-domain/p/D0672?noTemplate=1"
```

### 1.3 比赛 / 作业（Contest / Homework）

| 端点 | 说明 |
|------|------|
| `GET /contest?all=true&noTemplate=1` | 比赛列表 |
| `GET /contest/:tid?noTemplate=1` | 比赛详情 |
| `GET /contest/:tid/rank?noTemplate=1` | 比赛排行榜 |
| `GET /homework?all=true&noTemplate=1` | 作业列表 |
| `GET /homework/:tid?noTemplate=1` | 作业详情 |

```bash
curl -H "Authorization: Bearer 33tok_xxx" \
     "https://oj-domain/contest?all=true&noTemplate=1"
```

### 1.4 用户（User）

| 端点 | 说明 |
|------|------|
| `GET /user/:uid?noTemplate=1` | 用户个人页 |
| `GET /user/:uid/status?noTemplate=1` | 用户做题统计 |
| `GET /ranking?noTemplate=1` | 全站排名 |
| `GET /ranking?day=<n>&noTemplate=1` | 近 n 天活跃排名 |

```bash
curl -H "Authorization: Bearer 33tok_xxx" \
     "https://oj-domain/user/2?noTemplate=1"
```

### 1.5 讨论（Discussion）

| 端点 | 说明 |
|------|------|
| `GET /discuss?noTemplate=1` | 讨论节点列表 |
| `GET /discuss/:did?noTemplate=1` | 某节点下的帖子 |
| `GET /discuss/:did/:drid?noTemplate=1` | 单条帖子详情 |

### 1.6 训练（Training）

| 端点 | 说明 |
|------|------|
| `GET /training?noTemplate=1` | 训练列表 |
| `GET /training/:tid?noTemplate=1` | 训练详情 |

---

## 二、OI33 插件 API

所有 OI33 路由在 Hydro 路由体系内运行，同样支持 `?noTemplate=1`。

### 2.1 硬币系统

| 端点 | 说明 | 权限 |
|------|------|------|
| `GET /oi33/coin/show?noTemplate=1` | 重定向到 `/oi33/users` | 登录用户 |
| `GET /oi33/coin/bill/:uid?noTemplate=1` | 某用户的硬币账单 | 自己 / 管理员 |
| `GET /oi33/users?noTemplate=1` | 全部用户数据（含硬币、生日、实名等） | 管理员 |

```bash
# 查看全部 OI33 用户数据（需管理员 token）
curl -H "Authorization: Bearer 33tok_xxx" \
     "https://oj-domain/oi33/users?noTemplate=1"

# 查看某用户硬币账单
curl -H "Authorization: Bearer 33tok_xxx" \
     "https://oj-domain/oi33/coin/bill/2?noTemplate=1"
```

### 2.2 生日系统

| 端点 | 说明 | 权限 |
|------|------|------|
| `GET /oi33/birthday?noTemplate=1` | 今日寿星 | 公开 |
| `GET /oi33/birthday/all?noTemplate=1` | 全部生日列表 | 登录用户 |

### 2.3 徽章系统

| 端点 | 说明 | 权限 |
|------|------|------|
| `GET /oi33/badge?noTemplate=1` | 查看所有徽章 | 登录用户 |
| `GET /oi33/badge/manage?noTemplate=1` | 徽章管理页 | 管理员 |

### 2.4 签到系统

| 端点 | 说明 | 权限 |
|------|------|------|
| `GET /oi33/checkin` | 签到（会写入数据库） | 登录用户 |

> ⚠️ `/oi33/checkin` **不在 Token 白名单中**。该路由的 `get()` 方法内部会调用 `doCheckin()` 写入签到记录，因此即使它是 `GET` 请求，Token 访问也会返回 `This route is not available via token`。

### 2.5 剪贴板（Pastebin）

| 端点 | 说明 | 权限 |
|------|------|------|
| `GET /oi33/paste/show/:id?noTemplate=1` | 查看剪贴板内容 | 公开（私有需权限） |
| `GET /oi33/paste/manage?noTemplate=1` | 我的剪贴板列表 | 登录用户 |
| `GET /oi33/paste/all?noTemplate=1` | 全部剪贴板（含私有） | 管理员 |

```bash
# 查看公开剪贴板
curl -H "Authorization: Bearer 33tok_xxx" \
     "https://oj-domain/oi33/paste/show/abc123?noTemplate=1"
```

### 2.6 Rating 排名

| 端点 | 说明 | 权限 |
|------|------|------|
| `GET /oi33/at-cf-rating?noTemplate=1` | AT/CF Rating 排名 | 公开 |
| `GET /oi33/at-cf-rating?sort=codeforces&noTemplate=1` | 按 Codeforces 排序 | 公开 |

```bash
curl -H "Authorization: Bearer 33tok_xxx" \
     "https://oj-domain/oi33/at-cf-rating?sort=atcoder&noTemplate=1"
```

### 2.7 审批系统

| 端点 | 说明 | 权限 |
|------|------|------|
| `GET /oi33/requests?noTemplate=1` | 待审批申请列表 | 管理员 |

### 2.8 管理仪表盘

| 端点 | 说明 | 权限 |
|------|------|------|
| `GET /oi33/admin?noTemplate=1` | 最近动态时间线 | 管理员 |

---

## 三、Token 管理 API

Token 本身的路由也需要认证：

| 端点 | 方法 | 说明 | 权限 |
|------|------|------|------|
| `/oi33/tokens` | `GET` | 查看令牌列表 | 登录用户（管理员看全部） |
| `/oi33/tokens/create` | `POST` | 创建新令牌 | `PRIV_ALL` |
| `/oi33/tokens/:id/delete` | `POST` | 删除令牌 | `PRIV_ALL` |

> Token 管理页面是 HTML 表单，不适合直接 API 调用。建议在浏览器中访问 `/oi33/tokens` 进行创建。

---

## 四、只读保证详解

### 4.1 双重拦截机制

Token 认证在 Hydro v5 handler 生命周期的 **`handler/before` 事件钩子** 中执行，采用 **方法限制 + 路由白名单** 双重拦截：

```
init → prepare → handler/before → [TOKEN CHECK] → get()/post() → after → finish
                                    ├─ 方法检查: 非 GET/HEAD/OPTIONS → 拦截
                                    └─ 路由检查: 不在白名单 → 拦截
```

### 4.2 第一层：HTTP 方法限制

```typescript
const READONLY_METHODS = new Set(['get', 'head', 'options']);

if (!READONLY_METHODS.has(h.request.method)) {
    throw new Error('Read-only token cannot perform write operations');
}
```

- `h.request.method` 已被框架归一化为小写
- `POST` / `PUT` / `DELETE` / `PATCH` 在 **handler 方法体执行前** 就被拦截

### 4.3 第二层：路由白名单

```typescript
const READONLY_ROUTE_PATTERNS = [
    /^\/record(\/|$)/,
    /^\/problem(\/|$)/,
    /^\/p\//,
    /^\/contest(\/|$)/,
    /^\/homework(\/|$)/,
    /^\/user\//,
    /^\/ranking(\/|$)/,
    /^\/discuss(\/|$)/,
    /^\/training(\/|$)/,
    /^\/oi33\/users(\/|$)/,
    /^\/oi33\/birthday(\/|$)/,
    /^\/oi33\/badge$/,
    /^\/oi33\/badge\/manage$/,
    /^\/oi33\/at-cf-rating(\/|$)/,
    /^\/oi33\/paste\/show\//,
    /^\/oi33\/paste\/manage(\/|$)/,
    /^\/oi33\/paste\/all(\/|$)/,
    /^\/oi33\/coin\/bill\//,
    /^\/oi33\/admin(\/|$)/,
    /^\/oi33\/requests(\/|$)/,
    /^\/oi33\/tokens(\/|$)/,
];

if (!READONLY_ROUTE_PATTERNS.some((re) => re.test(h.request.path))) {
    throw new Error('This route is not available via token');
}
```

白名单的设计原则：
- **精确匹配**：如 `/oi33/badge` 和 `/oi33/badge/manage` 是分开的正则，防止 `/oi33/badge/manage/2/del` 被误放行
- **前缀匹配**：如 `/record/` 匹配所有以 `/record` 开头的路径
- **显式排除**：已知的 GET 写操作路由（如 `/oi33/checkin`）不在白名单中

### 4.4 白名单覆盖范围

| 分类 | 状态 | 说明 |
|------|------|------|
| `/record/*` | ✅ 允许 | 提交记录查询、代码下载 |
| `/problem/*`, `/p/*` | ✅ 允许 | 题目列表与详情 |
| `/contest/*`, `/homework/*` | ✅ 允许 | 比赛、作业 |
| `/user/*`, `/ranking` | ✅ 允许 | 用户信息、排行榜 |
| `/discuss/*`, `/training/*` | ✅ 允许 | 讨论、训练 |
| `/oi33/users`, `/oi33/birthday` | ✅ 允许 | OI33 数据展示 |
| `/oi33/badge` | ✅ 允许 | 徽章展示（精确匹配） |
| `/oi33/badge/manage` | ✅ 允许 | 徽章管理页（精确匹配） |
| `/oi33/paste/show/*` | ✅ 允许 | 剪贴板查看 |
| `/oi33/at-cf-rating` | ✅ 允许 | Rating 排名 |
| `/oi33/admin`, `/oi33/requests` | ✅ 允许 | 管理页（需管理员权限） |
| `/oi33/tokens` | ✅ 允许 | Token 列表 |
| `/oi33/checkin` | ❌ 禁止 | GET 内部会写入签到记录 |
| `/oi33/badge/manage/*/del` | ❌ 禁止 | GET 内部会删除徽章 |
| `/oi33/coin/inc` | ❌ 禁止 | 非白名单（且 POST 会被方法拦截） |
| `/oi33/profile/edit/*` | ❌ 禁止 | 非白名单（且 POST 会被方法拦截） |
| 其他未列出的路径 | ❌ 禁止 | 默认不在白名单中 |

---

## 五、错误码参考

| 响应 | 说明 |
|------|------|
| `200 OK` + JSON | 请求成功，`?noTemplate=1` 生效 |
| `200 OK` + HTML | 请求成功，但返回了 HTML 页面（未加 `?noTemplate=1`） |
| `403` / `Error: Invalid or expired token` | Token 无效、过期或域名不匹配 |
| `403` / `Error: Read-only token cannot perform write operations` | 尝试用 Token 执行 POST/PUT/DELETE/PATCH |
| `403` / `Error: This route is not available via token` | 请求的 URL 不在 Token 白名单中 |
| `500` / `Serialize failure` | JSON 序列化失败（通常数据量过大） |
