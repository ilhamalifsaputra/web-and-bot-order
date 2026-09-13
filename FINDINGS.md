# FINDINGS — Fase 0 Audit: Stock Traceability & Credential Encryption Hardening

Audit-only pass, tidak ada perubahan kode. Setiap `[VERIFIKASI]` di brief
diverifikasi terhadap kode saat ini (bukan hanya `INVENTORY_TRACEABILITY.md`,
yang tetap akurat untuk sebagian besar §0.1 tapi tidak dijadikan sumber
kebenaran tunggal). Severity: **critical / high / medium / low**. Status:
**confirmed-as-designed** (sudah benar), **gap — targeted by Fase N** (sudah
direncanakan diperbaiki di fase berikutnya), atau **gap — not yet covered**
(temuan baru, belum ada di rencana fase manapun).

---

## 0.1 Verifikasi model & alur

### StockItem fields
**Status: confirmed-as-designed.**
`prisma/schema.prisma:572-594` — persis: `id, productId, credentials, status,
orderId, addedAt, reservedAt, soldAt, note` (plus relasi `product`, `order`,
`orderItems`). Tidak ada field lain.

```prisma
model StockItem {
  id          Int       @id @default(autoincrement())
  productId   Int       @map("product_id")
  credentials String
  status      String    @default("AVAILABLE")
  orderId     Int?      @map("order_id")
  addedAt     DateTime  @default(now()) @map("added_at")
  reservedAt  DateTime? @map("reserved_at")
  soldAt      DateTime? @map("sold_at")
  note        String?
  @@index([status], map: "ix_stock_items_status")
  @@index([productId], map: "ix_stock_items_product_id")
  @@index([productId, status], map: "ix_stock_product_status")
  @@map("stock_items")
}
```

**Koreksi kecil terhadap asumsi brief**: `status` adalah `String` biasa,
**bukan** native Prisma/Postgres enum. Nilai valid didefinisikan hanya di
level TypeScript (`packages/core/src/enums.ts:65-71`):
```ts
export const StockStatus = {
  AVAILABLE: "AVAILABLE",
  RESERVED: "RESERVED",
  SOLD: "SOLD",
  DEAD: "DEAD",
} as const;
```
Relevan untuk Fase 1: enum baru (`StockEventType`, `StockActorType`,
`DeadReason`) yang diusulkan brief **adalah** native Prisma enum, jadi mereka
tidak otomatis konsisten dengan `StockItem.status` yang tetap `String` —
tidak masalah untuk fase additive, tapi dicatat di sini.

### StockStatus enum values
**Status: confirmed-as-designed.** Hanya `AVAILABLE | RESERVED | SOLD | DEAD`
— tidak ada nilai lain (lihat di atas).

### OrderItem.stockItemId nullable & unique constraint
**Status: gap — targeted by Fase 4. Severity: medium** (bukan bug aktif hari
ini karena semua jalur alokasi sudah disiplin, tapi tidak ada jaring pengaman
DB).
`prisma/schema.prisma:755-819`, field di line 760: `stockItemId Int? @map("stock_item_id")`.
- Nullable: ya.
- **Tidak ada `@unique`** pada field, **tidak ada `@@unique`/unique index**
  di model manapun (hanya `@@index([orderId])`, `@@index([productId])`,
  line 816-817).
- Dicek juga migration mentah: `prisma/migrations/20260827050616_postgresql_baseline/migration.sql:256`
  (definisi kolom) dan `:900` (FK `order_items_stock_item_id_fkey`, FK biasa,
  bukan unique) — tidak ada `CREATE UNIQUE INDEX` pada `stock_item_id` di
  `prisma/migrations/` manapun, termasuk arsip SQLite lama.
- **Konfirmasi**: hari ini tidak ada apa pun di level DB yang mencegah dua
  baris `OrderItem` menunjuk `StockItem` yang sama. Fase 4's
  `order_items_stock_item_id_key` unique index memang dibutuhkan dan belum
  ada.

### Rollback order batal/expired
**Status: confirmed-as-designed, dengan satu penyederhanaan penting.**
Bukan "banyak tempat terpisah" — ada **satu helper bersama**,
`releaseOrderHolds` (`packages/db/src/crud/orders.ts:1261-1272`):
```js
async function releaseOrderHolds(db, order) {
  for (const item of order.items) {
    if (item.stockItem && item.stockItem.status === StockStatus.RESERVED) {
      await db.stockItem.update({
        where: { id: item.stockItem.id },
        data: { status: StockStatus.AVAILABLE, orderId: null, reservedAt: null },
      });
    }
  }
}
```
Dipanggil dari tiga tempat:
- `orders.ts:1360` — dalam `cancelOrder()` (juga dipakai untuk expiry lewat
  `apps/order-bot/src/jobs/index.ts:479-493`'s `autoCancelExpiredOrders` →
  `cancelOrder(tx, o.id, "expired")`).
- `orders.ts:1428` — dalam `creditOrderToBalance()` (paid-but-unfulfillable →
  store credit).
- `orders.ts:1484` — dalam `rejectOrder()`.

Implikasi baik untuk Fase 3: karena hanya satu fungsi yang menulis transisi
ini, dual-write ke `StockItemEvent` cukup ditambahkan di **satu tempat**
(`releaseOrderHolds` itu sendiri), bukan tiga kali terpisah.

### settlePaidOrder re-alokasi & overwrite stockItemId
**Status: confirmed-as-designed.**
`settlePaidOrder` (`orders.ts:2091`) untuk branch AUTO mendelegasikan ke
`approveOrder` (`orders.ts:2135`). Re-alokasi ada di `approveOrder`
(`orders.ts:1574-1588`):
```js
for (const item of order.items) {
  let stock = item.stockItem;
  if (!stock || stock.status !== StockStatus.RESERVED) {
    const replacement = await allocateOneAvailableStock(db, item.productId, order.id);
    if (!replacement) {
      throw new ValidationError("error.cannot_deliver_out_of_stock", { product: item.product.name });
    }
    await db.orderItem.update({ where: { id: item.id }, data: { stockItemId: replacement.id } });
    stock = replacement;
  }
  await db.stockItem.update({ where: { id: stock.id }, data: { status: StockStatus.SOLD, soldAt: now } });
}
```
Konfirmasi: ya, `OrderItem.stockItemId` ditimpa (line 1583-1586) tanpa jejak
baris lama — persis masalah #1 di brief ("jejak tidak boleh hilang"). Ini
target langsung Fase 3's `SUBSTITUTED_OUT`/`SUBSTITUTED_IN` events.

### allocateOneAvailableStock — optimistic lock & retry
**Status: confirmed-as-designed, satu detail dikoreksi.**
`packages/db/src/crud/stock.ts:203-229`:
```js
export async function allocateOneAvailableStock(db, productId, orderId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = await db.stockItem.findFirst({
      where: { productId, status: StockStatus.AVAILABLE }, orderBy: { id: "asc" },
    });
    if (!candidate) return null;
    const res = await db.stockItem.updateMany({
      where: { id: candidate.id, status: StockStatus.AVAILABLE },
      data: { status: StockStatus.RESERVED, orderId, reservedAt: new Date() },
    });
    if (res.count === 1) return db.stockItem.findUnique({ where: { id: candidate.id } });
  }
  return null;
}
```
- Retry: **5 kali**.
- Habis retry (atau tidak ada kandidat sama sekali): **`return null`**, bukan
  throw langsung di fungsi ini. Koreksi terhadap asumsi brief — ini
  silent-return, bukan crash implisit. Setiap pemanggil (`orders.ts:776-778`,
  `:982-984`, `:1578-1582`) memeriksa `null` dan melempar `ValidationError`
  sendiri (`error.out_of_stock` / `error.cannot_deliver_out_of_stock`).

### bulkAddStock dedup
**Status: confirmed-as-designed.**
`packages/db/src/crud/stock.ts:34-62` — dedup dua arah: `new Set(credentials)`
untuk batch yang sama, lalu fetch semua baris eksisting berstatus
`AVAILABLE|RESERVED|SOLD` dan **dekripsi semua ke memori** untuk dibandingkan
(didokumentasikan sebagai O(baris eksisting) per panggilan, diterima karena
tabel low-volume). **`DEAD` dikecualikan dari dedup** — kredensial yang
pernah ditandai DEAD bisa diimpor ulang tanpa dianggap duplikat. Sesuai
asumsi brief persis.

### Refund tidak menyentuh StockItem
**Status: confirmed-as-designed.**
`packages/db/src/crud/refunds.ts` (workflow `Refund`/`RefundItem` murni,
tidak ada `stockItem`/`StockStatus` di grep). Jalur payout nyata yang
ditemukan, `refundUnderpaidOrder` (`packages/db/src/crud/binance_internal.ts:941-1001`),
juga tidak menyentuh `db.stockItem.*` — masuk akal karena beroperasi pada
order `UNDERPAID` yang belum pernah sampai tahap reservasi stok.

### Sold count
**Status: confirmed-as-designed.**
Agregat baca `groupBy` atas `OrderItem.quantity` where `Order.status === DELIVERED`,
bukan counter tersimpan. Ada di tiga tempat: `orders.ts:2480-2497`
(`soldCountsByDenomination`), `:2500-2503`, `:2511-2519`, dan sengaja
diduplikasi di `catalog.ts:1055-1084` untuk menghindari circular import
`catalog.ts ↔ orders.ts`. Tidak ada field `soldCount` di schema manapun.

---

## 0.2 Audit enkripsi kredensial

### Bentuk envelope
**Status: confirmed-as-designed.**
`packages/core/src/credentialCrypto.ts:27-41,93-106` — `{keyVersion, iv,
ciphertext, authTag}`, encoding **base64** untuk `iv`/`ciphertext`/`authTag`
(kunci itu sendiri **hex**, didekode terpisah). `IV_LENGTH_BYTES = 12`
(comment: "NIST-recommended GCM IV length"), `KEY_LENGTH_BYTES = 32`,
algoritma `"aes-256-gcm"`.

### Sumber & validasi kunci
**Status: gap — targeted by Fase 6.3. Severity: high.**
Dibaca dari `process.env.CREDENTIAL_ENCRYPTION_KEY` secara **lazy**, di
dalam `keyForVersion()`, dipanggil setiap kali `encryptCredentials`/
`decryptCredentials` dieksekusi — bukan sekali saat module load
(`credentialCrypto.ts:19-24` mendokumentasikan ini sengaja, supaya key bisa
divariasikan per-test).
```ts
function keyForVersion(version: number): Buffer {
  if (version !== CURRENT_KEY_VERSION) throw new CredentialKeyConfigError(...);
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new CredentialKeyConfigError("CREDENTIAL_ENCRYPTION_KEY is not configured...");
  let key: Buffer;
  try { key = Buffer.from(raw, "hex"); } catch { throw new CredentialKeyConfigError("...not valid hex."); }
  if (key.length !== KEY_LENGTH_BYTES) throw new CredentialKeyConfigError(`...must decode to exactly ${KEY_LENGTH_BYTES} bytes...`);
  return key;
}
```
Panjang **divalidasi** (harus 32 byte), tapi **hanya meledak saat enkripsi/
dekripsi pertama**, bukan saat boot proses — bertentangan langsung dengan
requirement brief "**Harus gagal saat boot**". `docker-entrypoint.sh:168-209`
memitigasi sebagian (auto-generate kalau env kosong), tapi tidak untuk kasus
key salah panjang/format yang di-set manual secara keliru. Ini target
eksplisit Fase 6.3 ("Validasi panjang kunci saat boot; gagal keras kalau
salah").

### AAD
**Status: gap — targeted by Fase 6.2. Severity: high (confirmed sesuai
dugaan brief).**
Grep repo-wide untuk `setAAD`/`getAAD`: **nol hasil**. `createCipheriv`/
`createDecipheriv` (`credentialCrypto.ts:96,157`) tidak pernah mengikat data
tambahan apa pun. **Konfirmasi**: ciphertext portabel antar baris dan antar
environment — menyalin `credentials` satu baris ke baris lain (atau restore
DB ke environment lain yang berbagi `CREDENTIAL_ENCRYPTION_KEY` yang sama)
akan berhasil didekripsi tanpa sinyal integritas bahwa baris itu dipindah.
Hanya `keyVersion` yang tertanam, bukan binding ke row/table.

### Fallback legacy-plaintext
**Status: gap — targeted by Fase 6.5. Severity: high.**
`credentialCrypto.ts:147-164`:
```ts
export function decryptCredentials(stored: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(stored); } catch { return stored; }
  if (!isEnvelopeShape(parsed)) return stored;
  const key = keyForVersion(parsed.keyVersion);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.authTag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}
```
Dua cabang silent pass-through (`catch { return stored; }` dan
`if (!isEnvelopeShape(parsed)) return stored;`). **Tidak ada counter, log,
atau metrik** pada kedua cabang. **Tidak digate di balik flag env apa pun**
hari ini — ini adalah jalur permanen tanpa syarat, dimaksudkan untuk
mentoleransi baris yang belum tersentuh backfill satu-kali
(`scripts/backfill-encrypt-stock-credentials.ts`,
`scripts/backfill-encrypt-settings-secrets.ts`). Koreksi terhadap brief:
Fase 6.5 tidak "mematikan" flag yang sudah ada — flag `ALLOW_LEGACY_PLAINTEXT`
**harus dibuat dari nol**, belum ada sama sekali.

### Jumlah baris legacy — TIDAK DAPAT DIUKUR di environment ini
**Status: outstanding action, bukan gap kode.**
DB Postgres dev lokal (`web-and-bot-order-postgres-1`, `bot_order`) **kosong
total**: `SELECT count(*) FROM stock_items` = 0, `SELECT count(*) FROM orders` = 0.
Tidak ada apa pun untuk dihitung di environment ini. Query read-only berikut
sudah ditulis dan diuji (aman — hanya membuat fungsi `pg_temp` session-scoped,
tidak menulis data apa pun) dan **perlu dijalankan terhadap DB produksi** oleh
siapa pun yang punya akses:

```sql
CREATE OR REPLACE FUNCTION pg_temp.try_jsonb(t text) RETURNS jsonb AS $$
BEGIN
  RETURN t::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

SELECT
  count(*) AS total_rows,
  count(*) FILTER (WHERE pg_temp.try_jsonb(credentials) IS NULL) AS not_valid_json_legacy_plaintext,
  count(*) FILTER (
    WHERE pg_temp.try_jsonb(credentials) IS NOT NULL
      AND NOT (
        pg_temp.try_jsonb(credentials) ? 'keyVersion'
        AND pg_temp.try_jsonb(credentials) ? 'iv'
        AND pg_temp.try_jsonb(credentials) ? 'ciphertext'
        AND pg_temp.try_jsonb(credentials) ? 'authTag'
      )
  ) AS valid_json_but_not_envelope_shape,
  count(*) FILTER (
    WHERE (pg_temp.try_jsonb(credentials)->>'keyVersion') IS NOT NULL
      AND (pg_temp.try_jsonb(credentials)->>'keyVersion')::text <> '1'
  ) AS envelope_keyversion_not_1
FROM stock_items;
```
Ganti nama tabel/kolom secara sama untuk menghitung baris `Setting` yang
terenkripsi kalau dibutuhkan.

### Isolasi kegagalan dekripsi
**Status: gap — not yet covered by rencana fase manapun (paling dekat ke
Fase 6.4, tapi 6.4 belum menyebutkan pemanggil spesifik ini). Severity:
high** karena satu jalur bisa dipicu buyer biasa.

Dua pemanggil **sudah** dikeraskan per-baris:
- `packages/db/src/crud/stock.ts:328-337` (`searchStockCredentials`) —
  try/catch per baris, baris rusak diperlakukan sebagai non-match, bukan
  melempar (kecuali `CredentialKeyConfigError`, yang tetap di-rethrow).
- `apps/order-bot/src/handlers/admin.ts:485-494` (`viewStockItems`) —
  try/catch per item, baris rusak diganti `"[unavailable]"` + `logger.warn`.

Tiga pemanggil **belum**:
- `packages/db/src/crud/stock.ts:49` (`bulkAddStock` dedup) — tanpa guard;
  satu baris eksisting rusak melempar, membatalkan seluruh transaksi
  bulk-add. Route (`apps/web-admin/src/routes/api/stock.ts:232-240`) hanya
  menangkap `CredentialKeyConfigError`, bukan kegagalan auth-tag generik.
- `packages/db/src/crud/stock.ts:140` (`listAvailableCredentials`, dipakai
  export CSV) — tanpa guard; satu baris rusak menggagalkan seluruh download.
- `packages/db/src/crud/orders.ts:502-509` (`withDecryptedStockCredentials`)
  — tanpa guard. Dipakai `getOrder`/`getOrderByCodeFull` (satu order gagal
  total kalau satu item stoknya rusak) **dan** `listUserDeliveredOrders`
  (`orders.ts:1132-1140`), yang di-map ke **seluruh riwayat order seorang
  user sekaligus** — dipakai endpoint buyer-facing
  `apps/storefront/src/routes/apiAccount.ts:327` (`/account/reviews`). Satu
  baris `StockItem` yang tampered/corrupt bisa membuat endpoint riwayat order
  seorang customer 500 total.

Catatan penting: komentar di `apps/web-admin/test/web.test.ts:3760-3791`
menunjukkan tim **sudah pernah** menemukan dan memperbaiki persis kelas bug
ini untuk `searchStockCredentials` — tapi perbaikan itu tidak
diterapkan ke tiga pemanggil lain di atas, yang masih rentan pada pola
kegagalan yang sama.

### Key reuse
**Status: confirmed-as-designed, tidak ada masalah.**
Grep repo-wide `CREDENTIAL_ENCRYPTION_KEY`: satu-satunya pembaca kriptografi
adalah `credentialCrypto.ts` (dipakai untuk `StockItem.credentials` dan,
lewat `setEncryptedSetting`/`getDecryptedSetting`, subset kunci `Setting`:
`tokopay_secret`, `paydisini_apikey`, `bybit_api_key/secret`,
`binance_api_key/secret`, `nowpayments_api_key/ipn_secret`, `bscscan_api_key`,
`smtp_pass`, `digiflazz_api_key`, `kokinpay_api_key`, `vipreseller_api_key`,
`melostore_api_key/secret_key` — `settings.ts:77-85`). Sisanya hanya
referensi di string error/log atau dokumentasi/test. Tidak ada reuse untuk
signing/session/HMAC.

---

## 0.3 Audit kebocoran plaintext di luar StockItem.credentials

### Order.deliveredContent
**Status: gap — targeted by Fase 6.1. Severity: critical (konfirmasi penuh
dugaan brief).**
`prisma/schema.prisma:635` — `deliveredContent String? @map("delivered_content")`,
kolom TEXT biasa, **tidak dienkripsi**. Dua penulis, keduanya plaintext
verbatim:
- `packages/db/src/crud/orders.ts:2266` (`fulfillManualOrder`) —
  `deliveredContent: content` (teks yang diketik admin apa adanya).
- `packages/db/src/crud/digiflazz.ts:621` (`fulfillDigiflazzOrder`) —
  `deliveredContent: args.sn` (serial number supplier, mentah).

Pembacaan:
- Admin order detail (`GET /api/orders/:orderId`) — lihat temuan kritis di
  bawah (**tidak diaudit**).
- Bot pelanggan (`apps/order-bot/src/handlers/customer.ts:1297-1298`) dan
  storefront account API (`apps/storefront/src/routes/apiAccount.ts:258`) —
  pembeli melihat data miliknya sendiri, audit tidak relevan di sini.
- Route resend (`apps/web-admin/src/routes/api/orders.ts:265-318`) — **sudah
  diaudit** (`logAdminAction`, action `order_resend_credentials`,
  `orders.ts:306`); body respons tidak pernah mengandung konten.
- Export CSV order (`GET /api/orders/export`) — **bersih**, tidak menyertakan
  `deliveredContent`.

### 🔴 Temuan baru — kritikal: reveal tanpa audit di GET /api/orders/:orderId
**Status: gap — not yet covered oleh rencana fase manapun. Severity:
critical.** Ini kemungkinan temuan paling serius dari seluruh audit.

`apps/web-admin/src/routes/api/orders.ts:194-214` mengambil order lewat
`getOrder(prisma, orderId)` (yang secara internal mendekripsi
`stockItem.credentials` lewat `withDecryptedStockCredentials`,
`orders.ts:506`) dan mengembalikan **seluruh objek order** ke client,
termasuk kredensial stok yang sudah didekripsi **dan** `deliveredContent`.
**Tidak ada panggilan `logAdminAction` di handler ini sama sekali.**
Dirender langsung di `apps/web-admin/client/src/pages/OrderDetailPage.tsx:393`
(`item.stockItem?.credentials`) dan `:433` (`deliveredContent`).

Bandingkan dengan route `/api/stock/item/:stockId/reveal`
(`apps/web-admin/src/routes/api/stock.ts:429-446`) yang eksplisit menulis
`credential_revealed` ke `AuditLog` — desain "reveal wajib diaudit" itu
sendiri **sudah ada dan benar** di satu tempat, tapi terlewat sepenuhnya di
jalur order-detail yang jauh lebih sering diakses. Setiap kali admin membuka
halaman detail order manapun, itu adalah reveal kredensial senyap.

### 🔴 Temuan baru: reveal tanpa audit di bot admin (viewStockItems)
**Status: gap — not yet covered. Severity: high.**
`apps/order-bot/src/handlers/admin.ts:464-503` (`viewStockItems`) mendekripsi
setiap item untuk preview 30-karakter yang ditampilkan ke admin di Telegram
— tidak ada `AuditLog`/event tertulis. Sudah ditangani dengan baik untuk
isolasi kegagalan (lihat 0.2), tapi tetap merupakan reveal plaintext nyata
tanpa jejak audit.

### StockItem.note
**Status: gap — not yet covered. Severity: medium.**
Field bebas, admin-editable lewat input single-line
(`apps/web-admin/client/src/pages/StockProductPage.tsx:405-427`,
`POST /api/stock/item/:stockId/note` → `setStockNote`,
`packages/db/src/crud/stock.ts:238`). Juga ikut di-scan oleh
`searchStockCredentials` (`stock.ts:317-339`).

**Vektor kebocoran konkret**: rute set-note dan mark-dead menyalin isi
`note` verbatim (terpotong 160-200 karakter) ke `AuditLog.details`:
- `apps/web-admin/src/routes/api/stock.ts:408` —
  `details: \`Updated stock item note to: "${note.slice(0, 200)}"\`.`
- `apps/web-admin/src/routes/api/stock.ts:361` —
  `details: \`Marked stock item dead. Note: "${note.slice(0, 200)}"\`.`
- `apps/web-admin/src/routes/api/stock.ts:318` —
  `details: \`Marked ${count} stock items dead. Note: "${note.slice(0, 160)}"\`.`

Kalau admin pernah menempel kredensial ke field note ini, sampai 200 karakter
kredensial itu terduplikasi **plaintext ke audit log** — tempat yang justru
dimaksudkan sebagai jejak tepercaya, sekarang juga jadi sink kredensial di
luar batas enkripsi `credentials`.

### AuditLog.details / OrderStatusHistory.meta
**Status: confirmed-as-designed, kecuali temuan note di atas.**
162 pemanggilan `logAdminAction` dan setiap `db.orderStatusHistory.create()`
digrep — tidak ada yang menginterpolasi `deliveredContent` atau kredensial
terdekripsi secara langsung (setiap entry stok eksplisit berkomentar "never
the credentials", `stock.ts:318,339,361,390,408,445,465`). Satu-satunya
jalur nyata adalah echo `note` di atas, plus kategori risiko lebih rendah
yang tidak spesifik-kredensial: alasan bebas-teks admin (`reason`) yang
masuk ke `OrderStatusHistory.meta` (`orders.ts:1496`).

### Logger & error handler
**Status: confirmed-as-designed secara umum, satu temuan baru signifikan.**
`packages/db/src/crud/stock.ts`, `orders.ts`, `digiflazz.ts` — tidak ada
`logger.*`/`console.*`/`JSON.stringify` yang menginterpolasi kredensial
terdekripsi atau `deliveredContent`. Error handler global sudah dikeraskan
secara sengaja: `apps/web-admin/src/server.ts:114-126` ("never log the
request body"), `apps/order-bot/src/main.ts:161-177` ("never log the raw
user text"), keduanya `Fastify({ logger: false })`.

**🟠 Temuan baru — high: kebocoran lewat error serializer pino di outbox
dispatcher.**
`packages/outbox-dispatcher/src/dispatcher.ts:621` — `logger.error({ err: e }, ...)`
pada kegagalan generik kirim Telegram me-log **seluruh objek `GrammyError`**
lewat error serializer default pino. `GrammyError` menyimpan `payload`
permintaan API yang dikirim (termasuk teks kredensial/`deliveredContent`)
sebagai own property (`node_modules/.../grammy/out/core/error.js:19-34`,
`this.payload = payload`), dan pino's `err` serializer
(`pino-std-serializers/lib/err.js:26-33`) menyalin semua own property ke
record log. Wrapper `trySend` ini dipakai baik oleh `deliverAccountDm`
(file kredensial stok) maupun `deliverManualContentDm` (`deliveredContent`)
— jadi **kegagalan kirim non-fatal apa pun** (pesan terlalu panjang, parse
entities gagal, state chat aneh) menulis kredensial/`deliveredContent`
plaintext langsung ke log aplikasi. Ini kebocoran nyata dan sudah live di
kode saat ini, di luar cakupan Fase 1-7 yang sudah direncanakan — layak
dipertimbangkan untuk diperbaiki lebih cepat daripada menunggu giliran fase.

### Telegram bot — retensi pesan
**Status: confirmed-as-designed (dengan pengecualian temuan di atas).**
Pengiriman kredensial (`deliverAccountDm`, dispatcher.ts:393-424) dan
`deliveredContent` (`deliverManualContentDm`, dispatcher.ts:458-502) memang
harus mengirim plaintext ke chat — itu tujuan fitur. `NotificationOutbox.payloadJson`
sengaja **tidak** menyimpan konten yang dirender (komentar
`notifications.ts:1030-1031`; diverifikasi test
`settlePaidOrder.test.ts:917` yang menegaskan `payloadJson` tidak pernah
berisi `"deliveredContent"`). Middleware grammY tidak mencatat teks pesan.
Satu-satunya kebocoran ke log adalah lewat jalur error serializer di atas.

### Export/CSV admin
**Status: confirmed-as-designed.**
- `GET /api/orders/export` — kolom Order Code/Customer/Status/Currency/Total/
  Payment Method/Created At saja. Bersih.
- `GET /api/stock/export` — agregat **jumlah** stok per denominasi saja,
  tanpa kredensial per-item (komentar eksplisit di `stock.ts:96-100`).
- `GET /api/stock/:productId/download` — **ini yang benar-benar mendumping
  kredensial plaintext**, satu login per baris sebagai `.txt`. **Sudah
  diaudit dengan benar**: `preHandler: blockReadonlyReads`, dicatat via
  `logAdminAction` (`action: "stock_download"`, hanya jumlah baris di
  `details`, `stock.ts:460-465`).

### Ringkasan jalur dekripsi tanpa audit
| Pemanggil | Audit? |
|---|---|
| `/api/stock/item/:stockId/reveal` | ✅ `credential_revealed` |
| `/api/stock/:productId/download` | ✅ `stock_download` |
| **`GET /api/orders/:orderId`** | ❌ **tidak ada audit sama sekali** |
| `/api/orders/:orderId/resend` | ✅ `order_resend_credentials` |
| `/api/orders/bulk-action` (getOrder internal) | ❌ tapi nilai tidak dipakai/dikembalikan — exposure nihil |
| `/api/search` (getOrder internal, untuk redirect) | ❌ tapi nilai tidak dipakai — exposure nihil |
| `searchStockCredentials` (admin search) | ❌ tapi respons di-mask (`MASKED_CREDENTIAL`) — exposure nihil |
| `bulkAddStock` dedup | ❌ internal-only, tidak pernah dikembalikan — exposure nihil |
| **bot `viewStockItems`** | ❌ **reveal nyata (preview terpotong), tanpa audit** |
| `approveOrder` auto-deliver | ✅ diaudit oleh caller (`auto_deliver` atau `approve_order`) |

Dua baris bertanda ❌ tebal di atas adalah reveal nyata tanpa audit yang
perlu ditindaklanjuti; sisanya secara teknis tidak diaudit tapi tidak
membocorkan apa pun ke luar.

---

## 0.4 Audit infrastruktur kunci

### Kunci ter-commit?
**Status: confirmed clean.**
`git log --all --diff-filter=A --name-only` untuk pola `.env`/`.env.*` hanya
menemukan `.env.example` (placeholder murni, `ganti-dengan-64-karakter-hex-acak`,
dikomentari). Tidak ada `.env` asli pernah ter-commit. Grep
`CREDENTIAL_ENCRYPTION_KEY` di `docker-compose*.yml`/`.github/**`/`*.yml`:
nihil.

### Auto-generation & pemisahan dari DB
**Status: confirmed-as-designed — mitigasi sudah baik.**
`docker-entrypoint.sh:168-209` (`ensure_credential_key`): kalau env kosong,
generate key acak sekali, simpan ke `data/credential_encryption.key`
(**bukan** `.env`/DB), `chmod 600`, **tidak pernah** ditulis ke log
(`"The key itself is never written to this log."`). Kalau operator sudah
set env manual, tidak pernah di-override.

### Backup DB terenkripsi?
**Status: gap — accepted risk, sudah didokumentasikan. Severity: low/medium.**
`deploy/backup/backup.sh:153` — `pg_dump -U ... -Fc ... | gzip` — dump **tidak
dienkripsi at rest**. Secara default berada di `data/backups/`, di dalam
`./data` yang sama dengan `data/credential_encryption.key`.
`.env.example:96-102` sudah secara eksplisit memperingatkan risiko ini dan
menginstruksikan operator menyimpan file key di lokasi off-box terpisah dari
backup DB — tapi **tidak ada penegakan teknis**; operator yang naif
menjalankan `tar czf backup.tar.gz data/` akan menggabungkan key dan
ciphertext dalam satu archive, meniadakan manfaat pemisahan yang didesain.
Tidak direkomendasikan untuk diperbaiki di fase ini (di luar scope brief),
hanya dicatat sebagai risiko yang diterima secara sadar dan sudah
terdokumentasi.

---

## Ringkasan prioritas untuk ditindaklanjuti

Selain gap yang sudah tercakup rencana Fase 1-7, dua temuan berikut **belum**
punya slot di rencana manapun dan sebaiknya dipertimbangkan terpisah/lebih
cepat karena keduanya adalah kebocoran/celah nyata yang aktif hari ini, bukan
sekadar hardening preventif:

1. **Critical** — `GET /api/orders/:orderId` mengembalikan kredensial stok
   terdekripsi + `deliveredContent` tanpa audit sama sekali. Setiap admin
   yang membuka halaman detail order mana pun adalah reveal senyap.
2. **High** — `packages/outbox-dispatcher/src/dispatcher.ts:621` membocorkan
   kredensial/`deliveredContent` plaintext ke log aplikasi lewat error
   serializer pino pada kegagalan kirim Telegram non-fatal apa pun.

Ditambah satu item yang butuh tindakan operasional (bukan kode) sebelum Fase
2 (backfill) bisa dijalankan dengan percaya diri:

3. Jalankan query SQL read-only di §0.2 terhadap **DB produksi** untuk
   mengetahui jumlah baris legacy-plaintext dan `keyVersion != 1` — tidak
   bisa diukur dari environment audit ini karena DB dev lokal kosong.

Semua temuan lain sudah tercakup oleh urutan Fase 1 (skema additive) → Fase 6
(pengerasan enkripsi) sebagaimana didesain di brief.
