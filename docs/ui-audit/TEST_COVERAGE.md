# Test coverage

What ran on this branch, and what did not. Counts come from the per-task
reports; each task ran its touched files with `--maxWorkers=2`.

## Gates

| Gate | Result |
|---|---|
| Package typechecks (`@app/web-admin`, `@app/web-admin-client`, `@app/storefront`, `@app/storefront-client`) and `tsc -p tsconfig.test.json` | Clean after every task, last on 2026-11-02 |
| `pnpm lint` | Clean, last on 2026-11-02 |
| `pnpm doctor:full` | 0 errors, 0 warnings on both clients, last on 2026-11-02 (704 files) |
| `pnpm doctor:bugs` | Clean |
| Both client suites, run once | 272 files / 2892 tests passed (after the loading work, `45b3f03e`) |
| Full `pnpm typecheck && pnpm test` | **Not run** (TEST-01). Pending the final gate (Task 11) |
| Real browser / E2E / responsive / contrast | **Not run** |

## Tests added by area

| Area | Files | Commits |
|---|---|---|
| Ticket uploads | `apps/web-admin/test/support-media-api.test.ts` (21 new), both `lib/supportUploads.test.tsx`, `SupportUploadPicker.test.tsx` (both apps), `TicketDetailReply.test.tsx`, `TicketComposer.test.tsx` | f0a7c8fb, 5162acb7, d158b647 |
| Wallet adjustment | `users-wallet-idempotency.test.ts` (15), `UserDetailPage.test.tsx`, `client.test.ts` | dea4baf1, 25d91357 |
| Cancel truth | `wallet-topup-api.test.ts`, `topup-order-api.test.ts`, `PayPage.test.tsx` | 3f4bfb48 |
| Readonly boundary | `users-vouchers-support-audit-api.test.ts` (sentinel tests on 5 routes, both product families) | 9975500c, 0cd0e22b |
| Bulk / Deliver / broadcast | `bulkOutcome.test.ts`, `broadcast.test.ts`, Orders/Payments/Vouchers/Broadcast page tests, `web.test.ts` | 5a399d94, e1ff9c49 |
| Admin session and failures | `api/sessionExpiry.test.tsx` (21), first-load and refresh tests on 9 list pages, Ticket/Order detail | f848a5ef, b65c8a1b, dcd14aff, a8e3bc2a |
| Storefront checkout | `CheckoutPage.test.tsx` (71 → 89), `idempotency.test.ts`, `client.test.ts`, `CartPage.test.tsx`, `spa-api.test.ts`, `security-hardening.test.ts` | b8bb1776, 2d5ae303, b42abd66 |
| Storefront failures | `firstLoadFailure.test` (10 routes), OrderDetail/TicketDetail, `recoveryScope.test`, `ErrorBoundary.test`, `chunkReload.test`, `randomId.test` | 9539336f, 8a12842c |
| Loading primitives | `loading-primitives.test.tsx`, Button pending tests (both apps), page skeleton tests | 58de858b … 45b3f03e |
| Visual states | `components/shared/stateVisuals.test.tsx` (admin, 5), `components/shop/stateVisuals.test.tsx` (storefront, 4), picker tests (+5, +3) | 5162acb7, d158b647 |

## Last runs for the visual commits (2026-11-02)

- Admin: `apps/web-admin/client/src/components` plus sessionExpiry,
  TicketDetail, TicketDetailReply, Orders and Payments page tests: 61 files /
  544 tests passed. Red run first: 9 of the 10 new tests failed.
- Storefront: `apps/storefront/client/src/components`: 82 files / 606 tests
  passed. Red run first: all 7 new behaviour tests failed.

## Known gaps

- Customer upload server tests cover malformed intents and foreign access only,
  not the image/video happy path (see the ticket investigation matrix).
- `tests/helpers/sampleData.ts` `resetDb` does not clear `support_attachments`
  or `processed_binance_tx`; the new tests clean up themselves.
- No offline, timeout, race or cancellation tests (no such behaviour exists yet).
- Known flake under load: run a failing file alone before calling it a regression.
