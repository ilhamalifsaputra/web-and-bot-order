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

### Pembayaran tercatat `matched` di ledger, tapi order `CANCELLED` dan tidak terkirim

**Diagnosis:** proses mati (restart, OOM, koneksi DB putus) tepat di antara
klaim ledger (`processed_*_tx`, outcome `matched`, di-commit sendiri) dan
transaksi delivery. Order tetap `PENDING_PAYMENT`, lalu poller/webhook
memulihkannya otomatis setelah klaim berumur 2 menit
(`STALE_MATCHED_CLAIM_MS`, `packages/db/src/crud/_staleClaim.ts`). Kalau
`expiresAt` keburu lewat (crash di menit-menit terakhir jendela 10 menit),
`autoCancelExpiredOrders` membatalkan order dan pemulihan tidak mungkin lagi:
`reclaimStaleMatchedClaim` (`_staleClaim.ts`) menolak order produk yang bukan `PENDING_PAYMENT`, retry
berikutnya hanya log `already_processed` (bukan `stale`), dan tombol kredit
(`canCreditCancelled`, `packages/db/src/crud/orders.ts`) tidak muncul karena
`orderHasIncomingLedgerPayment` (`packages/db/src/crud/reports.ts`) hanya
menghitung `delivery_failed`/`unmatched`.

**Alert:** sejak follow-up item 2, `cancelOrder` mengirim DM ke setiap admin
(`ADMIN_STALE_PAYMENT`, teks "payment ... was claimed, but the order was
cancelled before it was delivered" / "pembayaran ... sudah tercatat, tapi
pesanan dibatalkan sebelum dikirim"), satu kali per admin per order, saat
order produk `PENDING_PAYMENT` tanpa `paid_at` dibatalkan (auto-cancel,
pembeli, atau admin) padahal ada baris `matched` untuknya
(`orderMatchedLedgerClaim`, `reports.ts`). Alert itu tidak mengkredit apa pun
dan tidak mengubah baris ledger.

**Fix (manual; jalur kredit otomatis masih keputusan pemilik) — HANYA order
produk:** dari alert (atau dengan mencari baris ledger `matched` yang
`order_id`-nya menunjuk order produk `CANCELLED` dengan `paid_at` kosong),
cocokkan dengan dashboard gateway, lalu selesaikan dana pembeli secara manual
(kredit saldo lewat penyesuaian admin atau refund). Top-up dompet tidak
menerima alert ini, karena alasan di bawah.

**JANGAN lakukan ini untuk top-up dompet (`kind = WALLET_TOPUP`).** Top-up yang
`CANCELLED` dengan klaim `matched` tetap bisa diklaim ulang dan dikreditkan
otomatis saat webhook/poller berikutnya (`isLateSettleableWalletTopup`,
`packages/db/src/crud/wallet_topup.ts`). Kredit manual di atasnya membuat
saldo terkredit dua kali, karena status order tetap `CANCELLED` dan
penyelesaian otomatis masih lolos. Biarkan top-up menyelesaikan dirinya; kalau
tidak ada retry yang akan datang, keluarkan dulu baris ledger dari `matched`
(atau blokir klaim ulangnya) sebelum mengkredit manual.

**Masih keputusan pemilik:** jalur kredit untuk kasus ini belum dibangun
(alert-nya sudah) — lihat `docs/game-topup-refactor-phase1-design.md` §9.1.

### Order NOWPayments lewat `expiresAt` tapi belum dibatalkan, atau alert "still confirming"

**Diagnosis:** NOWPayments sudah melaporkan pembayaran (`payment_state`
`PAYMENT_DETECTED`/`VERIFYING`) tapi belum selesai dikonfirmasi saat jendela
bayar habis. Order produk seperti ini sengaja **tidak** dibatalkan selama
30 menit setelah `expiresAt` (`OBSERVED_PAYMENT_GRACE_MS`,
`packages/core/src/paymentReminder.ts`): auto-cancel melewatinya (log info
"... keeping it open for up to 30 more minutes ...") dan poller NOWPayments
tetap memeriksanya, jadi pembayaran yang selesai dalam masa itu tetap
terkirim normal. Lewat masa itu order dibatalkan seperti biasa dan setiap
admin menerima satu DM `ADMIN_UNCONFIRMABLE_PAYMENT` ("... was still
confirming, so the order has been cancelled" / "... masih dikonfirmasi, jadi
pesanan sudah dibatalkan"). Top-up dompet tidak ditahan (pembayaran yang
terlambat tetap menyelesaikannya otomatis).

**Fix:** dalam masa tenggang, tidak perlu tindakan. Setelah alert, periksa
pembayaran di dashboard NOWPayments; bila dananya masuk, selesaikan manual
(refund atau kredit saldo) — tidak ada pengiriman otomatis untuk order yang
sudah dibatalkan.

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
siklus tidak selesai dalam jendela stale rail tersebut, admin di-DM
Telegram sekali per insiden dan rail-nya tampil merah di kartu Business
Health panel admin. Jendela stale = cycle-timeout rail + `POLL_INTERVAL_SECONDS`
+ 30 detik, dan cycle-timeout itu diturunkan dari jendela bayar rail
(`reconcileBudgetForWindow`, `packages/core/src/payments/reconcileCycleBudget.ts`,
maksimal 40% jendela bayar): dengan default sekarang ~4,7 menit untuk TokoPay
dan PayDisini (jendela bayar 10 menit, 14 panggilan gateway per siklus,
cycle-timeout 240 detik) dan ~12,7 menit untuk NOWPayments (jendela 30 menit,
46 panggilan per siklus, cycle-timeout 720 detik). Angka itu berlaku untuk
poller yang benar-benar berhenti (proses mati atau loop-nya sudah tidak
jalan sama sekali, jadi heartbeat memang tidak pernah ditulis) — kalau
poller-nya masih hidup tapi tiap siklus hang lalu ditinggalkan (abandoned)
berulang-ulang, staleness check ini justru TIDAK pernah kepicu, karena
`onCycleTimeout` di tiap rail menulis heartbeat baru (me-refresh `lastRun`)
persis di titik cycle-timeout rail itu sendiri (240 detik untuk TokoPay
dan PayDisini, 720 detik untuk NOWPayments, dengan default sekarang) — selalu
lebih cepat dari jendela stale-nya sendiri. Untuk kasus hang-berulang ini,
yang memicu alert adalah rule lain: 3 siklus gagal beruntun
(`FAILURE_STREAK_ALERT_THRESHOLD`), sekitar 12 menit untuk TokoPay/PayDisini
dan 36 menit untuk NOWPayments — tetap sedikit melewati jendela bayar rail
itu sendiri, jadi order yang baru dibuat di awal rentang itu bisa keburu
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
