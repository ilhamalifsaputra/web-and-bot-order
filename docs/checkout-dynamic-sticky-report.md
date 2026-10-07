# Checkout dynamic fields and hybrid CTA — Task 1 report

Status: DONE. Implemented in the authorized existing worktree on `worktree-checkout-dynamic-sticky`, based on `9e2b2b2a`. No merge, push or deployment. Parent owns independent task review and broader branch validation.

## Root cause and source of truth

The current checkout already rendered `Denomination.additionalFields` through public `additional_fields`; there was no frontend game-name switch to remove. A Server/Zone field shown by this renderer came from the configured denomination field list. The UX gaps were that optional fields looked required, blank required fields had no useful guidance, filled invalid values immediately showed errors while typing, and the summary omitted account details. Public product shaping also used `parseAdditionalFields`, whose tolerant empty-array fallback concealed malformed metadata. Mobile had only an unconditional sticky submit and a permanent spacer before the footer. Wrapping plan rows allowed prices to fall below names.

`Denomination.additionalFields` remains the only field schema. The implementation uses existing `parseInputFields`, `parseProviderInputMapping`, `validateCustomerData`, field constraints and provider snapshots. No schema migration, alternate requirements schema, name inference, live backfill or data repair was introduced.

## Frontend behavior

- Account details → Choose a plan → Discount → Summary → Buy now stays in that relative order; existing guest contact and payment selection remain present.
- Only configured fields render. Existing bilingual labels, scalar metadata helpers/placeholders/options, supported input types, lengths and patterns are reused. Optional labels and neutral required hints are localized in English and Indonesian.
- Errors appear on blur/touched or attempted form submission, with `aria-invalid` and hint/error `aria-describedby`. Empty optional answers are valid; filled optional answers still obey their configured constraints. Selecting another top-up amount with the same field schema preserves answers and validation state. Changing the product or field schema resets them.
- Inputs remain strings, including large IDs and leading zeroes. Only configured trimmed answers are sent; the summary shows the selected plan and nonempty configured answers. No synthetic Server/Zone row or `-` account placeholder is created.
- Plan cards use a fixed price grid column, nonbreaking prices, names clamped to two lines, and constant selected/resting border width. Their native radio group now belongs to the actual `buy-form`, enabling arrow-key selection.
- Inline localized reasons cover invalid configuration, unavailable plans, loading/failed prices, invalid account/contact data and unavailable/unselected payment methods. Normal form validation produces no toast.
- The shared field component's validation timing also applies to cart checkout and order-detail editing. The existing CheckoutPage regression was updated to verify calm typing followed by an error on blur; parent verified existing consumers.

## Backend and provider behavior

`checkoutInputConfiguration` strictly parses metadata and validates server mapping references, returning only `additional_fields` and additive `input_configuration_valid`. Invalid configuration exposes no provider mapping or technical details. Backend logs include only a denomination identifier and a bounded reason (`invalid_field_metadata`, `invalid_provider_mapping`, `missing_digiflazz_inputs`). Digiflazz with no configured inputs is invalid; input-free stock delivery remains supported.

Both `/api/v1/topup/preview` and `/api/v1/topup/order` reject invalid configuration. Order answer validation and configuration validation occur before guest-user/session creation, idempotency claims or order writes. API regressions assert user/order counts remain unchanged for malformed JSON, incomplete field metadata, missing Digiflazz inputs and unknown provider mapping references.

Customer-data normalization, supplier target construction, nickname parameter mapping, order input snapshots, provider fulfillment and pricing remain owned by the existing backend. Frontend does not concatenate IDs or understand Digiflazz payloads. Backend regression coverage retains required-answer rejection, valid payload acceptance and idempotent order replay.

## Pricing, vouchers and submission

The selected plan's existing authoritative preview feeds the summary and both CTAs. QRIS fee rules and the existing currency formatter/IDR Price · Pay explanation are reused; no price formula was added.

Preview keys include denomination, currency, language and pricing context. Stored totals are gated by their context so old totals cannot enable a new selection. Voucher mutations capture denomination/context and a sequence number; abandoned-plan/context responses and older repeated applies cannot overwrite the active price. Voucher repricing blocks both submit controls. The entered code and applied code are separate: editing an unapplied code cannot change the code sent with the quoted amount. Plan/context changes clear voucher application and fetch their own preview.

Primary and sticky share the same blocked/pending flags and submit handler. A synchronous ref lock rejects duplicate clicks before mutation state renders. Both show localized Processing while pending, and the existing `useIdempotentPost` and backend idempotency protection remain intact. The page remains cart independent.

## Hybrid sticky behavior and footer

The primary Buy now is always in document flow below summary, including a disabled control while price is unavailable. Its actual element is observed through a callback ref, so late preview mounting and replacement are handled. `IntersectionObserver` uses the real viewport without an occlusion-dependent margin; any intersection hides the sticky. Empty observer entries default to visible. Observers disconnect on element changes, desktop changes and unmount.

Below the existing `lg` breakpoint (1024px), sticky appears only when the primary is outside the viewport and a preview exists. Desktop never has a bottom purchase bar. The sticky contains total/Buy now plus the necessary cross-currency payable explanation.

The bar remains portaled outside transformed page content. Its actual height, including existing safe-area padding, is measured with `ResizeObserver` and a resize fallback. A React-owned portal reserves that height in `purchase-bar-clearance` after the site footer, only while sticky is mounted. No persistent body styles or pre-footer spacer remain. At the footer, if primary is still in view the bar is correctly hidden; otherwise measured clearance keeps footer content above it.

## Verification evidence

2026-10-08 denomination-selection regression fix:

- Reproduced the reported sequence: enter the game ID/zone, then choose another diamond amount. Both direct-page and product-route tests failed with an empty ID before the fix. The reset effect incorrectly treated every denomination ID change as a new account form.
- Account state and field identity now use the product slug and field schema. Price/voucher/payment revalidation still follows the selected denomination, and nickname lookup cancels the previous request and rechecks the retained inputs.
- Focused Vitest run passed all 154 tests across `InstantBuyPage`, `ProductPage`, `CheckoutPage`, `DeliveryFieldInput` and currency switching. Coverage includes delayed repricing, the selected denomination and retained string IDs in the order payload, incompatible schemas, navigation to a cached different game, validation state and stale nickname responses.
- Chromium passed all eight responsive cases and the existing ID-only/duplicate-submit case. The new pointer-click regression passed separately after correcting its optional-field label locator: ID and selected Region persist, and the order request contains the newly selected amount. These browser checks use the current production bundle with mocked API responses.
- Storefront client typecheck, lint and build passed. The wider `tsconfig.test.json` check remains blocked by unrelated concurrent transaction/fulfillment changes (missing exports, fulfillment progress/return typing and ledger reason arguments); it reported no errors in the changed files.

Own final focused run:

```text
node -r dotenv/config node_modules/vitest/vitest.mjs run apps/storefront/client/src/pages/InstantBuyPage.test.tsx apps/storefront/client/src/components/shop/DeliveryFieldInput.test.tsx apps/storefront/src/inputConfiguration.test.ts dotenv_config_path=C:/Users/ilham/Documents/web-and-bot-order/.env
3 files passed; 42 tests passed; exit 0; duration 7.79s.
```

Own changed-backend run:

```text
node -r dotenv/config node_modules/vitest/vitest.mjs run apps/storefront/test/topup-order-api.test.ts dotenv_config_path=C:/Users/ilham/Documents/web-and-bot-order/.env
1 file passed; 40 tests passed; exit 0; duration 36.87s.
```

New field timing regressions first failed against the original behavior, then passed. Initial page regressions failed for missing in-flow CTA/summary/configuration feedback and missing voucher-pending blocking, then passed. Additional final regressions cover attempted-submit/reset timing, out-of-order repeated voucher applies, stale currency/pricing context, edited unapplied codes, trimmed long IDs and duplicate submission. Nickname fake-timer setup now waits for real initial query completion and advances timers inside async `act`; the previous warning flood is absent from the final focused run.

Own browser run, using the current built SPA and mocked API responses only:

```text
node node_modules/@playwright/test/cli.js test --config=tests/ui/checkout.playwright.config.ts
9 passed (12.7s); exit 0.
```

Eight responsive cases: 320, 360, 375, 390, 412, 430, 768 and 1280px. One additional case covers ID-only metadata, inline constraint timing, trimmed payload and duplicate submission. Assertions cover overflow, radio keyboard operation, two-line names, readable price columns, authoritative total, primary/sticky transitions, resize to/from desktop, measured spacer, safe-area declaration and footer clearance. Screenshots are generated for 320, 390 and 1280px. Existing static payment assets are served safely by the harness, including QRIS. No real provider/payment/order request leaves the mocked API harness.

The initial harness footer assertion incorrectly demanded sticky even when primary remained visible; it was corrected to check actual intersection and footer clearance. Two sandboxed Playwright runs printed nine passing cases but hung during Windows teardown and were stopped. The final run outside that process sandbox completed cleanly; `.last-run.json` reports passed with no failed tests.

Parent-provided independent evidence (not rerun here):

- Baseline checkout components: 4 files / 54 tests passed; Prisma generate passed.
- Existing player-input CRUD, Digiflazz CRUD and core playerInput: 3 files / 254 tests passed, exit 0, 102.83s.
- Shared frontend consumers: all 238 tests green across runs; CheckoutPage rerun passed all 62 after its blur-timing assertion update.
- `spa-api`: 154 passed; `topup-check-account` passed. The quantity-test Digiflazz fixture now has a valid configured field; the final own 40-test topup-order run supersedes its earlier configuration-related fixture failure.
- Recursive workspace typecheck and separate root `tsc -p tsconfig.test.json --noEmit`: passed.
- Storefront lint and frontend boundary check: passed.
- Storefront Vite build: passed. Own build after observer empty-entry fix passed (8.52s); parent rebuilt the final source and reran lint successfully (build 6.82s).

## Compatibility audit and limits

Parent's read-only local DB audit: 215 active SKUs beneath active/nonarchived products; 94 input-free, 53 single-field, 68 multi-field, 9 optional field definitions, no invalid configuration IDs. Strict fields, provider references and the Digiflazz nonempty rule all passed. No live DB changes, migration or backfill were necessary. Public validity is additive; older payloads without the flag retain existing field behavior.

Testing used isolated API test databases and browser API fixtures. Real supplier delivery, real payment settlement, physical-device safe-area inset values and live account lookup are not asserted by the UI harness. The measured spacer includes actual CSS safe-area padding; Chromium checks geometry and the declaration, with real hardware left to device QA. Existing build warnings about the static/dynamic CheckoutPage import and bundle size remain; preexisting shared-consumer act/Node localStorage warnings were not refactored.

## Files and artifacts

- `apps/storefront/client/src/pages/InstantBuyPage.tsx` and `.test.tsx`
- `apps/storefront/client/src/pages/CheckoutPage.test.tsx`
- `apps/storefront/client/src/components/shop/DeliveryFieldInput.tsx` and new `.test.tsx`
- `apps/storefront/client/src/components/shop/DenominationCard.tsx`
- `apps/storefront/client/src/components/shop/OrderSummaryCard.tsx`
- `apps/storefront/client/src/components/shop/StickyPurchaseBar.tsx`
- `apps/storefront/client/src/components/Layout.tsx`
- `apps/storefront/client/src/api/types.ts`
- `apps/storefront/src/inputConfiguration.ts` and new `.test.ts`
- `apps/storefront/src/pageData.ts`
- `apps/storefront/src/routes/apiTopup.ts`
- `apps/storefront/test/topup-order-api.test.ts`
- `packages/core/locales/en.json` and `id.json`
- `tests/ui/checkout.playwright.config.ts`, `checkout-dynamic-sticky.spec.ts`, `serve-checkout.mjs`
- `.gitignore` (narrow harness evidence ignore) and this report

Reproducible browser config: `tests/ui/checkout.playwright.config.ts`. Build the storefront first, then run the command above from the worktree root. No dotenv/DB is needed for the browser harness.

Local, deliberately uncommitted screenshots: `.audit-data/checkout-dynamic-sticky/screenshots/checkout-{320,390,1280}-primary.png`, plus `checkout-{320,390}-sticky.png`. Playwright output is under `.audit-data/checkout-dynamic-sticky/playwright/`. The narrow ignore excludes only this task's generated evidence. No user settings file was touched.

Self-review: reviewed final source/test diffs against the plan for configuration handling, field resets/normalization, price/voucher races, idempotency, observer lifecycle, responsive layout and footer portal cleanup; no outstanding critical/important findings. Parent performs independent review. Workflow rulings: follow explicit recovery authorization (existing worktree, no agents/brainstorming gates, parent broad checks); use the existing ledger fallback for unavailable native task tools. No product-requirement deviations or deferred polish changes were introduced.

Independent task review: approved; no critical or important findings. Its single verified minor was an inaccurate browser-test title claiming optional-select coverage for an ID-only fixture. Renamed the title to describe ID-only metadata, blur constraints, trimmed payload and duplicate guarding; test behavior is unchanged. Controller also confirmed final committed typechecks passed.

Review follow-up verification: the renamed Playwright case alone ran with `--grep "ID-only metadata, blur constraints, trimmed payload, and synchronous duplicate guard"` outside the Windows process sandbox: **1 passed (2.9s), exit 0**. No full-suite rerun or production source changes.
