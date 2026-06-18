# 03 — CI/CD

## ROLE
Platform Engineer.

## OBJECTIVE
CI otomatis sebagai gate regresi semua sprint: typecheck + test (+ lint bila ada) tiap PR. (H-3)

## GLOBAL RULES
- Minimal, deterministik, tidak flaky. Dokumentasikan pipeline.

## INPUT (issue audit)
- **H-3** — Tidak ada `.github/workflows/`. (DO-01)

## ANALYSIS (cari)
- Perintah otoritatif (root `package.json`): `pnpm -r typecheck`, `npx vitest run`. Paket web-admin/storefront/order-bot tak punya script `test` → pakai vitest root.
- Toolchain: pnpm@9.x, Node 20 (selaras `Dockerfile FROM node:20-slim`), Prisma butuh `prisma generate` sebelum typecheck/test.
- Lint: cek ESLint config; bila tak ada, jangan paksa.

## IMPLEMENTATION STRATEGY
1. Step minimal: checkout → setup pnpm + Node 20 → `pnpm install --frozen-lockfile` → `pnpm exec prisma generate` → `pnpm -r typecheck` → `npx vitest run`.
2. Trigger: `pull_request` + `push:master`. Cache pnpm store.
3. (Opsional) job lint bila config ada.

## WRITING PLAN
- **File baru:** `.github/workflows/ci.yml`.
- **Isi:** 1 job `verify` (ubuntu-latest, Node 20, pnpm via `pnpm/action-setup`), cache `~/.pnpm-store`, langkah seperti IMPLEMENTATION STRATEGY.
- **Branch protection:** jadikan job `verify` required check di `master` (langkah GitHub settings, dokumentasikan).
- **Docs:** catat di `DOCS.md` / `execution/03` cara CI berjalan.

## EXECUTION PLAN (siap jalan)
1. `git checkout -b chore/h3-ci`
2. Buat `.github/workflows/ci.yml`:
   - `on: [pull_request, push: branches master]`
   - steps: `actions/checkout` → `pnpm/action-setup@v4 (version 9)` → `actions/setup-node@v4 (node 20, cache pnpm)` → `pnpm install --frozen-lockfile` → `pnpm exec prisma generate` → `pnpm -r typecheck` → `npx vitest run`.
3. Validasi lokal dulu (mirror CI): jalankan keempat perintah di mesin bersih → semua hijau.
4. Push branch → buka PR → pastikan workflow jalan & hijau.
5. Set required status check di GitHub branch protection `master`.

## OUTPUT
- **CI strategy** (trigger, matrix Node 20, cache) + **pipeline checklist**: prisma generate sebelum typecheck; frozen lockfile; typecheck & vitest hijau; tidak flaky; required check aktif.

## CONSTRAINT
Boleh sertakan rancangan `ci.yml` sebagai contoh; jangan terapkan ke repo di tugas ini. Hasil = CI strategy + checklist.
