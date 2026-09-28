# Backend Audit — Full Pass, `storefront-topup-game` worktree

**Date:** 2026-08-21
**Scope:** `packages/core`, `packages/db`, `apps/web-admin/src` (server, not the React
client), `apps/storefront/src` (server, not the React client), `apps/order-bot`,
`apps/server`, `packages/outbox-dispatcher`. ~55,000 lines of backend source, including
the full Digiflazz Top Up Game feature (region-split import, instant-buy checkout,
auto-fulfillment poller, webhook) that landed in this worktree since the prior audit.
**Nature:** READ-ONLY — no code was changed during this audit. Findings are for review
and prioritization before any fix lands.
**Baseline:** `pnpm typecheck` clean across all 9 workspaces; `pnpm test` green
(317 files / 5,018 tests) as of commit `93f4995`.
**Methodology:** 3 parallel agents, each covering a disjoint slice of the backend
(core+db; the two Fastify server layers; the Telegram bot + process orchestration +
outbox dispatcher). Each was required to read `docs/audit-backend-2026-07-31.md` first
and report only genuinely new issues or regressions, noting explicitly what from that
audit is now fixed vs. still open. Every Critical below was independently traced to
source by its agent, not inferred.

## Executive summary

| Severity | Count |
|---|---|
| Critical | 3 |
| Important | 22 |
| Minor | ~35 |

### The good news first: remediation from the prior audit is real

Every High from `docs/audit-backend-2026-07-31.md` reachable in this pass's scope is
**fixed and independently re-verified against source** — not just marked fixed. That
includes H-1 (TokoPay fee-base mismatch), H-2 (`canCredit`/`canReject` asymmetry), H-3
(claim consumed on failed delivery), H-4 (bcrypt hash/email leakage — closed via
`USER_SELECT`/`ORDER_USER_SELECT`/`SEARCH_USER_SELECT`/`REVIEW_USER_SELECT`
projections), H-5 (`/setup/restart` auth), H-6 (restock-subscription consumption order),
H-7 (flash-sale broadcast transaction), plus a long tail of Mediums and Lows
(M-1/2/3/5/7/8/16/17/18/19/20/21/22/24/25/26/27/28/30/31/32/33/34/36). Full detail is
in each section below.

**Every remaining Critical and most Important findings share one shape**, named
independently by all three audit agents without prompting: *a rule gets correctly
implemented on one surface, and the newest or least-visible sibling surface never gets
it.* Buyability logic (storefront vs. bot), underpayment handling (crypto rails vs. QRIS
rails), webhook re-verification (three payment gateways vs. the new Digiflazz rail),
read-side RBAC (mutations vs. reads), input validation (wallet/voucher vs.
catalog/flash-sale). The structural fix recommended throughout is the same: push each
rule into one shared helper every surface is forced to call, rather than re-deriving it
per call site.

### Top items by impact

1. **[CRITICAL]** **Every manual-fulfillment SKU — including the entire Digiflazz Top Up
   Game catalog just built in this worktree — is unbuyable in the Telegram bot.** The
   "Buy Now" button is gated on `StockItem` row count, but manual/`manual_with_info`
   SKUs have no stock rows by design, so they always render as out-of-stock. This exact
   bug was already found and fixed one layer down (`showOrderConfirmation`), but the
   buyer can never reach that function through the keyboard. → order-bot §C-1
2. **[CRITICAL]** **The default `readonly` admin role can download every unsold account
   credential in the shop** (plus full order/user/settings CSV exports), because the
   role gate only runs on mutating requests, never on GET. The exact threat pattern the
   prior audit's H-4 fix addressed for password hashes, but the design gap that made it
   reachable was never revisited. → web-admin/storefront §C-1
3. **[CRITICAL]** **A malformed or partial Digiflazz price-list response silently zeroes
   out live storefront prices**, with no error and no alert — the hourly resync
   defaults an unparseable supplier price to `Decimal(0)` instead of rejecting the row,
   and the audit log reports the run as a clean success. → core+db §C-1
4. **[IMPORTANT]** The new Digiflazz payment webhook is the only one of four payment
   rails with no live re-verification against the supplier before marking an order
   delivered — a single observed callback is a permanent forgery token. → web-admin/storefront §I-1
5. **[IMPORTANT]** Three of six payment-reconciliation rails (the QRIS/IDR ones) treat
   underpayment as a log line with no admin alert and no visible order state, while the
   three crypto rails correctly flag and alert. → order-bot §I-5
6. **[IMPORTANT]** `importDigiflazzBrand` runs an unbounded, hundreds-of-queries import
   inside one `$transaction` with Prisma's default 5s timeout, against this repo's own
   "keep every transaction short" rule — risk of blowing the timeout and starving the
   single SQLite writer for every concurrent checkout. → core+db §I-2
7. **[IMPORTANT]** The outbox dispatcher — sole delivery path for every buyer credential
   DM and admin alert — is the only worker in the process with no health watchdog; a bad
   token or misconfiguration silently stops all Telegram delivery with no admin
   notification. → order-bot §I-3

---

## §1 — `packages/core` + `packages/db`

**Scope covered:** all crud files read in full (orders, digiflazz, vouchers, pricing,
stock, wallet_topup, wallet_checkout, revenue, orderStatus, audit, integrity, settings,
tokopay, referrals, credentials, users, catalog), `packages/core/src/{money, fx,
formatters, http, config, logger, deliveryFields}.ts`, `suppliers/digiflazz.ts`,
`payments/tokopay.ts`. Spot-checked the remaining gateway clients, `enums.ts`, schema.

### Strengths

- Every applicable prior High is genuinely fixed with a comment naming the finding it
  closes (`tokopay.ts:108`, `orders.ts:1089-1100`, `tokopay.ts:107-134`, `users.ts:38`,
  `notifications.ts:989`).
- `adjustWallet` (`users.ts:200-242`) is a correctly-designed money chokepoint: ledger
  row first, balance second, with the ordering rationale documented.
- `applyVoucherToSubtotal`'s zero-floor placement (`vouchers.ts:290-314`) is the
  strongest example in the codebase of a "why" comment earning its keep.
- No float money anywhere in these packages — repo-wide grep for `parseFloat`/
  `.toNumber()` on a money value returns zero hits.
- All raw SQL is confined to `crud/` and correctly parameterized (`Prisma.sql` +
  `Prisma.join`, or bound placeholders).
- `fetchWithTimeoutSafe` (`core/http.ts:95`) generalizes credential-leak protection into
  one helper every gateway client, including the new Digiflazz one, routes through.

### Issues

#### Critical

**C-1 — A malformed or partial Digiflazz price-list response silently rewrites the
shop's sell prices to zero, unattended, on the hourly sync.**
`packages/core/src/suppliers/digiflazz.ts:126,332-343` →
`packages/db/src/crud/digiflazz.ts:671-688`

`toPriceListItem` maps `price: toDecimalOrZero(d.price)` — any unparseable or absent
`price` field becomes `Decimal(0)`, not a skipped/errored row. `resyncDigiflazzCatalog`
then applies the markup rule to that zero with no sanity check, and
`applyDigiflazzMarkup(0, …)` returns 0 for every markup type — so every non-overridden
Digiflazz denomination gets `price = 0`. The storefront's `price: { gt: 0 }` filter then
makes the product vanish with no error and no alert; the audit row reports
`"Resynced N Digiflazz price(s)"` as a success. The supplier client's own comment admits
its wire format "has not been verified against a live account" — a field rename or
partial outage is enough to trigger this.

The same path also admits non-finite values: `new Decimal("NaN")` constructs
successfully, and `collapseToCheapestSeller`'s `.lessThan()` comparison is `false` for
NaN, so a NaN row can win the cheapest-seller collapse and persist as `NaN` via
`quantizeMoney`.

*Fix:* reject rows with a non-finite or non-positive price instead of defaulting to
zero; add a blast-radius circuit-breaker to `resyncDigiflazzCatalog` (abort + alert if
>X% of rows would change by >Y%).

#### Important

- **I-1 — Every USDT wallet top-up is permanently reported as order drift by
  `reconcileFinances`.** `reports.ts:28-30` has no `kind` filter, so top-ups (which are
  deliberately never FX-converted) are compared against an FX-converted expectation —
  guaranteed false-positive drift on every run, burying any genuine drift in the noise.
  *Fix:* filter to `kind: PRODUCT` or branch the expected-amount formula on kind.
- **I-2 — `importDigiflazzBrand` runs an unbounded import inside one untimed
  `$transaction`**, against this repo's own "keep `$transaction` short" rule (the
  sibling `splitMixedDigiflazzProducts` explicitly documents doing the opposite, one
  transaction per product). A 60-SKU brand import is ~300-500 serialized queries
  (`ensureUniqueSlug`'s unbounded collision loop is the main cost) inside one exclusive
  SQLite write lock — risk of a 5s timeout rollback and starving every concurrent
  checkout for the duration.
- **I-3 — `bulkSetPrices` writes a raw caller-supplied string straight into
  `Denomination.price` with no quantization or validation** (`catalog.ts:438-443`) —
  the weakest price-write path in the codebase; `"NaN"`, `"-5000"`, or a 12-decimal
  value all persist verbatim. The sibling `update*` helpers (`updateDenomination`,
  `updateCatalogProduct`, `updateCategory`) take an untyped `Record<string, unknown>`
  and forward it unexamined — a mass-assignment hole at the one layer meant to own DB
  writes.
- **I-4 — The Digiflazz webhook signature binds only `ref_id`, not the outcome**
  (`digiflazz.ts:298-316`), and unlike TokoPay/PayDisini this client has no
  `checkTransaction`-equivalent to fall back on for a live re-check — see
  web-admin/storefront §I-1 for the full exploit chain.
- **I-5 — `DIGIFLAZZ_API_BASE` is the only gateway endpoint read straight from
  `process.env`**, bypassing the validated zod config schema every sibling client uses
  — a typo or stale env value sends the shop's live Digiflazz credentials to an
  arbitrary host, and the credential-scrubbing in `fetchWithTimeoutSafe` means the
  resulting error hides exactly where they went.
- **I-6 — Two unbounded full-table loads run on a cron and a page render:**
  `reconcileFinances` (every non-cancelled order + every wallet payment leg, in-memory,
  on a schedule) and `topProductsByMargin`/`profitSummarySince` (unbounded joined
  `OrderItem` scans, no `take`/`groupBy`) — the sibling `topProducts` was already fixed
  for this exact issue (M-33) but its two neighbors weren't.
- **I-7 — Inconsistent error contracts within `vouchers.ts`/`catalog.ts`**: some
  caller-correctable failures throw `ValidationError` (i18n key, user-facing), others
  throw bare `Error` (opaque 500, untranslated English) — forcing `bulkDeleteVouchers`
  to hand-duplicate guards it can't reuse via the single-item helper.

#### Minor (12 items, full detail in agent transcript — highlights)

- `retryNotification` still has no status guard (prior L-26, still open) — can re-send
  an already-delivered buyer DM.
- `PAYMENT_LEDGER_TABLES` boot-time drift check is missing tables from two feature waves
  (prior L-21, now wider).
- `upsertBulkPricing`'s percent guard is the one that never got the `.isFinite()` fix
  every sibling got.
- `REFERRAL_COMMISSION_PERCENT` is an unbounded coerced number with no range check — a
  `100` typo'd for `10` credits 10x commission with no guard on either side.
- Two unbounded in-memory caches with no eviction (`warmUserCache.ts`,
  `users.ts:745`'s `lastSeenTouchedAt`).

### Testing gaps (ranked)

1. `packages/core/src/deliveryFields.ts` (the authoritative server-side input validator,
   feeding a value forwarded to the Digiflazz supplier as `customer_no`) has no
   colocated test, while its non-authoritative client-side UX mirror does.
2. `packages/core/src/fx.ts` (money-adjacent rounding, feeds every USDT order's snapshot
   rate) has no test.
3. `reconciliation.test.ts` has no `WALLET_TOPUP` case — exactly why I-1 shipped.
4. `resyncDigiflazzCatalog`'s malformed-input branches (price `0`, absent, `"NaN"`,
   negative) are untested — no test would fail today if C-1 regressed or were fixed.

---

## §2 — `apps/web-admin` + `apps/storefront` (server-side)

**Scope covered:** both apps' `server.ts`, `auth.ts`, plugins, and every route file read
in full (storefront: checkout/api/apiCheckout/apiCart/apiTopup/apiAuth/apiAccount/
apiTrack/apiWalletTopup/apiPages/auth/cart/settings; web-admin: auth/setup/spaShell/
catalogPhoto/broadcastPhoto + api/settings/orders/users/payments/stock/storage/
digiflazzSync/search/admins). Spot-checked the remainder. Full route-and-guard
enumeration via grep across both apps. 44 server test files (~22k lines) inventoried.

### Strengths

- **Webhook auth is genuinely solid on all three established payment rails** — all
  verify before any DB write, all `timingSafeEqual`, all fail closed when credentials
  are unset, and both TokoPay and PayDisini now do a live server-to-server
  re-verification and use *that* amount rather than the callback body's (M-9 is
  genuinely closed).
- H-4 (hash/email leakage) is closed comprehensively, including both follow-ups the
  execution ledger had left open.
- "Never send Telegram from the web" holds exactly — verified by grep across both apps.
  The one file-proxy route deliberately streams bytes rather than redirecting,
  specifically so the bot token never reaches a client-visible header.
- No user input reaches a filesystem path, shell, or raw query string anywhere in either
  app; the CSV export even neutralizes formula injection on guest-supplied email.
- The Digiflazz instant-buy design (`apiTopup.ts`'s `adHocLine` parameter added to
  `computeTotals`) provably shares one pricing implementation with checkout rather than
  forking a second one — verified no cart read/write anywhere on either topup route, and
  a test asserts byte-identical totals against the cart-checkout preview.
- Rate-limit coverage is thorough and reasoned, including a deliberately *shared* quota
  between checkout/voucher-preview/topup-preview so an attacker can't reset the
  voucher-code oracle by alternating routes.

### Issues

#### Critical

**C-1 — The default `readonly` admin role can download every unsold account credential
in the shop.**
`apps/web-admin/src/routes/api/stock.ts:93-114,280-300`

Both the per-product stock read (returns `credentials`) and the plain-text bulk
credential download are guarded only by `currentAdmin` — the role gate lives
exclusively in `csrfProtect`'s `roleGate`, which by explicit design never runs on a GET
("reads are open to every authenticated admin; only mutations are gated"). Every new
admin defaults to `"readonly"` (`api/admins.ts:64`). The same design gap reaches
`GET /api/orders/export`, `/api/users/export`, and `/api/settings/export`.

Rated Critical on this repo's own precedent: the prior audit rated the identical threat
shape (readonly reading data it shouldn't) as blocking for bcrypt hashes, and credentials
are strictly more monetizable. The download is at least audited by count, so it leaves a
trail — but only after the fact. *This is a policy decision, not an oversight* — the
fix is either a read-side role gate on the credential/export routes specifically, or
changing what `readonly` defaults to.

#### Important

- **I-1 — The Digiflazz callback's signature does not bind `status`, and it's the only
  rail with no live re-confirmation.** `md5(refId + ":" + secretKey)` is identical for
  a `Pending`, `Gagal`, or `Sukses` body and never expires — a callback observed once
  (a logging proxy, a TLS-inspecting appliance, an access-log dump) is a permanent
  forgery token replayable with `status: "Sukses"` and any `sn`. `fulfillDigiflazzOrder`
  will then atomically deliver and DM the buyer. This is the same design the prior audit
  hardened for TokoPay and PayDisini with a live status re-check; Digiflazz's client has
  no such inquiry function to fall back on. **Secondary:** the handler doesn't check the
  order it found is actually Digiflazz-sourced before delivering — a callback naming a
  manually-fulfilled order in `PROCESSING` would wrongly mark it delivered too.
- **I-2 — Catalog/flash-sale/Digiflazz-sync price inputs accept NaN/Infinity, catalog
  additionally accepts negatives** — the exact bug class fixed for wallet/voucher inputs
  (prior M-3) reintroduced on three newer routes, verified empirically against this
  repo's decimal.js version. A NaN-priced denomination produces a permanently unpayable
  order that `reconcileFinances`'s own NaN-blind drift check can't detect either.
- **I-3 — Deactivating/archiving a Product doesn't cascade to its denominations**, so
  every buy path (cart, instant-buy, direct checkout) keeps accepting orders for a
  denomination whose parent was "turned off" — only the browse queries filter the
  parent. Archiving reads as a kill switch in the admin UI and isn't one.
- **I-4 — `POST /setup/restart` has no role gate or CSRF**, while its deliberate
  super-admin-only, CSRF-protected twin (`/api/settings/restart`) exists specifically to
  be the gated equivalent — any authenticated admin, `readonly` included, can reboot the
  single combined process on a loop. A partial regression introduced by the prior
  audit's own H-5 fix, which closed the unauthenticated hole but left the route more
  permissive than its sibling.
- **I-5 — `paydisini_userkey` (half of that rail's webhook signing material) isn't
  classified as a secret** — shown in plaintext to every admin, written into the
  settings export file, and interpolated into the audit-log `details` string, directly
  violating this repo's "never log secrets" rule in the log admins actually read.
- **I-6 — Five call sites do raw Prisma model access**, against the repo's hard rule
  (support ticket count, a payment-credit transaction, two duplicated `cartItem`
  aggregate calls that should be one shared helper, and a raw `$queryRaw` healthcheck
  where web-admin's equivalent correctly goes through the crud layer).
- **I-7 — `WEB_COOKIE_SECURE` defaults to `false`** with no boot-time check for the
  contradiction of an https public URL — both session cookies (30-day storefront
  sessions authenticating wallet balances) and the guest cart cookie inherit the default
  silently.

#### Minor (11 items — highlights)

- CSRF comparison in the upload route isn't constant-time and ignores the header form
  (prior L-12, still open).
- Photo-upload route leaks a product-existence oracle via 400-vs-403 differential (prior
  L-17, still open).
- SMTP test-connection errors echo the raw nodemailer error (server banner,
  host/port, username) to the admin (prior L-14, still open).
- Both logout routes mutate session state with no CSRF check (prior L-13, still open).
- `fulfillDigiflazzOrder`'s five writes run outside any transaction, unlike every
  sibling `deliverPaid*Order`.
- The unauthenticated account-nickname-check endpoint spends a metered paid API call per
  request with only a per-IP rate limit, no global ceiling.
- Both SPA shells do synchronous blocking `readFileSync` on every single page request
  instead of caching at module load.

### Testing gaps

No test asserts a `readonly` admin is refused any read (because none exist to assert —
this is why C-1 shipped); no Digiflazz-webhook test for rate limiting or wrong-order-kind
rejection; no test asserting the `Secure` cookie flag under a production-shaped config.
Everything else in the high-risk set (topup order flow, all three established
payment-webhook suites, guest checkout, rate limiting, settings security) is well and
behaviorally covered.

---

## §3 — `apps/order-bot` + `apps/server` + `packages/outbox-dispatcher`

**Scope covered:** `apps/server/src/index.ts`, the full outbox dispatcher, all cron/job
registrations, the bot's middleware/handlers/conversations for admin flows, the payment
poll loop and all reconcile pollers, in full. Checkout/customer/wallet-topup handlers
read substantially (all money-relevant branches). All 39 order-bot test files plus the
dispatcher's inventoried.

### Strengths

- `payments/pollLoop.ts` is the best-engineered file in this whole audit's scope: the
  next timer is armed before a cycle runs, a per-cycle abandon deadline releases the
  overlap guard, and an `isCurrent()` token prevents a zombie cycle from overwriting a
  fresher heartbeat — with an honest doc-comment admitting the guard narrows rather than
  fully closes the race.
- All 13 cron registrations carry the overlap-protect flag, deliberately offset onto
  distinct seconds with a comment tracing the choice to a real production incident
  (prior M-26 fully closed).
- Idempotency is layered, not assumed — a ledger UNIQUE claim, an order-status check,
  and an outbox-row-status check all have to agree, and the poller/webhook now share one
  ledger-key function so they collide on the same row instead of two disjoint ones.
- The outbox really is the sole web→Telegram path — zero grammY imports in either web
  app, verified by grep; a payment-settlement DM correctly orders itself against a
  bot-owned message bubble via a bounded, double-checked hook across the process
  boundary.
- No double-poller-registration risk — verified against both the module self-start guard
  and the actual Docker/package.json boot command.
- Admin gating is genuinely complete across all 10 admin conversations and every
  buyer-scoped read re-checks ownership — no auth bypass found.
- Money is Decimal end-to-end; the one `Number()` hit on an amount in the whole scope is
  a comment explaining why it was *removed*.

### Issues

#### Critical

**C-1 — Every manual/`manual_with_info` SKU — including the entire Digiflazz catalog —
is unbuyable in the Telegram bot.**
`apps/order-bot/src/keyboards/customer.ts:253,278-282`

The "Buy Now" button only renders when `availableStock > 0`, and `availableStock` counts
`StockItem` rows only. Manual SKUs have no stock rows by design (stated explicitly
elsewhere in this same codebase) — so every manual denomination always shows
"Notify me when back in stock" instead of a buy button, with no other path to purchase
it through the bot. Since `packages/db/src/crud/digiflazz.ts` imports every Digiflazz
SKU as `MANUAL_WITH_INFO`, **this branch's entire headline feature — every game top-up
— is dead in the bot**, presented to buyers as permanently out of stock.

This exact rule was already correctly fixed one layer down: `showOrderConfirmation` has
an `if (deliveryType === AUTO)` guard and a regression test explicitly titled for this
bug — but the buyer can never reach that function through the keyboard, so the test
passes green over a dead user-facing path. The correct rule already exists on two other
surfaces in this codebase (the storefront SPA shell, and `lowStockDenominations` in
crud) — it just never made it into the bot's keyboard/quantity-selection code, which has
four separate call sites making the same wrong assumption.

*Fix:* thread `deliveryType` into `denominationDetailKb` and the three sibling call
sites (`qtyInputStart`, `qtyChange`, the plan-picker line renderer) so non-AUTO always
counts as purchasable. Add a browse-path regression test (not one that calls
`showOrderConfirmation` directly) asserting a buy button renders for a MANUAL_WITH_INFO
denomination.

#### Important

- **I-2 — The "Refresh payment status" button bypasses the poll loop's overlap guard**,
  invoking the raw poll-cycle function directly instead of the loop's own
  `triggerNow()`/`triggerImmediatePoll()` helper (which three of six rails don't even
  export). A burst of taps from one buyer can run a full extra reconcile cycle
  concurrently with the scheduled one, mutate a shared rotating cursor concurrently, and
  — at the rate limiter's ceiling — generate enough gateway calls to trip that gateway's
  own rate limit for the whole shop.
- **I-3 — The outbox dispatcher has no health watchdog**, unlike every one of the six
  payment pollers (each has a stale/failing-heartbeat watchdog that pages admins). A bad
  notifier token or misconfiguration silently stops every buyer credential DM and every
  admin alert with nothing but one log line — the rest of the process keeps serving
  normally, so nothing else signals the failure.
- **I-4 — The outbox's config-gap backoff counter shares a column with the
  terminal-failure counter** (prior L-24, now materially worse since the EMAIL delivery
  lane uses the same helper) — a notification parked for a week because SMTP wasn't
  configured accumulates "attempts," and its first real failure after that goes straight
  to permanently FAILED with zero actual retries.
- **I-5 — Three of six payment reconcile rails (QRIS/IDR) treat underpayment as a log
  line** with no DB state change, no ledger row, and no admin alert — the order silently
  auto-cancels while the money sits at the gateway. The three crypto rails do this
  correctly (a distinct order status plus an admin alert with amounts). This is the
  silent-failure half of the prior audit's H-1 finding that was never addressed when the
  calculation bug itself was fixed.
- **I-6 — A support-ticket conversation's two DB writes aren't transactional and have no
  error handling** — a busy-database hiccup between them leaves a ticket with no thread
  message and skips the admin forward notification, while every comparable multi-write
  flow elsewhere in this codebase correctly wraps the pair.
- **I-7 — The dispatcher's flood-control check is a truthiness check on
  `retry_after`**, so Telegram's legitimate `retry_after: 0` response gets misread as
  "not flood control" and burns a retry attempt on a buyer's credential DM — the
  sibling broadcast drainer explicitly documents and avoids this exact trap.
- **I-8 — An unthrottled admin×product fan-out runs on every single order approval** —
  low-stock alerts loop DMs to every admin for every low-stock SKU with no throttle, no
  dedup, and no threshold-crossing check, while both sibling fan-outs elsewhere in this
  codebase are deliberately throttled with a documented reason.

#### Minor (16 items — highlights)

- Two module-level rate-limit/join-gate caches grow unbounded with no eviction, the same
  class of leak `boundedSessionStorage` was written specifically to prevent elsewhere.
- An AbortSignal listener leaks once per dispatcher poll tick — thousands per day at the
  default interval (prior L-25, still open).
- `retryNotification` has no status guard and can re-send an already-delivered buyer DM
  (prior L-26, still open).
- Several buyer-facing timestamps render in raw UTC unlabeled, and several payment
  screens hardcode a `"WIB"` suffix next to a configurable timezone — the correct
  `localize()`/`ZZZZ`-token pattern exists and is used correctly elsewhere.
- The bot's admin dashboard and the web-admin dashboard compute "today" using two
  different day boundaries (UTC vs. shop-timezone) for the same KPI.
- Stale-payment alerting has silently inverted since the prior audit: it used to be the
  bot pollers doing it correctly and the web webhooks silent; now the web side alerts
  and the three bot pollers only log.
- The broadcast confirmation lock is read-then-write rather than atomic — a narrow
  double-send window for two admins confirming at the same instant.

### Testing gaps (ranked)

1. The bot's actual browse→buy path for non-AUTO SKUs is untested at the keyboard
   layer — every existing keyboard test passes an AUTO-shaped stock count, which is
   exactly why C-1 shipped green.
2. The dispatcher's two failure-classification branches (flood control, permanent
   failure) are untested — the two branches that decide whether a buyer's credentials
   get retried or silently dropped.
3. No test for the low-stock alert fan-out or the CSV/report export handler.
4. `refreshPaymentStatus`'s concurrency behavior (I-2) is untested — only that a
   rejected background poll doesn't crash the process, not the overlap risk itself.

---

## Recommendations, prioritized across all three sections

1. **Fix the two Criticals that make this session's own feature not actually usable
   first: order-bot C-1 (unbuyable in the bot) and core+db C-1 (silent price zeroing).**
   Neither requires a design decision — both are small, well-scoped code changes with a
   known-correct reference implementation already present elsewhere in the codebase.
2. **Decide the web-admin/storefront C-1 policy** (read-side RBAC for
   credentials/exports) — this one genuinely needs a decision (gate the specific routes,
   or change what `readonly` defaults to), not just a fix.
3. **Harden the Digiflazz webhook** (web-admin/storefront I-1 / core+db I-4) before this
   rail goes live with real money — add a live status re-check and an order-kind check,
   matching the pattern already proven on the other three gateways.
4. **Close the two silent-money-loss gaps**: QRIS/IDR underpayment alerting (order-bot
   I-5) and the wallet-top-up reconciliation false-positive (core+db I-1) — both are
   small, both directly extend fixes the prior audit already made halfway.
5. **Add the missing outbox watchdog** (order-bot I-3) — the last unmonitored worker in
   the whole process, and the one whose failure is otherwise invisible.
6. Batch the remaining Important items — most are single-file, few-line fixes with a
   correct reference pattern already in the codebase (I-2/I-6/I-7/I-8 in order-bot;
   I-2/I-3/I-5/I-6/I-7 in web-admin/storefront; I-2/I-3/I-6/I-7 in core+db).
7. Sweep the still-open Lows from the prior audit that have now survived two audits
   (L-12, L-13, L-14, L-15, L-17, L-24, L-25, L-26) as one batch — each is a few lines.
