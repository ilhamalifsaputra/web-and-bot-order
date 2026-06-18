# Phase 2 — Functional Audit

> Read-only. Boleh menjalankan test suite (tidak mengubah kode).

---

## Konteks Proyek
order-bot (grammY), web-admin & storefront (Fastify+Nunjucks), notifier, server.
packages/core, packages/db (Prisma + crud/*). SQLite tunggal. Test: `npx vitest run`
(±42 file, ±518 test). Pembayaran: Bybit deposit (USDT) & Binance internal; QRIS.
Stok berbasis `stockItem` (status AVAILABLE/RESERVED/...). Voucher, bulk pricing, referral.

---

## Objective
Memastikan semua fitur berjalan benar, termasuk edge case & konkurensi.

## Langkah Investigasi
1. `npx vitest run` — catat total lulus/gagal; baca **nama** test untuk memetakan perilaku yang sudah terjamin.
2. Untuk tiap flow di bawah, telusuri route/handler + crud terkait, lalu cari celah yang **belum** tertutup test.

## Flow yang harus ditelusuri
| Flow | Lokasi utama |
|---|---|
| Register / Login / Logout | `apps/storefront/src/routes/auth.ts`, `web-admin/src/routes/auth.ts` |
| 2FA enable/verify/disable | `apps/web-admin/src/auth.ts`, `routes/settings.ts` |
| CRUD katalog (kategori/produk/denominasi) | `apps/web-admin/src/routes/catalog.ts`, `packages/db/src/crud/catalog.ts` |
| Search / Filter / Pagination | storefront `routes/catalog.ts` `/search`; admin `routes/orders.ts` (paginasi) |
| Upload / Download (gambar, QR) | `web-admin/src/lib/upload.ts`, penyajian `/uploads/` |
| Notification / Email | `notification_outbox`, notifier; reset mail `storefront/src/routes/forgot.ts` |
| Payment (Bybit/USDT, QRIS) | `order-bot/src/payments/*`, storefront `routes/checkout.ts` |
| Webhook / jobs | `order-bot/src/jobs/index.ts`, `apps/server/src/index.ts` (webhook register) |
| Bot integration | `order-bot` browse → denominasi → checkout |

## Yang dicari (edge case)
- **Null / kosong**: input kosong, produk tanpa stok, kategori tanpa produk, harga 0.
- **Double submit**: checkout/bayar ditekan 2x → order ganda? (cek idempotensi).
- **Race condition**: 2 pembeli rebut 1 stok terakhir → cek tak ada RESERVED bocor / oversell. (Petunjuk: ada test "out-of-stock request throws and leaks no RESERVED rows".)
- **Invalid state transition**: order PAID→PAID, refund order belum bayar, dll.
- **Boundary**: qty negatif/sangat besar, voucher kadaluarsa/over-limit, bulk pricing batas qty.

## Output → tulis ke `audit/reports/phase-02-functional.md`
Bug list:
```
ID | Severity | Flow | File:line | Langkah reproduksi | Ekspektasi vs aktual | Saran
```
Plus: daftar area dengan cakupan test lemah (rekomendasi test tambahan).
