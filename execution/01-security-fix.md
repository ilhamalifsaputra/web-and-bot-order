# 01 — Security Fix

## ROLE
Senior Security Engineer.

## OBJECTIVE
Menutup temuan keamanan: dependency rentan (H-1) & hardening upload (M-6), patch minimal, zero regression.

## GLOBAL RULES
- Minimal patch, zero regression, preserve behavior; jangan ubah API publik tanpa alasan.
- Tambahkan test bila perilaku berubah; dokumentasikan.

## INPUT (issue audit)
- **H-1** — `@fastify/static@8.3.0` rentan (path traversal `GHSA-pr96-94w5-mx2h`, route-guard bypass `GHSA-x428-ghpx-8j92`); patch ≥9.1.1. (SEC-01)
- **M-6** — Upload MIME dari header klien (spoofable), tanpa content sniffing. (SEC-02)

## ANALYSIS (cari)
- H-1 root cause: `apps/storefront/package.json:21` & `apps/web-admin/package.json:22` (`^8.0.3`). Permukaan: `/uploads/` & `/static/` (`apps/storefront/src/server.ts:40-50`). Regression risk: breaking API `@fastify/static` v8→v9 (`setHeaders`, `wildcard`, `decorateReply`).
- M-6 root cause: `apps/web-admin/src/lib/upload.ts:51,63` (`part.mimetype` → `allowed[mimetype]`). Mitigasi eksisting: nama random + ext allowlist + nosniff + CSP.

## IMPLEMENTATION STRATEGY
1. Analisis package.json kedua app + `server.ts` + `lib/upload.ts`.
2. Blast radius: semua route static/uploads + branding/QR upload.
3. Test terdampak: `apps/storefront/test/*`, `apps/web-admin/test/*`.
4. Patch minimal: bump dep; tambah validasi magic-bytes.
5. Test → verifikasi → dokumentasi.

## WRITING PLAN
- **File diubah:** `apps/storefront/package.json`, `apps/web-admin/package.json` (bump `@fastify/static` → `^9.1.1`); `apps/web-admin/src/lib/upload.ts` (tambah cek magic-bytes setelah baca buffer, sebelum `opts.allowed[mimetype]`).
- **Test:** tambah/ubah test upload web-admin → file MIME palsu (header gambar, isi bukan) ditolak; gambar valid lolos.
- **Docs:** catat advisory yang ditutup + perilaku validasi baru di PR description / `DOCS.md`.

## EXECUTION PLAN (siap jalan)
1. `git checkout -b fix/h1-fastify-static`
2. Edit kedua `package.json` → `"@fastify/static": "^9.1.1"`; `pnpm install`.
3. `pnpm -r typecheck` && `npx vitest run apps/storefront/test apps/web-admin/test` (cek breaking v9).
4. Verifikasi manual: `pnpm --filter @app/storefront dev` → GET `/static/favicon.svg` & `/uploads/...` 200 + header `nosniff`/CSP.
5. `git checkout -b fix/m6-upload-magicbytes` (PR terpisah).
6. Di `lib/upload.ts`: setelah `fileBuffer` terisi, cek signature (PNG `89 50 4E 47`, JPEG `FF D8 FF`, dst sesuai `opts.allowed`); bila tak cocok → `redirectWithFlash(... "That file type is not allowed.")`.
7. Tambah test → `npx vitest run apps/web-admin/test`.
8. `pnpm -r typecheck && npx vitest run` (full) → hijau.

## OUTPUT
Patch plan + **regression checklist**: upload branding/logo/hero/QR sukses; MIME palsu ditolak; `/static/`+`/uploads/` 200+header; tak ada breaking v9; suite hijau.
