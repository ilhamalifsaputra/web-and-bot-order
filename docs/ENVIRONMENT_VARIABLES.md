# Referensi Variabel Environment

Sumber kebenaran: `packages/core/src/config.ts` (schema Zod `Env`). Contoh
nilai & checklist per-fitur ada di [`../.env.example`](../.env.example) dan
[`../DOCS.md` §10](../DOCS.md#10-setup-env--checklist-fitur). Banyak dari
variabel di bawah punya pasangan di tabel **`Setting`** yang menang atasnya
setelah setup awal — lihat [CONFIGURATION.md](CONFIGURATION.md).

## Telegram

| Variabel | Default/Validasi | Keterangan |
|---|---|---|
| `BOT_TOKEN` | opsional, min 20 char jika diisi (`blankableOptional`) | Token bot utama. Boleh kosong (`BOT_TOKEN=` bukan dihapus) — diisi via wizard/Settings. Setting `bot_token` menang. |
| `BOT_USERNAME` | opsional, min 3 char | Username bot (tanpa `@`). Setting `bot_username` menang. |
| `ADMIN_IDS` | CSV angka, default kosong | Telegram ID admin. **Union** dengan Setting `admin_ids` (bukan saling timpa) — hapus dari satu sisi saja tidak mencabut akses. |
| `SUPPORT_GROUP_ID` | opsional, number | Grup Telegram untuk mirror notifikasi support. |

## Payment — Binance Pay (manual, legacy fallback)

| Variabel | Default | Keterangan |
|---|---|---|
| `BINANCE_PAY_ID` | `""` (kosong = nonaktif) | ID Binance Pay untuk jalur manual (upload bukti + approve admin). Hanya tampil jika TIDAK ada metode auto-confirm aktif. |
| `BINANCE_QR_PATH` | opsional | Path gambar QR statis untuk Binance Pay manual. |
| `CURRENCY` | `"USDT"` | Mata uang tampilan default (legacy). |
| `PAYMENT_WINDOW_MINUTES` | `30` | Jendela bayar untuk Binance Pay manual. |
| `USE_UNIQUE_CENTS` | `true` (looseBool) | Tambah desimal unik ke total agar matching by-amount (Bybit/Binance fallback) tidak ambigu. **Jangan matikan** jika pakai Bybit Internal Transfer. |

## Payment — Binance Internal Transfer (UID, auto-confirm)

| Variabel | Default | Keterangan |
|---|---|---|
| `BINANCE_RECEIVE_UID` | opsional | UID Binance penerima. Kosong = fitur nonaktif + poller idle. |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | opsional | **Wajib READ-ONLY** (tanpa izin trading/withdraw). Hanya untuk baca riwayat transfer masuk. |
| `BINANCE_API_BASE` | `https://api.binance.com` | Base URL API. |
| `POLL_INTERVAL_SECONDS` | `10` | Interval poll Binance (HANYA Binance — Bybit punya interval sendiri). |
| `INTERNAL_PAYMENT_WINDOW_MINUTES` | `15` | Jendela bayar untuk metode ini. |
| `USDT_IDR_RATE` | opsional, number | Override manual kurs (jarang dipakai — biasanya dari Setting `usd_idr_rate`, auto-update). |

## Payment — Bybit Internal Transfer (UID, off-chain instant)

| Variabel | Default | Keterangan |
|---|---|---|
| `BYBIT_UID` | opsional | UID Bybit penerima. Bisa/biasanya diatur di Settings (menang atas env). |
| `BYBIT_API_KEY` / `BYBIT_API_SECRET` | opsional | **Wajib Wallet READ-ONLY** (tanpa Withdraw). Tes dengan `pnpm bybit-probe`. |
| `BYBIT_API_BASE` | `https://api.bybit.com` | Base URL API. |
| `BYBIT_PAYMENT_WINDOW_MINUTES` | `30` | Jendela bayar. |
| `BYBIT_POLL_INTERVAL_SECONDS` | `5` | Interval poll Bybit — independen dari `POLL_INTERVAL_SECONDS` (Binance). |
| `BYBIT_DEPOSIT_ADDRESS` / `BYBIT_DEPOSIT_CHAIN` | opsional / `"BSC"` | **Deprecated** — sisa dari skema on-chain BEP20 lama; tidak dibaca lagi (digantikan `BYBIT_UID`), dipertahankan agar `.env` lama tidak gagal parse. |

## Payment — NOWPayments (hosted invoice, USDT)

| Variabel | Default | Keterangan |
|---|---|---|
| `NOWPAYMENTS_PAYMENT_WINDOW_MINUTES` | `30` | Jendela bayar — lebih lebar karena pembeli membuka wallet app di luar Telegram/browser. Kredensial (`nowpayments_api_key`, `nowpayments_ipn_secret`, `nowpayments_pay_currency`) **hanya** di Settings, tidak ada di `.env`. |

## Database

| Variabel | Default | Keterangan |
|---|---|---|
| `DATABASE_URL_PRISMA` | `file:../data/bot.db` | URL Prisma (SQLite). Docker: path **absolut** (`file:/app/data/bot.db`). |

## Behaviour / Tuning

| Variabel | Default | Keterangan |
|---|---|---|
| `DEFAULT_LANGUAGE` | `"en"` → `enum("en","id")` | Bahasa default UI (case-insensitive di input, disimpan lowercase). |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` | `5` / `3` | Rate limit umum bot (per chat). |
| `REFERRAL_COMMISSION_PERCENT` | `10` | Persentase komisi referral. |
| `DEFAULT_WARRANTY_DAYS` | `30` | Garansi default item baru (di-snapshot per `OrderItem` saat checkout). |
| `LOW_STOCK_THRESHOLD` | `3` | Ambang "stok menipis" di UI. |
| `TIMEZONE` | `"Asia/Jakarta"` | Timezone tampilan (luxon) — DB selalu UTC. |

## Logging

| Variabel | Default | Keterangan |
|---|---|---|
| `LOG_LEVEL` | `"info"` → `enum(debug,info,warn,error)` | `"warning"` diterima & dinormalisasi ke `"warn"`. |

## Web Admin

| Variabel | Default | Keterangan |
|---|---|---|
| `WEB_COOKIE_SECRET` | opsional, **min 32 char jika diisi** | Kunci HMAC sesi admin. Kosong → auto-generate & disimpan ke Setting `web_cookie_secret` saat boot. `.env` (jika diisi) **menang** atas Setting — kebalikan dari pola umum (operator override). |
| `WEB_COOKIE_NAME` | `"stockweb_session"` | Nama cookie sesi admin. |
| `WEB_SESSION_TTL_HOURS` | `12` | Masa berlaku sesi admin. |
| `WEB_LOGIN_RATE_LIMIT_MAX` / `_WINDOW_SECONDS` | `5` / `600` | Anti-bruteforce login admin (per IP+akun). |
| `WEB_HOST` | `"127.0.0.1"` | Bind host admin. Docker override ke `0.0.0.0` via `docker-compose.yml`. |
| `WEB_PORT` | `8000` | Port admin. **[multi]** wajib unik per toko. |
| `WEB_COOKIE_SECURE` | `false` (looseBool) | `Secure` flag cookie sesi. **WAJIB `true` di produksi (HTTPS)** — default `false` adalah jebakan konfigurasi yang umum (lihat [SECURITY.md](SECURITY.md)). |
| `TRUST_PROXY` | opsional, CSV IP/CIDR | Daftar proxy tepercaya untuk `X-Forwarded-For`. **Default unset = XFF diabaikan total** (fail-safe). Isi HANYA dengan IP nginx yang sebenarnya. |

## Storefront

| Variabel | Default | Keterangan |
|---|---|---|
| `STOREFRONT_PORT` | `8100` | Port storefront (dev/standalone, atau saat `SHOP_HOST` tidak diset). **[multi]** wajib unik per toko. |
| `SHOP_HOST` | opsional | Host publik storefront — bila diset, satu listener melayani admin+storefront berdasarkan `Host` header. |
| `SHOP_PUBLIC_URL` | opsional, harus URL valid | Origin publik storefront (untuk link di DM pembeli + callback gateway). Fallback ke `PUBLIC_URL`. **[multi]** wajib unik per toko. |

## Server gabungan (`apps/server`) — transport bot

| Variabel | Default | Keterangan |
|---|---|---|
| `BOT_MODE` | `"polling"` → `enum(polling,webhook)` | `polling` = long-polling grammY (default, tak butuh domain). `webhook` = route Fastify (`/tg/<secret>`), butuh `PUBLIC_URL`+`WEBHOOK_SECRET`+HTTPS. |
| `PUBLIC_URL` | opsional, harus URL valid | Origin publik app — **wajib** jika `BOT_MODE=webhook`. |
| `WEBHOOK_SECRET` | opsional (tanpa `.min()` — lihat catatan) | Token rahasia path+header webhook. **Wajib** jika `BOT_MODE=webhook`; tidak ada validasi panjang minimum di schema — operator harus disiplin pilih string acak panjang sendiri. |

## Notifier (outbox dispatcher)

| Variabel | Default | Keterangan |
|---|---|---|
| `NOTIF_BOT_TOKEN` | opsional | Bot terpisah untuk posting channel testimoni. Kosong = pakai bot utama (harus jadi admin channel). |
| `PUBLIC_CHANNEL_ID` | opsional, number | ID channel testimoni publik. Setting `public_channel_id` menang. |
| `NOTIF_POLL_INTERVAL_SECONDS` | `10` | Interval polling `notification_outbox`. |
| `NOTIF_MAX_ATTEMPTS` | `5` | Percobaan kirim maksimum sebelum baris `FAILED` permanen. |

## SMTP (forgot-password storefront)

| Variabel | Default | Keterangan |
|---|---|---|
| `SMTP_HOST` | opsional | Aktifkan fitur lupa-password storefront hanya jika diisi BERSAMA `SMTP_FROM`. |
| `SMTP_PORT` | `587` | Port SMTP. |
| `SMTP_USER` / `SMTP_PASS` | opsional | Kredensial SMTP. |
| `SMTP_FROM` | opsional | Alamat pengirim (`"Toko Kamu <akun@gmail.com>"`). |
| `SMTP_SECURE` | `false` (looseBool) | TLS implisit (port 465) vs STARTTLS. |

## Hanya di Settings (TIDAK ada di `.env`)

Variabel berikut **tidak punya** representasi `.env` — hanya diedit di
web-admin → Settings, tersimpan di tabel `Setting`:

- `tokopay_merchant_id`, `tokopay_secret`, `tokopay_enabled`,
  `tokopay_default_channel`
- `paydisini_userkey`, `paydisini_apikey`, `paydisini_enabled`,
  `paydisini_default_channel`
- `nowpayments_api_key`, `nowpayments_ipn_secret`, `nowpayments_pay_currency`,
  `nowpayments_enabled`
- `usd_idr_rate`, `usd_idr_rate_auto`, `usd_idr_rate_rounding`
- `web_favicon_url`, `web_logo_url`, `web_hero_url`, `banner_image`,
  `shop_name`, `shop_tagline`, `welcome`

Lihat [`../DOCS.md` §6](../DOCS.md#6-settings-vs-env) untuk tabel resolusi
lengkap (mana yang DB menang, mana union, mana butuh restart).
