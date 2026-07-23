# 03 — Component Library

**Scope:** every reusable UI building block available to admin pages, its purpose,
variants, states, spacing, accessibility contract, interaction, and responsive
behavior. Primitives live in `apps/web-admin/client/src/components/ui/`; app-level
composites live in `apps/web-admin/client/src/components/shared/`.

**Rule (see `00_AI_RULES.md` §3):** always reuse a component from this document.
Never build a page-local equivalent of anything listed here.

Tokens referenced (colors, spacing, radius, shadow, motion, icon sizes) are defined
in `01_DESIGN_SYSTEM.md`.

---

## Button

**File:** `components/ui/button.tsx`
**Purpose:** every clickable action in the app — primary/secondary actions, icon
triggers, links styled as actions.

**Variants:**

| Variant | Style | Use |
|---|---|---|
| `default` | `bg-primary text-primary-foreground shadow-soft hover:bg-primary/80` | Primary action per screen/section (max one visually dominant per view) |
| `outline` | `border-border bg-background hover:bg-muted` | Secondary actions |
| `secondary` | `bg-secondary text-secondary-foreground` | Tertiary actions, toolbar buttons |
| `ghost` | transparent, `hover:bg-muted` | Low-emphasis actions, icon buttons, row actions |
| `destructive` | `bg-destructive/10 text-destructive hover:bg-destructive/20` (tinted, not solid) | Delete/cancel/disable actions |
| `link` | `text-primary underline-offset-4 hover:underline` | Inline text-styled actions |

**Sizes:** `xs` (h-6) / `sm` (h-7) / `default` (h-8) / `lg` (h-9); icon-only:
`icon-xs` (6) / `icon-sm` (7) / `icon` (8) / `icon-lg` (9). Default:
`variant="default" size="default"`.

**States:** hover (variant-specific fill), `focus-visible` (ring, `ring-3
ring-ring/50`), `disabled` (`opacity-50 pointer-events-none`), `aria-invalid`
(destructive ring), pressed (built-in `whileTap: { scale: 0.97 }` — every Button
animates on press automatically, no opt-in needed).

**Spacing:** icon-to-label gap `gap-1.5` (default/lg) or `gap-1` (xs/sm); horizontal
padding `px-2.5`.

**Accessibility:** icon-only buttons (`size="icon*"`) **must** carry an
`aria-label` — there is no visible text to name them. Supports `asChild` (Radix
`Slot`) to render as a `<Link>` while keeping button styling/semantics when the
action is actually navigation.

**Interaction:** press-scale animation is automatic; do not add a second one.

**Responsive:** icon-only sizes are preferred at narrow widths where label text
doesn't fit — the icon column of `DataTable`'s action column uses `icon-sm`.

**Never:** create `PrimaryButton`/`SecondaryButton` wrapper components — use
`variant` directly (see `00_AI_RULES.md`).

---

## Input

**File:** `components/ui/input.tsx`
**Purpose:** single-line text/number/password/etc. entry.

**Variants:** none — one fixed style: `h-8 rounded-lg border border-input
bg-transparent px-2.5 py-1 text-base md:text-sm`. The `text-base`→`md:text-sm` step
is deliberate (prevents iOS auto-zoom on focus below 768px) — do not remove it.

**States:** `focus-visible` (ring), `disabled`, `aria-invalid` (destructive
border+ring).

**Accessibility:** always paired with a `Label` (`components/ui/label.tsx`) via
`htmlFor`/`id`, or an explicit `aria-label` when no visible label fits (rare).

**Responsive:** width is controlled by the parent (`w-full`, `max-w-sm`, `w-36`,
etc.) — `Input` itself has no responsive behavior.

---

## Select

**File:** `components/ui/select.tsx` (Radix `Select`)
**Purpose:** choosing one value from a small, known, static list (status filters,
payment method filters, form dropdowns).

**Variants:** `SelectTrigger` has a `size` prop — `sm` / `default`.

**States:** open/closed, `disabled`, `focus-visible`.

**Accessibility:** Radix handles roving focus, `aria-expanded`, keyboard nav
(arrow keys, type-ahead, `Escape`) natively — do not override.

**Use `Select`, not `Combobox`,** whenever the option list is small and static. See
Combobox below for searchable/large lists.

---

## Combobox — *specified, not yet implemented*

**Purpose:** a searchable, filterable single-select for large or dynamic option
lists (e.g. picking a customer from thousands, picking a product SKU) where a plain
`Select` would be too long to scroll.

**Spec (build this, don't improvise a substitute):** Radix `Popover`
(`components/ui/popover.tsx`) as the container + `cmdk`'s `Command` primitives for
the filterable list, following the same interaction shape as the existing global
`SearchModal` (`Ctrl+K` search) — trigger button styled like a `Select` trigger,
opens a popover with a search `Input` at top and a scrollable, keyboard-navigable
result list below. Selected value renders in the trigger like `Select`. Empty-state
row: "No results found."

**Do not** build a one-off searchable dropdown inline in a page — if a page needs
this, build the shared `Combobox` component first, per this spec, then consume it.

---

## Search (SearchBar)

**File:** `components/shared/SearchBar.tsx`
**Purpose:** the single freestanding text filter on a list page (Catalog, Stock,
Users) — a controlled `Input` with a leading `Search` icon.

```ts
interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Swaps the leading Search icon for a spinning Loader2 — for callers using
   * the search-live pattern (04_CRUD_TEMPLATE.md §Toolbar/Search) that want to
   * show a debounced background refetch in flight. Omit for the default
   * Apply-button flow. */
  loading?: boolean;
}
```

**Spacing/size:** default width `w-full sm:w-64`; icon absolutely positioned
`left-2.5`, input padded `pl-8`.

**Interaction:** no built-in debounce — the caller decides commit-on-keystroke
(simple pages), commit-on-Apply (`FilterBar`'s draft mode, see below), or a
debounced live commit (the "search-live" `FilterBar` sub-mode,
`04_CRUD_TEMPLATE.md` §Toolbar/Search) via the shared `useDebouncedValue` hook
(`hooks/useDebouncedValue.ts`) — `SearchBar` itself stays a plain controlled
input either way.

**Use `SearchBar` only when search is the single freestanding filter.** When search
is one of several structured filter fields in a form (e.g. Orders' filter form), use
a plain labeled `Input` instead — mixing `SearchBar`'s icon-affordance into a
labeled-field group reads inconsistently.

---

## Settings-specific composites

Four composites built specifically for the Settings page's scale (`06_SETTINGS_GUIDELINES.md`
is the authoritative usage doc for all four — this entry is the component-library
reference for their shape/props).

### SettingsSearch

**File:** `components/shared/SettingsSearch.tsx`
**Purpose:** the Settings page's own instant filter — visually close to `SearchBar`
but a separate component: it targets settings sections/fields/gateways (not a
generic row list) and ships a match-highlighting helper `SearchBar` has no
equivalent of.

```ts
interface SettingsSearchProps { value: string; onChange: (value: string) => void; }
export function highlightMatch(text: string, query: string): JSX.Element; // wraps matches in <mark>
export function matchesQuery(haystack: string, query: string): boolean;   // case-insensitive substring
```

No debounce (filters an already-loaded in-memory list, not a network call).
`highlightMatch`'s `<mark>` uses `bg-pine-tint text-ink rounded-xs` — existing
tokens, no new color.

### SettingsNav

**File:** `components/shared/SettingsNav.tsx`
**Purpose:** the Settings jump-nav (`06_SETTINGS_GUIDELINES.md` §1), extended with
scrollspy active-section highlighting and the one collapsible group (Payment
Gateways).

```ts
interface SettingsNavLink { id: string; label: string; icon: LucideIcon; visible: boolean; }
interface SettingsNavGroup { label: string; icon: LucideIcon; links: SettingsNavLink[]; }
interface SettingsNavProps { topLinks: SettingsNavLink[]; group: SettingsNavGroup | null; bottomLinks: SettingsNavLink[]; }
```

`visible` is computed by the caller (only it knows which fields matched a search
query) — the component itself only handles layout, active-section tracking, and
the group's expand/collapse state (persisted to `localStorage`, guarded against
environments where it's unavailable).

### SettingsHealthCard

**File:** `components/shared/SettingsHealthCard.tsx`
**Purpose:** the compact "Configuration Health" summary (`06_SETTINGS_GUIDELINES.md`
brief §5) rendered once, above the search+nav+content grid.

```ts
interface HealthSection { label: string; status: "CONFIGURED" | "NOT_CONFIGURED" | "OPTIONAL" | "ERROR"; }
interface SettingsHealthCardProps { sections: HealthSection[]; }
```

`Card size="sm"` — deliberately compact (one percentage, one `ProgressBar`, one row
of small `StatusBadge`s), never a dashboard-scale summary. `ProgressBar` tone
follows the standard threshold convention (`pct<20` rust / `pct<50` amberx / else
grass).

### SettingsSaveStatus

**File:** `components/shared/SettingsSaveStatus.tsx`
**Purpose:** the page-header save-status pill. See `06_SETTINGS_GUIDELINES.md` §11
for the full precedence rules (Saving… / Unsaved changes / Saved {time} ago / All
changes saved / nothing).

```ts
interface SettingsSaveStatusProps {
  fieldStatuses: Map<string, "editing" | "saving">;
  lastSavedAt: number | null;
}
```

Ticks a local re-render every 15s (via `setInterval`) so the relative-time label
keeps advancing and the decay-to-"All changes saved" threshold fires without
requiring a new save.

---

## Textarea

**File:** `components/ui/textarea.tsx`
**Purpose:** multi-line text entry (cancellation reasons, support notes, product
descriptions).

**Behavior:** `field-sizing-content` — auto-grows to fit content, no manual resize
handle needed. Set `rows` for an initial height hint.

---

## Checkbox

**File:** `components/ui/checkbox.tsx` (Radix `Checkbox`)
**Purpose:** row selection in tables, boolean form fields where a `Switch` isn't
appropriate (e.g. "I agree" style, or a table's select-all/select-row).

**States:** checked / unchecked / indeterminate (select-all-on-page with a partial
selection) / disabled.

**Never** use a native `<input type="checkbox">` for a settings toggle — that's what
`Switch` is for (below). `Checkbox` is for table selection and plain boolean fields,
not toggles.

---

## Radio (RadioGroup)

**File:** `components/ui/radio-group.tsx` (Radix `RadioGroup`)
**Purpose:** choosing exactly one option from a small, always-visible set (2–5
options) where every option should be visible at once, unlike `Select`.

---

## Switch

**File:** `components/ui/switch.tsx` (Radix `Switch`)
**Purpose:** an immediately-effective boolean toggle — payment gateway
enabled/disabled, feature flags. Distinct from `Checkbox`: a `Switch` implies the
change takes effect (often after a confirm dialog), a `Checkbox` implies "selected
as part of a form/selection."

**Sizes:** `sm` / `default`.

**Canonical pairing:** a `Switch` that controls something consequential is wrapped in
a confirm step before the mutation fires — see `SettingsPage.tsx`'s payment-gateway
toggles, which open `SaveConfirmDialog` on `onCheckedChange` rather than mutating
immediately. See `06_SETTINGS_GUIDELINES.md`.

**Never** build a `StatusSwitch` wrapper component — use `Switch` directly (see
`00_AI_RULES.md`).

---

## Tabs

**File:** `components/ui/tabs.tsx` (Radix `Tabs`)
**Purpose:** switching between mutually-exclusive views of the same data without
navigating away (e.g. Orders' status tabs, a detail page's Items/History tabs).

**Variants:** `TabsList` has a `variant` prop — `default` (pill, `bg-muted`
background) or `line` (underline style). Pick per context: `default` for a
prominent top-level view switch, `line` for a lighter-weight in-card tab set.

**Accessibility:** Radix handles `role="tablist"`/`role="tab"`, arrow-key navigation,
and `aria-selected` — do not override.

---

## Card

**File:** `components/ui/card.tsx`
**Purpose:** the primary content-grouping surface — wraps nearly everything (KPI
stats, settings sections, detail-page blocks, list-page summary cards).

**Compound parts:** `Card`, `CardHeader`, `CardTitle`, `CardDescription`,
`CardAction`, `CardContent`, `CardFooter`.

- `Card` base: `rounded-xl border border-border bg-card shadow-soft`, `size` prop
  (`default` / `sm`) drives an internal `--card-spacing` var (16px / 12px padding).
- `CardTitle` accepts an `as` prop (`div`/`h2`/`h3`/`h4`, default `div`) so a real
  heading element can be rendered without changing the visual style — **always pass
  `as="h2"`/`as="h3"` when the card title is structurally a section heading** (screen
  readers rely on this).
- `CardFooter`: `flex items-center rounded-b-xl border-t bg-muted/50
  p-(--card-spacing)` — the standard "footer bar" look for card-level actions.
- Multiple stacked rows inside a card use `divide-y divide-line` on `CardContent`
  (the "card divider" convention) — there is no separate `CardDivider` component.

### Statistic Card

Not a separate component — the pattern `Card > CardHeader > CardTitle` +
`CardContent` with:
- Loading branch: `<p className="text-sm text-ink-soft">Loading…</p>`
- Error branch: `<p className="text-sm text-rust">Couldn't load X.</p>`
- Data branch: big number `font-display text-3xl font-semibold text-ink`, subtext
  `mt-1 text-xs text-ink-soft`, optional `StatTrend` (below) for a day-over-day
  delta.

See `07_DASHBOARD_GUIDELINES.md` for the full KPI card template and dashboard
composition order.

### Setting Card

Also not a separate component — a `Card` whose `CardHeader` holds a `CardTitle` (+
optional inline status label / `Switch`) and whose `CardContent` holds one or more
`FieldRow`-style rows (`divide-y divide-line`). See `06_SETTINGS_GUIDELINES.md` for
the full pattern, grounded in `SettingsPage.tsx`.

---

## Alert

**File:** `components/ui/alert.tsx`
**Purpose:** a persistent, page-level informational or warning message that isn't
tied to a specific field (unlike inline form error text) and isn't transient (unlike
a toast).

**Variants:** `default`, `destructive`. Supports an `AlertAction` slot (top-right)
for an inline action (e.g. "Retry").

**Use `Alert` for:** persistent page-level state ("This gateway is not configured.").
**Use toast for:** transient feedback after an action. **Use inline `text-rust` text
for:** a single field's validation error. Don't conflate the three.

---

## Badge

**File:** `components/ui/badge.tsx`
**Purpose:** small inline labels/counts — not for status (use `StatusBadge` for
that, see below).

**Variants:** `default`, `secondary`, `destructive`, `outline`, `ghost`, `link`.
**Shape:** `h-5`, `rounded-4xl` (pill), fixed size (no `size` prop).

---

## Status Badge

**File:** `components/shared/StatusBadge.tsx` (+ domain-specific siblings
`OrderStatusBadge.tsx`, `PaymentMethodBadge.tsx`)
**Purpose:** the **only** component used for status-like values anywhere in the app
— order status, payment status, stock level, voucher expiry, user ban state, etc.

```tsx
<StatusBadge status={rawStatusString} />
```

Internally maps ~20 known status strings to one of 4 tones (`success` → grass,
`warning` → amberx, `danger` → rust, `neutral` → sand/ink-soft), auto-title-cases
unknown statuses, and falls back to `neutral` for anything not in the map. Includes
the Settings-page configuration vocabulary: `CONFIGURED` (success), `OPTIONAL`
(neutral), `NOT_CONFIGURED` (warning), `ERROR` (danger) — see
`06_SETTINGS_GUIDELINES.md` §7 for how these replace the old "not set" text and the
old combined gateway status label.

**Rule: adding a new status value means adding it to `StatusBadge`'s tone map, never
inventing a new pill.** Two narrow, deliberate exceptions exist (Admins page's "You"
self-tag and its ✓ Pwd/2FA checkmark columns) — these are not `StatusBadge`
candidates because they aren't a "status," they're a boolean identity marker; don't
generalize from them.

`OrderStatusBadge`/`PaymentMethodBadge` exist as richer, domain-specific variants
used specifically on `OrdersPage.tsx` — reach for the generic `StatusBadge` first;
only add a domain-specific badge if a status genuinely needs richer treatment than
the generic tone map provides (and even then, model it after these two).

---

## Progress Bar

**File:** `components/shared/ProgressBar.tsx`
**Purpose:** a thin, colored ratio indicator (e.g. stock available/total).

```ts
type ProgressBarTone = "grass" | "amberx" | "rust";
interface ProgressBarProps { value: number; tone: ProgressBarTone; className?: string; }
```

A 1.5px track (`bg-sand`) with a filled bar clamped to 0–100%. Tone is
caller-computed by threshold — the established pattern (from `StockPage.tsx`) is
`pct < 20 ? "rust" : pct < 50 ? "amberx" : "grass"`. Reuse these exact thresholds for
any new stock/capacity-style progress bar unless there's a specific reason to differ.

---

## Table (primitive)

**File:** `components/ui/table.tsx`
**Purpose:** the raw table primitive underneath `DataTable` (below). Rarely consumed
directly by pages — `DataTable` is the page-level API.

**Built-in behavior:** row hover (`hover:bg-muted/50`, on by default, no opt-in),
automatic horizontal scroll wrapper (`overflow-x-auto`), checkbox-column padding
fix (`[&:has([role=checkbox])]:pr-0`). Sticky header is **not** built into this
primitive — it's a `DataTable`-level opt-in (see `05_TABLE_GUIDELINES.md`).

**Never** build a page with a raw `<table>` element — always go through `DataTable`.
`components/dashboard/RecentOrdersTable.tsx` currently violates this and is
documented tech debt, not a pattern to extend.

---

## Pagination

**File:** `components/shared/Pagination.tsx`
**Purpose:** numbered-page-window navigation for server-paginated lists.

```ts
interface PaginationProps {
  page: number;                 // 1-indexed
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;  // omit to hide the page-size selector
  pageSizeOptions?: number[];                 // default [20, 50, 100]
}
```

Windowing: first, last, and current±2, with an ellipsis for gaps (e.g. `1 … 5 6 [7]
8 9 … 20`). Layout: left — "Showing {start}–{end} of {total}" (or "No results");
center — Prev/numbers/Next; right (optional) — page-size `Select`. Active page uses
`variant="default"` + `aria-current="page"`; all pagination buttons carry a
`min-h-[44px] min-w-[44px]` tap-target class layered over the smaller visual
`size="sm"`/`icon-sm` button size, for touch accessibility.

Full details, including the two adoption tiers (server-paginated vs. client-only
pages), are in `05_TABLE_GUIDELINES.md`.

---

## Tooltip

**File:** `components/ui/tooltip.tsx` (Radix `Tooltip`)
**Purpose:** a short label for an icon-only control or truncated text, shown on
hover/focus.

**Note:** `delayDuration` is set to `0` app-wide (instant, non-standard default) —
tooltips here appear immediately, not after the usual ~700ms hover delay. Don't
override this per-instance without reason.

**Use for:** clarifying an icon-only button's purpose beyond its `aria-label`,
showing a full value that's visually truncated. **Don't use for:** anything the user
needs to read reliably (tooltips are dismissed on mouse-away and are not reliably
reachable on touch) — put that in visible text instead.

---

## Popover

**File:** `components/ui/popover.tsx` (Radix `Popover`)
**Purpose:** a floating panel anchored to a trigger, for richer content than a
tooltip (a mini-form, the future `Combobox`'s option list). Adds `PopoverHeader`,
`PopoverTitle`, `PopoverDescription` beyond stock shadcn.

---

## Dropdown (DropdownMenu)

**File:** `components/ui/dropdown-menu.tsx` (Radix `DropdownMenu`)
**Purpose:** a menu of discrete actions triggered by a button — the row-actions
"context menu" pattern (see `05_TABLE_GUIDELINES.md`), the TopBar user menu's
underlying primitive family (TopBar itself uses hand-rolled `framer-motion` panels,
not this component, for its own two menus — see `02_ADMIN_LAYOUT.md` §3).

**Variants:** `DropdownMenuItem` supports `variant="destructive"` for
destructive actions within the menu (e.g. "Cancel Order").

**Interaction:** always wrap the trigger's containing element with
`onClick={(e) => e.stopPropagation()}` when the menu lives inside a clickable table
row, so opening the menu doesn't also trigger the row's own click handler.

---

## Drawer — *specified, not yet implemented*

**Purpose:** a slide-in-from-the-edge panel for tasks that need more room than a
`Dialog` but shouldn't take over the whole viewport — e.g. a detail preview
alongside a list, or a longer secondary form.

**No `sheet.tsx`/Drawer exists in the codebase today.** Spec, when one is needed:
build on the Radix `Dialog` primitive already in `components/ui/dialog.tsx`, but
render the content panel with a slide-in transform from the right edge
(`translate-x-full` → `translate-x-0`, `DURATION.base` from `01_DESIGN_SYSTEM.md`
§8) instead of `Dialog`'s centered-panel style, keeping the same overlay/backdrop,
`showCloseButton` footer convention, and focus-trap behavior `Dialog` already
provides via Radix. Sizes: `default` (~400px wide) / `lg` (~560px wide).

**Decision: Drawer vs. Dialog vs. full page** — see `08_UX_RULES.md` §Drawer Usage.

**Do not** build a one-off slide-in panel inline in a single page — build the shared
`Drawer` component to this spec first.

---

## Dialog / Modal

**File:** `components/ui/dialog.tsx` (Radix `Dialog`)
**Purpose:** a focused, blocking task — confirmations with extra input (e.g. cancel
order with a required reason), a bulk-edit form, a settings save-confirmation.
"Dialog" and "Modal" refer to the same component in this app — use `Dialog`.

**Variants:** `DialogContent` has a `size` prop (`default` / `sm`).

**Footer convention:** `DialogFooter` is styled as a distinct bottom bar (`-mx-4
-mb-4 bg-muted/50 border-t`, not just a plain flex row) and accepts a
`showCloseButton` prop that auto-renders a "Close" button — use it instead of
hand-rolling a cancel button when a dialog is purely dismissible.

**Two purpose-built composites on top of `Dialog`:**
- **`ConfirmDialog`** (`components/shared/ConfirmDialog.tsx`) — the general
  destructive-confirmation wrapper. Supports both trigger-driven and fully-controlled
  (`open`/`onOpenChange`) usage; defaults to `variant="destructive"`. **Always** use
  this instead of `window.confirm()`.
- **`SaveConfirmDialog`** (`components/shared/SaveConfirmDialog.tsx`) — the
  Settings-flavored confirm used before any live-setting mutation, including a
  success checkmark-pop animation on completion. See `06_SETTINGS_GUIDELINES.md`.

**AlertDialog** (`components/ui/alert-dialog.tsx`) is the Radix `AlertDialog`
primitive underneath `ConfirmDialog`; adds an `AlertDialogMedia` icon-badge slot and
a `size` prop on `AlertDialogContent`. Prefer `ConfirmDialog` over consuming
`AlertDialog` directly unless building a new confirm-style composite.

---

## Toast

**File:** `components/ui/sonner.tsx` (wraps `sonner`)
**Purpose:** transient success/error/info feedback after an action.

**Config:** `theme="light"` (hardcoded — matches the light-only app, see
`01_DESIGN_SYSTEM.md` §12), custom Lucide icon per type (`success` → `CircleCheck`,
`info` → `Info`, `warning` → `TriangleAlert`, `error` → `OctagonX`, `loading` →
spinning `Loader2`), styled with the app's `--card`/`--card-foreground`/`--border`
tokens and `shadow-lift`.

**Usage pattern (the standard to follow):**
```ts
onSuccess: () => { invalidateAll(); toast.success("Order approved and delivered."); }
onError:   (e: Error) => toast.error(describeError(e.message)),
```
- Always route errors through `describeError()` (`src/lib/errorMessages.ts`) rather
  than showing `e.message` raw — it humanizes server error codes.
- `toast.error()` also doubles as the feedback channel for client-side validation
  failures caught *before* a mutation fires (e.g. "A cancellation reason is
  required.") — not just mutation results.
- Bulk actions report a single combined message (`"{n} succeeded, {m} failed."`), not
  separate toasts per outcome.

**Status:** `toast` is the **prescribed standard** for every mutation's
success/error feedback going forward. Today only `OrdersPage.tsx` fully follows it;
other pages fall back to inline `text-rust` error text with no success feedback at
all — that's documented tech debt (`00_AI_RULES.md` §8), not a second valid pattern.
New and touched pages should use toast.

---

## Skeleton

**File:** `components/ui/skeleton.tsx`
**Purpose:** loading placeholder shaped like the content it's replacing.
**Style:** `animate-pulse bg-muted`.
**Table use:** `components/shared/SkeletonRow.tsx` renders a full `TableRow` of
`Skeleton`s (one per column) — consumed internally by `DataTable`'s `isLoading`
state, not typically imported directly by pages. See `08_UX_RULES.md` for when to
use a skeleton vs. a spinner.

---

## Empty State

**File:** `components/shared/EmptyState.tsx`
**Purpose:** what a list/table shows when there's no data — either genuinely empty,
or empty due to active filters.

```tsx
<EmptyState
  icon={ShoppingCart}
  title="No orders found."
  description="Try adjusting your filters, or check back once new orders arrive."
  action={{ label: "Refresh", onClick: ... }}
  secondaryAction={{ label: "Clear Filters", onClick: ... }}
/>
```

**Copy convention:** bold, specific headline + an actionable subline — never generic
filter-assuming copy for a genuinely-empty (no filters applied) state. "No products
yet." / "Add your first product to start selling." is the model; a first-run empty
state should offer a primary action (e.g. "+ Add Product"), while a
filtered-to-empty state should offer "Clear Filters"/"Refresh" instead.

---

## Avatar

**File:** `components/ui/avatar.tsx` (Radix `Avatar`)
**Purpose:** user/account representation — the TopBar user menu's initials circle is
the primary live example.

**Sizes:** `sm` / `default` / `lg`. **Extensions beyond stock shadcn:**
`AvatarBadge` (small status dot, e.g. online/offline), `AvatarGroup` +
`AvatarGroupCount` (overlapping stack with a "+N" overflow indicator) — use these
instead of hand-rolling an overlapping-avatar layout.

---

## Breadcrumb

Not a standalone component — implemented as `PageHeader`'s optional `breadcrumb`
prop (see `02_ADMIN_LAYOUT.md` §5). Use it for pages reached via a clear hierarchy
(Catalog → Product → Denomination); never pair it with a redundant separate back
button.

---

## Navbar / Sidebar / Topbar

Covered in full in `02_ADMIN_LAYOUT.md` §§2–3 — the shell components (`Sidebar`,
`TopBar`) are singular, shell-owned, and never duplicated per-page.

---

## Loading Spinner

There is no dedicated spinner component — the app prefers **skeletons** for
anything with a knowable shape (tables, cards, KPI values — see Skeleton above) and
reserves an inline spinning icon (`Loader2` from Lucide, `animate-spin`) for small,
in-place indicators where a skeleton doesn't apply — e.g. a button's own pending
state ("Creating…" with a spinning icon), or the toast `loading` type's icon. Do not
introduce a full-page spinner for initial page loads — use a skeleton shaped like
the eventual content instead (see `08_UX_RULES.md`).

---

## Charts

**Library:** `recharts` (the only charting library in the app — do not add a second
one). Live example: `components/dashboard/SalesAnalyticsCard.tsx`.

**Rules:**
- Chart colors always come from the design tokens (`var(--color-grass)`,
  `var(--color-pine)`, `var(--color-amberx)`, `var(--color-rust)`, `var(--color-
  line)` for gridlines/axes) — never a hardcoded hex or `recharts`' default palette.
- A chart is always paired with a caption or surrounding context (a `CardTitle`, a
  summary number, a time-range label) — never rendered as a bare, unlabeled chart.
  See `07_DASHBOARD_GUIDELINES.md`.
- Tooltips on hover use the app's `Popover`/tooltip surface styling (`bg-card`,
  `border-line`, `shadow-lift`), not `recharts`' default tooltip box.
- Prefer simple chart types (line, bar, area) that read at a glance over dense
  multi-series visualizations — the dashboard's job is "what happened," not deep
  analysis (see `07_DASHBOARD_GUIDELINES.md`).
