# Phase 14 — Documentation Audit

> Read-only.

---

## Konteks Proyek
Dokumen: `README.md` (Bahasa Indonesia — Sebelum Mulai, `.env`, Docker, non-Docker,
Buat Admin Pertama, Pembayaran & Branding, Update/Backup/Perawatan, Masalah Umum,
Untuk Developer), `CLAUDE.md` (konvensi), `DOCS.md`, folder `docs/` (+ `docs/superpowers/`).

---

## Objective
Temukan gap dokumentasi yang menghambat operator/developer baru.

## Langkah Investigasi
1. Baca `README.md` (`grep -nE "^#{1,3} " README.md` untuk peta bagian) & `DOCS.md`.
2. Cek keberadaan & kualitas:
   - **Setup guide** (langkah dari nol sampai jalan).
   - **Environment variables** — terdokumentasi & **sinkron** dengan `packages/core/src/config.ts` (bandingkan; tandai env tak terdokumentasi).
   - **Deployment guide** (Docker & non-Docker; reverse proxy/TLS).
   - **Architecture overview** (diagram/penjelasan layer; mungkin tipis).
   - **API documentation** (jika relevan — app server-rendered, mungkin N/A; nyatakan).
   - **Backup guide** (langkah backup/restore `data/bot.db` + WAL; jadwal).
3. Cek dokumen usang vs kode (mis. perintah/skrip yang sudah berubah).

## Output → tulis ke `audit/reports/phase-14-documentation.md`
**Documentation gap**:
```
ID | Dokumen | Bagian hilang/usang | Dampak (siapa terhambat) | Saran isi | Prioritas
```
