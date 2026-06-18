# 09 — Incremental Refactor (Technical Debt)

## ROLE
Software Architect.

## OBJECTIVE
Roadmap refactor **bertahap & aman** untuk technical debt (god-file, duplikasi, SRP) tanpa refactor besar.

## GLOBAL RULES
- **Jangan refactor besar.** Perubahan kecil, perilaku identik, test sebagai jaring. Satu unit per PR.

## INPUT (issue audit — technical debt)
- **A-01** `apps/order-bot/src/conversations/admin.ts` (~934)
- **A-02** `apps/order-bot/src/handlers/checkout.ts` (~809)
- **A-03** `packages/db/src/crud/orders.ts` (~765)
- **A-04** Duplikasi `apps/storefront/src/routes/catalog.ts` `card()` vs `cards.ts` `shapeEntries`
- **A-05** `handlers/customer.ts` (~748), `handlers/admin.ts` (~651), `web-admin/routes/catalog.ts` (~584)

## ANALYSIS (cari)
- God-file: tanggung jawab majemuk dalam satu file (banyak wizard/metode). SRP violation.
- Duplicate logic: A-04 shaping kartu produk dobel.
- Risiko: refactor bot beresiko regресi UX (CLAUDE.md kontrak) → wajib test + perilaku identik.

## IMPLEMENTATION STRATEGY (strangler kecil)
1. Mulai dari ROI tertinggi & risiko terendah: **A-04** (duplikasi murah, setelah file 05 menyentuh `crud/catalog.ts`).
2. God-file: ekstrak unit kohesif (mis. per-metode pembayaran di checkout) satu per satu, perilaku identik, test tetap hijau.
3. Tiap langkah PR kecil + review; jangan gabung banyak ekstraksi.

## WRITING PLAN
- **A-04:** satukan shaping produk ke `shapeEntries` (`apps/storefront/src/cards.ts`); ganti `card()` di `routes/catalog.ts` `/c/:id` agar pakai `shapeEntries`. Test: `apps/storefront/test/storefront.test.ts` (kategori render tetap sama).
- **A-02 (checkout):** ekstrak handler per-metode (bybit/qris/binance) ke modul terpisah `apps/order-bot/src/handlers/checkout/*` tanpa ubah alur; re-export. Test: `apps/order-bot/test/*` checkout.
- **A-01/A-03/A-05:** rencana ekstraksi bertahap (daftar unit + urutan), **bukan** dilakukan sekaligus.
- **Docs:** roadmap + urutan PR + kriteria "perilaku identik".

## EXECUTION PLAN (siap jalan, per unit)
1. Pilih satu unit (mulai A-04). `git checkout -b refactor/a04-card-shapeentries`.
2. Tulis/identifikasi test karakterisasi yang mengunci perilaku saat ini (snapshot output kartu).
3. Lakukan ekstraksi/penyatuan minimal; jaga signature publik.
4. `pnpm -r typecheck && npx vitest run` → hijau & output identik.
5. Review + merge. Ulangi untuk unit berikut (A-02, lalu rencana A-01/03/05) — **satu PR per unit**.

## OUTPUT
- **Incremental refactor roadmap:** daftar unit, urutan (ROI↑/risiko↓), per unit: file, ekstraksi, test jaring, DoD "perilaku identik". A-04 & A-02 prioritas; A-01/03/05 dijadwal.

## CONSTRAINT
Jangan refactor besar / sekaligus. Hasilkan roadmap + rencana per-unit yang aman.
