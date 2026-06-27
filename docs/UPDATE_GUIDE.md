# Panduan Update

Prosedur untuk menarik versi baru dan menerapkannya ke instance yang sudah
jalan (produksi atau staging). Untuk konsep versi/rilis, lihat
[VERSIONING.md](VERSIONING.md) dan [CHANGELOG.md](CHANGELOG.md).

## Mengapa urutannya kaku

Aplikasi ini **satu proses** (`apps/server`) yang memegang **satu** koneksi
SQLite. Tidak ada rolling-update multi-instance, tidak ada load balancer di
depan beberapa replica — jadi "zero-downtime" di sini berarti **downtime
seminimal mungkin** (~detik, bukan nol mutlak) lewat urutan yang benar, bukan
blue-green deployment sungguhan.

**Urutan yang salah menyebabkan `P2022`/`P2021`** (lihat
[MIGRATIONS.md](MIGRATIONS.md)) — kode baru mereferensikan kolom/tabel yang
belum ada di DB live.

## Prosedur standar

```bash
# 1. Backup database — TITIK ROLLBACK. Jangan skip.
deploy/backup/backup.sh

# 2. Tarik kode terbaru
git pull

# 3. Install dependency (jika lockfile berubah)
pnpm install --frozen-lockfile      # atau: docker compose build

# 4. Cek migrasi data sekali-jalan (lihat catatan di bawah) SEBELUM lanjut

# 5. Terapkan migrasi skema — SEBELUM restart
pnpm exec prisma db push
# atau: docker compose run --rm server pnpm exec prisma db push

# 6. Build (jika perlu — pnpm start jalan langsung dari source via tsx,
#    biasanya tidak perlu step ini kecuali pakai build:bundle)
pnpm build

# 7. Restart workers/backend — SATU proses, jadi ini juga "restart backend"
pm2 restart bot-order                       # non-Docker
# atau: docker compose restart server       # Docker

# 8. Verifikasi health check
curl -I http://127.0.0.1:8000/healthz       # admin
curl -I http://127.0.0.1:8100/healthz       # storefront (jika diekspos)
```

**Catatan tentang "Restart workers" vs "Restart backend":** di stack lain ini
biasanya dua langkah terpisah (worker pool vs API server). Di sini **tidak
ada bedanya** — outbox dispatcher, payment poller, dan cron job semua
in-process di `apps/server`, jadi satu `docker compose restart server`
merestart semuanya sekaligus. Tidak ada urutan restart parsial yang perlu
dijaga.

## Migrasi data sekali-jalan (`scripts/migrate-*.ts`)

**Cek dulu apakah rilis yang ditarik menyertakan migrasi data, bukan cuma
skema**, sebelum `git pull` dieksekusi ulang ke produksi. Skrip seperti
`migrate-catalog-rename.ts` **tidak idempotent**:

1. Baca komentar header skrip — ada instruksi spesifik kapan/bagaimana jalan.
2. Matikan semua service dulu (`docker compose stop server` /
   `pm2 stop bot-order`).
3. Backup `data/bot.db` (+`-wal`/`-shm`) — sudah tercakup di langkah 1
   prosedur standar, tapi pastikan timestamp-nya tepat sebelum skrip ini.
4. Jalankan skrip sesuai instruksi headernya (`pnpm <nama-skrip>`).
5. `pnpm prisma:generate` sebelum start ulang.
6. **Lewati langkah ini** kalau skrip yang sama sudah pernah dijalankan di DB
   ini (jalankan ulang skrip non-idempotent = korup data).

## Breaking changes & restart order per jenis perubahan

| Jenis perubahan | Langkah tambahan | Butuh restart? |
|---|---|---|
| Kolom/tabel baru (additive) | `db push` sebelum restart | Ya |
| Rename tabel/kolom | Migrasi data sekali-jalan + `db push` + `prisma generate` | Ya |
| Variabel `.env` baru | Isi `.env` sebelum restart (proses tidak reload `.env` sendiri) | Ya |
| Setting baru (DB) | Tidak perlu apa-apa — terbaca live | Tidak (untuk Setting yang "langsung berlaku" — lihat tabel di [`../DOCS.md` §6](../DOCS.md#6-settings-vs-env)) |
| Ganti `bot_token`/`web_cookie_secret` via Settings | — | Ya (proses yang relevan, lihat §6) |
| Dependency baru (`package.json`) | `pnpm install` / `docker compose build` sebelum restart | Ya |

## Cache & "Redis"

**Tidak ada Redis atau cache layer eksternal di stack ini.** Tidak ada
langkah "flush cache" dalam prosedur update — satu-satunya state in-memory
yang hilang saat restart adalah sesi bot grammY (lihat catatan "In-Memory Bot
Sessions" di [ARCHITECTURE.md](ARCHITECTURE.md)): pengguna yang sedang di
tengah wizard/conversation akan kembali ke menu utama setelah restart. Ini
risiko yang diketahui & diterima, bukan bug — informasikan ke pengguna lewat
jendela maintenance singkat jika memungkinkan.

## Verifikasi pasca-update

Checklist lengkap (4 service up, healthcheck hijau, TLS valid, backup cron
aktif) ada di `deploy/README.md` bagian "Deployment checklist". Minimal:

```bash
docker compose ps                           # semua service "Up"/"healthy"
curl -I https://admin.contoh.com/healthz    # 200
curl -I https://shop.contoh.com/healthz     # 200 (jika storefront diekspos)
# di Telegram: /start ke bot → harus membalas
```

## Jika update gagal

Lihat [ROLLBACK.md](ROLLBACK.md) — intinya `deploy/backup/restore.sh
<backup-langkah-1>` mengembalikan DB ke titik sebelum update, lalu
`git checkout <commit-lama>` untuk kode.
