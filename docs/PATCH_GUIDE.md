# Panduan Patch (Bugfix)

Setiap bugfix — sekecil apa pun — didokumentasikan dengan template di bawah,
ditambahkan sebagai entri baru ke [CHANGELOG.md](CHANGELOG.md) (bagian
`Fixed`) dan, bila ada perubahan skema, ke [DATABASE.md](DATABASE.md) +
[MIGRATIONS.md](MIGRATIONS.md). Dokumentasi adalah bagian dari fix, bukan
langkah opsional setelahnya.

## Template

```markdown
### <judul ringkas bug>

- **Issue:** <gejala yang dilihat user/admin, bukan root cause>
- **Cause:** <root cause sebenarnya — hasil investigasi, bukan tebakan>
- **Files changed:** <daftar file:baris>
- **Database changes:** <ya/tidak — kolom/tabel apa>
- **Migration required?:** <ya/tidak — `db push` cukup, atau perlu skrip data>
- **Rollback procedure:** <langkah konkret, bukan "restore backup" generik>
- **Testing steps:** <cara verifikasi fix bekerja, termasuk regression test>
- **Affected modules:** <apps/packages yang tersentuh>
- **Release date:** <YYYY-MM-DD>
- **Developer notes:** <hal non-obvious untuk pembaca masa depan>
```

## Contoh terisi — insiden `claimed_at` (2026-06-24)

### Outbox notification gagal: `P2022 column claimed_at does not exist`

- **Issue:** Order yang sudah dibayar (`ORD-20260623-PKVZ`) gagal mengantre
  notifikasi pengiriman — alert admin "⚠️ Paid but delivery FAILED ...
  PrismaClientKnownRequestError ... column claimed_at does not exist". Order
  valid & sudah dibayar, tapi pembeli tidak menerima kredensial otomatis.
- **Cause:** Commit `c4778c8` (2026-06-23, paket fix audit keamanan)
  menambahkan kolom `claimed_at`/`next_retry_at` ke `NotificationOutbox` di
  `schema.prisma` + dua file migrasi SQL (`20260623082258_add_notification_claimed_at/`,
  `20260623174936_add_notification_next_retry_at/`) DAN mengubah
  `packages/db/src/crud/notifications.ts` untuk memakai kolom itu di setiap
  `create()`/`update()`. Tapi `pnpm exec prisma db push` tidak dijalankan
  ulang ke `data/bot.db` yang sungguhan sebelum kode baru jalan — *schema
  drift* klasik (lihat [MIGRATIONS.md](MIGRATIONS.md) "Kegagalan umum").
- **Files changed:** Tidak ada perubahan KODE untuk fix ini — kode sudah
  benar sejak commit `c4778c8`. Yang berubah hanya state DB
  (`data/bot.db`, via `db push`).
- **Database changes:** Kolom `claimed_at` (`DATETIME`, nullable) dan
  `next_retry_at` (`DATETIME`, nullable) ditambahkan ke `notification_outbox`.
  Keduanya nullable tanpa default — additive, tidak ada risiko data loss.
- **Migration required?:** Ya — `pnpm exec prisma db push` (bukan skrip data
  custom; perubahan murni `ALTER TABLE ADD COLUMN`).
- **Rollback procedure:** Tidak relevan untuk fix ini (additive, tidak ada
  downside untuk roll-forward). Jika perlu mundur ke commit SEBELUM
  `c4778c8` karena alasan lain: kolom baru di DB tidak mengganggu kode lama
  (kode lama cukup tidak membaca kolom itu) — aman dibiarkan ada.
- **Testing steps:**
  1. `sqlite3 data/bot.db "PRAGMA table_info(notification_outbox);"` —
     konfirmasi `claimed_at`/`next_retry_at` ADA sebelum klaim fix selesai.
  2. Restart proses (`pnpm start` ulang / `docker compose restart server`).
  3. Trigger satu order test sampai `DELIVERED` → konfirmasi baris
     `notification_outbox` baru ter-`INSERT` tanpa error di log.
  4. Re-trigger pengiriman `ORD-20260623-PKVZ` lewat panel admin `/outbox`
     (tombol Retry) → konfirmasi status berubah ke `SENT`.
- **Affected modules:** `packages/db` (crud/notifications.ts),
  `packages/outbox-dispatcher`, `prisma/schema.prisma`. Tidak menyentuh
  `apps/order-bot`/`apps/web-admin`/`apps/storefront` langsung.
- **Release date:** 2026-06-24 (penerapan `db push` yang menutup gap;
  kode aslinya sudah rilis di `c4778c8`, 2026-06-23).
- **Developer notes:** Ini BUKAN bug logic — pelajaran prosesnya adalah
  **`db push` ke DB live wajib jadi langkah eksplisit di setiap deploy/update**
  (lihat [UPDATE_GUIDE.md](UPDATE_GUIDE.md)), tidak bisa diasumsikan otomatis
  ikut `git pull`. Order yang gagal terkirim selama gap ini terbuka **tidak
  auto-retry** — selalu cek panel `/outbox` untuk baris `FAILED`/stuck setelah
  insiden schema-drift seperti ini.

## Kapan migrasi dianggap "required"

- **Additive** (kolom/tabel baru, nullable/default) → `db push` saja, aman
  roll-forward, jarang perlu rollback DB.
- **Destruktif** (rename/drop kolom, NOT NULL tanpa default ke tabel berisi
  data) → wajib backup dulu (`deploy/backup/backup.sh`), pertimbangkan
  apakah perlu skrip backfill terpisah — lihat pola di
  [MIGRATIONS.md](MIGRATIONS.md) "Disiplin migrasi aman".
