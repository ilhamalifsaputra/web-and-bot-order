# Backup & Restore — SQLite & PostgreSQL (execution/06, M-5)

Stack saat ini memakai **PostgreSQL**. Bagian SQLite di bawah berlaku untuk
instalasi lama yang belum menyelesaikan cutover dari file `data/bot.db` mode
**WAL**; ikuti [runbook cutover](../../docs/POSTGRES_MIGRATION.md) untuk
memindahkannya ke PostgreSQL.
`backup.sh` dan `restore.sh` di folder ini adalah **skrip yang sama** untuk
kedua engine — keduanya mendeteksi otomatis mana yang aktif, jadi entri cron
dan kebiasaan operator tidak berubah saat cutover terjadi. Dokumen ini
menjelaskan kedua jalur.

Untuk SQLite: transaksi terbaru bisa masih berada di `bot.db-wal` yang belum
di-checkpoint — jadi **menyalin `bot.db` mentah saat layanan jalan bisa
kehilangan data**. Bukti nyata: pada DB dev, `bot.db` ~405 KB sementara
`bot.db-wal` bisa mencapai beberapa MB. Solusi: `sqlite3 ".backup"` (online
backup API) yang mengambil snapshot **konsisten** termasuk isi `-wal`, tanpa
downtime.

Untuk Postgres: `pg_dump -Fc` (custom format) dijalankan *di dalam* container
`postgres` lewat `docker compose exec`, karena overlay produksi
(`docker-compose.postgres.prod.yml`) sengaja tidak mem-publish port Postgres
ke host. Ini juga cara skrip menghindari perlu membaca `POSTGRES_PASSWORD`
sama sekali — autentikasi terjadi lewat socket lokal container, bukan lewat
kredensial yang lewat jaringan atau tercetak di log/skrip.

## Jalur mana yang aktif? (deteksi otomatis)

- **`backup.sh`** membaca `DATABASE_URL_PRISMA` (variabel yang sama yang
  dibaca aplikasi sendiri, lihat `packages/db`):
  - kosong/unset, atau berawalan `file:` → jalur **SQLite**
  - berawalan `postgres://` atau `postgresql://` → jalur **Postgres**
  - nilai lain → error keras (exit non-zero), tidak pernah diam-diam salah jalur
- **`restore.sh`** membaca **ekstensi file backup** yang diberikan sebagai
  argumen:
  - `.db` atau `.db.gz` → jalur **SQLite**
  - `.dump` → jalur **Postgres**
  - ekstensi lain → error keras

Praktiknya: sebelum cutover, `.env` tidak mengeset `DATABASE_URL_PRISMA` ke
`postgres(ql)://...` sama sekali (atau menyetelnya ke `file:...`), jadi
`backup.sh` tetap mengambil jalur SQLite tanpa perubahan apa pun di sisi
operator. Setelah cutover, `.env` produksi berisi
`DATABASE_URL_PRISMA=postgresql://...` (dibaca aplikasi & `docker compose`
untuk interpolasi variabel) dan `backup.sh` otomatis mengambil jalur Postgres
begitu env var itu terlihat oleh skrip — lihat catatan cron di bawah untuk
cara memastikan itu.

## Prasyarat (host VPS)

Skrip ini berjalan **di host**, sama seperti perintah `docker compose`
lainnya untuk stack ini. Keduanya **self-locating**: baris pertama setelah
`set -euo pipefail` melakukan `cd` ke root repo relatif terhadap lokasi
skrip itu sendiri, jadi boleh dipanggil dari direktori mana pun — termasuk
dari cron, yang menjalankan job dengan working directory `$HOME`. Ini yang
membuat jalur Postgres bekerja di cron sama sekali: perintah
`docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml`
memakai path file compose **relatif**, yang hanya bisa ditemukan dari root
repo.

Konsekuensinya: nilai `DB=`/`DEST=` yang **relatif** ditafsirkan relatif
terhadap root repo, bukan terhadap direktori tempat Anda memanggil skrip.
(Path file backup yang diberikan sebagai argumen ke `restore.sh`
dikecualikan — itu di-resolve ke absolut lebih dulu, sebelum `cd`, sehingga
`restore.sh ./data/backups/x.dump` tetap berarti file yang barusan Anda
`ls`.) Path absolut seperti contoh produksi di bawah tidak terpengaruh sama
sekali.

**Jalur SQLite** — `./data` di-bind-mount di host. Pasang `sqlite3` sekali:

```bash
sudo apt-get update && sudo apt-get install -y sqlite3
```

`sqlite3` **juga** ada di image runtime Docker (lihat `Dockerfile`), karena
`docker-entrypoint.sh` memanggil `backup.sh` di dalam container untuk mengambil
snapshot wajib sebelum menerapkan perubahan skema — **hanya pada jalur
SQLite** (lihat bagian berikutnya). Kalau paket itu hilang dari image,
entrypoint **menolak** mengubah skema (tidak ada perubahan skema tanpa jalur
rollback) — jadi jangan hapus dari `Dockerfile`.

**Jalur Postgres** — data Postgres hidup di named volume container, bukan
`./data`. Host hanya butuh **`docker`** (untuk `docker compose exec`).
Tidak perlu memasang `postgresql-client` di host: dump, restore, **dan
verifikasi dump** (`pg_restore --list`) semuanya dijalankan di dalam
container `postgres` lewat `docker compose exec`, dump-nya dikirim masuk
lewat stdin.

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

Presence-check per jalur (`sqlite3` untuk SQLite, `docker` untuk Postgres)
dijalankan otomatis di awal `backup.sh` dan `restore.sh`; kalau hilang, skrip
berhenti dengan pesan error yang jelas sebelum menyentuh apa pun.

## Backup otomatis sebelum perubahan skema (jalur SQLite saja)

Selain cron di bawah, `backup.sh` dipanggil otomatis oleh
`docker-entrypoint.sh` **hanya ketika** skema DB berbeda dari `schema.prisma` —
tepat sebelum `prisma db push`. Hasilnya masuk ke `data/backups/` yang sama,
jadi `restore.sh` bisa langsung memakainya sebagai titik rollback migrasi.

Boot yang skemanya sudah cocok tidak mengambil snapshot apa pun, jadi
`docker compose restart` berulang (atau crash-loop) tidak menggerus retensi.
Detail lengkap: [../../docs/MIGRATIONS.md](../../docs/MIGRATIONS.md).

Ini **khusus jalur SQLite**, dan setelah cutover ke Postgres pembagiannya
berubah — bukan lagi "tidak ada yang otomatis":

- **Perubahan skema: otomatis.** `auto_migrate()` sekarang menangani
  `postgresql://` sepenuhnya (`prisma db push` → seed chart of accounts ledger →
  migrasi data-only rilis ini), jadi deploy cukup
  `docker compose ... up -d --build`. Lihat "Jalur PostgreSQL" di
  [../../docs/MIGRATIONS.md](../../docs/MIGRATIONS.md).
- **Snapshot pra-push: TIDAK otomatis, dan tetap tugas operator.** Jalur Postgres
  di skrip ini mengambil dump dengan menjalankan `pg_dump` **di dalam** container
  `postgres` lewat `docker compose exec` (lihat Prasyarat di atas) — sesuatu yang
  container `server` tidak bisa lakukan dari dalam dirinya sendiri, karena ia tidak
  punya akses ke Docker socket. Jadi jalankan `backup.sh` **di host sebelum**
  deploy; itu satu-satunya titik rollback deploy tersebut, persis pola D-01 di
  bagian bawah dokumen ini.

Yang tetap melindungi data dari push itu sendiri: `db push` dijalankan **tanpa**
`--accept-data-loss`, jadi perubahan yang akan membuang baris menggagalkan push
dan container menolak start — bukan menghapus lalu lanjut.

---

## Backup — SQLite

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
- **Retensi** — simpan `RETENTION` backup terbaru (default 28), pola nama
  `bot-<stamp>.db`; sisanya dipangkas.

### Jadwal (cron, tiap 6 jam)

`crontab -e`:

```cron
0 */6 * * * DB=/srv/app/data/bot.db DEST=/srv/backups /srv/app/deploy/backup/backup.sh >> /var/log/bot-backup.log 2>&1
```

## Backup — Postgres

```bash
deploy/backup/backup.sh
# atau dengan path produksi:
DEST=/srv/backups RETENTION=28 deploy/backup/backup.sh
```

Jalur ini aktif otomatis begitu `DATABASE_URL_PRISMA` di environment skrip
berawalan `postgres://`/`postgresql://` (lihat "Jalur mana yang aktif?" di
atas) — tidak ada flag terpisah untuk memilihnya.

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
- **Diverifikasi** — `pg_restore --list` dijalankan pada hasil (padanan
  `PRAGMA integrity_check` untuk Postgres, tanpa perlu restore sungguhan ke
  DB scratch), **di dalam container `postgres`** (lihat Prasyarat di atas —
  client host yang lebih tua dari server akan salah menolak dump yang sehat);
  gagal ⇒ pesan error asli dari `pg_restore` ikut dicetak, backup dihapus,
  exit non-zero.
- **Tidak pernah membaca `POSTGRES_PASSWORD`** — autentikasi terjadi lewat
  socket lokal di dalam container via `docker compose exec`, bukan kredensial
  yang harus diketikkan ke skrip/env.
- **`POSTGRES_USER`/`POSTGRES_DB`** — dibaca dari env, default ke `bot_order`/
  `bot_order` masing-masing (sama seperti fallback bawaan
  `docker-compose.postgres.prod.yml`), jadi kalau produksi belum mengubah
  nilai default ini, tidak perlu di-override sama sekali. **Jangan pernah
  menuliskan connection string Postgres lengkap dengan kredensial di
  dalamnya** di skrip cron atau dokumen mana pun — hanya `POSTGRES_USER`/
  `POSTGRES_DB` yang perlu diset sebagai env var operator, tidak pernah
  passwordnya.
- **Retensi** — simpan `RETENTION` dump terbaru (default 28, sama dengan
  jalur SQLite), pola nama `pg-<stamp>.dump` (mis.
  `pg-2026-08-28-153000.dump`). Glob prune-nya sengaja `pg-[0-9]*.dump`
  (bukan `pg-*.dump`) — perhatikan ini kalau menulis tooling lain di sekitar
  folder backup: nama file backup asli selalu diawali tahun 4 digit tepat
  setelah `pg-`, sedangkan salinan pengaman pra-restore dari `restore.sh`
  bernama `pg-pre-restore-<stamp>.dump` (lihat bagian Restore — Postgres di
  bawah). Glob yang lebih longgar akan ikut menghitung salinan pengaman itu
  ke kuota `RETENTION`, sehingga bisa memangkas backup sungguhan lebih awal
  dari seharusnya — glob saat ini secara khusus menghindari tabrakan itu.

### Jadwal (cron, tiap 6 jam)

`detect_engine()` di `backup.sh` membaca `DATABASE_URL_PRISMA` dari
environment proses skrip itu sendiri saat runtime — bukan otomatis dari
`.env` (yang hanya dibaca `docker compose` untuk interpolasi variabelnya
sendiri). Pola `VAR=value` di depan pemanggilan skrip pada baris crontab
yang sama **bekerja normal** di sini — persis seperti `DB=`/`DEST=` pada
contoh SQLite di atas — karena skrip membaca `$DATABASE_URL_PRISMA` lewat
ekspansi variabelnya sendiri di proses terpisah, bukan sebagai teks literal
yang perlu di-expand dalam baris crontab yang sama.

Baris cron **tidak** perlu `cd /srv/app &&` di depannya: `backup.sh`
melakukan `cd` ke root repo sendiri (lihat Prasyarat di atas), jadi ia
menemukan file `docker-compose*.yml` walau cron menjalankannya dari `$HOME`.

`detect_engine()` hanya mencocokkan **awalan** `DATABASE_URL_PRISMA`
(`postgres://`/`postgresql://`) untuk memilih jalur — nilainya sendiri tidak
pernah dipakai untuk koneksi (autentikasi lewat `docker compose exec`, lihat
di atas). Jadi entri cron **tidak perlu** memuat connection string
sungguhan/kredensial sama sekali, cukup nilai apa pun yang berawalan
`postgresql://`:

```cron
0 */6 * * * DATABASE_URL_PRISMA=postgresql://engine-marker DEST=/srv/backups /srv/app/deploy/backup/backup.sh >> /var/log/bot-backup.log 2>&1
```

Kalau lebih suka memakai nilai `.env` produksi yang sesungguhnya (fungsinya
sama — hanya awalannya yang dibaca), source saja filenya sebelum memanggil
skrip; ini tidak pernah mencetak isinya ke mana pun. Di varian ini `cd
/srv/app` tetap diperlukan — bukan demi skripnya (ia tetap `cd` sendiri),
melainkan supaya `. ./.env` menemukan file `.env`-nya:

```cron
0 */6 * * * cd /srv/app && set -a && . ./.env && set +a && deploy/backup/backup.sh >> /var/log/bot-backup.log 2>&1
```

## Off-box (aturan 3-2-1) — kedua jalur

Uncomment salah satu baris di akhir `backup.sh` (rsync / `aws s3 cp`) agar
salinan keluar dari box. Backup yang hanya di disk yang sama hilang bersama
box. Variabelnya (`$OFFBOX_FILE`) sudah otomatis mengarah ke file yang benar
untuk jalur yang aktif — `.db.gz` untuk SQLite, `.dump` (sudah terkompresi
lewat `-Fc`) untuk Postgres — jadi tidak perlu diubah manual per engine.

---

## Restore — SQLite (juga = rollback deploy/migrasi buruk)

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

## Restore — Postgres (juga = rollback deploy/migrasi buruk)

```bash
deploy/backup/restore.sh ./data/backups/pg-2026-06-18-120000.dump
```

Terdeteksi otomatis dari ekstensi `.dump` (lihat "Jalur mana yang aktif?" di
atas) — argumen yang sama seperti SQLite, tidak ada flag tambahan.

Langkah (otomatis di skrip):
1. `pg_restore --list` pada **backup** dulu — dijalankan di dalam container
   `postgres` (dump dikirim lewat stdin), bukan dengan binary host, alasan
   versinya ada di Prasyarat di atas. Abort sebelum menyentuh DB live bila
   dump-nya rusak, dan pesan error asli `pg_restore` ikut dicetak.
2. `docker compose stop server` (hentikan proses penulis DB; container
   `postgres` sendiri **tetap jalan**, hanya `server` yang dihentikan).
3. Simpan DB Postgres saat ini ke salinan pengaman `pg-pre-restore-<stamp>.dump`
   (lewat `pg_dump -Fc` sungguhan terhadap DB live yang masih aktif) —
   ditulis ke folder yang sama dengan file backup yang sedang direstore,
   sehingga restore pun reversibel. **File ini sengaja tidak ikut kena
   glob retensi `backup.sh`** — lihat catatan pola nama di bagian Backup —
   Postgres di atas. Kalau dump pengaman ini gagal, file parsialnya dihapus
   dan skrip **abort sebelum me-restore apa pun** (DB live masih utuh; start
   ulang service dengan `docker compose start server`) — restore tanpa titik
   balik bukan operasi yang reversibel.
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
5. `docker compose start …` lalu smoke `GET /healthz` sampai 200.

**Tidak ada sentinel `SKIP_AUTO_MIGRATE` di jalur ini** — tidak diperlukan.
`docker-entrypoint.sh`'s `auto_migrate()` sudah no-op total (tidak pernah
menjalankan `prisma db push` otomatis) untuk `DATABASE_URL_PRISMA` yang bukan
`file:...`, jadi tidak ada risiko container "memigrasi maju lagi" DB Postgres
yang baru direstore — beda dengan jalur SQLite yang butuh jeda eksplisit.
`restore.sh` juga tidak mencetak pengingat pelepasan sentinel untuk jalur ini
(pengingatnya khusus SQLite).

---

## RTO / RPO

| Metrik | SQLite | Postgres | Catatan |
|---|---|---|---|
| **RPO** (kehilangan data maks) | ≤ 6 jam | ≤ 6 jam | = interval cron pada kedua jalur; rapatkan jadwal untuk RPO lebih kecil |
| **RTO** (waktu pulih) | ~1–2 menit | ~1–3 menit | stop → verifikasi/salin/restore → start → healthz; Postgres sedikit lebih lama karena `pg_restore --clean` menjalankan ulang DDL, tapi orde besarnya sama (DB satu toko, kecil) |

Uji restore **berkala** (mis. bulanan) ke DB throwaway — backup yang tak pernah
diuji bukan backup. Berlaku untuk kedua jalur.

## Uji end-to-end (di staging — WAJIB sekali sebelum diandalkan)

> Tidak dijalankan dari mesin dev Windows ini: butuh Docker Linux, dan untuk
> jalur SQLite juga `sqlite3`; untuk jalur Postgres cukup Docker (tidak perlu
> `postgresql-client` di host — lihat Prasyarat) plus stack Postgres
> (`docker-compose.postgres.prod.yml`) sudah jalan. Sintaks kedua skrip sudah
> divalidasi (`bash -n`). Jalankan ini di staging VPS:

**SQLite:**

```bash
# 1) ambil backup
deploy/backup/backup.sh
# 2) catat satu baris data yang diketahui, lalu "rusak"/ubah DB live
#    (mis. hapus sebuah order) untuk mensimulasikan kehilangan
# 3) restore dari backup
deploy/backup/restore.sh ./data/backups/bot-<stamp>.db
# 4) verifikasi: /healthz 200 + baris yang tadi muncul kembali utuh
```

**Postgres** (setelah cutover, `DATABASE_URL_PRISMA` sudah menunjuk Postgres):

```bash
# 1) ambil backup
deploy/backup/backup.sh
# 2) catat satu baris data yang diketahui, lalu "rusak"/ubah DB live
#    (mis. hapus sebuah order) untuk mensimulasikan kehilangan
# 3) restore dari backup
deploy/backup/restore.sh ./data/backups/pg-<stamp>.dump
# 4) verifikasi: /healthz 200 + baris yang tadi muncul kembali utuh
```

Kriteria lulus (kedua jalur): verifikasi backup lulus (`integrity_check=ok`
untuk SQLite, `pg_restore --list` sukses untuk Postgres), `/healthz=200`,
data pasca-backup pulih sesuai snapshot.

## Disiplin migrasi aman (D-01 — konteks, bukan bagian skrip)

Kolom non-null tanpa default pada DB berisi data ⇒ `P2022 column … does not
exist` saat kode baru jalan sebelum DB dimigrasi. Berlaku untuk kedua engine.
Pola aman:

1. **Backup dulu** (`backup.sh`) — ini titik rollback. Pada jalur SQLite ini
   juga terjadi otomatis lewat `docker-entrypoint.sh` (lihat bagian di atas);
   pada jalur Postgres, jalankan manual sebelum `prisma db push` karena
   entrypoint tidak melakukannya secara otomatis untuk engine ini.
2. Tambah kolom sebagai **nullable** (atau dengan default) → `pnpm prisma db push`.
3. **Backfill** nilai untuk baris lama.
4. Baru jadikan **non-null** bila perlu (push kedua).
5. **Migrasi DB live + restart layanan SEBELUM kode baru jalan** (CLAUDE.md).
6. Rollback bila gagal = `restore.sh <backup-terakhir>`.

## Lihat juga

[../../docs/POSTGRES_MIGRATION.md](../../docs/POSTGRES_MIGRATION.md) adalah
runbook lengkap untuk cutover SQLite → Postgres itu sendiri (bukan dokumen
ini — dokumen ini hanya tentang backup/restore harian di kedua sisi). §3-nya
memakai `backup.sh` untuk mengambil snapshot SQLite terakhir sebelum cutover
dimulai; §8a membahas memindahkan entri cron produksi dari SQLite ke Postgres
setelah cutover selesai — cukup menukar env var di depan `backup.sh`, tanpa
tooling atau slot cron baru. §8a merujuk balik ke dokumen ini untuk detail
jalur Postgres, dan menegaskan bahwa `backup.sh` sudah menangani retensi,
verifikasi dump, dan salinan off-box untuk Postgres persis seperti untuk
SQLite; bagian "Backup — Postgres" dan "Restore — Postgres" di atas adalah
penjelasan lengkapnya. Satu hal yang tetap **tidak** dicakup pendekatan
snapshot berkala ini — di sini maupun di §8a — adalah point-in-time recovery
lewat WAL archiving berkelanjutan; itu di luar lingkup engine-swap.
