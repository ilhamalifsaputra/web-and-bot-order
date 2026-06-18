# Documentation Roadmap (execution/12)

Status penutupan gap dokumentasi DOC-01..05. Bahasa Indonesia (konsisten README);
akurat & sinkron kode (path/skrip diverifikasi ada).

| ID | Gap | Dokumen × bagian | Status |
|---|---|---|---|
| **DOC-01 / M-7** | Presedensi config env-vs-DB | `DOCS.md §6` — tabel sumber-kebenaran per setting (DB>env, union, env>DB) + catatan multi-proses | ✅ (execution/07) |
| **DOC-02 / M-5** | README §7 "copy satu file" tak WAL-safe | `README.md §7` — ganti `cp` → `deploy/backup/backup.sh` (`.backup`), tautkan `deploy/backup/README.md` | ✅ |
| **DOC-03 / H-2** | Tak ada panduan proxy/TLS + runbook 502 | `README.md §7` ringkas + tautan; isi lengkap di `deploy/README.md` (TLS, checklist, runbook 502, rollback) + `deploy/nginx/telegram-shop.conf` | ✅ (execution/02) |
| **DOC-04** | Arsitektur sinkron fitur denominasi/group-aware | `DOCS.md §1` — prinsip "Group-aware (denominasi)": kartu grup → `/g/:id`, shaper bersama `shapeEntries`, kolaps anggota-tunggal | ✅ |
| **DOC-05** | Nyatakan "tidak ada API publik" | `DOCS.md §1` — prinsip "Server-rendered, TIDAK ada API publik"; satu-satunya non-HTML = webhook internal (`/pay/tokopay/callback`, `/tg/<secret>`) + `/healthz` | ✅ |

## Cross-check (perintah/path diverifikasi nyata)

- `deploy/backup/{backup,restore}.sh`, `deploy/backup/README.md`,
  `deploy/README.md`, `deploy/nginx/telegram-shop.conf` — ada.
- `apps/storefront/src/cards.ts` `shapeEntries` — ada (dipakai home/kategori/search).
- Webhook: `POST /pay/tokopay/callback` (storefront checkout) + `POST /tg/<secret>`
  (server, `BOT_MODE=webhook`) — diverifikasi di kode, path dikoreksi (`/tg/<secret>`,
  bukan `/tg`).

## Dokumen pendukung yang dihasilkan sprint ini

- `deploy/README.md`, `deploy/backup/README.md`, `deploy/nginx/*.conf` (ops).
- `docs/observability.md` (access log, redaksi, audit, retensi — execution/11).
- `docs/refactor-roadmap.md`, `docs/test-matrix.md`,
  `audit/reports/payment-integrity-checklist.md`.
