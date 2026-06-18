# Laporan Phase 6 — Database Audit

Tanggal: 2026-06-18 · Read-only. Tidak menjalankan migrasi.

## Ringkasan: schema **sehat**. Indeks & unique sudah menutup jalur lookup/filter panas.

## Index & Unique (terverifikasi `prisma/schema.prisma`)
- **Unique pada kolom lookup panas:** `User.telegramId/loginUsername/email/referralCode`, `Order.orderCode`, `Order.paymentRef`, `Voucher.code`, `Category.name`, `BulkPricing.productId`, `Processed{Binance,Bybit,Tokopay}Tx.txid`, `PasswordResetToken.tokenHash`, composite `Review(userId,orderId)`, `CartItem(userId,productId)`, `RestockSubscription(userId,productId)`, `Referral.refereeId`. → semua `findUnique` panas terindeks.
- **Index pendukung filter/sort:** `Product(categoryId)`, `Product(productGroupId)`, `ProductGroup(categoryId)`, `StockItem(status)`, `StockItem(productId)`, `StockItem(productId,status)` (composite — pas untuk hitung stok available), `Order(userId)`, `Order(status)`, `Order(status,createdAt)` (composite — pas untuk list order terfilter+urut), `Order(binanceTxid/bybitTxid)`, `NotificationOutbox(status,createdAt)` + `(status)` + `(orderId)` + `(createdAt)`, `Broadcast(status)`, `AuditLog(createdAt)`, FK-FK lain.

**Kesimpulan index:** tidak ditemukan **missing index** pada query crud yang ada. Cakupan sangat baik (composite index sesuai pola query).

## Integritas relasi ✅
- FK aktif (`PRAGMA foreign_keys=ON`).
- `deleteGroup` melepas member dalam `$transaction` sebelum hapus grup → **tak ada orphan**.
- Idempotensi pembayaran via tabel Processed*Tx (unique txid).

## Money ✅
- Kolom uang `Decimal` (bukan `Float`) — konsisten aturan repo.

## Migrasi
```
ID | Kategori | Temuan | Rekomendasi
D-01 | migrasi-aman | Penambahan kolom non-null tanpa default berisiko P2022 saat deploy | Untuk schema change: `pnpm prisma db push` + restart SEBELUM kode baru jalan (sudah didokumentasikan CLAUDE.md); tambah default / 2-step (nullable→backfill→non-null) untuk kolom wajib |
D-02 | single-writer | SQLite 1 writer = batas tulis | Pantau; pemicu Postgres = ≥2 concurrent writer (RUN.md §9) |
```

## Temuan
Tidak ada masalah index/relasi/tipe. Hanya disiplin **migrasi aman** (D-01) & batas single-writer (D-02, arsitektural).

> Read-only — tidak ada perubahan schema/migrasi.
