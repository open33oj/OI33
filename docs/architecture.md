# 架构与约定

这份文档描述 OI33 重构后的目录形状与不可破坏的约定。新增功能前请先读
[adding-a-feature.md](adding-a-feature.md)，那里有一步不漏的清单。

## 目标

- **一层只做一件事**：`model/` 是数据与业务，`handler/` 只做路由与表单，`templates/` 负责渲染，
  `frontend/` 是浏览器脚本，`shared/` 是前后端都能用的纯常量/纯函数。
- **一个功能一个目录**：功能的公开 API 是目录里的 `index.ts`；目录内部怎么拆文件，外部不用知道。
- **纯规则与测试同目录**：凡是能被单测覆盖的判定（配额、阈值、分类、校验），都放进
  `rules.ts`，旁边必须有 `rules.test.ts`。
- **约定用脚本兜底**：`npm run check:structure` 校验路由、模板、桶（barrel）与规则测试，
  不靠人记。

## 目录

```
index.ts                  插件入口：挂 patches，按顺序 apply 各功能，启动定时任务
migrate.ts                /oi33/migrate 的 18 步迁移
model.ts                  Hydro 的 model 入口，转出 model/index.ts
model/
  index.ts                oi33Model 桶 + Collections 类型声明（唯一挂到 global.Hydro.model 的地方）
  types.ts                所有集合的字段类型（纯类型，无副作用）
  <feature>/              功能模块（medal、cat、…），见下
  <feature>.ts            还没有复杂到需要目录的功能（user、ai、meow、…）
  <feature>-rules.ts      纯规则；同名 .test.ts 是硬性要求
handler/
  <feature>/              功能路由目录：index.ts 注册路由，其它文件放 Handler
  <feature>.ts            只有一个入口文件的功能
  patches/                所有 monkey-patch（Hydro 升级时重点回归对象）
  ops.ts                  /oi33/admin/ops：健康状态与安全修复动作
  utils.ts                权限 / 用户加载等公共工具
templates/                Nunjucks：oi33_* 自有模板 + 与 core 同名同路径的覆盖模板
frontend/                 浏览器入口：只有顶层 *.page.ts 会被打包（见下）
shared/                   前后端共享的纯模块（不 import hydrooj / DB / DOM）：cat-map、medal-showcase
locales/zh.yaml           中文文案与页面标题
data/                     随插件分发的只读数据（OIerDB 学校表等）
scripts/                  校验脚本（check-locales / check-structure / typecheck）与运维脚本
docs/                     架构、开发流程
```

## 功能目录的形状

以 medal 为样板：

```
model/medal/
  index.ts          公开 API：export * from 下面各文件（顺序即依赖方向）
  definition.ts     集合、定义 CRUD、索引、域名配置
  award.ts          发放 / 撤销 / 升降级 / 统计 / 规则评估（两者互相调用，故同文件）
  initial.ts        内置 OJ 成就系列与像素图
  migrate.ts        一次性数据迁移（只被 migrate.ts 调用）
  definitions.ts    奖章定义 JSON 导入导出
  rules.ts          纯规则（分类、等级、展示、展示墙几何）
  rules.test.ts
handler/medal/
  index.ts          路由表（新增路由只改这里）+ record/judge 钩子
  manage.ts         管理页、编辑、配置、导入导出
  award.ts          发放 / 升级 / 撤销 / 扫描
  pages.ts          公开目录、持有者、用户奖章页、资料页注入
  showcase.ts       展示墙编辑
  shared.ts         表单解析与校验（纯函数）
  redirects.ts      旧 /oi33/achievements* 链接
```

`model/cat/` 遵循同样模式，并额外做了依赖分层：

```
eligibility.ts      实名准入（地图与大猫共用）
map.ts              地图数据、格子、领地统计
map-player.ts       小猫动作（加入/移动/染色/传送）
map-admin.ts        管理员绘图与强制迁移
map-plan.ts         路径计划执行
can.ts              猫罐头市场
account.ts          猫粮账本
school-shared.ts    大猫共享底座（集合、学校表、展示字段）
school.ts           大猫页面视图与特殊大猫
school-player.ts    绑定与投喂
school-transfer.ts  行政转移与贡献回填
school-reward.ts    周奖励结算
index.ts            汇总再导出
```

依赖方向：`index → 具体模块 → 共享底座`。任何模块都不反向 import 自己的 `index.ts`，
共享代码放底座文件而不是互相 import，避免循环。

## 路由

- 路由名必须是 `oi33_*`，路径必须在 `/oi33` 下；唯一的旧别名是
  `paste_show_legacy`（`/paste/show/:id`），白名单在 `scripts/check-structure.mjs`。
- 注册集中在功能的 `handler/<feature>/index.ts` 的 `apply(ctx)` 里。Handler 类放在同目录
  其它文件，由 `index.ts` import。
- 每个注册路由的文件要么导出 `apply()` 并被根 `index.ts` 挂载，要么被同功能入口 import
  （例如 `registerLegacyRedirects`）。
- 权限：路由级只表达 Hydro 的 `PRIV`；OI33 的 `realname_flag` 判定放在 Handler 内用
  `checkOi33Admin` / `checkUserFlag`，不要依赖路由 PRIV 表达身份等级。

## 模板

- 自有模板用 `oi33_*.html`，覆盖 core 的模板必须**同名同路径**（Hydro 以相对路径作为模板
  registry 的 key），所以覆盖模板只能放在 `templates/` 对应位置，不能挪进子目录。
  覆盖清单：`components/`、`partials/`、`layout/`、`user_detail.html`、`contest_*.html`、
  `problem_*.html`、`training_*.html`、`ranking.html`、`record_main.html`、`user_login.html`。
- 有 `{% set page_name = "oi33_xxx" %}` 的页面必须在 `locales/zh.yaml` 登记标题，
  `npm run check:locales` 会强制检查。
- `this.response.template` 与 `{% include %}` / `{% extends %}` 的目标必须存在，
  `scripts/check-structure.mjs` 会同时检查本地模板与 core 模板。

## 前端

- **只有 `frontend/` 顶层的 `*.page.ts` 会被 Hydro 打包**（`backendlib/builder.ts` 用
  `readdirSync` 且不递归）。所以入口文件必须留在顶层：`cat-can-arena.page.ts`、
  `medal-showcase.page.ts` 等。
- 逻辑可以拆到 `frontend/` 的子目录或普通模块（例如 `frontend/cat-can-arena/`），
  由入口 import；**不要**把被 import 的模块命名成 `*.page.ts`，否则它会被当成第二个入口
  重复打包。
- 页面脚本用 `AutoloadPage` / `NamedPage` 按 `page_name` 挂载；CSS 用 `import './x.css'`
  由 esbuild 注入（类型声明在 `frontend/css.d.ts`）。
- 前后端共用的常量/纯函数放 `shared/`（地图几何在 `shared/cat-map.ts`，展示墙在
  `shared/medal-showcase.ts`），前端不要直接 import `model/*`。

## 数据

- 所有业务数据在 `oi33_*` 集合；集合类型写在 `model/types.ts`，并在 `model/index.ts` 的
  `Collections` 声明里登记。
- 新模型模块必须挂进 `model/index.ts`：`import * as xModel from './x'` + 在 `oi33Model`
  里 `...xModel`，否则 `global.Hydro.model.oi33` 看不到它（`check:structure` 会报错）。
- 目录变成一个功能包时，`model/index.ts` 只 import 这个包的 `index.ts`，由包内 `export *`
  汇总；不同模块出现同名导出会在编译期报错，不会静默覆盖。

## 纯规则与测试

- `rules.ts`（或历史命名 `*-rules.ts`）不得 import hydrooj / DB / DOM，测试用
  `node --test` 直接跑 TS。
- 因此规则模块如果 import 另一个运行时模块，specifier 必须带 `.ts` 扩展名
  （`shared/medal-showcase.ts` 就是这样被 `model/medal/rules.ts` 引用的）：Node 的
  type-stripping 不做无扩展名解析。类型导入用 `import type` 单独一行，同样要带 `.ts`。
- 每个规则模块必须有同名 `.test.ts`（`check:structure` 强制）。

## 校验

| 命令 | 覆盖 |
| --- | --- |
| `npm run typecheck` | 后端 TS（忽略第三方依赖的诊断，项目代码必须 0 错） |
| `npm run typecheck:frontend` | 前端 page 脚本与 `shared/` |
| `npm run lint` | eslint（非类型感知） |
| `npm test` | 纯规则单测 + locale 校验 |
| `npm run check:structure` | 路由唯一性/前缀/挂载、模板引用、model 桶、规则测试 |
| `npm run check` | 以上全部 |

`scripts/typecheck.mjs` 以 tsc 的退出码为准：配置级错误（没有 `file:line:col` 前缀）也会
判失败，不会再出现「tsc 已经中止但脚本打勾」的假绿。
