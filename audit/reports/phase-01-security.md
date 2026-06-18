# Laporan Phase 1 — Security Audit (OWASP Top 10)

Tanggal: 2026-06-18 · Sifat: read-only (tidak ada kode diubah)
Skala acuan: satu toko, SQLite single-writer.

## Ringkasan
| Severity | Jumlah |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 2 |

**3 hal teratas:** (1) upgrade `@fastify/static` ≥9.1.1; (2) MIME upload tak di-sniff (spoofable) — mitigasi sudah ada; (3) TLS/reverse-proxy review sebelum ekspos publik.

Tidak ditemukan isu Critical/High. Fondasi keamanan kuat dan konsisten dengan aturan repo.

---

## Temuan

### [MEDIUM] SEC-01 — Dependency rentan: `@fastify/static@8.3.0`
- **Lokasi:** `apps/storefront/package.json:21`, `apps/web-admin/package.json:22` (resolusi `8.3.0`).
- **Risiko:** 2 advisory *moderate* — path traversal `GHSA-pr96-94w5-mx2h` & route-guard bypass `GHSA-x428-ghpx-8j92` (versi rentan `>=8.0.0 <=9.1.0`). Storefront & web-admin menyajikan `/uploads/` (file unggahan user) dan `/static/`, jadi permukaan terdampak nyata.
- **Bukti:** `pnpm audit --prod` → "2 vulnerabilities found, Severity: 2 moderate".
- **Fix:** naikkan ke `@fastify/static@^9.1.1` (atau patch ≥9.1.1), `pnpm install`, lalu `npx vitest run`. Mitigasi eksisting: `/uploads/` di-serve dengan `X-Content-Type-Options: nosniff` + CSP `default-src 'none'` (`apps/storefront/src/server.ts:44-49`).
- **Effort:** S.

### [LOW] SEC-02 — MIME upload dari header klien, tanpa content sniffing
- **Lokasi:** `apps/web-admin/src/lib/upload.ts:51,63` (`mimetype = part.mimetype` → cek `opts.allowed[mimetype]`).
- **Risiko:** MIME diambil dari multipart header klien (bisa dipalsukan); file polyglot/berbahaya bisa lolos allowlist bila header diset benar. Dampak ditekan karena: nama file di-generate `randomBytes(8)` + ekstensi dari allowlist (bukan dari user), `/uploads/` `nosniff` + CSP ketat, dan SVG dibuat inert.
- **Fix (hardening):** validasi magic-bytes (mis. cek signature gambar) selain MIME header; opsional batasi dimensi gambar.
- **Effort:** S–M.

### [LOW] SEC-03 — Default bind privat; butuh TLS/reverse-proxy review untuk publik
- **Lokasi:** konvensi deploy (CLAUDE.md), `config.WEB_COOKIE_SECURE`, `apps/server/src/index.ts`.
- **Risiko:** app bind `127.0.0.1`; ekspos publik memerlukan reverse proxy + TLS + header `X-Forwarded-*`/`trustProxy` agar `secure` cookie & rate-limit per-IP akurat. Bukan celah kode, tapi prasyarat rilis publik. (Lihat juga Phase 13.)
- **Fix:** dokumentasikan & terapkan nginx + TLS; pastikan `WEB_COOKIE_SECURE=true` di prod.
- **Effort:** M (ops).

---

## Hasil per area OWASP (bukti positif)

### A. Authentication ✅
- bcrypt **cost 12** (`packages/core/src/password.ts:4`).
- Cookie sesi **httpOnly + sameSite=lax + secure(prod)** (`apps/web-admin/src/routes/auth.ts:167-169`; storefront `routes/auth.ts:65-67`; setup `routes/setup.ts:147-149`).
- **TOTP 2FA** RFC 6238 via node:crypto (`apps/web-admin/src/auth.ts:53`), secret base32, key per-telegramId.
- Sesi web bertanda tangan + JTI (`plugins/auth.ts:39-41`).

### B. Authorization ✅
- `canMutate(role, url)` dipakai di route mutasi & upload (`lib/upload.ts:41`); `currentAdmin` preHandler tersebar (46 pemakaian di routes).
- Tidak ditemukan pola IDOR mencolok; objek admin diambil per-sesi (`req.admin!`), self-check eksplisit (mis. `admins.ts:39,64`).

### C. Input Validation & Injection ✅
- **Tak ada SQL mentah di route.** Raw hanya PRAGMA (`packages/db/src/client.ts:31-34`) + `SELECT 1` healthz (`storefront/src/server.ts:98`).
- **XSS:** tak ada `| safe` / `autoescape false` / `{% raw %}` di template — Nunjucks autoescape aktif penuh.
- **Path traversal (app-level):** `/uploads/` di-serve dengan nosniff + CSP ketat; nama file server-generated. (Risiko lib lihat SEC-01.)
- **SSRF:** semua `fetch` ke endpoint tetap/tepercaya — Telegram file API (`conversations/admin.ts:88` pakai `botToken` + `file_path` dari `getFile`, bukan URL user), Binance/Bybit API base dari config, `telegramCheck` ke `api.telegram.org`. Tak ada URL dikendalikan user.

### D. API / Endpoint Security ✅
- Rate-limit bot per-user (`apps/order-bot/src/middleware.ts:62`).
- Web: login throttle IP + lockout per-akun, balas **429** (`routes/auth.ts:106,114-116`); `/forgot` & `/reset` juga di-throttle (`:187,223`).
- Anti-enumeration: login & forgot balas pesan generik sama (`routes/auth.ts:229`).

### E. Secrets ✅
- **Tak ada secret di log** — pencarian `logger.* + (password|token|secret|file_id|api_key)` nihil yang membocorkan; komentar eksplisit "never log the code/URL" (`routes/auth.ts:198`, `server/src/index.ts:248`).
- **Tak ada hardcoded secret** — scan literal key/secret/token nihil.
- Settings: hanya key whitelist boleh diedit, key ber-secret tak pernah ditampilkan (`routes/settings.ts:2-4`).

### F. File Upload ✅ (dengan catatan SEC-02)
- CSRF di handler (`lib/upload.ts:48-57`) + role gate + **MIME allowlist** + **size limit** (`req.parts({ limits: { fileSize } })`) + nama file `randomBytes(8)` + ekstensi dari allowlist.

### G. Dependency Security
- `pnpm audit --prod` → 2 *moderate* (SEC-01). Tak ada High/Critical.

---

## Rekomendasi tindak lanjut (urut prioritas)
1. **SEC-01** upgrade `@fastify/static` ≥9.1.1 (cepat, hilangkan 2 advisory).
2. **SEC-03** siapkan TLS + reverse proxy sebelum publik (prasyarat rilis).
3. **SEC-02** tambah validasi magic-bytes pada upload (hardening).

> Read-only — tidak ada perubahan kode. Detail dependency dari `pnpm audit --prod` per 2026-06-18.
