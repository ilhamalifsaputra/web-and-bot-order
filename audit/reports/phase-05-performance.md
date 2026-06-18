# Laporan Phase 5 — Performance Audit

Tanggal: 2026-06-18 · Read-only. Skala: satu toko (SQLite single-writer).

## Backend

### Temuan
```
ID | Layer | File:line | Masalah | @kini | @×100 | Saran | Prioritas
P5-01 | DB | crud/catalog.ts:468-490 (searchCatalogEntries) | match produk di-fetch tanpa take; cap diterapkan di memori setelah kolaps | OK | query luas (q="a") muat semua match | tambah take (mis. limit*4) di query match | Medium
P5-02 | DB | crud/catalog.ts:391-415 (listCatalogEntries), 429-450 (listNewest) | scan seluruh kategori/katalog lalu kolaps di memori | OK | berat bila katalog besar | cache read katalog / batasi | Medium (saat tumbuh)
P5-03 | DB | crud/reports.ts:27,59,75,197 | laporan memuat semua order/voucher/user tanpa take | OK (admin/periodik) | berat | agregasi via groupBy / rentang tanggal | Low |
P5-04 | DB | crud/catalog.ts:193 (bulkSetPrices) | update di loop | OK | OK | sudah dibungkus $transaction pemanggil — biarkan | Info |
```

### Yang sehat ✅
- **Tak ada N+1 di grid katalog:** badge rating & bulk diambil sekali sebagai map (`productRatingSummaries`, `activeBulkPricingByProduct`).
- **Transaksi pendek & terfokus:** semua jalur tulis kritis (order/stock/wallet/voucher) dalam satu `$transaction` ringkas (`crud/orders.ts`, `handlers/checkout.ts`, `storefront/checkout.ts`) — penting untuk single-writer.
- **Lookup panas ber-index/unique:** orderCode, paymentRef, txid, voucher code, user fields (lihat Phase 6).

## Frontend ✅
- Gambar lazy + async; hero prioritas tinggi. Server-rendered → tak ada re-render SPA. JS minim (HTMX + skrip inline `home.njk`). Tidak ada isu berat.

## 3 bottleneck teratas
1. **P5-01** `searchCatalogEntries` tanpa `take` (paling mudah diperbaiki).
2. **P5-02** scan katalog penuh untuk grid (mitigasi: cache saat tumbuh).
3. **Single-writer SQLite** (lihat Phase 11) — batas struktural pada beban tulis tinggi.

> Read-only — tidak ada perubahan kode.
