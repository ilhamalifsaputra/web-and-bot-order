# Audit fixes plan — `docs/audit-backend-2026-08-21.md`

Standalone numbered tasks (continuing the numbering from Task 8, the
order-bot manual-SKU-buyability fix already committed as `1c540c8` on this
branch), each fixing one finding from the 2026-08-21 backend audit. Tasks are
independent of each other unless stated otherwise.

## Global Constraints

- Money is always `Decimal` from `@app/core/money` — never `float`/`number`
  arithmetic on a price/cost value.
- No raw SQL in routes/handlers; new DB logic belongs in `packages/db/src/crud/*`
  with colocated Vitest coverage.
- Any admin-visible audit entry (`logAdminAction`) `details` string is a short
  natural-language sentence, never `key=value` shorthand.
- Pino logger messages (`packages/core/src/logger.ts`) are full English
  sentences for developers/ops; never interpolate a truncated id/list — use a
  count instead.
- Never log secrets (credentials, payment-proof `file_id`, password hashes,
  full DB URLs).
- `pnpm typecheck` and `pnpm test` must stay green.

---

## Task 9: Reject non-finite/non-positive prices from the Digiflazz price list instead of defaulting to zero

**Finding:** `docs/audit-backend-2026-08-21.md` §1 Critical C-1 (first half).
`packages/core/src/suppliers/digiflazz.ts:119-131` (`toPriceListItem`) maps
`price: toDecimalOrZero(d.price)` — any unparseable, absent, non-finite, or
non-positive supplier `price` field silently becomes `Decimal(0)` instead of
being rejected. That zero then flows into
`packages/db/src/crud/digiflazz.ts`'s `resyncDigiflazzCatalog`, which applies
the markup rule to it (`applyDigiflazzMarkup(0, …)` returns `0` for every
markup type), silently zeroing the live sell price for every non-overridden
Digiflazz denomination with no error and a "success" audit entry.

The same path also admits non-finite values: `toDecimalOrNull` constructs
`new Decimal(String(v))` in a try/catch, but `new Decimal("NaN")` and
`new Decimal("Infinity")` do NOT throw (decimal.js accepts these as valid
special values by default) — so a NaN/Infinity price silently survives too.
`collapseToCheapestSeller`'s `.lessThan()` comparison (`packages/db/src/crud/digiflazz.ts:391-400`)
is `false` against NaN, so a NaN row can win the cheapest-seller collapse.

**Fix, in `packages/core/src/suppliers/digiflazz.ts`:**

1. `toDecimalOrNull` (currently returns `Decimal | null`): after constructing
   the `Decimal`, also return `null` when the result is not finite
   (`!d.isFinite()` — decimal.js's `Decimal#isFinite()` returns `false` for
   both NaN and ±Infinity) or when it's `<= 0` (a supplier cost of zero or
   negative is never legitimate for this shop's product catalog). Keep the
   existing try/catch for genuinely unparseable strings.
2. `toPriceListItem` (currently returns `DigiflazzPriceListItem` unconditionally):
   change so a row whose price is invalid by the above rule is not turned
   into a semantically-wrong `DigiflazzPriceListItem` — the caller
   (`getPriceList`) needs to be able to skip it entirely rather than storing
   a placeholder in the array. Pick whichever shape reads cleanest given the
   single call site: e.g. have `toPriceListItem` return `null` for an invalid
   row and change `getPriceList`'s `rows.map(...)` to filter the nulls out
   (`.map(...).filter((x): x is DigiflazzPriceListItem => x !== null)` or a
   `flatMap`). `DigiflazzPriceListItem.price` (the exported interface,
   line ~86-97) stays a required non-null `Decimal` — every consumer
   downstream (`collapseToCheapestSeller`, `resyncDigiflazzCatalog`,
   `groupDigiflazzPriceListByBrand`, `importDigiflazzBrand`) keeps assuming a
   valid, positive, finite price and needs no changes.
3. When `getPriceList` skips one or more rows, log ONE `logger.warn` call
   (not one per row) naming the supplier SKU count skipped — e.g.
   `` logger.warn(`Digiflazz price list: skipped ${n} row(s) with an invalid or non-positive price`) `` —
   matching this repo's "summarize by count, never a clipped id dump" logging
   rule. Do not throw; a partial response with some good rows should still
   sync those rows (the circuit-breaker in a later task handles the
   blast-radius case, not this one).

**Tests** (colocated `packages/core/src/suppliers/digiflazz.test.ts`, existing
`describe("getPriceList", …)` block at line ~158 is your model — it already
stubs `fetch` via `stubFetchJson`/`vi.stubGlobal`):

- A price list response containing one valid row and one row with
  `price: "NaN"` (or `price: NaN` if the stub JSON allows it) returns only
  the valid row, `list` has length 1.
- A row with `price: 0` is skipped.
- A row with `price: -500` is skipped.
- A row with `price: "Infinity"` is skipped.
- A row with a completely valid price still parses exactly as today (don't
  break the existing "parses the supplier's SKU/price list" test).
- Skipping logs a warning (assert via a `vi.spyOn` on the logger, matching
  how other suites in this repo assert log calls — grep for an existing
  example if unsure of the exact mocking shape used for `@app/core/logger`).

Self-review before committing: confirm `pnpm exec vitest run packages/core/src/suppliers/digiflazz.test.ts` is green, and that no other caller of `toDecimalOrNull`/`toPriceListItem` in this file (there are two other uses of `toDecimalOrNull`: `createTransaction`'s `price` field and `verifyCallback`'s `price` field) is affected in a way that breaks its own existing tests — those two call sites intentionally keep `Decimal | null` semantics (a transaction/callback price genuinely can be absent), so don't change their non-finite handling unless it's already broken the same way and doing so doesn't regress their tests.

---

## Task 10: Circuit-breaker + admin alert on `resyncDigiflazzCatalog`

**Depends on Task 9** (assumes `getPriceList` never returns a zero/NaN price
row after Task 9 lands — do not start this task until Task 9's commit exists
on this branch).

**Finding:** `docs/audit-backend-2026-08-21.md` §1 Critical C-1 (second half)
+ recommendation #1. Even with Task 9's per-row rejection, a different
failure mode remains: a genuinely malformed *response* (e.g. a field rename,
partial outage, wrong endpoint) could still cause `resyncDigiflazzCatalog`
(`packages/db/src/crud/digiflazz.ts:653-701`) to apply a wildly-wrong but
individually "valid" price to many denominations at once, with nothing but a
routine-looking `digiflazz_catalog_resync` audit entry. The audit's
recommended fix: "add a blast-radius circuit-breaker to
`resyncDigiflazzCatalog` (abort + alert if >X% of rows would change by >Y%)."

**Fix, in `packages/db/src/crud/digiflazz.ts`'s `resyncDigiflazzCatalog`:**

1. Before writing anything, compute for each `denom`/`item` pair (where
   `!denom.priceOverridden`, i.e. the rows this function would actually
   reprice) what the new price would be
   (`quantizeMoney(applyDigiflazzMarkup(item.price, markupSettings), 4)`) and
   compare it to the denomination's current `price`. Use these thresholds:
   a row "changed sharply" when the new price differs from the old price by
   more than 50% in either direction (`newPrice` is `< 0.5 * oldPrice` or
   `> 1.5 * oldPrice`) — guard against `oldPrice` being zero (treat any
   nonzero new price on a zero old price as a sharp change, and skip the
   ratio check with a boolean `oldPrice.isZero()` branch rather than dividing
   by zero). The run trips the breaker when sharply-changed rows are more
   than 20% of the *would-reprice* set AND that set has at least 5 rows
   (skip the breaker for a shop with only a handful of Digiflazz
   denominations, where one legitimate supplier price swing would look like
   ">20%" of the whole set every time).
2. When the breaker trips: **write nothing** (don't call `updateDenomination`
   for ANY row this run — a partial write of only the "safe" rows still
   leaves the audit trail claiming a normal resync happened), log one
   `logger.error` describing the aborted run (counts only — how many rows
   would have changed sharply out of how many considered — never raw
   SKU/price dumps), write ONE `logAdminAction` entry (`adminId: null`,
   action e.g. `"digiflazz_catalog_resync_aborted"`, a natural-language
   `details` sentence stating the run was aborted and why, in the tone of the
   existing `digiflazz_catalog_resync` entry at line ~696), and alert every
   admin so a human notices before the next hourly tick silently retries the
   same malformed data. Model the alert on
   `enqueueAdminStalePayment`/`enqueueAdminUnconfirmablePayment` in
   `packages/db/src/crud/notifications.ts` (lines ~262-330: fan-out one
   `notificationOutbox` row per `resolveAdminIds(db)` admin, `orderId: null`
   since this isn't order-scoped) — add:
   - a new `NotificationEvent.ADMIN_DIGIFLAZZ_RESYNC_ABORTED` entry in
     `packages/core/src/enums.ts` (model the doc comment on the
     `ADMIN_STALE_PAYMENT` entry a few lines above `NotificationEvent`'s
     closing brace — state what triggers it, what the payload carries,
     "admin DM not a channel post");
   - a new `enqueueAdminDigiflazzResyncAborted(db, args: { sharpChanges: number; consideredRows: number })`
     export in `notifications.ts`, following `enqueueAdminStalePayment`'s
     exact shape;
   - register the new event in `ADMIN_DM_EVENTS` in
     `packages/outbox-dispatcher/src/dispatcher.ts` (~line 86-96) so it
     routes as an admin DM, not a public channel post;
   - add a bilingual (id/en) template for it in
     `packages/outbox-dispatcher/src/templates.ts`, following the
     `ADMIN_STALE_PAYMENT` template right next to it as the shape to copy
     (interpolate `sharp_changes`/`considered_rows` as plain numbers — no
     HTML-unsafe content here, but check whether the template renderer
     HTML-escapes by default and match the sibling template's escaping
     approach either way).
   Return early from `resyncDigiflazzCatalog` in this case — same
   `{ updated: 0, deactivated: 0 }` shape the function already returns for
   its other early-return case (`!creds`), so the cron's caller
   (`apps/order-bot/src/jobs/index.ts:1380-1390`,
   `scheduleDigiflazzCatalogSync`) needs no changes.
3. When the breaker does NOT trip, behavior is unchanged from today (existing
   per-row update loop, existing `digiflazz_catalog_resync` success audit
   entry when `updated > 0 || deactivated > 0`).

**Tests** (colocated `packages/db/src/crud/digiflazz.test.ts` — it already has
a `resyncDigiflazzCatalog`-adjacent `describe` block per the file's existing
structure; follow its `makeTestDb`/`buildSampleData`/`digiflazzMock` pattern,
same file the audit's testing-gaps section names as missing this exact
coverage):

- A resync where every mapped denomination's price would move sharply (e.g.
  6+ denominations, markup-implied new price collapses toward zero — same
  failure shape C-1 originally described) trips the breaker: no
  `Denomination.price`/`costPrice`/`isActive` write happens for any row
  (assert via a re-fetch showing all rows unchanged from their pre-run
  state), a `digiflazz_catalog_resync_aborted` audit row is written, and one
  `ADMIN_DIGIFLAZZ_RESYNC_ABORTED` `notificationOutbox` row is enqueued per
  admin (reuse this file's existing pattern for asserting admin fan-out,
  e.g. how `binance_internal.test.ts` asserts `ADMIN_OVERPAID` row count
  against a configured `ADMIN_IDS`).
- A normal resync (a handful of denominations, price changes within the
  ±50% band, or fewer than 5 would-reprice rows even if some individually
  exceed the band) proceeds exactly as before — asserts the existing
  `{ updated, deactivated }` return shape and that no
  `_aborted` audit entry or alert is written.
- A resync with zero denominations to reprice (empty `mapped`, or all
  `priceOverridden: true`) does not trip the breaker (nothing to compare)
  and behaves as today.

Self-review before committing: confirm
`pnpm exec vitest run packages/db/src/crud/digiflazz.test.ts packages/db/src/crud/notifications.test.ts packages/outbox-dispatcher/src/dispatcher.test.ts packages/outbox-dispatcher/src/templates.test.ts`
is green, and run `pnpm typecheck` (the new `NotificationEvent` member and
`Db`-typed helper touch several packages' type surfaces).

---

## Task 11: Read-side role gate on credential/export routes (web-admin C-1)

**Finding:** `docs/audit-backend-2026-08-21.md` §2 Critical C-1. The `readonly`
web-admin role — the default for every newly-created admin
(`apps/web-admin/src/routes/api/admins.ts:64`) — can currently read every
unsold account credential and every CSV export, because
`apps/web-admin/src/plugins/auth.ts`'s `roleGate` (the RBAC check) only runs
as part of `csrfProtect`, which by design ("reads are open to every
authenticated admin; only mutations are gated", `auth.ts:53`) is never
attached to a `GET` route. Five routes are affected, all currently guarded
only by `currentAdmin` (auth, no role check):

- `apps/web-admin/src/routes/api/stock.ts:93` — `GET /api/stock/:productId`
  (returns `credentials` on every stock item unconditionally, line 113)
- `apps/web-admin/src/routes/api/stock.ts:280` — `GET /api/stock/:productId/download`
  (plaintext credential dump)
- `apps/web-admin/src/routes/api/orders.ts:160` — `GET /api/orders/export`
- `apps/web-admin/src/routes/api/users.ts:153` — `GET /api/users/export`
- `apps/web-admin/src/routes/api/settings.ts:412` — `GET /api/settings/export`

**Decision (made by the human, do not revisit):** gate these five specific
routes so `readonly` is refused; do not change what role new admins default
to, and do not touch `GET /api/stock/export` (the aggregate stock-health CSV
at `stock.ts:63`, which carries no credentials and is explicitly out of
scope — the audit only flagged the two credential-bearing stock routes plus
the three cross-domain exports).

**Fix, in `apps/web-admin/src/plugins/auth.ts`:**

Add a new preHandler array alongside the existing `csrfProtect`/`requireSuper`
(model it directly on `requireSuper` at lines 117-124 — same two-step shape:
`currentAdmin` first, then a role check that 403s with a short plain-text
message): e.g. `requireReadableByRole` or `blockReadonlyReads` (pick a name
that reads clearly at each of the five call sites below — `requireSuper`'s
naming pattern, `require<Constraint>`, is the sibling to match). The check
should reject only `role === "readonly"` — `support` and `super` both keep
today's unrestricted read access to these five routes (the audit's chosen
remedy is "gate the specific routes", not "make these super-only" — narrower
than `requireSuper`). Reuse the same 403 response shape `roleGate` already
uses (`reply.code(403).type("text/plain").send(...)`) with a message
appropriate to a read denial (not "Insufficient permissions for this
action" — that phrasing implies a mutation was attempted; write a message
that reads correctly for a blocked GET).

Then swap `preHandler: currentAdmin` for the new array on exactly the five
routes named above, in their four files (`stock.ts` ×2, `orders.ts`,
`users.ts`, `settings.ts`). Every other `GET` route in all five files (the
per-domain list pages, the non-credential-bearing stock read, etc.) is
unaffected and keeps `currentAdmin` alone.

**Tests:** each of the four route files already has a corresponding test
file (grep for `stock.test.ts`, `orders.test.ts`, `users.test.ts`,
`settings.test.ts` under `apps/web-admin/test/` — read one to find the
existing pattern for asserting a role-gated response, likely already present
for the `POST`/`csrfProtect` routes in the same file; mirror that pattern for
role, not CSRF). For each of the five routes: a `readonly`-session request
gets `403`; a `support`-session and a `super`-session request each still get
the same `200` + body shape they got before this change (regression guard —
don't accidentally narrow `support`'s access, which was NOT part of this
finding). Confirm via a re-read of `apps/web-admin/src/auth.ts`'s `WebRole`
type/session-building helpers (or the existing test files' setup) how tests
in this repo construct a session with a specific role — do not invent a new
mechanism if one already exists.

Self-review before committing: confirm
`pnpm exec vitest run apps/web-admin/test/stock.test.ts apps/web-admin/test/orders.test.ts apps/web-admin/test/users.test.ts apps/web-admin/test/settings.test.ts`
(adjust paths if the actual test file locations differ from this guess — find
them first) and `pnpm typecheck` are green.

---

## Task 12: Live re-verification + order-kind check on the Digiflazz webhook (I-1/I-4)

**Finding:** `docs/audit-backend-2026-08-21.md` §2 Important I-1 + §1 Important
I-4. `apps/storefront/src/routes/checkout.ts:1272-1325` (`POST
/pay/digiflazz/callback`) trusts the callback body's `status`/`sn` once the
signature (`verifyDigiflazzCallback`,
`packages/core/src/suppliers/digiflazz.ts:298-316`) checks out. That signature
formula (`md5(refId + ":" + secretKey)`) does not bind `status`, and per this
codebase's own design comment (`digiflazz.ts:298-316`'s doc comment on
`verifyCallback`, and the client generally) there is no separate live status
inquiry the way TokoPay/PayDisini have — so a callback observed once (a
logging proxy, a TLS-inspecting appliance, a leaked access log) is a
forgeable, non-expiring token: replaying it with `status: "Sukses"` and any
`sn` would auto-deliver the order. **Secondary:** the handler also never
confirms the order it looked up by `refId` is actually a Digiflazz-routed
order before calling `fulfillDigiflazzOrder` — a callback naming a
manually-fulfilled order that happens to be `PROCESSING` would wrongly
deliver it too.

**The fix does NOT invent a new Digiflazz API.** This client's own
`createTransaction` (`packages/core/src/suppliers/digiflazz.ts:248-276`) is
already documented as idempotent by `refId`: *"a repeat call with the same
`refId` returns the existing transaction rather than creating a new one"*
(doc comment, lines ~240-247). That means calling `createTransaction` again
with the SAME `refId`/`buyerSkuCode`/`customerNo` the original dispatch used
IS a live status re-check — exactly the "use that amount rather than the
callback body's" pattern the other three gateways already use (per the
audit's own framing), built entirely from a function this codebase already
calls elsewhere for exactly this SKU/order. Do not add any other new
supplier-facing call.

**Fix, part A — shared item-resolution helper (`packages/db/src/crud/digiflazz.ts`):**

`dispatchPendingDigiflazzOrders` (lines 219-268) already contains the exact
rule the webhook handler now also needs: find the order's Digiflazz-routed
item(s), and refuse (as a "needs manual review" case, not a crash) unless
there is EXACTLY ONE such item at quantity 1 (the N1 defense-in-depth
comment at lines 246-259 explains why). Extract this into one exported
function both call sites use, e.g.:

```ts
export type DigiflazzItemResolution =
  | { ok: true; supplierSku: string; product: { additionalFields: string | null } }
  | { ok: false; reason: string };

export function resolveSingleDigiflazzItem(order: {
  items: { quantity: number; product: { supplierSku: string | null; additionalFields: string | null; autoDeliverySource: string | null } }[];
}): DigiflazzItemResolution
```

(Adjust the exact shape/name if a cleaner one occurs to you once you're
reading the real code — the important constraint is ONE function, reused by
both `dispatchPendingDigiflazzOrders` and the webhook handler, expressing
this rule exactly once.) Update `dispatchPendingDigiflazzOrders` to call it
instead of its current inline `digiflazzItems`/`item` logic (lines 238-268),
preserving its existing alert-and-count-as-`failed` behavior for the
`{ ok: false }` case exactly as today (same `alertDigiflazzDispatchFailed`
call, same `reason` text shape).

**Fix, part B — `fulfillDigiflazzOrder` order-kind guard
(`packages/db/src/crud/digiflazz.ts:328-366`):** before the atomic
`PROCESSING -> DELIVERED` claim, call `resolveSingleDigiflazzItem` on
`order.items` (the `getOrder` include already carries `product` per item —
confirm the fields `resolveSingleDigiflazzItem` needs are present in
`fullInclude`, and widen the include if not) and throw a `ValidationError`
(matching this function's existing error style, e.g. a new
`error.order_not_digiflazz` i18n key alongside the existing
`error.order_not_found`/`error.order_not_processing`) when it's not `ok`.
This makes `fulfillDigiflazzOrder` itself refuse to deliver a non-Digiflazz
order regardless of caller — the single-choke-point fix the audit's own
"push each rule into one shared helper every surface is forced to call"
recommendation asks for, protecting every current AND future caller, not
just the webhook.

**Fix, part C — live re-verification in the webhook handler
(`apps/storefront/src/routes/checkout.ts:1272-1325`):** after
`verifyDigiflazzCallback` passes and the order is found (existing lines
1283-1290, unchanged), before branching on `cb.status`:

1. Call `resolveSingleDigiflazzItem(order.items)` (imported from
   `@app/db`, alongside the existing `getDigiflazzCreds`/`fulfillDigiflazzOrder`
   import). If not `ok`, log a `logger.warn` (count/reason only, e.g.
   `` `Digiflazz callback for order ${order.orderCode} but it isn't a
   single-item Digiflazz order (${resolution.reason}) — ignoring` `` — do
   NOT call `fulfillDigiflazzOrder` or `alertDigiflazzDispatchFailed` here,
   since this branch means the callback itself is suspect/mismatched, not
   that a legitimate dispatch failed) and `return reply.send({ status:
   "unmatched" })` — same shape as the existing "unknown order ref" branch a
   few lines above.
2. Recompute `customerNo` via `buildDigiflazzCustomerNo(resolution.product,
   order.customerData)` (same helper `dispatchPendingDigiflazzOrders` already
   uses, already exported from `packages/db/src/crud/digiflazz.ts`).
3. Call `createTransaction(creds, { refId: cb.refId, buyerSkuCode:
   resolution.supplierSku, customerNo })` — `creds` is already in scope
   (fetched a few lines above via `getDigiflazzCreds`). Wrap this in its own
   try/catch: on failure (network error, timeout, malformed response — same
   failure modes `dispatchPendingDigiflazzOrders`'s own try/catch at lines
   296-307 already handles), log a `logger.warn` naming the order code and
   error message (never the raw error body — same credential-scrubbing
   guarantee `fetchDigiflazzJson` already provides) and `return reply.send({
   status: "ok" })` without taking any delivery action — leave the order
   PROCESSING for a future callback or the next poller tick, exactly like
   the existing "unrecognised status treated as Pending" philosophy
   elsewhere in this client.
4. Branch on the FRESH `result.status` from step 3 — NOT `cb.status` — using
   the exact same three-way logic the handler already has (`"Sukses"` →
   `fulfillDigiflazzOrder(prisma, order.id, { sn: result.sn ?? "" })` wrapped
   in the existing race-tolerant try/catch; `"Gagal"` →
   `alertDigiflazzDispatchFailed` with `result.message` instead of
   `cb.message`; anything else → no action, matching the existing "Pending
   needs no action" comment). `cb` itself is now used ONLY to authenticate
   that some signed request named this `refId` and to look up the order —
   never again to decide what to actually do.

**Tests:**

- `packages/db/src/crud/digiflazz.test.ts`: `resolveSingleDigiflazzItem`
  covers the three shapes `dispatchPendingDigiflazzOrders`'s existing inline
  logic already implicitly covers (no Digiflazz item, exactly one at
  quantity 1 → `ok: true`, quantity > 1, more than one Digiflazz line) —
  reuse/adapt whatever existing tests already exercise
  `dispatchPendingDigiflazzOrders`'s N1 defense rather than writing new
  fixtures from scratch if suitable ones exist. `fulfillDigiflazzOrder`
  gains one new test: called against an order whose item is NOT
  Digiflazz-routed (`autoDeliverySource` unset/different) throws, and the
  order's status is unchanged (still whatever it was, not `DELIVERED`).
- `apps/storefront/test/digiflazz-webhook.test.ts`: this file has NO
  supplier-HTTP mock today (the current implementation never calls
  `createTransaction`) — you'll need to add one. Model it on
  `packages/db/src/crud/digiflazz.test.ts`'s
  `vi.hoisted(() => ({ createTransaction: vi.fn(), ... }))` +
  `vi.mock("@app/core/suppliers/digiflazz", ...)` pattern (spread
  `importOriginal` so `verifyCallback`/`parseProductRegion`/etc. stay real —
  only `createTransaction` needs mocking). New/changed cases:
  - A validly-signed `Sukses` callback whose live re-check (mocked
    `createTransaction`) ALSO returns `Sukses` still delivers the order
    (regression guard — the existing "happy path" test must keep passing
    with the new re-check wired in).
  - A validly-signed `Sukses` callback whose live re-check returns `Pending`
    (simulating a stale/replayed callback that no longer reflects reality)
    does NOT deliver the order — order stays `PROCESSING`.
  - A validly-signed callback for an order that ISN'T Digiflazz-routed (e.g.
    a plain manual order, still `PROCESSING`) returns `{ status: "unmatched"
    }` and does not call `createTransaction` or change the order.
  - The live re-check throwing (mocked `createTransaction` rejects) leaves
    the order `PROCESSING` and the route still responds `200`.

Self-review before committing: confirm
`pnpm exec vitest run packages/db/src/crud/digiflazz.test.ts apps/storefront/test/digiflazz-webhook.test.ts apps/order-bot/test/*digiflazz*`
(adjust the order-bot glob to whatever actually exercises
`dispatchPendingDigiflazzOrders` today — find it first, since Part A changes
that function's internals and its existing tests must still pass unmodified
in behavior) and `pnpm typecheck` are green.

---

## Task 13: Alert admins + flag UNDERPAID on the three QRIS/IDR reconcile pollers (I-5)

**Finding:** `docs/audit-backend-2026-08-21.md` §3 Important I-5. Three of six
payment reconcile pollers —
`apps/order-bot/src/payments/tokopayReconcile.ts:189-193`,
`paydisiniReconcile.ts:187-193`, `nowpaymentsReconcile.ts:223-227` (exact line
numbers approximate — find the `status.amount.lessThan(...)` branch in each,
labeled `// Paid but short — never deliver on an underpayment; leave for
manual review.`) — treat an underpayment as a `logger.warn` and nothing else:
no order-status change, no ledger/DB row, no admin alert. The order silently
sits `PENDING_PAYMENT` until it auto-cancels, while the buyer's money sits at
the gateway with no human ever told. The three crypto rails
(`packages/db/src/crud/binance_internal.ts`'s `markUnderpaid`, and its
Bybit/Bybit-BSC siblings `markUnderpaidBybit`/`markUnderpaidBybitBsc`) already
do this correctly: flip the order to `OrderStatus.UNDERPAID` (atomically,
idempotent against a race) and alert every admin with the amounts. This task
extends that same pattern to the three IDR rails.

**Fix, part A — one shared crud helper** (new export in
`packages/db/src/crud/orders.ts`, alongside the other order-mutation helpers
— or `orderStatus.ts` if that reads as the better home once you're in the
file; your call, but ONE function, not three copies):

Unlike the crypto pollers (which scan a blockchain and need a separate
per-gateway ledger table — `processed_binance_tx` etc. — to dedupe deposits
across polling cycles with no natural "already handled" marker), each of
these three reconcile pollers re-checks the SAME `order.id` every cycle via
its gateway's `checkTransaction`-equivalent — so the order's own status IS
the natural idempotency guard, and no new ledger table is needed. Build on
the already-existing `tryTransitionOrderStatus` (`packages/db/src/crud/orderStatus.ts:135-146`
— same file `transitionOrderStatus`/`LEGAL_TRANSITIONS` already lives in;
`PENDING_PAYMENT -> UNDERPAID` is already a legal transition, proven by the
crypto rails using it today) inside one `$transaction` alongside an
`Order.adminNote` write, mirroring `binance_internal.ts`'s `markUnderpaid`
(lines 611-639) for the transaction shape and `adminNote` wording
(`` `[underpaid] received ${amount} via ${gateway}, expected ${expected}` ``,
adjusted to name the gateway generically since this one function serves all
three rails, not one). Returns `boolean` — `true` if this call actually
performed the transition (write the note + alert), `false` if the order had
already left `PENDING_PAYMENT` (a race with a delivery, cancellation, or a
previous cycle already having flagged it — treat as a no-op, exactly how the
crypto rails already treat their own idempotent-`false` case).

**Fix, part B — wire it into all three reconcile files:** in each of
`tokopayReconcile.ts`, `paydisiniReconcile.ts`, `nowpaymentsReconcile.ts`,
replace the current `logger.warn(...); return "ok";`/`continue;` underpaid
branch with: call the new shared helper; if it returns `true`, keep the
existing `logger.warn` (unchanged wording) AND call that file's own
already-defined local `alertAdmins(api, text)` helper (each file has one —
`tokopayReconcile.ts:151`, similarly in the other two) with a message in the
same shape the crypto rails already use (`binanceInternal.ts:555-558`):
`` `⚠️ Underpaid order <code>${order.orderCode}</code>\nReceived
<b>${receivedAmount}</b>, expected <b>${expectedAmount}</b> (<gateway
name>).` ``. Keep the function's existing `return "ok"`/`continue` control
flow exactly as today — only what happens inside the branch changes.

**Tests:** each of the three reconcile files should already have a
`*.test.ts` — find it via the existing `reconcileOrder`/equivalent test
suite for each rail (grep for `apps/order-bot/test/*tokopay*`,
`*paydisini*`, `*nowpayments*`, or check `apps/order-bot/src/payments/` for
colocated tests) and add, per rail:

- An underpaid gateway response now flips the order to `UNDERPAID` (assert
  via a re-fetch) and calls the mocked bot API's `sendMessage` (however the
  existing test suite already asserts `alertAdmins` fired for another branch
  in the same file — e.g. the delivery-failure alert at
  `paydisiniReconcile.ts:226`/`nowpaymentsReconcile.ts:310` — mirror that
  exact assertion pattern).
- A second reconcile cycle against the same now-`UNDERPAID` order (simulating
  the poller's next tick before a human resolves it) does NOT alert a second
  time and does NOT throw (idempotent no-op — the shared helper returns
  `false`).

Add one test for the new shared crud helper itself (colocate with
`orders.test.ts` or `orderStatus.test.ts`, whichever already covers
`tryTransitionOrderStatus`): calling it twice for the same order applies the
transition exactly once, second call returns `false` and makes no additional
write.

Self-review before committing: confirm
`pnpm exec vitest run packages/db/src/crud/orders.test.ts packages/db/src/crud/orderStatus.test.ts`
plus whichever three order-bot test files actually cover
`tokopayReconcile`/`paydisiniReconcile`/`nowpaymentsReconcile` (find their
real paths first) are green, and `pnpm typecheck` passes.

---

## Task 14: Exclude wallet-topup orders from `reconcileFinances`'s order-drift check (I-1)

**Finding:** `docs/audit-backend-2026-08-21.md` §1 Important I-1.
`packages/db/src/crud/reports.ts:28-30`'s order-drift query
(`reconcileFinances`) has no `kind` filter — it loads every non-cancelled
`Order` regardless of `kind`, then (further down the same function, past
line 30) compares each one's actual paid amount against an expected-amount
formula that assumes the FX-conversion rules `PRODUCT` orders follow.
`OrderKind.WALLET_TOPUP` orders (`packages/core/src/enums.ts:194`) are
deliberately never FX-converted, so every wallet top-up order in the shop
guarantees a false-positive drift entry on every single `reconcileFinances`
run — burying any genuine drift (the entire point of this function) in
permanent noise.

**Fix:** add `kind: OrderKind.PRODUCT` to the `where` clause of the query at
`reports.ts:28-30` (import `OrderKind` alongside the existing `OrderStatus`
import at the top of the file). This is the audit's first suggested option
("filter to `kind: PRODUCT`") — simpler and safer than branching the
expected-amount formula on kind, since this function doesn't currently have
any topup-specific drift check to fall back on, and inventing one is out of
scope here. `WALLET_TOPUP` orders are simply excluded from this particular
drift check (not from `reconcileFinances` findings generally — `voucher_drift`
and `negative_wallets`, the other two sections of this function, are
unaffected and don't need a `kind` filter — don't touch them).

**Tests** (colocated `reports.test.ts` — find the existing
`reconcileFinances`/`order_drift` test coverage as your model):

- A `WALLET_TOPUP` order whose actual paid amount would, under the
  `PRODUCT`-shaped expected-amount formula, look like drift (i.e. exactly
  the false-positive shape I-1 describes) now produces NO `order_drift`
  entry for that order.
- A genuinely drifted `PRODUCT` order still produces an `order_drift` entry
  exactly as before (regression guard — don't accidentally suppress real
  drift).
- `voucher_drift` and `negative_wallets` findings are unaffected by a
  `WALLET_TOPUP` order existing in the DB (they were never filtered by kind
  and shouldn't be now either).

Self-review before committing: confirm
`pnpm exec vitest run packages/db/src/crud/reports.test.ts` and `pnpm typecheck`
are green.

---

## Task 15: Health watchdog for the outbox dispatcher (I-3)

**Finding:** `docs/audit-backend-2026-08-21.md` §3 Important I-3. All six
payment reconcile pollers have a heartbeat-based health watchdog (see
`apps/order-bot/src/jobs/index.ts:820-863`'s shared `pollWatchdog`, wrapped
per-rail by `binancePollWatchdog`/`tokopayPollWatchdog`/etc., each reading a
heartbeat written by `packages/db/src/crud/poll_health.ts`'s
`recordPollHealth`) — a stale/failing poller pages admins. The outbox
dispatcher (`packages/outbox-dispatcher/src/dispatcher.ts`'s `runDispatcher`
loop) is the sole delivery path for every buyer credential DM and every admin
alert this whole codebase enqueues, and has NO equivalent: it never writes a
heartbeat, so a bad notifier token or an unhandled exception class silently
stops all Telegram delivery with nothing but one `logger.error` line per tick
— no admin is ever told, because the only channel that would tell them (the
outbox itself) is the thing that's broken.

**Fix, part A — record a heartbeat (`packages/db/src/crud/poll_health.ts` +
`packages/outbox-dispatcher/src/dispatcher.ts`):**

1. Add `outbox: "outbox_dispatcher_poll_health"` to `POLL_HEALTH_KEYS`
   (`poll_health.ts:24-31`) — this is the only change needed in that file;
   `PollRail`, `getPollHealth`, `recordPollHealth` are already generic over
   any key in `POLL_HEALTH_KEYS` and need no further changes.
2. `drainBatch` (`dispatcher.ts:207`) currently returns `void`. Change it to
   return the number of rows it saw this cycle (`pending.length`, from the
   existing `const pending = await fetchPendingNotifications(prisma, 50);`
   near the top) — a small, non-invasive change; every existing internal
   `continue`/`return` inside the function's loop is unaffected, only the
   final implicit return needs a value. Check `dispatcher.test.ts` for any
   existing call site asserting `drainBatch`'s return is `undefined` and fix
   it if so (unlikely, but verify).
3. In `runDispatcher`'s loop (`dispatcher.ts:194-204`), call
   `recordPollHealth(prisma, "outbox", { lastTxCount: <count>, success: true })`
   right after a successful `await drainBatch(bot)`, and
   `recordPollHealth(prisma, "outbox", { lastTxCount: 0, success: false, error: String(e).slice(0, 300) })`
   inside the existing `catch (e)` block (300-char truncation matches this
   repo's own convention, documented in
   `packages/core/src/payments/pollHealth.ts:56-63`'s `LAST_ERROR_DISPLAY_MAX`
   comment — the poller-side truncation this display logic already expects).
   Import `recordPollHealth` from `@app/db`.

**Fix, part B — the watchdog itself
(`apps/order-bot/src/jobs/index.ts`):**

Add one more rail wrapper following the exact shape of
`tokopayPollWatchdog`/etc. (lines 865-942 are your model): a new function
`outboxDispatcherPollWatchdog(api: Api): Promise<void>` that calls the
shared `pollWatchdog(api, { label: "Outbox dispatcher", alertKey: <a new
settings key, e.g. "outbox_watchdog_alerted">, isEnabled: async () => true,
readHealth: () => getPollHealth(prisma, "outbox"), impact: <write a sentence
naming what actually breaks: every buyer credential DM AND every admin alert
stop being delivered — this is more severe than any single payment rail's
impact text, say so plainly> })`. `isEnabled` is `async () => true` — always
armed — for a reason spelled out in Part C below; don't try to detect
"is a notifier token configured" from this module, that check lives in
`apps/server`, not `apps/order-bot/jobs`.

**Fix, part C — where to SCHEDULE it (`apps/server/src/index.ts`) — read
this carefully, it's the part most likely to go wrong:**

Do **NOT** add this watchdog's `Cron` registration inside `scheduleJobs`
(`apps/order-bot/src/jobs/index.ts`) the way the other six are registered.
Reason: `scheduleJobs` is called from BOTH `apps/server/src/index.ts` (the
combined web+bot process, where `runDispatcher` actually runs via
`startNotifier`) AND `apps/order-bot/src/main.ts` (the standalone bot-only
binary, line 294 — grep to confirm) — and the standalone binary NEVER calls
`runDispatcher`/`startNotifier` at all (only `apps/server/src/index.ts`
does, via its own `startNotifier` at line ~179-203). If the outbox watchdog
cron lived inside `scheduleJobs`, the standalone binary would page admins
forever with "the outbox dispatcher has never completed a cycle" — a
permanent false alarm in a topology where the dispatcher isn't supposed to
run at all.

Instead: export a new `scheduleOutboxDispatcherWatchdog(api: Api): Cron`
from `apps/order-bot/src/jobs/index.ts` (same shape as the file's other
`schedule*` exports, e.g. `scheduleFxRefresh` — a thin `new Cron(...)`
wrapper around the Part B function, `{ protect: true }` like every other
watchdog cron per this file's own M-26 comment). In
`apps/server/src/index.ts`'s `start()`, call it **inside the same `if (bot)`
block that already calls `jobs = scheduleJobs(bot.api);`** (around line 284
— read the surrounding block to find the exact right spot), appending its
Cron to the same `jobs` array so it gets `.stop()`ed on shutdown like every
other job (`jobs.forEach(job => job.stop())` at line ~381). This guarantees
the watchdog is only ever scheduled in the exact process/branch where `bot`
is truthy — which, by `startNotifier`'s own logic (`!dedicated && !mainBot`
→ early return, otherwise it proceeds), is also exactly the condition under
which the dispatcher itself is guaranteed to actually run. Pick an unused
offset-second for the cron expression (every 2 minutes, its own distinct
second, following the sibling comment at `jobs/index.ts:1436-1445` about why
the six existing watchdogs are staggered across different seconds — e.g.
`"21 */2 * * * *"` if seconds 15/17/19 are already taken by the QRIS three
and 0 by the crypto three; verify against the real file before picking).

**Tests:**

- `packages/outbox-dispatcher` test suite (`dispatcher.test.ts`): after a
  successful `drainBatch`/`runDispatcher` cycle, `getPollHealth(prisma,
  "outbox")` reflects `success: true`-shaped fields (non-null `lastRun`);
  after a cycle that throws (force `fetchPendingNotifications` or similar to
  reject, matching however this file already injects a failure for its
  existing error-path tests), the heartbeat reflects the failure and the
  loop does not crash (already-existing behavior, just add the heartbeat
  assertion on top).
- `apps/order-bot`'s jobs/watchdog test coverage (find wherever
  `tokopayPollWatchdog`/`pollWatchdogDecision` is already tested — mirror its
  structure exactly): `outboxDispatcherPollWatchdog` pages admins once when
  the heartbeat is stale/never-run, and clears the alert flag on recovery,
  same two cases every existing rail's watchdog test already covers.
- `apps/server`: only if this repo already has an existing test asserting
  which Crons get registered when a bot exists (grep for one before writing
  a new one) — if no such test infrastructure exists for the other
  `schedule*` calls in `start()`, don't invent one for this task; note that
  in your report instead of overbuilding test scaffolding beyond this
  repo's existing pattern.

Self-review before committing: confirm
`pnpm exec vitest run packages/outbox-dispatcher packages/db/src/crud/poll_health.test.ts`
plus whichever order-bot test file covers the watchdog wrappers are green,
and `pnpm typecheck` passes (this touches three packages' type surfaces:
`@app/db`, `@app/outbox-dispatcher`, `@app/order-bot`/`apps/server`).
