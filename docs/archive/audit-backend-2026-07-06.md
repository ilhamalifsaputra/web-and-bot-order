# Backend Audit — Data, Money, Security, Logging

**Date:** 2026-07-06
**Scope:** `packages/core` (money/fx/logger/password), `packages/db` (Prisma crud layer),
`packages/outbox-dispatcher`, the Fastify route layer of `apps/web-admin` and
`apps/storefront`, `apps/order-bot`, and `prisma/migrations/*`.
**Nature:** READ-ONLY — no code was changed during this audit; findings are for review
and prioritization before any fix lands.
**Methodology:** 6 parallel agents, one per area below, each independently auditing its
slice against `auditBackend.md`'s brief. Each agent was instructed to first check whether
a finding was already covered by the prior full security/business-logic audit at
`docs/audit-security-2026-06-23.md` (56 findings, most Critical/High already fixed) and
only report genuinely new issues, regressions of previously-fixed items, or items that
doc explicitly left deferred.

## Executive summary

| Severity | Count |
|---|---|
| High | 6 |
| Medium | 8 |
| Low | 14 |

### Top items by impact

1. **[HIGH]** Reconciliation's negative-wallet-balance safety net only scans the IDR
   balance, never USDT — the same unit-mismatch bug class `5c0bba4` just fixed elsewhere
   could go completely undetected on the USDT rail. → §1 Money-1
2. **[HIGH]** `bulkAddStock`'s duplicate-credential dedup check is wrapped in a
   transaction at one call site (order-bot) but not the other (web-admin) — a race there
   can still deliver the same digital account to two buyers, the exact bug class Stock-1
   was fixed to prevent. → §2 Data-1
3. **[HIGH]** Storefront's lazy gateway-invoice caching in the pay-page route has an
   unguarded read-then-write race that can strand a paid order in `PENDING_PAYMENT`
   forever if two page loads race the external gateway call. → §2 Data-2
4. **[HIGH]** Password-reset token is now logged in full in the storefront access log —
   a **regression** of the previously-fixed Storefront-1 finding, caused by the recent
   React-SPA cutover changing the token's path shape out from under the redaction regex.
   → §3 Security-1
5. **[HIGH]** Outbox dispatcher's "channel not configured, release and retry" path skips
   backoff/attempts entirely — if a public channel is set then later unset, queued
   testimonial rows re-claim/re-release on every tick forever and can crowd real
   notifications out of the fixed-size batch. → §4 Outbox-1
6. **[HIGH]** The bot's ban/unban flow never captures a reason and writes an empty audit
   `details` for the identical action the web panel logs in full — a forensics gap on a
   punitive, customer-facing action. → §5 Log-5-1

### Cross-cutting pattern

Nearly every new finding here sits at a **migration seam**: USDT support bolted onto an
IDR-first money model (Money-1, Data-3), the ongoing Nunjucks→React SPA cutover
(Security-1, Data-3), or a helper (`bulkAddStock`) whose safety depends on the caller
remembering to wrap it (Data-1). The prior 2026-06-23 audit's fixes are holding up well
in the code they originally targeted — the gaps found here are almost all in code that
was added or reshaped *after* that audit, not un-fixed leftovers from it.

---

## 1. Money and financial correctness

### Money-1 [HIGH] — `packages/db/src/crud/reports.ts:87-95` (`reconcileFinances`)
**Problem:** The negative-wallet-balance drift check only scans `walletBalance` (IDR):
```js
const negatives = await db.user.findMany({ where: { walletBalance: { lt: 0 } } });
```
`User` also has `walletBalanceUsdt`, actively debited/credited via `adjustWallet(...,
{ currency: "USDT" })` (referral commissions, `applyUsdtWalletToOrder`, the web-admin
`/api/users/:id/wallet` route). This query never looks at it, so a negative USDT balance
is invisible to `reconcileFinancesJob` (runs every 6h, pages the admin) and to
`scripts/diag-reconcile-drift.ts`. No test exercises a negative `walletBalanceUsdt`.
**Impact:** If any bug ever drives a customer's USDT credit negative — the exact
unit/currency-mismatch bug class `5c0bba4` just fixed elsewhere in this same file — the
automated safety net built to catch that class of bug reports zero drift.
**Fix:** Add `db.user.findMany({ where: { walletBalanceUsdt: { lt: 0 } } })`, tag entries
with currency, include both in the count/alert.
**Convention:** Spirit of "Audit every state change" — the reconciliation mechanism that
substitutes for that audit on aggregate balances has a blind spot over half the money in
the system.

### Money-2 [MEDIUM] — `packages/db/src/crud/orders.ts:172-176` (`createOrderFromCart`)
**Problem:** `afterDiscount = subtotal.minus(bulkDiscount).minus(discount)` is never
clamped to 0 before computing `walletUsed = Decimal.min(walletAmount, afterDiscount)`.
Unlike `createOrderDirect` (which caps the voucher discount against
`subtotal.minus(bulkDiscount)`, structurally preventing this), `createOrderFromCart` caps
the voucher against the gross `subtotal`, so a cart with both an active bulk-pricing rule
and a stackable voucher where `bulkDiscount + discount > subtotal` produces a negative
`afterDiscount`, and with `walletAmount = 0` that flows straight into a negative
`walletUsed`, persisted on the order row.
**Impact:** No direct financial loss (`totalAmount` is still clamped to 0 before storage,
and `walletUsed.greaterThan(0)` prevents any real debit) — but `order.walletUsed` is
stored negative, corrupt data for admin reporting/audit. This is the previously-flagged
Pricing-7 from the 2026-06-23 audit, confirmed **still unfixed**, with the added detail
that the voucher-cap asymmetry between the two order-creation functions is the actual
root cause.
**Fix:** `const afterDiscount = Decimal.max(ZERO, subtotal.minus(bulkDiscount).minus(discount));`
and align the voucher cap between `createOrderFromCart` and `createOrderDirect`.
**Convention:** Undermines "Audit every state change" by corrupting the audit trail itself.

### Money-3/4 [LOW] — already known, no new action
- `packages/db/src/crud/orders.ts:232` — `warrantyDaysSnapshot` still assigned via an
  `as unknown` cast bypassing the `CartLine` type (Pricing-5, deferred LOW in prior audit).
- `packages/core/src/formatters.ts:58` / `fx.ts` — `ROUND_HALF_UP` to 0.1 USDT still
  rounds in the buyer's favor on small amounts (Pricing-6, explicitly a business decision,
  not a bug).

### Systemic pattern
Two parallel money rails (IDR and USDT) share the same functions (`adjustWallet`,
`reconcileFinances`, `createOrder*`) via a `currency` branch. Every place explicitly
revisited for USDT (pricing.ts, `reports.ts` revenue/profit, the just-fixed
`reconcileFinances` order-drift branch) is correct — but a few spots that predate the
USDT rail's full build-out still implicitly assume IDR-only (the negative-wallet scan) or
IDR-only-safe math (the voucher-cap asymmetry). Worth a single pass: for every place that
reads `walletBalance` or does subtotal/discount arithmetic, ask "does the USDT-equivalent
path get the same treatment," rather than fixing file-by-file as USDT bugs surface one at
a time (as happened with `5c0bba4`).

---

## 2. Data integrity & transactions

### Data-1 [HIGH] — `packages/db/src/crud/stock.ts:17-49` (`bulkAddStock`) + `apps/web-admin/src/routes/api/stock.ts:59`
**Problem:** `bulkAddStock` does a plain `findMany` dedup check then `createMany` insert
— not wrapped in a transaction inside the function itself. Race-safety depends entirely
on the caller wrapping it: `apps/order-bot/src/conversations/admin.ts:148-150` wraps it
in `prisma.$transaction`; `apps/web-admin/src/routes/api/stock.ts:59` calls it bare, no
transaction. There is still no unique constraint on `stock_items.credentials` (deferred
by design in the 2026-06-23 audit's Stock-1 fix — app-level check is the only guard).
**Impact:** Two concurrent web-admin bulk-add requests for the same product with
overlapping credentials (double-submit, or two staff pasting overlapping lists around the
same time) can each pass the "not existing" check before either commits its insert →
two live `AVAILABLE` rows with an identical credential string → the same digital account
can later be allocated to two different buyers — exactly the bug Stock-1 was fixed to
prevent, via a different door (request race, not within-batch duplicate) that has no test
coverage.
**Fix:** Wrap the web-admin call site the same way the bot does
(`prisma.$transaction(tx => bulkAddStock(tx, ...))`), or move the transaction wrapping
*into* `bulkAddStock` itself so callers can't get it wrong.
**Convention:** Same spirit as "keep each `$transaction` short" — here the bug is a
read-then-write missing its transaction entirely on one of two call sites.

### Data-2 [HIGH] — `apps/storefront/src/routes/checkout.ts:386-479`
**Problem:** The pay-page view lazily creates a gateway invoice and caches it into
`order.paymentRef` for TokoPay (:386-409), PayDisini (:417-440), and NOWPayments
(:453-479) — each: read cached ref → if empty, call the external gateway (network I/O) →
`prisma.order.update(...)` directly in the route (bypassing `packages/db/src/crud`). The
read-check-external-call-write sequence has no atomic claim.
**Impact:** Two concurrent requests for the same order (double page load/refresh while
the gateway API is in flight) can each see no cached ref, each create a *separate* gateway
invoice, and whichever write lands last wins. If the customer pays against the invoice
from the losing request, the order's stored `paymentRef` points at the other invoice —
the webhook confirmation for the one actually paid never matches this order, and it never
leaves `PENDING_PAYMENT`.
**Fix:** Claim atomically before calling out (conditional update `WHERE paymentRef IS
NULL`) so only one request proceeds to the gateway — same pattern already used correctly
elsewhere (`bumpVoucherUsage`, `approveOrder`'s claim). Don't wrap the network call itself
in a `$transaction`.
**Convention:** "No raw SQL in routes/handlers" (bypasses `packages/db/src/crud`) and the
single-writer transaction-shortness principle.

### Data-3 [MEDIUM] — `apps/web-admin/client/src/**` (13+ files)
**Problem:** No `@app/core/datetime` `localize()` usage anywhere under
`apps/web-admin/src`; JSON routes send raw ISO/`Date` (e.g.
`apps/web-admin/src/routes/api/orders.ts:114`), and the React client formats
client-side with the browser's locale (`OrdersPage.tsx:213`, `OrderDetailPage.tsx:147`,
`PaymentsPage.tsx:306,358,423`, `AuditPage.tsx:12`, `UsersPage.tsx:139,148`,
`UserDetailPage.tsx:181,202`, `TicketDetailPage.tsx:85`, `BroadcastPage.tsx:202`,
`StockProductPage.tsx:248`, `SupportPage.tsx:174`, `ReviewsPage.tsx:114`,
`OutboxPage.tsx:39`, `RecentOrdersTable.tsx:8` — all `new Date(x).toLocaleString()`/
`toLocaleDateString()`).
**Impact:** Contradicts the sibling app: the storefront's React SPA pre-formats every
date server-side via `localize()` specifically to preserve "UTC in DB, TIMEZONE on
display" (`apps/storefront/src/pageData.ts:128-131`). web-admin's React migration didn't
carry that discipline over. An admin whose device isn't set to the shop's `TIMEZONE`
(Asia/Jakarta) sees every audit-log entry, payment `processedAt`/`expiresAt`, and order
timestamp shifted relative to what bot notifications and the storefront show for the same
event — a real risk for reconciliation/fraud-review conclusions.
**Convention:** "UTC in DB, `TIMEZONE` on display (web `localdt` filter; bot `localize`)."

### Data-4/5 [LOW]
- `apps/storefront/src/routes/apiAuth.ts:154` — forgot-password does
  `prisma.user.findUnique({ where: { email } })` directly, while the login route two
  lines above correctly uses `findUserByLoginIdentifier` from `@app/db`.
- `apps/web-admin/src/routes/api/catalog.ts:63` and `api/reviews.ts:33` — inline
  `prisma.category.findUnique`/`prisma.review.findUnique` for 400/404 checks before
  delegating the actual mutation to a crud helper.

### Systemic pattern
The codebase has a correct, well-documented idiom for safe read-then-write under
SQLite's single-writer model — atomic conditional `updateMany` claims
(`allocateOneAvailableStock`, `approveOrder`'s claim, `bumpVoucherUsage`) — but it isn't
applied everywhere a read-then-write still exists: `bulkAddStock`'s dedup check and the
storefront checkout's gateway-ref caching both still do naive read-then-external-call-
then-write with no atomic claim. Separately, the web-admin React SPA migration didn't
carry over the storefront SPA's discipline of pre-formatting dates through `localize()`
before serializing. No `$transaction` body in `packages/db/src/crud/*` was found to
contain network or filesystem I/O — the "slow work inside a transaction" risk category
from the brief did not turn up any hits.

---

## 3. Security

### Security-1 [HIGH] — `apps/storefront/src/server.ts:57` + `apps/storefront/src/routes/apiAuth.ts:179` — regression of previously-fixed Storefront-1
**Problem:** The 2026-06-23 audit's Storefront-1 fix redacted the reset token from the
access log via `rawPath.replace(/^\/reset\/[^/]+/, "/reset/[redacted]")`, because the
token traveled in `GET /reset/:token`. Commit `1c783d1` (2026-07-04, React-SPA auth
cutover) deleted that Nunjucks route and replaced it with
`POST /api/v1/auth/reset/:token`. The redaction regex was never updated — it doesn't
match `/api/v1/auth/reset/...`, so the live single-use token is now written verbatim into
the Pino access log on every request.
**Impact:** Anyone with read access to application logs (ops staff, a compromised log
aggregator, misconfigured log shipping) can grep for `/api/v1/auth/reset/`, extract a
live single-use token within its 1-hour TTL, and use it before the legitimate user does —
full account takeover.
**Fix:** Generalize the redaction to match the token wherever it appears in a path
segment, e.g. drop the `^` anchor or add a second replace for the new API path shape.
**Convention:** "Never log secrets" — CLAUDE.md names this exact scenario as a risk.
Note: the token itself is still cryptographically strong, hashed, single-use, and
`Referrer-Policy: no-referrer` is still set — only the access-log leak is new.

### Security-2 [LOW] — `apps/web-admin/src/routes/broadcastPhoto.ts` (new, commit `ab1411a`)
**Problem:** Mirrors the established `catalogPhoto.ts` pattern correctly (auth, CSRF, RBAC
all enforced via the shared `handleUpload()` helper), but has zero test coverage — unlike
`catalogPhoto.ts`'s full happy/MIME-spoof/404/bad-CSRF/auth-required trio.
**Fix:** Add the same test trio, adapted for `broadcastPhoto.ts`.
**Convention:** "New routes get the happy/auth-fail/bad-csrf test trio."

### Verified clean (no new findings)
- Settings whitelist unchanged since baseline; secrets masked in both API responses and
  audit-log `details`.
- RBAC default-role fix (Admin-2) still correct; `/admins/add` still writes explicit
  `"readonly"`.
- No Telegram API call from `apps/web-admin` or `apps/storefront` beyond the already-
  vetted read-only `telegramCheck.ts` (`getMe`/`getChat`). The new broadcast-image send
  happens bot-side (`apps/order-bot/src/jobs/index.ts:342`); web-admin only enqueues.
- CSRF present on all newer storefront SPA mutating routes (`apiAccount.ts`,
  `apiCheckout.ts`, `apiCart.ts`).
- Storefront auth fundamentals (bcrypt cost 12, HMAC-signed timed cookies with
  `timingSafeEqual`, Telegram Login HMAC + replay-window check) unchanged and correct.
- `web_secret.ts` — 32-byte random cookie secret, never logged, never in the settings
  whitelist.

### Systemic pattern
The one real regression has a clear root cause: this repo is mid-migration from
server-rendered Nunjucks routes to React SPAs backed by a JSON `/api/v1` layer, and a
security fix anchored to a specific *path shape* (`GET /reset/:token`) wasn't re-derived
when the SPA cutover moved the sensitive data to a new path
(`POST /api/v1/auth/reset/:token`). Worth a one-time sweep: anywhere the 2026-06-23
audit's fix was described as "redact/protect path X," check whether a subsequent SPA
migration moved that functionality to a path the fix's pattern-match no longer covers.

---

## 4. Outbox / notification delivery

### Outbox-1 [HIGH] — `packages/outbox-dispatcher/src/dispatcher.ts:138-141`
**Problem:** When a non-DM notification's public channel isn't configured, the row is
released back to `PENDING` with no backoff/attempts increment (`releaseNotificationClaim`,
`packages/db/src/crud/notifications.ts:188-193`) — unlike every other failure path in the
file. This only bites rows enqueued while `PUBLIC_CHANNEL_ID` *was* configured
(`orders.ts:879` skips enqueueing testimonial rows entirely when it's unset at enqueue
time) and the channel is later unset/changed via the web settings whitelist.
**Impact:** Any testimonial rows already queued during the "configured" window become
permanently zero-backoff `PENDING` rows, re-claimed and re-released on every dispatcher
tick forever, each occupying one of the fixed 50 slots `fetchPendingNotifications`
returns (oldest-first). Enough of them can starve newer `ADMIN_PW_RESET`/
`ORDER_DELIVERED_DM`/`ADMIN_OVERPAID` rows out of every batch until an admin reconfigures
the channel — there is no admin-panel action to fail/delete a stuck row.
**Fix:** Either re-check the channel isn't `undefined` before treating this as benign
"wait," give it a bounded backoff/attempts cap like `markNotificationFailed`, or exclude
these rows from the fetch when unconfigured.
**Convention:** Conflicts with the outbox's own established backoff/attempts discipline
(the prior audit's Infra-2/Infra-3 fixes).

### Outbox-2 [LOW/MEDIUM] — `packages/outbox-dispatcher/src/templates.ts:169-185`
**Problem:** `dispatcher.ts:122-125` intercepts `ORDER_DELIVERED_DM` and routes it
entirely through `deliverAccountDm`/`delivery.ts` (correctly localized via `t()`), then
`continue`s — so `render("ORDER_DELIVERED_DM", ...)` in `templates.ts` is unreachable in
production, yet `templates.test.ts:55-66` unit-tests it directly and passes, implying this
hardcoded bilingual text is what buyers receive. It isn't.
**Fix:** Delete the dead branch so there's one source of truth for this event's copy.
**Convention:** Undermines "keep both locale files' key sets identical" as a verifiable
property, since this dead branch isn't in the locale files at all.

### Outbox-3 [LOW] — `packages/outbox-dispatcher/src/templates.ts:21-38, 111-207`
**Problem:** Notification copy for `ADMIN_PW_RESET`, `ADMIN_OVERPAID`,
`ORDER_PIPELINE_FAILED` is hardcoded English+Indonesian directly in TS rather than pulled
from `packages/core/locales/{en,id}.json` — understandable (the outbox has no `ctx` to
call `t()` with) but it means these strings live outside the locale-parity system; only
`ORDER_DELIVERED` actually localizes to one language, the other three always concatenate
both languages into one message.
**Fix:** Low priority; if touched, move to a lang-keyed helper analogous to `t()` callable
without a `ctx`, for parity-checkability.

### Outbox-4 [LOW/INFORMATIONAL] — `packages/outbox-dispatcher/src/dispatcher.ts:110,197-222`
**Problem:** The claim pattern is **at-least-once**, not exactly-once: if the process
crashes after Telegram accepts the send but before `markNotificationSent` commits, the
row stays `SENDING` until `STALE_CLAIM_MS` (5 min) elapses, then is reclaimed and resent
— a genuine duplicate message. Bounded, rare, and effectively unavoidable without a
Telegram-side idempotency key; flagged only to characterize the guarantee explicitly per
the brief.

### Outbox-5 [LOW] — `packages/outbox-dispatcher/src/templates.ts:62-75,186-205`
**Problem:** `enqueueOrderPipelineFailed` truncates `reason` to 300 chars before
enqueueing, but `ORDER_DELIVERED`'s `fmtItems`/`masked_buyer_id`/`total` fields have no
length cap before interpolation. All values are HTML-escaped (no injection risk) and
admin/system-controlled, so this is a resilience nit: an unusually long product name or
item list could push a message past Telegram's 4096-char limit, causing that row to
exhaust `NOTIF_MAX_ATTEMPTS` and land in `FAILED` — a lost testimonial, not a stuck queue.

### Verified clean — `git show ab1411a` (broadcast image attachment)
Web-admin only writes a DB row + file to disk (no Telegram call); upload validation
reuses the vetted `handleUpload` (CSRF, role gate, MIME allow-list, size cap, magic-byte
sniffing); the actual `sendPhoto` happens bot-side per-recipient inside its own
`try/catch`, so a broken image fails per-recipient without stalling `drainBroadcasts`.
This is a separate pipeline (`Broadcast` table) from `notification_outbox` and doesn't
touch outbox semantics. Minor pre-existing (not introduced by this commit) note: the
catch-all doesn't distinguish Telegram flood-control (429/`retry_after`) from a blocked
user — matches the prior audit's already-tracked `§Bot-5`-style gap, out of this area's
scope.

### Systemic pattern
The outbox's core machinery (atomic claim, stale-claim reaping, exponential backoff,
max-attempts-to-FAILED) is solid, and the prior audit's Infra-2/Infra-3 fixes are
confirmed still in place. The remaining gaps cluster around paths designed as "wait,
don't fail" escape hatches (channel-not-configured release, at-least-once-by-crash-
window) that deliberately opt out of the backoff/attempts discipline the rest of the file
enforces — exactly where an edge case (channel configured, then unconfigured) can quietly
reintroduce the head-of-line blocking that discipline was built to prevent.

---

## 5. Logging & auditability

The overwhelming majority of the codebase is compliant and often exemplary —
`packages/db/src/crud/audit.ts`, virtually all of `apps/web-admin/src/routes/api/*.ts`,
and the payment-poller files already match `docs/LOGGING.md`'s patterns almost verbatim.
Checkout-6 (auto-deliver audit gap) is confirmed fixed and centralized correctly in
`approveOrder`. The `5c0bba4` reconciliation fix was purely a detection-math correction —
reconciliation only logs drift, it doesn't move money, and the actual wallet debit path
already writes a proper `walletTransaction` ledger row.

### Log-5-1 [HIGH] — `apps/order-bot/src/handlers/admin.ts:182-196` (`userBan`)
**Problem:** The bot's ban/unban never prompts the admin for a reason and hardcodes one
into `user.bannedReason` (`"set by admin"`); the paired `logAdminAction` call has **no
`details` field at all**. The web-admin equivalent for the identical action
(`apps/web-admin/src/routes/api/users.ts:75-82`) captures free text and logs
`` details: `${doBan ? "Banned" : "Unbanned"} the user. Reason: "${reason}".` ``.
**Impact:** Forensics gap — an admin reviewing `/audit` for "why was this customer
banned" sees only the bare action name and target id when the ban happened via Telegram,
but a full reason when it happened via the web panel, for the identical business action.
**Fix:** Add a reason-capture step to the bot's ban/unban flow (mirroring the web form),
pass it into `setUserBanned`'s existing `reason` parameter, and include it in `details`.
**Convention:** Technically satisfies "Audit every state change with the acting admin
id," but fails `docs/LOGGING.md`'s core purpose — an empty `details` for a punitive
action is a blind spot for the shop admin reading the log.

### Log-5-2 [MEDIUM] — `apps/order-bot/src/main.ts:131-138`
**Problem:** The global Telegram-update error handler builds `key=value` fragments and
joins them into the log message: `` `ref=${ref}`, `user=${ctx.from.id}`,
`callback_button=${...}` `` bracketed into the final sentence — reconstructing, inside
the bracket, precisely the `key=value` shorthand `docs/LOGGING.md`'s "Contoh buruk" row
calls out, even though the surrounding sentence otherwise follows the "why it matters"
style correctly.
**Impact:** This is the single highest-traffic error log in the bot (catch-all for every
unhandled exception), so the anti-pattern appears constantly in production logs.
**Fix:** Rewrite as a sentence, e.g. `"Unhandled error while processing a Telegram
update from user 123456 (ref AB12CD, via callback button "v1:prod:view:9") — user saw a
generic error with this ref, check the stack trace below"`.
**Convention:** `docs/LOGGING.md` §2 rule 1 and its explicit "Contoh buruk" example.

### Log-5-3 [MEDIUM] — `apps/web-admin/src/routes/api/broadcast.ts:79`
**Problem:** The broadcast-enqueue audit line interpolates a raw UTC ISO timestamp:
`` `...for ${scheduledAt.toISOString()}.` ``, producing e.g. `"...for
2026-07-10T14:00:00.000Z."`.
**Impact:** The non-technical shop admin reading `/audit` sees a bare UTC instant with a
`Z` suffix instead of shop-local time, and must mentally convert it every time. Audit
rows are immutable and never reformatted post-write, so this is permanently wrong for
every row already written, not just a display bug fixable later.
**Fix:** Run `scheduledAt` through the same local-timezone formatter used elsewhere (the
`localdt` filter's underlying helper) before interpolating.
**Convention:** "UTC in DB, `TIMEZONE` on display" — this is admin-facing display text
that skipped localization.

### Log-5-4 [LOW] — `apps/order-bot/src/conversations/reject.ts:75` vs `apps/web-admin/src/routes/api/orders.ts:225`
**Problem:** Both write the rejection reason unquoted and inconsistently: bot writes
`` `Rejected order: ${reason}` `` (no order code); web writes `` `Rejected order
${orderId}: ${reason}` `` (numeric id, not the human-readable order code every other
order-audit line uses).
**Fix:** Standardize to `` `Rejected order ${orderCode}: "${reason}".` `` in both places.
**Convention:** `docs/LOGGING.md` §1 rule 5 (user-supplied text should be quoted) plus
general consistency of audit-sentence shape across call sites.

### Log-5-5 [LOW] — `apps/storefront/src/routes/checkout.ts:575`
**Problem:** `` logger.warn(`TokoPay callback claimed paid but live status check
disagrees for ${order.orderCode}`) `` — the one warn in the file with no why/what's-next
clause; its three siblings all end with one (e.g. the short-paid warn two lines below
explains "recording it as unmatched instead of delivering").
**Impact:** This exact scenario — a callback asserting "paid" that TokoPay's live API
contradicts — is precisely the signal relevant to the prior audit's Payment-1 forged-
callback finding; the log gives no hint whether this is a benign timing race or a
possible forgery attempt, nor what happens next.
**Fix:** Extend to `` `...disagrees — ignoring it, a retry will confirm payment once
TokoPay's own status catches up.` ``.
**Convention:** `docs/LOGGING.md` §2 rule 1 (warn/error must explain why it matters /
what's next).

### Log-5-6 [LOW, latent/unreachable today] — shared `adminId(admin) => admin ? admin.id : 0` fallback
**Problem:** `apps/order-bot/src/handlers/admin.ts:53` and inline equivalents in
`verification.ts:125,127` / `reject.ts:69,71` fall back to `adminId: 0` across ~8
`logAdminAction` calls plus `approveOrder`/`rejectOrder`. `AuditLog.adminId` has a real
FK to `User.id` (`PRAGMA foreign_keys = ON` in `packages/db/src/client.ts:31`), and
Prisma ids autoincrement from 1 — an id of `0` would throw a foreign-key violation and
roll back the **entire transaction** (not just the audit write) if it were ever reached.
In `approveOrder`, `0` also collides with the distinct "system/auto-deliver" sentinel
meaning.
**Why only LOW:** Verified unreachable today — the global `registeredUser` middleware
upserts the acting admin's `User` row before any handler runs, so `getUserByTelegramId`
should never return `null` for an in-flow admin action currently.
**Fix:** Replace the silent `: 0` fallback with a hard invariant check (throw/log) so a
future middleware-ordering regression fails loudly instead of silently corrupting a
transaction; don't let `0` double as both "no user" and "system action."
**Convention:** "Audit every state change with the acting admin id" — the fallback
exists to satisfy this but is fragile rather than a real guarantee.

### Log-5-7 [LOW] — `apps/order-bot/src/handlers/admin.ts:478-498` (`deleteBulkPricingHandler`) vs `apps/web-admin/src/routes/api/catalog.ts:455-461`
**Problem:** Bot logs `action: "bulk_pricing_delete"` with no `details`; web logs
`` details: `Removed bulk pricing for "${existing.name}".` `` for the identical action.
**Fix:** Fetch the product/denomination name (already available earlier in the same
handler) and add the equivalent `details` sentence.
**Convention:** `docs/LOGGING.md` §1 (details should read as a natural sentence
conveying the outcome) — here it's missing entirely, specific to the bot channel.

### Systemic pattern
The clearest cross-cutting pattern is a **bot-channel vs. web-channel fidelity gap**: for
at least three identical business actions implemented twice (once in
`apps/order-bot/src/handlers/admin.ts`, once in the corresponding
`apps/web-admin/src/routes/api/*.ts`), the web version consistently writes a fuller
`details` sentence than the bot version — `user_ban`/`user_unban`, `bulk_pricing_delete`,
and (to a lesser extent) `stock_mark_dead`. This suggests the bot-side admin handlers
were either written before the `details` convention solidified, or ported without
carrying over the richer web version's context-capture — worth a single pass over
`apps/order-bot/src/handlers/admin.ts` bringing every `logAdminAction` call up to parity
with its web-admin counterpart, rather than fixing each individually.

---

## 6. Schema & deploy discipline

### Schema-1 [MEDIUM] — `docs/DATABASE.md` missing model-inventory rows for the two newest migrations
**Problem:** `prisma/migrations/20260624160712_add_order_status_history/` adds a whole
new table (`order_status_history`) plus 5 columns to `orders` (`confirmations`,
`confirmed_at`, `first_detected_at`, `network`, `required_confirmations`) — none of this
appears in `docs/DATABASE.md`'s Order table. `prisma/migrations/20260706120000_broadcast_image/`
(today's `ab1411a`) adds `broadcasts.web_image_url`/`image_file_id` — also undocumented.
**Impact:** No P2022 risk (columns nullable), but `docs/PATCH_GUIDE.md` explicitly
requires updating `DATABASE.md`/`MIGRATIONS.md` on schema change; that step was skipped
for both. Anyone using `DATABASE.md` as the schema source of truth won't know these exist.
**Fix:** Add an `OrderStatusHistory` row and amend the `Order`/`Broadcast` rows.

### Schema-2 [MEDIUM] — `docs/CHANGELOG.md` stale since `[v1.10.0] — 2026-06-23`
**Problem:** No entry for the order-status-history/confirmations feature (2026-06-24),
the broadcast-image feature (`ab1411a`, 2026-07-06), or the USDT wallet-credit fix
(`5c0bba4`, 2026-07-06). The wallet fix in particular is exactly the class of bug
`docs/PATCH_GUIDE.md`'s template (Issue/Cause/Files changed/Database changes/Migration
required?/Rollback procedure) exists for, with zero entry.
**Impact:** No runtime effect, but breaks the audit trail this repo relies on for "was
this already patched / what's the rollback" — the same discipline that documented the
past `claimed_at` P2022 incident isn't being followed for the newest changes.
**Fix:** Add `Unreleased`/`v1.11.0` entries per the template for these three changes.

### Schema-3 [MEDIUM] — `apps/server/src/index.ts:207-214` boot-time drift check only catches missing tables, not missing columns
**Problem:** The only automated schema-drift guard at startup checks for missing
payment-ledger tables via existence check — not columns.
**Impact:** This would **not** have caught the documented `notification_outbox.claimed_at`/
`next_retry_at` incident (`docs/PATCH_GUIDE.md`'s own worked example, a column-level
drift on an existing table), and will equally miss drift on the two newest additive-column
migrations if an operator forgets `db push` after pulling those commits — silent P2022 at
first write, not a loud boot failure.
**Fix:** Either extend the guard to a column-level check for recently-touched tables, or
document the "tables only, not columns" limitation explicitly in `docs/MIGRATIONS.md`.

### Schema-4 [LOW] — `docs/UPDATE_GUIDE.md:75-82` breaking-changes table has no row for FK-constraint-only changes
**Problem:** `prisma/migrations/20260623174046_restrict_financial_cascades/` changes FK
actions from CASCADE/SET NULL to RESTRICT on 4 tables — SQLite implements this as
DROP+CREATE+bulk-INSERT+RENAME per table (verified safe, no data loss). The doc's
breaking-changes table only has rows for "additive" and "rename" — not "constraint-only
change requiring a full table rebuild," which carries a brief `SQLITE_BUSY`/"schema has
changed" risk if the old process is still holding the DB open during the rebuild window
(the doc's own step order runs `db push` before restart).
**Fix:** Add a row acknowledging FK/constraint-only changes rebuild tables in SQLite,
recommending a brief service-stop similar to the rename row.

### Schema-5 [LOW] — informational: migration-authoring inconsistency
Several migration folders (`20260531180000_wallet_transactions`,
`20260531200000_broadcasts`, `20260706120000_broadcast_image`) use round hand-picked
timestamps vs. realistically Prisma-generated ones elsewhere, suggesting hand-authored
rather than `prisma migrate dev --create-only`-generated SQL. Spot-checked
`20260706120000_broadcast_image` against the current `Broadcast` model — matches
correctly, no live defect. **Fix:** Run future migrations through the tool, or document
that hand-authored files are best-effort/unvalidated.

### Verified clean
The one migration in the recent window that adds a `NOT NULL` column without a default
to previously-populated tables (`categories.slug`/`products.slug`) is handled by the
dedicated, documented `scripts/migrate-catalog-rename.ts` cutover with an idempotent
backfill safety net — correctly cross-referenced in `UPDATE_GUIDE.md`/`INSTALLATION.md`/
`MIGRATIONS.md`. `wallet_balance_usdt` has a `DEFAULT 0`. All other recent additions
(`voucher_redemptions`, `notification_outbox.claimed_at`/`next_retry_at`, the 5 new
`orders` columns) are new tables or nullable/no-default columns — additive and safe.

### Systemic pattern
This codebase's schema-deploy documentation is not generically stale — it's precise and
self-auditing through `v1.10.0` (2026-06-23), including a worked incident writeup of its
own past P2022 failure. The gap is specifically at the trailing edge: the newest 2
schema-touching commits landed without their `DATABASE.md`/`CHANGELOG.md` companion
updates that `docs/PATCH_GUIDE.md` itself mandates, and the one automated safety net that
exists (the boot-time drift check) has a structural blind spot — table-existence-only —
that would not have caught the exact incident the docs use as their own teaching example.
The process is well-designed; its enforcement is lagging the most recent two weeks of
feature work.
