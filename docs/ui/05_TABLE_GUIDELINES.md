# 05 — Table Guidelines

**Scope:** the single table pattern every module must use —
`components/shared/DataTable.tsx`. Never a raw `<table>`, never a page-specific table
layout. Layout placement is covered in `02_ADMIN_LAYOUT.md`; the underlying `Table`
primitive is covered in `03_COMPONENT_LIBRARY.md`.

---

## 1. Why one table component

Every list page in the app — Orders, Stock, Users, Catalog, Payments — renders its
table through `DataTable`. This guarantees that hover states, loading skeletons,
empty states, mobile behavior, and action-column conventions are identical across
every module without each page reinventing them. **`components/dashboard/
RecentOrdersTable.tsx` hand-rolls a raw `<table>` instead and is documented tech
debt** — it is not a second acceptable pattern; if you touch that file, migrate it to
`DataTable` rather than extending the hand-rolled version.

## 2. `DataTable` contract

```ts
interface Column<T> {
  key: string;
  header: ReactNode;            // empty header ("") = an "action column"
  render: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  isLoading?: boolean;
  keyExtractor: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;             // rendered when data is empty and not loading
  stickyHeader?: boolean;        // opt-in per page, default off
  skeletonRows?: number;         // default 5
}
```

There is **no `sortable`/`onSort` field** on `Column<T>` — sorting is never a
clickable-header interaction in this app (see `04_CRUD_TEMPLATE.md` §Sorting). There
is **no `resizable` field** — column resize is explicitly out of scope for v1; do not
add it to a single table's columns.

## 3. Built-in behaviors (don't reimplement these)

- **Hover:** every row is `hover:bg-muted/50` by default — no opt-in needed.
- **Sticky header:** `stickyHeader` adds `sticky top-0 z-10 bg-card` to the header
  row. Opt-in per page — `OrdersPage.tsx` uses it; simpler pages (`StockPage`,
  `UsersPage`, `CatalogPage`, `PaymentsPage`) don't, because their result sets are
  short enough that a sticky header adds little. Turn it on for any table whose
  content commonly scrolls past a full viewport height.
- **Horizontal scroll:** the underlying `Table` primitive wraps itself in
  `overflow-x-auto` automatically — wide tables scroll instead of squashing columns.
- **Checkbox-column padding:** cells/headers containing a `role="checkbox"` element
  automatically lose their right padding (`[&:has([role=checkbox])]:pr-0`) — don't
  add manual padding overrides around selection checkboxes.
- **Loading:** `isLoading` renders `SkeletonRow` × `skeletonRows` (default 5) in the
  table body, matching the real column count.
- **Empty:** when `data` is empty and not loading, renders the `empty` prop (an
  `EmptyState` — see `03_COMPONENT_LIBRARY.md` and `04_CRUD_TEMPLATE.md`).
- **Mobile responsive:** below `md` (768px), `DataTable` auto-switches to a
  card-stack layout — one card per row, each field labeled, with any column whose
  `header` is empty (an "action column") rendered as a bottom-right button row on
  the card instead of a table cell. Do not build a separate mobile-only rendering
  path in a page — this comes free from `DataTable`.

## 4. Columns

- **Action column convention:** a column with `header: ""` is treated as the row's
  action slot (a `DropdownMenu` trigger, typically). This is how `DataTable` decides
  what to render as the mobile card's action row — always use an empty header for
  this, never a header like `"Actions"`.
- **Never abbreviate a header.** Table headers use full words ("Password Set",
  not "Pwd").
- Render status-like cell values through `StatusBadge` (or a domain-specific sibling)
  — never a bespoke colored `<span>` per column (`03_COMPONENT_LIBRARY.md` §Status
  Badge).
- Render identifiers/codes with `font-mono` (`01_DESIGN_SYSTEM.md` §4).
- Never render a raw backend enum, snake_case action code, or bare numeric ID as a
  cell value — always map it to a human-readable label (this is a repo-wide rule, not
  table-specific — see `docs/ui-refactor/design-system.md`'s findings on the Orders
  status filter and the Audit Log's admin-as-numeric-ID column for the exact bugs
  this rule prevents).

## 5. Selection

Selection is **always page-owned**, never internal to `DataTable`:

```tsx
const [selected, setSelected] = useState<Set<number>>(new Set());

// header column
{ key: "select", header: <Checkbox checked={allOnPageSelected} onCheckedChange={toggleSelectAllOnPage} />,
  render: (row) => (
    <Checkbox checked={selected.has(row.id)}
              onCheckedChange={...}
              onClick={(e) => e.stopPropagation()} />
  ) }
```

Rules:
- Selection state is a `Set<id>` in the page component's own state.
- The header checkbox toggles select-all **on the current page only**, not the
  entire filtered dataset.
- Every selection `Checkbox` stops propagation on click so it doesn't also trigger
  the row's `onRowClick`.
- Selection is cleared whenever filters or the query change
  (`useEffect(() => setSelected(new Set()), [filters])`), so a bulk action can never
  fire against rows that are no longer in view.
- `DataTable`'s built-in `data-[state=selected]:bg-muted` row styling convention
  exists on the underlying `Table` primitive but isn't currently wired to anything —
  selection highlighting today is expressed via the `Checkbox` state itself, not a
  full-row highlight. Don't add row highlighting for selection without first
  checking whether this has changed.

## 6. Row actions ("context menu")

The per-row action affordance is always a `DropdownMenu` (`03_COMPONENT_LIBRARY.md`
§Dropdown) triggered by a ghost icon button (`MoreVertical`, `size="icon-sm"`):

```tsx
{ key: "actions", header: "",
  render: (row) => (
    <div onClick={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm"><MoreVertical/></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={...}><Eye/> View</DropdownMenuItem>
          {row.eligibility.canAct && <DropdownMenuItem onSelect={...}>...</DropdownMenuItem>}
          {canDestroy(row) && (<>
            <DropdownMenuSeparator/>
            <DropdownMenuItem variant="destructive" onSelect={...}>...</DropdownMenuItem>
          </>)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ) }
```

Items are conditionally rendered per-row based on domain "eligibility" flags
returned from the API (e.g. `row.eligibility.canAct`), not client-computed business
rules duplicated in the frontend. Destructive items are separated with a
`DropdownMenuSeparator` and use `variant="destructive"`.

## 7. Keyboard navigation & accessibility

- Rows with `onRowClick` should also be reachable via keyboard where the row itself
  functions as a link/button (in practice, most row-click navigation in this app
  targets a detail page — ensure the row or an equivalent control is focusable).
- Selection `Checkbox`es, row `DropdownMenu` triggers, and pagination buttons all
  inherit their accessibility contract from Radix/the shared components — don't
  strip `aria-*` attributes or roles when composing them into a column's `render`.
- Icon-only row actions (the `MoreVertical` trigger) need an `aria-label` if not
  already provided by the shared trigger pattern.
- Table semantics (`<table>`/`<thead>`/`<tbody>`/`<tr>`/`<td>` via the `Table`
  primitive) are preserved even in the mobile card-stack view's underlying markup —
  don't replace them with `<div>`s when customizing a column's render.

## 8. Column resize — out of scope

Column resize is explicitly **not implemented and not planned for v1**. Do not add
resize handles to a single table's columns; if resize genuinely becomes a
requirement, it belongs in `DataTable` itself (all tables get it at once), which
means updating this document and `03_COMPONENT_LIBRARY.md` first.

## 9. Never do

- Never render a table with a raw `<table>` element — always `DataTable`.
- Never add clickable-header sorting to one table.
- Never add column resize to one table.
- Never abbreviate a column header.
- Never render a raw enum/ID as a cell value without a human label.
- Never let selection state live inside `DataTable` — it's always page-owned.
- Never skip `stopPropagation` on interactive cell content (checkboxes, dropdown
  triggers) inside a row that also has `onRowClick`.
