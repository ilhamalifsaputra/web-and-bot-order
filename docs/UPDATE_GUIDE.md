# Panduan Update

Prosedur untuk menarik versi baru dan menerapkannya ke instance yang sudah
jalan (produksi atau staging). Untuk konsep versi/rilis, lihat
[VERSIONING.md](VERSIONING.md) dan [CHANGELOG.md](CHANGELOG.md).

## Mengapa urutannya kaku

Aplikasi saat ini **satu proses** (`apps/server`) dengan database PostgreSQL
(lihat [DATABASE.md](arsitektur/DATABASE.md) dan
[POSTGRES_MIGRATION.md](POSTGRES_MIGRATION.md)).
Tidak ada rolling-update multi-instance, tidak ada load balancer di depan
beberapa replica — jadi "zero-downtime" di sini berarti **downtime
seminimal mungkin** (~detik, bukan nol mutlak) lewat urutan yang benar, bukan
blue-green deployment sungguhan.

**Urutan yang salah menyebabkan `P2022`/`P2021`** (lihat
[MIGRATIONS.md](MIGRATIONS.md)) — kode baru mereferensikan kolom/tabel yang
belum ada di DB live.

## Prosedur standar PostgreSQL — Docker produksi

Jalankan dari root repo. `backup.sh` **tidak** membaca `.env` sendiri;
`docker compose` membacanya untuk interpolasi, tetapi proses skrip backup
tetap membutuhkan penanda eksplisit. Skrip hanya memeriksa awalan URL,
jadi penanda berikut tidak memuat kredensial. Pastikan dump `.dump` berhasil
dan tersimpan sebelum menarik kode baru (lihat
[panduan backup](../deploy/backup/README.md)).

```bash
DATABASE_URL_PRISMA=postgresql://engine-marker deploy/backup/backup.sh
git pull
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml logs --since 10m server | grep entrypoint
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml ps
curl -i http://127.0.0.1:8000/healthz
```

`up -d --build` membangun image/bundle SPA dan entrypoint menjalankan
**schema push → seed chart of accounts → migrasi data-only** sebelum aplikasi
start. Baca hasil tiap langkah di log: schema push yang gagal menolak start,
sedangkan seed/migrasi data-only yang gagal hanya menghasilkan WARNING.
Periksa juga storefront (`:8100/healthz` jika diekspos) dan balasan `/start`
di bot. `AUTO_MIGRATE=0` adalah pengecualian untuk operator yang menjalankan
langkah database secara manual; lihat [MIGRATIONS.md](MIGRATIONS.md).

## PostgreSQL tanpa Docker (PM2)

Gunakan database host yang sama dengan instalasi (lihat
[README Jalur B](../README.md#4-jalur-b--tanpa-docker)). `backup.sh` di atas
memerlukan container `postgres`; untuk instalasi host murni, ambil dump
dengan client PostgreSQL sebelum `git pull`. Sesuaikan host, port, user,
dan nama database dengan `.env`; `pg_dump` akan meminta password.

```bash
mkdir -p data/backups
pg_dump -h 127.0.0.1 -p 5432 -U bot_order -Fc -f "data/backups/pg-$(date +%F-%H%M%S).dump" bot_order
git pull
pnpm install --frozen-lockfile
pnpm prisma:generate
pm2 stop bot-order
pnpm exec prisma db push
pnpm seed-chart-of-accounts
# Jalankan file dalam DATA_MIGRATIONS (docker-entrypoint.sh) sesuai urutan,
# misalnya untuk daftar pada rilis ini:
pnpm exec prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20260919120000_seed_usdt_rounding_ceil_since/migration.sql
pnpm --filter @app/web-admin-client build
pnpm --filter @app/storefront-client build
pm2 restart bot-order
curl -i http://127.0.0.1:8000/healthz
```

Jalur non-Docker harus menjalankan migrasi data-only yang relevan secara
manual; entrypoint Docker tidak dipakai. Setelah restart, periksa log PM2
dan health check kedua antarmuka.

## Migrasi data pada rilis PostgreSQL

Daftar `DATA_MIGRATIONS` di `docker-entrypoint.sh` berisi file SQL data-only
yang aman diulang. Docker mengeksekusinya otomatis setelah schema push dan
seed ledger pada setiap start. Pada jalur non-Docker, jalankan setiap file di
daftar itu dengan `pnpm exec prisma db execute --schema prisma/schema.prisma
--file prisma/migrations/<nama-folder>/migration.sql` setelah schema push dan
seed, sebelum restart PM2. Baca header tiap file untuk dampak dan verifikasi;
jangan jalankan skrip migrasi historis yang tidak tercantum secara otomatis.

## Breaking changes & restart order per jenis perubahan

| Jenis perubahan | Langkah tambahan | Butuh restart? |
|---|---|---|
| Kolom/tabel baru (additive) | `db push` sebelum restart | Ya |
| Rename tabel/kolom | Periksa dampak data dan instruksi rilis; siapkan SQL/backfill yang aman, lalu terapkan skema sebelum kode baru melayani trafik | Ya |
| FK/constraint-only | Periksa perubahan constraint dan dampaknya pada data yang ada; uji di staging dan ambil dump sebelum update | Ya |
| Variabel `.env` baru | Isi `.env` sebelum restart (proses tidak reload `.env` sendiri) | Ya |
| Setting baru (DB) | Tidak perlu apa-apa — terbaca live | Tidak (untuk Setting yang "langsung berlaku" — lihat tabel di [`../DOCS.md` §6](../DOCS.md#6-settings-vs-env)) |
| Ganti `bot_token`/`web_cookie_secret` via Settings | — | Ya (proses yang relevan, lihat §6) |
| Dependency baru (`package.json`) | `pnpm install` / `docker compose ... up -d --build` sebelum proses baru berjalan | Ya |

### Legacy SQLite, hanya checkout pra-cutover

Pada checkout lama yang masih memakai `data/bot.db`, skrip historis seperti
`migrate-catalog-rename.ts` dapat membutuhkan langkah manual sekali jalan.
Ikuti header skrip dan panduan backup SQLite pada versi kode itu; simpan
backup WAL-safe sebelum menjalankannya. Pembahasan rebuild tabel SQLite dan
file `bot.db` ini **bukan** prosedur update PostgreSQL saat ini.

## Cache & "Redis"

**Tidak ada Redis atau cache layer eksternal di stack ini.** Tidak ada
langkah "flush cache" dalam prosedur update — satu-satunya state in-memory
yang hilang saat restart adalah sesi bot grammY (lihat catatan "In-Memory Bot
Sessions" di [ARCHITECTURE.md](arsitektur/ARCHITECTURE.md)): pengguna yang sedang di
tengah wizard/conversation akan kembali ke menu utama setelah restart. Ini
risiko yang diketahui & diterima, bukan bug — informasikan ke pengguna lewat
jendela maintenance singkat jika memungkinkan.

## Verifikasi pasca-update

Checklist lengkap (4 service up, healthcheck hijau, TLS valid, backup cron
aktif) ada di `deploy/README.md` bagian "Deployment checklist". Minimal:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml ps  # server + postgres "Up"/"healthy"
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml logs --since 10m server | grep entrypoint
curl -I https://admin.contoh.com/healthz    # 200
curl -I https://shop.contoh.com/healthz     # 200 (jika storefront diekspos)
# di Telegram: /start ke bot → harus membalas
```

## Jika update gagal

Lihat [ROLLBACK.md](ROLLBACK.md) dan
[prosedur restore PostgreSQL](../deploy/backup/README.md).
Pada Docker, restore file `.dump` dengan `deploy/backup/restore.sh <path-dump>`; skrip
memasang `data/SKIP_AUTO_MIGRATE` sebelum start server supaya database tidak
langsung dimigrasi maju lagi. Cocokkan versi kode dengan database hasil
restore sebelum melepas sentinel dan restart. Pada instalasi host murni,
hentikan PM2, gunakan `pg_restore` client versi PostgreSQL yang cocok terhadap
dump host, lalu jalankan kembali kode yang kompatibel; skrip `restore.sh`
memerlukan container `postgres` dan tidak berlaku untuk jalur ini.
