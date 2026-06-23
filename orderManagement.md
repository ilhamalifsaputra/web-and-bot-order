# Prompt: Penguatan Order Management System — Sales → Orders

> Adaptasi dari prompt generik "build an OMS from scratch" agar fit dengan
> codebase **telegram-order-bot** yang sudah berjalan di production. Ini
> **bukan** proyek greenfield — `orders`, `stock_items`, payment webhook, audit
> log, dan outbox dispatcher sudah ada dan sudah diaudit (lihat
> `docs/audit-security-2026-06-23.md`). Tugasnya adalah **memperluas** sistem
> ini untuk mendukung queue, partial delivery, retry, dan UI command-center —
> tanpa merombak apa yang sudah benar.

Anda adalah Staff Backend Engineer yang mengerjakan monorepo pnpm
`apps/* + packages/*` ini. Patuhi `CLAUDE.md` di root repo secara harfiah:
Decimal untuk uang, tidak ada raw SQL di route, audit setiap perubahan status,
SQLite single-writer (transaksi harus pendek), dan **jangan pernah kirim
Telegram dari proses web** — selalu lewat `notification_outbox`.

---

## 0. Catatan adaptasi — baca dulu sebelum implementasi

Prompt generik aslinya mengasumsikan stack dan domain yang **tidak match**
dengan repo ini. Jangan ikuti asumsi-asumsi berikut dari versi generik:

| Asumsi generik | Realita di repo ini |
|---|---|
| React pages, tabel, modal | **Fastify + Nunjucks + HTMX** (`apps/web-admin`). Tidak ada SPA, tidak ada React. |
| WebSocket events | Tidak ada layer WebSocket/SSE/socket.io di repo. Realtime memakai **HTMX polling** (`hx-trigger="every Ns"`), persis seperti `apps/storefront/views/pay.njk` dan `apps/web-admin/views/_sla.njk`. |
| Payment gateway: Tripay, Midtrans, Xendit, Stripe, Paypal | Gateway yang **benar-benar terpasang**: `BINANCE_PAY` (manual, approve admin), `BINANCE_INTERNAL` & `BYBIT` (auto-confirm via poller UID/amount-match), `TOKOPAY` & `PAYDISINI` (webhook `POST /pay/<provider>/callback` di `apps/storefront/src/routes/checkout.ts`), `NOWPAYMENTS` (IPN webhook). Jangan tambah Tripay/Midtrans/Stripe/Paypal kecuali memang diminta eksplisit sebagai item terpisah. |
| `inventory` + `inventory_allocations` tabel baru | Sudah ada `StockItem` (`stock_items`) dengan status `AVAILABLE/RESERVED/SOLD/DEAD`, dan `OrderItem.stockItemId` sudah menjadi relasi alokasi 1 unit = 1 baris. **Tidak perlu tabel baru** — perluas yang ada. |
| `payment_events` tabel generik untuk idempotency | Sudah ada per-provider: `ProcessedBinanceTx`, `ProcessedBybitTx`, `ProcessedTokopayTx`, `ProcessedPaydisiniTx`, `ProcessedNowpaymentsTx` — semua dengan kolom UNIQUE pada tx id. Pertahankan pola per-provider ini, jangan konsolidasi ke satu tabel generik. |
| `FOR UPDATE SKIP LOCKED` (Postgres) | DB-nya **SQLite** (single writer). Pola yang sudah dipakai dan harus diikuti: `updateMany({ where: { id, status: AVAILABLE } })` + retry loop optimistik — lihat `allocateOneAvailableStock` di `packages/db/src/crud/stock.ts:130-156`. Jangan pakai row-lock ala Postgres. |
| "Horizontally scalable, concurrent workers" | `CLAUDE.md`: *"Shared SQLite is single-writer ... trigger to move to Postgres is ≥2 concurrent writers."* Worker baru harus berupa **satu proses polling-loop** (seperti `packages/outbox-dispatcher`), bukan banyak worker konkuren. Jangan desain untuk horizontal scaling sampai memang pindah ke Postgres. |
| i18n `t()` di semua UI | `apps/web-admin` **English-only**, tidak ada wiring `t()` (cek `apps/web-admin/views/base.njk`). String UI baru di web-admin tetap bahasa Inggris seperti yang sudah ada. Aturan "No leaked English" di `CLAUDE.md` hanya berlaku untuk string **customer/admin-facing di bot** (lewat `packages/core/locales/{en,id}.json`) — pesan DM baru (mis. "your order is now queued") wajib lewat `t()` dengan key di kedua file locale. |
| Status enum generik `UNPAID/PAID/QUEUED/...` | Enum asli di `packages/core/src/enums.ts` (`OrderStatus`): `PENDING_PAYMENT, PENDING_VERIFICATION, PAID, DELIVERED, CANCELLED, REJECTED, REFUNDED, UNDERPAID`. Tambahkan state baru secara **aditif** (lihat §1), jangan rename/hapus yang sudah dipakai BINANCE_PAY & poller flow. |

---

## 0.1. Wajib: semua UI baru di prompt ini harus mobile-friendly

Admin akan mengelola order ini dari HP, jadi ini bukan "nice to have." Repo
sudah punya preseden langsung untuk kelas bug ini —
`fix/admin-mobile-popover-overflow` (commit `cc91d34`,
"keep the ⋮ popover and stat-card grids on-screen on narrow phones") — pakai
pola yang sama persis, jangan reinvent:

- **Action menu** (Retry/Cancel/Refund/Force Deliver/Move Queue Priority/
  Rebuild Queue, §7): jangan deretan tombol mentah di baris tabel — itu yang
  bikin `data-table` overflow horizontal di HP. Pakai macro `dropdown()` yang
  sudah ada (`packages/web-ui/views/_macros.njk:184-194`) — panelnya sudah
  jadi bottom-sheet ter-pin viewport di bawah breakpoint `sm`
  (`max-sm:!fixed max-sm:!left-4 max-sm:!right-4 max-sm:!bottom-4` dst.),
  persis perbaikan yang sudah dipakai untuk menu edit denomination/category di
  `catalog.njk`/`product_detail.njk`.
- **Tidak ada macro modal generik di repo ini** — `_macros.njk` cuma punya
  `dropdown()` dan `dropzone()`. Add Inventory (§8) dan Force Deliver (§6)
  sama-sama butuh form di atas konten Order Detail: tambahkan **satu** macro
  `modal()` baru ke `_macros.njk` yang mengkloning teknik bottom-sheet
  `dropdown()` di atas, dipakai ulang oleh keduanya — jangan bikin dua overlay
  terpisah di dua file view, dan jangan pasang library modal baru.
- **Tabel `orders.njk`** (§10) sudah dibungkus `overflow-x-auto`
  (`orders.njk:35`) — audit UX (`docs/audit-ui-ux-2026-06-21.md` finding 2.2)
  menandai ini "acceptable tapi sebaiknya jadi daftar kartu di mobile."
  Karena halaman ini jadi command center yang dipakai dari HP, naikkan level:
  di bawah `sm` render tiap order sebagai kartu label–nilai (Code/Customer/
  Status/Progress/Total/Placed + tombol Open), tabel aslinya tetap tampil di
  ≥`sm` — pola dua-rendering (`hidden sm:block` pada `<table>`, `sm:hidden`
  pada list kartu).
- **Form fields baru** (Force Deliver, Add Inventory single+bulk, Move Queue
  Priority, alasan Cancel/Refund): ikuti pola yang sudah diperbaiki di
  `order_detail.njk:60-64` untuk form reject — container `class="flex
  flex-wrap gap-2"` + input `class="field w-full sm:w-64"` (bukan `w-64`
  polos), supaya field tidak memaksa scroll horizontal saat barisnya wrap di
  layar sempit.
- **Tombol aksi order** pakai `.btn` biasa, bukan `.btn-sm`/`.chip` — audit UX
  finding 5.1 menandai keduanya di bawah ~40-44px area sentuh, cukup untuk
  aksi sekunder tapi jangan dipakai untuk aksi yang ditekan berulang di HP
  seperti Force Deliver/Retry/Refund.
- **Grid kolom** Order Detail tetap `grid-cols-1 lg:grid-cols-3` yang sudah
  ada (`order_detail.njk:16`) — progress bar/timeline/info queue masuk
  sebagai `card card-pad` baru di dalam struktur kolom yang sama, jangan
  tambah blok lebar yang memotong breakpoint ini (audit finding 6.2 sudah
  menandai 3-kolom ini agak sempit di rentang tablet — jangan diperparah).
- Kalau ada container tinggi-penuh baru (mis. bottom-sheet `modal()` di
  atas), pakai `dvh`/`svh`, bukan `vh` — `vh` pecah saat keyboard HP muncul
  (audit finding 1.1/5.2).

---

## 1. OrderStatus — perluasan aditif

State machine saat ini: `PENDING_PAYMENT → PENDING_VERIFICATION → DELIVERED`
(manual proof) atau auto-confirm langsung ke `DELIVERED`, dengan cabang
`CANCELLED/REJECTED/REFUNDED/UNDERPAID`. Semua *checkout* hari ini bersifat
all-or-nothing: kalau stok kurang, `createOrderFromCart` langsung melempar
error (`packages/db/src/crud/orders.ts` sekitar baris 212) — order tidak
pernah dibuat.

Tambahkan 3 state baru ke `OrderStatus` di `packages/core/src/enums.ts` (jangan
ubah 8 state yang sudah ada):

```ts
QUEUED,      // PAID, tapi stok belum cukup untuk semua unit (partial atau 0 unit teralokasi)
PROCESSING,  // worker/admin sedang mengalokasikan atau force-deliver sedang berjalan
FAILED,      // alokasi/delivery gagal permanen, butuh retry manual admin
```

Flow baru (hanya berlaku untuk produk yang ditandai `deliveryType` selain
`INSTANT`, lihat §2 — produk lama default tetap berperilaku seperti sekarang):

```
PENDING_PAYMENT → PAID → QUEUED → PROCESSING → DELIVERED
                              ↑__________________|   (partial: kembali QUEUED, progress naik)
                  PROCESSING → FAILED → (retry admin) → PROCESSING → DELIVERED
```

`DELIVERED` hanya boleh ditulis ketika **semua** `OrderItem` milik order itu
punya `stockItemId` terisi (lihat §3). Jangan pakai kolom
`deliveredQty/orderedQty` terpisah kecuali ada alasan performa — keduanya bisa
dihitung dari `count(OrderItem)` vs `count(OrderItem where stockItemId not null)`,
konsisten dengan gaya repo yang menghindari state terdenormalisasi tanpa
kebutuhan nyata.

## 2. DeliveryType — field baru, bukan tabel baru

Tambahkan enum `DeliveryType { INSTANT, MANUAL, PREORDER }` ke
`packages/core/src/enums.ts`, dan kolom `deliveryType String @default("INSTANT")`
pada model `Denomination` (bukan `Order` — ini sifat produk, bukan transaksi).

- **INSTANT** (default, perilaku eksisting tidak berubah): checkout tetap
  all-or-nothing seperti sekarang. Tidak ada perubahan ke produk lama.
- **PREORDER**: checkout boleh melanjutkan walau stok kurang. Alokasikan
  sebanyak yang tersedia, buat sisa `OrderItem` dengan `stockItemId = null`
  (kolom ini sudah nullable, lihat `prisma/schema.prisma:274`). Status order →
  `QUEUED` jika ada unit belum teralokasi, atau `DELIVERED` jika langsung
  penuh.
- **MANUAL**: tidak pernah auto-allocate dari `StockItem`. Begitu `PAID`,
  langsung `QUEUED` menunggu admin **Force Deliver** (lihat §6).

## 3. Partial delivery — pakai relasi `OrderItem` yang sudah ada

Codebase ini sudah memodelkan "1 unit = 1 `OrderItem`" (lihat
`createOrderFromCart`, `packages/db/src/crud/orders.ts:218-228`: loop
`for (let k = 0; k < ci.quantity; k++)` membuat satu `OrderItem` per unit,
masing-masing dengan `quantity: 1`). Ini ternyata fondasi yang pas untuk
partial delivery generik — **tidak perlu kolom `delivered_qty`/`pending_qty`
baru di `Order`**:

- `ordered_qty` = `count(OrderItem where orderId = X)`
- `delivered_qty` = `count(OrderItem where orderId = X AND stockItemId IS NOT NULL)`
- `pending_qty` = selisihnya

Perubahan yang dibutuhkan:

1. Untuk produk `PREORDER`, izinkan `createOrderFromCart` membuat `OrderItem`
   dengan `stockItemId: null` untuk unit yang tidak kebagian stok saat
   checkout (saat ini fungsi melempar `ValidationError` dan tidak membuat apa
   pun jika `available < ci.quantity`).
2. Tambah fungsi `allocatePendingOrderItems(db, orderId)` di
   `packages/db/src/crud/orders.ts` yang, dalam `prisma.$transaction`, mencari
   `OrderItem` milik order itu dengan `stockItemId: null`, lalu untuk masing-masing
   memanggil `allocateOneAvailableStock` (sudah ada, sudah optimistic-locked —
   jangan tulis ulang). Begitu semua `OrderItem` terisi, set
   `status: DELIVERED, deliveredAt: now()` dan enqueue
   `ORDER_DELIVERED_DM` ke `notification_outbox` (jangan kirim Telegram
   langsung dari sini).
3. Progress bar di UI = `delivered_qty / ordered_qty` — query, bukan kolom.

## 4. Queue worker — proses baru, pola sama dengan `outbox-dispatcher`

Buat module baru `packages/queue-worker` (atau tambahkan ke
`packages/outbox-dispatcher` jika lebih disukai satu paket) yang **mengkloning
pola** `runDispatcher`/`drainBatch` di
`packages/outbox-dispatcher/src/dispatcher.ts:61-74`:

- Loop polling tiap N detik (env baru, misal `QUEUE_POLL_INTERVAL_SECONDS`),
  berhenti saat `AbortSignal` (mengikuti pola shutdown di `apps/server`).
- Tiap tick: ambil order `status = QUEUED ORDER BY paidAt ASC` (FIFO,
  bukan `FOR UPDATE SKIP LOCKED` — SQLite single-writer sudah menyerialkan
  penulis; cukup proses satu-per-satu dalam satu proses, **tidak** banyak
  worker konkuren).
- Set `status: PROCESSING, processingAt: now()` sebelum mencoba alokasi
  (kolom baru di `Order`, sejalan dengan `paidAt/deliveredAt` yang sudah ada).
- Panggil `allocatePendingOrderItems` (§3). Sukses penuh → `DELIVERED`.
  Sukses sebagian → balik ke `QUEUED` (progress naik). Exception → `FAILED`
  + `failureReason` (kolom baru di `Order`, string).
- **Watchdog zombie order**: di awal tiap tick, cari order
  `status = PROCESSING AND processingAt < now() - 5 menit` → kembalikan ke
  `QUEUED` dan catat di `audit_logs` (`action: "queue_watchdog_recover"`).
  Ini pengganti "worker heartbeat / automatic recovery" dari prompt generik —
  tidak perlu distributed lock karena cuma satu proses worker.
- Daftarkan start-up-nya di `apps/server/src/index.ts` (composition root),
  persis seperti `runDispatcher` di-start hari ini.

## 5. `resumeQueuedOrders(productId)` — auto-resume setelah stok masuk

Tambahkan fungsi ini ke `packages/db/src/crud/stock.ts`, dipanggil otomatis
tepat setelah `bulkAddStock` sukses — dari **dua** tempat:

1. Route eksisting `POST /stock/:productId/add`
   (`apps/web-admin/src/routes/stock.ts`).
2. Route baru "Add Inventory" di **Order Detail** (§7) — supaya admin tidak
   pernah harus pindah ke halaman Stock/Products saat menangani satu order.

Implementasi: query `OrderItem` dengan `stockItemId: null` milik order
`QUEUED`/`PROCESSING` untuk `productId` itu, urutkan lewat `order.paidAt ASC`
(FIFO), lalu panggil `allocatePendingOrderItems` per order sampai stok baru
habis atau semua order kebagian. Tidak perlu menunggu tick worker berikutnya.

## 6. Force Deliver — untuk produk `MANUAL`

Tombol di Order Detail: **Force Deliver**. Membuka form admin untuk
mengetik/paste kredensial manual (email/password/profile/pin/notes — field
yang sama dengan modal Add Inventory di §8, tapi langsung terikat ke order
ini, bukan masuk ke stok umum). Pakai macro `modal()` baru dari §0.1, dengan
field mengikuti pola `w-full sm:w-64` + `flex-wrap`. Aksi:

1. `status → PROCESSING`.
2. Buat satu `StockItem` baru `status: SOLD` langsung (skip `AVAILABLE`,
   tidak boleh terlihat sebagai stok yang bisa dialokasikan ke order lain),
   `orderId` & `soldAt` terisi, `credentials` = input admin.
3. Tautkan ke satu `OrderItem` yang masih `stockItemId: null`.
4. Audit log `action: "force_deliver"`, simpan siapa adminnya — **jangan**
   simpan kredensial di kolom `details` (ikuti larangan "never log secrets"
   di `CLAUDE.md`; cukup `order_code` + jumlah unit).
5. Jika semua unit order sudah terisi → `DELIVERED`, enqueue
   `ORDER_DELIVERED_DM`.

## 7. Retry / Cancel / Refund / Move Queue Priority / Rebuild Queue

Tambahkan sebagai route baru di `apps/web-admin/src/routes/orders.ts`,
mengikuti **persis** pola `POST /orders/:orderId/approve` yang sudah ada
(baris 88-115): `csrfProtect` preHandler → `prisma.$transaction` → fungsi crud
baru di `packages/db/src/crud/orders.ts` → `logAdminAction` di transaksi yang
sama → `redirectWithFlash`.

Di tabel `orders.njk`/Order Detail, kelompokkan **semua** baris di bawah ini
ke dalam satu macro `dropdown()` ("⋮ Actions") per order — lihat §0.1. Jangan
render sebagai tombol-tombol sejajar di baris tabel.

| Route | Fungsi crud baru | Aksi audit | Catatan |
|---|---|---|---|
| `POST /orders/:orderId/retry` | `retryFailedOrder` | `retry_order` | `FAILED → QUEUED`, reset `failureReason: null` |
| `POST /orders/:orderId/cancel` | (perluas `cancelOrder` yang ada) | `cancel_order` | Sudah ada untuk `PENDING_PAYMENT`; perluas guard agar juga valid dari `QUEUED`/`PROCESSING`, lepas semua `StockItem RESERVED` balik ke `AVAILABLE` |
| `POST /orders/:orderId/refund` | `refundOrder` (baru) | `refund_order` | `PAID/DELIVERED → REFUNDED`; tentukan kebijakan refund ke wallet vs gateway sebagai keputusan produk terpisah — jangan asumsikan |
| `POST /orders/:orderId/queue/priority` | `setQueuePriority` (baru, kolom `Order.queuePosition Int?` opsional) | `queue_priority_change` | Hanya perlu kalau FIFO murni (`paidAt ASC`) tidak cukup buat kebutuhan bisnis — pertimbangkan apakah benar dibutuhkan sebelum menambah kolom |
| `POST /orders/rebuild-queue` | `rebuildQueue` (baru) | `queue_rebuild` | Re-evaluasi semua order `QUEUED` untuk semua produk (panggil `resumeQueuedOrders` massal) — tombol darurat, bukan operasi rutin |

## 8. Add Inventory — langsung dari Order Detail

Modal HTMX (bukan modal React) yang membungkus endpoint **yang sudah ada**
`POST /stock/:productId/add` (`apps/web-admin/src/routes/stock.ts`), dibuka
dari tombol **+ Add Inventory** di Order Detail (`order_detail.njk`).
`productId` diambil dari order yang sedang dilihat — admin tidak perlu
memilih produk atau pindah halaman. Pakai macro `modal()` baru dari §0.1
(bottom-sheet di HP, dialog biasa di ≥`sm`) — jangan bikin overlay baru
khusus untuk form ini.

- **Single account**: form `email/password/profile/pin/notes` → digabung jadi
  satu baris `credentials` string (format yang sama dengan yang sudah dipakai
  `bulkAddStock`).
- **Bulk textarea**: satu baris per akun, format
  `email:password` (sesuai contoh) — split `\r?\n` seperti yang sudah dipakai
  route stock eksisting.
- **CSV import**: validasi baris, skip duplikat — `bulkAddStock` di
  `packages/db/src/crud/stock.ts:17-49` **sudah** melakukan ini (dedupe
  terhadap batch & terhadap `AVAILABLE/RESERVED/SOLD`), tinggal parse CSV jadi
  array string sebelum dipanggil. Tampilkan `{ added, skipped }` yang sudah
  dikembalikan fungsi itu sebagai pesan sukses.
- Setelah submit sukses → panggil `resumeQueuedOrders(productId)` (§5) →
  redirect balik ke Order Detail (HTMX swap, bukan full reload) dengan flash
  "Added N, skipped M — order resumed".

## 9. Order Detail — apa yang harus ditampilkan

Perluas `apps/web-admin/views/order_detail.njk` (sudah ada untuk
approve/reject) menjadi command center:

- Customer, Product, Ordered/Delivered/Pending Qty (dihitung, §3), Queue
  Position (jika dipakai, §7), Payment Provider, Status.
- **Progress bar**: `delivered_qty / ordered_qty`, contoh "7 / 10 Delivered
  (70%)".
- **Timeline** dengan timestamp asli (jangan field baru kalau sudah ada):
  `createdAt → paidAt → processingAt(baru) → deliveredAt` ditambah
  `failedAt(baru)/cancelledAt(sudah ada via status+updatedAt)/refundedAt`.
- Tombol aksi kondisional pada status, mengikuti pola `can_act`/`can_credit`
  yang sudah ada di route (`orders.ts:76-82`): Retry (FAILED), Force Deliver
  (MANUAL & ada unit pending), Cancel, Refund, Add Inventory (selalu, kalau
  ada unit pending), Move Queue Priority / Rebuild Queue (QUEUED).
- **Realtime**: `hx-get="/orders/:orderId/status" hx-trigger="every 5s"`
  selama status `QUEUED/PROCESSING`, berhenti polling begitu status terminal
  — pola identik dengan `payState()` polling di
  `apps/storefront/src/routes/checkout.ts` & `pay.njk`. **Jangan** bikin
  WebSocket/SSE baru.
- **Mobile**: pertahankan grid `grid-cols-1 lg:grid-cols-3` yang sudah ada,
  tombol aksi pakai `.btn` (bukan `.btn-sm`), dan kelompokkan aksi sekunder ke
  `dropdown()` — lihat §0.1.

## 10. Sales → Orders (list) — tab & kolom baru

Nav sudah benar di `apps/web-admin/views/base.njk` (`Sales` group → `Orders`,
`Automatic payments`, `Customer notifications`) — tidak perlu menu baru.
Perluas `orders.njk` + route list (`orders.ts:33-63`):

- Tab/filter status: tambahkan `QUEUED, PROCESSING, FAILED` ke
  `STATUS_VALUES` (otomatis ikut karena di-derive dari
  `Object.values(OrderStatus)`, `orders.ts:30`) di samping 8 status lama.
- Counter per tab: `countOrders(prisma, { status })` per status (fungsi
  sudah ada, dipakai). Tinggal render di template.
- Kolom tabel baru: Progress (`delivered/ordered`), Delivery Type, Queue
  Position, Waiting Time (`now() - paidAt` untuk yang masih `QUEUED`),
  Failure Reason (untuk `FAILED`).
- List bisa polling counter tiap 30s seperti `_sla.njk`, tapi opsional —
  jangan auto-refresh seluruh tabel kalau bikin pengalaman admin "lompat"
  saat sedang dibaca.
- **Mobile**: di bawah `sm`, render daftar order sebagai kartu (bukan tabel
  yang harus digeser) — lihat §0.1 untuk pola dua-rendering dan macro
  `dropdown()` untuk kolom Actions.

## 11. Webhook payment gateway — perketat titik masuk ke fulfillment, bukan rombak ulang

`TOKOPAY`/`PAYDISINI`/`NOWPAYMENTS` webhook (`apps/storefront/src/routes/checkout.ts`)
dan poller `BINANCE_INTERNAL`/`BYBIT` **sudah** punya idempotency per-provider
(`Processed*Tx` UNIQUE pada tx id) dan **sudah** verifikasi signature — jangan
sentuh itu. Satu-satunya perubahan: titik di mana mereka memanggil delivery
harus bercabang berdasarkan `deliveryType` produk:

- `INSTANT` & stok cukup → perilaku hari ini, tidak berubah (`PAID → DELIVERED`
  langsung).
- `INSTANT`/`PREORDER`/`MANUAL` & stok tidak cukup → `PAID → QUEUED` (bukan
  error/exception seperti sekarang) lalu serahkan ke queue worker (§4).

Jangan tambah endpoint `/webhooks/payment` generik — provider-provider ini
sudah punya endpoint sendiri-sendiri dan sengaja dipisah biar payload/signature
masing-masing tervalidasi sesuai bentuk aslinya.

## 12. Audit log — pakai `logAdminAction` yang sudah ada

Jangan buat sistem audit baru. Setiap aksi baru di §4-§8 **wajib** memanggil
`logAdminAction(tx, { adminId, action, targetType: "order", targetId, details })`
dari `packages/db/src/crud/audit.ts:7-26`, di dalam `$transaction` yang sama
dengan mutasi datanya (pola eksisting di `orders.ts:91-100`). Action string
baru yang konsisten dengan penamaan yang sudah ada (`approve_order`,
`stock_upload`, dst.): `retry_order`, `cancel_order` (perluas yang sudah ada
kalau ada), `refund_order`, `force_deliver`, `queue_priority_change`,
`queue_rebuild`, `queue_watchdog_recover`, `add_inventory_from_order`.

## 13. Anti ghost order — sebagian besar sudah selesai

Sudah ditangani, **jangan dibangun ulang**:

- Duplicate webhook / payment replay → `Processed*Tx` UNIQUE per provider.
- Overselling / double delivery → `allocateOneAvailableStock` optimistic
  `updateMany(... where status=AVAILABLE)` + retry; `bulkAddStock` dedupe
  kredensial; `OrderItem.order` relasi `onDelete: Restrict` (tidak pernah
  hard-delete order).
- Race condition pembeli ganda → ditangani di level transaksi
  `createOrderFromCart`.

Risiko **baru** yang muncul khusus karena ada queue (belum ada solusinya,
harus dibangun): **stuck `PROCESSING`** — diselesaikan oleh watchdog di §4.
Tidak perlu distributed lock/idempotency-key tambahan — semuanya jalan dalam
satu proses Node per `CLAUDE.md` ("single-writer... trigger pindah Postgres
adalah ≥2 concurrent writer").

## 14. Test

Ikuti konvensi `CLAUDE.md`: `pnpm typecheck` dan `pnpm test` harus tetap
hijau. Tambahkan:

- Unit test crud di `packages/db/src/crud/*.test.ts` — kolokasi dengan kode
  yang ditest, mengikuti gaya `stock_deduction.test.ts` /
  `purchase_flow.test.ts` / `order_creation.test.ts` yang sudah ada:
  - `allocatePendingOrderItems`: alokasi penuh, alokasi parsial, tidak ada
    stok sama sekali (tetap `QUEUED`).
  - `resumeQueuedOrders`: FIFO benar berdasarkan `paidAt`, tidak
    mengalokasikan ke order yang sudah `CANCELLED`/`REFUNDED`.
  - Watchdog: order `PROCESSING` lewat threshold kembali ke `QUEUED`.
  - Force Deliver: tidak pernah membuat `StockItem` berstatus `AVAILABLE`
    secara tidak sengaja (harus langsung `SOLD`).
- Trio happy/auth-fail/bad-csrf untuk setiap route POST baru di
  `apps/web-admin/src/routes/orders.ts`, persis seperti yang sudah ada untuk
  `/orders/:orderId/approve`.

## 15. Checklist implementasi (urutan disarankan)

1. Migrasi Prisma **aditif**: `Denomination.deliveryType`, `Order.processingAt`,
   `Order.failedAt`, `Order.failureReason`, (opsional) `Order.queuePosition`.
   Tidak ada drop/rename kolom.
2. `OrderStatus`/`DeliveryType` di `packages/core/src/enums.ts`.
3. `packages/db/src/crud/orders.ts`: `allocatePendingOrderItems`,
   `retryFailedOrder`, `refundOrder`, perluasan `cancelOrder`.
4. `packages/db/src/crud/stock.ts`: `resumeQueuedOrders`.
5. Worker baru (§4) — daftarkan di `apps/server/src/index.ts`.
6. Webhook/poller existing: ubah titik percabangan delivery (§11) — minimal
   diff, jangan rewrite handler.
7. Route admin baru/perluasan di `apps/web-admin/src/routes/orders.ts` (§7,
   §8) + `logAdminAction` di tiap aksi.
8. Views: `orders.njk` (tab+kolom, §10), `order_detail.njk` (progress, timeline,
   tombol, polling, modal Add Inventory, §6-§9).
9. Locale baru di `packages/core/locales/{en,id}.json` **hanya** untuk pesan
   DM bot yang baru (mis. notifikasi "order is queued/resumed"), bukan untuk
   web-admin.
10. Test (§14) → `pnpm typecheck && pnpm test` hijau sebelum PR.
11. QA manual di viewport ~360-390px lebar (devtools mobile emulation atau HP
    asli) untuk setiap view baru/diperluas — kartu Sales→Orders, `dropdown()`
    Actions, `modal()` Add Inventory & Force Deliver, polling status — sebelum
    PR (§0.1).
