# Laporan Phase 13 — DevOps Audit

Tanggal: 2026-06-18 · Read-only.

## Yang baik ✅
- **Dockerfile multi-stage** (`builder` node:20-slim → `runtime`), `--frozen-lockfile`, `prisma generate` saat build, user `app` dibuat, `--chown=app:app`.
- **Entrypoint** chown `data/` bind-mount agar fresh clone langsung jalan.
- **docker-compose**: healthcheck web-admin (`/login`) & storefront (`/healthz`), `restart: unless-stopped`, volume `./data:/app/data` (persisten), port via env.
- **Backup** terdokumentasi di README §7 ("semua data di satu file").

## Temuan
```
ID | Area | Temuan | File | Risiko | Rekomendasi | Prioritas
DO-01 | ci | TIDAK ada .github/workflows/ → tak ada CI otomatis (typecheck/test) | — | regresi lolos ke main | tambah workflow: pnpm -r typecheck + npx vitest run pada PR | High
DO-02 | tls/proxy | bind 127.0.0.1 default; ekspos publik perlu nginx+TLS; ada isu 502 historis | compose ports, CLAUDE.md | rilis publik tak aman tanpa proxy/TLS; 502 sulit didiagnosa (lihat L-01) | dok + contoh nginx; set WEB_COOKIE_SECURE=true; aktifkan access log | High
DO-03 | container-user | runtime sengaja tetap root (entrypoint chown lalu jalan) — komentar Dockerfile:61 | Dockerfile | proses Node jalan sebagai root dalam container | pertimbangkan `gosu app` setelah chown agar drop privilege | Medium
DO-04 | dockerfile | CMD hanya `order-bot start` (compose nampaknya jalankan service lain terpisah) — pastikan compose mengoordinasi semua app / atau pakai apps/server | Dockerfile:67, docker-compose.yml | salah paham entrypoint → service tak jalan | verifikasi compose menjalankan composition root (apps/server) atau service per-app konsisten | Medium
DO-05 | backup | prosedur backup file SQLite saat WAL aktif | README §7 | copy file mentah saat WAL bisa inkonsisten | gunakan `sqlite3 .backup` atau stop-then-copy; uji restore | Medium
```

## Catatan
Fondasi container baik. Gap terpenting: **DO-01 (tanpa CI)** & **DO-02 (TLS/proxy + access log untuk publik & diagnosa 502)**. DO-05 penting agar backup benar-benar konsisten (WAL).

> Read-only — tidak ada perubahan kode.
