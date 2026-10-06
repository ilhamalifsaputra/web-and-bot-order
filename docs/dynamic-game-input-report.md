# Dynamic Game Input — Implementation Report

Branch `codex/dynamic-game-input`. Audit and design: `docs/dynamic-game-input-audit.md` (includes the spec v2 reconciliation). Plan: `docs/superpowers/plans/2026-10-06-dynamic-game-input.md`.

## Problem
Checkout for Delta Force asked for a Zone ID it does not have. Cause: every imported game carried the same generic `Game ID` + optional `Server / Zone` template, nickname checks picked their game by fuzzy name matching, and web checkout dropped the answers of AUTO products.

## Design (summary)
- **Source of truth:** `Denomination.additionalFields` (the existing dynamic-field mechanism). Configuration is per sellable SKU, so two variants of one game never inherit from each other.
- **Provider mapping is separate and server-only:** new nullable `Denomination.providerInputMapping` (nickname parameter keys, Digiflazz target keys and separator). It is never sent to a client.
- **Order snapshot:** new nullable `Order.inputConfigSnapshot` freezes fields and mapping at purchase, so an admin edit cannot change the target of an order that is already pending. Historical orders have no snapshot and keep using current metadata.
- **No runtime guessing:** the nickname gate comes only from `nicknameCheckGameCode`. Name matching survives only in the one-time backfill, which is dry-run first.

## Changes
- **Core** (`packages/core`): `playerInput.ts` (mapping, snapshot, target and nickname-request builders); `deliveryFields.ts` gains length and an audited-pattern allowlist, rejects unknown answer keys (the display-only `nickname` is stripped), and guards reserved keys; KokinPay adapter forwards the zone; new locale strings.
- **DB** (`packages/db`): order creation validates configured fields for every delivery type and stores the snapshot; Digiflazz dispatch builds `customer_no` from validated answers and the order's snapshot; admin edits of a pending order's answers validate against the snapshot; backfill helper and script `pnpm backfill-player-input-configuration [-- --apply] [--product-ids=…]`.
- **Storefront:** account check accepts `player_inputs`, validates it against the SKU's own config and rejects unknown keys before any provider call; cart and direct checkout enforce fields for AUTO; the client renders configured fields for every delivery type, resets answers when the SKU or its config changes, and sends only active fields.
- **Bot:** one collector (`customerInfo`) for all products, with select options, Skip for optional fields and Back; the nickname lookup runs after all fields are collected and stays advisory (any failure continues to confirmation); answers are tied to SKU, quantity and config, and cleared on cancel or restart.
- **Admin:** the field editor is available for Automatic SKUs, the generic template no longer adds a Server/Zone field, and `providerInputMapping` is validated against the configured keys.
- **Migration** `20261006100000_dynamic_player_input_mapping`: two nullable `ADD COLUMN IF NOT EXISTS`. Additive; no history is rewritten.

## Fixes made while verifying
1. `createOrderDirect` refused Digiflazz SKUs with a missing `supplierSku` or quantity above 1, which the dispatcher deliberately routes to manual review. It now refuses only a top-up SKU with no input field.
2. The rewritten bot nickname conversation lost its fallback for unexpected lookup errors. Restored (logged, then continue).
3. Pending-order answer edits and the admin order page used current instead of snapshot fields.
4. The backfill froze snapshots for only six statuses; it now covers every non-terminal status.
5. Test expectations that encoded intentionally removed behaviour were updated with the reason in a comment (brand auto-detect, `/cancel` re-entering the wizard, AUTO ignoring fields, editor only for Manual+Info).

## Verification
| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm test` (full, 553 files) | 10 031 / 10 031 pass, exit 0 |
| New or changed tests after that run (`player-input`, `playerInputBackfill`, `digiflazz`) | pass |
| `eslint` on storefront client | clean |
| `prisma migrate status` (local DB) | up to date |
| Backfill dry-run on local DB | 0 changes (already applied) |

The first full run found 13 failures, all traced and fixed (see above) before the passing run.

## Spec cases
1–3 (ID only, ID+zone, optional) bot, web and API tests; 4–6 (fake config, removed field, unknown key) storefront and core tests; 7 (switch cleanup) web and bot; 8 (no KokinPay call before inputs are complete, mapped request) storefront and bot; 9–10 (target from validated input, invalid product) DB and storefront; 11–12 existing suites plus snapshot-less order test; 15–17 digiflazz and player-input tests.

## Deploy steps
1. `pnpm prisma migrate deploy`, then restart order-bot before the new code serves traffic (otherwise `P2022 column … does not exist`).
2. `pnpm backfill-player-input-configuration` (dry-run). **Review the output**, since a brand can hold variants with different requirements. Then re-run with `--apply` (optionally `--product-ids=`). It is idempotent.
3. Admins should open each active game SKU once and confirm its fields; new imports arrive inactive with a single `Game ID` field.

## Limitations
- Not verified at runtime: no browser walkthrough of the web checkout and no live Telegram session. Behaviour is covered by component, conversation and API tests only.
- No real KokinPay or Digiflazz call was made. Provider requests are verified against mocks.
- The local database holds test data; the backfill has not been run on any production database.
- Spec §8.3 provenance (`input_config_source`) is optional and not stored.
- Open decision: switching a SKU from Manual+Info to Automatic keeps its fields, since the editor is visible. Clearing them automatically is a small change if preferred.
