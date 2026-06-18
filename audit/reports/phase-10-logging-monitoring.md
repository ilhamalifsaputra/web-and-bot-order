# Laporan Phase 10 — Logging & Monitoring

Tanggal: 2026-06-18 · Read-only.

## Yang baik ✅
- **Logger terstruktur** pino (`packages/core/logger`).
- **Audit trail** kuat: `logAdminAction` dipakai luas (~74 referensi di web-admin) vs 66 route mutasi — indikasi cakupan tinggi. Index `AuditLog(createdAt)` untuk query.
- **Outbox observability:** halaman `/outbox` (PENDING/SENT/FAILED + attempts), index `(status,createdAt)`.
- **Health check:** `/healthz` (web-admin & storefront) probe DB `SELECT 1`; dipakai `docker-compose.yml` healthcheck.
- **Watchdog poller** Binance → alert admin bila macet.

## Temuan
```
ID | Area | Temuan/Blind spot | File:line | Rekomendasi | Prioritas
L-01 | access-log | Fastify dibuat `logger: false` di web-admin & storefront → TIDAK ada access log request bawaan (method/path/status/durasi) | web-admin/src/server.ts:51, storefront/src/server.ts:36 | aktifkan logger Fastify (atau hook onResponse ringkas) di prod untuk jejak request & diagnosa 4xx/5xx; pastikan tak log body/secret | Medium
L-02 | audit-coverage | verifikasi setiap route mutasi memang memanggil logAdminAction (rasio 74:66 menjanjikan, tapi cek route upload/branding/toggle) | web-admin/src/routes/* | audit manual singkat per route mutasi | Low
L-03 | alerting | tak ada error-tracking eksternal (Sentry/dll); blind spot pada error tak-fatal yang hanya masuk log | — | opsional saat trafik naik | Low
```

## Catatan
Blind spot utama = **L-01 (tanpa access log)**: saat 502/5xx di produksi (mis. isu nginx historis), tak ada jejak request internal untuk diagnosa. Mengaktifkan logger Fastify mempercepat investigasi.

> Read-only — tidak ada perubahan kode.
