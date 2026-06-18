# 12 — Documentation

## ROLE
Technical Writer.

## OBJECTIVE
Tutup gap dokumentasi yang menghambat operator/developer: config precedence, backup WAL, deployment/TLS, arsitektur.

## GLOBAL RULES
- Akurat & sinkron dengan kode. Jangan ubah kode. Bahasa Indonesia (konsisten README).

## INPUT (issue audit)
- **DOC-01/M-7** — Presedensi config env-vs-DB tak dijelaskan.
- **DOC-02/M-5** — Backup README §7 menyebut "satu file"; perlu metode WAL aman.
- **DOC-03/H-2** — Tak ada panduan reverse proxy/TLS + runbook 502.
- **DOC-04** — Architecture overview cek sinkron dgn fitur denominasi/group-aware terbaru.
- **DOC-05** — Nyatakan eksplisit "tidak ada API publik" (server-rendered).

## ANALYSIS (cari)
- Bandingkan README/DOCS dengan kondisi kode terkini (config.ts, client.ts WAL, server-rendered, denominasi).
- Gap paling berdampak: DOC-03 (TLS/502) & DOC-02 (backup WAL).

## IMPLEMENTATION STRATEGY
1. Inventaris bagian dokumen vs kebutuhan operator/dev.
2. Tulis bagian yang hilang; koreksi yang usang.
3. Tautkan ke artefak ops (file 02/06) & config (file 07).

## WRITING PLAN
- **README.md:** §7 backup → metode `.backup` + restore teruji (DOC-02); tambah bagian "Reverse proxy & TLS" + "Runbook 502" (DOC-03, tautkan `deploy/`).
- **DOCS.md:** tabel "Sumber Kebenaran per Setting" (DOC-01, dari file 07); perbarui Architecture overview (DOC-04: denominasi/group-aware); catatan "tidak ada API publik" (DOC-05).
- **deploy/README.md:** rujuk dari README (artefak dari file 02/06).

## EXECUTION PLAN (siap jalan)
1. `git checkout -b docs/audit-gaps`
2. Update README §7 (backup/restore WAL) + bagian TLS/proxy + runbook 502.
3. Update DOCS.md (tabel presedensi config, arsitektur terkini, no-public-API).
4. Cross-check: perintah/skrip yang disebut benar-benar ada (`pnpm`, `sqlite3 .backup`, path `deploy/`).
5. Review keterbacaan; pastikan sinkron dgn file 02/06/07.

## OUTPUT
- **Documentation roadmap:** daftar dokumen × bagian baru/diperbaiki × prioritas × status, plus draf isi untuk DOC-01..05.

