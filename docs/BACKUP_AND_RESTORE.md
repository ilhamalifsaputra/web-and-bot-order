# Backup & Restore

Stack ini punya **dua hal stateful** yang perlu dibackup: database SQLite
(`data/bot.db`) dan file upload (`data/uploads/`). **Tidak ada Redis** —
tidak ada state cache eksternal untuk dibackup.

## Database backup

Detail penuh skrip ada di `deploy/backup/README.md` — ringkasan operasional:

```bash
deploy/backup/backup.sh
# atau path produksi:
DB=/srv/app/data/bot.db DEST=/srv/backups RETENTION=28 deploy/backup/backup.sh
```

**Mengapa tidak `cp data/bot.db`:** DB memakai mode **WAL** — transaksi
terbaru bisa masih di `bot.db-wal` yang belum di-checkpoint. Copy file mentah
saat service jalan **bisa kehilangan data**. `backup.sh` memakai
`sqlite3 ".backup"` (online backup API SQLite) yang mengambil snapshot
konsisten termasuk isi `-wal`, **zero-downtime**.

Yang dilakukan skrip (`deploy/backup/backup.sh`):
1. `.backup` ke file timestamped (`bot-<tanggal>-<jam>.db`).
2. `PRAGMA integrity_check` pada hasil — gagal ⇒ backup dihapus, exit
   non-zero (**tidak pernah** menyimpan backup yang rusak).
3. `gzip -k` (file `.db` asli tetap ada untuk restore cepat).
4. Retensi: simpan `RETENTION` backup terbaru (default 28), sisanya dipangkas.

**Prasyarat host:** `sqlite3` tidak ada di image Docker runtime — skrip
jalan di **host** (tempat `./data` di-bind-mount), bukan di dalam container:
```bash
sudo apt-get update && sudo apt-get install -y sqlite3
```

**Jadwal (cron, tiap 6 jam):**
```cron
0 */6 * * * DB=/srv/app/data/bot.db DEST=/srv/backups /srv/app/deploy/backup/backup.sh >> /var/log/bot-backup.log 2>&1
```

## Uploads backup

`data/uploads/` (foto produk, branding, dokumen) **tidak tercakup**
`backup.sh` — backup terpisah, biasanya cukup `tar`/`rsync` biasa (bukan file
database, tidak butuh konsistensi WAL):

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
`deploy/backup/backup.sh`:

```bash
# rsync -a "$OUT.gz" backups@offsite:/srv/bot-backups/
# aws s3 cp "$OUT.gz" "s3://my-bucket/bot-backups/"
```

## Restore procedure

```bash
deploy/backup/restore.sh ./data/backups/bot-2026-06-18-1200.db
deploy/backup/restore.sh ./data/backups/bot-2026-06-18-1200.db.gz   # .gz juga bisa
```

Langkah otomatis di skrip:
1. `integrity_check` pada **file backup** dulu — abort sebelum menyentuh DB
   live bila ternyata rusak.
2. `docker compose stop server` (hentikan satu-satunya proses penulis DB).
3. Simpan DB saat ini ke `bot.db.pre-restore-<stamp>` — restore sendiri tetap
   reversibel.
4. Salin backup → `bot.db`; hapus `bot.db-wal`/`bot.db-shm` basi (milik DB
   lama — kalau dibiarkan, merusak hasil restore).
5. `chown app:app` (samakan dengan user runtime container).
6. `integrity_check` pada DB hasil restore.
7. `docker compose start ...` lalu smoke-test `GET /healthz` sampai 200.

## Disaster recovery

| Skenario | Langkah |
|---|---|
| Host VPS mati total, ada off-box backup | Provision VPS baru → clone repo → `restore.sh` dari backup off-box → restore `uploads/` dari rsync/tar terakhir → `docker compose up -d` → update DNS jika IP berubah |
| DB korup (integrity_check gagal di live) | `docker compose stop server` → `restore.sh <backup-terakhir-yang-valid>` → terima kehilangan data sejak backup terakhir (lihat RPO di bawah) |
| Migrasi/deploy gagal di tengah jalan | Lihat [ROLLBACK.md](ROLLBACK.md) — `restore.sh` ke backup pra-migrasi adalah jalur utama |
| `uploads/` terhapus tidak sengaja | Restore dari tar/rsync terakhir — gambar yang hilang sejak backup terakhir kembali ke fallback (Unsplash map / placeholder) sampai admin upload ulang |

## RTO / RPO

| Metrik | Nilai | Catatan |
|---|---|---|
| **RPO** (kehilangan data maksimum) | ≤ 6 jam | = interval cron backup; perapat jadwal untuk RPO lebih kecil |
| **RTO** (waktu pulih) | ~1–2 menit | stop → swap file → integrity check → start → healthz (DB satu toko, kecil) |

## Wajib backup sebelum...

- **Update** versi (lihat [UPDATE_GUIDE.md](UPDATE_GUIDE.md) langkah 1).
- **Migrasi** skema (`db push`) — lihat [MIGRATIONS.md](MIGRATIONS.md).
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
deploy/backup/restore.sh ./data/backups/bot-<stamp>.db
# 4) verifikasi: /healthz 200 + baris yang tadi muncul kembali utuh
```
Kriteria lulus: `integrity_check=ok`, `/healthz=200`, data pasca-backup pulih
sesuai snapshot. **Backup yang tak pernah diuji bukan backup.** Jalankan
rehearsal ini minimal bulanan.
