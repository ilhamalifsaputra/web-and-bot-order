# Audit `fitur.md` — 2026-07-04

Verifikasi menyeluruh terhadap setiap fitur yang didaftarkan di `fitur.md`
(root repo). Metode: (1) audit statis per-item oleh 3 agent eksplorasi
paralel — cek file/handler/route benar-benar ada dan teregistrasi, cross-check
dengan test yang sudah ada; (2) `pnpm typecheck` + `pnpm test` penuh di
seluruh monorepo; (3) verifikasi manual (Read/Grep) untuk semua temuan
berstatus SUSPECT/BROKEN sebelum dilaporkan di sini.

## Ringkasan

- **`pnpm typecheck`**: ✅ hijau, 9/9 workspace project.
- **`pnpm test`**: ✅ hijau, 139 file test / 1485 test, semua passing.
- **Cakupan fitur.md**: 100% item (24+13+6 bot, 38 web-admin, 17+26 storefront/infra)
  diperiksa satu per satu.
- **Temuan nyata (bug/doc usang, sudah diverifikasi manual)**: 2 BROKEN di sisi
  bot (fitur yang didokumentasikan tapi sudah dihapus dari kode), beberapa
  gap test pada endpoint sensitif di web-admin, dan sejumlah kode legacy
  orphaned pasca migrasi React yang aman tapi membingungkan.
- Tidak ada perbaikan kode yang diterapkan di audit ini — sesuai rencana,
  temuan dilaporkan dulu untuk keputusan lanjut.

---

## 1–2. Bot Telegram (`apps/order-bot`) — 24 + 13 + 6 item

Housekeeping: working tree bersih, tidak ada diff belum-commit di
`checkout.ts`/`keyboards/customer.ts` — fitur wallet-credit (commit
`bf095a9`→`5c5c036`) sudah full committed. 37 dari 43 item **OK**, wiring
lengkap dan (mayoritas) bertes.

### Temuan BROKEN (dokumentasi tidak sesuai kode — perlu keputusan: perbarui fitur.md atau kembalikan fitur)

1. **Item 1.12 — "Binance Pay manual fallback" sudah dipensiunkan, bukan
   fallback aktif.** `checkout.ts:9` eksplisit: *"the legacy manual
   Binance-Pay proof/verification path is retired."* `orderConfirmKb`
   (`keyboards/customer.ts:441-453`) tidak menampilkan tombol bayar apa pun
   bila tak ada rail terkonfigurasi & order belum wallet-covered penuh.
   Dikonfirmasi oleh nama test `payment-menu.test.ts:40`: *"offers no
   payable action when nothing is configured (manual fallback retired)"*.
   `BINANCE_PAY` cuma bertahan sebagai label read-only untuk order lama
   (`customer.ts:704-715`).

2. **Item 1.17 — "Ulasan/rating produk" dari bot tidak ada lagi.** Tidak ada
   `reviews.ts` atau alur submit-review di `apps/order-bot/src` sama sekali.
   Komentar eksplisit di `customer.ts:770-771`: *"Removed: per-order review,
   replacement, and the old delivered-only history download."*
   `crud/reviews.ts` masih dipakai, tapi hanya oleh web-admin & storefront
   (customer bot hanya menampilkan `productRating`, tidak bisa submit).

### Temuan SUSPECT / gap test (kode jalan, tapi bukan yang didokumentasikan atau kurang tercover test)

3. **Job "payment poller watchdog" over-claim.** fitur.md bilang mencakup
   5 gateway (Binance/Bybit/TokoPay/PayDisini/NOWPayments), tapi
   `jobs/index.ts:377-379` hanya mendaftarkan `binancePollWatchdog`,
   `bybitPollWatchdog`, `bybitBscPollWatchdog` — 3 dari 5. TokoPay/PayDisini/
   NOWPayments punya reconcile-poller fallback tapi **tanpa alert DM admin**
   saat stuck.

4. **Wallet-credit checkout (`walletm:*`/`walletpay:*`/
   `completeOrderWithWalletCredit`) — fitur terbaru, wiring source-level
   lengkap & DB-level test ada** (`wallet_checkout.test.ts`,
   `wallet_order_routing.test.ts`), **tapi belum ada test level-handler bot**
   yang menjalankan callback `walletm:*`/`walletpay:*` sungguhan
   (`payment-menu.test.ts`/`handlers.test.ts` tidak menyentuhnya). Rekomendasi:
   tambah 1 test vitest atau lakukan klik-tembus manual di Telegram sebelum
   dipercaya penuh di produksi.

5. Minor/cosmetic: komentar usang di `customer.ts:373-376` merujuk trigger
   `hears` untuk support yang sebenarnya tidak ada di `ConvSpec` (harmless,
   tidak ada reply-keyboard yang memicu label itu).

Section 2 (admin side) — **semua 13 item OK**, seluruhnya diverifikasi dan
punya test di `conversations.test.ts`. Tidak ada temuan.

---

## 3. Panel Admin Web (`apps/web-admin`) — 38 item

**Catatan penting: judul section "Fastify + Nunjucks legacy + React SPA" sudah
usang** — `.njk` template sudah 0 (nol), migrasi React sudah tuntas 100%.
Yang tersisa di `routes/*.ts` (non-`api`) bukan Nunjucks lagi, melainkan
handler form-POST lama yang sebagian besar sudah digantikan `/api/*`.

Semua 53 route-registration di `server.ts` ter-wire ke `buildApp()` — tidak
ada yang benar-benar unregistered. Tapi ada pola sistemik:

### Temuan sistemik #1 (prioritas tertinggi): endpoint `/api/*` yang dipakai SPA sering tidak bertes, sementara kembaran form-lama-nya (yang sudah tidak dipanggil SPA) masih full test coverage

Endpoint mutasi yang **live dipanggil SPA tapi nol test**:
`/api/settings/2fa/*`, `/api/settings/password`,
`/api/settings/payments/toggle`, `/api/settings/fx/refresh`,
`/api/settings/edit`, `/api/admins/{add,remove,:id/role,:id/logout}`,
`/api/users/:id/{role,ban}`, mutasi `/api/vouchers/*`,
`/api/support/{reply,close}`. Yang paling berisiko: **2FA disable** dan
**force-logout admin lain** — dekat dengan auth-bypass, celah divergensi
diam-diam di sini adalah worst-case.

### Temuan sistemik #2: `routes/catalog.ts` (613 baris) ~95% dead code

Hanya `POST /catalog/product/:productId/photo` yang masih dipanggil SPA
(`ProductDetailPage.tsx:149`, upload multipart memang sengaja bypass
`/api`). Sisanya (category/product/denomination CRUD, bulk-pricing —
11 dari 12 endpoint) tidak punya caller di `client/src` sama sekali
(diverifikasi: hits di `client/src` untuk `/catalog/...` hanya cocok dengan
path React Router, bukan panggilan fetch ke backend). Masih di-test di
`web.test.ts` — jadi test suite memvalidasi kode yang sudah mati, bukan jalur
yang dipakai. Pola sama (lebih kecil) di `routes/{stock,payments,orders,
users,vouchers,broadcast,reviews,support,outbox,admins,settings}.ts`.

### Fitur backend-lengkap tapi tidak ada tombol UI (BROKEN secara discoverability)

- **Item 16 (bulk pricing per denominasi)** — API + test ada
  (`routes/api/catalog.ts:364,394`), tapi **tidak ada halaman SPA yang
  memanggilnya** — 0 hits utk `bulk-pricing`/`BulkPricing` di `client/src`.
- **Item 22 (export order CSV)** — `GET /api/orders/export` lengkap &
  bertes, tapi `OrdersPage.tsx` **tidak punya tombol/link export** — hanya
  bisa dipicu via curl.
- **Item 36 (hapus/undo banner)** — `POST /branding/banner/clear` lengkap &
  bertes, tapi `BrandingPage.tsx` tidak punya tombol clear/undo.
- **Item 37 (Reports CSV export)** — fitur.md eksplisit klaim "export CSV"
  untuk Reports, tapi **tidak ada CSV export untuk data reports sama
  sekali** — satu-satunya CSV export di seluruh app adalah orders (di atas),
  dan itu pun tanpa UI. `/api/reports` sendiri juga nol test coverage.
- **`/api/audit`** — dipanggil live oleh `AuditPage.tsx`, nol test coverage.

Item 1-15, 18-21, 23-35, 38 lainnya: **OK**, wiring dan test lengkap (lihat
detail per-item di laporan agent jika perlu — tersedia di riwayat sesi ini).

---

## 4. Toko Web Pelanggan (`apps/storefront`) — 17 item

Semua 17 item **OK** — clean, tidak ada route orphaned/broken. Satu-satunya
catatan: **item 16** ("API internal read-only") mendeskripsikan
`routes/api.ts` sebagai read-only, padahal file itu juga mengekspos
`POST /cart` dan `POST /checkout` (bukan bug, hanya deskripsi fitur.md yang
kurang lengkap).

## 5. Lintas-Aplikasi / Infrastruktur — 26 item

24 dari 26 **OK**, well-tested (voucher engine, wallet ledger, state
machine, stock lifecycle, outbox, audit log, i18n, dst — semua ada
`*.test.ts` colocated sesuai konvensi CLAUDE.md).

- **Item 8 (komisi referral otomatis) — gap test.**
  `maybePayReferralCommission` (`crud/referrals.ts:21`) live dipanggil dari
  `crud/orders.ts:865`, **tapi tidak ada `referrals.test.ts`** dan tidak ada
  test lain yang menjalankan jalur komisi ini — melanggar konvensi CLAUDE.md
  soal test crud-level. Cabang konversi kurs IDR→USDT saat rate
  hilang/nol (`referrals.ts:43-53`) adalah edge-case yang belum terverifikasi.
- **Item 7 (bulk pricing/reseller)** — fitur.md tidak menyebut file; logic
  sebenarnya ada di `crud/catalog.ts`, sementara nama test-nya
  `bulk_pricing.test.ts` menyiratkan modul terpisah yang sebenarnya tidak
  ada — SUSPECT ringan, kemungkinan cuma penamaan file test yang membingungkan.
- Item 17, 26 (pola deploy multi-toko, single-tenant) bersifat klaim
  arsitektur/dokumentasi, tidak bisa difalsifikasi lewat grep kode —
  konsisten dengan desain yang diamati, tidak ada bukti bertentangan.

---

## Rekomendasi prioritas (jika ingin ditindaklanjuti)

1. Perbarui `fitur.md` item 1.12 dan 1.17 (Binance Pay manual & bot-side
   reviews) — fitur ini sudah tidak ada di kode, dokumentasi menyesatkan.
2. Tambahkan test level-handler untuk `walletm:*`/`walletpay:*` (checkout
   wallet-credit) — fitur terbaru, saat ini hanya diverifikasi DB-level.
3. Tambahkan test trio (happy/auth-fail/bad-csrf) untuk endpoint `/api/*`
   sensitif yang saat ini nol-coverage, terutama 2FA disable & admin
   force-logout.
4. Putuskan: hapus `routes/catalog.ts` cs. yang sudah orphaned (kecuali
   endpoint upload foto), atau biarkan sebagai dead code terdokumentasi —
   saat ini test suite memberi rasa aman palsu karena mengetes kode yang
   sudah tidak reachable dari UI.
5. Tambahkan tombol UI untuk fitur backend-lengkap yang saat ini tak
   terjangkau: bulk-pricing per denominasi, export CSV order, clear/undo
   banner, dan (bila memang dijanjikan) export CSV reports.
6. Tambah `referrals.test.ts` untuk `maybePayReferralCommission`, termasuk
   edge-case rate FX hilang/nol.
7. Perbaiki job watchdog agar juga memantau TokoPay/PayDisini/NOWPayments,
   atau perbarui deskripsi fitur.md agar sesuai cakupan sebenarnya (3
   gateway).
