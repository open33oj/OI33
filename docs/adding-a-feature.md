# 新增一个功能

以「假设要加一个 `sticker`（贴纸）功能」为例，按顺序做完这几步即可。每一步都有对应的
校验，做完跑 `npm run check` 应全绿。

## 0. 先决定边界

- 功能名（目录名、路由前缀、集合前缀）用小写 kebab：`sticker`、`cat-map`。
- 数据集合：`oi33_sticker`、`oi33_sticker_log`。
- 路由：`/oi33/stickers`、`/oi33/stickers/:id`，路由名 `oi33_sticker_*`。
- 页面标题：`oi33_sticker` → `locales/zh.yaml` 的 `oi33_sticker: '贴纸'`。

## 1. model：目录 + 公开入口

文件少就一个 `model/sticker.ts`；一旦出现「规则 / 持久化 / 迁移」三类东西，就建目录：

```
model/sticker/
  index.ts         export * from './rules'; export * from './store'; ...
  rules.ts         纯规则：尺寸、数量、价格、合法性
  rules.test.ts
  store.ts         集合 + CRUD + 索引
```

`rules.ts` 只能有纯函数（不 import hydrooj / DB / DOM），这样 `node --test` 能直接跑。
如果它需要 `shared/` 里的常量，import 必须带 `.ts`：

```ts
import { STICKER_MAX_SIDE } from '../../shared/sticker.ts';
```

`model/sticker/index.ts` 是唯一对外的门面：

```ts
export * from './rules';
export * from './store';
```

如果功能要和其它模型互相调用，把共享部分放进单独的 `shared.ts`，不要让两个文件互相 import
（循环依赖会在启动顺序上咬人）。

## 2. 集合类型 + 桶

在 `model/types.ts` 写 `Oi33Sticker`，然后在 `model/index.ts`：

```ts
import * as stickerModel from './sticker';
...
export { stickerColl } from './sticker';
...
const oi33Model = { ..., ...stickerModel };
...
interface Collections {
    oi33_sticker: import('./types').Oi33Sticker;
}
```

漏了这一步，`global.Hydro.model.oi33` 里就没有你的函数；`check:structure` 会直接报错。

## 3. handler：路由表与 Handler 分文件

小功能一个文件即可；多页面就建目录，形状照抄 `handler/medal/`：

```
handler/sticker/
  index.ts        apply(ctx) —— 只放路由与事件订阅
  manage.ts       Handler 类
  pages.ts
  shared.ts       表单解析/校验（纯函数）
```

`index.ts`：

```ts
import { Context, PRIV } from 'hydrooj';
import { StickerListHandler, StickerSaveHandler } from './manage';

export async function apply(ctx: Context) {
    ctx.Route('oi33_sticker_list', '/oi33/stickers', StickerListHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_sticker_save', '/oi33/stickers/save', StickerSaveHandler, PRIV.PRIV_USER_PROFILE);
}
```

约定：

- 路由名 `oi33_*`、路径 `/oi33/...`（`check:structure` 强制）。
- Handler 里需要 `domainId` 时：方法有 `@param` / `@query` 装饰器 → `domainId` 是第一个参数；
  没有装饰器 → 不注入。这是最容易写错的一处。
- 权限：路由级只挂 `PRIV`；OI33 的 `realname_flag` 判定用 `checkOi33Admin(this.user._id)` /
  `checkUserFlag(...)`，放在 Handler 里。
- 列表页渲染用户必须 `UserModel.getList` + `getUserDataByUids` + `mergeOi33Fields`，不要用
  `getListForRender` 渲染 `user.html`。
- POST 表单模板里必须有 `csrfToken` 隐藏域。
- 写操作都要 `addLog(...)`（审计日志）。

## 4. 挂到插件入口

`index.ts` 的 `parts` 数组里加一行：

```ts
['sticker', applySticker],
```

`applyPart` 会隔离单个功能的启动异常；但新功能仍然要保证 `apply()` 自己幂等、不抛错。

## 5. 模板

```
templates/oi33_stickers.html
templates/oi33_sticker_manage.html
```

- 顶部 `{% extends "layout/basic.html" %}`，并 `{% set page_name = "oi33_stickers" %}`。
- 在 `locales/zh.yaml` 登记 `oi33_stickers: '贴纸列表'`。
- 覆盖 core 模板必须同名同路径，不能被放进子目录（Hydro 用相对路径查模板）。
- 难度一律走 `partials/oi33_difficulty.html`；表格用 core 的 `.data-table` 与
  `components/paginator.html`。

## 6. 前端（可选）

入口必须是 `frontend/sticker.page.ts`（顶层才会被打包）：

```ts
import { AutoloadPage, NamedPage, addPage } from '@hydrooj/ui-default';
import './sticker.css';

addPage(new NamedPage(['oi33_stickers'], () => {
    // DOM 级委托，pjax 安全
}));
```

- 逻辑多时拆到 `frontend/sticker/` 子目录，由入口 import；子目录里的文件不要叫
  `*.page.ts`（会被当成第二个入口）。
- 浮动面板、拖拽这类有全局监听的功能，在 `NamedPage` 的第三个回调里清理监听。
- 需要服务端常量的，放 `shared/sticker.ts`，不要 import `model/`。

## 7. 需要迁移时

在 `migrate.ts` 里按现有格式追加一步（`Step N`），保持幂等：先预览、再执行、失败只记录到
`result.errors` 不中断其它步骤。迁移逻辑复杂时抽到 `model/sticker/migrate.ts`，由
`migrate.ts` 调用。

## 8. 验证清单

```bash
npm run typecheck
npm run typecheck:frontend
npm run lint
npm test
npm run check:structure
npm run check              # 上面全部
```

另外建议手工确认：

- 未登录 / 未实名 / flag=2 / flag=3 四种身份下的页面与 POST 行为。
- 路由清单没变少：`node scripts/check-structure.mjs --routes`。
- 服务端模块图能打包：`npx esbuild index.ts --bundle --platform=node --external:hydrooj --external:'@hydrooj/*' --outfile=/tmp/oi33.js`。

## 常见坑

| 坑 | 后果 | 正确做法 |
| --- | --- | --- |
| 用 `SystemModel.set` 存高频状态 | 每次写都广播、重建前端 bundle | 存 `oi33_*` 集合 |
| Handler 里 `db.collection(...)` 直接查 | 绕过审计/缓存，难测试 | 逻辑放 model，handler 只调 model |
| 前端 import `../model/xxx` | 可能把服务端代码打进浏览器 | 共享部分放 `shared/` |
| 规则模块 import 无扩展名 | `node --test` 解析失败 | 运行时 import 带 `.ts` |
| 覆盖模板改名/挪目录 | 不再覆盖 core，页面回退旧版 | 保持同名同路径 |
| 新增 model 忘记挂桶 | `oi33Model` 里找不到 | 改 `model/index.ts`，跑 `check:structure` |
