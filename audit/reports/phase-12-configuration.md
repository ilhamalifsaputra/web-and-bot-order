# Laporan Phase 12 — Configuration Audit

Tanggal: 2026-06-18 · Read-only.

## Yang baik ✅
- **Validasi env via zod** (`packages/core/src/config.ts`, ~209 baris): tipe, default, transform; **gagal cepat** bila env salah → onboarding aman.
- **DB sebagai sumber kebenaran runtime** (token bot, admin id via tabel `Setting`) → perubahan di web-admin dihormati lintas proses (plan `singletruth`).
- **Setup wizard** bertahap: `/setup/bot` → `/setup/owner` → `/setup/shop` → `/setup/restart`.

## Temuan
```
ID | Kategori | File:line | Temuan | Rekomendasi | Prioritas
C12-01 | wizard-desync | web-admin/routes/setup.ts:174 (/setup/restart) | "restart" mengandalkan proses dimulai ulang oleh orchestrator (pm2/docker) — verifikasi UI menjelaskan bahwa beberapa perubahan (mis. token) baru aktif setelah proses benar-benar restart | pastikan pesan UI eksplisit "perlu restart proses"; bila in-process reload didukung, sinkronkan | Low
C12-02 | dualitas-config | config.ts (env) + Setting (DB) | sebagian identitas ada di env DAN DB (mis. BOT_TOKEN env vs setting) — potensi bingung "mana yang menang" | dokumentasikan presedensi (DB > env atau sebaliknya) di README/DOCS | Low
C12-03 | hardcoded | (spot-check) | default `127.0.0.1`/port via env dengan default — wajar; tak ditemukan secret hardcoded | — | Info
```

## Verifikasi env terpakai
Spot-check menunjukkan env kunci dipakai (`REFERRAL_COMMISSION_PERCENT`, `PUBLIC_CHANNEL_ID` ×9, `SUPPORT_GROUP_ID`, `LOW_STOCK_THRESHOLD` ×8). Untuk audit penuh "unused env", jalankan loop grep semua key `config.*` vs pemakaian (lihat playbook Phase 12 langkah 1).

## Catatan
Konfigurasi tergolong matang. Isu utama = **kejelasan presedensi env-vs-DB** dan **ekspektasi restart** — keduanya dokumentasi, bukan bug.

> Read-only — tidak ada perubahan kode.
