# Sales Metrics Contract

The authoritative semantic definition of every sales, revenue, order-count,
profit and refund figure this system shows. One row per metric: what it means
in plain English, which query produces it, which order states and order kinds
it counts, how it treats currency, refunds, discounts and timezone, and how it
aggregates.

**Why this document exists.** These numbers are read by shop admins to make
money decisions, and several of them are computed by functions that look
interchangeable but are not (`revenueSummary` and `grossSalesForNetSales`
differ by exactly one status; `countDelivered` and `revenueSummary().orders`
count different things on purpose). Before changing any of the functions named
here, read its row. Before adding a metric, add a row.

**Standing rule this contract is held to:** no figure on any dashboard, report
or API response may be fabricated, estimated, or substituted for missing data.
Where a value is unknown the metric reports `null` and says so — it never
guesses a zero. Every metric below has a real, cited source-of-truth query.

Written at Financial Ledger milestone M7, against the code as of commit
`7e20b1eb`. Line numbers move; function names and file paths are the stable
references, and every claim below was verified against the live code rather
than carried over from an earlier investigation.

---

## Table of contents

- [Conventions used throughout](#conventions-used-throughout)
- [Revenue and sales](#revenue-and-sales)
- [Bucketed series (Day / Week / Month / Year)](#bucketed-series-day--week--month--year)
- [Order counts](#order-counts)
- [Customer spend](#customer-spend)
- [Wallet and cash](#wallet-and-cash)
- [KNOWN INCONSISTENCY: the day boundary is not the same everywhere](#known-inconsistency-the-day-boundary-is-not-the-same-everywhere)
- [Dashboard Source-of-Truth Matrix](#dashboard-source-of-truth-matrix)
- [What changed and why (for shops with wallet top-up history)](#what-changed-and-why-for-shops-with-wallet-top-up-history)
- [Open items deliberately not fixed here](#open-items-deliberately-not-fixed-here)

---

## Conventions used throughout

**Order kind.** Every `Order` row carries a `kind`: `PRODUCT` (a real sale) or
`WALLET_TOPUP` (a buyer moving their own money into their own wallet). A
settled top-up is a genuine `Order` row that reaches `DELIVERED` with a
`deliveredAt` stamped — `settleWalletTopup` (`packages/db/src/crud/wallet_topup.ts`)
writes `{PENDING_PAYMENT, CANCELLED} -> DELIVERED` directly (the `CANCELLED`
leg is a late settlement arriving after auto-cancel). **A top-up is never revenue and
never spend.** The money is still the buyer's; it lands in the
`wallet_liability.<ccy>` control account, and it is counted for real when they
later spend it on a product order. Counting both double-counts the same rupiah.

Every *sales* aggregate therefore carries `kind: OrderKind.PRODUCT`, expressed
as a shared constant in each file so it cannot be half-applied:

- `ORDER_KIND_SALES_FILTER` — `packages/db/src/crud/revenue.ts`
- `SPEND_KIND_FILTER` — `packages/db/src/crud/users.ts`
- spelled inline in `packages/db/src/crud/reports.ts` and
  `packages/db/src/crud/orders.ts`'s `shopFulfilmentStats`

Three categories legitimately do **not** carry it, and each says so in its own
doc comment:

1. **Structurally immune** — anything rooted at `OrderItem` (`topProducts`,
   `topProductsByMargin`, `profitSummarySince`, `profitByDay`, `profitByPeriod`,
   `botOverallStats.items_sold`). A top-up order carries zero `OrderItem` rows,
   so a filter would be dead weight implying the invariant is weaker than it
   is. `countAwaitingManualFulfillment` is immune for a different structural
   reason (a `WALLET_TOPUP` order can never hold `PROCESSING`).
2. **Deliberately kind-agnostic operational counters** — the work-queue and
   tab-badge counts in `orders.ts`. See [Order counts](#order-counts).
3. **Deliberately kind-agnostic account-activity signals** —
   `orderStatsByUserIds.totalOrders`/`.lastOrderAt`, `orderCountByUserIds`.

**Currency.** IDR and USDT are kept in separate buckets everywhere. Summing
`Order.totalAmount` across currencies would add a USDT order's small decimal
straight into the Rupiah figure. Orders predating the `currency` column count
as USDT (their snapshot unit). There is exactly **one** deliberate,
user-opt-in blend — see [Combined revenue](#combined-revenue-the-one-deliberate-currency-blend).

**Money type.** Every figure is `Decimal` (`@app/core/money`), never float,
quantized to 4 decimal places (`quantizeMoney(v, 4)`) at the point it becomes
a string.

**Null-when-zero.** `/api/dashboard/kpis` shapes money as `null` when the
figure is exactly zero (`shapeRevenue`, `shapeMoneyPair` in
`apps/web-admin/src/routes/api/dashboard.ts`) so the card renders its own empty
state rather than a literal Rp0.

**Timezone.** Values are stored UTC in the database. Bucket boundaries are
**not** uniform across metrics — this is a known inconsistency, documented in
full in [its own section below](#known-inconsistency-the-day-boundary-is-not-the-same-everywhere).
Every row below names its boundary explicitly. Do not assume.

**Discount treatment.** Two different rules, both correct for their own
purpose:

- **`Order`-rooted** metrics (all revenue/sales figures) sum
  `Order.totalAmount`, which is already **net of** `bulkDiscountAmount` and
  `discountAmount` — what the shop actually charged.
- **`OrderItem`-rooted** metrics (profit, margin) must prorate the order-level
  discount down to each line, because order-level discounts live only on the
  `Order` row and are never written back to `OrderItem.unitPrice`. That is
  `orderItemRevenueIdr` (`revenue.ts`): `lineDiscount = (bulkDiscountAmount +
  discountAmount) × (lineGross / orderSubtotal)`. `walletUsed` is deliberately
  **excluded** from this — it is a payment method (money the shop already
  holds), not a discount, so it does not reduce banked revenue.
  `topProducts` is the one deliberate exception: its revenue is **gross**, by
  design, because its ranking is by quantity sold and the proration is not
  expressible through `groupBy._sum`. Use `topProductsByMargin` when you need
  the discount-aware figure.

**Unknown cost is never zero.** `Denomination.costPrice` is nullable. Every
profit metric excludes cost-unknown lines from both the profit sum and the
margin denominator rather than treating unknown cost as 0 (which would read as
a fabricated 100% margin). How the exclusion is surfaced differs by shape —
see [Profit](#profit-today) and [profit series](#profit-by-day--week--month--year).

---

## Revenue and sales

### Revenue Today / Revenue Yesterday

Also referred to in the plan as **Gross Sales**. Post the M6 Task 6a fix, this
figure *is* the gross sales figure by definition — there is deliberately **no
separate "Gross Sales" card**, because a second card showing the identical
number under a different label is pure duplication and risks the two silently
drifting apart later (Task 6b design decision). Renaming this card to "Gross
Sales Today" remains an open, purely cosmetic, zero-data-risk option.

| | |
|---|---|
| **Business definition** | How much the shop sold today (and yesterday) — the money value of product orders delivered in that window, before any refunds are taken off. |
| **Source of truth** | `revenueSummary` — `packages/db/src/crud/revenue.ts`, via the shared `salesRevenueByCurrency` helper. Surfaced at `GET /api/dashboard/kpis` (`revenue`) and `GET /api/orders/kpis` (`revenueToday`). |
| **Included states** | `Order.status = DELIVERED` only. |
| **Excluded states** | Everything else, including `REFUNDED`. A fully refunded order leaves `DELIVERED` (`executeRefund` moves it to `REFUNDED`) and therefore drops out of this figure entirely — that is intentional for a *gross delivered* number, and it is exactly why Net Sales needs its own separate basis (below). `PARTIALLY_DELIVERED` is not counted. |
| **Kind filter** | `kind: PRODUCT`, hard-coded in `salesRevenueByCurrency`, not caller-optional. A top-up is never revenue by definition, so no caller of a function named "revenue" has a legitimate reason to get them mixed in. |
| **Currency** | IDR and USDT kept strictly separate. Never blended. The API additionally echoes the USDT figure under a `usd` key (1 USDT ≈ 1 USD, the same number under a second label) — it is not a second, independently computed figure. |
| **Refund treatment** | **Not refund-aware.** This is a gross figure. A partial refund leaves the order `DELIVERED` and does not reduce it; a full refund removes the order from it entirely (see above). Use Net Sales for the refund-aware number. |
| **Discount treatment** | Net of discounts — sums `Order.totalAmount`, which is post-`bulkDiscountAmount`/`discountAmount`. |
| **Timezone** | ⚠️ **Jakarta-local midnight**, not UTC. The route passes `startOfDayUtc()` (`packages/core/src/datetime.ts:52-54`), which despite its name computes `config.TIMEZONE`-local midnight converted to a UTC instant. See [the timezone section](#known-inconsistency-the-day-boundary-is-not-the-same-everywhere). The **bot's** admin dashboard calls the same function with a **true UTC** midnight instead — the two "today's revenue" figures can legitimately disagree. Both windows are right-anchored at "now" rather than at a fixed close, so the gap is **not** a flat 7 hours: it's up to 7 hours' worth of orders before 17:00 UTC (when the Jakarta date has not yet rolled), widening to up to 17 hours' worth between 17:00 and 23:59 UTC (once it has). |
| **Aggregation** | `SUM(Order.totalAmount)` grouped by currency over `deliveredAt ∈ [since, until]`, plus the order count behind it. "Yesterday" is bounded at the same clock time as now (`yesterdaySameClock`) so a mid-day comparison is like-for-like, not today-so-far against a whole day. |
| **Trend %** | `(today − yesterday) / yesterday × 100`, 1dp, `null` when yesterday was zero (no division by zero, and no "∞%"). |

`revenueSummary().orders` is a count of **sales**, not of all delivered order
rows — it inherits the same `kind: PRODUCT` filter. It is not the same number
as `countDelivered()`.

### Refunds Today

| | |
|---|---|
| **Business definition** | How much money the shop actually paid back to customers today. |
| **Source of truth** | `refundTotalsSince` — `packages/db/src/crud/revenue.ts`. Surfaced at `GET /api/dashboard/kpis` (`refunds`). |
| **Included states** | `RefundExecution.status = COMPLETED` only. |
| **Excluded states** | `PENDING` (has not happened yet) and `FAILED` (a transfer that bounced). Counting either would subtract revenue that was never given back. |
| **Source table** | `RefundExecution.amount`, **never** `Refund.amount`. A `Refund` row is the *request* ("this buyer is owed 50,000"); a `RefundExecution` is one real payout. They genuinely differ: a refund may be settled across several attempts, and a request can sit forever with no payout at all. Only money that actually left the shop reduces what a customer effectively spent. |
| **Kind filter** | Not applicable — this is rooted at `RefundExecution`, not `Order`. A wallet top-up has no refund executions. |
| **Currency** | Grouped by `RefundExecution.currency` directly, no join to the Order. `executeRefund` snapshots that column from the `Refund`, which `createRefund` pins to the order's own currency, and re-checks the two agree before paying anything out. Non-IDR falls into the USDT bucket, mirroring `salesRevenueByCurrency`. Never blended. |
| **Refund treatment** | This *is* the refund figure. |
| **Discount treatment** | Not applicable — a payout amount is a payout amount. |
| **Timezone** | ⚠️ Jakarta-local midnight, inherited from the route's `startOfDayUtc()` — same as Revenue Today. |
| **Aggregation** | `SUM(RefundExecution.amount)` grouped by currency over `executedAt ∈ [since, until]`. Bucketed on **`executedAt`** (the payout's own instant, stamped by `executeRefund`), not `createdAt` — a refund recorded at one moment and paid at another belongs to the day the money moved. |

### Net Sales Today

| | |
|---|---|
| **Business definition** | Today's sales after taking off the refunds paid out today — what the shop actually kept. |
| **Source of truth** | `grossSalesForNetSales(...) − refundTotalsSince(...)`, subtracted in the route: `apps/web-admin/src/routes/api/dashboard.ts` (`netSales`). Both halves live in `packages/db/src/crud/revenue.ts`. |
| **Included states** | Gross basis: `Order.status ∈ {DELIVERED, REFUNDED}`. Refund side: `RefundExecution.status = COMPLETED`. |
| **Excluded states** | `PARTIALLY_DELIVERED` is deliberately **not** in the gross basis: it is not a "sold then refunded" state, and a partial refund never moves an order into it. `REFUNDED` is the only status added over `revenueSummary`. |
| **Kind filter** | `kind: PRODUCT` on the gross side (via `salesRevenueByCurrency`) — widening the status set must not quietly reopen the top-up door. |
| **Currency** | Per currency, subtracted per currency. Never blended, and never cross-subtracted (an IDR refund never reduces the USDT figure). |
| **Refund treatment** | This is the one KPI that is fully refund-aware. |
| **Discount treatment** | Net of discounts on the gross side (`Order.totalAmount`). |
| **Timezone** | ⚠️ Jakarta-local midnight, same route boundary as the two above. |
| **Aggregation** | Plain `Decimal` subtraction. **Deliberately not clamped at zero**: a refund can legitimately be for an order sold on an earlier day, so "more refunded today than sold today" is a real negative signal an operator needs to see, not an error to hide behind a 0. |

#### Why Net Sales uses its own gross basis, and why Revenue − Refunds ≠ Net Sales

This is the single most counter-intuitive thing in this document, so it is
spelled out in full. **Net Sales does not subtract refunds from "Revenue
Today". It subtracts them from its own, wider, gross figure.**

`executeRefund` closes a fully-refunded `DELIVERED` order by moving it to
`REFUNDED`. `revenueSummary` counts `DELIVERED` only. So an order sold today
and fully refunded today **disappears from "Revenue Today" the moment it is
refunded**. Subtracting the payout from a figure the sale had already left
charged the same refund twice: an order sold for Rp10,000 today and paid back
in full today reported **Net Sales of −Rp10,000** — a number that never
happened, on a day that genuinely netted zero. (This was reproduced empirically
against a real Postgres database during the Task 6b review before it was
fixed.)

`grossSalesForNetSales` counts `{DELIVERED, REFUNDED}`, so the refunded sale
stays in gross and the subtraction happens exactly once. The same day now
correctly nets to **Rp0** — as much was sold as was handed back.

The consequence, stated plainly so nobody "fixes" it later:

> **On a day containing a FULL same-day refund, "Revenue Today" and "Net Sales
> Today" do NOT differ by exactly "Refunds Today". This is correct.**

The identity `Revenue = Net + Refunds` only ever held as an artifact of the
double-counting bug itself. Gross and Net are *supposed* to be two different
numbers:

| Scenario | Revenue Today (gross, DELIVERED-only) | Refunds Today | Net Sales Today | Why |
|---|---|---|---|---|
| Sold 10,000 today, no refund | 10,000 | 0 | 10,000 | Identity holds trivially. |
| Sold 10,000 today, **partial** refund of 3,000 today | 10,000 (order stays `DELIVERED`) | 3,000 | 7,000 | Identity holds — both figures count the sale once. |
| Sold 10,000 today, **full** refund of 10,000 today | **0** (order left `DELIVERED` for `REFUNDED`) | 10,000 | **0** | Identity breaks, and both figures are individually honest: nothing is still sold, and nothing was net kept. |
| Sold 10,000 **yesterday**, refunded 10,000 today | 0 | 10,000 | **−10,000** | Correct and deliberately not clamped: the shop really did pay out more today than it sold. |

`revenueSummary`, `revenueByDay`, the Reports page, the bot's stats and the
`RevenueKpiCard` are all completely untouched by this — `grossSalesForNetSales`
is a separate function with exactly one caller, and its doc comment says so.

Implementation note worth preserving: the widened status set is passed as an
explicit, named `statuses` parameter on `salesRevenueByCurrency`, **not**
smuggled through its `extraWhere` argument. `extraWhere` is spread *before*
`status`/`kind` precisely so a caller cannot widen "delivered product revenue"
into something else; the named parameter keeps the one legitimate widening
reviewable at its single call site.

### Profit Today

| | |
|---|---|
| **Business definition** | What the shop earned today after the cost of what it sold. |
| **Source of truth** | `profitSummarySince` — `packages/db/src/crud/revenue.ts`. Surfaced at `GET /api/dashboard/kpis` (`profit`). |
| **Included states** | Delivered `OrderItem` lines: `order.status = DELIVERED`, `order.deliveredAt >= since`. |
| **Kind filter** | None, and none needed — rooted at `OrderItem`, and a `WALLET_TOPUP` order has zero item rows (structural immunity). |
| **Currency** | Split by the **order's** currency, never blended. Both `OrderItem.unitPrice` and `Denomination.costPrice` are always catalog-central IDR; a USDT-currency line converts **both** revenue and cost through **that order's own `fxRate` snapshot** (never a live rate) via the shared `idrToBucketCurrency` helper, so revenue and cost can never end up in mismatched units inside one bucket. |
| **Refund treatment** | Not refund-aware. A refunded order's items are no longer `DELIVERED` once the order moves to `REFUNDED`, so a full refund removes them; a partial refund does not reduce profit. |
| **Discount treatment** | Discount-prorated per line via `orderItemRevenueIdr`. This matters: without it a discounted order reported pre-discount revenue against real cost, so a healthy margin could show on an order that genuinely lost money. |
| **Unknown cost** | Lines whose `Denomination.costPrice` is `null` are excluded from both the profit sum **and** the margin denominator, and counted in `excludedItemCount` instead. The returned shape is `{ netProfit, marginPct, excludedItemCount }` — the `excludedItemCount` riding alongside is what makes a `netProfit` of `"0"` honest rather than a claim of break-even. A currency with no revenue and no exclusions returns `null` (nothing to report). `marginPct` is `null` when revenue is zero. |
| **Timezone** | ⚠️ Jakarta-local midnight (route passes `startOfDayUtc()`). |
| **Aggregation** | Sum over delivered lines since `since`, per currency. |

### `botOverallStats` — the bot's customer-facing shop stats

| | |
|---|---|
| **Business definition** | Lifetime shop totals shown to *buyers* on the bot's own dashboard: "X items sold · Rp Y total revenue · Z users". |
| **Source of truth** | `botOverallStats` — `packages/db/src/crud/revenue.ts`. Called from `apps/order-bot/src/handlers/customer.ts`. |
| **Included states** | `DELIVERED` (both the revenue half, via `salesRevenueByCurrency`, and the `items_sold` half). |
| **Kind filter** | `revenue_idr`/`revenue_usdt`: `kind: PRODUCT` (Task 6a fix) — this is a "total revenue" figure shown to buyers, so a top-up must not inflate it. `items_sold`: no filter, structurally immune (aggregates `OrderItem.quantity`). `total_users`: `COUNT(User)`, not order-derived at all. |
| **Currency** | Separate IDR/USDT, rendered by the bot's own `mixedAmount` formatter. |
| **Refund / discount** | Not refund-aware; net of discounts (`Order.totalAmount`). |
| **Timezone** | None — lifetime, unwindowed. |
| **Aggregation** | Lifetime sums/counts. |

### `shopFulfilmentStats` — the storefront home page

| | |
|---|---|
| **Business definition** | Site-wide proof-of-life figures on the storefront home: how many orders have actually been delivered, and how many distinct customers have bought. |
| **Source of truth** | `shopFulfilmentStats` — `packages/db/src/crud/orders.ts`. Called from `apps/storefront/src/pageData.ts`. |
| **Included states** | `DELIVERED`. |
| **Kind filter** | `kind: PRODUCT` on **both** queries, as of the Task 6a review's I-1 fix (commit `997fd500`). Before that, a settled wallet top-up counted as a delivered order *and* made its owner a "customer" on a page whose own doc comments promise "Real numbers… stays honest". |
| **Currency** | Not applicable — counts, not money. |
| **Refund treatment** | Not refund-aware. A fully refunded order leaves `DELIVERED` and stops being counted. |
| **Timezone** | None — lifetime. |
| **Aggregation** | `COUNT(*)` for orders; `GROUP BY userId` then `.length` for distinct buyers. |

---

## Bucketed series (Day / Week / Month / Year)

These feed the Sales Analytics chart (`GET /api/dashboard/analytics`, `range` /
`metric` / `currency` query params) and the Reports page.

**All of them bucket on genuine UTC calendar boundaries** — unlike the Today
KPIs above. This is the project's stated policy and the new Task 6c code
follows it correctly from the start.

### Day-granularity series

`revenueByDay`, `ordersByDay`, `combinedRevenueByDay`, `profitByDay` — all
in `packages/db/src/crud/revenue.ts` and all feeding the Sales Analytics
chart. `refundsByDay` lives in the same file and shares the same shape, but
**has no production caller today** — the analytics route's `metric` only
ever dispatches to `revenue`, `orders`, or `profit` (`dashboard.ts:340-379`);
no route or page charts refunds yet. It shipped alongside the Refunds Today
KPI (Task 6b) as the natural day-bucketed counterpart, ready for a future
"Refunds" chart series, but is not wired to one — treat its row below as a
source-of-truth definition, not evidence it's dashboard-visible.

| | |
|---|---|
| **Window** | A **rolling last-N-days** window, not a calendar rollup: `since = addDays(now, -(days - 1))` then `setUTCHours(0,0,0,0)`. Default `days = 30`; the analytics route passes 30 for `range=30d` and 7 otherwise. |
| **Bucket key** | `deliveredAt.toISOString().slice(0, 10)` — a genuine **UTC calendar day**, `YYYY-MM-DD`. (`refundsByDay` keys on `executedAt` instead.) |
| **Zero-fill** | Every day in the window is pre-seeded, so an inactive day reports a real zero and the chart has no gaps. `profitByDay` seeds with a profit accumulator and reports `null`, not zero — see below. |
| **Included states / kind** | `DELIVERED` + `kind: PRODUCT` for revenue/orders/combined. `refundsByDay`: `RefundExecutionStatus.COMPLETED`. `profitByDay`: delivered `OrderItem` lines, structurally immune to kind. |
| **Refund treatment** | `refundsByDay` is the refund series (**not currently charted — no production caller**, see above); the others are gross and not refund-aware. There is deliberately **no** `netSalesByDay` — Net Sales shipped as a today-only KPI and a charted version was never asked for. |
| **Currency** | Per currency, except `combinedRevenueByDay` (see below). |
| **Discount** | `Order.totalAmount` (net) for revenue/orders/combined; prorated per line for profit. |

### Calendar-period series (Week / Month / Year)

`revenueByPeriod`, `ordersByPeriod`, `profitByPeriod` — same file.

| | |
|---|---|
| **Bucket boundary** | luxon `DateTime.fromJSDate(at, { zone: "utc" }).startOf(granularity)`. So: **ISO week starting Monday 00:00 UTC**, **calendar month UTC**, **calendar year UTC**. Never a rolling window, never a locale-dependent week start. |
| **Bucket label** | `week` → `"2026-W38"` (`kkkk-'W'WW`), `month` → `"2026-09"` (`yyyy-LL`), `year` → `"2026"` (`yyyy`). Lexicographically sortable so insertion order and string order agree; rendered verbatim as a chart axis tick with no formatter. `kkkk` is the **ISO week-year**, not the calendar year — 2027-01-01 belongs to ISO week `2026-W53`, and a naive `yyyy` label would mislabel it. |
| **Window** | The last `count` periods, oldest→newest, **including the period in progress** — matching `revenueByDay`'s own convention (its window ends with today, not yesterday). |
| **Default `count`** | `week: 12`, `month: 12`, `year: 5` (`DEFAULT_PERIOD_COUNT`). **These are a UI readability choice, not a data-correctness matter** — they set the default width of the chart window only, never which rows are real. 12 weeks ≈ a quarter; 12 months makes seasonality visible and puts this December next to last December; 5 years reads a multi-year trend without an axis of mostly pre-launch years. A shop younger than the window shows real zeros (zero-filled, never interpolated) for the years before it existed. |
| **Included states / kind** | Identical to the Day series: `DELIVERED` + `kind: PRODUCT` for revenue/orders; `OrderItem`-rooted and structurally immune for profit. |
| **Field naming** | The bucket label field is called `day` on `PeriodRevenue`/`PeriodOrderCounts`/`PeriodProfit`, not `period` — deliberately, so every granularity flows through the existing `{day, value}` chart point type and `XAxis dataKey="day"` with no per-granularity branching. |
| **Known scaling ceiling** | Each of the three issues **one** `findMany` covering the whole window (no per-bucket queries), with no `take`. At `year: 5` that is a genuinely unbounded row fetch — `profitByPeriod` most of all, since its rows carry a joined `product.costPrice` — re-issued every 30s by `useAnalytics.ts`'s `refetchInterval` for as long as an admin leaves the Year view open. **Not a correctness bug** (no `take` means no silent truncation), but a real ceiling, accepted rather than fixed at M6. The fix, if it ever matters, is a raw `date_trunc` `GROUP BY` — `revenue.sql-crosscheck.test.ts` already sets the precedent. |

### Profit by Day / Week / Month / Year

`profitByDay` and `profitByPeriod` share `PROFIT_ITEM_SELECT`,
`accumulateLineProfit` and `shapeBucketProfit`, so the two granularities cannot
report different profit for the same data. The arithmetic is
`profitSummarySince`'s, verbatim: discount-prorated line revenue, cost as
catalog-central IDR × quantity, both brought into the bucket's currency through
that order's own `fxRate` snapshot.

**A bucket with no cost-known delivered item reports `null`, not `"0"`.** This
is a deliberate divergence from `profitSummarySince`, and the reasoning matters:

> `profitSummarySince`'s own `shape` helper can afford to return `netProfit:
> "0"` for an all-cost-unknown window **only because it also returns
> `excludedItemCount` alongside it** — the excluded count is what tells the
> reader the zero is not a real break-even. A single `{day, value}` chart point
> has nowhere to carry that caveat. A `0` there would read as a period that
> genuinely broke even, which is a fabricated claim. `null` (the chart draws a
> gap) is the honest answer.

A second, smaller divergence: the emptiness test is `costKnownItems === 0`, not
`shape`'s `revenue.isZero() && excluded === 0`. A line discounted to zero with a
known cost is a real loss, and keying on the counter reports it instead of
hiding it behind a zero-revenue check.

**Chart ambiguity worth naming:** a `null` bucket renders identically whether it
means "no sales at all" or "sales, but every cost is unknown". The chart cannot
currently distinguish them. Recorded, not fixed.

### Combined revenue — the one deliberate currency blend

`combinedRevenueByDay` (Day path) and `PeriodRevenue.revenueIdrEquiv`
(Week/Month/Year path). Reached via `currency=combined` on
`GET /api/dashboard/analytics`.

| | |
|---|---|
| **Business definition** | Both currencies expressed as one IDR-equivalent total, for an operator who explicitly opts in to a single line. |
| **Rule** | IDR orders pass through unconverted. USDT orders convert via **that order's own `fxRate` snapshot**, stored on the `Order` row at payment time. |
| **Why this is safe** | The rate is a **per-order snapshot, never a live rate**, so a past day's or past period's combined total never moves when today's exchange rate changes. A report you printed last month still says the same thing today. Summing raw currency amounts (or re-converting historical orders at today's rate) would produce a number that silently changes under the reader. |
| **Why it is legitimate here specifically** | It operates on `Order.totalAmount`, which genuinely follows `Order.currency`. The same multiplication applied to `OrderItem.unitPrice` would be a bug — `unitPrice` is *always* catalog-central IDR regardless of settlement currency, and a past bug that multiplied it by `fxRate` inflated USDT-paid orders' reported revenue by roughly the exchange rate. That is why every `OrderItem`-derived figure routes through `orderItemRevenueIdr`. |
| **Opt-in only** | Every other revenue figure in this system is per-currency. This is the single exception and it exists behind a filter the user clicks. |
| **fxRate-less USDT order** | Counted **unconverted** (its raw USDT total lands in the IDR-equivalent sum) rather than dropped. This is a pre-existing wart, now reachable at more granularities than before; `revenueByPeriod` replicates the Day path's behavior verbatim precisely so the two series can never disagree. Recorded, not fixed. |
| **There is no combined PROFIT** | Only revenue has a blend. Profit is derived from catalog-central IDR `unitPrice`/`costPrice` per line, so a "combined profit" would have to be invented. `metric=profit&currency=combined` falls back to the **IDR** series — a real number under a slightly narrower label. The card hides the Combined option while Profit is selected, so this is a backstop for a hand-written query string, not a path a user clicks. |

### Known quirk: `metric=orders&currency=combined` returns the IDR count

`GET /api/dashboard/analytics?metric=orders&currency=combined` resolves to
`ordersIdr` — the **IDR order count**, not a real combined count — at every
granularity.

- This is **pre-existing behavior on the Day path**, predating this ledger
  build. Task 6c's review confirmed via the diff that the line in question was
  unchanged context, so it is not something the Week/Month/Year work
  introduced; that work only made the existing quirk reachable at more
  granularities.
- It is **inconsistent** with revenue's handling of the same query param, where
  `combined` is a genuine fxRate-snapshot blend.
- A combined *count* is well-defined and trivial (`ordersIdr + ordersUsdt`) —
  unlike combined profit, there is no missing-data problem here. It is simply
  not implemented.
- **Candidate fix for a future pass. Not this one.** Documented here so each
  task stops re-deciding it.

---

## Order counts

There are two distinct families of order count in this system and they answer
two different questions. Mixing them is the most likely way to read a wrong
number off this dashboard.

### Sales funnel counts — `kind: PRODUCT` filtered

`ordersByStatus` and `ordersByStatusSince` — `packages/db/src/crud/reports.ts`.

| | |
|---|---|
| **Business definition** | How product orders are distributed across the order funnel: how many reached each status. |
| **Source of truth** | `ordersByStatus` (lifetime, feeds the Reports page's order funnel alongside `revenueByDay`/`topProducts`/`voucherUsage`); `ordersByStatusSince` (windowed, feeds `GET /api/dashboard/kpis` → `orders` → `OrdersKpiCard`). |
| **Included states** | All statuses — the grouping *is* the answer. The dashboard route then folds them into display buckets: `delivered` = `DELIVERED`; `pending` = `PENDING_PAYMENT`, `PAYMENT_DETECTED`, `CONFIRMING`, `PENDING_VERIFICATION`, `UNDERPAID`; `failed` = `CANCELLED`, `REJECTED`, `FAILED`. `total` is the sum of **every** status, including ones outside those three buckets. |
| **Kind filter** | `kind: PRODUCT` (Task 6a). A settled `WALLET_TOPUP` reaches `DELIVERED` like any sale and would otherwise inflate the funnel's delivered leg with money the buyer has not spent. |
| **Currency** | Not applicable — counts. |
| **Refund treatment** | A refunded order appears under `REFUNDED`, which is in none of the three display buckets, so it silently leaves `delivered` without joining `pending` or `failed` while still counting toward `total`. |
| **Timezone** | ⚠️ `ordersByStatusSince` is called with `startOfDayUtc()` → **Jakarta-local midnight**. |
| **Aggregation** | `GROUP BY status`, `COUNT(*)`. Note `ordersByStatusSince` windows on **`createdAt`**, not `deliveredAt` — "orders *placed* today", which is a deliberately different question from Revenue Today's "orders *delivered* today". The two cards on the same dashboard row therefore window on different columns. |

### Operational counters — deliberately kind-**agnostic**

`countPendingPaymentLike`, `countProcessing`, `countPendingVerifications`,
`countUnderpaid`, `countExpiredPending`, `countAwaitingManualFulfillment`,
`countDelivered`, `countCancelled` — `packages/db/src/crud/orders.ts`.

**These count BOTH order kinds, on purpose. Do not "finish the job" here.**
They were reviewed in the Task 6a pass and deliberately left alone; the file
carries a block header comment saying so, and `orders.test.ts` has a test
pinning it.

| | |
|---|---|
| **Business definition** | Admin work queues: how many orders are sitting in each state waiting for a human. |
| **Source of truth** | The eight functions above. They feed exactly two surfaces: the dashboard's Operation Center and Pending Actions cards (each deep-linking to the Orders page filtered by that status), and the Orders page's own KPI row and status-tab count badges (`GET /api/orders/kpis`, `OrderStatusTabs.tsx`). |
| **Kind filter** | **None, deliberately.** The Orders list behind both surfaces is itself kind-agnostic (`listOrders` applies no kind filter, and admins genuinely resolve top-up orders there). Filtering these would (a) make every tab badge contradict the row count of the list it labels, and (b) hide real work — an `UNDERPAID` or expired wallet top-up needs a human exactly as much as an `UNDERPAID` product order does. |
| **The one structural case** | `countAwaitingManualFulfillment` needs no filter for a *structural* reason rather than a product one: a `WALLET_TOPUP` order can never hold `PROCESSING`. Only `settlePaidOrder`'s MANUAL branch puts a fresh order there and it refuses a top-up before the branch split; even without that guard the branch is unreachable, because `isManual` reads `order.items.some(...)` and a top-up has zero item rows. A filter here would be dead weight implying the invariant is weaker than it is. This was verified by hand-tracing `settlePaidOrder` during the Task 6a review, not assumed. |
| **Escape hatch** | `countOrders(db, { kind: OrderKind.PRODUCT, status: DELIVERED })` for a caller that genuinely wants one kind only. `OrderFilter.kind` is typed `OrderKind \| null` (narrowed from a loose `string \| null` in commit `997fd500`, so a typo'd kind cannot silently return a zero money figure) and has **no default** — existing callers are unaffected. |
| **Currency / refund / discount / timezone** | Not applicable. These are unwindowed counts with no money and no date bound, except `countExpiredPending(db, now)` which takes an explicit `now`. |

### Cross-metric warning: the Orders-page KPI row mixes both families

`GET /api/orders/kpis` (`apps/web-admin/src/routes/api/orders.ts`) returns, in
one response object:

```
totalOrders   → countOrders(prisma, {})   ← ALL KINDS (product + wallet top-up)
revenueToday  → revenueSummary(...)       ← PRODUCT ONLY
delivered     → countDelivered(...)       ← ALL KINDS
cancelled     → countCancelled(...)       ← ALL KINDS
```

Each individual figure is correct for its own purpose, and each is correct
relative to the kind-agnostic Orders list the row sits above. But:

> **An admin computing average order value by dividing `revenueToday` by
> `totalOrders` from this one row will get a wrong number** on any shop with
> wallet top-up history — a product-only numerator over an all-kinds
> denominator. There is no AOV figure in the product today; if one is ever
> added, it must take both halves from the same family. `revenueSummary`
> already returns its own product-only `orders` count for exactly this reason.

`totalOrders` is additionally **lifetime**, while `revenueToday` is **today** —
a second reason the two do not divide.

---

## Customer spend

All in `packages/db/src/crud/users.ts`. The split here is between *spend*
questions (product-only) and *account activity* questions (all kinds), and it
is drawn deliberately per field rather than per function.

### Product-only — "what has this customer bought"

| Function | Business definition | States | Kind | Currency | Timezone | Aggregation |
|---|---|---|---|---|---|---|
| `userTotalSpent` | How much one customer has spent with the shop, ever. | `DELIVERED` | `SPEND_KIND_FILTER` (PRODUCT) | IDR/USDT separate | Lifetime | `SUM(totalAmount)` grouped by currency |
| `totalSpentByUserIds` | The same figure, batched for a page of customers (one `groupBy`, not the N+1 `userTotalSpent` has when called per row). | `DELIVERED` | PRODUCT | IDR/USDT separate | Lifetime | `SUM(totalAmount)` grouped by (userId, currency). **Users with no delivered product order are absent from the returned Map** — callers must default to zero on a miss, which is also where a top-up-only customer now lands. |
| `orderStatsByUserIds.deliveredOrders` | How many real purchases this customer has completed — drives the per-row "RETURNING" badge (≥ 2). | `DELIVERED` | PRODUCT | n/a | Lifetime | `COUNT(*)` per user. Must match `customersKpis.returningCustomers`, or a customer with two top-ups and no purchase would wear a "Returning" badge on a page whose own KPI refused to count them. |
| `customersKpis.returningCustomers` | How many customers have bought at least twice. | `DELIVERED` | PRODUCT | n/a | Lifetime | `GROUP BY userId`, keep `count ≥ 2`. Non-admin users only. |
| `customersKpis.totalRevenue` | All-time revenue from customers (distinct from the Orders page's "Revenue Today"). | `DELIVERED` | PRODUCT | IDR/USDT separate | Lifetime | `SUM(totalAmount)` grouped by currency, non-admin users only. |
| `rankUserIdsBySpend` (private) | The ordering behind the Customers page's "sort by spend". | `DELIVERED` | PRODUCT | **IDR only** — see note | n/a | `groupBy(userId)` ordered by `SUM(totalAmount) DESC`, paginated in SQL; users with no ranked spend are appended `createdAt`-desc. |

`rankUserIdsBySpend` was fixed **beyond** the Task 6a brief's enumerated list,
and correctly so: with "Total Spent" now product-only, a ranking still sorted
by top-up-inflated spend would have ordered customers inconsistently with the
figure displayed next to them on the same row.

> **Pre-existing, and deliberate by design — not a bug to fix:**
> `rankUserIdsBySpend` ranks on `currency: "IDR"` orders only. A customer who
> has only ever paid in USDT ranks as a zero-spender and is sorted into the
> `createdAt`-desc tail, even though their "Total Spent" cell correctly shows a
> USDT figure. The function's own doc comment (`users.ts:693-698`) states why:
> spend is inherently two numbers (IDR, USDT), and blending them into one
> ranking scalar would fabricate a single figure — exactly what
> `CurrencyStack` exists to avoid doing on the display side. **Do not resolve
> this by inventing a blended spend score.** Recorded here for completeness;
> out of scope for M7.

### All-kinds — "what has this account been doing"

| Function / field | Why it is deliberately not filtered |
|---|---|
| `orderStatsByUserIds.totalOrders` | Feeds the Customers page's "Orders" column and the customers CSV export. A wallet top-up **is** activity on that account, and is visible as its own row on the Orders page. This column answers "what has this account been doing", not "what has it bought". |
| `orderStatsByUserIds.lastOrderAt` | `MAX(createdAt)`, any status, any kind — same account-activity framing. |
| `orderCountByUserIds` | Left kind-agnostic because it has **zero callers anywhere in the repo** (verified; `orderStatsByUserIds.totalOrders` superseded it for the Customers page). There is no sales context here to correct — filtering it would be inventing a semantic for a function nobody calls. If a caller ever appears, decide *then* which of the two questions it is asking. |

### `customersKpis.newToday` / `.activeToday`

Not order-derived at all — they count `User.createdAt` and `User.lastSeenAt`
against `startOfDayUtc()`, so the kind filter does not apply to them. They are
non-admin-only. **Their day boundary is Jakarta-local midnight**, same as the
revenue KPIs — see the next section.

---

## Wallet and cash

### Wallet Funding

| | |
|---|---|
| **Business definition** | Money customers have put into their wallets. |
| **Source of truth** | `WalletTransaction` (reason `wallet_topup`) and `User.walletBalance`/`walletBalanceUsdt`. **Never** an `Order`-derived sales figure. |
| **Status in the product today** | There is **no aggregated "Wallet Funding" card or report on any dashboard** as of this commit. This row exists to pin the source of truth *before* one is built, not to describe a figure that ships. The existing surfaces are row-level, not aggregated: the per-user wallet timeline (`listWalletLedger`) and the admin wallet-transactions ledger page (`listAllWalletTransactions` / `countAllWalletTransactions`), all in `packages/db/src/crud/users.ts`. |
| **Kind filter** | Not applicable — not an `Order` aggregate. |
| **Why this matters** | **This is the headline fix of the entire Financial Ledger project.** Before Task 6a, a wallet top-up was counted as a product sale in thirteen separate call points — the dashboard's Revenue Today, the Reports page's funnel and charts, the customer's "Total Spent", the Customers page KPIs, the bot's customer-facing and admin dashboards, and the storefront home page. A buyer moving their own money into their own wallet inflated the shop's reported revenue, and then inflated it a second time when they actually spent it. Wallet funding is a **liability** (`wallet_liability.<ccy>`), not revenue. It becomes revenue only when the credit is spent on a product order. |

### Cash Position

| | |
|---|---|
| **Business definition** | Where the shop's money actually is right now, account by account. |
| **Source of truth** | `trialBalance(db, currency)` — `packages/db/src/crud/ledger.ts`. Reads `LedgerAccount` + `LedgerEntry`. **Not derived from any `Order` figure at all** — it is the double-entry ledger's own view. |
| **Status in the product today** | **`trialBalance` has no production caller.** It is exercised by `ledger.test.ts` only; no route, page or bot handler surfaces it as of this commit. Wiring it to an admin-facing surface is later-milestone work. This row pins the source of truth so that when it is wired, it is wired to the ledger and not re-derived from orders. |
| **Signing** | Balances are **signed, not absolute**: debit-normal types report `debit − credit`, credit-normal types `credit − debit`. An ASSET account credited beyond its debits is genuinely negative and is reported as such — reporting it as positive would hide exactly the kind of bug a trial balance is read to find. An unrecognised account type **throws** rather than defaulting to a sign. |
| **Currency** | One currency per call. IDR and USDT are separate books (`assertBalancedPerCurrency`) and are never summed. |
| **Scope** | `isActive: true` accounts only, ordered by `code` so successive reads compare line by line. Retired accounts stay readable through `getAccountBalance`, which takes any code. |
| **Caching** | None, by design — there is no running-total column to go stale. The entries *are* the balance; a cached total that disagrees with them is unfixable without knowing which one lied. The sum happens in Postgres. |
| **Missing account** | `getAccountBalance` **throws** for an unknown code rather than returning zero: "this account has no entries" and "there is no such account" are different answers, and a typo'd code silently reading 0.00 would make a reconciliation report look clean. |

### The Wallet Liability control-account invariant

Checked by `findWalletLedgerDrift` inside `reconcileLedger`
(`packages/db/src/crud/reconcileLedger.ts`), run by a 6-hourly cron, reported
as `WALLET_LEDGER_DRIFT` at `CRITICAL` severity.

```
sum(User.walletBalance)  +  in-flight wallet holds  ==  wallet_liability.<ccy>
```

Checked **per currency, independently, never summed** — a surplus in one must
not hide a shortfall in the other.

**The in-flight-hold reconciling term (Task 5's C1 fix) — read this before
concluding the check is wrong.** The two sides are updated at different
moments by different code. Wallet credit spent at checkout leaves
`User.walletBalance` **immediately**, but only reaches `wallet_liability.<ccy>`
when the order **settles**. So while any order sits in `PENDING_PAYMENT` or
`PENDING_VERIFICATION` with wallet credit spent on it, the buyers' side is
legitimately lower than the ledger's. Without this term the check fired
constantly on any live shop, forever — the exact "false positives train admins
to ignore real alerts" failure the whole reconciliation system exists to
prevent.

`inFlightWalletHolds` measures that gap from **real `WalletTransaction` rows**,
not an allowance:

- An order counts as in flight when **no `order:{id}:payment` posting exists**
  for it. That is the same question the settlement path answers, not a guess
  about status — statuses change and get added; the posting's presence is the
  fact that decides whether `wallet_liability` has been debited yet.
- Each order's `order_payment` debits are **netted against** its `order_refund`
  releases, so a hold returned by `releaseOrderHolds` stops counting.
- A negative net (more returned than spent — unreachable through the app) is
  **floored at zero**. This term exists to explain a shortfall the ledger has
  not caught up with; letting it go negative would let it explain away credit
  that appeared from nowhere, which is precisely the drift being hunted.
- A settled order whose posting was *erased* also lands here, and is reported
  by `findMissingOrderPostings` instead — the same root cause named once, by
  the check that can point at the order.

**Two further expected behaviors, both documented rather than suppressed:**

1. **Before M10's historical backfill runs, this check is EXPECTED to report
   the shop's whole pre-ledger wallet float as drift**, as one standing
   `CRITICAL` per funded currency. `User.walletBalance` carries every credit a
   buyer was ever given, including pre-ledger ones; `wallet_liability.<ccy>`
   only holds what has been posted since M3 went live. This is a *different*
   problem from the in-flight term and resolves when M10 runs, not before.
   Suppressing it would need a stored opening balance this milestone does not
   have, and inventing one would be a fabricated figure.
2. **The comparison is deliberately unscoped** — not because per-row history is
   missing (it exists: `adjustWallet` writes a timestamped `WalletTransaction`
   with `delta` and `balanceAfter` before every balance write), but because
   scoping it to movements would **blind the check to any balance change that
   bypassed `adjustWallet` altogether** — a hand-edited `User.walletBalance`
   column writes no movement row and would cancel out of a movements-based
   comparison exactly. That is precisely the drift class this check exists to
   catch. The unscoped comparison is the more paranoid one, not merely the
   un-optimised one.

A `wallet_liability.<ccy>` account that does not exist at all (chart of
accounts never seeded) is **logged and skipped**, not compared against a zero
it never had — reporting the buyers' whole balance as drift against an account
that was never created would name the wrong problem.

---

## KNOWN INCONSISTENCY: the day boundary is not the same everywhere

**This is current behavior being documented, not a recommendation, and not a
fix.** It was found during M6 and deliberately left in place. Read this before
comparing any two "today" figures.

This project's stated, confirmed policy is **UTC everywhere** for reporting
boundaries — no retroactive shift to `config.TIMEZONE`. **Part of the current
code contradicts that policy, and predates the Financial Ledger work.**

There are **three** different "start of today" conventions live in the codebase
right now:

| Convention | Computed by | Used by |
|---|---|---|
| **Jakarta-local midnight** (`config.TIMEZONE`-local 00:00, converted to a UTC instant) | `startOfDayUtc()` — `packages/core/src/datetime.ts:52-54`. **The name is misleading**: it is not UTC midnight. | `GET /api/dashboard/kpis` → Revenue Today/Yesterday, Refunds Today, Net Sales Today, Profit Today, Orders Today funnel. `GET /api/orders/kpis` → `revenueToday`. `customersKpis` → `newToday`, `activeToday`. |
| **True UTC midnight** | `ensureUtc(new Date()).startOf("day")` | The **bot's** admin dashboard (`apps/order-bot/src/handlers/admin.ts`) — its "today's revenue"/"today's orders", and its period="today" report filter. |
| **True UTC calendar day / ISO week / month / year** | `setUTCHours(0,0,0,0)` + `toISOString().slice(0,10)` (Day series); luxon `.startOf(granularity)` in UTC zone (Week/Month/Year) | **Every** `*ByDay` and `*ByPeriod` function in `revenue.ts`: `revenueByDay`, `ordersByDay`, `combinedRevenueByDay`, `refundsByDay`, `profitByDay`, `revenueByPeriod`, `ordersByPeriod`, `profitByPeriod`. |

**Practical consequences, stated plainly:**

- Jakarta is UTC+7, so the web admin's "today" starts **7 hours earlier** than
  the chart's "today". Orders placed between 17:00 and 23:59 UTC fall on
  *tomorrow* for the KPI cards and on *today* for the chart.
- **The "Revenue Today" KPI card and the last point of the Revenue-by-Day chart
  on the same dashboard can legitimately show different numbers.** Neither is
  broken.
- **The web admin's "today's revenue" and the bot admin's "today's revenue" can
  legitimately disagree**, even though both call `revenueSummary` — they pass
  different day boundaries.

**Why it was not fixed at M6:**

1. Changing it shifts "today's revenue" by up to 7 hours' worth of orders
   before 17:00 UTC, and up to 17 hours' worth between 17:00 and 23:59 UTC
   (both bot-vs-web-admin windows are right-anchored at "now", not a fixed
   close, so the gap widens once the Jakarta date rolls but the UTC one
   hasn't — see the row above) — a real, user-visible number change entirely
   unrelated to the `kind: PRODUCT` bug M6 exists to fix.
2. M8's parity report must attribute every pre-fix/post-fix delta to the
   documented `kind: PRODUCT` correction alone, with nothing unexplained.
   Folding in an unrelated timezone-boundary change would contaminate that
   attribution beyond repair.
3. `customersKpis`'s Jakarta-local "today" for new/active customer counts is
   arguably a *legitimate, separate* design choice (shop-operations framing, not
   a financial-ledger metric). Conflating it with the revenue-boundary question
   would overreach.

**Status: candidate fix for a future, separate, explicitly-scoped milestone.**
Not this one. When it is done it must be done as its own change with its own
before/after numbers — **never silently folded into another change**, and never
by renaming `startOfDayUtc` without changing its callers or vice versa.

---

## Dashboard Source-of-Truth Matrix

One row per figure the system computes. "Timezone" is the day/period boundary
that figure is bucketed on.

| Metric | Source function | File | Currency handling | Kind filter | Refund-aware? | Timezone convention |
|---|---|---|---|---|---|---|
| Revenue Today / Yesterday (= Gross Sales) | `revenueSummary` | `packages/db/src/crud/revenue.ts` | IDR/USDT separate (+ `usd` alias of the USDT figure) | `PRODUCT` | No — gross | ⚠️ Jakarta-local midnight (`startOfDayUtc`) |
| Refunds Today | `refundTotalsSince` | `packages/db/src/crud/revenue.ts` | IDR/USDT separate, from `RefundExecution.currency` | n/a (refund-rooted) | Yes — is the refund figure | ⚠️ Jakarta-local midnight; buckets on `executedAt` |
| Net Sales Today | `grossSalesForNetSales` − `refundTotalsSince` | `revenue.ts` + `apps/web-admin/src/routes/api/dashboard.ts` | IDR/USDT separate, subtracted per currency | `PRODUCT` | **Yes** | ⚠️ Jakarta-local midnight |
| Profit Today | `profitSummarySince` | `packages/db/src/crud/revenue.ts` | Separate; USDT via per-order `fxRate` snapshot | n/a (OrderItem-rooted, immune) | No | ⚠️ Jakarta-local midnight |
| Orders Today (funnel: total/delivered/pending/failed) | `ordersByStatusSince` | `packages/db/src/crud/reports.ts` | n/a (counts) | `PRODUCT` | Refunded orders leave `delivered`, stay in `total` | ⚠️ Jakarta-local midnight; windows on **`createdAt`** |
| Order funnel (Reports page, lifetime) | `ordersByStatus` | `packages/db/src/crud/reports.ts` | n/a | `PRODUCT` | As above | Lifetime |
| Revenue by Day | `revenueByDay` | `packages/db/src/crud/revenue.ts` | IDR/USDT separate | `PRODUCT` | No | **UTC calendar day**, rolling last-N-days |
| Orders by Day | `ordersByDay` | `packages/db/src/crud/revenue.ts` | Split by currency (counts) | `PRODUCT` | No | **UTC calendar day**, rolling |
| Combined Revenue by Day | `combinedRevenueByDay` | `packages/db/src/crud/revenue.ts` | **Blended to IDR-equiv via per-order `fxRate` snapshot** (opt-in) | `PRODUCT` | No | **UTC calendar day**, rolling |
| Refunds by Day (⚠️ no production caller today) | `refundsByDay` | `packages/db/src/crud/revenue.ts` | IDR/USDT separate | n/a | Yes | **UTC calendar day**, rolling, on `executedAt` |
| Profit by Day | `profitByDay` | `packages/db/src/crud/revenue.ts` | Separate; per-order `fxRate` snapshot; `null` when all cost unknown | n/a (immune) | No | **UTC calendar day**, rolling |
| Revenue by Week/Month/Year | `revenueByPeriod` | `packages/db/src/crud/revenue.ts` | Separate, **plus** `revenueIdrEquiv` blend (opt-in) | `PRODUCT` | No | **UTC ISO week (Mon) / calendar month / calendar year** |
| Orders by Week/Month/Year | `ordersByPeriod` | `packages/db/src/crud/revenue.ts` | Split by currency (counts) | `PRODUCT` | No | **UTC ISO week / month / year** |
| Profit by Week/Month/Year | `profitByPeriod` | `packages/db/src/crud/revenue.ts` | Separate; `fxRate` snapshot; `null` when all cost unknown | n/a (immune) | No | **UTC ISO week / month / year** |
| Top products (Reports) | `topProducts` | `packages/db/src/crud/revenue.ts` | IDR (catalog-central) | n/a (immune) | No | Rolling window from `since` |
| Top products by margin (Dashboard) | `topProductsByMargin` | `packages/db/src/crud/revenue.ts` | IDR-equivalent; `profitIdrEquiv` **`null`** if any unit's cost unknown | n/a (immune) | No | Rolling window from `since` (default 30d) |
| Orders-page `totalOrders` | `countOrders(db, {})` | `packages/db/src/crud/orders.ts` | n/a | **None — all kinds, deliberate** | No | Lifetime |
| Orders-page `delivered` / `cancelled` badges | `countDelivered` / `countCancelled` | `packages/db/src/crud/orders.ts` | n/a | **None — all kinds, deliberate** | A refunded order leaves `delivered` | Lifetime |
| Operation Center / Pending Actions counts | `countPendingPaymentLike`, `countProcessing`, `countPendingVerifications`, `countUnderpaid`, `countExpiredPending`, `countAwaitingManualFulfillment` | `packages/db/src/crud/orders.ts` | n/a | **None — all kinds, deliberate** (`countAwaitingManualFulfillment` is structurally immune) | No | Point-in-time; `countExpiredPending` takes an explicit `now` |
| Customer "Total Spent" | `userTotalSpent` / `totalSpentByUserIds` | `packages/db/src/crud/users.ts` | IDR/USDT separate | `PRODUCT` | No | Lifetime |
| Customers KPI row (`totalRevenue`, `returningCustomers`) | `customersKpis` | `packages/db/src/crud/users.ts` | IDR/USDT separate | `PRODUCT` | No | Lifetime |
| Customers KPI row (`newToday`, `activeToday`) | `customersKpis` | `packages/db/src/crud/users.ts` | n/a | n/a (reads `User.createdAt`/`lastSeenAt`) | n/a | ⚠️ Jakarta-local midnight |
| Customers "Orders" / "Last Order" columns | `orderStatsByUserIds.totalOrders` / `.lastOrderAt` | `packages/db/src/crud/users.ts` | n/a | **None — all kinds, deliberate** | No | Lifetime |
| "RETURNING" badge | `orderStatsByUserIds.deliveredOrders` | `packages/db/src/crud/users.ts` | n/a | `PRODUCT` | No | Lifetime |
| Customers sort-by-spend ordering | `rankUserIdsBySpend` (private) | `packages/db/src/crud/users.ts` | **IDR-only ranking** (pre-existing, deliberate — see note above, not a bug) | `PRODUCT` | No | Lifetime |
| Storefront home fulfilment stats | `shopFulfilmentStats` | `packages/db/src/crud/orders.ts` | n/a | `PRODUCT` | No | Lifetime |
| Bot customer dashboard stats | `botOverallStats` | `packages/db/src/crud/revenue.ts` | IDR/USDT separate; `items_sold` immune; `total_users` not order-derived | `PRODUCT` on revenue | No | Lifetime |
| Bot admin dashboard "today's revenue/orders" | `revenueSummary` | `packages/db/src/crud/revenue.ts`, called from `apps/order-bot/src/handlers/admin.ts` | IDR/USDT separate | `PRODUCT` | No | **True UTC midnight** — differs from the web admin's same-named figure |
| Wallet Funding | `WalletTransaction` (`wallet_topup`) / `User.walletBalance*` | `packages/db/src/crud/users.ts`, `wallet_topup.ts` | Per currency | **Never an Order sales aggregate** | n/a | *No dashboard card exists today* |
| Cash Position | `trialBalance` | `packages/db/src/crud/ledger.ts` | One currency per call, never summed | **Not Order-derived at all** | Ledger-complete | *No production caller today* |
| Wallet liability invariant | `findWalletLedgerDrift` / `inFlightWalletHolds` in `reconcileLedger` | `packages/db/src/crud/reconcileLedger.ts` | Per currency, independently | n/a | n/a | Point-in-time, 6-hourly cron |

---

## What changed and why (for shops with wallet top-up history)

> **If your shop has wallet top-up activity, your Revenue, Order-count and
> Customer-spend figures will be LOWER after this update than they were before.
> This is a bug fix, not lost data. Nothing was deleted.**

**What was wrong.** A wallet top-up creates a real order row that reaches
"Delivered" just like a sale does. The old queries counted it as a sale. So
when a customer put Rp500,000 into their wallet, the dashboard reported
Rp500,000 of revenue — and then reported it *again* when they actually spent
that credit on a product. The same rupiah was counted twice, and money that was
never the shop's (it is still the customer's, held as a liability) was shown as
income.

**What is right.** Funding a wallet is not a sale. It becomes revenue only when
the credit is spent on a product. Every sales figure now counts product orders
only.

**Which figures moved down**, and by how much (exactly the top-up volume in
each window):

- Dashboard "Revenue Today"/"Revenue Yesterday", and the Orders-page
  "Revenue Today"
- The Reports page's revenue charts and order funnel
- The Sales Analytics chart at every granularity
- Each customer's "Total Spent", the Customers page's KPI row, and the
  "Returning customer" counts and badges
- The storefront home page's "orders delivered" and "customers served"
- The bot's customer-facing shop stats, and the bot's own admin dashboard
  "today's revenue"/"today's orders"

**Which figures did NOT move**, deliberately:

- The Orders page's total/delivered/cancelled counts and status-tab badges,
  and the Operation Center / Pending Actions queues. These count admin *work*,
  and a stuck wallet top-up is real work an admin must see. They intentionally
  still count both kinds — see [Order counts](#order-counts).
- The "Orders" and "Last Order" columns on the Customers page — account
  activity, not purchases.

**Audit trail.** Every change is in these commits on branch
`worktree-financial-ledger`:

| Commit | Subject | What it changed |
|---|---|---|
| `3c15ba47` | `fix(db): stop counting wallet top-ups as product sales` | 13 call points across `revenue.ts` (`salesRevenueByCurrency` — which fixes `revenueSummary` *and* `botOverallStats` — `revenueByDay`, `ordersByDay`, `combinedRevenueByDay`), `reports.ts` (`ordersByStatus`, `ordersByStatusSince`), `users.ts` (`userTotalSpent`, `totalSpentByUserIds`, `customersKpis` × 2 groups, `orderStatsByUserIds.deliveredOrders`, `rankUserIdsBySpend`), and `orders.ts` (the kind-agnostic operational-counter block header comment, and the new `OrderFilter.kind` field). 13 new tests, each watched failing first. |
| `997fd500` | `fix(db): stop shopFulfilmentStats counting wallet top-ups as sales` | The storefront home page's own delivered-orders and distinct-customers counts (found during the Task 6a review, same bug class, not in the original list). Also narrowed `OrderFilter.kind` from `string \| null` to `OrderKind \| null`. |

Two further commits in the same milestone changed what the dashboard *shows*
rather than correcting an existing figure:

| Commit | Subject |
|---|---|
| `f09e3f5d` | `feat(dashboard): show refunds and net sales, the first refund-aware KPIs` |
| `047927b2` | `fix(dashboard): stop Net Sales double-subtracting a same-day full refund` |
| `c7fd5563` | `feat(dashboard): add Week/Month/Year ranges and a Profit metric to Sales Analytics` |
| `7e20b1eb` | `docs(db): record the year-window unbounded-fetch tradeoff` |

An auditor can reproduce the delta for any window by running the current query
with and without its `kind: OrderKind.PRODUCT` clause; the difference is
exactly the settled `WALLET_TOPUP` volume in that window. M8's parity report
does this systematically, with real numbers.

---

## Open items deliberately not fixed here

Recorded so a future milestone can act on them with full context. **None of
these is a fix this document performs** — M7 is documentation-only.

1. **The three-way day-boundary inconsistency.** Documented above. Needs its
   own explicitly-scoped milestone with its own before/after numbers. Must not
   be folded into an unrelated change.
2. **`metric=orders&currency=combined` returns the IDR count.** Pre-existing;
   trivially fixable (`ordersIdr + ordersUsdt`) but not in scope. Inconsistent
   with revenue's real blend on the same query param.
3. **`netSales` of exactly zero renders as the empty "no activity" state.** The
   `null`-when-zero convention applied consistently rather than a second rule
   invented for one field, but it means a day whose refunds exactly cancel its
   sales reads identically to a day with nothing at all. Only the exact-zero
   knife edge — a genuinely negative net is non-zero and renders in full.
4. **A `null` profit bucket is ambiguous on the chart** — "no sales" and
   "sales, all costs unknown" draw the same gap.
5. **fxRate-less USDT orders are counted unconverted** in the combined blend
   rather than dropped. Pre-existing; now reachable at more granularities.
6. **`rankUserIdsBySpend` ranks on IDR-only spend**, so a USDT-only buyer sorts
   as a zero-spender despite a correct non-zero "Total Spent" cell. This is
   **deliberate by the function's own doc comment** (`users.ts:693-698`):
   blending IDR and USDT spend into one ranking scalar would fabricate a
   figure, the same reasoning `CurrencyStack` encodes on the display side.
   Not an open bug to fix — recorded so a future pass doesn't "fix" it by
   inventing a blended spend score.
7. **`listUserDeliveredOrders`** (`orders.ts`) is still kind-agnostic while its
   own siblings `listUserOrders`/`countUserOrders` are `PRODUCT`-filtered — a
   buyer's account page can show an empty "delivered order" for a settled
   top-up. Pre-existing, not a money metric, out of M6's blast radius.
8. **`year: 5` is an unbounded row fetch** re-issued every 30s while the Year
   view is open. Not a correctness bug; a scaling ceiling. Fix is a raw
   `date_trunc GROUP BY` if it ever matters.
9. **No `@@index([status, executedAt])` on `RefundExecution`.** Deferred at
   Task 6b because the table is tiny and a schema change adds a deploy step.
10. **No AOV metric exists**; if one is added it must take numerator and
    denominator from the same kind-filter family — see the
    [cross-metric warning](#cross-metric-warning-the-orders-page-kpi-row-mixes-both-families).
11. **`trialBalance` and wallet-funding figures have no production surface.**
    When they get one, it must read the ledger, not re-derive from orders.
12. **`WALLET_LEDGER_DRIFT` will report the pre-ledger wallet float** as one
    standing `CRITICAL` per funded currency until M10's backfill runs. Expected,
    not a bug. Whoever deploys should either expect it or run M10 promptly.

---

*Financial Ledger M7. Verified against commit `7e20b1eb`.*
