# Checkout dynamic fields and hybrid CTA

Implement the user-authorized prompt at `C:/Users/ilham/Downloads/prompt-checkout-dynamic-fields-sticky-cta.md` incrementally in the existing storefront.

## Global constraints

- Account details → Choose a plan → Discount → Summary → Buy now stays in that order; preserve guest contact and payment selection.
- `Denomination.additionalFields` / public `additional_fields` is the existing source of truth. Reuse it, with bilingual labels, helpers, options and constraints. No game-name inference, new parallel schema, provider mapping on the client, schema migration or live backfill.
- Backend validates customer data and owns provider targets and pricing. Reuse `parseInputFields`, provider mapping validation and order snapshot behavior.
- Empty optional fields never block checkout. Filled values still use existing backend validation.
- Primary Buy now is in flow below Summary at all viewports. Mobile sticky shows only while primary CTA is outside viewport. Use existing lg breakpoint and IntersectionObserver; avoid an oscillation caused by the sticky covering its sentinel.
- Safe-area and footer clearance only while sticky is active; preferably measured height and space after the site footer rather than a pre-footer spacer.
- Both CTAs use the same price, pending flag, blocked state and submit handler. Synchronous lock plus existing idempotency protects double clicks.
- Keep current currency formatter, QRIS fee rules, localization, cart independence and existing interactions.
- Use token styling and >=44px controls. Plan grid keeps price aligned and unbroken, names clamp to two lines, narrow viewports remain usable.

## Task 1: Implement and verify checkout UI

Read the supplied prompt, then relevant actual files. Primary targets: InstantBuyPage.tsx, DeliveryFieldInput.tsx, DenominationCard.tsx, OrderSummaryCard.tsx, StickyPurchaseBar.tsx; their focused tests; bilingual locales; pageData.ts and apiTopup.ts if needed for safe configuration errors.

1. Expose safe, additive input configuration validity for product denominations, using strict existing metadata parsing. Malformed metadata must not silently become an apparently input-free product. Validate server mapping too; log denomination identifiers and a technical reason safely on backend. Digiflazz products with no configured input must report a configuration error. Stock-delivered products with no input remain supported. Validate before guest account/order writes.
2. Render active fields dynamically. Mark optional labels, use metadata helper text, show neutral required hints initially and inline errors on blur/touched or attempted submit. Wire aria-invalid/describedby. Reset touched and answers on SKU/config changes. Preserve string IDs and send only configured trimmed answers. Summary shows selected plan and only nonempty configured account fields.
3. Fix plan layout via grid and consistent price column, two-line names, keyboard radio group bound to the actual buy form, stable selection height.
4. Render normal primary CTA below summary and observe its actual element, accounting for late preview mount. Desktop never shows bottom CTA. On mobile, hide sticky whenever primary intersects; handle viewport changes and observer cleanup; use a simple total/Buy now bar. Preserve any necessary cross-currency payable explanation.
5. When sticky is mounted, reserve its real height plus contained safe area after site footer, and remove space when hidden. Avoid global persistent side effects.
6. Inline reason for unavailable/config-invalid fields, loading/unavailable price, invalid account details, contact or payment choice. Preserve calm initial state. Share pending UI and synchronous submit guard; show localized Processing while pending. Retain backend idempotency.
7. Price consistency: current selected plan's authoritative preview feeds summary and both CTAs. Disable during voucher repricing. Guard stale voucher results when switching SKU, currency/context or applying twice; distinguish entered code from applied code so editing an un-applied coupon cannot change submitted amount. No new price formulas.
8. Add meaningful component/API regressions for dynamic ID-only, ID+zone, optional-empty, select/constraint fields, inline validation timing, invalid metadata, summary omission, primary/sticky visible transitions, desktop, duplicate submission, authoritative price/voucher transitions. Update tests relying on obsolete always-sticky UI.
9. Run focused tests, storefront lint, applicable typechecks/build and browser responsive verification at 320, 360, 375, 390, 412, 430, 768 and desktop. A local mocked API browser harness is appropriate and avoids live DB/provider/payment. Keep harness reproducible in tests/UI with its own Playwright config if necessary. No real order/provider calls.
10. Self-review, commit requested changes in this worktree, and write `docs/checkout-dynamic-sticky-report.md` covering root cause, metadata, frontend/backend/provider behavior, sticky behavior, files, evidence, limitations and compatibility.

## Review

Controller dispatches task review after implementation and broad branch review after fixes. Parent handles any environment issues and final validation. Do not dispatch child agents or merge/push/deploy.
