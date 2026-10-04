# Backup & Restore — PostgreSQL (execution/06, M-5)

Database toko adalah **PostgreSQL**. `backup.sh` mengambil dump `pg_dump -Fc`
(custom format) dan `restore.sh` memulihkannya dengan `pg_restore`; keduanya
dijalankan **di host**, sedangkan `pg_dump`/`pg_restore` sendiri berjalan
*di dalam* container `postgres` lewat `docker compose exec`, karena overlay
produksi (`docker-compose.postgres.prod.yml`) sengaja tidak mem-publish port
Postgres ke host. Ini juga cara skrip menghindari perlu membaca
`POSTGRES_PASSWORD` sama sekali — autentikasi terjadi lewat socket lokal
container, bukan lewat kredensial yang lewat jaringan atau tercetak di
log/skrip.

## Validasi input

- **`backup.sh`** membaca `DATABASE_URL_PRISMA` dari environment prosesnya
  (kunci ini sengaja tidak dibaca dari `.env`; dari `.env` skrip hanya
  mengambil `POSTGRES_USER`/`POSTGRES_DB`, lihat di bawah) hanya sebagai pagar
  pengaman:
  - kosong/unset, atau berawalan `postgres://` / `postgresql://` → lanjut
  - nilai lain → error keras (exit non-zero), karena aplikasi sendiri menolak
    start dengan URL seperti itu
- **`restore.sh`** hanya menerima file berekstensi **`.dump`**; ekstensi lain →
  error keras.

## Prasyarat (host VPS)

Skrip ini berjalan **di host**, sama seperti perintah `docker compose`
lainnya untuk stack ini. Keduanya **self-locating**: baris pertama setelah
`set -euo pipefail` melakukan `cd` ke root repo relatif terhadap lokasi
skrip itu sendiri, jadi boleh dipanggil dari direktori mana pun — termasuk
dari cron, yang menjalankan job dengan working directory `$HOME`. Ini yang
membuat skrip bekerja di cron sama sekali: perintah
`docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml`
memakai path file compose **relatif**, yang hanya bisa ditemukan dari root
repo.

Konsekuensinya: nilai `DEST=`/`DATA_DIR=` yang **relatif** ditafsirkan relatif
terhadap root repo, bukan terhadap direktori tempat Anda memanggil skrip.
(Path file backup yang diberikan sebagai argumen ke `restore.sh`
dikecualikan — itu di-resolve ke absolut lebih dulu, sebelum `cd`, sehingga
`restore.sh ./data/backups/x.dump` tetap berarti file yang barusan Anda
`ls`.) Path absolut seperti contoh produksi di bawah tidak terpengaruh sama
sekali.

Host hanya butuh **`docker`** (untuk `docker compose exec`). Data Postgres
hidup di named volume container, bukan `./data`. Tidak perlu memasang
`postgresql-client` di host: dump, restore, **dan verifikasi dump**
(`pg_restore --list`) semuanya dijalankan di dalam container `postgres`
lewat `docker compose exec`, dump-nya dikirim masuk lewat stdin.

Itu bukan sekadar penghematan paket — itu **wajib demi kebenaran**. Server-nya
`postgres:16-alpine` (lihat `docker-compose.postgres.yml` dan
`docker-compose.postgres.prod.yml`), sedangkan `apt-get install
postgresql-client` di beberapa distro masih memberi client PG14/PG15. Client
yang lebih tua **menolak** membaca dump `-Fc` buatan PG16 dengan pesan
`unsupported version ... in file header` — padahal dump-nya sehat. Kalau
verifikasi memakai binary host, `backup.sh` akan menganggap itu "dump rusak",
**menghapus backup-nya**, dan exit non-zero — berpotensi pada *setiap* run.
Client di dalam container selalu seversi dengan servernya, jadi masalah itu
tidak bisa terjadi.

Presence-check `docker` dijalankan otomatis di awal `backup.sh` dan
`restore.sh`; kalau hilang, skrip berhenti dengan pesan error yang jelas
sebelum menyentuh apa pun.

## Perubahan skema saat deploy

`docker-entrypoint.sh` menangani skema sepenuhnya: `auto_migrate()` menjalankan
`prisma db push` → seed chart of accounts ledger → migrasi data-only rilis
ini, jadi deploy cukup `docker compose ... up -d --build`. Lihat "Jalur
PostgreSQL" di [../../docs/MIGRATIONS.md](../../docs/MIGRATIONS.md).

**Snapshot pra-push: TIDAK otomatis, dan tetap tugas operator.** Skrip ini
mengambil dump dengan menjalankan `pg_dump` **di dalam** container `postgres`
lewat `docker compose exec` (lihat Prasyarat di atas) — sesuatu yang
container `server` tidak bisa lakukan dari dalam dirinya sendiri, karena ia
tidak punya akses ke Docker socket. Jadi jalankan `backup.sh` **di host
sebelum** deploy; itu satu-satunya titik rollback deploy tersebut, persis pola
D-01 di bagian bawah dokumen ini.

Yang tetap melindungi data dari push itu sendiri: `db push` dijalankan **tanpa**
`--accept-data-loss`, jadi perubahan yang akan membuang baris menggagalkan push
dan container menolak start — bukan menghapus lalu lanjut.

---

## Backup

```bash
deploy/backup/backup.sh
# atau dengan path produksi:
DEST=/srv/backups RETENTION=28 deploy/backup/backup.sh
```

- **`pg_dump -Fc`** — format custom (sudah terkompresi, bisa direstore
  selektif dengan `pg_restore`), dijalankan **di dalam** container `postgres`
  lewat `docker compose -f docker-compose.yml -f
  docker-compose.postgres.prod.yml exec -T postgres pg_dump -U
  "$POSTGRES_USER" -Fc "$POSTGRES_DB"`, hasilnya di-redirect ke file host.
  Kalau `pg_dump` gagal (container mati, dsb.), file hasil redirect yang
  terlanjur dibuat shell **dihapus eksplisit** sebelum skrip exit — file
  0-byte tidak boleh tertinggal, karena pemangkasan retensi murni berdasar
  urutan waktu dan akan menganggap stub terbaru itu sebagai backup yang
  layak disimpan, lalu memangkas backup sungguhan.
- **Diverifikasi** — `pg_restore --list` dijalankan pada hasil (tanpa perlu
  restore sungguhan ke DB scratch), **di dalam container `postgres`** (lihat
  Prasyarat di atas — client host yang lebih tua dari server akan salah
  menolak dump yang sehat); gagal ⇒ pesan error asli dari `pg_restore` ikut
  dicetak, backup dihapus, exit non-zero (tak pernah menyimpan backup rusak).
- **Tidak pernah membaca `POSTGRES_PASSWORD`** — autentikasi terjadi lewat
  socket lokal di dalam container via `docker compose exec`, bukan kredensial
  yang harus diketikkan ke skrip/env.
- **`POSTGRES_USER`/`POSTGRES_DB`** — urutan sumbernya: environment proses
  (kalau diset di sana), lalu `.env` di root repo (file yang sama yang dipakai
  `docker compose` untuk membuat container `postgres`), lalu default
  `bot_order`/`bot_order` (sama seperti fallback bawaan
  `docker-compose.postgres.prod.yml`). Jadi toko yang `.env`-nya memakai user/DB
  non-default otomatis ter-dump dari database yang benar, termasuk dari cron.
  `.env` **tidak di-`source`**: `deploy/backup/lib-env.sh` membacanya sebagai
  teks `KEY=VALUE` (mendukung `export `, kutip, komentar ` # ...`, CRLF), jadi
  isi seperti `$(...)` tidak pernah dieksekusi, dan hanya kunci yang dibutuhkan
  yang dibaca — `POSTGRES_PASSWORD` tidak pernah. **Jangan pernah
  menuliskan connection string Postgres lengkap dengan kredensial di
  dalamnya** di skrip cron atau dokumen mana pun — hanya `POSTGRES_USER`/
  `POSTGRES_DB` yang perlu diset sebagai env var operator, tidak pernah
  passwordnya.
- **Retensi** — simpan `RETENTION` dump terbaru (default 28), pola nama
  `pg-<stamp>.dump` (mis. `pg-2026-08-28-153000.dump`). Glob prune-nya
  sengaja `pg-[0-9]*.dump` (bukan `pg-*.dump`) — perhatikan ini kalau menulis
  tooling lain di sekitar folder backup: nama file backup asli selalu
  diawali tahun 4 digit tepat setelah `pg-`, sedangkan salinan pengaman
  pra-restore dari `restore.sh` bernama `pg-pre-restore-<stamp>.dump` (lihat
  bagian Restore di bawah). Glob yang lebih longgar akan ikut menghitung
  salinan pengaman itu ke kuota `RETENTION`, sehingga bisa memangkas backup
  sungguhan lebih awal dari seharusnya — glob saat ini secara khusus
  menghindari tabrakan itu.

### Jadwal (cron, tiap 6 jam)

`backup.sh` tidak mewajibkan `DATABASE_URL_PRISMA` sama sekali — ia hanya
menolak nilai yang bukan `postgres://`/`postgresql://` kalau variabel itu
ada. Cron tidak perlu memuat connection string atau kredensial apa pun.

Baris cron **tidak** perlu `cd /srv/app &&` di depannya: `backup.sh`
melakukan `cd` ke root repo sendiri (lihat Prasyarat di atas), jadi ia
menemukan file `docker-compose*.yml` walau cron menjalankannya dari `$HOME`.

`crontab -e`:

```cron
0 */6 * * * DEST=/srv/backups /srv/app/deploy/backup/backup.sh >> /var/log/bot-backup.log 2>&1
```

`POSTGRES_USER`/`POSTGRES_DB` tidak perlu ditambahkan di depan: skrip
membacanya sendiri dari `.env` repo. Set di depan hanya kalau sengaja ingin
mengalahkan nilai `.env`.

## Off-box (aturan 3-2-1)

Uncomment salah satu baris di akhir `backup.sh` (rsync / `aws s3 cp`) agar
salinan keluar dari box. Backup yang hanya di disk yang sama hilang bersama
box. Variabelnya (`$OFFBOX_FILE`) sudah otomatis mengarah ke file `.dump`
(sudah terkompresi lewat `-Fc`), jadi tidak perlu diubah manual.

---

## Restore (juga = rollback deploy/migrasi buruk)

```bash
deploy/backup/restore.sh ./data/backups/pg-2026-06-18-120000.dump
```

Argumennya harus berekstensi `.dump` (lihat "Validasi input" di atas).

Langkah (otomatis di skrip):
1. `pg_restore --list` pada **backup** dulu — dijalankan di dalam container
   `postgres` (dump dikirim lewat stdin), bukan dengan binary host, alasan
   versinya ada di Prasyarat di atas. Abort sebelum menyentuh DB live bila
   dump-nya rusak, dan pesan error asli `pg_restore` ikut dicetak.
2. `docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml stop server` (hentikan proses penulis DB; container
   `postgres` sendiri **tetap jalan**, hanya `server` yang dihentikan).
3. Simpan DB Postgres saat ini ke salinan pengaman `pg-pre-restore-<stamp>.dump`
   (lewat `pg_dump -Fc` sungguhan terhadap DB live yang masih aktif) —
   ditulis ke folder yang sama dengan file backup yang sedang direstore,
   sehingga restore pun reversibel. **File ini sengaja tidak ikut kena
   glob retensi `backup.sh`** — lihat catatan pola nama di bagian Backup di
   atas. Kalau dump pengaman ini gagal, file parsialnya dihapus dan skrip
   **abort sebelum me-restore apa pun** (DB live masih utuh; start ulang
   service dengan `docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml start server`) — restore tanpa titik balik
   bukan operasi yang reversibel.
4. `pg_restore --clean --if-exists --single-transaction -U "$POSTGRES_USER"
   -d "$POSTGRES_DB"` — dijalankan di dalam container `postgres` lewat
   `docker compose exec`, menerima dump lewat stdin. `--clean --if-exists`
   menghapus object lama sebelum me-restore ulang, tanpa error kalau object
   itu belum ada. **`--single-transaction` bukan opsional di sini:** tanpanya
   `pg_restore` exit 0 walau sebagian statement di dalam dump gagal — hanya
   mencetak error ke stderr lalu lanjut — sehingga DB yang setengah ter-restore
   akan lolos ke langkah 5, `/healthz` tetap 200, dan operator mengira
   rollback-nya sukses. Dengan flag itu seluruh restore dibungkus satu
   `BEGIN`/`COMMIT` (gagal ⇒ DB kembali ke keadaan **sebelum** restore, bukan
   setengah jadi) dan `--exit-on-error` ikut aktif, jadi kegagalan sungguhan
   benar-benar exit non-zero.
5. Tulis `data/SKIP_AUTO_MIGRATE` **sebelum** `server` dimulai lagi. Tanpa
   jeda, entrypoint langsung menjalankan `prisma db push` → seed chart of
   accounts → migrasi data-only pada database yang baru direstore dan dapat
   membatalkan rollback.
6. `docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml start …` lalu smoke `GET /healthz` di `WEB_PORT` sampai 200. Skrip
   mencetak pengingat pelepasan sentinel, baik smoke berhasil maupun gagal.

Semua panggilan `docker compose` di `restore.sh` (exec, stop, start) dan semua
perintah yang dicetaknya untuk operator memakai **kedua** file Compose.
`POSTGRES_USER`, `POSTGRES_DB`, `WEB_PORT`, dan `DATA_DIR` dibaca dengan urutan
yang sama seperti `backup.sh` (environment → `.env` repo → default), jadi smoke
test mengetes port toko ini sendiri di host multi-toko. `DATA_DIR` harus tetap
direktori yang di-bind-mount sebagai `/app/data` (default `./data`), karena di
situlah entrypoint mencari sentinel.

### Setelah restore: cocokkan kode, lalu lepas jedanya

Biarkan `data/SKIP_AUTO_MIGRATE` tetap ada sampai kode yang akan dijalankan
benar-benar cocok dengan skema dan data pada dump yang dipilih. Jika restore
dipakai untuk rollback deploy, kembalikan juga kode ke versi yang kompatibel;
health check 200 saja tidak membuktikan seluruh alur aplikasi cocok. Selama
sentinel ada, start/restart berikutnya **tidak** menjalankan schema push, seed,
atau migrasi data-only — termasuk pada deploy berikutnya. Itu disengaja
(melindungi rollback), tapi kalau dibiarkan Anda kembali ke masalah `P2022`
yang justru ingin dicegah. `restore.sh` mencetak pengingat, dan entrypoint
menampilkan isi file itu di log setiap start. Setelah versi kode/skema cocok
dan siap kembali ke alur update otomatis:

```bash
rm ./data/SKIP_AUTO_MIGRATE
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml restart server
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml logs --since 10m server | grep entrypoint
```

Baca log setelah restart: pada start tanpa sentinel, entrypoint kembali
menjalankan schema push → seed ledger → migrasi data-only. Jangan hapus
sentinel selama masih menjalankan kode yang tidak cocok dengan database
hasil restore.

---

## RTO / RPO

| Metrik | Nilai | Catatan |
|---|---|---|
| **RPO** (kehilangan data maks) | ≤ 6 jam | = interval cron; rapatkan jadwal untuk RPO lebih kecil |
| **RTO** (waktu pulih) | ~1–3 menit | stop → verifikasi/restore → start → healthz; `pg_restore --clean` menjalankan ulang DDL, tapi orde besarnya kecil (DB satu toko) |

Uji restore **berkala** (mis. bulanan) ke DB throwaway — backup yang tak pernah
diuji bukan backup.

## Uji end-to-end (di staging — WAJIB sekali sebelum diandalkan)

> Tidak dijalankan dari mesin dev Windows: butuh Docker Linux dan stack
> Postgres (`docker-compose.postgres.prod.yml`) yang sudah jalan. Tidak perlu
> `postgresql-client` di host — lihat Prasyarat. Sintaks skrip divalidasi
> dengan `bash -n`; `deploy/backup/test-restore-postgres.sh` dan
> `deploy/backup/test-backup-postgres.sh` menjalankan kedua skrip dengan Docker
> dan probe HTTP yang di-stub (termasuk pembacaan `.env` dan pemilihan file
> Compose). Jalankan ini di
> staging VPS:

```bash
# 1) ambil backup
deploy/backup/backup.sh
# 2) catat satu baris data yang diketahui, lalu "rusak"/ubah DB live
#    (mis. hapus sebuah order) untuk mensimulasikan kehilangan
# 3) restore dari backup
deploy/backup/restore.sh ./data/backups/pg-<stamp>.dump
# 4) verifikasi: /healthz 200 + baris yang tadi muncul kembali utuh
```

Kriteria lulus: verifikasi backup lulus (`pg_restore --list` sukses),
`/healthz=200`, data pasca-backup pulih sesuai snapshot.

## Disiplin migrasi aman (D-01 — konteks, bukan bagian skrip)

Kolom non-null tanpa default pada DB berisi data ⇒ `P2022 column … does not
exist` saat kode baru jalan sebelum DB dimigrasi. Pola aman:

1. **Backup dulu** (`backup.sh`) — ini titik rollback. Jalankan manual di host
   sebelum deploy, karena entrypoint tidak mengambil snapshot.
2. Tambah kolom sebagai **nullable** (atau dengan default) → `pnpm prisma db push`.
3. **Backfill** nilai untuk baris lama.
4. Baru jadikan **non-null** bila perlu (push kedua).
5. **Migrasi DB live + restart layanan SEBELUM kode baru jalan** (CLAUDE.md).
6. Rollback bila gagal = `restore.sh <backup-terakhir>`.

Satu hal yang **tidak** dicakup pendekatan snapshot berkala ini adalah
point-in-time recovery lewat WAL archiving berkelanjutan.
