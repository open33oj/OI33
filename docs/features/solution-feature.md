# 题解与题解加精（AI 申请制）

> 代码：`model/solution-feature.ts` + `solution-feature-rules.ts`、
> `handler/solution.ts`、`handler/patches/display.ts`（列表顺序/可见性）、
> `templates/components/comments_solution.html`、`templates/oi33_solution_featured.html`。
> 集合：`oi33_solution_config`（奖励配置）、`oi33_solution_feature_apply`（申请记录）。

## 题解只有三种状态

| 状态 | 判定 | 谁能看到 |
| --- | --- | --- |
| 隐藏 | `hidden: true`（发布/编辑后 AI 审核未通过、或仍在人工队列） | 作者与管理员 |
| 发布 | `hidden` 为假、`featured` 为假 | 所有有权限的读者 |
| 精华 | `featured: true` | 所有人，列表里排最前 |

- 新题解/编辑后的题解先 `hidden`，后台 AI 审核；**通过则恢复发布，block/review 一律保持隐藏，绝不自动删除**。
- 人工审核「驳回」对题解也只是隐藏（作者可编辑后重新提交），不删除。
- block 会给作者私信原因；review 静默进人工队列。
- 隐藏题解的数量按「每人每道题一篇」计算：作者不能靠再发一篇绕过，只能编辑原题解等审核。

## 每人每道题只能有一篇题解

`handler/solution.ts` 在 `handler/before-operation/ProblemSolution`（`operation === 'submit'`）
里查 `(owner, parentId)` 是否已有题解，有则直接拒绝并提示去编辑。
编辑（`edit_solution`）不受限制。并发下存在极窄的竞态窗口（没有加唯一索引，因为 core 的
`document` 集合里可能已有历史重复数据）；如果以后要彻底堵住，先清理历史重复再加 partial
unique index。

## 用户申请加精

- 入口：题目题解列表里，作者自己的「已发布」题解右上角显示「申请精华」；已精华/隐藏/当天
  已申请时不显示或显示「今日已申请」。
- 条件：实名（flag≥1）、自己的题解、非隐藏、非精华。
- 额度：**每人每天 1 篇**（Asia/Shanghai 自然日）。额度用 `oi33_solution_feature_apply`
  的 `_id = "${uid}:${YYYY-MM-DD}"` 唯一键原子抢占；重复提交直接提示明天再来。
- 点击后立即返回「已提交」，AI 审核在后台跑，结果私信通知。

## AI 审核

- 默认提示词在 `solution-feature-rules.ts`：正确性 / 完整性（思路、复杂度、关键实现）/
  可读性 / 原创性；风格、篇幅、语言不扣分；只输出 JSON。**题解正文全文送审，不截断**
  （超长导致模型上下文超限时按 AI 异常退款）。
- 通过条件：模型 `pass === true` 且 `score >= featurePassScore`（默认 70）；解析失败/
  接口异常一律退款，不消耗额度。
- 模型：`featureModel` → `teacher_model` → `moderation_model` → `deepseek-v4-flash`，
  单次调用按 AI 用量记账。
- 被规则/AI 拦截且没有进入人工队列的隐藏题解，会出现在 `/oi33/ai/moderation#solution`，
  管理员可直接「通过并发布」；已经在队列里的题解仍从队列处理，不会重复列出。
- **可配置**：`/oi33/solutions/featured` 的「AI 评审」表单可改模型、通过分数（0-100）、
  提示词（留空使用内置默认，页面可展开查看默认提示词）。自定义提示词必须要求模型只输出
  JSON 对象，否则会被解析器判为异常并退款。
- 结果：
  - 通过 → `setSolutionFeatured`（`featuredBy = 0` 表示 AI）+ 合并一条私信（含奖励信息）；
  - 不通过 → 题解保持发布，私信「评分 + 结论 + 最多 3 条修改建议」，额度已用，明天可再申请；
  - AI 未配置/超时/返回异常/题解状态在审核期间变化 → 删除申请记录、**退回当天额度**并私信说明。

## 后台

`/oi33/solutions/featured`（flag≥2）：

- 加精奖励配置（none/can/food + 数量），同一篇只发一次；
- 全部题解列表，管理员可强制加精/取消（仍然保留，作为 AI 之外的人工兜底）；
- 「最近加精申请」表：时间、作者、题目、状态（审核中/已通过/未通过/异常）、AI 评分与建议。

## 数据

`oi33_solution_feature_apply`：

```
_id: string            // `${uid}:${YYYY-MM-DD}`，唯一键 = 每日额度
uid, domainId, psid, pid
status: 'pending' | 'featured' | 'rejected' | 'error'
score?, reason?, suggestions?, model?, cost?
createdAt, decidedAt?
```

`error` 记录只在“内容状态变化但不想退额度”的场景保留；基础设施异常会直接删记录退额度，
所以页面上看到的 `error` 很少。

## 坑

- 作者编辑一篇精华题解时，会**先自动取消精华**再走新一轮审核（避免「隐藏 + 精华」的
  第四种状态）；奖励不会重复发放，重新通过后需要再申请加精。
- AI 审核失败会退额度，所以「今天申请过」不等于「额度一定用掉了」——以记录是否存在为准。
- 题解被隐藏后不能申请加精；先把题解改到通过审核。
- 申请记录是审计数据，不要随手删；只有基础设施失败才由代码删除退额度。
- 改提示词后先拿一篇旧题解试跑，确认模型仍输出 `{"pass":...,"score":...}`；解析器只认
  这个结构，不认自然语言结论。
