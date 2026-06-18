# Laporan Phase 0 — Project Understanding

Tanggal: 2026-06-18 · Sifat: read-only (tidak ada kode diubah)

---

## 1. Architecture Overview

### 1.1 Folder tree penting
```
apps/
  server/      composition root PRODUKSI — boot 1 proses: web-admin + storefront + bot + notifier
  web-admin/   Fastify+Nunjucks+HTMX — panel admin (routes/, plugins/auth, lib/upload)
  storefront/  Fastify+Nunjucks — toko pelanggan (routes/, cards.ts, views/)
  order-bot/   grammY — Telegram (handlers/, conversations/, keyboards/, jobs/, payments/)
  notifier/    grammY — pengirim antrian Telegram (drain notification_outbox)
packages/
  core/        money(Decimal), i18n(en/id), config(zod), password(bcrypt), logger(pino), mailer(nodemailer)
  db/          Prisma + crud/* (per-domain) + client.ts (PRAGMA WAL)
  web-ui/      macro Nunjucks bersama (_macros.njk) — dipakai web-admin & storefront
prisma/schema.prisma   24 model, ~28 @@index, FK aktif
data/bot.db            SQLite tunggal (WAL)
scripts/               build-bundle, reset-admin-password, bybit-probe
```

### 1.2 Layer & flow request
- **Web (admin & storefront):** `route` → `preHandler` (`currentAdmin`/`csrfProtect`/`canMutate`) → `packages/db/src/crud/*` → Prisma → SQLite. **Tidak ada SQL mentah di route.** Render Nunjucks (autoescape).
- **Bot:** `middleware` (`bindUpdateId` → `registeredUser` → `rateLimit`) → `handler`/`conversation` → crud → Prisma. Render = edit bubble Telegram.
- **Composition root** `apps/server/src/index.ts`: `buildApp()` (web-admin) + `buildShopApp()` (storefront) di-mount; bot via **polling** (dev) atau **webhook** (`/tg/<secret>`, dipilih `BOT_MODE`); poller Binance start; notifier jalan. Satu listener publik, split admin vs toko per subdomain.

### 1.3 Database schema overview (24 model)
Inti katalog & order:
```
Category 1─* ProductGroup 1─* Product 1─* StockItem
                       (Product.productGroupId opsional; denominasi)
User 1─* Order 1─* OrderItem ;  Order *─ pakai StockItem (deduksi stok)
User 1─* CartItem, Review, Referral, SupportTicket, WalletTransaction, RestockSubscription
Product 1─1 BulkPricing ; Voucher (kode unik) ; PasswordResetToken
```
Operasional & pembayaran:
```
Setting (key-value, sumber kebenaran runtime) ; AuditLog (logAdminAction)
NotificationOutbox (antrian DM) ; Broadcast (antrian broadcast)
ProcessedBinanceTx / ProcessedBybitTx / ProcessedTokopayTx (idempotensi pembayaran)
SupportTicket 1─* TicketMessage
```
PRAGMA (`packages/db/src/client.ts`): `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`.

### 1.4 Service dependency graph
```
apps/server ──includes──> web-admin, storefront, order-bot, notifier
   all apps ─────────────> packages/db (Prisma) ──> SQLite data/bot.db
   all apps ─────────────> packages/core (money, i18n, config, logger, password, mailer)
   web-admin, storefront ─> packages/web-ui (macro njk)
External:
   order-bot/notifier/server ──> Telegram Bot API (grammy)
   order-bot/payments ─────────> Bybit API, Binance API, Tokopay
   web-admin/lib/telegramCheck ─> Telegram getMe/getChat (validasi, BUKAN kirim pesan)
   packages/core/mailer ───────> SMTP (reset password)
```

## 2. Tech Stack & Dependencies

| Layer | Teknologi |
|---|---|
| Bahasa/monorepo | TypeScript, pnpm workspaces |
| Bot | grammy + @grammyjs/conversations + @grammyjs/runner; jadwal **croner** |
| Web | Fastify 5 + Nunjucks + HTMX; @fastify/{cookie,formbody,static,multipart} |
| DB/ORM | Prisma 5 + @prisma/client atas SQLite |
| Uang | decimal.js (Decimal, bukan float) |
| Auth | bcryptjs (cost 12), TOTP 2FA (node:crypto), sesi cookie httpOnly |
| Config | zod (validasi env), dotenv |
| Waktu | luxon (TIMEZONE display) |
| Email | nodemailer (SMTP) |
| Log | pino |

**Route web-admin (19):** admins, audit, auth, branding, broadcast, catalog, dashboard, orders, outbox, payments, reports, reviews, search, settings, setup, stock, support, users, vouchers.
**Route storefront (8):** account, auth, cart, catalog, checkout, forgot, home, settings.
**Domain crud (db):** admins, audit, binance_internal, broadcasts, bybit_deposit, cart, catalog, credentials, notifications, orders, pricing, referrals, reports, reviews, settings, setup, stock, support, tokopay, users, vouchers, web_secret, webauth.

**Background jobs** (`order-bot/src/jobs/index.ts`, croner): auto-cancel order tiap menit, tutup tiket basi tiap jam, rekonsiliasi finance tiap 6 jam, + watchdog poller Binance (alert admin bila macet).

**Env utama** (`packages/core/src/config.ts`, zod): `BOT_TOKEN`, `BOT_MODE`, `BOT_USERNAME`, `NOTIF_BOT_TOKEN`, `DATABASE_URL_PRISMA`, `PUBLIC_URL`, `SHOP_HOST`/`SHOP_PUBLIC_URL`, `STOREFRONT_PORT`, `TIMEZONE`, `DEFAULT_LANGUAGE`, `DEFAULT_WARRANTY_DAYS`, `LOW_STOCK_THRESHOLD`, `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_SECONDS`, `REFERRAL_COMMISSION_PERCENT`, pembayaran `BYBIT_*`/`BINANCE_*`, `SMTP_*`, `PUBLIC_CHANNEL_ID`/`SUPPORT_GROUP_ID`, `LOG_LEVEL`. Banyak identitas runtime (token bot, admin) juga dibaca dari tabel `Setting` (sumber kebenaran runtime).

## 3. Potential High Risk Areas (untuk fase berikut)

| Area | Lokasi | Catatan risiko |
|---|---|---|
| **Payment** | `apps/order-bot/src/payments/{binanceInternal,bybitDeposit}.ts`, `crud/{binance_internal,bybit_deposit,tokopay}.ts`, storefront `routes/checkout.ts` | Uang nyata; idempotensi via Processed*Tx; poller eksternal + watchdog |
| **Authentication** | `apps/web-admin/src/{auth.ts,plugins/auth.ts}`, `routes/auth.ts`, `routes/setup.ts`; storefront `routes/auth.ts` | Sesi cookie, TOTP 2FA, lockout/throttle, bootstrap admin |
| **Admin panel** | `apps/web-admin/src/routes/*` (19 route) | RBAC `canMutate`; CSRF; audit; whitelist settings |
| **File upload** | `apps/web-admin/src/lib/upload.ts`; penyajian `/uploads/` (storefront `server.ts:40-50`) | MIME allowlist + size limit + CSRF; SVG dibuat inert |
| **Webhook** | `apps/server/src/index.ts` (`/tg/<secret>`) | Secret token; hanya aktif mode webhook |
| **Background jobs** | `apps/order-bot/src/jobs/index.ts` | Auto-cancel, rekonsiliasi, watchdog poller; kegagalan diam = risiko |

---

### Catatan untuk auditor fase berikut
- Jumlah model = **24** (terverifikasi: 24 baris `model` di `schema.prisma`).
- Antrian (`NotificationOutbox`, `Broadcast`) berbasis tabel DB, bukan broker — relevan untuk Phase 11 (scalability).
- Idempotensi pembayaran sudah ada (Processed*Tx) — verifikasi cakupannya di Phase 1/2.

> Read-only — tidak ada perubahan kode pada fase ini.
