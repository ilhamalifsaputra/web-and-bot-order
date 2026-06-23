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
berfungsi sebagai **dokumentasi/audit-trail SQL** (dibuat & divalidasi byte-identik
via `prisma migrate diff` terhadap shadow DB saat fitur ditambahkan — lihat
komentar di `docs/audit-security-2026-06-23.md` §Infra-5/§Pricing-1), bukan
mekanisme penerapan yang dijalankan otomatis.

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
