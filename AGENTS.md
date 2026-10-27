# OI33 — 33OJ Unified Hydro Plugin

把 coin、birthday、badge、realname、checkin、pastebin、猫罐头经济、奖章/拍卖、AI 题意/审核、
wiki、OAuth 等整合为**单个** Hydro addon：入口 `index.ts` 按功能 `apply`，数据全部在
`oi33_*` 集合，model 统一经 `model/index.ts` 的 `oi33Model` 桶导出。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 分层、目录、路由/模板/前端/数据/测试约定 |
| [docs/adding-a-feature.md](docs/adding-a-feature.md) | 新增功能的逐步清单 |
| [docs/features/medal.md](docs/features/medal.md) | 奖章：四系列、等级、展示墙、导入导出 |
| [docs/features/cat.md](docs/features/cat.md) | 猫咪地图、路径规划、大猫与周奖励 |
| [docs/features/economy.md](docs/features/economy.md) | 猫粮/罐头、市场、拍卖、合同、盲盒 |
| [docs/features/algorithm.md](docs/features/algorithm.md) | 算法掌握（NOI 大纲、月度自评额度） |
| [docs/features/ai.md](docs/features/ai.md) | AI 客户端、审核引擎、bio、题解/讨论审核 |
| [docs/features/community.md](docs/features/community.md) | 喵喵、题解、题目讨论、Wiki、OC 赛制 |
| [docs/features/accounts.md](docs/features/accounts.md) | 身份/主档、OAuth、Token、Paste、评测机监控 |
| [docs/features/ops.md](docs/features/ops.md) | `/oi33/admin/ops`：健康状态与运维动作 |
| [docs/patches.md](docs/patches.md) | 17 处 monkey-patch 与 25 个 core 模板覆盖清单 |
| [API.md](API.md) | Bearer Token 只读 API（MCP/Agent） |

## 目录

```
index.ts              入口：patches + 各功能 apply + 定时任务
migrate.ts            /oi33/migrate 的 18 步迁移（幂等、可预览）
model/
  index.ts            oi33Model 桶 + Collections 类型（唯一挂 global.Hydro.model）
  types.ts            所有集合的字段类型（纯类型）
  medal/              definition · award · initial · migrate · definitions · rules(+test)
  cat/                eligibility · map · map-player · map-admin · map-plan(-rules)
                      can · account · school-shared · school · school-player
                      school-transfer · school-reward
  <feature>.ts        单文件功能：user · ai · moderate · algorithm · meow · blindbox
                      auction · contract · oauth · token · paste · wiki · log 等
handler/
  medal/              index(路由表) · manage · award · pages · showcase · shared · redirects
  cat/                index(子入口) · can · plan · account · school
  ai/                 index · prompts · summary · analyze · admin
  patches/            所有 monkey-patch
  <feature>.ts        单文件功能路由（含 admin.ts 仪表盘与 ops.ts 运维页）
templates/            oi33_* 自有模板 + 与 core 同名同路径的覆盖模板
frontend/             浏览器入口：只有顶层 *.page.ts 会被打包
shared/               前后端共享的纯模块（不 import hydrooj / DB / DOM）
data/                 随插件分发的只读数据（OIerDB 学校表）
docs/                 架构、功能细节、新增功能指南
locales/zh.yaml       中文文案与页面标题
```

## 硬规则（容易踩坑）

1. **domainId 注入**：handler 方法有 `@param/@query` 装饰器 → `domainId` 是第一个参数；
   没有装饰器 → 不注入。
2. **权限**：公开 < 登录（PRIV_USER_PROFILE）< OI33 flag≥2（管理）< flag=3（行政）< PRIV_ALL。
   路由级只挂 Hydro `PRIV`；`realname_flag` 判定在 Handler 内用 `checkOi33Admin` / `checkUserFlag`。
3. **未认证（flag<1）**：全站匿名成 `UID n`；禁止签到、地图、喂猫、交易、发喵喵、新建/编辑
   paste、收猫粮、自动奖章。Hydro 虚拟用户（`vuser`，负数 uid）例外，不匿名化，置 `oi33_virtual`。
4. **用户列表渲染**：`UserModel.getList` + `getUserDataByUids` + `mergeOi33Fields`；
   禁止用 `getListForRender` 渲染 `user.html`。
5. **功能目录契约**：`model/<feature>/index.ts` 与 `handler/<feature>/index.ts` 是公开入口；
   新模块必须挂进 `model/index.ts` 的桶；路由只在功能入口的 `apply(ctx)` 里注册。
   `npm run check:structure` 会校验路由可达性、模板引用、桶覆盖与目录 index。
6. **纯规则与测试**：可单测的判定放 `rules.ts`（或 `*-rules.ts`），旁边必须有同名 `.test.ts`；
   规则模块不得 import hydrooj/DB/DOM。若 import 其它运行时模块，specifier 必须带 `.ts`
   （`node --test` 的原生 type-stripping 不做无扩展名解析）。
7. **模板**：覆盖 core 必须**同名同路径**（Hydro 以相对路径作模板 key），不能挪进子目录；
   有 `{% set page_name = "oi33_xxx" %}` 必须在 `locales/zh.yaml` 登记标题；POST 表单带
   `csrfToken`；难度渲染走 `partials/oi33_difficulty.html`。
8. **不要用 `SystemModel.set` 存高频写的状态**：它默认广播 `system/setting`，会让
   `@hydrooj/ui-default` 全量重建前端 bundle。高频状态一律存 `oi33_*` 集合；
   `SystemModel` 只留给「低频写 + 读在热路径」的配置（如奖章接受题目域）。
9. **写路径**：每次写操作 `addLog`；金额增减只走 `adjustCatCans` / `grantCatFood`；
   额度/占位要原子、失败要回滚；对外操作要幂等（可重放、可重试）。
10. **前端**：只有 `frontend/` 顶层 `*.page.ts` 会被打包；被 import 的模块不要命名成
    `*.page.ts`。前后端共用的常量/纯函数放 `shared/`，不要从 `frontend` import `model/`。
11. **奖章**：新建时同 ID 已存在必须报错；保存表单带 `editing`；一般奖章重复获得靠
    `count` 累加，星级是派生值。**猫咪**：格子 `catId` 非负学校 id 编码为 `schoolId+1`，
    特殊大猫用负数；计划模块单向依赖 `map-player/map`。
12. **运维**：启动失败的部件、定时任务状态、修复动作集中在 `/oi33/admin/ops`；
    新增后台修复能力请挂到那里，而不是散落在临时脚本里。

## 开发校验

```bash
npm run typecheck           # 后端 tsc（第三方诊断被过滤，项目代码必须 0 错）
npm run typecheck:frontend  # 前端 page 脚本与 shared/
npm run lint                # eslint（非类型感知）
npm run check:structure     # 路由/模板/桶/规则测试结构检查
npm test                    # 纯函数单测 + locale 校验
npm run check               # 以上全部（提交/发版前跑）
```

- CI/本地统一 `npm ci`；不要把 `node_modules` 软链到其它 checkout（会把 TypeScript 版本带偏）。
- `scripts/typecheck.mjs` 以 tsc 退出码为准：没有 `file:line:col` 前缀的配置级错误也会判失败。
- `tsconfig.json` 不使用 `baseUrl`（TS 6 会把它当硬错误；`paths` 自 TS 4.1 起相对 tsconfig 解析）。
- 新增页面记得补 `locales/zh.yaml` 标题（`check:locales` 强制）。

## 安装

```bash
hydrooj addon add /path/to/oi33 && pm2 restart hydrooj
# 访问 /oi33/migrate 跑迁移（幂等），再到 /oi33/admin/ops 看健康状态
```
