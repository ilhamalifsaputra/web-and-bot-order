# plan.md — Website Jualan (Storefront): Arsitektur & Rencana

> Rencana implementasi **toko online pelanggan (storefront)** yang:
> - bergaya **sama persis** dengan web-admin (lihat [design.md](design.md)),
> - **terhubung ke DB & stok yang sama** dengan bot order Telegram,
> - belum dieksekusi — ini cetak biru untuk disetujui dulu.
>
> Konteks proyek: monorepo Node/TS (pnpm) hasil migrasi dari Python. Ada
> `apps/order-bot` (grammY), `apps/web-admin` (Fastify+Nunjucks+HTMX),
> `apps/notifier`, `apps/server` (composition root satu-proses), `packages/core`,
> `packages/db` (Prisma di atas SQLite `data/bot.db`). Skema 18+ model dipakai
> bersama. Storefront = **versi web dari sisi pelanggan bot**.

---

## 1. Tujuan & non-tujuan

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

## 2. Keputusan arsitektur utama: di mana storefront hidup?

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

### Deploy / proses (keputusan F)
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

## 3. Tech stack (mirror web-admin)

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

## 4. Pemetaan fitur: dari bot pelanggan → halaman web

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

## 5. Autentikasi pelanggan

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

## 6. Konsistensi tema: berbagi komponen dengan admin

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

## 7. Stok real-time & integritas

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

## 8. Gambar produk (Unsplash, mudah diedit)

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

## 9. Struktur kode (rencana `apps/storefront`)

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

## 10. Keputusan terbuka (perlu konfirmasi sebelum eksekusi)

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

## 11. Testing & kualitas (ikut CLAUDE.md)

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

## 12. Tahapan eksekusi (saran urutan, setelah disetujui)

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

## 13. Risiko & catatan

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

## 14. Ringkasan

Storefront = **wajah web dari sisi pelanggan bot**, dibangun dengan stack &
tema **identik** web-admin, **berbagi DB & crud** sehingga **stok dan semua data
otomatis sinkron** dengan bot. Bangun sebagai `apps/storefront` di monorepo,
auth via Telegram Login, gambar via `web_image_url` (admin) + Unsplash fallback,
pembayaran & order memakai alur yang sudah ada (tanpa duplikasi), notifikasi
lewat outbox. Harga **terpusat dalam IDR** dengan **USDT (bulat) tampil di
sampingnya sebagai info** (tanpa deteksi IP); pembeli memilih mata uang **saat
bayar** — **USDT via Binance**, **IDR via TokoPay** — lihat §15. Lihat
[design.md](design.md) untuk detail visual.

> **Status: rancangan — belum dieksekusi.** Menunggu keputusan §10 (sisa B/D/F/G)
> sebelum mulai.

---

## 15. Harga pusat IDR + USDT info & TokoPay — keputusan H

Keputusan: **(1) SATU harga pusat = Rupiah** (sumber kebenaran). **(2) USDT
diturunkan otomatis dari kurs, sudah dibulatkan, dan ditampilkan di samping
harga IDR sebagai informasi** untuk semua pembeli — **bukan** mata uang
per-pembeli dan **TANPA deteksi IP**. **(3) Mata uang transaksi dipilih saat
membayar**: **USDT hanya via Binance**, **selain itu (IDR) via TokoPay**.
**(4) Berlaku di storefront + bot** (keduanya menampilkan IDR + USDT bersisian).

### 15.1 Model harga — satu harga pusat IDR, USDT tampil di samping (REVISI)
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

### 15.2 Penentuan mata uang — TANPA deteksi IP
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

### 15.3 Bot Telegram — sama persis
Tanpa deteksi IP, bot **tak perlu** logika khusus. Aturan bot **identik** dengan
web:
- Bot menampilkan harga **IDR + USDT bersisian** (kurs yang sama, `usd_idr_rate`).
- Saat checkout/bayar, pembeli memilih **Binance (USDT)** atau **TokoPay (IDR)**;
  pilihan itu menetapkan `Order.currency`.
- Tidak ada lagi pembacaan/fallback `User.currency` atau menu "ganti mata uang".
  Storefront & bot **otomatis konsisten** karena keduanya menampilkan hal yang
  sama dan menunda pemilihan mata uang sampai pembayaran.

### 15.4 Routing pembayaran (dipilih pembeli saat bayar)
| Metode dipilih → `Order.currency` | Jumlah ditagih | Gateway | Mekanisme konfirmasi |
|---|---|---|---|
| Rupiah → `IDR` | harga pusat (eksak) | **TokoPay** (baru) | QRIS / VA / e-wallet; konfirmasi via **callback webhook** |
| USDT → `USDT` | nilai USDT **dibulatkan** (§15.1) | **Binance** (existing) | Binance Internal (UID) + nominal unik; auto-confirm poller |
- **USDT hanya bisa dibayar via Binance**; semua metode lain (QRIS/VA/e-wallet)
  lewat **TokoPay** dalam Rupiah. Tidak ada gateway USDT selain Binance.
- `uniqueCents` (pencocokan nominal) hanya relevan untuk jalur USDT/Binance.
- Web = **auto-confirm saja** (tanpa upload bukti — §17.1 #1).
- Halaman bayar berbeda tampilan per gateway (design.md §8b).

### 15.5 Integrasi TokoPay (PG IDR)
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

### 15.9 Kredensial TokoPay diatur di web-admin (disatukan dgn setelan bayar)
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

### 15.6 Tampilan harga (lihat juga design.md §8b)
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

### 15.7 Hal yang perlu aturan (sub-keputusan kecil saat eksekusi)
1. **Pembulatan total vs per-item**: untuk order USDT, bulatkan **total order**
   sekali di akhir (rekomendasi) agar konsisten dengan yang ditagih Binance, dan
   tampilkan USDT per-item sebagai turunan (boleh ada selisih sen kecil yang
   dijelaskan oleh pembulatan total). Tetapkan satu cara & konsisten.
2. **Wallet/saldo**: tersembunyi di web v1 (§17.1 #5); aturan basis wallet
   (USDT→IDR) ditunda ke saat fitur wallet web dibuat.
3. **Reseller**: `resellerPrice` (kini IDR) → USDT diturunkan sama seperti `price`.

### 15.8 Sisa keputusan kecil (bisa diputuskan saat eksekusi)
- **Arah pembulatan USDT**: 0,1 **terdekat** (default, sesuai contoh `2.453→2.5`)
  atau **ke atas** (agar tak pernah undercharge)? (usul: terdekat)
- **Kurs**: ✅ **DIPUTUSKAN & DIBANGUN — auto dari kurs pasar asli + pembulatan.**
  Job tiap jam (`scheduleFxRefresh`) menarik kurs USD→IDR dari open.er-api.com,
  membulatkannya ke kelipatan `usd_idr_rate_rounding` (default Rp100), lalu
  menyimpan `usd_idr_rate`. Matikan dengan `usd_idr_rate_auto=false` (kembali
  manual); web-admin juga punya tombol "Update USDT rate from the market now".
  Order lama aman — tiap order USDT menyimpan snapshot `fxRate`-nya.
- Apakah perlu menyimpan **kurs referensi** untuk laporan admin (mencampur Rp & $
  di `/reports`)? Reports lintas-mata-uang perlu sikap: pisah per mata uang
  **atau** konversi ke satu mata uang pelaporan (butuh kurs). (usul: pisah per
  mata uang dulu.)

---

## 16. Kredensial terpusat di web-admin (token bot, notifier, TokoPay)

Permintaan: **semua kredensial sensitif** — **token bot order**, **token
notifier**, dan **kredensial TokoPay** — bisa **di-set manual di web-admin**,
menyatu dengan setelan pembayaran. Tujuannya satu tempat, tanpa edit `.env` /
redeploy.

### 16.1 Daftar key di `Setting` (whitelist `EDITABLE`)
| Key | Isi | Rahasia? |
|---|---|---|
| `bot_token` | Token bot order (BotFather) | ✅ secret |
| `bot_username` | Username bot (untuk deep-link/referral) — atau auto via `getMe` | tidak |
| `notif_bot_token` | Token bot notifier (opsional; kosong = pakai bot utama) | ✅ secret |
| `tokopay_merchant_id` | Merchant TokoPay | tidak |
| `tokopay_secret` | Secret/private key TokoPay | ✅ secret |
| `tokopay_enabled` | "true"/"false" jalur Rp | tidak |
| `binance_pay_id` | (sudah ada) | tidak |
| `usd_idr_rate` | Kurs Rupiah per 1 USDT (mis. `16000`) — basis konversi info harga USDT (§15.1) | tidak |

Semua key **secret** memakai penanganan yang **sama persis** dengan §15.9
(write-only / "●●● tersimpan", `isSecret()` → `(hidden)` di tabel, audit
`key=(updated)` tanpa nilai, idealnya enkripsi at-rest). Dikelompokkan di UI:
sub-bagian **"Bot & Notifications"** (token) + **"Payments"** (Binance/TokoPay).

### 16.2 PERBEDAAN PENTING: hot-reload vs perlu restart
| Kredensial | Kapan dibaca | Ganti nilai → efek |
|---|---|---|
| `tokopay_*` | **Tiap request** (stateless) | **Langsung berlaku**, tanpa restart |
| `bot_token` / `notif_bot_token` | **Sekali saat boot** (membangun instance grammY `Bot`) | **Perlu restart** bot/proses agar berlaku |

grammY `Bot` dibangun sekali di composition root (`buildBot()` dipanggil dari
`apps/server/src/index.ts` setelah `initDb()`). Token tak bisa di-_hot-swap_ di
bot yang sedang berjalan → mengganti token = **restart terkontrol**.

### 16.3 Cara sumber token dipindah dari env → DB (dengan fallback)
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

### 16.4 Pengaman "jangan brick the bot" (WAJIB)
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

### 16.5 Catatan & risiko
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

## 17. Open items & hardening (pra-eksekusi)

Hal yang sudah otomatis aman karena **satu proses + DB bersama**: **kedaluwarsa
order** ditangani croner job (`listExpiredPendingOrders` → `cancelOrder` yang
melepas stok RESERVED + refund wallet + rollback voucher) — order web ikut tanpa
kode baru. Sisanya di bawah.

### 17.1 Keputusan yang sudah diambil
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
    mengelolanya **lewat bot**. Ini **membatalkan kerumitan §15.7 wallet-untuk-USDT
    di web** (tak relevan karena wallet tak tampil di web v1).
  - Menu **Referral tetap tampil** (kode + link) walau saldo komisi dilihat di bot.

### 17.2 To-do desain yang masih perlu dimatangkan (punya default)
| # | Item | Default/rekomendasi |
|---|---|---|
| 2 | **Status bayar real-time** di halaman `/checkout/:code/pay` | **HTMX polling** status order tiap ~5 dtk → otomatis berubah "Lunas → kredensial muncul"; + countdown dari `expiresAt` (client-side). |
| 3 | **Re-validasi saat checkout** (produk nonaktif/stok habis/harga berubah/voucher kedaluwarsa/bulk) | Recompute via crud yang sama **tepat sebelum buat order**; bila berubah → tahan + tampilkan pesan jelas, jangan diam-diam pakai harga lama. |
| 4 | **Migrasi skema live + konversi basis USDT→IDR** (`Order.currency`, `Order.fxRate`, `web_image_url` + reinterpretasi `price`/`resellerPrice` jadi IDR — **tanpa** `User.currency`) | `prisma db push` ke DB live **+ restart bot SEBELUM kode baru** (risiko `P2022`). **Konversi data**: kalikan harga katalog yang ada (`price`, `resellerPrice`, bulk, voucher nominal) **× kurs awal** sekali, set `usd_idr_rate`, lalu ubah logika tampilan bot jadi IDR-basis **+ USDT info di samping**. Order/wallet historis dibiarkan (snapshot USDT). **Tulis langkah cutover + backup di RUN.md; uji di DB salinan dulu.** |
| 6 | **Keamanan publik** (storefront menghadap internet; admin bind 127.0.0.1) | Rate limit (login/order/add-to-cart), cek freshness `auth_date` + anti-replay Telegram Login, CSRF form publik, `trustProxy` benar, review header keamanan. Satu pass khusus sebelum go-live. |
| 7 | **Onboarding parity** saat login web pertama | Tangkap referral (`?ref=`/`start=`), set bahasa, welcome — samakan dengan `/start` bot agar user web tak "kelas dua". (Tak ada set currency/IP — harga selalu IDR + USDT bersisian.) |
| 8 | **Gambar skala + SEO** | Produksi: download/self-host gambar (kolom `web_image_url` membantu), jangan hotlink Unsplash di skala. SEO: title/meta/OG/sitemap/robots/canonical (admin tak perlu, toko perlu). |

### 17.3 Minor / operasional (catat saja)
- **Filter review `hidden`** — storefront hanya tampilkan review yang **tidak**
  disembunyikan (kolom `hidden` sudah ada).
- **Tag sumber order** (web vs bot) — opsional, berguna untuk analitik admin.
- **Non-teknis**: S&K / kebijakan refund di halaman statis; **verifikasi bisnis
  TokoPay (KYB)** yang biasanya disyaratkan PG Indonesia (di luar lingkup kode,
  tapi blocker go-live IDR).
