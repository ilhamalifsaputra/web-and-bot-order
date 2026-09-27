# Finance Architecture — pricing and FX

How this shop turns a catalogue price into an amount a buyer is actually
charged, and what protects that arithmetic.

This is the pricing/FX half of the money system. The accounting half — how a
charged total becomes balanced double-entry postings — lives in the ledger
(`packages/db/src/crud/ledger.ts`) and the metrics contract
(`docs/sales-metrics-contract.md`). See
[Relationship to the ledger](#relationship-to-the-ledger) for which document
answers which question.

Every claim below was verified against the code at the time of writing. Line
numbers drift; function and file names are the durable part of a citation, so
open the named function rather than trusting a line number that has moved.

---

## Table of contents

1. [Central-IDR pricing model](#central-idr-pricing-model)
2. [Deriving USDT: the rounding policy](#deriving-usdt-the-rounding-policy)
3. [The FX rate and its four guards](#the-fx-rate-and-its-four-guards)
4. [Minimum order amount](#minimum-order-amount)
5. [Unique cents and payment matching](#unique-cents-and-payment-matching)
6. [Read-time price quantization](#read-time-price-quantization)
7. [Already correct — things an audit should not re-flag](#already-correct--things-an-audit-should-not-re-flag)
8. [Relationship to the ledger](#relationship-to-the-ledger)
9. [Known gaps and accepted trade-offs](#known-gaps-and-accepted-trade-offs)
10. [Settings reference](#settings-reference)

---

## Central-IDR pricing model

**Rupiah is the one source of truth. Every USDT figure in this system is
derived, never independently priced.**

`packages/db/src/crud/pricing.ts` states the rule in its own module doc
comment (lines 1-7):

> Central-IDR price model: `Product.price` holds Rupiah — the one source of
> truth — and the USDT figure is DERIVED from the admin-set `usd_idr_rate`
> setting, rounded UP to the next 0.01. The transaction currency is chosen at
> PAY time (USDT → Binance, IDR → TokoPay) and snapshotted on the order
> together with the fx rate, so later rate edits never rewrite history.

What that means concretely:

- `Product.price` / `Denomination.price` / `Denomination.resellerPrice` are
  Rupiah amounts. There is no USDT price column anywhere in the catalogue.
- An order is created with a Rupiah total. The buyer's currency choice is
  applied afterwards, once, by `finalizeOrderPayment`
  (`pricing.ts:560`).
- `finalizeOrderPayment` converts the **total**, never the individual line
  items — "convert once per displayed price/total, never per component, to
  avoid double-rounding drift" (`usdtFromIdr`'s own doc comment,
  `packages/core/src/formatters.ts:66-96`).
- On the IDR branch it quantizes the total to whole Rupiah
  (`quantizeMoney(baseIdr, 0)`), clears `fxRate` to null and strips the unique
  cents (QRIS confirms by callback, not by amount matching).
- On the USDT branch it snapshots the rate it was handed onto `Order.fxRate`.
  A later admin rate edit therefore never rewrites a past order's arithmetic.

The one place this model is intentionally broken is the storefront client's
JavaScript mirror of the conversion
(`apps/storefront/client/src/lib/format.ts`, `formatUsdt`/`roundCeil`), which
exists so a shopfront figure matches the charged total to the cent. Its doc
comment is explicit that it has "no licence to round its own way" — if you
change `usdtFromIdr`, change that mirror in the same commit.

---

## Deriving USDT: the rounding policy

`usdtFromIdr` (`packages/core/src/formatters.ts:97-99`):

```ts
export function usdtFromIdr(idr: Decimal.Value, rate: Decimal.Value): Decimal {
  return new Decimal(idr).div(rate).toDecimalPlaces(2, Decimal.ROUND_CEIL);
}
```

**Step 0.01, always rounded UP (`Decimal.ROUND_CEIL`).** This is the current
and only policy.

### Why

Rupiah is the source of truth and every USDT figure is a derived quote the shop
has to honour. The rule has to answer the question "when the exact conversion
lands between two payable amounts, who absorbs the difference?" Ceiling answers
"the buyer, by at most one cent" — rounding always lands in the platform's
favour, so the shop can never be asked to honour a quote below the real
converted price.

Cutting the step from 0.1 to 0.01 pays for that: the worst-case overcharge is
now 0.01 USDT instead of 0.1, so a buyer is *closer* to the true converted price
than they were under the old rule, not further from it.

### The previous policy is gone

Before this change (Finance Hardening M13, audit item P2-1) the rule was
**step 0.1, half-up**. Half-up rounded half of all quotes *down*, so the shop
systematically undercharged on roughly half of its crypto sales, by up to 0.05
USDT a time — on a cheap order, a double-digit percentage of the sale.

Do not describe the 0.1/half-up rule as current behaviour anywhere. It survives
in exactly one place on purpose: `reconcileFinances`
(`packages/db/src/crud/reports.ts`) keeps a frozen, module-private
`legacyUsdtFromIdr` snapshot of it, so a USDT order priced before the change is
recognised as correctly-priced history instead of being reported as drift on
every past order. That snapshot is an exact-match exemption, never a widened
tolerance, and is unreachable from any pricing path.

**That exemption is dated** (review D8). It applies only to orders created before
`usdt_rounding_ceil_since`, the settings row recording when this shop's rounding
changed. It used to be open-ended, so a total landing on the old 0.1 figure was
excused *forever* — including on an order created today, long after anything
could legitimately produce that figure. A present-day 0.1-shaped total is a bug
in whatever wrote it, and it was the single class of USDT mispricing this report
could not see: the only figures it accepted without deriving them were the ones
it should have been most suspicious of.

The boundary is exclusive at the top: an order created at exactly that instant is
judged by the current rule, because the cutoff names the moment the new rule took
effect and the first order of the new era is the one most worth checking.

An **absent, blank or unparseable** value exempts nothing. That is the strict
direction on purpose — the permissive reading would quietly restore the
open-ended exemption this key exists to remove — and it is why the value is
seeded rather than defaulted in code: migration
`20260919120000_seed_usdt_rounding_ceil_since` writes `NOW()` (i.e. the deploy
instant, which for every existing shop *is* when the new rule started pricing
orders) with `ON CONFLICT DO NOTHING`. A hardcoded date could not be right for
two shops deploying on different days, and being wrong in the early direction
reports a shop's whole USDT history as drift.

### Two consequences that needed explicit handling

**1. No positive Rupiah amount converts to 0.0 USDT any more.**

Under the old step, Rp700 at a 16.000 rate became `0.0` — a real Rupiah amount
rounding away to nothing, leaving a gateway asked to collect zero and an order
no amount-matcher could ever recognise. That case is now unreachable: the same
Rp700 is `0.05`, and any positive Rupiah amount is at least `0.01`.

This is exactly the case `orderMinimums.ts` was originally built around. Its
`nothing_to_collect` backstop was deliberately **kept** rather than deleted, but
its meaning changed: it now guards a genuinely zero or negative total (a fully
discounted order that reached the rail instead of the zero-value short-circuit),
not a rounding artifact. See `railMinimumFailure`
(`orderMinimums.ts:193-228`) and its in-code comment, which says so directly.

Pinned by regression tests in `packages/core/src/core.test.ts`:
`usdtFromIdr("700", "16000") === "0.05"`, `usdtFromIdr("100", "16000") ===
"0.01"`, `usdtFromIdr("1", "16000") === "0.01"`.

**2. The unique-cents collision margin argument had to be re-proved.**

`computeUniqueCents` (`formatters.ts:163-166`) produces a deterministic offset
in the range 0.002 … 0.098 (49 buckets, step 0.002), added on top of the base
USDT total so two simultaneous transfers of the same base amount can be told
apart. The payment matchers compare `|received − total| <= AMOUNT_TOLERANCE`,
where `AMOUNT_TOLERANCE = 0.001`
(`apps/order-bot/src/payments/amountMatching.ts:27`).

With a 0.1 base step, the offset range (0.096 wide) was narrower than the step,
so two different Rupiah totals could never share a final USDT total. At the
0.01 step the offset range is *wider* than the base step, so **two different
Rupiah totals CAN now produce the same final USDT total.**

That is safe, and the argument is two-part:

- A base is a whole number of cents and an offset is a whole number of 0.002s,
  so every producible total is an even multiple of 0.001. Two producible totals
  are therefore either **equal** or **at least 0.002 apart** — never within
  `AMOUNT_TOLERANCE` of each other without being identical. Pinned by
  `core.test.ts`'s `"CLOSES THE GAP AT THE NEW 0.01 STEP: every producible
  total is > AMOUNT_TOLERANCE from every other"`.
- Exact ties are handled where they always were — see
  [Unique cents and payment matching](#unique-cents-and-payment-matching).

Read both `core.test.ts` tests before changing either constant or the rounding
step.

---

## The FX rate and its four guards

The rate lives in one setting, `usd_idr_rate` (Rupiah per 1 USDT). Four
independent mechanisms protect it. They are easy to conflate; they are not the
same lever and they do not have the same consequence.

### Where the rate comes from

`refreshUsdIdrRate` (`pricing.ts:273`) is the market updater. It:

1. Fetches the live USDT→IDR rate from CoinGecko's `/simple/price?ids=tether&vs_currencies=idr`
   endpoint (`packages/core/src/fx.ts`, `fetchUsdIdrMarketRate`). CoinGecko quotes USDT
   directly against IDR rather than proxying through a USD/IDR forex figure.
2. Applies the shop's protective spread (`applyUsdtSpread`, `fx.ts:149`).
3. Rounds to the configured step, default Rp100 (`roundRateToStep`, `fx.ts:32`).
4. Validates the **resulting figure** — after spread and rounding, not the raw
   market number — against the sanity band.
5. Saves it, or refuses.

It is called hourly by `scheduleFxRefresh` (`apps/order-bot/src/jobs/index.ts:1526`,
cron `"5 * * * *"`, plus one immediate run at boot) via `runFxRefreshTick`
(`jobs/index.ts:1553`), and on demand by web-admin's "update now" button with
`force: true` (which bypasses the `usd_idr_rate_auto` switch).

`refreshUsdIdrRate` returns a discriminated `FxRefreshResult`:
`"updated"` | `"unchanged"` | `"disabled"` | `"rejected"`.

### Guard 1 — the sanity band (`fx_rate_min` / `fx_rate_max` / `fx_rate_max_delta_pct`)

Before this existed, any number the market source answered was rounded and
saved, becoming the price of every USDT order with nothing catching a garbage or
wrong-unit response.

`validateUsdIdrRate` (`packages/core/src/fx.ts:97`) is a pure validator — not a
throwing guard, deliberately, so its caller can keep the previously saved rate in
effect, count the failure and alert an admin without reconstructing a reason from
an error message. It returns a discriminated `FxRateRejection` (`fx.ts:54-61`),
one of:

| `reason` | Meaning | Carries |
| --- | --- | --- |
| `not_a_number` | NaN or ±Infinity | — |
| `not_positive` | Zero or negative | — |
| `below_min` | Under the `fx_rate_min` floor | `min` |
| `above_max` | Over the `fx_rate_max` ceiling | `max` |
| `delta_too_large` | Moved more than `fx_rate_max_delta_pct` in one refresh | `lastKnown`, `deltaPct`, `maxDeltaPct` |

Every variant carries the figure it actually failed against, so the admin DM can
say *"17500 is 8.02% away from the saved 16200, past the 5% cap"* rather than
*"the rate was rejected"*.

The bounds are `FxRateBounds` (`fx.ts:70-77`), read from settings by
`fxRateBounds` (`pricing.ts:215`). The band is **inclusive at both ends** — a
rate landing exactly on `min` or `max` is inside the range an admin typed.
`lastKnown` being null (a first-ever fetch) skips the deviation check only; the
band still applies, which is what catches a source returning the wrong unit on
day one.

The `min`/`max` are **sanity** bounds, not a market range: they exist to catch a
source that starts answering in the wrong unit or returns a placeholder.
`fx_rate_max_delta_pct` is the check that second-guesses a real market move.

**When a rate is rejected, `refreshUsdIdrRate` writes nothing.** Not the rate,
and — critically — not the freshness stamp. Re-stamping an unverified rate as
fresh would be worse than not checking at all: a rate nobody has confirmed in
days, wearing a fresh timestamp. It also increments `fx_refresh_failures`
(`countFxRefreshFailure`, `pricing.ts:224`), a plain integer string reset to
`"0"` by the next refresh that actually confirms a rate, so a streak that
self-heals stops being reported as one.

### Guard 2 — the spread (`usdt_spread_bps`)

`applyUsdtSpread` (`fx.ts:149`) shaves the market rate by `bps` basis points
(100 bps = 1%) **before** rounding, so the saved figure — and therefore every
USDT order's `fxRate` snapshot — already carries it. It is a real pricing lever,
not a display tweak.

**The sign reads backwards at first glance.** `rate` is Rupiah per USDT and
every USDT figure is `idr / rate`, so **lowering the rate raises the USDT a
buyer sends** for the same Rupiah list price. That is the protective direction:
the shop over-collects crypto slightly relative to spot, which cushions the
conversion/withdrawal loss it takes turning that USDT back into Rupiah. A spread
that *raised* the rate would under-collect and hand the buyer the shop's FX risk.

Default is `"0"` — no spread, so nothing changes for a shop that never sets it.
A blank, zero, negative or unparseable value is a no-op, and so is a value of
10000 or more (which would zero or invert the rate).

**It applies to the automatic refresh only.** `applyUsdtSpread` is reached from
`refreshUsdIdrRate` and nowhere else, so a rate an admin types into web-admin is
saved exactly as typed. A shop that sets its rate by hand is not quietly getting a
spread on top — it is getting none, and has to build its margin into the figure it
types.

**A spread can no longer deadlock the refresh** (review D10 — fixed; do not
re-introduce the old comparison).

The delta check used to judge the post-spread figure against whatever
`usd_idr_rate` held. Raise the spread above the cap — or hand-type the raw market
figure — and the saved rate no longer carried that spread, so the next refresh
was refused for "moving too far" when the market had not moved at all. A refusal
saves nothing, so the tick after that compared the same two numbers and was
refused again: it never converged, the rate aged until `fx_rate_max_age_hours`
hid the USDT rail, and the rejection DM blamed the market the whole way down. A
10% spread under the 5% default cap was a permanent, self-inflicted USDT outage.

The cap is now measured **market-to-market**: the raw pre-spread market figure
against `usd_idr_market_rate`, the raw pre-spread figure of the last refresh this
shop accepted. `validateUsdIdrRate`'s `deltaOf` parameter is what separates the
two questions — the band judges the figure that would be SAVED (so a spread wide
enough to push it under `fx_rate_min` is still refused), while the deviation
check judges the market's own move. The spread now cancels out of the comparison
at any size.

`usd_idr_market_rate` is internal, not an admin field — it is a record of what
the market said, not a lever. Three states:

| State | Meaning |
| --- | --- |
| a usable figure | the cap is live and measures against it |
| **absent** | no reference recorded yet, so the cap is skipped for that one refresh, which then records it. **Every existing shop is in this state on the deploy that adds the key** — the same deploy-safety grace the freshness stamp gives a missing stamp |
| **`""`** | cleared by `setUsdIdrRate`, i.e. an admin typed a rate in. A hand-typed figure is not a market observation so it cannot become the reference, but a stale one must not be left behind either, or the next refresh would be measured against a figure from before the admin intervened. Cleared, the next refresh adopts the market afresh |

That last row is what keeps the documented remedy working: typing a rate in
un-sticks a refresh the band keeps refusing. Note the write order inside
`refreshUsdIdrRate` — its `"updated"` branch records the new reference **after**
calling `setUsdIdrRate`, whose clear would otherwise swallow it.

**Still true:** the spread applies to the automatic refresh only, and is never
applied to a hand-typed rate (see above).

### Guard 3 — the freshness stamp, and its two writers

Both staleness mechanisms below read the **same** setting:
`usd_idr_rate_updated_at` (`USD_IDR_RATE_UPDATED_AT_KEY`, `pricing.ts:56`).

It is an ISO timestamp of the last time the rate was **set or re-confirmed
against the market** — not "when the row was last written". An `"unchanged"`
market refresh stamps it even though the number did not move, because fetching
the live rate and finding it identical is a genuine re-confirmation.

**Exactly two production paths write it** (verified by tracing every reference
to `USD_IDR_RATE_UPDATED_AT_KEY`, `setUsdIdrRate` and `stampUsdIdrRateConfirmed`
across the repo; every other reference is a test):

1. **`refreshUsdIdrRate`**, on its `"updated"` and `"unchanged"` outcomes only.
   `"updated"` goes through `setUsdIdrRate` (`pricing.ts:163`, called at
   `pricing.ts:326`); `"unchanged"` calls `stampUsdIdrRateConfirmed` directly
   (`pricing.ts:323`). `"disabled"` and a throwing fetch stamp nothing —
   nothing was checked, so the rate's freshness claim is exactly what it was.
   `"rejected"` stamps nothing either, for the reason given above.
2. **A manual admin edit** of `usd_idr_rate` in web-admin, via `applyFieldEdit`
   (`apps/web-admin/src/routes/api/settings.ts:391-411`), which routes through
   the same `setUsdIdrRate`. Typing a rate by hand is a re-confirmation of it,
   so it must stamp freshness exactly like a market refresh — otherwise a shop
   that sets its rate manually would have every USDT order refused once the TTL
   elapsed.

   One deliberate exception: **clearing** the rate (`value === ""`) falls
   through to a plain `setSetting` and stamps nothing. An absent rate is not a
   confirmed-fresh one, and clearing it already disables the USDT path entirely.

`setUsdIdrRate` is the single sanctioned mutator — the value and its stamp are
written together there so the two can never drift apart, which is the whole
basis of both checks below. `usd_idr_rate_updated_at` is not in web-admin's
`EDITABLE` allowlist (`settings.ts:48`), so an admin cannot hand-edit the stamp
itself.

`setUsdIdrRate` deliberately does **not** validate its input: web-admin's rate
field is free text, and parsing there would turn a typo into a 500 instead of
the saved-as-typed behaviour every caller has today. Value validation is the
sanity band's job, at refresh time.

### Guard 3a — `fx_quote_ttl_minutes`: stop offering USDT (default 180 **minutes**)

`assertFxQuoteIsFresh` (`pricing.ts:491`, module-private) is called from
`finalizeOrderPayment`'s USDT branch at `pricing.ts:605`. If the stamp is older
than `fx_quote_ttl_minutes`, it logs a warning and throws
`ValidationError("error.fx_quote_expired")`.

**What it actually guards.** `finalizeOrderPayment` never reads `usd_idr_rate`
itself — it snapshots whatever rate its caller passed, and every real caller
fetches that rate and finalizes in the same handler invocation, milliseconds
apart. So "how old is this buyer's quote" is never the risk. The risk is that
`usd_idr_rate` **itself** went stale: the hourly auto-update failing silently, or
`usd_idr_rate_auto` switched off months ago and forgotten. Left unguarded, every
USDT order would keep being priced off that frozen number indefinitely with
nothing anywhere saying so.

It runs **before any row is touched** — before the conversion, and above the
rail-minimum guard — so a refused order is left exactly as its creator made it
and the caller can offer a fresh quote or the IDR rail instead. Same contract as
the minimum-order guard below it.

It never blocks an IDR order.

**The checkout rail lists consult it too.** `assertFxQuoteIsFresh` and the
predicate `usdIdrQuoteIsFresh` are both thin wrappers over one read,
`usdIdrQuoteStaleness` — the same one-implementation-two-wrappers shape
`railMinimumFailure` has in `orderMinimums.ts`, and for the same reason. The
bot's `offerableRails` and the storefront's `checkoutView` call the predicate, so
a USDT rail is never advertised to a buyer whose tap the guard is about to
refuse. Before that, a shop whose auto-update died spent the whole window between
the quote TTL and `fx_rate_max_age_hours` (two days) showing every USDT button
and refusing every one of them — which reads as a broken shop rather than as
"pay in Rupiah instead". So the practical effect of this lever is not "one order
is refused"; it is **no USDT rail is offered at all**, with the throw reserved
for a screen rendered before the quote expired.

**Why the default is 180 minutes, not 60** (whole-branch review D7). The market
refresh is an hourly cron (`scheduleFxRefresh`, `"5 * * * *"`), so a 60-minute TTL
was exactly one tick: a single missed tick — a redeploy landing on the wrong
minute, a blip at the rate source, a slow fetch — took USDT off every checkout
screen shop-wide until some later tick happened to succeed. Paying for one
transient failure with a payment method is not what this lever is for. At three
ticks, it fires only once the refresh has genuinely stopped working — which is
also the moment the admins are now DMed about it (Guard 4).

**Admins are alerted when it trips.** `alertIfUsdIdrRateStale` fires at *both*
thresholds now, not just the outer one — see Guard 4.

Both lists exempt a **zero total**, exactly as they already exempt it from the
rail minimums: a nothing-left-to-collect order is settled from the shop's own
books (`settleFullyDiscountedOrder`) and never reaches `finalizeOrderPayment`, so
no freshness check can refuse it, and hiding its options would strand a buyer
whose voucher covered their cart.

### Guard 3b — `fx_rate_max_age_hours`: hide the whole USDT rail (default 48 **hours**)

`usdIdrRateStaleness` (`pricing.ts:375`) is a pure, side-effect-free read of the
same stamp against `fx_rate_max_age_hours`. `getUsdIdrRate` (`pricing.ts:416`)
calls it and returns **`null`** once the horizon is passed.

Returning null is the entire kill-switch, landed in one function rather than at
each of the dozen call sites, because every real caller already treats a null
rate as "USDT is not available" and already has the copy for it: the
storefront's two wallet checkouts raise `web.pay_method_unavailable`, the bot's
`currentUsdtRate` makes its screens Rupiah-only, web-admin's stock export leaves
the USDT column blank. That copy reads correctly for both causes — a buyer can
do nothing about either, and "pay in Rupiah instead" is the right next step
whether the rate is missing or merely old. Telling them *which* would leak an
operational fault into a shopfront for no gain; admins get the real explanation
by DM.

`getUsdIdrRate` takes an `allowStale` escape hatch. Two production call sites
use it:

- `packages/db/src/crud/referrals.ts:87` — converting an already-settled IDR
  order into the USDT wallet to pay a commission. Dropping an already-earned
  commission is a silent, permanent loss for the referrer with nothing to retry,
  and the conversion is not a quote anyone can act on, so an old rate beats no
  rate. (`pricing.ts`'s own doc comment calls this "the one caller"; it is now
  the one *pricing-adjacent* caller.)
- `apps/order-bot/src/jobs/index.ts:1567` — reading the saved rate purely to
  quote it back in the rejection DM. Reports nothing to a buyer.

**Do not reach for `allowStale` anywhere a buyer is being quoted a price.**

### The two staleness levers, side by side

| | `fx_quote_ttl_minutes` | `fx_rate_max_age_hours` |
| --- | --- | --- |
| Unit | **Minutes** | **Hours** |
| Default | `180` (3× the hourly refresh) | `48` |
| Reads | `usd_idr_rate_updated_at` | `usd_idr_rate_updated_at` (same stamp) |
| Enforced in | `assertFxQuoteIsFresh` → `finalizeOrderPayment` | `usdIdrRateStaleness` → `getUsdIdrRate` |
| Blast radius | Every USDT rail stops being offered; prices still show USDT | **The whole USDT rail, shop-wide** |
| Symptom | The USDT rails stop being offered; a tap on a screen rendered before it expired gets `error.fx_quote_expired` | USDT stops being offered **or displayed** anywhere (no USDT prices either) |
| Admin DM | `ADMIN_FX_RATE_STALE`, `stage: "quote_ttl"` | `ADMIN_FX_RATE_STALE`, `stage: "max_age"` |
| Admin-editable in web-admin | Yes | Yes |

They are layered on purpose: a shop whose auto-update dies at 09:00 stops
offering USDT three hours later (quote TTL) and stops advertising USDT two days
later (max age). Each threshold raises its own DM, so the second one is not the
first the admins hear about it.

### Deploy-safety grace: a missing stamp is not a stale one

Both checks treat a **missing or unparseable** stamp as "freshness unknown" and
let it through. The same applies to a blank, non-numeric or non-positive TTL or
horizon: an unusable value means "this check is off", never "reject everything".

Do not "fix" this into a hard failure. Every shop that has not hit either write
path since this shipped, and every shop whose rate was seeded directly (e.g. by
`scripts/convert-prices-to-idr.ts`), has no stamp — rejecting them would be a
self-inflicted checkout outage with no actual staleness behind it. The stamp
appears the first time the rate is refreshed or edited, and both guards become
real from then on.

This "blank/unusable means the check is off" convention is repo-wide for
free-text numeric settings — see `parseMinAmount` (`_minAmount.ts`),
`numericSetting` (`pricing.ts:203`) and `roundRateToStep`'s invalid-step
handling. An admin's typo must cost the shop a disabled safety check, never a
pricing outage.

### Guard 4 — how admins actually find out

`refreshUsdIdrRate` **deliberately does not alert anyone.** Its two callers
differ: the hourly cron has nobody watching, while web-admin's "update now"
button answers the admin who pressed it, on screen, synchronously. Alerting from
inside the function would DM every admin about a failure one of them is already
reading.

Alerting therefore lives in the caller, and goes through the **notification
outbox**, never a direct `api.sendMessage` — the FX cron holds no bot `Api`
reference at all, on purpose, so it keeps running on a web-only boot. (This also
satisfies the repo-wide rule that web/cron code never sends Telegram directly.)

Two outbox events (`NotificationEvent`, `packages/core/src/enums.ts:659` and
`:674`), both routed as admin DMs by
`packages/outbox-dispatcher/src/dispatcher.ts:108-109` and rendered by
`templates.ts:457` / `:508`:

| Event | Enqueued by | Fires when |
| --- | --- | --- |
| `ADMIN_FX_RATE_REJECTED` | `enqueueAdminFxRateRejected` (`crud/notifications.ts:350`), called from `alertIfFxRateRejected` (`pricing.ts`, itself called from `runFxRefreshTick`) | The hourly refresh got a rate the sanity band refused. Payload carries the reason, the market figure, the post-spread/rounding figure, the still-saved rate and the consecutive-failure count. |
| `ADMIN_FX_RATE_STALE` | `enqueueAdminFxRateStale` (`crud/notifications.ts`), called from `alertIfUsdIdrRateStale` (`pricing.ts`, itself called from `runFxRefreshTick`) | The saved rate crossed **either** staleness threshold. `stage: "quote_ttl"` = past `fx_quote_ttl_minutes`, so no USDT rail is offered any more (prices still shown); `stage: "max_age"` = past `fx_rate_max_age_hours`, so USDT is hidden shop-wide. The two render different messages, because the consequence an admin must act on differs. |

**Both alerts fire once per EPISODE, not once per hourly tick**, each through its
own marker in the settings table:

- `alertIfUsdIdrRateStale`'s episode key is the freshness stamp, **qualified by
  which threshold was crossed**, remembered in `fx_stale_alerted_for`. One
  outage that crosses the quote TTL and then, hours later, the outer horizon is
  two different pieces of news about one stamp — the second says USDT prices have
  gone as well — so each raises its own DM while every repeat tick of one stage
  stays quiet. The `max_age` stage keys off the bare stamp, exactly what this
  marker held before the quote-TTL stage existed, so a shop mid-outage when that
  shipped is not DMed twice about an episode it was already told about. A later
  refresh clears the marker and writes a new stamp, so a subsequent staleness
  episode is a genuinely different outage and gets its own DM.
- `alertIfFxRateRejected`'s episode key is the rejection's **reason**, remembered
  in `fx_rejected_alerted_for`. A source stuck in one failure mode produces the
  same reason every hour with no new information in it, so only the first gets a
  DM (whose `consecutive_failures` figure says how long the streak has run). A
  reason that *changes* — below the floor one hour, past the delta cap the next —
  is different news and gets its own DM. The figures deliberately stay out of the
  key, or a drifting source would make every tick a fresh "episode".

Both markers are re-armed by `clearFxFailureState`, which runs whenever a rate is
confirmed — by a market refresh **or by an admin typing it in** (`setUsdIdrRate`).
The manual path matters: typing the rate in is the remedy the rejection DM
recommends, so it has to end the streak (`fx_refresh_failures` back to `"0"`) as
well as the episode, or the next DM would quote a failure count from a run that
was already over.

web-admin's own "update now" button never alerts at all — the admin who pressed it
is reading the refusal on screen — and therefore never marks an episode as
told-about, so it cannot silence the cron.

The staleness check runs even when the refresh threw or was disabled — those are
precisely the states that *produce* staleness — and the two failure paths are
isolated from each other in `runFxRefreshTick` so neither can suppress the other.

The developer-facing Pino lines are separate from the admin-facing DM copy, on
purpose: different audiences, different detail, different language. See
`describeFxRejection` (`pricing.ts:340`) for the English one-sentence
developer wording.

---

## Minimum order amount

`packages/db/src/crud/orderMinimums.ts` (Finance Hardening M11, audit P0-1).

Two failure modes it closes, both previously unguarded:

- A total below a gateway's own documented minimum, which the gateway then
  rejects out of band, leaving the buyer on a payment screen that can never
  succeed.
- (Historically) a Rupiah total small enough that the IDR→USDT conversion
  rounded it away entirely. No longer reachable for a positive Rupiah total
  since the rounding change — see
  [the rounding policy](#deriving-usdt-the-rounding-policy).

### Where the numbers come from

Every figure is a real admin-set setting. None is invented in this module.

- **Per-rail override**: each rail's existing `<rail>_min_amount` setting —
  `tokopay_min_amount`, `paydisini_min_amount`, `nowpayments_min_amount`,
  `bybit_min_amount`, `bybit_bsc_min_amount`, `binance_internal_min_amount`
  (mapped in `PER_METHOD_MIN_AMOUNT_KEYS`, `orderMinimums.ts:88`). These already
  existed and already had web-admin fields; before M11 they were read only to
  *print* an informational note. M11 enforces them. Each is denominated in the
  currency its rail settles in: Rupiah for TokoPay/PayDisini, USDT for the four
  crypto rails.
- **Shop-wide fallback**: `min_order_amount_idr` (`orderMinimums.ts:77`), in
  Rupiah, default `"1000"` (`DEFAULT_MIN_ORDER_AMOUNT_IDR`, `:80`).

`PaymentMethod.BINANCE_PAY` has no per-rail setting (manual proof upload, bot
only), so it falls through to the shop-wide minimum.

### Each minimum is compared in its OWN currency, never converted

This is the design decision most likely to be "helpfully" undone by a later
reader, so the reasoning is worth stating plainly.

Converting the Rupiah floor into USDT to compare it against a USDT total would
make the enforced number something other than the number an admin typed. At a
16.000 rate a Rp100 floor converts to `0.01` USDT, which is Rp160 back again —
60% stricter than the figure entered, and a different distortion at every rate.
Under the *old* rounding rule it was worse: it converted to `0.0`, i.e. no
minimum at all — the exact bug this module exists to prevent.

So `railMinimumFailure` (`orderMinimums.ts:193`) compares the shop-wide Rupiah
floor against the order's **central-IDR** total, and a rail's own floor against
the **rail-currency** total. No exchange rate is involved in either comparison,
and `usdtFromIdr`'s rounding step cannot distort it.

### WALLET is exempt entirely, at every layer

`PaymentMethod.WALLET` returns `null`/no-failure from `resolveRailMinimum`
(`:131`) and `railMinimumFailure` (`:203`) before anything else runs. A wallet
payment is an internal ledger movement — there is no rail with a floor to clear,
and its own sufficiency rule (`error.insufficient_wallet`) already governs it.

### One implementation, three consumers

| Function | Used by |
| --- | --- |
| `railMinimumFailure` (`:193`) | the shared implementation |
| `orderTotalClearsRailMinimum` (`:170`) | checkout payment-method lists — `offerableRails` (`apps/order-bot/src/handlers/checkout.ts:145`) and `railsClearingTheTotal` (`apps/storefront/src/routes/checkout.ts:343`) |
| `assertOrderTotalClearsRailMinimum` (`:237`) | the throwing guard in `finalizeOrderPayment` (`pricing.ts:577` IDR branch, `:615` USDT branch) |

Because the offered list and the finalize-time rejection share one
implementation, **a buyer can never be offered a rail that would refuse their
own tap.**

The guard runs before any row is written, so a rejected order keeps the exact
shape its creator left it in — no payment method, no expiry, no reference
pointing at a gateway that was never going to accept it.

### On a USDT rail, the floor is judged after the buyer's credit

Every USDT caller — `createInternalOrder`, `createBybitOrder`,
`createBybitBscOrder` and the bot's NOWPayments handler — calls
`finalizeOrderPayment` and then spends the buyer's USDT credit on the finalized
total with `applyUsdtWalletToOrder` (`crud/orders.ts`). The minimum guard sits
between those two steps, so judging the pre-credit total would put the guard on
the wrong side of the only figure that matters: what the gateway is actually
asked for. A buyer whose credit covered all but a sliver of the order got that
order finalized against a rail that then refused the sliver out of band — the
very failure this guard exists to prevent (whole-branch review D6).

`PaymentChoice.walletAmount` (`pricing.ts`) carries the credit the caller is
about to spend, and the USDT branch subtracts it from **both** figures the guard
compares, each in its own currency: the rail amount loses the credit itself, and
the central-IDR amount loses `credit × rate`, because the shop-wide floor is a
Rupiah figure. Omitted or zero, every figure is exactly what it was before.

Two boundaries of that behaviour, both deliberate:

- The credit is clamped **to the payable total only**, never to the buyer's
  balance. An unaffordable request is `applyUsdtWalletToOrder`'s
  `error.insufficient_wallet` to raise; pre-empting it here with
  "that total is too small" would name the wrong problem.
- A credit that covers the whole converted total **exempts** the order, like a
  zero total: there is no rail amount left to floor. An order that is zero for
  any other reason still meets the `nothing_to_collect` backstop.

The two checkout rail lists do not need the same treatment, and each for its own
reason. The bot's `offerableRails` is already handed the subtotal *after* credit
(the bot's credit is all-or-nothing, so that figure is either the full subtotal
or exactly zero, and zero is never filtered). The storefront never combines
credit with a gateway at all — `performCheckout`/`performDirectCheckout` pass no
`walletAmount`, and the SPA offers credit only as an all-or-nothing method that
settles without a gateway.

Failures are typed (`RailMinimumFailure`, `:183`) and surface as:

- `error.amount_below_rail_minimum` (carries `min` and `currency`)
- `error.amount_too_small_for_rail` (the `nothing_to_collect` backstop; carries
  only `currency`, because the floor it fails is "more than zero", which is not
  a configured amount — printing an invented one would misreport it)

#### A wallet top-up gets its own two sentences (review D9)

An IDR wallet top-up reaches this guard through `finalizeOrderPayment`'s IDR
branch, exactly like a product order, and used to inherit that flow's copy with
it: *"That total is below the minimum… **Add more items**, or choose a different
payment method."* There is no cart on a top-up form, so the one instruction the
message gave was impossible to follow, on the screen where the buyer had just
typed a number they could simply have typed larger.

`assertOrderTotalClearsRailMinimum` now takes a `purpose`
(`RailMinimumPurpose`, defaulting to `"order"`) that selects the message pair and
nothing else. `finalizeOrderPayment` derives it from `order.kind`, not from an
argument: a caller that had to declare itself would eventually forget, and
`createWalletTopupOrder` is not the sort of caller worth trusting to remember.
The top-up pair is `error.wallet_topup_below_rail_minimum` and
`error.wallet_topup_nothing_to_collect`.

**The floor itself is still shared**, and deliberately. `min_order_amount_idr`
is the shop's "we will not ask a gateway to collect less than this" figure — a
property of the rail and the shop, not of what is being bought — and a top-up
already has its own separate bound in `wallet_topup_min_amount_idr`, checked
earlier by `createWalletTopupOrder`. A second top-up-specific rail floor would
give a top-up two floors with nothing to say about which one an admin meant.

**The top-up copy carries no placeholders**, unlike its product twin. The
storefront surfaces a `ValidationError` as its key alone — its API client throws
`new Error(body.error)`, dropping `formatArgs` — so a `{min}` in this copy would
reach the buyer as literal braces. `locales.test.ts` pins that: both keys must
stay placeholder-free in both languages, and no `error.wallet_topup_*` string may
mention a cart. `formatArgs` is still populated on the throw, so the bot, the
logs and the tests can see the figure that failed.

Known gap, not addressed here: neither the bot's nor the storefront's top-up form
mentions the rail floor in its min/max hint (`wallet.topup_min_hint` /
`web.wallet_topup_min_hint` read only the top-up bounds), so a buyer can be shown
"minimum Rp1.000" and still be refused at Rp5.000 by a Rp10.000 rail floor. The
refusal now at least tells them what to do about it.

### The zero-value short-circuit

A voucher or bulk rule can cover an order's whole price before wallet credit is
even considered. Such an order is created with a Rp0 total and left
`PENDING_PAYMENT` like any other. Before M11 the checkout flow handed it to
whichever gateway the buyer had nominally picked, asking it to collect nothing;
after M11's guard that attempt is refused outright — which would leave a
fully-discounted order unbuyable by any route.

So this is a **routing** rule, not a rejection. There is nothing to collect, so
nothing is collected, and the buyer gets the normal "paid, here's your delivery"
outcome.

- `orderHasNothingLeftToCollect` (`packages/db/src/crud/wallet_checkout.ts:147`)
  is the single place that question is answered, so a checkout entry point
  deciding to skip the gateway and the settle function agreeing can never
  disagree. It subtracts the unique cents for the same reason
  `finalizeOrderPayment` derives its `baseIdr` that way — the cents are matching
  noise the order carries from creation, not money anyone owes. A voucher
  covering the whole price leaves a `totalAmount` of a few hundredths of a
  Rupiah, not a literal zero; reading the column alone would miss every
  fully-discounted order on a live deploy while passing in any test that turns
  unique cents off.
- `settleFullyDiscountedOrder` (`wallet_checkout.ts:179`) settles it **from the
  shop's own books**: `paymentMethod: WALLET`, currency IDR, no unique cents, no
  gateway field ever touched. It re-derives the "nothing left to collect" claim
  from the freshly created row and throws `error.order_still_owing` if the claim
  no longer holds, so a voucher that stopped covering the price between the
  screen and this call fails here rather than delivering goods nobody paid for.
  It writes no `WalletTransaction` — it moves no money.
- The buyer's chosen currency is deliberately not honoured: a zero total
  converts to zero in either one, and booking a nonexistent charge in USDT would
  attach an exchange rate to a payment that never happened.

Wired at **both** checkout entry points, not inside `finalizeOrderPayment` —
which keeps that function's existing contract (stamp payment fields; never
settle or deliver) intact:

- `apps/storefront/src/routes/checkout.ts:687` and `:803`
- `apps/order-bot/src/handlers/checkout.ts:1690`, via
  `settleDiscountCoveredOrder`

Both run inside the caller's `$transaction` alongside the order creation, so a
failure rolls the whole checkout back.

---

## Unique cents and payment matching

The two memo-less crypto rails (BYBIT Internal Transfer and BYBIT_BSC on-chain
BEP20) can only identify a payment by its **amount**. `computeUniqueCents`
(`formatters.ts:163`) adds a deterministic per-order offset (0.002 … 0.098, 49
buckets) so two simultaneous transfers of the same base amount are
distinguishable. Controlled by `USE_UNIQUE_CENTS` (`packages/core/src/config.ts:85`,
default on).

**Collision avoidance is already correct and was re-verified after the rounding
change — this needs no redesign.**

`finalizeOrderPayment` (`pricing.ts:662-677`) runs a retry loop for BYBIT and
BYBIT_BSC that allocates a collision-free total against **the real pending-order
pool the matcher itself reads**: `paymentMethod: method`, `status:
PENDING_PAYMENT`, `expiresAt: { gt: now }`, same `totalAmount`. Bumping the seed
by +1 each cycle walks all 49 buckets before repeating. `paymentMethod: method`
scopes it per rail, so a BYBIT order and a BYBIT_BSC order never collide with
each other's pool — each is matched by its own independent poller.

Covered by:

- `packages/db/src/crud/pricing.test.ts`, describe block
  `"finalizeOrderPayment — BYBIT vs BYBIT_BSC collision-avoidance is scoped per
  method"`, including its `"control: a same-amount pending order under the SAME
  method does trigger a bump"` case (`:732`) — which seeds a decoy PENDING order
  at exactly the total a second order's first attempt will compute, the
  deterministic way to force the collision branch.
- `packages/core/src/core.test.ts`'s two margin-proof tests, covering the
  lower-level `AMOUNT_TOLERANCE` argument.

**Amount-only matching is safe because the candidate pool is already scoped.**
`matchByAmount` (`apps/order-bot/src/payments/amountMatching.ts:193`) compares by
amount alone, but by the time any caller reaches it the candidate list has
already been narrowed by rail/account, on-chain address/network (BSC), and time
window. Rather than re-explaining that here, read `matchByAmount`'s own doc
comment (`amountMatching.ts:163-191`), which cites all three filters at the
files that apply them — it is deliberately the single authority on this, sitting
on the function a reader opens first.

---

## Read-time price quantization

`createDenomination` / `updateDenomination`
(`packages/db/src/crud/catalog.ts`) quantize `price`/`resellerPrice` to **four**
decimal places at write time — deliberately wider than the rail, so an admin can
type a markup-derived figure without it being rounded under them.

But Rupiah has no fractional unit anywhere downstream. `flashPrice` rounds to
0dp, and `finalizeOrderPayment`'s IDR branch rounds the order total to 0dp
before any gateway sees it. A row holding `8900.37` — written through that 4dp
path, or by hand against the database — is a state every price consumer
implicitly assumes cannot happen.

The `wholeRupiah` helper (`packages/core/src/flash.ts:60`) makes that assumption
true, at read time:

```ts
function wholeRupiah(price: Decimal.Value): Decimal {
  return quantizeMoney(price, 0);
}
```

**It is half-up, not floor** — `quantizeMoney`'s own rule
(`formatters.ts:11-13`, `Decimal.ROUND_HALF_UP`). That is for consistency with
the two roundings this figure meets downstream, `flashPrice`'s and
`finalizeOrderPayment`'s, both of which are half-up; a unit price rounded the
other way would drift against the total computed from it. The direction is not a
buyer-protection question at this scale — the gap is under one Rupiah, on a
figure that only has a fractional part because of a data-entry artifact.

**Why it lives in `flashPrice`/`effectiveUnitPrice` and not at every call site.**
There are roughly a dozen places that read a catalogue price. `flash.ts` is the
one module that decides what a unit actually costs right now — the bot catalog,
the storefront grids/cart/checkout and `createOrder*` in `@app/db` all go through
`effectiveUnitPrice` (`flash.ts:129`), precisely so a buyer can never be shown
one price and charged another. Putting the floor there makes it unavoidable;
putting it at each call site makes it something a thirteenth call site can
forget.

It also fixes a real arithmetic question: `flashPrice` (`flash.ts:100`) now takes
its percent off the **whole-Rupiah** list price, not the stored 4dp figure. The
discount a buyer is promised is a percent off the price they were shown, and
rounding both ends the same way stops one SKU having two defensible sale prices
depending on which end rounds first.

This is deliberately **not** a write-time change — the 4dp column stays as it
is, in the same spirit as `activeFlashPercent` re-validating
`flashDiscountPercent`'s bounds at read time rather than trusting the write-time
guard.

---

## Already correct — things an audit should not re-flag

Each of the following was independently checked during the finance-hardening
pass and found already handled. They are recorded here with real citations so a
future audit does not re-open them as gaps.

### Wallet debit atomicity — handled

`adjustWallet` (`packages/db/src/crud/users.ts:273`) takes the user row's write
lock before reading the balance:

```ts
await trx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
```

(`users.ts:288`.) The read of the current balance, the overdraw check and the
write-back are one read-modify-write cycle; under Postgres two callers for the
same user can genuinely run it at the same instant, and without the lock both
would read the same pre-movement balance, both would pass their own overdraw
check, and whichever committed last would silently overwrite the other — a
double-spend on debits, a lost credit on top-ups. (Under the old SQLite
deployment the single-writer pool serialised this accidentally. That protection
is gone; this lock replaces it.)

A row lock only lasts as long as its transaction, so `adjustWallet` opens one
when handed the bare client and reuses the caller's `tx` when given one.

The ledger row is written **before** the balance, on purpose: `wallet_transactions`
is `UNIQUE(orderId, reason)`, so that insert can legitimately fail, and failing
first means the rejection aborts before any money moves rather than relying on a
rollback to undo it.

Covered by `packages/db/src/crud/wallet_concurrency.test.ts`.

### Webhook / poller idempotency — handled

Five insert-first-on-unique idempotency tables, each unique-constrained on the
provider's own transaction id:

| Model | Table | Unique column | `prisma/schema.prisma` |
| --- | --- | --- | --- |
| `ProcessedBinanceTx` | `processed_binance_tx` | `binance_tx_id` | `:1648` |
| `ProcessedBybitTx` | `processed_bybit_tx` | `bybit_tx_id` | `:1666` |
| `ProcessedTokopayTx` | `processed_tokopay_tx` | `trx_id` | `:1682` |
| `ProcessedPaydisiniTx` | `processed_paydisini_tx` | `trx_id` | `:1697` |
| `ProcessedNowpaymentsTx` | `processed_nowpayments_tx` | `trx_id` | `:1712` |

Five tables for six rails: **BYBIT_BSC shares `ProcessedBybitTx` with BYBIT**
(`packages/db/src/crud/bybit_bsc_deposit.ts` writes `db.processedBybitTx`, keyed
on the on-chain `0x…` txID). The ids do not overlap, so one table is correct —
but do not go looking for a `ProcessedBybitBscTx` that does not exist.

The pattern is: claim the id by INSERT first; a unique violation means it was
already claimed, so stop. A repeated poll cycle or a redelivered webhook can
therefore never double-deliver.

Status moves are separately idempotent. `transitionOrderStatus`
(`packages/db/src/crud/orderStatus.ts:124`) validates the shape against
`LEGAL_TRANSITIONS`, then atomically claims the row with an `updateMany` whose
WHERE clause names the expected current status — so a stale or duplicate caller
fails safely instead of overwriting an order that already moved on — and writes
exactly one `OrderStatusHistory` row in the same call.
`tryTransitionOrderStatus` (`:159`) is the same thing with a lost race as a
benign no-op, for callers where "another poller already moved this order past
this point" is an expected outcome (the BSC deposit poller and the confirmation
tracker both touch the same order on independent timers).

### Voucher usage atomicity and per-user limits — handled

`bumpVoucherUsage` (`packages/db/src/crud/orders.ts:156`, module-private) is a
single atomic conditional `updateMany`:

```ts
const bumped = await db.voucher.updateMany({
  where: { id: voucher.id,
           OR: [{ usageLimit: null }, { usedCount: { lt: voucher.usageLimit ?? undefined } }] },
  data: { usedCount: { increment: 1 } },
});
if (bumped.count === 0) throw new ValidationError("error.voucher_used_up");
```

One statement's row-level atomicity makes this safe under any isolation level —
unlike a separate read-check-then-increment, which only stayed safe under SQLite
because `BEGIN IMMEDIATE` serialised concurrent transactions. Called from both
order-creation paths (`orders.ts:826`, `:1010`).

Per-user capping is enforced at the schema level: `VoucherRedemption` carries
`@@unique([voucherId, userId], map: "ix_voucher_redemptions_voucher_user")`
(`prisma/schema.prisma`), so one redemption per voucher per user is a database
constraint, not an application check.

### No `Numeric(12,4)` overflow risk — handled (and the premise was wrong)

There is **no `@db.Decimal(...)` annotation anywhere in `prisma/schema.prisma`**
(verified: zero occurrences). Money columns are declared as bare `Decimal`, so
Prisma's PostgreSQL default applies. The actual applied column type, read from
the baseline migration SQL
(`prisma/migrations/20260827050616_postgresql_baseline/`), is
**`DECIMAL(65,30)`** — all 41 decimal columns across every migration use it.

That is not a precision an application amount can overflow. A comment claiming
`Order.totalAmount` is "stored at 4dp" was corrected during this build for the
same reason: 4dp is the discipline app-written amounts are *quantized to*, not
what the column holds.

### Refund FX arbitrage — not reachable

`refundUnderpaidOrder` (`packages/db/src/crud/binance_internal.ts:959`) credits
**exactly the amount actually received**, in **the order's own currency**:

```ts
const received = (await findUnderpaidReceived(tx, args.orderId)) ?? new Decimal(0);
await adjustWallet(tx, order.userId, received, {
  reason: "underpaid_refund",
  currency: order.currency as "IDR" | "USDT",
  ...
});
```

No live rate is read, no conversion happens, and the whole thing runs in one
transaction. A USDT order returns USDT and a Rupiah order returns Rupiah —
`adjustWallet` silently defaults to IDR when no currency is passed, which would
otherwise pay a crypto buyer back in the wrong money entirely.

There is also **no IDR↔USDT wallet-conversion feature anywhere in this
codebase** (verified by search). The two balances — `User.walletBalance` and
`User.walletBalanceUsdt` — are separate books with no exchange path between them,
so there is no rate spread for a buyer to round-trip through.

Both the wallet credit and the `Refund` record are gated on
`received.greaterThan(0)`, so a zero-received UNDERPAID order leaves no
misleading `COMPLETED` refund of 0.00 implying a payout that never happened.

---

## Relationship to the ledger

This document and the ledger docs cover **deliberately separate concerns**:

| You are debugging… | Read |
| --- | --- |
| "Why is this USDT total wrong?" | **This document.** Pricing and FX: how a Rupiah amount becomes a charged total. |
| "Why is this order's minimum/rail rejection firing?" | **This document.** |
| "Why is the price on screen different from the price charged?" | **This document** (rounding, read-time quantization, the storefront mirror). |
| "Why doesn't the ledger balance?" | `packages/db/src/crud/ledger.ts` and `reconcileLedger.ts` module doc comments. Accounting: how a charged total becomes balanced double-entry postings. |
| "Where does this dashboard number come from?" | `docs/sales-metrics-contract.md`. |

The boundary in one line: **pricing decides the number; the ledger records what
happened to it.**

Pointers rather than duplication — each of these files carries its own
authoritative reasoning, and copying it here would create a second copy to drift:

- **`packages/db/src/crud/ledger.ts`** — the ONLY writer of
  `FinancialTransaction`/`LedgerEntry` rows, plus `getAccountBalance` (`:561`)
  and `trialBalance` (`:592`). Its doc comment explains why being the only
  writer is load-bearing (every invariant — positive amounts, entry currency
  matching account currency, debits equalling credits per currency — is an
  application-layer invariant, because `db push` is the deploy mechanism and
  Postgres cannot express the third at all) and the two things it enforces that
  no call site could: balance-before-write, and one economic effect per
  `idempotencyKey` (`postFinancialTransaction`, `:340`).
- **`packages/db/src/crud/ledgerPostings.ts`** — the posting map: which
  chart-of-accounts rows each real money event touches and in which direction.
  Its three load-bearing conventions are in its doc comment: amounts and
  currencies come from the `WalletTransaction` row rather than the caller's
  intent; a posting never blocks the money movement it describes; idempotency
  keys are derived (`order:{id}:payment`, `order:{id}:topup`,
  `wallet:{walletTransactionId}`), never invented per call site.
- **`packages/db/src/crud/reconcileLedger.ts`** — the read-only drift detector
  (`reconcileLedger`, `:705`), run on a six-hourly cron. Writes nothing, ever: a
  reconciliation that repairs what it finds destroys the evidence of how the
  books came to disagree. Deliberately and permanently separate from
  `reconcileFinances` (`crud/reports.ts`), which checks the operational rows
  against *each other* rather than against the ledger — both run, neither
  replaces the other.
- **`docs/sales-metrics-contract.md`** — the source-of-truth definition for
  every dashboard figure, including the Dashboard Source-of-Truth Matrix, the
  documented three-way day-boundary inconsistency, and the open items
  deliberately left unfixed.

---

## Known gaps and accepted trade-offs

Recorded so they are not rediscovered as new findings. None is a defect
introduced by the hardening pass.

**1. No per-payment `FEE` ledger posting exists, on any rail — by design.**
No gateway in this system reports a real, per-transaction fee figure. The only
fee-shaped data anywhere is TokoPay's `computeQrisAdminFee`
(`packages/core/src/payments/tokopay.ts:98`) — a **locally estimated** constant
(Rp100 + 0.70%, `:79-80`) charged to the **buyer** as a surcharge on top of
`order.totalAmount` via `qrisChargeAmount` (`:108`), not a fee TokoPay reports
having deducted.

Booking a `FEE` transaction from that estimate would either double-count money
already correctly netted out (the order-payment posting books exactly
`order.totalAmount`, which *is* the shop's expected net receipt once TokoPay
keeps its real, unknown cut out of the buyer's gross), or fabricate an entry
from a number that is not a transaction fact. So `payment_fee.idr` /
`payment_fee.usdt` (`crud/ledgerAccounts.ts:133`, `:139`) and
`FinancialTransactionType.FEE` exist in the chart of accounts and are
**legitimately unused** at payment time until a real gateway-reported fee figure
exists. That is honest incompleteness, not a gap to paper over. See
`crud/tokopay.ts:223-224`, which says so at the call site.

There is one place a real, provider-reported fee figure does exist, and it is not
a `Payment`: `Settlement.feeAmount` is read off the provider's own statement by
the admin entering the batch. `postSettlementPosting`
(`packages/db/src/crud/ledgerPostings.ts`) books it as the fee leg of a
`SETTLEMENT` posting — `Dr cash` (net) + `Dr payment_fee` (fee) / `Cr
provider_clearing` (gross). That is still not a `FEE` transaction, and the
distinction is the whole point: a reported amount, at the moment the provider
actually kept it, rather than an estimate attached to each order. See gap 6.

**2. `Payment.netAmount == Payment.amount` on TokoPay, and that is correct.**
`netAmount` is documented as "`gross paid − fee`", not "`amount − fee`".
`Payment.amount` is this shop's own quoted figure (`order.totalAmount`), while
the buyer's gross payment is `totalAmount + adminFee`. On a rail whose fee is a
buyer-side surcharge, `amount` already equals the net. The schema's own doc
comment on `netAmount` spells this out. `fee`/`netAmount` are populated as data
only, for TokoPay alone; `null` on the other five rails means "not known", never
"the fee was zero" (a genuinely free payment stores `0`).

**3. TokoPay wallet top-ups log a gateway-amount-mismatch warning as a matter of
course.** `settleWalletTopup` (`packages/db/src/crud/wallet_topup.ts`) credits
`order.totalAmount` — the figure `createWalletTopupOrder` already validated —
and never the caller-supplied `args.amount`, logging a `logger.warn` whenever
the two differ. Both production TokoPay callers pass the gateway-reported figure
(`live.amount`, from `apps/storefront/src/routes/checkout.ts:1165` and
`apps/order-bot/src/payments/tokopayReconcile.ts:209`), which on QRIS is the
admin-fee-inclusive gross, while the order total is net. So the warning is
expected on this rail, not evidence of drift. Explained, not a bug — noted so it
is not re-investigated as new.

**4. `confirmPaymentAttempt` can now raise a genuine `P2002`.** Populating
`Payment.providerTransactionId` made the `@@unique([method,
providerTransactionId])` index reachable at confirm time, inside the rails' own
delivery transaction, where the existing `.catch` cannot rescue an
already-poisoned Postgres transaction. Analysed as unreachable in practice (the
reclaim-on-failed-delivery path only reassigns an id after a rollback), and left
to throw rather than adding defensive handling for an unreachable case — but it
is a real, deliberate change in risk profile, recorded as an accepted trade-off
rather than an oversight.

**5. ~~Two settings have documented defaults but no web-admin field.~~ Closed.**
`fx_quote_ttl_minutes` and `min_order_amount_idr` were absent from `EDITABLE`
(`apps/web-admin/src/routes/api/settings.ts`), so they could only be changed by a
direct database write or a seed script. Both are now editable fields, and the
whole FX group — the spread, the three sanity-band figures and both staleness
levers — is rendered in the "Exchange Rates" card next to the rate itself rather
than falling through to "Other Settings". Every setting in the table below is now
either admin-editable or explicitly internal.

**6. `cash.*` and `provider_clearing.*` become a real cash position only for the
periods an admin has actually entered a statement for — CLOSED as of 2026-09-19
(task F1), with an operational caveat.** The `Settlement`/`SettlementTransaction`
models shipped as schema only, and for a while nothing wrote a row to either;
`postSettlementPosting` (`packages/db/src/crud/ledgerPostings.ts`) had the
accounting right — `Dr cash.<ccy>` (net) + `Dr payment_fee.<ccy>` (fee) / `Cr
provider_clearing.<ccy>` (gross) under `settlement:{id}`, refusing a batch whose
`netAmount + feeAmount` does not equal its `grossAmount` — but had no caller. It
has one now:

- `recordSettlement` (`packages/db/src/crud/settlements.ts`) writes the
  `Settlement` row, its `SettlementTransaction` lines, the `SETTLEMENT` posting
  and the audit row in **one transaction**, so a batch can never be recorded
  without being booked (or booked without being recordable);
- `POST /api/settlements` + `GET /api/settlements`
  (`apps/web-admin/src/routes/api/settlements.ts`) are the admin surface, behind
  the Settlements page in web-admin. The prefix is in `CONFIG_PREFIXES`
  (`plugins/auth.ts`), so **only `super` may record a batch** — the same tier as
  a hand-made wallet adjustment.

**The remaining caveat is operational, not structural: this is manual entry.**
`provider_clearing.*` still over-reads and `cash.*` still under-reads by exactly
the batches nobody has typed in yet, so the two accounts are a cash position only
as far as the statements an admin has entered. A batch that was recorded while the
chart of accounts was unseeded saves its row and posts nothing; those show in the
list with no posting id and a red "Not booked to the ledger" note, and the fix is
`pnpm seed-chart-of-accounts` followed by recording the batch again (the
backfill script does **not** cover settlements).

`refund_clearing.*` remains posted by nothing in either direction and reads a
true zero — deliberately, not as a second missing posting. A refund payout here is
one event, not approve-then-pay, so there is no interval for a clearing account
to describe, and a `Dr refund_clearing` drain added to the payout alone would
drive the account negative. See `CHART_OF_ACCOUNTS`' doc comment
(`crud/ledgerAccounts.ts`).

Every other account is fully posted and can be read as it stands
(`sales_revenue.*`, `wallet_liability.*`, `adjustment.*`,
`referral_expense.usdt`, and `payment_shortfall.*` from gap 7). `trialBalance`
and `getAccountBalance` (`crud/ledger.ts`) carry this same warning at the point
of use, because they are where a reader would otherwise trust the number.

**7. Underpaid-but-delivered orders posted at the full order total before
2026-09-19.** `deliverUnderpaidOrder` ("deliver anyway") books the order's full
total as `sales_revenue` — correctly; the shop earned the sale it chose to
honour — but only the amount that actually arrived is a receivable from the
gateway. The shortfall the operator absorbed is now booked to
`payment_shortfall.<ccy>` (EXPENSE, both currencies), so the three legs are `Dr
provider_clearing` (received) + `Dr payment_shortfall` (shortfall) / `Cr
sales_revenue` (total). Postings made **before** that change put the whole total
into `provider_clearing` with no expense leg, which overstates the receivable by
each absorbed shortfall. Those rows are not rewritten — the ledger is append-only
— and `reconcileLedger` reports the same shape as a
`LEDGER_POSTING_AMOUNT_MISMATCH` finding, so the affected orders are findable;
each can be corrected with `reverseFinancialTransaction` and re-posted, or left
as documented history.

**8. An overpayment is returned by hand, and only when an admin notices —
partially closed 2026-09-19 (task F2).** When a buyer pays more than an order
asked for, every rail delivers the order, stamps `outcome: "overpaid"` on its own
processed-transaction row and enqueues an `ADMIN_OVERPAID` DM. **No rail credits
the excess, and no rail persists it as a figure.** What changed is that there is
now a correct way to hand it back:

- `findOverpaidExcess` (`packages/db/src/crud/overpayments.ts`) DERIVES the excess
  from whichever rail's row exists — `amount − what the order billed`. The billed
  figure is **not the same expression on every rail**: TokoPay's QRIS admin fee is
  a buyer-side surcharge, so the buyer is billed `qrisChargeAmount(total)` and
  comparing against the bare total would invent an excess equal to the shop's own
  fee on every QRIS order. Each rail's expectation is taken from the TABLE the row
  came from, not from `Order.paymentMethod`.
- `creditOverpaymentToBalance` credits it with `adjustWallet` and posts
  `postOverpaymentCreditPosting` (`Dr provider_clearing / Cr wallet_liability`) in
  one transaction. Before this, an admin used the generic wallet-adjustment form,
  which books `Dr adjustment.*` (EQUITY) — claiming the shop funded out of its own
  equity a credit the buyer had paid for.
- `POST /api/orders/:orderId/credit-overpayment` is the surface, at the `super` +
  `support` tier its `/api/orders` prefix grants — matching
  `/api/payments/order/:id/credit-anyway`, the existing route that credits a wallet
  from a rail-recorded amount. **No amount is ever accepted from the client**; a
  supplied figure could disagree with the rail's record while the ledger balanced
  perfectly, which is the one error class double-entry cannot detect.
- One order can be credited once: a read-then-refuse for the ordinary double click,
  and `wallet_transactions`' own `UNIQUE (orderId, reason)` underneath it for two
  requests racing past the read. That constraint applies only because the credit
  has its own reason code, `overpaid_credit` — `admin_adjust` rows carry a null
  `orderId` and escape it.

**What is still open:** nothing returns an overpayment automatically. The excess
stays with the shop until an admin opens the order and clicks, so a buyer who
overpays and is never noticed is never repaid. Automating it was deliberately not
part of this task — an auto-credit needs a policy decision about dust amounts and
about whether wallet credit is an acceptable answer for every buyer.

---

## Settings reference

Every figure the pricing/FX system reads. All are free text; the repo-wide
convention is that a blank, non-numeric or non-positive value means **"this
check is off"**, never "reject everything".

| Setting | Default | Unit | Effect | Editable in web-admin |
| --- | --- | --- | --- | --- |
| `usd_idr_rate` | `USDT_IDR_RATE` env | IDR per USDT | The rate itself. Unset/invalid hides USDT everywhere. | Yes |
| `usd_idr_rate_auto` | on | `"false"` = off | Turns the hourly market refresh off. The admin's "update now" button bypasses it. | Yes |
| `usd_idr_rate_rounding` | `100` | IDR | Step the fetched rate is rounded to (after spread). | Yes |
| `usd_idr_rate_updated_at` | — | ISO timestamp | Freshness stamp. Written only by `setUsdIdrRate` / `stampUsdIdrRateConfirmed`. | No (internal) |
| `usd_idr_market_rate` | — | IDR per USDT | The last PRE-spread market figure a refresh accepted: the reference `fx_rate_max_delta_pct` measures against. Absent = cap skipped once; `""` (an admin typed a rate in) = same. | No (internal) |
| `usdt_spread_bps` | `0` | basis points | Shaves the market rate *down* → buyer sends more USDT (protective). Automatic refresh only; never applied to a hand-typed rate. No longer constrained by `fx_rate_max_delta_pct` (D10). | Yes |
| `fx_rate_min` | `8000` | IDR per USDT | Sanity floor. Refuses a refresh below it. | Yes |
| `fx_rate_max` | `40000` | IDR per USDT | Sanity ceiling. Refuses a refresh above it. | Yes |
| `fx_rate_max_delta_pct` | `5` | percent | Max move the MARKET may make between two accepted refreshes, measured against `usd_idr_market_rate` — not against the saved rate, so a spread of any size cannot trip it (D10). | Yes |
| `fx_quote_ttl_minutes` | `180` | **minutes** | Past it, checkout stops offering the USDT rails, `finalizeOrderPayment` refuses an order submitted anyway with `error.fx_quote_expired`, and every admin is DMed once. Three times the hourly refresh, so one missed tick cannot switch USDT off. | Yes |
| `fx_rate_max_age_hours` | `48` | **hours** | Past it, `getUsdIdrRate` returns null and the **whole USDT rail** is hidden. | Yes |
| `fx_refresh_failures` | `0` | count | Consecutive sanity-band refusals. Reset by the next confirmed rate — a refresh or a hand-typed one. | No (internal) |
| `fx_stale_alerted_for` | — | ISO timestamp, `\|quote_ttl`-suffixed for the earlier stage | Which staleness episode and threshold admins were already DMed about. | No (internal) |
| `fx_rejected_alerted_for` | — | rejection reason | Which rejection episode admins were already DMed about. | No (internal) |
| `usdt_rounding_ceil_since` | deploy instant, seeded by migration | ISO timestamp | End date of `reconcileFinances`' pre-M13 rounding exemption. Blank/unparseable/absent = exempt nothing. Not a pricing lever. | Yes |
| `min_order_amount_idr` | `1000` | IDR | Shop-wide minimum for any rail without its own override. Only a MISSING row takes the default; a blank one means "no shop-wide minimum". | Yes |
| `<rail>_min_amount` | unset | rail's own currency | Per-rail override: `tokopay_`, `paydisini_`, `nowpayments_`, `bybit_`, `bybit_bsc_`, `binance_internal_`. | Yes |

Key/default constants live in `packages/db/src/crud/pricing.ts` (FX) and
`packages/db/src/crud/orderMinimums.ts` + `_minAmount.ts` (minimums).
