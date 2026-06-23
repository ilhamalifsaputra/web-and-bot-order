# Rollback

## Rollback kode

```bash
git log --oneline -10                 # cari commit terakhir yang baik
git checkout <commit-lama>            # atau: git revert <commit-buruk> untuk rollback non-destructive
docker compose build                  # jika Docker
docker compose restart server
# non-Docker: pnpm install && pm2 restart bot-order
```

Pilih `git revert` (membuat commit baru yang membalikkan perubahan) bukan
`git reset --hard` ketika riwayat sudah di-push/dibagikan — `reset --hard`
menghilangkan commit dari riwayat lokal dan berisiko di tim yang berbagi
branch. Untuk instance produksi yang deploy dari satu branch tunggal,
`git checkout <commit>` (detached) ke commit lama lalu deploy dari sana juga
valid sebagai mitigasi cepat sebelum revert resmi disiapkan.

## Rollback database

**Database tidak punya "undo" granular** (tidak ada migration history
formal — lihat [MIGRATIONS.md](MIGRATIONS.md)). Satu-satunya jalur rollback
DB adalah **restore dari backup**:

```bash
deploy/backup/restore.sh data/backups/bot-<stamp-sebelum-masalah>.db
```

Ini mengembalikan **seluruh** isi DB ke titik backup — termasuk order/
pembayaran yang masuk SETELAH backup itu akan hilang. Untuk masalah yang
hanya menyentuh satu fitur/tabel, pertimbangkan dulu apakah perbaikan manual
via panel admin (mis. requeue notifikasi, retry pembayaran) lebih murah
daripada kehilangan semua transaksi sejak backup terakhir — lihat
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) untuk kasus yang tidak butuh
restore penuh.

## Rollback migrasi skema

Karena mekanisme yang dipakai adalah `db push` (lihat
[MIGRATIONS.md](MIGRATIONS.md)), "rollback migrasi" dalam praktik berarti
salah satu dari:

1. **Kolom/tabel additive yang baru ditambah** (aman dibiarkan, tidak ada
   downside) — cukup rollback KODE-nya (kode lama mengabaikan kolom baru);
   TIDAK perlu menyentuh DB.
2. **Perubahan destruktif** (rename/drop kolom, NOT NULL baru) — **wajib**
   `restore.sh` ke backup pra-migrasi. Tidak ada `db push` versi mundur yang
   bisa "un-rename" kolom dengan aman tanpa kehilangan data yang ditulis
   setelah rename.

## Rollback skrip migrasi data sekali-jalan

Skrip seperti `migrate-catalog-rename.ts` **tidak idempotent dan tidak punya
mode undo**. Rollback satu-satunya: `restore.sh` ke backup yang diambil
**sebelum** skrip dijalankan (lihat instruksi wajib-backup di header skrip
itu sendiri dan di [UPDATE_GUIDE.md](UPDATE_GUIDE.md)).

## Restore dari backup (ringkasan — detail penuh di BACKUP_AND_RESTORE.md)

```bash
deploy/backup/restore.sh <path-backup>
```

Otomatis: integrity-check backup → stop writer → simpan DB saat ini sebagai
`bot.db.pre-restore-<stamp>` (restore sendiri reversibel) → swap file →
hapus `-wal`/`-shm` basi → integrity-check hasil → start → smoke-test
`/healthz`. Detail penuh: [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md).

## Recovery dari deployment yang gagal

| Gejala | Diagnosis | Recovery |
|---|---|---|
| Container tidak `healthy` setelah `docker compose up -d` | `docker compose logs --tail=100 server` | Biasanya `P2022`/`P2021` (lupa `db push`) atau `.env` salah — lihat [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| App crash loop pasca-update | Cek log crash handler (`registerCrashHandlers` — exit code 1 = crash, bukan stop bersih) | Rollback kode ke commit sebelumnya (lihat di atas), investigasi root cause sebelum coba lagi |
| Migrasi data setengah jalan (skrip non-idempotent terhenti) | Cek apakah baris yang sudah diproses skrip masih konsisten | **Jangan jalankan ulang skrip** — restore dari backup pra-skrip, baru ulangi dengan fix |
| 502 dari nginx pasca-deploy | Lihat "502 runbook" di `deploy/README.md` | `docker compose restart server`, verifikasi `/healthz` lokal dulu sebelum lewat nginx |

## Verifikasi pasca-rollback

```bash
docker compose ps                        # service "Up"/"healthy"
curl -I https://admin.contoh.com/healthz  # 200
curl -I https://admin.contoh.com/login    # 200
```
Konfirmasi juga: order/pembayaran yang masuk di antara waktu backup dan
waktu rollback **tidak otomatis tercatat ulang** — cek panel `/orders` dan
`/outbox` untuk transaksi yang perlu direkonsiliasi manual pasca-restore.
