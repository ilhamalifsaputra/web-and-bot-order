# Backup & Restore — SQLite WAL (execution/06, M-5)

Stack ini memakai **satu** file SQLite `data/bot.db` dalam mode **WAL**
(`PRAGMA journal_mode=WAL`, `packages/db/src/client.ts`). Transaksi terbaru bisa
masih berada di `bot.db-wal` yang belum di-checkpoint — jadi **menyalin
`bot.db` mentah saat layanan jalan bisa kehilangan data**. Bukti nyata: pada
DB dev, `bot.db` ~405 KB sementara `bot.db-wal` bisa mencapai beberapa MB.

Solusi: `sqlite3 ".backup"` (online backup API) yang mengambil snapshot
**konsisten** termasuk isi `-wal`, tanpa downtime.

## Prasyarat (host VPS)

Skrip ini berjalan **di host**, tempat `./data` di-bind-mount. Pasang `sqlite3`
sekali:

```bash
sudo apt-get update && sudo apt-get install -y sqlite3
```

`sqlite3` **juga** ada di image runtime Docker (lihat `Dockerfile`), karena
`docker-entrypoint.sh` memanggil `backup.sh` di dalam container untuk mengambil
snapshot wajib sebelum menerapkan perubahan skema. Kalau paket itu hilang dari
image, entrypoint **menolak** mengubah skema (tidak ada perubahan skema tanpa
jalur rollback) — jadi jangan hapus dari `Dockerfile`.

## Backup otomatis sebelum perubahan skema

Selain cron di bawah, `backup.sh` dipanggil otomatis oleh
`docker-entrypoint.sh` **hanya ketika** skema DB berbeda dari `schema.prisma` —
tepat sebelum `prisma db push`. Hasilnya masuk ke `data/backups/` yang sama,
jadi `restore.sh` bisa langsung memakainya sebagai titik rollback migrasi.

Boot yang skemanya sudah cocok tidak mengambil snapshot apa pun, jadi
`docker compose restart` berulang (atau crash-loop) tidak menggerus retensi.
Detail lengkap: [../../docs/MIGRATIONS.md](../../docs/MIGRATIONS.md).

## Backup

```bash
deploy/backup/backup.sh
# atau dengan path produksi:
DB=/srv/app/data/bot.db DEST=/srv/backups RETENTION=28 deploy/backup/backup.sh
```

- **WAL-safe & zero-downtime** — `.backup` aman walau bot/web sedang menulis.
- **Diverifikasi** — `PRAGMA integrity_check` dijalankan pada hasil; gagal ⇒
  backup dihapus & exit non-zero (tak pernah menyimpan backup rusak).
- **Kompresi** — `gzip -k` membuat `.gz` untuk transfer off-box (file `.db`
  tetap ada untuk restore cepat).
- **Retensi** — simpan `RETENTION` backup terbaru (default 28); sisanya dipangkas.

### Jadwal (cron, tiap 6 jam)

`crontab -e`:

```cron
0 */6 * * * DB=/srv/app/data/bot.db DEST=/srv/backups /srv/app/deploy/backup/backup.sh >> /var/log/bot-backup.log 2>&1
```

### Off-box (aturan 3-2-1)

Uncomment salah satu baris di akhir `backup.sh` (rsync / `aws s3 cp`) agar
salinan keluar dari box. Backup yang hanya di disk yang sama hilang bersama box.

## Restore (juga = rollback deploy/migrasi buruk)

```bash
deploy/backup/restore.sh ./data/backups/bot-2026-06-18-1200.db
deploy/backup/restore.sh ./data/backups/bot-2026-06-18-1200.db.gz   # .gz juga bisa
```

Langkah (otomatis di skrip):
1. `integrity_check` pada **backup** dulu — abort sebelum menyentuh DB live bila rusak.
2. `docker compose stop server` (hentikan proses penulis DB).
3. Tulis `data/SKIP_AUTO_MIGRATE` — **menjeda auto-migrasi entrypoint**. Tanpa ini
   container akan mendeteksi backup lama itu "beda dari `schema.prisma`" lalu
   memigrasinya maju lagi saat start, sehingga rollback Anda batal.
4. Simpan DB saat ini ke `bot.db.pre-restore-<stamp>` (restore pun reversibel).
5. Salin backup → `bot.db`; **hapus `bot.db-wal`/`bot.db-shm` basi** (milik DB lama
   — bila dibiarkan akan merusak hasil restore).
6. `chown app:app` (samakan dgn user runtime container).
7. `integrity_check` pada DB hasil restore.
8. `docker compose start …` lalu smoke `GET /healthz` sampai 200.

### Setelah restore: lepas jedanya

Selama `data/SKIP_AUTO_MIGRATE` ada, **tidak ada** perubahan skema yang
diterapkan otomatis — termasuk pada deploy berikutnya. Itu disengaja (melindungi
rollback), tapi kalau dibiarkan Anda kembali ke masalah `P2022` yang justru
ingin dicegah. `restore.sh` mencetak pengingat, dan entrypoint menampilkan isi
file itu di log setiap start. Begitu kode yang jalan sudah cocok dengan skema DB:

```bash
rm ./data/SKIP_AUTO_MIGRATE
docker compose restart server
```

## RTO / RPO

| Metrik | Nilai | Catatan |
|---|---|---|
| **RPO** (kehilangan data maks) | ≤ 6 jam | = interval cron; rapatkan jadwal untuk RPO lebih kecil |
| **RTO** (waktu pulih) | ~1–2 menit | stop → swap file → integrity → start → healthz (DB satu toko, kecil) |

Uji restore **berkala** (mis. bulanan) ke DB throwaway — backup yang tak pernah
diuji bukan backup.

## Uji end-to-end (di staging — WAJIB sekali sebelum diandalkan)

> Tidak dijalankan dari mesin dev Windows ini: butuh `sqlite3` + Docker Linux.
> Sintaks kedua skrip sudah divalidasi (`bash -n`). Jalankan ini di staging VPS:

```bash
# 1) ambil backup
deploy/backup/backup.sh
# 2) catat satu baris data yang diketahui, lalu "rusak"/ubah DB live
#    (mis. hapus sebuah order) untuk mensimulasikan kehilangan
# 3) restore dari backup
deploy/backup/restore.sh ./data/backups/bot-<stamp>.db
# 4) verifikasi: /healthz 200 + baris yang tadi muncul kembali utuh
```

Kriteria lulus: `integrity_check=ok`, `/healthz=200`, data pasca-backup pulih
sesuai snapshot.

## Disiplin migrasi aman (D-01 — konteks, bukan bagian skrip)

Kolom non-null tanpa default pada DB berisi data ⇒ `P2022 column … does not
exist` saat kode baru jalan sebelum DB dimigrasi. Pola aman:

1. **Backup dulu** (`backup.sh`) — ini titik rollback.
2. Tambah kolom sebagai **nullable** (atau dengan default) → `pnpm prisma db push`.
3. **Backfill** nilai untuk baris lama.
4. Baru jadikan **non-null** bila perlu (push kedua).
5. **Migrasi DB live + restart layanan SEBELUM kode baru jalan** (CLAUDE.md).
6. Rollback bila gagal = `restore.sh <backup-terakhir>`.
