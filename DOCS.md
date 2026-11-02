# Dokumentasi Teknis — `telegram-order-bot`

Arsitektur, fitur, dan setup environment proyek. Panduan instalasi (VPS) ada
di [`README.md`](README.md), tutorial migrasi database di
[`docs/MIGRATIONS.md`](docs/MIGRATIONS.md), indeks seluruh dokumentasi di
[`docs/README.md`](docs/README.md), dan konvensi koding di
[`.claude/CLAUDE.md`](.claude/CLAUDE.md).

## Daftar Isi

1. [Arsitektur](#1-arsitektur)
2. [Autentikasi pelanggan](#2-autentikasi-pelanggan)
3. [Katalog, gambar produk & branding](#3-katalog-gambar-produk--branding)
4. [Harga: IDR pusat + USDT turunan](#4-harga-idr-pusat--usdt-turunan)
5. [Pembayaran](#5-pembayaran)
6. [Settings vs `.env`](#6-settings-vs-env)
7. [Manajemen stok](#7-manajemen-stok)
8. [Credit balance (IDR + USDT)](#8-credit-balance-idr--usdt)
9. [Program referral](#9-program-referral)
10. [Tiket dukungan (support)](#10-tiket-dukungan-support)
11. [Ulasan & rating produk](#11-ulasan--rating-produk)
12. [Langganan restock](#12-langganan-restock)
13. [Desain storefront](#13-desain-storefront)
14. [Setup env & checklist fitur](#14-setup-env--checklist-fitur)
15. [Banyak toko dalam satu VPS](#15-banyak-toko-dalam-satu-vps)
16. [API & Webhook](#16-api--webhook)

---

## 1. Arsitektur

Monorepo pnpm: empat workspace `apps/*` + tiga `packages/*`, berbagi **satu
database PostgreSQL** (schema `public`; lihat `docs/MIGRATIONS.md` dan
`deploy/backup/README.md` untuk deploy produksi).

Bagian ini adalah peta singkat. Diagram proses, boundary, alur order, dan
referensi arsitektur terperinci ada di
[`docs/arsitektur/ARCHITECTURE.md`](docs/arsitektur/ARCHITECTURE.md); indeks
referensi per-domain ada di [`docs/README.md`](docs/README.md).

| Workspace | Peran |
|---|---|
| `apps/order-bot` | Bot Telegram grammY (alur pelanggan + admin) |
| `apps/web-admin` | Panel admin — Fastify JSON API di belakang React SPA (`apps/web-admin/client`) |
| `apps/storefront` | Toko web pelanggan — Fastify + JSON API (`/api/v1`) di belakang React SPA (`apps/storefront/client`); tidak ada sisa Nunjucks — halaman error/setup-pending juga dilayani lewat SPA shell (`apps/storefront/src/lib/spaFallback.ts`), dengan fallback HTML tulisan tangan hanya jika build SPA belum ada |
| `apps/server` | **Composition root satu-proses**: gabung admin + storefront + bot + worker dengan **satu PrismaClient** (`apps/server/src/index.ts`) |
| `packages/core` | Config (zod), money (Decimal), datetime (luxon), i18n, password, mailer, fx |
| `packages/db` | Prisma client + semua CRUD (`packages/db/src/crud/*`) |
| `packages/outbox-dispatcher` | Drain `notification_outbox` → channel/DM (`runDispatcher`, jalan in-process di `apps/server`) |

**Prinsip inti:**

- **Satu sumber data.** Storefront & bot memakai DB + CRUD yang sama, jadi stok
  dan harga otomatis sinkron. Tidak ada SQL mentah di route — semua lewat
  `packages/db/src/crud/*`.
- **Decimal untuk semua uang** (`@app/core/money`), tidak pernah `float`.
- **Web tak pernah kirim Telegram** — enqueue ke `notification_outbox`, dispatcher
  outbox (`@app/outbox-dispatcher`, in-process di `apps/server`) yang mengirim.
- **PostgreSQL menangani konkurensi sendiri** — tiap `$transaction` tetap
  dijaga pendek sebagai praktik baik.
- **Katalog 3-tier: Category → Product → Denomination.** `Product` (mis.
  "Netflix") adalah satu-satunya kartu di grid (home, kategori `/c/:slug`,
  search) — TIDAK punya harga/stok sendiri. Tiap Product punya satu/lebih
  `Denomination` (mis. "1 bulan" / "1 tahun") yang menyimpan harga, stok, dan
  auto-delivery; dipilih di halaman detail produk `/p/:slug`. Satu shaper
  bersama `shapeProducts` (`apps/storefront/src/cards.ts`) membentuk kartu grid
  dari denominasi aktif termurah ("starting price") + agregat stok/rating
  lintas denominasi.
- **Tidak ada API publik untuk konsumsi pihak ketiga.** Storefront dan admin
  masing-masing React SPA yang dilayani lewat JSON API internal (`/api/v1/*`
  storefront, `/api/*` admin, lihat §16) — bukan kontrak stabil untuk klien
  luar, hanya untuk `client/` masing-masing app. Satu-satunya endpoint
  non-HTML untuk pihak ketiga adalah webhook (`/pay/{tokopay,
  paydisini,nowpayments}/callback`, `/tg/<secret>` saat `BOT_MODE=webhook`) dan
  `/healthz` — daftar lengkap + kontrak request/respons di §16. Integrasi =
  lewat DB/CRUD, bukan HTTP.

**Topologi listen** (`apps/server/src/index.ts`):

- `SHOP_PUBLIC_URL` di-set → **satu listener publik**; request ke host toko →
  storefront, sisanya (admin, webhook `/tg`, health) → admin.
- Tidak di-set → admin di `WEB_PORT`, storefront di `STOREFRONT_PORT` (8100).

`BOT_MODE` (`polling` | `webhook`) memilih transport bot. Web tetap jalan walau
token bot kosong (bot OFF sampai diisi + restart).

> Pada deploy Docker (README Jalur A), satu container `server` menjalankan
> `apps/server` sebagai proses gabungan, berdampingan dengan satu container
> PostgreSQL. Pada Jalur B, proses gabungan yang sama dijalankan langsung lewat
> `pnpm start`.

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
JSON routes `apps/storefront/src/routes/apiAuth.ts` (login/register/logout/
forgot/reset) + `src/routes/auth.ts` (the Telegram Login Widget's server-side
`GET /auth/telegram` callback, which redirects the whole page instead of an
XHR), consumed by the React pages under `apps/storefront/client/src/pages/`,
`packages/core/src/{password,mailer}.ts`.

---

## 3. Katalog, gambar produk & branding

**Gambar produk** diurutkan: `Product.webImageUrl` (upload admin) → peta Unsplash
per kategori (`apps/storefront/src/images.ts`) → placeholder. Admin meng-upload
foto lewat web-admin; file disimpan di **`data/uploads/`** dan disajikan storefront
sebagai statis `GET /uploads/*` (env `UPLOADS_DIR`, default `data/uploads`).

**Branding** — halaman **web-admin → Settings → Branding**
(`apps/web-admin/src/routes/branding.ts`, endpoint JSON/multipart
`POST /branding/*`) meng-upload ke
**`data/uploads/branding/`** (nama file di-hash, anti traversal):

| Aset | Setting | Dipakai |
|---|---|---|
| Favicon (PNG/ICO/SVG) | `web_favicon_url` | tiap halaman storefront (fallback `/static/favicon.svg`) |
| Logo header (PNG/SVG/WebP) | `web_logo_url` | header toko (kosong → ikon `store`) |
| Hero (JPG/PNG/WebP) | `web_hero_url` | beranda toko (fallback: gradient warna brand, tanpa foto) |
| Banner bot | `banner_image` | atas menu utama & daftar produk di bot |

Identitas toko `shop_name`, `shop_tagline`, `welcome` juga diedit di sini. Semua
langsung berlaku tanpa restart. Folder `/uploads/` di kedua app mengirim header
`X-Content-Type-Options: nosniff` + CSP ketat agar SVG yang di-upload inert.

Banner bot dikirim sebagai `InputFile` lalu file_id Telegram-nya di-cache
(`banner_image_fileid`); cache di-invalidasi saat banner di-set/hapus.

**Foto produk di bot (chat bubble).** Layar denomination picker (`browseProduct`)
dan detail SKU (`browseDenomination`) kini merender foto produk itu sendiri
(`Product.webImageUrl`) sebagai bubble foto+caption, bukan hanya banner generik
toko — `productPhotoArg`/`cacheProductPhotoFileId`
(`apps/order-bot/src/util/productPhoto.ts`) meng-cache file_id yang di-resolve
ke kolom `Product.imageFileId` setelah pengiriman pertama, mengikuti pola cache
banner di atas. Produk tanpa foto tetap jatuh ke perilaku lama (banner/teks
biasa).

**Custom emoji Telegram (ikon animasi di dalam pesan bot).** Setting
`custom_emoji_map` menyimpan JSON `{"✅": "5368324170671202286"}` — emoji unicode
sebagai kunci, id sticker custom emoji sebagai nilai. Transformer API bersama
(`apps/order-bot/src/util/apiDefaults.ts`) membungkus setiap emoji yang dipetakan
menjadi `<tg-emoji emoji-id="…">✅</tg-emoji>` pada `text`/`caption` yang dikirim
mode HTML, jadi ratusan string di `packages/core/locales/*.json` tidak perlu
diubah; peta kosong = tampilan persis seperti sebelumnya. Isi teks di dalam
`<pre>`/`<code>` sengaja dilewati (entity tak boleh bersarang di sana, dan isinya
memang untuk disalin).

- **Syarat Telegram:** bot hanya boleh mengirim entity custom emoji bila punya
  username beli-an Fragment, **atau** — untuk pesan langsung ke chat
  privat/grup/supergrup — bila pemilik bot berlangganan Premium. **Post ke
  channel tidak tercakup jalur Premium**: kalau Telegram menolak, transformer
  mengirim ulang sekali dengan emoji biasa (satu baris log warn) agar pesan
  tetap sampai.
- **Teks tombol inline keyboard tidak mendukung entity sama sekali** — emoji di
  tombol selalu unicode biasa.
- **Cara dapat id-nya:** dari akun Premium, kirim `/emojiid <emoji>` ke bot (atau
  balas pesan yang memuatnya); bot membalas JSON siap tempel ke Settings.
  Perubahan Settings langsung berlaku tanpa restart (satu proses `apps/server`).

---

## 4. Harga: IDR pusat + USDT turunan

**Rupiah adalah sumber kebenaran harga.** `Denomination.price` / `resellerPrice`
(bukan `Product` — mid-tier itu tidak punya kolom harga) dalam IDR. USDT
diturunkan: `idrPrice / usd_idr_rate`, dibulatkan ke 0,1, dan **tampil
bersisian** dengan IDR di storefront dan bot (mis. `Rp79.000 ≈ $4,9`). Tidak ada
deteksi IP atau preferensi mata uang per-user — mata uang transaksi dipilih **saat
bayar** (IDR → TokoPay/PayDisini; USDT → NOWPayments/Binance Internal/
Bybit Internal Transfer/Bybit BSC).

`usd_idr_rate` **auto-update dari pasar** (`scheduleFxRefresh`,
`packages/core/src/fx.ts`), dibulatkan ke kelipatan `usd_idr_rate_rounding`
(default Rp100). Matikan dengan `usd_idr_rate_auto=false` lalu set manual. Bila
`usd_idr_rate` kosong, info USDT disembunyikan tapi checkout IDR tetap jalan.

Tiap order menyimpan snapshot: `Order.currency` (`IDR`/`USDT`), `Order.fxRate`
(kurs saat USDT), `Order.paymentMethod`, `Order.paymentRef`. Order lama tak diubah.

---

## 5. Pembayaran

**Enam metode auto-confirm, tersedia di bot & storefront saat dikonfigurasi:**

| Metode | Mata uang | Mekanisme | Kelola |
|---|---|---|---|
| **Binance Internal** (UID + nominal unik) | USDT | poller auto-confirm (`payments/binanceInternal`) | env / Settings |
| **TokoPay (QRIS)** | IDR | webhook `POST /pay/tokopay/callback` (verifikasi signature + idempoten `ProcessedTokopayTx`) | Settings |
| **PayDisini (QRIS/e-wallet)** | IDR | webhook `POST /pay/paydisini/callback` + reconcile poller fallback; idempoten `ProcessedPaydisiniTx` | Settings |
| **NOWPayments (hosted invoice)** | USDT | IPN webhook `POST /pay/nowpayments/callback` (HMAC-SHA512, header `x-nowpayments-sig`) + reconcile poller fallback; idempoten `ProcessedNowpaymentsTx` | Settings |
| **Bybit Internal Transfer** (UID-based, instant off-chain) | USDT | poller cocokkan **nominal unik**; tak cocok → "unmatched" untuk review; idempoten `processed_bybit_tx` | Settings |
| **Bybit BSC** (on-chain BEP20) | USDT | poller deposit Bybit cocokkan **nominal unik** setelah status sukses on-chain, dengan filter jaringan/alamat; ledger `ProcessedBybitTx` | Settings |

Kontrak webhook + reconcile poller ketiga gateway IDR/USDT di atas (TokoPay,
PayDisini, NOWPayments) didokumentasikan lengkap di **§16**.

Klien TokoPay & PayDisini ada di `@app/core/payments/{tokopay,paydisini}`,
NOWPayments di `@app/core/payments/nowpayments` (resolver `getTokopayCreds` /
`getPaydisiniCreds` / `getNowpaymentsCreds` di `@app/db`), dipakai storefront
dan bot. Bot menggambar QR di dalam Telegram untuk TokoPay & PayDisini
(`buyNowTokopay` / `buyNowPaydisini`, callback `payq`); NOWPayments membuka
tautan hosted invoice (`buyNowNowpayments`) karena pembayarannya di luar
Telegram.

**Storefront:** pembeli pilih metode saat bayar
(`apps/storefront/src/routes/checkout.ts`). Status di halaman bayar (React
PayPage) via polling JSON `GET /api/v1/orders/:code/status` ~5 dtk; saat
`DELIVERED` redirect ke kredensial. Web **tanpa upload bukti** dan **tanpa
wallet**.

**QRIS/e-wallet butuh Callback URL publik** di dashboard merchant —
TokoPay (`https://<host>/pay/tokopay/callback`) dan PayDisini
(`https://<host>/pay/paydisini/callback`) — tanpa itu order mentok sampai
jendela bayar habis. NOWPayments **tidak perlu** didaftarkan manual: callback
URL dikirim otomatis per-invoice (`ipn_callback_url`). Binance & Bybit (poller)
tak terpengaruh sama sekali.

**Binance Pay manual** (upload bukti, approve manual di bot) sudah
**dipensiunkan** — `checkout.ts:9` eksplisit: *"the legacy manual Binance-Pay
proof/verification path is retired"*, dan `orderConfirmKb` tidak lagi
menampilkan tombol untuk memilihnya (dikonfirmasi test `payment-menu.test.ts:40`,
*"manual fallback retired"*). `BINANCE_PAY` kini murni label read-only pada
order lama yang dibuat sebelum dipensiunkan — tidak ada jalur aktif untuk
order baru.

Menu bayar: **QRIS / PayDisini / NOWPayments / Binance / Bybit Internal / Bybit BSC**. Tes koneksi
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
- **Custom emoji:** `custom_emoji_map` (JSON emoji → id, divalidasi saat simpan;
  langsung berlaku — lihat §3).

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

### Alur katalog Game Top-up (selalu aktif)

Untuk Game Top-up saja (dipilih lewat `category.group`, bukan nama produk), bot
selalu menampilkan akhiran harga huruf kecil pada daftar produk (`from <harga>` di bahasa Inggris, `mulai <harga>` di bahasa Indonesia; kunci `browse.product_from_price`), satu baris hint
`hint.*` per layar (daftar game, edisi, region, paket, search), dan `/search`
(berperingkat, label layanan, halaman, "Search again"; alias dari tabel
`detection_aliases` yang bawaannya **kosong**). `/search` hanya mengembalikan
produk Game Top-up. Urutan langkah navigasi (edisi, region, daftar produk) tidak
berubah, kecuali level Region yang dilewati pada scope campuran (lihat "Guard scope campuran di bot" di bawah). Tidak ada saklar di Settings dan tidak ada perubahan skema. Storefront
tidak terpengaruh. Premium Apps tidak pernah terpengaruh: tidak ada `From`,
hint, atau perubahan lain pada daftar, picker, dan layar SKU-nya.

**Cara memilih: tombol inline, bukan angka (kecuali Premium Apps).** Gaya pilih
tiap layanan diatur di satu tempat, `listSelection` pada entri registri
`packages/core/src/services.ts` (`"numbered"` hanya untuk Premium Apps; layanan
tanpa isian ini, termasuk layanan baru, mendapat `"inline"`), dibaca lewat
`usesNumberedSelection(group)`. Game Top-up: daftar produk berupa tombol inline
per produk + Prev/Next + ← Kembali, picker edisi/region juga inline, tanpa pesan
pendamping "Gunakan angka..." dan tanpa keyboard bawah angka; angka yang
diketik di layar katalog Game tidak menambah pesan: layar yang sama diedit di
tempat (tombolnya tetap) dengan baris `browse.use_buttons` di atasnya, dan angka
yang diketik dihapus; di luar katalog (Home, Pesanan, Dompet) angka tetap
berjalan seperti sebelumnya. Premium Apps = grup `PREMIUM_APPS` atau grup
kosong/tidak terdaftar (`serviceForCategoryGroup`); layanan terdaftar lain
memakai `listSelection` registrinya (default inline). Premium Apps
tetap bernomor. Cara menambah layanan baru (mis. Steam Wallet): lihat
`.claude/skills/bot-ux-grammy/SKILL.md`, bagian "How to add a new service".

**Struktur level katalog Game Top-up.** Tidak ada level Server terpisah: pada data
Digiflazz region = server (satu level: Global, Malaysia, Indonesia, Brazil, ...).
Hirarkinya Edisi (`Product.gameVariant`) → Region (`Product.gameRegion`) → paket.
Edisi dipisah dari `type` Digiflazz (mis. Arena Breakout vs Arena Breakout
Infinite). Dua game bernama sama tetapi berbeda akhiran publisher/distribusi
tetap dua `Product` terpisah dan **tidak pernah digabung**.

**Tingkat game.** Kategori Game Top-up yang berisi beberapa game (≥ 2 game dan
ada yang bisa dipilih di dalam game: produk lebih dari satu, edisi, atau region —
seperti katalog import Digiflazz yang menaruh semua game dalam satu kategori)
menampilkan daftar game lebih dulu, lalu edisi dan region **per game**.
Game/edisi/region diturunkan saat dibaca (`deriveGameIdentity`,
`packages/core/src/gameIdentity.ts`; nilai admin menang), tanpa menulis data.
Pemilih edisi/region tingkat kategori hanya untuk kategori satu game, dan juga
memakai identitas turunan (negara di `type` = region, bukan edisi).
Detail: `docs/game-topup-refactor-phase1-design.md` §2.1.

**Isi region otomatis saat import Digiflazz.** Saat admin mengimpor brand
(Settings → Digiflazz sync → apply), `Product.gameRegion` diisi dari akhiran
region grup di price list lewat `gameRegionLabel`, dengan syarat:

- **Hanya saat Product dibuat (create-only).** Product yang sudah ada tidak
  disentuh; nilai yang diisi/diubah admin selalu menang.
- **Hanya kategori Game Top-up** (`category.group = GAME_TOPUP`). Premium Apps dan
  kategori tanpa grup tidak pernah dapat region dari import.
- **Hanya akhiran yang ada di tabel putih** `packages/core/src/regionLabel.ts`
  (Indonesia, Malaysia, Singapore, Filipina, Russia, Brazil, Global; label berisi
  emoji bendera). Tabel ini **DRAFT** untuk dikoreksi pemilik; singkatan
  `id`/`sg`/`my` adalah asumsi. **Menambah negara = menambah satu baris** di tabel
  itu (token + label; label harus muat satu tombol sempit). Kata publisher
  (mis. Garena, Activision) tidak pernah menjadi label: region dibiarkan kosong
  untuk diisi admin.

Respons `/sync/apply` memuat `regions[]` (sejajar dengan `brands`): `written`
(true hanya bila import ini yang membuat Product dengan region itu), `label`,
`suffix`, dan `skippedReason` bila tidak ditulis: `product_exists`, `no_suffix`,
`unrecognized_suffix`, `no_matching_group`, `no_price_list` (tanpa kredensial,
price list gagal dimuat, atau rc 83) atau `not_game_topup_category`. Toast sukses
di halaman Digiflazz Sync menambah satu kalimat (bahasa Inggris, seperti string
di sekitarnya) mis. "2 of 3 brands got an automatic region; 1 skipped
(unrecognised suffix: Garena)." Yang **dilaporkan**: `unrecognized_suffix`
(maks. 3 nama lalu "..."), `no_price_list` dan `no_matching_group`. Yang
**senyap** (bukan tindakan admin): `product_exists`, `no_suffix`,
`not_game_topup_category`; bila tidak ada yang layak dilaporkan, toast tidak
menambah kalimat apa pun.

**Guard scope campuran di bot.** Untuk satu scope (kategori + edisi), bila ada
produk layak tampil (aktif, tidak diarsipkan, punya paket aktif berharga) yang
`gameRegion`-nya kosong, level Region **dilewati** dan semua produk scope itu
ditampilkan dalam satu daftar (halaman, refresh, dan Back konsisten). Tidak ada
produk yang menghilang gara-gara sebagian saudaranya diberi region. Picker Region
baru muncul bila semua produk di scope punya region.

**Backfill produk lama (sekali jalan).** Produk yang diimpor sebelum auto-isi
region tidak berubah sendiri. Skrip operator:

```
pnpm exec tsx scripts/fill-game-regions.ts                      # dry run (default), tidak menulis apa pun
pnpm exec tsx scripts/fill-game-regions.ts --apply              # tulis scope yang memenuhi syarat
pnpm exec tsx scripts/fill-game-regions.ts --category-ids=1,2   # batasi ke kategori tertentu
```

- Menolak jalan bila `DATABASE_URL_PRISMA` menunjuk host selain
  localhost/127.0.0.1/::1, kecuali diberi `--i-know-this-is-not-local`. Ambil backup
  segar sebelum `--apply` di database bersama.
- **Pemilik sebaiknya menjalankan dry run dulu dan membaca laporannya sebelum
  `--apply`.** Dry run tidak menulis apa pun (tanpa audit, tanpa bump revisi).
- **Semua-atau-tidak-sama-sekali per scope** = (kategori GAME_TOPUP, `gameVariant`;
  null adalah scope sendiri; produk tidak diarsipkan, aktif atau tidak). Scope
  ditulis hanya bila setiap anggota bisa diberi label dan ada >= 2 label berbeda.
  Alasan dilewati: `mixed` (sebagian anggota tanpa akhiran), `no_suffix`,
  `admin_set_region_present` (ada nilai `gameRegion` apa pun, termasuk kosong/spasi;
  tidak pernah ditimpa), `already_filled` (semua sudah persis berlabel itu),
  `unknown_suffix` (akhiran di luar tabel; daftar akhiran ikut dilaporkan),
  `single_region_scope` (butuh >= 2 label berbeda; satu region tidak berguna dan
  menyembunyikan saudara yang diimpor kemudian), `possible_doubled_suffix` (nama
  dasar sudah memuat kata region itu, mis. "Game Malaysia (Malaysia)"),
  `changed_concurrently` (anggota scope berubah antara baca dan tulis), dan
  `failed` (galat tak terduga).
- Penulisan: satu transaksi pendek per scope, compare-and-set (`gameRegion` masih
  null), satu baris audit per produk (`game_region_backfill`), lalu
  `bumpCatalogRevision` sekali bila ada yang tertulis. Galat tak terduga
  menghentikan run di scope itu (`stoppedEarly`); scope sebelumnya tetap, yang
  sesudahnya tidak dicoba. Pesan galat dibersihkan dari URL `postgres(ql)://`.
- Kode keluar: `0` sukses; `1` bila ada scope `changed_concurrently`/`failed` atau
  bump revisi gagal; `2` untuk opsi salah atau penolakan host non-lokal.
- **Risiko sisa:** transaksi berjalan pada READ COMMITTED, jadi saudara yang
  di-commit sesi lain di antara hitung ulang dalam transaksi dan COMMIT tidak
  terlihat. Jalankan saat tidak ada Digiflazz sync/import berjalan. Produk itu
  hanya tanpa region dan tetap tampil di bot lewat guard scope campuran.
- **Satu produk nonaktif yang usang dengan brand sampah memblokir seluruh
  scope-nya** (`unknown_suffix`/`mixed`): arsipkan atau perbaiki produk itu lalu
  jalankan ulang.

**Deploy.** Tidak ada perubahan skema dibanding `master` (skema `Product`
identik), jadi tidak ada migrasi untuk cabang ini dan tidak ada langkah restart
khusus selain deploy kode biasa. Tabel label region masih draft: koreksi dulu
sebelum menjalankan backfill dengan `--apply`.

**Daftar cek smoke manual (`@testtoko_bot`, hanya di database worktree).**
Tes otomatis memakai transport Telegram palsu dan stub gateway; yang di bawah
ini adalah uji tangan opsional di Telegram sungguhan.

Prasyarat (di worktree `game-topup-refactor`, bukan di checkout utama):

1. Postgres milik worktree: `docker compose -f docker-compose.postgres.yml -p gtr up -d`
   (hanya satu worktree boleh menjalankannya; port dan nama DB dari `POSTGRES_PORT`
   dan `POSTGRES_DB=bot_order_gtr` di `.env` worktree). `DATABASE_URL_PRISMA`
   harus menunjuk `bot_order_gtr` di localhost.
2. `pnpm prisma:generate`, `pnpm -r build`, lalu `pnpm exec prisma db push --skip-generate`
   (tanpa `--accept-data-loss`) pada database worktree itu.
3. `WEB_PORT` dan `STOREFRONT_PORT` di `.env` worktree dibuat berbeda dari
   worktree lain.
4. Seed fixture (nama tampak seperti toko sungguhan, tanpa penanda terlihat dan
   tanpa kredensial provider):
   `pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db`
   (dry run, hanya hitungan), lalu
   `pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db --apply`
   (tambah `--bulk` untuk katalog besar **sebagai pengganti** fixture kecil, bukan
   tambahan: `--bulk` membuat satu kategori Game Top-up per game, sekitar 32 game,
   game mobile dulu lalu game PC (dibedakan lewat emoji 🎮/🖥️ dan urutan saja,
   karena skema tidak punya subkategori), plus 8 produk Premium Apps; tanpa
   `--bulk` yang dibuat hanya fixture kecil "Game Top Up" dan "Mixed Games").
   Bila manifest masih berisi tata letak bulk lama (Game Top Up / Regional Games /
   Game Editions / Mixed Games), `--bulk` menghapus baris manifest lama itu dahulu
   dan berhenti dengan pesan, tanpa mengubah apa pun, bila ada order yang masih
   merujuknya. Skrip menolak jalan kecuali host lokal,
   DB `bot_order_gtr`, dan flag konfirmasi. Kepemilikan baris dicatat di
   **manifest tak terlihat**: id kategori, produk, denominasi, dan pembeli yang
   dibuat atau diadopsi disimpan sebagai JSON di satu baris setting
   `seed_game_topup_manifest` (hanya di DB target, tanpa rahasia). Baris yang
   namanya sama tetapi tidak ada di manifest (baris toko asli) **ditolak**, tidak
   diambil alih, dan namanya dilaporkan. `--apply` juga mengganti nama di tempat
   (id dan order tetap) baris lama yang masih berakhiran ` [SEED-GTR]` lalu
   memasukkannya ke manifest; bila nama bersih bentrok dengan baris asli,
   skrip berhenti dengan pesan jelas dan tidak mengubah apa pun. Ia juga
   menyalakan layanan Game Top-up (bot dan web) dan menyetel minimum order 0
   (setting bersama; `--remove` tidak mengembalikannya).
5. Token bot dibaca dari setting DB `bot_token` (bukan `.env`); salin dari DB dev
   sesuai [CATALOG_BUTTONS.md](docs/CATALOG_BUTTONS.md) bagian 9. **Hanya satu
   worktree yang boleh menjalankan order-bot** pada token yang sama (dua poller
   memicu error 409). Jalankan `pnpm dev:bot`.

Daftar cek:

- [ ] Penelusuran dengan katalog `--bulk`: Game Top-up -> Mobile Legends (satu
  kategori per game) -> pilih region (Indonesia/Malaysia/Philippines/Global) ->
  daftar denominasi hanya untuk region itu. Jalur edisi: Game Top-up -> Arena
  Breakout -> pilih edisi (Standard/Infinite) -> pilih region -> denominasi.
  Game satu region atau tanpa region (mis. Roblox) langsung ke paket tanpa
  picker. Dengan fixture kecil (tanpa `--bulk`): kategori, game, region (bila
  ada), paket; game tanpa region langsung ke paket; kategori campuran
  menampilkan semua produk.
- [ ] Tingkat game (katalog seperti produksi: satu kategori "Game Top Up" berisi
  banyak game, mis. hasil import Digiflazz): Game Top-up -> daftar game (satu
  tombol per game, tidak ada "MOBILE LEGENDS Malaysia"/"Mobile Legends (BR)"
  sebagai game) -> Mobile Legends -> pemilih region berbendera (Indonesia,
  Malaysia, Russia, Brazil, Philippines, Global) -> paket hanya region itu.
  Jalur edisi: daftar game -> Arena Breakout -> Umum/Infinite -> paket (pilih
  region muncul bila game itu punya ≥ 2 region). Pack picker berupa pesan teks
  (tanpa foto), foto produk hanya di detail paket; pack picker 2 halaman
  menampilkan `1/2 ›` lalu `‹ 2/2`. Ulangi game -> edisi -> region -> paket ->
  detail -> ← Kembali sampai daftar game beberapa kali: jumlah pesan di chat
  tetap, tidak ada "Choose edition"/"Pilih edisi" ganda. Ketuk tombol di bubble
  lama atau ketuk dua kali cepat: toast "layar kedaluwarsa", tanpa pesan baru.
  Premium Apps di database yang sama tetap bernomor.
- [ ] Tanpa sistem angka di Game Top-up: picker edisi, picker region, dan daftar
  produk **tidak** mengirim pesan "Gunakan angka di bawah untuk memilih:" dan
  tidak memasang keyboard bawah 1-2-3. Daftar produk memakai tombol inline per
  produk (nama lengkap tetap di teks), Prev/Next, dan ← Kembali (juga pada
  daftar satu halaman). Ulangi region -> ← Kembali -> region lain beberapa
  kali: jumlah pesan di chat tidak bertambah. Ketik "Produk" dengan satu layanan
  dan satu game: tepat satu pesan. Ketik angka (tiga kali) di layar Game: layar
  itu diedit di tempat dengan baris "Pilih dengan menekan tombol pada daftar."
  di atasnya, tombolnya tetap, angkanya terhapus, tanpa pesan baru dan tanpa
  membuka produk apa pun. Ketik angka di Home setelah membuka Game: baris itu
  tidak muncul.
- [ ] Satu baris hint di tiap layar (daftar game, edisi, region, paket, search),
  dan label `mulai <harga>` pada daftar produk Game Top-up.
- [ ] `/search` menemukan produk Game Top-up saja (tidak ada Premium Apps).
- [ ] Beli produk bergaya ML: ketik ID dan Zone dalam satu pesan, mis. `123456789 1234`;
  layar review menampilkan field terpisah dengan label.
- [ ] Ubah harga denominasi di admin setelah layar review tampil, lalu ketuk
  bayar: tidak ada order baru, layar dirender ulang dengan "Harga berubah
  menjadi ...", dan ketukan tombol lama tidak membayar.
- [ ] Setting yang disalin dari DB dev bisa berisi kredensial TokoPay sungguhan:
  mengetuk tombol bayar QRIS membuat invoice merchant sungguhan (uang tidak
  bergerak kecuali dibayar). Untuk smoke test pakai setting TokoPay kosong/stub,
  kecuali pemilik sengaja meminta invoice sandbox.
- [ ] Faktur QRIS: **hanya di sandbox yang aman. Jangan membayar uang sungguhan.**
  Di tes otomatis TokoPay di-stub. Lewati item ini bila tidak ada sandbox.
- [ ] Pengingat sekitar 5 menit sebelum jendela habis: tepat satu DM.
- [ ] Saat kedaluwarsa: pesan pembayaran diedit menjadi dibatalkan, dan hanya
  satu push pemberitahuan.
- [ ] Kontrol: Premium Apps tidak menampilkan `mulai`, hint, atau layar review,
  dan daftarnya tetap bernomor seperti sebelumnya (pesan "Gunakan angka...",
  keyboard bawah angka, ketik angka membuka produk).
- [ ] Bersihkan: `pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db --apply --remove`,
  lalu hentikan bot dan `docker compose -f docker-compose.postgres.yml -p gtr down`.
  `--remove` hanya menghapus id yang ada di manifest (baris toko asli tidak
  pernah disentuh) dan menghapus baris manifest hanya bila tidak ada yang
  dilewati; tanpa `--apply` hanya mencetak hitungan dari manifest. Baris seed
  yang masih dirujuk order milik penguji (atau riwayat dompet) **dilewati dan
  dilaporkan**, bukan dihapus: biarkan saja, atau hapus order tes itu secara
  manual hanya di DB worktree. Penghapusan denominasi seed ikut menghapus
  (cascade) item keranjang dan ulasan penguji pada denominasi itu.

**Tidak dibuktikan oleh tes otomatis:** format kawat live TokoPay, Digiflazz,
dan KokinPay (stub saja); perilaku Telegram sungguhan (edit pesan, suara
notifikasi, rate limit); apakah invoice TokoPay/PayDisini/NOWPayments ikut
kedaluwarsa bersama jendela bayar kita (panggilan create tidak mengirim waktu
kedaluwarsa); latensi gateway terhadap siklus rekonsiliasi; sinkronisasi jam
host.

Key rahasia (`tokopay_secret`, `bot_token`, `notif_bot_token`, `bybit_api_key`,
`bybit_api_secret`, `web_cookie_secret`) ditangani **write-only**: tak di-echo,
`(hidden)` di tabel, audit `key=(updated)` tanpa nilai.

---

## 7. Manajemen stok

Halaman **web-admin → Stock → (produk)**
(`apps/web-admin/src/routes/api/stock.ts`, endpoint JSON `/api/stock/*`):

- **Tambah stok** — kredensial satu baris per akun (`email:password`).
- **Lihat stok** — tabel item per produk + status (AVAILABLE / RESERVED / SOLD /
  DEAD), login, order, catatan.
- **Download remaining** — `GET /stock/:productId/download` mengembalikan `.txt`,
  satu kredensial per baris, hanya item **AVAILABLE**. Read-only (`currentAdmin`),
  `Content-Disposition: attachment` + `Cache-Control: no-store`, **diaudit hanya
  jumlahnya** (`stock_download`) — kredensial tak pernah masuk log. Tiap baris
  yang ikut ter-download juga mendapat event `CREDENTIAL_REVEALED` atas nama
  admin itu (satu transaksi dengan baris audit), sama seperti reveal satuan.
- **Delete selected** — `POST /stock/:productId/bulk-delete` melakukan *soft
  delete*: baris diberi `deletedAt` dan hilang dari semua tampilan, tapi tetap
  tersimpan beserta riwayat event-nya untuk jejak audit (beda dari "Mark as
  bad" yang menyetel status DEAD). Pengaman di crud
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
- **Arah sebaliknya — bayar order dari credit balance:** pembeli dengan saldo
  cukup bisa membayar order langsung dari `walletBalance`/`walletBalanceUsdt`
  yang sudah ada, tanpa gateway pembayaran sama sekali. Callback bot
  `walletm:*`/`walletpay:*` (`apps/order-bot/src/handlers/{checkout,
  callbacks}.ts`) memanggil `completeOrderWithWalletCredit`
  (`packages/db/src/crud/wallet_checkout.ts`), yang mendebit saldo mata-uang
  order lalu menyelesaikan pengiriman seperti pembayaran gateway biasa. Ini
  konsep berlawanan arah dari kredit admin di atas: uang keluar dari saldo,
  bukan masuk.
- **Tampil di:** web-admin user detail, storefront account, dan profil bot.

CRUD: `packages/db/src/crud/{users,orders,binance_internal,bybit_deposit,
wallet_checkout}.ts`.

---

## 9. Program referral

Pembeli membagikan kode referral pribadi; saat orang yang direferensikan
menyelesaikan pembelian pertama, pereferensi otomatis menerima komisi —
tanpa approval manual admin.

- **Bot:** layar `ref:view` (`apps/order-bot/src/handlers/customer.ts`,
  keyboard di `keyboards/customer.ts`) menampilkan kode/link referral milik
  pembeli beserta ringkasan komisi yang sudah didapat.
- **Storefront:** halaman `/account/referral`
  (`apps/storefront/src/routes/apiAccount.ts`) — tampilan setara untuk
  pembeli yang login lewat web.
- **Komisi otomatis:** `maybePayReferralCommission`
  (`packages/db/src/crud/referrals.ts`) dipanggil dari `crud/orders.ts` saat
  order pertama referee selesai; komisi dikreditkan ke saldo mata-uang order
  (konversi kurs IDR→USDT dipakai bila perlu — lihat §4 untuk sumber kurs).

CRUD: `packages/db/src/crud/referrals.ts`.

---

## 10. Tiket dukungan (support)

Saluran dukungan terpusat, dua pintu masuk, satu thread per tiket:

- **Bot:** percakapan `apps/order-bot/src/conversations/support.ts` — pembeli
  mengetik pesan, tiket dibuat/ditambahkan ke thread yang sedang terbuka.
- **Storefront:** `/account/support` (buat tiket baru + daftar tiket milik
  akun) dan `/account/support/:id` (thread balasan) di
  `apps/storefront/src/routes/apiAccount.ts`.
- **Admin:** antrian tiket + balas/tutup di
  `apps/web-admin/src/routes/api/support.ts`.

CRUD: `packages/db/src/crud/support.ts` (dan `support.test.ts` colocated).

---

## 11. Ulasan & rating produk

- **Bot bersifat read-only** — hanya menampilkan `productRating`
  teragregasi per produk. Alur submit-review per-order dari bot **sudah
  dihapus** (`apps/order-bot/src/handlers/customer.ts:770-771` punya komentar
  eksplisit yang mencatat penghapusan ini) — jangan asumsikan ada jalur bot
  untuk mengirim ulasan baru.
- **Submit & moderasi ulasan** sepenuhnya di storefront (`/account/reviews`)
  dan web-admin (moderasi/hapus ulasan tak pantas).

CRUD: `packages/db/src/crud/reviews.ts`.

---

## 12. Langganan restock

Pembeli bisa berlangganan notifikasi saat denominasi yang sedang habis stok
kembali tersedia — callback bot `restock:sub`
(`apps/order-bot/src/handlers/callbacks.ts`,
`apps/order-bot/src/handlers/admin.ts`). Notifikasi dikirim lewat jalur
`notification_outbox` yang sama dengan notifikasi lain (§1) saat stok
denominasi itu bertambah kembali.

---

## 13. Desain storefront

Satu bahasa visual dengan web-admin ("Clean Modern"): token warna, font, radius,
shadow **identik** di kedua app — storefront React SPA
(`apps/storefront/client`, Vite + Tailwind v4), tokennya ditranskripsi
byte-for-byte ke sebuah `@theme` block di `client/src/index.css` (lihat
komentar di kepala file itu, yang mendokumentasikan tema Nunjucks lama
sebagai sumber portingan — riwayat migrasi lengkap di
[REACT_STOREFRONT_MIGRATION.md](docs/REACT_STOREFRONT_MIGRATION.md)).
Mobile-first, dwibahasa (EN+ID). Tidak ada sisa Nunjucks: halaman error/
setup-pending (§1) juga dilayani lewat SPA shell
(`apps/storefront/src/lib/spaFallback.ts`), dengan fallback HTML tulisan
tangan hanya jika build SPA belum tersedia.

**Token warna:** `pine` `#2563eb` (aksen/tombol/harga), `grass` `#16a34a`
(tersedia), `amberx` `#b45c0a` (menunggu/stok menipis), `rust` `#dc2626`
(habis/batal); latar `paper` `#f6f8fb`, kartu `#fff`, teks `ink` `#1b2330`.
**Font:** Outfit (judul), Manrope (isi), JetBrains Mono (kredensial). Ikon Lucide.

**Peta halaman:** `/` beranda · `/c/:slug` & `/search` daftar/cari · `/p/:slug`
detail · `/cart` · `/checkout` (pilih metode = pilih mata uang) ·
`/checkout/:code/pay` (instruksi + status via polling JSON) · `/account` +
`/orders`/`/orders/:code` (kredensial bila DELIVERED) / `/referral` / `/reviews` /
`/support` · `/login` + `/register` + `/forgot` + `/reset`.

Macro `price` merender **IDR + USDT bersisian** untuk semua pembeli (tanpa pemilih
mata uang). Pantangan: web tak pernah kirim Telegram; tak menampilkan
`file_id`/proof/hash mentah (kredensial hanya ke pemilik order DELIVERED); tak ada
SQL mentah; jangan ubah nama kolom/skema (DB dipakai bersama).

---

## 14. Setup env & checklist fitur

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

`CREDENTIAL_ENCRYPTION_KEY` juga boleh dikosongkan di deploy Docker — di-generate
otomatis sekali oleh `docker-entrypoint.sh` dan disimpan di
`data/credential_encryption.key` (lihat `.env.example`). Pastikan file itu ikut
ter-backup: kalau hilang, semua credential yang sudah terenkripsi (Digiflazz
API key, akun manual di stok) tidak bisa dibaca lagi selamanya.
Tiap proses (server, order-bot, web-admin, storefront) mengecek key ini saat
start dan menolak jalan kalau key kosong atau gagal uji enkripsi/dekripsi.
Instalasi tanpa Docker WAJIB mengisinya sendiri (`openssl rand -hex 32`).

`ALLOW_LEGACY_PLAINTEXT` (default `true`): nilai lama yang belum terenkripsi
tetap terbaca, dengan warning di log. Kalau `false`, setiap pembacaan nilai
plaintext melempar error — credential stok **dan** secret terenkripsi di
Settings (API key payment/provider), **dan** `Order.deliveredContent` (akun yang
diketik admin untuk order manual). Hanya daftar/cari/export stok dan preview
stok di bot yang melewati baris itu; jalur lain (detail order admin, pencarian
admin, riwayat order pembeli, pengiriman) mengembalikan error. Jadi set `false`
hanya setelah **keempat** backfill selesai: `backfill-encrypt-stock-credentials`,
`backfill-encrypt-settings-secrets`, `backfill-encrypt-delivered-content`, dan
`backfill-encrypt-customer-data` (jawaban pembeli, `Order.customerData`).
Cara tahu backfill sudah tuntas: jalankan keempat script itu, lalu restart —
warning "legacy plaintext" (muncul sekali per proses) tidak muncul lagi di log
**semua** proses. Urutan lengkapnya ada di "Checklist rollout" di bawah.

### Envelope credential v2 (AAD) — rollout dua tahap

Envelope v2 (`"v":2`) mengikat ciphertext ke tempat penyimpanannya lewat AAD
AES-GCM, jadi ciphertext yang disalin ke baris/kolom lain tidak bisa didekripsi.
Konteks AAD (JANGAN pernah diubah — mengubahnya membuat semua nilai v2 di
bawahnya tidak terbaca selamanya):

| Kolom | Konteks |
| --- | --- |
| `StockItem.credentials` | `stock_items.credentials:{id}` |
| `Order.deliveredContent` | `orders.delivered_content:{orderId}` |
| `Order.customerData` (jawaban pembeli) | `orders.customer_data:{orderId}` |
| `BotSession.data` (sesi grammY) | `bot_sessions.data:{key}` |
| `Setting.value` (kunci di `ENCRYPTED_SETTING_KEYS`) | `settings.value:{key}` |

Kode pembaca menerima v1 (tanpa AAD, konteks diabaikan) dan v2 (konteks wajib
cocok). Penulis tetap menulis v1 kecuali `CREDENTIAL_ENVELOPE_WRITE_V2=true`
(default mati). Urutan operator:

1. **Tahap 1 — deploy kode pembaca.** Deploy versi ini ke SEMUA proses (server,
   order-bot, web-admin, storefront) dengan flag belum di-set. Perilaku sama
   persis dengan sebelumnya; tidak ada nilai v2 yang tertulis.
2. **Verifikasi.** Pastikan semua proses sudah restart ke versi ini (tidak ada
   instance lama yang masih jalan), dan detail order, reveal stok, serta
   pengiriman berjalan normal.
3. **Dry run.** `pnpm reencrypt-credentials-v2 --dry-run` — hanya menghitung
   (v1, sudah v2, belum terenkripsi, tidak terbaca) per kolom, tidak menulis
   apa pun. Angka "unreadable" harus 0 atau sudah dipahami penyebabnya; nilai
   "not encrypted" diurus dulu oleh script `backfill-encrypt-*`.
4. **Nyalakan flag.** Set `CREDENTIAL_ENVELOPE_WRITE_V2=true` di `.env` semua
   proses, lalu restart. Mulai saat ini nilai baru ditulis sebagai v2.
5. **Re-encrypt.** `pnpm reencrypt-credentials-v2` — menulis ulang setiap v1
   menjadi v2 per batch (compare-and-set, idempotent, aman diulang), mencatat
   event `REENCRYPTED` (aktor SYSTEM) per baris stok, dan hanya mencetak
   jumlah. Script menolak jalan (selain `--dry-run`) selama flag mati —
   tapi cek itu HANYA membaca environment proses script itu sendiri. Ia tidak
   membuktikan apa pun tentang proses aplikasi, host lain, atau cron; pastikan
   langkah 1 dan 4 sudah benar di semua tempat itu secara manual.
6. **Verifikasi.** Jalankan lagi `--dry-run`: `v1` harus 0 di keempat kolom
   (`StockItem.credentials`, `Order.deliveredContent`, `Order.customerData`,
   `Setting.value`; kalau ada "changed during the run", ulangi langkah 5).
   Order baru menulis jawabannya sebagai v2 yang terikat ke order itu sendiri
   (dalam transaksi yang sama, begitu id-nya ada), jadi angka ini tetap 0.
   `BotSession.data` tidak ditulis ulang oleh script: sesi v1 menjadi v2 saat
   ditulis berikutnya, dan habis sendiri dalam 24 jam.

**Rollback.** Setelah langkah 4, nilai v2 sudah ada di database. Mematikan flag
hanya menghentikan penulisan v2 baru — nilai v2 yang ada tetap v2. Karena itu
rollback setelah flag menyala WAJIB tetap memakai kode tahap 1 (atau lebih
baru); kode sebelum tahap 1 tidak bisa membaca v2 dan akan gagal di setiap
credential yang sudah v2. Sebelum langkah 4, rollback ke kode lama aman.

"Semua tempat" berarti setiap host/container yang memakai database ini:
proses server, order-bot, web-admin, storefront, **dan** setiap host yang
menjalankan `scripts/*` (backfill, `reencrypt-credentials-v2`, script
maintenance lain), cron job, atau tooling ops yang membaca credential. Semuanya
harus tetap di kode tahap 1 atau lebih baru setelah langkah 4.

Backup database yang diambil SETELAH langkah 4/5 berisi nilai v2: backup itu
hanya bisa di-restore dan dibaca oleh kode tahap 1 atau lebih baru. Restore ke
deploy lama (sebelum tahap 1) akan membuat credential v2 tidak terbaca.

Rotasi `CREDENTIAL_ENCRYPTION_KEY` tetap di luar cakupan: envelope v2 tetap
`keyVersion: 1`, dan fingerprint stok (HMAC dari key yang sama) tidak berubah
oleh re-encrypt ini.

### Traceability stok: backfill & audit integritas

**`pnpm backfill-stock-traceability`** — backfill sekali jalan untuk baris stok
lama: fingerprint credential, `soldToOrderId` untuk baris terjual, riwayat event
sintetis (aktor SYSTEM, `meta.backfilled`), dan klaim dedup
`activeCredentialKey`. Idempotent (aman diulang kalau terputus) dan aman
dijalankan saat app hidup. Selalu jalankan `--dry-run` dulu — hanya menghitung,
tidak menulis. Arti angka ringkasannya:

- `fingerprints` — `computed` baru dihitung, `alreadyPresent` sudah ada,
  `decryptFailed` credential tidak terbaca (harus 0 atau diselidiki dulu).
- `soldTo` — `backfilled` terisi; `soldWithNoOrderId` / `soldWithNoOrderItem` /
  `soldOrderMismatch` = baris SOLD yang tidak bisa dipastikan pembelinya →
  cek manual.
- `events` — `rowsBackfilled`/`eventsCreated` riwayat yang dibuat,
  `rowsAlreadyTraced` sudah punya riwayat, `statusReconciled` diberi satu event
  penutup, `statusUnreconciled` status tidak bisa dicapai tanpa mengarang
  riwayat → cek manual.
- `keyVersion` — `legacyPlaintext` = baris yang masih plaintext (jalankan
  `backfill-encrypt-stock-credentials`).
- `claims` — `claimed`/`alreadyClaimed` normal; `duplicate` = baris hidup
  dengan credential yang sudah dipegang baris lain (dobel stok AVAILABLE/
  RESERVED → tandai DEAD salah satunya; duplikat SOLD dari sebelum Fase 5a
  adalah riwayat, tidak bisa dan tidak perlu diperbaiki); `released` = klaim sisa di baris DEAD/terhapus yang
  dilepas; `unfingerprinted` = baris hidup tanpa fingerprint (gagal dekripsi).

**`pnpm audit-stock-integrity`** — read-only, hanya mencetak jumlah per temuan
(tidak pernah id atau credential). Semua angka selain `legacyRowsWithoutEvents`
harus 0. Temuan yang paling sering muncul setelah backfill:
`liveRowsWithoutClaimKey` (baris hidup tanpa klaim di denominasi yang sudah
di-fingerprint — biasanya `duplicate`/`unfingerprinted` dari backfill; baris
SOLD yang credential-nya sudah diklaim baris lain tidak dihitung karena itu
riwayat, sedangkan baris SOLD yang credential-nya tidak diklaim siapa pun tetap
dihitung karena credential itu bisa diimpor dan dijual lagi),
`deadOrDeletedRowsHoldingClaimKey` (jalankan ulang backfill untuk melepasnya),
dan `soldWithoutSoldToOrderId` (penjualan tanpa order tujuan). Untuk mendapat
id barisnya, panggil `checkStockIntegrity` langsung atau pakai
**`scripts/audit-stock-duplicates.sql`** (`psql "$DATABASE_URL_PRISMA" -f
scripts/audit-stock-duplicates.sql`, hanya SELECT): pointer stok dobel, order
batal/ditolak yang masih menunjuk stok, dan baris SOLD yang order-nya hilang
atau tidak DELIVERED.

### Checklist rollout: traceability stok + enkripsi credential

Urutan ini wajib; jangan lompat langkah.

1. **Backup.** `pg_dump` database dulu.
2. **Key enkripsi.** Pastikan `CREDENTIAL_ENCRYPTION_KEY` (atau
   `data/credential_encryption.key`) ada dan sama di semua proses — tiap proses
   menolak start tanpa key. Di Docker, file key yang hilang membuat
   entrypoint men-generate key **baru**, dan semua ciphertext lama tidak
   terbaca lagi selamanya.
3. **Skema + restart bersamaan.** `prisma db push` (entrypoint Docker sudah
   menjalankannya), lalu restart order-bot, server, web-admin, dan storefront
   **bersama-sama** sebelum kode baru melayani trafik — kalau tidak, muncul
   `P2022 column … does not exist`.
4. **Traceability.** `pnpm backfill-stock-traceability --dry-run`, baca
   angkanya (lihat di atas), lalu jalankan tanpa `--dry-run`.
5. **Enkripsi.** `pnpm backfill-encrypt-stock-credentials`,
   `pnpm backfill-encrypt-settings-secrets`,
   `pnpm backfill-encrypt-delivered-content`, lalu jawaban pembeli
   (`Order.customerData`): `pnpm backfill-encrypt-customer-data --dry-run`,
   baca angkanya, lalu jalankan tanpa `--dry-run`. Ulangi `--dry-run` sampai
   `plaintext = 0` dan `corrupt = 0` sebelum lanjut ke langkah 7.

   > **Peringatan rollback.** Begitu ada order yang jawabannya terenkripsi
   > (order baru langsung terenkripsi sejak kode ini jalan), kode versi
   > sebelumnya membaca envelope itu sebagai "tanpa jawaban": Game ID kosong
   > di admin dan di halaman pembeli, dan pengiriman Digiflazz-nya gagal validasi
   > field wajib sehingga order masuk "perlu review manual" (tidak ada yang
   > dikirim ke supplier, tapi semua order game baru tertahan sampai ditangani
   > manual). Rollback hanya aman ke versi yang
   > masih bisa mendekripsinya; jangan rollback melewati perubahan ini. Sesi
   > bot (`BotSession.data`) juga terenkripsi, dan kode lama TIDAK mengenali
   > envelope-nya sebagai sesi (ia mem-parse JSON envelope itu seolah-olah
   > sesi); kalau terpaksa rollback, kosongkan tabel sesi bot dulu
   > (`DELETE FROM bot_sessions;` — hanya status navigasi/checkout yang
   > sedang berjalan yang hilang).
6. **Audit.** `pnpm audit-stock-integrity` dan
   `scripts/audit-stock-duplicates.sql`; selesaikan temuannya dulu.
7. **Mode ketat.** Hanya setelah warning "legacy plaintext" hilang dari log
   **semua** proses: set `ALLOW_LEGACY_PLAINTEXT=false`, lalu restart.
8. **Envelope v2.** Semua host dan cron sudah di kode ini →
   `pnpm reencrypt-credentials-v2 --dry-run` → set
   `CREDENTIAL_ENVELOPE_WRITE_V2=true` di semua proses dan restart →
   `pnpm reencrypt-credentials-v2` → `--dry-run` lagi, `v1` harus 0 di keempat kolom. Sejak
   itu rollback wajib tetap ke kode tahap 1 atau lebih baru (lihat "Envelope
   credential v2" di atas).

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
| **Binance Pay manual** | — | **Dipensiunkan** — hanya label read-only pada order lama, tak ada jalur aktif untuk order baru (lihat §5). |
| **Kurs USDT↔IDR** | `usd_idr_rate` di **Settings** | Auto-update pasar ON default. |
| **Lupa password toko** | `SMTP_HOST` + `SMTP_FROM` (+ `SMTP_USER`/`SMTP_PASS`) | Aktif bila host & from terisi. |
| **Produksi** | `WEB_COOKIE_SECURE=true` di balik HTTPS | Reverse proxy. |

---

## 15. Banyak toko dalam satu VPS

Aplikasi ini **single-tenant**: `satu deploy = satu bot = satu toko = satu DB`.
Untuk menjalankan **beberapa bisnis yang benar-benar terpisah** (produk, stok,
order, admin, dan bot Telegram berbeda) di satu VPS, jalankan **beberapa instance
penuh yang berdiri sendiri** — tiap toko dari direktori repo sendiri dengan `.env`,
folder `./data`, volume PostgreSQL sendiri, bot, dan port sendiri. nginx
me-route tiap domain ke port loopback instance yang sesuai.

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
POSTGRES_DB=shopa                          # ← beda (DB Postgres terpisah per toko)
POSTGRES_USER=shopa
POSTGRES_PASSWORD=<acak-kuat-per-toko>     # ← beda
DATABASE_URL_PRISMA=postgresql://shopa:<password>@postgres:5432/shopa  # host tetap `postgres` (nama service Compose)
```

> Tidak perlu `POSTGRES_PORT` terpisah per toko: `docker-compose.postgres.prod.yml`
> tidak mempublikasikan port host sama sekali (Postgres hanya dijangkau lewat
> jaringan internal Compose), dan nama volume/container-nya otomatis
> di-prefix `COMPOSE_PROJECT_NAME` — jadi tiap instance sudah dapat container
> `postgres` dan volume data sendiri tanpa perlu variabel port tambahan (lihat
> juga "Backup & batas" di bawah).

Gateway pembayaran (TokoPay / PayDisini / NOWPayments) **tidak** diisi di `.env` —
diisi di web-admin → Settings tiap instance (tersimpan di DB masing-masing, jadi
otomatis terpisah). Pakai akun gateway berbeda per toko.

### Langkah (ulangi per toko)

```bash
git clone <repo-url> /opt/shop-a && cd /opt/shop-a
cp .env.example .env                                      # isi sesuai tabel di atas
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml run --rm server pnpm exec prisma db push   # skema sebelum start (hindari P2022)
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml up -d                                 # nama container otomatis dari COMPOSE_PROJECT_NAME
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

- **Backup per instance**: satu `pg_dump` per toko (lihat
  `deploy/backup/README.md`) — tiap direktori repo/instance punya container
  `postgres` dan volume data sendiri (`docker-compose.postgres.prod.yml`'s own
  header comment: Compose otomatis prefix nama volume dengan
  `COMPOSE_PROJECT_NAME`, jadi dua toko independen tidak berbagi data
  Postgres apa pun).
- **Tiap instance punya database Postgres sendiri** (bukan beberapa writer ke
  satu DB yang sama), jadi isolasi antar-toko terjaga.
- **Batas praktis**: N toko = 2×N container (`server` + `postgres` per toko);
  yang membatasi adalah RAM/CPU VPS (kira-kira ~1 GB per toko), bukan
  arsitektur DB.

---

## 16. API & Webhook

Proyek ini **tidak punya REST/GraphQL API publik** untuk konsumsi pihak ketiga
(lihat §1). Storefront dan admin masing-masing punya JSON API
(`/api/v1/*` storefront `apps/storefront/src/routes/api*.ts`, `/api/*` admin
`apps/web-admin/src/routes/api/*.ts`) — tapi itu kontrak privat untuk
React SPA masing-masing (`client/`), bukan sesuatu yang didaftarkan/
didokumentasikan untuk klien luar. Daftar di bawah adalah endpoint yang
**memang** dimaksudkan untuk dipanggil
dari luar proses ini: health check, webhook Telegram, dan webhook gateway
pembayaran. Integrasi eksternal lain harus lewat DB + `packages/db/src/crud/*`,
bukan HTTP.

### 16.1 Health check

| Endpoint | Proses | Auth | Respons |
|---|---|---|---|
| `GET /healthz` | web-admin (`apps/web-admin/src/routes/auth.ts`) | tidak ada (di-exclude dari setup-gate) | `{"status":"ok"}` setelah satu ping DB (`getSetting`) |
| `GET /healthz` | storefront (`apps/storefront/src/server.ts`) | tidak ada | sama, untuk domain toko sendiri |

Dipakai uptime monitor / reverse proxy; tetap menjawab walau setup wizard
belum selesai atau bot OFF (token kosong).

### 16.2 Webhook Telegram

`POST /tg/<WEBHOOK_SECRET>` — hanya didaftarkan saat `BOT_MODE=webhook` dan
token bot terisi (`apps/server/src/index.ts`). Default transport tetap
`polling`; endpoint ini tidak ada sama sekali bila mode ≠ `webhook`.

Auth dua lapis: path harus cocok `WEBHOOK_SECRET`, lalu grammY (`webhookCallback`)
memverifikasi header `X-Telegram-Bot-Api-Secret-Token` sebelum update
diteruskan ke bot — mismatch dibalas `401` sebelum logic bot jalan sama sekali.

### 16.3 Webhook gateway pembayaran (storefront, public)

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

### 16.4 Endpoint internal lain (bukan API publik)

- `GET /api/v1/orders/:code/status` — JSON yang di-poll halaman bayar
  storefront (React PayPage) tiap ~5 detik (§5); butuh sesi pembeli pemilik
  order, jadi bukan endpoint yang bisa dipanggil pihak ketiga.
