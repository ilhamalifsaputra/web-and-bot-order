# Prompt — Build a Stock Management Web App for `telegram-order-bot`

Copy the section below into a fresh Claude / Cursor / Copilot chat (or any
coding assistant) when you want to scaffold the web admin UI. Everything
the assistant needs to know about the existing bot, schema, and constraints
is included.

---

## 🎯 Goal

Build a **web-based stock & admin management dashboard** that sits next to
the existing `telegram-order-bot` project and operates on the **same
SQLite database**. The bot continues to run as-is; this web app is a
parallel admin surface so the operator no longer has to do everything from
inside Telegram.

This web app **must not** replace any bot functionality. It must coexist
with the bot and the `telegram-testimoni-bot` notifier without breaking
either of them.

---

## 📁 Project layout (what already exists)

```
C:\Users\manda\OneDrive\Dokumen\PROJECT BOT ORDER\
├── telegram-order-bot\
│   └── telegram-order-bot\          ← main bot project root
│       ├── bot\                     ← Python package (handlers/db/utils)
│       │   ├── database\
│       │   │   ├── models.py        ← SQLAlchemy 2.0 ORM models (source of truth)
│       │   │   ├── crud.py          ← async CRUD helpers (reuse these!)
│       │   │   └── session.py       ← async session_scope() context manager
│       │   ├── handlers\admin.py    ← reference for admin business logic
│       │   ├── config.py            ← pydantic Settings
│       │   ├── messages.py          ← string tables (en/id)
│       │   └── utils\i18n.py        ← t(key, lang=...) helper
│       ├── data\
│       │   └── bot.db               ← SQLite database (shared)
│       ├── .venv\                   ← existing virtualenv
│       ├── .env                     ← BOT_TOKEN, ADMIN_IDS, DATABASE_URL, …
│       └── requirements.txt
├── telegram-testimoni-bot\          ← public-channel notifier (separate bot)
└── telegram-stock-web\              ← ⭐ NEW — create this folder for the web app
```

Create the new web app at:

```
C:\Users\manda\OneDrive\Dokumen\PROJECT BOT ORDER\telegram-stock-web\
```

---

## 🧱 Tech stack (required)

- **Backend**: Python 3.12+, **FastAPI**, **SQLAlchemy 2.0 async**, **Uvicorn**
- **Frontend**: server-rendered **Jinja2** templates + **HTMX** + **Tailwind
  CSS** (via CDN — no bundler). Keep it boring; no React/Vue.
- **Auth**: session cookies signed with `itsdangerous`. Login via
  Telegram-admin-ID + a server-issued password (stored hashed in the
  `settings` table, key `web_admin_password_hash:<telegram_id>`). No
  external OAuth.
- **Reuse the bot's models and CRUD**: import directly from `bot.database`
  rather than re-declaring SQLAlchemy models. Add the order-bot project
  root to `sys.path` (same pattern the testimoni bot uses — see
  `telegram-testimoni-bot/notif_bot/main.py`).

### Why these choices

- FastAPI matches the bot's async style and works on the same SQLAlchemy
  session machinery.
- HTMX keeps the SPA-feel without the build pipeline; an operator-facing
  admin tool doesn't need a JS framework.
- Server-rendered Jinja2 lets us reuse the existing i18n strings in
  `bot/locales/*.json` if we want bilingual UI later.
- Sharing models eliminates the #1 risk: schema drift between the bot
  and the web app.

---

## 🗄️ Database (read this carefully — it's the most important part)

- **Single SQLite file**: `telegram-order-bot/telegram-order-bot/data/bot.db`.
  Both the bot and this web app read/write it concurrently.
- **Use the bot's async engine and `session_scope`** so SQLite WAL +
  busy-timeout settings are consistent. Do NOT open your own engine with
  different pragmas — you will deadlock with the bot.
- **Never modify the schema directly**. Schema changes must happen in
  `bot/database/models.py` first, then the web app picks them up via the
  shared import.
- **Always go through `bot.database.crud`** when an existing helper
  matches your need. Examples:
  - `crud.bulk_add_stock`, `crud.mark_stock_dead`,
    `crud.list_stock_items_for_product`, `crud.count_available_stock`
  - `crud.list_pending_verifications`, `crud.approve_order`,
    `crud.reject_order`
  - `crud.create_product`, `crud.update_product`, `crud.create_category`
  - `crud.create_voucher`, `crud.upsert_bulk_pricing`
  - `crud.bot_overall_stats`, `crud.revenue_summary`,
    `crud.low_stock_products`
- If a CRUD helper doesn't exist for what you need, add it in `crud.py` —
  don't write raw SQL or ad-hoc ORM queries in the web routes.
- Every state-changing endpoint must call `crud.log_admin_action(...)`
  with the acting admin's Telegram ID so the audit trail in
  `audit_logs` stays complete (the bot already does this from the
  Telegram side).

### Schema overview (already exists — do NOT recreate)

Tables (see `bot/database/models.py` for full detail):

- `users` — incl. `role` (customer/reseller/admin), `language`,
  `wallet_balance`, `referral_code`, `banned`
- `categories`, `products`, `stock_items` (status: available / reserved /
  sold / dead), `bulk_pricing`
- `orders`, `order_items` — order status enum:
  pending_payment → pending_verification → paid → delivered (or
  cancelled / rejected / refunded)
- `vouchers` (percent / fixed), `reviews`, `referrals`
- `support_tickets`, `ticket_messages`
- `restock_subscriptions`, `cart_items`
- `settings` (key/value), `audit_logs`
- `notification_outbox` — drained by the separate testimoni notifier;
  the web app should NOT post to Telegram itself

**Monetary fields use `Numeric(12, 4)`** — always work with `Decimal`,
never `float`. Display rounding is presentation-layer only.

**Timestamps are timezone-aware UTC.** Convert to `Settings.TIMEZONE`
(default `Asia/Jakarta`) on display only.

---

## 🔐 Auth model

1. **First-run bootstrap**: if no `web_admin_password_hash:*` row exists,
   the app shows a setup page that lets an existing bot admin (their
   Telegram ID must be in the order bot's `ADMIN_IDS` env var) set a
   password.
2. **Login**: Telegram ID + password. Verify the ID is still in
   `ADMIN_IDS` and the user's row in `users` has `role = ADMIN` and
   `banned = False`.
3. **Session**: signed cookie holding `{admin_user_id, expires_at}`.
   Default lifetime: 12 h sliding.
4. **CSRF**: protect every POST/PATCH/DELETE with a per-session token
   rendered into forms and validated on the server. HTMX `hx-headers`
   carries it for AJAX requests.
5. **Rate limit** the login endpoint (e.g. 5 attempts / 10 min / IP)
   using an in-process counter; that's enough for a single-operator app.

The web app reads `ADMIN_IDS` and the DB URL from the **order bot's
`.env`** — the same way the testimoni bot does. Don't duplicate secrets;
load `bot.config.get_settings()`.

---

## 🧭 Pages & features (MVP scope)

Build these screens, in this order:

### 1. Dashboard `/`
- Cards: total revenue (today / 7d / 30d), order count by status,
  low-stock product count, pending verifications count.
- Recent activity feed (last 10 audit log entries).
- Backed by `crud.bot_overall_stats`, `crud.revenue_summary`,
  `crud.low_stock_products`.

### 2. Stock management `/stock`
- **Per-product stock list**: table grouped by category → product, with
  available / reserved / sold / dead counts per product.
- **Bulk add stock**: select product, paste one credential per line
  (format `email:password` or `email|password|extra`), submit → calls
  `crud.bulk_add_stock`.
- **Per-stock-item drawer**: status, sold-to order (if any),
  added/reserved/sold timestamps, note. Actions: mark dead (with note —
  calls `crud.mark_stock_dead`), edit note.
- **CSV import** (optional stretch): one credential per row, with a dry
  run preview before commit.

### 3. Products & categories `/catalog`
- CRUD on `categories` (name, emoji, sort_order, is_active).
- CRUD on `products` (name, description, type, duration_label, price,
  reseller_price, warranty_days, is_active). Image is a Telegram
  `file_id` — for now just show/edit the raw string; a proper image
  picker is a stretch goal.
- Per-product bulk pricing rule (`bulk_pricing`).

### 4. Orders `/orders`
- Filter by status, user, date range, order code, voucher.
- Order detail page: items, payment proof image (resolve Telegram
  `file_id` via the bot only if a simple proxy is easy — otherwise just
  display the `file_id` as text), buyer info, totals breakdown, admin
  notes, audit trail.
- Actions for `pending_verification` orders:
  - **Approve** → calls `crud.approve_order(...)`. The bot's existing
    flow will enqueue the testimoni notification — do NOT post to
    Telegram from here.
  - **Reject** with reason → `crud.reject_order(...)`.
- Show delivered credentials only to logged-in admins, and **never log
  them** (the schema comment in `models.py` says so).

### 5. Vouchers `/vouchers`
- List, create (percent/fixed, usage limit, min purchase, expiry),
  toggle active. Reuse `crud.create_voucher`.

### 6. Users `/users`
- Search by Telegram ID / username / name (`crud.search_users`).
- User detail: orders, total spent (`crud.user_total_spent`), wallet
  balance, referral stats, support tickets.
- Actions: change role, ban/unban with reason, manual wallet adjustment
  (calls `crud.adjust_wallet` — must always be logged via
  `log_admin_action`).

### 7. Support tickets `/support`
- List open / replied / closed.
- Thread view with `ticket_messages`. Posting a reply from the web
  inserts a `TicketMessage` with `sender_type=ADMIN`. The bot's existing
  notifier will deliver it to the user (verify this in the bot code —
  if not, leave a TODO; do not duplicate the delivery here).

### 8. Settings `/settings`
- View runtime settings from the `settings` table.
- Edit specific known keys (whitelist) — never let the operator edit
  arbitrary keys via the UI; that's how you brick the bot.
- Change web-admin password.

### 9. Audit log `/audit`
- Filter by admin, action, target type, date range. Read-only.

### Out of scope for MVP

- Telegram bot management (start/stop, edit messages.py strings, etc.).
- Real-time push (use plain HTMX polling on the dashboard if needed —
  no WebSockets).
- Multi-tenant / multi-bot support.

---

## ⚙️ Concrete requirements

- Python ≥ 3.12, but the existing bot virtualenv uses 3.14 — match it.
- Use a **separate** `.venv` in `telegram-stock-web/` so the web's
  FastAPI/uvicorn deps don't pollute the bot's lockfile.
- All DB access async; never use a sync `Session`. The single source of
  the engine is `bot.database.session.session_scope`.
- HTMX targets and IDs should be stable and semantic so a future
  operator can run a screen reader / keyboard nav.
- Error handling: render a friendly error page on uncaught exceptions;
  log the traceback to `telegram-stock-web/data/logs/web.log` with the
  same rotating handler the bot uses.
- Logging: never log credential rows, payment proof file_ids, or
  password hashes.
- All money columns rendered with the currency from
  `Settings.CURRENCY` and `Decimal.quantize(Decimal('0.0001'))`.
- All timestamps rendered in `Settings.TIMEZONE` with the UTC offset
  shown in a tooltip.

---

## 🚀 Local dev run instructions (Windows)

```powershell
cd "C:\Users\manda\OneDrive\Dokumen\PROJECT BOT ORDER\telegram-stock-web"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
# Make sure ../telegram-order-bot/telegram-order-bot/.env is filled in
# (BOT_TOKEN, ADMIN_IDS, DATABASE_URL must already be set for the bot).
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Also add a one-click launcher: `run-web.ps1` at the parent project root,
following the same pattern as the existing `run-all.ps1`.

---

## 🌐 Production deployment (single-VPS topology)

The web app, the order bot, and the testimoni notifier **all run on the
same VPS** (e.g. Namecheap KVM, Hostinger VPS, Hetzner CX11, Contabo,
etc.) and share the single `bot.db` SQLite file. The web is exposed to
the public internet via a reverse proxy with TLS; the bot and the
notifier stay process-local.

### Architecture

```
                Internet
                    │
                    ▼
            ┌───────────────┐
            │ Caddy (443)   │  ← public TLS, auto Let's Encrypt
            └───────┬───────┘
                    │  reverse proxy
                    ▼
        ┌──────────────────────────┐
        │ uvicorn (127.0.0.1:8000) │  ← telegram-stock-web
        └─────────────┬────────────┘
                      │  reads/writes
                      ▼
        ┌──────────────────────────┐
        │  bot.db (SQLite, WAL)    │
        └─────────────┬────────────┘
                      ▲
       ┌──────────────┴──────────────┐
       │                             │
┌──────┴───────┐             ┌──────┴────────┐
│ order bot    │             │ notifier bot  │
│ (Telegram)   │             │ (testimoni)   │
└──────────────┘             └───────────────┘
```

All three Python processes are supervised by **systemd** so they
auto-restart on crash and survive reboots.

### VPS prerequisites

- Debian 12 or Ubuntu 24.04 LTS.
- A domain (or subdomain) pointed at the VPS A record, e.g.
  `admin.yourdomain.com`.
- Ports **22, 80, 443** open inbound. **Block everything else** with
  ufw — the order bot uses long-poll outbound, so it needs *zero*
  inbound ports.
- Python 3.12+ (match the bot's venv — currently 3.14).
- `git`, `caddy`, `sqlite3`.
- A dedicated unprivileged user (`botuser`) — never run any of this as
  root.

### Directory layout on the VPS

```
/opt/bot-order/
├── telegram-order-bot/telegram-order-bot/   ← order bot
├── telegram-testimoni-bot/                  ← notifier bot
├── telegram-stock-web/                      ← web app
└── backups/                                 ← nightly SQLite snapshots
```

### Reverse proxy (Caddy — recommended over nginx)

Caddy auto-provisions Let's Encrypt certificates; no certbot ritual.

`/etc/caddy/Caddyfile`:

```
admin.yourdomain.com {
    encode gzip
    reverse_proxy 127.0.0.1:8000
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options    "nosniff"
        X-Frame-Options           "DENY"
        Referrer-Policy           "no-referrer"
    }
}
```

```
systemctl reload caddy
```

TLS comes up on the first request.

### systemd units

`/etc/systemd/system/order-bot.service`:

```ini
[Unit]
Description=Telegram Order Bot
After=network-online.target
Wants=network-online.target

[Service]
User=botuser
WorkingDirectory=/opt/bot-order/telegram-order-bot/telegram-order-bot
ExecStart=/opt/bot-order/telegram-order-bot/telegram-order-bot/.venv/bin/python -m bot.main
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/notif-bot.service`:

```ini
[Unit]
Description=Testimoni Notifier Bot
After=order-bot.service
Requires=order-bot.service

[Service]
User=botuser
WorkingDirectory=/opt/bot-order/telegram-testimoni-bot
ExecStart=/opt/bot-order/telegram-testimoni-bot/.venv/bin/python -m notif_bot.main
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/stock-web.service`:

```ini
[Unit]
Description=Stock Management Web
After=order-bot.service

[Service]
User=botuser
WorkingDirectory=/opt/bot-order/telegram-stock-web
ExecStart=/opt/bot-order/telegram-stock-web/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

Enable + start everything:

```
systemctl daemon-reload
systemctl enable --now order-bot notif-bot stock-web caddy
```

Live logs: `journalctl -u stock-web -f` (swap the unit name for the
other two).

### Firewall

```
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw enable
```

Port `8000` is never exposed publicly — Caddy proxies it locally.

### Backups

Nightly cron snapshot using SQLite's `.backup` (safe while WAL is
live):

```
0 3 * * *  /usr/bin/sqlite3 /opt/bot-order/telegram-order-bot/telegram-order-bot/data/bot.db ".backup '/opt/bot-order/backups/bot-$(date +\%F).db'"
```

Keep the last 14 days, then rclone-sync to off-site object storage
(B2 / R2 / S3) — a single-VPS topology has no DB redundancy by
default, so off-site backups are the whole disaster-recovery story.

### Update / redeploy procedure

```
systemctl stop stock-web notif-bot order-bot

cd /opt/bot-order/telegram-order-bot/telegram-order-bot
git pull && .venv/bin/pip install -r requirements.txt

cd /opt/bot-order/telegram-stock-web
git pull && .venv/bin/pip install -r requirements.txt

systemctl start order-bot notif-bot stock-web
```

Order matters: start the order bot first so its `init_db()` runs
before the others touch the file.

### Scaling note

SQLite + a single VPS comfortably handles a single-operator dashboard
plus the bot's normal throughput. The day you want a second admin
posting concurrently from another laptop, or any kind of horizontal
redundancy, switch to Postgres — the SQLAlchemy code already supports
it; only `DATABASE_URL` and the driver dep change.

---

## 📦 Deliverable file layout

```
telegram-stock-web\
├── app\
│   ├── __init__.py
│   ├── main.py                ← FastAPI app factory, mounts routers
│   ├── deps.py                ← session_scope dep, current_admin dep
│   ├── auth.py                ← login/logout/CSRF/password helpers
│   ├── routers\
│   │   ├── dashboard.py
│   │   ├── stock.py
│   │   ├── catalog.py
│   │   ├── orders.py
│   │   ├── vouchers.py
│   │   ├── users.py
│   │   ├── support.py
│   │   ├── settings.py
│   │   └── audit.py
│   ├── templates\             ← Jinja2 templates (base.html + per-page)
│   └── static\                ← Tailwind via CDN, plus minimal app.css
├── data\logs\                 ← rotating log dir
├── tests\                     ← pytest-asyncio + httpx.AsyncClient
├── requirements.txt
├── .env.example               ← only WEB_-prefixed vars; DB & admins come from the bot's .env
├── README.md
└── pyproject.toml             ← black/ruff config matching the bot's style
```

---

## ✅ Acceptance criteria

1. Web app starts with `uvicorn app.main:app` and serves `/login` on
   `127.0.0.1:8000`.
2. With the order bot running, the web app can read live data and
   issue writes (e.g. approving a pending order) without SQLite-locked
   errors over a 5-minute soak test.
3. Approving an order in the web app produces:
   - The order row's status flipping to `delivered`,
   - A row in `notification_outbox` with the buyer's `language` in the
     payload (so the testimoni bot picks it up correctly),
   - An entry in `audit_logs` with the acting admin's Telegram ID.
4. Logging out invalidates the session cookie server-side, not just by
   clearing the cookie.
5. Every state-changing endpoint has a corresponding pytest covering
   the happy path and at least one auth-failure path.
6. The bot's existing tests (`pytest` in `telegram-order-bot/`) still
   pass after any change you made to `bot/database/crud.py` to add
   helpers for the web app.

---

## 🚫 Do not

- Do not duplicate the SQLAlchemy models. Import them.
- Do not bypass `crud.py` with raw SQL.
- Do not send Telegram messages from the web app. The bot and the
  notifier handle all outbound messaging.
- Do not log secrets (credentials, password hashes, payment proof
  `file_id`, full DB URLs).
- Do not introduce migrations tooling (Alembic) in this PR — the bot
  uses `Base.metadata.create_all` and schema is stable for MVP.
- Do not assume the operator wants a public deployment. Bind to
  `127.0.0.1` by default; document that exposing it requires a reverse
  proxy + TLS + a stronger auth review.

---

## 🧪 Suggested first commit

After scaffolding, the first PR should land just:

1. Project skeleton + `requirements.txt` + `.env.example`.
2. `app.main` with health check `/healthz`.
3. Read-only Dashboard page wired to `crud.bot_overall_stats`.
4. Login page + bootstrap-first-admin flow.
5. README with run instructions.

Subsequent PRs add Stock → Orders → Catalog → Users → Vouchers →
Support → Settings → Audit, in that order, each behind its own router
file and template subdir.

---

*End of prompt. Paste everything from "Goal" downward into your coding
assistant to begin.*

---

# 📈 Post-MVP feature suggestions (roadmap)

> **Status update:** the admin has since been **migrated to the Node/TS stack**
> (`apps/web-admin` — Fastify 5 + Nunjucks + HTMX, shared `@app/db` Prisma layer).
> The 9 MVP pages above are all built. The suggestions below target that Node
> app. **Ground rules still apply:** the web **never** sends Telegram messages
> (enqueue to `notification_outbox`, let the notifier deliver); every mutation
> calls `logAdminAction`; money stays `Decimal`; settings edits are
> whitelist-only; never log credentials / proof `file_id` / hashes.
>
> Each item is tagged with effort (S/M/L) and whether it reuses existing CRUD or
> needs new `@app/db` helpers. Priorities are a suggestion, not gospel.

## Tier 1 — highest leverage (do first)

> **✅ All three Tier 1 items shipped.** `/payments` ops panel, `/outbox` monitor,
> and the dashboard SLA widgets are live in `apps/web-admin` with Vitest coverage.
> A poller heartbeat (`binance_poll_health` setting) was added to the order-bot
> so the health card reflects real liveness.

### 1. Binance Internal Transfer ops panel `/payments`  · M · new crud  — ✅ DONE
We just added UID-based auto-confirm (`ProcessedBinanceTx` ledger, `UNDERPAID`
status). Give the operator visibility + manual levers:
- **Transfer ledger**: list `processed_binance_tx` (matched / underpaid /
  unmatched / delivery_failed) with the linked order, amount, timestamp.
- **Resolve UNDERPAID**: per order, one-click → top-up wallet for the diff,
  deliver anyway, refund, or cancel (all audited).
- **Manual match**: when a buyer forgot the note, attach an `UNMATCHED` tx to a
  PENDING order → run the same `deliverPaidInternalOrder` path.
- **Poller health card**: last poll time, last fetched-tx count, backoff state.
*Why:* auto-confirm WILL have edge cases (wrong note, short pay); without this
the operator is blind to money that arrived but didn't deliver.

### 2. Outbox / notifications monitor `/outbox`  · S · reuse crud  — ✅ DONE
Surface `notification_outbox`: PENDING / SENT / FAILED with `last_error` and
`attempts`. Actions: **retry failed** (reset to PENDING), inspect payload.
*Why:* delivery is fire-and-forget today; a stuck/failed testimoni or credential
notice is currently invisible until a customer complains.

### 3. Stale-order & SLA dashboard widgets  · S · reuse crud  — ✅ DONE
On the dashboard: count + list of orders **aging in PENDING_VERIFICATION**
(>N hours), pending-payment about to expire, and warranties expiring in 3 days
(the bot already computes this for reminders — show it). HTMX-poll refresh.
*Why:* turns the dashboard from vanity metrics into an action queue.

## Tier 2 — operational depth

> **✅ §4–§7 shipped** in `apps/web-admin` with Vitest coverage. §8 (bulk ops)
> is the remaining Tier 2 item.

### 4. Wallet ledger + manual top-up `/users/:id/wallet`  · M · new crud  — ✅ DONE
A per-user wallet transaction history (every `adjustWallet` with reason + admin),
not just the current balance. Top-up / deduct form with mandatory reason.
*Why:* manual wallet moves are money; an audit trail per user is essential.
*Shipped:* the ledger is derived from `audit_logs` (action `wallet_adjust`,
`target_type=user`) via `listWalletLedger` — no new table — and rendered on the
user detail page; the adjustment form now **requires** a reason. Automated
credits (underpaid refunds) stay on `/payments` where they're audited.

### 5. Reviews moderation `/reviews`  · S · new crud  — ✅ DONE
List reviews (rating + comment + product + buyer), hide/flag abusive ones,
per-product average + count. *Why:* reviews feed reputation; need a kill switch.
*Shipped:* added a `reviews.hidden` column (migration
`20260531140000_review_hidden`); the order bot now **excludes hidden reviews**
from the per-product rating average it shows customers, so the kill switch is
real, not cosmetic. New crud: `listReviews` / `countReviews` /
`setReviewHidden` / `productRatingSummaries`.

### 6. Restock waitlist view `/stock` enhancement  · S · reuse crud  — ✅ DONE
Show `restock_subscriptions` per product ("12 waiting"). When bulk-adding stock,
display how many will be notified (the bot enqueues the notify).
*Shipped:* a "Waiting" column on `/stock` (via `restockSubscriberCounts`) and a
banner on the per-product page (`countRestockSubscribers`) before bulk add.

### 7. Reports & charts `/reports`  · M · new crud  — ✅ DONE
Beyond the existing CSV: revenue by day/7d/30d (server-rendered SVG sparkline or
Chart.js via CDN — a lib, not a framework, so it fits the "no build" rule),
top products, voucher usage, referral payouts, orders-by-status funnel.
*Shipped:* `/reports` with a **server-rendered SVG sparkline** (no JS lib) for
30-day daily revenue, plus top products, orders-by-status funnel, and voucher
usage. New crud: `revenueByDay` / `topProducts` / `ordersByStatus` /
`voucherUsage`.

### 8. Bulk operations  · M · new crud
Bulk mark-dead stock, bulk activate/deactivate products, bulk price update,
product CSV import with a dry-run preview (mirrors the stock CSV idea).

## Tier 3 — platform / hardening

### 9. Multi-admin + RBAC  · L · schema + new crud
Today it's effectively single-operator. Add admin accounts with roles
(super-admin / support-only / read-only); gate routes per role; the audit log
already keys by admin so attribution is ready. Needs a small schema addition.

### 10. Web login 2FA + session management  · M · new crud
TOTP on top of the existing bcrypt + `jti` rotation; an "active sessions" list
with force-logout. *Why:* this dashboard can approve orders and move wallet
balances — it deserves more than a password.

### 11. Admin-UI i18n (EN/ID)  · S · reuse `@app/core/i18n`
The locale tables already exist; render the admin UI bilingually via the same
`t()` loader. Low effort, nice for a non-English operator.

### 12. Broadcast composer `/broadcast`  · M · needs a bot-side drainer
Compose + preview + segment (all / resellers / recent buyers) + schedule.
**Constraint:** the web must NOT send Telegram itself — it enqueues to a
broadcast queue/outbox that the bot drains. Don't ship the web half without the
bot half, or messages silently pile up.

### 13. Global search / quick-jump  · S · reuse crud
One box → jump to an order by code, a user by TG id/username, or a product by
name. Pure quality-of-life for a busy operator.

## Explicitly out of scope (still)
- Sending Telegram messages directly from the web (always via outbox/bot).
- Editing arbitrary `settings` keys (whitelist only — see §8 of the MVP).
- Real-time push / WebSockets (HTMX polling is enough for one operator).

## Implementation notes that bite
- **No raw SQL in routes** — add helpers to `packages/db/src/crud/*`, mirror the
  existing per-domain split, and cover them with the Vitest harness.
- **Decimal everywhere** for money; the `money` Nunjucks filter already exists.
- **UTC in DB, `TIMEZONE` on display** (the `localdt` filter handles this).
- **Audit every state change** with the acting admin id (`logAdminAction`).
- **CSRF**: reuse the existing `csrfProtect` preHandler on every new POST.
- Anything touching the **shared SQLite** must keep transactions short
  (single-writer); for genuinely concurrent multi-admin writes, that's the
  trigger to move to Postgres (see `RUN.md §9`).
