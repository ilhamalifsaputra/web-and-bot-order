# Phase 6 — Database Audit

> Read-only. **Jangan jalankan migrasi / ubah schema.**

---

## Konteks Proyek
Prisma 5.x atas **SQLite tunggal** `data/bot.db`. `prisma/schema.prisma` (24 model,
~28 `@@index`, FK aktif). `packages/db/src/client.ts`: PRAGMA `foreign_keys=ON`,
`journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`. **Money disimpan Decimal.**
Single-writer: pemicu migrasi Postgres = **≥2 concurrent writer** (CLAUDE.md / RUN.md §9).
Schema change saat deploy: `pnpm prisma db push` + restart **sebelum** kode baru jalan
(kalau tidak → `P2022 column ... does not exist`).

---

## Objective
Menilai kesehatan schema, index, integritas relasi, dan keamanan migrasi.

## Langkah Investigasi
1. **Model & index:** baca `prisma/schema.prisma`; daftar tiap model + `@@index`/`@@unique`.
2. **Missing index:** untuk tiap query crud (`grep -rn "where:\|orderBy:" packages/db/src/crud --include=*.ts`), cek apakah kolom kunci ber-index. Tandai kolom yang sering difilter/diurut tanpa index.
3. **Integritas relasi:** cek perilaku hapus — `grep -n "onDelete\|productGroupId\|deleteMany\|updateMany" prisma/schema.prisma packages/db/src/crud/*.ts`. Contoh sehat: `deleteGroup` melepas member dalam `$transaction` (tak ada orphan).
4. **Duplicate / orphan:** model tanpa `@@unique` pada field yang seharusnya unik (mis. kode order, referralCode, username); FK yang bisa menggantung.
5. **Migrasi aman:** cek penambahan kolom non-null tanpa default (risiko `P2022`); urutan deploy (push sebelum kode).
6. **Tipe money:** pastikan semua kolom uang `Decimal`, bukan `Float`.

## Output → tulis ke `audit/reports/phase-06-database.md`
- **Index recommendations** (kolom → alasan → query yang diuntungkan).
- **Integritas/relasi** temuan.
- **Strategi migrasi aman** (langkah deploy untuk schema change berikutnya).
- Catatan single-writer & ambang Postgres.
```
ID | Kategori (index/relasi/migrasi/tipe) | Model/Field atau File:line | Masalah | Rekomendasi | Prioritas
```

## Constraint
Analisis saja — jangan menjalankan `prisma db push` / mengubah schema.
