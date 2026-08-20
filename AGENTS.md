# OI33 — 33OJ Unified Hydro Plugin

把多个 legacy 插件（coin、birthday、badge、realname、checkin、pastebin、猫罐头经济、成就/拍卖、AI 题意/审核、wiki、OAuth 等）整合为单个 Hydro addon。入口 `index.ts` 依次调用各 `handler/*.ts` 的 `apply(ctx)`；model 统一经 `model/index.ts` 的 `oi33Model` 桶导出，业务数据全部存在 `oi33_*` 集合（字段见 `model/types.ts`）。

## 目录

- `model/` 数据层：`user.ts`（oi33_user 主档：签到/猫粮/实名/徽章）、`cat-*.ts`、`school-cat.ts`、`achievement/auction/contract.ts`、`ai.ts`（AI 配置/用量/批量状态 `oi33_ai_batch`）、`moderate.ts`（审核队列 + `normalizeText`/`hashOf`/`bioHashOf`）、`log.ts`（审计日志，每次写操作都记）。
- `handler/` 路由与逻辑（`ctx.Route` 注册，路由表看代码）：`user/content/admin/profile/wiki/oauth/cat-*/school-cat/ai/moderate/meow/achievement/auction/contract/bio.ts`；`patches.ts` 所有 monkey-patch；`utils.ts` 的 `checkUserFlag`/`checkOi33Admin`。
- `templates/` Nunjucks，同名覆盖 core（`user_detail.html`、`components/user.html`、`layout/html5.html` 等）；`frontend/` 客户端 page 脚本；`locales/zh.yaml` i18n。

## 关键规则（容易踩坑）

- **domainId 注入**：handler 方法有 `@param/@query` 装饰器 → `domainId` 是第一个参数；没有装饰器 → 不注入。
- **权限**：公开 < 登录（PRIV_USER_PROFILE）< OI33 flag≥2（管理）< flag=3（行政）< PRIV_ALL。`realname_flag` 0 未认证/1 已认证/2 管理员/3 行政管理员。
- **未认证（flag<1）**：全站匿名化为 `UID <id>`（`mergeOi33Fields`+`anonymizeOi33Identity`）；禁止签到、地图、喂猫、买卖罐头、拍卖、合同、发喵喵、新建/编辑 paste、收猫粮、自动成就。
- **用户列表渲染**：必须 `UserModel.getList`（带 `hasPriv()`，`components/user.html` 依赖）+ `getUserDataByUids` + `mergeOi33Fields`；禁用 `getListForRender` 渲染 user.html。
- **模板**：POST 表单必带 `csrfToken` 隐藏域；难度渲染一律走 `partials/oi33_difficulty.html`（0-8 洛古难度，默认遮罩、前端点击显示）。
- **审核引擎复用**：`handler/moderate.ts` 的 `runAiVerdict(uid, normalized, hash, cfg)`（规则+AI+缓存+预算熔断，fail-closed），喵喵/讨论区/简介共用；开关 `moderation_enabled`（默认开）。
- **大猫（school-cat）**：地图格子 `catId` 编码为非负学校 id+1、特殊大猫负数原样，0=无大猫；**特殊大猫**用负数 `_id`（自定义 `name`，★ 不占数字名次，周奖励走管理员规则），是**唯一**的管理员大猫形式（旧 isAdminCat 手动设定已废弃，迁移会清除旧标记），仅 flag≥2 可搜索/绑定，flag≥3 可创建/改名；`transferSchoolCat`（flag≥3）把一只大猫的绑定用户/投喂历史/体重/领地格子整体转移到另一只并重算 territoryCount。周奖池 = 领地基础奖励（≥64 格起 1，翻倍 +1，封顶 12）× max(0, ⌊log2(体重)⌋−10)，按 ⌊log2(贡献)⌋ 权重最大余数法分配；结算完成后全体用户当前贡献与大猫体重各扣 5%（回滚不恢复）。成就仅稀有（saleable）或手动发放才自动发喵喵，用户可删自己的喵喵。**地图分区**：帝国区=距边框 250 格环形（前/后 250 行、左/右 250 列），中央 500×500（坐标 250~749）为 00区（`CAT_MAP_CORE_MIN/MAX`，前端 `cat-can-arena.page.ts` 有同步副本）；分界线画成 00区外框的加粗「口」字，由地图「帝国边界」图层开关控制（默认开）。00区内某格与上下左右四邻全归属同一大猫即为「领地核心」（`fortressCatIdAt`），禁止绑定其他大猫的小猫移动/加入进入；染色形成核心时滞留其上的小猫被驱逐（`displaceFortressIntruders`）——绑定了大猫的传送到自己领地随机格，未绑定的传送到帝国区随机位置，驱逐走 `oi33/cat-map-change` player 广播。

## 个人简介（bio）AI 审核

bio 是 Hydro 核心字段，编辑走 core `/home/settings/account`，本插件用 `handler/before|after/HomeSettings#post` 钩子介入（`handler/bio.ts`）：改动有 **2 小时冷却**（`bio_edited_at`）；变更后写 `bio_status:'pending'`+`bio_hash` 并后台 AI 审核：pass→approved；block/review/出错→rejected 隐藏并私信通知本人（含分类与理由；人工驳回只发「人工审核未通过」）。所有判定记入 `oi33_ai_moderation`（`kind:'bio'`，见 `/oi33/ai/moderation` 结果列表），review/出错进人工队列，管理员 approve/reject 直接翻转 bio 状态（哈希守卫，不会覆盖更新的编辑）。**显示规则**（`mergeOi33Fields` 算 `udoc.bio_visible`）：flag≥1 且 `bio_status==='approved'` 且 `bio_hash===bioHashOf(当前 bio)`——哈希不符（如 OAuth 回写）自动隐藏。展示点：user_detail tab 面板第一项「Bio」（未过审时本人见提示，`after/UserDetail` 钩子同时清空 JSON 里的 bio）、首页 ranking partial。初始批量审查：管理页 `/oi33/ai/bio-review`（flag≥2，幂等可重跑，进度存 `oi33_ai_batch` 的 `_id:'bio_review'`）。

## patches.ts 清单

`getList`/`getListForRender`/`getById`/`User.private` 注入 oi33 字段并匿名化；`HomeHandler.getCheckin/getCountdown` 首页数据；`handler/after/*` 兜底匿名化；Bearer `33tok_` 只读 token 鉴权（跳过 `/oi33/oauth/*`）；nunjucks `getTemplate` 启动竞态守卫。

## 安装

```bash
hydrooj addon add /path/to/oi33 && pm2 restart hydrooj
# 访问 /oi33/migrate 跑迁移（幂等）
```
