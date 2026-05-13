# OI33 — 33OJ Unified Hydro Plugin

Integrates 8 legacy plugins (coin, birthday, badge, realname, checkin, countdown, pastebin, frontend) into a single Hydro addon.

## Architecture

```
oi33/
├── package.json          # Hydro addon manifest
├── index.ts              # Main entry: handlers, routes, monkey-patches
├── model.ts              # Database layer (MongoDB collections + operations)
├── migrate.ts            # Data migration from legacy plugins (idempotent)
├── frontend/
│   └── foo.page.ts       # Client-side UserSelectAutoComplete init
├── locales/
│   └── zh.yaml           # Chinese i18n strings (~120 keys)
├── public/               # Static assets (favicons, logo)
└── templates/            # Nunjucks templates
    ├── oi33_*.html       # Feature pages (16 templates)
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
| `oi33_user` | `_id` (== UserModel._id), `coin_now`, `coin_all`, `birthday_date`, `birthday_monthDay`, `badge_text`, `badge_color`, `badge_textColor`, `realname_flag`, `realname_name`, `checkin_time`, `checkin_luck`, `checkin_cnt_now`, `checkin_cnt_all` |
| `oi33_coin_bill` | `_id` (ObjectId), `userId`, `rootId`, `amount`, `text` |
| `oi33_paste` | `_id` (random string), `updateAt`, `title`, `owner`, `content`, `isprivate` |
| `oi33_log` | `_id` (Date), `type` (coin/birthday/badge/realname/paste), type-specific fields |

Every write operation also inserts into `oi33_log` so the admin activity timeline has timestamps for all entries.

## Handler Patterns

### domainId injection rule (CRITICAL)
- Methods **with** `@param` or `@query` decorators → `domainId` is injected as the **first parameter**
- Methods **without** decorators → `domainId` is NOT injected; use `''` (default domain) or the parameter won't exist

### Privilege levels used
- Public: no privilege
- `PRIV_USER_PROFILE`: any logged-in user
- `PRIV_MOD_BADGE`: admin-level (used for all management operations)

### User data pattern
When rendering user lists with oi33 data:
1. Query `oi33_user` collection for relevant docs
2. Extract `uids` from results
3. Call `UserModel.getList(domainId, uids)` → returns objects WITH `hasPriv()` method (needed by `user.html` component)
4. Call `oi33Model.getUserDataByUids(uids)` → returns oi33 data dict
5. Call `oi33Model.mergeOi33Fields(udoc, oi33Data)` to merge oi33 fields onto each udoc

Never use `getListForRender` when the `user.html` component is rendered, because that component calls `udoc.hasPriv()` which is only available on `getList` results.

## Routes (19 total)

| Route | Handler | Permission |
|-------|---------|------------|
| `/oi33/users` | UsersShowHandler | PRIV_MOD_BADGE |
| `/oi33/coin/show` | CoinShowHandler → redirects to /oi33/users | PRIV_USER_PROFILE |
| `/oi33/coin/inc` | CoinIncHandler | PRIV_MOD_BADGE |
| `/oi33/coin/bill/:uid` | CoinBillHandler | PRIV_USER_PROFILE |
| `/oi33/birthday/set` | BirthdaySetHandler | PRIV_MOD_BADGE |
| `/oi33/birthday` | BirthdayShowHandler | public |
| `/oi33/birthday/all` | BirthdayAllHandler → redirects to /oi33/users | PRIV_USER_PROFILE |
| `/oi33/badge` | BadgeShowHandler | PRIV_USER_PROFILE |
| `/oi33/badge/create` | BadgeCreateHandler | PRIV_MOD_BADGE |
| `/oi33/badge/manage` | BadgeManageHandler | PRIV_MOD_BADGE |
| `/oi33/badge/manage/:uid/del` | BadgeDelHandler | PRIV_MOD_BADGE |
| `/oi33/realname/set` | RealnameSetHandler | PRIV_MOD_BADGE |
| `/oi33/realname/show` | RealnameShowHandler → redirects to /oi33/users | PRIV_MOD_BADGE |
| `/oi33/checkin` | CheckinHandler | PRIV_USER_PROFILE |
| `/oi33/paste/create` | PasteCreateHandler | PRIV_USER_PROFILE |
| `/oi33/paste/manage` | PasteManageHandler | PRIV_USER_PROFILE |
| `/oi33/paste/all` | PasteAllHandler | PRIV_MOD_BADGE |
| `/oi33/paste/show/:id` | PasteShowHandler | public |
| `/oi33/paste/show/:id/edit` | PasteEditHandler | PRIV_USER_PROFILE |
| `/oi33/paste/show/:id/delete` | PasteDeleteHandler | PRIV_USER_PROFILE |
| `/oi33/admin` | Oi33AdminHandler | PRIV_MOD_BADGE |
| `/oi33/migrate` | MigrateHandler | PRIV_MOD_BADGE |

## Monkey-patches (in index.ts)
1. **UserModel.getListForRender** — injects oi33 fields (coin, badge, realname, birthday) into user objects for all Hydro pages
2. **HomeHandler.getCheckin** — injects `payload.oi33_checkin` for the checkin partial
3. **HomeHandler.getCountdown** — injects `payload.dates` for the countdown partial

## Template conventions
- Use `_('key')` for i18n (keys defined in zh.yaml)
- Use `handler.user.hasPriv(PRIV.PRIV_MOD_BADGE)` to gate admin-only UI
- Page title uses `_('Back to Admin')` → links to `/oi33/admin`, gated by `PRIV_MOD_BADGE`
- Use `{{ datetimeSpan(value)|safe }}` for timestamp rendering

## Installation
```bash
hydrooj addon add /path/to/oi33
pm2 restart hydrooj
# Visit /oi33/migrate to run migration (idempotent, safe to re-run)
```
