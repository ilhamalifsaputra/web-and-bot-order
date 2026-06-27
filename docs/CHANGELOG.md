# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/), versi:
[Semantic Versioning](VERSIONING.md). **Jangan hapus entri lama** — tambahkan
selalu di atas. Versi v1.0.0–v1.10.0 di bawah adalah rekonstruksi retroaktif
dari git log (lihat catatan di [VERSIONING.md](VERSIONING.md)); belum ada
tag git yang sungguhan sampai dokumen ini ditulis.

## [Unreleased]

### Fixed
- Gap schema-drift `notification_outbox.claimed_at`/`next_retry_at` ditutup
  via `prisma db push` — lihat [PATCH_GUIDE.md](PATCH_GUIDE.md) untuk detail
  insiden.

## [v1.10.0] — 2026-06-23

### Security
- Tutup 1 temuan Critical (`/admin`+`/wallet` bot tanpa gate otorisasi), 9
  High, dan 24 Medium dari audit keamanan penuh repo (56 temuan total) —
  checkout/ghost-order dedup, reservasi stok atomik, validasi qty
  server-side, voucher per-user cap, klaim atomik outbox + backoff, RBAC
  default-deny, setup-wizard re-lock, FK finansial `Restrict`, crash handler
  global, dan lainnya. Detail penuh: `docs/audit-security-2026-06-23.md`.
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
