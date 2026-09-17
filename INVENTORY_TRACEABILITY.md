# Inventory Traceability — Arsitektur Keterlacakan Stok

Ringkasan bagaimana repo ini melacak satu kredensial digital dari masuk
gudang sampai terjual (atau mati/dihapus), dan siapa/apa yang menyentuhnya di
sepanjang jalan. Tidak ada modul bernama literal "Inventory Traceability" di
kode — keterlacakan ini adalah hasil komposisi dari model `StockItem`,
link-nya ke `OrderItem`, timestamp per status, enkripsi kredensial, dan dua
lapisan audit (`OrderStatusHistory`, `AuditLog`).

**Penting**: `StockItem` cuma satu dari dua jalur fulfillment yang ada di
repo, dan bukan yang dominan di produksi — sebagian besar SKU top-up hasil
sync Digiflazz sama sekali tidak punya baris `StockItem` (§4). §1-§3 di
bawah murni tentang SKU yang distok lokal.

## 1. Unit dasar — `StockItem` (`prisma/schema.prisma:572`)

Satu baris = satu kredensial digital (akun/voucher/dsb) milik satu
`Denomination` (SKU; kolom relasinya masih bernama `product`/`product_id`
untuk source-compat).

```
StockItem {
  id, productId            // -> Denomination (SKU)
  credentials              // terenkripsi AES-256-GCM (@app/core/credentialCrypto)
  status                   // AVAILABLE | RESERVED | SOLD | DEAD
  orderId                  // order yang memakai baris ini (null jika belum)
  addedAt, reservedAt, soldAt   // timeline penuh per unit
  note                     // catatan admin (mis. alasan DEAD)
}
```

Setiap tulis kredensial mengenkripsi; setiap baca yang mengembalikan
plaintext ke caller mendekripsi secara eksplisit. Baca yang hanya perlu tahu
"baris ini ada" (`getStockItem`, `listStockItemsForProduct`) **tidak**
mendekripsi — jalur ini memberi makan list admin yang default masked dan
stock browser bot, yang keduanya tidak boleh membawa plaintext lewat kode
yang tidak seharusnya.

### Gap: rotasi kunci enkripsi belum didukung

Envelope yang tersimpan di `credentials` berbentuk `{ keyVersion, iv,
ciphertext, authTag }` (`packages/core/src/credentialCrypto.ts:36-41`),
AES-256-GCM dengan IV acak per enkripsi — tapi versioning-nya baru
scaffolded: `CURRENT_KEY_VERSION = 1` (`:34`) dan `keyForVersion` menolak
versi selain itu (`:64-88`), jadi cuma ada satu key aktif yang dibaca dari
env `CREDENTIAL_ENCRYPTION_KEY`, tidak ada tabel multi-key.

**Risiko nyata**: kalau `CREDENTIAL_ENCRYPTION_KEY` dirotasi (env value
diganti) tanpa migrasi manual, semua `StockItem.credentials` lama (masih
`keyVersion: 1`) akan gagal didekripsi permanen — GCM auth tag mismatch,
bukan silent-garbage — karena tidak ada fallback ke key lama. Jadi "rotasi
kunci" hari ini efektif operasi satu arah yang merusak riwayat, kecuali
admin re-encrypt semua baris lama dulu sebelum ganti env var.

Ada juga fallback legacy-plaintext (`credentialCrypto.ts:132-154`): nilai
yang bukan JSON/tidak match bentuk envelope dikembalikan apa adanya — ini
kasus beda dari "terenkripsi tapi key-nya salah" di atas, untuk baris
pra-enkripsi yang belum tersentuh backfill satu-kali.

## 2. Siklus hidup & guard rails — `packages/db/src/crud/stock.ts`

### Masuk (import)
`bulkAddStock` — dedup dua arah: terhadap batch yang sama (mis. CSV yang
sama ditempel dua kali) *dan* terhadap baris AVAILABLE/RESERVED/SOLD yang
sudah ada di DB. Dedup tidak bisa lewat SQL `credentials IN (...)` karena IV
acak per enkripsi membuat ciphertext berbeda meski plaintext sama — jadi
fungsi ini mengambil semua baris eksisting, mendekripsi, lalu membandingkan
di memori (O(baris eksisting) per panggilan; diterima karena tabel ini
low-volume per desain).

### Reservasi (checkout)
`allocateOneAvailableStock` (`stock.ts:203`) — ambil satu baris AVAILABLE
`ORDER BY id ASC`, lalu `updateMany` dengan guard `status: AVAILABLE` sebagai
optimistic lock, retry hingga 5x kalau kalah race. Baris yang menang
langsung ditandai RESERVED + `orderId` + `reservedAt`.

### Terjual (pelunasan)
Di `packages/db/src/crud/orders.ts` (`settlePaidOrder`, ~L1575-1591):
RESERVED → SOLD, `soldAt` di-set, dalam transaksi yang sama dengan pelunasan
order. Kalau baris reservasi ternyata sudah tidak RESERVED lagi (kasus
tepi), fungsi ini mengalokasikan pengganti lewat `allocateOneAvailableStock`
dan menulis ulang `OrderItem.stockItemId`.

### Rollback (order batal/expired)
`orders.ts:1266-1269` — kalau order dibatalkan/kedaluwarsa sebelum lunas,
baris RESERVED dikembalikan ke AVAILABLE (`orderId`/`reservedAt` di-null-kan)
supaya stok itu bisa dijual lagi ke buyer lain.

### Tidak bisa diubah/dihapus setelah SOLD
- `markStockDead` / `bulkMarkStockDead` — hanya menyentuh baris yang masih
  AVAILABLE/RESERVED; SOLD/DEAD dibiarkan.
- `bulkDeleteStock` / `deleteStockItem` — menolak baris berstatus SOLD *atau*
  yang sudah direferensikan oleh `orderItems`.

Prinsipnya sama di keduanya: kredensial yang sudah terkirim ke pembeli tidak
pernah boleh berubah atau hilang diam-diam.

### Refund tidak me-restock
`packages/db/src/crud/refunds.ts` murni menangani sisi uang (jumlah refund,
`RefundItem`) — tidak menyentuh `StockItem` sama sekali. Kredensial yang
sudah SOLD dianggap terkirim permanen dan tidak pernah dikembalikan ke pool
AVAILABLE, sejalan dengan guard hapus di atas.

## 3. Sambungan ke Order — jejak "unit stok ini dijual ke order mana"

`OrderItem.stockItemId` (`prisma/schema.prisma:760`, nullable) adalah paper
trail utamanya: satu baris order-item terhubung ke persis satu `StockItem`.

- Dari sisi **order** → tahu persis kredensial mana yang dikirim untuk baris
  itu (`item.stockItem.credentials`, didekripsi di tempat oleh
  `withDecryptedStockCredentials` di `orders.ts:494` untuk order DELIVERED).
- Dari sisi **stock** → tahu order mana yang memakai kredensial itu
  (`StockItem.orderId`).

`stockItemId` nullable karena order manual/manual-with-info (fulfil tangan)
tidak pernah mengalokasikan `StockItem` — baris `OrderItem`-nya dibuat dengan
`stockItemId: null` (lihat komentar `orders.ts:906`).

## 4. Jalur fulfillment eksternal (Digiflazz) — SKU tanpa `StockItem`

Ini jalur yang justru menangani mayoritas SKU top-up di produksi, dan sama
sekali tidak lewat apa pun yang dijelaskan di §1-§3.

SKU hasil Digiflazz catalog sync selalu dibuat dengan
`deliveryType: MANUAL_WITH_INFO` (`packages/core/src/cartComposition.ts:27-30`),
**bukan** `"auto"` — jadi jangan disamakan dengan "auto delivery" di §1-§3.
Karena itu `settlePaidOrder` (`packages/db/src/crud/orders.ts:2123-2125`,
branch manual di `:2187-2241`) tidak pernah menyentuh `StockItem` untuk order
ini; jalur alokasi `approveOrder`/`allocateOneAvailableStock`
(`orders.ts:1574-1601`) sama sekali tidak terpanggil. "Stok" SKU ini murni
saldo/API pihak Digiflazz, bukan baris di tabel `stock_items`.

**Dispatch: dispatch + poll, bukan sinkron saat settle.**
- Order yang lunas parkir dulu di status PROCESSING (tidak ada panggilan
  Digiflazz saat settle).
- `dispatchPendingDigiflazzOrders` (`digiflazz.ts:434-581`) mengklaim satu
  order PROCESSING per iterasi lalu memanggil `createTransaction` Digiflazz.
- `"Sukses"` → `fulfillDigiflazzOrder` (`digiflazz.ts:598-650`) langsung
  PROCESSING→DELIVERED di pass yang sama.
- `"Pending"` → dijadwalkan recheck dengan backoff
  (`digiflazz.ts:346-375`, jendela 24 jam).
- `"Gagal"` atau backoff habis → gagal terminal, admin dialert, order tetap
  PROCESSING untuk difulfil tangan (`digiflazz.ts:382-396`).
- Ada juga webhook callback (`apps/storefront/src/routes/checkout.ts`,
  `POST /pay/digiflazz/callback`; referensi di `digiflazz.ts:16-19,258-260`)
  yang bisa memicu jalur sukses/gagal yang sama untuk order yang tadinya
  Pending — jadi dua mekanisme (poll + webhook) berjalan berdampingan.

**Jejak/trace fields — analog `stockItemId` untuk jalur ini:**
- `refId = order.orderCode` dikirim sebagai idempotency key ke Digiflazz
  (`digiflazz.ts:509-510`) — ini jawaban "order mana yang memicu transaksi
  supplier ini".
- Serial number dari supplier disimpan di `Order.deliveredContent` — kolom
  yang sama dipakai fulfillment manual (`digiflazz.ts:598-621`).
- Sub-status perjalanan di `Order.digiflazzStatus` /
  `digiflazzDispatchedAt` / `digiflazzAttempts` / `digiflazzNextRecheckAt` /
  `digiflazzFailureDetail` (`prisma/schema.prisma:666-698`) — semua
  di-null-kan lagi begitu DELIVERED, karena cuma relevan "in flight".
- `OrderStatusHistory.meta` diisi `"digiflazz_fulfill"`
  (`digiflazz.ts:638-640`) — beda dari `"manual_fulfill by admin_id=..."`
  (`orders.ts:2269-2271`) dan `"approved by admin_id=..."`
  (`orders.ts:1552-1554`), sehingga audit trail bisa membedakan
  auto-supplier vs fulfil tangan vs approve stok lokal.
- Tidak ada kolom trx-supplier di level `OrderItem`; `OrderItem.stockItemId`
  tetap null untuk semua baris jalur ini.

**Sync katalog tidak menyentuh stok**: `resyncDigiflazzCatalog`
(`digiflazz.ts:1242-1422`) cuma menyinkronkan `costPrice`/`price`/`isActive`
pada `Denomination` dari price list Digiflazz — tidak pernah menyentuh
`StockItem`, karena memang tidak ada baris lokal untuk disinkronkan.

## 5. `ProductProviderMapping` — routing multi-provider yang belum aktif

Model ini (`prisma/schema.prisma:535-570`) dirancang untuk melepas SKU dari
hard-binding ke Digiflazz lewat `Denomination.autoDeliverySource`/
`supplierSku`, lewat resolver `resolveDenominationProvider`
(`packages/db/src/crud/productProviderMappings.ts:75-106`) yang menghitung
ulang kedua field itu dari mapping berprioritas-tertinggi yang enabled.

**Belum ada pemanggil produksi** — dikonfirmasi oleh komentar di kode itu
sendiri (`productProviderMappings.ts:96-104`, dan `digiflazz.ts:421-432`:
*"not reachable today"*) dan oleh grep: `resolveDenominationProvider`/
`upsertProductProviderMapping` hanya dipanggil dari file crud-nya sendiri
dan test-nya. Poller `dispatchPendingDigiflazzOrders` masih hardcode
literal `autoDeliverySource: "digiflazz"` (`digiflazz.ts:442`), jadi
provider lain yang ditulis lewat tabel ini tidak akan pernah di-dispatch
oleh siapa pun hari ini.

KokinPay / VIP-Reseller / MeloStore (`packages/db/src/crud/{kokinpay,
vipreseller,melostore}.ts`) **bukan** provider fulfillment/stok — mereka
cuma credential reader untuk live nickname-check di storefront
(`Denomination.nicknameCheckGameCode` / `expectedRegionCode`,
`prisma/schema.prisma:376-401`), yang eksplisit didokumentasikan sebagai
"independen dari `autoDeliverySource`/`supplierSku` — bukan jalur
fulfilment", bukan bagian dari sistem stok manapun.

## 6. Notifikasi restock — dua jalur terpisah

Dua mekanisme berbeda bisa terpicu saat stok ditambahkan, dan keduanya
independen/aditif satu sama lain:

- **`broadcastOnRestock`** (blast ke SEMUA customer non-banned yang
  terhubung Telegram) — dipicu dari dua entry point "tambah stok" setelah
  `bulkAddStock`: `apps/web-admin/src/routes/api/stock.ts:256-262` dan
  `apps/order-bot/src/conversations/admin.ts:190-201` (keduanya digate
  `added > 0 && product.broadcastOnRestock`). Implementasinya
  `enqueueRestockBroadcast` (`packages/db/src/crud/notifications.ts:1110-1149`)
  menulis satu baris `notification_outbox` per user eligible (event
  `PRODUCT_RESTOCKED_BROADCAST`) plus satu baris `Broadcast` untuk tabel
  History di admin.
- **`RestockSubscription`** (opt-in per-SKU, DM sekali pakai) — HANYA
  dipicu dari conversation admin di order-bot
  (`apps/order-bot/src/conversations/admin.ts:188` →
  `notifyRestockSubscribers`, `apps/order-bot/src/handlers/admin.ts:642-670`).
  Beda dari yang di atas, ini kirim langsung lewat `ctx.api.sendMessage`
  (bukan lewat `notification_outbox`), dengan throttle antar-pesan, dan
  baris subscription baru dihapus (`deleteRestockSubscription`) **setelah**
  kirim sukses — supaya kirim yang gagal otomatis dicoba lagi di restock
  berikutnya. Rute web-admin **tidak** memicu jalur ini; ia cuma
  menampilkan jumlah subscriber (`countRestockSubscribers`).

Karena hanya satu dari dua entry point "tambah stok" (order-bot, bukan
web-admin) yang memicu DM per-subscriber, admin yang menambah stok lewat
web-admin perlu tahu bahwa subscriber opt-in tidak otomatis di-DM dari
sana.

## 7. Sold count — agregat baca, bukan counter tersimpan

`soldCountsByDenomination` / `soldCountForDenomination` /
`soldCountForProduct` (`packages/db/src/crud/orders.ts:2480-2519`) dan
`soldCountsByProduct` (`packages/db/src/crud/catalog.ts:1055-1080`,
sengaja diduplikasi dari yang di `orders.ts` untuk menghindari circular
import `catalog.ts ↔ orders.ts`) — semuanya `groupBy` atas
`OrderItem.quantity` where `Order.status === DELIVERED`. Ini bukan kolom
counter tersimpan, murni agregat baca real-time.

Implikasi traceability: refund tidak mengurangi angka ini (tidak ada
counter untuk dikurangi) — order yang sudah DELIVERED lalu di-refund tetap
terhitung "terjual" kecuali ada kode lain yang mengubah `Order.status`.
Konsisten dengan §2 "Refund tidak me-restock" — refund di repo ini memang
tidak mengubah state inventory sama sekali, baik `StockItem` maupun agregat
sold-count.

Status saat ini: menurut doc comment di `sold_counts.test.ts`, "nothing
consumes these yet" — fungsi-fungsi ini scaffolded untuk fitur "X Terjual"
dan "Produk Populer" yang belum dipakai UI mana pun.

## 8. Lapisan audit di atasnya

- **`OrderStatusHistory`** (`prisma/schema.prisma:737`) — timeline status
  order (`status`, `occurredAt`, `meta`). Relasinya `onDelete: Restrict` ke
  Order, jadi history tidak pernah bisa terhapus ikut order-nya walau di masa
  depan ada kode yang mencoba hard-delete Order.
- **`AuditLog`** (`prisma/schema.prisma:1498`) — jejak aksi admin/customer
  (`adminId`/`customerId`, `actorType`, `channel`, `correlationId`,
  `targetType`/`targetId`). Reveal kredensial stok
  (`revealStockCredentials`, `stock.ts:150`) **wajib** dicatat di sini
  sebagai `credential_revealed` oleh pemanggilnya (route-nya, bukan fungsi
  crud-nya, karena fungsi crud tidak punya admin id untuk diatribusikan) —
  lihat `apps/web-admin/src/routes/api/stock.ts`.
- **`RefundItem`** — jejak refund per line item, terpisah dari status stok
  (lihat §2, refund tidak me-restock).

## 9. Kenapa didesain seperti ini

Kredensial adalah aset sekali-pakai bernilai uang, jadi desainnya sengaja
paranoid di titik-titik "tidak boleh ganda / tidak boleh hilang jejak":

- Dedup lintas-enkripsi saat impor (mencegah dua kredensial identik terjual
  ke dua buyer berbeda — Stock-1 fix, security audit 2026-06-23).
- Optimistic lock saat alokasi (mencegah dua buyer mendapat baris yang
  sama).
- Larangan hapus/ubah baris SOLD (mencegah kredensial terkirim berubah/
  hilang diam-diam).
- Pemisahan baca "cek eksis" (tanpa dekripsi) vs baca "reveal" (wajib
  diaudit) — plaintext kredensial tidak pernah lewat jalur kode yang tidak
  seharusnya.

## Referensi file utama

- `prisma/schema.prisma` — model `StockItem`, `OrderItem`,
  `OrderStatusHistory`, `AuditLog`
- `packages/db/src/crud/stock.ts` — siklus hidup StockItem
- `packages/db/src/crud/orders.ts` (~L1266-1269, ~L1575-1596,
  ~L2123-2241, ~L2480-2519) — reservasi, rollback, pelunasan, branch
  auto vs manual, sold count
- `packages/db/src/crud/refunds.ts` — sisi uang refund (tidak menyentuh
  stock)
- `packages/core/src/credentialCrypto.ts` — enkripsi/dekripsi kredensial,
  key versioning
- `apps/web-admin/src/routes/api/stock.ts` — audit `credential_revealed`
- `packages/db/src/crud/digiflazz.ts` — dispatch/poll/webhook fulfillment
  Digiflazz, sync katalog
- `packages/core/src/cartComposition.ts` — kenapa SKU Digiflazz selalu
  `MANUAL_WITH_INFO`, tidak pernah punya stok lokal
- `packages/db/src/crud/productProviderMappings.ts` — routing
  multi-provider (belum aktif)
- `packages/db/src/crud/notifications.ts` — broadcast restock ke
  `notification_outbox`
- `apps/order-bot/src/conversations/admin.ts`,
  `apps/order-bot/src/handlers/admin.ts` — DM per-subscriber saat restock
- `packages/db/src/crud/catalog.ts` — `soldCountsByProduct`
