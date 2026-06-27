# Fase 3 — Bersih-bersih & finalisasi (Planning Document)

> **Altitude:** Dokumen perencanaan tingkat-tinggi. Plan eksekusi rinci ditulis
> setelah Fase 2 cutover sukses (kedua web sudah Next.js di Postgres).

**Goal:** Menghapus seluruh sisa stack lama (Nunjucks/Fastify/HTMX, composition-root
satu-proses) yang sudah tak terpakai, dan memfinalkan deploy/dokumentasi, tanpa
mengubah perilaku yang sudah berjalan.

**Prasyarat:** Fase 1 & 2 cutover sukses dan stabil di produksi (admin & storefront
Next.js melayani semua trafik; tidak ada route Nunjucks yang masih dirujuk).

## Global Constraints

- **Hapus hanya yang sudah terbukti tak terpakai** — verifikasi via grep/referensi sebelum delete; jangan hapus `packages/core` atau `packages/db/crud/*`.
- `pnpm typecheck` + `pnpm test` wajib tetap hijau setiap langkah.
- Jangan mengubah perilaku produksi; ini murni penghapusan + dokumentasi.

## Yang dihapus / diubah

| Item | Aksi | Catatan |
|---|---|---|
| `apps/web-admin` Nunjucks/Fastify lama | Hapus (sudah diganti Next di Fase 1) | pastikan tak ada import tersisa |
| `apps/storefront` Nunjucks/Fastify lama | Hapus (Fase 2) | — |
| `packages/web-ui` (tema Nunjucks `_theme`/`_macros`) | Hapus | digantikan `packages/ui` |
| `apps/server` (composition-root satu-proses) | Hapus/ubah peran | proses kini terpisah (admin/storefront/bot/notifier) di Compose |
| Dependency Fastify/Nunjucks/HTMX/@fastify/* | Uninstall dari workspace | bersihkan lockfile |
| Tailwind via CDN | Hapus | sudah pakai build Tailwind di Next/`packages/ui` |
| `prisma/migrations-sqlite-archive` | Pertahankan sbg arsip atau hapus | keputusan ops |
| `scripts/migrate-sqlite-to-postgres.*` | Pertahankan (riwayat) atau pindah `scripts/archive` | one-shot selesai |

## Urutan task (altitude tinggi)

1. **Audit referensi**: grep seluruh repo untuk import `@app/web-ui`, `fastify`,
   `nunjucks`, `htmx`, `@app/server`, `reply.view`, `.njk`. Daftar nol-referensi =
   aman dihapus.
2. **Hapus app/paket lama** satu per satu; setelah tiap penghapusan jalankan
   `pnpm typecheck` + `pnpm test` + boot tiap service.
3. **Bersihkan dependency** (pnpm remove) + regenerasi lockfile; pastikan build image masih sukses.
4. **Finalisasi Docker Compose + Caddy**: hapus service lama, kunci topologi final
   (postgres, web-admin, storefront, bot, notifier, caddy), TLS + health semua hijau.
5. **Dokumentasi**: perbarui `DOCS.md` (arsitektur baru), `README.md`/`RUN.md`
   (install VPS dengan Docker Compose + Postgres), `CLAUDE.md` (hapus aturan
   Fastify/Nunjucks/single-writer SQLite; tambah aturan Next/Auth.js/Postgres),
   tabel sumber-konfigurasi (M-7) disesuaikan.
6. **Verifikasi akhir**: full E2E admin + storefront, `pnpm typecheck` + `pnpm test`
   hijau, backup `pg_dump` terjadwal jalan, smoke seluruh service di Compose.

## Risiko

- Penghapusan terlalu dini bila masih ada referensi tersembunyi → mitigasi: audit grep (task 1) + test hijau per langkah.
- `CLAUDE.md` adalah sumber konvensi — pembaruannya harus akurat agar sesi berikutnya tidak salah arah.
- Lockfile/Docker drift saat uninstall — verifikasi build image setelah cleanup dependency.
