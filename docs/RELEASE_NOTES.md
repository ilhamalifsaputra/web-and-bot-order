# Release Notes

Turunan dari [CHANGELOG.md](CHANGELOG.md), dengan info migrasi/restart yang
operator butuhkan untuk tiap rilis. Lihat [VERSIONING.md](VERSIONING.md)
untuk catatan bahwa v1.0.0–v1.10.0 adalah rekonstruksi retroaktif (belum ada
tag git nyata).

---

## v1.10.0 — 2026-06-23

**Fitur:** —  (rilis hardening, bukan fitur baru)
**Fixes:** 1 Critical + 9 High + 24 Medium dari audit keamanan penuh (lihat
`docs/audit-security-2026-06-23.md`) — auth bot `/admin`/`/wallet`,
RBAC default-deny, reservasi stok atomik, voucher per-user cap, klaim outbox
atomik+backoff, FK finansial restricted, crash handler global, dan lainnya.
**Known issues:** Beberapa temuan Low (lihat dokumen audit) belum ditutup —
prioritas rendah, tidak ada eksploitasi langsung diketahui.
**Migration required?:** **Ya** — 4 migrasi baru (voucher redemptions, kolom
`claimed_at`/`next_retry_at` outbox, FK restricted). `pnpm exec prisma db
push` sebelum restart.
**Restart required?:** Ya (semua perubahan di `packages/db`/skema).
**Rollback notes:** Additive only (kolom baru nullable, FK Restrict tidak
mengubah data ada) — aman roll-forward. Mundur ke commit sebelumnya tanpa
restore DB tetap aman (kode lama mengabaikan kolom baru), TAPI akan
mengembalikan kerentanan yang baru ditutup — hanya lakukan ini darurat.

---

## v1.9.0 — 2026-06-22

**Fitur:** Bybit pindah dari on-chain BEP20 ke Internal Transfer (instan,
tanpa biaya gas, UID-based).
**Fixes:** Surcharge unique-cents diperkecil untuk order kecil; backoff
rate-limit poller dibatasi.
**Known issues:** —
**Migration required?:** Tidak (perubahan konfigurasi/Settings, bukan skema).
**Restart required?:** Ya, jika mengganti `BYBIT_UID`/kredensial di Settings
pada deploy non-Docker yang belum auto-reload (lihat §6 DOCS.md).
**Operator action:** Set `BYBIT_UID` (bukan lagi `BYBIT_DEPOSIT_ADDRESS`) di
web-admin → Settings jika memakai Bybit.
**Rollback notes:** Reversibel via Settings (isi ulang alamat on-chain lama)
TAPI rail on-chain BEP20 lama sudah tidak punya jalur kode — rollback berarti
mundur kode juga.

---

## v1.8.0 — 2026-06-21

**Fitur:** Toggle on/off per metode bayar; rate-limit login/forgot
storefront.
**Fixes:** Operasi admin (approve/reject/credit/cancel) dibungkus
`$transaction`.
**Known issues:** —
**Migration required?:** Tidak.
**Restart required?:** Ya (kode aplikasi berubah).
**Rollback notes:** Standar — `git checkout` ke commit sebelumnya, tidak ada
state DB yang perlu dikembalikan.

---

## v1.7.0 — 2026-06-20

**Fitur:** Gateway **PayDisini** + **NOWPayments**; UI bot inline baru.
**Fixes:** —
**Known issues:** Endpoint/skema signature PayDisini & sebagian NOWPayments
ditandai `ASSUMPTION (flagged)` di kode — **belum diverifikasi ke dashboard
live**, verifikasi sebelum go-live dengan gateway ini (lihat
[PAYMENT_GATEWAY.md](PAYMENT_GATEWAY.md)).
**Migration required?:** Ya — tabel `processed_paydisini_tx` +
`processed_nowpayments_tx` baru.
**Restart required?:** Ya.
**Rollback notes:** Matikan gateway via Settings (`paydisini_enabled`/
`nowpayments_enabled` = false) tidak butuh rollback kode jika hanya ingin
menonaktifkan tanpa mundur versi.

---

## v1.6.0 — 2026-06-19

**Fitur:** Rename katalog 3-tier tuntas; `/api/v1/*` internal.
**Fixes:** Berbagai bug bot/storefront pasca-rename (back-button loop,
field naming).
**Known issues:** —
**Migration required?:** **Ya, dan butuh skrip data sekali-jalan**
(`pnpm migrate-catalog-rename`) — **TIDAK idempotent**. Baca header skrip,
backup dulu, matikan service, baca [MIGRATIONS.md](MIGRATIONS.md).
**Restart required?:** Ya.
**Rollback notes:** Restore dari backup pra-migrasi — skrip rename tidak
punya jalur "undo" otomatis.

---

## v1.5.0 — 2026-06-18

**Fitur:** CI gate, backup/restore WAL-safe, nginx TLS + runbook 502, access
log.
**Fixes:** Performa search katalog, keamanan upload (`@fastify/static` v9 +
magic-byte check).
**Known issues:** —
**Migration required?:** Tidak (infra/tooling, bukan skema — kecuali
`ProductGroup` fase awal, additive).
**Restart required?:** Ya untuk perubahan kode; tidak untuk `deploy/`
tooling murni.
**Rollback notes:** Standar.

---

## v1.4.0 — 2026-06-17

**Fitur:** Manajemen stok web-admin (lihat/download/hapus), Binance config
DB-driven.
**Migration required?:** Tidak.
**Restart required?:** Ya.

---

## v1.3.0 — 2026-06-14 s/d 2026-06-16

**Fitur:** Setup wizard, Branding page, dual credit balance, public channel
ID di web.
**Migration required?:** Ya — kolom wallet USDT, kolom branding di Setting
(additive).
**Restart required?:** Ya.
**Operator action:** Instalasi BARU tidak perlu lagi edit `.env` untuk login
pertama — arahkan ke `/setup`.

---

## v1.2.0 — 2026-06-13

**Fitur:** Bybit USDT-BSC (on-chain, kemudian dipindah ke Internal Transfer
di v1.9.0).
**Migration required?:** Ya — tabel `processed_bybit_tx`.
**Restart required?:** Ya.

---

## v1.1.0 — 2026-06-12

**Fitur:** `apps/storefront`, password auth, TokoPay, `apps/server`
composition root.
**Migration required?:** Ya — tabel `users` (kolom login web), `password_reset_tokens`,
`processed_tokopay_tx`.
**Restart required?:** Ya.
**Operator action:** Tinjau apakah ingin mengekspos storefront
(`STOREFRONT_PORT` atau `SHOP_HOST`) — sebelumnya hanya bot yang publik.

---

## v1.0.0 — 2026-05-30 s/d 2026-05-31

**Fitur:** Rewrite Python→Node/TS, Binance Internal Transfer, web-admin
Tier 1-3 (RBAC, 2FA, wallet, broadcast).
**Migration required?:** Ya — skema awal Node/Prisma (port dari SQLAlchemy).
**Restart required?:** Ya (ini adalah cutover stack, bukan update inkremental
— lihat catatan "jangan jalankan order-bot Python & Node bersamaan" di
`docker-compose.yml`).
**Rollback notes:** Rollback ke stack Python lama tidak didukung lagi
(artefak Python sudah di-retire) — titik tidak-bisa-mundur proyek ini.
