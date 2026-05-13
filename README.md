# OI33 — 33OJ 统一插件

整合了 8 个独立 Hydro 插件：硬币、生日、徽章、实名、签到、倒计时、剪贴板、前端覆盖。

## 功能

| 功能 | 说明 | 路由 |
|------|------|------|
| 硬币 | 余额排行、发放/扣除、交易流水 | `/oi33/coin/*` |
| 生日 | 设置生日、今日寿星展示（含动画）、全部生日列表 | `/oi33/birthday/*` |
| 徽章 | 创建/编辑/删除徽章 | `/oi33/badge/*` |
| 实名 | 学生/老师认证、实名展示 | `/oi33/realname/*` |
| 签到 | 每日打卡+运势、连续签到统计 | `/oi33/checkin` |
| 倒计时 | 首页倒计时组件（配置驱动） | 首页 partial |
| 剪贴板 | Markdown 剪贴板 CRUD、公有/私有 | `/oi33/paste/*` |
| 前端覆盖 | Logo、favicon、模板覆盖 | 静态资源 |
| 管理仪表盘 | 统一查看所有数据 | `/oi33/admin` |
| 数据迁移 | 从老插件迁移数据到新集合 | `/oi33/migrate` |

## 数据库

新插件使用 `oi33_*` 前缀的 4 个集合，与 Hydro 核心的 `user` 集合解耦：

| 集合 | 用途 |
|------|------|
| `oi33_user` | 用户属性：硬币余额、生日、徽章、实名、签到数据 |
| `oi33_coin_bill` | 硬币交易流水 |
| `oi33_paste` | 剪贴板文档 |
| `oi33_log` | 操作日志（硬币、生日、徽章、实名、剪贴板） |

## 权限配置

| 路由 | 所需权限 | 说明 |
|------|---------|------|
| `/oi33/birthday` | 公开 | 查看今日生日 |
| `/oi33/birthday/all` | `PRIV_USER_PROFILE` | 查看所有用户生日 |
| `/oi33/paste/show/:id` | 公开 | 查看公开剪贴板 |
| `/oi33/checkin` | `PRIV_USER_PROFILE` | 每日签到 |
| `/oi33/coin/show` | `PRIV_USER_PROFILE` | 查看硬币排行 |
| `/oi33/coin/bill/:uid` | `PRIV_USER_PROFILE` | 查看自己账单（查看他人需 `PRIV_MOD_BADGE`） |
| `/oi33/badge` | `PRIV_USER_PROFILE` | 查看徽章 |
| `/oi33/paste/create` | `PRIV_USER_PROFILE` | 创建剪贴板 |
| `/oi33/paste/manage` | `PRIV_USER_PROFILE` | 管理自己的剪贴板 |
| `/oi33/paste/show/:id/edit` | `PRIV_USER_PROFILE` | 编辑自己剪贴板（编辑他人需 `PRIV_MOD_BADGE`） |
| `/oi33/paste/show/:id/delete` | `PRIV_USER_PROFILE` | 删除自己剪贴板（删除他人需 `PRIV_MOD_BADGE`） |
| `/oi33/coin/inc` | `PRIV_MOD_BADGE` | 发放硬币 |
| `/oi33/birthday/set` | `PRIV_MOD_BADGE` | 设置生日 |
| `/oi33/badge/create` | `PRIV_MOD_BADGE` | 创建徽章 |
| `/oi33/badge/manage` | `PRIV_MOD_BADGE` | 管理徽章 |
| `/oi33/badge/manage/:uid/del` | `PRIV_MOD_BADGE` | 删除徽章 |
| `/oi33/realname/set` | `PRIV_MOD_BADGE` | 设置实名 |
| `/oi33/realname/show` | `PRIV_MOD_BADGE` | 查看实名列表 |
| `/oi33/paste/all` | `PRIV_MOD_BADGE` | 查看所有剪贴板 |
| `/oi33/admin` | `PRIV_MOD_BADGE` | 管理仪表盘 |
| `/oi33/migrate` | `PRIV_MOD_BADGE` | 执行数据迁移 |
| `/oi33/users` | `PRIV_MOD_BADGE` | 查看全部用户数据 |

## 安装与迁移

```bash
# 1. 安装插件
hydrooj addon add /path/to/oi33
pm2 restart hydrooj

# 2. 管理员访问 /oi33/migrate 执行数据迁移（幂等，可重复执行）
#    迁移来源：
#    - coin 集合 → oi33_coin_bill
#    - paste 集合 → oi33_paste
#    - birthday 集合 → oi33_user
#    - user 集合字段 (coin_*, badge, realname_*, checkin_*) → oi33_user

# 3. 确认迁移数据正确后，移除老插件
hydrooj addon remove coin-33oj
hydrooj addon remove birthday-33oj
hydrooj addon remove badge-33oj
hydrooj addon remove realname-33oj
hydrooj addon remove checkin-33oj
hydrooj addon remove countdown-33oj
hydrooj addon remove pastebin-33oj
hydrooj addon remove frontend-33oj

# 4. 清理老数据（可选）
#    db.birthday.drop()
#    db.coin.drop()
#    db.paste.drop()
#    db.user.updateMany({}, { $unset: { coin_now:"", coin_all:"", badge:"", realname_flag:"", realname_name:"", checkin_time:"", checkin_luck:"", checkin_cnt_now:"", checkin_cnt_all:"" } })
```

## 系统设置

在 Hydro 后台「系统设置」→ `hydrooj` → `homepage` 中配置。以下为完整示例：

```yaml
- width: 9
  bulletin: true
  contest: 5
  homework: 10
  training: 10
  ranking: 10
  discussion: 20
- width: 3
  checkin:
    luck_type:
      - text: "大吉"
        color: "#ED5A65"
      - text: "吉"
        color: "#ED5A65"
      - text: "小吉"
        color: "#ED5A65"
      - text: "平"
        color: "#161823"
      - text: "小凶"
        color: "#161823"
      - text: "小凶"
        color: "#161823"
      - text: "大凶"
        color: "#161823"
    luck_template:
      - text: "大吉"
        color: "#ED5A65"
      - text: "吉"
        color: "#ED5A65"
      - text: "小吉"
        color: "#ED5A65"
      - text: "平"
        color: "#161823"
      - text: "小凶"
        color: "#161823"
      - text: "小凶"
        color: "#161823"
      - text: "大凶"
        color: "#161823"
    luck_vip:
      - 18, 1422
  countdown:
    title: 倒计时
    max_dates: 5
    dates:
      - name: APIO 2026
        date: 2026-05-07
      - name: NOI 2026
        date: 2026-07-18
      - name: IOI 2026
        date: 2026-08-09
      - name: CSP-J/S 第一轮
        date: 2026-09-19
      - name: CSP-J/S 第二轮
        date: 2026-10-31
      - name: NOIP & 女生赛
        date: 2026-11-28
  sidebar_nav:
    - title: 常用功能
      urls:
        - name: 软件下载
          url: /p/SOFTWARE
        - name: "三三百科"
          url: https://33dai.wiki
        - name: 初学者常用内容
          url: https://www.33dai.wiki/w/%E5%88%9D%E5%AD%A6%E8%80%85%E5%B8%B8%E7%94%A8%E5%86%85%E5%AE%B9
        - name: 题目分享
          url: https://pan.baidu.com/s/5XGUMx5EV1MhTN7S7oIxUeA
        - name: 打字练习
          url: https://type.33dai.cn
    - title: 33OJ
      urls:
        - name: 生日快乐
          url: /oi33/birthday
        - name: 管理后台
          url: /oi33/admin
        - name: 云剪贴板
          url: /oi33/paste/manage
    - title: 常用 OJ
      urls:
        - name: HydroOJ
          url: https://hydro.ac/
        - name: 洛谷
          url: https://www.luogu.com.cn/
        - name: AtCoder
          url: https://atcoder.jp/
        - name: CodeForces
          url: https://codeforces.com/
  hitokoto: true
  starred_problems: 50
  recent_problems: 10
  discussion_nodes: true
  suggestion: true
```

### checkin 配置项

| 字段 | 说明 |
|------|------|
| `luck_type` | 7 级运势的文字和颜色，对应 checkin_luck 0-6 |
| `luck_template` | 预留，当前与 luck_type 保持一致 |
| `luck_vip` | VIP 用户 UID 列表，始终显示「大吉」 |

### countdown 配置项

| 字段 | 说明 |
|------|------|
| `title` | 倒计时组件标题 |
| `max_dates` | 最多显示几条倒计时 |
| `dates` | 倒计时列表，每条含 `name`（名称）和 `date`（日期 YYYY-MM-DD），已过日期自动隐藏 |

### sidebar_nav 配置项

| 字段 | 说明 |
|------|------|
| `title` | 链接分组标题 |
| `urls` | 链接列表，每条含 `name`（显示名）和 `url`（链接地址） |

