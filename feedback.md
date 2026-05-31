# Project Feedback & Recommendations — `telegram-order-bot` (Node/TS monorepo)

> Audience: the project owner/operator and any future contributor.
> Scope: the Node/TS stack (`apps/order-bot`, `apps/web-admin`, `apps/notifier`,
> `packages/core`, `packages/db`) on the shared SQLite `data/bot.db`.
> Status date: 2026-05-31. Authored after the WEB.md Tier 1/Tier 2 build-out and
> a Binance live-API probe.

This document is the running backlog of observations and recommendations. Items
marked **✅ DONE** were implemented in recent sessions; the rest are prioritized
suggestions with enough detail to pick up cold.

---

## 1. Changelog — what was implemented recently

### Web admin (WEB.md roadmap)
- **Tier 1** — `/payments` Binance ops panel, `/outbox` monitor, dashboard SLA
  widgets, poller heartbeat (`binance_poll_health`). ✅
- **Tier 2 §4–§7** — wallet ledger on `/users/:id` (derived from `audit_logs`,
  no new table; wallet adjustment now requires a reason), reviews moderation
  `/reviews` (+`reviews.hidden` column, bot excludes hidden from rating),
  restock waitlist on `/stock`, `/reports` with server-rendered SVG sparkline. ✅

### Bot UX consistency — "edit the bubble, don't just toast"
- `cancelPendingOrder` now edits the payment bubble into a cancellation
  confirmation (`smartEdit` + `notificationKb`) instead of leaving a stale
  screen. ✅
- `subscribeRestock` edits the product bubble into a subscribed-confirmation. ✅
- `closeTicketUser` edits the ticket bubble into a closed-confirmation (was only
  stripping the markup). ✅
- `smartEdit` now edits photo+caption bubbles (the QR payment screen) in place,
  matching `adminEdit`. ✅

### Binance Internal Transfer matching
- Fixed `normalizeTx` note fallback: `??` never skipped an empty-string note;
  switched to a `firstNonEmpty()` helper and **removed the `orderId` fallback**
  (that field is Binance's own id, not the buyer memo). ✅
- Added a conservative **amount fallback** (`matchByAmount`): when the note is
  absent, a transfer auto-confirms only if exactly one pending order's expected
  total is within tolerance; collisions are refused and left for manual match. ✅

### Tests / i18n
- New crud helper `productRating()` (single source of truth for the public
  rating, hidden-excluded) + unit tests. ✅
- New `matchByAmount` unit tests. ✅
- Converted the visible **admin confirmation toasts** to `admin.toast.*` locale
  keys (EN + ID). ✅
- Suite: **159 tests green**; full `pnpm -r typecheck` clean.

---

## 2. High priority (do next)

### 2.1 🔴 Confirm the Binance `note` field (one-command check; needs one test transfer)
Note-based auto-confirm rests on an assumption the live probe has NOT yet
confirmed: a probe run showed `GET /sapi/v1/pay/transactions` returns real C2C
transfers but with `note: ''` on every historical row (those simply had no memo).
**Not a blocker** — the amount fallback (§2.2, shipped) already makes
auto-confirm work without the note. This step just decides whether note-matching
can be the *primary* path.

**Verification runbook (≈2 min):**
1. From any order, grab its `paymentRef` (10-char hex, e.g. `BCC1BDDE6F`).
   It's shown on the internal-transfer payment screen and in the `orders` table.
2. Send a **small** USDT transfer to the receiving UID with that `paymentRef`
   typed in the **Note/Memo** field.
3. Run: `pnpm exec tsx scripts/binance-probe.ts`
4. Read the **`── NOTE-FIELD VERDICT ──`** block the probe now prints:
   - **PASS** ("a buyer memo IS captured") → note-matching is viable; keep it as
     primary, amount fallback as the safety net. Nothing more to do.
   - **FAIL / PARTIAL** (memo fields stay empty) → the payload doesn't carry the
     sender memo here. Don't fight it — stay on the **amount fallback +
     `USE_UNIQUE_CENTS=1`** (already the default). Optionally, for exactness,
     capture the payer UID at checkout and match `counterpartyId → order`
     (more buyer friction; only if amount collisions become real).

**Recommendation (regardless of outcome):** keep unique-cents on and lean on the
amount fallback; treat note-matching as a bonus once the probe says PASS. Record
the verdict in `RUN.md` and keep the payment-screen copy in sync (§8.5).

### 2.2 ✅ DONE — Warn when Binance Internal is on but unique-cents is off
`matchByAmount` is only reliable when order totals are distinct.
`startPolling` (binanceInternal.ts) now logs a loud `⚠` warning at boot when
`isBinanceInternalEnabled()` is true but `USE_UNIQUE_CENTS` is false. (Default
is already `true`.) Equal-total orders are refused, never mis-delivered, so this
is a degradation warning, not a safety hole.

### 2.3 ✅ DONE — Deployment checklist for schema migrations
The column was applied to the live DB via `prisma db push` (migration
`20260531140000_review_hidden` is the reproducible delta). For any other
environment: run `pnpm prisma db push` (or apply the migration) **and restart
order-bot** before the new `/reviews` panel and the hidden-exclusion are used —
otherwise the bot throws `P2022 column reviews.hidden does not exist` on product
view. **Now documented** as a generic "Schema changes on deploy" step in WEB.md
("Implementation notes that bite").

---

## 3. Consistency & i18n debt

### 3.1 ✅ DONE — Localize remaining admin strings
Added `admin.hdr_*` / `admin.empty_*` / `admin.wallet_*` / `admin.bulk_none_set` /
`admin.ticket_closed_body` keys (EN+ID) and replaced the literals in
`admin.ts` (section headers, empty-states, wallet command, bulk-pricing body,
stock-items empty, close-ticket body). Remaining (intentionally English): the
`/wallet` success line `New balance for user …` is an operator-only debug echo —
localize if a non-English operator uses the command often.

### 3.2 ✅ DONE — Resolve recipient language in user DMs
`closeTicketAdmin` now DMs the buyer in **their** language
(`getUserByTelegramId` → `langCode`) instead of a hardcoded `"en"`. Admin-group
posts intentionally stay English (deliberate constant). Audit any new user DM for
the same pattern.

### 3.3 ✅ DONE — Toast vs alert + edit-in-place convention
Documented in the new **`CLAUDE.md`** ("Bot UX"): routine success → non-blocking
toast; errors/destructive → `show_alert: true`; every terminal tap edits its
bubble (`smartEdit`/`adminEdit`) + a nav keyboard; no leaked English (locale
key-parity). CLAUDE.md also consolidates the money/audit/CSRF/never-log-secrets
rules for both apps.

---

## 4. Web admin — remaining roadmap (WEB.md)

### 4.1 ✅ DONE — Tier 2 §8 — Bulk operations
- ✅ **Bulk activate/deactivate** products on `/catalog` — checkbox per card +
  select-all + toolbar → `POST /catalog/products/bulk` → `bulkSetProductsActive`
  (one `updateMany` writer), audited once.
- ✅ **Bulk mark-dead** stock on `/stock/:id` — checkbox column (only
  available/reserved rows are selectable) + reason → `POST /stock/:id/bulk-dead`
  → `bulkMarkStockDead` (skips SOLD/DEAD so delivered creds are never touched),
  audited once, **never logs credentials**. Both covered by tests (happy /
  empty-selection / auth / bad-CSRF).
- ✅ **Bulk price update** on `/catalog` — same checkbox selection + a toolbar
  (Set price to / Adjust by %) → a **two-step preview** (`POST .../bulk-price`
  renders old→new, writes nothing; rows that would go ≤0 are flagged & skipped)
  → confirm (`POST .../bulk-price/apply`) commits via
  `prisma.$transaction(tx => bulkSetPrices(tx, items))`, audited once. Tests
  cover preview-is-read-only, apply-commits, percent math + ≤0 skip, auth/CSRF.
- ✅ **Product CSV import** with a **dry-run preview** on `/catalog` — paste
  pipe-delimited rows (`category | name | type | duration | price [| reseller |
  warranty_days | description]`); `POST .../import` validates each row against
  existing category names and renders a per-row ✓ready / ✗error table **without
  writing**; `POST .../import/apply` re-parses (never trusts a precomputed
  payload) and creates the valid rows in one `prisma.$transaction`, audited once.
  Tests: preview-read-only, apply-creates-valid-only, all-invalid rejected,
  auth/CSRF.
- Implementation note honored: bulk active = one `updateMany`; bulk price &
  CSV import = one short interactive `$transaction` — not a loop of independent
  writers. **§4.1 fully complete.**

### 4.2 ✅ DONE — Global search / quick-jump
`/search` (nav + page): an exact order code 302s straight to the order detail;
otherwise a grouped results page lists matching users (`searchUsers`) and
products (`searchProducts`). Read-only, no new crud, with happy/exact-jump/auth
tests. (A future enhancement: also list partial order-code matches.)

### 4.3 ✅ DONE — Tier 3 §9 — Multi-admin + RBAC
Three web roles — **super** (full), **support** (operational mutations:
`/orders /support /outbox /payments /reviews`), **readonly** (view + own
password) — stored in **settings** (`web_admin_role:<tg>`), so **no schema
change** (consistent with the existing password-hash-in-settings pattern). Unset
role ⇒ **super**, so the current operator's access is unchanged (backward
compatible).
- `csrfProtect` gained a **`roleGate`** step (after auth + CSRF): mutations are
  allowed/denied per role by URL area via the pure, unit-tested `canMutate`.
  Reads (GET) stay open to any authenticated admin.
- New **`/admins`** page (super-only via `requireSuper`): lists `ADMIN_IDS` with
  their role + password status, assigns roles (audited), and **blocks
  self-demotion** so the dashboard can't be left without a super. Nav shows a
  role badge and the Admins link only for super.
- Covered by tests: the `canMutate` matrix, readonly-blocked-but-can-view,
  support-ops-yes/config-no, and `/admins` super-only + assign + self-demotion +
  not-in-ADMIN_IDS guards.
- **Note:** role granularity is by URL area (coarse, good for a small team);
  finer per-action capabilities can come later. `/stock` and `/users` are
  super-only (inventory + wallet/ban are structural/money).

### 4.4 ✅ DONE — Web login 2FA + session management
- **TOTP 2FA** (RFC 6238, SHA-1/6-digit/30s) implemented on `node:crypto` — no
  new dependency, stays buildless. Self-service enrolment on `/settings`
  (begin → show base32 secret + `otpauth://` URI → confirm a code → enable;
  disable needs **password + a valid code**). Login now requires the code when
  2FA is on. Secrets live in settings (`web_2fa_secret:<tg>`, pending under
  `web_2fa_pending:`), are in the secret-redaction list, and are never logged.
  Allowed for **every** role (carved out in `canMutate` like `/settings/password`).
- **Session management**: `/admins` (super-only) now has **force-logout** per
  admin — rotates their `web_session_jti`, invalidating any cookie in the wild —
  plus 2FA-status and session columns. Self uses the normal Logout button.
- Tested: `verifyTotp` accept/reject, enrol begin→enable (wrong-code rejected),
  login-requires-code-when-enabled, disable-needs-password+code,
  readonly-can-still-manage-own-2FA, force-logout rotates jti / not-self.
- **Deferred (note):** a full **multi-session** "active sessions" list (per-device
  rows with IP/UA/created-at + selective revoke) needs a sessions table — the
  current model is one jti per admin (one active session), so force-logout +
  a session-present flag cover the practical need for now.

### 4.5 ✅ DONE — Broadcast composer (both halves)
- **Web half** `/broadcast` (super-only): compose plain text, pick a **segment**
  (ALL / RESELLERS / RECENT_BUYERS, with live audience counts), optionally
  **schedule** (`datetime-local`), and **enqueue** to a new `broadcasts` table
  (migration `20260531200000_broadcasts`). The web **sends nothing** — verified
  by a test asserting no outbox/Telegram side effect at enqueue. Cancel a
  still-PENDING broadcast; a history table shows status + sent/total. Every
  enqueue/cancel is audited.
- **Bot half** `drainBroadcasts` (croner, every minute, `protect: true`): claims
  the next due broadcast (`scheduledAt` null/past) by flipping PENDING→SENDING
  (the single-writer + status guard prevents double-send), resolves the segment,
  DMs each recipient (plain text, ~40ms throttle ≈ under Telegram's 30/s), counts
  sent/failed, marks SENT. Banned users are always excluded.
- Segments live in `@app/db` (`countSegment` / `resolveSegmentRecipients`), so
  web preview and bot delivery share one definition.
- Tested: segment counts (banned excluded, recent-buyer window), queue lifecycle
  (claim-once / future-scheduled-skipped / cancel-only-pending), web enqueue
  sends-nothing + cancel + auth/CSRF, and the drainer delivers to the segment and
  marks SENT.
- **Deferred (note):** photo broadcasts (the bot's interactive flow supports them;
  the web is text-only for now) and per-broadcast delivery analytics beyond the
  sent/failed counts.

---

## 5. Architecture & robustness

### 5.1 ✅ DONE — Authoritative wallet ledger table
Added a **`wallet_transactions`** table (migration
`20260531180000_wallet_transactions`) written by **`adjustWallet`** itself, so
**every** balance movement is recorded with its running `balanceAfter`, a
machine `reason`, and optional `note`/`adminId`/`orderId` — nothing is missed.
All 6 call sites now pass a reason: `admin_adjust` (web + bot `/wallet`),
`underpaid_refund` (with admin + order), `referral`, `order_payment`,
`order_refund`. `listWalletLedger` reads the table directly (newest-first,
running balance); `/users/:id` shows the full timeline with reason badges,
balance, and order links — no longer audit-log reconstruction. Covered by a
crud test (applied delta + running balance + reason, rejected-overdraw writes no
row, default reason). Applied to the live DB via `db push`; restart-before-code
rule (CLAUDE.md) applies on deploy.

### 5.2 ✅ DONE (documented) — SQLite single-writer ceiling
Captured in **`CLAUDE.md`** ("Shared SQLite is single-writer — keep each
`$transaction` short; the trigger to move to Postgres is ≥2 concurrent writers")
and WEB.md. Keep bulk/admin features transaction-tight until the switch.

### 5.3 ✅ DONE — Poller observability
- ✅ The dashboard shows a red **Binance alert banner** with the unmatched /
  delivery-failed counts (money that arrived but didn't deliver), linking to
  `/payments?outcome=unmatched`. Gated on `isBinanceInternalEnabled()`.
- ✅ A **watchdog croner job** (every 2 min) DMs admins if the poller hasn't
  completed a cycle in 5 min while not intentionally backing off. Fires once per
  stale episode and re-arms on recovery (state in `binance_poll_alert_sent`).
  The decision is a pure `pollWatchdogDecision()` with 6 unit tests.

### 5.4 ✅ DONE — `normalizeTx` fixture test
`normalizeTx` is now exported and covered by a fixture test using a redacted
real `pay/transactions` row (empty note, Binance's own `orderId`), asserting the
mapping and that `orderId` never leaks into `note`. The mapping stays the
isolated swappable seam.

---

## 6. Testing gaps

- **Binance poll integration** ✅ DONE — the poll loop was extracted into an
  exported `processTransfers(api, txs, orders)` and integration-tested against
  the real DB with a fake `Api`: note-match delivers, amount-fallback delivers,
  an equal-total collision stays unmatched, and a short note-match flags
  UNDERPAID + alerts admins.
- **`normalizeTx` fixture** ✅ DONE — a redacted real `pay/transactions` row is
  now snapshotted and asserted (empty note, no `orderId` leak).
- **Web `/reviews` hide → bot rating**: an integration test proving a hidden
  review is excluded from `productRating` (crud-level test shipped; an
  end-to-end web→bot test would be the belt-and-suspenders version).
- **CSRF/auth coverage** is good on web mutations; extend the same happy/auth/
  bad-csrf trio to every new route (bulk ops, global search) as they land.

---

## 7. Security & ops notes

- **Never log secrets** is well respected (credentials, proof `file_id`, hashes,
  full DB URLs). Keep auditing new log lines for this — the bulk/CSV import is
  the next risk surface (don't echo pasted credentials into logs or flash msgs).
- **Binance API key** must stay read-only (the module only calls the signed
  read-only `pay/transactions`). Document the key scope in `.env.example`.
- **Settings whitelist**: web settings edits are whitelist-only — preserve this
  invariant; it's the main "brick the bot" guardrail.
- **Web exposure**: binds `127.0.0.1` by default; public exposure requires the
  reverse proxy + TLS + a stronger auth review (and ideally §4.3/§4.4 first).

---

## 8. Bot UI/UX — observations & recommendations

The Telegram bot *is* the customer's entire product experience, so its UX
deserves the same rigor as the web admin. Observations are grounded in the
current handlers/keyboards/locales.

### 8.1 Edit-in-place consistency ✅ (keep enforcing)
Every terminal button tap should **edit the bubble it lives on** into a
confirmation with a forward action, never just fire an ephemeral toast or leave
a stale screen. Now applied to: order cancel, restock subscribe, user
ticket-close, and photo+caption (QR) bubbles via `smartEdit`. **Rule for new
handlers:** end on `smartEdit`/`adminEdit` + a navigation keyboard; reserve
`show_alert: true` for errors/destructive confirms (see §3.3). Add this to
`CLAUDE.md` so it's enforced by convention.

### 8.2 ✅ DONE — Numbered list kept, now with prices (inline reverted)
An inline-per-product list was tried but **reverted**: with a large catalog one
full-width button per product is a long vertical scroll, whereas the **numbered
reply keyboard packs 5 buttons per row** (10 products = 2 compact rows) and is
faster to scan/tap on mobile — the operator's call, and the right one for scale.
Kept the numbered keyboard and instead applied the real win from this item:
**each line now shows the reseller-aware price** (`┊ [ 1 ] NAME — PRICE`) so
buyers can compare without opening each. Pagination (`PAGE_SIZE = 10`) already
caps numbers per page at 1–10. The §8.3 snapshot fix still governs which product
a number maps to. Tested: numbered layout + a price on each line.

### 8.3 ✅ DONE — Stale-catalog race in numbered selection
`handleProductNumber` now resolves the tapped number against the
**`browseProductIds` snapshot** captured when the list was rendered, falling back
to a fresh page slice only when there's no snapshot yet. A catalog change between
render and tap can no longer shift the numbering onto the wrong product. Covered
by a test that proves snapshot precedence over a fresh query. (Inline per-product
buttons — §8.2 — would remove this class of bug entirely; still recommended.)

### 8.4 Decorative ASCII headers (kept — operator preference)
`browse.list_decorated` uses box-drawing art (`╭═┅═━━…☉`). It was kept (the
numbered branded look is intentional); only **prices were added** per line
(§8.2). If it ever renders poorly on some client, a lighter layout is the
fallback. Stylistically distinct but it renders inconsistently across some
clients/fonts and eats some vertical space on mobile — consider a lighter,
scannable layout (one product + price per line, a
short header). Keep the brand flourish minimal.

### 8.5 Keep payment copy in sync with the matching strategy
`checkout.internal_instructions` tells the buyer they **must** include the
Note/Memo or it won't auto-confirm. Once §2.1 resolves how matching actually
works:
- If the memo field isn't captured by Binance, that copy is **misleading** —
  switch it to "send the exact amount **{amount}**; delivery is automatic"
  (amount fallback) and drop the memo mandate.
- If the memo works, keep it but make the amount exact (unique-cents) as a
  second safety net. Either way, the instruction string and the matcher must
  tell the same story.

### 8.6 ◑ PARTIAL — Error correlation id
- ✅ The global `bot.catch` now generates a short **ref** (e.g. `AB12CD`),
  attaches it to the log line (`ref=…`), and best-effort DMs the user
  `error.generic_ref` ("⚠ Something went wrong (ref: AB12CD)…") so an uncaught
  exception no longer leaves them on a dead screen and a customer report maps
  straight to the stack trace. EN+ID key added (parity guard covers it).
- ⏸ Optional next: thread the same ref through handler-level `error.generic`
  catches, and split **transient** ("try again") vs **hard** ("contact support")
  copy where the error type is known.

### 8.7 Never strand the user
Every terminal screen should offer at least one forward action (Menu / My
Orders / Back). The new confirmations include nav keyboards — keep that property
for all future flows; a confirmation with no buttons is a dead end on mobile.

### 8.8 ✅ DONE — Bilingual integrity guard
`packages/core/src/locales.test.ts` now fails CI if `en.json` and `id.json`
drift apart in **keys** OR in their per-key `{placeholder}` sets. Any English
leak from a one-sided key add is caught immediately. (Both files currently in
full parity.)

### 8.9 Quantity-input mode is stateful — guard the exits
Manual qty entry uses `awaitingQtyProductId` and disambiguates typed numbers
against `MENU_LABELS`. `smartEdit` clears the flag on navigation (good). Audit
any new entry/exit path to ensure the flag is always cleared, or a stray number
later gets misread as a quantity.

---

## 9. Suggested order of attack

1. Verify the Binance `note` field with a memo'd test transfer (§2.1) and decide
   note-vs-amount-vs-UID; flip on unique-cents (§2.2); sync payment copy (§8.5).
2. ~~Bot catalog UX: inline-per-product list (§8.2)~~ ✅ done (race §8.3 too).
   Optional follow-up: delete the dead numbered-keyboard machinery.
3. Global search (§4.2) — small, high QoL for the operator.
4. Bulk operations (§4.1) — biggest operator time-saver; mind single-writer.
5. Locale key-set CI guard (§8.8) + finish admin i18n sweep (§3.1).
6. Wallet ledger table (§5.1) and poller alerting (§5.3) for money-trail rigor.
7. ~~RBAC (§4.3) + 2FA (§4.4)~~ ✅ done — the auth review for public exposure is
   in good shape (RBAC, TOTP 2FA, force-logout, jti rotation).
