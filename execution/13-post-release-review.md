# 13 — Post-Release Review

## ROLE
Release Manager.

## OBJECTIVE
Checklist rilis end-to-end: smoke test, rollback, post-deployment, monitoring, incident — agar rilis aman & terkendali.

## GLOBAL RULES
- Verifikasi nyata (bukan asumsi). Setiap langkah punya kriteria pass/fail. Reversible.

## INPUT
Semua issue Sprint 1 (H-1..H-4) + DoD rilis dari `audit/reports/phase-15-production-readiness.md`
(H-1, H-2, H-3, H-4, M-5, M-9).

## ANALYSIS (cari)
- Surface kritis: web-admin, storefront, bot (polling/webhook), notifier, jobs/poller.
- Titik gagal pasca-rilis: TLS/proxy (502), DB lock (single-writer), poller pembayaran, outbox.

## IMPLEMENTATION STRATEGY
1. Pre-flight (DoD rilis terpenuhi).
2. Deploy → smoke test → monitoring window.
3. Bila gagal → rollback. Dokumentasikan insiden.

## WRITING PLAN
- **Dokumen baru:** `execution/RELEASE-CHECKLIST.md` (atau output sesi) memuat 5 checklist di OUTPUT.
- Tautkan ke artefak file 02 (nginx/backup/502 runbook) & file 11 (monitoring/log).

## EXECUTION PLAN (siap jalan)
1. **Pre-flight:** verifikasi DoD rilis (H-1..H-4, M-5, M-9) hijau; CI hijau; backup terbaru ada & restore teruji.
2. **Deploy:** `git pull` → build → restart (Docker `compose build && up -d` / pm2 restart) sesuai file 02; tanpa `prisma db push` bila tak ada schema change.
3. **Smoke test** (lihat OUTPUT) — semua pass.
4. **Monitoring window** 30–60 mnt: access log, error rate, healthcheck, poller log, outbox FAILED.
5. **Bila fail:** jalankan rollback checklist.

## OUTPUT (checklist konkret)
### Smoke test
- [ ] `/healthz` (storefront) & `/login` (web-admin) 200.
- [ ] Home tampil grup denominasi; `/c/:id`, `/g/:id`, `/p/:id` OK.
- [ ] `/search?q=...` OK (kolaps grup).
- [ ] Login admin + 2FA OK; satu aksi mutasi + audit tercatat.
- [ ] Bot `/start` → Produk → Denominasi → Checkout (sandbox) OK.
- [ ] TLS valid (https, no mixed content); cookie `Secure` terset.
### Rollback
- [ ] Revert ke commit/tag sebelumnya (atau `compose` image lama).
- [ ] Restore DB dari backup terakhir (file 06) bila perlu.
- [ ] Revert nginx (file 02) bila TLS/proxy bermasalah.
- [ ] Verifikasi smoke test pasca-rollback.
### Post-deployment
- [ ] Versi/commit ter-deploy tercatat; CHANGELOG diperbarui.
- [ ] `USE_UNIQUE_CENTS=1` aktif; warning boot pembayaran hilang.
- [ ] Backup pasca-rilis berjalan.
### Monitoring
- [ ] Access log mengalir; error rate normal (window 30–60 mnt).
- [ ] Poller pembayaran "active"/healthy; watchdog tak alert.
- [ ] `notification_outbox` tak menumpuk FAILED.
- [ ] CPU/mem/DB lock dalam batas.
### Incident
- [ ] Severity & owner ditetapkan; `ref` error dikumpulkan.
- [ ] Mitigasi (rollback/hotfix) + komunikasi.
- [ ] Post-mortem + action item masuk backlog.

