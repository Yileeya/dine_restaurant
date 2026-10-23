# 餐廳預約系統

單一 Cloudflare Worker：`public/` 是前端（原生 HTML/JS），`src/` 是 API（Hono），資料存在 D1。
前後端同網域，不需處理 CORS。規則數值集中在 `src/rules.ts`，對應[規格書](docs/規格書_v1.xlsx) Rules 工作表。

## Demo

- 前台：https://dine-restaurant.yilee.workers.dev
- 後台：https://dine-restaurant.yilee.workers.dev/admin/login

## 環境需求

- Node.js 24 以上（開發時使用 24.22.1）
- npm（隨 Node.js 安裝）

## 本機開發

```bash
npm install
cp .dev.vars.example .dev.vars      # 本機帳密與測試 API 開關
npm run types                       # 產生 worker-configuration.d.ts（型別檔，不進版控）
npm run db:init:local               # 建立本機資料表（會清空資料）
npm run dev                         # http://localhost:8787
```

- 前台：`/`
- 後台：`/admin/login` → `/admin/reservations`（帳密見 `.dev.vars`）

## 部署上線（免費方案）

```bash
npx wrangler login                  # 第一次需登入 Cloudflare
npx wrangler d1 create restaurant-db
# 把輸出的 database_id 貼到 wrangler.jsonc 的 REPLACE_ME
npm run db:init:remote
npx wrangler secret put ADMIN_USER
npx wrangler secret put ADMIN_PASS
npx wrangler secret put SESSION_SECRET
npm run deploy                      # 輸出 https://dine-restaurant.<你的子網域>.workers.dev
```

正式環境**不要**設定 `ENABLE_TEST_API`，測試專用 API 會回 404。

## API

| Method | Path | 說明 | 規則 |
| --- | --- | --- | --- |
| GET | `/api/availability?date=YYYY-MM-DD` | 各時段剩餘名額、可預約日期範圍 | BR-04、12 |
| POST | `/api/reservations` | 建立預約 `{name, phone, date, slot, guests}` | BR-01~08 |
| POST | `/api/admin/login` | `{username, password}`，成功設 HttpOnly cookie | BR-09 |
| POST | `/api/admin/logout` | 清除 cookie | — |
| GET | `/api/admin/reservations?date=&q=` | 需登入；`q` 比對姓名或電話 | BR-09、10 |
| DELETE | `/api/admin/reservations/:id` | 需登入 | BR-09、11 |
| POST | `/api/test/reset` | 清空資料（僅測試環境） | — |
| POST | `/api/test/seed` | `{reservations: [...]}` 直接寫入前置資料（僅測試環境） | — |

錯誤格式：`400 {error:"VALIDATION_ERROR", fields:{phone:"INVALID_PHONE"}}`、`409 {error:"SLOT_FULL", remaining:5}`、`409 {error:"DUPLICATE"}`、`401 {error:"UNAUTHORIZED"}`。

## 注意

- 「今天」以台灣時間（UTC+8）計算，可預約 D+1 ~ D+30。
- 建立預約用單一 SQL 同時檢查容量與寫入，避免兩人同時送出時超賣。
- 資料庫有 CHECK 約束（每筆 1–10 人、只允許 4 個時段），測試種子資料「某時段已有 15 人」要拆成多筆。
