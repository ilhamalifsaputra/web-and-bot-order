# Daftar Fitur — `telegram-order-bot`

Hasil pemindaian kode di `apps/order-bot`, `apps/web-admin` (Nunjucks + React SPA
`client/`), `apps/storefront`, dan `packages/{core,db,outbox-dispatcher}`.
Dikelompokkan per permukaan aplikasi. Path file mengacu ke lokasi implementasi.

---

## 1. Bot Telegram — Sisi Pelanggan (`apps/order-bot`)

1. **Menu utama** (`/start`, `/menu`) — pintu masuk semua alur pelanggan (`handlers/customer.ts`).
2. **Ganti bahasa** EN/ID (`/language`, tombol menu bahasa) — semua string via `packages/core/locales/{en,id}.json`.
3. **Jelajah katalog** — daftar produk flat + pagination (`/listproduk`, `browse:prods`/`browse:page`).
4. **Pencarian produk** (`/search`).
5. **Produk populer** (`browse:popular`).
6. **Detail produk & pilihan denominasi** — kartu Product → pilih Denomination (harga/stok per varian) (`browse:pick`, `browse:denom`).
7. **Input kuantitas** sebelum beli, dengan tombol +/- dan mode ketik-angka (`qty:*`).
8. **Ringkasan/konfirmasi pesanan** sebelum bayar (`buy:<pid>:<qty>`, `checkout.ts`).
9. **Kode voucher saat checkout** — pasang/lepas diskon (percent/fixed) (`voucher:*`, conversation `voucher`).
10. **Bayar pakai saldo (wallet credit)** — submenu pilih pakai saldo IDR atau USDT, mutually exclusive, bisa menutup total sebagian atau seluruhnya tanpa gateway eksternal (`walletm:*`, `walletpay:*`, `completeOrderWithWalletCredit`).
11. **Lima metode pembayaran auto-confirm**, simetris dgn storefront:
    - Binance Internal Transfer (USDT, UID+nominal unik) — `payx`
    - Bybit Internal Transfer (USDT, UID-based) — `payb`
    - Bybit BSC on-chain (USDT, konfirmasi block-explorer) — `paybc`
    - TokoPay QRIS (IDR, webhook) — `payq`
    - PayDisini QRIS/e-wallet (IDR, webhook) — `payd`
    - NOWPayments hosted invoice (USDT, webhook) — `payn`
12. **Binance Pay (manual, retired)** — label read-only untuk order lama yang dibuat sebelum jalur bukti-bayar-manual dipensiunkan; tidak ada lagi jalur bot aktif untuk memilih/mengunggah bukti metode ini (`checkout.ts:9`, dikonfirmasi test `payment-menu.test.ts:40`: "manual fallback retired").
13. **Batalkan pesanan pending** & **refresh status pembayaran** (`checkout:cancel`, `checkout:refresh`).
14. **Riwayat pesanan** — daftar, detail per order, semua riwayat (`order:list/view/allhistory`).
15. **Kredensial terkirim otomatis** setelah `DELIVERED` (auto-delivery dari stok).
16. **Program referral** — lihat kode/link referral sendiri, komisi otomatis dari order pertama orang yang direferensikan setelah `DELIVERED` (`ref:view`, `maybePayReferralCommission`).
17. **Rating produk (read-only)** — rata-rata rating + jumlah ulasan ditampilkan di layar detail denominasi (`productRating`, `browseDenomination` di `customer.ts:500`); pelanggan tidak bisa memberi rating/komentar dari bot (fitur submit dihapus, lihat komentar `customer.ts:770-771` — hanya bisa dari storefront `/account/reviews`, §4 item 13).
18. **Langganan restock** — notifikasi saat stok produk habis terisi lagi (`restock:sub`).
19. **Tiket dukungan (support)** — buka tiket, kirim balasan, lihat daftar/tiket sendiri, tutup tiket (`/support`, `ticket:*`, conversation `support`/`ticketUserReply`).
20. **Halaman statis** — FAQ (`/faq`), Syarat & Ketentuan (`/terms`), Cara Bayar (`/howtopay`).
21. **Pusat bantuan (Help Center)** — tombol bantuan terpusat (`help:open`).
22. **Batalkan operasi berjalan** (`/cancel`) — keluar dari conversation aktif kapan saja.
23. **Kartu profil/dompet ringkas** — lihat saldo wallet IDR+USDT (`wallet:view`).
24. **Banner bot** — gambar promosi di atas menu utama/list produk, ter-cache sebagai `file_id` Telegram.

### Job terjadwal (bot, `apps/order-bot/src/jobs/index.ts`)
- Auto-cancel order pending yang kedaluwarsa — tiap 1 menit.
- Auto-close tiket support yang sudah dibalas tapi tak direspon pelanggan 48 jam — tiap 1 jam.
- Rekonsiliasi keuangan / deteksi drift antar order-voucher-wallet — tiap 6 jam.
- Watchdog kesehatan poller pembayaran (Binance Internal, Bybit Internal Transfer, Bybit BSC), DM admin bila macet — tiap 2 menit. (TokoPay/PayDisini/NOWPayments webhook-primary dengan reconcile-poller fallback, tapi belum punya watchdog/alerting tersendiri.)
- Drain antrian broadcast — tiap 1 menit.
- Refresh kurs USDT/IDR otomatis — tiap 1 jam (`scheduleFxRefresh`).

## 2. Bot Telegram — Sisi Admin (`apps/order-bot`)

1. **Panel admin** (`/admin`) — menu khusus admin, gate `adminOnly`.
2. **Dashboard ringkas** (`adm:dash`).
3. **Antrian verifikasi pembayaran manual** — lihat antrian, lihat detail order, approve, reject (dengan alasan), kirim ulang kredensial (`verif:*`, conversation `reject`).
4. **Manajemen produk** — buat produk baru, ubah nama/harga, toggle aktif/nonaktif, lihat item stok per produk (`prod:*`, conversation `productCreate`/`productEdit`).
5. **Manajemen stok** — upload kredensial (satu baris = satu akun), lihat menu stok, tandai item rusak/dead (`stock:*`, `stockitem:dead`, conversation `stockUpload`).
6. **Bulk pricing** — diskon tingkat kuantitas per produk, buat/hapus (`bulk:*`, conversation `bulkPricing`).
7. **Voucher** — buat kode voucher baru, lihat daftar (`vouch:*`, conversation `voucherCreate`).
8. **Manajemen user** — cari user, lihat kartu profil, ban/unban, set/lepas status reseller, sesuaikan saldo wallet (`users:*`, conversation `userSearch`; command `/wallet`).
9. **Laporan (reports)** — lihat menu laporan, export CSV (`reports:*`).
10. **Pengaturan (settings)** — edit setting whitelist, undo penghapusan banner (`settings:*`, conversation `setting`).
11. **Broadcast** — kirim pesan massal ke seluruh/segmen pengguna bot (`broadcast:start`, conversation `broadcast`).
12. **Tiket dukungan (admin)** — lihat daftar tiket, balas, tutup tiket (`ticket:*`, conversation `ticketReply`).
13. **Command menu per-role** — daftar command berbeda untuk admin vs pengguna umum (`setupCommandMenu`).

## 3. Panel Admin Web — `apps/web-admin` (Fastify + Nunjucks legacy + React SPA)

### Onboarding & Akun
1. **Setup wizard** 3 langkah (bot token → owner admin → identitas toko) untuk instalasi baru (`routes/setup.ts`).
2. **Bootstrap manual** — set password admin pertama tanpa wizard, jalur deploy lama (`routes/auth.ts`).
3. **Login / logout**, sesi cookie HMAC httpOnly (`routes/auth.ts`).
4. **Lupa password / reset password** via email token (`routes/auth.ts`).
5. **Autentikasi dua faktor (2FA TOTP)** — begin/enable/disable/cancel (`routes/settings.ts`, `api/settings.ts`).
6. **Manajemen admin lain** — tambah/hapus admin, ubah role, paksa logout admin lain (`routes/admins.ts`, `api/admins.ts`).

### Dashboard
7. **Dashboard KPI (React SPA)** — revenue IDR/USDT hari ini vs kemarin + tren %, jumlah order per status, antrian verifikasi, underpaid, pending, processing, expired (`api/dashboard.ts`).
8. **Peringatan stok menipis** & **peringatan garansi item mendekati kedaluwarsa** (`lowStockDenominations`, `listOrderItemsExpiringWarranty`).
9. **Order terbaru** & **produk terlaris berdasar margin** (`recentOrders`, `topProductsByMargin`).
10. **Grafik tren revenue & order per hari** (`revenueByDay`, `ordersByDay`, `combinedRevenueByDay`).
11. **Status kesehatan bot & poller Binance** (`api/dashboard.ts` health endpoint).
12. **Pencarian global admin** (`api/search.ts`, `SearchPage.tsx`).
13. **Log audit** — lihat riwayat aksi admin (`api/audit.ts`, `AuditPage.tsx`).

### Katalog & Stok
14. **Manajemen kategori** — buat, update, toggle aktif (`routes/catalog.ts`, `api/catalog.ts`).
15. **Manajemen produk** — buat, update, hapus, toggle aktif/nonaktif (single & bulk) (`catalog.ts`).
16. **Manajemen denominasi** (varian harga/stok per produk) — buat, update, hapus, toggle aktif, bulk pricing per denominasi.
17. **Import produk massal** (bulk/CSV) dengan pratinjau sebelum apply (`products/import`, `products/import/apply`).
18. **Halaman stok per produk** — tambah stok (kredensial baris per baris), lihat tabel status item (`routes/stock.ts`).
19. **Download kredensial tersisa** (.txt, hanya status AVAILABLE, tercatat di audit tanpa isi kredensial).
20. **Tandai item stok rusak** (single & bulk "mark as dead") dan **hapus permanen** (bulk-delete, item SOLD/terkait order tak pernah terhapus).
21. **Catatan per item stok**.

### Order & Pembayaran
22. **Daftar & detail order** dengan filter/status (`routes/orders.ts`, `api/orders.ts`, export data order).
23. **Approve / reject order** (verifikasi manual) + kirim ulang kredensial.
24. **Kredit order ke saldo pelanggan** — order sudah dibayar tapi tak bisa diantar → jadi store credit, order jadi CANCELLED (`credit-balance`).
25. **Halaman pembayaran (payments)** — deliver manual, refund, cancel order; cocokkan transaksi "unmatched" ke order; kredit langsung ke saldo pembeli; dismiss entri (`routes/payments.ts`, `api/payments.ts`).
26. **Antrian notifikasi (outbox)** — lihat status pengiriman, retry manual notifikasi Telegram yang gagal (`routes/outbox.ts`).

### Pelanggan & Promosi
27. **Manajemen user** — ubah role, ban/unban, sesuaikan saldo wallet (`routes/users.ts`, `api/users.ts`).
28. **Manajemen voucher** — buat, toggle aktif, hapus (`routes/vouchers.ts`, `api/vouchers.ts`).
29. **Broadcast pesan** — kirim ke seluruh pelanggan bot, batalkan broadcast terjadwal (`routes/broadcast.ts`, `api/broadcast.ts`).
30. **Moderasi ulasan (reviews)** — sembunyikan review (`routes/reviews.ts`, `api/reviews.ts`).
31. **Dukungan pelanggan (support)** — lihat tiket, balas, tutup, assign ke admin (`routes/support.ts`, `api/support.ts`).

### Pengaturan & Branding
32. **Pengaturan whitelist** — edit kredensial gateway, kurs, dsb dengan field rahasia write-only (`routes/settings.ts`).
33. **Toggle aktif/nonaktif per payment gateway** (`settings/payments/toggle`).
34. **Refresh kurs USDT/IDR manual** (`settings/fx/refresh`) selain auto-refresh terjadwal.
35. **Ganti password admin** (`settings/password`).
36. **Branding toko** — upload favicon, logo header, hero image, banner bot; edit nama/tagline/welcome toko; hapus/undo banner (`routes/branding.ts`, `api/branding.ts`).
37. **Reports** — ringkasan laporan + export CSV (`routes/orders.view.test.ts` cakupan; `api/reports.ts`).
38. **Healthcheck** (`GET /healthz`).

## 4. Toko Web Pelanggan — `apps/storefront`

1. **Beranda** — produk unggulan/kategori (`routes/home.ts`).
2. **Kategori & pencarian produk** (`/c/:slug`, `/search`, `routes/catalog.ts`).
3. **Halaman detail produk** — pilih denominasi (`/p/:slug`).
4. **Keranjang belanja** — keranjang tamu via cookie, digabung ke akun saat login (`routes/cart.ts`).
5. **Checkout** — pilih metode bayar sekaligus mata uang (IDR via TokoPay/PayDisini, USDT via NOWPayments/Binance/Bybit), pasang voucher, pakai saldo wallet (`routes/checkout.ts`).
6. **Halaman instruksi bayar + polling status** — HTMX poll `/checkout/:code/status` tiap ~5 detik, auto-redirect ke kredensial saat `DELIVERED`.
7. **Webhook pembayaran otomatis** — `POST /pay/{tokopay,paydisini,nowpayments}/callback`, idempoten per-gateway.
8. **Registrasi & login** — username/email + password (utama); **Telegram Login Widget** (lookup-only, tidak membuat akun baru) (`routes/auth.ts`).
9. **Lupa password / reset password** via email (`routes/forgot.ts`).
10. **Akun saya** — profil, saldo wallet (`routes/account.ts`).
11. **Riwayat pesanan & detail order** — kredensial ditampilkan hanya untuk order `DELIVERED` milik sendiri (`/account/orders`).
12. **Program referral** — lihat kode/link referral sendiri (`/account/referral`).
13. **Ulasan saya** — lihat/kelola ulasan yang pernah diberikan (`/account/reviews`).
14. **Dukungan pelanggan** — buka/lihat tiket dari web (`/account/support`).
15. **Ganti bahasa** (`GET /lang`).
16. **API internal read-only** untuk kebutuhan frontend (`routes/api.ts`: `/categories`, `/products`).
17. **Healthcheck** (`GET /healthz`).

## 5. Lintas-Aplikasi / Infrastruktur (`packages/core`, `packages/db`, `packages/outbox-dispatcher`)

1. **Harga: IDR sebagai sumber kebenaran + USDT turunan otomatis** dari kurs pasar (`packages/core/src/fx.ts`, auto-refresh terjadwal, bisa dimatikan/manual).
2. **Uang presisi Decimal** di semua alur (tidak pernah `float`) (`@app/core/money`).
3. **Enam rel pembayaran auto-confirm** + **reconcile poller fallback** per gateway (TokoPay, PayDisini, NOWPayments, Binance Internal, Bybit Internal Transfer, Bybit BSC) — lihat `apps/order-bot/src/payments/*`.
4. **Saldo kredit (wallet) dua mata uang terpisah tanpa konversi** (IDR + USDT), ledger `WalletTransaction` per transaksi, chokepoint `adjustWallet` sadar mata uang (`packages/db/src/crud/users.ts`).
5. **Checkout dibayar penuh dari saldo wallet** — tanpa gateway eksternal (`crud/wallet_checkout.ts`).
6. **Mesin voucher/diskon** — tipe percent (dibatasi 0–100%) atau fixed (dibatasi subtotal), limit pemakaian, minimum pembelian, kedaluwarsa (`crud/vouchers.ts`).
7. **Bulk pricing / harga reseller** — tingkat harga berbeda berdasar kuantitas atau status reseller.
8. **Komisi referral otomatis** — persentase dari order pertama yang `DELIVERED` milik orang yang direferensikan, dikonversi lewat snapshot kurs order (`crud/referrals.ts`).
9. **Mesin status order terstruktur** — transisi tervalidasi (`LEGAL_TRANSITIONS`) + histori append-only `OrderStatusHistory` (`crud/orderStatus.ts`, `docs/ORDER_STATE_MACHINE.md`).
10. **Siklus hidup stok** — `AVAILABLE → RESERVED → SOLD/DEAD`, reservasi atomik saat checkout (anti-oversell) (`crud/stock.ts`, `docs/INVENTORY_SYSTEM.md`).
11. **Antrian notifikasi (`notification_outbox`)** — tabel SQLite sebagai queue, diklaim atomik anti double-send, retry dengan exponential backoff, dikonsumsi in-process oleh `packages/outbox-dispatcher` (bukan Redis/BullMQ) — menjamin **web tidak pernah kirim Telegram langsung**.
12. **Log audit admin** (`logAdminAction`) — setiap perubahan state dicatat dengan id admin pelaku, kalimat natural (bukan `key=value`).
13. **Internasionalisasi (i18n) EN/ID** — parity kunci penuh antara bot & web (`packages/core/locales/{en,id}.json`).
14. **Sistem ulasan & rating produk** + **langganan restock** (`crud/reviews.ts`).
15. **Sistem tiket dukungan dua arah** (customer ↔ admin), berlaku baik dari bot maupun web (`crud/support.ts`).
16. **Setup wizard vs `.env`** — resolver per-setting dengan aturan menang berbeda (DB>env, env>DB, union, dsb.) (`docs` §6, `packages/db/src/crud/{credentials,admins,web_secret,pricing}.ts`).
17. **Multi-toko dalam satu VPS** — pola deploy banyak instance independen (satu bot = satu toko = satu DB per instance), lihat `DOCS.md` §11.
18. **Backup & restore WAL-safe** (`deploy/backup/backup.sh`, `docs/BACKUP_AND_RESTORE.md`).
19. **Webhook Telegram** (`POST /tg/<WEBHOOK_SECRET>`, mode `BOT_MODE=webhook`) dengan verifikasi header rahasia dua lapis.
20. **Garansi (warranty) per item order** — snapshot durasi garansi, dilaporkan mendekati kedaluwarsa di dashboard.
21. **Deteksi schema-drift** (`crud/integrity.ts`) — cek tabel yang hilang di runtime untuk menangkap migrasi DB yang belum di-`push` sebelum menyebabkan error `P2022` diam-diam.
22. **Nudge dispatcher** (`packages/core/src/nudge.ts`) — webhook pembayaran bisa memaksa outbox-dispatcher langsung tick saat itu juga, tanpa menunggu interval poll normal.
23. **Cek validitas token bot** (`apps/web-admin/src/lib/telegramCheck.ts`) — validasi `getMe` sebelum token bot disimpan dari Settings/Setup Wizard.
24. **Import katalog dari CSV/daftar** (`apps/web-admin/src/lib/catalogImport.ts`) — parse → preview → apply produk massal.
25. **Kebijakan migrasi**: operasional pakai `prisma db push` (bukan `prisma migrate deploy`); file di `prisma/migrations/*` disimpan hanya sebagai dokumentasi/audit historis, bukan mekanisme yang dijalankan (`docs/MIGRATIONS.md`).
26. **Single-tenant per proses** — tidak ada multi-tenant di level kode (satu deploy = satu shop/bot/DB); banyak toko dicapai dengan menjalankan banyak instance terpisah (lihat §11 `DOCS.md`), bukan fitur multi-tenant bawaan.
