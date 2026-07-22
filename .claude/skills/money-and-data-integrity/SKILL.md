---
name: money-and-data-integrity
description: Use when touching money/price code, writing DB access from a route or handler, changing admin state, or opening a Prisma $transaction — before writing the code
---

# Money & Data Integrity

## Overview

This repo has one shared SQLite database written from three processes (bot, web-admin, storefront). Money must never be a float, database writes must never be raw SQL sitting in a route/handler, and every state change an admin makes must be auditable in plain language. These rules exist because a single silent violation (a float rounding error, an untracked write, an unexplained audit entry) is invisible until it corrupts money or blocks a support investigation.

## When to Use

- Adding or editing any code that computes, stores, or displays a price, balance, or amount.
- Adding a new database read/write in `apps/*/src/routes/*`, `apps/*/src/handlers/*`, or any route/handler-level code.
- Adding or changing an admin action that mutates data (approve, edit, delete, restock, refund, etc.).
- Opening a Prisma `$transaction`.
- Writing a `logger.*()` call or a `logAdminAction()` call.

## Money is always Decimal

- Use `@app/core/money` (Decimal) for every money value end-to-end — never `float`/`number` arithmetic on prices, balances, or totals.
- Formatting for display happens client-side, not in the money type itself:
  - storefront: `formatIdr` and friends in `apps/storefront/client/src/lib/format.ts`
  - admin: the `CurrencyAmount` component
  - bot: `formatPrice`

## No raw SQL in routes or handlers

- Route files (`apps/web-admin/src/routes/*`, `apps/storefront/src/routes/*`) and bot handler files (`apps/order-bot/src/handlers/*`) must not contain raw SQL or ad-hoc Prisma queries.
- New DB logic belongs in `packages/db/src/crud/*`, split per domain (`orders.ts`, `stock.ts`, `pricing.ts`, `vouchers.ts`, etc.), with colocated Vitest coverage (`*.test.ts` next to the crud file).
- If the domain file doesn't exist yet for what you're writing, create it following the existing crud files' shape rather than inlining the query where it's called.

## Time: UTC in the DB, TIMEZONE on display

- Store and compare all timestamps in UTC.
- Convert for display only at the edge: web uses the `localdt` filter, the bot uses `localize`. Never bake a local offset into stored data.

## Audit every state change

- Any admin action that changes data calls `logAdminAction` with the acting admin's id.
- The `details` string is read by shop admins, not developers — write it as a short natural-language sentence (e.g. `"Added 150 items; skipped 2 invalid lines and 1 duplicate."`), never `key=value` shorthand. Full convention and examples: `docs/LOGGING.md`.

## Pino logs are a separate, developer-facing channel

- `packages/core/src/logger.ts` logs are for developers/ops, not shop admins — write them in English as full sentences: state what happened, give enough context to understand significance without reading the surrounding code, and for warn/error explain why it matters or what's next.
- Spell out internal abbreviations — no bare `cb`/`cmd`/`idx`/`tx`.
- Never interpolate a truncated/sliced id or name list into a log string — summarize by count instead (e.g. `"12 products"`, not a clipped id dump).
- The structured metadata object (`logger.info({ err, id }, "msg")`) is exempt from the sentence rule — only the leading message string follows it.

## Never log secrets

Credentials, payment-proof `file_id`, password hashes, and full DB URLs must never appear in any log, audit entry, or error message.

## SQLite is single-writer

- The shared `data/bot.db` (WAL) has one writer at a time across all three processes — keep every `$transaction` block as short as possible; don't do network calls, file I/O, or unrelated queries inside one.
- The trigger to migrate to Postgres is ≥2 concurrent writers becoming a real bottleneck — don't preemptively add transaction workarounds for that; just keep transactions short.

## Schema changes on deploy

Migrating the live DB (`pnpm prisma db push` or applying the migration) and restarting order-bot must happen **before** new code runs, or you get `P2022 column … does not exist`. Flag this in any change that touches `prisma/schema.prisma`.
