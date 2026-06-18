# Phase 7 — Architecture Audit

> **Read-only — jangan ubah kode.**

---

## Konteks Proyek
Layering: **route/handler tipis → crud per-domain (`packages/db/src/crud/*`) → Prisma → SQLite.**
Aturan: tak ada SQL mentah di route. Storefront shaping kartu: `apps/storefront/src/cards.ts`
(`shapeEntries`). Kandidat god-file (LOC tinggi, verifikasi ulang):
- `apps/order-bot/src/conversations/admin.ts` ~934
- `apps/order-bot/src/handlers/checkout.ts` ~809
- `packages/db/src/crud/orders.ts` ~765
- `apps/order-bot/src/handlers/customer.ts` ~748
- `apps/order-bot/src/handlers/admin.ts` ~651
- `apps/web-admin/src/routes/catalog.ts` ~584

---

## Objective
Menilai kualitas struktur: pemisahan tanggung jawab, kohesi, kopling.

## Langkah Investigasi
1. **God-file:** `find apps packages -name "*.ts" -not -name "*.test.ts" -not -path "*/node_modules/*" | xargs wc -l | sort -rn | head -20`. Untuk tiap file >500 loc, nilai apakah ia mengerjakan banyak tanggung jawab.
2. **Duplicate logic:** bandingkan helper sejenis — contoh nyata: `card()` di `apps/storefront/src/routes/catalog.ts` vs cabang produk `shapeEntries` di `cards.ts`. Cari pola serupa lain.
3. **Pelanggaran layering:** `grep -rn "prisma\.\|\$transaction\|findMany\|findUnique" apps/web-admin/src/routes apps/storefront/src/routes apps/order-bot/src/handlers --include=*.ts` → query DB langsung di route/handler (harusnya via crud).
4. **Circular dependency / tight coupling:** modul yang saling impor; handler yang tahu detail internal modul lain.
5. **Konsistensi pola:** apakah route baru mengikuti pola crud + preHandler yang sama.

## Yang dicari
- **Code smell:** god class/function, duplicate logic, circular dep, tight coupling, parameter list panjang.
- **Separation of concern:** logika bisnis bocor ke route/handler/template.

## Output → tulis ke `audit/reports/phase-07-architecture.md`
**Refactor priority** (urut ROI = dampak maintainability ÷ effort):
```
ID | Smell | File:line (rentang) | Mengapa bermasalah | Saran refactor | Effort (S/M/L) | ROI
```

## Constraint
**Jangan mengubah kode.**
