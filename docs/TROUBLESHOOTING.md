# Troubleshooting

Gejala → diagnosis → fix, untuk masalah operasional yang sudah pernah
terjadi atau diketahui bisa terjadi di stack ini. Untuk bug/insiden baru,
ikuti proses sistematis (root cause dulu, bukan tebak-tebak fix) — lihat
catatan investigasi di [PATCH_GUIDE.md](PATCH_GUIDE.md) sebagai contoh.

## Database / Prisma

### `PrismaClientKnownRequestError: column ... does not exist` (P2022)

**Gejala:** Order valid sudah dibayar, tapi gagal di suatu operasi DB
(contoh nyata: `notificationOutbox.create()` gagal dengan
`The column claimed_at does not exist`, menyebabkan alert "Paid but delivery
FAILED ... Manual action needed").

**Diagnosis:** Schema-drift — kode sudah mereferensikan kolom yang baru
ditambah ke `schema.prisma`, tapi `pnpm exec prisma db push` belum
dijalankan ke database PostgreSQL yang dipakai aplikasi. Konfirmasi kolom
aktual di katalog PostgreSQL (contoh `notification_outbox.claimed_at`; ganti
nama tabel/kolom sesuai error). Perintah berikut memakai user/DB default
`bot_order`; sesuaikan jika `.env` memakai nama lain:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml exec -T postgres \
  psql -U bot_order -d bot_order -c "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notification_outbox' ORDER BY ordinal_position;"
```

Bandingkan kolom yang muncul dengan field di `prisma/schema.prisma` untuk
model terkait (perhatikan `@map` pada nama kolom) — kolom yang ada di schema
tapi tidak di output ini adalah gap-nya. Untuk non-Docker, jalankan query
yang sama dengan `psql` terhadap URL host di `.env`.

**Fix:**
```bash
# Docker: setelah backup dan bila tidak sedang rollback, deploy kode/schema yang cocok:
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml logs --since 10m server | grep entrypoint
# Non-Docker: pnpm exec prisma db push, lalu restart proses aplikasi
```
Jika `data/SKIP_AUTO_MIGRATE` ada karena restore, selesaikan pencocokan
kode/database rollback sebelum melepasnya; entrypoint sengaja melewati
schema push selama sentinel ada.
Lihat detail lengkap insiden ini (root cause, fix, testing steps) di
[PATCH_GUIDE.md](PATCH_GUIDE.md) dan mekanisme penuh di
[MIGRATIONS.md](MIGRATIONS.md). **Order yang gagal selama gap terbuka tidak
auto-retry** — cek panel `/outbox` untuk baris stuck/`FAILED` setelah fix.

### `P2021: table does not exist`

Sama akar masalah dengan P2022 tapi untuk tabel yang baru ditambahkan atau
di-rename — jalankan `db push` lalu restart; lihat
[MIGRATIONS.md](MIGRATIONS.md).

## Bot Telegram

### Bot tidak membalas `/start`

**Diagnosis:** `BOT_TOKEN` kosong/salah, atau proses crash.
```bash
docker compose logs server | grep -i bot
# atau: pm2 logs bot-order
```

### Bot crash: `String must contain at least 20 character(s)`

**Diagnosis:** `.env` punya baris `BOT_TOKEN=` (kosong, bukan dihapus) —
schema Zod `blankableOptional` menerima kosong, tapi jika ada whitespace
atau token sebagian (<20 char), validasi `.min(20)` gagal.

**Fix:** Hapus/comment baris `BOT_TOKEN=` di `.env` sepenuhnya (jangan
kosongkan jadi `BOT_TOKEN=`), ATAU isi token lengkap yang valid.

### Error 409 "terminated by other getUpdates"

**Diagnosis:** Dua proses polling memakai **token bot yang sama**
bersamaan — biasanya dua instance toko yang tidak sengaja berbagi
`BOT_TOKEN`.

**Fix:** Pastikan setiap instance toko punya bot @BotFather sendiri
(`BOT_TOKEN` unik) — aturan emas multi-toko di
[`../DOCS.md` §11](../DOCS.md#11-banyak-toko-dalam-satu-vps). Dispatcher
outbox (`sendMessage` saja, bukan `getUpdates`) tidak memicu error ini.

### Sesi/conversation bot reset ke menu utama setelah restart

**Bukan bug** — sesi bot disimpan in-memory (lihat
[ARCHITECTURE.md](arsitektur/ARCHITECTURE.md) "Catatan desain yang diketahui"). Restart
proses mereset state aktif. Informasikan ke pengguna sebelum maintenance
window jika memungkinkan.

## Web Admin / Storefront

### Tidak bisa login / loop login

**Diagnosis:** Mismatch `WEB_COOKIE_SECURE` vs protokol akses.

**Fix:** HTTP lokal (`http://127.0.0.1`) → `WEB_COOKIE_SECURE=false`.
Produksi → HTTPS + `WEB_COOKIE_SECURE=true`. Cookie `Secure` tidak pernah
terkirim balik lewat koneksi plain-HTTP, jadi sesi terlihat seperti tidak
pernah tersimpan.

### Panel tidak bisa diakses dari luar VPS

**Fix:** Non-Docker → set `WEB_HOST=0.0.0.0` (default `127.0.0.1`, idealnya
tetap di balik HTTPS via nginx). Docker → sudah `0.0.0.0` lewat
`docker-compose.yml` (`environment: WEB_HOST: "0.0.0.0"`); cek port
`127.0.0.1:${WEB_PORT}` di host sudah benar di-publish.

### 502/504 dari nginx

Triase berurutan (detail penuh: `deploy/README.md` "502 runbook"):

1. `docker compose ps` — service `Up`/healthy? Jika down/restarting →
   `docker compose logs --tail=100 server` (umumnya `P2022` lupa `db push`,
   atau crash boot karena `.env` salah).
2. `curl -I http://127.0.0.1:8000/healthz` dari host — `200` berarti
   masalah di proxy_pass nginx (port salah); connection refused berarti app
   belum bind (`WEB_HOST` salah).
3. `tail -f /var/log/nginx/error.log` — `connect() failed` (upstream down)
   vs `upstream timed out` (handler lambat — timeout 5s/30s).
4. `docker compose restart server`, verifikasi `/healthz` lokal dulu sebelum
   coba lewat nginx lagi.

## Pembayaran

### Bybit/Binance tidak auto-confirm

**Diagnosis:** Pembeli tidak kirim **jumlah persis** (unique-cents), atau
`USE_UNIQUE_CENTS` mati.

**Fix:** Pastikan `USE_UNIQUE_CENTS=1` (atau aktif di Settings). Pembeli
harus transfer **jumlah persis** yang ditampilkan instruksi (termasuk
desimal unik) — bukan dibulatkan. Tes koneksi API: `pnpm bybit-probe` /
`pnpm exec tsx scripts/binance-probe.ts`.

### Order "paid but delivery FAILED" / alert "Manual action needed"

**Diagnosis:** Pembayaran SUDAH terdeteksi & tercatat di ledger
(`processed_*_tx`, outcome `delivery_failed`) — order TIDAK hilang, tapi
auto-delivery gagal di tengah jalan (race stok, atau — seperti insiden yang
ditemukan saat menyusun dokumentasi ini — schema-drift DB, lihat bagian
"P2022" di atas).

**Fix:** Buka panel admin `/orders/:id`, cek detail. Pilihan: deliver manual
(jika stok ada), atau `creditOrderToBalance` (kredit ke saldo pembeli jika
tidak bisa di-deliver). Jangan abaikan alert ini — dana pembeli sudah masuk.

### Webhook gateway tidak pernah sampai (order menumpuk PENDING lalu auto-cancel)

**Diagnosis:** Callback URL belum didaftarkan di dashboard merchant
(TokoPay/PayDisini), atau app tidak punya HTTPS publik yang reachable dari
internet gateway.

**Fix:** Daftarkan `https://<SHOP_PUBLIC_URL>/pay/{tokopay,paydisini}/callback`
di dashboard masing-masing (NOWPayments otomatis, tidak perlu manual).
Reconcile poller (`POLL_INTERVAL_SECONDS`) tetap jadi fallback selama
jendela bayar belum habis — lihat [PAYMENT_GATEWAY.md](arsitektur/PAYMENT_GATEWAY.md).

**Sejak Task 12:** kalau reconcile poller-nya sendiri juga berhenti (bukan
cuma webhook-nya) — bukan lagi silent sampai order menumpuk lalu
auto-cancel. Ketiga rail QRIS/IDR (TokoPay, PayDisini, NOWPayments) sekarang
punya watchdog sendiri (`tokopayPollWatchdog`/`paydisiniPollWatchdog`/
`nowpaymentsPollWatchdog` di `apps/order-bot/src/jobs/index.ts`): begitu satu
siklus tidak selesai dalam jendela stale rail tersebut (~13,7 menit untuk
ketiga rail — TokoPay, PayDisini, dan NOWPayments — lebih lebar dari 5 menit
milik rail crypto, karena satu siklus QRIS bisa sampai 50 panggilan gateway
berurutan), admin di-DM Telegram sekali per insiden dan rail-nya tampil merah
di kartu Business Health panel admin. Angka ~13,7 menit itu berlaku untuk
poller yang benar-benar berhenti (proses mati atau loop-nya sudah tidak
jalan sama sekali, jadi heartbeat memang tidak pernah ditulis) — kalau
poller-nya masih hidup tapi tiap siklus hang lalu ditinggalkan (abandoned)
berulang-ulang, staleness check ini justru TIDAK pernah kepicu, karena
`onCycleTimeout` di tiap rail menulis heartbeat baru (me-refresh `lastRun`)
persis di titik cycle-timeout rail itu sendiri (~780 detik untuk ketiga rail
— TokoPay, PayDisini, dan NOWPayments) — selalu lebih cepat dari jendela
stale-nya sendiri. Untuk kasus hang-berulang ini, yang memicu alert adalah
rule lain: 3 siklus gagal beruntun (`FAILURE_STREAK_ALERT_THRESHOLD`),
sekitar 39 menit untuk ketiga rail QRIS/IDR — sudah melewati jendela bayar
30 menit default, jadi order yang baru dibuat di awal rentang itu bisa keburu
expired sebelum admin sempat di-DM. Watchdog hanya aktif kalau kredensial
rail terkait sudah diisi di Settings — rail yang memang belum dipakai toko
tidak akan pernah memicu alert.

## Notifikasi (outbox)

### Baris `notification_outbox` stuck `SENDING`

**Diagnosis:** Dispatcher mati di tengah kirim (crash-window). Baris
otomatis claimable lagi setelah `STALE_CLAIM_MS` (5 menit) — TIDAK perlu
intervensi manual untuk kasus ini.

### Baris `FAILED` permanen

**Fix:** Panel admin `/outbox` → tombol **Retry** (`retryNotification`) —
reset `attempts=0`, hapus backoff, requeue ke `PENDING`. Lihat
[QUEUE_SYSTEM.md](arsitektur/QUEUE_SYSTEM.md).

### Channel testimoni tidak pernah posting

**Diagnosis:** `PUBLIC_CHANNEL_ID` belum diset — baris `ORDER_DELIVERED`
dilepas balik ke `PENDING` tanpa dihitung gagal (bukan `FAILED`), menunggu
channel dikonfigurasi.

**Fix:** Set `public_channel_id` di Settings (bot harus jadi admin channel
itu).

## Migrasi data sekali-jalan

### Skrip migrasi data sekali-jalan dijalankan dua kali, data jadi aneh

**Diagnosis:** Skrip ini **tidak idempotent** — menjalankannya ulang di DB
yang sudah pernah diproses bisa korup data.

**Fix:** `deploy/backup/restore.sh <backup-sebelum-skrip-dijalankan>`. Tidak
ada jalur "undo" otomatis — lihat [ROLLBACK.md](ROLLBACK.md).

## Eskalasi

Jika gejala tidak ada di daftar ini: kumpulkan log
(`docker compose logs -f server` / `pm2 logs bot-order`), cek
`docker compose ps`/`/healthz`, lalu ikuti proses investigasi root-cause
penuh sebelum menerapkan fix (jangan tebak-tebak) — pola yang dipakai untuk
menulis [PATCH_GUIDE.md](PATCH_GUIDE.md) bisa jadi referensi.
