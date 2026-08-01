# Migrasi Database

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
komentar di `docs/audit-security-2026-06-23.md`) memang dibuat & divalidasi
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

## Cara membuat migrasi (sebagai dokumentasi SQL, opsional)

Jika Anda menambah kolom/tabel di `schema.prisma` dan ingin menyimpan SQL-nya
sebagai catatan (pola yang diikuti komit-komit sebelumnya):

```bash
# Hasilkan SQL diff TANPA menerapkannya (perlu shadow DB sementara — Prisma membuatnya otomatis)
pnpm exec prisma migrate dev --create-only --name <nama_deskriptif>
```

Ini menulis `prisma/migrations/<timestamp>_<nama>/migration.sql` untuk dibaca
manusia, tapi **belum** menyentuh `data/bot.db`. Review SQL-nya, lalu terapkan
dengan `db push` (bukan `migrate deploy`) seperti langkah berikutnya.

## Cara menerapkan migrasi (yang sungguhan dipakai)

```bash
# Non-Docker
pnpm exec prisma db push

# Docker
docker compose run --rm server pnpm exec prisma db push
```

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
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Cara rollback migrasi

Tidak ada "migrate rollback" karena tidak ada migration history yang
diterapkan secara formal. Rollback yang sungguhan tersedia adalah **restore
dari backup pra-migrasi**:

```bash
deploy/backup/backup.sh                       # WAJIB sebelum migrasi apa pun
# ... jalankan db push, terjadi masalah ...
deploy/backup/restore.sh data/backups/bot-<stamp-sebelum-migrasi>.db
```

Detail lengkap (stop writer → swap file → integrity check → restart →
smoke test) ada di [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md) dan
[ROLLBACK.md](ROLLBACK.md).

## Contoh per environment

### Development (lokal)

```bash
pnpm exec prisma db push
pnpm prisma:generate     # regenerate client jika schema berubah field/model
```
Tidak perlu backup untuk DB dev (`data/bot.db` lokal, biasanya berisi data
uji coba) — tapi tetap disiplin commit `schema.prisma` + folder migrasi SQL
(jika dibuat) di PR yang sama dengan kode yang memakainya.

### Staging

```bash
deploy/backup/backup.sh                 # snapshot dulu meski staging
docker compose run --rm server pnpm exec prisma db push
docker compose restart server
curl -I http://127.0.0.1:8000/healthz   # smoke test
```
Staging adalah tempat **menguji prosedur rollback** sebelum dipraktikkan di
produksi (lihat "Uji end-to-end" di `deploy/backup/README.md`).

### Production

```bash
deploy/backup/backup.sh                                          # 1. backup dulu, SELALU
docker compose run --rm server pnpm exec prisma db push           # 2. terapkan skema
docker compose restart server                                     # 3. restart SEBELUM trafik baru
curl -I https://admin.contoh.com/healthz                          # 4. smoke test
```
Jangan skip langkah 1 — lihat insiden nyata di bagian berikut.

## Kegagalan umum & pemulihan

### `P2022: column ... does not exist`

**Sebab:** kode baru sudah jalan (mereferensikan kolom yang baru ditambah ke
`schema.prisma`), tapi `db push` belum dijalankan ulang ke `data/bot.db` yang
sungguhan — *schema drift* antara kode dan DB live.

**Contoh nyata yang ditemukan saat menyusun dokumentasi ini:** kolom
`claimed_at`/`next_retry_at` ditambahkan ke `NotificationOutbox` di commit
`c4778c8` (2026-06-23, paket fix audit keamanan — lihat
`prisma/migrations/20260623082258_add_notification_claimed_at/` dan
`20260623174936_add_notification_next_retry_at/`). `PRAGMA table_info` pada
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
`PAYMENT_LEDGER_TABLES` terhadap `sqlite_master` dan **fail-loud** (log error +
DM ke semua admin) kalau ada tabel ledger pembayaran yang hilang. Ini menutup
skenario "tabel belum pernah dibuat" (mis. lupa `db push` setelah migrasi yang
menambah tabel baru seperti `order_status_history`).

**Yang TIDAK dicek:** kolom baru pada tabel yang SUDAH ada — `missingTables`
hanya query `SELECT name FROM sqlite_master WHERE type='table'`, tidak pernah
`PRAGMA table_info` per tabel. Jadi migrasi column-only (mis.
`orders.network`/`confirmations`/`required_confirmations`/`first_detected_at`/
`confirmed_at` dari `20260624160712_add_order_status_history`, atau
`broadcasts.web_image_url`/`image_file_id` dari `20260706120000_broadcast_image`)
tidak memicu peringatan apa pun saat boot kalau operator lupa `db push` —
gejala baru muncul sebagai `P2022` pertama kali kode menulis ke kolom yang
belum ada (lihat contoh nyata `claimed_at`/`next_retry_at` di bawah), bukan
sebagai log error saat startup. Ini keterbatasan yang disengaja: menambah
deteksi drift level-kolom (PRAGMA table_info per tabel, dibandingkan terhadap
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
