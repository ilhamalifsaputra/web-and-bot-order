# Dynamic Game Input Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, task by task.

**Goal:** Make existing input configuration authoritative across web, bot, nickname lookup and fulfillment.

**Architecture:** Extend additionalFields and customerData; store provider mappings separately. Additive snapshots protect pending orders. Reuse existing renderers and collectors.

**Tech Stack:** TypeScript, Zod, Prisma/PostgreSQL, Fastify, React, GramMY, Vitest.

**Spec:** `C:/Users/ilham/Downloads/dynamic-game-id-zone-id-requirements-enhanced.md`; audit/design: `docs/dynamic-game-input-audit.md`.

## Global Constraints
- No name-based runtime input requirements, duplicate client configuration or arbitrary provider payload forwarding.
- Preserve existing API names, orders, payment behavior and idempotency; no dependency additions.
- Audit before coding; no production migration or real charge during tests.

## Review Focus
- Invalid stored JSON must fail closed for new purchases.
- SKU/config switches must invalidate stale answers and nickname results.
- New snapshots must preserve pending targets after admin edits.
- Provider outages must preserve existing advisory lookup semantics.
- Legacy field keys and order data must remain readable.

### Task 1: Shared rules and mappings
- [ ] Write and run failing validation/mapping tests for required zone, optional/select, length, unknown keys, leading zeros and provider allowlists.
- [ ] Extend `deliveryFields.ts`; add `playerInput.ts` mapping/snapshot helpers and exports. Run focused Vitest tests (expected all pass).

### Task 2: Authoritative backend and persistence
- [ ] Add nullable providerInputMapping and inputConfigSnapshot migration/schema; generate Prisma.
- [ ] Test AUTO order validation, account lookup and snapshot behavior before implementation.
- [ ] Update CRUD/order/cart/direct/dispatch gates; admin config validation; eliminate runtime name lookup; implement dry-run backfill and safe import defaults.
- [ ] Run database/API regressions (expected pass).

### Task 3: Web and Telegram
- [ ] Test dynamic nickname payload and cleanup plus bot field collection/cancellation.
- [ ] Use configured fields regardless of delivery type; cleanup on config changes; shared type-only contracts.
- [ ] Reuse generic bot collector, checking nickname after inputs; preserve retry/confirmation behavior.
- [ ] Run web/bot component and conversation tests (expected pass).

### Task 4: Verification and report
- [ ] Run typecheck, repository test command, migration checks and frontend lint/build.
- [ ] Review diff for unsafe payloads, stale state, provider regressions and historical orders.
- [ ] Write report with commands, observed results, deployment steps and verification limitations.
