# Dokumentasi Proyek — `telegram-order-bot`

> Dokumen gabungan: **rencana** & **desain** storefront, dan **cutover** harga
> USDT→IDR. Sebelumnya terpisah di `plan.md`, `design.md`, `CUTOVER-IDR.md` —
> kini satu file agar tidak berserakan. Konvensi koding tetap di
> [`CLAUDE.md`](CLAUDE.md), panduan instalasi (VPS) di [`README.md`](README.md).

## Daftar isi

- [Status & implementasi nyata (Juni 2026)](#status--implementasi-nyata-juni-2026)
- [Bagian 1 — Rencana Storefront (Arsitektur & Rencana)](#bagian-1--rencana-storefront-arsitektur--rencana)
- [Bagian 2 — Desain Storefront (Spesifikasi Visual)](#bagian-2--desain-storefront-spesifikasi-visual)
- [Bagian 3 — Cutover Harga USDT → IDR (Runbook)](#bagian-3--cutover-harga-usdt--idr-runbook)
- [Bagian 5 — Setup & konfigurasi env lengkap (untuk pembeli)](#bagian-5--setup--konfigurasi-env-lengkap-untuk-pembeli)

---

## Status & implementasi nyata (Juni 2026)

> **Bagian 1–3 di bawah ini adalah dokumen perencanaan asli** (ditulis sebelum
> kode dibuat) — disimpan sebagai catatan keputusan & rasional. **Storefront kini
> SUDAH dibangun penuh** dan berjalan di `apps/storefront`, jadi beberapa "how"
> berbeda dari rencana. Bagian ini adalah **sumber kebenaran terkini**; bila
> bertentangan dengan Bagian 1–3, **ikuti bagian ini**.

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
  token bot kosong (bot OFF sampai diisi + restart).

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
kecuali kamu pindah lokasi DB (di dalam container Docker pakai path absolut, mis.
`file:/app/data/bot.db`).

### 5.4 Urutan boot & LOGIN PERTAMA (jalur manual / deploy lama)

> Pada instalasi **baru**, pakai **wizard `/setup`** (§5.0) — lebih mudah, tanpa
> `/start` atau edit `.env`. Langkah di bawah adalah jalur **manual `/bootstrap`**
> yang tetap berlaku untuk **deploy lama** atau bila kamu ingin mengontrol penuh.

1. Isi `.env` minimum (§5.3) dan siapkan DB (`prisma db push`).
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
| **Toko web (storefront)** | `SHOP_HOST` (1 port, host toko) **atau** `STOREFRONT_PORT` (port terpisah); `SHOP_PUBLIC_URL` untuk link di DM | Lihat [`README.md`](README.md) (Jalur A/B). |
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
- [ ] Produksi: `WEB_COOKIE_SECURE=true` di balik HTTPS (reverse proxy).
