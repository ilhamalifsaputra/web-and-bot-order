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
DB adalah **restore dari backup** lewat `restore.sh`, yang menerima file
`.dump` hasil `backup.sh` (detail penuh di
[deploy/backup/README.md](../deploy/backup/README.md)):

```bash
deploy/backup/restore.sh data/backups/pg-<stamp-sebelum-masalah>.dump
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

Skrip migrasi data sekali-jalan (bila sebuah rilis membawanya) **tidak
idempotent dan tidak punya mode undo**. Rollback satu-satunya: `restore.sh` ke backup yang diambil
**sebelum** skrip dijalankan (lihat instruksi wajib-backup di header skrip
itu sendiri dan di [UPDATE_GUIDE.md](UPDATE_GUIDE.md)).

## Rollback refactor Game Top-up

Refactor ini tidak punya migrasi (lihat [MIGRATIONS.md](MIGRATIONS.md)), jadi
rollback-nya hanya kode dan `.env`; DB tidak perlu di-restore.

1. **Kode:** di checkout utama (`master`), `git revert -m 1 <merge-commit>`
   (SHA merge belum diketahui: `<merge-commit>` diisi saat merge), lalu build
   dan restart order-bot dan web (Docker: `docker compose build` +
   `docker compose restart server`; non-Docker: `pnpm install && pm2 restart
   bot-order`).
2. **`.env`:** bila operator mengubah jendela bayar, kembalikan kelima kunci
   ke default KODE LAMA (`git show master:packages/core/src/config.ts`
   sebelum merge refactor). Nilai eksplisit di `.env` selalu menang atas default,
   jadi kunci yang tidak pernah diubah operator tidak perlu disentuh, tetapi
   defaultnya kembali ke nilai lama setelah revert:

   | Kunci | Default lama (rollback) | Default baru (refactor) |
   |---|---|---|
   | `PAYMENT_WINDOW_MINUTES` | `30` | `10` |
   | `INTERNAL_PAYMENT_WINDOW_MINUTES` | `15` | `10` |
   | `BYBIT_PAYMENT_WINDOW_MINUTES` | `30` | `10` |
   | `BYBIT_BSC_PAYMENT_WINDOW_MINUTES` | `15` | `30` |
   | `NOWPAYMENTS_PAYMENT_WINDOW_MINUTES` | `30` | `30` |

3. **Hanya pengingat bayar yang bermasalah?** Cukup `PAYMENT_REMINDER_LEAD_MINUTES=0`
   di `.env` lalu restart order-bot; tidak perlu rollback kode.

**Efek pada data yang sudah ada:**

- `Product.gameRegion` yang terisi oleh import atau backfill tetap terisi dan
  tidak berbahaya bagi kode lama (kolom sudah ada di `master`).
- Order yang dibuat selama jendela 10 menit mempertahankan `expiresAt`-nya;
  tidak ada yang di-restamp.
- Bubble pembayaran yang terbuka saat rollback membawa nonce di `callback_data`
  yang tidak dikenal kode lama: pembeli perlu satu ketukan tambahan (membuka
  ulang layar pembayaran). Tidak ada uang yang terpengaruh. (Perilaku ketukan
  ini disimpulkan dari desain, bukan diuji terhadap kode lama.)
- Klaim pembayaran `matched` yang macet kembali dipulihkan setelah 10 menit
  (bukan 120 detik) oleh kode lama; pada rail berjendela 10 menit crash
  di tengah pengiriman tidak bisa dipulihkan sebelum order dibatalkan.
- **Baris outbox `PAYMENT_REMINDER_DM` / `ORDER_EXPIRED_DM` yang masih
  `PENDING` saat rollback:** dispatcher lama tidak punya template untuk dua
  event itu (`render` mengembalikan teks kosong), sehingga barisnya dicatat
  `FAILED` dengan `lastError` `no template for event ...` pada percobaan
  pertama (`failRow(row, ..., 1)`). Tidak ada loop dan tidak ada pesan
  terkirim; pembeli hanya tidak menerima pengingat/pemberitahuan itu. Aman
  dibiarkan. Cek dengan `SELECT id, event, status, last_error FROM
  notification_outbox WHERE event IN ('PAYMENT_REMINDER_DM','ORDER_EXPIRED_DM')
  AND status IN ('PENDING','FAILED');`. Jangan menekan **Retry** di panel
  `/outbox` untuk baris ini: ia akan gagal lagi. (Disimpulkan dari
  pembacaan `master:packages/outbox-dispatcher/src/dispatcher.ts`; tidak
  dijalankan terhadap kode lama.)

## Restore dari backup (ringkasan — detail penuh di BACKUP_AND_RESTORE.md)

```bash
deploy/backup/restore.sh <path-backup>
```

Otomatis: verifikasi backup (`pg_restore --list`) → stop writer → simpan DB
saat ini sebagai salinan pengaman pra-restore (`pg-pre-restore-<stamp>.dump`,
restore sendiri reversibel) → terapkan backup ke DB live (`pg_restore --clean
--if-exists --single-transaction`, atomik — gagal ⇒ DB kembali ke keadaan
sebelum restore) → tulis sentinel `data/SKIP_AUTO_MIGRATE` → start →
smoke-test `/healthz`. Detail penuh:
[BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md).

## Recovery dari deployment yang gagal

| Gejala | Diagnosis | Recovery |
|---|---|---|
| Container tidak `healthy` setelah `docker compose up -d` | `docker compose logs --tail=100 server` | Biasanya `P2022`/`P2021` (lupa `db push`) atau `.env` salah — lihat [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| App crash loop pasca-update | Cek log crash handler (`registerCrashHandlers` — exit code 1 = crash, bukan stop bersih) | Rollback kode ke commit sebelumnya (lihat di atas), investigasi root cause sebelum coba lagi |
| Migrasi data setengah jalan (skrip non-idempotent terhenti) | Cek apakah baris yang sudah diproses skrip masih konsisten | **Jangan jalankan ulang skrip** — restore dari backup pra-skrip, baru ulangi dengan fix |
| Pembeli mengeluh pesanan Game Top-up dibatalkan terlalu cepat setelah deploy refactor | Cek `PAYMENT_WINDOW_MINUTES` dan empat kunci jendela lain di `.env`; bandingkan `expires_at` order dengan `created_at` | Jendela bayar kini 10 menit di TokoPay/PayDisini/Binance/Bybit UID. Setel nilai eksplisit di `.env` bila perlu, atau rollback kode (bagian "Rollback refactor Game Top-up") |
| Pembeli menerima pengingat bayar yang mengganggu / salah | Cek log order-bot dan `notification_outbox` event `PAYMENT_REMINDER_DM` | `PAYMENT_REMINDER_LEAD_MINUTES=0` lalu restart order-bot; tanpa rollback kode |
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
