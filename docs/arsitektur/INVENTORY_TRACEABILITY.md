# Inventory Traceability — Arsitektur Keterlacakan Stok

Ringkasan bagaimana repo ini melacak satu kredensial digital dari masuk
gudang sampai terjual (atau mati/dihapus), dan siapa/apa yang menyentuhnya di
sepanjang jalan. Ini adalah dokumen "arsitektur seperti yang sudah dikirim"
(as shipped) setelah rencana hardening 7-fase "Stock Traceability &
Credential Encryption" + Track T ("tidak ada tampilan data
palsu/menyesatkan") selesai dikerjakan. Untuk status per-temuan audit (apa
yang sudah diperbaiki di fase mana, apa yang sengaja diterima sebagai risiko,
apa yang masih terbuka) lihat
[`audit-stock-traceability-fase0.md`](../archive/audit-stock-traceability-fase0.md).
Untuk langkah rollout operasional
(backfill, urutan flag, query produksi) lihat checklist di `DOCS.md` — tidak
diduplikasi di sini.

**Penting**: `StockItem` cuma satu dari dua jalur fulfillment yang ada di
repo, dan bukan yang dominan di produksi — sebagian besar SKU top-up hasil
sync Digiflazz sama sekali tidak punya baris `StockItem` (§10). §1-§9 di
bawah murni tentang SKU yang distok lokal.

## 1. Unit dasar — `StockItem` (`prisma/schema.prisma`)

Satu baris = satu kredensial digital (akun/voucher/dsb) milik satu
`Denomination` (SKU; kolom relasinya masih bernama `product`/`product_id`
untuk source-compat).

```
StockItem {
  id, productId                          // -> Denomination (SKU)
  credentials                            // terenkripsi AES-256-GCM (@app/core/credentialCrypto), envelope v1/v2
  status                                  // AVAILABLE | RESERVED | SOLD | DEAD (String biasa, bukan enum Postgres)
  orderId                                 // order yang SEDANG memakai baris ini (null kalau tidak)
  addedAt, reservedAt, soldAt             // timeline mutable per unit
  note                                    // catatan admin bebas (tidak pernah di-echo verbatim ke AuditLog, lihat §2)

  // Identitas & dedup (Fase 5a/5b — pipeline import, §4)
  identityFingerprint, credentialFingerprint   // HMAC-SHA256 keyed, bukan hash biasa (lihat §4)
  credentialKeyVersion                    // mirror query-only dari keyVersion di dalam envelope
  activeCredentialKey                     // klaim unik "{productId}:{credentialFingerprint}" selagi hidup; NULL saat DEAD/soft-deleted

  // Provenance (Fase 5a)
  addedByAdminId, importBatchId, supplierRef, unitCost

  // Penjualan (Fase 3b)
  soldToOrderId, soldToOrderItemId, warrantyUntil

  // Garansi (Fase 5e/7)
  replacesStockItemId                     // self-relation ke baris lama yang baris ini gantikan

  // Pengecekan manual (belum ada penulis kode; kolom disiapkan)
  lastCheckedAt, lastCheckResult

  // Soft delete (Fase 3a)
  deletedAt, deletedByAdminId
  deadReason                              // salah satu DeadReason, diisi saat markStockDead/bulkMarkStockDead
}
```

Setiap tulis kredensial mengenkripsi; setiap baca yang mengembalikan
plaintext ke caller mendekripsi secara eksplisit. Baca yang hanya perlu tahu
"baris ini ada" (`getStockItem`, `listStockItemsForProduct`) **tidak**
mendekripsi — jalur ini memberi makan list admin yang default masked dan
stock browser bot.

## 2. `StockItemEvent` — ledger siklus hidup (immutable)

`StockItemEvent` (`prisma/schema.prisma`) adalah log kejadian append-only per
`StockItem`, ditulis **bersamaan dengan** (bukan menggantikan) kolom mutable
di atas — jadi rollback/substitusi/penggantian garansi tidak lagi kehilangan
jejak ke null-out/overwrite seperti sebelum fase ini. Helper tulis tunggal:
`recordStockEvent`/`recordStockEvents` (`packages/db/src/crud/stockEvents.ts`)
— setiap pemanggil **wajib** berada di transaksi yang sama dengan perubahan
status yang dideskripsikannya.

```ts
export const StockEventType = {
  IMPORTED, RESERVED, RESERVATION_RELEASED, SOLD,
  SUBSTITUTED_OUT, SUBSTITUTED_IN, MARKED_DEAD,
  CREDENTIAL_REVEALED, REENCRYPTED, SOFT_DELETED, WARRANTY_REPLACED,
} // packages/core/src/enums.ts

export const StockActorType = { ADMIN, CUSTOMER, SYSTEM };
export const DeadReason = {
  PASSWORD_CHANGED, REGION_LOCK, SUPPLIER_REVOKED, EXPIRED, DUPLICATE, TEST, OTHER,
};
```

Kolom `eventType`/`actorType` di skema tetap `String` biasa (bukan enum
Postgres native) — `toRow()` di `stockEvents.ts` memvalidasi terhadap enum TS
di atas sebelum insert, jadi nilai sampah ditolak di level aplikasi, bukan DB.
`meta` adalah `Json?` (satu-satunya kolom di skema ini yang JSONB, bukan
`String?` seperti `OrderStatusHistory.meta`) — untuk detail terstruktur yang
mungkin di-query nanti, isinya **tidak pernah** kredensial.

**Siapa menulis event apa:**
| Event | Ditulis oleh | Catatan |
|---|---|---|
| `IMPORTED` | `bulkAddStock` (`stock.ts`) | satu event per baris baru, actor ADMIN/SYSTEM |
| `RESERVED` | `allocateOneAvailableStock` (`stock.ts`) | dipanggil checkout & `approveOrder`'s substitusi |
| `RESERVATION_RELEASED` | `releaseOrderHolds` (`orders.ts`) | **juga meng-null-kan `OrderItem.stockItemId`** untuk baris yang masih RESERVED — lihat §8 |
| `SOLD` | `approveOrder`/`settlePaidOrder` (`orders.ts`), dan `redeliverAfterWarrantyReplacement` (`stockReplacement.ts`) | flip ke SOLD selalu bersyarat (lihat §8) |
| `SUBSTITUTED_OUT` / `SUBSTITUTED_IN` | `approveOrder` (`orders.ts`) | pasangan event saat baris RESERVED lama sudah tidak valid dan digantikan baris baru; kedua status tetap null (bukan transisi status baris itu sendiri) |
| `MARKED_DEAD` | `bulkMarkStockDead`/`markStockDead` (`stock.ts`), dan penggantian garansi (`stockReplacement.ts`, baris lama) | `reasonCode` = `DeadReason` |
| `CREDENTIAL_REVEALED` | `revealStockCredentials` (reveal satu baris) **dan** `exportAvailableCredentials` (download massal `.txt`, satu event per baris yang diekspor) | `meta.via: "available_stock_download"` untuk yang massal |
| `REENCRYPTED` | `scripts/backfill-encrypt-stock-credentials.ts` dan re-encrypt v1→v2 | actor SYSTEM, `reasonCode` menandai backfill mana |
| `SOFT_DELETED` | `bulkDeleteStock`/`deleteStockItem` (`stock.ts`) | |
| `WARRANTY_REPLACED` | `redeliverAfterWarrantyReplacement` (`stockReplacement.ts`) | ditulis pada baris SPARE (baris baru) setelah event SOLD-nya sendiri |

**Timeline per-baris**: `listStockItemEvents(db, stockItemId)`
(`stockEvents.ts`) mengembalikan event terurut `occurredAt, id` dengan nama
aktor yang sudah di-resolve dan kode order — **tidak pernah** membawa
`credentials` atau `meta` mentah, jadi aman ditampilkan ke admin manapun
tanpa audit reveal tambahan. Ini backend untuk §6.

## 3. Siklus hidup & guard rails — `packages/db/src/crud/stock.ts`

### Masuk (import)
Lihat §4 — pipeline import penuh (dedup fingerprint, `StockImportBatch`,
klaim unik) menggantikan dedup decrypt-semua yang dulu dipakai untuk setiap
baris.

### Reservasi (checkout)
`allocateOneAvailableStock` — ambil satu baris AVAILABLE `ORDER BY id ASC`,
lalu `updateMany` dengan guard `status: AVAILABLE` sebagai optimistic lock,
retry hingga 5x kalau kalah race. Baris yang menang ditandai RESERVED +
`orderId` + `reservedAt`, dan menulis event RESERVED (actor + `orderItemId`
diteruskan dari pemanggil).

### Terjual (approve/pelunasan)
`approveOrder` (`orders.ts`) men-flip baris RESERVED ke SOLD **hanya jika
order ini masih benar-benar memegangnya** (`updateMany` berkondisi
`status: RESERVED, orderId: <order ini>, deletedAt: null`, bukan update tanpa
syarat dari snapshot pra-klaim) — lihat §8 untuk kenapa. Kredensial yang
dikirim ke pembeli didekripsi dari baris SETELAH flip, bukan dari snapshot
lama. Kalau baris sudah tidak RESERVED lagi (mis. admin men-`markStockDead`
di antara pembacaan order dan klaim), jalur ini jatuh ke substitusi
(`SUBSTITUTED_OUT`/`SUBSTITUTED_IN`) via `allocateOneAvailableStock`.

### Rollback (order batal/expired)
`releaseOrderHolds` (`orders.ts`) — satu-satunya fungsi yang menjalankan
transisi ini, dipanggil dari `cancelOrder`, `rejectOrder`, dan
`creditOrderToBalance`. Baris RESERVED milik order ini dikembalikan ke
AVAILABLE (`orderId`/`reservedAt` di-null-kan), menulis event
RESERVATION_RELEASED, **dan meng-null-kan `OrderItem.stockItemId`** (lihat
§8 — perbaikan L-6 dari audit final-review). Baris yang sudah DEAD sebelum
release (admin men-mark-dead baris RESERVED itu duluan) tidak diapa-apakan
statusnya, tapi pointer order-item ke baris DEAD itu tetap dilepas
(`unlinkIfDeadHere`) tanpa event baru — event MARKED_DEAD-nya sudah ada.

### Tidak bisa diubah/dihapus setelah SOLD
- `markStockDead`/`bulkMarkStockDead` — hanya menyentuh baris yang masih
  AVAILABLE/RESERVED; SOLD/DEAD dibiarkan. Melepas `activeCredentialKey` dan
  menulis MARKED_DEAD dengan `reasonCode`.
- `bulkDeleteStock`/`deleteStockItem` — **soft delete** (set `deletedAt`,
  `deletedByAdminId`), bukan hapus baris (lihat §5). Menolak baris SOLD atau
  yang masih direferensikan `orderItems`. Melepas `activeCredentialKey` dan
  menulis SOFT_DELETED.

### Refund tidak me-restock
`packages/db/src/crud/refunds.ts` murni menangani sisi uang — tidak
menyentuh `StockItem` sama sekali. Kredensial yang sudah SOLD dianggap
terkirim permanen.

## 4. Pipeline import — `StockImportBatch` + fingerprint

`bulkAddStock` (`stock.ts`) menulis satu `StockImportBatch` per upload
(`rowsSubmitted/rowsInserted/rowsDuplicate`, `sourceHash` = HMAC keyed dari
seluruh isi upload — mendeteksi upload yang sama tanpa membocorkan isinya
lewat hash tak-berkunci) dan menempelkan `importBatchId`/`addedByAdminId` ke
setiap baris baru.

**Fingerprint identitas & kredensial** (`packages/core/src/credentialCrypto.ts`):
- Kunci indeks 32-byte diturunkan dari `CREDENTIAL_ENCRYPTION_KEY` yang sama
  lewat **HKDF** dengan `info = "trustance/credential-index/v1"`
  (`deriveCredentialIndexKey`) — dipisah secara kriptografis dari kunci
  AES-GCM (info string berbeda) supaya kunci indeks ini tidak pernah bisa
  dipakai balik untuk mendekripsi envelope kredensial.
- Segmen identitas = segmen pertama yang mengandung `"@"`; kalau tidak ada
  `"@"` sama sekali, identitas = segmen pertama (untuk kredensial
  satu-segmen, itu keseluruhan string). Segmen dipisah oleh `:`/`|`.
- **Aturan case-folding**: identitas HANYA di-lowercase (+ whitespace
  dirapikan) kalau dia sebuah e-mail (mengandung `"@"`); identitas non-email
  (mis. username game) dibiarkan apa adanya (`canonicalIdentity`).
- `identityFingerprint = HMAC-SHA256(indexKey, normalizeIdentity(plaintext))`.
- `credentialFingerprint = HMAC-SHA256(indexKey, normalizeCredential(plaintext))`
  — identitas dinormalisasi sama, delimiter di kiri/kanannya disamakan jadi
  `:`, sisanya (password, spasi internal) dijaga persis.

**Dedup** dua arah, sekarang lewat fingerprint bukan decrypt-semua:
1. Dalam batch yang sama — `Map` per `credentialFingerprint`, yang pertama
   menang.
2. Terhadap baris live (AVAILABLE/RESERVED/SOLD, `deletedAt: null`) di
   denominasi yang sama — query `credentialFingerprint IN (...)`. Baris lama
   yang belum di-backfill (fingerprint `null`) masih dibandingkan lewat
   decrypt satu-per-satu, **ber-guard**: baris yang gagal didekripsi dihitung
   di `unreadableExisting` dan dilewati, tidak lagi membatalkan seluruh
   upload.
3. Identitas yang sama dengan password berbeda **tidak ditolak** — hanya
   dihitung sebagai `identityWarnings` di respons.

**Klaim unik** `activeCredentialKey = "{productId}:{credentialFingerprint}"`
(`StockItem.activeCredentialKey`, `@unique` penuh yang mengizinkan banyak
`NULL` — dipilih karena deploy pakai `prisma db push`, yang tidak pernah
menerapkan partial unique index) dipegang selagi baris AVAILABLE/RESERVED/SOLD
dan di-NULL-kan saat DEAD/soft-deleted, sehingga kredensial yang sama boleh
diimpor ulang setelah dianggap mati. Klaim ini adalah jaring pengaman
terakhir: bahkan penulis yang entah bagaimana melewati dedup fingerprint di
atas akan gagal insert kalau kliennya bentrok, dan itu dihitung sebagai
duplikat, bukan crash (`skipDuplicates: true`).

**Konkurensi & performa**:
- `pg_advisory_xact_lock` per `productId` (namespace `"STK1"`) menyerialkan
  upload untuk denominasi yang sama, sehingga baca-dedup dan tulis benar-benar
  atomik bersama — tanpa ini dua upload paralel bisa sama-sama membaca
  "belum ada" dan sama-sama insert.
- Insert dipecah per **2000 baris** (`STOCK_INSERT_CHUNK_ROWS`) supaya jumlah
  parameter bind tetap jauh di bawah batas 65535 Postgres per statement.
- **Reservasi id untuk envelope v2**: kalau `CREDENTIAL_ENVELOPE_WRITE_V2`
  menyala (§9), AAD envelope butuh id barisnya sendiri SEBELUM insert —
  `reserveStockItemIds` menarik sejumlah id dari sequence `stock_items_id_seq`
  lewat `nextval()` dalam transaksi yang sama, lalu setiap baris di-insert
  dengan id yang sudah ditentukan. Saat flag mati (v1, default), tidak ada
  reservasi id — insert berjalan seperti biasa.

Satu event `IMPORTED` ditulis per baris baru (§2), dan setiap fungsi
mutasi-stok lain di file ini (`markStockDead`, `bulkDeleteStock`, reveal, dst.)
sekarang dibungkus `$transaction` supaya perubahan status dan event-nya
atomik.

## 5. Soft delete & guard hapus denominasi/produk

Stok tidak pernah di-hard-delete lagi: `bulkDeleteStock`/`deleteStockItem`
(`stock.ts`) melakukan `updateMany` yang men-set `deletedAt`/
`deletedByAdminId`, bukan `deleteMany`. Baris yang soft-deleted tetap ada
untuk jejak audit; setiap pembacaan "stok yang hidup" (dedup import,
`listAvailableCredentials`, `allocateOneAvailableStock`, hitungan status,
pencarian, dst.) memfilter `deletedAt: null`.

Konsekuensinya: `Denomination`/`Product` yang **pernah** punya stok tidak
bisa dihapus sama sekali. `assertNoStockHistory` (`packages/db/src/crud/catalog.ts`)
dipanggil dari `deleteDenomination` dan `deleteCatalogProductCascade` —
menghitung baris `StockItem` **dan** `StockItemEvent` untuk denominasi itu;
kalau salah satu > 0, keduanya menolak dengan
`error.denomination_has_stock_history` (pesan ini juga yang dipetakan
UI web-admin). Karena `StockItemEvent.stockItemId` punya FK `onDelete:
Restrict` ke `StockItem` (§2), dan `StockItem.product` punya `onDelete:
Cascade` ke `Denomination`, guard aplikasi ini adalah satu-satunya yang
mencegah cascade itu tercapai untuk denominasi yang punya riwayat — kalau
sampai tercapai, Postgres sendiri akan menolak lewat FK Restrict di level
event. Satu-satunya jalan menyingkirkan SKU yang pernah punya stok adalah
menonaktifkannya (`isActive: false`), bukan menghapusnya.

## 6. Riwayat per-stok — endpoint + dialog

`GET /api/stock/item/:stockId/history` (`apps/web-admin/src/routes/api/stock.ts`,
`preHandler: currentAdmin` — bukan `blockReadonlyReads`, karena ini bacaan
non-kredensial yang aman untuk role readonly) memanggil `listStockItemEvents`
(§2) dan mengembalikan timeline tanpa kredensial. Klien: `StockHistoryDialog`
(`apps/web-admin/client/src/components/shared/StockHistoryDialog.tsx`),
dipicu dari aksi baris "History" di menu tiap item pada `StockProductPage.tsx`.
Belum ada tautan ke dialog ini dari `OrderDetailPage.tsx` — riwayat stok saat
ini hanya dapat dibuka dari halaman produk-stok, bukan dari detail order.

## 7. `checkStockIntegrity` — laporan integritas read-only + dua alat operator

Karena deploy memakai `prisma db push` (bukan `prisma migrate deploy`; lihat
`docs/MIGRATIONS.md`), CHECK constraint dan partial unique index tidak bisa
diandalkan — `db push` tidak pernah menerapkan konstruk SQL mentah itu (ada
preseden: partial unique index `Payment` yang pernah dicoba lalu dibatalkan).
`checkStockIntegrity(db)` (`packages/db/src/crud/stockIntegrity.ts`)
menggantikan constraint DB dengan laporan SELECT/COUNT murni — tidak pernah
menulis apa pun, dan tidak pernah membaca/mengembalikan `StockItem.credentials`.

Sebelas temuan dalam `StockIntegrityReport` (delapan di antaranya sudah ada
sejak Fase 4a, tiga di antaranya baru ditambahkan di final review):
- `reservedOrSoldWithoutOrderId`, `soldWithoutSoldAt`, `statusOutsideEnum`,
  `softDeletedStillReserved` — pelanggaran invarian dasar per baris.
- `duplicateStockItemPointers` — id `StockItem` yang dirujuk lebih dari satu
  `OrderItem.stockItemId` (bentuk persis yang akan dilarang `@unique` Fase
  4b, masih belum diterapkan — lihat
  [`audit-stock-traceability-fase0.md`](../archive/audit-stock-traceability-fase0.md)).
- `statusEventMismatch` / `legacyRowsWithoutEvents` — status kolom
  dibandingkan dengan event **transisi-status** terakhir (`toStatus IS NOT
  NULL`; event non-transisi seperti `CREDENTIAL_REVEALED`/`REENCRYPTED`
  dilewati saat mencari "event terakhir" supaya reveal/re-encrypt rutin tidak
  ditandai sebagai drift). Baris tanpa event transisi sama sekali (data lama
  sebelum ledger ada) dihitung terpisah di `legacyRowsWithoutEvents`, bukan
  sebagai defect.
- `cancelledOrRejectedOrderItemsStillLinked` — pointer order-item yang masih
  menempel ke stok padahal ordernya CANCELLED/REJECTED (harusnya sudah
  dilepas `releaseOrderHolds`, §3); pointer ke baris DEAD tidak dihitung
  (baris DEAD tidak bisa direservasi lagi jadi tidak bisa jadi duplikat).
- `duplicateActiveCredentialFingerprints` — baris live berbagi
  `credentialFingerprint` di denominasi yang sama (toleran-NULL, karena Fase
  5 belum mem-backfill semua baris lama).
- **Tiga temuan baru**: `liveRowsWithoutClaimKey` (baris live tanpa
  `activeCredentialKey` padahal denominasinya sudah pakai fingerprint —
  berarti klaim unik tidak melihat baris ini, celah dedup), 
  `deadOrDeletedRowsHoldingClaimKey` (baris DEAD/soft-deleted yang masih
  memegang klaim — harusnya sudah dilepas `markStockDead`/soft delete),
  `soldWithoutSoldToOrderId` (baris SOLD tanpa `soldToOrderId` — penjualan
  yang tidak tahu order pembelinya).

**Dua alat operator, keduanya read-only:**
- `scripts/audit-stock-integrity.ts` (`pnpm audit-stock-integrity`) —
  menjalankan `checkStockIntegrity` terhadap `DATABASE_URL_PRISMA` dan
  mencetak **hitungan saja** (tidak pernah `sampleIds` atau kredensial);
  temuan non-nol ditindaklanjuti dengan memanggil `checkStockIntegrity`
  langsung untuk id-nya.
- `scripts/audit-stock-duplicates.sql` — SQL murni `SELECT`, dijalankan
  manual (`psql ... -f scripts/audit-stock-duplicates.sql` atau ditempel ke
  GUI Postgres) terhadap DB produksi: pointer duplikat berikut order id/status
  pemiliknya, hitungan order-item CANCELLED/REJECTED yang masih menempel,
  baris SOLD yang `soldToOrderId`-nya tidak DELIVERED, dan hitungan per status
  untuk konteks skala. Nol baris di tiga query pertama = data sudah bersih
  untuk Fase 4b's `@unique`.

## 8. Sambungan ke Order — jejak "unit stok ini dijual ke order mana"

`OrderItem.stockItemId` (`prisma/schema.prisma`, nullable, **belum**
`@unique` — Fase 4b digantung menunggu audit produksi bersih, lihat
[`audit-stock-traceability-fase0.md`](../archive/audit-stock-traceability-fase0.md))
adalah paper trail utamanya: satu baris order-item terhubung
ke persis satu `StockItem` **selagi masih relevan**.

- Dari sisi **order** → tahu persis kredensial mana yang dikirim untuk baris
  itu (`item.stockItem.credentials`, didekripsi di tempat oleh
  `withDecryptedStockCredentials` di `orders.ts` untuk order DELIVERED).
- Dari sisi **stock** → tahu order mana yang SEDANG memakai kredensial itu
  (`StockItem.orderId`) dan, setelah terjual, order mana yang PERNAH memakainya
  secara permanen (`StockItem.soldToOrderId`/`soldToOrderItemId` — kolom ini
  tidak pernah di-null-kan lagi setelah SOLD, beda dari `orderId` yang bisa
  dilepas saat release).

**Pointer di-null-kan, bukan dibiarkan menggantung (perbaikan L-6, Fase 3b).**
Sebelum fase ini, `releaseOrderHolds` mengembalikan baris RESERVED ke
AVAILABLE tapi TIDAK PERNAH melepas `OrderItem.stockItemId` — order yang
batal/expired tetap menunjuk baris yang lalu direservasi order lain,
sehingga dua `OrderItem` bisa menunjuk satu `StockItem` yang sama di alur
normal (bukan kasus tepi). Sekarang `releaseOrderHolds` men-null-kan pointer
itu SETELAH menulis event RESERVATION_RELEASED (event itu sendiri yang jadi
pengganti pointer sebagai jejak: order, baris, dan aktor tetap tercatat).
Baris yang sudah DEAD sebelum release ditangani serupa
(`unlinkIfDeadHere`) — statusnya tetap DEAD, tapi pointer order-nya dilepas
supaya baris itu bisa di-soft-delete dan supaya `checkStockIntegrity` tidak
lagi menganggapnya data lama.

**Flip ke SOLD selalu bersyarat pada kepemilikan saat ini, bukan snapshot.**
`approveOrder` membaca order sekali di awal (snapshot), tapi baris RESERVED
bisa berubah antara pembacaan itu dan klaimnya — admin bisa men-`markStockDead`
baris itu di tengah jalan. `sellIfStillHeld` (`orders.ts`) meng-update dengan
syarat `status: RESERVED, orderId: <order ini>, deletedAt: null`; kalau nol
baris ter-update, jalur substitusi (`SUBSTITUTED_OUT`/`SUBSTITUTED_IN`)
mengambil alih persis seolah baris itu sudah mati sebelum order dibaca.
Tanpa guard ini, admin yang mematikan kredensial tepat saat approve berjalan
bisa membuat baris DEAD ditimpa balik jadi SOLD dan pembeli menerima
kredensial yang baru saja dinyatakan mati oleh admin.

**Jalur pembacaan tanpa dekripsi untuk mesin status.** `getOrder`/
`getOrderByCodeFull` (`orders.ts`) mendekripsi setiap `stockItem.credentials`
dan `deliveredContent`, dan MELEMPAR pada baris yang tidak terbaca. Fungsi ini
dulu juga dipakai `cancelOrder`, `rejectOrder`, `creditOrderToBalance`, dan
pembacaan pra-klaim `approveOrder` — satu baris korup (atau plaintext lama
begitu `ALLOW_LEGACY_PLAINTEXT=false`) membuat order itu MUSTAHIL dibatalkan
atau kedaluwarsa, membocorkan reservasinya selamanya. Jalur mesin-status di
atas sekarang memakai `getOrderRaw` (`orders.ts`), yang tidak pernah
mendekripsi apa pun — nilai kembali sengaja tidak boleh dikirim/ditampilkan
ke siapa pun, hanya dipakai untuk memutuskan transisi status. Jalur
pengiriman/tampilan tidak berubah bentuk.

`stockItemId` tetap nullable karena order manual/manual-with-info (fulfil
tangan) tidak pernah mengalokasikan `StockItem` sama sekali (§10).

## 9. Enkripsi kredensial — envelope v1/v2, AAD, dan mode ketat

`packages/core/src/credentialCrypto.ts`, AES-256-GCM, kunci 32-byte dari
`CREDENTIAL_ENCRYPTION_KEY` (hex).

**Envelope v1 (bentuk asli)**: `{ keyVersion, iv, ciphertext, authTag }`,
`iv`/`ciphertext`/`authTag` base64. Tidak ada AAD — ciphertext-nya portabel
antar baris/tabel, tidak terikat ke tempat penyimpanannya.

**Envelope v2 (Fase 6d, AAD)**: menambah penanda `v: 2` dan mengikat
ciphertext ke AES-GCM *additional authenticated data* — jadi ciphertext yang
disalin ke baris/kolom lain tidak lagi bisa didekripsi di tempat barunya.
Tiga konteks AAD, masing-masing string literal yang SEKALI ditentukan dan
tidak boleh diubah (mengubahnya membuat semua v2 yang sudah ditulis di bawah
konteks lama permanen tak terbaca):
- `stock_items.credentials:{id}` — kredensial satu `StockItem`.
- `orders.delivered_content:{orderId}` — `Order.deliveredContent` satu order.
- `settings.value:{key}` — nilai `Setting` terenkripsi (mis. API key
  supplier/payment gateway).

`CREDENTIAL_ENVELOPE_WRITE_V2` mengendalikan versi mana yang DITULIS
(default **mati** = v1); PEMBACA selalu menerima v1 maupun v2. Ini rollout
dua tahap yang disengaja: kode yang bisa membaca v2 harus sudah ter-deploy
ke SEMUA proses (web-admin, storefront, order-bot, outbox-dispatcher, server)
sebelum baris v2 pertama pernah ditulis di mana pun — kalau flag dinyalakan
sebelum itu, proses lama yang belum bisa baca AAD akan gagal dekripsi baris
yang baru ditulis proses lain. `bulkAddStock` (§4) adalah satu-satunya
penulis yang perlu reservasi id sebelum insert karena AAD stok butuh id baris
sebelum enkripsi berjalan.

**Pemeriksaan boot.** `assertCredentialKeyConfigured()` dipanggil dari
`start()` tiap proses (`apps/web-admin`, `apps/storefront`, `apps/server`,
`apps/order-bot` — bukan dari `buildServer`/`buildApp`, supaya test yang
membangun app tanpa key tetap jalan): memvalidasi panjang & format kunci,
lalu menjalankan round-trip enkripsi/dekripsi kanari. Proses gagal start
kalau kuncinya salah, bukan menunggu upload/pengiriman pertama untuk
menemukan itu.

**Dekripsi berpengaman vs melempar.** `tryDecryptCredentials`/
`tryDecryptDeliveredContent` (dipakai `withDisplayStockCredentials`/
`getOrderByCodeFullForDisplay`, pencarian admin, `bulkAddStock` dedup,
`viewStockItems` bot) mengembalikan `null` + `logger.warn` (nama baris saja)
pada baris yang tidak terbaca, supaya satu baris korup tidak menjatuhkan
seluruh halaman/upload/pencarian — kecuali `CredentialKeyConfigError` (kunci
salah konfigurasi), yang tetap dilempar ulang karena itu bukan masalah
per-baris. `decryptCredentials`/`decryptStockCredentials`/
`decryptDeliveredContent` (dipakai `getOrder`/`getOrderByCodeFull`,
`approveOrder`, `fulfillManualOrder`, `core/delivery.ts`) tetap MELEMPAR pada
baris tak terbaca — jalur pengiriman harus gagal-dan-retry (outbox), bukan
mengirim placeholder atau ciphertext ke pembeli.

**`ALLOW_LEGACY_PLAINTEXT`** (dibaca lazy seperti kunci; default permisif =
`true` sampai backfill terukur di produksi) mengatur dua cabang passthrough
di `decryptCredentials` untuk nilai yang bukan JSON/tidak berbentuk envelope
(kredensial lama pra-enkripsi): permisif → dikembalikan apa adanya (dihitung
`legacyPlaintextPassthroughCount`, di-log sekali per proses), `false` →
`LegacyPlaintextCredentialError`. Nilai kosong (`""`) selalu lolos tanpa
syarat (tidak membawa rahasia apa pun).

**`Order.deliveredContent` terenkripsi (Fase 6c).** Dulu kolom TEXT biasa
plaintext, sekarang dienkripsi seperti kredensial stok (AAD
`orders.delivered_content:{orderId}`). Tiga choke point dekripsi:
`withDecryptedStockCredentials` (lempar, jalur pengiriman/detail admin),
`withDisplayStockCredentials` (berpengaman, halaman detail pembeli), dan
`listUserDeliveredOrders` (tidak lagi memuat/mendekripsi sama sekali — lihat
[`audit-stock-traceability-fase0.md`](../archive/audit-stock-traceability-fase0.md)).
**Daftar admin di-strip, bukan didekripsi**:
`withoutDeliveredContent` (`orders.ts`) membuang kolom ini sepenuhnya dari
setiap baris `listOrders` (endpoint `GET /api/orders` dan `/export`) sebelum
ke JSON — daftar/ringkasan order tidak pernah membawa rahasia terkirim,
apalagi mendekripsinya; hanya jalur detail (`getOrder` via `GET
/api/orders/:orderId`, ter-mask default + tombol Reveal ber-audit — §11) dan
resend yang membacanya.

**Kegagalan dekripsi di outbox tidak lagi menghentikan batch.** Dua DM
pengiriman kredensial (`deliverAccountDm`/`deliverManualContentDm`,
`packages/outbox-dispatcher/src/dispatcher.ts`) membaca order lewat
`readOrderForDelivery`, yang menangkap kegagalan dekripsi per baris:
gagal → `markNotificationFailed(..., NOTIF_MAX_ATTEMPTS)`, jadi baris itu
mundur dengan backoff seperti kegagalan kirim lain dan berakhir
`DEAD_LETTER` di batas percobaan — bukan lagi melempar keluar dari
`drainBatch` dan membuat sisa 50 baris dalam batch itu ikut tertunda tanpa
pernah terhitung sebagai percobaan. Tidak ada yang dikirim untuk baris yang
gagal ini: bukan ciphertext, bukan placeholder.

## 10. Gap yang masih terbuka: rotasi kunci enkripsi

**Belum ada mekanisme rotasi** untuk `CREDENTIAL_ENCRYPTION_KEY` di luar cakupan
fase ini, dan AAD v2 (§9) TIDAK menyelesaikan masalah ini — AAD mengikat
ciphertext ke lokasinya, bukan ke versi kuncinya. `keyForVersion` hanya
mengenal `CURRENT_KEY_VERSION = 1`; tidak ada tabel multi-key atau fallback
ke kunci lama. Kalau `CREDENTIAL_ENCRYPTION_KEY` diganti tanpa migrasi
manual, semua `StockItem.credentials`/`Order.deliveredContent`/`Setting`
terenkripsi lama gagal didekripsi permanen (GCM auth tag mismatch).

**Fingerprint identitas/kredensial (§4) mewarisi risiko yang sama**: kunci
indeksnya diturunkan (HKDF) dari `CREDENTIAL_ENCRYPTION_KEY` yang sama.
Merotasi kunci master diam-diam menghilangkan KEDUA hal sekaligus — bukan
cuma kredensial tak terbaca, tapi juga setiap `identityFingerprint`/
`credentialFingerprint`/`activeCredentialKey` yang ada jadi tidak cocok lagi
dengan apa pun yang dihitung ulang dari kredensial yang (dengan asumsi sudah
di-re-encrypt) terbaca dengan kunci baru — dedup impor efektif buta terhadap
seluruh histori sampai semua baris di-backfill ulang. Rotasi kunci hari ini
hanya aman kalau seluruh baris lama di-re-encrypt (kredensial + fingerprint)
ke kunci baru SEBELUM env var lama dibuang.

## 11. Track T — "tidak ada tampilan data/klaim palsu atau menyesatkan"

Selain hardening traceability, satu prinsip terpisah ("tidak boleh ada
tampilan data palsu/menyesatkan di proyek ini") menghasilkan beberapa
perbaikan lintas admin/buyer:

- **Detail order: mask default + Reveal ber-audit.** `GET
  /api/orders/:orderId` tidak lagi mengirim kredensial stok/`deliveredContent`
  terbuka — responsnya diganti `MASKED_CREDENTIAL` + flag `hasDeliveredContent`.
  `POST /api/orders/:orderId/reveal` (ber-CSRF, ditolak untuk role readonly)
  adalah satu-satunya jalan membacanya, dan menulis `logAdminAction`
  (`order_credentials_revealed`) setiap kali dipanggil — menutup "reveal
  senyap" yang dulu terjadi setiap admin membuka halaman detail order mana
  pun.
- **Permintaan restock lewat outbox, bukan kirim langsung dari web.**
  Notifikasi subscriber restock per-SKU dipindah ke
  `notification_outbox` (event `RESTOCK_SUBSCRIBER_NOTIFIED`) supaya upload
  stok dari web-admin juga bisa memicunya (dulu hanya conversation admin bot
  yang bisa), dan predikat "penerima yang bisa dilayani" (`actionableSubscriberWhere`
  — terhubung Telegram, tidak banned) disatukan dengan filter broadcast agar
  angka "Waiting"/"Restock requests" di admin cocok dengan siapa yang benar-
  benar akan menerima notifikasi (lihat §12).
- **Pendapatan yang jujur.** Agregat revenue/order (dashboard, laporan)
  menyaring `Order.kind = PRODUCT` — top-up saldo tidak lagi terhitung
  sebagai penjualan (juga menghapus hitung-ganda saat pembayaran memakai
  saldo).
- **Hitungan admin yang jujur.** Ambang stok rendah satu sumber
  (`config.LOW_STOCK_THRESHOLD`); hitungan yang dibatasi (`take`/`limit`)
  tidak lagi disajikan seolah total; kolom Stock di admin menampilkan
  `{available} ready` (+ reserved) tanpa progress bar yang menghitung
  sold/dead sebagai bagian dari "total stok".
- **Copy pembeli yang selalu benar** — klaim SLA/waktu-kirim/garansi/jumlah
  pelanggan yang tidak bisa dibuktikan dihapus/dinetralkan dari locale bot +
  storefront, diganti pernyataan yang selalu benar (mis. "dikirim otomatis
  setelah pembayaran terkonfirmasi" alih-alih janji waktu tetap).
  **Guard anti-regresi**: `tests/no-fake-claims.test.ts` memindai
  `packages/core/locales/*.json` untuk pola-pola ini (klaim jumlah pelanggan,
  "24/7", waktu balas/kirim tetap, dst.) — lihat
  [`audit-stock-traceability-fase0.md`](../archive/audit-stock-traceability-fase0.md)
  untuk batasan
  cakupannya (hanya JSON locale, bukan literal string di komponen TSX).

## 12. Jalur fulfillment eksternal (Digiflazz) — SKU tanpa `StockItem`

Ini jalur yang justru menangani mayoritas SKU top-up di produksi, dan sama
sekali tidak lewat apa pun yang dijelaskan di §1-§11.

SKU hasil Digiflazz catalog sync selalu dibuat dengan
`deliveryType: MANUAL_WITH_INFO` (`packages/core/src/cartComposition.ts`),
**bukan** `"auto"` — jadi jangan disamakan dengan "auto delivery" di §1-§9.
Karena itu `settlePaidOrder` (`packages/db/src/crud/orders.ts`) tidak pernah
menyentuh `StockItem` untuk order ini; jalur alokasi
`approveOrder`/`allocateOneAvailableStock` sama sekali tidak terpanggil.
"Stok" SKU ini murni saldo/API pihak Digiflazz, bukan baris di tabel
`stock_items`.

**Dispatch: dispatch + poll, bukan sinkron saat settle.**
- Order yang lunas parkir dulu di status PROCESSING (tidak ada panggilan
  Digiflazz saat settle).
- `dispatchPendingDigiflazzOrders` (`digiflazz.ts`) mengklaim satu order
  PROCESSING per iterasi lalu memanggil `createTransaction` Digiflazz.
- `"Sukses"` → `fulfillDigiflazzOrder` (`digiflazz.ts`) langsung
  PROCESSING→DELIVERED di pass yang sama.
- `"Pending"` → dijadwalkan recheck dengan backoff (jendela 24 jam).
- `"Gagal"` atau backoff habis → gagal terminal, admin dialert, order tetap
  PROCESSING untuk difulfil tangan.
- Webhook callback (`apps/storefront/src/routes/checkout.ts`, `POST
  /pay/digiflazz/callback`) bisa memicu jalur sukses/gagal yang sama untuk
  order yang tadinya Pending — poll + webhook berjalan berdampingan.

**Jejak/trace fields — analog `stockItemId` untuk jalur ini:**
- `refId = order.orderCode` dikirim sebagai idempotency key ke Digiflazz.
- Serial number dari supplier disimpan di `Order.deliveredContent` (sekarang
  terenkripsi — §9) — kolom yang sama dipakai fulfillment manual.
- Sub-status perjalanan di `Order.digiflazzStatus`/`digiflazzDispatchedAt`/
  `digiflazzAttempts`/`digiflazzNextRecheckAt`/`digiflazzFailureDetail` —
  semua di-null-kan lagi begitu DELIVERED.
- `OrderStatusHistory.meta` diisi `"digiflazz_fulfill"` — beda dari
  `"manual_fulfill by admin_id=..."` dan `"approved by admin_id=..."`,
  sehingga audit trail bisa membedakan auto-supplier vs fulfil tangan vs
  approve stok lokal.
- Tidak ada kolom trx-supplier di level `OrderItem`; `OrderItem.stockItemId`
  tetap null untuk semua baris jalur ini.

**Sync katalog tidak menyentuh stok**: `resyncDigiflazzCatalog`
(`digiflazz.ts`) cuma menyinkronkan `costPrice`/`price`/`isActive` pada
`Denomination` dari price list Digiflazz — tidak pernah menyentuh
`StockItem`.

## 13. `ProductProviderMapping` — routing multi-provider yang belum aktif

Model ini (`prisma/schema.prisma`) dirancang untuk melepas SKU dari
hard-binding ke Digiflazz lewat `Denomination.autoDeliverySource`/
`supplierSku`, lewat resolver `resolveDenominationProvider`
(`packages/db/src/crud/productProviderMappings.ts`) yang menghitung ulang
kedua field itu dari mapping berprioritas-tertinggi yang enabled.

**Belum ada pemanggil produksi** — dikonfirmasi oleh komentar di kode itu
sendiri (*"not reachable today"*) dan oleh grep: `resolveDenominationProvider`/
`upsertProductProviderMapping` hanya dipanggil dari file crud-nya sendiri
dan test-nya. Poller `dispatchPendingDigiflazzOrders` masih hardcode literal
`autoDeliverySource: "digiflazz"`, jadi provider lain yang ditulis lewat
tabel ini tidak akan pernah di-dispatch oleh siapa pun hari ini.

KokinPay/VIP-Reseller/MeloStore (`packages/db/src/crud/{kokinpay,
vipreseller,melostore}.ts`) **bukan** provider fulfillment/stok — mereka
cuma credential reader untuk live nickname-check di storefront, bukan
bagian dari sistem stok manapun.

## 14. Notifikasi restock — dua jalur terpisah, keduanya lewat outbox

Dua mekanisme berbeda bisa terpicu saat stok ditambahkan (`afterStockAdded`,
`packages/db/src/crud/notifications.ts`), keduanya independen/aditif:

- **`enqueueRestockBroadcast`** (blast ke SEMUA customer non-banned yang
  terhubung Telegram) — dipicu setelah `bulkAddStock` dari kedua jalur
  tambah stok (web-admin `api/stock.ts` dan bot `conversations/admin.ts`),
  digate `added > 0 && product.broadcastOnRestock`. Menulis satu baris
  `notification_outbox` per user eligible (event
  `PRODUCT_RESTOCKED_BROADCAST`) plus satu baris `Broadcast` untuk tabel
  History di admin.
- **`enqueueRestockSubscriberNotifications`** (opt-in per-SKU, DM sekali
  pakai) — dipanggil dari kedua jalur tambah stok yang sama lewat
  `afterStockAdded`, dalam transaksi yang sama dengan penambahan stok:
  membaca subscriber yang "actionable" (`actionableSubscriberWhere` —
  terhubung Telegram, tidak banned; predikat yang sama dipakai
  `listRestockSubscribers`/`restockSubscriberCounts`), menulis
  `notification_outbox` (event `RESTOCK_SUBSCRIBER_NOTIFIED`), lalu menghapus
  baris `RestockSubscription` yang di-enqueue — at-least-once terjamin
  karena hapusnya baru terjadi setelah enqueue berhasil dalam transaksi yang
  sama. Web-admin tidak pernah mengirim Telegram langsung (aturan repo);
  dispatcher outbox yang merender & mengirim pesan sebenarnya.

## 15. Sold count — agregat baca, bukan counter tersimpan

`soldCountsByDenomination`/`soldCountForDenomination`/`soldCountForProduct`
(`orders.ts`) dan `soldCountsByProduct` (`catalog.ts`, sengaja diduplikasi
dari yang di `orders.ts` untuk menghindari circular import) — semuanya
`groupBy` atas `OrderItem.quantity` where `Order.status === DELIVERED`. Ini
bukan kolom counter tersimpan, murni agregat baca real-time; refund tidak
menguranginya (tidak ada counter untuk dikurangi), konsisten dengan §3
"Refund tidak me-restock".

## 16. Lapisan audit di atasnya

Tiga lapisan yang saling melengkapi, masing-masing untuk pembaca berbeda:

- **`StockItemEvent`** (§2) — ledger traceability teknis per unit stok:
  kapan, status apa ke apa, siapa/apa aktornya, order mana. Dibaca lewat
  `listStockItemEvents`/dialog History (§6) dan `checkStockIntegrity` (§7).
- **`OrderStatusHistory`** — timeline status order (`status`, `occurredAt`,
  `meta`). Relasinya `onDelete: Restrict` ke Order, jadi history tidak
  pernah bisa terhapus ikut order-nya.
- **`AuditLog`** — jejak aksi admin/customer yang dibaca ADMIN TOKO (bahasa
  natural, lihat `docs/LOGGING.md`), bukan ledger teknis. Reveal kredensial
  stok (`revealStockCredentials`) dan reveal order (§11) **wajib** dicatat
  di sini oleh route-nya (bukan fungsi crud, yang tidak punya admin id untuk
  diatribusikan). Catatan `note`/alasan DEAD di `AuditLog.details` sengaja
  TIDAK meng-echo isi `note` verbatim (potensi kebocoran kredensial yang
  ditempel admin ke field bebas itu) — kalimatnya generik ("Marked N stock
  items dead.").

`StockItemEvent` dan `AuditLog` sengaja dipertahankan berdampingan untuk
event admin di dunia stok (reveal, mark-dead, dst.): yang satu untuk
traceability lintas-baris yang bisa di-query, yang satu untuk kalimat yang
bisa dibaca admin toko.

## 17. Kenapa didesain seperti ini

Kredensial adalah aset sekali-pakai bernilai uang, jadi desainnya sengaja
paranoid di titik-titik "tidak boleh ganda / tidak boleh hilang jejak":

- Dedup fingerprint-keyed saat impor (mencegah dua kredensial identik
  terjual ke dua buyer berbeda), diperkuat klaim unik `activeCredentialKey`
  sebagai jaring pengaman kedua.
- Optimistic lock saat alokasi, dan flip-ke-SOLD yang selalu bersyarat pada
  kepemilikan saat ini (mencegah dua buyer mendapat baris yang sama, atau
  baris yang sudah dimatikan admin terjual balik).
- Larangan hapus/ubah baris SOLD, soft delete untuk sisanya (mencegah
  kredensial terkirim — atau riwayatnya — berubah/hilang diam-diam).
- Ledger event terpisah dari kolom status mutable, supaya rollback/
  substitusi/penggantian garansi tidak pernah menimpa jejak sebelumnya.
- Pemisahan baca "cek eksis" (tanpa dekripsi), "tampilan" (dekripsi
  berpengaman), dan "pengiriman" (dekripsi yang melempar) — plaintext
  kredensial tidak pernah lewat jalur kode yang tidak seharusnya, dan
  kegagalan satu baris tidak pernah diam-diam berubah jadi kegagalan
  pengiriman yang salah tafsir sebagai sukses.

## Referensi file utama

- `prisma/schema.prisma` — model `StockItem`, `StockItemEvent`,
  `StockImportBatch`, `OrderItem`, `OrderStatusHistory`, `AuditLog`
- `packages/core/src/enums.ts` — `StockEventType`, `StockActorType`,
  `DeadReason`
- `packages/db/src/crud/stock.ts` — siklus hidup StockItem, pipeline import
- `packages/db/src/crud/stockEvents.ts` — penulis/pembaca ledger
  `StockItemEvent`
- `packages/db/src/crud/stockIntegrity.ts` — `checkStockIntegrity`
- `packages/db/src/crud/stockReplacement.ts` — alur ganti garansi
- `packages/db/src/crud/orders.ts` — reservasi, rollback (pointer-null),
  pelunasan/substitusi bersyarat, `getOrder` vs `getOrderRaw`, branch
  auto vs manual, sold count, `withoutDeliveredContent`
- `packages/db/src/crud/refunds.ts` — sisi uang refund (tidak menyentuh
  stock)
- `packages/db/src/crud/catalog.ts` — `assertNoStockHistory`,
  `deleteDenomination`/`deleteCatalogProductCascade`
- `packages/core/src/credentialCrypto.ts` — enkripsi/dekripsi kredensial,
  fingerprint, AAD v1/v2, boot assertion
- `apps/web-admin/src/routes/api/stock.ts` — audit `credential_revealed`,
  endpoint history
- `apps/web-admin/src/routes/api/orders.ts` — mask default + `POST
  /reveal` ber-audit
- `packages/outbox-dispatcher/src/dispatcher.ts` — pengiriman kredensial/
  deliveredContent, `readOrderForDelivery`, `DEAD_LETTER`
- `scripts/audit-stock-integrity.ts`, `scripts/audit-stock-duplicates.sql`
  — alat operator read-only
- `packages/db/src/crud/digiflazz.ts` — dispatch/poll/webhook fulfillment
  Digiflazz, sync katalog
- `packages/core/src/cartComposition.ts` — kenapa SKU Digiflazz selalu
  `MANUAL_WITH_INFO`, tidak pernah punya stok lokal
- `packages/db/src/crud/productProviderMappings.ts` — routing
  multi-provider (belum aktif)
- `packages/db/src/crud/notifications.ts` — broadcast + subscriber restock
  lewat `notification_outbox`
- `packages/db/src/crud/catalog.ts` — `soldCountsByProduct`
- `tests/no-fake-claims.test.ts` — guard anti-regresi Track T
- `DOCS.md` — checklist rollout operator (backfill, urutan flag, query
  produksi)
- [`audit-stock-traceability-fase0.md`](../archive/audit-stock-traceability-fase0.md)
  — status per-temuan audit
