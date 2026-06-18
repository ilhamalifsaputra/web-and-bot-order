# Phase 5 — Performance Audit

> Read-only.

---

## Konteks Proyek
Server-rendered Nunjucks. DB **SQLite tunggal (single-writer, WAL)** → panjang
transaksi & query berat berdampak langsung. crud katalog `packages/db/src/crud/catalog.ts`:
`listCatalogEntries`, `listNewestCatalogEntries`, `searchCatalogEntries` — sebagian
**scan seluruh katalog** lalu kolaps/slice di memori. Badge rating/bulk diambil sekali
sebagai map (anti N+1): `productRatingSummaries`, `activeBulkPricingByProduct`.
Order list admin sudah paginasi (`apps/web-admin/src/routes/orders.ts:36-37`).

---

## Objective
Identifikasi bottleneck terbesar (FE & BE), dengan konteks skala (satu toko vs ×100).

## Backend — Langkah Investigasi
1. **Query tanpa batas:** `grep -rn "findMany" apps packages --include=*.ts | grep -v test` → tandai yang **tanpa `take`** pada data yang bisa besar.
   - Petunjuk: `searchCatalogEntries` memotong di memori, bukan `take` di DB. `listCatalogEntries` scan seluruh kategori.
2. **N+1:** cari `findMany`/`findUnique` di dalam loop (`for`/`map` yang await query). Verifikasi badge map sudah mencegah N+1 di grid.
3. **Index pendukung:** cocokkan kolom `where`/`orderBy` di crud dengan `@@index` di `prisma/schema.prisma` (lihat juga Phase 6).
4. **Transaksi panjang:** `grep -rn "\$transaction" packages apps --include=*.ts` → pastikan pendek (single-writer).
5. **Blocking:** operasi sync berat / `await` berantai yang bisa di-`Promise.all`.

## Frontend — Langkah Investigasi
- Lazy loading gambar: `grep -rn "loading=\"lazy\"" apps/storefront/views` (kartu grid harus lazy; hero `fetchpriority="high"`).
- Ukuran gambar: cek params Unsplash/`webImageUrl` (cropped/compressed).
- JS: minim (HTMX + inline). Cek skrip inline besar di `home.njk`.

## Output → tulis ke `audit/reports/phase-05-performance.md`
```
ID | Layer (FE/BE/DB) | File:line | Masalah | Dampak @skala-kini | Dampak @×100 | Saran (mis. take, index, cache) | Prioritas
```
Tutup dengan **3 bottleneck teratas** terurut.
