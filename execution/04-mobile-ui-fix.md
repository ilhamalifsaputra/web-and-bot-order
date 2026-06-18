# 04 — Mobile UI Fix

## ROLE
Senior Frontend Engineer.

## OBJECTIVE
Audit visual mobile (H-4) + anti double-submit/loading checkout (M-1).

## GLOBAL RULES
- Minimal patch, zero regression, preserve design system. Reuse macro (`_shop.njk`, `_macros.njk`).
- Progressive enhancement (JS kecil) tanpa merusak no-JS fallback. Dokumentasikan.

## INPUT (issue audit)
- **H-4** — Audit visual mobile belum dilakukan. (Phase 3: U-01..U-05)
- **M-1** — Tombol checkout tak disable/loading → double-submit. (UX-01)

## ANALYSIS (cari)
- Overflow/responsive di 375px: `home.njk` (403), `pay.njk`+`_pay_status.njk` (alamat deposit panjang/QR/countdown), admin `settings.njk` (360), `catalog.njk` (295), `payments.njk` (195).
- M-1: form checkout/pay POST klasik tanpa disable; bot sudah punya anti double-tap (`admin.processing`) — selaraskan.

## IMPLEMENTATION STRATEGY
1. Audit manual 375px & ≥1280px tiap halaman U-01..U-05; catat overflow/misalignment.
2. Perbaikan minimal via util Tailwind (`truncate`, `break-all`, `overflow-x-auto`, `flex-wrap`).
3. M-1: handler submit kecil (disable + spinner + cegah ganda).
4. Verifikasi tak ada regresi desktop & no-JS.

## WRITING PLAN
- **File diaudit/diubah:** `apps/storefront/views/{home,pay,_pay_status}.njk`, `apps/web-admin/views/{settings,catalog,payments}.njk` (hanya class util bila perlu).
- **M-1:** tambah skrip kecil di `apps/storefront/views/base.njk` atau partial checkout (`<form data-submit-once>` → JS disable tombol + spinner saat submit).
- **Test:** UI manual (tak ada test runner visual). Tambah catatan hasil ke `audit/reports/phase-03-ui.md` (checklist U-01..U-05 jadi lulus/diperbaiki).

## EXECUTION PLAN (siap jalan)
1. `pnpm --filter @app/storefront dev` (8100) & `pnpm --filter @app/web-admin dev`.
2. Buka tiap halaman U-01..U-05 di DevTools device 375px; screenshot & catat temuan.
3. `git checkout -b fix/h4-mobile-ui`; terapkan perbaikan util class minimal per temuan; cek ulang 375px & desktop.
4. `git checkout -b fix/m1-checkout-loading`; tambah `data-submit-once` + skrip kecil; uji double-click cepat (tak dobel submit) & no-JS (form tetap jalan).
5. `pnpm -r typecheck && npx vitest run` (pastikan render test tak rusak).
6. Update checklist di `audit/reports/phase-03-ui.md`.

## OUTPUT
- **Mobile audit checklist** (per halaman: item, status, perbaikan, file njk) + rencana M-1 (mekanisme + titik pasang + uji double-click).

## CONSTRAINT
Jangan langsung mengubah template/CSS. Hasilkan mobile audit checklist + rencana (WRITING/EXECUTION PLAN sebagai panduan).
