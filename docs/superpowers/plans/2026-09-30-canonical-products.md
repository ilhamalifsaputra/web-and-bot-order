# Canonical Products Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Web dan Telegram memakai canonical denomination yang sama tanpa kehilangan semantic atau presisi harga.
**Architecture:** Adapter canonical dalam core existing; additive DTO di API; presenter terpisah memakai canonical. Nama supplier exact disimpan dalam kolom nullable baru.
**Tech Stack:** TypeScript, Zod, Decimal.js, Prisma/PostgreSQL, Fastify, React, grammY, Vitest.
**Spec:** `docs/superpowers/specs/2026-09-30-canonical-products-design.md`.

## Global Constraints

- Jangan mengubah raw catalog, SKU, fulfillment, aturan margin, provider payment, atau sumber rate hanya demi tampilan.
- Jangan menjalankan migration/destructive operation pada database produksi atau melakukan deployment sebagai bagian task ini.
- Decimal untuk semua uang; IDR precision sampai 4 harus dipertahankan; USD display memakai kebijakan existing, bukan USD settlement baru.
- Frontend tidak mengimpor Prisma/database/supplier/server core; API additive dan snapshot histori tetap.
- Normalisasi deterministic; parsing satu jalur backend; semua bonus, qualifier, durasi dan unknown tetap informatif.

## Review Focus

- Structured quantity yang berbeda dari raw: raw pembeda tetap terlihat (Task 1).
- Fractional IDR, zero, large values dan rounding suffix: exact value tidak berubah (Task 1/2).
- Label collision setelah harga dibulatkan dan grapheme emoji/CJK: pilihan unik, urutan stabil (Task 2).
- Long catalog melebihi caption Telegram: pagination/list text jangan gagal render (Task 2).
- Stale price/status serta reseller user: caller effective pricing dan existing confirmation tetap benar (Task 2).

### Task 1: Canonical domain, money dan supplier raw storage

**Files:** Create `packages/core/src/canonicalProduct.ts`, colocated tests; Modify core package exports, Prisma schema, CRUD catalog/Digiflazz; Create additive nullable migration.
**Interfaces:** Produces exported `CanonicalProduct`, `CanonicalProductSchema`, `canonicalProduct(input, context)` with explicit input/context types. Return exact price/display currency and original identity. Scalar inputs only. Task 2 consumes this function without reparsing names.

- [ ] Read spec and inspect exact CRUD/input patterns.
- [ ] Write failing tests: real catalog names (ML dot grouping, Growtopia named package if present, AB etc), synthetic bonus/qualifier/unknown/subscription, structured qty conflict, integer digit Money and status/purchasable validity, fractional IDR and USD conversion metadata.
- [ ] Run `node node_modules/vitest/vitest.mjs run packages/core/src/canonicalProduct.test.ts`, record expected RED.
- [ ] Implement canonical adapter/schema and additive supplierRawName storage import/resync. Legacy provenance explicit, source timestamp truthful. No rawName DB backfill guesses.
- [ ] Run core tests and package typecheck; generate Prisma locally. DB tests if safe isolated Postgres available; otherwise report blocked DB verification.
- [ ] Self-review, commit only task files, write report `.superpowers/sdd/2026-09-30-canonical-products/task-1-report.md`.

### Task 2: Integrate API, web and Telegram presenters

**Files:** Modify storefront `pageData.ts`, `routes/apiPages.ts`, `routes/api.ts`, client DTO and DenominationCard/ProductPage/InstantBuyPage as needed; bot handler/keyboards; Create focused presenter module and tests; update affected legacy tests; Create `docs/CANONICAL_PRODUCTS.md`.
**Interfaces:** Consumes Task 1 canonicalProduct + schema. Produces additive canonical DTO and exact price text from backend on list/detail, bot presenter final labels/rows/list fallback tied to stable denomination ID. Preserve existing callback strings.

- [ ] Write integration/presenter failing tests for semantic parity, long unknown, bonus and qualifier, collision, price currency/locale before width, lossless quantities, CJK/emoji widths, callback UTF-8 and stable IDs, pagination/message limits, stale price/status flow.
- [ ] Run focused tests, record RED.
- [ ] Integrate canonical backend for active SPA and compatibility catalog endpoints (list/detail). Runtime validate canonical response; avoid exposing cost/metadata. Do not create conflicting pricing logic.
- [ ] Include truthful existing `usd_idr_rate_updated_at` and `settings:usd_idr_rate` conversion metadata; invalidate/refetch personalized product payload on currency changes and prevent shared HTTP caching.
- [ ] Implement Telegram presenter and adaptive rows, full-name exact-price message fallback, bounded pagination and stable callbacks; detail canonical text. Do not ellipsize meaningful text.
- [ ] React renders full canonical name/qualifier/backend exact price, wrapping/responsive; compatibility fallback for old DTO. No browser canonical name parsing or rate arithmetic.
- [ ] Run focused tests, typecheck including test tsconfig, lint, build and frontend boundary checks. Existing checkout/invoice/fulfillment tests if safe DB available. Do not rerun the entire suite repeatedly.
- [ ] Document final types and list/detail fixture responses, sample before/after for amount/bonus/package/long/unknown/collision, migration rollout, verification evidence and manual limitations. Commit and write report `.superpowers/sdd/2026-09-30-canonical-products/task-2-report.md`.
