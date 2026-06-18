# Phase 1 — Security Audit (OWASP Top 10)

> **Read-only — jangan ubah kode.** Hanya temuan + rekomendasi.

---

## Konteks Proyek
Monorepo pnpm+TS. web-admin & storefront (Fastify+Nunjucks, autoescape ON), order-bot (grammY),
server (composition root). packages/core (bcrypt, config zod, pino), packages/db (Prisma + crud/*).
DB SQLite tunggal (single-writer, WAL). Aturan: money Decimal; **tak ada SQL mentah di route**;
**web tak pernah kirim Telegram** (enqueue `notification_outbox`); **jangan log secret**;
**CSRF `csrfProtect` di tiap route mutasi**; upload lewat `apps/web-admin/src/lib/upload.ts`.

---

## Objective
Audit keamanan berbasis OWASP Top 10, fokus area berisiko: auth, payment, upload, admin panel.

## Severity Rubric
- **Critical** — RCE, bypass auth, kebocoran dana/kredensial, kehilangan data.
- **High** — kerentanan nyata berdampak besar, perbaiki segera.
- **Medium** — risiko terbatas / kondisi tertentu, dapat dijadwalkan.
- **Low** — hardening/kosmetik.

## Checklist + Langkah Investigasi

### A. Authentication
- Validasi sesi web: `apps/web-admin/src/plugins/auth.ts`, `auth.ts` (cek tanda tangan/JTI sesi, expiry).
- TOTP 2FA: `apps/web-admin/src/auth.ts:53` dst — cek window, replay, penyimpanan secret.
- Hashing: `packages/core/src/password.ts` (harus bcrypt cost ≥12).
- Cookie: `grep -rn "httpOnly\|sameSite\|secure:" apps/*/src` — harus httpOnly + sameSite + secure(prod).

### B. Authorization (akses & RBAC)
- `grep -rn "canMutate\|currentAdmin\|csrfProtect\|loadWebRole\|role" apps/web-admin/src`.
- Cek tiap route mutasi punya gate role yang benar; cari **IDOR** (akses objek milik user lain via id di params).
- Role escalation: route admin-only yang tak cek `super`/role.

### C. Input Validation & Injection
- SQL Injection: pastikan **tak ada** raw SQL di route — `grep -rn "\$queryRaw\|\$executeRaw\|Unsafe" apps packages --include=*.ts | grep -v test` (yang sah hanya PRAGMA `client.ts` + `SELECT 1` healthz).
- XSS: cek pemakaian `| safe` / `{% autoescape false %}` di `.njk`; data user yang dirender tanpa escape.
- Path traversal: penyajian `/uploads/` & `/static/` (`apps/storefront/src/server.ts:40-50`, web-admin) — cek normalisasi path & header.
- SSRF: fetch keluar (`lib/telegramCheck.ts`, payments) dengan input user.

### D. API / Endpoint Security
- Rate limiting: bot `apps/order-bot/src/middleware.ts:62`; web login throttle `routes/auth.ts:106,114-116`. Cek endpoint sensitif lain (reset, forgot) juga di-throttle.
- CORS, endpoint debug terbuka, response yang membocorkan data internal.

### E. Secrets
- `grep -rniE "log(ger)?\.(info|debug|warn|error).*(password|token|secret|file_id|api_?key)" apps packages --include=*.ts | grep -v test` → harus kosong / hanya yang sudah jelas tak membocorkan.
- Cari hardcoded token/key: `grep -rniE "(api_?key|secret|token|password)\s*[:=]\s*['\"][A-Za-z0-9_-]{12,}" apps packages --include=*.ts | grep -v test`.

### F. File Upload (`apps/web-admin/src/lib/upload.ts`)
- Cek: CSRF di handler (`:48-57`), gate role (`canMutate`), **MIME allowlist** (`:63`), **batas ukuran** (`limits.fileSize`), nama file aman (tak ada path injection), SVG di-nonaktifkan/served inert.

### G. Dependency Security
- `pnpm audit --prod` — catat tiap advisory: paket, severity, versi rentan vs patch, path.
- Petunjuk awal (verifikasi): **`@fastify/static@8.3.0`** punya 2 advisory *moderate* (path traversal `GHSA-pr96-94w5-mx2h`, route-guard bypass `GHSA-x428-ghpx-8j92`), patch `>=9.1.1` — relevan karena menyajikan `/uploads/`.

## Output → tulis ke `audit/reports/phase-01-security.md`
Tabel ringkas + detail per temuan:
```
ID | Severity | Area | File:line | Risiko | Rekomendasi fix | Effort
```
Tutup dengan ringkasan: jumlah per severity + 3 hal teratas yang wajib ditindak.

## Constraint
**Jangan melakukan perubahan kode.**
