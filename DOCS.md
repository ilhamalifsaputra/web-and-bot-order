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
11. [Banyak toko dalam satu VPS](#11-banyak-toko-dalam-satu-vps)
12. [API & Webhook](#12-api--webhook)

---

## 1. Arsitektur

Monorepo pnpm: lima workspace `apps/*` + tiga `packages/*`, berbagi **satu
database SQLite** (`data/bot.db`, mode WAL).

| Workspace | Peran |
|---|---|
| `apps/order-bot` | Bot Telegram grammY (alur pelanggan + admin) |
| `apps/web-admin` | Panel admin Fastify + Nunjucks + HTMX |
| `apps/storefront` | Toko web pelanggan (Fastify + Nunjucks + HTMX) |
| `apps/server` | **Composition root satu-proses**: gabung admin + storefront + bot + worker dengan **satu PrismaClient** (`apps/server/src/index.ts`) |
| `packages/core` | Config (zod), money (Decimal), datetime (luxon), i18n, password, mailer, fx |
| `packages/db` | Prisma client + semua CRUD (`packages/db/src/crud/*`) |
| `packages/outbox-dispatcher` | Drain `notification_outbox` → channel/DM (`runDispatcher`, jalan in-process di `apps/server`) |
| `packages/web-ui` | Tema bersama (`_theme.njk`, `_macros.njk`) yang di-`include` admin & storefront |

**Prinsip inti:**

- **Satu sumber data.** Storefront & bot memakai DB + CRUD yang sama, jadi stok
  dan harga otomatis sinkron. Tidak ada SQL mentah di route — semua lewat
  `packages/db/src/crud/*`.
- **Decimal untuk semua uang** (`@app/core/money`), tidak pernah `float`.
- **Web tak pernah kirim Telegram** — enqueue ke `notification_outbox`, dispatcher
  outbox (`@app/outbox-dispatcher`, in-process di `apps/server`) yang mengirim.
- **SQLite single-writer** — tiap `$transaction` dijaga pendek.
- **Katalog 3-tier: Category → Product → Denomination.** `Product` (mis.
  "Netflix") adalah satu-satunya kartu di grid (home, kategori `/c/:slug`,
  search) — TIDAK punya harga/stok sendiri. Tiap Product punya satu/lebih
  `Denomination` (mis. "1 bulan" / "1 tahun") yang menyimpan harga, stok, dan
  auto-delivery; dipilih di halaman detail produk `/p/:slug`. Satu shaper
  bersama `shapeProducts` (`apps/storefront/src/cards.ts`) membentuk kartu grid
  dari denominasi aktif termurah ("starting price") + agregat stok/rating
  lintas denominasi.
- **Server-rendered, TIDAK ada API publik.** Admin & storefront mengembalikan
  HTML (Nunjucks + HTMX), bukan JSON. Tidak ada REST/GraphQL untuk konsumsi
  pihak ketiga; satu-satunya endpoint non-HTML adalah webhook (`/pay/{tokopay,
  paydisini,nowpayments}/callback`, `/tg/<secret>` saat `BOT_MODE=webhook`) dan
  `/healthz` — daftar lengkap + kontrak request/respons di §12. Integrasi =
  lewat DB/CRUD, bukan HTTP.

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

**Rupiah adalah sumber kebenaran harga.** `Denomination.price` / `resellerPrice`
(bukan `Product` — mid-tier itu tidak punya kolom harga) dalam IDR. USDT
diturunkan: `idrPrice / usd_idr_rate`, dibulatkan ke 0,1, dan **tampil
bersisian** dengan IDR di storefront dan bot (mis. `Rp79.000 ≈ $4,9`). Tidak ada
deteksi IP atau preferensi mata uang per-user — mata uang transaksi dipilih **saat
bayar** (IDR → TokoPay, USDT → Binance Internal / Bybit Internal Transfer).

`usd_idr_rate` **auto-update dari pasar** (`scheduleFxRefresh`,
`packages/core/src/fx.ts`), dibulatkan ke kelipatan `usd_idr_rate_rounding`
(default Rp100). Matikan dengan `usd_idr_rate_auto=false` lalu set manual. Bila
`usd_idr_rate` kosong, info USDT disembunyikan tapi checkout IDR tetap jalan.

Tiap order menyimpan snapshot: `Order.currency` (`IDR`/`USDT`), `Order.fxRate`
(kurs saat USDT), `Order.paymentMethod`, `Order.paymentRef`. Order lama tak diubah.

---

## 5. Pembayaran

**Lima metode auto-confirm, simetris di bot & storefront:**

| Metode | Mata uang | Mekanisme | Kelola |
|---|---|---|---|
| **Binance Internal** (UID + nominal unik) | USDT | poller auto-confirm (`payments/binanceInternal`) | env / Settings |
| **TokoPay (QRIS)** | IDR | webhook `POST /pay/tokopay/callback` (verifikasi signature + idempoten `ProcessedTokopayTx`) | Settings |
| **PayDisini (QRIS/e-wallet)** | IDR | webhook `POST /pay/paydisini/callback` + reconcile poller fallback; idempoten `ProcessedPaydisiniTx` | Settings |
| **NOWPayments (hosted invoice)** | USDT | IPN webhook `POST /pay/nowpayments/callback` (HMAC-SHA512, header `x-nowpayments-sig`) + reconcile poller fallback; idempoten `ProcessedNowpaymentsTx` | Settings |
| **Bybit Internal Transfer** (UID-based, instant off-chain) | USDT | poller cocokkan **nominal unik**; tak cocok → "unmatched" untuk review; idempoten `processed_bybit_tx` | Settings |

Kontrak webhook + reconcile poller ketiga gateway IDR/USDT di atas (TokoPay,
PayDisini, NOWPayments) didokumentasikan lengkap di **§12**.

Klien TokoPay & PayDisini ada di `@app/core/payments/{tokopay,paydisini}`,
NOWPayments di `@app/core/payments/nowpayments` (resolver `getTokopayCreds` /
`getPaydisiniCreds` / `getNowpaymentsCreds` di `@app/db`), dipakai storefront
dan bot. Bot menggambar QR di dalam Telegram untuk TokoPay & PayDisini
(`buyNowTokopay` / `buyNowPaydisini`, callback `payq`); NOWPayments membuka
tautan hosted invoice (`buyNowNowpayments`) karena pembayarannya di luar
Telegram.

**Storefront:** pembeli pilih metode saat bayar
(`apps/storefront/src/routes/checkout.ts`). Status di halaman bayar via **HTMX
polling** `/checkout/:code/status` ~5 dtk; saat `DELIVERED` redirect ke kredensial.
Web **tanpa upload bukti** dan **tanpa wallet**.

**QRIS/e-wallet butuh Callback URL publik** di dashboard merchant —
TokoPay (`https://<host>/pay/tokopay/callback`) dan PayDisini
(`https://<host>/pay/paydisini/callback`) — tanpa itu order mentok sampai
jendela bayar habis. NOWPayments **tidak perlu** didaftarkan manual: callback
URL dikirim otomatis per-invoice (`ipn_callback_url`). Binance & Bybit (poller)
tak terpengaruh sama sekali.

**Binance Pay manual** (upload bukti, approve manual di bot) hanya muncul sebagai
fallback zero-config bila tak ada metode otomatis. Perlu `BINANCE_PAY_ID`.

Menu bayar: **QRIS / PayDisini / NOWPayments / Binance / Bybit**. Tes koneksi
API: `pnpm binance-probe`, `pnpm bybit-probe`.

---

## 6. Settings vs `.env`

Kredensial & setelan terpusat di **web-admin → Settings**
(`apps/web-admin/src/routes/settings.ts`, whitelist `EDITABLE`):

- **Bot & notifications:** `bot_token`, `bot_username`, `notif_bot_token`
  (divalidasi `getMe` sebelum simpan; **perlu restart**).
- **Kurs:** `usd_idr_rate`, `usd_idr_rate_auto`, `usd_idr_rate_rounding`.
- **QRIS/TokoPay:** `tokopay_merchant_id`, `tokopay_secret`, `tokopay_enabled`.
- **Bybit:** `bybit_uid`, `bybit_api_key`, `bybit_api_secret`.
- **Branding:** identitas toko + upload aset (halaman `/branding` terpisah).

**Aturan umum: DB (Setting) menang, `.env` = bootstrap/pemulihan** — tapi ada
tiga pola resolver yang sengaja berbeda. `.env.example` sengaja TIDAK lagi
mencantumkan baris isi untuk `bot_token`/Binance UID+key/Bybit UID+key, dkk. —
field-field itu hanya diisi lewat Setup Wizard/Settings; env tetap didukung di
kode sebagai jalur recovery darurat (tidak divalidasi format, tak pernah
crash boot), tapi sengaja tak ditampilkan supaya tidak ada yang isi di situ
secara normal. Tabel sumber-kebenaran per setting
(resolver di `packages/db/src/crud/`, dipanggil sekali per proses saat boot lalu
di-stamp ke `@app/core/runtime`):

| Setting | env var | DB key | Yang menang | Resolver | Perubahan berlaku |
|---|---|---|---|---|---|
| Token bot/notif, username, channel | `BOT_TOKEN`, `BOT_USERNAME`, `NOTIF_BOT_TOKEN`, `PUBLIC_CHANNEL_ID` | `bot_token` dst | **DB > env** | `credentials.ts` | **perlu restart** (instance grammY sudah jalan) |
| Admin ids | `ADMIN_IDS` | `admin_ids` | **union (env ∪ DB)** — keduanya berlaku, hapus dari satu sumber saja tak mencabut akses | `admins.ts` | proses web **langsung** (`setAdminIds`); bot (proses lain) **perlu restart** |
| Web cookie secret | `WEB_COOKIE_SECRET` | `web_cookie_secret` | **env > DB > generated** (kebalikan; env = override operator; bila kosong, di-generate & disimpan ke DB) | `web_secret.ts` | **perlu restart** (mengganti → invalidasi semua sesi) |
| Kurs USDT↔IDR | `USDT_IDR_RATE` | `usd_idr_rate` | **DB > env** | `pricing.ts` (`getUsdIdrRate`, dibaca **per-operasi**) | **langsung berlaku** |
| `tokopay_*`, `bybit_*`, `binance_*`, setelan toko lain | — | Setting | **DB** (sumber tunggal, env tak ikut) | crud terkait | **langsung berlaku** (dibaca runtime) |

> **Catatan multi-proses:** setiap proses (order-bot, web-admin,
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

**Peta halaman:** `/` beranda · `/c/:slug` & `/search` daftar/cari · `/p/:slug`
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
`packages/core/src/config.ts`. **`.env.example`** sendiri adalah referensi
lengkap tiap variabel (dikomentari per kelompok); lihat juga
[`README.md` bagian 9](README.md#9-untuk-developer) untuk struktur proyek.

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
| **Bybit Internal Transfer (auto)** | `bybit_uid` + `bybit_api_key` + `bybit_api_secret` di **Settings** | Wallet **read-only**, jaga `USE_UNIQUE_CENTS=1`. Tes: `pnpm bybit-probe`. |
| **QRIS Rupiah (TokoPay)** | `tokopay_merchant_id` + `tokopay_secret` + `tokopay_enabled` di **Settings** | Butuh Callback URL publik. |
| **Binance Pay manual** | `BINANCE_PAY_ID` | Fallback; admin approve manual di bot. |
| **Kurs USDT↔IDR** | `usd_idr_rate` di **Settings** | Auto-update pasar ON default. |
| **Lupa password toko** | `SMTP_HOST` + `SMTP_FROM` (+ `SMTP_USER`/`SMTP_PASS`) | Aktif bila host & from terisi. |
| **Produksi** | `WEB_COOKIE_SECURE=true` di balik HTTPS | Reverse proxy. |

---

## 11. Banyak toko dalam satu VPS

Aplikasi ini **single-tenant**: `satu deploy = satu bot = satu toko = satu DB`.
Untuk menjalankan **beberapa bisnis yang benar-benar terpisah** (produk, stok,
order, admin, dan bot Telegram berbeda) di satu VPS, jalankan **beberapa instance
penuh yang berdiri sendiri** — tiap toko dari direktori repo sendiri dengan `.env`,
folder `./data` (DB sendiri), bot, dan port sendiri. nginx me-route tiap domain ke
port loopback instance yang sesuai.

> **Apakah bot order & pengiriman notifikasi bentrok antar-toko?** Tidak —
> **selama tiap instance pakai bot @BotFather yang berbeda.** Error Telegram 409
> ("terminated by other getUpdates") hanya muncul kalau dua proses polling memakai
> **token yang sama**. Dispatcher outbox hanya mengirim pesan (bukan `getUpdates`),
> jadi yang memakai ulang token utama instance-nya sendiri tetap aman. **Aturan
> emas: jangan pernah pakai satu token bot di dua instance.**

### Pola port (skala ke N toko)

| | Shop A | Shop B | Shop ke-N |
|---|---|---|---|
| Direktori | `/opt/shop-a` | `/opt/shop-b` | `/opt/shop-<n>` |
| `COMPOSE_PROJECT_NAME` | `shopa` | `shopb` | unik |
| Admin → toko | `admin.shop-a.com` / `shop-a.com` | `admin.shop-b.com` / `shop-b.com` | per-domain |
| `WEB_PORT` | `8000` | `8001` | `8000+n` |
| `STOREFRONT_PORT` | `8100` | `8101` | `8100+n` |

### `.env` per instance — yang **WAJIB beda** antar-toko

```ini
COMPOSE_PROJECT_NAME=shopa                 # ← beda (dipakai Compose untuk nama container)
BOT_TOKEN=<token-bot-dari-BotFather>       # ← beda (bot berbeda per toko)
ADMIN_IDS=<id-admin-toko-ini>
WEB_PORT=8000                              # ← beda (8001, 8002, …)
STOREFRONT_PORT=8100                       # ← beda (8101, 8102, …)
WEB_COOKIE_SECRET=<openssl rand -hex 32>   # ← beda (acak, min 32 char)
SHOP_PUBLIC_URL=https://shop-a.com         # ← domain toko ini (link DM + callback gateway)
WEB_COOKIE_SECURE=true                     # produksi di balik HTTPS
BOT_MODE=polling                           # default; tidak butuh domain untuk bot
DATABASE_URL_PRISMA=file:/app/data/bot.db  # Docker: path ABSOLUT; ./data-nya beda per direktori
```

Gateway pembayaran (TokoPay / PayDisini / NOWPayments) **tidak** diisi di `.env` —
diisi di web-admin → Settings tiap instance (tersimpan di DB masing-masing, jadi
otomatis terpisah). Pakai akun gateway berbeda per toko.

### Langkah (ulangi per toko)

```bash
git clone <repo-url> /opt/shop-a && cd /opt/shop-a
cp .env.example .env                                      # isi sesuai tabel di atas
docker compose run --rm server pnpm prisma db push        # skema sebelum start (hindari P2022)
docker compose up -d                                      # nama container otomatis dari COMPOSE_PROJECT_NAME
```

`docker-compose.yml` repo ini sudah siap multi-instance: nama container diturunkan
dari `COMPOSE_PROJECT_NAME` (tidak hardcoded) dan port hanya dipublish ke
`127.0.0.1` — jadi dua instance tidak saling bentrok dan tetap di balik nginx.

### nginx + TLS

Pakai `deploy/nginx/telegram-shop.conf` sebagai pola, lalu untuk **tiap toko**
salin satu pasang server block (admin + storefront), ganti `server_name`, path
sertifikat, dan port `proxy_pass` (`8000+n` admin, `8100+n` storefront). Satu
`certbot` bisa mencakup semua domain sekaligus:

```bash
certbot --nginx -d shop-a.com -d admin.shop-a.com \
                -d shop-b.com -d admin.shop-b.com
nginx -t && systemctl reload nginx
```

### Backup & batas

- **Backup per instance**: satu cron per toko memakai `deploy/backup/backup.sh`
  dengan path DB berbeda (`/opt/shop-a/data/bot.db`, …). WAL-safe via
  `sqlite3 .backup`; lihat `deploy/backup/README.md`.
- **Single-writer SQLite tetap aman**: tiap instance menulis ke DB-nya **sendiri**
  (bukan beberapa writer ke satu DB), jadi tidak memicu kebutuhan pindah Postgres.
- **Batas praktis**: N toko = 4×N container; yang membatasi adalah RAM/CPU VPS
  (kira-kira ~1 GB per toko), bukan arsitektur DB.

---

## 12. API & Webhook

Proyek ini **server-rendered, tidak punya REST/GraphQL API publik** untuk
konsumsi pihak ketiga (lihat §1) — admin & storefront selalu balas HTML
(Nunjucks + HTMX). Daftar di bawah adalah **satu-satunya** endpoint non-HTML:
health check, webhook Telegram, dan webhook gateway pembayaran. Integrasi
eksternal lain harus lewat DB + `packages/db/src/crud/*`, bukan HTTP.

### 12.1 Health check

| Endpoint | Proses | Auth | Respons |
|---|---|---|---|
| `GET /healthz` | web-admin (`apps/web-admin/src/routes/auth.ts`) | tidak ada (di-exclude dari setup-gate) | `{"status":"ok"}` setelah satu ping DB (`getSetting`) |
| `GET /healthz` | storefront (`apps/storefront/src/server.ts`) | tidak ada | sama, untuk domain toko sendiri |

Dipakai uptime monitor / reverse proxy; tetap menjawab walau setup wizard
belum selesai atau bot OFF (token kosong).

### 12.2 Webhook Telegram

`POST /tg/<WEBHOOK_SECRET>` — hanya didaftarkan saat `BOT_MODE=webhook` dan
token bot terisi (`apps/server/src/index.ts`). Default transport tetap
`polling`; endpoint ini tidak ada sama sekali bila mode ≠ `webhook`.

Auth dua lapis: path harus cocok `WEBHOOK_SECRET`, lalu grammY (`webhookCallback`)
memverifikasi header `X-Telegram-Bot-Api-Secret-Token` sebelum update
diteruskan ke bot — mismatch dibalas `401` sebelum logic bot jalan sama sekali.

### 12.3 Webhook gateway pembayaran (storefront, public)

Tiga gateway auto-confirm (lihat §5) punya webhook dengan kontrak request/respons
yang sengaja dibuat seragam (`apps/storefront/src/routes/checkout.ts`):

| Endpoint | Mata uang | Auth (signature) | Ledger idempoten |
|---|---|---|---|
| `POST /pay/tokopay/callback` | IDR | field di body, `md5(merchantId:secret:refId)` | `ProcessedTokopayTx` |
| `POST /pay/paydisini/callback` | IDR | field di body (skema sejenis TokoPay) | `ProcessedPaydisiniTx` |
| `POST /pay/nowpayments/callback` | USDT | header `x-nowpayments-sig`, HMAC-SHA512 atas body yang key-nya di-sort rekursif | `ProcessedNowpaymentsTx` |

**Kontrak respons identik untuk ketiganya** — supaya gateway berhenti retry
terlepas dari hasilnya:

- `403` — gateway dimatikan (kredensial/`*_enabled` kosong) atau signature tidak valid.
- `200` untuk **semua** outcome lain: `ignored` (status belum final, mis.
  `waiting`/`confirming`), `unmatched` (refId/orderId tak ketemu order yang
  cocok → tetap dicatat ke ledger untuk review admin), `amount mismatch`
  (dibayar kurang dari `order.totalAmount`), `delivered`, atau
  `delivery failed` (pembayaran sudah tercatat tapi auto-delivery gagal —
  diselesaikan manual dari panel order, ditandai `delivery_failed` di ledger).

**Pendaftaran callback URL per gateway:**

- **TokoPay & PayDisini** — didaftarkan manual di dashboard merchant masing-masing:
  `https://<SHOP_PUBLIC_URL>/pay/tokopay/callback` /
  `https://<SHOP_PUBLIC_URL>/pay/paydisini/callback`.
- **NOWPayments** — dikirim otomatis per-invoice sebagai `ipn_callback_url`
  saat invoice dibuat (`createInvoice`,
  `packages/core/src/payments/nowpayments.ts`); tidak perlu didaftarkan manual.

**Fallback bila webhook tidak sampai:** ketiga gateway juga punya reconcile
poller di bot (`apps/order-bot/src/payments/{tokopay,paydisini,nowpayments}Reconcile.ts`)
yang polling status gateway untuk order `PENDING` yang masih dalam jendela
bayar, idempoten lewat ledger yang sama dengan webhook-nya.

> ⚠ **Belum sepenuhnya terverifikasi ke dashboard live:** nama field/endpoint
> PayDisini, dan sebagian detail NOWPayments (slug `pay_currency`, endpoint
> status-check) — lihat komentar `ASSUMPTION (flagged)` di
> `packages/core/src/payments/{paydisini,nowpayments}.ts`. Verifikasi sebelum
> go-live.

### 12.4 Endpoint internal lain (bukan API publik)

- `GET /checkout/:code/status` — partial HTMX yang di-poll halaman bayar
  storefront tiap ~5 detik (§5); butuh sesi pembeli pemilik order, jadi bukan
  endpoint yang bisa dipanggil pihak ketiga.
