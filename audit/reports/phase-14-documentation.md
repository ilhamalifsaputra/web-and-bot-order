# Laporan Phase 14 — Documentation Audit

Tanggal: 2026-06-19 (refresh dari laporan 2026-06-18) · **Eksekusi langsung** —
gap di bawah sudah diperbaiki di commit ini (lihat bagian "Perubahan").

## Status temuan sebelumnya (2026-06-18)
| ID | Status | Catatan |
|---|---|---|
| DOC-01 (presedensi env-vs-DB) | ✅ Resolved | DOCS.md §6 sekarang punya tabel "sumber kebenaran" per setting |
| DOC-02 (backup WAL aman) | ✅ Resolved | README §7 sudah mendokumentasikan `deploy/backup/backup.sh` (`sqlite3 .backup`) + `restore.sh` |
| DOC-03 (reverse proxy/TLS + 502) | ✅ Resolved | README §7 menunjuk `deploy/README.md` + `deploy/nginx/telegram-shop.conf` |
| DOC-04 (arsitektur katalog usang) | ⚠️ Masih open, makin parah | Lihat DOC-06 di bawah — rename katalog 3-tier (commit `e567081`..`28fc608`, 2026-06-19) membuat dokumen makin tidak sinkron dari yang ditemukan semula |
| DOC-05 (nyatakan tidak ada API publik) | ✅ Resolved | DOCS.md §1: "Server-rendered, TIDAK ada API publik" |

## Temuan baru (2026-06-19)
```
ID | Dokumen | Bagian hilang/usang | Dampak | Saran | Prioritas
DOC-06 | DOCS.md §1 | Arsitektur masih mendeskripsikan model lama (Product+grup opsional, drill ke /g/:id, shaper shapeEntries) — sudah diganti total oleh rename Category→Product→Denomination | dev baru salah paham model data inti, /g/:id tidak ada lagi | tulis ulang jadi 3-tier Category→Product→Denomination, route /c/:slug & /p/:slug, shaper shapeProducts | High
DOC-07 | DOCS.md §4 | "Product.price / resellerPrice" — field itu sekarang di Denomination, Product (mid-tier) tidak punya kolom harga | dev nulis query/kode ke field yang salah | ganti referensi ke Denomination.price/resellerPrice | High
DOC-08 | DOCS.md §10 | Link ke "README.md#9-referensi-variabel-env" — anchor itu tidak ada (README §9 = "Untuk Developer") | link mati, operator tidak ketemu referensi env | arahkan ke `.env.example` (referensi env yang sebenarnya lengkap) | Medium
DOC-09 | .env.example / DOCS.md | `WEB_LOGIN_RATE_LIMIT_MAX` & `WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS` (dipakai di apps/web-admin/src/auth.ts) tidak terdokumentasi di mana pun selain config.ts | operator tidak tahu anti-bruteforce login admin bisa dituning | tambahkan ke .env.example dengan default + penjelasan singkat | Low
DOC-10 | README §7 | Migrasi data sekali-jalan (mis. scripts/migrate-catalog-rename.ts) tidak disinggung — hanya ada di komentar kepala skrip; operator yang git pull tanpa baca skrip satu-per-satu bisa lewat dan kena P2021 (table does not exist) saat live | downtime/500 di produksi setelah update (terjadi pada storefront sesi ini, root-caused manual) | tambah catatan di README §7: cek scripts/migrate-*.ts sebelum update produksi, ikuti prosedur stop+backup+jalankan+prisma generate di komentar skripnya | High
DOC-11 | DOCS.md §9 | Peta halaman menyebut "/p/:id" — route asli adalah "/p/:slug" (lihat apps/storefront/src/routes/catalog.ts) | salah kecil, membingungkan saat menyamakan dgn kode | ganti ke /p/:slug | Low
```

## Perubahan yang diterapkan (bukan sekadar laporan)
- `DOCS.md` §1: bullet katalog ditulis ulang ke model 3-tier (Category → Product
  → Denomination), route `/c/:slug` & `/p/:slug`, shaper `shapeProducts`.
- `DOCS.md` §4: `Product.price`/`resellerPrice` → `Denomination.price`/`resellerPrice`.
- `DOCS.md` §9: `/p/:id` → `/p/:slug`.
- `DOCS.md` §10: link mati ke README#9 diganti, arahkan ke `.env.example`.
- `.env.example`: tambah `WEB_LOGIN_RATE_LIMIT_MAX` / `WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS`
  dengan default + komentar.
- `README.md` §7: tambah catatan untuk cek `scripts/migrate-*.ts` (migrasi
  sekali-jalan, stop+backup+jalankan+prisma generate) sebelum update produksi.

## Catatan
Root cause DOC-10 ditemukan langsung di sesi ini: rename katalog 3-tier
(`e567081`..`28fc608`) mengubah skema tapi `data/bot.db` lokal belum dimigrasi
saat operator menjalankan storefront secara manual → `P2021: table main.denominations
does not exist` di semua halaman katalog. Migrasi sudah dijalankan ulang
(backup diambil dulu) dan diverifikasi (`/`, `/search`, `/c/:slug`, `/p/:slug`
→ 200). DOC-10 mendokumentasikan langkah itu untuk operator lain/VPS produksi.

Gap berdampak tinggi yang masih perlu perhatian developer (bukan sekadar dok):
tidak ada — sisanya sudah diperbaiki langsung di atas.
