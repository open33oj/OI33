# OI33 — 33OJ Unified Hydro Plugin

Integrates 8 legacy plugins (coin, birthday, badge, realname, checkin, countdown, pastebin, frontend) into a single Hydro addon.

## Architecture

```
oi33/
├── package.json          # Hydro addon manifest
├── index.ts              # Entry: calls handler/* sub-applies
├── model.ts              # Database layer (MongoDB collections + operations)
├── migrate.ts            # Data migration from legacy plugins (idempotent)
├── handler/
│   ├── patches.ts        # Monkey-patches (UserModel.getList, HomeHandler.getCheckin / getCountdown)
│   ├── user.ts           # Coin / Birthday / Badge / Realname / Checkin / Users
│   ├── content.ts        # Paste
│   ├── admin.ts          # Admin dashboard / Migrate / Script registration
│   └── profile.ts        # Unified profile edit + request approval
├── scripts/
│   └── export-hydro-data.ts
├── frontend/
│   └── foo.page.ts       # Client-side UserSelectAutoComplete init
├── locales/
│   └── zh.yaml           # Chinese i18n strings
├── public/               # Static assets (favicons, logo)
└── templates/            # Nunjucks templates
    ├── oi33_*.html       # Feature pages
    ├── components/
    │   └── user.html     # Overrides Hydro user badge rendering
    ├── partials/
    │   ├── footer.html
    │   ├── homepage/     # checkin, countdown, sidebar_nav, recent_problems
    │   ├── problem_default.md
    │   ├── scoreboard.html
    │   └── training_list.html
    └── layout/
        └── html5.html    # Overrides Hydro base layout
```

## MongoDB Collections (all prefixed `oi33_*`)

| Collection | Key fields |
|------------|-----------|
| `oi33_user` | `_id` (== UserModel._id), `coin_now`, `coin_all`, `birthday_date`, `birthday_monthDay`, `badge_text`, `badge_color`, `badge_textColor`, `realname_flag`, `realname_name`, `checkin_time`, `checkin_luck`, `checkin_cnt_now`, `checkin_cnt_all`, `atcoder`, `codeforces`, `atcoder_rating` (Number), `codeforces_rating` (Number), `atcoder_updated_at`, `codeforces_updated_at` |
| `oi33_coin_bill` | `_id` (ObjectId), `userId`, `rootId`, `amount`, `text` |
| `oi33_paste` | `_id` (random string), `updateAt`, `title`, `owner`, `content`, `isprivate` |
| `oi33_request` | `_id` (ObjectId), `uid`, `requester`, `status` (`pending`/`approved`/`rejected`), `createdAt`, `handledAt?`, `handler?`, + same patch fields as `oi33_user` (`birthday_date`, `realname_flag`, `realname_name`, `badge_*`, `atcoder`, `codeforces`) |
| `oi33_log` | `_id` (Date), `type` (coin/birthday/badge/realname/paste/request), type-specific fields |

Every write operation also inserts into `oi33_log` so the admin activity timeline has timestamps for all entries.

## Handler Patterns

### domainId injection rule (CRITICAL)
- Methods **with** `@param` or `@query` decorators → `domainId` is injected as the **first parameter**
- Methods **without** decorators → `domainId` is NOT injected; use `''` (default domain) or the parameter won't exist

### Privilege levels used
- Public: no privilege
- `PRIV_USER_PROFILE`: any logged-in user
- `PRIV_MOD_BADGE`: admin-level (used for all management & approval operations)

### User data pattern
When rendering user lists with oi33 data:
1. Query `oi33_user` collection for relevant docs
2. Extract `uids` from results
3. Call `UserModel.getList(domainId, uids)` → returns objects WITH `hasPriv()` method (needed by `user.html` component)
4. Call `oi33Model.getUserDataByUids(uids)` → returns oi33 data dict
5. Call `oi33Model.mergeOi33Fields(udoc, oi33Data)` to merge oi33 fields onto each udoc

Never use `getListForRender` when the `user.html` component is rendered, because that component calls `udoc.hasPriv()` which is only available on `getList` results.

### Profile edit + approval flow

User-facing edit lives at `/oi33/profile/edit/:uid` (`handler/profile.ts`). The editable fields are: `birthday_date`, `realname_flag`/`realname_name`, `badge_text`/`badge_color`/`badge_textColor`, `atcoder` (username), `codeforces` (username).

AtCoder/Codeforces 用户名通过申请流程修改。AT 和 CF 的 rating 字段（`atcoder_rating`, `codeforces_rating`）及最后更新时间（`atcoder_updated_at`, `codeforces_updated_at`）由后台更新脚本自动维护，不可手动设置，但在个人页面上会显示。

- **Regular user** editing self → `oi33Model.submitRequest()` creates a `pending` doc in `oi33_request`; `oi33_user` is unchanged until approval. Existing pending for same `uid` is overwritten.
- **`PRIV_MOD_BADGE` user** → `oi33Model.directUpdate()` writes the new values to `oi33_user` AND records a status=`approved` audit entry in `oi33_request`.
- Approval queue at `/oi33/requests` (admin only). Approve → `applyRequestPayload` applies the saved fields, sets `status=approved`. Reject → sets `status=rejected`.
- Empty `badge_text` clears the entire badge triple via `$unset`. Empty `birthday_date` clears both `birthday_date` and `birthday_monthDay`.

## Routes

| Route | Handler | Permission |
|-------|---------|------------|
| `/oi33/users` | UsersShowHandler | PRIV_MOD_BADGE |
| `/oi33/coin/show` | CoinShowHandler → /oi33/users | PRIV_USER_PROFILE |
| `/oi33/coin/inc` | CoinIncHandler | PRIV_MOD_BADGE |
| `/oi33/coin/bill/:uid` | CoinBillHandler | PRIV_USER_PROFILE |
| `/oi33/birthday` | BirthdayShowHandler | public |
| `/oi33/birthday/all` | BirthdayAllHandler → /oi33/users | PRIV_USER_PROFILE |
| `/oi33/badge` | BadgeShowHandler | PRIV_USER_PROFILE |
| `/oi33/badge/manage` | BadgeManageHandler | PRIV_MOD_BADGE |
| `/oi33/badge/manage/:uid/del` | BadgeDelHandler | PRIV_MOD_BADGE |
| `/oi33/checkin` | CheckinHandler | PRIV_USER_PROFILE |
| `/oi33/profile/edit/:uid` | ProfileEditHandler | PRIV_USER_PROFILE (self only; admin can edit anyone) |
| `/oi33/requests` | RequestListHandler | PRIV_MOD_BADGE |
| `/oi33/requests/:id/approve` | RequestApproveHandler (POST) | PRIV_MOD_BADGE |
| `/oi33/requests/:id/reject` | RequestRejectHandler (POST) | PRIV_MOD_BADGE |
| `/oi33/at-cf-rating` | RatingShowHandler | public |
| `/oi33/paste/create` | PasteCreateHandler | PRIV_USER_PROFILE |
| `/oi33/paste/manage` | PasteManageHandler | PRIV_USER_PROFILE |
| `/oi33/paste/all` | PasteAllHandler | PRIV_MOD_BADGE |
| `/oi33/paste/show/:id` | PasteShowHandler | public |
| `/oi33/paste/show/:id/edit` | PasteEditHandler | PRIV_USER_PROFILE |
| `/oi33/paste/show/:id/delete` | PasteDeleteHandler | PRIV_USER_PROFILE |
| `/oi33/admin` | Oi33AdminHandler | PRIV_MOD_BADGE |
| `/oi33/migrate` | MigrateHandler | PRIV_MOD_BADGE |

**Deprecated** (deleted in profile-unification refactor):
- `/oi33/birthday/set`, `/oi33/realname/set`, `/oi33/realname/show`, `/oi33/badge/create` — use `/oi33/profile/edit/:uid` instead.

## Monkey-patches ([handler/patches.ts](handler/patches.ts))
1. **UserModel.getList** — injects oi33 fields (coin, badge, realname, birthday, atcoder, codeforces, rating fields) into `User` instances with `hasPriv()` (used by pages rendering `user.html`)
2. **UserModel.getListForRender** — same injection for plain objects without `hasPriv()` (used for lightweight rendering)
3. **HomeHandler.getCheckin** — injects `payload.oi33_checkin` for the checkin partial
4. **HomeHandler.getCountdown** — injects `payload.dates` for the countdown partial

Patches are wrapped in `applyPatches(ctx)` and called from the top-level `apply()` in [index.ts](index.ts), not import-time side effects.

## Template conventions
- Use `_('key')` for i18n (keys defined in zh.yaml)
- Use `handler.user.hasPriv(PRIV.PRIV_MOD_BADGE)` to gate admin-only UI
- Page title uses `_('Back to Admin')` → links to `/oi33/admin`, gated by `PRIV_MOD_BADGE`
- Use `{{ datetimeSpan(value)|safe }}` for timestamp rendering
- POST forms must include `<input type="hidden" name="csrfToken" value="{{ handler.csrfToken }}">`

## Installation
```bash
hydrooj addon add /path/to/oi33
pm2 restart hydrooj
# Visit /oi33/migrate to run migration (idempotent, safe to re-run)
```
