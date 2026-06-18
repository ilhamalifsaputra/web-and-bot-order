# 02 — DevOps / Infra Fix

## ROLE
Senior SRE Engineer.

## OBJECTIVE
Jalur rilis publik aman & terdiagnosa: reverse proxy + TLS + access log (H-2), backup/restore
SQLite WAL (M-5), koordinasi entrypoint container (M-8).

## GLOBAL RULES
- Minimal & reversible; rollback plan wajib. Jangan ubah perilaku app tanpa alasan. Dokumentasikan.

## INPUT (issue audit)
- **H-2** — Belum ada reverse proxy + TLS + access log; 502 sulit didiagnosa. (DO-02/SEC-03/L-01/DOC-03)
- **M-5** — Backup SQLite saat WAL bisa inkonsisten. (DO-05/DOC-02)
- **M-8** — `Dockerfile:67` CMD hanya `order-bot start`; pastikan compose menjalankan semua surface / `apps/server`. (DO-04)

## ANALYSIS (cari)
- nginx: terminasi TLS, header `X-Forwarded-Proto/For` → `trustProxy` + `WEB_COOKIE_SECURE=true`; app tetap bind `127.0.0.1`.
- access log: `logger:false` (`apps/web-admin/src/server.ts:51`, `apps/storefront/src/server.ts:36`) → tak ada jejak request (koordinasi file 11).
- backup WAL: `journal_mode=WAL` (`packages/db/src/client.ts:32`) → copy mentah berisiko; pakai `sqlite3 .backup`.
- M-8: cek `docker-compose.yml` service/port (`WEB_PORT`/`STOREFRONT_PORT`) benar menjalankan web+toko+bot+notifier.

## IMPLEMENTATION STRATEGY
1. Petakan topologi (proxy → app 127.0.0.1; subdomain admin/toko).
2. Susun konfig nginx (artefak ops, bukan kode app).
3. Rencana aktivasi access log (file 11).
4. Rancang backup `.backup` + jadwal + uji restore di staging.
5. Verifikasi entrypoint/compose (M-8). Buat rollback tiap langkah.

## WRITING PLAN
- **Artefak baru (ops, bukan kode app):** `deploy/nginx/<domain>.conf` (TLS, proxy_pass, header, timeout); `deploy/backup/backup.sh` + `restore.sh`; entri cron.
- **Verifikasi config app:** `WEB_COOKIE_SECURE`, `trustProxy` (cek apakah perlu diaktifkan via env/opsi Fastify — koordinasi minimal, lihat file 11 untuk logger).
- **Docs:** `deploy/README.md` (langkah TLS, backup/restore, 502 runbook). Koordinasi dgn file 12.

## EXECUTION PLAN (siap jalan)
1. Staging: siapkan VM/host uji.
2. nginx: tulis server block (443 TLS + redirect 80→443), `proxy_set_header X-Forwarded-Proto $scheme`, `proxy_pass http://127.0.0.1:${WEB_PORT}`; reload `nginx -t && systemctl reload nginx`.
3. Set `WEB_COOKIE_SECURE=true` di env prod; pastikan Fastify `trustProxy` aktif (koordinasi file 11 untuk logger Fastify).
4. Backup: `sqlite3 data/bot.db ".backup '/backup/bot-$(date +%F).db'"`; jadwalkan cron; uji `restore.sh` → `PRAGMA integrity_check` → smoke test app.
5. M-8: `docker compose config` cek service; pastikan semua surface up (`docker compose ps` + healthcheck hijau).
6. Uji 502 runbook end-to-end (matikan upstream → cek log/diagnosa → pulihkan).

## OUTPUT
- **Deployment checklist:** TLS aktif; cookie secure; trustProxy; access log mengalir; `/healthz`+`/login` hijau; semua surface up.
- **Rollback plan:** revert nginx; matikan TLS redirect; restore DB; verifikasi pasca-rollback.
- **502 runbook.**

## CONSTRAINT
Jangan mengubah kode app. Hasilkan deployment checklist + rollback plan + runbook.
