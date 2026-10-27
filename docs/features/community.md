# 社区内容（喵喵 / 题解 / 讨论 / Wiki）

> 代码：`model/meow.ts`、`model/solution-feature.ts` + `-rules.ts`、
> `handler/meow.ts`、`handler/solution.ts`、`handler/discuss.ts`、`handler/wiki.ts`、
> `handler/contest.ts`（OC 赛制）。

## 喵喵（短博客）

- 集合：`oi33_meow_post`、`oi33_meow_follow`、`oi33_meow_like`。
- 发帖走审核引擎（`evaluateContent` + `moderateContentInBackground`）：未实名不能发；
  `pending` 仅本人/管理员可见。
- 页面：`/oi33/meow`（广场）、`/oi33/meow/user/:uid`、关注/粉丝列表。
- `/oi33/meow/admin` 只做全量查看与删除；**待审队列已并入 `/oi33/ai/moderation#meow`**。
- 奖章发放**不再自动发喵喵**（自动规则、管理员发放、拍卖、合同、盲盒都不发）；
  旧数据里的奖章公告保留，撤销奖章时顺手删除对应旧公告。

## 题解

- **全部题解时间线**：`GET /oi33/solutions`（`PERM_VIEW_PROBLEM_SOLUTION`），按 `_id`
  倒序分页列出所有非 hidden 题解；入口在讨论区侧栏组件，不占顶部导航。
- **题解加精**：用户每天可申请 1 篇，AI 自动审核并私信修改建议；管理员仍可强制加精/取消。
  题解只有隐藏 / 发布 / 精华三态，每人对每题只能有一篇。详见
  [solution-feature.md](solution-feature.md)。
- **题解审核**：与讨论共用规则+AI+人工队列，详见 [ai.md](ai.md)。

## 题目讨论

- 题目页讨论（`parentType = TYPE_PROBLEM`）不再出现在 `/discuss` 与首页讨论组件，
  集中到 `/oi33/discuss/problem`（复用 core `partials/discussion_list.html`）。
- 讨论侧栏组件 `templates/partials/discussion_nodes_widget.html` 提供
  「题目讨论 / 全部题解」入口。

## Wiki

- 集合：`oi33_wiki`、`oi33_wiki_category`；分类 + Markdown 页面 CRUD + JSON 批量导入导出。
- 页面：`/oi33/wiki`、`/oi33/wiki/categories`、`/oi33/wiki/pages`、`/oi33/wiki/:id`；
  仅管理员可编辑。

## OC（One Chance）赛制

- `ContestModel.RULES.oc`，基于 core `ioi` 规则构建；每题按个人时限内第一次提交计排名分，
  括号显示比赛内最高分。
- **补题**：个人时限（`startAt + duration`，封顶比赛 `endAt` 与提前结束 `tsdoc.endAt`）
  之后仍可在比赛内提交，记录标记 `late`：不计排名分、只计括号最高分。
- 实现要点：包装 `ProblemSubmitHandler.prepare` 放行已参赛用户的 `ContestNotLiveError`，
  `ProblemDetailHandler._prepare` 赛后保持 `mode='contest'`；`handler/after/ProblemSubmit#post`
  与 `record/judge` 触发 `recalcOcStatus` 重打 `late` 标记并重算。
- 文案在 `locales/zh.yaml` 的 Contest Rules 节；比赛列表配色在 `frontend/contest-oc.css`。
