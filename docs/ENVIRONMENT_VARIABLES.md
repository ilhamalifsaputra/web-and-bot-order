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

## Payment — jendela bayar per rail

Berapa lama pembeli boleh membayar sebelum pesanan dibatalkan otomatis
(`autoCancelExpiredOrders`). Berlaku untuk bot **dan** storefront, termasuk
top-up saldo wallet (memakai config yang sama).

| Rail | Variabel | Default |
|---|---|---|
| TokoPay QRIS, PayDisini (juga stempel awal setiap pesanan) | `PAYMENT_WINDOW_MINUTES` | `10` |
| Binance Pay (Internal Transfer) | `INTERNAL_PAYMENT_WINDOW_MINUTES` | `10` |
| Bybit UID (Internal Transfer) | `BYBIT_PAYMENT_WINDOW_MINUTES` | `10` |
| Bybit BSC (on-chain BEP20) | `BYBIT_BSC_PAYMENT_WINDOW_MINUTES` | `30` |
| NOWPayments (hosted invoice) | `NOWPAYMENTS_PAYMENT_WINDOW_MINUTES` | `30` |

- **Nilai eksplisit di `.env` selalu menang atas default.** `.env` lama yang
  masih berisi `30/15/30/15/30` tetap memakai jendela lama — saat deploy,
  **edit atau hapus kelima baris itu di `.env`** agar default baru berlaku.
- Pesanan yang sudah dibuat tetap memakai `expiresAt` tersimpannya; nilai baru
  hanya berlaku untuk pesanan baru.
- Rail deposit (Binance, Bybit UID, Bybit BSC) tetap ketat: deposit yang masuk
  setelah `expiresAt` tidak dicocokkan. Ini juga berlaku untuk deposit yang
  dikirim **sebelum** `expiresAt` tetapi baru terlihat oleh poller sesudahnya
  (backoff poll sampai 30 s, jeda laporan exchange): poller hanya mencocokkan
  pesanan yang `expiresAt`-nya masih di depan, jadi deposit itu tercatat
  `unmatched` dan masuk antrean manual-match di Payments ledger.
- Rail webhook (TokoPay, PayDisini, NOWPayments): pembayaran yang datang
  setelah pesanan dibatalkan otomatis tetap masuk alur "pembayaran basi →
  alert admin" yang sudah ada (tanpa grace tambahan, tanpa kredit wallet
  otomatis).
- Anggaran siklus poller rekonsiliasi TokoPay/PayDisini/NOWPayments diturunkan
  dari jendela ini (`packages/core/src/payments/reconcileCycleBudget.ts`):
  satu siklus maksimal 40% jendela (10 menit → 14 pesanan/siklus, 240 s;
  30 menit → 46 pesanan/siklus, 720 s).

### Pengingat pembayaran

| Variabel | Default | Keterangan |
|---|---|---|
| `PAYMENT_REMINDER_LEAD_MINUTES` | `5` | Berapa menit sebelum `expiresAt` pembeli Telegram menerima **satu** pengingat bayar (`PAYMENT_REMINDER_DM`). `0` mematikan pengingat; nilai negatif, bukan angka, atau di bawah 1 juga dianggap mati (boot tidak gagal, order-bot menulis satu peringatan di log saat start). Baris kosong = default. |

- Berlaku untuk semua service dan semua rail, termasuk top-up saldo wallet;
  hanya pesanan `PENDING_PAYMENT` yang belum dibayar, pembelinya punya
  Telegram ID (pesanan web/guest tanpa Telegram tidak dikirimi), dan jendela
  bayarnya **lebih panjang** dari nilai ini.
- Job `sendPaymentReminders` (order-bot, tiap menit di detik 47) hanya
  meng-enqueue ke `notification_outbox` dengan dedupe key
  `payment_reminder:<orderId>` — paling banyak satu pengingat per pesanan,
  walau job berjalan berkali-kali atau di dua instance.
- Dispatcher membaca ulang pesanan tepat sebelum mengirim dan melewati
  (status `SKIPPED`, dedupe key tetap) bila pesanan sudah dibayar, dibatalkan,
  atau sisa waktunya tinggal kurang dari 1 menit. Sisa waktu di pesan dihitung
  saat dikirim, deadline ditampilkan `yyyy-LL-dd HH:mm WIB`.
- Hanya pesanan yang **belum terlihat pembayarannya** yang diingatkan:
  `paymentState` kosong atau `WAITING_PAYMENT`, tanpa `paidAt`, dan
  `walletCreditState` bukan `NEEDS_REVIEW`. State `PAYMENT_DETECTED`,
  `VERIFYING`, `PAID`, `UNDERPAID`, `FAILED`, `EXPIRED`, `REFUNDED` (dan state
  baru apa pun) menekan pengingat, baik saat enqueue maupun saat kirim
  (`SKIPPED` dengan alasan `PAYMENT_IN_PROGRESS` atau
  `PAYMENT_ALREADY_RECEIVED`) — agar pembeli yang transfernya sudah terdeteksi
  tidak membayar dua kali.

## Payment — Binance Pay (manual, legacy fallback)

| Variabel | Default | Keterangan |
|---|---|---|
| `BINANCE_PAY_ID` | `""` (kosong = nonaktif) | ID Binance Pay untuk jalur manual (upload bukti + approve admin). Hanya tampil jika TIDAK ada metode auto-confirm aktif. |
| `BINANCE_QR_PATH` | opsional | Path gambar QR statis untuk Binance Pay manual. |
| `CURRENCY` | `"USDT"` | Mata uang tampilan default (legacy). |
| `PAYMENT_WINDOW_MINUTES` | `10` | Jendela bayar TokoPay QRIS dan PayDisini, sekaligus stempel `expiresAt` awal setiap pesanan sebelum rail terpilih menimpanya. Lihat "jendela bayar per rail" di atas. |
| `USE_UNIQUE_CENTS` | `true` (looseBool) | Tambah desimal unik ke total agar matching by-amount (Bybit/Binance fallback) tidak ambigu. **Jangan matikan** jika pakai Bybit Internal Transfer. |

## Payment — Binance Internal Transfer (UID, auto-confirm)

| Variabel | Default | Keterangan |
|---|---|---|
| `BINANCE_RECEIVE_UID` | opsional | UID Binance penerima. Kosong = fitur nonaktif + poller idle. |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | opsional | **Wajib READ-ONLY** (tanpa izin trading/withdraw). Hanya untuk baca riwayat transfer masuk. |
| `BINANCE_API_BASE` | `https://api.binance.com` | Base URL API. |
| `POLL_INTERVAL_SECONDS` | `10` | Interval poll Binance (HANYA Binance — Bybit punya interval sendiri). |
| `INTERNAL_PAYMENT_WINDOW_MINUTES` | `10` | Jendela bayar untuk metode ini. |
| `USDT_IDR_RATE` | opsional, number | Override manual kurs (jarang dipakai — biasanya dari Setting `usd_idr_rate`, auto-update). |

## Payment — Bybit Internal Transfer (UID, off-chain instant)

| Variabel | Default | Keterangan |
|---|---|---|
| `BYBIT_UID` | opsional | UID Bybit penerima. Bisa/biasanya diatur di Settings (menang atas env). |
| `BYBIT_API_KEY` / `BYBIT_API_SECRET` | opsional | **Wajib Wallet READ-ONLY** (tanpa Withdraw). Tes dengan `pnpm bybit-probe`. |
| `BYBIT_API_BASE` | `https://api.bybit.com` | Base URL API. |
| `BYBIT_PAYMENT_WINDOW_MINUTES` | `10` | Jendela bayar. |
| `BYBIT_POLL_INTERVAL_SECONDS` | `5` | Interval poll Bybit — independen dari `POLL_INTERVAL_SECONDS` (Binance). |
| `BYBIT_DEPOSIT_ADDRESS` / `BYBIT_DEPOSIT_CHAIN` | opsional / `"BSC"` | **Deprecated** — sisa dari skema on-chain BEP20 lama; tidak dibaca lagi (digantikan `BYBIT_UID`), dipertahankan agar `.env` lama tidak gagal parse. |

## Payment — Bybit BSC (on-chain BEP20)

| Variabel | Default | Keterangan |
|---|---|---|
| `BYBIT_BSC_PAYMENT_WINDOW_MINUTES` | `30` | Jendela bayar — lebih lebar karena pembeli biasanya mengirim dari wallet/exchange lain dan deposit masih perlu konfirmasi on-chain. Deposit setelah `expiresAt` tidak dicocokkan. |
| `BYBIT_BSC_POLL_INTERVAL_SECONDS` | `5` | Interval poll deposit BSC — independen dari interval Bybit Internal Transfer. |

## Payment — NOWPayments (hosted invoice, USDT)

| Variabel | Default | Keterangan |
|---|---|---|
| `NOWPAYMENTS_PAYMENT_WINDOW_MINUTES` | `30` | Jendela bayar — lebih lebar karena pembeli membuka wallet app di luar Telegram/browser. Kredensial (`nowpayments_api_key`, `nowpayments_ipn_secret`, `nowpayments_pay_currency`) **hanya** di Settings, tidak ada di `.env`. |

## Finance — CoinGecko (market rate source)

| Variabel | Default | Keterangan |
|---|---|---|
| `COINGECKO_API_KEY` | opsional | Demo API key untuk CoinGecko. Free tier tetap jalan tanpa key; API key opsional menaikkan rate limit. |
| `COINGECKO_API_BASE` | `https://api.coingecko.com/api/v3` | Base URL CoinGecko API. |

## Database

| Variabel | Default | Keterangan |
|---|---|---|
| `DATABASE_URL_PRISMA` | **wajib, tidak ada default** | Connection string Postgres (`postgresql://user:password@host:port/db`). Dua lapis validasi yang berbeda: **schema Zod** (`packages/core/src/config.ts`, `z.string()`) hanya memastikan variabelnya **ada** — proses gagal start saat boot kalau tidak diset sama sekali, tapi Zod tidak memeriksa bentuk/skema URL-nya. Yang menolak nilai selain `postgresql://` adalah **Prisma**, saat mencoba konek (bukan saat config di-parse), karena `schema.prisma` sudah Postgres-only. Docker: host **wajib** nama service `postgres` (jaringan internal Compose), bukan `localhost`/`127.0.0.1`. Lihat [`../.env.example`](../.env.example). |

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
| `NOTIF_MAX_ATTEMPTS` | `10` | Percobaan kirim maksimum sebelum baris jadi `DEAD_LETTER` permanen (baris yang benar-benar sudah di-retry sampai limit — beda dari `FAILED`, yang khusus kegagalan permanen sejak percobaan pertama, lihat komentar `markNotificationFailed` di `packages/db/src/crud/notifications.ts`). |

## SMTP (forgot-password storefront)

Kredensial normalnya diisi di web admin → Settings → **Email (SMTP)**
(`smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `smtp_from`,
`smtp_secure`) — Setting menang atas env, tanpa restart (lihat
`getSmtpCreds()` di `@app/db`). Variabel `.env` di bawah **hanya** fallback
darurat/bootstrap kalau web-admin belum bisa diakses.

| Variabel | Default | Keterangan |
|---|---|---|
| `SMTP_HOST` | opsional | Fitur lupa-password storefront aktif hanya jika host + from-address terisi (dari Setting atau env). Setting `smtp_host` menang. |
| `SMTP_PORT` | `587` | Port SMTP. Setting `smtp_port` menang. |
| `SMTP_USER` / `SMTP_PASS` | opsional | Kredensial SMTP. Setting `smtp_user` / `smtp_pass` menang. |
| `SMTP_FROM` | opsional | Alamat pengirim (`"Toko Kamu <akun@gmail.com>"`). Setting `smtp_from` menang. |
| `SMTP_SECURE` | `false` (looseBool) | TLS implisit (port 465) vs STARTTLS. Setting `smtp_secure` menang. |

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
