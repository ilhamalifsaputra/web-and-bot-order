# Migrasi Database

## [BARU — 2026-08-27] Engine-swap ke PostgreSQL: `prisma/migrations/` di-baseline ulang

> Bagian ini didokumentasikan begitu ditambahkan (task 4 dari rencana engine-swap
> SQLite→PostgreSQL, `worktree-pg-engine-swap`) dan TIDAK menggantikan isi lama di
> bawah — semua bagian selanjutnya tetap sejarah yang akurat untuk 46 folder
> migrasi SQLite yang sekarang diarsipkan (lihat di bawah).

Cabang ini mengganti `datasource.provider` di `schema.prisma` dari `sqlite` ke
`postgresql` (task 2) dan menghapus kode aplikasi khusus SQLite dari
`packages/db` (task 3). **`db push` tetap satu-satunya mekanisme deploy yang
sungguhan dipakai** — semua yang dijelaskan di bagian "Mekanisme yang SEBENARNYA
dipakai repo ini" tepat di bawah ini tetap berlaku persis sama, hanya
providernya sekarang `postgresql`, bukan `sqlite`.

**Kenapa folder migrasi di-baseline ulang, bukan diedit di tempat:** ke-46 folder
SQLite-era di `prisma/migrations/` berisi SQL SQLite murni (`PRAGMA`, pola
rebuild `INSERT INTO "new_x" (...) SELECT ... FROM "x"`, tipe kolom SQLite) yang
ditulis terhadap `migration_lock.toml` ber-provider `sqlite`. Begitu provider
schema berganti ke `postgresql`, `check-migration-drift`
(`prisma migrate diff --from-migrations`) akan mencoba me-*replay* SQL SQLite
itu di shadow database PostgreSQL dan gagal **keras** — bukan sekadar melaporkan
diff, karena sintaks SQLite bukan SQL PostgreSQL yang valid. Panduan resmi
Prisma sendiri untuk situasi pindah provider datasource adalah memulai migration
history yang baru; SQL provider lama tidak valid untuk provider baru.

**Yang dilakukan (task 4, 2026-08-27):**

1. Ke-46 folder lama dipindah utuh — nama folder dan isi SQL tidak diubah sama
   sekali — ke `prisma/migrations-sqlite-archive/`. **Tidak dihapus**: folder ini
   murni dokumentasi/audit-trail sejarah SQLite, dan tidak pernah lagi dibaca
   oleh Prisma CLI atau ketiga guard script (`check-migration-drift`,
   `check-migration-timestamps`, `check-migration-rebuild-quoting`) — ketiganya
   hanya men-scan `prisma/migrations/*`. Salinan `migration_lock.toml` ber-provider
   `sqlite` (nilai file ini sebelum task 2 mengubahnya ke `postgresql`) disimpan
   di `prisma/migrations-sqlite-archive/migration_lock.toml` supaya folder arsip
   itu self-describing kalau dibaca lepas dari konteks commit ini.
2. Satu migrasi baseline baru, `prisma/migrations/20260827050616_postgresql_baseline/migration.sql`,
   dibuat via:
   ```bash
   prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
   ```
   — **bukan** `prisma migrate dev --create-only` seperti draft awal task ini
   menyarankan. `migrate diff --from-empty --to-schema-datamodel` dipilih setelah
   dicek lewat context7/dokumentasi Prisma: command ini murni diffing
   schema-ke-schema dan **tidak menyentuh database apa pun sama sekali** (beda
   dari `migrate dev`, yang butuh shadow database dan bisa mendeteksi "drift"
   antara riwayat migrasi kosong vs. `bot_order_pg` yang skemanya sudah live via
   `db push` — berisiko menawarkan reset destruktif terhadap DB dev yang
   sungguhan dipakai). Dokumentasi Prisma sendiri menandai pola
   `--from-empty --to-schema` persis ini sebagai cara resmi untuk "baseline
   database saat pindah dari `db push` ke migration history tanpa mengubah data
   lokal yang sudah ada" — cocok persis dengan situasi repo ini.
3. Migrasi baseline itu **tidak** ditandai `--applied` di `_prisma_migrations` —
   konsisten dengan premis inti halaman ini: tabel tersebut tidak dipercaya
   sebagai catatan skema yang diterapkan di repo ini, karena `db push` tidak
   pernah menulisinya.
4. `migration_lock.toml` di `prisma/migrations/` (yang aktif) **tidak berubah** —
   sudah `postgresql` sejak task 2.

**`check-migration-drift` butuh perubahan mekanisme, bukan cuma isi folder:**
untuk PostgreSQL, `prisma migrate diff --from-migrations` menolak jalan tanpa
flag `--shadow-database-url` eksplisit (`Error: You must pass the
--shadow-database-url if you want to diff a migrations directory`, diverifikasi
empiris) — beda dari SQLite, yang otomatis membuat file temporary sebagai shadow
DB tanpa konfigurasi apa pun. `pnpm run check-migration-drift` sekarang
memanggil `scripts/check-migration-drift.ts` (dulu satu baris `prisma migrate
diff ...` langsung di `package.json`) yang membangun `--shadow-database-url`
dari `DATABASE_URL_PRISMA` + `?schema=_migration_diff_shadow` — schema
**terpisah di DALAM database dev yang sama**, bukan database fisik terpisah,
supaya tidak ada environment variable baru yang perlu dikonfigurasi manual di
tiap `.env`. Role `bot_order` (lihat `docker-compose.postgres.yml`) sudah
superuser/`CREATEDB`, jadi Prisma bisa membuat & mengisi ulang schema tersebut
sendiri di setiap run — diverifikasi dengan menjalankan check-nya dua kali
berturut-turut (keduanya sukses, tanpa perlu cleanup manual di antaranya) dan
dengan memaksa diff sungguhan lewat `--to-empty` untuk mengonfirmasi
`--exit-code` tetap melaporkan kode 2 (bukan selalu 0 apa pun keadaannya)
lewat jalur shadow-schema yang sama.

**`check-migration-timestamps` dan `check-migration-rebuild-quoting` tidak
butuh perubahan mekanisme** — keduanya cuma men-scan folder di
`prisma/migrations/*`, jadi begitu 46 folder lama pindah keluar dari direktori
itu, keduanya otomatis hanya melihat folder baseline baru (yang tidak punya
duplikat timestamp maupun pola rebuild SQL sama sekali — baseline-nya murni
`CREATE TABLE`, tidak ada `ALTER`/rebuild). Yang **diedit** di kedua script:
entri `GRANDFATHERED` masing-masing (pasangan timestamp H-9 di
`check-migration-timestamps.ts`; dua folder pre-H-9 di
`check-migration-rebuild-quoting.ts`) dikosongkan, karena kedua folder yang
mereka rujuk sudah tidak lagi ada di `prisma/migrations/` — tanpa perubahan itu
keduanya gagal keras (`allowlisted folder not found`) di setiap run, bukan
karena masalah baru, tapi karena allowlist-nya menunjuk ke folder yang sudah
pindah. Penalaran H-9 di baliknya tidak berubah dan tetap terdokumentasi di
komentar kedua script serta di bagian-bagian lama halaman ini.

**Titik awal baru untuk `check-migration-drift`:** mulai sekarang, setiap
perubahan `schema.prisma` di cabang ini perlu migrasi SQL baru di
`prisma/migrations/` relatif terhadap
`20260827050616_postgresql_baseline/` — persis pola yang sama seperti
sebelumnya relatif terhadap 46 folder SQLite, hanya titik nolnya yang pindah.
Mekanisme "Cara membuat migrasi" dan "Cara menerapkan migrasi" di bagian bawah
halaman ini tidak berubah.

## Mekanisme yang SEBENARNYA dipakai repo ini: `db push`, bukan `migrate deploy`

Repo ini punya folder `prisma/migrations/*` (SQL terurut, ada history),
**tapi** seluruh dokumentasi operasional (`README.md`, `DOCS.md`, `CLAUDE.md`,
`deploy/backup/README.md`, CI) secara konsisten memerintahkan
**`pnpm exec prisma db push`** untuk menerapkan perubahan skema — bukan
`prisma migrate deploy`. Ini bukan kelalaian dokumentasi: untuk SQLite
single-file tanpa tim multi-developer yang butuh history migrasi formal,
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

## Catatan: sebagian folder migrasi dibuat manual, bukan via Prisma

Beberapa folder di `prisma/migrations/*` punya timestamp bulat/hand-picked
(mis. `20260531120000_drop_alembic_version`, `20260531140000_review_hidden`,
`20260531180000_wallet_transactions`, `20260531200000_broadcasts`,
`20260706120000_broadcast_image` — semua berakhiran `:00:00`), berbeda dengan
folder lain yang timestamp-nya presisi-detik acak (mis.
`20260623174046_restrict_financial_cascades`), ciri khas keluaran
`prisma migrate dev --create-only` sungguhan. Timestamp bulat mengindikasikan
folder itu ditulis tangan (SQL disalin/disesuaikan manual), bukan dihasilkan
dan divalidasi terhadap shadow DB. Perlakukan migrasi hand-authored sebagai
**best-effort/belum tervalidasi** — jangan asumsikan SQL-nya sudah dicek
`prisma migrate diff` byte-identik terhadap `schema.prisma` seperti yang
diklaim untuk batch Infra-5/Pricing-1 di atas; review manual SQL-nya sebelum
mengandalkannya sebagai dokumentasi otoritatif.

## Cek drift migrasi-vs-schema di CI

Karena `db push` tidak pernah menulis file SQL, folder `prisma/migrations/*`
bisa diam-diam ketinggalan di belakang `schema.prisma` — kolom/index baru
ditambahkan ke schema, di-`db push`-kan ke DB dev, tapi tidak ada folder
migrasi yang dibuat untuk mendokumentasikannya. Ini baru pertama kali
ketahuan (H-8, 2026-08-01) ketika 12+ kolom dan 2 index di `schema.prisma`
ternyata tidak punya SQL sama sekali di `prisma/migrations/` — `prisma
migrate deploy` terhadap DB kosong akan gagal `P2022` di tabel `denominations`/
`support_tickets`/`orders`/`products`. Katalog lengkap kolom yang saat itu
hilang, plus review keamanan lengkap (additive vs destructive, kenapa dua
file terpisah, verifikasi empiris `db push`/`db execute`/`migrate deploy`),
ada di dua migrasi yang menutupnya:
`prisma/migrations/20260801000000_catchup_missing_columns_and_indexes/migration.sql`
(aman — murni `ALTER TABLE ADD COLUMN`/`CREATE INDEX`, tidak ada rebuild
tabel sama sekali) dan
`prisma/migrations/20260801000001_support_tickets_last_status_change_not_null/migration.sql`
(terisolasi sengaja — satu-satunya bagian yang butuh SQLite table-rebuild,
karena `support_tickets.last_status_change_at` perlu diketatkan dari
nullable ke NOT NULL, sesuatu yang SQLite tidak bisa lakukan lewat `ALTER
TABLE` apa pun; baca header file itu untuk verifikasi keamanannya sebelum
menjalankannya di luar `db push`/`migrate deploy`).

Untuk mencegah drift berulang tanpa ketahuan, script
`pnpm run check-migration-drift` (`prisma migrate diff --from-migrations
./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma
--exit-code`) punya dua tempat jalan: sebagai step CI ("Migration drift
check" di `.github/workflows/ci.yml`, sebelum typecheck/test — tapi lihat
catatan di bawah, workflow ini nonaktif hari ini), dan sebagai `pretest` di
root `package.json`, jadi `pnpm test` menjalankannya duluan setiap kali
(biaya: satu shadow-DB SQLite sekali per run, beberapa detik) — inilah yang
SUNGGUH-SUNGGUH menegakkan drift-check ini hari ini, bukan CI. Keduanya **gagal
(exit code 2)** kalau `schema.prisma` dan `prisma/migrations/*` tidak
sinkron. Kalau salah satu merah: jalankan command yang sama tanpa
`--exit-code` (tambahkan `--script`) untuk lihat SQL-nya, review pola
destructive/rebuild sebagaimana dijelaskan di komentar kedua migrasi H-8 di
atas (khususnya: cek apakah drift itu murni kolom baru — biasanya aman
lewat `ALTER TABLE ADD COLUMN` hand-written meski Prisma sendiri
menghasilkan rebuild — atau benar-benar constraint change pada kolom lama,
yang di SQLite SELALU butuh rebuild), lalu simpan sebagai folder migrasi
baru dengan timestamp setelah folder terakhir.

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

Repo ini punya satu pasangan seperti itu:
`20260725000000_add_support_ticket_priority` dan
`20260725000000_add_ticket_priority_category_resolved` (dua branch yang
di-merge independen di hari yang sama). Hari ini keduanya **saling
independen** — kolom/index yang mereka sentuh tidak beririsan (`priority` +
`ix_support_tickets_priority` versus `category`/`first_response_at`/
`resolved_at`/`last_status_change_at` + `ix_support_tickets_status`) dan tidak
ada yang membaca keluaran yang lain. Ini diverifikasi empiris (H-9,
2026-08-01) dengan menjalankan `migrate deploy` pada DB kosong setelah
pasangan itu dipaksa berjalan dalam urutan terbalik: skema akhir identik dan
`prisma migrate diff` tetap "No difference detected."

Karena itu pasangan tersebut **sengaja tidak di-rename**: mengganti nama
folder migrasi yang sudah pernah diterapkan akan merusak pelacakan
`_prisma_migrations` di DB mana pun yang sudah menjalankannya dengan nama
lama. Yang dicegah sekarang adalah pasangan **baru** masuk tanpa ketahuan:
`pnpm run check-migration-timestamps`
(`scripts/check-migration-timestamps.ts`) gagal dengan exit code 1 kalau ada
timestamp ganda di luar allowlist, dan ikut jalan sebagai bagian `pretest`
(bersama drift check) plus sebagai step CI.

Allowlist-nya menyimpan **nama folder yang persis**, bukan sekadar
timestamp-nya. Kalau hanya timestamp yang di-allowlist, justru tanggal yang
paling mungkin dipakai ulang secara tidak sengaja — tanggal yang sudah muncul
dua kali di tree — jadi satu-satunya tanggal yang tanpa perlindungan sama
sekali: folder **ketiga** di `20260725000000` akan lolos diam-diam. Karena itu
guard-nya menuntut kesetaraan himpunan: folder tambahan, folder yang hilang,
atau folder yang di-rename sama-sama gagal (ketiganya diverifikasi negatif —
lihat `.superpowers/sdd/2026-07-31-audit-backend-fixes/task-37-report.md`).

## Arsip SQLite pra-cutover: pemulihan dari `migrate deploy` yang gagal (P3018 / P3009)

Bagian ini relevan hanya kalau Anda menjalankan `prisma migrate deploy`
(bukan alur normal repo ini, yang memakai `db push` — lihat bagian paling
atas). Belum ada dokumentasi soal ini sebelumnya, padahal repo ini **sudah
pernah kena** (commit `058afd7`, 2026-07-27).

### Apa arti kedua error itu

| Kode | Kapan muncul | Artinya |
| --- | --- | --- |
| `P3018` | Saat satu file migrasi error di tengah jalan | Migrasi itu ditandai **failed** di `_prisma_migrations` (`finished_at` NULL, `rolled_back_at` NULL) |
| `P3009` | Pada `migrate deploy` **berikutnya** | Prisma menolak menerapkan migrasi baru selama masih ada migrasi berstatus failed |

**Jebakan terbesar: SQLite tidak punya DDL transaksional.** Setiap
`ALTER TABLE`/`CREATE INDEX` auto-commit sendiri-sendiri, jadi pernyataan
sebelum yang gagal **tetap tertulis permanen** ke DB. Prisma tetap mencatat
`applied_steps_count = 0` untuk migrasi yang gagal — angka itu **tidak bisa
dipercaya** sebagai "tidak ada yang berubah". Selalu cek sendiri dengan
`PRAGMA table_info(<tabel>)` sebelum memutuskan langkah pemulihan.

### Dua perintah pemulihan Prisma

```bash
# "Migrasi ini SUDAH benar-benar diterapkan (saya sudah cek/lengkapi manual)" —
# tandai selesai, JANGAN jalankan ulang SQL-nya.
pnpm exec prisma migrate resolve --applied <nama_folder_migrasi>

# "Migrasi ini TIDAK meninggalkan jejak apa pun (atau sudah saya undo manual)" —
# hapus tanda failed sehingga `migrate deploy` berikutnya menjalankan ulang SQL-nya.
pnpm exec prisma migrate resolve --rolled-back <nama_folder_migrasi>
```

Keduanya hanya mengubah baris di `_prisma_migrations` — **tidak satu pun
menyentuh skema/data**. Pilih `--rolled-back` hanya kalau SQL migrasi itu
memang aman dijalankan ulang dari awal; pada SQLite itu jarang benar untuk
file berisi `ALTER TABLE ADD COLUMN`, karena kolom yang sudah terlanjur
masuk akan menabrak `duplicate column name`.

Selalu `deploy/backup/backup.sh` dulu sebelum langkah pemulihan apa pun.

### Kasus nyata: `20260725000000_add_ticket_priority_category_resolved`

Versi awal file itu memakai
`ADD COLUMN "last_status_change_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`.
SQLite menolak default non-konstan, jadi pernyataan ke-4 gagal
(`Cannot add a column with non-constant default`, P3018) **setelah** tiga
`ADD COLUMN` sebelumnya sudah commit.

> **Penting kalau Anda mencoba mereproduksi insiden ini:** penolakan itu
> **hanya terjadi kalau tabelnya sudah berisi baris.** Pada tabel kosong,
> `ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT CURRENT_TIMESTAMP` **berhasil**
> tanpa keluhan apa pun — diverifikasi lewat `prisma db execute`: kolomnya
> masuk ke tabel kosong, dan pernyataan identik ke tabel berisi satu baris
> langsung gagal. Jadi DB scratch yang belum di-seed akan terlihat seolah bug
> ini tidak pernah ada. **Seed dulu tabelnya, baru jalankan migrasinya** —
> itulah satu-satunya cara reproduksi ini valid, dan juga kenapa bug-nya lolos
> ke produksi: `db push` (yang dipakai test suite) membangun ulang tabel dari
> nol alih-alih `ALTER TABLE`, jadi tidak pernah menyentuh jalur ini sama
> sekali. DB yang kena berada dalam keadaan:
`category`, `first_response_at`, `resolved_at` **ada**;
`last_status_change_at` dan index `ix_support_tickets_status` **tidak ada**.
File-nya sendiri sudah diperbaiki (kolom kini nullable + backfill), tapi
perbaikan itu tidak bisa menyembuhkan DB yang sudah terlanjur setengah jalan.

Kalau Anda menemukan DB dalam keadaan itu, ini urutan yang benar
(diverifikasi end-to-end pada DB scratch, H-9):

```bash
deploy/backup/backup.sh          # 0. selalu

# 1. Selesaikan sendiri bagian yang belum sempat jalan.
cat > /tmp/repair.sql <<'SQL'
ALTER TABLE "support_tickets" ADD COLUMN "last_status_change_at" DATETIME;
UPDATE "support_tickets" SET "last_status_change_at" = "created_at" WHERE "last_status_change_at" IS NULL;
CREATE INDEX IF NOT EXISTS "ix_support_tickets_status" ON "support_tickets"("status");
SQL
pnpm exec prisma db execute --schema prisma/schema.prisma --file /tmp/repair.sql

# 2. Baru tandai migrasinya selesai (JANGAN --rolled-back, lihat di bawah).
pnpm exec prisma migrate resolve --applied 20260725000000_add_ticket_priority_category_resolved

# 3. Lanjutkan sisa rantainya.
pnpm exec prisma migrate deploy
```

**Kenapa bukan `--rolled-back`:** itu menyuruh Prisma menjalankan ulang
file-nya, dan file itu tetap dibuka tiga `ADD COLUMN` polos tanpa penjaga
idempotensi — SQLite tidak punya bentuk `ADD COLUMN IF NOT EXISTS` sama
sekali, jadi tidak ada cara menulis ulang file itu supaya aman diulang.
Dijalankan ulang, ia langsung gagal `duplicate column name: category`
(diverifikasi). File itu juga **tidak boleh diedit** sekarang: `migrate
deploy` memverifikasi checksum tiap migrasi yang sudah diterapkan, jadi
mengubah isinya — termasuk komentar — akan mematahkan DB mana pun yang sudah
menjalankannya dengan sukses. Perbaikan apa pun harus maju ke depan
(migrasi/langkah baru), bukan mengedit file lama.

**Kenapa langkah 1 harus mendahului langkah 2:** kalau Anda langsung
`--applied` lalu `deploy`, rantainya sampai ke
`20260801000001_support_tickets_last_status_change_not_null`, yang membangun
ulang `support_tickets` dan membaca `last_status_change_at` dari tabel lama —
kolom yang belum ada. Sejak H-9 semua referensi kolom di file itu ditulis
berkualifikasi (`"support_tickets"."last_status_change_at"`), jadi kasus ini
**gagal keras** dengan `no such column: support_tickets.last_status_change_at`
dan tidak ada data yang berubah.

> Sebelum H-9 referensinya polos (`"last_status_change_at"`), dan itu jauh
> lebih buruk daripada kelihatannya: SQLite bawaan Prisma masih mengaktifkan
> perilaku warisan "double-quoted string literal", sehingga nama berkutip
> ganda yang tidak cocok dengan kolom mana pun **diam-diam berubah menjadi
> literal string**. Hasilnya migrasi "sukses" tanpa error sambil menulis teks
> `last_status_change_at` ke kolom timestamp setiap baris — diverifikasi
> empiris di DB scratch pada H-9. Pola ini berlaku untuk **semua** migrasi
> rebuild bergaya `INSERT INTO "new_x" (...) SELECT ... FROM "x"`
> (`20260619170759_add_paydisini_nowpayments_ledgers` dan
> `20260623174046_restrict_financial_cascades` masih memakai bentuk polos;
> keduanya tidak diubah karena sudah diterapkan dan checksum-nya beku). Kalau
> Anda menulis migrasi rebuild baru, **selalu kualifikasikan kolom sumber
> dengan nama tabelnya.**

Aturan terakhir itu tidak lagi cuma imbauan di dokumen:
`pnpm run check-migration-rebuild-quoting`
(`scripts/check-migration-rebuild-quoting.ts`) memindai setiap
`INSERT INTO "new_x" (...) SELECT ... FROM "x"` di seluruh
`prisma/migrations/*` dan gagal dengan exit code 1 kalau ada kolom sumber yang
ditulis polos. Alias (`... AS "nama"`) dikecualikan — alias menamai kolom
keluaran, tidak pernah di-resolve ke tabel sumber. Dua folder pra-H-9 di atas
di-grandfather **per nama folder**, lengkap dengan jumlah pelanggaran yang
diharapkan, jadi mengedit file yang checksum-nya beku pun ikut ketahuan.
Guard ini jalan di `pretest` dan sebagai step CI, sama seperti dua cek
lainnya.

Kalau langkah 2 terlanjur dijalankan sebelum langkah 1 dan `deploy` sudah
gagal di `20260801000001`, pulihkan begini (juga diverifikasi): jalankan
langkah 1, lalu
`pnpm exec prisma migrate resolve --rolled-back 20260801000001_support_tickets_last_status_change_not_null`,
lalu `migrate deploy` lagi. Aman diulang karena file itu kini dibuka dengan
`DROP TABLE IF EXISTS "new_support_tickets"` — tanpa itu, percobaan kedua
akan gagal dengan `table new_support_tickets already exists` (tabel staging
ikut auto-commit saat percobaan pertama berhenti di tengah).

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
jadi "urutan wajib" di bawah dipenuhi secara struktural — tidak bisa lupa. Dua
gerbang pertama sama untuk kedua engine:

1. `AUTO_MIGRATE=0`? → berhenti di sini, database tak disentuh sama sekali.
2. Ada `data/SKIP_AUTO_MIGRATE`? → berhenti (jeda pasca-rollback, ditulis
   `restore.sh`); isi file dicetak ke log.
3. `DATABASE_URL_PRISMA` belum di-set → **container menolak start**
   (`schema.prisma` menuntut connection string `postgresql://`).

Sesudah itu jalurnya bercabang menurut prefix `DATABASE_URL_PRISMA`.

#### Jalur PostgreSQL (produksi hari ini)

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
2. **`prisma db push --skip-generate`** (lewat `db_push()` yang sama dengan jalur
   SQLite, jadi **tetap tanpa** `--accept-data-loss`): perubahan yang akan
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
   isinya satu: `20260919120000_seed_usdt_rounding_ceil_since`.

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

**Tidak ada snapshot pra-push di jalur ini**, dan itu disengaja: jalur Postgres
`deploy/backup/backup.sh` mengambil dump dengan menjalankan `pg_dump` **di dalam**
container `postgres` lewat `docker compose exec` (lihat
[`deploy/backup/README.md`](../deploy/backup/README.md)), yang butuh Docker socket
yang tidak dimiliki container `server` — dan memasang `postgresql-client` ke image
app justru memberi client lebih tua dari server `postgres:16`, yang dump-nya
ditolak server itu sendiri. Yang **dijamin** entrypoint: `db push` menolak setiap
perubahan yang tidak bisa diterapkan tanpa membuang data. Yang **tetap tugas
operator**: ambil dump di host sebelum deploy — lihat "Backup — Postgres" di
[`deploy/backup/README.md`](../deploy/backup/README.md).

#### Jalur SQLite (checkout pra-cutover) — tidak berubah

1. File DB belum ada → fresh install, `db push` langsung (tak ada yang perlu
   di-backup).
2. `prisma migrate diff --exit-code` membandingkan DB vs `schema.prisma`:
   - exit **0** (sama) → tidak ada backup, tidak ada push. Jadi `restart`
     berulang/crash-loop tidak menggerus retensi backup.
   - exit **2** (beda) → `deploy/backup/backup.sh` **dulu**, lalu `db push`.
   - exit **1** (gagal membandingkan) → **container menolak start**, supaya
     masalahnya terlihat sekarang alih-alih muncul sebagai `P2022` di setiap
     query order.
3. Kalau snapshot tak bisa diambil (mis. `sqlite3` hilang dari image, atau
   `backup.sh` gagal) → **menolak mengubah skema**. Tidak ada perubahan skema
   tanpa jalur rollback.

`DATABASE_URL_PRISMA` yang bukan `postgresql://` maupun `file:` dilewati dengan
satu baris log — entrypoint tidak menebak cara menyelaraskan engine yang tidak
dikenalnya.

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
dari dump PostgreSQL pra-migrasi**. `backup.sh` memilih engine dari environment
prosesnya sendiri, sehingga penanda PostgreSQL wajib diberikan eksplisit:

```bash
DATABASE_URL_PRISMA=postgresql://engine-marker deploy/backup/backup.sh
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

### Legacy SQLite, hanya checkout pra-cutover

Pada versi lama yang masih memakai `data/bot.db`, backup `bot-*.db` dibuat
melalui SQLite online backup lalu direstore dengan `restore.sh`. Perintah
`.db` itu tidak berlaku untuk PostgreSQL saat ini.

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
DB dev ada di volume PostgreSQL, bukan `data/bot.db`. Jika data uji perlu
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

DATABASE_URL_PRISMA=postgresql://engine-marker deploy/backup/backup.sh  # 1. dump manual, SELALU
$COMPOSE up -d --build                              # 2. entrypoint: db push → seed ledger → migrasi data → app
$COMPOSE logs --since 10m server | grep entrypoint  # 3. BACA barisnya (lihat catatan)
curl -I https://admin.contoh.com/healthz            # 4. smoke test
```

Langkah 2 juga membangun ulang bundle SPA React (panel admin + toko web) di
builder stage Dockerfile, jadi tidak ada langkah build client terpisah di jalur
Docker.

**Langkah 1 tidak redundan di jalur Postgres.** Entrypoint **tidak** mengambil
snapshot sendiri di sini (alasannya di "Jalur PostgreSQL" di atas: `pg_dump`
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

**Contoh historis SQLite pra-cutover:** kolom
`claimed_at`/`next_retry_at` ditambahkan ke `NotificationOutbox` di commit
`c4778c8` (2026-06-23, paket fix audit keamanan — lihat
`prisma/migrations-sqlite-archive/20260623082258_add_notification_claimed_at/` dan
`prisma/migrations-sqlite-archive/20260623174936_add_notification_next_retry_at/`). `PRAGMA table_info` pada
`data/bot.db` lokal menunjukkan kolom itu **tidak ada** — `db push` belum
pernah dijalankan ulang pasca-commit tersebut, padahal kode
(`packages/db/src/crud/notifications.ts`) sudah memakainya. Akibatnya
`notificationOutbox.create()`/`update()` gagal dengan `P2022` setiap kali
order yang sudah dibayar mencoba mengantre notifikasi pengiriman — order
valid, tapi gagal terkirim ke pembeli.

**Pemulihan:**
```bash
pnpm exec prisma db push        # menutup gap kolom (ALTER TABLE ADD COLUMN — aman, additive)
# lalu restart proses (pnpm start ulang / docker compose restart server)
```
Order yang gagal saat gap ini terbuka **tidak otomatis retry** — re-trigger
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
`confirmed_at` dari `20260624160712_add_order_status_history`, atau
`broadcasts.web_image_url`/`image_file_id` dari `20260706120000_broadcast_image`)
tidak memicu peringatan apa pun saat boot kalau operator lupa `db push` —
gejala baru muncul sebagai `P2022` pertama kali kode menulis ke kolom yang
belum ada (lihat contoh historis `claimed_at`/`next_retry_at` di atas), bukan
sebagai log error saat startup. Ini keterbatasan yang disengaja: menambah
deteksi drift level-kolom (`information_schema.columns` per tabel, dibandingkan terhadap
skema Prisma) adalah mesin schema-diffing kustom — dicatat sebagai
keterbatasan yang diketahui/didokumentasikan di sini, bukan dibangun, karena
lebih murah dan lebih rendah risiko daripada menambah mekanisme deteksi baru.

### `P2021: table does not exist`

Sama akar masalahnya dengan `P2022` tapi untuk tabel yang baru di-rename
(bukan kolom baru) — biasanya terjadi setelah migrasi data sekali-jalan
seperti `migrate-catalog-rename`. Solusi sama: `db push`, lalu pastikan
skrip migrasi data terkait sudah dijalankan (lihat header skrip di
`scripts/migrate-catalog-rename.ts`).

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
