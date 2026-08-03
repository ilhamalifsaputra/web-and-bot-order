# Backend Audit Fixes — High + Medium (2026-07-31)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task.

**Goal:** Fix the 9 High and 37 Medium findings from `docs/audit-backend-2026-07-31.md`
without regressing the baseline (typecheck clean, `pnpm test` green — 250 files / 3,106
tests at the time of the audit). Low findings (26) are explicitly out of scope for this
plan.

**Source of truth for every finding:** `docs/audit-backend-2026-07-31.md`. Each task below
gives the finding ID, files, root cause and fix direction already verified against the
source during the audit — the audit doc has the full failure-scenario narrative if an
implementer wants more context, but the task text below is self-sufficient to implement.

**Tech stack:** TypeScript, Fastify (`apps/web-admin`, `apps/storefront`), grammY
(`apps/order-bot`), Prisma + SQLite (`packages/db`), Decimal.js via `@app/core/money`,
Vitest.

## Global Constraints

- **Decimal for all money**, never float/`Number()`/`parseFloat` for storage or comparison.
- **No raw SQL in routes/handlers** — DB access goes through `packages/db/src/crud/*`.
- **Never send Telegram from the web** — enqueue to `notification_outbox`.
- **Never log secrets** (credentials, `file_id`, password hashes, DB URLs, tokens).
- **Audit every admin state change** with `logAdminAction`, `details` as a natural-language
  sentence (never `key=value`), per `docs/LOGGING.md`.
- **Shared SQLite is single-writer** — every `$transaction` must be short; never await
  network I/O (HTTP fetch, Telegram call) while holding one open.
- **UTC in DB, `TIMEZONE` only on display.**
- **Bot UX invariants:** edit the bubble via `smartEdit`/`adminEdit` + `menuAnchor`, one
  active keyboard per chat (`retireKeyboard`), unknown/stale callback data answers
  `error.stale_screen`, wizards are single-bubble, all customer/admin strings go through
  `t(ctx, key, args)` with matching keys in both `packages/core/locales/{en,id}.json`.
- **`pnpm typecheck` and `pnpm test` must stay green after every task.** Add or update
  tests for every behavior change — this is a repo rule, not optional polish.
- If a change touches `apps/web-admin/client` or `apps/storefront/client` (it should not,
  for this plan — server-side only), run the relevant `pnpm --filter ... build` first.
- Tasks are grouped into 6 batches matching the audit report's own sections, in the
  order the report's "Suggested remediation order" recommends. Do not reorder batches.
  Within a batch, later tasks may touch a file an earlier task in the same batch already
  touched — that's expected and fine; read the current file state, don't assume the
  audit's line numbers still match after earlier tasks in the batch land.

---

## Batch 1 — Money, pricing, reconciliation

### Task 1: H-1 — Fix TokoPay's QRIS fee base so discounted orders aren't rejected as short-paid

**Files:**
- Modify: `packages/core/src/payments/tokopay.ts` (`computeQrisAdminFee`, `qrisChargeAmount`, ~lines 47-58)
- Modify call sites: `apps/storefront/src/routes/checkout.ts` (~175, 543-544, 759, 775),
  `apps/order-bot/src/handlers/checkout.ts` (~1048, 1054),
  `apps/order-bot/src/payments/tokopayReconcile.ts` (~100),
  `packages/db/src/crud/tokopay.ts` (~141)
- Test: `packages/core/src/payments/tokopay.test.ts`, `packages/db/src/crud/tokopay.test.ts`,
  `apps/storefront/test/tokopay-webhook.test.ts`, `apps/order-bot/test/tokopay-reconcile.test.ts`

**Problem:** `qrisChargeAmount(totalAmount, subtotalAmount)` computes the buyer's expected
charge as `totalAmount + 100 + 0.7% × subtotalAmount`. But the code that actually creates
the TokoPay transaction (`createTransaction`) sends `nominal: order.totalAmount` (net of
bulk discount / voucher / wallet credit) — TokoPay then adds its own fee on top of that
`nominal`. So on any order carrying a discount, the fee TokoPay actually charges
(`0.7% × totalAmount`) is smaller than the fee our verification expects
(`0.7% × subtotalAmount`, the pre-discount gross). The webhook and the reconcile poller
both compute `expectedCharge` this same wrong way and reject the payment as short-paid —
the buyer paid the correct amount, the order sits `PENDING_PAYMENT` forever, and
`autoCancelExpiredOrders` eventually cancels it. Money in, nothing delivered, no alert.

**Fix:** Change the fee base to be the amount TokoPay actually received a fee on —
`totalAmount`, not `subtotalAmount`. Concretely: change `computeQrisAdminFee` to take a
single `amountIdr` (the nominal actually sent), and change `qrisChargeAmount` to
`totalAmount + computeQrisAdminFee(totalAmount)` — dropping the `subtotalAmount` parameter
entirely. Update every call site listed above to match the new signature (they all already
have `order.totalAmount` in scope). Also fix `checkout.ts`'s two display sites
(`qris_grand_total` at ~175 and ~543-544) so the price the customer previews matches the QR
they're actually shown.

**Testing:** Update the existing `qrisChargeAmount`/`computeQrisAdminFee` unit tests in
`tokopay.test.ts` for the new signature. Add a new test case (in `crud/tokopay.test.ts` or
`apps/storefront/test/tokopay-webhook.test.ts`, whichever exercises
`deliverPaidTokopayOrder`/the webhook end-to-end) that creates an order with a voucher or
bulk discount applied, computes the fee-inclusive charge the system expects, and asserts it
equals exactly what a gateway billing `0.7% × totalAmount` would charge — i.e. the
short-payment check must NOT fire for a buyer who paid exactly `totalAmount + fee(totalAmount)`.

---

### Task 2: M-1 — Prorate order-level discounts across line items so dashboard profit/margin reflect what the shop actually banked

**Files:**
- Modify: `packages/db/src/crud/revenue.ts` (`orderItemRevenueIdr`, ~lines 31-33, used by
  `profitSummarySince` ~269-306 and `topProductsByMargin` ~202-243)
- Test: `packages/db/src/crud/revenue.test.ts` (or wherever `orderItemRevenueIdr`/
  `profitSummarySince`/`topProductsByMargin` are currently tested)

**Problem:** `orderItemRevenueIdr` computes `unitPrice × quantity` per line with no
reduction for the order's `bulkDiscountAmount`, `discountAmount` (voucher), or
`walletUsed` — those live only on the `Order` row, never applied to lines. So an order
with a 30% voucher that actually loses money shows a healthy positive profit/margin on the
admin dashboard.

**Fix:** When computing revenue for an order's line items, prorate
`bulkDiscountAmount + discountAmount` across the order's lines by each line's share of
`subtotalAmount` (i.e. `lineDiscount = totalDiscount × (lineSubtotal / orderSubtotal)`),
and subtract that from the line's gross revenue before it feeds `profitSummarySince`/
`topProductsByMargin`. Use `Decimal` throughout — never float division for this
proration. Do not touch `revenueSummary` (the net-`totalAmount`-based figure) — it's
already correct; this fix is only for the per-line/per-product profit path.

**Testing:** Add a test: an order with a voucher discount whose cost basis would make it
loss-making after the discount — assert `profitSummarySince`/`topProductsByMargin` now
reports a profit consistent with the discounted revenue, not the gross.

---

### Task 3: M-2 — Delete the VoucherRedemption row when an order holding it is released

**Files:**
- Modify: `packages/db/src/crud/orders.ts` (`releaseOrderHolds`, ~lines 971-979)
- Test: `packages/db/src/crud/orders.test.ts` or `packages/db/src/crud/vouchers.test.ts`
  (wherever voucher redemption + cancel/expire flows are tested)

**Problem:** Order creation writes a `VoucherRedemption(voucherId, userId)` row alongside
incrementing the voucher's `usedCount` (`orders.ts` ~535, ~695). `releaseOrderHolds` (called
from cancel/reject/expire) decrements `usedCount` back but never deletes the
`VoucherRedemption` row. Since `assertVoucherNotRedeemedByUser` checks for the existence of
that row (not `usedCount`), a buyer whose order is cancelled/expired is permanently locked
out of ever using that one-per-user voucher again, with no admin UI to clear it.

**Fix:** Inside `releaseOrderHolds`, in the same `if (order.voucherId)` block that
decrements `usedCount`, also delete the matching `VoucherRedemption` row
(`where: { voucherId: order.voucherId, userId: order.userId }` — confirm the exact unique
key shape from the schema/existing `voucherRedemption.create` calls). This only runs on
cancel/reject/expire, never on a delivered order, so a genuinely-used voucher is untouched.

**Note on `getVoucherStats.totalRedemptions`:** this count reads from the same
`voucherRedemption` table (`crud/vouchers.ts` ~458). After this fix it will naturally
reflect only currently-held redemptions (cancelled orders no longer count), which is more
correct — no separate change needed to that function, but if the reviewer or existing tests
assumed `totalRedemptions` is an all-time, never-decreasing counter, flag that as a
behavior change in your report so it can be checked against any test/UI copy that assumes
"all-time".

**Testing:** Add a test: redeem a voucher, cancel/expire the order, then assert the same
user CAN redeem the voucher again (previously threw `error.voucher_already_redeemed`).

---

### Task 4: M-3 — Reject non-finite (`NaN`, `Infinity`) values in voucher/wallet amount guards

**Files:**
- Modify: `apps/web-admin/src/routes/api/vouchers.ts` (~86, 213, 233)
- Modify: `packages/db/src/crud/vouchers.ts` (~47-61, 144-154, 299)
- Modify: `apps/web-admin/src/routes/api/users.ts` (~288-296)
- Modify: `apps/order-bot/src/handlers/admin.ts` (~225)
- Test: corresponding test files for each of the above (vouchers, wallet adjustment)

**Problem:** `new Decimal("NaN")` constructs successfully, and every inequality guard used
in these files (`.lte(0)`, `.gt(100)`, `.isNegative()`, `.isZero()`, `.lessThan(0)`) returns
`false` for NaN — so a NaN value sails through every bound check. `""` throws (caught) and
`Infinity` is caught for PERCENT vouchers, but nothing catches NaN. A voucher created with
`value: "NaN"` or a wallet adjustment with `delta: "NaN"` persists a NaN amount that
poisons downstream totals — and `reconcileFinances`'s own drift check
(`expected.minus(total).abs().greaterThan("0.0001")`) is ALSO `false` for NaN, so the
reconciliation safety net won't catch it either (that check is out of scope for this task —
just noting why this guard matters).

**Fix:** In each of the four locations, add an explicit `.isFinite()` check alongside the
existing bound checks (reject if not finite), mirroring the existing pattern in
`activeFlashPercent` (`packages/core/src/flash.ts` ~54) and `activeBulkPercent`
(`packages/core/src/bulk.ts` ~55) — read those two functions first to match the exact
style/error used.

**Testing:** Add a test per guard location: submitting `"NaN"` (and, where not already
covered, `"Infinity"`) as the amount/value must be rejected with the same validation error
class as an out-of-range or negative value — not silently accepted.

---

### Task 5: M-4 — Show both wallet currencies in the bot's admin user card, and add a currency argument to `/wallet`

**Files:**
- Modify: `apps/order-bot/src/handlers/admin.ts` (user card render ~line 52 and ~172,
  `/wallet` command handler ~lines 215-255)
- Test: `apps/order-bot/test/handlers.test.ts` (wherever the admin user-card and `/wallet`
  command are currently tested)

**Problem:** The admin bot's user card renders only `walletBalance` (IDR) via a helper
confusingly named `price` (which is actually `formatUsdtAmount`), with no currency label,
and never shows `walletBalanceUsdt`. `/wallet <uid> <amount>` has no currency argument and
always adjusts the IDR balance via `adjustWallet`'s default. Referral commissions are
always credited in USDT, so an admin resolving "where's my referral credit?" for a
USDT-only customer sees `Wallet: 0`, then runs `/wallet <uid> <amount>` believing they're
crediting the missing USDT — but it silently credits IDR instead, creating a second wrong
balance.

**Fix:** Render both `walletBalance` and `walletBalanceUsdt` on the user card, each with an
explicit `Rp`/`USDT` label (web-admin's `UserDetailPage.tsx` already does this via
`CurrencyStack` — match that mental model, doesn't need to match its UI). Extend the
`/wallet` command to accept an optional trailing currency argument,
e.g. `/wallet <uid> <amount> [IDR|USDT]`, defaulting to `IDR` when omitted (preserves
existing command usage), and pass it through to `adjustWallet`'s `currency` option. Make
sure the `logAdminAction` audit `details` sentence for this action states which currency
was adjusted.

**Testing:** Add a test asserting the card shows both balances distinctly, and a test that
`/wallet <uid> <amount> USDT` credits `walletBalanceUsdt` while leaving `walletBalance`
untouched (and vice versa for the default/`IDR` case).

---

## Batch 2 — Auth, CSRF, route security

### Task 6: H-4 — Stop serializing password hashes and emails into admin API responses

**Files:**
- Modify: `packages/db/src/crud/users.ts` (`getUser` ~28, `listUsers` ~415 — add an
  explicit `select`/projection)
- Modify: `packages/db/src/crud/orders.ts` (`fullInclude` ~224-228, `listOrders` ~1596 —
  the `user: true` include needs a projection instead)
- Modify callers: `apps/web-admin/src/routes/api/users.ts` (~129, ~228),
  `apps/web-admin/src/routes/api/orders.ts` (~135, ~197),
  `apps/web-admin/src/routes/api/payments.ts` (~61-62)
- Test: `apps/web-admin/test/web.test.ts` (users, orders, payments route sections)

**Problem:** These routes spread whole Prisma `User` rows into JSON responses (`...u`,
`...user`, `...o` where the order include is `user: true`), with no `select` at the crud
layer. `User.passwordHash` and `User.email` therefore ship to the browser on every one of
these endpoints. All five routes are guarded only by `currentAdmin` — no role gate — so the
lowest-privilege `readonly` admin role can read them.

**Fix:** Add an explicit `select` (or a shaping helper) at the crud layer so these queries
never return `passwordHash`, and confirm `email` should also be excluded from the
lowest-trust surfaces (check what the web-admin React pages actually render for user
identity — likely `loginUsername`/`fullName`/`telegramId` suffice; if `email` is genuinely
needed somewhere, keep it only on that specific call, not by default). Mirror the existing
pattern `TICKET_USER_SELECT` in `packages/db/src/crud/support.ts` (~470) — read that first
to match the established style. Apply the new projection to both `getUser`/`listUsers` and
the `user: true` include on `fullInclude`/`listOrders`, then verify none of the three
route files above still destructure a field that's now missing (`passwordHash` shouldn't be
referenced anywhere in these routes — if it is, that call site needs to move to a
crud function that explicitly selects it, scoped only to where it's truly needed, e.g.
login verification).

**Testing:** Add a test per affected route (`GET /api/users`, `GET /api/users/:id`,
`GET /api/orders`, `GET /api/orders/:id`, and whatever `payments.ts` ~61-62 serializes)
asserting the JSON response never contains a `passwordHash` key at any depth.

---

### Task 7: H-5 — Lock `POST /setup/restart` after setup completes

**Files:**
- Modify: `apps/web-admin/src/routes/setup.ts` (~lines 201-214)
- Test: `apps/web-admin/test/web.test.ts` (~lines 5115-5137, the existing test asserting
  the unauthenticated 200 — this needs to change to assert the locked behavior)

**Problem:** Unlike its three siblings (`/setup/bot`, `/setup/owner`, `/setup/shop`, which
all call `await checkSetupLock(reply)` first and return early if setup is already locked),
`/setup/restart` has no lock check, no `currentAdmin`, and no `csrfProtect` — and stays
reachable forever because `plugins/setupGate.ts` excludes the whole `/setup` prefix from
the first-run gate. Anyone who can reach the admin host can loop `POST /setup/restart` to
reboot the single process hosting the bot, storefront and admin panel, and the response
discloses `bot_configured` pre-auth.

**Fix:** Add `if (await checkSetupLock(reply)) return;` at the top of the handler, matching
its three siblings exactly. Update the existing test at `web.test.ts:5115-5137` — it
currently asserts a 200 for an unauthenticated post-setup call; change it to assert
whatever `checkSetupLock` returns in that case (check the sibling routes' tests for the
expected status, likely 303 or 403) instead.

**Testing:** The updated test above, plus confirm (via test) that `/setup/restart` still
works normally *during* the setup wizard, before `checkSetupLock` would trip.

> **Superseded during execution.** The task reviewer found that this literal fix breaks the
> route's only real caller: `SetupDonePage.tsx`'s "Restart server" button fires
> `POST /setup/restart` from the Done screen, which is only reachable *after*
> `/setup/shop`'s finish handler already calls `markSetupComplete` (`setup.ts:168`) and
> auto-logs the owner in with a real session cookie (`setup.ts:169-180`) — so by the time
> the legitimate caller ever fires, `checkSetupLock` is unconditionally true and the fix as
> literally specified permanently disables the button. Corrected fix (applied instead):
> gate the route with `currentAdmin` (require a valid admin session) rather than
> `checkSetupLock` — since a session always exists by the time this route is legitimately
> called, this closes the unauthenticated-forever-open hole without breaking the wizard's
> own flow. Left un-CSRF'd for now (the existing client call doesn't attach a token) —
> recommended follow-up: either add `csrfProtect` here and update `SetupDonePage.tsx` to
> attach the token, or retire this route entirely in favor of the already-existing
> `POST /api/settings/restart` (`api/settings.ts:448-467`), which is `currentAdmin` +
> `csrfProtect` gated and does the identical restart-trigger-file write.

---

### Task 8: M-16 — Rotate the admin session jti on password change

**Files:**
- Modify: `apps/web-admin/src/routes/api/settings.ts` (password-change handler ~497-508)
- Test: `apps/web-admin/test/web.test.ts` (settings/password section)

**Problem:** Every other admin credential-invalidation path rotates the session jti
(`/reset` at `routes/auth.ts:246`, `/login` at `:166`,
`/api/admins/:tgId/logout` at `api/admins.ts:95`) so old sessions stop authenticating — but
changing your own password via `/api/settings/password` does not. A stolen session cookie
keeps working for the rest of `WEB_SESSION_TTL_HOURS` even after the victim "secures" their
account by changing the password.

**Fix:** After successfully writing the new password hash and auditing the change, mint a
new jti (`newJti()`) and store it under the admin's `sessionJtiKey`, then re-issue the
session cookie for *this* request via the same helper the storefront uses
(`apps/storefront/src/routes/apiAccount.ts:501-513` — read this first, it's the exact
pattern to mirror) so the admin stays logged in on the device that just changed the
password, while every other device's cookie is invalidated.

**Testing:** A test that changes the password, then asserts a session cookie minted before
the change no longer authenticates, while the response to the change request itself (with
its re-issued cookie) still does.

---

### Task 9: M-17 — Rate-limit storefront registration and password-reset submission

**Files:**
- Modify: `apps/storefront/src/routes/apiAuth.ts` (`/auth/register` ~114,
  `/auth/reset/:token` ~191-208)
- Test: `apps/storefront/test/` (wherever auth rate limiting is currently tested)

**Problem:** `/auth/login` and `/auth/forgot` are both rate-limited
(`loginRateLimited`/`forgotEmailRateLimited`), but `/auth/register` and
`/auth/reset/:token` have no rate limiting at all. Registration is the most expensive
unauthenticated endpoint in the app (cost-12 bcrypt + a DB write) on a single-process
server backed by single-writer SQLite — a burst of concurrent POSTs can stall checkout and
the bot.

**Fix:** Apply `loginRateLimited(clientIp(req))` at the top of both handlers — the helper
and its config already exist in `apps/storefront/src/rateLimit.ts`, read it first to use it
correctly (same call shape as the existing `/auth/login` usage).

**Testing:** A test asserting a burst of requests to `/auth/register` (and separately
`/auth/reset/:token`) past the configured threshold gets a 429, matching how `/auth/login`'s
rate limit is already tested.

---

### Task 10: M-18 — Validate ticket attachments before writing them to disk

**Files:**
- Modify: `apps/storefront/src/lib/ticketAttachments.ts` (`parseTicketMultipart`,
  `saveAttachment`/`writeAttachment`, ~lines 57-119)
- Modify: `apps/storefront/src/routes/apiAccount.ts` (ticket-creation handler ~270-304)
- Test: `apps/storefront/test/` (ticket attachment upload tests)

**Problem:** `parseTicketMultipart` writes each attachment part to disk as it streams,
*before* the handler checks order ownership and *before* the `if (message)` guard that
decides whether a ticket row is even created. A customer can POST an empty message with
several large attachment parts in a loop: each request returns success with no ticket
created, leaving orphaned files on disk with no owning ticket row for
`storageCleanupJob` to ever reclaim — enough of this fills the disk and takes down SQLite's
WAL writes.

**Fix:** Restructure so validation (order ownership, the `message`/attachment-required
guard) happens before any file is written — either buffer the multipart parts in memory
first and only call `writeAttachment` after validation passes, or write to a temp
location and delete-on-early-return for every failure path. Also add a simple per-user
attachment count/size limit for ticket creation if one doesn't already exist elsewhere in
this flow.

**Testing:** A test that POSTs an empty message with attachments and asserts no file is
left on disk after the request completes (previously the guard failed but the file was
still written).

---

### Task 11: M-19 — Strip the query string before logging the request URL in both error handlers

**Files:**
- Modify: `apps/storefront/src/server.ts` (`setErrorHandler`, ~line 148)
- Modify: `apps/web-admin/src/server.ts` (`setErrorHandler`, ~line 109)
- Test: whichever test file covers each app's error-handler logging (add if none exists)

**Problem:** Both apps' access-log `onResponse` hooks correctly log only
`req.url.split("?", 1)[0]` (the comment there explains the query "may carry tokens"), but
each `setErrorHandler` logs `redactPath(req.url)` — the full URL including the query
string — and `redactPath` only rewrites `/reset/<segment>` path segments, not query
parameters. The storefront's Telegram Login flow carries its HMAC-signed auth payload
entirely in the query string (`GET /auth/telegram?...&hash=...`), so any error thrown while
establishing that session writes a still-valid, replayable auth payload straight into the
error log.

**Fix:** In both `setErrorHandler`s, change the logged path to
`redactPath(req.url.split("?", 1)[0])` — matching exactly what the access-log hooks
already do.

**Testing:** A test that triggers an error on a route with query-string-carried secrets
(or a synthetic case if the Telegram login route is hard to trigger an error on in tests)
and asserts the logged message contains no query string.

---

### Task 12: M-20 — Add `Cache-Control: no-store` to the SPA shell responses

**Files:**
- Modify: `apps/storefront/src/routes/spaShell.ts` (~lines 582-624)
- Modify: `apps/web-admin/src/routes/spaShell.ts` (~lines 36-45)
- Test: `apps/storefront/test/` and `apps/web-admin/test/` (spaShell / index route tests)

**Problem:** Both SPA shells substitute the current session's live CSRF token into the
served `index.html` with no `Cache-Control` header at all — Fastify sets none by default,
so a caching reverse proxy in front of the storefront (explicitly expected per this repo's
deployment model) could serve one logged-in customer's CSRF token to a later visitor,
which combined with `SameSite=Lax` cookies is enough to forge state-changing requests.

**Fix:** Add `reply.header("Cache-Control", "no-store")` (or equivalent) to every
SPA-shell response in both apps, before the response body is sent.

**Testing:** A test asserting the `Cache-Control: no-store` header is present on the SPA
shell response in both apps.

---

## Batch 3 — Orders, checkout, stock, delivery

### Task 13: H-2 — Let paid `PROCESSING` orders be credited to balance instead of only rejected

**Files:**
- Modify: `packages/db/src/crud/orders.ts` (`computeOrderEligibility` ~1516-1526,
  `rejectOrder`/`cancelOrder` — add a guard near wherever they check the order's current
  status before transitioning)
- Test: `packages/db/src/crud/orders.test.ts` (order eligibility / reject / credit tests)

**Problem:** `canReject` was widened to include `PROCESSING` (a manual-fulfilment order the
buyer already paid for via gateway) by an earlier fix, but `canCredit` was not — it's still
only `PENDING_VERIFICATION || UNDERPAID`. So when an admin can't source the account for a
paid `PROCESSING` order, the only refund-shaped action the UI offers is Reject, which moves
the order to the terminal `REJECTED` state with `walletUsed` at 0 (nothing to release) —
and `creditOrderToBalance` then refuses to act on a terminal order forever. The buyer's
money becomes unrecoverable without direct DB edits.

**Fix:** Add `PROCESSING` to `canCredit` in `computeOrderEligibility` (alongside
`PENDING_VERIFICATION`/`UNDERPAID`). Also add a guard in `rejectOrder`/`cancelOrder`: refuse
to transition an order whose `paidAt` is set to a terminal state unless the caller has
already credited it to balance (or is explicitly crediting as part of the same operation) —
read how `paidAt` is currently used elsewhere in `orders.ts` to match the existing
convention for checking "was this order paid".

**Testing:** A test: create a `PROCESSING` order that's paid (`paidAt` set), assert
`canCredit` is now true for it, assert crediting it to balance succeeds, and assert
`rejectOrder`/`cancelOrder` on a paid order without crediting first is refused (or
automatically credits — pick whichever the guard you implement does, and test that exact
behavior).

---

### Task 14: H-3 — Let a failed gateway delivery be retried instead of permanently consuming its idempotency claim

**Files:**
- Modify: `packages/db/src/crud/tokopay.ts` (~lines 84-95, 164-168)
- Modify: `packages/db/src/crud/paydisini.ts` (~93, 163)
- Modify: `packages/db/src/crud/nowpayments.ts` (~95, 165)
- Modify: `packages/db/src/crud/binance_internal.ts` (~201, 226)
- Modify: `packages/db/src/crud/bybit_deposit.ts` (~168, 193)
- Test: the corresponding `*.test.ts` for each of the five files above

**Problem:** In all five gateway delivery functions, the idempotency claim row (e.g.
`processedTokopayTx`) is created *before* (outside) the delivery `$transaction`. If
anything inside that transaction throws (a `SQLITE_BUSY` collision, a timeout, a transient
notification-enqueue failure), the transaction rolls back the order but the `catch` block
only re-tags the claim row with `outcome: "delivery_failed"` and rethrows — the claim row
itself survives. Every subsequent retry (webhook redelivery or reconcile poller) hits the
same unique-constraint violation and is turned away as `already_processed`, silently,
forever — the order eventually auto-cancels while the buyer's payment sits with the
merchant, unrecoverable through the normal retry path.

**Fix:** In each of the five files, make the `already_processed`/unique-violation check
inspect the claim row's `outcome`: if it's `"delivery_failed"` (i.e. the previous attempt
never actually delivered), treat this as re-claimable rather than `already_processed` — e.g.
by deleting the stale claim row and re-creating it, or updating it in place and proceeding
to the delivery transaction again. Pick one consistent approach and apply it identically to
all five files (they share the same shape). Do not weaken the guard for a claim whose
`outcome` reflects an actual success or a genuine duplicate — only the failed-delivery case
should become retryable.

**Testing:** For each of the five gateways, add a test: simulate the delivery transaction
throwing (e.g. inject a stock-allocation failure or similar), assert the claim row is left
in a retryable state, then call the delivery function again with the same transaction id
and assert it now succeeds rather than returning `already_processed`.

---

### Task 15: M-5 — Guard denomination `deliveryType` edits against in-flight orders

**Files:**
- Modify: `apps/web-admin/src/routes/api/catalog.ts` (denomination update handler,
  ~lines 434-490)
- Modify (if snapshot approach chosen): `packages/db/src/crud/orders.ts`
  (`settlePaidOrder` ~1377-1379, order creation to snapshot `deliveryType`)
- Test: `apps/web-admin/test/web.test.ts` (catalog denomination update tests) and/or
  `packages/db/src/crud/orders.test.ts`

**Problem:** `settlePaidOrder` reads the *live* denomination row to decide whether an order
is auto- or manual-delivered, but `deliveryType` can be edited at any time with no guard
against in-flight orders. If an AUTO order reserves stock and the SKU is then flipped to
`manual` before payment, `settlePaidOrder` takes the manual branch and never touches the
reserved `StockItem` rows — they're permanently stuck `RESERVED`, excluded from available
stock forever, with no release path.

**Fix (pick one):** Either (a) reject a `deliveryType` edit on `PATCH`/`PUT` when the
denomination has any order in a non-terminal status, returning a clear validation error the
admin UI can surface, or (b) snapshot `deliveryType` onto `OrderItem` at order-creation time
(mirroring the existing `warrantyDaysSnapshot` pattern — read how that field is populated
first) and have `settlePaidOrder` read the snapshot instead of the live denomination row.
Prefer (b) if it's not significantly more invasive — it also fixes the reverse case (edit
manual→auto stranding a paid order) that (a) alone wouldn't need to worry about, since the
snapshot is immutable once taken.

**Testing:** A test: create an AUTO order (stock reserved), edit the denomination to
`manual`, pay the order, and assert the reserved stock is not silently lost (either the
edit was rejected earlier, or the snapshot preserved the original AUTO behavior).

---

### Task 16: M-6 — Wrap the bot's TokoPay/PayDisini/NOWPayments invoice caching in the existing atomic claim helpers

**Files:**
- Modify: `apps/order-bot/src/handlers/checkout.ts` (~lines 946, 1058, 1187)
- Test: `apps/order-bot/test/handlers.test.ts` (checkout gateway invoice tests)

**Problem:** The bot's three gateway checkout paths cache the created invoice with a bare
`prisma.order.update({ where: { id }, data: { paymentRef } })` — no atomic claim. The
storefront's equivalent (`payView`) already uses `claimGatewaySlot`/`commitGatewayResult`/
`releaseGatewaySlot` (`packages/db/src/crud/orders.ts` ~155-221) to prevent a race where a
buyer starting checkout on both the bot and the storefront ends up with two separate
invoices for the same order, with the reconcile poller watching only one.

**Fix:** Wrap all three of the bot's cache-write sites in the same
`claimGatewaySlot` → gateway API call → `commitGatewayResult`/`releaseGatewaySlot` sequence
that `apps/storefront/src/routes/checkout.ts` (~548-583) already uses — read that code
first and mirror it exactly rather than inventing a new pattern. This also moves the raw
`prisma.order.update` calls into the existing crud helper, addressing the "raw model access
in a handler" note from the audit.

**Testing:** A test mirroring however the storefront's claim/commit/release race is
currently tested (if it has one) — verify the bot's three gateway paths now behave the same
way under a concurrent claim attempt.

---

### Task 17: M-7 — Cap storefront cart size and batch stock allocation into one insert

**Files:**
- Modify: `apps/storefront/src/routes/checkout.ts` (`performCheckout`/`createOrderFromCart`,
  ~lines 416-464)
- Modify (if the cap lives there): `apps/storefront/src/routes/api.ts` (~line 153, existing
  per-line qty clamp)
- Test: `apps/storefront/test/checkout.test.ts` or similar

**Problem:** `createOrderFromCart` runs inside one `$transaction` with Prisma's default 5s
timeout, and does per-unit work — `allocateOneAvailableStock` plus an individual
`orderItem.create` — for every single unit in the cart, with no cap on total units across
all lines (only a 99-per-line clamp exists). A large multi-line cart can turn into
thousands of queries inside one write transaction, holding SQLite's single writer for
seconds and starving every other writer (the bot, webhooks, delivery transactions) before
likely timing out and rolling back — so the buyer can never complete that cart at all.

**Fix:** Add a server-side cap on total units across the whole cart (return a clear
validation error above the cap — pick a sane number, e.g. in the low hundreds, consistent
with what a real checkout would need). Additionally, batch the per-unit
`orderItem.create` calls into a single `createMany` after `allocateOneAvailableStock` has
determined which stock items to assign, rather than one `create` per unit — this reduces
the query count from O(units) to closer to O(lines).

**Testing:** A test asserting a cart exceeding the new cap is rejected with a clear error
before hitting the transaction, and a test confirming a large-but-under-cap cart still
completes correctly with the batched insert (same resulting `OrderItem` rows as before).

---

### Task 18: M-8 — Guard `markStockDead` against altering delivered credentials

**Files:**
- Modify: `packages/db/src/crud/stock.ts` (`markStockDead` ~lines 51-56, compare
  `bulkMarkStockDead` ~63-74)
- Modify caller if needed: wherever `POST /api/stock/item/:stockId/dead` handles the
  result (to surface "already sold" instead of a silent success)
- Test: `packages/db/src/crud/stock.test.ts`

**Problem:** `bulkMarkStockDead` deliberately restricts its update to
`status IN (AVAILABLE, RESERVED)` specifically so a delivered credential is never altered.
The single-item `markStockDead` has no such filter, so an admin who mis-taps a `SOLD` row in
a list view (which shows all statuses) can flip a delivered credential to `DEAD`, corrupting
stock-status reporting and destroying the one record a warranty dispute would be resolved
with.

**Fix:** Give `markStockDead` the identical guard `bulkMarkStockDead` already has — turn it
into an `updateMany` with the same `status: { in: [AVAILABLE, RESERVED] }` filter, returning
the affected count, and have the caller check that count is `1` (else surface an
"already sold"/"not eligible" error rather than a silent success).

**Testing:** A test: create a `SOLD` stock item, call `markStockDead` on it, assert it's
rejected/no-ops and the item's status is unchanged; a test that an `AVAILABLE`/`RESERVED`
item is still correctly marked dead.

---

## Batch 4 — Payment gateways and webhooks

### Task 19: M-9 — Add a live re-check before delivering on a PayDisini callback

**Files:**
- Modify: `packages/core/src/payments/paydisini.ts` (~lines 151-182)
- Modify: `apps/storefront/src/routes/checkout.ts` (PayDisini webhook handler, wherever it
  calls the delivery function — near the TokoPay equivalent at ~759-775)
- Test: `apps/storefront/test/` (paydisini webhook tests), `packages/core/src/payments/paydisini.test.ts`

**Problem:** PayDisini's signature material (`md5(apiKey:userKey:refId:amount)`) doesn't
cover the payment `status` — `cb.paid` comes straight from the unsigned `body.status`
field. TokoPay had the identical design flaw and was hardened with a live
server-to-server `checkTransaction` call before delivering; PayDisini — added later — never
got the same treatment, even though `checkTransaction` already exists in its client and its
own reconcile poller already uses it.

**Fix:** Mirror the TokoPay hardening exactly: after the signature check passes, call
`checkTransaction` (already implemented) and gate delivery on the live response's
`paid`/`amount`, not on the callback body's `status` field. Look at how
`apps/storefront/src/routes/checkout.ts` does this for TokoPay (~759-775) and replicate the
same shape for PayDisini.

**Testing:** A test: send a validly-signed PayDisini callback with `status` claiming
success but where `checkTransaction` (mocked) reports the payment as not actually paid —
assert delivery does NOT happen.

---

### Task 20: M-10 — Alert admins when a webhook delivery outcome is `"stale"`

**Files:**
- Modify: `apps/storefront/src/routes/checkout.ts` (three webhook handlers, ~lines 791,
  840, 898)
- Test: `apps/storefront/test/` (webhook tests for each of the three gateways)

**Problem:** All three storefront webhook handlers `reply.send({ status })` with no branch
for `r.status === "stale"` (returned when the order left `PENDING_PAYMENT` between the
webhook arriving and the delivery transaction running — routine, since
`autoCancelExpiredOrders` cancels orders on a timer). No warning is logged and no admin is
notified — the bot-side pollers already `alertAdmins` on this exact outcome; only the web
webhooks are silent.

**Fix:** In all three handlers, when `r.status === "stale"`, log a warning and enqueue an
admin notification — reuse whatever alert shape the bot-side pollers or
`enqueueAdminOverpaid`/similar admin-alert helpers already use in this codebase (check
`packages/db/src/crud/notifications.ts` for an existing admin-alert enqueue helper before
writing a new one).

**Testing:** A test per gateway: trigger the `"stale"` outcome and assert an admin
notification is enqueued (and/or a warning is logged, matching however the bot-side
`alertAdmins` calls are currently tested).

---

### Task 21: M-11 — Stop the BSC confirmation tracker from permanently blocking delivery

**Files:**
- Modify: `apps/order-bot/src/payments/bybitBscConfirmationTracker.ts` (~lines 190-206)
- Modify: `packages/db/src/crud/bybit_bsc_deposit.ts` (`PRE_DELIVERY_STATUSES` and
  `recordBybitBscTrackingFailed`, ~lines 328-354)
- Test: `apps/order-bot/test/` (BSC confirmation tracker tests), `packages/db/src/crud/bybit_bsc_deposit.test.ts`

**Problem:** The BSC confirmation tracker is documented as display-only, but after 10
consecutive cycles (under two minutes at the default interval) where a third-party block
explorer returns no transaction, it transitions the order to `FAILED` via
`recordBybitBscTrackingFailed` — a real state change. `FAILED` is not in
`PRE_DELIVERY_STATUSES`, so when Bybit later reports the deposit as genuinely successful,
`deliverPaidBybitBscOrder` claims the idempotency slot and immediately returns `"stale"` —
the payment can never be delivered automatically, even though it was real. A flaky
free-tier explorer API key is enough to trigger this.

**Fix (pick one):** Either (a) stop transitioning to `FAILED` from explorer-lookup-failure
data — replace it with a non-terminal "tracking stale" flag plus an admin alert, leaving
the order in a state Bybit's later report can still act on, or (b) add `FAILED` to
`PRE_DELIVERY_STATUSES` so a genuine later Bybit success report can still override the
explorer's failed opinion. Prefer (a) — it doesn't rely on the delivery function correctly
handling a `FAILED` order that's about to become deliverable, which is a more surprising
invariant to maintain.

**Testing:** A test: simulate `MAX_CONSECUTIVE_LOOKUP_FAILURES` explorer-lookup failures,
then simulate Bybit reporting a genuine success afterward, and assert the order still ends
up delivered (not permanently stuck).

---

### Task 22: M-12 — Treat a blank NOWPayments `payment_id` as a verification failure, not a valid (empty) idempotency key

**Files:**
- Modify: `packages/core/src/payments/nowpayments.ts` (`verifyIpn`, ~lines 155-156)
- Test: `packages/core/src/payments/nowpayments.test.ts`, `apps/storefront/test/` (NOWPayments IPN tests)

**Problem:** `verifyIpn` returns `trxId: ""` when `body.payment_id` is missing or not a
string/number. That empty string is then used as the UNIQUE idempotency ledger key. The
first IPN missing a `payment_id` inserts a row keyed `""`; every subsequent IPN with the
same defect is answered `already_processed`/`false`, silently — a genuinely-paid order is
never delivered and never flagged.

**Fix:** Change `verifyIpn` to return a verification failure (e.g. `null`/an explicit
rejected result) rather than `trxId: ""` when `payment_id` is missing or malformed, and make
sure the caller in `checkout.ts` treats that as "reject this callback", not "proceed with
an empty trx id".

**Testing:** A test: send an IPN with `payment_id` missing, assert it's rejected outright
(not silently ledger-poisoned), and a second such IPN afterward is independently rejected
too (proving the first one didn't leave a poisoned `""` claim behind).

---

### Task 23: M-13 — Flag and alert on Binance Internal overpayment, matching the other three rails

**Files:**
- Modify: `apps/order-bot/src/payments/binanceInternal.ts` (~lines 87-96)
- Modify: `packages/db/src/crud/binance_internal.ts` (`deliverPaidInternalOrder`, ~lines 184-230)
- Test: `packages/db/src/crud/binance_internal.test.ts`

**Problem:** TokoPay, PayDisini and NOWPayments all compute an overpayment excess and set
`outcome: "overpaid"` + call `enqueueAdminOverpaid` when the buyer sent more than expected.
Binance Internal delivers correctly on overpayment (its match tolerance allows it) but never
flags it — the surplus is silently absorbed with no ledger flag and no admin alert, leaving
no operational trail for a later refund request.

**Fix:** Add the same `excess.greaterThan(0)` → `outcome: "overpaid"` +
`enqueueAdminOverpaid` block to `deliverPaidInternalOrder`, computed against
`order.totalAmount`, mirroring exactly how `packages/db/src/crud/tokopay.ts` (~141-156) does
it for TokoPay — read that code first to match the shape.

**Testing:** A test: deliver a Binance Internal order where the transaction amount exceeds
`order.totalAmount`, assert the ledger row is flagged `"overpaid"` and an admin alert is
enqueued.

---

### Task 24: M-14 — Make Bybit's amount-matching tolerance asymmetric so overpayment doesn't orphan the deposit

**Files:**
- Modify: `apps/order-bot/src/payments/binanceInternal.ts` (`matchByAmount`, ~lines 107-116
  — shared/copied logic used by the Bybit rails; check whether Bybit's own files have their
  own copy)
- Modify: `apps/order-bot/src/payments/bybitDeposit.ts` and `bybitBscDeposit.ts` (wherever
  they call the equivalent amount-matching logic)
- Test: `apps/order-bot/test/` (Bybit deposit matching tests)

**Problem:** `matchByAmount` filters candidates on
`Math.abs(tx.amount - expected) <= tolerance` — a symmetric window. Because internal
transfer and BEP20 deposits carry no memo, amount is the only disambiguator, so a buyer who
rounds up (a very common real-world behavior) matches nothing, the deposit is recorded
`unmatched`, and the order auto-cancels at expiry even though the money genuinely arrived.
The BSC rail additionally has no `markUnderpaid` path at all for the symmetric short side.

**Fix:** Make the tolerance asymmetric: accept `tx.amount >= expected - tolerance` as a
match candidate (i.e. don't reject overpayment), while still refusing to match when ≥2
candidate orders would qualify for the same transaction (ambiguity guard stays as-is). Route
genuinely-short amounts to whatever `markUnderpaid` equivalent exists for that rail (add one
for BSC if it's missing, mirroring the pattern from a rail that has it).

**Testing:** A test per affected rail: a deposit slightly over the expected amount now
matches and delivers (previously `unmatched`); a deposit slightly under still does not
match as a full payment (routes to underpaid-handling instead).

---

### Task 25: M-15 — Move TokoPay/PayDisini credentials out of GET query strings

**Files:**
- Modify: `packages/core/src/payments/tokopay.ts` (~lines 66-73, 121-128)
- Modify: `packages/core/src/payments/paydisini.ts` (~lines 44-51, 100-107)
- Test: `packages/core/src/payments/tokopay.test.ts`, `packages/core/src/payments/paydisini.test.ts`

**Problem:** Both clients put the merchant secret / api key directly into the request URL's
query string (`GET /v1/order?merchant=...&secret=...`). Query strings are the most commonly
logged part of an HTTP request — forward proxies, egress gateways, TLS-inspection
appliances and the gateway's own access logs routinely capture them. NOWPayments does this
correctly via an `x-api-key` header.

**Fix:** If TokoPay's/PayDisini's API accepts credentials via header or POST body instead
of query string, switch to that (check their API docs/existing integration comments in the
codebase for what's actually supported). If the API genuinely requires query-string
credentials, at minimum wrap every `fetch` call in these two files so that any thrown error
strips the URL before it can propagate into a log (the code already has a `// never log the
query` comment acknowledging this for the throw sites within these files — the goal now is
to make sure that guarantee can't be defeated by an error surfacing elsewhere, e.g. an
unhandled rejection logging the raw fetch call).

**Testing:** A test asserting that if a request to either gateway fails, no code path
that logs the error includes the raw URL/query string.

---

## Batch 5 — Order bot

### Task 26: H-6 — Don't consume restock subscriptions until each notification DM succeeds, and throttle the send loop

**Files:**
- Modify: `apps/order-bot/src/handlers/admin.ts` (`notifyRestockSubscribers`, ~lines 599-621)
- Modify: move the two raw Prisma calls into a crud helper (likely
  `packages/db/src/crud/reviews.ts`, next to `listRestockSubscribers`)
- Test: `apps/order-bot/test/handlers.test.ts`

**Problem:** `notifyRestockSubscribers` deletes every matching `RestockSubscription` row
*before* the send loop runs. Any DM failure after that point (Telegram rate limit, bot
restart mid-loop) is permanent — the subscriber is never told and has no subscription left
to retry against. The send loop also has no throttle at all, unlike `drainBroadcasts`
(`BROADCAST_THROTTLE_MS = 40`), so more than ~30 subscribers reliably trips Telegram's bulk
rate limit partway through. Separately: the two Prisma calls (`user.findMany`,
`restockSubscription.deleteMany`) are raw model access inside a handler, and
`Number(tgId)` sends to chat `0` for web-only users with `telegramId: null`.

**Fix:** Delete each subscription individually *after* its own DM succeeds (or mark it
`notifiedAt` instead of deleting, if that fits the schema better — check for an existing
`notifiedAt`-style column pattern elsewhere first), add the same 40ms throttle
`drainBroadcasts` uses between sends, filter the query to `telegramId: { not: null }`
before sending, and move the two Prisma calls into a crud helper (e.g. alongside
`listRestockSubscribers` in `packages/db/src/crud/reviews.ts`).

**Testing:** A test: simulate a DM failure partway through a batch of subscribers, assert
the subscribers whose DM failed still have their subscription (retryable), while
subscribers whose DM succeeded do not (consumed). A test that a web-only subscriber
(`telegramId: null`) is skipped rather than causing a `sendMessage(0)` error.

---

### Task 27: H-7 — Stop the flash-sale announcement from holding one write transaction across a whole-customer-base enqueue

**Files:**
- Modify: `apps/order-bot/src/jobs/index.ts` (`announceStartedFlashSales`, ~lines 412-426)
- Modify: `packages/db/src/crud/notifications.ts` (`enqueueFlashSaleBroadcast`, ~lines 499-545)
- Test: `apps/order-bot/test/` (jobs/flash-sale tests), `packages/db/src/crud/notifications.test.ts`

**Problem:** `announceStartedFlashSales` wraps both the `flashAnnouncedAt` claim stamp AND
`enqueueFlashSaleBroadcast` (which does a `user.findMany` over the entire non-banned
Telegram-linked customer base plus a matching `createMany` of outbox rows) in a single
`$transaction` with an explicit 15s timeout — itself an admission the transaction is too
long. On a large customer base this holds SQLite's single writer for seconds, blocking
every other concurrent writer (checkout, settlement, cancellation, the outbox dispatcher's
own claim) past their 5s `busy_timeout`.

**Fix:** Keep only the conditional `flashAnnouncedAt` claim (the atomic "has this sale
already been announced" check) inside the short transaction. Move the customer enumeration
and outbox enqueue OUTSIDE that transaction, and batch the `createMany` into chunks (e.g.
500 rows per short transaction) rather than one giant insert — so no single transaction
ever holds the writer lock for more than a brief moment regardless of customer-base size.

**Testing:** A test asserting a large simulated customer base still gets a `Broadcast`
row and the expected count of outbox notifications enqueued, and that the claim-then-enqueue
sequence still correctly prevents double-announcement of the same sale (the property the
original single-transaction design was protecting).

---

### Task 28: M-21 — Answer `error.stale_screen` for unrecognized `v1:adm:*` admin callbacks

**Files:**
- Modify: `apps/order-bot/src/handlers/admin.ts` (`handleAdminCallback`, ~lines 659-739)
- Test: `apps/order-bot/test/handlers.test.ts` (admin callback routing)

**Problem:** `handleAdminCallback`'s `switch (section)` has no `default:` case, and none of
its inner `if/else if` chains have a trailing `else` — so an admin callback whose
section/action is no longer recognized (e.g. from a stale panel bubble after a rename)
falls through silently: the spinner clears via `routeCallback`'s blank
`answerCallbackQuery()`, but nothing tells the admin why. Every other domain in this
codebase (`dispatchBrowse`, `routeCallback`'s own unknown-domain path) handles this
correctly by answering `error.stale_screen`.

**Fix:** Add a `default:` case to the outer `switch`, and an `else` to every inner
`if/else if` chain that currently has none, all answering
`t(ctx, "error.stale_screen")` (matching how `dispatchBrowse` does it, including its
`{ event: "dead_tap" }` warn log if that's part of the established pattern — check
`dispatchBrowse` first).

**Testing:** A test sending a syntactically-valid but unrecognized `v1:adm:*` callback and
asserting the response is the `error.stale_screen` toast, not silence.

---

### Task 29: M-22 — Answer unrecognized inline taps during conversation wait loops instead of leaving the button spinning

**Files:**
- Modify: `apps/order-bot/src/conversations/support.ts` (~lines 95, 106-126)
- Modify: `apps/order-bot/src/conversations/customerInfo.ts` (~lines 105-110)
- Modify: `apps/order-bot/src/conversations/editCustomerInfo.ts` (~lines 137-142)
- Modify: `apps/order-bot/src/conversations/admin.ts` (~lines 111-134)
- Test: `apps/order-bot/test/conversations.test.ts`

**Problem:** Every `conversation.wait()` loop in these files filters for its own expected
callback data and `continue`s on anything else. Because the conversations plugin consumes
the update before `routeCallback` ever sees it, a non-matching tap is never answered at
all — Telegram's client keeps the button's loading spinner up until it eventually times
out, with no feedback to the user and no way out except knowing to type `/cancel`.

**Fix:** In each loop's fall-through/`continue` branch, when the update has a
`callbackQuery`, answer it with `t(ctx, "error.stale_screen")` before continuing to wait —
the same toast used elsewhere for stale/unrecognized taps.

**Testing:** A test per conversation: while inside the wait loop, send an unrecognized
callback and assert `answerCallbackQuery` was called with the stale-screen text, and that
the conversation is still waiting for its expected input afterward (unaffected).

---

### Task 30: M-23 — Route the support order-picker step through `menuAnchor` instead of leaving stray keyboards

**Files:**
- Modify: `apps/order-bot/src/conversations/support.ts` (~lines 70-73, 99-102, 139-142)
- Test: `apps/order-bot/test/conversations.test.ts`

**Problem:** The `AWAITING_ORDER` step (and the two sends after it) use a bare
`ctx.api.sendMessage(...)` + `orderPickerKb`, bypassing `smartEdit`/`menuAnchor` and never
calling `retireKeyboard` on the previous bubble. This leaves up to three simultaneously
live, tappable inline keyboards in the same chat, against the "one active keyboard per
chat" invariant — and per Task 29's fix, tapping a stale one now at least gets an answer,
but the UX is still wrong (multiple bubbles instead of one anchored one).

**Fix:** Route all three of these sends through `menuAnchor` (the same helper used
elsewhere in this file and across the bot for anchored, single-bubble wizard steps) instead
of the bare `ctx.api.sendMessage` calls.

**Testing:** A test walking through the support ticket creation flow asserting only one
message/keyboard is live at the end of each step (previous ones retired), matching however
other `menuAnchor`-based flows are tested elsewhere in this test file.

---

### Task 31: M-24 — Use `menuAnchor` (not `smartEdit`) for the quantity-input wizard's typed-input path

**Files:**
- Modify: `apps/order-bot/src/handlers/customer.ts` (`handleQtyTextInput`, ~lines 649-670)
- Test: `apps/order-bot/test/handlers.test.ts`

**Problem:** A prior fix (`8c41146`) added `consumeInput(ctx)` to delete the user's typed
message, but the wizard still re-renders through `smartEdit`, which on a typed (non-callback)
update takes its fresh-send path — sending a brand-new message rather than editing in
place. So typing an invalid quantity twice still stacks two new "invalid quantity" bubbles
plus the original prompt, violating the single-bubble wizard invariant.

**Fix:** Replace the `smartEdit` calls in `handleQtyTextInput` with `menuAnchor`, which
already delegates to `smartEdit` on the callback path (so the existing
`qtyInputStart`/`qtyInputCancel` callback-driven flows are unaffected) but correctly edits
in place on a typed-input path.

**Testing:** A test: type two invalid quantities in a row inside the qty-input wizard,
assert only one message is live at the end (no stacked bubbles).

---

### Task 32: M-25 — Exclude web-only users from the bot broadcast, and throttle it

**Files:**
- Modify: `apps/order-bot/src/conversations/admin.ts` (~lines 377-379, 405-419)
- Test: `apps/order-bot/test/conversations.test.ts`

**Problem:** The broadcast conversation's `user.findMany` doesn't filter
`telegramId: { not: null }` (unlike `enqueueFlashSaleBroadcast`, which does), so every
web-only registered customer becomes `sendMessage(0)` and counts as `failed`. With no
inter-send delay, real Telegram rate-limiting inflates the failure count further. The
misleading "sent X, failed Y" numbers get written verbatim into the permanent audit log via
`logAdminAction`.

**Fix:** Add `telegramId: { not: null }` to both the preview-count query and the actual
send-list query. Add the existing `BROADCAST_THROTTLE_MS` delay between sends in this
loop, matching `drainBroadcasts`.

**Testing:** A test: seed a mix of Telegram-linked and web-only customers, run the
broadcast preview and send, assert the preview count and the actual send attempts both
exclude web-only users.

---

### Task 33: M-26 — Add `{ protect: true }` to the four unprotected scheduled jobs, and fix the watchdog double-alert race

**Files:**
- Modify: `apps/order-bot/src/jobs/index.ts` (`reconcileFinancesJob` and the three poller
  watchdogs, ~lines 491-494 for registration; the alert-flag read/write inside each
  watchdog function)
- Test: `apps/order-bot/test/` (jobs tests)

**Problem:** `reconcileFinancesJob` and the three poller watchdogs are registered without
croner's `{ protect: true }`, unlike every other job in the same list (which have it with a
comment explaining why). Each watchdog reads its alert flag, DMs every admin sequentially,
and only afterward writes the flag — so if a run overlaps the next tick (a slow Telegram
API, e.g.), the second run reads the still-unset flag and every admin gets paged twice.

**Fix:** Add `{ protect: true }` to all four `new Cron(...)` registrations. Additionally,
move the `setSetting(..., "1")` (or whatever marks the alert as sent) write to BEFORE the
admin DM loop, not after — so even without overlap, a crash mid-DM-loop doesn't cause a
re-alert storm on the next run.

**Testing:** A test simulating two overlapping invocations of one of the watchdogs and
asserting admins are only alerted once.

---

### Task 34: M-27 — Wrap each stale-ticket-closure iteration in its own try/catch

**Files:**
- Modify: `apps/order-bot/src/jobs/index.ts` (`autoCloseStaleTickets`, ~lines 109-127 —
  compare `autoCancelExpiredOrders` immediately above it, ~lines 94-106, which already does
  this correctly)
- Test: `apps/order-bot/test/` (jobs tests)

**Problem:** `autoCloseStaleTickets` only wraps the customer DM in try/catch; the
`prisma.user.findUnique` and `closeTicket` calls run bare inside the loop, so a single
failure (a write-lock timeout, a constraint violation) throws out of the entire `for` loop
and the whole run is skipped — every other stale ticket in that batch stays open for
another hour, and if the same row keeps failing, the batch never drains past it.

**Fix:** Wrap the entire body of each loop iteration in try/catch (log-and-continue),
mirroring exactly how `autoCancelExpiredOrders` does it immediately above.

**Testing:** A test: seed multiple stale tickets where one row's closure throws, assert
every other row in the batch still gets processed (not aborted by the one failure).

---

### Task 35: M-28 — Stop logging a credential list, and route hardcoded admin strings through `t()`

**Files:**
- Modify: `apps/order-bot/src/handlers/verification.ts` (~lines 198-199, 63, 66, 213, 285)
- Modify: `apps/order-bot/src/handlers/admin.ts` (~lines 200-203)
- Modify: `packages/core/locales/en.json` and `packages/core/locales/id.json` (add the new
  keys, keeping both files' key sets identical with matching placeholders)
- Test: `apps/order-bot/test/handlers.test.ts`, `packages/core/src/locales.test.ts` (should
  already assert key-set parity — just make sure it still passes)

**Problem:** Line ~199 builds a Pino log message that interpolates a per-item list of
redacted credentials (`redacted.join(", ")`) — the logging convention explicitly forbids
interpolating id/name lists (summarize by count instead), and this is derived-credential
material in logs regardless. Separately, five admin-facing strings bypass `t(ctx, key,
args)` entirely (hardcoded English), and `maybeAlertLowStock` hardcodes the locale to
`"en"` instead of using the receiving admin's own language.

**Fix:** Change the log line to summarize by count (e.g. `` `... (${redacted.length}
credential set(s))` ``) instead of joining the list. Add locale keys (in both `en.json` and
`id.json`, keeping the key sets and `{placeholder}` sets identical) for the five hardcoded
strings at `verification.ts:63,66,213,285` and `admin.ts:200-203`, and route each through
`t(ctx, key, args)`. In `maybeAlertLowStock`, pass each recipient admin's own language
(however other multi-admin-alert code in this codebase determines a specific admin's
language — check for an existing per-admin-language lookup pattern) instead of hardcoding
`"en"`.

**Testing:** A test asserting the delivery log message never contains more than a count for
multi-credential orders. `locales.test.ts` should already catch any key-parity mistake —
just confirm it still passes with the new keys added.

---

## Batch 6 — Data layer and schema

### Task 36: H-8 — Generate the missing catch-up migration for 12 columns and 2 indexes that exist only in `schema.prisma`

**Files:**
- Generate: a new file under `prisma/migrations/`
- Modify: whatever CI config runs `pnpm typecheck`/`pnpm test` (add a migration-drift check)
- Modify: `docs/MIGRATIONS.md` if it needs a note about the CI check

**Problem:** 12 columns (`delivery_type`, `additional_fields`, `what_you_get`, `terms`,
`warranty_note`, `customer_data`, `delivered_content`, `closed_at`,
`flash_discount_percent`, and others) and 2 indexes
(`ix_denominations_flash_ends_at`, `ix_support_tickets_closed_at`) exist in
`schema.prisma` with no corresponding SQL anywhere in `prisma/migrations/`. A fresh
`prisma migrate deploy` against an empty database would fail with `P2022` the moment the
catalog is read. Day-to-day deploys in this repo use `prisma db push`, so this is currently
latent, not a live outage — but it blocks the Postgres migration path this repo has named
as its own scaling trigger.

**Fix:** Run
`prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --script`
to generate the exact SQL needed, review it carefully (it should contain only additive
`ALTER TABLE ADD COLUMN`/`CREATE INDEX` statements matching the 12 columns + 2 indexes named
in the audit — no drops, no renames, nothing destructive), save it as a new migration
folder with an appropriately later timestamp, and confirm `prisma migrate diff` between the
migrations folder and the schema now reports no difference. Add this same `migrate diff`
command as a CI check (find wherever CI/typecheck scripts are configured, e.g. root
`package.json` or a CI workflow file) that fails the build if the diff is non-empty, so this
can't silently drift again.

**Testing:** Run the `migrate diff` command yourself as the acceptance test for this task —
it must report zero differences after the new migration is added. Do not apply the
migration to any running database as part of this task (this repo's deploys use
`db push` — generating the migration file is the deliverable, not running
`migrate deploy`).

---

### Task 37: H-9 — Fix the unrunnable ticket-priority migration and its timestamp collision

**Files:**
- Modify or replace:
  `prisma/migrations/20260725000000_add_ticket_priority_category_resolved/migration.sql`
- Modify: `docs/MIGRATIONS.md` (add a "Recovering from a failed `migrate deploy`" section)

**Problem:** This migration's own commit message (`058afd7`) documents that its original
version already failed a real `migrate deploy` with P3018, partially applied (3 of 4
columns landed, the index didn't). The corrected version still opens with three bare
`ADD COLUMN` statements with no idempotency guard — so any database that took the original
partial application still can't run this file cleanly (`migrate resolve --rolled-back`
re-runs it and hits `duplicate column name: category`; `migrate resolve --applied` marks it
done while `last_status_change_at` is still missing, breaking every subsequent
`supportTicket` read). Separately, this folder's timestamp
(`20260725000000`) is byte-identical to a sibling
(`20260725000000_add_support_ticket_priority`), and the ordering the file's own comment
depends on only holds because of `s < t` lexicographic luck.

**Fix:** Split the migration into individually idempotent steps (e.g. check column
existence before each `ADD COLUMN`, if the SQLite dialect/Prisma migration tooling supports
a safe conditional form — otherwise document the manual recovery steps clearly), or re-cut
it as a fresh migration with a distinctly later timestamp that explicitly assumes the
partially-applied state as its starting point. Rename one of the two colliding folders to a
distinct timestamp so ordering no longer depends on string comparison luck (careful: renaming
an already-applied migration folder can break `_prisma_migrations` tracking on databases
that already ran it under the old name — note this tradeoff in your task report so the
human reviewing this can decide whether renaming is safe for this deployment's actual state,
or whether a forward-only fix is safer). Add a "Recovering from a failed `migrate deploy`"
section to `docs/MIGRATIONS.md` covering P3018 and the `migrate resolve` commands, since no
doc currently mentions either.

**Testing:** This is a migration-file correctness fix — verify by running
`prisma migrate diff` (same command as Task 36) and confirming it still reports no
difference after your change, and manually reason through (documented in your report) the
three DB-state scenarios: (1) fresh DB, (2) DB that has the corrected 4-column migration
already applied, (3) DB that has the original broken 3-column partial application. State how
each scenario is now handled.

---

### Task 38: M-29 — Stamp `lastStatusChangeAt`/`firstResponseAt` on every ticket status transition

**Files:**
- Modify: `packages/db/src/crud/support.ts` (`reopenTicket` ~142-146, `replyToTicket` ~173-195)
- Modify: `prisma/schema.prisma` and its migration (align `lastStatusChangeAt` nullability —
  see note below)
- Test: `packages/db/src/crud/support.test.ts`

**Problem:** `schema.prisma` declares `lastStatusChangeAt DateTime @default(now())`
(non-nullable) but its migration adds the column nullable — so a `db push` DB and a
`migrate deploy` DB have physically different schemas. Worse, the migration's comment
claims every write path sets this column explicitly, but `reopenTicket` writes only
`status`/`closedAt`, and the bot's `replyToTicket` sets neither `lastStatusChangeAt` nor
`firstResponseAt`. The admin queue's "Waiting since" column and the first-response SLA
metric both read these fields, so they're wrong for any ticket reopened or replied-to via
these paths.

**Fix:** In `reopenTicket`, add `lastStatusChangeAt: new Date()` to its update. In
`replyToTicket`, add `lastStatusChangeAt: new Date()` and, if `firstResponseAt` is
currently null on that ticket, set it to `new Date()` as well (mirror however
`addTicketMessage` already computes this, if it does something similar — check that
function first for the established pattern). For the nullability mismatch: since this
task's fix means the column is now always set by every write path, align the *migration*
to match the schema's `NOT NULL DEFAULT` intent as closely as SQLite's `ALTER TABLE`
limits allow (SQLite can't add a `NOT NULL DEFAULT CURRENT_TIMESTAMP` column via `ALTER
TABLE` — this is exactly why the original migration had to go nullable, per its own
comment). If a genuine `NOT NULL` can't be added via a safe `ALTER TABLE`, leave the column
nullable at the SQL level but note in your report that the schema's `@default(now())`
without an explicit "not null enforced at the app layer" comment is misleading, and consider
whether the schema's declared nullability should instead be relaxed to match the DB
reality, rather than vice versa — this is a documentation/consistency fix, not a data
migration, so don't attempt a destructive column rebuild.

**Testing:** A test: reopen a ticket, assert `lastStatusChangeAt` updates; reply to a
ticket via `replyToTicket`, assert `lastStatusChangeAt` updates and `firstResponseAt` gets
set on the first reply (and is NOT overwritten on a second reply).

---

### Task 39: M-30 — Expire the pre-auth `OWNER_TG_KEY` setup state so `/setup/owner` can't stay open indefinitely

**Files:**
- Modify: `apps/web-admin/src/routes/setup.ts` (~lines 61-62, 126-139)
- Test: `apps/web-admin/test/web.test.ts` (setup wizard tests)

**Problem:** `OWNER_TG_KEY` is deleted only on a *successful* `POST /setup/shop` (the final
wizard step). If an operator abandons the wizard after step 2 (closed browser, interrupted
deploy), `setup_completed` stays unset and `checkSetupLock` returns `false` permanently,
while the shop runs normally and nobody notices — so the pre-auth, no-CSRF
`POST /setup/owner` route stays reachable indefinitely. Anyone who can reach the panel can
submit their own `telegram_id` + password and get a full super-admin account.

**Fix:** Store a timestamp alongside `OWNER_TG_KEY` when it's set, and have
`checkSetupLock` (or wherever `OWNER_TG_KEY`'s presence is checked) treat it as expired
after a short window (e.g. 30 minutes) — falling back to the `anyAdminPasswordSet` check
instead of trusting an old `OWNER_TG_KEY` forever. Alternatively (simpler, prefer this if it
doesn't complicate the wizard's step ordering), write `setup_completed` as soon as step 2
succeeds rather than waiting for step 3 — check whether step 3 (`/setup/shop`) genuinely
needs to happen pre-auth, or whether it could become a normal authenticated settings edit
once the owner account exists. Pick whichever approach is less invasive to the existing
wizard flow and explain the choice in your task report.

**Testing:** A test: complete step 2 only, wait past the expiry window (or simulate time
passing), and assert `POST /setup/owner` is now locked/refused rather than staying open
forever.

---

### Task 40: M-31 — Fix the overdue-ticket predicate to catch reopened/follow-up tickets

**Files:**
- Modify: `packages/db/src/crud/support.ts` (`ticketWhere`'s `overdue` filter ~353-357,
  and the raw-SQL mirror `ticketWhereRaw` ~406-410)
- Test: `packages/db/src/crud/support.test.ts`

**Problem:** The overdue predicate is
`status = OPEN AND repliedAt IS NULL AND createdAt < cutoff`. But a customer follow-up on
an already-answered ticket flips it back to `OPEN` (via `addTicketMessage`) WITHOUT clearing
`repliedAt` — so a three-week-old ticket a customer just replied to ("still not fixed") is
invisible to the Overdue KPI, filter and badge, all of which share this one predicate. It
also keys on `createdAt` rather than the ticket's actual wait-clock reset point.

**Fix:** Change the predicate to `status IN (OPEN) AND lastStatusChangeAt < cutoff` (drop
the `repliedAt IS NULL` term and swap `createdAt` for `lastStatusChangeAt`, which — after
Task 38's fix — correctly resets whenever the ticket re-enters `OPEN`). Apply the identical
change to both `ticketWhere` and its raw-SQL mirror `ticketWhereRaw`, keeping the two
predicates byte-equivalent as the existing pattern requires.

**Testing:** A test: create a ticket, have it answered (`repliedAt` set), have the customer
reply (flips back to `OPEN`, `repliedAt` unchanged), wait past the overdue cutoff relative
to `lastStatusChangeAt`, and assert it now appears in the overdue filter (previously
invisible).

---

### Task 41: M-32 — Add indexes for the new revenue/flash-sale queries' filter columns

**Files:**
- Modify: `prisma/schema.prisma` (`OrderItem` add `@@index([productId])`, `Order` add
  `@@index([status, deliveredAt])`)
- Generate: matching migration
- Test: none required beyond confirming `pnpm test` still passes (index-only change) — but
  do run `prisma migrate diff` (Task 36's command) afterward to confirm this migration is
  captured

**Problem:** `OrderItem` has only `@@index([orderId])`, and `Order` has no index on
`deliveredAt`. But `topProductsByMargin`, `profitSummarySince`, and `flashSalePerformance`
(all recently added) filter/join on exactly `orderItem.productId` and
`order.{status, deliveredAt}`. At scale (`order_items` is the fastest-growing table) these
become full scans holding read locks that queue behind concurrent checkout writes.

**Fix:** Add `@@index([productId], map: "ix_order_items_product_id")` to `OrderItem` and
`@@index([status, deliveredAt], map: "ix_orders_status_delivered")` to `Order` in
`schema.prisma`, then generate the corresponding migration (same `prisma migrate diff`
workflow as Task 36 — do this as part of the same migration-generation pass if convenient,
but keep it as a distinct, clearly-named migration folder).

**Testing:** Confirm `pnpm typecheck && pnpm test` still pass, and confirm
`prisma migrate diff` reports no difference after the new migration is added.

---

### Task 42: M-33 — Replace `topProducts`'s full-table scan with a bounded, grouped query

**Files:**
- Modify: `packages/db/src/crud/revenue.ts` (`topProducts`, ~lines 155-160)
- Test: `packages/db/src/crud/revenue.test.ts`

**Problem:** `topProducts` does `db.orderItem.findMany({ where: { order: { status:
DELIVERED } } })` with no `take`, no `since` window, and no `groupBy` — it materializes the
entire order-history table into JS memory and buckets it in a `Map` just to return the top
10, on every Reports-page request.

**Fix:** Replace with `orderItem.groupBy({ by: ["productId"], _sum: { quantity: true }, ... })`
(or the equivalent aggregate this Prisma version supports), bounded by a `since` parameter
consistent with how the rest of the Reports page scopes its date range, and `orderBy`/`take`
applied at the query level rather than in JS.

**Testing:** A test confirming the same top-10 ranking as before on a representative
dataset (regression-safe), and confirming the function now accepts/respects a `since`
bound.

---

### Task 43: M-34 — Add indexes for the Customers/Audit admin surfaces, and bound `rankUserIdsBySpend`

**Files:**
- Modify: `prisma/schema.prisma` (`User` add `@@index([role, createdAt])` and
  `@@index([lastSeenAt])`; `AuditLog` add `@@index([targetType, targetId])`)
- Generate: matching migration
- Modify: `packages/db/src/crud/users.ts` (`rankUserIdsBySpend`, ~lines 374-385 — add a
  `take` bound)
- Test: `packages/db/src/crud/users.test.ts`

**Problem:** `User` has no index beyond its unique constraints, while the Customers module
filters/sorts on `role`/`banned`/`createdAt`/`lastSeenAt`; `AuditLog` indexes `createdAt`
only while its filter now also uses `targetType`/`targetId`. `rankUserIdsBySpend`
additionally has no `take`, so a "sort by spend" page load pulls every matching user id
before paginating, then issues a `groupBy` over all of them (which Prisma must chunk around
SQLite's parameter-count limit on a large customer base).

**Fix:** Add the two `User` indexes and the one `AuditLog` index listed above, generate the
migration (same workflow as Task 36/41). Bound `rankUserIdsBySpend` with a sane `take`
ceiling (or restructure it to do the ranking via a single bounded `groupBy` + `orderBy` +
`take`, rather than materializing all ids first — prefer this if not too invasive).

**Testing:** Confirm `pnpm typecheck && pnpm test` pass and `prisma migrate diff` is clean.
Add a test asserting `rankUserIdsBySpend` (or its replacement) returns a bounded, correctly
paginated result on a dataset larger than the bound.

---

### Task 44: M-35 — Add missing tests for 7 crud files that changed without test coverage

**Files:**
- Modify test files: `packages/db/src/crud/binance_internal.test.ts`,
  `bybit_deposit.test.ts`, `bybit_bsc_deposit.test.ts`, `nowpayments.test.ts`,
  `paydisini.test.ts`, `orderStatus.test.ts`, `reviews.test.ts`

**Problem:** These 7 crud files changed since the last backend audit with no corresponding
test change. Specifically untested: the `"processing"` branch each of the 5 gateway files
now has (including that `ORDER_DELIVERED_DM` is correctly skipped on that branch while the
overpaid alert stays unconditional — an interaction between two branches that no test
currently exercises), 2 new `LEGAL_TRANSITIONS` entries in `orderStatus.ts`, and
`listRestockSubscribers`'s widened `include` shape (consumed by Task 26's fix in
`handlers/admin.ts`).

**Fix:** Add one table-driven test (shared logic, run once per gateway file since they're
near-identical) covering the `"processing"` branch's DM-skip/overpaid-alert interaction for
each of the 5 gateway files. Add a test for each of the 2 new `LEGAL_TRANSITIONS` entries
(both the allowed transition succeeding and an adjacent illegal one being rejected). Add a
test asserting `listRestockSubscribers`'s returned shape matches what
`handlers/admin.ts:600` destructures (this should already be exercised indirectly by Task
26's tests — check before duplicating, and only add what's not already covered there).

**Testing:** This task IS the testing task — its deliverable is the new/updated test files
themselves, run and passing.

---

### Task 45: M-36 — Derive the raw-SQL ticket-priority-sort query's id set from the same predicate `countTickets` uses

**Files:**
- Modify: `packages/db/src/crud/support.ts` (`ticketWhereRaw` ~369-418 and
  `listTicketIdsByPriorityRank` ~425-450, vs `ticketWhere`/`countTickets` ~338-366, ~485)
- Test: `packages/db/src/crud/support.test.ts`

**Problem:** The priority-sorted ticket list needs a raw SQL `ORDER BY` (a custom enum rank
Prisma can't express) via `ticketWhereRaw`, but `countTickets` always uses the Prisma
`ticketWhere` version — so the two predicates must stay byte-equivalent by hand forever.
They already differ subtly on `%term%` escaping, meaning the header count and the
priority-sorted page can silently disagree on how many tickets match a filter.

**Fix:** Keep the raw SQL only for the `ORDER BY` rank expression itself. Derive the
matching id set from `ticketWhere` (the Prisma predicate) first — e.g. fetch matching ids
via a Prisma query using `ticketWhere`, then do `SELECT ... FROM support_tickets WHERE id IN
(...) ORDER BY <priority rank expression>` — so there is exactly one filter predicate
(Prisma's) feeding both the count and the priority-sorted list, and the raw SQL's job
shrinks to just the ordering.

**Testing:** A test asserting the priority-sorted list and `countTickets` agree on the
total number of matching tickets for a filter that includes a `%`/`_` character in a search
term (the exact case the audit flagged as already differing).

---

### Task 46: M-37 — Add `details` sentences to the remaining bare `logAdminAction` call sites

**Files:**
- Modify: `apps/web-admin/src/routes/api/vouchers.ts` (~358-363),
  `apps/web-admin/src/routes/api/catalog.ts` (~516-521),
  `apps/web-admin/src/routes/api/outbox.ts` (~41-46),
  `apps/web-admin/src/routes/api/broadcast.ts` (~97, 110, 123),
  `apps/web-admin/src/routes/api/reviews.ts` (~38),
  `apps/web-admin/src/routes/api/payments.ts` (~122),
  `apps/web-admin/src/routes/api/support.ts` (~297, 310),
  `apps/web-admin/src/routes/api/settings.ts` (~505, 531, 544),
  `apps/order-bot/src/handlers/admin.ts` (~485, 572)
- Test: existing tests for these routes/handlers should already assert `logAdminAction` is
  called — extend them to assert on the new `details` text, or add coverage where missing

**Problem:** 15 `logAdminAction` call sites write no `details` — worst on delete actions
(`voucher_delete`, `denomination_delete`) where the referenced row no longer exists by the
time anyone reads the audit log, so "who deleted the WELCOME50 code?" resolves to a bare
`voucher_delete → voucher #47` with nothing describing what was deleted.

**Fix:** For each site, capture the relevant identifying info (name/code/title) BEFORE the
delete/mutation happens, and write a natural-language `details` sentence per
`docs/LOGGING.md`'s convention (never `key=value` shorthand) — e.g.
`` `Deleted voucher "${code}" (never used).` ``, `` `Deleted denomination "${name}" from
product "${product}".` ``, `` `Requeued a ${eventType} notification for delivery.` ``. Read
`docs/LOGGING.md` first for the exact tone/format expected, and look at an already-fixed
sibling (the audit notes `bulk_pricing_delete` was already fixed with `details: \`Removed
bulk pricing for "…".\``) as a concrete template.

**Testing:** For each of the 15 sites, assert the `logAdminAction` call now includes a
non-empty, natural-language `details` string (not just that the call happened).

---

## Batch 7 — Operations Center cross-gateway payments visibility (added mid-execution)

This task was NOT in the original audit report — it was found and root-caused via
`superpowers:systematic-debugging` mid-execution of this plan, then scoped and approved by
the human partner. It's appended here rather than in a separate plan because the human
partner asked for it to run in this same worktree.

### Task 47: Make the "Failed Deliveries" Operation Center card show data from every payment gateway, not just Binance

**Files:**
- Modify: `packages/db/src/crud/reports.ts` or a new function near
  `manualMatchQueueCounts` (~lines 208-226) — add a function that lists (not just counts)
  ledger rows across all 6 gateway tables with a unified shape
- Modify: `apps/web-admin/src/routes/api/payments.ts` (`GET /api/payments`, ~lines 33-78)
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.tsx` (read `outcome` from the URL on
  mount; render a `gateway` column; adapt row actions to only appear for gateways that
  support them)
- Modify (if needed for consistency): `apps/web-admin/client/src/api/types.ts`
- Test: `apps/web-admin/test/dashboard-api.test.ts`, `apps/web-admin/test/web.test.ts`
  (payments section), `apps/web-admin/client/src/pages/PaymentsPage.test.tsx`
- **This task DOES touch `apps/web-admin/client` — after editing it, run
  `pnpm --filter @app/web-admin-client build` before `pnpm test`/`pnpm typecheck` will see
  a consistent picture.**

**Root cause (from the debugging investigation):**
1. The Operation Center's "Failed Deliveries" card (`apps/web-admin/client/src/components/dashboard/OperationCenter.tsx:18`)
   shows a count from `manualQueue.deliveryFailed`
   (`apps/web-admin/src/routes/api/dashboard.ts:89,109` → `manualMatchQueueCounts` in
   `packages/db/src/crud/reports.ts:208-226`), which sums the `delivery_failed` outcome
   across **five** ledger tables: `processedBinanceTx`, `processedBybitTx`,
   `processedTokopayTx`, `processedPaydisiniTx`, `processedNowpaymentsTx`. (Check whether
   `processedBybitBscTx`/the BSC deposit ledger is a sixth table not currently included
   here either — audit it while you're in this function, and include it if so.)
2. The card links to `/payments?outcome=delivery_failed`, but `GET /api/payments`
   (`apps/web-admin/src/routes/api/payments.ts:33-78`) only ever queries
   `listProcessedBinanceTx`/`countProcessedBinanceTx` — by design, per
   `docs/superpowers/specs/2026-07-24-payments-page-redesign-design.md`'s explicit
   non-goal ("No cross-page changes — this session touches only PaymentsPage.tsx,
   api/payments.ts, crud/binance_internal.ts"). So a `delivery_failed` row on any of the
   other gateways is structurally invisible on this page — not a loading/filter bug, the
   data is never queried.
3. Independently, `PaymentsPage.tsx:184` (`const [outcome, setOutcome] = useState("")`)
   never reads the `outcome` query-string parameter from the URL at all — no
   `useSearchParams`/`useLocation` anywhere in the file — so even a genuine Binance
   `delivery_failed` row won't be pre-filtered when landing from the card link.

**Fix — do both parts:**

*Part A (backend):* Add a function alongside `manualMatchQueueCounts` (same file) that
returns a **unified, paginated list** of ledger rows across all gateway tables, not just
counts. Each gateway's `processed*Tx` table has a different column shape (e.g.
`binanceTxId` vs `trxId` vs whatever TokoPay/PayDisini/NOWPayments use) — normalize each
row into a common shape: `{ id, gateway: "binance" | "bybit" | "bybit_bsc" | "tokopay" |
"paydisini" | "nowpayments", reference: string, amount: string | null, currency: string |
null, outcome: string, createdAt: Date, orderId: number | null }` (check each table's
actual columns first — the exact source field for `reference` will differ per gateway,
e.g. `binanceTxId`, `trxId`, whatever PayDisini/NOWPayments call their transaction
reference). Fetch each table's matching rows (filtered by `outcome` if provided, same
`TX_OUTCOMES` validation as the existing Binance-only query) in parallel via
`Promise.all`, tag each with its `gateway`, merge, sort by `createdAt` descending, then
apply pagination in memory (mirror the existing `manualMatchQueueCounts` pattern of
querying all tables and combining in JS — do NOT use raw SQL `UNION`, this repo's rule is
no raw SQL outside the crud layer, and an in-JS merge is simpler and safer here given
these ledger tables are not enormous). Also add a combined count function analogous to
`countProcessedBinanceTx` but across all gateways with the same filter.

Update `GET /api/payments` to use these new combined functions instead of the
Binance-only ones for the `ledger`/`total` response fields. Keep `underpaid`/
`pendingInternal`/`health`/`enabled` as-is (those are genuinely Binance-Internal-specific
concepts per the page's original design — only the ledger listing needs to become
cross-gateway). The existing manual actions (`/api/payments/match`, `/api/payments/credit`,
`/api/payments/dismiss`) operate on Binance transactions specifically (`binanceTxId`) —
leave those as-is for this task; don't try to extend manual match/credit/dismiss to the
other five gateways, that's out of scope here. The frontend should simply not show those
row-action buttons for a row whose `gateway !== "binance"` (see Part B).

*Part B (frontend):* In `PaymentsPage.tsx`, read the `outcome` query parameter from the URL
using `react-router-dom`'s `useSearchParams` (or `useLocation` + manual parsing — check
what's already imported/used elsewhere in this app's pages for reading URL query params,
e.g. `OrdersPage.tsx` likely already does this for its own `?status=` links from
`OperationCenter` — follow that exact pattern) on initial mount, seeding the `outcome`
state from it instead of always starting at `""`. Add a `gateway` column to the ledger
`DataTable` showing which payment rail each row came from (a simple `StatusBadge`-style or
plain-text label is fine — check `StatusBadge.tsx`'s tone map, it may need a new
entry/pattern for gateway names, or a plain badge without semantic tone is fine here since
gateway isn't a status). Only render the existing row action dropdown (Match/Credit/
Dismiss) for rows where `gateway === "binance"` — for other gateways, either omit the
action column's dropdown entirely for that row, or show it disabled with a tooltip
explaining manual actions for that gateway aren't available in this page yet (pick
whichever fits the existing `DataTable`/`DropdownMenu` usage more simply).

**Testing:** Add a test seeding a `delivery_failed` row on a non-Binance gateway (e.g.
TokoPay) and one on Binance, then asserting `GET /api/payments?outcome=delivery_failed`
returns both (previously only Binance's would appear). Add a frontend test asserting
`PaymentsPage` initializes its `outcome` filter from `?outcome=delivery_failed` in the URL
on mount (previously always started unfiltered). Run
`pnpm --filter @app/web-admin-client build` before running the full suite, since this
touches client code.
