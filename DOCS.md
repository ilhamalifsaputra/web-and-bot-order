# Dokumentasi Teknis — `telegram-order-bot`

Arsitektur, fitur, dan setup environment proyek. Konvensi koding ada di
[`CLAUDE.md`](CLAUDE.md); panduan instalasi (VPS) ada di [`README.md`](README.md).

## Daftar Isi

1. [Arsitektur](#1-arsitektur)
2. [Autentikasi pelanggan](#2-autentikasi-pelanggan)
3. [Katalog, gambar produk & branding](#3-katalog-gambar-produk--branding)
4. [Harga: IDR pusat + USDT turunan](#4-harga-idr-pusat--usdt-turunan)
5. [Pembayaran](#5-pembayaran)
6. [Settings vs `.env`](#6-settings-vs-env)
7. [Manajemen stok](#7-manajemen-stok)
8. [Credit balance (IDR + USDT)](#8-credit-balance-idr--usdt)
9. [Desain storefront](#9-desain-storefront)
10. [Setup env & checklist fitur](#10-setup-env--checklist-fitur)

---

## 1. Arsitektur

Monorepo pnpm: lima workspace `apps/*` + tiga `packages/*`, berbagi **satu
database SQLite** (`data/bot.db`, mode WAL).

| Workspace | Peran |
|---|---|
| `apps/order-bot` | Bot Telegram grammY (alur pelanggan + admin) |
| `apps/web-admin` | Panel admin Fastify + Nunjucks + HTMX |
| `apps/storefront` | Toko web pelanggan (Fastify + Nunjucks + HTMX) |
| `apps/notifier` | Drain `notification_outbox` → channel/DM |
| `apps/server` | **Composition root satu-proses**: gabung admin + storefront + bot + worker dengan **satu PrismaClient** (`apps/server/src/index.ts`) |
| `packages/core` | Config (zod), money (Decimal), datetime (luxon), i18n, password, mailer, fx |
| `packages/db` | Prisma client + semua CRUD (`packages/db/src/crud/*`) |
| `packages/web-ui` | Tema bersama (`_theme.njk`, `_macros.njk`) yang di-`include` admin & storefront |

**Prinsip inti:**

- **Satu sumber data.** Storefront & bot memakai DB + CRUD yang sama, jadi stok
  dan harga otomatis sinkron. Tidak ada SQL mentah di route — semua lewat
  `packages/db/src/crud/*`.
- **Decimal untuk semua uang** (`@app/core/money`), tidak pernah `float`.
- **Web tak pernah kirim Telegram** — enqueue ke `notification_outbox`, notifier/bot
  yang mengirim.
- **SQLite single-writer** — tiap `$transaction` dijaga pendek.

**Topologi listen** (`apps/server/src/index.ts`):

- `SHOP_PUBLIC_URL` di-set → **satu listener publik**; request ke host toko →
  storefront, sisanya (admin, webhook `/tg`, health) → admin.
- Tidak di-set → admin di `WEB_PORT`, storefront di `STOREFRONT_PORT` (8100).

`BOT_MODE` (`polling` | `webhook`) memilih transport bot. Web tetap jalan walau
token bot kosong (bot OFF sampai diisi + restart).

> Pada deploy Docker (README Jalur A), tiap layanan jalan sebagai container
> terpisah berbagi `./data`. Pada Jalur B, `apps/server` menjalankan semuanya
> dalam satu proses.

---

## 2. Autentikasi pelanggan

Storefront punya **dua pintu** di `/login`:

- **Username/email + password (utama)** — registrasi mandiri di `/register`
  (`loginUsername` 3–32 char `[a-z0-9_]`, `email` unik, `passwordHash`). Login
  verifikasi hash; kegagalan selalu pesan generik (anti-enumerasi).
- **Telegram Login Widget = lookup-only** — hanya **masuk** ke akun yang sudah ada
  via `telegramId`; tidak membuat user baru. Telegram ID asing diarahkan ke
  `/register` atau bot.

**Lupa password:** `/forgot` → email token reset → `/reset` (tabel
`PasswordResetToken`, email via `@app/core/mailer`).

Sesi di-key per `userId`, cookie HMAC `httpOnly` + `SameSite=Lax`, jti rotasi di
`Setting`. Keranjang tamu (cookie) digabung ke `CartItem` saat login. Katalog
bebas tanpa login; checkout wajib login.

Kolom/tabel: `User.loginUsername`, `User.email`, `User.passwordHash`,
`PasswordResetToken`. CRUD: `packages/db/src/crud/webauth.ts`. File:
`apps/storefront/src/routes/{auth,forgot}.ts`, `src/auth.ts`,
view `login/register/forgot/reset.njk`, `packages/core/src/{password,mailer}.ts`.

---

## 3. Katalog, gambar produk & branding

**Gambar produk** diurutkan: `Product.webImageUrl` (upload admin) → peta Unsplash
per kategori (`apps/storefront/src/images.ts`) → placeholder. Admin meng-upload
foto lewat web-admin; file disimpan di **`data/uploads/`** dan disajikan storefront
sebagai statis `GET /uploads/*` (env `UPLOADS_DIR`, default `data/uploads`).

**Branding** — halaman **web-admin → Settings → Branding**
(`apps/web-admin/src/routes/branding.ts`, view `branding.njk`) meng-upload ke
**`data/uploads/branding/`** (nama file di-hash, anti traversal):

| Aset | Setting | Dipakai |
|---|---|---|
| Favicon (PNG/ICO/SVG) | `web_favicon_url` | tiap halaman storefront (fallback `/static/favicon.svg`) |
| Logo header (PNG/SVG/WebP) | `web_logo_url` | header toko (kosong → ikon `store`) |
| Hero (JPG/PNG/WebP) | `web_hero_url` | beranda toko (fallback `HERO_IMAGE`) |
| Banner bot | `banner_image` | atas menu utama & daftar produk di bot |

Identitas toko `shop_name`, `shop_tagline`, `welcome` juga diedit di sini. Semua
langsung berlaku tanpa restart. Folder `/uploads/` di kedua app mengirim header
`X-Content-Type-Options: nosniff` + CSP ketat agar SVG yang di-upload inert.

Banner bot dikirim sebagai `InputFile` lalu file_id Telegram-nya di-cache
(`banner_image_fileid`); cache di-invalidasi saat banner di-set/hapus.

---

## 4. Harga: IDR pusat + USDT turunan

**Rupiah adalah sumber kebenaran harga.** `Product.price` / `resellerPrice` dalam
IDR. USDT diturunkan: `idrPrice / usd_idr_rate`, dibulatkan ke 0,1, dan **tampil
bersisian** dengan IDR di storefront dan bot (mis. `Rp79.000 ≈ $4,9`). Tidak ada
deteksi IP atau preferensi mata uang per-user — mata uang transaksi dipilih **saat
bayar** (IDR → TokoPay, USDT → Binance/Bybit).

`usd_idr_rate` **auto-update dari pasar** (`scheduleFxRefresh`,
`packages/core/src/fx.ts`), dibulatkan ke kelipatan `usd_idr_rate_rounding`
(default Rp100). Matikan dengan `usd_idr_rate_auto=false` lalu set manual. Bila
`usd_idr_rate` kosong, info USDT disembunyikan tapi checkout IDR tetap jalan.

Tiap order menyimpan snapshot: `Order.currency` (`IDR`/`USDT`), `Order.fxRate`
(kurs saat USDT), `Order.paymentMethod`, `Order.paymentRef`. Order lama tak diubah.

---

## 5. Pembayaran

**Tiga metode auto-confirm, simetris di bot & storefront:**

| Metode | Mata uang | Mekanisme | Kelola |
|---|---|---|---|
| **Binance Internal** (UID + nominal unik) | USDT | poller auto-confirm (`payments/binanceInternal`) | env / Settings |
| **TokoPay (QRIS)** | IDR | webhook `POST /pay/tokopay/callback` (verifikasi signature + idempoten `ProcessedTokopayTx`) | Settings |
| **Bybit USDT-BEP20** (on-chain) | USDT | poller cocokkan **nominal unik** (BEP20 tanpa memo); tak cocok → "unmatched" untuk review; idempoten `processed_bybit_tx` | Settings |

Klien TokoPay ada di `@app/core/payments/tokopay` (resolver `getTokopayCreds` di
`@app/db`), dipakai storefront dan bot. Bot menggambar QR QRIS di dalam Telegram
(`buyNowTokopay`, callback `payq`).

**Storefront:** pembeli pilih metode saat bayar
(`apps/storefront/src/routes/checkout.ts`). Status di halaman bayar via **HTMX
polling** `/checkout/:code/status` ~5 dtk; saat `DELIVERED` redirect ke kredensial.
Web **tanpa upload bukti** dan **tanpa wallet**.

**QRIS butuh Callback URL publik** (`https://<host>/pay/tokopay/callback`) di
dashboard TokoPay — tanpa itu order QRIS mentok sampai jendela bayar habis.
Binance & Bybit (poller) tak terpengaruh.

**Binance Pay manual** (upload bukti, approve manual di bot) hanya muncul sebagai
fallback zero-config bila tak ada metode otomatis. Perlu `BINANCE_PAY_ID`.

Menu bayar: **QRIS / Binance / Bybit-BSC**. Tes koneksi API:
`pnpm binance-probe`, `pnpm bybit-probe`.

---

## 6. Settings vs `.env`

Kredensial & setelan terpusat di **web-admin → Settings**
(`apps/web-admin/src/routes/settings.ts`, whitelist `EDITABLE`):

- **Bot & notifications:** `bot_token`, `bot_username`, `notif_bot_token`
  (divalidasi `getMe` sebelum simpan; **perlu restart**).
- **Kurs:** `usd_idr_rate`, `usd_idr_rate_auto`, `usd_idr_rate_rounding`.
- **QRIS/TokoPay:** `tokopay_merchant_id`, `tokopay_secret`, `tokopay_enabled`.
- **Bybit:** `bybit_deposit_address`, `bybit_api_key`, `bybit_api_secret`.
- **Branding:** identitas toko + upload aset (halaman `/branding` terpisah).

**Aturan umum: DB (Setting) menang, `.env` = bootstrap/pemulihan** — tapi ada
tiga pola resolver yang sengaja berbeda. Tabel sumber-kebenaran per setting
(resolver di `packages/db/src/crud/`, dipanggil sekali per proses saat boot lalu
di-stamp ke `@app/core/runtime`):

| Setting | env var | DB key | Yang menang | Resolver | Perubahan berlaku |
|---|---|---|---|---|---|
| Token bot/notif, username, channel | `BOT_TOKEN`, `BOT_USERNAME`, `NOTIF_BOT_TOKEN`, `PUBLIC_CHANNEL_ID` | `bot_token` dst | **DB > env** | `credentials.ts` | **perlu restart** (instance grammY sudah jalan) |
| Admin ids | `ADMIN_IDS` | `admin_ids` | **union (env ∪ DB)** — keduanya berlaku, hapus dari satu sumber saja tak mencabut akses | `admins.ts` | proses web **langsung** (`setAdminIds`); bot/notifier (proses lain) **perlu restart** |
| Web cookie secret | `WEB_COOKIE_SECRET` | `web_cookie_secret` | **env > DB > generated** (kebalikan; env = override operator; bila kosong, di-generate & disimpan ke DB) | `web_secret.ts` | **perlu restart** (mengganti → invalidasi semua sesi) |
| Kurs USDT↔IDR | `USDT_IDR_RATE` | `usd_idr_rate` | **DB > env** | `pricing.ts` (`getUsdIdrRate`, dibaca **per-operasi**) | **langsung berlaku** |
| `tokopay_*`, `bybit_*`, `binance_*`, setelan toko lain | — | Setting | **DB** (sumber tunggal, env tak ikut) | crud terkait | **langsung berlaku** (dibaca runtime) |

> **Catatan multi-proses:** setiap proses (order-bot, notifier, web-admin,
> storefront — atau `apps/server` saat satu-proses) menyimpan snapshot runtime
> sendiri. Setting yang "perlu restart" hanya menempel di proses yang dibaca
> ulang; di deploy multi-proses, restart **proses yang relevan**, bukan hanya web.

Key rahasia (`tokopay_secret`, `bot_token`, `notif_bot_token`, `bybit_api_key`,
`bybit_api_secret`, `web_cookie_secret`) ditangani **write-only**: tak di-echo,
`(hidden)` di tabel, audit `key=(updated)` tanpa nilai.

---

## 7. Manajemen stok

Halaman **web-admin → Stock → (produk)** (`apps/web-admin/src/routes/stock.ts`,
view `stock_product.njk`):

- **Tambah stok** — kredensial satu baris per akun (`email:password`).
- **Lihat stok** — tabel item per produk + status (AVAILABLE / RESERVED / SOLD /
  DEAD), login, order, catatan.
- **Download remaining** — `GET /stock/:productId/download` mengembalikan `.txt`,
  satu kredensial per baris, hanya item **AVAILABLE**. Read-only (`currentAdmin`),
  `Content-Disposition: attachment` + `Cache-Control: no-store`, **diaudit hanya
  jumlahnya** (`stock_download`) — kredensial tak pernah masuk log.
- **Delete selected** — `POST /stock/:productId/bulk-delete` menghapus baris
  permanen (beda dari "Mark as bad" yang menyetel status DEAD). Pengaman di crud
  `bulkDeleteStock`: item **SOLD tak pernah dihapus** dan item yang terkait order
  item dilewati, sehingga histori order terkirim tetap utuh. CSRF-protected,
  diaudit `stock_bulk_delete` tanpa kredensial.

CRUD: `bulkDeleteStock`, `listAvailableCredentials` di
`packages/db/src/crud/stock.ts`.

---

## 8. Credit balance (IDR + USDT)

Saat pembeli sudah membayar tapi pesanan tak bisa diantar (mis. pembayaran async
telat ke order yang sudah kedaluwarsa), dana bisa dimasukkan ke **credit balance**
pembeli (store credit — **bukan** refund ke rekening).

- **Dua saldo terpisah tanpa konversi:** `User.walletBalance` (IDR) +
  `User.walletBalanceUsdt`; `WalletTransaction.currency` menandai tiap baris
  ledger. Chokepoint `adjustWallet` sadar-mata-uang (overdraw per-currency).
- **Aksi admin:** **payments → unmatched** ("Add to buyer's credit balance") dan
  **order detail** (paid-but-undeliverable) memanggil `creditOrderToBalance` →
  kredit ke saldo mata-uang order (`unfulfilled_credit`), lepas hold stok, tandai
  order **CANCELLED**, idempoten, retag tx `credited_to_balance`. Keduanya
  CSRF-protected + diaudit.
- **Tampil di:** web-admin user detail, storefront account, dan profil bot.

CRUD: `packages/db/src/crud/{users,orders,binance_internal,bybit_deposit}.ts`.

---

## 9. Desain storefront

Satu bahasa visual dengan web-admin ("Clean Modern"): token warna, font, radius,
shadow, dan komponen (`.card`/`.btn`/`.chip`/`.field`/`.data-table`) **identik**
karena di-`include` dari `_theme.njk` bersama. Mobile-first, dwibahasa (EN+ID),
server-rendered (Tailwind CDN + HTMX, bukan SPA).

**Token warna:** `pine` `#2563eb` (aksen/tombol/harga), `grass` `#16a34a`
(tersedia), `amberx` `#b45c0a` (menunggu/stok menipis), `rust` `#dc2626`
(habis/batal); latar `paper` `#f6f8fb`, kartu `#fff`, teks `ink` `#1b2330`.
**Font:** Outfit (judul), Manrope (isi), JetBrains Mono (kredensial). Ikon Lucide.

**Peta halaman:** `/` beranda · `/c/:slug` & `/search` daftar/cari · `/p/:id`
detail · `/cart` · `/checkout` (pilih metode = pilih mata uang) ·
`/checkout/:code/pay` (instruksi + status HTMX polling) · `/account` +
`/orders`/`/orders/:code` (kredensial bila DELIVERED) / `/referral` / `/reviews` /
`/support` · `/login` + `/register` + `/forgot` + `/reset`.

Macro `price` merender **IDR + USDT bersisian** untuk semua pembeli (tanpa pemilih
mata uang). Pantangan: web tak pernah kirim Telegram; tak menampilkan
`file_id`/proof/hash mentah (kredensial hanya ke pemilik order DELIVERED); tak ada
SQL mentah; jangan ubah nama kolom/skema (DB dipakai bersama).

---

## 10. Setup env & checklist fitur

Semua konfigurasi lewat **`.env`** (salin dari [`.env.example`](.env.example)) +
sebagian via **web-admin → Settings**. Acuan kebenaran:
`packages/core/src/config.ts`. Referensi tabel variabel ada di
[`README.md` bagian 9](README.md#9-referensi-variabel-env).

### Setup lewat wizard (default)

Pada instalasi baru (belum ada admin berpassword), **tak perlu edit `.env`** untuk
login pertama. Buka panel admin (`http(s)://<host>/`) → otomatis diarahkan ke
**`/setup`**, dipandu tiga langkah:

1. **Bot token** dari @BotFather (boleh "Atur nanti").
2. **Owner admin**: Telegram ID (dari @userinfobot) + password (≥ 8 karakter).
3. **Identitas toko** (opsional).

Saat **Selesai**: otomatis login. Jika token diisi, tombol **"Nyalakan bot
sekarang"** menulis `tmp/restart.txt` agar app reboot. Selama setup belum selesai,
storefront menampilkan "Toko belum aktif" (503); setelah selesai, wizard terkunci
permanen.

`WEB_COOKIE_SECRET` boleh dikosongkan (di-generate & disimpan otomatis saat boot).

### Jalur manual `/bootstrap` (deploy lama)

1. Isi `.env` minimum + `prisma db push`.
2. Jalankan app → bot menyala (polling).
3. Buka bot di Telegram, ketik `/start` → membuat baris admin (role ADMIN karena
   ID ada di `ADMIN_IDS`). **Wajib** — login web butuh baris ini.
4. Buka `/bootstrap` → set password untuk Telegram ID itu.
5. Buka `/login` → masuk dengan Telegram ID + password.

> Lupa `/start` dulu? Login gagal `no_account`. Darurat tanpa bot:
> `pnpm reset-admin-password <telegram_id> --set <password>`.

### Env minimum

```ini
BOT_TOKEN=123456:token-dari-botfather
BOT_USERNAME=TokoSaya_bot
ADMIN_IDS=123456789
WEB_COOKIE_SECRET=acak-minimal-32-karakter-xxxxxxxxxxxxxx
TIMEZONE=Asia/Jakarta
DEFAULT_LANGUAGE=id
```

### Checklist fitur

| Fitur | Yang diisi | Catatan |
|---|---|---|
| **Bot order (inti)** | `BOT_TOKEN`, `ADMIN_IDS` | Ganti token → restart. |
| **Toko web** | `STOREFRONT_PORT` (port terpisah) **atau** `SHOP_HOST` + `SHOP_PUBLIC_URL` (1 port per-domain) | Lihat [`README.md`](README.md). |
| **Transport bot** | `BOT_MODE=webhook` + `PUBLIC_URL` + `WEBHOOK_SECRET` | Default `polling`. Webhook butuh domain HTTPS. |
| **Channel testimoni** | `PUBLIC_CHANNEL_ID` (+ `NOTIF_BOT_TOKEN` opsional) | Bot harus jadi admin channel. |
| **Binance Internal (auto)** | `BINANCE_RECEIVE_UID` + `BINANCE_API_KEY` + `BINANCE_API_SECRET` | API **read-only**. Tes: `pnpm binance-probe`. |
| **Bybit USDT-BEP20 (auto)** | `bybit_deposit_address` + `bybit_api_key` + `bybit_api_secret` di **Settings** | Wallet **read-only**, jaga `USE_UNIQUE_CENTS=1`. Tes: `pnpm bybit-probe`. |
| **QRIS Rupiah (TokoPay)** | `tokopay_merchant_id` + `tokopay_secret` + `tokopay_enabled` di **Settings** | Butuh Callback URL publik. |
| **Binance Pay manual** | `BINANCE_PAY_ID` | Fallback; admin approve manual di bot. |
| **Kurs USDT↔IDR** | `usd_idr_rate` di **Settings** | Auto-update pasar ON default. |
| **Lupa password toko** | `SMTP_HOST` + `SMTP_FROM` (+ `SMTP_USER`/`SMTP_PASS`) | Aktif bila host & from terisi. |
| **Produksi** | `WEB_COOKIE_SECURE=true` di balik HTTPS | Reverse proxy. |
