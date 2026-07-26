# 04 — CRUD Template

**Scope:** the canonical structure for every list ("manage X") page and every
create/edit form. Grounded in `apps/web-admin/client/src/pages/OrdersPage.tsx` (the
fullest real example — search+filters, bulk actions, server pagination, row actions,
sticky header, toast feedback) and `StockPage.tsx`/`UsersPage.tsx` (the simpler
tier). Layout hierarchy is defined in `02_ADMIN_LAYOUT.md`; components used here are
defined in `03_COMPONENT_LIBRARY.md`.

---

## 1. Two list-page tiers

Not every list needs every feature. Pick the tier that matches the dataset:

| | **Simple tier** | **Full tier** |
|---|---|---|
| Example | `StockPage.tsx`, `UsersPage.tsx`, `CatalogPage.tsx` | `OrdersPage.tsx` |
| Dataset size | Small/bounded (fits comfortably client-side) | Large/growing, needs server pagination |
| Filtering | Client-side, immediate (`SearchBar` updates state per keystroke) | Server-side, draft+Apply/Clear via `FilterBar` |
| Pagination | None — full result set rendered | `Pagination`, server-paginated |
| Bulk actions | None | Selection + sticky bulk-action bar |
| Row actions | Inline buttons or a simple menu | `DropdownMenu` per row |
| Sticky table header | Usually off | On (`stickyHeader`) |

**Default to the simple tier** for a new list page unless the dataset is expected to
grow past a page or two, or the feature genuinely needs bulk operations. Upgrading a
simple-tier page to full-tier later is a mechanical, additive change (add
`Pagination`, add selection state, add a bulk-action bar) — it doesn't require a
rewrite, so don't over-build a page's first version "for scale" it doesn't need yet.

## 2. Full-tier page structure (annotated)

```tsx
<PageLayout title="Orders">
  {/* HEADER */}
  <PageHeader
    title="Orders"
    description="Manage customer purchases, payments, deliveries and fulfillment."
    actions={<ExportButton />}
  />

  {/* SUMMARY CARDS — optional */}
  <OrdersKpiRow />
  <OrderStatusTabs active={activeTab} onChange={selectTab} />

  {/* TOOLBAR: SEARCH + FILTERS */}
  <FilterBar onApply={applyFilters} onClear={clearFilters}>
    <SearchBar value={draft.q} onChange={...} />
    <Select ... />      {/* Status */}
    <Select ... />      {/* Payment Method */}
    <DateInput ... />   {/* From */}
    <DateInput ... />   {/* To */}
  </FilterBar>

  {/* BULK ACTIONS — conditional */}
  {selected.size > 0 && (
    <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3
                     rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift">
      <span>{selected.size} selected</span>
      <Button variant="outline">Mark Delivered</Button>
      <Button variant="outline">Resend</Button>
      <Button variant="destructive">Cancel</Button>
      <Button variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
    </div>
  )}

  {/* TABLE */}
  <DataTable
    stickyHeader
    columns={[ /* see 05_TABLE_GUIDELINES.md */ ]}
    data={pageRows}
    isLoading={isLoading}
    keyExtractor={(row) => row.id}
    onRowClick={(row) => navigate(`/orders/${row.id}`)}
    empty={<EmptyState icon={ShoppingCart} title="No orders found." description="..."
                        action={{ label: "Refresh", onClick: refetch }}
                        secondaryAction={{ label: "Clear Filters", onClick: clearFilters }} />}
  />

  {/* PAGINATION */}
  {data && (
    <div className="mt-4">
      <Pagination page={filters.page} pageSize={filters.pageSize} total={data.total}
                  onPageChange={...} onPageSizeChange={...} />
    </div>
  )}

  {/* create/edit/cancel dialogs mounted conditionally at the bottom of the tree */}
</PageLayout>
```

## 3. Section-by-section rules

### Header
Always `PageHeader` with a title and a short one-sentence description (see
`02_ADMIN_LAYOUT.md` §5). Primary page-level action (e.g. "Export CSV", "+ Add
Product") goes in `actions`.

### Toolbar / Search / Filters
Always `FilterBar` wrapping a `SearchBar` (if search is the single freestanding
filter — otherwise a plain labeled `Input` alongside other filter fields, see
`03_COMPONENT_LIBRARY.md` §Search) and any `Select`/`DateInput` filter controls.

Two `FilterBar` modes:
- **Immediate** — no `onApply`, filters commit on every change. Use for the simple
  tier / client-filtered pages.
- **Draft + commit** — `onApply`/`onClear` supplied, fields write to local draft
  state, only "Apply" commits to the actual query. Use for server-side filtered
  pages (avoids firing a request per keystroke). Optionally wrap in `<form
  onSubmit>` for Enter-to-submit.

A server-side filtered page's free-text `SearchBar` may additionally use a
**third, search-specific sub-mode — search-live** — while every other field in
the same `FilterBar` stays on draft + commit: the `SearchBar`'s own value
commits on a **250–350ms debounce** (via the shared `useDebouncedValue` hook,
`hooks/useDebouncedValue.ts`) independent of the surrounding Apply button, and
is round-tripped to the URL (`?q=...`) via `useSearchParams` so the query
survives a reload/back-navigation. Use this when the search field's own
result-narrowing is valuable moment-to-moment (a lookup-style search) and the
other filter fields remain deliberate/Apply-gated (discrete pickers, where
debouncing makes no UX sense). Pass `loading={isFetching && value !== ""}` to
`SearchBar` (its `loading` prop swaps the leading icon for a spinning
`Loader2`) so a debounced refetch has a visible in-place indicator. Reference
implementation: `apps/web-admin/client/src/pages/UsersPage.tsx`. Do not add
this live-commit behavior to a `Select`/`DateInput`/other structured filter —
it's scoped to free-text search only.

### Sorting
There is **no clickable-column-header sorting** anywhere in this app (see
`00_AI_RULES.md` §4). Where sorting exists, it's a separate `Select` control (e.g.
"Sort by: Newest / Price / Stock") plus a client-side `.sort()` on the fetched
array. Follow this pattern for new sortable lists — do not add header-click sorting
to a single table.

### Bulk Actions
Conditional — only rendered when `selected.size > 0`. Styled as a floating sticky bar
(`sticky bottom-4 shadow-lift`), never an always-visible toolbar row. Selection state
lives in the page (`Set<id>`), never inside `DataTable`, and is **cleared whenever
filters/query change** (`useEffect(() => setSelected(new Set()), [filters])`) so a
stale, off-screen selection can't be bulk-acted on.

### Table
Always `DataTable` — see `05_TABLE_GUIDELINES.md` for the full contract (columns,
selection, action-column convention, mobile behavior). Never a raw `<table>`.

### Pagination
Server-paginated pages: `Pagination`, driven by `page`/`pageSize` in the page's
filter state, sent as query params only when non-default. Client-filtered
simple-tier pages: no pagination — the full filtered result set renders.

### Loading
`isLoading` passed straight through to `DataTable`, which renders `SkeletonRow`s
(default 5) in place of the table body. Never a full-page spinner for a list's
initial load.

### Empty State
`DataTable`'s `empty` prop, an `EmptyState` with copy following the "bold headline +
actionable subline" convention (`03_COMPONENT_LIBRARY.md` §Empty State). When
filters are active, offer "Clear Filters" as a secondary action; when genuinely
empty (no filters), offer the page's primary create action instead.

### Error State
`isError` short-circuits the whole page body:
```tsx
if (isError) return <PageLayout title="Orders"><p className="text-rust">Failed to load orders.</p></PageLayout>;
```
This is a per-page inline pattern today (no shared `PageError` component exists) —
follow it consistently rather than inventing per-page error copy/layout.

### Success State
Prefer `toast.success(...)` after a successful mutation, always paired with a
`queryClient.invalidateQueries()` call (see `03_COMPONENT_LIBRARY.md` §Toast). For
create flows, success is typically communicated by navigating to the newly created
entity's detail page rather than a toast (see §5 below).

### Permission State
The client surfaces exactly one permission flag today: `isOwner` (used in
`SettingsPage.tsx` to gate owner-only sections/actions). There is no broader
role/RBAC system in the admin UI. If a new page needs to gate a section or action by
permission, follow the same shape — a boolean flag from the API response gating a
conditional render — rather than introducing a new permissions framework. Gated UI
should be **hidden**, not shown-but-disabled-without-explanation, unless disabling
with a clear inline reason communicates something the user needs (e.g. "Add
credentials below to enable this gateway").

### Responsive behavior
Follows `02_ADMIN_LAYOUT.md` §6 and `05_TABLE_GUIDELINES.md`'s mobile card-stack —
no page-specific responsive overrides.

### Keyboard shortcuts
- `Ctrl+K`/`Cmd+K` — global search (shell-level, always available).
- `Enter` inside a `FilterBar` wrapped in `<form onSubmit>` — submits/applies filters.
- Standard browser/Radix keyboard behavior inside `Select`, `DropdownMenu`, `Dialog`
  (arrow keys, `Escape` to close, `Tab` focus trap inside dialogs) — never override
  these.

## 4. Create/Edit pattern

There is **no schema-validation library** (`react-hook-form`/`zod`) in this app.
Every form validates manually:

```tsx
const [name, setName] = useState("");
// ...one useState per field
const create = useMutation({
  mutationFn: () => apiPost("/api/catalog/products", { name: name.trim(), ... }),
  onMutate: () => setError(null),
  onSuccess: (product) => { qc.invalidateQueries(...); navigate(`/catalog/${product.id}`); },
  onError: (e: Error) => setError(e.message),
});
const canSubmit = name.trim().length > 0 && categoryId !== null;
...
<Button disabled={!canSubmit || create.isPending} onClick={() => create.mutate()}>
  {create.isPending ? "Creating…" : "Create Product"}
</Button>
```

This is the standard, not a stopgap — do not introduce `react-hook-form`/`zod` on a
single new form. If a repo-wide decision is made to adopt a schema library, that's a
migration across all forms at once, updating this document first.

**Required-field marker:** a `<span className="text-rust">*</span>` next to the
label. **Server error display:** a local `error` state string, rendered as
`<p className="text-sm text-rust">{error}</p>` near the submit button.

### Two co-existing, both-canonical patterns

**Full-page create/edit** — for primary, multi-field entities (Product,
Denomination):
```tsx
<PageLayout title="New Product">
  <PageHeader breadcrumb={[{label:"Catalog", href:"/catalog"}, {label:"New Product"}]} />
  <div className="max-w-lg flex flex-col gap-4">
    {/* one <label> + Input/Textarea/Select block per field */}
  </div>
</PageLayout>
```
Supports an inline "create related entity" sub-flow where useful — e.g. a Category
`Select` with a `+ New category` sentinel option that swaps the `Select` for an
inline mini-form with its own Confirm/Cancel (see `ProductCreatePage.tsx`).

**Dialog-based create/edit** — for secondary/lighter-weight entities and bulk
operations: renaming a Category (`CatalogPage.tsx`'s `CategoryEditDialog`), bulk-
applying a flash sale to N selected SKUs (`FlashSalesPage.tsx`), cancel-with-reason
(`OrdersPage.tsx`). Use `Dialog` with a `DialogFooter` (Cancel + submit button), same
manual validation approach.

### Choosing full-page vs. dialog

| Use full-page when... | Use a dialog when... |
|---|---|
| The entity has many fields | The form is short (1–4 fields) |
| Creating it is a primary, deliberate flow the user navigates to | It's a quick edit/action reached from a row or a bulk selection |
| The result deserves its own detail page to land on afterward | The result just needs the underlying list refreshed |

**Never** build a bare, unlabeled inline table row for create/edit (no `Label` +
`Input`/`Select`, placeholder-only fields) — not a third valid tier.
