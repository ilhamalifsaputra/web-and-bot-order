# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/), versi:
[Semantic Versioning](VERSIONING.md). **Jangan hapus entri lama** — tambahkan
selalu di atas. Versi v1.0.0–v1.10.0 di bawah adalah rekonstruksi retroaktif
dari git log (lihat catatan di [VERSIONING.md](VERSIONING.md)); belum ada
tag git yang sungguhan sampai dokumen ini ditulis.

## [Unreleased]

### Added
- **Refactor katalog dan checkout Game Top-up (bot Telegram; Premium Apps
  tidak berubah).** Dikerjakan bertahap di branch `worktree-game-topup-refactor`:
  - Katalog: region = server (satu level, tanpa level Server terpisah); edisi
    dipisah dari `type` Digiflazz; import Digiflazz mengisi `Product.gameRegion`
    saat Product dibuat, dari akhiran region grup; skrip operator
    `scripts/fill-game-regions.ts` (dry run bawaan) mengisi produk lama; bot
    tidak menyembunyikan produk bila sebagian saudaranya belum punya region.
    Rollback: kode lama mengabaikan isi `gameRegion` (kolomnya sudah ada), jadi
    nilai yang sudah terisi aman dibiarkan; tidak ada migrasi untuk dibalik.
  - Penelusuran: label harga `mulai <harga>` / `from <harga>`, satu baris hint
    per layar, dan `/search` berperingkat khusus Game Top-up. Flag tahap awal
    dihapus, fiturnya selalu aktif. Rollback: kembali ke daftar tanpa label dan
    `/search` lama lewat revert kode; tidak ada saklar di Settings.
  - Input akun satu pesan (mis. ID dan Zone sekaligus), layar review sebelum
    bayar, dan kunci harga: harga yang berubah di antara review dan ketukan
    bayar tidak membuat order, layar dirender ulang dengan keterangan harga
    berubah. Tombol bayar membawa nonce per-render. Rollback: bot lama
    menanyakan field satu per satu tanpa layar review; bubble pembayaran yang
    terbuka saat rollback kehilangan segmen nonce sehingga butuh satu ketukan
    tambahan.
  - Pengingat bayar (`PAYMENT_REMINDER_DM`): satu push ke pembeli Telegram saat
    sisa jendela bayar kira-kira `PAYMENT_REMINDER_LEAD_MINUTES` (bawaan 5)
    menit, untuk order semua layanan dan top-up wallet; tidak dikirim bila
    pembayaran sudah terdeteksi. Rollback: setel `PAYMENT_REMINDER_LEAD_MINUTES=0`
    untuk mematikan pengingat saja; setelah rollback kode, baris outbox bertipe
    ini yang tertinggal menjadi `FAILED` (lihat `docs/ROLLBACK.md`).
  - Notifikasi kedaluwarsa (`ORDER_EXPIRED_DM`): pesan pembayaran diedit
    menjadi "dibatalkan", dan hanya bila pembatalan itu tidak menambah pesan
    baru di chat, pembeli menerima tepat satu push. Rollback: seperti baris di
    atas (`docs/ROLLBACK.md`).
- **Skrip seed fixture manual `scripts/seed-game-topup-fixtures.ts`** dan
  pembangun fixture bersama `tests/helpers/gameTopupFixtures.ts` untuk uji
  manual Game Top-up di `@testtoko_bot`. Skrip menolak jalan kecuali host lokal,
  nama database `bot_order_gtr`, dan flag `--confirm-worktree-db`; bawaannya dry
  run, `--apply` menulis, `--apply --remove` hanya menghapus id yang tercatat di
  manifest tak terlihat (setting `seed_game_topup_manifest`); nama seed tampak
  seperti toko sungguhan, tanpa penanda. Baris bernama sama yang tidak ada di
  manifest ditolak, dan baris lama berakhiran ` [SEED-GTR]` diganti namanya di
  tempat saat `--apply`. Rollback: hapus file; data seed dibersihkan dengan
  `--remove`.
- **Saklar layanan (Top Up Game / Premium Apps) kini dipisah per kanal: bot
  Telegram dan website.** Tiap layanan punya dua kunci setting,
  `service_<id>_enabled_bot` dan `service_<id>_enabled_web`; halaman Settings
  admin menampilkan dua switch per layanan dan `POST /api/settings/services/toggle`
  menerima `{ service, channel, enabled }`. Kunci lama `service_<id>_enabled`
  tetap dibaca sebagai fallback selama kunci kanalnya belum ada (nilai lama
  `false` = kedua kanal mati sampai salah satu disetel), tidak pernah ditulis
  atau dihapus oleh saklar baru. Tanpa kunci apa pun, layanan aktif. Rollback:
  kode lama hanya membaca kunci lama, jadi setelah rollback layanan yang
  dimatikan lewat saklar per kanal yang baru kembali aktif di kedua kanal;
  untuk menerapkannya lagi, setel `service_game_topup_enabled=false` /
  `service_premium_apps_enabled=false` untuk tiap layanan yang harus tetap mati.
- **Audit alur pembayaran menyeluruh (6 rail: TokoPay, PayDisini, NOWPayments,
  Binance Internal, Bybit Internal, Bybit BSC).** Dikerjakan sebagai satu
  branch bertahap; ringkasnya:
  - Notifikasi top-up sukses kini punya **satu produsen** untuk semua rail —
    event outbox `WALLET_TOPUP_CREDITED_DM`, di-enqueue dari satu titik di
    dalam `settleWalletTopup` di balik klaim atomiknya. Sebelumnya tiga rail
    webhook meng-enqueue outbox sementara tiga rail kripto DM langsung, dan
    keduanya sama-sama mengira dirinya satu-satunya — itulah penyebab pembeli
    QRIS menerima dua pesan "top-up berhasil" dengan format berbeda.
  - Bubble QR top-up yang sudah settle kini **dihapus tanpa pengganti**
    (order produk tetap diganti pesan sukses), lewat satu pemetaan
    `bubbleOnPhotoFor(order.kind)`.
  - Bubble pembayaran kini **dibalik sebelum** DM penyelesaian dikirim, di
    semua jalur, lewat hook flush yang dipanggil outbox dispatcher — termasuk
    jalur webhook dan approval admin yang berjalan di proses web dan tidak
    boleh menyentuh Telegram sama sekali. Ini yang membuat kredensial tidak
    lagi tampak datang sebelum "Pembayaran diterima" (tidak ada yang pernah
    terkirim lebih awal — `approveOrder` selalu menggerbanginya; murni urutan
    pesan).
  - Kunci ledger sintetis `reconcile-<orderCode>` dihapus: poller dan webhook
    tiap rail kini menurunkan kunci yang sama, sehingga ledger UNIQUE benar-benar
    menangkap duplikat alih-alih menyerahkannya ke lapisan di bawahnya.
  - `notification_outbox.dedupeKey` (UNIQUE, nullable) dan
    `wallet_transactions @@unique([orderId, reason])` — dua aturan "tepat
    sekali" yang tadinya hanya dijaga letak pemanggilan, kini dijaga database.
  - Kosakata log terstruktur seragam di seluruh jalur pembayaran
    (`PaymentLogEvent`), plus pemetaan status gateway terpusat
    (`paymentStatus.ts`) yang membuat enum Bybit `2` vs `3` yang saling
    terbalik mustahil tertukar di call site.

- Live confirmation-count tracking untuk deposit Bybit BSC on-chain: kolom
  `network`/`confirmations`/`requiredConfirmations`/`firstDetectedAt`/
  `confirmedAt` di `Order`, plus tabel append-only baru `OrderStatusHistory`
  (audit trail tiap transisi `Order.status`, dipakai render timeline
  live-tracking) — migrasi `20260624160712_add_order_status_history`
  (2026-06-24).
- Dukungan gambar opsional pada broadcast web-admin: kolom `webImageUrl`/
  `imageFileId` di `Broadcast`, endpoint upload `/broadcast/photo`, validasi
  panjang caption (1024 char saat ada gambar), dan `drainBroadcasts` kirim
  via `sendPhoto` (cache `file_id` yang di-resolve) alih-alih `sendMessage`
  saat gambar terlampir — migrasi `20260706120000_broadcast_image`, commit
  `ab1411a` (2026-07-06).

### Changed
- **Jendela bayar bawaan per rail dipersingkat: TokoPay QRIS / PayDisini 10,
  Binance Pay 10, Bybit UID 10, Bybit BSC 30, NOWPayments 30 menit** (sebelumnya
  30/15/30/15/30 untuk `PAYMENT_WINDOW_MINUTES`, `INTERNAL_PAYMENT_WINDOW_MINUTES`,
  `BYBIT_PAYMENT_WINDOW_MINUTES`, `BYBIT_BSC_PAYMENT_WINDOW_MINUTES`,
  `NOWPAYMENTS_PAYMENT_WINDOW_MINUTES`). Nilai eksplisit di `.env` tetap menang
  atas bawaan, jadi `.env` lama harus menyunting kelima baris itu agar bawaan
  baru berlaku. Order yang sudah dibuat mempertahankan `expiresAt`-nya.
  Rollback: kembalikan kelima kunci ke nilai lama di `.env` lalu restart
  (nilai lama dicantumkan di `docs/ROLLBACK.md`).
- **Klaim pembayaran `matched` yang macet kini dipulihkan setelah 120 detik**
  (`STALE_MATCHED_CLAIM_MS`, sebelumnya 10 menit), supaya crash di tengah
  pengiriman pada rail berjendela 10 menit masih bisa dipulihkan sebelum order
  dibatalkan otomatis. Rollback: ikut revert kode; kode lama memakai 10 menit.

### Fixed
- Gap schema-drift `notification_outbox.claimed_at`/`next_retry_at` ditutup
  via `prisma db push` — lihat [PATCH_GUIDE.md](PATCH_GUIDE.md) untuk detail
  insiden.
- `reconcileFinances` salah menghitung drift finansial untuk order USDT yang
  dilunasi via saldo wallet USDT: `walletUsed` diperlakukan sebagai IDR dan
  dikurangkan dari `subtotalAmount` SEBELUM konversi IDR→USDT, padahal
  `applyUsdtWalletToOrder` menyimpan `walletUsed` dalam USDT dan
  mengurangkannya dari `totalAmount` yang SUDAH dikonversi — reproduksi order
  produksi #182 (recompute salah 1.6 USDT vs. nilai tersimpan yang benar 0).
  Sekarang jalur USDT dikonversi dulu, baru `walletUsed` (USDT) dikurangkan —
  commit `5c0bba4` (2026-07-06).

## [v1.10.0] — 2026-06-23

### Security
- Tutup 1 temuan Critical (`/admin`+`/wallet` bot tanpa gate otorisasi), 9
  High, dan 24 Medium dari audit keamanan penuh repo (56 temuan total) —
  checkout/ghost-order dedup, reservasi stok atomik, validasi qty
  server-side, voucher per-user cap, klaim atomik outbox + backoff, RBAC
  default-deny, setup-wizard re-lock, FK finansial `Restrict`, crash handler
  global, dan lainnya. Detail penuh: `docs/archive/audit-security-2026-06-23.md`.
- 4 migrasi Prisma baru: voucher redemptions, kolom klaim/backoff outbox,
  FK finansial restricted.

### Fixed
- Disambiguator amount Bybit diperluas (anti kolisi antar order paralel).
- Order yatim (gateway gagal pasca-create) kini auto-cancel, bukan menumpuk
  PENDING.

## [v1.9.0] — 2026-06-22

### Changed
- **Breaking (operator):** Bybit dipindah dari on-chain BEP20
  (`BYBIT_DEPOSIT_ADDRESS`) ke Internal Transfer UID-based (`BYBIT_UID`,
  dikonfigurasi di Settings). `BYBIT_DEPOSIT_ADDRESS`/`_CHAIN` dipertahankan
  di schema env hanya agar `.env` lama tidak gagal parse — tidak dibaca lagi.
- `apps/server` kini menangani `www.<shop host>` sebagai storefront pada
  topologi single-listener.

### Fixed
- Surcharge unique-cents diperkecil 10x untuk order USDT kecil; backoff
  rate-limit poller dibatasi + Bybit punya cadence poll sendiri.

## [v1.8.0] — 2026-06-21

### Added
- Toggle on/off per metode bayar di web-admin (tersembunyi otomatis di
  storefront/bot saat dimatikan).
- Brute-force/rate-limit protection untuk login+forgot storefront.

### Fixed
- Operasi admin (`approve`/`reject`/`credit-balance`, `payments`
  cancel/credit/dismiss) dibungkus `$transaction` (sebelumnya multi-step
  tanpa atomicity).
- Overpayment webhook kini memicu alert admin (bukan silent).

## [v1.7.0] — 2026-06-20

### Added
- Gateway pembayaran **PayDisini** (QRIS/e-wallet IDR) dan **NOWPayments**
  (hosted invoice USDT) — webhook + reconcile poller + idempotency ledger,
  simetris dengan TokoPay.
- UI bot inline: Home, Produk Populer, qty stepper ±5, Refresh Status,
  live-edit-to-success untuk QRIS/PayDisini.

### Removed
- Jalur Binance Pay manual untuk pembeli (digantikan rail auto-confirm).

## [v1.6.0] — 2026-06-19

### Changed
- **Breaking (skema):** rename katalog 3-tier tuntas — `products` (lama) →
  `denominations`, `product_groups` → `products`. Lihat
  `scripts/migrate-catalog-rename.ts` (non-idempotent, sekali-jalan).
- Bot & storefront migrasi penuh ke alur Category → Product → Denomination.

### Added
- `/api/v1/*` internal (dipakai halaman storefront sendiri via fetch/HTMX,
  **bukan** API publik pihak ketiga).

## [v1.5.0] — 2026-06-18

### Added
- Audit production-readiness round 1: CI gate (typecheck+vitest di setiap
  PR), backup/restore WAL-safe, nginx TLS reverse-proxy + runbook 502, access
  log dengan redaksi otomatis.
- `ProductGroup` (fase awal, sebelum rename tuntas di v1.6.0).

### Fixed
- Search katalog dibatasi kandidat read di atas page limit (performa).
- `@fastify/static` naik ke v9 + validasi magic-byte upload.

## [v1.4.0] — 2026-06-17

### Added
- Manajemen stok web-admin: lihat status item, download sisa stok `.txt`,
  hapus/tandai rusak (item SOLD dilindungi dari penghapusan).
- Binance Internal Transfer config DB-driven (`resolveBinanceInternalConfig`).

## [v1.3.0] — 2026-06-14 – 2026-06-16

### Added
- Setup wizard (`/setup`) — instalasi baru tanpa edit `.env` untuk login
  pertama.
- Branding page (favicon/logo/hero/banner upload + identitas toko).
- Dual credit balance (IDR + USDT, tanpa konversi) + credit-on-unfulfilled-order.
- `public_channel_id` dikelola dari web-admin (sebelumnya env-only).

## [v1.2.0] — 2026-06-13

### Added
- Bybit USDT-BSC deposit (awalnya on-chain, lihat v1.9.0 untuk pivot ke
  Internal Transfer) sebagai metode bayar auto-confirm ke-3.

## [v1.1.0] — 2026-06-12

### Added
- `apps/storefront` — toko web pelanggan (Fastify+Nunjucks+HTMX), berbagi DB
  dengan bot.
- Login password storefront (username/email) + Telegram Login Widget
  (lookup-only).
- Forgot/reset password via email (SMTP).
- TokoPay (QRIS, IDR) sebagai metode bayar auto-confirm via webhook.
- `apps/server` — composition root satu-proses.

## [v1.0.0] — 2026-05-30 – 2026-05-31

### Added
- Migrasi `order-bot` dari Python ke Node/TS (grammY) — rewrite penuh,
  retire artefak Python lama.
- Binance Internal Transfer (UID, auto-confirm) sebagai metode bayar
  pertama yang tidak butuh approval manual.
- `apps/web-admin` Tier 1-3: dashboard, RBAC (super/support/readonly), 2FA
  (TOTP), wallet ledger, broadcast.
