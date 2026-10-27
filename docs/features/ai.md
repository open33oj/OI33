# AI、审核与内容治理

> 代码：`model/ai.ts`（AI 客户端）、`model/moderate.ts` + `moderate-rules.ts`（规则/AI 审核引擎）、`handler/ai/*`、`handler/bio.ts`、`handler/moderate.ts`。

## AI 能力（可复用 API）

AI 与审核能力（可复用 API）

新增功能不要再自己拼 `resolveChatConfig → fetch → aiAddUsage → calcCost`，也不要在 handler 里重写规则/AI/队列流程；这两块能力已经下沉到 model 层，经 `oi33Model` 与 `../model/ai`、`../model/moderate` 直接调用。

- **AI 客户端**（`model/ai.ts`）：`aiChat({ model|config, system, user, maxTokens?, json?, effort?, timeoutMs?, signal?, usage? })` 一步完成「解析 provider/模型 → 调用 → 写 `oi33_ai_usage` → 算成本」，返回 `{ content, usage, finishReason, error, model, provider, price, cost }`；流式用 `aiChatStream({ ..., onChunk, onRChunk })`（同样支持 `usage` 记账）。`usage = { uid, type: 'analysis'|'summary'|'moderation', rid?, domainId?, pid?, deducted? }`，不传 `usage` 则只算成本不记账（AI 分析流自扣余额那种场景用）。底层 `aiResolveChatConfig`/`aiCalcCost`/`aiChatCompletion`/`aiChatCompletionStream` 也导出，供需要自己处理原始响应的调用方使用。`handler/ai/` 的题意/难度/分析都改走这些接口，不再各自持有 HTTP/用量样板。
- **审核引擎**（`model/moderate-rules.ts` + `model/moderate.ts`）：纯规则层（`normalizeText`/`hashOf`/`mathTooDeep`/`checkRules`/`configWords`/`configReviewWords`/`sanitizeModerationCategory`/`DEFAULT_MODERATION_PROMPT`）在 `moderate-rules.ts`，刻意不依赖 hydrooj/DB，可被单测（`model/moderate-rules.test.ts`）；`moderate.ts` 重新导出它们并实现判定层 `runAiVerdict(uid, normalized, hash, cfg)`（缓存 + 规则 + 预算熔断 + AI，fail-closed）、`moderationEnabled(cfg)`（唯一的开关判断）、便捷入口 `evaluateContent(uid, text, cfg?)`（自动 normalize+hash 并返回 `{ normalized, hash, verdict }`，适合自带状态/队列的功能，如喵喵、简介），以及目标动作 `moderationTargetExists`/`hideModerationTarget`/`unhideModerationTarget`/`deleteModerationTarget`/`applyModerationTarget`（已覆盖讨论主题/回复与其评论、题解与其评论）。
- **编排入口**：`moderateContent({ kind, uid, text, target?, applyVerdict?, record?, queueForReview?, cfg? })` 是「已隐藏内容的完整后处理」：判定 → 通过则 `applyVerdict`（缺省用 `target` 的 unhide/delete）→ 写 `oi33_ai_moderation`，永不抛错；`moderateContentInBackground(opts)` 是它的 fire-and-forget 版本，请求内钩子用它。`applyVerdict` 覆盖内置目标动作，适合状态不是 `hidden` 的功能；`record:false` 给自带审核队列的功能；`queueForReview` 可为函数，在 `applyVerdict` 之后惰性判断该 review 是否真的转人工。
- **HTTP 层**（`handler/moderate.ts`）：只保留 `runModerationPrecheck(uid, kind, text)`（同步预检，未实名/限流/规则硬拦会抛 HTTP 错误）、讨论/题解生命周期钩子、以及 `/oi33/ai/moderation` 管理页：讨论/题解/简介人工队列（按类型筛选，每条带「查看目标」链接）、喵喵待审（通过/驳回）、被拦截的隐藏题解（恢复发布）、简介批量审查入口，以及审核设置。
- **Prompt 分层**：讨论、喵喵、简介共用 `moderation_prompt`；题解正文/编辑可单独配 `moderation_prompt_solution`（留空复用通用 Prompt）。注意规则层（违禁词、外链）独立于 Prompt 运行，改 Prompt 不会关掉这些规则；手机号、QQ/微信等联系方式已从规则层移除，交给 AI 判断，如需硬拦请加入违禁词表。外链策略可在管理页配 `moderation_link_review`（`all` / `external` 默认 / `off`）与信任域名 `moderation_link_allow`（默认 `33dai.cn`）；`external` 下站点自身域名（`server.url`）与信任域名（含子域名）的链接不转人工，只有站外链接在 AI 判通过时仍进队列，理由注明「含站外链接，转人工复核」。新的同步拦截请挂在 `handler/before-operation/<Handler>` 事件里调用 `runModerationPrecheck`，再把隐藏 + `moderateContentInBackground` 放到 `handler/after/<Handler>#post` 事件里。



## 个人简介（bio）审核

个人简介（bio）AI 审核

bio 是 Hydro 核心字段，编辑走 core `/home/settings/account`，本插件用 `handler/before|after/HomeSettings#post` 钩子介入（`handler/bio.ts`）：改动有 **2 小时冷却**（`bio_edited_at`）；变更后写 `bio_status:'pending'`+`bio_hash` 并后台 AI 审核：pass→approved；block/review/出错→rejected 隐藏并私信通知本人（含分类与理由；人工驳回只发「人工审核未通过」）。所有判定记入 `oi33_ai_moderation`（`kind:'bio'`，见 `/oi33/ai/moderation` 结果列表），review/出错进人工队列，管理员 approve/reject 直接翻转 bio 状态（哈希守卫，不会覆盖更新的编辑）。**显示规则**（`mergeOi33Fields` 算 `udoc.bio_visible`）：flag≥1 且 `bio_status==='approved'` 且 `bio_hash===bioHashOf(当前 bio)`——哈希不符（如 OAuth 回写）自动隐藏。展示点：资料页「个人简介」卡片（未过审时本人见提示，`after/UserDetail` 钩子同时清空 JSON 里的 bio）、首页 ranking partial。初始批量审查：管理页 `/oi33/ai/bio-review`（flag≥2，幂等可重跑，进度存 `oi33_ai_batch` 的 `_id:'bio_review'`）。

**队列记录与「已被修改」错误**：审核记录绑定的是它当时判定的那一版简介（`content`/`contentHash`），只有该版本仍是**当前** bio 时才可 approve/reject。判定统一走 `model/moderate.ts` 的 `bioQueueState(entry, live)` → `'ok'`（可审）/ `'text'`（文本相同但 `bio_hash` 漂移，例如被旧批量审查覆盖；决定仍可作用于该文本并改写哈希，否则「通过」后简介仍然不显示）/ `'stale'`（用户已改过简介或账号不存在，永远无法应用）。`live` 由 `getLiveBio`/`getLiveBios`（`model/user.ts`，直读 core `user` 集合，不走 User 缓存）取得。**旧的死循环**：`'stale'` 记录以前直接抛 `该个人简介已被修改，不能处理旧审核记录`，两个按钮都失败且记录永远 pending（`modListPending` 只取最旧 200 条），队列被堵死；现在改为关闭为 `'stale'` 状态（`modExpireEntries`，只动队列不动用户简介状态），审核页给这类记录打「简介已变更，仅可标记失效」标记并把按钮换成「标记失效」，另有一键「清理失效的简介记录（N）」（`expireStaleBioEntries`）。预防：`bioMarkEdited` 会顺带把该用户此前的 pending bio 记录关闭为 stale（新的编辑自带一条新记录），批量审查每个用户在 AI 调用前后各重读一次 live bio，改动中的用户跳过，避免用旧文本覆盖 `bio_hash`。



## 题解审核与题目讨论板块

题解审核与题目讨论板块

- **题解审核**：题解（core `document.TYPE_PROBLEM_SOLUTION`，`handler/solution.ts` 负责列表页与题解加精；生命周期钩子在 `handler/moderate.ts` 的 `applySolutionHooks`）与讨论共用同一套规则 + AI + 人工队列：`handler/before-operation/ProblemSolution` 做同步预检（`submit`/`edit_solution`/`reply`/`edit_reply`，kind 为 `solution`/`solution_edit`/`solution_reply`/`solution_reply_edit`），`handler/after/ProblemSolution#post` 把新内容 `hidden` 后 `moderateContentInBackground`。`Oi33ModerationTarget` 用 `psid`（题解）与 `psrid`（评论）定位，`moderationTargetExists`/`hideModerationTarget`/`unhideModerationTarget`/`deleteModerationTarget` 已覆盖题解；通过=取消 hidden，驳回=删除题解/评论，编辑命中 block 会降级为 review（不销毁旧内容）。未认证（flag<1）发题解会被预检拒绝；flag≥2 免审。
- **全部题解时间线**：`GET /oi33/solutions`（`oi33_solutions`，`PERM_VIEW_PROBLEM_SOLUTION`）按 `_id` 倒序分页列出所有非 hidden 题解。入口与「所有题目讨论」保持一致：放在讨论区侧栏组件 `templates/partials/discussion_nodes_widget.html` 的「题解 → 全部题解」（`/discuss`、讨论节点页、首页讨论组件、`/oi33/discuss/problem` 都包含该组件），**不占顶部导航栏**；管理页 `templates/oi33_admin.html` 另有一条。模板 `templates/oi33_solutions.html`。
- **题目讨论板块**：题目页内的讨论（`parentType = TYPE_PROBLEM`）不再出现在 `/discuss` 的「全部讨论」与首页「讨论」组件里，集中到 `GET /oi33/discuss/problem`（`oi33_problem_discussions`，`PERM_VIEW_DISCUSSION`，模板 `templates/oi33_problem_discussions.html`，复用 core `partials/discussion_list.html`）；`templates/partials/discussion_nodes_widget.html` 覆写 core，在讨论侧栏补上「题目讨论 → 所有题目讨论」入口，题目页 `/discuss/problem/:pid` 本身不变。


