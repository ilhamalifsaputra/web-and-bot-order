# 11 — Observability

## ROLE
SRE.

## OBJECTIVE
Tutup blind spot observability: access log request, redaksi log sensitif, cakupan audit, (opsional) error-tracking.

## GLOBAL RULES
- Minimal & aman: jangan log secret/body sensitif. Zero regression. Dokumentasikan.

## INPUT (issue audit)
- **L-01/H-2** — Fastify `logger:false` → tak ada access log (`apps/web-admin/src/server.ts:51`, `apps/storefront/src/server.ts:36`).
- **L-8/B16-02** — `bot.catch` mencatat `text=ctx.message.text.slice(0,120)` (bisa TxID/teks sensitif) — `apps/order-bot/src/main.ts:124`.
- **L-9/L-02** — Verifikasi cakupan `logAdminAction` tiap route mutasi.
- **L-10/L-03** — Tanpa error-tracking eksternal (opsional).

## ANALYSIS (cari)
- Tanpa access log → 502/4xx/5xx sulit didiagnosa (kaitan file 02 H-2).
- Risiko log sensitif: teks pesan user di `bot.catch`.
- Audit coverage: rasio `logAdminAction` (~74) vs route mutasi (~66) menjanjikan; verifikasi per route.

## IMPLEMENTATION STRATEGY
1. Aktifkan access log Fastify (atau hook `onResponse` ringkas: method, path, status, durasi) — **tanpa** body/secret.
2. Redaksi `bot.catch`: hilangkan/redaksi `text` mentah; cukup `callbackData` + `ref`.
3. Audit coverage: pastikan tiap route mutasi panggil `logAdminAction`.
4. (Opsional) integrasi Sentry/dll saat trafik naik.

## WRITING PLAN
- **File diubah:** `apps/web-admin/src/server.ts` & `apps/storefront/src/server.ts` (logger Fastify on / hook onResponse dengan redaksi); `apps/order-bot/src/main.ts:124` (redaksi text).
- **Test:** smoke — pastikan log muncul (level), tak ada secret; test web tetap hijau.
- **Docs:** observability roadmap (apa yang dilog, retensi, korelasi `ref`).

## EXECUTION PLAN (siap jalan)
1. `git checkout -b obs/access-log`
2. Aktifkan logger Fastify (pino, level via `LOG_LEVEL`) atau tambah hook `onResponse` yang mencatat `{method,url,statusCode,responseTime}` (tanpa body). Pastикан redaksi field sensitif.
3. `apps/order-bot/src/main.ts:124` → ganti `text=...slice(0,120)` jadi tanpa text (atau redaksi), pertahankan `ref` + `callbackData`.
4. Verifikasi audit coverage: `grep -rn "app.post\|app.put\|app.delete" apps/web-admin/src/routes` vs `logAdminAction`; tambah pemanggilan yang hilang (bila ada).
5. `pnpm -r typecheck && npx vitest run` hijau; jalankan dev → konfirmasi access log mengalir & tak bocor secret.

## OUTPUT
- **Observability roadmap:** access log (format, redaksi, korelasi ref), audit-coverage gap + perbaikan, opsi error-tracking (kapan & bagaimana), retensi log.

## CONSTRAINT
Jangan log secret/body. Hasilkan observability roadmap (+ patch minimal access-log/redaksi sesuai rencana).
