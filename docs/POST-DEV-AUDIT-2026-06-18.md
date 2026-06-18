# Post-Development Audit Report — 2026-06-18

Audit read-only sesuai `postdev.md`. **Tidak ada kode yang diubah.** Bukti dikutip
dengan `file:baris`. Skala acuan: satu toko, SQLite tunggal (single-writer), proses
gabungan via `apps/server`.

---

## Phase 0 — Project Understanding

**Arsitektur:** pnpm monorepo, TypeScript, satu composition root `apps/server`
(`apps/server/src/index.ts`, 303 loc) yang menyatukan bot + web-admin + storefront
+ notifier dalam satu proses, satu `PrismaClient`.

```
apps/
  order-bot/     grammY (Telegram)        — handlers/, conversations/, keyboards/, jobs/, payments/
  web-admin/     Fastify + Nunjucks + HTMX — routes/, plugins/auth, lib/upload
  storefront/    Fastify + Nunjucks        — routes/, cards.ts, views/
  notifier/      pengirim antrian Telegram
  server/        composition root (prod)
packages/
  core/          money(Decimal), i18n(en/id), config(zod), password(bcrypt), logger(pino)
  db/            Prisma + crud/* (per-domain) + client.ts (PRAGMA WAL)
prisma/schema.prisma  24 model, 28 @@index, FK on
```

**Flow request (web):** Fastify route → preHandler (`currentAdmin`/`csrfProtect`) →
crud `packages/db/src/crud/*` → Prisma → SQLite. **Tidak ada SQL mentah di route.**

**DB:** SQLite `data/bot.db`, `PRAGMA foreign_keys=ON`, `journal_mode=WAL`,
`busy_timeout=5000` (`packages/db/src/client.ts:31-34`).

**Deploy:** Docker (`docker-compose.yml`, healthcheck `/healthz`) atau non-Docker
(pnpm + pm2). Bind `127.0.0.1` default → butuh reverse proxy + TLS untuk publik.

### High-Risk Areas (untuk fase berikut)
- **Payment**: Bybit deposit + Binance internal (`apps/order-bot/src/payments/*`).
- **Auth**: web-admin TOTP 2FA + lockout; storefront login/registrasi.
- **File upload**: `apps/web-admin/src/lib/upload.ts` + penyajian `/uploads/`.
- **Webhook/queue**: `notification_outbox`, `broadcasts`, jobs bot.

---

## Phase 1 — Security Audit (OWASP)

| Area | Status | Bukti |
|---|---|---|
| Password hashing | ✅ bcrypt cost 12 | `packages/core/src/password.ts:4` |
| Session cookie | ✅ httpOnly + sameSite=lax + secure(prod) | `apps/web-admin/src/routes/auth.ts:167-169` |
| CSRF (mutasi) | ✅ `csrfProtect` preHandler; upload cek CSRF manual | `lib/upload.ts:48-57` |
| Brute-force | ✅ throttle IP + lockout per-akun (429) | `routes/auth.ts:106,114-116` |
| 2FA | ✅ TOTP RFC 6238 (node:crypto) | `apps/web-admin/src/auth.ts:53` |
| SQL Injection | ✅ tak ada raw SQL di route (hanya PRAGMA + `SELECT 1`) | `client.ts:31-34`, `storefront/src/server.ts:98` |
| Secret logging | ✅ eksplisit tak pernah log secret/kode/URL webhook | `routes/auth.ts:198`, `server/src/index.ts:248` |
| Web → Telegram | ✅ tak pernah; pakai outbox/broadcast queue | `routes/broadcast.ts:3-4`, `routes/auth.ts:197` |
| File upload | ✅ CSRF + role + MIME allowlist + size limit | `lib/upload.ts:41-63` |
| Anti-enumeration | ✅ /forgot & login balas pesan generik sama | `routes/auth.ts:229` |

**Route POST tanpa `csrfProtect` inline — semua terverifikasi aman:**
- `/bootstrap`, `/login`, `/forgot`, `/reset`, `/logout`, `/setup/*` → **pra-auth**
  (belum ada sesi/CSRF token), wajar.
- `/branding/*`, `/settings/qr`, `/catalog/product/:id/photo` → multipart upload yang
  **memvalidasi CSRF di dalam handler** (`lib/upload.ts:48-57`), bukan celah.

### Temuan

**[MEDIUM] Dependency rentan — `@fastify/static@8.3.0` (2 advisory moderate).**
- Path traversal `GHSA-pr96-94w5-mx2h` + route-guard bypass `GHSA-x428-ghpx-8j92`.
- Versi rentan `>=8.0.0 <=9.1.0`; **patch `>=9.1.1`**.
- Relevan: storefront menyajikan `/uploads/` (file unggahan user) & `/static/`
  (`apps/storefront/src/server.ts:40-50`), dan web-admin juga.
- **Fix:** naikkan `@fastify/static` ke `^9.1.1` (atau `^8.x` ≥ patch jika ada) di
  `apps/storefront/package.json:21` & `apps/web-admin/package.json:22`, lalu
  `pnpm install` + jalankan ulang test. Mitigasi yang sudah ada: `/uploads/` sudah
  `X-Content-Type-Options: nosniff` + CSP `default-src 'none'`.

Tak ditemukan: hardcoded secret, CORS longgar, atau endpoint sensitif terbuka.

---

## Phase 2 — Functional Audit

- **Test suite: 518 lulus / 0 gagal, 42 file** (`npx vitest run`, 2026-06-18).
- Cakupan flow: register/login/2FA, CRUD katalog, search, checkout (Bybit/USDT),
  voucher, stok (race/out-of-stock), reconciliation, password reset (one-time,
  invalidasi sesi), referral.
- Race/stok: `create order from cart > out-of-stock request throws and leaks no
  RESERVED rows` membuktikan transaksi stok aman.
- **Bug fungsional: tidak ada yang teridentifikasi** dari suite + pembacaan kode.

---

## Phase 3 — UI Audit (checklist)

Storefront memakai design-system terpusat (`_shop.njk` macro + filter `idr`/`usdt`),
web-admin pakai `_macros.njk`. Konsistensi tinggi karena komponen dibagikan.

- [x] Tipografi/spacing via util class Tailwind konsisten (`card`, `card-pad`, `chip`)
- [x] Kartu produk & grup memakai macro tunggal → konsisten
- [x] Responsive grid (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`)
- [ ] **Dark mode**: tak ada (di luar scope; bukan kebutuhan toko)
- [ ] **Audit visual manual** (overflow/misalignment) belum dilakukan — perlu mata
  manusia di browser; rekomendasi: cek halaman `home`, `pay`, `settings` (file njk
  terbesar) di viewport mobile.

---

## Phase 4 — UX Audit

Flow: Home → (Kategori/Grup) → Denominasi → Detail → Cart → Checkout → Pay → Success.

- ✅ **Hierarki denominasi baru** (Parent → Denominasi → Order) baru saja diterapkan
  di Home & Search — mengurangi kebingungan "produk datar".
- ✅ Empty state ada (`web.catalog_empty`, `web.search_empty`).
- ✅ Bot: tiap layar terminal selalu menyediakan aksi maju (Menu/Pesanan/Back) —
  aturan "never strand the user" (CLAUDE.md).
- ⚠️ **Loading/disable saat submit**: storefront berbasis form POST klasik (bukan
  SPA), jadi double-submit dicegah server-side; namun tombol checkout tak otomatis
  disable di klien. Bot sudah pakai state `admin.processing` anti double-tap.
  Rekomendasi minor: tambah `disabled`+spinner pada tombol bayar via JS kecil.

---

## Phase 5 — Performance Audit

**Backend (temuan utama):**
- ⚠️ **`searchCatalogEntries` tanpa `take` di sisi DB** (`packages/db/src/crud/catalog.ts`):
  memuat semua produk yang cocok lalu memotong di memori. Sama pola dengan
  `listCatalogEntries` (scan seluruh kategori). **Aman di skala satu toko**, tapi
  pada katalog besar query luas (`q="a"`) boros memori. Fix bila katalog tumbuh:
  `take: limit * 4` pada query match.
- ✅ Tidak ada N+1 mencolok: badge rating/bulk diambil sekali sebagai map
  (`productRatingSummaries`, `activeBulkPricingByProduct`).
- ✅ Order list admin sudah paginasi (`routes/orders.ts:36-37`, `PAGE_SIZE`).

**Frontend:** server-rendered Nunjucks, gambar `loading="lazy" decoding="async"`,
hero `fetchpriority="high"`. Bundle JS minim (HTMX + skrip inline). Tak ada isu berat.

---

## Phase 6 — Database Audit

- ✅ 28 `@@index`, FK aktif, WAL, `busy_timeout` → setup SQLite sehat.
- ✅ Money disimpan Decimal (bukan float) — aturan inti dipatuhi.
- ⚠️ **Single-writer SQLite** = batas arsitektural utama. Sudah didokumentasikan:
  pemicu pindah ke Postgres = ≥2 concurrent writer (CLAUDE.md / RUN.md §9).
- ✅ `deleteGroup` melepas member dalam `$transaction` (tak ada orphan FK).
- Rekomendasi: tetap pantau panjang `$transaction` agar tak memblok writer tunggal.

---

## Phase 7 — Architecture Audit

- ✅ Pemisahan baik: crud per-domain (`packages/db/src/crud/*`), tak ada SQL di route.
- ⚠️ **God-file (LOC tinggi)** — kandidat refactor (ROI menurun):
  - `apps/order-bot/src/conversations/admin.ts` — **934**
  - `apps/order-bot/src/handlers/checkout.ts` — **809**
  - `packages/db/src/crud/orders.ts` — **765**
  - `apps/order-bot/src/handlers/customer.ts` — **748**
  - `apps/order-bot/src/handlers/admin.ts` — **651**
  - `apps/web-admin/src/routes/catalog.ts` — **584**
- ⚠️ **Duplikasi minor (sudah dicatat)**: helper `card()` di `storefront/routes/catalog.ts`
  meniru cabang produk `shapeEntries` (`cards.ts`). Bersihkan saat `/c/:id` direvisi.

---

## Phase 8 — Dead Code Audit

**Safe to remove:**
- `singletruth.txt` (untracked) — file plan "Single Source of Truth for Runtime
  Config" yang tercecer di root. Bukan kode; pindahkan ke `docs/` atau hapus.
- `postdev.md` (untracked) — plan audit ini sendiri; simpan/relokasi sesuai selera.
- Route bulk `/catalog/group/:id/assign` **sudah dihapus** di commit `4bfb389`.

**Need verification:** tak ada import/komponen/env yatim yang terdeteksi
(`pnpm -r typecheck` bersih = tak ada import mati yang fatal).

---

## Phase 9 — Error Handling Audit

- ✅ **Tidak ada `catch {}` / `catch(e){}` kosong** di seluruh `apps/` & `packages/`.
- ✅ Error tak terduga ditangani: storefront & web-admin punya `setErrorHandler` +
  `setNotFoundHandler` yang merender halaman ramah dan **tidak** mencatat body
  request (`storefront/src/server.ts:56-71`).
- ✅ Pesan user generik; detail teknis ke logger (pino).

---

## Phase 10 — Logging & Monitoring

- ✅ Logger terstruktur (pino) `packages/core/logger`.
- ✅ **Audit log** tiap perubahan state admin (`logAdminAction`) + halaman
  `/outbox` untuk status `notification_outbox`.
- ✅ Health check: `/healthz` (web-admin & storefront) dengan probe `SELECT 1`.
- Blind spot: tak ada APM/error-tracking eksternal (Sentry dll). Opsional untuk
  satu toko; pertimbangkan bila trafik naik.

---

## Phase 11 — Scalability Audit (asumsi user ×100)

- ⚠️ **Bottleneck #1: SQLite single-writer.** Pada beban tulis tinggi (banyak
  checkout serempak) akan jadi titik jenuh → migrasi Postgres (sudah jadi rencana).
- ⚠️ **Queue berbasis tabel DB** (`notification_outbox`, `broadcasts`) — cukup
  untuk skala kini; pada ×100 pertimbangkan broker khusus (Redis/BullMQ).
- ⚠️ **Tanpa cache** (Redis/memori) — tiap render katalog query DB. Tambah cache
  read untuk Home/kategori bila perlu.
- ✅ Paginasi ada di list order; tambah paginasi pada list lain bila data tumbuh.
- ✅ Rate-limit bot per-user sudah ada (`order-bot/src/middleware.ts:62`).

---

## Phase 12 — Configuration Audit

- ✅ `packages/core/src/config.ts` (209 loc) memvalidasi env dengan **zod**
  (tipe, default, transform) — onboarding aman, gagal cepat bila env salah.
- ✅ DB sebagai sumber kebenaran runtime (bot token, admin) — perubahan via
  web-admin dihormati lintas proses (sesuai plan `singletruth`).
- Tak ada hardcoded value mencurigakan / config ganda yang terdeteksi.

---

## Phase 13 — DevOps Audit

- ✅ `Dockerfile` + `docker-compose.yml` dengan **healthcheck** per service.
- ✅ `restart: unless-stopped`.
- ✅ README mendokumentasikan update/backup (Docker & non-Docker).
- ⚠️ **TLS/reverse proxy & RBAC/2FA review** wajib sebelum ekspos publik
  (default bind `127.0.0.1`) — sudah dicatat di CLAUDE.md / feedback.md §4.3/§4.4.
- ⚠️ **CI/CD**: tak terlihat workflow (`.github/workflows/` kosong/absen) —
  rekomendasi tambah pipeline minimal (typecheck + vitest) agar reg␣resi tertangkap.

---

## Phase 14 — Documentation Audit

README (Bahasa Indonesia) **lengkap**: Sebelum Mulai, `.env`, Docker, non-Docker,
Buat Admin Pertama, Pembayaran & Branding, Update/Backup/Perawatan, Masalah Umum,
Untuk Developer. Plus `CLAUDE.md` (konvensi), `DOCS.md`.

- Gap kecil: **dokumentasi arsitektur** & **panduan backup terpisah** bisa
  diperjelas; **dokumentasi API** tak ada (wajar — app server-rendered, bukan API
  publik).

---

## Phase 15 — Production Readiness Report

### Critical Issues (wajib sebelum production)
- *(tidak ada)* — tak ditemukan isu yang memblok rilis pada skala satu toko.

### High Priority (perbaiki segera)
1. **Upgrade `@fastify/static` ke ≥ 9.1.1** (2 advisory moderate: path traversal +
   route-guard bypass). Menyentuh penyajian `/uploads/` & `/static/`. *(Phase 1)*
2. **Sebelum ekspos publik:** reverse proxy + TLS + review RBAC/2FA. *(Phase 13)*

### Medium Priority (boleh dijadwalkan)
3. `searchCatalogEntries`: tambah `take` di sisi DB sebelum kolaps. *(Phase 5)*
4. Tambah **CI** (typecheck + vitest) di GitHub Actions. *(Phase 13)*
5. Tombol checkout: disable + loading state di klien (anti double-click). *(Phase 4)*

### Low Priority (kosmetik)
6. Hapus/relokasi `singletruth.txt` & `postdev.md` dari root. *(Phase 8)*
7. Bersihkan duplikasi `card()` vs `shapeEntries` saat `/c/:id` direvisi. *(Phase 7)*
8. Audit visual manual mobile (home/pay/settings). *(Phase 3)*

### Technical Debt
- God-file di order-bot (`admin.ts` 934, `checkout.ts` 809) & `crud/orders.ts` 765.
- Single-writer SQLite (migrasi Postgres terencana saat ≥2 concurrent writer).
- Queue berbasis tabel DB (cukup kini; broker khusus saat skala naik).

### Refactor Recommendation (ROI tertinggi → terendah)
1. Upgrade `@fastify/static` (effort kecil, risiko keamanan langsung turun).
2. Tambah CI (effort kecil, mencegah regресi berulang).
3. Pecah `conversations/admin.ts` & `handlers/checkout.ts` (maintainability).
4. `take` pada search + cache read katalog (saat trafik naik).

### Overall Score (1–10)
| Dimensi | Skor | Catatan |
|---|---|---|
| Security | **8** | Fondasi kuat (CSRF, 2FA, lockout, no-secret-log); −2 untuk dep rentan + butuh TLS publik |
| Maintainability | **7** | crud rapi & test kuat; −untuk god-file |
| Performance | **8** | Sehat untuk skala toko; batas SQLite saat scale |
| UX | **8** | Hierarki denominasi memperjelas; minor loading-state |
| UI | **8** | Design-system konsisten; dark mode/audit visual belum |
| Scalability | **6** | Single-writer + tanpa cache/broker = batas pada ×100 |
| Documentation | **8** | README ID lengkap; −untuk arsitektur/API doc |

**Kesimpulan:** **Production-ready untuk skala satu toko** setelah menutup 2 item
High Priority (upgrade `@fastify/static`, TLS/reverse-proxy untuk akses publik).
Tak ada isu Critical. Sisanya peningkatan terjadwal.

> Audit ini analisis read-only — tidak ada kode yang diubah, sesuai instruksi `postdev.md`.
