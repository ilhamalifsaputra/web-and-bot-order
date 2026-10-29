# React Doctor Phase 1 - Correctness & Bugs Report

## 1. Baseline

- Audit: 2026-10-11. Worktree `.claude/worktrees/react-doctor-correctness`, branch `worktree-react-doctor-correctness`, base `771e3a6d`.
- React Doctor **0.9.17**, pinned in root devDependencies and lockfile. React 18.3.1, TanStack Query 5, Router 7, Vite 6, pnpm 9.15.9; existing Vitest/jsdom/Testing Library and Playwright.
- Baseline command: `npx --yes react-doctor@0.9.17 --project @app/web-admin-client,@app/storefront-client --scope full --verbose --json --json-out .local/react-doctor/baseline.json --no-score`.
- Measured baseline Bugs: **Admin 19 + Storefront 34 = 53**. The supplied prompt headline says 19 + 33 = 52, but its per-rule Storefront counts sum to 34. Raw baseline JSON confirms 53. The initial unfiltered scan reported 320 diagnostics before Bugs severity was raised.
- The first implementation reduced 53 to 27: 26 reviewed observations/false positives and one unresolved ticket identity contract. After those limitations were explained, the user explicitly requested fixing all 27. The follow-up replaces uncached mutation wrappers with guarded event handlers, makes answer updates declarative, and supplies stable list identities. The ticket blocker is resolved with a minimal additive ID contract; server and client must ship together. No schema, pricing, payment/provider, authentication, fulfillment, or product-family business rules changed.
- Pre-integration full Bugs scan: **Admin 0 + Storefront 0 = 0**, without new suppressions, category downgrades or diagnostic ignores. Final build, full typecheck, lint and all 11,505 tests passed. This is a verified tool result, not a guarantee that every possible runtime bug has been discovered.
- No existing Doctor config or pre-commit hook. Storefront already had token-focused ESLint; Admin had no lint script. Main checkout's untracked `skills-lock.json` was untouched. Graphify could not read absent graph data, so current source was inspected.
- Scans and command logs are under ignored `.local/react-doctor/`. Rule recipes were fetched with no-cache headers before each initial pass. The earlier report is preserved locally as `phase-1-report-before-followup.md`.

## 2. Progress by pass

Counts are **Admin / Storefront**, including diagnostics originally assessed as non-bugs. Final counts include the user's follow-up request.

| Pass | Rule | Before | Final | Changes and focused evidence |
|---|---|---|---|---|
| 1 | no-unguarded-numeric-input-parse | 0 / 1 | 0 / 0 | Finite numeric quantity with existing bounds; ProductPage 61 tests initially. |
| 2 | query-mutation-missing-invalidation | 4 / 4 | 0 / 0 | Scoped invalidation for cached data; six uncached actions use guarded async handlers. Follow-up: 162 tests / 5 files. |
| 3 | exhaustive-deps | 3 / 1 | 0 / 0 | Committed SSE callbacks, stable key dependencies, search/settings initialization guards; two unnecessary old suppressions removed. |
| 4 | no-side-effect-in-state-updater-function | 1 / 2 | 0 / 0 | SettingsNav persistence after commit; immutable per-unit answer construction. Follow-up: 119 tests / 2 files. |
| 5 | no-ref-current-in-render | 1 / 1 | 0 / 0 | Commit dialog/preview refs in layout effects; 46 tests / 2 files initially. |
| 6 | no-derived-useState | 0 / 1 | 0 / 0 | Server-derived cart quantity until deliberate editing; final CartPage race regression 25/25. |
| 7 | no-adjust-state-on-prop-change | 5 / 2 | 0 / 0 | Event-owned search/dialog sessions and selection snapshots; focus and reopen regressions. |
| 8 | no-effect-chain | 1 / 2 | 0 / 0 | Product/filter session ownership and checkout derivation; existing transaction payloads retained. |
| 9 | no-array-index-as-key | 4 / 18 | 0 / 0 | File/draft IDs, database IDs, explicit static IDs, order-unit IDs, single pricing preview. Follow-up: 283 tests / 16 files, Admin 49/49, API 159/159. |
| 10 | no-create-object-url-in-render | 0 / 2 | 0 / 0 | Effect-owned preview resources; strict cleanup and pure-render tests. |
| Total | Bugs diagnostics | **19 / 34** | **0 / 0** | **53 -> 0; remaining follow-up 27 -> 0.** |

Initial passes used affected tests, package typechecks, lint and Doctor scans before continuing. Follow-up similarly completed the mutation, updater, then key passes separately. Focused counts describe individual runs, not additive unique-test totals. Failing new assertions/fixtures were corrected and rerun before acceptance.

## 3. Root causes and fixes

1. **Quantity parsing:** read `valueAsNumber`, guard nonfinite values, preserve truncation, minimum 1 and inventory caps. Empty/partial, fractional, negative, zero, valid and excessive entries are covered; cart submission still sends the established payload once.
2. **Cache/action ownership:** ticket/order updates refresh relevant detail/list caches; cart actions refresh context/cart/checkout. Payment cancellation removes the exact payable/status caches and refreshes relevant product/order data, without local paid status or wallet credit. Resend/reveal, reset-email, restock subscription and wallet invoice creation have no changed cached-query representation, so they use async event handlers with synchronous duplicate guards, pending/error/local state, and unmount/selection request tokens. No dummy/global invalidation. Admin order identity owns its action session. Stale restock responses cannot reset a newer request or redirect another selection; leaving wallet top-up ignores its old invoice response.
3. **Credential containment:** revealing credentials formerly retained the response in TanStack's mutation cache despite local-state rendering. The direct reveal handler keeps credentials out of both query and mutation caches. Hide/unmount clears the local value; tests assert an empty mutation cache and sanitized cached order. Existing authorization, audit and reveal API behavior remain unchanged.
4. **Effects/committed refs:** SSE uses the latest committed callback and reconstructs its query key inside the effect; equal inline keys do not reconnect. Cleanup detaches listeners and closes the source. Search/denomination/settings dependencies preserve equality/one-time guards. Dialog-open and instant-buy preview-context refs update after commit.
5. **Pure state updates:** SettingsNav persists committed expansion changes after render, without initial or StrictMode duplicate writes. Storefront answer updaters construct the next array with `Array.from`, preserving untouched entries and copying the edited object. No previous-state mutation or storage/network side effect inside an updater.
6. **Cart draft lifetime:** untouched quantity derives from the server; editing owns a nullable draft. Success clears only that submitted draft. Newer edits made during the request survive; errors/refetches preserve dirty input. A regression first reproduced an old response erasing newer input, then passed after correction.
7. **Session boundaries:** Admin search retains the MotionDialog shell and keys session content, preserving exit/focus behavior. Save confirmation synchronously prevents duplicate submission and ignores completion after unmount. Storefront highlight belongs to its query/result snapshot. Product sessions follow product identity; selection events reset restock state; customer selection belongs to its filter/page context. Checkout derives live item text while retaining user-owned drafts/settings.
8. **Editable/file identity:** additional-field drafts receive local IDs at creation; stored fields use existing keys. Submission excludes draft IDs. Browser-local counters work on plain HTTP without `crypto.randomUUID`. Upload identity follows individual File objects, preserving duplicate names/metadata and original submission files.
9. **Persistent dynamic identity:** Storefront exposes existing database IDs for testimonials, public/account reviews, order-detail items, ticket messages and linked-order items: seven additive mapping fields in three server files, with required client types and updated fixtures. No schema/business change. Ticket entries namespace message IDs and deterministic system/legacy event IDs; duplicate content/timestamps are never identity. Admin answers follow order-item/unit IDs; legacy extra answer slots retain immutable order/ordinal identity. Static steps/badges have semantic IDs, breadcrumbs use unique ancestor destinations/current marker, and the one-cost pricing preview renders as one panel.
10. **Preview resources:** `useFileRows` owns stable File row identities and `FilePreview` owns effect-created image URLs and exact cleanup on replacement/removal/unmount. Reordering retained File objects retains their preview; a replacement File receives its own preview. Rendering without committed effects allocates none.

## 4. Functional regression checks

- Product/cart/checkout/payment: quantity/stock bounds, server clamping, dirty drafts, both product families, product/denomination switching, live item/schema/currency refetches, per-unit answers, errors, scoped cache refresh, cancellation and existing payment methods.
- Repeated reset submission, wallet invoice creation and reveal each make exactly one POST while pending. Leaving the top-up route prevents late navigation back. Reveal responses enter neither TanStack cache.
- Ticket tests use duplicate content/timestamps, insertion and reordered refetches. Video DOM nodes and playback positions stay with message IDs. Order credential rows, equal-label badges, instruction inputs and Admin buyer-answer nodes retain identity through reorder.
- API tests assert IDs against the database and distinct duplicate-message IDs across GETs. Focused API suite: **159/159 passed**.
- SSE: equal-key reuse, URL/key/null changes, one event with the current callback, late events after cleanup. StrictMode search/dialog: focus, Escape/opener restoration, reopen reset and stale-session completion.
- Attachments: duplicate filenames/metadata, removal/reordering, retained focus, missing `crypto.randomUUID`, exact allocation/revocation counts and URL values. Every allocated URL is revoked once; server rendering allocates none.
- Previous bot wiring timeout came from three real Telegram startup requests with a fake token while polling was mocked. Test-only stubs now cover `getMe`, `setMyCommands`, `deleteWebhook`, assert four expected menus/startup calls and retain all seven poller checks. Focused **5/5 passed**, 17 ms test execution. No production bot code or timeout changed.
- Browser E2E/manual production checks were not run. No claim of real gateway, Telegram delivery or production verification.

## 5. False positives and blockers

**Remaining full-scan Bugs: 0. Remaining Phase 1 blockers: 0.** The initial 26 observations and ticket identity blocker are superseded by the follow-up fixes. Some original findings represented safe code; 53 cleared diagnostics do not imply 53 independently reproduced runtime failures.

Before synchronization with the broader remediation merged into master, the unfiltered full scan retained **266 non-Bugs warnings**: 117 Accessibility, 108 Maintainability, 41 Performance. Admin has 206; Storefront 60. These historical counts are superseded by section 9.

The pre-integration changed scan reported one Performance `no-create-object-url-without-revoke` in `hooks/useFileRows.ts`. The analyzer does not follow row-object URL ownership into cleanup. The effect revokes owned `row.url` values; StrictMode tests assert those same values exactly once on replacement/removal/unmount. Integration now reuses master's effect-owned `FilePreview` while the row hook retains File object identity; that diagnostic is resolved without suppression.

Initial `--no-respect-inline-disables` auditing exposed hidden dependency matches. Unnecessary SettingsNav/HelpPage suppressions were removed. Retained pre-existing cases were reviewed: Layout's welcome snapshot, CheckoutPage's serialized input-schema boundary, InstantBuyPage's first-load draft seed, SearchRedirect's mount-only handoff, Admin SupportPage/ReplyDialog snapshots. No suppression was added. A clean default Doctor scan does not mean all existing directives were removed.

## 6. Pre-integration verification

- Isolated ignored `.env`, ports **8319/8320**, private **react_doctor_correctness** DB in existing local PostgreSQL. Frozen install, Prisma generation and initial workspace build passed. No second bot/application server started.
- Existing dependency importers/metadata/snapshots preserved; only pinned Doctor dependency closure added. Frozen install passed without re-resolution.
- `git fetch` completed before the final gate; HEAD, master and origin/master were `771e3a6d`; no rebase needed. Changes remain uncommitted in this worktree.
- `pnpm -r build`: **exit 0** (`followup-build.log`). Existing large-chunk warnings are outside Phase 1.
- `pnpm typecheck`: **exit 0**, all workspace checks plus `tsc -p tsconfig.test.json` (`followup-typecheck.log`). An optional wider TSX audit surfaced existing fixture issues in tests excluded by the supported test-type command; that optional audit is not claimed green.
- `pnpm test`: **exit 0, 612 files passed / 0 failed; 11,505 tests passed / 0 failed**, 747.18 seconds (`followup-final-test.log`). The unchanged pretest migration drift/timestamp, frontend boundary, token-lint and detection-purity checks also passed. This completed full run accepted the pre-integration source; section 9 records verification after synchronization with newer master.
- Earlier full runs exposed uninitialized public schema in the private DB and the wiring timeout. Integrity failed in isolation too; after asserting DB name exactly `react_doctor_correctness`, `pnpm exec prisma db push --skip-generate` applied the existing unchanged schema only there, then integrity passed 5/5. Wiring was subsequently made deterministic. Earlier failed runs remain in logs and are not passing gates.
- `pnpm lint`: **exit 0** (`followup-final-lint.log`), Storefront token ESLint plus both-client full Bugs.
- `pnpm doctor:bugs --json --json-out .local/react-doctor/followup-final-bugs.json`: **exit 0, Admin 0 / Storefront 0**.
- `pnpm doctor:changed --json --json-out .local/react-doctor/followup-final-changed.json`: **exit 0, 0 new Bugs**, master comparison including untracked source.
- `pnpm doctor:full --json --json-out .local/react-doctor/followup-final-full.json`: **exit 0, 0 Bugs**, 266 non-Bugs warnings. Warnings remain visible; success reflects configured blocking severity.
- `pnpm doctor:full --scope changed --base master --include-untracked --json --json-out .local/react-doctor/followup-final-changed-full.json`: **exit 0**, one reviewed Performance cleanup false positive, no new Bugs.
- Iteration scans used `--no-supply-chain`; final scans used defaults with supply-chain checks. Production source was frozen before final scans; only deterministic wiring tests/report changed afterward.
- `git diff --check`: **passed**. No CI/CD, Docker/deployment, schema-source or production bot edits. Additive Storefront IDs require coordinated server/client delivery.

## 7. Local prevention guard (NO CI/CD)

- Root `doctor.config.json`: `lint: true`, `warnings: true`, `scope: full`, `blocking: error`, `categories: { Bugs: error }`. No rule/category ignore added. Both apps pass full Bugs checks.
- `doctor:bugs`, `doctor:changed`, `doctor:full` scan both verified packages. Changed scans compare master and include untracked source. Runtime tests remain necessary.
- Root `lint` combines existing Storefront token ESLint with both-client Doctor Bugs. Existing typecheck/test/build/pretest checks remain intact. AGENTS.md documents local React verification.
- Standalone ESLint Doctor integration was evaluated/deferred: presets without CLI framework context yielded Router-v8 import errors against Router 7, browser-global/hydration false positives in a browser-only SPA, and unknown pre-existing Hooks directive errors. Trial config/dependencies removed; project-aware CLI supplies the guard.
- No existing pre-commit hook. `react-doctor install --dry-run` inspected only. No native hook, hook manager, CI or deployment change installed; automatic commit/deployment enforcement is not claimed.
- Official references: [configuration](https://www.react.doctor/docs/configuration/config-files), [CLI](https://www.react.doctor/docs/reference/cli-reference), [ESLint integration](https://www.react.doctor/docs/configuration/eslint-and-oxlint-plugins). All ten rule recipes reviewed before their initial pass.

## 8. Changed files

Historical Phase 1 changed-file inventory, before integration with the newer master remediation. Backend edits are limited to three additive ID mappings; the only bot edit is its test. Other sessions' worktrees were not modified. Integration and push were subsequently authorized by the user; section 9 records the synchronized verification.

- `.gitignore`
- `AGENTS.md`
- `apps/order-bot/test/wiring.test.ts`
- `apps/storefront/client/src/api/types.ts`
- `apps/storefront/client/src/components/AuthBrandPanel.tsx`
- `apps/storefront/client/src/components/shop/AttachmentPicker.tsx`
- `apps/storefront/client/src/components/shop/Breadcrumb.tsx`
- `apps/storefront/client/src/components/shop/EvidenceUploader.tsx`
- `apps/storefront/client/src/components/shop/FileRows.test.tsx`
- `apps/storefront/client/src/components/shop/GameTopupDetailCard.test.tsx`
- `apps/storefront/client/src/components/shop/GameTopupDetailCard.tsx`
- `apps/storefront/client/src/components/shop/InlineTicketPanel.test.tsx`
- `apps/storefront/client/src/components/shop/SearchOverlay.test.tsx`
- `apps/storefront/client/src/components/shop/SearchOverlay.tsx`
- `apps/storefront/client/src/components/shop/StaticPage.test.tsx`
- `apps/storefront/client/src/components/shop/StaticPage.tsx`
- `apps/storefront/client/src/components/shop/StepTimeline.test.tsx`
- `apps/storefront/client/src/components/shop/StepTimeline.tsx`
- `apps/storefront/client/src/components/shop/Stepper.tsx`
- `apps/storefront/client/src/components/shop/TicketMessageThread.test.tsx`
- `apps/storefront/client/src/components/shop/TicketMessageThread.tsx`
- `apps/storefront/client/src/components/shop/TicketOrderSummaryCard.test.tsx`
- `apps/storefront/client/src/components/shop/TicketOrderSummaryCard.tsx`
- `apps/storefront/client/src/components/ui/TrustBadgeRow.test.tsx`
- `apps/storefront/client/src/components/ui/TrustBadgeRow.tsx`
- `apps/storefront/client/src/hooks/useFileRows.ts`
- `apps/storefront/client/src/hooks/useSse.test.ts`
- `apps/storefront/client/src/hooks/useSse.ts`
- `apps/storefront/client/src/lib/ticketTimeline.test.ts`
- `apps/storefront/client/src/lib/ticketTimeline.ts`
- `apps/storefront/client/src/pages/CartPage.test.tsx`
- `apps/storefront/client/src/pages/CartPage.tsx`
- `apps/storefront/client/src/pages/CheckoutPage.tsx`
- `apps/storefront/client/src/pages/ForgotPage.test.tsx`
- `apps/storefront/client/src/pages/ForgotPage.tsx`
- `apps/storefront/client/src/pages/HelpPage.test.tsx`
- `apps/storefront/client/src/pages/HelpPage.tsx`
- `apps/storefront/client/src/pages/HomePage.test.tsx`
- `apps/storefront/client/src/pages/HomePage.tsx`
- `apps/storefront/client/src/pages/HowToOrderPage.tsx`
- `apps/storefront/client/src/pages/InstantBuyPage.tsx`
- `apps/storefront/client/src/pages/OrderDetailPage.test.tsx`
- `apps/storefront/client/src/pages/OrderDetailPage.tsx`
- `apps/storefront/client/src/pages/PayPage.test.tsx`
- `apps/storefront/client/src/pages/PayPage.tsx`
- `apps/storefront/client/src/pages/PrivacyPage.tsx`
- `apps/storefront/client/src/pages/ProductPage.test.tsx`
- `apps/storefront/client/src/pages/ProductPage.tsx`
- `apps/storefront/client/src/pages/RefundPage.tsx`
- `apps/storefront/client/src/pages/ReviewsPage.test.tsx`
- `apps/storefront/client/src/pages/ReviewsPage.tsx`
- `apps/storefront/client/src/pages/TermsPage.tsx`
- `apps/storefront/client/src/pages/TicketDetailPage.test.tsx`
- `apps/storefront/client/src/pages/WalletTopupPage.test.tsx`
- `apps/storefront/client/src/pages/WalletTopupPage.tsx`
- `apps/storefront/client/src/pages/dev/UiGalleryPage.tsx`
- `apps/storefront/src/pageData.ts`
- `apps/storefront/src/routes/apiAccount.ts`
- `apps/storefront/src/routes/apiPages.ts`
- `apps/storefront/test/spa-api.test.ts`
- `apps/web-admin/client/src/api/types.ts`
- `apps/web-admin/client/src/components/layout/AppShell.tsx`
- `apps/web-admin/client/src/components/layout/SearchModal.test.tsx`
- `apps/web-admin/client/src/components/layout/SearchModal.tsx`
- `apps/web-admin/client/src/components/shared/AdditionalFieldsEditor.test.tsx`
- `apps/web-admin/client/src/components/shared/AdditionalFieldsEditor.tsx`
- `apps/web-admin/client/src/components/shared/MotionDialog.tsx`
- `apps/web-admin/client/src/components/shared/PageHeader.tsx`
- `apps/web-admin/client/src/components/shared/SaveConfirmDialog.test.tsx`
- `apps/web-admin/client/src/components/shared/SaveConfirmDialog.tsx`
- `apps/web-admin/client/src/components/shared/SettingsNav.test.tsx`
- `apps/web-admin/client/src/components/shared/SettingsNav.tsx`
- `apps/web-admin/client/src/hooks/useSse.test.ts`
- `apps/web-admin/client/src/hooks/useSse.ts`
- `apps/web-admin/client/src/lib/additionalFields.test.ts`
- `apps/web-admin/client/src/lib/additionalFields.ts`
- `apps/web-admin/client/src/pages/DenominationEditPage.tsx`
- `apps/web-admin/client/src/pages/OrderDetailPage.test.tsx`
- `apps/web-admin/client/src/pages/OrderDetailPage.tsx`
- `apps/web-admin/client/src/pages/OrdersPage.tsx`
- `apps/web-admin/client/src/pages/PricingPage.tsx`
- `apps/web-admin/client/src/pages/SearchPage.tsx`
- `apps/web-admin/client/src/pages/TicketDetailPage.test.tsx`
- `apps/web-admin/client/src/pages/TicketDetailPage.tsx`
- `apps/web-admin/client/src/pages/UsersPage.test.tsx`
- `apps/web-admin/client/src/pages/UsersPage.tsx`
- `docs/REACT_DOCTOR_PHASE_1_REPORT.md`
- `doctor.config.json`
- `package.json`
- `pnpm-lock.yaml`


## 9. Integration with newer master

- Synced onto `f374cc01`, which includes the separate complete React Doctor remediation. All 41 overlapping file conflicts were reviewed against both changesets. Latest extracted components, accessibility controls, LazyMotion, bounded stock concurrency and formatter helpers remain; Phase 1 request/cache ownership, stable database identities and regression coverage were preserved.
- File previews reuse master's effect-owned `FilePreview`, with File object IDs from `useFileRows`. Tests assert four allocations and four exact revocations for the two StrictMode-mounted image previews; reorder retains the existing preview URL and focus. No suppression was added.
- Focused integrated regressions: shared components 64 tests passed; storefront pages/actions 288 tests passed; admin 138 tests passed plus the corrected SaveConfirmDialog file 8/8; final credential/file ownership 57/57; ProductPage 63/63. Counts are individual runs, not unique totals.
- Read-only Prisma schema diff against the integration checkout's configured local database returned `-- This is an empty migration.` Neither incoming master nor Phase 1 modifies Prisma schema/migrations, so no database migration is needed for this integration.
- Read-only cross-review approved Storefront integration and caught a remaining editor override of the counter ID with `crypto.randomUUID()`. A new plain-HTTP Add Field regression failed, then passed after removing the redundant override. The focused file and InstantBuy checks passed 49/49; InstantBuy also passed alone 38/38 after a load-sensitive failure in the interrupted full run.
- Uncached full React Doctor scan after conflict resolution: **0 errors, 0 warnings**, admin 316 and storefront 303 source files, no skipped checks. Full typecheck, workspace build and lint passed before the review correction; the admin bundle was rebuilt after it. Final synchronized source `be1893a2` passed **`pnpm typecheck` and `pnpm test` (exit 0): 616 files, 11,523 tests, 0 failures, 778.11 seconds**. All unchanged pretest gates passed. Logs: `synced-final-typecheck.log`, `synced-final-test.log`; final frontend builds: `synced-admin-build.log` and `synced-store-build.log`.
- Validation artifacts are preserved in the integration checkout under ignored `.local/react-doctor-correctness-integration/` before the feature worktree is removed. The integration checkout repeats the required full typecheck/test gate before push, using the same isolated test database through a process-only environment override; main `.env` is retained unchanged. Its command evidence is `main-typecheck.log` and `main-full-test.log`.


## 10. Storefront visual hierarchy merge (2026-10-12)

- Resolved the 13 conflicting files from `worktree-storefront-visual-hierarchy` (`70bbcd8f`) against `master` (`27b8d6e7`) in the isolated `storefront-merge-conflicts` worktree. Preserved extracted components, stable item identities, request/cache ownership, checkout guards and regression tests from both branches.
- Applied the tab-bar routing change in `MobileTabBar.helpers.ts` and retained the shared `CheckoutErrorBanner` with a scroll anchor. Integrated larger totals, countdown below the payable amount, catalog-first homepage, touch targets and distinct Premium Apps/Game Top Up presentation.
- Storefront package typecheck and the complete workspace build passed. Focused Storefront client validation passed: **127 files, 1,286 tests, 0 failures, 81.15 seconds**.
- Astra reduced control-flow complexity by extracting module-level denomination label/price components and a product-data hook, preserving markup, pricing, query ownership and session state. The focused regression files passed **90 tests in 10.15 seconds**; Storefront typecheck and lint passed.
- Final `pnpm doctor:changed` (35 files), `pnpm doctor:bugs` (620 files) and `pnpm doctor:full` passed. The full scan checked **620 files in 48.9 seconds: 0 errors and 0 warnings**, with an empty diagnostics JSON. No suppressions, exclusions or disabled rules were added. Full diagnostics: `react-doctor-5406a1d2-285a-4bc3-8cec-6de7b0f3587b` in the Windows temporary directory.
- Shared repository rules and the global Codex and Claude instructions now require a full scan across both React clients and all diagnostic categories, fixing all errors and warnings before completion, commit, merge or release.
- The full integration typecheck and test suite are pending.
- Validation logs are retained in the Windows temporary directory with the prefix `storefront-merge-conflicts-`. Runtime/database tests use the isolated local PostgreSQL database `storefront_merge_conflicts` on port 55439. The integration checkout's `.env` is unchanged.


## 11. Trustance toggles, Telegram callback, and 23 email events (2026-10-12)

- Worktree `auth-email-toggles`, baseline `aa2794f5`; admin/shared toggles, event preferences/schedule/thresholds/diagnostics and legacy Telegram fragment adapter were tested without adding suppressions or exclusions.
- `pnpm doctor:changed`: 30 files, no Bugs issues. `pnpm doctor:bugs`: 628 files, 12.6 seconds, no Bugs issues.
- `pnpm doctor:full`: **628 files, 12.7 seconds, 0 errors and 0 warnings across both clients and all categories**. Diagnostics directory: `react-doctor-5a5ec21e-4a31-48e6-8e7c-abeaed16d916` under Windows Temp.
- Repeated all three Doctor commands after synchronizing the existing voucher race test with the actual in-flight API request. This full scan reused diagnostic cache for 628 files in 337ms and again reported **0 errors and 0 warnings**, diagnostics `react-doctor-7ea76949-195f-42ce-b183-9125f5d5adc0`. The full run then identified a DOM readiness race in that same existing test (`within(null)` while the replacement SKU summary was loading); an explicit assertion waits for the summary to render. Assertions and production checkout behavior remain intact; no arbitrary delay was added. All Doctor commands are repeated for the final source.
- Final source: all three Doctor commands passed again; full scan **628 files, 154ms cached, 0 errors and 0 warnings**, diagnostics `react-doctor-d3c56a41-5e44-44ce-ae41-30d4f634d7cd`. Fresh workspace production build and full typecheck passed; mailer, loopback SMTP and InstantBuy validation passed **67/67**.
- Storefront lint and production workspace builds passed. Production Chromium smoke verified all 23 switches, locked mandatory recovery, keyboard Space, persisted refresh, failed-save previous state, render-only preview, no overflow at 390px and zero page errors; the QA script and desktop/mobile screenshots are preserved under `%TEMP%/trustance-auth-email-toggles/`. API fixtures were used; no customer mail or bot poller was started.
- Final synchronized gate passed: **`pnpm typecheck` and `pnpm test`, exit 0; 628 files, 11,804 tests, 0 failures, 717.65 seconds**. All unchanged pretest gates passed. Final pipeline also rebuilt the workspace and passed 67 mailer/SMTP/InstantBuy tests before the full gate. Logs `.typecheck-verified.log`, `.test-verified.log`, `.build-verified.log` and `.doctor-*-verified.log` are preserved in the worktree and under `%TEMP%/trustance-auth-email-toggles/verification/`; details are in `docs/TRUSTANCE_AUTH_EMAIL_TOGGLES_REPORT.md`.


## Ticketing V2 - 13 Oktober 2026

- Worktree `ticketing-v2`, branch `worktree-ticketing-v2`, synchronized with `master` / `origin/master` at `c39b0150` before the final gate.
- Final source full Doctor (`pnpm doctor:full`): **637 files, 0 errors, 0 warnings**, 38.4 seconds. Output `.ticketing-doctor-compact-final.log`, diagnostics `react-doctor-19b65f01-13a6-45a1-8f0f-34a14d1e1f3d`. No suppression, exclusion or disabled rule added.
- `pnpm doctor:changed`: 38 files, Bugs category clean. `pnpm lint`: Storefront ESLint and both clients' full `doctor:bugs` scan clean (637 files). Outputs `.ticketing-doctor-changed-complete-final.log`, `.ticketing-lint-complete-final.log`.
- Object URL previews belong to mounted components with effect cleanup; URLs are revoked on file change/unmount. Active content never receives a preview. Synchronous upload capacity handles multiple events before React rerenders, and a failed/denied/unverified file never appears in submitted attachment IDs. Final upload hooks/admin list/detail focused run: **87/87**.
- Browser runtime: customer help/detail and admin list/detail exercised with API fixtures at **CSS widths 320, 375, 768, 1024, 1440, 1920**. Document/main horizontal scroll stayed within client widths. Admin table scrolling is contained at 768/1024; mobile uses existing DataTable cards. Checked category switching clears order context, `Gg` refund description is invalid, long unbroken text wraps, title modal saves on mobile, and internal notes are distinct in admin.
- Browser fixtures verify rendering/interaction, not production authentication, live R2 or live Telegram. Authorization/domain behavior has separate isolated Postgres integration tests. Screenshots: `docs/ticketing-{help-mobile,detail-mobile,admin-mobile,admin-desktop,admin-detail-mobile}.png`.
- Workspace build and full typecheck passed on final source `50490bd7`, synchronized with `master` / `origin/master` at `c39b0150`. Final full verification passed: **`pnpm typecheck` and `pnpm test`, exit 0; 634 files, 11,845 tests, 0 failures, 757.39 seconds**. All unchanged pretest gates passed. Logs `.ticketing-build-complete-final.log`, `.ticketing-typecheck-compact-final.log` and `.ticketing-test-verified-final.log`. Subsequent changes only record verification in documentation.

- Final mobile filter QA: admin Status/Source controls share the same row at CSS width 320 (about 131 px each), with no document/main overflow across all six widths. Screenshot `docs/ticketing-admin-320.png`; 30/30 SupportPage tests passed.


## Dependency upgrade - 17 Oktober 2026

- Worktree `deps-upgrade`, branch `worktree-deps-upgrade`, based on `master` at `2f86c643`. Upgraded React 19, recharts 3, motion 14, vite 8, vitest 5, jsdom 30, plugin-react 6, eslint 10, TypeScript 6.0.3, zod 4 and the other majors listed in the commit log. React 19 type fallout (global `JSX` namespace, nullable `RefObject`, boolean `inert`) was fixed in source; no suppression, exclusion or disabled rule was added.
- `react-doctor` stays at 0.9.17: 0.9.18 adds a `click-events-have-key-events` warning for the clickable row in `apps/storefront/client/src/components/shop/TicketRow.tsx`, which is a design decision still open.
- Final source `pnpm doctor:full`: **637 files, 0 errors and 0 warnings across both clients and all categories**. `pnpm doctor:bugs` and `pnpm lint` clean (637 files); `pnpm doctor:changed` 245 files, no Bugs issues.
- `pnpm typecheck`, `pnpm run pretest` and `pnpm exec vitest run --maxWorkers=2` all exit 0 against an isolated local PostgreSQL on port 5560: **644 test files, 11,984 tests, 0 failures**. Production build passed. Runtime check is covered by the client test suites (React 19, jsdom 30); no live browser session was run.
- Not upgraded on purpose: TypeScript 7 (breaks typescript-eslint and the AST guard tests), Prisma 7 and `@grammyjs/conversations` 2 (separate branches), `prom-client` replacement, `@types/node` stays 22 to match `engines`.


## Pricing & Margins fix rounds - 19 Oktober 2026

- Worktree `pricing-margins`, branch `worktree-pricing-margins`, based on `master` at `b7a955f5`, with nine fix commits (`04c12366` through `4e979678`) answering an independent review of the Pricing & Margins feature that was already on `master`.
- Final source `pnpm doctor:full`: **640 files, 0 errors and 0 warnings across both clients and all categories** (449.9 seconds). `pnpm doctor:bugs`: **640 files, no issues in category Bugs** (143.2 seconds). `pnpm doctor:changed` was clean in the fix rounds. No suppression, exclusion or disabled rule was added.
- `pnpm run pretest` (migration drift, migration timestamps, frontend boundaries, Storefront lint, detection-engine purity) and `pnpm exec tsc -p tsconfig.test.json` both exit 0. The package typechecks of `pnpm typecheck` finished with `Done` for every package and no error line in the log.
- Full vitest run against an isolated local PostgreSQL (port 5591), in eight foreground shards with `--maxWorkers=2` because one unsharded run was stopped by the system under memory pressure: **651 test files, 12,189 tests; every shard exited 0 except shard 6**, which had one failure in `apps/web-admin/client/src/pages/VouchersPage.test.tsx` ("clears the bulk selection when the page changes", about 1.5 seconds under load). That file passes 27/27 when run alone (three separate re-runs, the last after the shards) and none of the fix commits touch it or any component it renders, so it is recorded as a load-dependent flake, not a regression.
- Not covered by an automated run in this branch: production authentication, live Digiflazz and live Telegram. Browser checks use API fixtures; see `.superpowers/sdd/visual-review.md` and `.superpowers/sdd/visual-review-2.md` (local, gitignored).

- Follow-up on the same branch (20 Oktober 2026): the post-fix browser review found three medium issues (error alert weaker than the warning, Apply-now error far from its button, and Apply now blocked for every category by one unreadable category rule). Six more commits (`b279f0a1` through `22c1789a`) fix them, including a contrast fix for the destructive alert (4.08:1 to 5.47:1). The first full scan of these commits showed two Doctor warnings (array lookup in a loop in `PricingSummary.tsx`, high control-flow complexity in `PricingPage.tsx`); they were fixed at the cause (a hoisted lookup and four extracted subcomponents), with no suppression.
- Final source: `pnpm doctor:full` **641 files, "No issues found!"** (0 errors, 0 warnings); `pnpm doctor:bugs` **641 files, no issues in category Bugs**; `pnpm typecheck` exit 0 with no `error TS` line; `pnpm run pretest` exit 0 (run against the isolated database, since the migration-drift check needs one).
- Full vitest on the final source, in eight foreground shards (`--shard=i/8 --maxWorkers=2`, isolated PostgreSQL on port 5591): **651 test files, 12,211 tests, every shard exit 0, 0 failures**. The earlier `VouchersPage.test.tsx` load flake did not recur.


## Tiered pricing, storefront part - 23 Oktober 2026

- Worktree `tiered-pricing`, branch `worktree-tiered-pricing`. Storefront client commits `bcbb8619` (tier ladder, quantity quote, cart and summary tier lines) and `fb505e5c` (expected_total quote binding and the "price changed" confirmation).
- The first full scan showed one warning (`react-doctor/only-export-components`: `tierApplies` exported from `TierPricing.tsx`). Fixed at the cause by moving it to `TierPricing.helpers.ts`, the existing `*.helpers.ts` pattern; no suppression, exclusion or disabled rule.
- Final source `pnpm doctor:full`: **651 files, "No issues found!"** (0 errors, 0 warnings, both clients, all categories). `pnpm doctor:bugs`: 650 files, no Bugs issues. `pnpm doctor:changed`: 29 files, no Bugs issues. Storefront ESLint clean. `@app/storefront` and `@app/storefront-client` typecheck and `tsc -p tsconfig.test.json --noEmit` exit 0.
- Runtime correctness is covered by focused client tests (ProductPage, CartPage, CheckoutPage, InstantBuyPage, OrderSummaryCard, ProductCard, strings): 301 tests passed, including a debounce/out-of-order test that proves a later quantity's price is never replaced by an earlier answer. The full `pnpm test` gate was not run in this session (machine memory); it remains due before merge. No live browser session was run.

- Final gate of the whole tiered-pricing branch (26 Oktober 2026, after the whole-branch review fixes): `pnpm doctor:full` **"No issues found!"** (0 errors, 0 warnings, both clients, all categories); `pnpm doctor:bugs` no Bugs issues. `pnpm typecheck` and `pnpm run pretest` (migration drift, timestamps, frontend boundaries, Storefront lint, detection purity) exit 0. Full `pnpm exec vitest run --maxWorkers=2` against the worktree's isolated PostgreSQL (port 5581): **660 test files, 12,432 tests, 0 failures**. This supersedes the "full gate not run" note in the storefront entry above. No live browser session was run.

- Admin tier editor precision follow-up (26 Oktober 2026): `apps/web-admin/client/src/lib/tierDraft.ts` now refuses a fractional rupiah (fixed unit price, amount off per unit) and a percent with more than 2 decimals inline, in the server's wording, and keeps Save disabled. `pnpm doctor:full`: **651 files, "No issues found!"** (0 errors, 0 warnings, both clients, all categories); `pnpm doctor:bugs`: 651 files, no Bugs issues; `pnpm doctor:changed`: 30 files, no Bugs issues. `@app/web-admin-client` typecheck exits 0; `TieredPricingCard.test.tsx` 22 tests passed (both families). The full `pnpm test` gate was not rerun for this follow-up (machine memory); it remains due before merge.


## Game Top-up catalog refactor, Phase 2 - 23 Oktober 2026

- Worktree `game-topup-refactor`, branch `worktree-game-topup-refactor`, 39 commits rebased onto `master` at `f3d960a4` (no conflicts). Net schema and migrations are identical to `master`; the Server level (`gameServer`) and the `game_topup_flow_v2_enabled` flag that were built during the work were both removed again by owner decision, so only region seeding, the region mixed-scope guard, the `From` label, hints and the Game Top-up `/search` remain.
- Final source `pnpm doctor:full`: **643 files, 0 errors and 0 warnings across both clients and all categories**. `pnpm lint` (Storefront token lint + `doctor:bugs`): **643 files, no issues in category Bugs**. `pnpm typecheck` and `pnpm run pretest` (migration drift, migration timestamps, frontend boundaries, Storefront lint, detection-engine purity) exit 0.
- Full vitest run against an isolated local PostgreSQL (port 5433), in eight shards (`--shard=i/8`) because two unsharded runs were stopped by the system under memory pressure; the first of them also lost 231 of 658 test files to `Worker exited unexpectedly with exit code 3221225794` (0xC0000142) and was therefore not counted. In the final sharded run **all 658 test files ran (12,347 tests)**. Shard 7 lost 13 files to the same worker crash on its first attempt and was re-run in full with one worker (82 files, 2,307 tests, exit 0); shard 8 was run with one worker (82 files, 1,241 tests, exit 0). Shards 2 to 5 exit 0.
- Two shards exit 1, each with a single failing test unrelated to this branch (neither file is touched by it): `SalesAnalyticsCard.test.tsx` "refetches with new params when a filter button is clicked" (shard 1) timed out at 20 s under load and passes alone (10/10); `VouchersPage.test.tsx` "clears the bulk selection when the page changes" (shard 6) fails when its file runs as a whole and passes with `-t`, and it also fails on pristine `master` (2 of 3 runs in a throwaway worktree at `f3d960a4`, since removed), so it is an intermittent test-isolation problem already present on `master`. This is therefore not a fully clean exit.
- Not covered by an automated run: live Digiflazz price-list shapes (region suffixes, publisher suffixes), live Telegram and production authentication. The region whitelist in `packages/core/src/regionLabel.ts` is a draft for the owner to extend. The backfill (`scripts/fill-game-regions.ts`) has only been dry-run against the worktree database; run it as a dry run on a copy of production and read the report before `--apply`, with no Digiflazz sync or import running.


## Game Top-up catalog refactor, Phase 3 and 4 - 25 Oktober 2026

- Worktree `game-topup-refactor`, branch `worktree-game-topup-refactor`, based on `master` at `f3d960a4` (0 commits behind at gate time), now 70 commits ahead including Phase 2. Phase 3 and 4 add: the single-message Game Top-up account parser and review screen, the IDR price lock (`expectedTotal` plus a per-render nonce) on every bot pay path, payment windows of 10/10/10/30/30 minutes (TokoPay and PayDisini / Binance Pay / Bybit UID / Bybit BSC / NOWPayments), a 120 s stale-claim recovery threshold, the payment reminder (`PAYMENT_REMINDER_DM`) and the expiry push (`ORDER_EXPIRED_DM`). No schema, migration, lockfile or dependency change; the only `package.json` change is one `./accountInput` entry in the `@app/core` exports map. `apps/storefront/src` and the web-admin sources are unchanged by Phase 3 and 4.
- Final source `pnpm doctor:full`: **643 files, 0 errors and 0 warnings across both clients and all categories**. `pnpm lint` (Storefront token lint + `doctor:bugs`): **643 files, no issues in category Bugs**. `pnpm -r build`, `pnpm typecheck` and `pnpm run pretest` (migration drift, migration timestamps, frontend boundaries, Storefront lint, detection-engine purity) exit 0. After the last two small commits (reminder wording for wallet top-ups; documentation) a full `pnpm typecheck` was run again and exits 0.
- Full vitest run against an isolated local PostgreSQL (port 5433), in eight shards (`--shard=i/8 --maxWorkers=1`) because unsharded runs were stopped by the system under memory pressure on this machine. **666 test files ran with 0 worker crashes.** Shards 2, 3, 4, 5, 7 and 8 exit 0. Shards 1 and 6 exit 1 with three tests that each hit the 20 s test timeout under load, none of which touches code changed by this branch, and each passes when run alone: `SalesAnalyticsCard.test.tsx` "refetches with new params when a filter button is clicked" (10/10), `ReportsPage.test.tsx` "shows error on fetch failure" (3/3) and `packages/db/src/crud/order_creation.test.ts` "a large-but-under-cap multi-line cart completes with one batched insert" (7/7). This is therefore not a fully clean exit. The last two commits changed only the reminder template and payload, `enqueuePaymentReminderDm` and documentation; their targeted tests (templates 77, dispatcher 100, payment_reminder 33, notifications 102, order-bot jobs 149) and the full typecheck pass, but the eight shards were run on the commit before them.
- Opus whole-change review: no Critical findings. Three Critical/Important findings raised during per-task reviews were fixed before this gate: a queued double-tap could pay at an unseen price after a quote mismatch (fixed by the per-render nonce), crash-stuck payment claims were unrecoverable inside a 10-minute window (stale-claim threshold lowered to 120 s), and the reminder reached buyers whose payment a provider had already seen (shared predicate `awaitingPaymentNothingObserved`).
- Open owner decisions, not built: auto-cancel still cancels `PENDING_PAYMENT` orders whose NOWPayments payment is `PAYMENT_DETECTED` or `VERIFYING`; a `matched` ledger row on a `CANCELLED` product order has no admin alert or credit path; the wallet rail double-tap lands on a fresh pay screen; the review is too large at about 40 units or more and Change details re-asks every unit; the 128-character cap does not apply to the per-field loop used for select or optional fields.
- Not covered by an automated run: whether TokoPay, PayDisini and NOWPayments invoices expire with our window (our create calls send no expiry, so a QR can be paid after the 10-minute auto-cancel and raise more stale-payment alerts), live Telegram behaviour, gateway latency against the reconcile budget, and host clock synchronisation (claim age uses JavaScript time on two hosts).
- Deploy: every environment that sets `PAYMENT_WINDOW_MINUTES`, `INTERNAL_PAYMENT_WINDOW_MINUTES`, `BYBIT_PAYMENT_WINDOW_MINUTES`, `BYBIT_BSC_PAYMENT_WINDOW_MINUTES` or `NOWPAYMENTS_PAYMENT_WINDOW_MINUTES` must edit or remove those lines, because an explicit value overrides the new default (the local `.env` still sets the old values). Orders already in flight keep their old `expiresAt`. Payment messages shown before the deploy need one extra tap. The reminder and the expiry push start immediately for Telegram-linked buyers. `PAYMENT_REMINDER_LEAD_MINUTES` is optional (default 5, 0 disables).


## Game Top-up catalog refactor, Phase 5 - 26 Oktober 2026

- Phase 5 menambah bukti dan alat, bukan perilaku produk: pembangun fixture bersama (`tests/helpers/gameTopupFixtures.ts`), skrip seed manual yang dijaga ketat (`scripts/seed-game-topup-fixtures.ts`, hanya DB lokal `bot_order_gtr`, `--confirm-worktree-db`, `--remove` hanya menghapus id yang tercatat di manifest tak terlihat), tes E2E yang menjalankan `buildBot()` asli dengan transport Telegram palsu (`apps/order-bot/test/game-topup-e2e.test.ts`, 9 skenario), dan runbook migrasi, rollback, changelog serta checklist smoke. Tidak ada perubahan kode di `apps/*/src` atau `packages/*/src`, tidak ada perubahan skema, `package.json`, atau dependensi.
- Review Opus Phase 5: tanpa temuan Critical. Lima temuan Important diperbaiki sebelum gate (parameter `host`/`hostaddr` pada URL seed ditolak, perintah rollback Docker yang benar, transport palsu menolak edit teks pada foto dan edit pada pesan yang hilang, tes penghapusan seed yang dirujuk order, tabel hasil).
- Gate pada `c673ee48`: `pnpm -r build`, `pnpm typecheck`, `pnpm run pretest` exit 0; `pnpm doctor:full` 643 file, 0 error, 0 warning; `pnpm lint` 643 file tanpa temuan; Vitest 8 shard satu worker: **669 file dan 12.705 tes lulus, semua shard exit 0, tanpa timeout beban maupun crash worker**. Run typecheck pertama mati kehabisan memori (exit 3221225794) dan diulang sendirian hingga lulus.
- Butir sebelumnya yang masih terbuka tidak berubah (lihat bagian Phase 3 dan 4): keputusan pemilik soal order NOWPayments yang terdeteksi, baris `matched` pada order batal, dan sisanya. Dua temuan lama di master dicatat sebagai follow-up kecil: payload outbox `order.received` mencatat `payment_method` BINANCE_PAY untuk order TokoPay (tidak tampil di email), dan pesan pengiriman memakai label tetap "Game ID" sedangkan layar review memakai label field dari admin.


## Game Top-up refactor, follow-up fixes after Phase 5 - 26 Oktober 2026

- Item terbuka yang ditutup setelah Phase 5 (semua dengan tes yang gagal dulu, mutasi pada tes uang, dan review Opus): batas 20 unit untuk Game Top-up yang butuh data akun dan batas 128 karakter di loop per-field; `payment_method` dihapus dari fakta `order.received`; label pesan pengiriman memakai label field dari admin; penjaga input-berubah pada semua rail bayar (data dibersihkan dan diminta ulang, termasuk rail USDT); ketukan ganda dompet dijawab "sudah dibayar" tanpa membuka input lagi; alert admin saat klaim `matched` berada di order produk yang dibatalkan; order NOWPayments yang pembayarannya terdeteksi atau diverifikasi ditahan 30 menit sejak `expiresAt` sebelum auto-cancel, lalu dibatalkan dengan satu alert admin.
- Sengaja dibiarkan: ketukan lama setelah ketidakcocokan harga tidak menampilkan baris "harga berubah" (aman uang, kosmetik); tampilan pesanan pembeli menunjukkan hitung mundur 0:00 selama masa tenggang dan pembatalan oleh pembeli tetap boleh (sudah ada sebelumnya); jalur kredit untuk klaim `matched` pada order batal tetap keputusan pemilik; format kawat gateway dan perilaku Telegram sungguhan belum terbukti.
- Gate pada `7203ecfc`: `pnpm -r build`, `pnpm typecheck`, `pnpm run pretest` exit 0; Vitest 8 shard satu worker: **671 file dan 12.769 tes lulus, semua shard exit 0**; `pnpm doctor:full` 643 file, 0 error, 0 warning; `pnpm lint` 643 file tanpa temuan. Tanpa perubahan skema, `package.json` atau dependensi.


## Game Top-up refactor, Back navigation, inline-only selection and master sync - 27 Oktober 2026

- Perubahan setelah laporan sebelumnya: seed katalog besar (satu kategori per game, nama realistis, daftar id tak kasat mata sebagai pengganti tag); tombol Back di semua section menu (kecuali `/start`, layar pembayaran/QR, struk akhir, prompt percakapan dan onboarding) dengan target dihitung dari jalur nyata, Back ketikan mengedit bubble yang ada dan menghapus ketikan pembeli; Game Top-up dan layanan baru memilih lewat tombol inline saja (tanpa pesan pendamping dan keyboard angka) lewat pengaturan `listSelection` di registri layanan, Premium Apps tetap bernomor; sinkron dengan `master` (tiered pricing) dengan kunci harga kita sebagai satu-satunya pengikat dan enam tes `master` disesuaikan pada protokol kuncinya tanpa melemahkan asersi harga bertingkat.
- Gate pada `55f5c5ed` (jalur hemat memori: build dan typecheck per paket berurutan, satu worker Vitest): build, typecheck semua paket, `tsc -p tsconfig.test.json`, `pnpm run pretest` exit 0; Vitest 8 shard: **686 file dan 13.107 tes lulus, semua shard exit 0**; `pnpm doctor:full` 653 file, 0 error, 0 warning; `pnpm lint` 653 file tanpa temuan kategori Bugs.
- Migrasi dari `master` (`20261013090000_tiered_pricing`, `20261013090100_tiered_pricing_backfill`) ada di branch tetapi belum diterapkan ke `bot_order_gtr`. Sisi admin dan storefront untuk layanan baru (opsi grup di `CategoryDialog`, validasi API katalog, template storefront) masih tertulis untuk dua grup: lihat panduan "How to add a new service". Perilaku pada Telegram sungguhan belum diuji di `@testtoko_bot` setelah perubahan terakhir.

## Product description read-more toggle - 19 Oktober 2026

- Worktree `product-description-readmore`, branch `worktree-product-description-readmore`, based on `master` at `b7a955f5`. Adds a shared `ProductDescription` component (3-line clamp below `md`, a "Read more" / "Show less" toggle only when the text is truncated) used by the Premium Apps product page and the Game Top Up page, plus the `web.read_more` / `web.read_less` locale keys.
- Final source `pnpm doctor:full`: **641 files, 0 errors and 0 warnings across both clients and all categories** (full scan covers the Bugs category; a separate `pnpm doctor:bugs` run was skipped for memory reasons). `pnpm typecheck` and `pnpm run pretest` exit 0 against an isolated local PostgreSQL on port 5571.
- Full `vitest` was **not proven green** before merge, on the owner's call: the first full run (`--maxWorkers=2`) ended with exit 4 and no summary after one admin test (`SalesAnalyticsCard`) timed out under load (it passes 10/10 alone); a rerun with a JSON reporter was still in progress at merge time. Focused tests for the touched files, `locales.test.ts`, and the storefront client typecheck pass.


## Game Top-up refactor, game level for single-category catalogs - 29 Oktober 2026

- Perubahan: tingkat "game" di browse Game Top-up (kategori -> daftar game -> edisi -> region per game -> pack picker teks -> detail), identitas game/edisi/region diturunkan saat dibaca dari data lama tanpa menulis ke DB (`packages/core/src/gameIdentity.ts`, whitelist `regionLabel.ts`: BR = Brazil, PH = Philippines, MY = Malaysia, nama panjang tetap dikenali), bubble katalog usang dihapus hanya bila semua tombolnya milik layar katalog (struk, pembayaran, QR, wallet tidak pernah dihapus), tombol penunjuk halaman, laporan "region tidak dikenali" di sinkron Digiflazz dan dry-run backfill. Premium Apps tidak berubah. Tanpa perubahan skema, `package.json`, atau dependensi.
- Simulasi produksi buatan: `tests/helpers/legacyProductionCatalog.ts` + `apps/order-bot/test/legacy-production-catalog.test.ts` (8/8) mereproduksi bentuk katalog dari screenshot produksi; `game-level-browse.test.ts` pinning jumlah bubble hidup untuk siklus berulang, ketukan lama, ketukan ganda dan Back setelah bubble hilang.
- Gate pada `91f83b54` (jalur hemat memori; shard 7 dijalankan ulang karena worker mati kehabisan memori, bukan kegagalan tes): build, typecheck semua paket, `tsc -p tsconfig.test.json`, `pnpm run pretest` exit 0; Vitest 8 shard satu worker: **691 file dan 13.252 tes lulus, semua shard exit 0**; `pnpm doctor:full` 655 file, 0 error, 0 warning; `pnpm lint` 655 file tanpa temuan kategori Bugs.
- Belum terbukti: perilaku Telegram sungguhan (waktu hapus pesan, batas 48 jam, ketukan paralel nyata), format kawat gateway, dan daftar region selain BR/PH/MY (SG, TH, VN, TR, RU, Global, SEA masih draf). Keputusan pemilik: "Delta Force Garena" tetap game tersendiri.
