# Migrasi Database

## Riwayat migrasi: baseline PostgreSQL

`prisma/migrations/` dimulai dari satu migrasi baseline,
`20260827050616_postgresql_baseline/migration.sql`, dibuat dengan:

```bash
prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

Perintah itu murni membandingkan schema ke schema dan **tidak menyentuh
database apa pun**. Baseline tidak ditandai `--applied` di
`_prisma_migrations` — konsisten dengan premis halaman ini: tabel tersebut
tidak dipercaya sebagai catatan skema yang diterapkan, karena `db push` tidak
pernah menulisinya. Setiap perubahan `schema.prisma` sesudahnya perlu migrasi
SQL baru di `prisma/migrations/` relatif terhadap baseline itu (lihat "Cara
membuat migrasi" di bawah).

`migration_lock.toml` di `prisma/migrations/` ber-provider `postgresql`.
`pnpm run check-migration-drift` memanggil `scripts/check-migration-drift.ts`,
yang membangun `--shadow-database-url` dari `DATABASE_URL_PRISMA` +
`?schema=_migration_diff_shadow` — schema terpisah di dalam database dev yang
sama, karena `prisma migrate diff --from-migrations` di PostgreSQL menolak
jalan tanpa shadow database eksplisit. Role `bot_order` (lihat
`docker-compose.postgres.yml`) sudah cukup berhak membuat dan mengisi ulang
schema itu di setiap run.

## Mekanisme yang SEBENARNYA dipakai repo ini: `db push`, bukan `migrate deploy`

Repo ini punya folder `prisma/migrations/*` (SQL terurut, ada history),
**tapi** seluruh dokumentasi operasional (`README.md`, `DOCS.md`, `CLAUDE.md`,
`deploy/backup/README.md`, CI) secara konsisten memerintahkan
**`pnpm exec prisma db push`** untuk menerapkan perubahan skema — bukan
`prisma migrate deploy`. Ini bukan kelalaian dokumentasi: untuk satu
instance tanpa tim multi-developer yang butuh history migrasi formal,
`db push` (sinkronisasi langsung schema→DB, tanpa file SQL incremental) lebih
sederhana dan itulah yang dipakai mulai instalasi awal sampai update rutin.

**Implikasi penting:** tabel `_prisma_migrations` (yang biasanya dipakai
Prisma melacak migrasi mana yang sudah jalan) **TIDAK bisa dipercaya** sebagai
catatan "skema mana yang sudah diterapkan" di DB manapun di repo ini —
`db push` tidak menulis baris ke tabel itu. Folder `prisma/migrations/*`
berfungsi sebagai **dokumentasi/audit-trail SQL**, bukan mekanisme penerapan
yang dijalankan otomatis. Sebagian batch (mis. Infra-5/Pricing-1, lihat
komentar di `docs/archive/audit-security-2026-06-23.md`) memang dibuat & divalidasi
byte-identik via `prisma migrate diff` terhadap shadow DB saat fitur
ditambahkan — **tapi itu bukan jaminan yang berlaku untuk seluruh folder.**
H-8 (2026-08-01) membuktikan sebaliknya: 12+ kolom dan 2 index nyata-nyata
ada di `schema.prisma` tanpa SQL apa pun di `prisma/migrations/` selama
berminggu-minggu sebelum ketahuan — drift ini terjadi persis karena tidak
ada mekanisme yang benar-benar mengecek klaim "sudah divalidasi" itu setiap
kali `schema.prisma` berubah. Sejak commit yang menambahkan bagian "Cek
drift migrasi-vs-schema di CI" di bawah, klaim byte-identik sekarang
**ditegakkan otomatis** (`pnpm run check-migration-drift`, di CI dan sebagai
`pretest`) — sebelum itu, klaim tersebut hanya sekuat disiplin manual
penulisnya di commit saat itu, per-batch, tidak diverifikasi ulang.

## Cek drift migrasi-vs-schema di CI

Karena `db push` tidak pernah menulis file SQL, folder `prisma/migrations/*`
bisa diam-diam ketinggalan di belakang `schema.prisma` — kolom/index baru
ditambahkan ke schema dan di-`db push`-kan ke DB dev, tapi tidak ada folder
migrasi yang mendokumentasikannya. Akibatnya `prisma migrate deploy` terhadap
DB kosong gagal `P2022` pada tabel yang kolomnya tidak punya SQL.

Untuk mencegah drift tanpa ketahuan, `pnpm run check-migration-drift`
(`prisma migrate diff --from-migrations ./prisma/migrations
--to-schema-datamodel ./prisma/schema.prisma --exit-code`, lewat
`scripts/check-migration-drift.ts`) punya dua tempat jalan: sebagai step CI
("Migration drift check" di `.github/workflows/ci.yml` — tapi lihat catatan di
bawah, workflow ini nonaktif hari ini), dan sebagai `pretest` di root
`package.json`, jadi `pnpm test` menjalankannya duluan setiap kali — inilah
yang SUNGGUH-SUNGGUH menegakkan drift-check ini hari ini, bukan CI. Keduanya
**gagal (exit code 2)** kalau `schema.prisma` dan `prisma/migrations/*` tidak
sinkron. Kalau merah: jalankan command yang sama tanpa `--exit-code`
(tambahkan `--script`) untuk melihat SQL-nya, review, lalu simpan sebagai
folder migrasi baru dengan timestamp setelah folder terakhir.

**Catatan:** CI workflow saat ini nonaktif (`workflow_dispatch` saja, akun
GitHub Actions terkunci karena billing — lihat komentar di
`.github/workflows/ci.yml`). Sampai dipulihkan, jalankan
`pnpm run check-migration-drift` manual sebelum PR yang mengubah
`schema.prisma`.

## Cek tabrakan timestamp antar folder migrasi

Prisma menerapkan `prisma/migrations/*` berurutan menurut **nama folder
lengkap** secara leksikografis. Kalau dua folder punya timestamp yang sama,
urutan pasangan itu ditentukan oleh slug deskriptif di belakang underscore —
sesuatu yang tidak pernah dipilih siapa pun dengan mempertimbangkan urutan.

`pnpm run check-migration-timestamps` (`scripts/check-migration-timestamps.ts`)
gagal dengan exit code 1 kalau ada timestamp ganda di luar allowlist, dan ikut
jalan sebagai bagian `pretest` (bersama drift check). Allowlist-nya menyimpan
**nama folder yang persis**, bukan sekadar timestamp-nya, dan menuntut
kesetaraan himpunan — saat ini kosong, karena tidak ada pasangan yang
bertabrakan. Jangan me-rename folder migrasi yang sudah pernah diterapkan:
itu merusak pelacakan `_prisma_migrations` di DB mana pun yang sudah
menjalankannya dengan nama lama.

## Catatan per migrasi: `20261008090000_transaction_payment_credit_state`

Migrasi ini menambah enam kolom nullable pada `orders` untuk status pembayaran,
kredit wallet, dan audit penyelesaian admin, serta unique index
`fulfillment_messages(chat_id, message_id)`. Nomor order dan isi ledger tetap
menggunakan source of truth existing. Baris dengan `message_id = NULL` tetap
dapat dicatat sebelum layar pembayaran Telegram diakui.

**Urutan penerapan:** cek bahwa tidak ada pasangan `chat_id, message_id`
non-null yang dimiliki lebih dari satu order, terapkan SQL berikut pada database
target yang belum memiliki perubahan ini, lalu regenerate Prisma client sebelum
menjalankan kode baru:

```bash
pnpm exec prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261008090000_transaction_payment_credit_state/migration.sql
pnpm exec prisma generate
```

`db push` dapat berhenti pada peringatan unique constraint meskipun preflight
tidak menemukan duplikasi. Gunakan SQL additive yang sudah ditinjau di atas,
tanpa `--accept-data-loss`. Sesudah SQL diterapkan, sinkronisasi skema rutin
melalui entrypoint Docker tetap dapat berjalan. File ini tidak idempoten;
jangan jalankan ulang pada database yang sudah memiliki kolom dan index tersebut.

Entrypoint Docker sekarang otomatis menjalankan
`deploy/sql/fulfillment-message-unique-index.sql` sebelum `db push`. Script ini
idempoten: pada database kosong langkah ini dilewati, sedangkan pada tabel
existing script mengunci penulisan sementara, memeriksa duplikasi pasangan
non-null, lalu membuat unique index jika belum ada. Tidak ada baris yang diubah
atau dihapus. Jika ada duplikasi atau SQL gagal, container tidak akan start dan
error menjelaskan penyebabnya. Setelah index siap, `db push` menerapkan kolom
lainnya dengan perlindungan data-loss tetap aktif.

Entrypoint tidak menjalankan `migrate deploy`, sesuai mekanisme `db push` repo
ini. Ini menghindari P3005 pada database existing tanpa baseline riwayat Prisma.
Untuk menerapkan perbaikan Docker, rebuild image lalu recreate service server;
restart saja tidak memasukkan script baru ke image.

Database PostgreSQL lokal `bot_order`, schema `public`, telah diperbarui pada
2026-10-08. Pemeriksaan sesudahnya memastikan keenam kolom dan index unik ada,
jumlah baris tetap, dan diff database terhadap `schema.prisma` kosong.

## Catatan per migrasi: `20261005100000_add_order_item_cost_snapshot`

Migrasi ini menambahkan `order_items.cost_snapshot` sebagai Decimal nullable
tanpa default atau backfill. Pesanan baru menyimpan modal per unit dalam IDR
dari denominasi saat item dibuat, termasuk checkout wallet dan produk manual.
Laporan profit menggunakan snapshot ini agar perubahan modal supplier setelah
penjualan tidak mengubah profit historis. Baris lama dan item yang modalnya
belum diketahui tetap memakai fallback `denominations.cost_price` saat laporan
dibaca; modal nol disimpan sebagai nol, bukan dianggap tidak diketahui.

**Urutan deploy wajib:** terapkan skema dengan `pnpm exec prisma db push` atau
migrasi SQL ini, jalankan `pnpm run prisma:generate`, dan restart order-bot
sebelum kode baru berjalan. Semua proses yang memakai Prisma client baru
(web-admin, storefront, order-bot, dan worker) perlu memakai skema yang sudah
diperbarui; jika kolom belum ada, pembacaan OrderItem dapat gagal `P2022`.
Entrypoint Docker yang menjalankan `db push` sebelum aplikasi start memenuhi
urutan perubahan skema ini; jangan menjalankan kode baru pada database lama.

## Catatan per migrasi: `20261003000000_rename_legacy_unique_index_names`

Migrasi ini mengganti nama lima unique index warisan SQLite
(`sqlite_autoindex_categories_1`, `..._reviews_1`, `..._referrals_1`,
`..._restock_subscriptions_1`, `..._cart_items_1`) ke nama default Prisma
(`categories_name_key`, dst.), bersamaan dengan dihapusnya `map:
"sqlite_autoindex_*"` dari `schema.prisma`. Hanya **nama** index yang berubah:
kolom, isi, dan aturan keunikannya sama persis, dan tidak ada kode aplikasi
yang menyebut nama index ini.

**Produksi tidak perlu menjalankan file ini secara manual.** `db push` dari
`schema.prisma` yang baru menghasilkan sendiri kelima `ALTER INDEX ... RENAME`
yang sama. Diverifikasi 2026-10-04 di database scratch berisi data: skema lama
(dengan `map: sqlite_autoindex_*`) di-push, lalu `prisma migrate diff` ke skema
baru hanya berisi 5 `RenameIndex`, dan `prisma db push` (tanpa
`--accept-data-loss`) selesai tanpa peringatan data loss dengan baris tetap utuh.

- **Kapan terjadi:** saat container image baru start. Entrypoint menjalankan
  `db push` **sebelum** kode baru jalan, jadi rename terjadi di langkah deploy
  biasa (`$COMPOSE up -d --build`). Jalur non-Docker: `pnpm exec prisma db push`
  sebelum restart proses, seperti perubahan skema lainnya.
- **Sebelum deploy:** tidak perlu, dan tidak berguna. Kalau dijalankan saat
  image lama masih hidup, restart image lama berikutnya akan me-rename balik
  lewat `db push`-nya sendiri (tidak berbahaya, tapi sia-sia).
- **Sesudah deploy:** aman tapi no-op. File SQL-nya sekarang idempoten: setiap
  rename hanya jalan kalau index lama ada **dan** nama baru belum dipakai, jadi
  file ini juga tidak lagi gagal (`relation "sqlite_autoindex_categories_1"
  does not exist`) di instalasi baru atau di DB yang sudah di-rename `db push`.
  Kalau tetap ingin menjalankannya:
  `$COMPOSE run --rm server pnpm exec prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261003000000_rename_legacy_unique_index_names/migration.sql`.
- **Kenapa tidak di `$DATA_MIGRATIONS`:** daftar itu dijalankan **sesudah**
  `db push`, yang sudah melakukan rename, jadi file ini akan selalu no-op di
  sana. Isinya juga perubahan struktur, bukan baris — persis yang memang
  ditangani `db push`.
- **Rollback ke image sebelumnya:** `db push` milik image lama (skemanya masih
  punya `map: sqlite_autoindex_*`) me-rename index kembali ke nama lama, juga
  tanpa data loss (diverifikasi di DB scratch yang sama). Kalau start dicegat
  `data/SKIP_AUTO_MIGRATE` (dibuat `restore.sh`) atau `AUTO_MIGRATE=0`, nama
  index dibiarkan seperti yang ada di DB/dump — kedua versi kode tetap jalan
  dengan nama mana pun, karena tidak ada yang bergantung pada nama itu. Restore
  dump pra-deploy mengembalikan nama lama; deploy image baru berikutnya
  me-rename lagi.

## Cara membuat migrasi (sebagai dokumentasi SQL, opsional)

Jika Anda menambah kolom/tabel di `schema.prisma` dan ingin menyimpan SQL-nya
sebagai catatan (pola yang diikuti komit-komit sebelumnya):

```bash
# Hasilkan SQL diff TANPA menerapkannya (perlu shadow DB sementara — Prisma membuatnya otomatis)
pnpm exec prisma migrate dev --create-only --name <nama_deskriptif>
```

Ini menulis `prisma/migrations/<timestamp>_<nama>/migration.sql` untuk dibaca
manusia, tapi **belum** menerapkan SQL itu ke database aplikasi. Review SQL-nya, lalu terapkan
dengan `db push` (bukan `migrate deploy`) seperti langkah berikutnya.

## Cara menerapkan migrasi (yang sungguhan dipakai)

```bash
# Non-Docker
pnpm exec prisma db push
pnpm seed-chart-of-accounts   # sekali per environment; idempoten, lihat di bawah

# Docker — biasanya TIDAK perlu: entrypoint sudah melakukan keduanya (plus
# migrasi data-only rilis ini) saat container start, lihat bagian berikut.
# Kedua perintah ini tetap valid & idempoten, mis. saat AUTO_MIGRATE=0 atau untuk
# menerapkan skema tanpa restart.
docker compose run --rm server pnpm exec prisma db push
docker compose run --rm server pnpm seed-chart-of-accounts
```

### Docker: otomatis lewat entrypoint

`docker-entrypoint.sh` menyelaraskan skema **sebelum** `pnpm start` dijalankan,
jadi "urutan wajib" di bawah dipenuhi secara struktural — tidak bisa lupa.
Gerbangnya, berurutan:

1. `AUTO_MIGRATE=0`? → berhenti di sini, database tak disentuh sama sekali.
2. Ada `data/SKIP_AUTO_MIGRATE`? → berhenti (jeda pasca-rollback, ditulis
   `restore.sh`); isi file dicetak ke log.
3. `DATABASE_URL_PRISMA` belum di-set, atau bukan `postgresql://`/`postgres://`
   → **container menolak start** (PostgreSQL satu-satunya database yang
   didukung).

Sejak rilis Financial Ledger, entrypoint menjalankan **seluruh** langkah deploy
rilis, bukan cuma skemanya — jadi deploy cukup
`docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml up -d --build`,
tanpa satu pun perintah manual sesudahnya:

1. **Tunggu database siap** (maks. 10 × 2 detik; `DB_WAIT_ATTEMPTS`/
   `DB_WAIT_SECONDS` bisa di-override). `depends_on: service_healthy` di
   `docker-compose.postgres.prod.yml` hanya membuktikan `pg_isready` pernah
   sukses — bukan bahwa container Postgres yang **baru pertama kali** boot sudah
   selesai me-restart server sungguhannya setelah menjalankan init script. Tanpa
   jeda ini, race beberapa detik itu menjadi crash-loop.
2. **`prisma db push --skip-generate`** (lewat `db_push()`, jadi **tetap tanpa**
   `--accept-data-loss`): perubahan yang akan
   membuang data **menggagalkan push** dan container **menolak start**. Ini satu-
   satunya langkah yang fatal.
3. **Seed chart of accounts ledger** (`scripts/seed-chart-of-accounts.ts`, sama
   dengan `pnpm seed-chart-of-accounts`). Setiap posting ledger mencari akunnya
   **berdasarkan `code`**, jadi di database yang belum pernah di-seed, settlement
   order, top-up wallet, penyesuaian wallet manual, dan komisi referral
   **tidak mencatat apa pun** — postingnya dilewati, bukan di-retry. Seed ini
   upsert idempoten, jadi aman dijalankan setiap start.
4. **Migrasi data-only** yang terdaftar di `$DATA_MIGRATIONS` (di
   `docker-entrypoint.sh`), diterapkan lewat `prisma db execute --file`. `db push`
   hanya menyinkronkan **struktur**, jadi migrasi yang mengisi/membetulkan
   **baris** harus dieksekusi terpisah atau diam-diam tidak pernah jalan. Hari ini
   isinya dua: `20260919120000_seed_usdt_rounding_ceil_since` dan
   `20261008120100_backfill_credentials_delivered_at` (menandai order stok yang
   sudah `DELIVERED` sebelum kolom `credentials_delivered_at` ada, supaya file
   kredensialnya tidak dikirim ulang otomatis).

**Langkah 3 dan 4 hanya WARNING kalau gagal, tidak pernah crash-loop.** Alasannya
dua. Pertama, skema sudah ter-push di titik itu; container yang menolak start
justru menghilangkan satu-satunya tempat untuk membetulkannya. Kedua, seed
chart-of-accounts **sengaja** keluar non-zero juga untuk hal yang bukan
kegagalan: akun yang `type`/`currency`-nya berbeda dari `CHART_OF_ACCOUNTS`, dan
akun aktif yang sudah tidak ada lagi di chart. Keduanya keputusan **akuntansi**
atas baris yang mungkin sudah memuat entri terposting (lihat komentar kepala
skripnya) — mematikan toko karena pertanyaan pembukuan adalah trade yang salah.

Karena itu **baca baris entrypoint setiap habis deploy**:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml \
  logs --since 10m server | grep entrypoint
```

**Kontrak idempotensi `$DATA_MIGRATIONS`:** setiap file di daftar itu
di-apply-ulang **setiap start**, karena tidak ada apa pun yang bisa dikonsultasi
soal apa yang sudah jalan — repo ini deploy dengan `db push`, yang tidak pernah
menulis `_prisma_migrations` (lihat bagian paling atas halaman ini). Jadi file
yang boleh masuk daftar itu **hanya** yang aman dijalankan berulang: `INSERT ...
ON CONFLICT DO NOTHING`, `UPDATE ... WHERE <belum dikerjakan>`, atau sejenisnya.
Saat sebuah rilis membawa migrasi data-only baru: tambahkan nama foldernya ke
`$DATA_MIGRATIONS` (dipisah spasi, terlama dulu) **dan** tulis di komentar kepala
file SQL-nya kenapa re-run-nya aman.
`deploy/test-entrypoint-auto-migrate.sh` ikut memverifikasi setiap nama di daftar
itu benar-benar ada di `prisma/migrations/`, supaya salah tulis tidak berakhir
sebagai WARNING produksi yang tak pernah dibaca.

**Tidak ada snapshot pra-push**, dan itu disengaja: `deploy/backup/backup.sh`
mengambil dump dengan menjalankan `pg_dump` **di dalam** container `postgres`
lewat `docker compose exec` (lihat
[`deploy/backup/README.md`](../deploy/backup/README.md)), yang butuh Docker socket
yang tidak dimiliki container `server` — dan memasang `postgresql-client` ke image
app justru memberi client lebih tua dari server `postgres:16`, yang dump-nya
ditolak server itu sendiri. Yang **dijamin** entrypoint: `db push` menolak setiap
perubahan yang tidak bisa diterapkan tanpa membuang data. Yang **tetap tugas
operator**: ambil dump di host sebelum deploy — lihat "Backup" di
[`deploy/backup/README.md`](../deploy/backup/README.md).

Kenapa di entrypoint dan bukan service `migrate` + `depends_on`:
`depends_on` hanya dievaluasi saat `up`, sehingga
`docker compose restart server` akan melewatinya — sedangkan entrypoint dilewati
oleh **semua** jalur start (`up`, `restart`, dan restart otomatis setelah crash).

> Konsekuensi: `docker compose run --rm server <apa pun>` juga melewati
> entrypoint, jadi perintah one-off ikut menyelaraskan skema lebih dulu.
> Umumnya justru yang diinginkan; kalau tidak, awali dengan `AUTO_MIGRATE=0`.

**Expected output (sukses, tanpa data loss):**
```
Your database is now in sync with your Prisma schema. Done in 123ms
```

**Expected output (butuh konfirmasi destruktif — kolom non-null tanpa default
pada tabel berisi data, dst.):** Prisma akan menampilkan ringkasan perubahan
dan **meminta konfirmasi interaktif**, atau gagal di mode non-interaktif
(CI/Docker) — tambahkan kolom sebagai nullable/dengan default dulu, backfill,
baru jadikan non-null di push kedua (lihat "Disiplin migrasi aman" di
`deploy/backup/README.md`).

**Urutan wajib (CLAUDE.md):** `db push` **dulu**, restart proses **kedua**,
baru kode baru benar-benar jalan. Kebalikannya (kode dulu, push belakangan)
menghasilkan `P2022 column ... does not exist` — lihat
[TROUBLESHOOTING.md](TROUBLESHOOTING.md). Di Docker urutan ini dijamin oleh
entrypoint; yang perlu Anda jaga manual hanyalah jalur non-Docker
(`pnpm start`, dev).

## Cara rollback migrasi

Tidak ada "migrate rollback" karena tidak ada migration history yang
diterapkan secara formal. Rollback yang sungguhan tersedia adalah **restore
dari dump PostgreSQL pra-migrasi**:

```bash
deploy/backup/backup.sh
# ... update dijalankan, terjadi masalah ...
deploy/backup/restore.sh data/backups/pg-<stamp-sebelum-update>.dump
```

`restore.sh` menghentikan penulis, mengambil dump pengaman database saat ini,
me-restore `.dump`, lalu membuat `data/SKIP_AUTO_MIGRATE` **sebelum** server
dimulai. Selama sentinel ada, entrypoint tidak menjalankan schema push, seed,
atau migrasi data-only. Pilih versi kode yang cocok dengan skema/data dump
tersebut; setelah cocok, hapus sentinel dan restart dengan kedua file Compose.
Langkah lengkap ada di [panduan backup/restore](../deploy/backup/README.md),
[BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md), dan
[ROLLBACK.md](ROLLBACK.md).

**Jangan rollback ke image lama tanpa restore dump (rilis backend-audit-fixes).**
Rilis ini menambah lima kolom `updated_at` dan `idempotency_records.pending_since`.
Kalau image lama dijalankan di atas database yang sudah di-push skema baru,
`db push` milik image lama ingin men-drop keenam kolom itu (kehilangan data), jadi
ia menolak tanpa `--accept-data-loss` — entrypoint gagal dan container tidak mau
start. Rollback yang didokumentasikan untuk rilis ini adalah restore dari dump
pra-deploy seperti di atas, bukan sekadar mengganti image.

## Contoh per environment

### Development (lokal)

Nyalakan PostgreSQL lokal lewat Compose dan gunakan URL host
`postgresql://bot_order:<password>@127.0.0.1:5432/bot_order` di `.env`
(sesuaikan user, password, DB, dan `POSTGRES_PORT` dengan file Compose):

```bash
docker compose -f docker-compose.postgres.yml up -d
pnpm exec prisma db push
pnpm prisma:generate     # regenerate client jika schema berubah field/model
pnpm seed-chart-of-accounts
```
DB dev ada di volume PostgreSQL. Jika data uji perlu
dipertahankan sebelum perubahan skema, ambil dump dulu. Tetap commit
`schema.prisma` + folder migrasi SQL (jika dibuat) bersama kode pemakainya.

### Staging

```bash
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml"
$COMPOSE up -d --build                    # entrypoint: db push → seed ledger → migrasi data → app
$COMPOSE logs -f server                   # cek baris "entrypoint: ..."
curl -I http://127.0.0.1:8000/healthz     # smoke test
```
Staging adalah tempat **menguji prosedur rollback** sebelum dipraktikkan di
produksi (lihat "Uji end-to-end" di `deploy/backup/README.md`).

### Production

```bash
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml"

deploy/backup/backup.sh                             # 1. dump manual, SELALU
$COMPOSE up -d --build                              # 2. entrypoint: db push → seed ledger → migrasi data → app
$COMPOSE logs --since 10m server | grep entrypoint  # 3. BACA barisnya (lihat catatan)
curl -I https://admin.contoh.com/healthz            # 4. smoke test
```

Langkah 2 juga membangun ulang bundle SPA React (panel admin + toko web) di
builder stage Dockerfile, jadi tidak ada langkah build client terpisah di jalur
Docker.

**Langkah 1 tidak redundan di jalur Postgres.** Entrypoint **tidak** mengambil
snapshot sendiri di sini (alasannya di "Docker: otomatis lewat entrypoint" di atas: `pg_dump`
jalan di dalam container `postgres` lewat Docker socket yang tidak dimiliki
container `server`), jadi langkah 1 adalah **satu-satunya** titik rollback
deploy ini. Yang melindungi data dari push itu sendiri adalah penolakan
`db push` terhadap perubahan yang membuang data — bukan backup.

**Langkah 3 wajib dibaca, bukan sekadar dijalankan.** Hanya `db push` yang fatal;
seed chart-of-accounts dan migrasi data-only **hanya WARNING** kalau gagal, dan
container tetap start. Jadi satu-satunya tanda bahwa seed ledger perlu keputusan
Anda (akun ter-drift, atau akun aktif yang tak ada lagi di chart) ada di baris
`entrypoint: WARNING ...` itu. Kalau skema tidak berubah, `db push` cuma bilang
sudah sinkron; seed dan migrasi data-only tetap jalan dan tetap no-op.

## Kegagalan umum & pemulihan

### `P2022: column ... does not exist`

**Sebab:** kode baru sudah jalan (mereferensikan kolom yang baru ditambah ke
`schema.prisma`), tapi `db push` belum dijalankan ke database PostgreSQL
yang dipakai aplikasi — *schema drift* antara kode dan DB live.

**Pemulihan:**
```bash
pnpm exec prisma db push        # menutup gap kolom (ALTER TABLE ADD COLUMN — aman, additive)
# lalu restart proses (pnpm start ulang / docker compose restart server)
```
Order yang gagal saat gap ini terbuka (mis. gagal mengantre notifikasi
pengiriman ke pembeli) **tidak otomatis retry** — re-trigger
manual lewat panel admin `/outbox` (tombol Retry) atau re-jalankan
reconcile gateway terkait. Detail diagnosis di
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

### Boot-time drift check hanya menangkap TABEL hilang, bukan KOLOM hilang

`apps/server/src/index.ts` (sekitar baris 199-214) menjalankan `missingTables`
(`packages/db/src/crud/integrity.ts`) saat boot, membandingkan
`PAYMENT_LEDGER_TABLES` terhadap `information_schema.tables` dan **fail-loud** (log error +
DM ke semua admin) kalau ada tabel ledger pembayaran yang hilang. Ini menutup
skenario "tabel belum pernah dibuat" (mis. lupa `db push` setelah migrasi yang
menambah tabel baru seperti `order_status_history`).

**Yang TIDAK dicek:** kolom baru pada tabel yang SUDAH ada — `missingTables`
hanya query `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`, tidak pernah
memeriksa kolom per tabel. Jadi migrasi column-only (mis.
`orders.network`/`confirmations`/`required_confirmations`/`first_detected_at`/
`confirmed_at`, atau `broadcasts.web_image_url`/`image_file_id` — keduanya
dulu datang lewat migrasi tersendiri, kini sudah terlipat ke `postgresql_baseline`)
tidak memicu peringatan apa pun saat boot kalau operator lupa `db push` —
gejala baru muncul sebagai `P2022` pertama kali kode menulis ke kolom yang
belum ada bukan sebagai log error saat startup. Ini keterbatasan yang disengaja: menambah
deteksi drift level-kolom (`information_schema.columns` per tabel, dibandingkan terhadap
skema Prisma) adalah mesin schema-diffing kustom — dicatat sebagai
keterbatasan yang diketahui/didokumentasikan di sini, bukan dibangun, karena
lebih murah dan lebih rendah risiko daripada menambah mekanisme deteksi baru.

### `P2021: table does not exist`

Sama akar masalahnya dengan `P2022` tapi untuk tabel yang baru ditambahkan
atau di-rename (bukan kolom baru). Solusi sama: `db push`, lalu restart
proses.

### `db push` minta konfirmasi destruktif di CI/Docker (non-interaktif)

Prisma menolak melanjutkan tanpa TTY ketika perubahan berisiko
(kolom NOT NULL tanpa default ke tabel berisi data, dsb.). **Jangan** tambah
flag `--accept-data-loss` secara reflex — itu literally mengizinkan
penghapusan data. Perbaiki skema dulu: kolom baru nullable/dengan default →
push → backfill nilai → (jika perlu) jadikan non-null → push lagi.

### Database `readonly` / permission denied saat push

```bash
sudo chown -R 999:999 data    # Docker — UID container `app`
docker compose restart server
```
