# Sistem Inventori (Stok)

Model: `StockItem` (tabel `stock_items`) — satu baris = satu kredensial siap
jual (akun/lisensi/key), terikat ke satu `Denomination` (kolom `productId`,
lihat catatan rename historis di [DATABASE.md](DATABASE.md)). CRUD:
`packages/db/src/crud/stock.ts`.

## Status stok

```
AVAILABLE → RESERVED → SOLD
AVAILABLE → DEAD   (admin: "Mark as bad")
RESERVED  → AVAILABLE  (rilis: cancel/expire order)
RESERVED  → DEAD       (bulk mark dead, jika belum SOLD)
```

| Status | Arti | Bisa dialokasikan? |
|---|---|---|
| `AVAILABLE` | Siap jual | Ya |
| `RESERVED` | Terkunci ke satu order `PENDING_PAYMENT`/`PENDING_VERIFICATION` | Tidak |
| `SOLD` | Terkirim ke pembeli (order `DELIVERED`) | Tidak — **tidak pernah** kembali ke status lain |
| `DEAD` | Ditandai admin rusak/expired/dicabut provider | Tidak |

## Reservasi atomik saat checkout (bukan saat approve)

`allocateOneAvailableStock(db, productId, orderId)` — dipanggil di dalam
`$transaction` checkout (`createOrderDirect`/`createOrderFromCart`), **bukan**
ditunda sampai admin approve. Ini menutup celah oversell yang sebelumnya ada
(Checkout-2 fix, audit keamanan 2026-06-23):

```ts
for (let attempt = 0; attempt < 5; attempt++) {
  const candidate = await db.stockItem.findFirst({
    where: { productId, status: "AVAILABLE" }, orderBy: { id: "asc" },
  });
  if (!candidate) return null;
  const res = await db.stockItem.updateMany({
    where: { id: candidate.id, status: "AVAILABLE" },   // optimistic guard
    data: { status: "RESERVED", orderId, reservedAt: new Date() },
  });
  if (res.count === 1) return /* baris yang berhasil diklaim */;
  // kalah race untuk baris ini — coba baris berikutnya (maks 5 percobaan)
}
```

SQLite menyerialkan writer dalam satu `$transaction` sehingga ini race-free
hari ini; guard `updateMany WHERE status=AVAILABLE` + retry tetap dipasang
agar tidak diam-diam bergantung pada detail isolasi SQLite (penting jika
suatu saat migrasi ke Postgres — lihat catatan lintas-domain di
`docs/audit-security-2026-06-23.md`).

Sebelum loop reservasi, `countAvailableStock` dicek per baris cart sebagai
**fast-fail** — supaya permintaan qty lebih dari stok yang ada tidak
meninggalkan reservasi parsial.

## Pelepasan reservasi (`releaseOrderHolds`)

Dipanggil oleh `cancelOrder`, `rejectOrder`, dan `creditOrderToBalance` —
mengembalikan setiap `StockItem` berstatus `RESERVED` milik order itu ke
`AVAILABLE` (`orderId: null`, `reservedAt: null`), plus refund wallet/voucher
terkait. Lihat [ORDER_STATE_MACHINE.md](ORDER_STATE_MACHINE.md).

## ⚠️ Limitasi yang diketahui: belum ada reaper TTL

**Tidak ada job terjadwal yang melepas `RESERVED` basi** (mis. order yang
macet di luar jalur normal — crash di tengah transaksi sebelum sampai
`releaseOrderHolds`). Risiko ini didokumentasikan sebagai temuan Low
(`Stock-2`) di audit keamanan 2026-06-23: saat ini **tidak aktif** karena
setiap baris RESERVED punya jalur pelepas yang jelas (expire cron, cancel,
credit) — tapi bila pola pemakaian berubah, tambahkan reaper berbasis
`reservedAt`+TTL:

```ts
// Belum diimplementasikan — referensi pola jika dibutuhkan
export async function releaseStaleReservations(db: Db, olderThanMinutes: number) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  return db.stockItem.updateMany({
    where: { status: "RESERVED", reservedAt: { lt: cutoff } },
    data: { status: "AVAILABLE", orderId: null, reservedAt: null },
  });
}
```

## Dedup saat tambah stok massal (`bulkAddStock`)

Admin upload kredensial (satu baris per akun, format `email:password`) lewat
panel Stock. `bulkAddStock` dedup di **dua arah** (Stock-1 fix, audit
2026-06-23):

1. **Dalam batch yang sama** — CSV yang sama tertempel dua kali → `new
   Set(credentials)`.
2. **Terhadap baris existing** — kredensial yang sudah `AVAILABLE`/
   `RESERVED`/`SOLD` untuk produk itu tidak di-insert ulang (kredensial
   `DEAD` BUKAN dianggap duplikat — baris mati boleh ditambah ulang).

Return `{ added, skipped }` — kedua angka dilaporkan ke admin & dicatat di
audit log. **Tidak ada UNIQUE constraint di level DB** untuk `credentials`
— mitigasi sengaja di level aplikasi (constraint DB butuh keputusan soal
data lama yang mungkin sudah duplikat sebelum fix ini ada).

## Hapus stok (`bulkDeleteStock`) vs tandai rusak (`markStockDead`/`bulkMarkStockDead`)

Dua operasi berbeda, jangan tertukar:

- **Hapus (`bulkDeleteStock`)** — hard-delete baris. **Dua guard**: baris
  `SOLD` tidak pernah dihapus, dan baris yang terkait `OrderItem` apa pun
  (`orderItems: { none: {} }`) dilewati — histori order terkirim tetap
  utuh meski kredensial-nya pernah dihapus dari pool tersedia.
- **Tandai rusak (`markStockDead`/`bulkMarkStockDead`)** — soft, ubah status
  ke `DEAD` + catat `note`. Hanya baris `AVAILABLE`/`RESERVED` yang disentuh
  (`SOLD`/`DEAD` dilewati). Ini yang dipakai saat provider mencabut akun,
  bukan delete.

## Download stok tersisa

`listAvailableCredentials` (dipanggil dari `GET /stock/:productId/download`)
— **hanya** baris `AVAILABLE`, urut `id ASC`. Hasilnya **tidak pernah
dicatat ke log** (`Cache-Control: no-store`, audit hanya mencatat jumlah
baris, bukan isi kredensial) — lihat
[`../CLAUDE.md`](../CLAUDE.md) "Never log secrets".

## Agregat status (`stockStatusCounts`)

Satu query `groupBy` per `(productId, status)` — dipakai dashboard admin dan
kartu produk storefront (badge "stok menipis" di bawah
`LOW_STOCK_THRESHOLD`). Lihat [`../DOCS.md` §7](../DOCS.md#7-manajemen-stok).

## Restock subscription

`RestockSubscription` (unique `(userId, productId)`) — pelanggan
"berlangganan" notifikasi saat stok produk tertentu kembali tersedia.
**Bukan cron** — `notifyRestockSubscribers(ctx, productId)`
(`apps/order-bot/src/handlers/admin.ts`) dipanggil **langsung setelah admin
menambah stok** lewat panel/bot. Sekali-pakai: subscription row dihapus
(`deleteMany`) begitu notifikasi terkirim, jadi pelanggan harus subscribe
ulang untuk restock berikutnya. Kirim langsung via `ctx.api.sendMessage`
(bukan lewat `notification_outbox`) — perhatikan ini satu-satunya jalur
notifikasi di luar outbox yang ditemukan di codebase.
