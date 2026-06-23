# Dokumentasi `telegram-order-bot` — Indeks

Dokumen ini adalah indeks untuk dokumentasi operasional/teknis tambahan di
`docs/`. Untuk pemasangan awal di VPS, mulai dari
[`../README.md`](../README.md); untuk arsitektur & fitur lengkap, lihat
[`../DOCS.md`](../DOCS.md); untuk konvensi koding, lihat
[`../CLAUDE.md`](../CLAUDE.md). Dokumen di bawah ini **melengkapi**, bukan
mengganti, ketiga file itu — hindari duplikasi, ikuti link saat tumpang tindih.

## Daftar dokumen

| Dokumen | Isi |
|---|---|
| [INSTALLATION.md](INSTALLATION.md) | Requirement, langkah instalasi Docker/non-Docker, verifikasi |
| [CONFIGURATION.md](CONFIGURATION.md) | Sumber konfigurasi (`.env` vs Settings DB), profil dev/prod |
| [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | Referensi lengkap tiap variabel di `packages/core/src/config.ts` |
| [DATABASE.md](DATABASE.md) | Model Prisma, relasi, index, FK, ERD |
| [MIGRATIONS.md](MIGRATIONS.md) | Cara migrasi (`db push` vs `migrate deploy`), rollback, kegagalan umum |
| [UPDATE_GUIDE.md](UPDATE_GUIDE.md) | Prosedur update versi baru (urutan restart, migrasi dulu) |
| [PATCH_GUIDE.md](PATCH_GUIDE.md) | Template + contoh dokumentasi bugfix |
| [CHANGELOG.md](CHANGELOG.md) | Riwayat versi (semantic versioning) |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | Catatan rilis per versi |
| [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md) | Backup/restore SQLite WAL, uploads, disaster recovery |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Arsitektur proses, alur order/pembayaran, state machine |
| [API_REFERENCE.md](API_REFERENCE.md) | Semua route Fastify (admin, storefront) + webhook publik |
| [QUEUE_SYSTEM.md](QUEUE_SYSTEM.md) | `notification_outbox` sebagai antrian — klaim, backoff, dispatcher |
| [ORDER_STATE_MACHINE.md](ORDER_STATE_MACHINE.md) | Status order & transisi yang valid |
| [INVENTORY_SYSTEM.md](INVENTORY_SYSTEM.md) | Stok, reservasi, dedup, restock subscription |
| [PAYMENT_GATEWAY.md](PAYMENT_GATEWAY.md) | 5 metode bayar — webhook, signature, reconcile poller |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Gejala umum → diagnosis → fix |
| [SECURITY.md](SECURITY.md) | Model otorisasi, RBAC, CSRF, ringkasan audit keamanan |
| [ROLLBACK.md](ROLLBACK.md) | Rollback kode, DB, migrasi, deploy gagal |
| [VERSIONING.md](VERSIONING.md) | Skema semantic versioning untuk repo ini |

## Sumber kebenaran

Dokumen ini ditulis dari pembacaan langsung kode per 2026-06-24 (commit
`c4778c8`). Saat kode berubah, file terkait di atas **wajib diperbarui di PR
yang sama** — lihat aturan di [`../CLAUDE.md`](../CLAUDE.md) dan praktik
"dokumentasi adalah bagian dari fitur" di [PATCH_GUIDE.md](PATCH_GUIDE.md).

Stack nyata project ini **tidak memakai Redis, websocket, atau job-queue
terpisah** — jangan tertipu istilah generik. Antrian notifikasi adalah satu
tabel SQLite (`notification_outbox`) yang di-poll in-process oleh
`packages/outbox-dispatcher` (lihat [QUEUE_SYSTEM.md](QUEUE_SYSTEM.md)).
