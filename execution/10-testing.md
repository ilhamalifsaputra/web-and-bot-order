# 10 — Testing

## ROLE
QA Automation Engineer.

## OBJECTIVE
Tutup celah test & edge case yang teridentifikasi audit; jaga suite tetap deterministik & hijau.

## GLOBAL RULES
- Test verifikasi perilaku nyata (bukan mock berlebih). Deterministik, tidak flaky. Tak ubah kode produksi kecuali bug nyata.

## INPUT (issue audit)
- **F-01** route-level `searchCatalogEntries` (`/search`) — query parsial & grup-by-name.
- **F-02** Voucher boundary — over-limit `used_count`, kadaluarsa tepat di batas.
- **F-03** Wallet balance negatif — adjust saldo manual admin (`allowNegative`).
- **F-04** Webhook mode — `webhookCallback` path (kini polling yang banyak diuji).
- **L-9** Verifikasi `logAdminAction` tiap route mutasi (audit coverage).

## ANALYSIS (cari)
- Baseline: `npx vitest run` (±518 hijau, 42 file). Pemetaan perilaku terjamin dari nama test.
- Area tipis: route storefront `/search`, voucher boundary, wallet negatif, webhook, audit coverage.

## IMPLEMENTATION STRATEGY
1. Jalankan suite; petakan cakupan per domain.
2. Tulis test untuk tiap gap (F-01..F-04, L-9) memakai pola yang ada (`app.inject`, `makeTestDb`).
3. Pastikan deterministik & hijau; tak menaikkan flakiness.

## WRITING PLAN
- **Test baru:**
  - `apps/storefront/test/storefront.test.ts` → F-01: `/search?q=` parsial & cocok nama grup (kolaps ke `/g/:id`).
  - `packages/db/src/crud/vouchers.test.ts` (atau yang relevan) → F-02 boundary.
  - `packages/db/src/crud/users.test.ts`/wallet → F-03 saldo negatif (`allowNegative`).
  - `apps/order-bot/test/*` atau `apps/server` → F-04 `webhookCallback` (mode webhook).
  - `apps/web-admin/test/web.test.ts` → L-9: assert `logAdminAction` terpanggil pada route mutasi kunci (upload/branding/toggle).
- **Docs:** test matrix (fitur × jenis test × status).

## EXECUTION PLAN (siap jalan)
1. `git checkout -b test/audit-gaps`
2. `npx vitest run` → catat baseline.
3. Tulis test per gap (TDD: pastikan gagal bila perilaku tak ada, lalu hijau).
4. `pnpm -r typecheck && npx vitest run` → semua hijau, jumlah test naik, tak flaky (jalankan 2× untuk pastikan determinisme).
5. Update test matrix.

## OUTPUT
- **Test matrix:** baris = fitur/flow (register, login, 2FA, katalog, search, denominasi, checkout Bybit/QRIS, voucher, wallet, webhook, audit) × kolom = unit/route/edge × status (ada/tambah). Plus daftar test baru F-01..F-04, L-9.

## CONSTRAINT
Jangan ubah kode produksi kecuali test menyingkap bug nyata (laporkan terpisah). Hasilkan test matrix + rencana test.
