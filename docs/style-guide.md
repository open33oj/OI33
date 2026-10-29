# OI33 前端配色规范

> 目标：全站中性色（背景 / 文字 / 边框 / 悬停态）都能被用户主题覆盖；语义色和画布数据色保持稳定。
> 代码位置：`templates/partials/oi33-content.css`（共享工具类）、`templates/partials/oi33-shell.css`（外壳变量）、
> `model/theme-rules.ts`（用户主题 CSS）。

## 1. 颜色令牌

优先使用 CSS 变量，不要再写死中性灰或白底。

| 变量 | 用途 | 来源 |
| --- | --- | --- |
| `--oi33-page-bg` / `--oi33-page-fg` | 页面背景 / 主文字 | 用户主题（可空） |
| `--oi33-page-muted` / `--oi33-page-border` | 页面次级文字 / 边框 | 由页面文字色派生 |
| `--oi33-card-bg` / `--oi33-card-fg` | 默认卡片背景 / 文字 | 用户主题，空时依次跟随侧栏 / 顶栏 / 页面 |
| `--oi33-card-muted` / `--oi33-card-border` / `--oi33-card-hover` | 卡片次级文字 / 边框 / 悬停 | 由卡片文字色派生 |
| `--oi33-topbar-bg` | 顶栏背景 | 用户主题 |
| `--oi33-sidebar-bg` | 侧栏背景 | 用户主题 |
| `--oi33-text` / `--oi33-muted` / `--oi33-border` / `--oi33-hover` | 外壳默认文字 / 次级 / 边框 / 悬停 | `oi33-shell.css` 的 `:root`（含暗色覆盖） |
| `--oi33-accent` / `--oi33-accent-strong` / `--oi33-accent-weak` | 强调色 / 深色 / 浅底 | 用户主题；默认蓝 |
| `--oi33-radius` / `--oi33-card-shadow` | 卡片圆角 / 阴影 | `oi33-shell.css`，亮/暗各一套 |

使用示例：

```css
.oi33-foo-help { color: var(--oi33-card-muted, var(--oi33-muted)); }
.oi33-foo-surface { background: var(--oi33-card-hover, var(--oi33-hover)); }
.oi33-foo-link { color: var(--oi33-accent); }
```

不要在深色规则里重复写一套灰色，例如旧写法：

```css
/* 不要新增这种 */
.x { color: #666; }
.theme--dark .x { color: #aaa; }
```

改为：

```css
.x { color: var(--oi33-card-muted, var(--oi33-muted)); }
```

## 2. 共享工具类

新增页面优先使用这些类，而不是内联 `style="color:#..."`：

- `.oi33-muted`：次级文字。
- `.oi33-hint`：次级说明文字 + `.9em`。
- `.oi33-link-action`：行内操作链接（强调色，替代 `style="color:var(--accent-color,#55b6e2)"`）。
- `.oi33-ok` / `.oi33-warn` / `.oi33-bad` / `.oi33-info`：语义状态色（亮/暗各自有默认值）。

布局和控件继续使用 Hydro 标准类：`.section`、`.section__header/body/footer`、`.data-table`、
`.button`、`.textbox`、`.select`、`.typo`、`.supplementary`。不要为同一概念再造一套 `div` 结构。

## 3. class 命名

- 跨页面/共享组件：`oi33-*`，并优先放进 `oi33-content.css` 或 `oi33-shell.css`。
- 单个页面/功能内部：可用功能前缀（`ai33-*`、`bio33-*`、`meow-*`、`auction-*`、`theme-*`、
  `hidden-*`、`draw-*`、`oi33-wall-*` 等），但不要跨页面复用同名的通用类。
- 模板内 `<style>` 只放该页独有的布局/组件样式，颜色必须走变量或工具类。
- 新增 `data-*` 钩子给前端 JS 用，不要用样式类选择器当行为钩子。

目前 `auction-*`、`theme-*`、`hidden-*` 是页面内命名空间，虽不是 `oi33-` 前缀，但没有跨页复用；
如果以后要共享，再迁到 `oi33-*`。

## 4. 允许写死颜色的例外

以下颜色有语义/数据含义，不跟随用户主题：

- 评测状态、难度、奖章/徽章、抽奖运势、文件 I/O 标记等状态色；
- 奖章、猫咪、像素画、奖章墙的画布数据色和调色板；
- 图表系列色（猫账户曲线等）；
- 用户自定义徽章颜色（`user-profile-badge` 的 inline 背景/文字色）、抽奖结果的 `color` 字段；
- 图片、头像、外链内容、代码高亮 token。

这些场景应保留在组件内部，不要把它们接到 `--oi33-accent` 等主题变量上，否则会丢失语义。

## 5. 边界

- 用户主题/自定义 CSS 只覆盖页面、默认卡片、顶栏、侧栏、卡片内普通表单控件和正文链接；
  不覆盖弹窗/下拉浮层、画布、图表、代码高亮和状态色。
- 亮色/暗色必须分开生成；不要只写一套颜色然后期望暗色自动可用。
- 自定义 CSS 只允许 `background-color` / `color`，选择器白名单见 `THEME_CSS_SELECTORS`。
- 不要新增 `!important` 去压主题；用变量和合理的选择器层级。

## 6. 现状与待办

已完成：

- `oi33-content.css` 的标题、目录、徽章外框等中性色改为主题变量；
- 卡片统一 12px 圆角、细边框、轻阴影和 18/22px 内边距；
- 顶栏 52px、侧栏 232px，顶栏链接改为 pill hover，侧栏分组标签/激活态重新排版；
- 首页 hero 改为主题渐变 + 大像素 logo + 域名 pill；讨论列表增加行悬停与底部「更多」样式；
- 讨论/比赛/题解列表（`contest-main.css`）、奖章展示墙（`medal-showcase.css`）、
  猫账户（`cat-account.css`）的次级文字/边框/背景改为变量；
- 模板内 176 处裸灰 `#666/#777/#888/#999/#aaa` 已统一为 `--oi33-card-muted`；
- `--accent-color` 已统一为 `--oi33-accent`；
- 算法管理、审核、盲盒日志、简介审查等页面的说明文字改用工具类/变量；
- 新增 `.oi33-muted` / `.oi33-hint` / `.oi33-link-action` / `.oi33-ok|warn|bad|info`。

仍需按页面逐步处理（非阻塞）：

- 约 50 个模板仍有页面内 `<style>`；颜色已多数变量化，但部分背景/边框仍是固定浅色，后续可继续迁移。
- `cat.css`、`cat-can-arena.css`、`draw.css`、`medal-showcase.css` 的画布/猫咪绿色调是功能视觉，
  没有强行改成用户强调色；只把通用文字/边框接入了变量。
- 动态徽章、运势、奖章等级、评测状态等 inline 颜色继续保留。

## 7. 提交前检查

- 新增中性色是否使用了变量/工具类；
- 是否同时检查亮色和暗色；
- 是否误改了语义色/画布色；
- 页面内联 `style` 是否只用于布局或动态颜色；
- `npm run check`（类型、lint、单测、locale、结构）。
