# Audit UI/UX Fungsional — Bot + Web-Admin + Storefront

**Tanggal:** 2026-07-01
**Cakupan:** `apps/order-bot` (grammY) + `apps/web-admin` (Fastify + React SPA) +
`apps/storefront` (Fastify + Nunjucks + HTMX).
**Sifat:** READ-ONLY — tidak ada kode aplikasi yang diubah untuk audit ini.
**Fokus:** bukan audit visual/estetika, tapi fitur yang *terlihat* ada/berfungsi di UI namun
nyatanya gagal di jalur nyata — tombol yang berakhir di endpoint salah, aksi yang gagal diam-diam
tanpa feedback, teks/error yang salah konteks, dead-end.

Setiap temuan: **Severity · File:baris · Penyebab · Dampak · Solusi**. Severity = High / Medium /
Low / Info.

> Audit ini melengkapi, bukan mengulang, tiga dokumen yang sudah ada:
> `docs/audit-ui-ux-2026-06-21.md` (visual/responsive, storefront+web-admin lama, bot di luar
> cakupan), `docs/audit-security-2026-06-23.md` (auth/CSRF/IDOR), dan
> `docs/admin-ux-pass-v2-plan.md` (gap fitur vs brief eksternal `ui.txt`). Tidak ada temuan di
> bawah yang tumpang tindih dengan ketiganya — semua diverifikasi ulang terhadap kode saat ini.

---

## Bagian 1 — Bot Telegram (`apps/order-bot`)

### 1.1 [HIGH] "My Orders → Pay" menampilkan instruksi pembayaran yang salah/basi untuk semua metode pembayaran aktif

- **File:** `apps/order-bot/src/handlers/customer.ts:686-696` (`viewOrder`), dipicu dari
  `keyboards/customer.ts:360-364` (`ordersListKb`) dan `:373-385` (`orderDetailKb`).
- **Penyebab:** Setiap order baru dibuat lewat salah satu dari enam rail auto-confirm
  (`buyNowInternal`, `buyNowBybit`, `buyNowBybitBsc`, `buyNowTokopay`, `buyNowPaydisini`,
  `buyNowNowpayments` di `handlers/checkout.ts`), masing-masing merender instruksinya sendiri
  (UID, alamat on-chain, QR, atau link invoice) di bubble yang dibuat saat checkout. Tapi begitu
  customer keluar dari bubble itu (Home → My Orders) lalu membuka order yang masih
  `PENDING_PAYMENT`, `viewOrder` hanya mengecek `order.status`, **tidak pernah mengecek
  `order.paymentMethod`** — sehingga order TokoPay/PayDisini QRIS, Bybit-BSC on-chain, atau
  NOWPayments hosted-invoice **semuanya** ditampilkan teks lama peninggalan alur manual-transfer:
  `t(ctx, "order.pending_payment_detail", { binance_id: ... })`. Kalau `BINANCE_PAY_ID` tidak
  diset (default `""`), bubble-nya secara harfiah berbunyi "Pay to Binance ID: `<kosong>`" —
  instruksi yang sama sekali tidak relevan dengan metode pembayaran yang sebenarnya dipakai.
  `orderDetailKb` juga tidak punya tombol "Refresh Status" atau link balik ke rail aslinya —
  hanya Cancel/Back/Menu.
- **Dampak:** Customer tidak tahu cara menyelesaikan pembayaran yang sudah dimulai kalau ia
  sempat pindah layar. Setelah window anti-duplikat 30 detik (`refuseDuplicateCheckout`) lewat,
  ia berisiko checkout ulang dan membuat order kedua untuk produk yang sama — bukan
  menyelesaikan yang lama, malah menambah kebingungan. Tidak tercover test: `makeOrder()` di
  `test/handlers.test.ts:93-97` selalu membuat order tanpa `paymentMethod`, jadi celah ini lolos
  dari suite yang ada.
- **Solusi:** Cabangkan `viewOrder` berdasarkan `order.paymentMethod` juga (bukan hanya status),
  dan render ulang instruksi rail yang sesuai (atau minimal tambahkan tombol "Refresh Status" yang
  memanggil pooler reconcile yang sama seperti `refreshPaymentStatus` di `checkout.ts:1080-1126`,
  yang sudah benar dipakai di layar tunggu aslinya).

### 1.2 [MEDIUM] Kegagalan re-validasi voucher ditelan diam-diam, subtotal berubah tanpa penjelasan

- **File:** `apps/order-bot/src/handlers/checkout.ts:172-192` (`computeConfirmation`).
- **Penyebab:** Saat voucher pertama kali diterapkan, `conversations/checkout.ts:78-87` sudah
  benar menampilkan `ValidationError` (expired/nonaktif/belum capai minimum/sudah habis) lewat
  `menuAnchor`. Tapi setiap kali layar konfirmasi dirender ulang (ubah kuantitas, toggle dompet
  IDR/USDT, back-lalu-buka-lagi), voucher yang sudah terpasang divalidasi ulang lewat
  `applyVoucherToSubtotal`, dan jalur gagalnya adalah:
  ```js
  } catch {
    delete ctx.session.scratch.appliedVoucherCode;
    voucherCode = "";
  }
  ```
  Blok ini menelan **semua** exception (bukan cuma `ValidationError` — error DB sungguhan pun
  ikut tertelan), langsung menghapus voucher tanpa toast/alert apa pun.
- **Dampak:** Customer melihat totalnya naik lagi di render berikutnya tanpa tahu alasannya
  (mis. kuantitas diturunkan di bawah `min_purchase` voucher, atau voucher kadaluarsa/habis di
  tengah sesi).
- **Solusi:** Bedakan `instanceof ValidationError` (tampilkan `t(ctx, e.key, e.formatArgs)`
  sebagai toast/alert, sama seperti jalur penerapan awal) dari error tak terduga (log via
  `logErrorRef`, pesan generik) — jangan gabungkan keduanya ke satu jalur tanpa feedback.

### 1.3 [LOW/INFO] Locale key untuk resolusi order underpaid hilang dari kedua bahasa

- **Detail:** `error.order_not_underpaid`, `error.tx_not_found`, `error.tx_not_unmatched` tidak
  ada di `packages/core/locales/en.json` maupun `id.json`. Hanya dilempar dari
  `packages/db/src/crud/binance_internal.ts:340-456`, dan hanya dipanggil dari web-admin (lihat
  §2.2) — **tidak** memengaruhi alur bot. Dicatat untuk kelengkapan karena berbagi locale file
  yang sama.

### Sudah baik (bot) — tidak perlu tindakan
- i18n parity 100% untuk 222 key statis + semua key dinamis `ValidationError` yang relevan ke
  bot (611/611 key ada di kedua bahasa).
- Semua `callback_data` yang di-emit keyboard customer punya handler yang cocok — tidak ada
  tombol mati.
- Stock habis di tengah checkout, kegagalan gateway TokoPay/PayDisini/NOWPayments, dan
  double-tap checkout semuanya sudah ditangani dengan alert ramah dan tidak meninggalkan order
  menggantung.

---

## Bagian 2 — Web-Admin (`apps/web-admin`)

### 2.1 [HIGH] Tombol "Retry" Outbox dan "Hide/Unhide" Reviews gagal senyap — aksi sukses di server tapi UI tidak pernah update

- **File:** `apps/web-admin/client/src/pages/OutboxPage.tsx:61`, `ReviewsPage.tsx:62`; route
  server `apps/web-admin/src/routes/outbox.ts:18-32`, `routes/reviews.ts:20-35`.
- **Penyebab:** Kedua tombol memanggil `apiPost` ke route lama yang masih melakukan
  Post/Redirect/Get gaya Nunjucks — `redirectWithFlash` mengirim `303` ke `GET /outbox` /
  `GET /reviews`. Kedua `GET` itu sudah *retired* (komentar eksplisit di kode), jadi request
  jatuh ke SPA catch-all (`routes/spaShell.ts:28-31`) yang mengembalikan `200 text/html` (shell
  React). `fetch()` mengikuti redirect secara default sehingga `res.ok` bernilai `true`, lalu
  `res.json()` gagal parse HTML sebagai JSON dan melempar `SyntaxError`. `OutboxPage`'s `retry()`
  tidak punya `catch`; `ReviewsPage`'s mutation tidak punya `onError` sama sekali.
- **Dampak:** Aksi retry/hide **benar-benar terjadi** di server (notifikasi di-requeue, audit log
  tercatat) — tapi baris di tabel tetap menampilkan status lama sampai reload manual. Admin bisa
  klik retry/hide berkali-kali tanpa sadar itu sudah berhasil, atau mengira fitur ini rusak total.
  Tidak tercover test — `OutboxPage.test.tsx`/`ReviewsPage.test.tsx` hanya menguji render list
  awal, bukan aksi POST-nya.
- **Solusi:** Buat endpoint JSON (`POST /api/outbox/:id/retry`, `POST /api/reviews/:id/hide`) yang
  mengembalikan JSON (bukan redirect), pakai pola yang sama seperti route `/api/*` lain. Route
  lama bisa dipensiunkan sepenuhnya begitu client dialihkan.

### 2.2 [HIGH] Resolusi order underpaid (deliver/refund/cancel) tidak punya UI sama sekali

- **File:** `apps/web-admin/src/routes/api/payments.ts:62-116` (backend lengkap); tidak ada
  pemanggil di `apps/web-admin/client/src/pages/PaymentsPage.tsx`.
- **Penyebab:** `GET /api/payments` (`payments.ts:37-59`) sudah mengembalikan array
  `underpaid`/`pendingInternal` khusus untuk alur ini, tapi interface `PaymentsData` di
  `PaymentsPage.tsx:32-40` tidak mendeklarasikan field tersebut, dan tidak ada komponen yang
  merender atau memanggil `deliver`/`refund`/`cancel`.
- **Dampak:** Admin **tidak bisa** menyelesaikan order underpaid dari web panel sama sekali —
  padahal backend, validasi, dan audit log sudah siap. Fitur yang seharusnya sudah bisa dipakai
  tapi tidak pernah terhubung ke UI.
- **Solusi:** Tambahkan section "Underpaid Orders" di `PaymentsPage.tsx` yang menampilkan
  `underpaid`/`pendingInternal`, dengan tiga aksi (Deliver anyway / Refund to wallet / Cancel)
  yang memanggil route yang sudah ada.

### 2.3 [MEDIUM] Ganti role customer tidak punya UI

- **File:** `apps/web-admin/src/routes/api/users.ts:50-67` (`POST /api/users/:userId/role`);
  `apps/web-admin/client/src/pages/UserDetailPage.tsx:17,22,85`.
- **Penyebab:** `GET /api/users/:userId` sengaja mengembalikan array `roles` untuk keperluan ini,
  tapi `UserDetailPage` hanya merender `user.role` sebagai `<Badge>` read-only; `roles` yang
  di-fetch tidak pernah dipakai.
- **Dampak:** Admin tidak bisa mempromosikan/mengubah role customer (mis. jadi reseller) lewat
  web panel.
- **Solusi:** Tambahkan `<Select>` + mutation di `UserDetailPage.tsx` yang memanggil endpoint yang
  sudah ada.

### 2.4 [MEDIUM] Fitur denomination baru: bisa create + toggle-active, tapi tidak ada edit/delete

- **File:** `packages/db/src/crud/catalog.ts:278` (`updateDenomination`), `:346`
  (`deleteDenomination`) — logic sudah ada; tidak ada route `/api/catalog/denominations/:id`
  `PUT`/`DELETE` maupun UI React untuk memanggilnya.
- **Penyebab:** Fungsi crud ini dulu terpakai lewat route Nunjucks lama
  (`apps/web-admin/src/routes/catalog.ts:504,585`), tapi `GET`-nya sudah retired sehingga form
  editnya tidak bisa dijangkau lagi, dan SPA baru tidak pernah membangun penggantinya.
- **Dampak:** Regresi dibanding admin versi sebelum SPA — admin bisa membuat denomination baru
  dan menonaktifkannya, tapi tidak bisa memperbaiki typo harga/nama atau menghapus denomination
  sama sekali lewat web panel.
- **Solusi:** Tambahkan route JSON `PUT`/`DELETE` yang memanggil crud yang sudah ada, plus
  form edit/tombol delete di halaman denomination SPA.

### 2.5 [LOW] `STORE_KEYS` di SettingsPage adalah kunci hantu — card "Store" tidak pernah render

- **File:** `apps/web-admin/client/src/pages/SettingsPage.tsx:44-48`
  (`min_order_amount`, `order_expiry_minutes`, `stock_low_threshold`); whitelist server
  `apps/web-admin/src/routes/api/settings.ts:28-71`.
- **Penyebab:** Ketiga key ini tidak ada di whitelist `EDITABLE` maupun di tempat lain di
  codebase (bukan setting sungguhan) — kemungkinan sisa dari brief eksternal yang tidak pernah
  di-wire. `GET /api/settings` tidak pernah mengembalikan field untuk key ini, jadi
  `fieldGroup(...)` selalu `[]` dan card "Store" tersembunyi total (bukan tampil rusak — memang
  tidak pernah tampil).
- **Dampak:** Tidak dirasakan langsung oleh admin (tersembunyi), tapi dead code yang
  menyesatkan kalau dibaca ulang nanti — dan sesuai aturan CLAUDE.md, menambah key ke whitelist
  butuh review, jadi ini bukan sesuatu yang boleh "diperbaiki" dengan sekadar melonggarkan
  whitelist tanpa keputusan sadar.
- **Solusi:** Hapus `STORE_KEYS`/card "Store" kalau memang tidak ada rencana menjadikannya
  setting sungguhan, atau ajukan key-key ini secara sadar ke whitelist kalau memang dibutuhkan.

### Sudah baik (web-admin) — tidak perlu tindakan
- CSRF coverage lengkap di semua mutating fetch (`apiPost` + header `X-CSRF-Token`) — konsisten
  dengan `docs/audit-security-2026-06-23.md`. Masalah 2.1 adalah bug bentuk-response, bukan CSRF.
- Denomination create, password-toggle di LoginPage, dan banner sukses/error di SettingsPage
  (password, 2FA, FX refresh, payment-method toggle) semuanya diverifikasi tersambung penuh ke
  route yang benar.

---

## Bagian 3 — Storefront (`apps/storefront`)

### 3.1 [HIGH] Tombol "Apply" voucher di halaman checkout diam-diam membuat order sungguhan

- **File:** `apps/storefront/views/checkout.njk:98-104` (tombol Apply) dan `:16-17,160-162`
  (tombol Place Order) — keduanya berada di `<form>` yang sama; handler tunggal
  `apps/storefront/src/routes/checkout.ts:351-374` (`POST /checkout`) langsung memanggil
  `performCheckout()` (`checkout.ts:263-339`).
- **Penyebab:** Tidak ada script yang mengintersep submit tombol Apply, dan tidak ada endpoint
  terpisah untuk "preview/validasi voucher". `performCheckout()` langsung menjalankan
  `createOrderFromCart` + `finalizeOrderPayment` dalam satu `$transaction` (mereservasi stok,
  membuat order pending) lalu redirect ke halaman bayar — persis efek "Place Order". Satu-satunya
  cara bug ini tidak kelihatan adalah kalau kode vouchernya **salah** (baru muncul error dan
  halaman dirender ulang).
- **Dampak:** Kalau kode voucher valid, klik "Apply" (yang niatnya cuma mau lihat potongan harga)
  langsung mengunci cart, mereservasi stok, dan mengirim buyer ke halaman pembayaran dengan
  metode pembayaran default yang mungkin belum ia maksud konfirmasi. Tidak tercover test.
- **Solusi:** Buat endpoint terpisah (mis. `POST /checkout/voucher/preview`, dipanggil via HTMX
  `hx-post` yang menargetkan hanya bagian ringkasan harga) yang memvalidasi & menghitung ulang
  subtotal **tanpa** membuat order. Tombol "Apply" tidak boleh lagi jadi `type="submit"` di form
  yang sama dengan Place Order.

### 3.2 [MEDIUM] Link kontak Telegram di homepage tidak dijaga seperti tempat lain — jadi link mati kalau bot belum di-setup

- **File:** `apps/storefront/views/home.njk:292-301`.
- **Penyebab:** `resolveBotUsername()` (`apps/storefront/src/shop.ts:16-20`) sengaja
  mengembalikan `""` untuk kondisi belum di-setup/masih placeholder, dan setiap pemakaian lain
  (`pay.njk:98,141,181,193`, `login.njk:44`, `settings.njk:55`) membungkusnya dengan
  `{% if bot_username %}`. Blok di `home.njk` **tidak** — link `<a href="https://t.me/{{
  bot_username }}">` dirender apa adanya.
- **Dampak:** Di toko yang belum setting bot Telegram, tombol kontak Telegram di homepage
  mengarah ke `https://t.me/` — link generik/mati, bukan disembunyikan seperti seharusnya.
- **Solusi:** Bungkus blok tersebut dengan `{% if bot_username %}...{% endif %}`, samakan dengan
  pola di file lain; sesuaikan juga grid kolom kontak (`sm:grid-cols-3`/`sm:grid-cols-2`) supaya
  tidak berasumsi Telegram selalu ada.

### 3.3 [LOW] Form "restock" tanpa JS mengirim ke endpoint tanpa id → 404

- **File:** `apps/storefront/views/product.njk:69-74,148`.
- **Penyebab:** `action="/restock/"` default (tanpa id) hanya diperbaiki oleh JS inline saat
  denomination dipilih. Route sebenarnya `POST /restock/:id`, mewajibkan param.
- **Dampak:** Kalau JS mati, submit form ini 404 — tapi halaman produk memang sudah butuh JS
  untuk memilih denomination, jadi ini edge case progressive-enhancement berseverity rendah.
- **Solusi:** Set `action` lewat JS saat halaman load (bukan hanya saat user memilih
  denomination), atau nonaktifkan tombol submit sebelum ada denomination terpilih.

### Sudah baik (storefront) — tidak perlu tindakan
- Alur forgot-password (`GET/POST /forgot` → email → `GET/POST /reset/:token`) ditelusuri
  end-to-end, token single-use dan atomic, tidak ada link putus.
- CSRF token hadir di semua form yang butuh (guest cart/product form sengaja tidak mewajibkan
  token, sudah terdokumentasi sebagai trade-off di audit keamanan sebelumnya).
- Polling HTMX di `pay.njk` (`hx-get` status setiap 5 detik) tersambung benar ke partial yang
  sesuai dan meng-handle redirect saat delivered.

---

## Ringkasan prioritas kalau lanjut ke perbaikan

| # | Temuan | Severity | Surface |
|---|---|---|---|
| 1 | My Orders → Pay salah instruksi pembayaran | High | Bot |
| 2 | Outbox retry / Reviews hide gagal senyap | High | Web-Admin |
| 3 | Resolusi order underpaid tanpa UI | High | Web-Admin |
| 4 | Voucher "Apply" checkout bikin order sungguhan | High | Storefront |
| 5 | Re-validasi voucher bot menelan error diam-diam | Medium | Bot |
| 6 | Ganti role customer tanpa UI | Medium | Web-Admin |
| 7 | Denomination tanpa edit/delete | Medium | Web-Admin |
| 8 | Link Telegram homepage jadi link mati | Medium | Storefront |
| 9 | `STORE_KEYS` dead code di Settings | Low | Web-Admin |
| 10 | Form restock tanpa JS 404 | Low | Storefront |
