# Phase 10 — Logging & Monitoring

> Read-only.

---

## Konteks Proyek
Logger pino terstruktur. **Audit log** perubahan state admin via `logAdminAction`
(id admin + action + target). Halaman `/outbox` memantau `notification_outbox`
(PENDING/SENT/FAILED + attempts). Health check `/healthz` di web-admin & storefront
(probe `SELECT 1`). Job bot drain outbox/broadcast (`apps/order-bot/src/jobs/index.ts`).

---

## Objective
Pastikan observability cukup untuk mendeteksi & mendiagnosis masalah produksi.

## Langkah Investigasi
1. **Error logs:** sampling `grep -rn "logger.error" apps packages` — konteks cukup? tanpa secret?
2. **Audit logs:** `grep -rn "logAdminAction" apps/web-admin/src` — apakah **setiap** mutasi admin (create/update/delete/toggle/price/role/broadcast) tercatat? Cari route mutasi yang TIDAK memanggilnya.
3. **Access logs:** cek konfig Fastify logger di `apps/server/src/index.ts` / pembuatan app — apakah request di-log (method, path, status, durasi)?
4. **Retry & outbox health:** apakah `notification_outbox` punya status FAILED + attempts + visibilitas (`/outbox`)? Ada job re-drive?
5. **Health check:** `/healthz` benar-benar cek DB? Dipakai oleh `docker-compose.yml` healthcheck?
6. **Alerting:** ada integrasi error-tracking eksternal (Sentry/dll)? (kemungkinan tidak.)

## Yang dicari (blind spots)
- Mutasi penting tanpa audit trail.
- Kegagalan diam (silent failure) tanpa metrik/log.
- Tidak ada cara tahu job macet / outbox menumpuk FAILED.
- Tidak ada alerting proaktif.

## Output → tulis ke `audit/reports/phase-10-logging-monitoring.md`
```
ID | Area (error/audit/access/health/retry/alert) | Temuan/Blind spot | File:line | Rekomendasi | Prioritas
```
