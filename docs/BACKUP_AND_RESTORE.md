# Backup & Restore

Stack ini punya **dua hal stateful** yang perlu dibackup: database dan file
upload (`data/uploads/`). **Tidak ada Redis** — tidak ada state cache
eksternal untuk dibackup.

Database-nya **PostgreSQL** (lihat [`DATABASE.md`](arsitektur/DATABASE.md)).
`deploy/backup/backup.sh` dan `deploy/backup/restore.sh` mencadangkan dan
memulihkannya lewat `pg_dump -Fc` / `pg_restore`.

Detail penuh (prasyarat host, apa yang diverifikasi, format nama file &
retensi, contoh cron produksi, sentinel `SKIP_AUTO_MIGRATE`) ada di
**[`deploy/backup/README.md`](../deploy/backup/README.md) — jadikan itu
sumber kebenaran, dokumen ini hanya ringkasan operasional.**

## Database backup

```bash
deploy/backup/backup.sh
# atau path produksi:
DEST=/srv/backups RETENTION=28 deploy/backup/backup.sh
```

`pg_dump -Fc` (format custom) dijalankan **di dalam** container `postgres`
lewat `docker compose exec` — ini juga cara skrip menghindari perlu membaca
`POSTGRES_PASSWORD` sama sekali, autentikasi terjadi lewat socket lokal
container, bukan kredensial di jaringan/log/skrip. Dump diverifikasi dengan
`pg_restore --list` — juga dijalankan **di dalam container** — lalu dipangkas
sesuai retensi (pola nama `pg-<stamp>.dump`, default 28 backup terbaru).
Dump yang gagal verifikasi dihapus, tidak pernah disimpan sebagai backup.

**Prasyarat host:** cukup `docker`. Dump, restore, dan verifikasi dump
semuanya berjalan di dalam container `postgres` lewat `docker compose exec`,
jadi **tidak perlu memasang `postgresql-client` di host**. Itu disengaja:
server-nya `postgres:16-alpine`, dan client host yang lebih tua (PG14/PG15,
yang masih diberikan `apt-get install postgresql-client` di sebagian distro)
akan menolak dump `-Fc` buatan PG16 dengan `unsupported version ... in file
header` — `backup.sh` akan salah menyimpulkan dump-nya rusak lalu
**menghapus backup yang sebenarnya sehat**. Client di dalam container selalu
seversi dengan servernya.

Kedua skrip juga **self-locating** (`cd` ke root repo berdasarkan lokasi
skripnya sendiri), sehingga bisa dipanggil dari direktori mana pun —
termasuk cron, yang working directory-nya `$HOME`. Ini yang membuat skrip
bisa menemukan file `docker-compose*.yml`-nya.

### Jadwal (cron, tiap 6 jam)

```cron
0 */6 * * * DEST=/srv/backups /srv/app/deploy/backup/backup.sh >> /var/log/bot-backup.log 2>&1
```

Baris cron tidak perlu memuat password atau connection string kredensial
apa pun, dan tidak perlu prefix `cd /srv/app &&`: `backup.sh` sudah `cd` ke
root repo sendiri.

## Uploads backup

`data/uploads/` (foto produk, branding, dokumen) **tidak tercakup**
`backup.sh` — backup terpisah, biasanya cukup `tar`/`rsync` biasa (bukan
file database, tidak butuh konsistensi transaksi):

```bash
tar -czf "uploads-$(date +%F).tar.gz" data/uploads/
# atau sinkron berkelanjutan:
rsync -a data/uploads/ backups@offsite:/srv/bot-uploads/
```

Jalankan pada jadwal yang sama dengan backup DB (cron 6 jam) supaya snapshot
DB dan file referensinya (`Product.webImageUrl`, `banner_image`, dst.) tidak
terlalu jauh berbeda waktu.

## Credential encryption key backup

`data/credential_encryption.key` (kalau ada — dibuat otomatis oleh
`docker-entrypoint.sh` saat toko pertama kali menyimpan credential
terenkripsi, mis. Digiflazz API key atau akun manual di stok) **juga tidak
tercakup** `backup.sh`. Backup terpisah, sama seperti `uploads/`:

```bash
cp data/credential_encryption.key "credential-key-$(date +%F).bak"
```

**Jangan** taruh file ini di archive yang sama dengan dump database (mis.
`tar czf backup.tar.gz data/` yang juga berisi `data/backups/` dari
`backup.sh`) — itu menyatukan kembali key dan ciphertext yang sengaja
dipisahkan, menghilangkan proteksi enkripsi-saat-disimpan kalau archive itu
bocor. Simpan di lokasi off-box yang terpisah dari backup database.

**Kalau file ini hilang tanpa backup, semua credential yang sudah
terenkripsi (Settings seperti Digiflazz API key, dan akun manual apa pun di
stok) tidak bisa dibaca lagi selamanya** — restart hanya men-generate key
baru yang tidak bisa mendekripsi data lama.

## Off-box (aturan 3-2-1)

Backup yang hanya ada di disk yang sama dengan DB live **hilang bersama
host** kalau VPS bermasalah. Uncomment salah satu baris di akhir
`deploy/backup/backup.sh`; variabel `$OFFBOX_FILE` sudah otomatis mengarah
ke file `.dump` yang benar:

```bash
# rsync -a "$OFFBOX_FILE" backups@offsite:/srv/bot-backups/
# aws s3 cp "$OFFBOX_FILE" "s3://my-bucket/bot-backups/"
```

## Restore procedure

```bash
deploy/backup/restore.sh ./data/backups/pg-2026-08-27-153000.dump
```

`restore.sh` hanya menerima file berekstensi `.dump`. Langkahnya (detail
lengkap, termasuk sentinel `SKIP_AUTO_MIGRATE`, ada di
`deploy/backup/README.md`):

1. Verifikasi file backup dulu (`pg_restore --list`) — abort sebelum
   menyentuh DB live bila ternyata rusak.
2. `docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml stop server` (hentikan satu-satunya proses penulis DB;
   container `postgres` sendiri tetap jalan, hanya `server` yang dihentikan).
3. Simpan DB saat ini ke salinan pengaman `pg-pre-restore-<stamp>.dump` —
   restore sendiri tetap reversibel.
4. `pg_restore --clean --if-exists --single-transaction` di dalam container
   (`--single-transaction` membuat restore-nya atomik **dan** membuat
   `pg_restore` benar-benar exit non-zero saat ada statement yang gagal —
   tanpa itu restore yang setengah jadi tetap dilaporkan sukses).
5. Tulis sentinel `data/SKIP_AUTO_MIGRATE` supaya entrypoint tidak langsung
   menjalankan `prisma db push` pada database yang baru direstore.
6. `docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml start ...` dan smoke-test `GET /healthz` (di `WEB_PORT` dari `.env`) sampai 200.

Setelah restore, biarkan sentinel tetap ada sampai kode yang berjalan cocok
dengan skema database hasil restore, lalu hapus (`rm ./data/SKIP_AUTO_MIGRATE`)
dan restart `server` — lihat bagian "Setelah restore" di
`deploy/backup/README.md`.

## Disaster recovery

| Skenario | Langkah |
|---|---|
| Host VPS mati total, ada off-box backup | Provision VPS baru → clone repo → `restore.sh` dari backup off-box → restore `uploads/` dari rsync/tar terakhir → **restore `data/credential_encryption.key` dari backup terpisah SEBELUM start pertama** (kalau toko ini punya credential terenkripsi — key baru yang di-generate otomatis TIDAK bisa mendekripsi data lama) → bawa stack naik (`docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml up -d`) → update DNS jika IP berubah |
| DB korup (`pg_restore --list` gagal pada dump, atau data live rusak) | `docker compose stop server` → `restore.sh <backup-terakhir-yang-valid>` → terima kehilangan data sejak backup terakhir (lihat RPO di bawah) |
| Migrasi/deploy gagal di tengah jalan | Lihat [ROLLBACK.md](ROLLBACK.md) — `restore.sh` ke backup pra-migrasi adalah jalur utama |
| `uploads/` terhapus tidak sengaja | Restore dari tar/rsync terakhir — gambar yang hilang sejak backup terakhir kembali ke fallback (Unsplash map / placeholder) sampai admin upload ulang |

## RTO / RPO

| Metrik | Nilai | Catatan |
|---|---|---|
| **RPO** (kehilangan data maksimum) | ≤ 6 jam | = interval cron backup; perapat jadwal untuk RPO lebih kecil |
| **RTO** (waktu pulih) | ~1–3 menit | stop → verifikasi/restore → start → healthz (DB satu toko, kecil); `pg_restore --clean` menjalankan ulang DDL |

## Wajib backup sebelum...

- **Update** versi (lihat [UPDATE_GUIDE.md](UPDATE_GUIDE.md) langkah 1).
- **Migrasi** skema (`db push`) — lihat [MIGRATIONS.md](MIGRATIONS.md).
  Jalankan `backup.sh` manual dulu; entrypoint tidak mengambil snapshot
  otomatis (lihat `deploy/backup/README.md`).
- **Patch**/bugfix yang menyentuh DB (lihat [PATCH_GUIDE.md](PATCH_GUIDE.md)).
- **Rilis major** — lihat [VERSIONING.md](VERSIONING.md) untuk definisi
  major di repo ini (biasanya berarti migrasi data sekali-jalan non-idempotent
  — risiko tertinggi).

## Uji restore (wajib berkala, bukan sekali saat setup)

```bash
# 1) ambil backup
deploy/backup/backup.sh
# 2) catat satu baris data yang diketahui, lalu ubah/hapus di DB live (simulasi kehilangan)
# 3) restore dari backup
deploy/backup/restore.sh ./data/backups/pg-<stamp>.dump
# 4) verifikasi: /healthz 200 + baris yang tadi muncul kembali utuh
```
Kriteria lulus: verifikasi backup lulus (`pg_restore --list` sukses),
`/healthz=200`, data pasca-backup pulih sesuai snapshot. **Backup yang tak
pernah diuji bukan backup.** Jalankan rehearsal ini minimal bulanan.
