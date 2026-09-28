# Dokumentasi `telegram-order-bot` — Indeks

Dokumen ini adalah indeks untuk seluruh isi `docs/`. Untuk pemasangan awal di
VPS, mulai dari [`../README.md`](../README.md); untuk migrasi/upgrade versi,
lihat [`../migrate.md`](../migrate.md); untuk arsitektur & fitur lengkap,
lihat [`../DOCS.md`](../DOCS.md); untuk konvensi koding, lihat
[`../.claude/CLAUDE.md`](../.claude/CLAUDE.md) — **bukan** `../CLAUDE.md`,
file itu tidak ada lagi di root repo. Dokumen di bawah ini **melengkapi**,
bukan mengganti, file-file itu — hindari duplikasi, ikuti link saat tumpang
tindih.

`docs/` sudah direorganisasi ke subfolder. Bagian di bawah mengikuti
struktur direktori aktual.

## `arsitektur/` — referensi arsitektur, keuangan, inventaris (living)

| Dokumen | Isi |
|---|---|
| [ARCHITECTURE.md](arsitektur/ARCHITECTURE.md) | Arsitektur proses, alur order/pembayaran, state machine |
| [DATABASE.md](arsitektur/DATABASE.md) | Model Prisma, relasi, index, FK, ERD |
| [DETECTION_ENGINE.md](arsitektur/DETECTION_ENGINE.md) | Detection Engine — mengubah nama produk supplier (free-form) jadi identitas stabil `baseProductKey`/`productKey`/`skuKey`; ditulis dalam bahasa Inggris karena mengikuti nama identifier di `packages/core/src/detection/**` |
| [FINANCE_ARCHITECTURE.md](arsitektur/FINANCE_ARCHITECTURE.md) | Separuh pricing/FX dari sistem uang — bagaimana harga katalog jadi nominal tagihan pembeli, dan apa yang menjaga aritmetikanya. Separuh akuntansi (ledger double-entry) ada di kode (`packages/db/src/crud/ledger.ts`) dan [sales-metrics-contract.md](sales-metrics-contract.md) |
| [FINANCE_MATH_REFERENCE.md](arsitektur/FINANCE_MATH_REFERENCE.md) | Ringkasan referensi cepat arsitektur uang, model harga, dan logika matematis (mis. base currency IDR, bukan multicurrency sejajar) |
| [FLOW.md](arsitektur/FLOW.md) | Diagram alur bisnis, diverifikasi terhadap kode aktual — dua jalur order terpisah: PRODUCT (top-up game/app premium) dan WALLET_TOPUP (isi saldo) |
| [INVENTORY_SYSTEM.md](arsitektur/INVENTORY_SYSTEM.md) | Stok, reservasi, dedup, restock subscription |
| [INVENTORY_TRACEABILITY.md](arsitektur/INVENTORY_TRACEABILITY.md) | Arsitektur keterlacakan stok "as shipped" — bagaimana satu kredensial digital dilacak dari masuk gudang sampai terjual/mati, setelah rencana hardening 7-fase "Stock Traceability & Credential Encryption" selesai |
| [ORDER_STATE_MACHINE.md](arsitektur/ORDER_STATE_MACHINE.md) | Status order & transisi yang valid |
| [PAYMENT_GATEWAY.md](arsitektur/PAYMENT_GATEWAY.md) | 6 metode bayar (semua auto-confirm) — endpoint, signature, idempotency, jalur kegagalan; ringkasan tabel di [`../DOCS.md` §5](../DOCS.md#5-pembayaran) |
| [QUEUE_SYSTEM.md](arsitektur/QUEUE_SYSTEM.md) | `notification_outbox` sebagai antrian — klaim, backoff, dispatcher |

## Dokumen referensi flat (setup/ops/reference, living)

| Dokumen | Isi |
|---|---|
| [INSTALLATION.md](INSTALLATION.md) | Requirement, langkah instalasi Docker/non-Docker, verifikasi |
| [CONFIGURATION.md](CONFIGURATION.md) | Sumber konfigurasi (`.env` vs Settings DB), profil dev/prod |
| [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | Referensi lengkap tiap variabel di `packages/core/src/config.ts` |
| [MIGRATIONS.md](MIGRATIONS.md) | Cara migrasi (`db push` vs `migrate deploy`), rollback, kegagalan umum |
| [POSTGRES_MIGRATION.md](POSTGRES_MIGRATION.md) | Runbook cutover produksi: migrasi toko live dari stack SQLite (`docker-compose.yml`) ke layer Postgres produksi (`docker-compose.postgres.prod.yml`), langkah demi langkah |
| [REACT_STOREFRONT_MIGRATION.md](REACT_STOREFRONT_MIGRATION.md) | Dokumen tracking migrasi `apps/storefront` dari Nunjucks+HTMX ke React SPA (pixel-identical, behavior identik) — titik resume lintas sesi |
| [UPDATE_GUIDE.md](UPDATE_GUIDE.md) | Prosedur update versi baru (urutan restart, migrasi dulu) |
| [PATCH_GUIDE.md](PATCH_GUIDE.md) | Template + contoh dokumentasi bugfix |
| [CHANGELOG.md](CHANGELOG.md) | Riwayat versi (semantic versioning) |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | Catatan rilis per versi |
| [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md) | Backup/restore database (SQLite WAL lama atau PostgreSQL, tergantung status cutover toko — lihat [DATABASE.md](arsitektur/DATABASE.md)) + `data/uploads/`, disaster recovery |
| [sales-metrics-contract.md](sales-metrics-contract.md) | Definisi semantik otoritatif tiap angka sales/revenue/order-count/profit/refund yang ditampilkan sistem — satu baris per metrik: makna, query, status order yang dihitung, penanganan currency/refund/diskon/timezone |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Gejala umum → diagnosis → fix |
| [LOGGING.md](LOGGING.md) | Konvensi penulisan log: audit log (kalimat untuk admin toko) vs Pino (pesan untuk developer/ops) |
| [SECURITY.md](SECURITY.md) | Model otorisasi, RBAC, CSRF, ringkasan audit keamanan |
| [ROLLBACK.md](ROLLBACK.md) | Rollback kode, DB, migrasi, deploy gagal |
| [VERSIONING.md](VERSIONING.md) | Skema semantic versioning untuk repo ini |
| [API_REFERENCE.md](API_REFERENCE.md) | Semua route Fastify (admin, storefront) + webhook publik |

## `ui/` — panduan gaya UI admin (living, konvensi bernomor sendiri)

Style guide untuk `apps/web-admin/client` (Trustance Admin Dashboard), 11
dokumen bernomor `00` sampai `10`, dibaca berurutan: `00` menjelaskan cara
memakai dokumen `01`–`10`, lalu tiap nomor berikutnya membahas satu lapisan
(design system, layout, komponen, CRUD template, tabel, settings, dashboard,
UX rules, code style, review checklist). Mulai dari entry point:
[`ui/00_AI_RULES.md`](ui/00_AI_RULES.md) — dokumen itu mengarahkan ke sisanya.

## `archive/` — historis/point-in-time, BUKAN dokumentasi kondisi saat ini

Semua isi `docs/archive/` adalah snapshot dari suatu titik waktu tertentu
(audit, rencana, laporan). **Jangan jadikan isi folder ini sebagai acuan
kondisi repo sekarang** — untuk itu pakai bagian `arsitektur/` dan
dokumen flat di atas, atau [`../DOCS.md`](../DOCS.md). Isinya:

- 12 file `audit-*.md` — audit backend/UI-UX bertanggal 2026-06 s/d 2026-08
  (termasuk `audit-stock-traceability-fase0.md`)
- `ui-refactor/` (24 file + screenshot) — audit/rencana refactor UI storefront
  + admin
- `implementation/` (7 file) — kumpulan rencana storefront-redesign
- `admin-ux-pass-v2-plan.md`, `FRONTEND_IMPLEMENTATION_PROMPT_v3.md`,
  `PROJECT_ARCHITECTURE.md`, `RESOURCE_OPTIMIZATION_REPORT.md` — masing-masing
  rencana/laporan point-in-time berdiri sendiri

## `trustance-reference/` — referensi eksternal, BUKAN arsitektur repo ini

Lima dokumen `trustance-*.md` yang menggambarkan sistem lain (aspirational,
milik proyek induk "Trustance") — package dan provider pembayaran yang
berbeda dari yang benar-benar ada di repo ini. Jangan jadikan acuan
implementasi. Baca [`trustance-reference/README.md`](trustance-reference/README.md)
untuk disclaimer lengkap dan daftar isi tiap file.

## `superpowers/` — arsip plan/spec dari workflow skill-driven development

`docs/superpowers/plans/` (31 file) dan `docs/superpowers/specs/` (25 file)
adalah arsip dokumen kerja dari proses pengembangan berbasis skill Superpowers
— di luar cakupan detail indeks ini.

## Sumber kebenaran

Dokumen ini disusun ulang dan diverifikasi terhadap struktur direktori
`docs/` pada 2026-09-29. Setiap file di atas dibaca langsung dari kode pada
waktu penulisannya masing-masing (lihat header/isi tiap dokumen untuk konteks
tanggal); saat kode berubah, file terkait **wajib diperbarui di PR yang
sama** — lihat aturan di [`../.claude/CLAUDE.md`](../.claude/CLAUDE.md) dan
praktik "dokumentasi adalah bagian dari fitur" di
[PATCH_GUIDE.md](PATCH_GUIDE.md).

Stack nyata project ini **tidak memakai Redis, websocket, atau job-queue
terpisah** — jangan tertipu istilah generik. Antrian notifikasi adalah satu
tabel **PostgreSQL** (`notification_outbox`, engine-swap dari SQLite merged
2026-08-27) yang di-poll in-process oleh `packages/outbox-dispatcher` (lihat
[QUEUE_SYSTEM.md](arsitektur/QUEUE_SYSTEM.md)).
