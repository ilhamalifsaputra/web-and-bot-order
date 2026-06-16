# Dokumentasi Proyek — `telegram-order-bot`

> Dokumen gabungan: **rencana** & **desain** storefront, **cutover** harga
> USDT→IDR, dan panduan **deploy** Hostinger. Sebelumnya terpisah di
> `plan.md`, `design.md`, `CUTOVER-IDR.md`, `DEPLOY-HOSTINGER.md` — kini satu
> file agar tidak berserakan. Konvensi koding tetap di [`CLAUDE.md`](CLAUDE.md),
> panduan instalasi di [`README.md`](README.md).

## Daftar isi

- [Status & implementasi nyata (Juni 2026)](#status--implementasi-nyata-juni-2026)
- [Bagian 1 — Rencana Storefront (Arsitektur & Rencana)](#bagian-1--rencana-storefront-arsitektur--rencana)
- [Bagian 2 — Desain Storefront (Spesifikasi Visual)](#bagian-2--desain-storefront-spesifikasi-visual)
- [Bagian 3 — Cutover Harga USDT → IDR (Runbook)](#bagian-3--cutover-harga-usdt--idr-runbook)
- [Bagian 4 — Deploy ke Hostinger Node App Manager](#bagian-4--deploy-ke-hostinger-node-app-manager)
- [Bagian 5 — Setup & konfigurasi env lengkap (untuk pembeli)](#bagian-5--setup--konfigurasi-env-lengkap-untuk-pembeli)

---

## Status & implementasi nyata (Juni 2026)

> **Bagian 1–4 di bawah ini adalah dokumen perencanaan asli** (ditulis sebelum
> kode dibuat) — disimpan sebagai catatan keputusan & rasional. **Storefront kini
> SUDAH dibangun penuh** dan berjalan di `apps/storefront`, jadi beberapa "how"
> berbeda dari rencana. Bagian ini adalah **sumber kebenaran terkini**; bila
> bertentangan dengan Bagian 1–4, **ikuti bagian ini**.

### Peta aplikasi (kondisi sekarang)
Monorepo pnpm, lima workspace `apps/*` + tiga `packages/*`:

| Workspace | Peran |
|---|---|
| `apps/order-bot` | Bot Telegram grammY (pelanggan + admin) |
| `apps/web-admin` | Panel admin Fastify+Nunjucks+HTMX |
| `apps/storefront` | **Toko web pelanggan** (sudah jadi — rencana di Bagian 1–2) |
| `apps/notifier` | Drain `notification_outbox` → channel publik |
| `apps/server` | **Composition root satu-proses**: gabung admin + storefront + bot + worker dengan **satu PrismaClient** (`apps/server/src/index.ts`) |
| `packages/core` | Config (zod), money (Decimal), datetime (luxon), i18n, **password**, **mailer**, **fx** |
| `packages/db` | Prisma + semua crud (`packages/db/src/crud/*`) |
| `packages/web-ui` | Tema bersama (`_theme.njk`, `_macros.njk`) yang di-include admin & storefront |

### Apa yang berubah dari rencana — "how" yang sebenarnya

**1. Auth pelanggan = username/email + password (BUKAN hanya Telegram Login Widget).**
Rencana Bagian 1 §5 menyebut Telegram Login Widget sebagai satu-satunya pintu.
Implementasi nyata punya **dua pintu** di `/login`:
- **Username/email + password (utama)** — registrasi mandiri di `/register`
  (`loginUsername` 3–32 char `[a-z0-9_]`, `email` unik, `passwordHash`), login
  memverifikasi hash, gagal selalu pesan generik (anti-enumerasi).
- **Telegram Login Widget = lookup-only** — hanya **masuk** ke akun yang sudah
  ada by `telegramId`; tidak lagi auto-membuat user. Telegram ID asing diarahkan
  ke `/register` atau bot.
- **Lupa password** (`/forgot` → email token reset → `/reset`), token di tabel
  `PasswordResetToken`, email dikirim via `@app/core/mailer`.
- Sesi di-key per `userId` (akun web murni tak punya `telegramId`); cookie HMAC
  `httpOnly`+`SameSite=Lax`, jti rotasi disimpan di `Setting`. Guest-cart digabung
  saat login (rencana §5 keputusan D — tetap berlaku).
- Kolom DB baru: `User.loginUsername`, `User.email`, `User.passwordHash`,
  tabel `PasswordResetToken`. Crud: `packages/db/src/crud/webauth.ts`.
- File terkait: `apps/storefront/src/routes/auth.ts`, `routes/forgot.ts`,
  `src/auth.ts`, view `login/register/forgot/reset.njk`,
  `packages/core/src/{password,mailer}.ts`.

**2. Gambar produk = upload admin → `data/uploads/` (Unsplash hanya fallback).**
Rencana Bagian 1 §8 / Bagian 2 §6 mengutamakan Unsplash. Nyatanya:
- Admin meng-upload foto produk lewat web-admin; file disimpan di
  **`data/uploads/`** dan path-nya di kolom **`Product.webImageUrl`**.
- Storefront menyajikan folder itu sebagai statis: `GET /uploads/*`
  (`apps/storefront/src/server.ts`, env `UPLOADS_DIR`, default `data/uploads`).
- Urutan resolusi gambar: `webImageUrl` (upload admin) → peta Unsplash per
  kategori (`apps/storefront/src/images.ts`) → placeholder.
- **Branding bisa di-upload (Juni 2026):** halaman **web-admin › Settings ›
  Branding** (`apps/web-admin/src/routes/branding.ts`, view `branding.njk`)
  meng-upload **favicon** (PNG/ICO/SVG), **logo header** (PNG/SVG/WebP), **hero**
  storefront, dan **banner bot** (JPG/PNG/WebP) ke **`data/uploads/branding/`**
  (nama file di-hash, anti traversal). Setting: `web_favicon_url`, `web_logo_url`,
  `web_hero_url`, `banner_image`. Storefront memakai favicon di tiap halaman
  (`shopContext` → `favicon_url`, fallback `/static/favicon.svg`), **logo** di
  header (`logo_url`; kosong → ikon `store` bawaan), dan hero di home
  (`web_hero_url` → fallback `HERO_IMAGE`). Folder `/uploads/` di **kedua** app kini menyajikan
  header `X-Content-Type-Options: nosniff` + CSP ketat agar SVG yang di-upload
  inert (tak bisa eksekusi script bila dibuka langsung).

**3. Pembayaran = TIGA metode auto-confirm, kini SIMETRIS di kedua front.**
| Metode | Mata uang order | Front | Mekanisme | Kelola |
|---|---|---|---|---|
| **Binance Internal Transfer** (UID + nominal unik) | USDT | bot **&** storefront | poller auto-confirm (`payments/binanceInternal`) | env / Settings |
| **TokoPay (QRIS)** | IDR | bot **&** storefront | webhook `POST /pay/tokopay/callback` (verifikasi signature + idempotensi `ProcessedTokopayTx`) | web-admin Settings |
| **Bybit USDT-BEP20 (on-chain)** | USDT | bot **&** storefront | poller cocokkan **nominal unik** (BEP20 tanpa memo); tak cocok = "unmatched" untuk review; idempoten via `processed_bybit_tx` UNIQUE | web-admin Settings |
- **Simetri metode (Juni 2026):** storefront = QRIS + Binance + **Bybit**; bot =
  **QRIS + Binance Internal + Bybit** (menu dirapikan, lihat poin 9 — manual
  Binance Pay kini hanya fallback zero-config). Klien TokoPay kini di rumah bersama
  `@app/core/payments/tokopay` (resolver `getTokopayCreds` di `@app/db`), dipakai
  storefront **dan** bot. Bot QRIS menggambar QR di dalam Telegram
  (`buyNowTokopay`, callback `payq`); pembeli QRIS Telegram dikonfirmasi via
  webhook (bukan poller) lalu mengambil kredensial dari **My Orders** di bot.
- **Dependensi QRIS (web & bot):** auto-confirm hanya jalan bila **Callback URL
  TokoPay** publik diset (`https://<host>/pay/tokopay/callback`, §15.5). Tanpa itu
  order QRIS mentok sampai jendela bayar habis lalu auto-cancel. Binance & Bybit
  (poller) tak terpengaruh.
- Di **storefront** pembeli memilih metode **saat bayar**: USDT→**Binance atau
  Bybit**, IDR→TokoPay (`apps/storefront/src/routes/checkout.ts`). Status di
  halaman bayar via **HTMX polling** `/checkout/:code/status` tiap ~5 dtk; saat
  `DELIVERED` redirect ke kredensial. Web **tanpa upload bukti** & **tanpa
  wallet** (§17.1).
- `Order.currency` ("IDR"/"USDT") + `Order.fxRate` (snapshot kurs saat USDT) +
  `Order.paymentMethod` + `Order.paymentRef` sudah ada di skema.

**4. Kurs USDT auto-update dari pasar (bukan manual-only).**
- `usd_idr_rate` di-refresh otomatis dari pasar (`scheduleFxRefresh`,
  `packages/core/src/fx.ts`), dibulatkan ke kelipatan `usd_idr_rate_rounding`
  (default Rp100). Matikan dengan `usd_idr_rate_auto=false` → baru edit manual.
- USDT turunan: `idrPrice / usd_idr_rate`, dibulatkan ke 0,1. Tampil bersisian
  dengan IDR di storefront **dan** bot (sesuai rencana §15).

**5. Kredensial terpusat di web-admin Settings (`apps/web-admin/src/routes/settings.ts`).**
Whitelist `EDITABLE`, dikelompokkan jadi tab di `settings.njk`:
- **Bot & notifications**: `bot_token`, `bot_username`, `notif_bot_token`
  (token → **perlu restart**; divalidasi `getMe` sebelum simpan).
- **Pembayaran — kurs**: `usd_idr_rate`, `usd_idr_rate_auto`, `usd_idr_rate_rounding`.
- **Pembayaran — QRIS/TokoPay**: `tokopay_merchant_id`, `tokopay_secret`,
  `tokopay_enabled`.
- **Pembayaran — Bybit**: `bybit_deposit_address`, `bybit_api_key`, `bybit_api_secret`.
- **Branding** (halaman terpisah `/branding`, bukan tab Settings): identitas toko
  `shop_name`, `shop_tagline`, `welcome` dan **banner bot** `banner_image` kini
  diedit di sini bersama upload favicon/hero (lihat poin 2). Key-key itu **keluar
  dari form Settings** (tetap di whitelist `EDITABLE` sbg fallback + tabel
  read-only). Banner bot: bot mengirim file upload via `InputFile` lalu meng-cache
  file_id Telegram-nya (`banner_image_fileid`); file_id legacy (di-set dari bot)
  tetap jalan, dan cache di-invalidasi saat banner di-set/hapus/undo dari bot.
  `support_whatsapp` tetap di tab Website.
- Key rahasia (`SECRET_KEYS`: `tokopay_secret`, `bot_token`, `notif_bot_token`,
  `bybit_api_key`, `bybit_api_secret`) ditangani **write-only**: tak di-echo,
  `(hidden)` di tabel, audit `key=(updated)` tanpa nilai.
- Prioritas: **DB (Setting) menang, env = bootstrap/pemulihan**. `tokopay_*` &
  `bybit_*` dibaca per-request/per-poll (hot, tanpa restart); token bot dibaca
  saat boot (perlu restart).

**6. Deploy = composition root satu-proses (`apps/server`).**
- Dua topologi listen (`apps/server/src/index.ts`): bila `SHOP_PUBLIC_URL` di-set
  → **satu listener publik**, request host toko → storefront, sisanya (admin,
  webhook `/tg`, health ping) → admin. Bila tidak → admin di `WEB_PORT`,
  storefront di `STOREFRONT_PORT` (default 8100).
- `BOT_MODE` (polling | webhook) memilih transport bot. Web tetap jalan walau
  token bot kosong (bot OFF sampai diisi + restart). Build & langkah Hostinger:
  Bagian 4.

**7. Manajemen stok lanjutan di web-admin (Juni 2026).**
Halaman **web-admin › Stock › (produk)** (`apps/web-admin/src/routes/stock.ts`,
view `stock_product.njk`) kini punya tiga aksi di luar tambah-stok & catatan:
- **Lihat stok** — tabel semua item per produk dengan status (AVAILABLE /
  RESERVED / SOLD / DEAD), login, order, dan catatan.
- **Unduh stok tersisa** — tombol "Download remaining" → `GET
  /stock/:productId/download` mengembalikan **file `.txt`, satu kredensial per
  baris** (format sama dengan kotak upload) hanya untuk item **AVAILABLE**.
  Read-only (`currentAdmin`), `Content-Disposition: attachment` +
  `Cache-Control: no-store`, **diaudit hanya jumlahnya** (`stock_download`) —
  kredensial tak pernah masuk log.
- **Hapus terpilih** — checkbox + tombol "Delete selected" → `POST
  /stock/:productId/bulk-delete` **menghapus baris secara permanen** (beda dari
  "Mark as bad" yang menyetel status DEAD tapi menyimpan barisnya). Dua pengaman
  di crud `bulkDeleteStock`: item **SOLD tak pernah dihapus** dan item yang
  **terkait order item dilewati**, sehingga histori order terkirim tetap utuh.
  CSRF-protected, diaudit `stock_bulk_delete` (`requested`/`deleted`, tanpa
  kredensial). Crud baru: `bulkDeleteStock`, `listAvailableCredentials` di
  `packages/db/src/crud/stock.ts`.

**8. Credit balance dua mata uang (IDR + USDT) untuk order tak terpenuhi.**
Saat pembeli sudah membayar tapi pesanan tak bisa diantar (mis. pembayaran
async/telat ke order yang sudah kedaluwarsa), dana bisa dimasukkan ke **credit
balance** pembeli (store credit, **bukan** refund ke rekening, **bukan** "saldo").
- **Dua saldo terpisah tanpa konversi**: kolom `User.walletBalance` (IDR) +
  `User.walletBalanceUsdt`, dan `WalletTransaction.currency` menandai tiap baris
  ledger. Chokepoint `adjustWallet` jadi sadar-mata-uang (overdraw per-currency).
- Aksi admin: **payments › unmatched** ("Add to buyer's credit balance") dan
  **order detail** (saat paid-but-undeliverable) memanggil `creditOrderToBalance`
  → kredit ke saldo mata-uang order (`unfulfilled_credit`), lepas hold stok,
  tandai order **CANCELLED** (bukan REFUNDED), idempoten, dan retag tx jadi
  `credited_to_balance`. Kedua rute CSRF-protected + diaudit.
- Tampil di **web-admin user detail**, **storefront account**, dan **profil bot**
  (dua saldo). Crud: `packages/db/src/crud/{users,orders,binance_internal,
  bybit_deposit}.ts`. Desain lengkap: `docs/superpowers/specs/2026-06-16-dual-credit-balance-design.md`.

**9. Menu pembayaran dirapikan (bot & storefront, Juni 2026).**
Nama & urutan metode jadi **QRIS / BINANCE / Bybit-BSC**, logo diseragamkan di
storefront (`apps/storefront/static/pay/{qris,binance,bybit}.png`). Di bot, menu
bayar dibersihkan dari emoji dan disusun **QRIS** lalu **USDT** (submenu Binance /
Bybit); QR QRIS **dan** QR Binance manual kini satu bubble foto+caption (bukan
foto terpisah). Metode "Binance manual" lama dihapus dari menu.

### Status fase (rencana Bagian 1 §12)
Fase 0–6 (scaffold, katalog, akun+auth, keranjang+checkout, harga IDR+TokoPay,
wiring deploy, poles) **sudah diimplementasikan**. Selain itu ditambahkan di luar
rencana awal: **auth password/email + lupa-password**, **upload foto produk
admin**, **pembayaran Bybit USDT-BEP20**, **auto-update kurs pasar**, **halaman
Branding** (upload favicon/hero/banner + identitas toko), **manajemen stok
lanjutan** (unduh stok tersisa + hapus terpilih), **credit balance IDR+USDT**, dan
**menu pembayaran QRIS/BINANCE/Bybit yang dirapikan**.

---

## Bagian 1 — Rencana Storefront (Arsitektur & Rencana)

> ⚠️ **Dokumen perencanaan asli (historis) — sudah diimplementasikan & diringkas.**
> Versi panjangnya ada di histori git; untuk kondisi & "how" terkini lihat
> [Status & implementasi nyata](#status--implementasi-nyata-juni-2026). Bagian ini
> menyimpan **keputusan & rasional** inti saja.

**Inti rencana.** Storefront = wajah web dari sisi pelanggan bot, dibangun sebagai
`apps/storefront` di monorepo, **berbagi DB & crud** (`@app/db` → `data/bot.db`
yang sama) sehingga stok & data otomatis sinkron dengan bot. Stack & tema
**identik** web-admin (Fastify + Nunjucks + HTMX + Tailwind CDN), server-rendered,
bukan SPA. Tidak pernah kirim Telegram dari web (pakai `notification_outbox`);
tidak ada SQL mentah di route (lewat `packages/db/src/crud/*`).

**Keputusan final (§10 rencana — semua sudah dieksekusi):**

| # | Keputusan |
|---|---|
| A | Storefront = **app monorepo** `apps/storefront` (bukan proyek terpisah; hindari penulis SQLite kedua) |
| B | **Tema bersama** via `packages/web-ui/views/_theme.njk` + `_macros.njk`, di-`include` kedua app |
| C | Gambar produk: kolom `Product.webImageUrl` (upload admin) + fallback peta `images.ts` (Unsplash) |
| D | **Keranjang tamu** (cookie) digabung ke `CartItem` saat login; katalog tanpa login; checkout wajib login |
| E | **Dwibahasa** EN+ID (i18n `@app/core` yang sama) |
| F | **Satu proses, satu Fastify** (composition root `apps/server`, 1 PrismaClient); storefront vs admin dipisah per Host/port |
| G | Identitas toko di **Settings** (`shop_name`/`tagline`/`logo_url`) + env `PUBLIC_URL` |
| H | **Satu harga pusat IDR** (sumber kebenaran); USDT diturunkan dari `usd_idr_rate` (dibulatkan) & tampil **di samping IDR** sebagai info — **tanpa deteksi IP**. Mata uang transaksi dipilih **saat bayar**: IDR→TokoPay, USDT→Binance/Bybit. Lihat §15 |
| I | **Kredensial (token bot/notifier, TokoPay) di web-admin Settings** — secret write-only, DB menang atas env, token bot perlu restart + validasi `getMe`. Lihat §16 |

**§15 — Harga pusat IDR + USDT info.** `Product.price`/`resellerPrice` kini
**Rupiah** (bukan USDT). `Order.currency` ("IDR"/"USDT") + `Order.fxRate` (snapshot
kurs); `User.currency` **tidak ada** (tak ada preferensi/IP). USDT =
`idrPrice / usd_idr_rate`, dibulatkan; ditagih apa adanya bila pembeli pilih
Binance/Bybit. Order historis pra-`currency` dianggap USDT (snapshot, tak diubah).
Migrasi basis USDT→IDR = **Bagian 3**.

**§16 — Kredensial di Settings.** Key `Setting`: `bot_token`/`notif_bot_token`
(secret, dibaca saat boot → **perlu restart** + validasi `getMe`, Owner-only),
`tokopay_merchant_id`/`tokopay_secret`/`tokopay_enabled` (dibaca per-request →
**hot**), `binance_pay_id`, `usd_idr_rate`. Secret = write-only ("●●● tersimpan"),
`(hidden)` di tabel, audit `key=(updated)` tanpa nilai. Prioritas **DB menang,
env = bootstrap/pemulihan**.

**§17 — Keputusan & open items yang jadi kenyataan.** Web = **auto-confirm saja**
(tanpa upload bukti manual; USDT→Binance/Bybit poller, IDR→TokoPay webhook) — alur
Binance Pay manual + bukti tetap **hanya di bot** (§17.1 #1). **Wallet
disembunyikan di web v1** (dikelola via bot; §17.1 #5). Re-validasi stok/harga
tepat sebelum buat order; status bayar via **HTMX polling**; kedaluwarsa order
ditangani cron (`cancelOrder`) tanpa kode baru.

---

## Bagian 2 — Desain Storefront (Spesifikasi Visual)

> ⚠️ **Spesifikasi desain historis — sudah diimplementasikan & diringkas.** Sumber
> kebenaran visual sekarang = kode (`apps/storefront/views/*` +
> `packages/web-ui/views/_theme.njk`/`_macros.njk`).

**Prinsip.** Satu bahasa visual dengan web-admin ("Clean Modern"): token warna,
font, radius, shadow, dan komponen (`.card`/`.btn`/`.chip`/`.field`/`.data-table`)
**identik** karena di-`include` dari `_theme.njk` bersama — ganti token sekali, dua
web ikut. Bahasa polos dwibahasa (tanpa jargon), mobile-first, stok jujur
real-time, ringan (Tailwind CDN + HTMX, server-rendered).

**Tokens (sumber: `web-admin base.njk`).** Brand `pine` `#2563eb` (aksen/tombol/
link/harga), `grass` `#16a34a` (sukses/tersedia), `amberx` `#b45c0a`
(menunggu/stok menipis), `rust` `#dc2626` (habis/batal); latar `paper` `#f6f8fb`,
kartu `#fff`, teks `ink` `#1b2330`. Font: **Outfit** (judul), **Manrope** (isi),
**JetBrains Mono** (kode/kredensial). Ikon **Lucide**.

**Komponen baru storefront** (pakai token sama): header toko (logo + search +
keranjang + akun), `product_card` (grid 2→4 kolom), `stock_badge`
(tersedia/sisa-N/habis), `price` (IDR utama + `≈ $` info), cart drawer (HTMX),
stepper checkout, `stars`, hero/banner, category pills.

**Peta halaman.** `/` beranda · `/c/:slug` & `/search` daftar/cari · `/p/:id`
detail · `/cart` · `/checkout` (pilih metode = pilih mata uang) ·
`/checkout/:code/pay` (instruksi + status HTMX polling) · `/account` +
`/orders`/`/orders/:code` (kredensial bila DELIVERED)/`/referral`/`/reviews`/`/support`
· `/login` (dulu Telegram widget; kini juga username/password — lihat Status §1).
Wallet ditunda di web v1.

**Tampilan harga (§8b).** Macro `price` merender **IDR + USDT bersisian** untuk
semua pembeli (tanpa pemilih mata uang / IP). IDR `Rp79.000` (tanpa desimal),
USDT `≈ $4,9` (turunan `usd_idr_rate`, dibulatkan 0,1). Bila `usd_idr_rate` kosong
→ info USDT disembunyikan, checkout IDR tetap jalan via TokoPay.

**Pantangan (selaras aturan proyek):** web tak pernah kirim Telegram (outbox); tak
tampilkan `file_id`/proof/hash mentah (kredensial hanya ke pemilik order
DELIVERED); tak ada SQL mentah; jangan ubah nama kolom/skema (DB dipakai bersama).

---

## Bagian 3 — Cutover Harga USDT → IDR (Runbook)

> ⚠️ **Migrasi satu-kali (historis).** Repo sudah berbasis IDR. Runbook ini hanya
> relevan bila menghidupkan **DB lama yang masih berbasis USDT** — DB wajib
> dikonversi sebelum kode baru jalan, kalau tidak harga tampil 16.000× lebih murah
> & kolom baru memicu `P2022`.

**Yang dikonversi** (oleh `scripts/convert-prices-to-idr.ts`; satu `$transaction`,
menolak jalan dua kali bila `usd_idr_rate` sudah terisi): `Product.price` &
`resellerPrice` (× kurs, bulat ke Rupiah), `Voucher.value` (type `FIXED`) &
`Voucher.minPurchase` (× kurs), `Setting usd_idr_rate` (= kurs dipakai).
`BulkPricing` (persen) dan order/wallet historis **tidak** diubah (snapshot USDT).

**Urutan (WAJIB urut):**
1. **Stop** bot/server (single-writer SQLite — script jadi penulis tunggal).
2. **Backup** `data/bot.db` + `-wal` + `-shm` (mis. `.bak-pre-idr-YYYYMMDD`).
3. `pnpm exec prisma db push` (kolom `web_image_url`, `orders.currency`,
   `orders.fx_rate`, tabel `processed_tokopay_tx`).
4. `pnpm tsx scripts/convert-prices-to-idr.ts 16000` (ganti `16000` = kurs pasar hari itu).
5. **Start kode baru** (migrasi dulu, kode belakangan — CLAUDE.md).
6. Cek web-admin Catalog & bot katalog (harga `Rp… ≈ $…`).

**Gladi resik:** jalankan dulu ke **salinan** DB (`DATABASE_URL_PRISMA` → file
salinan) sebelum menyentuh DB asli. **Rollback:** stop → kembalikan backup
`bot.db*` → start kode lama (tak ada rollback parsial — itulah kenapa backup wajib).

> Setelah cutover, `usd_idr_rate` **otomatis mengikuti kurs pasar** (tiap jam,
> dibulatkan ke `usd_idr_rate_rounding`, default Rp100) — kurs di langkah 4 hanya
> menentukan konversi katalog sekali itu. Matikan via Settings →
> `usd_idr_rate_auto=false`. Order lama tetap pakai snapshot `fxRate` masing-masing.

---

## Bagian 4 — Deploy ke Hostinger Node App Manager

Panduan menjalankan `telegram-order-bot` di **Hostinger Node.js App Manager**
(berbasis Passenger), bukan VPS. Ini jalur yang punya batasan, jadi baca bagian
**Konsep & Caveat** dulu sebelum eksekusi.

> Alternatif yang jauh lebih mulus tetap **Hostinger VPS** (`RUN.md`, Docker).
> Dokumen ini khusus untuk yang tetap mau pakai App Manager.

---

### 0. Konsep & Caveat (WAJIB paham dulu)

App Manager (Passenger) berbeda dari VPS. Empat hal yang membentuk seluruh strategi:

1. **Satu aplikasi = satu proses = satu startup file.**
   Project ini punya 3 service: `order-bot`, `web-admin`, `notifier`. Mereka akan
   digabung jadi **satu proses** (satu entry `apps/server`). Karena DB SQLite
   bersifat *single-writer* (lihat `CLAUDE.md`), satu proses justru paling aman.

2. **Install pakai `npm`, bukan `pnpm`.**
   Dependensi internal ditulis `"@app/core": "workspace:*"` — npm tidak paham itu.
   Solusi: kode di-*bundle* dengan esbuild jadi **satu file JS** (`dist/server.cjs`)
   sehingga paket `@app/*` ikut ter-*inline*; npm cukup meng-install dependensi
   eksternal lewat `package.prod.json` yang rata (tanpa workspace).

3. **Runtime = `node`, bukan `tsx`.**
   Passenger menjalankan startup file dengan `node` biasa. Output esbuild adalah
   JS murni, jadi tidak butuh `tsx` saat runtime.

4. **Passenger meng-*idle* aplikasi saat tidak ada traffic HTTP.**
   Web-admin aman (ada request). Tapi **bot Telegram & notifier butuh nyala 24/7**.
   Jika Passenger menidurkan proses, bot ikut mati sampai ada yang membuka web.
   **Mitigasi wajib:** pasang **UptimeRobot** (atau cron-job.org) yang nge-ping
   URL web tiap 1–5 menit agar proses tidak pernah idle. Tanpa ini, bot tidak
   reliabel di App Manager. (Di VPS, masalah ini tidak ada.)

   > **Dua mode transport bot** (env `BOT_MODE`):
   > - `polling` (default) — long polling grammY; **tidak** butuh domain/HTTPS
   >   untuk bot. Paling simpel, tapi sepenuhnya bergantung pada UptimeRobot agar
   >   proses tidak idle.
   > - `webhook` — bot di-*mount* sebagai route `POST /tg/<secret>` di Fastify
   >   yang sama. Telegram nge-POST tiap ada pesan, jadi traffic masuk **ikut
   >   membangunkan** Passenger (mengurangi idle untuk bot). Butuh `PUBLIC_URL`
   >   (domain HTTPS app) + `WEBHOOK_SECRET`. **Tetap** pasang UptimeRobot karena
   >   poller Binance & job croner butuh nyala walau tak ada pesan masuk.

---

### 1. Cek dulu kemampuan paketmu di hPanel

Sebelum mulai, pastikan tiga hal di **hPanel**:

1. **Apakah ada Node.js App Manager?**
   hPanel → cari menu **"Node.js"** / **"Setup Node.js App"**. Kalau tidak ada,
   paketmu (mis. Single/Premium shared lama) belum tentu mendukung Node — perlu
   upgrade ke Business/Cloud, atau pindah ke VPS.

2. **Apakah ada SSH / Terminal?**
   hPanel → **Advanced → SSH Access**. Kalau tombol/akun SSH bisa diaktifkan,
   berarti **punya SSH** → ikuti **Jalur A** (paling fleksibel).
   Kalau hanya ada UI Node App (tombol *Run NPM install*, *Restart*, dropdown
   startup file) tanpa SSH → ikuti **Jalur B**.

3. **Versi Node** yang tersedia ≥ 20 (project butuh Node ≥ 20 — `package.json`
   `engines.node`). Pilih Node 20/22 di dropdown App Manager.

---

### 2. Perubahan kode (SUDAH diterapkan ✅)

Semua perubahan di bawah sudah dibuat dan diverifikasi (`pnpm -r typecheck` &
`pnpm test` hijau, 218 tests pass; bundle ter-build & smoke-test OK).

| # | File baru/diubah | Tujuan | Status |
|---|---|---|---|
| 1 | **`apps/server/src/index.ts`** (baru) | Composition root gabungan: `initDb()` sekali (1 PrismaClient, WAL), reuse `buildApp()` web-admin, `buildBot()` (polling **atau** webhook via `BOT_MODE`), notifier/poller/croner in-process, `/healthz`, graceful shutdown. Export `buildServer()` murni untuk test. | ✅ |
| 2 | **`apps/server/package.json`** (baru) | Workspace baru `@app/server`. Build dipicu dari root: `pnpm run build:bundle`. | ✅ |
| 3 | **`scripts/build-bundle.ts`** (baru) | Jalankan esbuild: `platform=node`, `format=cjs`, bundling `@app/*` + source, **eksternal** untuk paket yang tak boleh di-bundle (`@prisma/client`, `.prisma/client`, `pino`, `pino-roll`, `thread-stream`, `nunjucks`). Shim `import.meta.url` + `define` `APP_BUNDLED=1` (agar entry order-bot tak auto-start dobel). Output → `dist/server.cjs`. | ✅ |
| 4 | **`package.prod.json`** (baru) | `package.json` rata berisi **hanya** dependensi runtime eksternal + `prisma` (untuk `prisma generate`) + `"postinstall": "prisma generate"` + `engines.node>=20`. Inilah yang di-upload & di-`npm install` di server. | ✅ |
| 5 | **`prisma/schema.prisma`** | **Tidak perlu di-patch.** `postinstall: prisma generate` jalan di host Linux Hostinger → `native` otomatis menghasilkan engine Linux yang benar. Hardcode `binaryTargets` Linux justru memaksa tiap mesin dev/CI mengunduh engine ekstra. | — |
| 6 | **`server.ts` + `views.ts` + `i18n.ts`** (patch) | (a) Combined entry listen `host=0.0.0.0` (override `WEB_HOST`), `port=process.env.PORT ?? WEB_PORT`. (b) `VIEWS_DIR`/`LOCALES_DIR`/`STATIC_DIR` bisa di-override via env (lihat caveat §3) agar tidak `ENOENT` setelah bundling. | ✅ |
| 7 | **`.gitignore`** | Abaikan `dist/`. | ✅ (sudah ada) |

> Selain itu: `apps/{order-bot,web-admin,notifier}/package.json` dapat
> `exports` map (subpath) agar entry gabungan bisa meng-import building block-nya
> (`buildBot`, `buildApp`, `runDispatcher`, dst.); `esbuild` ditambah ke
> devDependencies root; script `build:bundle` ditambah ke root `package.json`.
>
> Tidak ada perubahan skema DB. Aturan main `CLAUDE.md` tetap berlaku (Decimal,
> audit, no-Telegram-from-web, dll).

---

### 3. Yang di-upload ke server

Setelah `npm run build:bundle` menghasilkan `dist/server.cjs`, yang perlu naik ke
folder aplikasi Hostinger hanyalah **artefak runtime**, bukan source TS:

```
dist/server.cjs                 # hasil bundle (startup file)
package.prod.json  → package.json   (rename saat upload)
prisma/schema.prisma            # dibutuhkan `prisma generate`
prisma/migrations/              # (opsional, untuk apply migrasi)
data/bot.db (+ -wal, -shm)      # database SQLite (lihat §6; konversi IDR dulu — CUTOVER-IDR.md)
views/admin/   (file .njk admin)        # template web-admin — DIBACA dari disk
views/shop/    (file .njk storefront)   # template storefront (apps/storefront/views)
views/shared/  (_theme.njk,_macros.njk) # tema bersama (packages/web-ui/views)
locales/       (en.json,id.json)# string i18n — DIBACA dari disk saat runtime
static/        (app.css admin)  # aset statis web admin (/static/*)
static-shop/   (app.css shop)   # aset statis storefront (apps/storefront/static)
.env                            # ATAU set via UI App Manager (lebih aman)
```

> Storefront ikut dalam bundle yang sama (satu proses — plan.md §2 F). Path
> template/staticnya juga bisa di-override: `STOREFRONT_VIEWS_DIR`,
> `STOREFRONT_STATIC_DIR`, dan `SHARED_VIEWS_DIR` (tema bersama web-ui).
> Susunan folder di atas hanya saran — yang penting env menunjuk ke folder
> yang benar.

> ⚠️ **Penting — resolusi path setelah bundling.** Kode meresolusi folder ini
> secara **relatif terhadap lokasi file sumbernya** via `import.meta.url`:
> - Nunjucks: `VIEWS_DIR = <src>/../../views` ([views.ts:16-17](apps/web-admin/src/plugins/views.ts#L16-L17))
> - Locales: `LOCALES_DIR = <src>/../locales` ([i18n.ts:13-15](packages/core/src/i18n.ts#L13-L15))
> - Static: `STATIC_DIR = <src>/../static` ([server.ts:36](apps/web-admin/src/server.ts#L36))
>
> Begitu kode di-*bundle* ke `dist/server.cjs`, `import.meta.url` menunjuk ke
> `dist/`, sehingga path `../..` itu **meleset** → `ENOENT`. Karena itu salah satu
> tugas implementasi (§2 #6) adalah membuat ketiga path ini bisa di-*override*
> lewat env (`VIEWS_DIR`, `LOCALES_DIR`, `STATIC_DIR`) atau diresolusi dari satu
> root yang dapat dikonfigurasi (default `process.cwd()`). Lalu di server cukup
> taruh `views/ locales/ static/` di root aplikasi dan arahkan env-nya ke situ.
>
> Pengecualian lain: jika pakai QR pembayaran, file `BINANCE_QR_PATH` juga berkas
> di disk → upload file itu, set env-nya ke path absolut.

---

### 4. Jalur A — Punya SSH (disarankan)

1. **Lokal:** build bundle, lalu commit/siapkan artefak.
   ```bash
   pnpm install
   pnpm run build:bundle        # menghasilkan dist/server.cjs
   ```
2. **Upload** isi §3 ke folder aplikasi (mis. `~/nodeapp/`) via SFTP/Git.
   Rename `package.prod.json` → `package.json`.
3. **SSH ke server**, masuk virtualenv Node-nya (App Manager biasanya kasih
   perintah `source ~/nodevenv/.../activate`), lalu:
   ```bash
   cd ~/nodeapp
   npm install --omit=dev        # memicu postinstall → prisma generate
   npx prisma generate           # jika postinstall tidak jalan
   ```
4. (Jika DB baru) buat skema:
   ```bash
   npx prisma db push
   ```
   (Jika bawa DB lama dari stack lain, lihat catatan datetime di `RUN.md §1`.)
5. **Set startup file** = `dist/server.cjs` di UI Node App, isi **Environment
   Variables** (§7), lalu **Restart**.
6. Pasang **UptimeRobot** ke URL web (§0 caveat #4).

---

### 5. Jalur B — Hanya panel App Manager (tanpa SSH)

Semua langkah yang butuh terminal dialihkan ke mekanisme panel:

1. **Lokal:** `pnpm run build:bundle`.
2. **Upload** isi §3 lewat **File Manager** hPanel ke folder aplikasi.
   Rename `package.prod.json` → `package.json`.
3. Di UI Node App:
   - **Application root** = folder tadi.
   - **Application startup file** = `dist/server.cjs`.
   - **Node version** = 20/22.
   - Klik **Run NPM Install** → ini menjalankan `npm install` **dan** `postinstall`
     (`prisma generate`) otomatis. Inilah kenapa `prisma generate` ditaruh di
     `postinstall`: supaya jalan tanpa terminal.
4. **DB:** karena tanpa terminal, `prisma db push` tidak bisa dijalankan langsung.
   Dua opsi:
   - **(a)** Buat DB di lokal dengan `pnpm exec prisma db push`, lalu **upload
     file `data/bot.db`** ke server (cara paling gampang untuk App Manager).
   - **(b)** Tambah skrip sekali-jalan `db:push` di `package.json` dan picu lewat
     fitur **"Run JS script"/NPM script** kalau panel menyediakannya.
   → Rekomendasi App Manager: **opsi (a)**.
5. Isi **Environment Variables** (§7) di UI, **Restart**.
6. Pasang **UptimeRobot** ke URL web.

---

### 6. Database (SQLite) di App Manager

- **Lokasi:** taruh `bot.db` di dalam folder aplikasi, mis. `~/nodeapp/data/bot.db`,
  dan set `DATABASE_URL_PRISMA` ke **path absolut**:
  ```
  DATABASE_URL_PRISMA=file:/home/USER/nodeapp/data/bot.db
  ```
  (Path relatif `file:./data/bot.db` rawan ambigu — pakai absolut, sama seperti
  pesan di `RUN.md §0`.)
- **WAL & locking:** project pakai WAL. Di filesystem shared hosting, WAL umumnya
  OK selama hanya **satu proses** yang menulis (dan kita memang satu proses).
  Jangan menjalankan dua instance aplikasi terhadap file yang sama.
- **Backup:** unduh berkala `data/bot.db` (+`-wal`/`-shm`) via File Manager,
  sama semangatnya dengan `RUN.md §4`.

---

### 7. Environment Variables

Isi via **UI App Manager** (lebih aman daripada upload `.env`; jangan commit
rahasia). Kunci minimum (detail lengkap di `README.md` → Configuration):

**Wajib**
```
DATABASE_URL_PRISMA=file:/home/USER/nodeapp/data/bot.db
BOT_TOKEN=...        # bootstrap saja — setelah live, token dikelola di web-admin
BOT_USERNAME=...     # opsional — diisi otomatis via getMe / web-admin
ADMIN_IDS=12345678,9876543
WEB_COOKIE_SECRET=<min 32 karакter acak>
TIMEZONE=Asia/Jakarta
CURRENCY=USDT
DEFAULT_LANGUAGE=id
```

> **Token bot kini bisa dikelola di web-admin** (Settings → Bot & notifications,
> plan.md §16): nilai di DB **menang** atas env; env tinggal jalur bootstrap /
> pemulihan. Ganti token di web → divalidasi `getMe` dulu → **restart** app
> (sentuh `tmp/restart.txt` atau tombol Restart panel) agar berlaku.

**Storefront (toko pelanggan — satu proses yang sama)**
```
SHOP_PUBLIC_URL=https://shop.domainkamu.com   # set ⇒ satu listener, dipisah per Host
                                              # (host ini → toko; host lain → admin+webhook)
# tanpa SHOP_PUBLIC_URL: toko listen di port terpisah STOREFRONT_PORT (default 8100)
```
**Notifier (kalau dipakai)**
```
NOTIF_BOT_TOKEN=...               # atau isi notif_bot_token di web-admin Settings
PUBLIC_CHANNEL_ID=-100xxxxxxxxxx
```
**Pembayaran Binance (sesuai metode yang dipakai)**
```
BINANCE_PAY_ID=...
BINANCE_RECEIVE_UID=...
BINANCE_API_KEY=...        # hanya jika pakai auto-confirm internal transfer
BINANCE_API_SECRET=...
```
**Transport bot (pilih salah satu)**
```
# Opsi A — paling simpel, tanpa domain untuk bot:
BOT_MODE=polling

# Opsi B — webhook (bot jadi route di Fastify yang sama):
BOT_MODE=webhook
PUBLIC_URL=https://<domain-app-kamu>      # tanpa trailing slash
WEBHOOK_SECRET=<string acak panjang>       # dipakai sbg path /tg/<secret> + secret_token
```

**Web/port** — *jangan* set `WEB_PORT` manual; Passenger menyuntik `PORT` sendiri.
Server listen ke `process.env.PORT` (di mode webhook bind `0.0.0.0`).

> Jangan pernah men-*log* token/secret (aturan `CLAUDE.md`). Set lewat UI, bukan
> di file yang ter-commit.

---

### 8. Verifikasi setelah Restart

1. Buka `https://<domain-web>/login` → harus tampil 200 (halaman login).
2. Chat bot di Telegram `/start` → harus membalas. (Jika tidak, cek caveat idle §0
   #4 dan log aplikasi di panel.)
3. Coba satu alur: lihat katalog → Buy Now. Pastikan tidak ada error.
4. Cek **log** di UI App Manager (atau `~/nodeapp/logs` / stderr Passenger) untuk
   baris pino. Waspadai `P2022`/`P2023` (masalah DB) atau `ENOENT` (path views/
   locales salah).

---

### 9. Masalah umum & solusi cepat

| Gejala | Penyebab | Solusi |
|---|---|---|
| `Cannot find module '@app/core'` | bundle tidak meng-inline internal | pastikan build pakai `scripts/build-bundle.ts`, bukan upload source TS |
| `PrismaClientInitializationError` / engine mismatch | client di-generate di OS lain (mis. di-upload dari Windows) | jalankan `prisma generate` **di host** (lewat `npm install`/postinstall), jangan upload `node_modules`. Kalau terpaksa generate lokal, tambah `binaryTargets` Linux yang sesuai lalu generate ulang |
| `P2023` saat query | DB lama dari stack Python belum dikonversi datetime | lihat `RUN.md §1` (konversi datetime) |
| Web 503 / app gagal start | startup file salah / Node < 20 | set startup `dist/server.cjs`, Node 20/22, cek log |
| Bot kadang mati lalu hidup saat web dibuka | Passenger idle (caveat §0 #4) | pasang UptimeRobot ping web tiap 1–5 menit |
| `ENOENT .../views/*.njk` atau `locales/*.json` | resolusi path meleset setelah bundling | upload `views/ locales/ static/`, set env `VIEWS_DIR/LOCALES_DIR/STATIC_DIR` (§2 #6, §3) |
| `ENOENT` QR/file pembayaran | `BINANCE_QR_PATH` menunjuk path yang tak ada di server | upload file QR, set env ke path absolut |

---

### 10. Kapan sebaiknya pindah ke VPS

App Manager bisa, tapi titik lemahnya: idle-shutdown (butuh ping), tidak ada
proses worker sejati, dan tuning terbatas. Pertimbangkan **Hostinger VPS** bila:
- bot sering dilaporkan "telat/mati", atau
- butuh ≥2 penulis DB / pindah ke Postgres (`RUN.md §9`), atau
- mau deploy apa adanya via Docker (`RUN.md`) tanpa bundling.

---

### Status

- [x] Panduan ditulis (dokumen ini).
- [x] Implementasi kode §2 (#1–#7) — **selesai** (typecheck & test hijau).
- [x] Build bundle & uji lokal — `pnpm run build:bundle` → `dist/server.cjs`
      (3.5mb), smoke-test `node dist/server.cjs` load bersih (semua `@app/*`
      ter-inline, eksternal tetap `require`, `import.meta.url` ter-shim).
- [ ] Deploy ke Hostinger + UptimeRobot — **langkah manual kamu** (Jalur A/B §4–5).

---

## Bagian 5 — Setup & konfigurasi env lengkap (untuk pembeli)

> Panduan ini untuk **pembeli script** yang memasang sendiri dengan **bot Telegram
> miliknya** (dibuat di BotFather). Semua konfigurasi lewat file **`.env`** (salin
> dari [`.env.example`](.env.example)) + sebagian lewat **web-admin → Settings**.
> Tujuannya: **semua fitur menyala maksimal**. Acuan kebenaran: `packages/core/src/config.ts`.

### 5.0 Setup lewat wizard (tanpa edit `.env`) — cara default sekarang

Pada instalasi **baru** (belum ada admin yang punya password), kamu **tidak perlu
mengedit `.env`** untuk login pertama. Setelah file ter-upload dan app jalan,
cukup buka panel admin di browser (`http(s)://<host-admin>/`) — kamu **otomatis
diarahkan ke `/setup`** dan dipandu **tiga langkah**:

1. **Bot token** — tempel token dari **@BotFather**. Boleh juga klik **"Atur
   nanti"** untuk lewati (token bisa diisi nanti via Settings).
2. **Owner admin** — isi **Telegram ID**-mu (lihat di **@userinfobot**) + **password
   login** (minimal 8 karakter). ID ini jadi **owner/admin pertama**.
3. **Identitas toko** — nama toko / tagline. **Opsional** (semua punya default,
   boleh dilewati).

Saat **Selesai**: kamu **otomatis login**. Jika token bot tadi diisi, ada tombol
**"Nyalakan bot sekarang"** yang menulis `tmp/restart.txt` (best-effort) supaya app
me-reboot dan bot menyala. Bila tombol gagal, pakai tombol **Restart** di panel
hosting.

Catatan:
- **Selama setup belum selesai**, storefront menampilkan halaman **"Toko belum
  aktif"** (503). Setelah Selesai, **wizard terkunci permanen** dan tak bisa
  diakses lagi.
- **`WEB_COOKIE_SECRET` boleh dikosongkan** — kalau kosong, di-generate otomatis
  & disimpan saat boot. **`BINANCE_PAY_ID` juga boleh kosong** (= Binance Pay
  manual tidak aktif).
- **Deploy lama / jalur manual**: `/bootstrap` (§5.4) tetap ada sebagai cara
  kompatibel. Wizard hanya muncul pada instalasi baru (belum ada admin
  berpassword).

### 5.1 Konsep: `.env` vs web-admin Settings
- **`.env`** dibaca **saat boot** — ganti nilai = **harus restart** aplikasi.
- **Settings (web-admin)** dibaca **runtime** — kebanyakan **langsung berlaku
  tanpa restart** (kecuali token bot). Bila sebuah nilai ada di **dua** tempat,
  **Settings (DB) menang**, `.env` jadi cadangan/pemulihan.

### 5.2 Cara mendapatkan nilai penting
| Nilai | Cara dapat |
|---|---|
| `BOT_TOKEN` | BotFather → `/newbot` (atau `/mybots` → API Token). |
| `BOT_USERNAME` | Username bot (mis. `TokoSaya_bot`). Opsional — terisi otomatis via `getMe`. |
| `ADMIN_IDS` | **Angka** Telegram ID-mu (bukan username). Kirim pesan ke **@userinfobot** untuk melihatnya. Banyak admin → pisah koma: `111,222`. |
| `WEB_COOKIE_SECRET` | Minimal 32 karakter acak. `openssl rand -hex 32`, atau ketik asal ≥32 huruf/angka. **Rahasia.** |
| `BINANCE_PAY_ID` | **Opsional** — boleh dikosongkan (= Binance Pay manual tidak aktif). App tetap boot. |

### 5.3 Env minimum agar app + login admin jalan
```
BOT_TOKEN=123456:token-dari-botfather
BOT_USERNAME=TokoSaya_bot
ADMIN_IDS=123456789
BINANCE_PAY_ID=0
WEB_COOKIE_SECRET=ganti-jadi-acak-minimal-32-karakter-xxxxxx
TIMEZONE=Asia/Jakarta
DEFAULT_LANGUAGE=id
```
`DATABASE_URL_PRISMA` sudah punya default (`file:../data/bot.db`) — tak perlu diisi
kecuali kamu pindah lokasi DB (di Hostinger pakai path absolut — Bagian 4 §6).

### 5.4 Urutan boot & LOGIN PERTAMA (jalur manual / deploy lama)

> Pada instalasi **baru**, pakai **wizard `/setup`** (§5.0) — lebih mudah, tanpa
> `/start` atau edit `.env`. Langkah di bawah adalah jalur **manual `/bootstrap`**
> yang tetap berlaku untuk **deploy lama** atau bila kamu ingin mengontrol penuh.

1. Isi `.env` minimum (§5.3) dan siapkan DB (`prisma db push`, atau upload
   `data/bot.db` kosong yang sudah dibuat — Bagian 4 §5).
2. **Jalankan app** → bot menyala (mode polling).
3. **Buka bot-mu di Telegram, ketik `/start`.** Ini **membuat baris admin** di DB
   dan otomatis menaikkan role ke **ADMIN** karena ID-mu ada di `ADMIN_IDS`.
   **Langkah ini wajib** — login web butuh baris admin ini.
4. Buka web **`/bootstrap`** → set **password** untuk Telegram ID itu (halaman ini
   terbuka selama belum ada admin yang punya password).
5. Buka **`/login`** → masuk dengan Telegram ID + password.
6. *(Opsional)* Pindahkan token bot ke **Settings → Bot & notifications** (DB
   menang atas env), lalu **restart** agar berlaku.

> **Lupa `/start` dulu?** Login akan gagal `no_account`. Jalan darurat tanpa bot:
> `pnpm reset-admin-password <telegram_id> --set <password>` (tetap butuh ID ada
> di `ADMIN_IDS`).

### 5.5 Menyalakan tiap fitur (checklist)
| Fitur | Yang diisi | Catatan |
|---|---|---|
| **Bot order (inti)** | `BOT_TOKEN`, `ADMIN_IDS` | Ganti token → restart. |
| **Toko web (storefront)** | `SHOP_HOST` (1 port, host toko) **atau** `STOREFRONT_PORT` (port terpisah); `SHOP_PUBLIC_URL` untuk link di DM | Lihat Bagian 4 / §5.1. |
| **Transport bot** | `BOT_MODE=polling` (default) **atau** `webhook` + `PUBLIC_URL` + `WEBHOOK_SECRET` | Webhook butuh domain HTTPS. |
| **Channel testimoni** | `PUBLIC_CHANNEL_ID` (+ `NOTIF_BOT_TOKEN` opsional) | Bot harus jadi **admin** di channel. Kosongkan ID = fitur mati. |
| **Bayar Binance Pay (manual + bukti)** | `BINANCE_PAY_ID` (+ `BINANCE_QR_PATH` opsional) | Admin approve manual di bot. |
| **Bayar Binance Internal (USDT, auto)** | `BINANCE_RECEIVE_UID` + `BINANCE_API_KEY` + `BINANCE_API_SECRET` | Aktif **hanya bila ketiganya terisi**. API key **READ-ONLY**. Tes: `pnpm binance-probe`. |
| **Bayar Bybit USDT-BEP20 (auto)** | `bybit_deposit_address` + `bybit_api_key` + `bybit_api_secret` di **Settings** (atau `BYBIT_*` di env) | BEP20 tanpa memo → cocok via **nominal unik**, jaga `USE_UNIQUE_CENTS=1`. API key Wallet **read-only**. Tes: `pnpm bybit-probe`. |
| **Bayar QRIS Rupiah (TokoPay)** | `tokopay_merchant_id` + `tokopay_secret` + `tokopay_enabled=true` di **Settings** | Hanya di web-admin Settings (bukan env). |
| **Kurs USDT↔IDR** | `usd_idr_rate` di **Settings** (auto-update pasar ON secara default) | Matikan auto: `usd_idr_rate_auto=false`. |
| **Lupa password toko (email)** | `SMTP_HOST` + `SMTP_FROM` (+ `SMTP_USER`/`SMTP_PASS`) | Aktif hanya bila host & from terisi. |

### 5.6 Mana yang butuh restart vs langsung berlaku
- **Perlu restart**: semua nilai `.env`, dan **token bot/notifier** (walau diubah
  di Settings).
- **Langsung (hot, tanpa restart)**: `tokopay_*`, `bybit_*`, `usd_idr_rate`, dan
  setelan web-admin lain.

### 5.7 Checklist "semua fitur maksimal"
- [ ] `.env` minimum terisi (§5.3) + DB siap.
- [ ] `/start` bot → `/bootstrap` → bisa `/login` (§5.4).
- [ ] Storefront tampil (host/port benar) + `SHOP_PUBLIC_URL` di-set.
- [ ] Channel testimoni jalan (`PUBLIC_CHANNEL_ID`, bot admin channel).
- [ ] Minimal satu metode bayar otomatis aktif (Binance Internal / Bybit / TokoPay).
- [ ] Kurs `usd_idr_rate` terisi (harga IDR + USDT tampil bersisian).
- [ ] (Opsional) SMTP untuk lupa-password toko.
- [ ] Produksi: `WEB_COOKIE_SECURE=true` di balik HTTPS + UptimeRobot (Bagian 4 §0).
