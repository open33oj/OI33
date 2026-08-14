# OI33 — 33OJ Unified Hydro Plugin

Integrates 8 legacy plugins (coin, birthday, badge, realname, checkin, countdown, pastebin, frontend) into a single Hydro addon.

## Architecture

```
oi33/
├── package.json          # Hydro addon manifest
├── index.ts              # Entry: calls handler/* sub-applies
├── model/
│   ├── index.ts          # Central barrel export (oi33Model + Hydro type augmentation)
│   ├── types.ts          # All TypeScript interfaces (Oi33User, Oi33Paste, Oi33Wiki, etc.)
│   ├── user.ts           # User data: coin, birthday, badge, realname, checkin, rating
│   ├── paste.ts          # Pastebin CRUD
│   ├── wiki.ts           # Wiki CRUD + categories
│   ├── request.ts        # Profile edit request/approval flow
│   ├── token.ts          # API token management
│   ├── oauth.ts          # OAuth2 provider data (clients, codes, access/refresh tokens)
│   ├── cat-can.ts        # Reserve-backed cat-can AMM, price history, balances and trades
│   ├── cat-account.ts    # Unified food/can ledger, charts, grants, previews and reversals
│   ├── cat-map.ts        # 640x480 positions, persistent colors, movement costs/cooldowns
│   ├── school-cat.ts     # Big cat world: school import, binding, feeding, leaderboards, NPC movement tick
│   ├── school-cat-data.json # Generated school list (code/province/pinyin-initials) imported into oi33_school
│   ├── auction.ts        # Achievement auctions: escrowed can bids, lazy settlement, refunds
│   ├── contract.ts       # Achievement trade contracts: direct resale of auction-won achievements for cat food
│   └── log.ts            # Activity log (audit trail)
├── handler/
│   ├── patches.ts        # Monkey-patches (UserModel.getList, HomeHandler.getCheckin / getCountdown)
│   ├── utils.ts          # Shared helpers (checkUserFlag, canPublish)
│   ├── user.ts           # Coin / Birthday / Badge / Realname / Checkin / Users / Rating
│   ├── content.ts        # Paste (with realname_flag-based publish gating)
│   ├── admin.ts          # Admin dashboard / Migrate / Script registration
│   ├── profile.ts        # Unified profile edit + request approval
│   ├── judge-monitor.ts  # Judge machine heartbeat monitor + WeChat webhook
│   ├── token.ts          # MCP/Agent API token CRUD
│   ├── oauth.ts          # OAuth2 provider (authorize/token/userinfo/revoke + client mgmt)
│   ├── wiki.ts           # Wiki pages + categories + import/export
│   ├── cat-can.ts        # Cat-can market and realtime pixel-map routes/connections
│   ├── cat-account.ts    # Unified account, grant, batch preview and reversal routes
│   ├── school-cat.ts     # Big cat world routes (state, school list/search, bind, feed, detail)
│   ├── auction.ts        # Achievement auction routes (list/detail/bid, admin create/cancel)
│   ├── contract.ts       # Achievement trade contract routes (list/create/accept/decline/cancel)
│   └── permissions.ts    # Permission matrix reference page
├── scripts/
│   ├── update-ratings.ts
│   ├── fix-luogu-difficulty.ts # /manage/script: restores raw Luogu difficulty (0-8) from ndjson, undoing hydroac-client remap; args {"path":"","domainId":"luogu","prefix":""}
│   ├── school.txt        # OIerDB school list source (province,city,official name,aliases)
│   └── build-school-cat-data.py # Regenerates model/school-cat-data.json (needs pypinyin)
├── frontend/
│   ├── foo.page.ts       # Client-side UserSelectAutoComplete init
│   └── cat-big-arena.page.ts # Big cat world canvas, tabs, picker, feeding and leaderboards
├── locales/
│   └── zh.yaml           # Chinese i18n strings
├── public/               # Static assets (favicons, logo)
└── templates/            # Nunjucks templates
    ├── oi33_*.html       # Feature pages (including wiki templates)
    ├── problem_detail.html # Overrides Hydro problem page (Luogu difficulty badge)
    ├── problem_edit.html # Overrides Hydro problem edit page (difficulty dropdown)
    ├── components/
    │   └── user.html     # Overrides Hydro user badge rendering
    ├── partials/
    │   ├── footer.html
    │   ├── homepage/     # checkin, countdown, sidebar_nav, recent_problems
    │   ├── oi33_difficulty.html # Luogu difficulty badge/dropdown macros (style/render/options)
    │   ├── problem_list.html   # Overrides Hydro problem list (Luogu difficulty badge)
    │   ├── problem-sidebar-information.html # Overrides Hydro problem sidebar (Luogu difficulty badge)
    │   ├── problem_default.md
    │   ├── scoreboard.html
    │   ├── training_detail.html # Overrides Hydro training detail (Luogu difficulty badge)
    │   └── training_list.html
    └── layout/
        └── html5.html    # Overrides Hydro base layout
```

## MongoDB Collections (all prefixed `oi33_*`)

| Collection | Key fields |
|------------|-----------|
| `oi33_user` | `_id` (== UserModel._id), `coin_now`, `coin_all`, `birthday_date`, `birthday_monthDay`, `badge_text`, `badge_color`, `badge_textColor`, `realname_flag` (0-3: 未认证/已认证/管理员/行政管理员), `realname_name`, `checkin_time`, `checkin_luck`, `checkin_cnt_now`, `checkin_cnt_all`, `cat_food`, `cat_can`, `cat_can_trade_available_at`, `cat_food_backfill_version`, `cat_food_backfilled_at`, `school_cat`, `school_cat_food`, `school_cat_month`, `school_cat_feed_at`, `achievement_showcase`, `atcoder`, `codeforces`, rating fields |
| `oi33_coin_bill` | `_id` (ObjectId), `userId`, `rootId`, `amount`, `text` |
| `oi33_paste` | `_id` (random string), `updateAt`, `title`, `owner`, `content`, `isprivate` |
| `oi33_wiki` | `_id` (random slug: 8 hex bytes + base36 timestamp), `title`, `content`, `category`, `order`, `createdAt`, `updatedAt` |
| `oi33_wiki_category` | `_id` (slug), `name` (display name), `order` |
| `oi33_request` | `_id` (ObjectId), `uid`, `requester`, `status` (`pending`/`approved`/`rejected`/`cancelled`), `createdAt`, `handledAt?`, `handler?`, `kind`, + same patch fields as `oi33_user` (`birthday_date`, `realname_flag`, `realname_name`, `badge_*`, `atcoder`, `codeforces`) |
| `oi33_token` | `_id` (ObjectId), `uid`, `name`, `hash` (SHA-256 of raw token), `domains` (string[]), `expiresAt?`, `createdAt`, `lastUsedAt?` |
| `oi33_oauth_client` | `_id` (client_id, `33oj_` + base64url), `name`, `description?`, `secretHash?` (SHA-256), `secretPrefix?`, `redirectUris` (string[]), `scopes` (always `['profile']`), `isPublic` (PKCE), `accessTokenTtl`, `refreshTokenTtl`, `createdAt`, `createdBy`, `isActive` |
| `oi33_oauth_code` | `_id` (auth code), `clientId`, `uid`, `redirectUri`, `scopes`, `codeChallenge?`, `codeChallengeMethod?`, `expiresAt` (10 min), `consumed` |
| `oi33_oauth_token` | `_id`, `tokenHash` (SHA-256 of `33oat_…`), `tokenPrefix`, `clientId`, `uid`, `scopes`, `expiresAt`, `createdAt`, `lastUsedAt`, `isActive` |
| `oi33_oauth_refresh` | `_id`, `tokenHash` (SHA-256 of `33ojrt_…`), `clientId`, `uid`, `scopes`, `expiresAt`, `createdAt`, `isActive` |
| `oi33_log` | `_id`, `createdAt`, `type` (coin/birthday/badge/realname/checkin/cat_account/cat_map/paste/wiki/request/oauth/auction/admin), type-specific fields |
| `oi33_auction` | `_id` (ObjectId), `achievementId`, `startPrice`, `startAt`, `endAt`, `createdBy`, `status` (`active`/`settled`/`cancelled`), `highestBid`, `highestBidder`, `bidCount`, `winner`, `settlePrice`, `foodBurn` (reserve food burned at settlement, absent on legacy), `settledAt` |
| `oi33_auction_bid` | `_id` (ObjectId), `auctionId`, `uid`, `amount`, `createdAt` |
| `oi33_achievement_contract` | `_id` (ObjectId), `achievementId`, `seller`, `buyer`, `price` (cat food g), `fee` (intermediary fee g, absent on legacy contracts), `status` (`pending`/`accepted`/`declined`/`cancelled`), `createdAt`, `resolvedAt` |
| `oi33_cat_can_bill` | buy/sell/reversal ledger with principal, fee, food delta and can delta |
| `oi33_cat_can_pool` | real reserve, virtual supply, burned fees, incremental global food/can counters and counter version |
| `oi33_cat_can_price` | minimal 8-hour buy/sell price history (`_id`, prices, `createdAt`) |
| `oi33_cat_food_batch_preview` | expiring, single-use bulk cat-food grant previews |
| `oi33_cat_map_player` | globally unique per-user positions, shared action cooldown, non-stacking `freeColorAvailable` credit and transient lock |
| `oi33_cat_map_cell` | persistent 8-bit colors keyed by `x:y` |
| `oi33_school` | OIerDB schools imported at startup (`_id` = OIerDB code, `prov`, `abbr`; `_id: 'meta'` tracks import count) |
| `oi33_school_cat` | one doc per fed school (`_id` = school code): `currentWeight`, `historyWeight`, optional pinned position `x`/`y`/`positionAt` |
| `oi33_school_feed_history` | archived per-user feeding totals moved out of 当前投喂 on rebind (`uid`, `schoolId`, `amount`) |
| `oi33_ai_problem_summary` | per-problem cached AI 精简题意 (`content`, `model`) plus AI-judged Luogu difficulty (`difficulty` 1-8, `difficultyModel`) |
| `oi33_ai_batch` | single doc `_id: 'current'`: batch summary/difficulty generation progress (`running`, `start`/`end`, counters, `currentSort`) |

Core profile/content write operations also insert into `oi33_log`. `oi33_user.cat_can` is the single source of truth for cat-can inventory, while trades use the immutable `oi33_cat_can_bill` ledger. Normal runtime no longer reads or writes the legacy `oi33_cat_can_batch` collection; `/oi33/migrate` previews and idempotently drops it.

## Handler Patterns

### domainId injection rule (CRITICAL)
- Methods **with** `@param` or `@query` decorators → `domainId` is injected as the **first parameter**
- Methods **without** decorators → `domainId` is NOT injected; use `''` (default domain) or the parameter won't exist

### Privilege levels used
- Public: no privilege
- `PRIV_USER_PROFILE`: any logged-in user
- OI33 `realname_flag >= 2`: all OI33 management and approval operations
- `PRIV_ALL`: super-admin (used only for token management)

### `realname_flag` identity levels
| Flag | Label | Paste public? |
|------|-------|--------------|
| 0 | 未认证 (Unverified) | No |
| 1 | 已认证 (Verified) | Yes (`flag >= 1`) |
| 2 | 管理员 (internal key: Teacher) | Yes |
| 3 | 行政管理员 (internal key: Admin) | Yes |

### User data pattern
When rendering user lists with oi33 data:
1. Query `oi33_user` collection for relevant docs
2. Extract `uids` from results
3. Call `UserModel.getList(domainId, uids)` → returns objects WITH `hasPriv()` method (needed by `user.html` component)
4. Call `oi33Model.getUserDataByUids(uids)` → returns oi33 data dict
5. Call `oi33Model.mergeOi33Fields(udoc, oi33Data)` to merge oi33 fields onto each udoc

Never use `getListForRender` when the `user.html` component is rendered, because that component calls `udoc.hasPriv()` which is only available on `getList` results.

Users with `realname_flag < 1` (including missing `oi33_user` data) are anonymized in all user-list rendering as `UID <id>` with the default blank avatar. Their custom username and avatar are visible only on their own user-detail page to viewers with `realname_flag >= 2`.

For alt-account detection, viewers with `realname_flag >= 2` additionally see a 注册信息 card on every user-detail page (including unverified profiles, where the stock registration block is hidden): mail, regat/loginat, last-login IP and all historical IPs, each IP linking to `/oi33/admin/ip?ip=…` (all accounts that used it). The full roster lives at `/oi33/admin/accounts`; both pages read Hydro's raw `user` collection directly, bypassing the anonymizing `UserModel.getList` patch on purpose.

Cat-map participation also requires `realname_flag >= 1`. Downgrading a user below that level deletes their map-player position immediately so an invisible player cannot continue occupying a cell; re-verification requires joining the arena again.

Unverified users (`realname_flag < 1`) are blocked from every interactive feature: daily check-in (`CheckinHandler`, and the homepage checkin partial hides the button via `payload.oi33_checkin_flag`), cat-map join/move/color and big-cat bind/feed/position (model-level `realname_flag: { $gte: 1 }` filters), buying/selling cat cans (`CatCanBuyHandler`/`CatCanSellHandler`), bidding in achievement auctions (`AuctionBidHandler`), creating or accepting achievement trade contracts, creating or editing pastes (they may still view/manage/delete their existing pastes), posting meows (pre-existing) plus following and liking (unfollow stays allowed), receiving cat food in any form (single grants throw, batch grants skip them at preview and again at confirm, the launch backfill marks them processed without granting), and automatic achievement evaluation (`achievementEvaluateUser` returns early for flag < 1; manual admin grants still work).

Adjacent cat-map movement costs 3g cat food, while teleporting costs 3 cat cans. Every successful move or teleport sets `freeColorAvailable` to `true`; the next color change may bypass the current shared cooldown and atomically consumes that credit. The boolean credit never accumulates: moving or teleporting again before coloring still leaves exactly one free color change.

### Big cat world (大猫世界)

The arena page (`/oi33/arena`) renders a single shared canvas with three layers, bottom to top: painted cells, big cats, small cats. Big-cat labels are always drawn (they may be covered by small cats and their labels, but are never culled); small-cat labels follow the original cans-priority overlap culling. Each big cat represents an OIerDB school; the public label is `<拼音缩写>#<OIerDB编号>` (e.g. `CSSYLZX#0`), the province code only appears as a tag in the school picker, and the label links to `https://oier.baoshuo.dev/school/<编号>`. School codes are `(1-based line number in scripts/school.txt) - 4`; blank placeholder lines (`,,`) are skipped so codes stay aligned.

- Participation requires `realname_flag >= 1` (same as the small-cat map). Users who fed and are later downgraded keep their binding and contributions untouched; they simply cannot feed/rebind until verified again.
- Users bind one school cat; the first bind is free, afterwards the binding may change once per calendar month (Asia/Shanghai, tracked by `school_cat_month`). On rebind the user's accumulated contribution moves from the old cat's `currentWeight` into its `historyWeight` and a `oi33_school_feed_history` row; binding back to a previously fed cat restores that user's history feeding into current feeding.
- Feeding burns cat food (`userFoodTotal` decreases), increments the cat's `currentWeight` and the user's `school_cat_food`, and logs a `cat_account`/`school_feed` entry so it appears in the unified cat account. Feeding has a fixed 2-hour cooldown (`school_cat_feed_at`).
- A cat appears on the map at `currentWeight >= 1024` with size 8×8 cells; every doubling (2048, 4096, …) adds +8 to the side length. Below 1024 the cat stays in the DB but is hidden.
- Big cats have no movement simulation: the canvas is display-only. The #1 contributor on a cat's 当前投喂榜 may pin its top-left cell (`x`/`y`/`positionAt` on `oi33_school_cat`) once every 2 hours; unpinned cats are laid out client-side at seeded pseudo-random, non-overlapping positions. Idle sit/tail-up frames come from the shared sprite sheet. Weight/position changes broadcast as `type: 'bigcat'` over the shared `/oi33/arena/conn` socket and trigger a client state refresh.
- Both leaderboards (当前投喂榜 from live `school_cat_food` bindings, 历史投喂榜 from the history collection) are served per school by `/oi33/arena/big/cat/:schoolId`.
- School data is regenerated with `python scripts/build-school-cat-data.py` (requires `pypinyin`) and imported into `oi33_school` at startup when the meta count differs.

Authentication visibility and real-name visibility are separate: flag >= 1 restores the public username/avatar, but `realname_name` and the `[realname]username` rendering are visible only to viewers with OI33 flag >= 2.

### Cat food rewards

- Effective immediately from `2026-07-18`: a normal daily check-in grants 100 cat food; a check-in continuing the previous day's streak grants 150.
- Existing users receive a one-time launch grant of `checkin_cnt_all * 100`; users who already completed a consecutive check-in on launch day receive another 50. Versioned balance reconciliation makes the grant idempotent.
- Cat food is displayed below the cat component on the user detail page. A successful check-in redirects with a Hydro success notification showing the awarded amount.
- Unverified users can never receive cat food: `grantCatFood` throws `CAT_FOOD_UNVERIFIED_MESSAGE` for positive amounts (deductions stay allowed), batch previews filter unverified users out (shown as a skipped list) and `confirmCatFoodBatchPreview` skips them again at confirm time (counted in the result), and the launch backfill marks unverified users processed without granting.
- `grantCatFood` deductions may drive the balance negative (plain `$inc`, no sufficiency gate) so mis-granted food can be clawed back; future earnings offset the debt. Spending paths (can trades, map moves, school feeds) still require sufficient balance.

### Cat-can market insights (`/oi33/cat-can`)

- The market page exposes a 定价参数 table: every input and intermediate value of the 8-hour price tick (reserve/user/system food, circulating cans, virtual supply, pool cans, AMM price, backing price, raw target, previous price, ±`MAX_TICK_PERCENT` band, bounded target, backing cap, final sell/buy prices, cumulative burned fees). Both the tick writer (`ensureCurrentCatCanPrice`) and the page share `computeCatCanPriceParams(pool, previousSellPrice)` — never duplicate the formula.
- The 经济指标 tables show 7d/30d cat-food mint vs burn (checkin, admin/contest grants, trade fees, school feeds, map moves, contract fees, admin deductions, net) and can flows (pool sales, sell-backs, teleport/meow/auction returns, net outflow), plus a can circulation ratio and reserve coverage note. Data comes from `oi33_log` (every food/can flow writes one entry) and `oi33_cat_can_bill`; both collections have a `{ createdAt: 1 }` index (`ensureLogIndexes` in `model/log.ts`, wired in `index.ts` startup).

### Achievement auctions, showcase and profile panel

- **Auctions** (`/oi33/auction`): OI33 flag >= 2 admins list an achievement with a duration (1–720 h) and a starting price in cat cans. Only **saleable** achievements can be auctioned, each rare achievement is auctioned **at most once** (`auctionCreate` rejects when a settled-with-winner auction or an auction/contract-sourced award already exists), and only one active auction per achievement; the create-form dropdown only offers saleable, never-sold, unheld achievements (`auctionRareShowcase` rows with status `pending`). Bidding requires `realname_flag >= 1`; each bid must exceed the current highest by at least 1 can (first bid meets the start price). Bids are escrowed — the full amount is deducted at bid time and the outbid previous leader is refunded automatically. Users who already own the achievement (and the current leader) cannot bid. Settlement is lazy (`auctionSettle` runs when an expired auction is listed/viewed/bid on): the winner is granted the achievement through `achievementGrant` (source `auction`, meow announcement included), the winning cans return to the AMM pool (`circulatingCans` decreases) AND the pool burns reserve food equal to `highestBid × current sellPrice` (clamped to the reserve, stored as `foodBurn` on the auction and in the settle log) — economically identical to the winner selling the cans back and destroying the proceeds; auctions with no bids simply close. Admins may cancel an active auction, which refunds the current leader (a cancelled auction may be re-listed). All actions log `type: 'auction'`. The arena page (`/oi33/arena`) shows a 罐头行情与成就拍卖 module below the map: the live can quote with 24 h change (`getCatCanDayChange`, measured on the sell/anchor price against the newest price slot at or before now-24h) plus up to 4 active auctions, each linking to its detail page.
- **Rare showcase** (`/oi33/achievements/rare`, public): lists every saleable achievement with its uniqueness status — 持有中 (current holder via auction/contract award, with earned time and contract-transfer tag), 拍卖中 (link, current price, remaining time) or 待拍卖 — plus the settle price. Data comes from `auctionRareShowcase()`.
- **Trade contracts** (`/oi33/contracts`): an achievement definition marked `saleable` (checkbox in 成就管理) can be resold by a user whose award came from a trade — an auction win or a previous contract (`source` in `TRADE_AWARD_SOURCES` = `['auction', 'contract']`). The seller creates a contract naming a buyer UID and a cat-food price; one pending contract per seller+achievement. The named buyer accepts, declines, or the seller cancels. On accept the buyer pays the full price (sufficiency gate) while the seller receives the price minus a 5% intermediary fee (`contractFeeAmount`, ceiled, stored as `fee` on the contract); the fee is burned and the AMM pool's `userFoodTotal` counter is decremented to match. The seller's award is deleted and re-granted to the buyer with `source: 'contract'` — contract-bought copies can be resold again, so the trade chain is unbounded. The creation form carries a prominent fee notice, and the outgoing/resolved tables show the fee and the seller's net proceeds. All actions log `type: 'contract'` (accept logs include `fee`).
- **Showcase**: each user picks up to 16 earned achievements at `/oi33/achievements/showcase` (stored as `achievement_showcase` on `oi33_user`; the array order is the display order, set via per-badge position numbers in the editor). The user detail page renders them as a 4-column badge grid titled 成就展示柜 in its own section **between the profile header and the tab panel** (the header and tabs live in separate `.section` blocks), replacing the old grouped achievement section; unconfigured profiles show an edit hint to the owner instead.
- **Profile achievement tab**: the user detail tabs (喵喵/关注/粉丝/…) include an 成就 tab listing every earned achievement as a compact row (font-height logo + name + description), capped at 50 rows; when more exist, a link leads to the public full list at `/oi33/achievements/user/:uid`. Achievement lists everywhere (manage page, profile tab, showcase editor, full list) order definitions as **saleable/auction first, then manual (`ruleType: 'manual'`), then automatic** (`achievementCategoryRank`; ties fall back to `order`/`earnedAt`).

### Profile edit + approval flow

User-facing edit lives at `/oi33/profile/edit/:uid` (`handler/profile.ts`). The editable fields are: `birthday_date`, `realname_flag`/`realname_name`, `badge_text`/`badge_color`/`badge_textColor`, `atcoder` (username), `codeforces` (username).

AtCoder/Codeforces 用户名通过申请流程修改。AT 和 CF 的 rating 字段（`atcoder_rating`, `codeforces_rating`）及最后更新时间（`atcoder_updated_at`, `codeforces_updated_at`）由后台更新脚本自动维护，不可手动设置，但在个人页面上会显示。

- **Regular user** editing self → `oi33Model.submitRequest()` creates a `pending` doc in `oi33_request`; `oi33_user` is unchanged until approval. Existing pending for the same `uid` + `kind` is marked `cancelled` (both the request doc and its activity-log entry), so the old log line shows "已取消" instead of staying "待审批".
- **OI33 manager/executive-admin direct edit** → `oi33Model.directUpdate()` writes the new values to `oi33_user` AND records a status=`approved` audit entry in `oi33_request`. Flag-2 managers may directly set ordinary users only to identity 0/1 and cannot change another manager/executive-admin's identity; flag-3 executive admins may edit every identity level and every user.
- **Hydro `PRIV_ALL` bootstrap** → a Hydro super administrator may directly edit any user's OI33 identity regardless of their current OI33 flag, including promoting themselves to flag 3 (executive administrator).
- Approval queue at `/oi33/requests` is available to OI33 managers/executive admins. Flag-2 managers can approve identity targets 0-1; flag-3 executive admins can approve targets 0-2. Identity target 3 cannot be approved through the queue. Approve → `applyRequestPayload` applies the saved fields, sets `status=approved`. Reject → sets `status=rejected`.
- Empty `badge_text` clears the entire badge triple via `$unset`. Empty `birthday_date` clears both `birthday_date` and `birthday_monthDay`.

## Routes

| Route | Handler | Permission |
|-------|---------|------------|
| `/oi33/users` | UsersShowHandler | OI33 flag >= 2 |
| `/oi33/coin/show` | CoinShowHandler → /oi33/users | PRIV_USER_PROFILE |
| `/oi33/coin/inc` | CoinIncHandler | OI33 flag >= 2 |
| `/oi33/coin/bill/:uid` | CoinBillHandler | PRIV_USER_PROFILE |
| `/oi33/birthday` | BirthdayShowHandler | public |
| `/oi33/birthday/all` | BirthdayAllHandler → /oi33/users | PRIV_USER_PROFILE |
| `/oi33/badge` | BadgeShowHandler | PRIV_USER_PROFILE |
| `/oi33/badge/manage` | BadgeManageHandler | OI33 flag >= 2 |
| `/oi33/badge/manage/:uid/del` | BadgeDelHandler | OI33 flag >= 2 |
| `/oi33/checkin` | CheckinHandler | PRIV_USER_PROFILE + verified |
| `/oi33/cat-food/bill/:uid` | CatFoodBillHandler | Legacy redirect to unified cat account |
| `/oi33/profile/edit/:uid` | ProfileEditHandler | PRIV_USER_PROFILE (self; OI33 manager/executive admin can edit others with role limits) |
| `/oi33/requests` | RequestListHandler | Logged in + OI33 manager/executive admin |
| `/oi33/requests/:id/approve` | RequestApproveHandler (POST) | Logged in + role-based approval limit |
| `/oi33/requests/:id/reject` | RequestRejectHandler (POST) | Logged in + OI33 manager/executive admin |
| `/oi33/at-cf-rating` | RatingShowHandler | public |
| `/oi33/auction` | AuctionListHandler | public |
| `/oi33/achievements/rare` | AuctionRareHandler | public |
| `/oi33/auction/:id` | AuctionDetailHandler | public |
| `/oi33/auction/create` | AuctionCreateHandler (POST) | OI33 flag >= 2 |
| `/oi33/auction/:id/bid` | AuctionBidHandler (POST) | PRIV_USER_PROFILE + verified |
| `/oi33/auction/:id/cancel` | AuctionCancelHandler (POST) | OI33 flag >= 2 |
| `/oi33/contracts` | ContractListHandler | PRIV_USER_PROFILE |
| `/oi33/contracts/create` | ContractCreateHandler (POST) | PRIV_USER_PROFILE + verified |
| `/oi33/contracts/:id/accept` | ContractAcceptHandler (POST) | PRIV_USER_PROFILE + verified (named buyer) |
| `/oi33/contracts/:id/decline` | ContractDeclineHandler (POST) | PRIV_USER_PROFILE (named buyer) |
| `/oi33/contracts/:id/cancel` | ContractCancelHandler (POST) | PRIV_USER_PROFILE (seller) |
| `/oi33/achievements/showcase` | AchievementShowcaseHandler (GET/POST) | PRIV_USER_PROFILE + verified |
| `/oi33/achievements/user/:uid` | AchievementUserHandler | public |
| `/oi33/cat-can` | CatCanMarketHandler | PRIV_USER_PROFILE |
| `/oi33/arena` | CatCanArenaHandler | public (verified users only) |
| `/oi33/arena/big/state` | SchoolCatStateHandler | public |
| `/oi33/arena/big/schools` | SchoolCatSchoolsHandler (list/search) | PRIV_USER_PROFILE + verified |
| `/oi33/arena/big/bind` | SchoolCatBindHandler (POST) | PRIV_USER_PROFILE + verified |
| `/oi33/arena/big/feed` | SchoolCatFeedHandler (POST, 2h cooldown) | PRIV_USER_PROFILE + verified |
| `/oi33/arena/big/cat/:schoolId/position` | SchoolCatPositionHandler (POST, top feeder only, 2h cooldown) | PRIV_USER_PROFILE + verified |
| `/oi33/arena/big/cat/:schoolId` | SchoolCatDetailHandler | public |
| `/oi33/arena/state` | CatMapStateHandler | public |
| `/oi33/arena/join` | CatMapJoinHandler (POST) | PRIV_USER_PROFILE + verified; first placement is free |
| `/oi33/arena/move` | CatMapMoveHandler (POST) | PRIV_USER_PROFILE + verified |
| `/oi33/arena/color` | CatMapColorHandler (POST) | PRIV_USER_PROFILE + verified |
| `/oi33/cat-arena/admin` | CatMapAdminHandler | OI33 flag = 3; rectangle paint and forced random relocation |
| `/oi33/cat-arena/admin/relocate` | CatMapAdminRelocateHandler (POST) | OI33 flag = 3 |
| `/oi33/cat-can/buy` | CatCanBuyHandler (POST) | PRIV_USER_PROFILE + verified |
| `/oi33/cat-can/sell` | CatCanSellHandler (POST) | PRIV_USER_PROFILE + verified |
| `/oi33/cat-account/:uid` | CatAccountHandler | PRIV_USER_PROFILE (self; OI33 flag >= 2 for others) |
| `/oi33/cat-food/grant` | CatFoodGrantHandler | OI33 flag >= 2 |
| `/oi33/cat-food/grant/bulk` | CatFoodBulkGrantHandler | OI33 flag >= 3 |
| `/oi33/cat-food/grant/bulk/confirm` | CatFoodBulkConfirmHandler (POST) | OI33 flag >= 3 |
| `/oi33/cat-account/transaction/:id/reverse` | CatCanReverseHandler (POST) | OI33 flag >= 2 |
| `/oi33/paste/create` | PasteCreateHandler | PRIV_USER_PROFILE + verified |
| `/oi33/paste/manage` | PasteManageHandler | PRIV_USER_PROFILE |
| `/oi33/paste/all` | PasteAllHandler | OI33 flag >= 2 |
| `/oi33/paste/show/:id` | PasteShowHandler | public |
| `/oi33/paste/show/:id/edit` | PasteEditHandler | PRIV_USER_PROFILE + verified |
| `/oi33/paste/show/:id/delete` | PasteDeleteHandler | PRIV_USER_PROFILE |
| `/oi33/admin` | Oi33AdminHandler | OI33 flag >= 2 |
| `/oi33/admin/user/create` | AdminUserCreateHandler (GET 表单 / POST) | OI33 flag >= 2 |
| `/oi33/admin/accounts` | AdminAccountsHandler | OI33 flag >= 2 |
| `/oi33/admin/ip` | AdminIpHandler (`?ip=`) | OI33 flag >= 2 |
| `/oi33/migrate` | MigrateHandler | OI33 flag >= 2 |
| `/oi33/wiki` | WikiMainHandler | public |
| `/oi33/wiki/pages` | WikiPagesHandler | public |
| `/oi33/wiki/create` | WikiEditHandler (GET/POST) | OI33 flag >= 2 |
| `/oi33/wiki/:id` | WikiShowHandler | public |
| `/oi33/wiki/:id/edit` | WikiEditHandler (GET/POST) | OI33 flag >= 2 |
| `/oi33/wiki/:id/export` | WikiExportHandler | public |
| `/oi33/wiki/:id/delete` | WikiDeleteHandler (POST) | OI33 flag >= 2 |
| `/oi33/wiki/export` | WikiBulkExportHandler | public |
| `/oi33/wiki/import` | WikiBulkImportHandler (GET form) | OI33 flag >= 2 |
| `/oi33/wiki/import/submit` | WikiImportHandler (POST JSON) | OI33 flag >= 2 |
| `/oi33/wiki/categories` | WikiCategoriesHandler (GET/POST) | OI33 flag >= 2 |
| `/oi33/judge-monitor` | JudgeMonitorHandler (GET/POST) | OI33 flag >= 2 |
| `/oi33/permissions` | PermissionsShowHandler | OI33 flag >= 2 |
| `/oi33/ai/summary/batch` | Ai33SummaryBatchHandler (GET/POST) | OI33 flag >= 2 |
| `/oi33/tokens` | TokenListHandler | PRIV_USER_PROFILE (admin sees all) |
| `/oi33/tokens/create` | TokenCreateHandler (POST) | PRIV_ALL |
| `/oi33/tokens/:id/delete` | TokenDeleteHandler (POST) | PRIV_ALL |
| `/oi33/oauth/authorize` | OAuthAuthorizeHandler (GET/POST) | PRIV_USER_PROFILE |
| `/oi33/oauth/token` | OAuthTokenHandler (POST) | public (client auth) |
| `/oi33/oauth/userinfo` | OAuthUserInfoHandler (GET) | public (Bearer access token) |
| `/oi33/oauth/revoke` | OAuthRevokeHandler (POST) | public |
| `/oi33/oauth/clients` | OAuthClientsHandler | OI33 flag >= 2 |
| `/oi33/oauth/clients/:id` | OAuthClientShowHandler | OI33 flag >= 2 |
| `/oi33/oauth/clients/create` | OAuthClientCreateHandler (POST) | OI33 flag >= 2 |
| `/oi33/oauth/clients/:id/delete` | OAuthClientDeleteHandler (POST) | OI33 flag >= 2 |
| `/paste/show/:id` | PasteShowHandler | PRIV_USER_PROFILE (legacy redirect) |

**Deprecated** (replaced by unified `/oi33/profile/edit/:uid`):
- `/oi33/birthday/set`, `/oi33/realname/set`, `/oi33/realname/show`, `/oi33/badge/create`

### Paste visibility rules
- Creating or editing any paste requires `flag >= 1` (Verified or above); unverified users can only view or delete their existing pastes. Making a paste public additionally goes through `canPublish()`.
- `canPublish()` in `handler/utils.ts` enforces the public-visibility rule at create and edit time.

### Wiki handler patterns
- Wiki pages use a dedicated layout (`layout/oi33_wiki.html`) with custom nav and footer, making the wiki section feel like a standalone site.
- Wiki editing requires OI33 `realname_flag >= 2`.
- Wiki categories page (`/oi33/wiki/categories`) is admin-only; public category browsing is available via the sidebar on the "All Pages" page.
- Wiki import: accepts JSON array via POST body as `__raw_body`. Each object: `{ title, content, category? }`. Auto-creates unknown categories.
- Wiki export: returns JSON array `[{ title, content, category }, ...]`. Optional `?category=` filter. Single page export at `/oi33/wiki/:id/export`.
- Wiki index page (`_id: "index"`) is auto-created if missing and **cannot** be deleted.
- All wiki write operations log via `oi33_log` with `type: 'wiki'`.

### Judge monitor
- Runs a timed check every 5 minutes (`NODE_APP_INSTANCE === '0'` only).
- Stores state in `SystemModel` keys under `oi33.judge_monitor.*`.
- WeChat Work (企业微信) webhook sends markdown messages on state transitions (`offline`/`recovery`/`delta`).

### OAuth2 provider (33OJ as identity provider)
- Implements RFC 6749 Authorization Code flow with PKCE (RFC 7636) support, refresh tokens (RFC 6749 §6), and token revocation (RFC 7009).
- **Flow**: client redirects user → `GET /oi33/oauth/authorize` (consent page, requires login) → `POST /oi33/oauth/authorize` (approve/deny) → redirect back with `code` → client server `POST /oi33/oauth/token` (exchange code for access+refresh token) → `GET /oi33/oauth/userinfo` (Bearer access token → user claims).
- **Client registration** at `/oi33/oauth/clients` (admin only). Confidential clients get a `client_secret` (shown once, stored as SHA-256). Public clients (SPAs/mobile) use PKCE with no secret.
- **Scope**: only `profile` — returns `sub` (stable user ID string) and `uname` (username). No email or oi33 business data is exposed.
- Access tokens are `33oat_…` (hashed at rest); refresh tokens are `33ojrt_…`. Auth codes live 10 min, single-use.
- The `handler/create` bearer-token hook in `patches.ts` **skips** `/oi33/oauth/*` paths so the OAuth handlers manage their own Bearer auth against `oi33_oauth_token` (separate from the `oi33_token` API-token system).
- All OAuth write ops (authorize/deny/token/refresh/revoke/client_create/client_delete) log via `oi33_log` with `type: 'oauth'`.

### AI reference difficulty (AI 参考难度)
- `handler/ai.ts` `generateProblemDifficulty()` judges the Luogu-scale difficulty (1-8) from the cached 精简题意 and stores it on the `oi33_ai_problem_summary` doc (`difficulty`/`difficultyModel`); cost logs as global `summary` usage (never charged).
- `generateProblemSummaryWithDifficulty()` produces both in ONE call: the model writes the condensed statement, then a trailing `[[难度]]N` marker line (`SUMMARY_DIFFICULTY_TAIL`); the marker is stripped before saving. All summary generation (manual regenerate, streaming, batch) uses the configured `summary_model` from `/oi33/ai/models` — there is no forced pro model. A custom `difficulty_prompt` only applies to the difficulty-only path; combined generation uses the fixed tail.
- Unrated problems (`difficulty` unset/0) get the AI level written directly via `problem.edit`; already-rated problems keep their rating and only show the AI badge on `/oi33/ai/summary` (rendered via `partials/oi33_difficulty.html`).
- Manual regenerate on `/oi33/ai/summary` uses `generateProblemSummaryWithDifficulty()`; a difficulty-only action exists for problems with a cached summary but no AI difficulty (e.g. summaries generated in the background during analysis).
- Batch at `/oi33/ai/summary/batch` (OI33 flag >= 2): `sort` range [start, end] in a chosen domain (input, default `system`) supporting both plain numbers (`1000`) and alphanumeric sorts (`ABC123A` — parsed to `[prefix, num, tail]`, compared prefix-first then numerically), max 500 problems per run, sequential background processing using `summary_model`, idempotent (only fills gaps; fresh summaries come with a difficulty from the same call, cached-but-undifficultied summaries get a difficulty-only pass), progress in `oi33_ai_batch` (`_id: 'current'`).
- The difficulty system prompt is configurable via `difficulty_prompt` on `/oi33/ai/models` (empty = built-in default).

## Monkey-patches ([handler/patches.ts](handler/patches.ts))
1. **UserModel.getList** — injects oi33 fields (coin, badge, realname, birthday, atcoder, codeforces, rating fields) into `User` instances with `hasPriv()` (used by pages rendering `user.html`)
2. **UserModel.getListForRender** — same injection for plain objects without `hasPriv()` (used for lightweight rendering)
3. **HomeHandler.getCheckin** — injects `payload.oi33_checkin` for the checkin partial
4. **HomeHandler.getCountdown** — injects `payload.dates` for the countdown partial

5. **handler/create Bearer-token auth** — verifies `Authorization: Bearer 33tok_…` against `oi33_token`, injects the token user before Hydro's `handler/create/http` PERM_VIEW gate, and enforces read-only method + route whitelist. **Skips** `/oi33/oauth/*` paths so the OAuth provider handlers manage their own Bearer auth against `oi33_oauth_token`.
6. **nunjucks `Environment.prototype.getTemplate`** — startup-race guard for template overrides. Hydro calls `server.listen()` before ui-default's `TemplateService` finishes reading addon templates into its registry; a page rendered in that window compiles shared names (e.g. `components/user.html`) from ui-default's original content, and the production loader (`noCache: false`) caches that compiled version for the whole process lifetime (symptom: ranking table loses `[realname]` prefixes, identity icons and anonymization until restart). For every template oi33 ships, the patch drops the compiled `loader.cache` entry until the registry provably holds oi33's file content (exact string compare), then marks the name verified and stops touching it; a 120 s startup deadline bounds the worst case.

Patches are wrapped in `applyPatches(ctx)` and called from the top-level `apply()` in [index.ts](index.ts), not import-time side effects.

## Template conventions
- Use `_('key')` for i18n (keys defined in zh.yaml)
- Use `(handler.user.realname_flag or 0) >= 2` to gate OI33 management UI
- Page title uses `_('Back to Admin')` → links to `/oi33/admin`, gated by OI33 `realname_flag >= 2`
- Use `{{ datetimeSpan(value)|safe }}` for timestamp rendering
- POST forms must include `<input type="hidden" name="csrfToken" value="{{ handler.csrfToken }}">`
- Problem difficulty always renders through `partials/oi33_difficulty.html` (`render` badge / `renderMasked` masked badge / `options` dropdown). Stored values follow Luogu's 0-8 scale (0/未设置 = 暂无评定, 1 = 入门 … 8 = NOI/NOI+/CTS) with Luogu badge colors; Hydro's automatic `lib.difficulty(nSubmit, nAccept)` fallback is never used. The problem edit/create form posts `difficulty` as `''` (clears to 0) or `1`-`8` because Hydro validates it as optional `PositiveInt`.
- Everywhere difficulty is displayed (problem detail tag row + sidebar, problem list, training detail tables), it is masked by default and revealed purely client-side (CSS hides the badge under `html.hasjs`; `frontend/oi33_difficulty.page.ts` — registered as a plain `addPage` function so it binds on every page load — flips inline `display` styles directly and mirrors state on the `oi33-diff-shown` class). Problem page badges use `renderMasked` (a gray 显示难度 tag that toggles itself); list tables hide the whole column (cells show a gray 隐藏 placeholder) behind a plain-text 显示难度 link in the column header that toggles the entire table (text swaps to 隐藏难度). Only admin tooling (`/oi33/ai/summary`) renders unmasked.

## Installation
```bash
hydrooj addon add /path/to/oi33
pm2 restart hydrooj
# Visit /oi33/migrate to run migration (idempotent, safe to re-run)
```
