# Security

Ringkasan model keamanan aplikasi + status audit. Untuk laporan audit penuh
(56 temuan, metodologi, kode contoh per fix) lihat
[`../docs/audit-security-2026-06-23.md`](audit-security-2026-06-23.md) —
dokumen ini **tidak menduplikasi** isinya, hanya merangkum model yang
berlaku **setelah** semua fix Critical/High/Medium diterapkan (commit
`c4778c8`).

## Model otorisasi

### web-admin — RBAC 3 peran

`super` / `support` / `readonly`, disimpan di `Setting`
(`web_admin_role:{telegramId}`), default `readonly` untuk admin yang
ditambah lewat `/admins/add` (sebelum fix Admin-2, default adalah `super` —
privilege escalation by default). Detail prefix mana yang digerbang ke
siapa: [API_REFERENCE.md](API_REFERENCE.md) "Mekanisme guard".

**Baca selalu terbuka** untuk admin terautentikasi apa pun (termasuk
`readonly`) — audit log, laporan finansial, saldo wallet user semua bisa
DIBACA oleh `readonly`/`support`. Ini **keputusan desain yang sadar**
(Admin-9, ditandai "observasi" bukan bug di audit), bukan kebocoran — kalau
kebutuhan compliance berubah, gate read sensitif ke `super` saja.

### storefront — satu peran (customer)

Tidak ada RBAC — `currentCustomer` adalah satu-satunya gate. IDOR dicegah
konsisten dengan menurunkan `userId` dari sesi (bukan dari parameter URL) +
404 (bukan 403) untuk resource yang bukan milik user.

### Bot Telegram

`adminOnly` middleware di `apps/order-bot/src/middleware.ts` — **wajib**
dipasang di setiap command admin (`/admin`, `/wallet`). Sampai 2026-06-23,
kedua command ini **tidak punya gate apa pun** (Bot-1, **Critical** — temuan
paling serius di seluruh audit: user biasa bisa kredit wallet sendiri tanpa
batas dan membuka panel admin penuh). Sudah ditutup dengan gate di
middleware DAN defensif langsung di handler (karena unit test memanggil
handler langsung, melewati middleware grammY).

## CSRF

Kedua app pakai pola yang sama: token CSRF di-bundle dalam payload cookie
sesi yang **signed double-submit** (HttpOnly) — aman dari CSRF klasik
karena cookie tidak bisa dibaca JS pihak ketiga, dan hanya relevan kalau
sudah ada XSS (yang sudah game-over terlepas dari CSRF). `csrfProtect`
(array preHandler) memverifikasi `body.csrf_token` terhadap klaim di sesi
SETELAH autentikasi, SEBELUM role gate — lihat
[API_REFERENCE.md](API_REFERENCE.md).

Cart guest storefront **mengecualikan diri dari CSRF** (mengandalkan
`SameSite=Lax`) — risiko diterima karena cart bebas-uang & harga
di-recompute server-side saat checkout login-gated.

## Secrets handling

- **Tidak ada hardcoded secret di source** (diverifikasi grep saat audit).
- `.env` di-gitignore, tidak pernah ter-commit; `.env.example` placeholder
  saja.
- Password: `bcrypt` cost 12 (`packages/core/src/password.ts`).
- Token reset password: 32-byte random, **hanya hash SHA-256 disimpan**,
  single-use atomik, TTL dicek.
- Key rahasia di Settings (`tokopay_secret`, `bot_token`, `notif_bot_token`,
  `bybit_api_key`/`_secret`, `web_cookie_secret`) **write-only** di UI: tidak
  pernah di-echo balik, tampil `(hidden)` di tabel, audit log mencatat
  `key=(updated)` tanpa nilai.
- Logger (`packages/core/src/logger.ts`) tidak pernah mencatat password/kode
  reset/token bot/URL webhook. Path token reset di-redaksi dari access log
  (`/reset/[redacted]`) — lihat Storefront-1 fix.
- **Jangan log:** kredensial, `file_id` bukti bayar, hash password, full DB
  URL — aturan eksplisit di [`../CLAUDE.md`](../CLAUDE.md). Permukaan
  risiko berikutnya yang disebut eksplisit di CLAUDE.md: jalur bulk/CSV.

## Settings whitelist — guardrail "jangan brick toko"

`apps/web-admin/src/routes/settings.ts` membatasi `POST /settings/edit` ke
daftar **whitelist eksplisit** (`EDITABLE`) — bukan mass-assignment bebas ke
tabel `Setting`. **Jangan perluas whitelist tanpa review** — ini pengaman
utama supaya admin (bahkan `super`) tidak bisa menulis key sembarangan yang
mematahkan boot aplikasi.

## Idempotensi & konkurensi pembayaran

Setiap gateway punya idempotency ledger dengan UNIQUE constraint pada ID
transaksi gateway — pola insert-first-on-unique (SQLite tidak punya row
lock). Detail per gateway: [PAYMENT_GATEWAY.md](PAYMENT_GATEWAY.md).
**Catatan arsitektural:** beberapa invarian (klaim atomik `approveOrder`,
increment `usedCount` voucher) aman HARI INI karena `BEGIN IMMEDIATE`
SQLite menyerialkan transaksi — begitu migrasi ke Postgres (trigger resmi:
≥2 *concurrent writer*), pola read-then-write yang sama bisa jadi race
eksploitable. Lihat catatan lintas-domain di audit penuh sebelum migrasi DB
dilakukan.

## Network/transport

- App **selalu bind `127.0.0.1`** secara default — ekspos publik **wajib**
  lewat reverse proxy (nginx) + TLS. `WEB_COOKIE_SECURE` defaultnya
  **`false`** — operator **harus** menyalakannya manual di produksi (lihat
  [CONFIGURATION.md](CONFIGURATION.md)); ini jebakan konfigurasi yang nyata
  (Security Defaults Configuration, dicatat sebagai weakness arsitektural).
- `TRUST_PROXY` default **unset** — `X-Forwarded-For` diabaikan total
  kecuali operator eksplisit mengisi alamat proxy tepercaya (Admin-8/
  Storefront-4 fix — sebelumnya XFF dipercaya tanpa daftar, bisa dipakai
  bypass rate-limit per-IP).
- Webhook rate-limited 30 hit/60 detik per route per IP, dicek SEBELUM
  signature/body diproses (Payment-3 fix).
- Upload (`/uploads/*`) mengirim `X-Content-Type-Options: nosniff` + CSP
  ketat agar SVG yang di-upload inert (anti stored-XSS via SVG).

## Status audit (ringkasan)

| Severity | Jumlah | Status |
|---|---|---|
| Critical | 1 | ✅ Ditutup |
| High | 9 | ✅ Ditutup |
| Medium | 24 | ✅ Ditutup (kecuali beberapa partial — lihat catatan implementasi per temuan) |
| Low | 22 | Belum ditutup — prioritas rendah, tidak ada eksploitasi langsung diketahui |

Metodologi: 8 agen paralel meng-audit slice arsitektur independen
(checkout, payment, pricing/voucher/wallet, stock/delivery, admin-web,
storefront auth, bot concurrency, infra/secrets/schema) dengan instruksi
roleplay penyerang/fraudster/rogue-staff. Detail penuh + kode contoh fix:
[`audit-security-2026-06-23.md`](audit-security-2026-06-23.md).

## Melaporkan temuan baru

Tidak ada program bug-bounty formal untuk repo ini. Temuan keamanan baru
sebaiknya didokumentasikan dengan format yang sama dengan audit existing
(SEVERITY · FILE · PROBLEM · ATTACK SCENARIO · BUSINESS IMPACT · FIX ·
CONFIDENCE) agar mudah diprioritaskan bersama temuan Low yang belum ditutup.
