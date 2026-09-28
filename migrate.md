# Panduan Migrasi Database

Database aplikasi saat ini adalah PostgreSQL. Pilih alur yang sesuai: Bagian A
untuk perubahan skema rutin, Bagian B hanya untuk toko lama yang masih memakai
SQLite, atau Bagian C untuk menyiapkan database development lokal.

Sebelum mengubah database production, ambil dan verifikasi backup. Lihat
[`deploy/backup/README.md`](deploy/backup/README.md) untuk prosedurnya.

## Bagian A — Update skema saat development

Repo ini menerapkan perubahan `prisma/schema.prisma` dengan
`pnpm exec prisma db push`, bukan `prisma migrate deploy`. Pastikan
`DATABASE_URL_PRISMA` di `.env` menunjuk ke database PostgreSQL yang dimaksud.
Setelah mengubah skema atau memperbarui kode, jalankan:

```bash
pnpm prisma:generate
pnpm exec prisma db push
```

Generate ulang Prisma Client saat skema berubah. Setelah `db push` berhasil,
restart proses order-bot/aplikasi (misalnya `pm2 restart bot-order` pada instalasi
non-Docker). Terapkan skema **sebelum** kode baru berjalan; urutan sebaliknya
dapat memicu `P2022` (kolom belum ada) atau `P2021` (tabel belum ada).

Pada deploy Docker standar, jalankan kedua file Compose production seperti di
[`README.md`](README.md): entrypoint menerapkan `db push`, seed chart of accounts,
dan migrasi data-only sebelum aplikasi dimulai. Periksa log `entrypoint:` setelah
deploy, karena kegagalan seed atau migrasi data-only dilaporkan sebagai
peringatan. Dengan `AUTO_MIGRATE=0`, operator harus menjalankan langkah tersebut
secara manual. Panduan drift check, recovery, migrasi data-only, dan rollback ada
di [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md).

## Bagian B — Cutover sekali-jalan SQLite → PostgreSQL

Bagian ini **hanya** untuk toko legacy yang database production-nya masih
SQLite. Cutover memerlukan penghentian penulisan, backup SQLite yang terverifikasi,
penyiapan skema PostgreSQL, pemindahan data, rekonsiliasi, perpindahan aplikasi,
penyesuaian backup terjadwal, dan rencana rollback.

Ikuti **[`docs/POSTGRES_MIGRATION.md`](docs/POSTGRES_MIGRATION.md)** sebagai
runbook lengkap dan sumber kebenaran untuk urutan serta perintahnya. Runbook itu
juga menjelaskan `deploy/postgres-cutover.sh`, opsi `--dry-run`, langkah yang
tetap manual, dan gerbang rekonsiliasi. Simpan backup SQLite selama masa
monitoring pasca-cutover dan selama masih diperlukan untuk rollback.

## Bagian C — PostgreSQL lokal untuk development

Jika `.env` belum ada, salin dari `.env.example`. Isi `POSTGRES_PASSWORD` di
`.env`, lalu nyalakan layanan PostgreSQL lokal:

```bash
docker compose -f docker-compose.postgres.yml up -d
```

Sesuaikan `DATABASE_URL_PRISMA` di `.env` dengan `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`, dan `POSTGRES_PORT` pada Compose. Untuk Prisma
yang berjalan di host, gunakan `127.0.0.1` sebagai host database; nama layanan `postgres` hanya
berlaku di jaringan Compose. Setelah dependensi terpasang, jalankan:

```bash
pnpm prisma:generate
pnpm exec prisma db push
```

Untuk instalasi aplikasi baru, jalankan juga `pnpm seed-chart-of-accounts`
sebelum aplikasi dipakai; lihat [`README.md`](README.md) untuk langkah instalasi
lengkap.
