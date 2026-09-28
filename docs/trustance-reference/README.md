# Trustance Reference (Arsip Referensi)

Lima dokumen di folder ini adalah materi referensi arsitektur dari proyek
root/induk milik pemilik repo ("Trustance"), disimpan di sini hanya untuk
arsip/rujukan. **Dokumen-dokumen ini BUKAN dokumentasi arsitektur repo ini.**

Isinya menggambarkan sistem yang berbeda: package yang tidak ada di repo ini
(mis. `packages/web-ui`, `packages/api-contracts`), serta provider pembayaran
yang berbeda (Digiflazz, VIPReseller, Kokinpay, MeloStore) — sedangkan repo
ini sebenarnya mengintegrasikan TokoPay, PayDisini, NOWPayments, Binance, dan
Bybit. Jangan jadikan dokumen di folder ini sebagai acuan implementasi nyata.

Untuk arsitektur repo ini yang sebenarnya, baca
[`docs/arsitektur/ARCHITECTURE.md`](../arsitektur/ARCHITECTURE.md) dan
[`DOCS.md` §1](../../DOCS.md#1-arsitektur).

## Daftar isi

- `trustance-telegram-bot-architecture-FINAL-v3.2.md` — spesifikasi arsitektur bot Telegram (grammY) versi final v3.2: checkout, pembayaran, runtime, state, dan reliability.
- `trustance-prisma-database-architecture-POSTGRESQL-DOCKER-V1.md` — arsitektur database Prisma + PostgreSQL (Docker) untuk commerce multi-currency (IDR/USDT), ledger, inventory, dan fulfillment.
- `trustance-master-architecture-prompt.md` — prompt implementasi master: modular monolith yang mencakup storefront, bot, web admin, provider, inventory, refund, pricing, dan lain-lain.
- `trustance-frontend-architecture-CANONICAL-V1.md` — arsitektur frontend kanonis versi 1 untuk storefront web dan web admin (React/Next.js).
- `trustance-frontend-architecture-REACT-SPA-V2.md` — arsitektur frontend kanonis versi 2, React SPA (Router, Tailwind, Vitest, Playwright) untuk storefront dan web admin.
