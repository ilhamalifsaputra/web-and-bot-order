# Backup & Restore

Stack ini punya **dua hal stateful** yang perlu dibackup: database dan file
upload (`data/uploads/`). **Tidak ada Redis** — tidak ada state cache
eksternal untuk dibackup.

Database-nya bisa **SQLite atau PostgreSQL** tergantung status cutover toko
— lihat [`DATABASE.md`](DATABASE.md) untuk penjelasan kenapa dua-duanya
masih relevan: `schema.prisma` sudah Postgres-only sejak engine-swap, tapi
toko yang belum menjalankan runbook
[`POSTGRES_MIGRATION.md`](POSTGRES_MIGRATION.md) database live-nya
masih SQLite lama (`data/bot.db`, mode **WAL**).

## Database backup — dua jalur, terdeteksi otomatis

`deploy/backup/backup.sh` dan `deploy/backup/restore.sh` adalah **skrip
yang sama untuk kedua engine** — operator tidak perlu tahu/memilih jalur
mana yang aktif, skrip mendeteksinya sendiri:

- **`backup.sh`** membaca `DATABASE_URL_PRISMA`: kosong atau berawalan
  `file:` → jalur **SQLite**; berawalan `postgres://`/`postgresql://` →
  jalur **Postgres**; nilai lain → error keras.
- **`restore.sh`** membaca ekstensi file backup yang diberikan: `.db` atau
  `.db.gz` → jalur **SQLite**; `.dump` → jalur **Postgres**.

Detail penuh (prasyarat host per jalur, apa yang diverifikasi, format nama
file & retensi, contoh cron produksi, cara memindahkan cron dari SQLite ke
Postgres setelah cutover, kaitan dengan auto-backup-sebelum-migrasi di
`docker-entrypoint.sh`) ada di
**[`deploy/backup/README.md`](../deploy/backup/README.md) — jadikan itu
sumber kebenaran, dokumen ini hanya ringkasan operasional.**

### Jalur SQLite (toko pre-cutover)

```bash
deploy/backup/backup.sh
# atau path produksi:
DB=/srv/app/data/bot.db DEST=/srv/backups RETENTION=28 deploy/backup/backup.sh
```

**Mengapa tidak `cp data/bot.db`:** mode WAL berarti transaksi terbaru bisa
masih berada di `bot.db-wal` yang belum di-checkpoint — copy file mentah
saat service jalan **bisa kehilangan data**. `backup.sh` memakai `sqlite3
".backup"` (online backup API), snapshot **konsisten** termasuk isi `-wal`,
**zero-downtime**, lalu diverifikasi dengan `PRAGMA integrity_check` (gagal
⇒ backup dihapus, tidak pernah menyimpan backup yang rusak), dikompres
`gzip -k`, dan dipangkas sesuai retensi (default 28 backup terbaru).

**Prasyarat host:** `sqlite3` tidak ada di image Docker runtime — skrip
jalan di **host** (tempat `./data` di-bind-mount):
```bash
sudo apt-get update && sudo apt-get install -y sqlite3
```

### Jalur Postgres (toko post-cutover)

```bash
deploy/backup/backup.sh
# atau path produksi:
DEST=/srv/backups RETENTION=28 deploy/backup/backup.sh
```

Jalur ini aktif otomatis begitu `DATABASE_URL_PRISMA` di environment skrip
berawalan `postgres(ql)://` — tidak ada flag terpisah. `pg_dump -Fc`
(format custom) dijalankan **di dalam** container `postgres` lewat `docker
compose exec` — ini juga cara skrip menghindari perlu membaca
`POSTGRES_PASSWORD` sama sekali, autentikasi terjadi lewat socket lokal
container, bukan kredensial di jaringan/log/skrip. Diverifikasi dengan
`pg_restore --list` (padanan `integrity_check` untuk Postgres), lalu
dipangkas sesuai retensi (pola nama `pg-<stamp>.dump`).

**Prasyarat host:** `pg_restore` (paket `postgresql-client`):
```bash
sudo apt-get update && sudo apt-get install -y postgresql-client
```

### Jadwal (cron, tiap 6 jam)

Skrip yang sama untuk kedua jalur — hanya env var di depan pemanggilannya
yang beda:

```cron
# Jalur SQLite (pre-cutover):
0 */6 * * * DB=/srv/app/data/bot.db DEST=/srv/backups /srv/app/deploy/backup/backup.sh >> /var/log/bot-backup.log 2>&1

# Jalur Postgres (post-cutover):
0 */6 * * * DATABASE_URL_PRISMA=postgresql://engine-marker DEST=/srv/backups /srv/app/deploy/backup/backup.sh >> /var/log/bot-backup.log 2>&1
```

`postgresql://engine-marker` cukup sebagai penanda prefix — nilainya
sendiri **tidak pernah dipakai untuk koneksi sungguhan** (autentikasi lewat
`docker compose exec`, lihat di atas), jadi baris cron tidak perlu memuat
password atau connection string kredensial apa pun. Setelah toko selesai
cutover, ganti baris cron produksi dari varian SQLite ke varian Postgres —
langkah lengkapnya ada di §8a
[`POSTGRES_MIGRATION.md`](POSTGRES_MIGRATION.md).

## Uploads backup

`data/uploads/` (foto produk, branding, dokumen) **tidak tercakup**
`backup.sh` di jalur mana pun — backup terpisah, biasanya cukup
`tar`/`rsync` biasa (bukan file database, tidak butuh konsistensi WAL):

```bash
tar -czf "uploads-$(date +%F).tar.gz" data/uploads/
# atau sinkron berkelanjutan:
rsync -a data/uploads/ backups@offsite:/srv/bot-uploads/
```

Jalankan pada jadwal yang sama dengan backup DB (cron 6 jam) supaya snapshot
DB dan file referensinya (`Product.webImageUrl`, `banner_image`, dst.) tidak
terlalu jauh berbeda waktu.

## Off-box (aturan 3-2-1)

Backup yang hanya ada di disk yang sama dengan DB live **hilang bersama
host** kalau VPS bermasalah. Uncomment salah satu baris di akhir
`deploy/backup/backup.sh` — berlaku untuk kedua jalur, variabelnya sudah
otomatis mengarah ke file yang benar (`.db.gz` untuk SQLite, `.dump` untuk
Postgres):

```bash
# rsync -a "$OFFBOX_FILE" backups@offsite:/srv/bot-backups/
# aws s3 cp "$OFFBOX_FILE" "s3://my-bucket/bot-backups/"
```

## Restore procedure

```bash
# Jalur SQLite:
deploy/backup/restore.sh ./data/backups/bot-2026-06-18-1200.db
deploy/backup/restore.sh ./data/backups/bot-2026-06-18-1200.db.gz   # .gz juga bisa

# Jalur Postgres:
deploy/backup/restore.sh ./data/backups/pg-2026-08-27-153000.dump
```

Jalur dipilih otomatis dari ekstensi file backup yang diberikan. Langkah
umum di kedua jalur (detail lengkap per-jalur, termasuk sentinel
`SKIP_AUTO_MIGRATE` khusus SQLite, ada di `deploy/backup/README.md`):

1. Verifikasi file backup dulu (`integrity_check` untuk SQLite, `pg_restore
   --list` untuk Postgres) — abort sebelum menyentuh DB live bila ternyata
   rusak.
2. `docker compose stop server` (hentikan satu-satunya proses penulis DB;
   container `postgres` sendiri tetap jalan di jalur Postgres, hanya
   `server` yang dihentikan).
3. Simpan DB saat ini ke salinan pengaman pra-restore (`bot.db.pre-restore-
   <stamp>` / `pg-pre-restore-<stamp>.dump`) — restore sendiri tetap
   reversibel.
4. Terapkan backup ke DB live — SQLite: salin file lalu hapus
   `bot.db-wal`/`bot.db-shm` basi milik DB lama; Postgres: `pg_restore
   --clean --if-exists` di dalam container.
5. `integrity_check` ulang (SQLite) pada hasil restore, lalu `docker compose
   start ...` dan smoke-test `GET /healthz` sampai 200.

## Disaster recovery

| Skenario | Langkah |
|---|---|
| Host VPS mati total, ada off-box backup | Provision VPS baru → clone repo → `restore.sh` dari backup off-box (SQLite atau Postgres, sesuai jalur toko) → restore `uploads/` dari rsync/tar terakhir → bawa stack naik (`docker compose up -d`, tambah overlay `docker-compose.postgres.prod.yml` bila sudah cutover) → update DNS jika IP berubah |
| DB korup (`integrity_check`/`pg_restore --list` gagal di live) | `docker compose stop server` → `restore.sh <backup-terakhir-yang-valid>` → terima kehilangan data sejak backup terakhir (lihat RPO di bawah) |
| Migrasi/deploy gagal di tengah jalan | Lihat [ROLLBACK.md](ROLLBACK.md) — `restore.sh` ke backup pra-migrasi adalah jalur utama. Untuk rollback cutover SQLite→Postgres itu sendiri (bukan migrasi skema biasa), lihat §9 [`POSTGRES_MIGRATION.md`](POSTGRES_MIGRATION.md) |
| `uploads/` terhapus tidak sengaja | Restore dari tar/rsync terakhir — gambar yang hilang sejak backup terakhir kembali ke fallback (Unsplash map / placeholder) sampai admin upload ulang |

## RTO / RPO

| Metrik | SQLite | Postgres | Catatan |
|---|---|---|---|
| **RPO** (kehilangan data maksimum) | ≤ 6 jam | ≤ 6 jam | = interval cron backup di kedua jalur; perapat jadwal untuk RPO lebih kecil |
| **RTO** (waktu pulih) | ~1–2 menit | ~1–3 menit | stop → verifikasi/salin/restore → start → healthz (DB satu toko, kecil); Postgres sedikit lebih lama karena `pg_restore --clean` menjalankan ulang DDL |

## Wajib backup sebelum...

- **Update** versi (lihat [UPDATE_GUIDE.md](UPDATE_GUIDE.md) langkah 1).
- **Migrasi** skema (`db push`) — lihat [MIGRATIONS.md](MIGRATIONS.md). Di
  jalur SQLite ini terjadi otomatis lewat `docker-entrypoint.sh` sebelum
  `prisma db push`; di jalur Postgres, jalankan `backup.sh` manual dulu —
  entrypoint tidak melakukannya otomatis untuk engine ini (lihat
  `deploy/backup/README.md`).
- **Patch**/bugfix yang menyentuh DB (lihat [PATCH_GUIDE.md](PATCH_GUIDE.md)).
- **Rilis major** — lihat [VERSIONING.md](VERSIONING.md) untuk definisi
  major di repo ini (biasanya berarti migrasi data sekali-jalan non-idempotent
  — risiko tertinggi).
- **Cutover SQLite → Postgres itu sendiri** — runbook
  [`POSTGRES_MIGRATION.md`](POSTGRES_MIGRATION.md) §3 memakai
  `backup.sh` untuk mengambil snapshot SQLite terakhir sebelum proses
  dimulai; itu juga titik rollback §9-nya.

## Uji restore (wajib berkala, bukan sekali saat setup)

```bash
# 1) ambil backup (jalur terdeteksi otomatis dari DATABASE_URL_PRISMA)
deploy/backup/backup.sh
# 2) catat satu baris data yang diketahui, lalu ubah/hapus di DB live (simulasi kehilangan)
# 3) restore dari backup — bot-<stamp>.db untuk SQLite, pg-<stamp>.dump untuk Postgres
deploy/backup/restore.sh ./data/backups/bot-<stamp>.db
# 4) verifikasi: /healthz 200 + baris yang tadi muncul kembali utuh
```
Kriteria lulus: verifikasi backup lulus (`integrity_check=ok` untuk SQLite,
`pg_restore --list` sukses untuk Postgres), `/healthz=200`, data
pasca-backup pulih sesuai snapshot. **Backup yang tak pernah diuji bukan
backup.** Jalankan rehearsal ini minimal bulanan, di kedua jalur bila toko
sedang dalam masa transisi.
