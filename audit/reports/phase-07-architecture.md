# Laporan Phase 7 — Architecture Audit

Tanggal: 2026-06-18 · Read-only.

## Yang baik ✅
- **Layering konsisten:** route/handler tipis → `crud/*` per-domain (23 domain) → Prisma. Verifikasi: query Prisma langsung di route/handler **terbatas pada pemanggilan `$transaction(tx => crudFn(...))`** (komposisi), bukan query ad-hoc — pola sehat.
- **23 modul crud** terpisah rapi per domain → kohesi tinggi, mudah diuji.
- **Macro UI tersentralisasi** (web-ui `_macros.njk`, storefront `_shop.njk`).

## Refactor priority (ROI)
```
ID | Smell | File:line (rentang) | Masalah | Saran | Effort | ROI
A-01 | God-file | order-bot/conversations/admin.ts (~934) | banyak wizard admin dalam 1 file | pecah per-domain wizard (stok/produk/saldo/broadcast) | L | Sedang
A-02 | God-file | order-bot/handlers/checkout.ts (~809) | alur checkout + banyak metode bayar | ekstrak per-metode pembayaran | M | Sedang-Tinggi
A-03 | God-file | crud/orders.ts (~765) | banyak query order + creation | pisah read vs write/creation | M | Sedang
A-04 | Duplicate | storefront/routes/catalog.ts (card()) vs cards.ts (shapeEntries cabang produk) | logika shaping kartu produk dobel | satukan ke shapeEntries saat /c/:id direvisi | S | Sedang
A-05 | God-file | order-bot/handlers/customer.ts (~748), handlers/admin.ts (~651), web-admin/routes/catalog.ts (~584) | besar tapi kohesif | pantau; pecah bila tumbuh | M | Rendah |
```

## Catatan
- Tidak ada circular dependency atau pelanggaran layering mencolok yang terdeteksi.
- God-file adalah **technical debt maintainability**, bukan bug. Prioritaskan A-02 (checkout) & A-04 (duplikasi murah).

> Read-only — tidak ada perubahan kode.
