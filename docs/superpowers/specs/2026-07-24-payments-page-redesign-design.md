# Payments page structural redesign

**Date:** 2026-07-24
**Status:** Design approved by user, ready for implementation plan

## Problem

`docs/audit-ui-ux-structural-2026-07-24.md` ranked `PaymentsPage.tsx` P0/P1: its summary
stat cards are computed client-side from only the current page of the ledger (so "Today's
Transactions" silently becomes wrong once pagination is in play — a real correctness bug, not
just a cosmetic gap), and the page is missing search, bulk actions, a shared `Pagination`
component (it hand-rolls Prev/Next), and shared `StatCard`/`StatTile` styling for its stats.
Additionally, while reading the code for this session, two already-built-but-unwired backend
capabilities surfaced:

- `processedTxOutcomeCounts(prisma)` already returns correct **global** per-outcome counts
  (`data.counts`) — the frontend fetches it but never uses it, computing Pending/Failed from
  the paginated `ledger` slice instead.
- `POST /api/payments/credit` + `creditOrderToBalance` (crud) are fully implemented and tested,
  per `docs/superpowers/specs/2026-06-16-dual-credit-balance-design.md` §Component 3 entry
  point (a) — "For an `unmatched` tx the admin can identify, add 'Add to buyer's credit
  balance' next to the existing Dismiss / Match-by-hand" — but that Payments-panel UI action
  was never built. The `credited_to_balance` outcome is already in `TX_OUTCOMES` but has no
  `StatusBadge` tone (falls back to neutral).

## Goals

1. Fix the KPI correctness bug (Pending/Failed from `data.counts`; add a real server-side
   "today" count).
2. Bring the page structurally in line with the `OrdersPage.tsx` reference pattern: shared
   `Pagination`, a search+filter toolbar, bulk actions, `DropdownMenu` row actions.
3. Close out the unimplemented entry point (a) from the 2026-06-16 credit-balance spec.
4. Surface Binance poll health (already fetched, never rendered) as a small status indicator.

## Non-goals

- No changes to Underpaid/Pending Internal actions (Deliver anyway/Refund/Cancel) beyond
  visual restyling.
- No CSV export (not requested, no precedent on this page).
- No cross-page changes — this session touches only `PaymentsPage.tsx`,
  `apps/web-admin/src/routes/api/payments.ts`, `packages/db/src/crud/binance_internal.ts`, and
  `StatusBadge.tsx`'s tone map.

## Design

### 1. Page composition (top to bottom)

```
PageHeader (title="Payments", description="Match transfers to orders and resolve payment issues.")
  + health indicator (small pill, only when data.enabled) in the PageHeader area
  → KPI row: 3× StatCard (Today's Transactions / Pending / Failed) — icons + tone (warning for
    Pending, danger for Failed), sourced from server aggregates, not the page slice
  → Manual Match card (unchanged — already correct)
  → Attention queues: Underpaid Orders + Pending Internal Transfers, restyled as compact
    non-paginated cards (existing DataTable usage kept, just visually quieter — smaller
    CardTitle, no page-scoped toolbar since these are small operational queues, matching
    docs/ui/07_DASHBOARD_GUIDELINES.md's OperationCenter pattern, not the full list-page pattern)
  → Ledger section: FilterBar (outcome Select, kept) + SearchBar (Transfer ID) in one toolbar
  → Bulk-action bar (conditional on selected.size > 0): "Dismiss N transfers"
  → DataTable (Ledger) — adds a leading Checkbox column (eligible rows = outcome "unmatched"
    only, mirrors OrdersPage's `eligibility`-predicate pattern), converts the lone Dismiss
    button into a DropdownMenu with Dismiss + "Add to buyer's credit balance" (both only for
    unmatched rows)
  → Pagination (shared component, replacing hand-rolled Prev/Next)
  → Existing ConfirmDialogs (Deliver/Refund/Cancel) unchanged
  → New: CreditToBalance dialog (order-code input + autosuggest, reusing the existing
    `useOrderCodeSuggest` hook already in this file)
```

### 2. Backend changes

**`packages/db/src/crud/binance_internal.ts`**
- New `countProcessedBinanceTxToday(db: Db): Promise<number>` — counts
  `processedBinanceTx` rows with `createdAt >= startOfLocalDay`. Reuse
  `packages/core`'s luxon datetime helper for "start of day in `TIMEZONE`" (grep for the
  existing helper the codebase already uses for local-day boundaries — do not hand-roll date
  math). Add a colocated Vitest test (`binance_internal.test.ts` or a new file, matching the
  existing `crud/*.test.ts` convention).
- Extend `listProcessedBinanceTx` with an optional `q?: string` — when present, adds
  `binanceTxId: { contains: q }` to the `where` clause (SQLite `contains` is case-insensitive
  by default for the existing collation used elsewhere in this codebase — confirm against how
  other `contains` filters are written in `crud/*`, e.g. `orders.ts`'s search, and match that
  exact pattern rather than introducing a new one).

**`apps/web-admin/src/routes/api/payments.ts`**
- `GET /api/payments`: pass `q` query param through to `listProcessedBinanceTx`/
  `countProcessedBinanceTx`; add `todayCount: await countProcessedBinanceTxToday(prisma)` to
  the response alongside the existing `counts`.
- No new route for bulk dismiss — call the existing single-dismiss path once per selected id
  from the client (small N, simplest correct option; mirrors how `dismissUnmatchedTx` is
  already a single-row crud call with no existing bulk variant).

**`apps/web-admin/client/src/components/shared/StatusBadge.tsx`**
- Add `CREDITED_TO_BALANCE: "success"` to the `TONE` map (money successfully resolved).

### 3. Frontend changes (`PaymentsPage.tsx`)

- **KPI row**: replace the `stats` `useMemo` (computed from `data?.ledger`) with direct reads:
  `data?.todayCount ?? 0`, `data?.counts["unmatched"] ?? 0`, `data?.counts["delivery_failed"] ?? 0`.
  Render via `StatCard` (icon + tone), not the ad-hoc `Card`/`CardContent` currently used —
  matches `OrdersKpiRow`'s component choice per the audit rubric. `isLoading` gated on `!data`.
- **Health indicator**: small component (co-located in this file or a tiny new
  `PaymentsHealthPill.tsx` if it grows past ~15 lines) deriving one of 4 states from
  `data.health` — "Synced Xm ago" (neutral/success), "Retrying at HH:mm" (warning, when
  `backoffUntil` is future), "N consecutive failures" (danger), "Not yet synced" (neutral,
  `lastRun` null) — only rendered when `data.enabled`. Mirror `SettingsSaveStatus.tsx`'s local
  `relativeTime()` helper style (no new shared utility needed for one page).
- **Underpaid/Pending Internal cards**: reduce `CardTitle` visual weight (drop redundant count
  in the header if `StatCard`-style badges are added, or keep as-is — a light-touch pass, not a
  rebuild) so they read as "attention queues" rather than primary list sections. No new
  toolbar/pagination on these two.
- **Search + bulk selection state**: `const [q, setQ] = useState("")` (draft) debounced into
  the query key (mirror the 300ms debounce pattern already in this file via
  `useOrderCodeSuggest`, or a simple `useEffect` timer — keep consistent with existing local
  conventions rather than importing a new debounce utility). `const [selected, setSelected] =
  useState<Set<number>>(new Set())`, cleared on `[outcome, q]` change via `useEffect`
  (mirrors `OrdersPage.tsx`'s exact pattern).
- **Bulk dismiss**: new `useMutation` that `Promise.all`s `apiPost("/api/payments/dismiss", {
  binance_tx_id })` for each selected id's `binanceTxId`, then invalidates `["payments"]` and
  clears selection. Sticky bulk bar mirrors `OrdersPage.tsx`'s exact markup/positioning.
- **Row actions**: unmatched rows get a `DropdownMenu` (Dismiss + "Add to buyer's credit
  balance", `stopPropagation()` wrapper) instead of the lone ghost Dismiss button. Non-unmatched
  rows keep the empty actions cell.
- **Credit-to-balance dialog**: `pendingCredit: TxRow | null` state (same pattern as
  `pendingDeliver`/`pendingRefund`/`pendingCancel`), rendered as a small `Dialog` (not
  `ConfirmDialog`, since it needs an input) with an order-code `Input` reusing
  `useOrderCodeSuggest`, a `ConfirmDialog`-style confirm step or a `DialogFooter` Confirm button
  (disabled until a valid order code is entered), calling
  `apiPost("/api/payments/credit", { binance_tx_id: pendingCredit.binanceTxId, order_code })`.
- **Pagination**: replace the hand-rolled Prev/Next block with `<Pagination page={page}
  pageSize={data?.pageSize ?? 50} total={data?.total ?? 0} onPageChange={setPage} />` (no
  `onPageSizeChange` — matches `data.pageSize` being server-fixed at 50, same as other
  full-tier pages that don't expose a page-size control).
- **PageHeader**: add `description="Match transfers to orders and resolve payment issues."`
  (currently title-only).

### 4. Error handling

Existing conventions already followed by this file are kept as-is: `isError` short-circuit
before render, `toast.error(describeError(...))` on mutation failure, `toast.success(...)` +
`invalidateQueries` on success. Bulk dismiss surfaces a single toast summarizing the batch
(e.g. "Dismissed 3 transfers." / partial-failure case: "Dismissed 2 of 3 transfers — 1
failed."), not one toast per row.

### 5. Testing

- `packages/db/src/crud/binance_internal.test.ts` (or new colocated file): test
  `countProcessedBinanceTxToday` (rows today counted, rows from other days excluded, respects
  `TIMEZONE` boundary) and the new `q` search param on `listProcessedBinanceTx`
  (substring match, case-insensitive, no match → empty array).
- `apps/web-admin/test/web.test.ts`: extend existing Payments route tests for the new `q`
  param and `todayCount` field on `GET /api/payments`; confirm `/api/payments/credit` still
  behaves as before (no backend contract change there, only a new frontend caller).
- Manual verification (`pnpm dev:web`, per the audit's recommended "Final check"): load
  Payments, confirm KPI numbers match `data.counts`/`todayCount` regardless of which page
  you're on; search a known Transfer ID substring; select 2+ unmatched rows and bulk-dismiss;
  use "Add to buyer's credit balance" on an unmatched row end-to-end; confirm the health pill
  renders correctly with Binance internal enabled vs. disabled.

## Out of scope for this session

- Any change to `apps/order-bot`, storefront, or other admin pages.
- Auto-link entry point (c) from the 2026-06-16 spec (matcher auto-crediting) — that spec
  explicitly scoped it as a follow-up.
- `RecentOrdersTable`/Dashboard tech debt — unrelated page.
