# Audit Folder — Post-Development Audit (per-fase, detail)

Pecahan dari `postdev.md` menjadi **satu playbook prompt per fase**, siap dijalankan
terpisah (mis. satu sesi agent per file). Jalankan berurutan `phase-00` → `phase-14`,
lalu `phase-16` (deep-dive bot), lalu `phase-15` (sintesis akhir).

Tiap file kini **detail & self-contained**, berisi:
- **Konteks Proyek** ringkas (agar bisa di-run standalone tanpa membaca repo lebih dulu).
- **Objective**.
- **Langkah Investigasi** — perintah grep / file:baris konkret yang perlu diperiksa.
- **Checklist / yang dicari** spesifik repo ini.
- **Severity rubric** (untuk fase keamanan/temuan).
- **Template Output** terstruktur → ditulis ke `audit/reports/<nama-fase>.md`.
- **Constraint** (umumnya read-only — jangan ubah kode).

## Cara pakai
1. Buat folder hasil: `audit/reports/` (otomatis bila agent menulis ke sana).
2. Buka satu file fase → berikan isinya sebagai prompt ke agent (atau kerjakan manual).
3. Agent menjalankan langkah investigasi & menulis laporan ke `audit/reports/<fase>.md`.
4. Fase analisis **read-only**. **Phase 15** merangkum semua laporan jadi skor akhir.

## Daftar fase
| # | File | Fokus |
|---|---|---|
| 0 | `phase-00-project-understanding.md` | Pahami sistem (no perubahan) |
| 1 | `phase-01-security.md` | OWASP Top 10 + `pnpm audit` |
| 2 | `phase-02-functional.md` | Semua flow & edge case + vitest |
| 3 | `phase-03-ui.md` | Konsistensi UI (checklist + manual) |
| 4 | `phase-04-ux.md` | Kemudahan flow + rekomendasi |
| 5 | `phase-05-performance.md` | FE/BE/DB bottleneck |
| 6 | `phase-06-database.md` | Index, relasi, migrasi aman |
| 7 | `phase-07-architecture.md` | Code smell, layering, ROI refactor |
| 8 | `phase-08-dead-code.md` | Kode/aset/dep tak terpakai |
| 9 | `phase-09-error-handling.md` | catch kosong, retry, leak |
| 10 | `phase-10-logging-monitoring.md` | Log, audit, health, blind spot |
| 11 | `phase-11-scalability.md` | Asumsi user ×100 |
| 12 | `phase-12-configuration.md` | env & setup wizard |
| 13 | `phase-13-devops.md` | Docker, CI/CD, TLS, backup |
| 14 | `phase-14-documentation.md` | README & docs gap |
| 16 | `phase-16-bot-audit.md` | Deep-dive bot grammY (middleware, conversation, callback, jobs, poller) |
| 15 | `phase-15-production-readiness.md` | Laporan akhir + skor + Go/No-Go (rangkum 0–14 + 16) |

## Catatan
- Tiap playbook memuat **petunjuk awal** (dugaan dari scan repo) yang **wajib diverifikasi**, bukan ditelan mentah.
- Contoh hasil audit sekali-jalan (referensi format laporan) ada di `docs/POST-DEV-AUDIT-2026-06-18.md`.
