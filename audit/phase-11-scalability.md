# Phase 11 — Scalability Audit

> Read-only. Asumsikan beban **user naik 100×**.

---

## Konteks Proyek
**DB SQLite tunggal (single-writer, WAL)** — batas arsitektural utama; ambang migrasi
Postgres = ≥2 concurrent writer (CLAUDE.md/RUN.md §9). Queue berbasis **tabel DB**
(`notification_outbox`, `broadcasts`) didrain bot/notifier. **Tanpa cache eksternal**
(Redis). Rate-limit bot per-user (`apps/order-bot/src/middleware.ts:62`). Paginasi ada
di order list admin. Proses gabungan via `apps/server` (1 proses).

---

## Objective
Petakan batas skalabilitas saat ini & urutan mitigasinya.

## Langkah Investigasi
1. **Write contention:** identifikasi jalur tulis terpanas (checkout, deduksi stok, order create) — `packages/db/src/crud/orders.ts`, `crud/stock_deduction*`. Berapa banyak writer serempak yang mungkin?
2. **Cache:** apakah render katalog/Home query DB tiap request? (kandidat cache read).
3. **Queue:** beban broadcast/notifikasi pada ×100 — tabel DB cukup? (`jobs/index.ts` interval & batch).
4. **Pagination:** `grep -rn "findMany" apps --include=*.ts | grep -v test` → list yang belum paginasi & bisa membesar (produk, user, audit log).
5. **Memory:** data dimuat penuh ke memori sebelum dipotong (mis. `searchCatalogEntries`).
6. **Single-process:** semua app dalam 1 proses Node — titik kegagalan tunggal & batas CPU.

## Output → tulis ke `audit/reports/phase-11-scalability.md`
**Current scaling limitation** (urut dampak) + roadmap mitigasi dengan **pemicu**:
```
Batas | Komponen/File | Gejala saat ×100 | Mitigasi (Postgres / Redis cache / queue broker / paginasi / split proses) | Pemicu kapan dikerjakan
```
