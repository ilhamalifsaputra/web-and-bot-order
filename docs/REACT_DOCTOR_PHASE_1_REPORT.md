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
