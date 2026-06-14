# Dokumentasi Proyek — `telegram-order-bot`

> Dokumen gabungan: **rencana** & **desain** storefront, **cutover** harga
> USDT→IDR, dan panduan **deploy** Hostinger. Sebelumnya terpisah di
> `plan.md`, `design.md`, `CUTOVER-IDR.md`, `DEPLOY-HOSTINGER.md` — kini satu
> file agar tidak berserakan. Konvensi koding tetap di [`CLAUDE.md`](CLAUDE.md),
> panduan instalasi di [`README.md`](README.md).

## Daftar isi

- [Bagian 1 — Rencana Storefront (Arsitektur & Rencana)](#bagian-1--rencana-storefront-arsitektur--rencana)
- [Bagian 2 — Desain Storefront (Spesifikasi Visual)](#bagian-2--desain-storefront-spesifikasi-visual)
- [Bagian 3 — Cutover Harga USDT → IDR (Runbook)](#bagian-3--cutover-harga-usdt--idr-runbook)
- [Bagian 4 — Deploy ke Hostinger Node App Manager](#bagian-4--deploy-ke-hostinger-node-app-manager)

---

## Bagian 1 — Rencana Storefront (Arsitektur & Rencana)

> Rencana implementasi **toko online pelanggan (storefront)** yang:
> - bergaya **sama persis** dengan web-admin (lihat [Bagian 2 — Desain Storefront](#bagian-2--desain-storefront-spesifikasi-visual)),
> - **terhubung ke DB & stok yang sama** dengan bot order Telegram,
> - belum dieksekusi — ini cetak biru untuk disetujui dulu.
>
> Konteks proyek: monorepo Node/TS (pnpm) hasil migrasi dari Python. Ada
> `apps/order-bot` (grammY), `apps/web-admin` (Fastify+Nunjucks+HTMX),
> `apps/notifier`, `apps/server` (composition root satu-proses), `packages/core`,
> `packages/db` (Prisma di atas SQLite `data/bot.db`). Skema 18+ model dipakai
> bersama. Storefront = **versi web dari sisi pelanggan bot**.

---

### 1. Tujuan & non-tujuan

**Tujuan**
- Pelanggan bisa **lihat katalog, cek stok real-time, masukkan keranjang,
  checkout, bayar, terima kredensial, lihat pesanan, saldo, referral, ulas, dan
  minta bantuan** — semua lewat web, tanpa harus pakai bot.
- **Stok & data sinkron otomatis** dengan bot karena **DB-nya sama** (tidak ada
  duplikasi/sinkronisasi manual).
- Tampilan **konsisten** dengan web-admin (tema Clean Modern).

**Non-tujuan (untuk v1)**
- Bukan SPA / framework berat (React/Next). Tetap server-rendered + HTMX.
- Tidak membangun payment gateway baru — pakai alur pembayaran yang sudah ada
  (Binance Pay + nominal unik + auto-confirm Binance Internal + saldo wallet).
- Tidak mengubah skema DB (kecuali 1 kolom opsional untuk gambar web — lihat §8).
- Tidak mengirim pesan Telegram dari web (pakai outbox).

---

### 2. Keputusan arsitektur utama: di mana storefront hidup?

**Rekomendasi: jadikan app baru di dalam monorepo → `apps/storefront`.**

Alasannya: kebutuhan inti adalah **berbagi stok & data dengan bot**. Cara
paling bersih & paling sedikit risiko adalah memakai **`@app/db` (Prisma) dan
`@app/core` yang sama**, menunjuk ke **`data/bot.db` yang sama**. Dengan begitu:
- Tidak ada sinkronisasi stok manual — query yang sama, kebenaran yang sama.
- Reuse seluruh `packages/db/src/crud/*` (order, cart, voucher, wallet, dst.)
  yang sudah teruji.
- Reuse tema, auth pattern, dan util web-admin.

Folder **`WEBSITE JUALAN`** ini dipakai untuk **dokumen perencanaan**
(`design.md`, `plan.md`). Saat eksekusi, kode app masuk ke
`BOT dan Web Admin/apps/storefront` (di-_wire_ ke monorepo lewat
`pnpm-workspace.yaml` yang sudah meng-_glob_ `apps/*`).

> **Alternatif (jika benar-benar ingin proyek terpisah di folder ini):** project
> standalone yang tetap membuka **SQLite yang sama** via Prisma sendiri. Bisa,
> tapi: rawan dua proses menulis SQLite bersamaan (single-writer — lihat
> RUN.md/CLAUDE.md), duplikasi skema & crud, dan beda deploy. **Tidak
> disarankan** untuk v1. → keputusan dikonfirmasi di §10.

#### Deploy / proses (keputusan F)
**Satu proses, satu Fastify** — storefront masuk ke composition root
(`apps/server/src/index.ts`) yang sudah menjalankan web-admin + bot + worker
dengan **satu PrismaClient**. Karena SQLite **single-writer**, ini paling aman
(tak ada penulis kedua) dan **pas dengan Hostinger Passenger** (satu entrypoint
per domain).
- **Pemisahan storefront vs admin** di satu listener: lewat **subdomain via Host
  header** (`shop.domain` → rute storefront, `admin.domain` → rute admin) atau
  **prefix** (`/` vs `/admin`). Plugin auth & cookie di-_scope_ terpisah agar tak
  bentrok (cookie sesi pelanggan ≠ cookie admin).
- Konsekuensi: route/plugin/views storefront didaftarkan ke **instance Fastify
  yang sama**; gunakan Fastify `register` ber-`prefix` atau pengecekan Host di
  preHandler. (Detail struktur di §9.)

---

### 3. Tech stack (mirror web-admin)

| Lapis | Pilihan | Catatan |
|---|---|---|
| Runtime | Node 20 + **tsx** (ESM, extensionless import) | sama monorepo |
| Web framework | **Fastify 5** | sama web-admin |
| Template | **Nunjucks** (`@fastify/view`) | reuse `base.njk`, `_macros.njk` |
| Interaktivitas | **HTMX 2** | keranjang, filter, swap partial |
| Styling | **Tailwind via CDN** + token inline | identik design.md §2 |
| Ikon | **Lucide** | sama |
| Data | **`@app/db`** (Prisma, SQLite `data/bot.db`) | berbagi dengan bot |
| Util/konfig | **`@app/core`** (config zod, money decimal.js, datetime luxon, i18n) | reuse |
| Auth | **Telegram Login Widget** + token HMAC (port pola `web-admin/src/auth.ts`) | §5 |
| Test | **Vitest** + `app.inject()` (pola `web-admin/test`) | §11 |

---

### 4. Pemetaan fitur: dari bot pelanggan → halaman web

Sisi pelanggan bot (handlers `customer.ts`, `checkout.ts`, dll.) dipetakan 1:1.
Semua sudah ada di `packages/db/src/crud` — web hanya menyajikan ulang.

| Fitur bot | Halaman web | crud/sumber data |
|---|---|---|
| Browse kategori/produk | `/`, `/c/:slug`, `/p/:id` | `catalog` crud, `Category`, `Product` |
| Cek stok | badge di kartu & detail | hitung `StockItem` status `AVAILABLE` |
| Keranjang | `/cart` | `cart` crud (`CartItem`) |
| Diskon kuantitas | detail produk + checkout | `BulkPricing` |
| Voucher | input di cart/checkout | `vouchers` crud (`Voucher`) |
| Checkout/buy-now | `/checkout` | `orders` crud (`createOrderFromCart`/`Direct`) |
| Pembayaran (auto-confirm saja, §17.1) | `/checkout/:code/pay` | USDT: Binance Internal (UID) · IDR: TokoPay callback |
| Auto-confirm Binance Internal (UID) | status di halaman bayar (HTMX polling) | poller `binanceInternal` (sudah ada) |
| ~~Bayar pakai saldo~~ | **ditunda web v1** (§17.1 #5) | — wallet tak tampil di web |
| Terima kredensial | `/account/orders/:code` (mono, salin) | `StockItem.credentials` (DELIVERED) |
| Pesananku & status | `/account/orders` | `Order` + `status_badge` |
| ~~Saldo & riwayat~~ | **ditunda web v1** (kelola via bot) | `WalletTransaction` |
| Referral (kode + link) | `/account/referral` | `User.referralCode`, `Referral` |
| Ulasan | `/account/reviews`, detail produk | `reviews` crud (`Review`) |
| Restock notify | tombol "Kabari saat ready" | `RestockSubscription` |
| Support | `/account/support` | `support` crud (`SupportTicket`, `TicketMessage`) |
| Banner toko | hero beranda | setting `banner_image` (memori `bot-banner-feature`) + Unsplash |

**Prinsip kritikal:** semua **mutasi uang/stok** lewat crud yang **caller-nya
membungkus `$transaction`** (lihat memori migrasi). Web jangan bikin alur order
baru — **panggil crud yang sama** dengan bot supaya reservasi stok, nominal unik,
voucher, dan audit konsisten.

---

### 5. Autentikasi pelanggan

User di DB di-_key_ oleh **`telegramId`**. Web tidak punya password pelanggan.
Solusi natural & konsisten dengan ekosistem:

- **Telegram Login Widget** di `/login`. Telegram mengirim
  `{id, first_name, username, photo_url, auth_date, hash}`; verifikasi `hash`
  dengan HMAC-SHA256 memakai `BOT_TOKEN` (algoritma resmi Telegram).
- Setelah verifikasi → cari/buat `User` by `telegramId` (reuse `users` crud,
  pola sama seperti bot saat `/start`).
- Terbitkan **cookie sesi** memakai **port `web-admin/src/auth.ts`**: token HMAC
  bertanda waktu (`<payloadB64url>.<ts>.<sig>`) dengan TTL, payload `{u: telegramId}`.
  Simpan/rotasi jti opsional. Cookie `httpOnly`, `secure` (di balik TLS), `SameSite=Lax`.
- Guard `currentCustomer` (preHandler) untuk halaman `/account/*` & `/checkout`
  → redirect `/login` bila belum masuk.
- **CSRF**: semua route mutasi pakai preHandler `csrfProtect` (pola web-admin).

**Keputusan D — keranjang tamu + merge saat login:**
- Katalog & **keranjang bisa diakses tanpa login**. Keranjang tamu disimpan di
  **cookie** (id anonim + daftar `{productId, qty}`), bukan `CartItem`.
- Saat user **login** (di checkout/kapan saja), isi cookie-cart **digabung
  (merge)** ke `CartItem` milik `userId` (jumlahkan qty bila produk sama), lalu
  cookie-cart dikosongkan. Setelah itu sumber kebenaran = `CartItem` (lintas
  perangkat).
- **Checkout tetap wajib login** (butuh `User` untuk order, pembayaran, kredensial).

---

### 6. Konsistensi tema: berbagi komponen dengan admin

**Keputusan B — partial bersama (DRY), bukan copy.** Agar benar-benar identik
dan tidak _drift_:
1. **Ekstrak tema ke partial bersama**: pindahkan blok Tailwind config +
   `@layer components` + import font/ikon ke **`packages/web-ui/views/_theme.njk`**,
   lalu **`base.njk` admin & storefront sama-sama `{% include "_theme.njk" %}`**.
   Ganti token sekali → dua web berubah. **Plumbing**: set Nunjucks
   `FileSystemLoader` / `@fastify/view` `templates` di **kedua app** ke **dua
   path** — folder `views/` app sendiri + `packages/web-ui/views`. Refactor
   `base.njk` admin kecil & berisiko rendah (yang dipindah hanya CSS/config, bukan
   string yang di-_assert_ test — tetap jalankan `pnpm test` admin setelahnya).
2. **`_macros.njk` dibagikan** (ikut ke `packages/web-ui/views`): `flash`,
   `status_badge`, `csrf_field`, `ic`, `empty_row`, ditambah macro storefront baru
   (`stock_badge`, `stars`, `product_card`, `price`).
3. _(Fallback bila refactor admin dianggap berisiko)_: minimal
   **copy nilai token apa adanya** dan beri komentar "sumber: web-admin base.njk —
   jaga sinkron".

→ Rekomendasi: **opsi 1** (DRY) bila aman; kalau tidak, opsi copy. Konfirmasi §10.

---

### 7. Stok real-time & integritas

- **Sumber stok** = jumlah `StockItem` ber-status `AVAILABLE` per `productId`
  (sudah ada index `ix_stock_product_status`). Tampilkan via `stock_badge`.
- **Saat checkout**, reservasi/pengurangan stok memakai **crud order yang sama**
  dengan bot (atomik dalam `$transaction`) — mencegah oversell walau pembeli
  datang dari web & bot bersamaan.
- **Restock**: tombol di produk habis → buat `RestockSubscription`; notifikasi
  pelanggan tetap lewat **bot/outbox** (web tak kirim Telegram).
- **Single-writer SQLite**: jaga transaksi pendek; storefront idealnya **satu
  proses** dengan bot (composition root) agar tak ada dua penulis. Bila beban
  tulis naik (≥2 penulis konkuren), pemicu pindah ke Postgres (RUN.md §9) — di
  luar lingkup v1, tapi dicatat.

---

### 8. Gambar produk (Unsplash, mudah diedit)

Masalah: `Product.imageFileId` = Telegram file_id, tak bisa dipakai `<img>`.

Rencana (sesuai design.md §6) — **keputusan C: pakai kolom DB + fallback peta**:
- **Kolom DB (dipilih)**: tambah kolom opsional `web_image_url String?` di
  `Product` + field input di admin (`catalog.njk`) supaya **admin atur foto
  sendiri**. Aditif & nullable → tak merusak bot. Ikuti aturan deploy:
  `prisma db push` + restart sebelum kode baru (CLAUDE.md).
- **Fallback `images.ts`**: bila `web_image_url` kosong, pakai peta Unsplash
  terpusat `apps/storefront/src/images.ts`:
  `categoryImage(name)` (Unsplash) → `PLACEHOLDER`. Semua URL di satu file.
- Urutan resolusi gambar: `web_image_url` (admin) → Unsplash per kategori →
  placeholder netral.
- Parameter Unsplash ringan: `?w=800&q=80&auto=format&fit=crop`. Lazy-load.
- Lisensi: placeholder Unsplash untuk pengembangan; produksi pakai foto toko.

---

### 9. Struktur kode (rencana `apps/storefront`)

Meniru `apps/web-admin`:
```
apps/storefront/
  package.json            # @app/storefront, deps: fastify, nunjucks, @app/db, @app/core…
  tsconfig.json
  src/
    server.ts             # buildApp() factory (plugins + routers) — testable
    main.ts               # start() (listen)
    auth.ts               # Telegram Login verify + token sesi (port web-admin/auth.ts)
    plugins/
      views.ts            # Nunjucks + filter money (IDR+USDT bersisian)/localdt + i18n
      auth.ts             # currentCustomer, csrfProtect
      static.ts, cookie, formbody
    routes/
      home.ts             # /
      catalog.ts          # /c/:slug, /p/:id, /search
      cart.ts             # /cart (+ HTMX partial)
      checkout.ts         # /checkout, /checkout/:code/pay
      account.ts          # /account, /orders, /wallet, /referral, /reviews
      support.ts          # /account/support
      auth.ts             # /login, /logout, telegram callback
    images.ts             # peta gambar Unsplash (§8)
  views/
    base.njk              # header toko + include _theme/_macros
    _theme.njk            # (opsi) token bersama dgn admin
    _macros.njk           # + stock_badge, stars, product_card, price
    home.njk, catalog.njk, product.njk, search.njk,
    cart.njk, checkout.njk, pay.njk,
    account.njk, orders.njk, order_detail.njk, wallet.njk,
    referral.njk, reviews.njk, support.njk, login.njk, error.njk
  static/ app.css
  test/ storefront.test.ts (+ setup-env.ts)
```
Wiring proses: tambahkan `buildApp()` storefront ke composition root
(`apps/server/src/index.ts`) — di-mount sebagai instance Fastify kedua pada
port berbeda, **atau** sebagai sub-app/prefix di Fastify yang sama. (Keputusan
§10: port terpisah lebih sederhana untuk dipisah dari admin.)

---

### 10. Keputusan terbuka (perlu konfirmasi sebelum eksekusi)

| # | Pertanyaan | Keputusan |
|---|---|---|
| A | Storefront jadi **app monorepo** (`apps/storefront`) atau **proyek terpisah** di folder WEBSITE JUALAN? | ✅ **App monorepo** (`apps/storefront`) |
| B | **Tema bersama** via partial (`_theme.njk`) atau **copy token**? | ✅ **Partial bersama** — ekstrak `_theme.njk` + macro ke `packages/web-ui/views`, kedua app `{% include %}` (loader dua-path) |
| C | Tambah kolom **`web_image_url`** ke `Product`, atau cukup peta `images.ts`? | ✅ **Tambah kolom** `web_image_url` (admin atur foto sendiri) + `images.ts` sebagai fallback Unsplash |
| D | **Keranjang tamu** (belum login) atau wajib login dulu? | ✅ **Keranjang tamu** (cookie) + **merge** ke `CartItem` saat login; katalog selalu tanpa login |
| E | **Bahasa**: dwibahasa EN+ID (i18n bot) atau English saja (seperti admin)? | ✅ **Dwibahasa** EN+ID |
| F | Proses deploy: **gabung composition root** atau service Fastify terpisah berbagi volume DB? | ✅ **Satu proses, satu Fastify**, pisah via **subdomain/prefix** (1 PrismaClient; pas Passenger) |
| G | Nama & domain toko, logo, mata uang tampil? | ✅ **Settings** (`shop_name/tagline/logo_url`, admin atur) + **env** `PUBLIC_URL` untuk domain |
| H | **Tampilan dwi-mata-uang** (IDR utama + USDT info di sampingnya) + **TokoPay** sebagai PG IDR | ✅ Ya — **satu harga pusat IDR** (sumber kebenaran), **USDT diturunkan dari kurs (`usd_idr_rate`) + sudah dibulatkan, tampil di samping IDR sebagai informasi**, **TANPA deteksi IP**. Mata uang transaksi dipilih **saat bayar**: **USDT→Binance**, **IDR→TokoPay**. Berlaku storefront + bot. Lihat §15 |
| I | **Kredensial di web-admin Settings**: token bot order + notifier + TokoPay | ✅ Ya — disimpan di `Setting` (secret write-only), DB menang atas env; token bot perlu restart + validasi `getMe`. Lihat §16 |

---

### 11. Testing & kualitas (ikut CLAUDE.md)

- **Vitest** dengan `app.inject()` (pola `web-admin/test/web.test.ts`):
  `setup-env.ts` di-import paling awal (set env + `prisma db push` ke DB temp
  sebelum `@app/*` dimuat — singleton Prisma mengikat `DATABASE_URL_PRISMA` saat
  konstruksi).
- Tiap route mutasi: trio **happy / belum-login / CSRF-salah**.
- Uji alur kritikal: tambah keranjang → checkout → order PENDING_PAYMENT dibuat,
  stok ter-reserve, **outbox terisi** (bukan kirim Telegram), audit tercatat.
- Uji verifikasi auth Telegram (hash valid/invalid).
- `pnpm -r typecheck` & `pnpm test` harus tetap hijau.

---

### 12. Tahapan eksekusi (saran urutan, setelah disetujui)

- **Fase 0 — Scaffold & tema.** Buat `apps/storefront`, port `base.njk` +
  `_macros.njk` + token, header toko, halaman kosong + login Telegram. Verifikasi
  tampil identik dengan admin.
- **Fase 1 — Katalog (read-only).** Beranda, daftar produk, detail produk, search,
  badge stok, gambar Unsplash (`images.ts`), rating/review tampil. Tanpa login.
- **Fase 2 — Akun & auth.** Login Telegram (+ onboarding parity: referral,
  bahasa, currency), sesi/cookie, `/account`, pesananku, detail pesanan
  (kredensial), referral, ulasan, support — reuse crud. _(Wallet ditunda — §17.1
  #5.)_
- **Fase 3 — Keranjang & checkout.** Keranjang tamu + merge, `CartItem`, voucher,
  diskon kuantitas, **re-validasi saat checkout** (§17.2 #3), pembuatan order
  (crud sama), halaman pembayaran **auto-confirm** (USDT: Binance UID + nominal
  unik + countdown; status via **HTMX polling**), outbox untuk notifikasi. _(Tanpa
  bayar-saldo — §17.1 #1/#5; TokoPay menyusul Fase 4.)_
- **Fase 4 — Harga IDR + USDT info & TokoPay.** Migrasi skema (`Order.currency`,
  `Order.fxRate` — **tanpa** `User.currency`) + **konversi basis USDT→IDR** & kurs
  `usd_idr_rate` (§17.2 #4), macro `price` yang **merender IDR + USDT bersisian**
  (USDT turunan + bulat, **tanpa deteksi IP**), routing bayar **dipilih saat
  bayar** (IDR→TokoPay, USDT→Binance), modul `payments/tokopay.ts` + webhook +
  idempotency, **kredensial TokoPay diatur di web-admin Settings** (bagian
  "Payments", secret write-only/redacted — §15.9), lalu cerminkan tampilan
  IDR+USDT yang sama ke bot. Detail §15.
- **Fase 5 — Wiring proses & deploy.** Gabung ke composition root / service,
  healthcheck, env (kunci TokoPay), dokumen deploy (selaras DEPLOY-HOSTINGER.md).
  Tes E2E ringan.
- **Fase 6 — Poles.** Empty/loading/error state, i18n ID lengkap, aksesibilitas,
  performa gambar, SEO dasar (title/meta/OpenGraph).

Setiap fase: tambah test, jaga typecheck hijau, audit tiap perubahan state.

---

### 13. Risiko & catatan

- **Single-writer SQLite** — dua web + bot menulis. Mitigasi: satu proses,
  transaksi pendek; pantau, siap pindah Postgres bila perlu (RUN.md §9).
- **Gambar Telegram tak terpakai di web** — sudah ditangani via Unsplash/peta.
- **Konsistensi enum & datetime** — patuhi memori `enum-storage-uppercase`
  (simpan UPPERCASE) & `datetime-storage-incompat` (DB sudah dikonversi untuk Node).
- **Jangan kirim Telegram dari web** — selalu outbox.
- **Keamanan**: storefront publik → wajib TLS + review auth; jangan bocorkan
  `file_id`/kredensial selain ke pemilik pesanan terkirim.
- **Drift tema** bila token tidak dibagikan — pilih opsi partial bersama (B).
- **Tanpa deteksi IP** — mata uang **tidak** ditentukan dari IP/geo; semua pembeli
  (web & bot) melihat IDR + USDT bersisian dan memilih saat bayar. Tak ada
  `User.currency`, tak ada ketergantungan reverse-proxy untuk geo. Lihat §15.2.
- **Mata uang dompet (wallet)** — `walletBalance` satu kolom; perlu aturan untuk
  pelanggan IDR. Lihat §15.7 (ditunda; wallet tersembunyi di web v1).
- **Webhook TokoPay** — callback publik wajib verifikasi tanda tangan +
  idempotensi (bisa dikirim berulang). Lihat §15.5.
- **Token bot di Settings = risiko brick** — token salah ⇒ bot mati; butuh
  validasi `getMe` sebelum simpan, Owner-only, restart terkontrol, & jalur
  pemulihan env. Beda dari TokoPay (token bot perlu restart, tak hot-reload).
  Lihat §16.4.

---

### 14. Ringkasan

Storefront = **wajah web dari sisi pelanggan bot**, dibangun dengan stack &
tema **identik** web-admin, **berbagi DB & crud** sehingga **stok dan semua data
otomatis sinkron** dengan bot. Bangun sebagai `apps/storefront` di monorepo,
auth via Telegram Login, gambar via `web_image_url` (admin) + Unsplash fallback,
pembayaran & order memakai alur yang sudah ada (tanpa duplikasi), notifikasi
lewat outbox. Harga **terpusat dalam IDR** dengan **USDT (bulat) tampil di
sampingnya sebagai info** (tanpa deteksi IP); pembeli memilih mata uang **saat
bayar** — **USDT via Binance**, **IDR via TokoPay** — lihat §15. Lihat
[Bagian 2 — Desain Storefront](#bagian-2--desain-storefront-spesifikasi-visual) untuk detail visual.

> **Status: rancangan — belum dieksekusi.** Menunggu keputusan §10 (sisa B/D/F/G)
> sebelum mulai.

---

### 15. Harga pusat IDR + USDT info & TokoPay — keputusan H

Keputusan: **(1) SATU harga pusat = Rupiah** (sumber kebenaran). **(2) USDT
diturunkan otomatis dari kurs, sudah dibulatkan, dan ditampilkan di samping
harga IDR sebagai informasi** untuk semua pembeli — **bukan** mata uang
per-pembeli dan **TANPA deteksi IP**. **(3) Mata uang transaksi dipilih saat
membayar**: **USDT hanya via Binance**, **selain itu (IDR) via TokoPay**.
**(4) Berlaku di storefront + bot** (keduanya menampilkan IDR + USDT bersisian).

#### 15.1 Model harga — satu harga pusat IDR, USDT tampil di samping (REVISI)
> Revisi: **tanpa deteksi IP** dan **bukan satu mata uang per-pembeli**. Admin
> **hanya mengisi harga Rupiah** (harga pusat = sumber kebenaran). Nilai **USDT
> dihitung otomatis** dari kurs, **dibulatkan**, dan **ditampilkan di samping
> harga IDR sebagai informasi** untuk semua pembeli. Mata uang transaksi dipilih
> **saat membayar** (USDT→Binance, IDR→TokoPay). Tidak ada kolom harga ganda.

- **Basis sistem = IDR.** `Product.price` (dan `resellerPrice`) **berisi
  Rupiah** — satu sumber kebenaran. Tidak ada `priceIdr` terpisah.
- **Kurs di Settings (web-admin)**: key `usd_idr_rate` = **Rupiah per 1 USDT**
  (mis. `16000`). Diatur admin (lihat §16.1), bukan API FX live (sederhana &
  terprediksi; auto-update bisa menyusul).
- **USDT diturunkan**: `usdt = idrPrice / usd_idr_rate`, lalu **dibulatkan ke 0,1
  terdekat (1 desimal)**. Contoh: kurs 16.000, Rp40.000 → `2.5`; `2.453 → 2.5`.
  Nilai bulat inilah yang **tampil di samping IDR** dan yang **ditagih Binance**
  bila pembeli memilih bayar USDT. (Opsi tak pernah _undercharge_: bulatkan **ke
  atas** ke 0,1 — keputusan kecil §15.8; default: 0,1 terdekat.)
- **Pembulatan hanya untuk USDT.** IDR ditampilkan apa adanya (harga pusat, bulat).
- **Selalu tampil berdampingan.** Tiap harga muncul `Rp40.000` dengan `≈ $2,5`
  (USDT) di sampingnya — **di storefront maupun bot**. Tidak ada pemilihan mata
  uang tampilan; keduanya selalu terlihat. Pembeli memilih mata uang **hanya saat
  bayar**, bukan saat melihat katalog.

**Perubahan skema:**
```
// Reinterpretasi: Product.price / resellerPrice kini menyimpan IDR (bukan USDT).
Order.currency  String  @default("IDR")  // mata uang transaksi: "IDR" | "USDT" — dipilih saat bayar
Order.fxRate    Decimal?  // snapshot kurs saat currency=USDT (audit & histori tak berubah bila kurs diubah)
Setting "usd_idr_rate"    // kurs (Rupiah per 1 USDT), diatur di web-admin
```
- **`User.currency` DIHAPUS dari rencana** — tak ada preferensi mata uang
  per-user (tak ada deteksi IP; semua melihat IDR + USDT bersisian). Mata uang
  hanya melekat ke **order** sesuai metode bayar yang dipilih.
- **Order menyimpan mata uang transaksi + snapshot kurs.** Bayar TokoPay → order
  `IDR` (jumlah = harga pusat, eksak). Bayar Binance → order `USDT` dengan
  `totalAmount` = nilai USDT **yang sudah dibulatkan** (yang benar-benar ditagih
  Binance) + `fxRate` tersimpan. Jadi perubahan kurs **tak mengubah order lama**.
- **DIHAPUS dari rencana lama**: kolom `priceIdr` / `resellerPriceIdr` (satu harga
  saja) **dan** `User.currency` (tak ada deteksi/preferensi mata uang per-user).

**⚠ Implikasi migrasi (penting — basis berubah USDT → IDR):**
- Saat ini `price` bermakna USDT & bot menampilkannya sebagai `$`. Mengubah basis
  ke IDR berarti **mengonversi nilai katalog yang ada** (`price`, `resellerPrice`,
  bulk pricing, voucher nominal-tetap) **× kurs** saat cutover, dan **mengubah
  logika tampilan bot** agar membaca `price` sebagai IDR + menurunkan USDT
  (ditampilkan di samping IDR). Ini bagian dari scope "storefront + bot". Detail
  langkah cutover di §17.2 #4.
- Order/wallet **historis** (pra-kolom `currency`) dianggap USDT & dibiarkan apa
  adanya (snapshot). Saldo wallet (USDT) tersembunyi di web v1 (§17.1 #5) — aturan
  konversi wallet → IDR ditunda (keputusan terpisah saat fitur wallet web dibuat).

#### 15.2 Penentuan mata uang — TANPA deteksi IP
- **Tidak ada deteksi IP / geolokasi sama sekali.** Tidak memakai `CF-IPCountry`,
  **MaxMind GeoLite2**, maupun `trustProxy` untuk tujuan geo. Tidak ada
  `User.currency`, tidak ada cookie mata uang, tidak ada "tombol ganti mata uang".
- **Tampilan selalu sama untuk semua pembeli**: harga pusat **IDR** sebagai angka
  utama, dengan **USDT (sudah dibulatkan) sebagai info di sampingnya**. Berlaku di
  katalog, detail produk, keranjang, dan ringkasan checkout.
- **Mata uang ditentukan hanya saat membayar**, bukan saat melihat: di halaman
  bayar, pembeli memilih **metode pembayaran**, dan metode itulah yang menetapkan
  `Order.currency`:
  - Pilih **bayar USDT (Binance)** → order `USDT` (jumlah = USDT bulat).
  - Pilih **bayar Rupiah (TokoPay)** → order `IDR` (jumlah = harga pusat eksak).
- Karena tak ada IP, **tak ada masalah reverse-proxy/VPN/WNI-di-luar-negeri** —
  semua orang melihat keduanya dan bebas memilih saat bayar.

#### 15.3 Bot Telegram — sama persis
Tanpa deteksi IP, bot **tak perlu** logika khusus. Aturan bot **identik** dengan
web:
- Bot menampilkan harga **IDR + USDT bersisian** (kurs yang sama, `usd_idr_rate`).
- Saat checkout/bayar, pembeli memilih **Binance (USDT)** atau **TokoPay (IDR)**;
  pilihan itu menetapkan `Order.currency`.
- Tidak ada lagi pembacaan/fallback `User.currency` atau menu "ganti mata uang".
  Storefront & bot **otomatis konsisten** karena keduanya menampilkan hal yang
  sama dan menunda pemilihan mata uang sampai pembayaran.

#### 15.4 Routing pembayaran (dipilih pembeli saat bayar)
| Metode dipilih → `Order.currency` | Jumlah ditagih | Gateway | Mekanisme konfirmasi |
|---|---|---|---|
| Rupiah → `IDR` | harga pusat (eksak) | **TokoPay** (baru) | QRIS / VA / e-wallet; konfirmasi via **callback webhook** |
| USDT → `USDT` | nilai USDT **dibulatkan** (§15.1) | **Binance** (existing) | Binance Internal (UID) + nominal unik; auto-confirm poller |
- **USDT hanya bisa dibayar via Binance**; semua metode lain (QRIS/VA/e-wallet)
  lewat **TokoPay** dalam Rupiah. Tidak ada gateway USDT selain Binance.
- `uniqueCents` (pencocokan nominal) hanya relevan untuk jalur USDT/Binance.
- Web = **auto-confirm saja** (tanpa upload bukti — §17.1 #1).
- Halaman bayar berbeda tampilan per gateway (design.md §8b).

#### 15.5 Integrasi TokoPay (PG IDR)
Pola seperti poller Binance Internal, tapi **didorong webhook**:
- **Modul** `apps/storefront/src/payments/tokopay.ts`:
  - `createTransaction(order)` → panggil API TokoPay (merchant id + secret),
    dapat **QR/VA/checkout URL** + ref; simpan ref di `Order.paymentRef`.
  - `verifyCallback(body, sig)` → verifikasi **tanda tangan** (signature) TokoPay.
- **Route webhook** publik (mis. `POST /pay/tokopay/callback`) — verifikasi
  signature **sebelum** apa pun; balas cepat 200.
- **Idempotensi** (callback bisa berulang): ledger seperti `ProcessedBinanceTx`,
  usul tabel baru `ProcessedTokopayTx { ref UNIQUE, orderId, amount, outcome }`.
  Insert-first-on-unique sebagai pengaman (SQLite tanpa row lock — pola yang sama
  dengan Binance, lihat memori `binance-internal-transfer`).
- **Konfirmasi sukses** → tandai order `PAID/DELIVERED` lewat **crud yang sama**
  (dalam `$transaction`), lalu **enqueue outbox** (web tak kirim Telegram) →
  notifier/bot kirim kredensial.
- **Kredensial dari web-admin Settings (bukan env)** — lihat §15.9.
- **Catatan verifikasi**: detail endpoint/format signature TokoPay **belum
  diverifikasi** dari dokumentasi resmi — wajib dicek saat implementasi
  (tandai sebagai asumsi, sama seperti catatan Binance).

#### 15.9 Kredensial TokoPay diatur di web-admin (disatukan dgn setelan bayar)
Permintaan: TokoPay **bisa di-set manual di web-admin**, **menyatu** dengan
setelan pembayaran lain (`binance_pay_id`, `qr`). Pola yang sudah ada:
`apps/web-admin/src/routes/settings.ts` punya whitelist `EDITABLE` + bagian
"Shop options" di `settings.njk`. Rencana:

- **Key baru di `Setting`** (whitelist `EDITABLE`), runtime dibaca via
  `getSetting(prisma, …)`:
  - `tokopay_merchant_id` — id merchant (tak terlalu rahasia, boleh tampil).
  - `tokopay_secret` — **secret/private key (RAHASIA)**.
  - `tokopay_enabled` — "true"/"false" untuk menyalakan jalur Rp (opsional).
  - (opsional) `tokopay_default_channel` — QRIS / VA / dll.
- **Kelompokkan UI**: di `settings.njk`, buat sub-bagian **"Payments"** yang
  menyatukan `binance_pay_id`, `qr`, dan key TokoPay di atas (bukan tercecer di
  daftar field generik) — sekaligus merapikan setelan bayar yang sudah ada.
- **Penanganan secret (WAJIB — `tokopay_secret`)**, karena UI sekarang
  menampilkan nilai apa adanya & mengaudit nilainya:
  1. Perlakukan seperti secret: **jangan echo nilainya** kembali ke input
     (tampilkan sebagai field kosong berlabel **"●●● tersimpan"** bila sudah ada,
     kosongkan = tidak diubah) — **write-only**.
  2. **Sembunyikan dari tabel "All saved options"**: tambahkan ke daftar
     `SECRET_PREFIXES`/`isSecret()` agar tampil `(hidden)`.
  3. **Audit tanpa nilai**: pada `setting_set`, untuk key secret catat
     `tokopay_secret=(updated)` — **bukan** isinya (CLAUDE.md: never log secrets).
  4. Idealnya **enkripsi at-rest** (mis. dengan `WEB_COOKIE_SECRET`/kunci app)
     sebelum simpan ke `Setting`; minimal pastikan poin 1–3.
- **Runtime**: modul `payments/tokopay.ts` baca kredensial dari Settings saat
  perlu. Bila `tokopay_secret`/`merchant_id` kosong atau `tokopay_enabled=false`
  → jalur pembayaran Rp **nonaktif** (checkout IDR tampilkan "pembayaran Rupiah
  belum aktif"), tanpa mematikan jalur $/Binance.
- **Konsekuensi**: ini **menyentuh web-admin yang sudah live** (tambah key +
  bagian Payments + logika secret di `settings.ts`/`settings.njk`). Masuk Fase 4;
  jaga test web-admin tetap hijau (ada test yang meng-_assert_ redaksi secret).

#### 15.6 Tampilan harga (lihat juga design.md §8b)
- Konversi: USDT = `round(idrPrice / usd_idr_rate, 0,1 terdekat)`. Lakukan
  konversi **sekali per harga yang ditampilkan** (atau total order), bukan
  per-komponen, agar tak ada selisih pembulatan ganda.
- **Tampilan berdampingan (default & satu-satunya)**: IDR sebagai angka utama,
  USDT sebagai info di sampingnya — mis. `Rp79.000  ≈ $4,9`. Helper/macro `price`
  merender **keduanya sekaligus**; tak ada filter "sadar mata uang per-pembeli"
  karena tak ada preferensi per-user.
  - Format IDR → `Rp79.000` (tanpa desimal, pemisah ribuan titik — konvensi ID).
  - Format USDT → `$4,9` (sudah dibulatkan ke 0,1; 1–2 desimal, mis. `$2,50`).
- Admin mengisi **harga Rupiah saja**; UI admin boleh tampilkan **preview USDT
  (read-only)** dari kurs — sama dengan yang dilihat pembeli.
- Diskon kuantitas & voucher **persen** bekerja relatif (sama untuk kedua angka).
  Voucher **nominal tetap** disimpan dalam **IDR (basis)**; nilai USDT yang tampil
  di sampingnya & yang ditagih Binance dikonversi + dibulatkan sama seperti harga.

#### 15.7 Hal yang perlu aturan (sub-keputusan kecil saat eksekusi)
1. **Pembulatan total vs per-item**: untuk order USDT, bulatkan **total order**
   sekali di akhir (rekomendasi) agar konsisten dengan yang ditagih Binance, dan
   tampilkan USDT per-item sebagai turunan (boleh ada selisih sen kecil yang
   dijelaskan oleh pembulatan total). Tetapkan satu cara & konsisten.
2. **Wallet/saldo**: tersembunyi di web v1 (§17.1 #5); aturan basis wallet
   (USDT→IDR) ditunda ke saat fitur wallet web dibuat.
3. **Reseller**: `resellerPrice` (kini IDR) → USDT diturunkan sama seperti `price`.

#### 15.8 Sisa keputusan kecil (bisa diputuskan saat eksekusi)
- **Arah pembulatan USDT**: 0,1 **terdekat** (default, sesuai contoh `2.453→2.5`)
  atau **ke atas** (agar tak pernah undercharge)? (usul: terdekat)
- **Kurs**: manual di Settings (default) — apakah perlu auto-update FX nanti?
- Apakah perlu menyimpan **kurs referensi** untuk laporan admin (mencampur Rp & $
  di `/reports`)? Reports lintas-mata-uang perlu sikap: pisah per mata uang
  **atau** konversi ke satu mata uang pelaporan (butuh kurs). (usul: pisah per
  mata uang dulu.)

---

### 16. Kredensial terpusat di web-admin (token bot, notifier, TokoPay)

Permintaan: **semua kredensial sensitif** — **token bot order**, **token
notifier**, dan **kredensial TokoPay** — bisa **di-set manual di web-admin**,
menyatu dengan setelan pembayaran. Tujuannya satu tempat, tanpa edit `.env` /
redeploy.

#### 16.1 Daftar key di `Setting` (whitelist `EDITABLE`)
| Key | Isi | Rahasia? |
|---|---|---|
| `bot_token` | Token bot order (BotFather) | ✅ secret |
| `bot_username` | Username bot (untuk deep-link/referral) — atau auto via `getMe` | tidak |
| `notif_bot_token` | Token bot notifier (opsional; kosong = pakai bot utama) | ✅ secret |
| `tokopay_merchant_id` | Merchant TokoPay | tidak |
| `tokopay_secret` | Secret/private key TokoPay | ✅ secret |
| `tokopay_enabled` | "true"/"false" jalur Rp | tidak |
| `binance_pay_id` | (sudah ada) | tidak |
| `usd_idr_rate` | Kurs Rupiah per 1 USD (mis. `16000`) — basis konversi harga USD (§15.1) | tidak |

Semua key **secret** memakai penanganan yang **sama persis** dengan §15.9
(write-only / "●●● tersimpan", `isSecret()` → `(hidden)` di tabel, audit
`key=(updated)` tanpa nilai, idealnya enkripsi at-rest). Dikelompokkan di UI:
sub-bagian **"Bot & Notifications"** (token) + **"Payments"** (Binance/TokoPay).

#### 16.2 PERBEDAAN PENTING: hot-reload vs perlu restart
| Kredensial | Kapan dibaca | Ganti nilai → efek |
|---|---|---|
| `tokopay_*` | **Tiap request** (stateless) | **Langsung berlaku**, tanpa restart |
| `bot_token` / `notif_bot_token` | **Sekali saat boot** (membangun instance grammY `Bot`) | **Perlu restart** bot/proses agar berlaku |

grammY `Bot` dibangun sekali di composition root (`buildBot()` dipanggil dari
`apps/server/src/index.ts` setelah `initDb()`). Token tak bisa di-_hot-swap_ di
bot yang sedang berjalan → mengganti token = **restart terkontrol**.

#### 16.3 Cara sumber token dipindah dari env → DB (dengan fallback)
- Saat boot, `start()` (sesudah `initDb()`) **baca `bot_token` dari `Setting`**,
  **fallback ke `BOT_TOKEN` env** bila kosong, lalu **teruskan ke `buildBot(token)`**
  (refactor: `buildBot()` terima token sbg argumen, bukan baca `config` langsung).
  Sama untuk `notif_bot_token`.
- **Zod config** (`@app/core/config`) `BOT_TOKEN`/`BOT_USERNAME` jadi **opsional**
  (bukan required) karena sumber utamanya kini DB. `bot_username` bisa
  **otomatis** dari `bot.api.getMe()` saat boot, jadi tak wajib diisi manual.
- **Bootstrap (instalasi baru / DB kosong)**: bila `Setting` & env dua-duanya
  kosong → **bot tidak start** (web tetap jalan); tampilkan banner admin
  "Token bot belum diisi → Settings". Set token → restart → bot hidup.

#### 16.4 Pengaman "jangan brick the bot" (WAJIB)
Menyimpan token bot di setelan yang bisa diedit = kuat tapi **berisiko** (token
salah ⇒ bot mati). Mitigasi:
1. **Validasi sebelum simpan**: saat admin submit `bot_token`, panggil
   `new Bot(token).api.getMe()` dulu; tolak & beri pesan bila gagal. Cegah token
   ngawur tersimpan.
2. **Owner-only**: edit token dibatasi role **super/Owner** (cek `admin.role`),
   bukan support/readonly.
3. **Restart terkontrol**: setelah simpan token valid, beri aksi/instruksi
   **restart**. Di Hostinger Passenger: sentuh `tmp/restart.txt` (memori
   `hostinger-node-app-deploy`); atau tombol "Terapkan & mulai ulang bot" yang
   memicu graceful restart proses. Jangan diam-diam — kasih tahu admin efeknya.
4. **Jalur pemulihan via env tetap ada**: bila bot ter-_brick_ dari DB, set
   `BOT_TOKEN` di env + restart akan menyelamatkan (env = fallback, tapi DB
   menang bila terisi — atau sebaliknya; tentukan prioritas & dokumentasikan).
5. **Audit** `setting_set` tanpa nilai token; **jangan pernah** log token
   (CLAUDE.md).

#### 16.5 Catatan & risiko
- Ini **menyentuh kode inti** (`@app/core/config`, `apps/server` boot,
  `apps/order-bot/main.buildBot`, `apps/web-admin/settings`) — bukan hanya
  storefront. Jadwalkan di **Fase 5 (wiring proses & deploy)**; jaga seluruh
  test (`pnpm -r typecheck && pnpm test`) hijau — beberapa test bot/wiring set
  `BOT_TOKEN` env, harus tetap kompatibel (fallback env menjaga ini).
- **Prioritas DB vs env** harus ditetapkan eksplisit dan konsisten untuk ketiga
  token + pembayaran (usul: **DB menang bila terisi, else env** — supaya web-admin
  jadi sumber kebenaran, env hanya bootstrap/pemulihan).
- Token notifier mengikuti pola yang sama; kosong = pakai bot utama (perilaku
  existing di `startNotifier`).

---

### 17. Open items & hardening (pra-eksekusi)

Hal yang sudah otomatis aman karena **satu proses + DB bersama**: **kedaluwarsa
order** ditangani croner job (`listExpiredPendingOrders` → `cancelOrder` yang
melepas stok RESERVED + refund wallet + rollback voucher) — order web ikut tanpa
kode baru. Sisanya di bawah.

#### 17.1 Keputusan yang sudah diambil
- **#1 Bukti bayar web = AUTO-CONFIRM SAJA** (tanpa upload bukti manual di web):
  - **USDT** → **Binance Internal Transfer (UID)** → poller `binanceInternal`
    konfirmasi otomatis.
  - **IDR** → **TokoPay** → webhook callback konfirmasi otomatis.
  - **Konsekuensi**: pembeli **USDT di web tidak punya jalur "bayar lalu kirim
    bukti"** — hanya metode auto-confirm. Alur Binance Pay manual + upload bukti
    (`paymentProofFileId`) **tetap ada di bot**, tak diubah. Admin tak perlu
    review manual untuk order web. Halaman bayar web tampilkan instruksi
    UID/QRIS + status menunggu (lihat 17.2).
- **#5 Wallet/saldo DISEMBUNYIKAN di web v1**:
  - Tidak ada menu Saldo di web; **checkout web tidak memakai wallet** (tanpa
    "pakai saldo", tanpa potong saldo) — pembayaran murni lewat gateway.
  - Saldo tetap berfungsi di backend (referral/admin tetap mengkredit); pelanggan
    mengelolanya **lewat bot**. Ini **membatalkan kerumitan §15.7 wallet-untuk-USD
    di web** (tak relevan karena wallet tak tampil di web v1).
  - Menu **Referral tetap tampil** (kode + link) walau saldo komisi dilihat di bot.

#### 17.2 To-do desain yang masih perlu dimatangkan (punya default)
| # | Item | Default/rekomendasi |
|---|---|---|
| 2 | **Status bayar real-time** di halaman `/checkout/:code/pay` | **HTMX polling** status order tiap ~5 dtk → otomatis berubah "Lunas → kredensial muncul"; + countdown dari `expiresAt` (client-side). |
| 3 | **Re-validasi saat checkout** (produk nonaktif/stok habis/harga berubah/voucher kedaluwarsa/bulk) | Recompute via crud yang sama **tepat sebelum buat order**; bila berubah → tahan + tampilkan pesan jelas, jangan diam-diam pakai harga lama. |
| 4 | **Migrasi skema live + konversi basis USDT→IDR** (`Order.currency`, `Order.fxRate`, `web_image_url` + reinterpretasi `price`/`resellerPrice` jadi IDR — **tanpa** `User.currency`) | `prisma db push` ke DB live **+ restart bot SEBELUM kode baru** (risiko `P2022`). **Konversi data**: kalikan harga katalog yang ada (`price`, `resellerPrice`, bulk, voucher nominal) **× kurs awal** sekali, set `usd_idr_rate`, lalu ubah logika tampilan bot jadi IDR-basis **+ USDT info di samping**. Order/wallet historis dibiarkan (snapshot USDT). **Tulis langkah cutover + backup di RUN.md; uji di DB salinan dulu.** |
| 6 | **Keamanan publik** (storefront menghadap internet; admin bind 127.0.0.1) | Rate limit (login/order/add-to-cart), cek freshness `auth_date` + anti-replay Telegram Login, CSRF form publik, `trustProxy` benar, review header keamanan. Satu pass khusus sebelum go-live. |
| 7 | **Onboarding parity** saat login web pertama | Tangkap referral (`?ref=`/`start=`), set bahasa, welcome — samakan dengan `/start` bot agar user web tak "kelas dua". (Tak ada set currency/IP — harga selalu IDR + USDT bersisian.) |
| 8 | **Gambar skala + SEO** | Produksi: download/self-host gambar (kolom `web_image_url` membantu), jangan hotlink Unsplash di skala. SEO: title/meta/OG/sitemap/robots/canonical (admin tak perlu, toko perlu). |

#### 17.3 Minor / operasional (catat saja)
- **Filter review `hidden`** — storefront hanya tampilkan review yang **tidak**
  disembunyikan (kolom `hidden` sudah ada).
- **Tag sumber order** (web vs bot) — opsional, berguna untuk analitik admin.
- **Non-teknis**: S&K / kebijakan refund di halaman statis; **verifikasi bisnis
  TokoPay (KYB)** yang biasanya disyaratkan PG Indonesia (di luar lingkup kode,
  tapi blocker go-live IDR).

---

## Bagian 2 — Desain Storefront (Spesifikasi Visual)

> Dokumen desain untuk **toko online (storefront)** yang dipakai **pelanggan**.
> Tujuannya: tampil **konsisten 1:1** dengan web-admin yang sudah ada
> (`BOT dan Web Admin/apps/web-admin`) — tema **"Clean Modern"** — tetapi
> di-_adaptasi_ untuk pengalaman belanja (hero, grid produk, gambar, keranjang,
> checkout). Storefront berbagi database & stok yang sama dengan bot Telegram,
> jadi yang berubah hanya **tampilan**, bukan datanya.
>
> Implementasi belum dikerjakan. Lihat [Bagian 1 — Rencana Storefront](#bagian-1--rencana-storefront-arsitektur--rencana) untuk arsitektur &
> tahapan. Dokumen ini hanya **spesifikasi desain**.

---

### 1. Prinsip desain

1. **Satu bahasa visual dengan admin.** Token warna, font, radius, shadow, dan
   komponen (`.card`, `.btn`, `.chip`, `.field`, `.data-table`) **identik** dengan
   `apps/web-admin/views/base.njk`. Kalau admin diganti temanya, storefront ikut
   berubah dari token yang sama.
2. **Bahasa polos, tanpa jargon.** Sama seperti aturan admin (memori
   `web-admin-plain-language`): tidak ada istilah teknis. "Stok habis", bukan
   "OUT_OF_STOCK". "Pesananku", bukan "ORDER #". Storefront ditujukan untuk
   pelanggan awam.
3. **Belanja itu visual.** Berbeda dari admin yang padat tabel, storefront
   mengutamakan **gambar produk, kartu, dan ruang putih**. Gambar memakai
   **Unsplash** (pihak ketiga) yang gampang diganti nanti (lihat §7).
4. **Mobile-first.** Mayoritas pembeli buka dari HP (kebanyakan datang dari link
   bot Telegram). Layout default 1 kolom, naik ke grid di layar lebar.
5. **Stok jujur & real-time.** Karena DB-nya sama dengan bot, jumlah stok yang
   tampil = stok asli. Tampilkan badge stok di setiap kartu produk; jangan biarkan
   orang checkout barang yang sudah habis.
6. **Cepat, ringan, tanpa build berat.** Ikuti admin: Tailwind via CDN + HTMX,
   bukan SPA. Halaman server-rendered (Nunjucks) supaya ringan & SEO-friendly.

---

### 2. Design tokens (disalin persis dari web-admin)

Sumber kebenaran: `apps/web-admin/views/base.njk` (Tailwind config inline). Nilai di
bawah **harus sama** supaya dua web kelihatan satu keluarga. Nama token tetap
(`pine` sekarang membawa warna biru — jangan diganti namanya).

#### Warna

| Token | Hex | Pakai untuk |
|---|---|---|
| `paper` | `#f6f8fb` | Latar halaman (off-white sejuk) |
| `card` | `#ffffff` | Permukaan kartu |
| `sand` | `#eef1f6` | Latar hover / header tabel |
| `line` | `#e3e8ef` | Garis & border |
| `ink` | `#1b2330` | Teks utama |
| `ink.soft` | `#5a6473` | Teks sekunder |
| `ink.faint` | `#97a1b1` | Teks samar / placeholder |
| `pine` (brand) | `#2563eb` | Aksen utama, tombol, link, harga aktif |
| `pine.dark` | `#1d4ed8` | Hover tombol primer |
| `pine.tint` | `#e6effe` | Latar lembut / chip brand |
| `grass` | `#16a34a` | Sukses / "Tersedia" / "Lunas" |
| `grass.tint` | `#e7f6ec` | Latar badge sukses |
| `amberx` | `#b45c0a` | Peringatan / "Menunggu pembayaran" / stok menipis |
| `amberx.tint` | `#fdedcf` | Latar badge peringatan |
| `rust` | `#dc2626` | Bahaya / "Stok habis" / batal |
| `rust.tint` | `#fde7e7` | Latar badge bahaya |

**Arti warna status** (sama dengan macro `status_badge` admin):
hijau = baik/selesai/tersedia · biru = menunggu/info · amber = perlu perhatian ·
merah = berhenti/habis/batal.

#### Tipografi

Google Fonts (preconnect sama seperti admin):

- **Outfit** (`font-display`) — judul (`h1/h2/h3`), nama produk, harga besar.
- **Manrope** (`font-sans`) — teks isi, deskripsi, label.
- **JetBrains Mono** (`font-mono`) — kode pesanan, kredensial, ID, angka txid.

Skala (ikut admin): `.page-title` = `text-3xl font-semibold tracking-tight`;
`.section-title` = `text-lg font-semibold`; body = `text-sm`.

#### Bentuk & bayangan

- Radius: kartu `rounded-2xl` (1rem) / token `xl2` (1.25rem) untuk panel besar;
  tombol `rounded-xl`; chip `rounded-full`.
- Shadow: `shadow-soft` (kartu diam), `shadow-lift` (dropdown, kartu hover,
  cart drawer).

#### Ikon

**Lucide** (`https://unpkg.com/lucide`), sama dengan admin. Ikon mewarisi
`currentColor`. Beberapa yang relevan untuk storefront:
`store, shopping-cart, shopping-bag, package, search, heart, star, wallet,
truck, shield-check, badge-check, bell, user, log-in, chevron-right, filter,
tag, ticket-percent, life-buoy, gift`.

---

### 3. Komponen yang dipakai ulang dari admin

Salin/port langsung dari `base.njk` `<style type="text/tailwindcss">` &
`_macros.njk` agar identik:

- `.card`, `.card-pad` — permukaan utama.
- `.btn`, `.btn-primary`, `.btn-soft`, `.btn-ghost`, `.btn-danger`, `.btn-sm`.
- `.field`, `.field-label` — input & form.
- `.chip` + macro `status_badge(value)` — badge status (pesanan, stok).
- `.link`, `.codeish` — link & teks kode (mono).
- `.stat-label/.stat-value/.stat-sub` — kartu angka (dipakai di halaman Akun).
- macro `flash(message, kind)`, `empty_row(cols, msg)`, `csrf_field(admin)`,
  `ic(name, cls)`.

> Cara teknis menjaga konsistensi: idealnya komponen ini diekstrak ke satu file
> partial bersama yang di-_include_ kedua app. Lihat [Bagian 1 §6](#bagian-1--rencana-storefront-arsitektur--rencana) (opsi
> "shared theme partial"). Minimal: copy nilai token & blok `@layer components`
> apa adanya.

---

### 4. Komponen baru khusus storefront

Komponen di bawah **memakai token yang sama**, tapi belum ada di admin.

#### 4.1 Header toko (storefront nav)
Berbeda dari nav admin (yang penuh menu manajemen). Header toko ringkas:

```
┌────────────────────────────────────────────────────────────────┐
│ 🛍 NamaToko        [ cari produk… 🔍 ]      Akun▾   🛒 Keranjang(2)│
└────────────────────────────────────────────────────────────────┘
```
- Kiri: logo + nama toko (ikon `store`, warna `pine`) — sama gaya brand admin.
- Tengah: search bar (`.field` + ikon `search`), submit ke `/search`.
- Kanan: tombol **Keranjang** (ikon `shopping-cart` + badge jumlah `chip
  bg-pine text-white`), menu **Akun** (jika login: nama + avatar; jika belum:
  tombol **Masuk** via Telegram).
- Sticky, `bg-card/85 backdrop-blur border-b border-line` (persis admin).
- Mobile: search jadi baris kedua / ikon yang membuka overlay; menu jadi
  bottom-bar opsional (Beranda · Cari · Keranjang · Akun).

#### 4.2 Kartu produk (`.product-card`)
Inti storefront. Grid `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4`.

```
┌──────────────────┐
│  [ gambar 4:3 ]  │ ← Unsplash, object-cover, rounded-t-2xl
│                  │
├──────────────────┤
│ Netflix 1 Bulan  │ ← font-display, text-sm font-semibold, truncate 2 baris
│ Streaming        │ ← text-ink-faint text-xs (kategori)
│ ★ 4.8 · terjual…│ ← rating (grass/amber) + sosial proof (opsional)
│                  │
│ $5.00   [Tersedia]│ ← harga (pine, font-display) + badge stok
│      [ + Keranjang ]│ ← .btn-primary .btn-sm  (atau "Beli")
└──────────────────┘
```
- Hover: `shadow-lift` + sedikit translate-y (micro-interaction).
- Badge stok pakai `status_badge`: `available`→hijau "Tersedia",
  stok≤ambang→amber "Sisa N", 0→merah "Habis" (tombol jadi **Kabari saat
  ready** / restock).
- Harga reseller hanya tampil bila user login sebagai reseller (`User.role`).

#### 4.3 Badge stok (`stock_badge(count, lowThreshold)`)
Macro baru di atas `status_badge`:
- `count > low` → chip hijau "Tersedia".
- `0 < count ≤ low` → chip amber "Sisa {count}".
- `count == 0` → chip merah "Stok habis".

#### 4.4 Price tag (`.price`)
`font-display font-semibold text-pine`. Varian: harga coret (`line-through
text-ink-faint`) saat ada diskon kuantitas/voucher. **Selalu IDR + USDT
bersisian**: `Rp79.000` sebagai angka utama dengan `≈ $4,9` (USDT turunan kurs,
sudah dibulatkan — §8b) sebagai info di sampingnya, untuk **semua** pembeli.

#### 4.5 Cart drawer / panel keranjang
Panel kanan `shadow-lift` (HTMX swap), atau halaman `/cart` penuh:
```
Keranjang (2)                                   ✕
─────────────────────────────────────────────
[img] Netflix 1 Bulan        $5.00   [- 1 +]  🗑
[img] Spotify 3 Bulan        $9.00   [- 1 +]  🗑
─────────────────────────────────────────────
Subtotal                               $14.00
Punya kode diskon? [______]  [Pakai]
─────────────────────────────────────────────
        [   Lanjut ke pembayaran →   ]
```
Item = `CartItem` (sudah ada di DB, keyed by `userId`). Update qty/hapus via
HTMX → kembalikan partial panel.

#### 4.6 Langkah checkout (stepper)
Chip langkah memakai `pine`/`grass`:
`(1) Keranjang → (2) Pembayaran → (3) Selesai`. Step aktif `bg-pine text-white`,
selesai `bg-grass-tint text-grass-dark`, depan `bg-sand text-ink-soft`.

#### 4.7 Rating bintang (`stars(rating)`)
5 ikon `star`; terisi `text-amber-400 fill-current`, kosong `text-line`.
Dipakai di kartu & detail produk (rata-rata dari tabel `Review`).

#### 4.8 Hero / banner beranda
Banner lebar (`rounded-2xl overflow-hidden`) dengan gambar Unsplash + overlay
gelap lembut + judul `font-display text-3xl/4xl text-white` + sub + tombol CTA
`.btn-primary`. Catatan: bot sudah punya fitur **banner_image** (memori
`bot-banner-feature`) — storefront sebaiknya pakai sumber gambar yang sama bila
nanti diisi admin; default-nya Unsplash (lihat §7).

#### 4.9 Category pills
Baris chip bisa di-scroll horizontal untuk filter kategori:
`chip` aktif `bg-pine text-white`, lainnya `bg-sand text-ink-soft hover:bg-pine-tint`.
Sumber: tabel `Category` (yang `isActive`), urut `sortOrder`, ikon dari `emoji`.

---

### 5. Peta halaman & layout

Semua halaman extend `base.njk` (versi storefront, header toko menggantikan nav
admin). Lebar konten `max-w-6xl mx-auto px-4`. Grid produk boleh `max-w-7xl`.

| Route | Halaman | Isi utama |
|---|---|---|
| `/` | **Beranda** | Hero · category pills · "Terlaris"/"Baru" (grid produk) · banner promo |
| `/c/:slug` atau `/?cat=` | **Daftar produk** | Filter kategori + urut (harga/terbaru) · grid produk · paginasi |
| `/p/:id` | **Detail produk** | Galeri gambar · nama/harga/badge stok · deskripsi · garansi · diskon kuantitas · rating + review · tombol Beli/Keranjang · "Kabari saat ready" |
| `/search?q=` | **Hasil cari** | Reuse grid produk |
| `/cart` | **Keranjang** | Daftar item · kode diskon · ringkasan · CTA checkout |
| `/checkout` | **Checkout** | Stepper · ringkasan (IDR + USDT bersisian) · **pilih metode bayar** yang menetapkan mata uang (USDT→Binance UID, IDR→TokoPay) · **tanpa saldo** (wallet ditunda, plan.md §17.1) |
| `/checkout/:code/pay` | **Pembayaran** | USDT: instruksi Binance Internal (UID + nominal unik) · IDR: QRIS/VA TokoPay · countdown · **status auto-confirm via HTMX polling** (tanpa upload bukti) |
| `/account` | **Akun** | Kartu ringkas (jml pesanan, kode referral) · menu |
| `/account/orders` | **Pesananku** | Daftar pesanan + status (`status_badge`) |
| `/account/orders/:code` | **Detail pesanan** | Item · status · **kredensial** (mono, tombol salin) bila DELIVERED · garansi · ajukan komplain/ganti |
| ~~`/account/wallet`~~ | **Saldo** | _ditunda web v1 — kelola via bot (plan.md §17.1 #5)_ |
| `/account/referral` | **Referral** | Kode + link bagikan (komisi dilihat di bot) |
| `/account/reviews` | **Ulasanku** | Beri/ubah ulasan untuk pesanan terkirim |
| `/account/support` | **Bantuan** | Daftar tiket + buat tiket baru (`SupportTicket`) |
| `/login` | **Masuk** | Tombol **Login with Telegram** (widget) |
| `/about`, `/terms` | Statis | Info toko, S&K (opsional) |

#### Wireframe detail produk (acuan)
```
┌───────────────────────┐   Netflix Premium — 1 Bulan
│                       │   Streaming · ⏳ Garansi 30 hari
│    [ gambar besar ]   │   ★★★★★ 4.8 (32 ulasan)
│                       │
│  [thumb][thumb][thumb]│   Rp79.000 / $5.0     [ Tersedia ]
└───────────────────────┘   Beli 3+ → hemat 10%
                            ┌─────────────────────────────┐
Deskripsi…                  │  Jumlah [- 1 +]             │
Profil sharing, garansi…    │  [   + Keranjang   ][ Beli ]│
                            └─────────────────────────────┘
─────────────────────────────────────────────────────────
Ulasan pembeli
★★★★★  "Cepat, akun work." — A***  · 2 hari lalu
```

---

### 6. Imagery — strategi Unsplash (editable)

Produk di DB menyimpan `imageFileId` = **Telegram file_id**, yang **tidak bisa**
dipakai langsung sebagai `<img src>` di web. Karena itu:

1. **Default: Unsplash.** Gunakan gambar Unsplash sebagai placeholder yang rapi
   & relevan per kategori/produk. Pakai **Unsplash Source / URL** atau daftar URL
   yang dikurasi, dengan parameter ukuran (`?w=800&q=80&auto=format&fit=crop`)
   supaya ringan.
2. **Gampang diganti nanti** (sesuai permintaan): semua URL gambar dikumpulkan di
   **satu tempat** — usul: file `apps/storefront/src/images.ts` (atau kolom DB
   baru `web_image_url`, lihat plan.md §8 "open decisions"). Jadi mengganti
   gambar = ubah satu peta, tidak menyebar di template.
   ```ts
   // contoh peta — pseudocode, bukan implementasi final
   export const productImage = (p) =>
     IMAGE_OVERRIDES[p.id] ??               // 1) override manual admin
     categoryImage(p.category?.name) ??     // 2) gambar per kategori (Unsplash)
     PLACEHOLDER;                           // 3) fallback netral
   ```
3. **Hero & kategori**: pakai koleksi Unsplash bertema (mis. "streaming",
   "gaming", "software") — disimpan sebagai konstanta yang jelas diberi komentar
   `// TODO: ganti dengan foto produk asli`.
4. **Rasio & kualitas seragam**: kartu 4:3 (`aspect-[4/3] object-cover`), hero
   21:9 atau 16:9, detail 1:1/4:3. Selalu `object-cover` + `bg-sand` sebagai
   warna loading.
5. **Atribusi/lisensi**: catat bahwa ini placeholder Unsplash; saat produksi
   diganti foto milik toko (lihat plan.md untuk to-do legal/atribusi bila pakai
   Unsplash API resmi).
6. **Performa**: `loading="lazy"`, `decoding="async"`, srcset opsional. Hindari
   gambar > 1600px.

---

### 7. Responsif, aksesibilitas, & interaksi

- **Breakpoint**: 1 kolom < `sm`, grid 2 kolom `sm`, 3 `md`, 4 `lg` untuk produk.
  Header collapse ke ikon + bottom-bar di mobile.
- **Kontras**: `ink` di atas `paper`/`card` lolos AA. Jangan andalkan warna saja
  untuk status — selalu ada **label teks** (sudah ditangani `status_badge`).
- **Fokus**: ring `focus:ring-2 focus:ring-pine/30` (sudah di `.btn`/`.field`).
- **Keyboard & alt**: tiap gambar produk `alt="{nama produk}"`; tombol ikon punya
  `aria-label`.
- **Micro-interaction**: hover kartu naik + `shadow-lift`; tombol transisi 150ms;
  badge keranjang animasi kecil saat nambah; toast HTMX untuk "Ditambahkan ke
  keranjang".
- **Loading**: skeleton `bg-sand animate-pulse` untuk grid saat HTMX load.
- **Empty states**: ramah & berarah (macro `empty_row` gaya), mis. "Keranjang
  masih kosong — lihat produk →".

---

### 8. Bahasa (i18n)

Bot sudah dwibahasa **EN + ID** (`packages/core/locales/{en,id}.json`).
Storefront sebaiknya **memakai i18n yang sama** (`@app/core/i18n`):
- Default mengikuti `User.language` bila login, atau cookie/toggle bahasa.
- Tambah key storefront-baru ke **kedua** file locale (jaga key set identik —
  aturan CLAUDE.md).
- Copy default di dokumen ini ditulis Bahasa Indonesia sebagai contoh untuk
  pelanggan; padanan EN wajib disediakan.

> Catatan: web-admin memilih English polos karena adminnya. Storefront melayani
> pelanggan (kemungkinan Indonesia), jadi dwibahasa lebih tepat. Keputusan final
> ada di plan.md §8.

---

### 8b. Tampilan harga (IDR utama + USDT info) & pembayaran

Harga **terpusat dalam Rupiah** (satu harga, diisi admin — lihat
[Bagian 1 §15](#bagian-1--rencana-storefront-arsitektur--rencana)); **USDT diturunkan otomatis dari kurs** (`usd_idr_rate`)
lalu **dibulatkan ke 0,1 terdekat** (mis. `$2.453 → $2,5`). **Tidak ada deteksi
IP** dan **bukan satu mata uang per-pembeli**: **semua** pembeli melihat **IDR
sebagai angka utama + USDT (bulat) sebagai info di sampingnya**. Mata uang
transaksi baru ditentukan **saat membayar** (pilih metode).

- **Format angka** (macro `price` merender keduanya sekaligus):
  - IDR → `Rp79.000` (tanpa desimal, pemisah ribuan **titik** — konvensi ID;
    `font-display`, warna `pine`).
  - USDT → `≈ $4,9` (sudah dibulatkan ke 0,1; ukuran lebih kecil, `text-ink-soft`)
    bersisian/di bawah angka IDR sebagai pelengkap, bukan menggantikan.
- **Tidak ada pemilih mata uang** di header (tak ada chip `[ Rp ▾ ]`, tak ada
  "ganti mata uang", tak ada deteksi IP). Header cukup pemilih **bahasa** saja.
- **Konversi sekali** per harga/total yang ditampilkan (jangan per-komponen) agar
  tak ada selisih pembulatan ganda; bulatkan **total order USDT** di akhir.
- **Harga reseller**: dari `resellerPrice` (IDR) → USDT diturunkan sama; hanya
  tampil bila user reseller.
- **Diskon**: harga coret + harga diskon tampil untuk kedua angka. Badge "hemat
  10%" (persen) berlaku relatif (sama untuk IDR & USDT).
- **Sisi admin**: admin **hanya mengisi harga Rupiah**; boleh ada **preview USDT
  (read-only)** dari kurs di form produk — sama dengan yang dilihat pembeli.
- **Pilih metode bayar = pilih mata uang** (di `/checkout` & `/checkout/:code/pay`):
  - **Rupiah / TokoPay** → order `IDR`; tampilkan **QRIS / Virtual Account /
    e-wallet** (logo channel), status menunggu, lalu sukses (konfirmasi callback).
  - **USDT / Binance** → order `USDT`; tampilkan **Binance Internal Transfer (UID +
    nominal unik) + countdown**, status auto-confirm (poller). **USDT hanya via
    Binance**; web tanpa upload bukti manual (plan.md §17.1).
  Keduanya pakai komponen kartu & stepper yang sama (design.md §4.6) — hanya isi
  instruksi yang beda. Status "menunggu → lunas" diperbarui via **HTMX polling**.
- **Satu harga pusat (Rupiah)** per produk; USDT selalu turunan kurs. Produk tanpa
  harga disembunyikan. Bila `usd_idr_rate` belum diisi, **info USDT** disembunyikan
  (IDR tetap tampil & bisa checkout via TokoPay); jalur **bayar USDT/Binance**
  nonaktif sampai kurs diisi.

---

### 9. Yang TIDAK dilakukan (selaras aturan proyek)

- **Web tidak pernah kirim Telegram langsung.** Notifikasi (kredensial,
  konfirmasi) selalu lewat `notification_outbox` → notifier/bot. (CLAUDE.md)
- **Tidak menampilkan data sensitif mentah**: `paymentProofFileId`, `file_id`,
  hash — sembunyikan/abstraksi. Kredensial hanya tampil ke pemilik pesanan yang
  sudah DELIVERED.
- **Tidak ada SQL mentah di route** — semua lewat `packages/db/src/crud/*`.
- **Jangan ubah nama kolom/skema** — DB dipakai bersama bot. (memori
  `enum-storage-uppercase`, `datetime-storage-incompat`)

---

### 10. Ringkasan "definition of done" visual

Storefront dianggap sesuai desain bila:
1. Buka berdampingan dengan web-admin → terasa **satu produk** (font, warna,
   kartu, tombol, badge sama).
2. Semua warna/font berasal dari **token yang sama**; ganti token → kedua web
   berubah.
3. Tiap produk punya **gambar (Unsplash, mudah diganti)** + **badge stok jujur**.
4. Bahasa polos, dwibahasa, tanpa jargon teknis.
5. Mobile-first, lolos kontras AA, ada empty/loading/error state.

---

## Bagian 3 — Cutover Harga USDT → IDR (Runbook)

Langkah cutover untuk model **harga pusat IDR** (plan.md §15 / §17.2 #4).
Sebelum cutover, `Product.price` dkk. bermakna **USDT**; sesudahnya kolom yang
sama berisi **Rupiah**, dan angka USDT diturunkan otomatis dari setting
`usd_idr_rate`. Kode di repo ini sudah memakai basis IDR — **DB lama wajib
dikonversi sebelum kode baru jalan**, kalau tidak semua harga tampil salah
(murah 16.000×) dan kolom baru memicu `P2022`.

### Apa yang dikonversi (oleh `scripts/convert-prices-to-idr.ts`)

| Data | Perlakuan |
|---|---|
| `Product.price`, `Product.resellerPrice` | × kurs, dibulatkan ke Rupiah utuh |
| `Voucher.value` (hanya type `FIXED`) | × kurs |
| `Voucher.minPurchase` (semua voucher) | × kurs |
| `Setting usd_idr_rate` | di-set = kurs yang dipakai |
| `BulkPricing` (persen) | tidak diubah |
| Order / wallet historis | tidak diubah — snapshot USDT (plan.md §15.1) |

Script menolak jalan dua kali (`usd_idr_rate` sudah terisi = sudah dikonversi)
dan membungkus semuanya dalam satu `$transaction`.

### Urutan eksekusi (WAJIB urut)

1. **Stop** bot/server (single-writer SQLite — script harus jadi penulis satu-satunya).
2. **Backup**: salin `data/bot.db` + `bot.db-wal` + `bot.db-shm`
   (mis. `bot.db.bak-pre-idr-YYYYMMDD`).
3. **Push skema baru** (kolom `web_image_url`, `orders.currency`, `orders.fx_rate`,
   tabel `processed_tokopay_tx`):
   ```bash
   pnpm exec prisma db push
   ```
4. **Konversi** dengan kurs awal (Rupiah per 1 USDT) yang kamu pilih:
   ```bash
   pnpm tsx scripts/convert-prices-to-idr.ts 16000
   ```
5. **Deploy/start kode baru** (basis IDR) — urutan "migrasi dulu, kode belakangan"
   sesuai CLAUDE.md.
6. Cek hasil: buka web-admin → Catalog (harga tampil `Rp…` + preview USDT),
   dan bot → katalog (harga `Rp… ≈ $…`).

### Gladi resik dulu (disarankan)

Jalankan dulu ke salinan DB persis seperti di atas tapi dengan
`DATABASE_URL_PRISMA` menunjuk file salinan (ingat: path `file:` relatif ke
folder `prisma/`), lalu periksa angkanya sebelum menyentuh DB asli.

### Rollback

Stop proses → kembalikan file backup (`bot.db*`) → start kode lama. Tidak ada
rollback parsial; itulah kenapa backup di langkah 2 wajib.

> Setelah cutover, kurs **otomatis mengikuti kurs pasar asli** (di-update tiap
> jam, dibulatkan ke kelipatan `usd_idr_rate_rounding`, default Rp100) — jadi
> angka kurs yang kamu pakai di langkah 4 hanya menentukan **konversi harga
> katalog** sekali itu; sesudahnya `usd_idr_rate` akan tertimpa kurs pasar.
> Pakailah kurs pasar hari itu agar konsisten. Auto-update bisa dimatikan via
> Settings → Payments → `usd_idr_rate_auto=false`. Order lama tidak berubah:
> tiap order USDT menyimpan snapshot `fxRate`-nya sendiri.

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
