# 08 — UX Rules

**Scope:** interaction and feedback rules that apply across every surface — loading,
empty/error states, confirmations, validation, accessibility, motion, and layout
behavior not already covered structurally in `02_ADMIN_LAYOUT.md`. Components
referenced are defined in `03_COMPONENT_LIBRARY.md`; tokens in
`01_DESIGN_SYSTEM.md`.

---

## 1. Loading

- **Prefer skeletons over spinners** whenever the eventual content's shape is
  knowable in advance — a table (`SkeletonRow` × N via `DataTable`'s `isLoading`),
  a KPI card (its own `Loading…` text branch, §KPI card in
  `07_DASHBOARD_GUIDELINES.md`).
- **Never a full-page spinner** for a page's initial load — render the page shell
  (`PageHeader`, etc.) immediately and let the content area show its own
  skeleton/loading branch.
- **Inline spinners** (`Loader2`, `animate-spin`) are reserved for small, in-place
  indicators where a skeleton doesn't apply — a submit button's own pending label
  ("Creating…" with a spinning icon), the toast `loading` type.
- Loading state never blocks the rest of the page from being usable unless the data
  being loaded is a hard prerequisite for everything else on the page.

## 2. Empty state

Always `EmptyState` (`03_COMPONENT_LIBRARY.md` §Empty State): bold headline + a
specific, actionable subline. Genuinely-empty (no filters applied) states offer the
page's primary create action; filtered-to-empty states offer "Clear Filters"/
"Refresh" instead. Never generic copy that assumes filters are the cause when they
aren't, or vice versa.

## 3. Error state

Two levels:
- **Whole-page load failure** (`isError` from the primary query): short-circuit the
  page body with `<p className="text-rust">Failed to load {noun}.</p>` inside the
  still-rendered `PageLayout` — see `04_CRUD_TEMPLATE.md` §Error State.
- **Mutation failure**: `toast.error(describeError(e.message))` (see §6 below) or,
  on pages not yet migrated to toast, a local `error` state rendered as
  `text-sm text-rust` near the action that failed.

Never swallow an error silently — every failed query/mutation must surface
*something* to the admin.

## 4. Confirmation dialogs

- **Destructive or consequential actions** (cancel an order, disable a payment
  gateway, delete something) always confirm first via `ConfirmDialog`
  (general-purpose) or `SaveConfirmDialog` (settings-flavored, with a
  checkmark-pop success animation) — never `window.confirm()`.
- The confirm dialog's description states the **real-world consequence**, not just
  "are you sure?" — e.g. "Customers will no longer be able to pay with this
  gateway." This is what makes the confirm step actually useful rather than
  friction for its own sake.
- Confirm dialogs that gate a mutation whose completion also flips the triggering
  UI's own state (e.g. an editable field's `editing` flag) must be **mounted
  unconditionally**, with only their `open` prop gated — conditionally rendering the
  dialog itself risks unmounting it mid-success-animation the instant the mutation
  resolves (see `06_SETTINGS_GUIDELINES.md` §3 for the exact case this prevents).

## 5. Undo — *specified, not yet implemented*

No undo pattern exists in the app today. Where a future action would benefit from
undo instead of (or in addition to) a confirm dialog — e.g. a reversible bulk
status change — the spec is: a `toast` with an inline **action button** ("Undo"),
following `sonner`'s built-in action-button support, shown for a few seconds after
the mutation succeeds, rather than a pre-action confirm dialog. Use this for actions
that are cheap to reverse and where a confirm-before dialog would slow down a
common, low-risk workflow; keep `ConfirmDialog`/`SaveConfirmDialog` for anything
expensive or impossible to reverse.

## 6. Success feedback (toast)

`toast.success(...)` (via `sonner`, `03_COMPONENT_LIBRARY.md` §Toast) paired with a
`queryClient.invalidateQueries()` call is the **prescribed standard** for
communicating a successful mutation, going forward, on every page. Errors always
route through `describeError()` rather than a raw server message. This is not yet
universally adopted (`00_AI_RULES.md` §8) — new and touched pages should follow it
regardless of what a neighboring older page currently does.

## 7. Validation

Manual `useState` + a derived `canSubmit` boolean gating the submit button's
`disabled` state — see `04_CRUD_TEMPLATE.md` §4. Field-level errors, where shown
inline rather than blocking submission, use `text-sm text-rust` directly under the
field. There is no schema-validation library in this app; don't introduce one on a
single form.

## 8. Accessibility

- **ARIA**: rely on Radix's built-in ARIA wiring for every primitive (`Dialog`,
  `DropdownMenu`, `Select`, `Tabs`, `Switch`, `Checkbox`, `Popover`, `Tooltip`) —
  don't strip or override roles/attributes it sets.
- **Icon-only controls** must always carry an explicit `aria-label` — this must hold
  at every breakpoint, including ones where an icon-only button replaces a
  label+icon button on narrow screens (a control that has a visible label on
  desktop but loses it below `sm` still needs the label as `aria-label`).
- **Keyboard navigation**: `Tab`/`Shift+Tab` moves focus in visual order; `Escape`
  closes any open `Dialog`/`Popover`/`DropdownMenu`/`Select`; arrow keys navigate
  within `Select`/`Tabs`/`DropdownMenu` (Radix default — don't override); `Ctrl+K`/
  `Cmd+K` opens global search from anywhere in the app.
- **Focus visibility**: every interactive element shows a visible focus ring
  (`focus-visible:ring-3 focus-visible:ring-ring/50`, built into `Button`/`Input`/
  form controls) — never remove `focus-visible` styling to "clean up" a control's
  look.
- **Tab order**: follows DOM order, which must follow visual order — don't use
  `tabIndex` to reorder focus around a CSS-only visual rearrangement.
- **Color contrast**: text must meet WCAG AA (4.5:1 for normal text). `ink-faint`
  was deliberately darkened from an earlier, failing value specifically to meet this
  bar (`01_DESIGN_SYSTEM.md` §3.2) — never introduce a new "faint" text color
  without checking its contrast against the background it's used on.
- **Semantic headings**: use `CardTitle`'s `as="h2"`/`as="h3"` (or a real
  `<h1>`/`<h2>`) for anything that is structurally a section heading — a styled
  `<div>`/`<span>` that merely *looks* like a heading breaks screen-reader
  navigation.
- **Screen reader / labeling**: every `Input` pairs with a `Label` via `htmlFor`/
  `id`, or an `aria-label` when no visible label fits.
- **Reduced motion**: every custom (non-utility) animation is `motion-safe:`-gated
  (see §10 below).

## 9. Minimum touch target

Interactive controls meant to be tapped (not just clicked) target **44×44px**
minimum — `Pagination`'s buttons apply a `min-h-[44px] min-w-[44px]` class layered
on top of their smaller visual `size="sm"`/`size="icon-sm"` styling specifically for
this reason. Apply the same layered approach (visually compact `Button` size + a
minimum tap-target wrapper/class) for any other small, frequently-tapped control on
a page expected to see mobile/tablet use.

## 10. Scroll behavior

- Page-level scrolling happens inside `AppShell`'s `<main>` — the sidebar and
  topbar never scroll with the content (see `02_ADMIN_LAYOUT.md` §1).
- Tables scroll horizontally within their own `overflow-x-auto` wrapper rather than
  causing the whole page to scroll horizontally.
- Anchor-jump targets (e.g. Settings' section `Card`s) carry `scroll-mt-20` so a
  jump doesn't hide the target under a sticky header/nav.

## 11. Sticky elements

Three sticky patterns exist, each for a specific reason — don't invent a fourth
without one:
- **Sticky table header** (`DataTable`'s `stickyHeader`) — keeps column labels
  visible while scrolling a long table.
- **Sticky bulk-action bar** (`sticky bottom-4`, `shadow-lift`) — keeps the bulk
  toolbar reachable without scrolling back up after selecting rows deep in a long
  list.
- **Sticky Settings jump-nav** (`sticky top-0`/`top-4`) — keeps section navigation
  reachable while scrolling a long settings page.

`TopBar` is also sticky (`sticky top-0`) as part of the shell itself, not a
page-level pattern.

## 12. Drawer usage

Drawer is specified but not yet implemented (`03_COMPONENT_LIBRARY.md` §Drawer).
When deciding what a new secondary-content need should use:

| Need | Use |
|---|---|
| A short confirmation, or a form with ≤4 fields, focused and blocking | `Dialog` |
| A longer form or a detail preview that benefits from staying anchored to an edge while the list behind it is still visible/scrollable | `Drawer` (build to spec) |
| A genuinely primary, multi-field flow (create Product, create Denomination) | Full page |

Don't reach for a `Drawer` just because a `Dialog` "feels small" — most of this
app's forms are short enough that `Dialog` (or a full page, for primary entities) is
correct; build and use `Drawer` only when the content genuinely needs to coexist
with what's behind it.

## 13. Modal (Dialog) usage

- `Dialog` is for a focused, blocking task — see `03_COMPONENT_LIBRARY.md` §Dialog.
- Use `DialogFooter`'s `showCloseButton` for purely dismissible dialogs; hand-roll
  a Cancel + primary action pair in the footer for anything that mutates.
- Every `Dialog` traps focus and closes on `Escape`/overlay click (Radix default) —
  don't override this.
- Don't stack a `Dialog` on top of another `Dialog` — resolve or cancel the first
  before opening a second.

## 14. Hover

The default, app-wide hover treatment for interactive rows/items is `hover:bg-
muted/50` (table rows, sidebar nav items use a slightly stronger `hover:bg-sand`
variant intentionally, since they're navigation rather than data rows). Don't invent
a new hover treatment (a border, a shadow, a scale) for a new interactive row/list
item — match whichever of these two existing treatments the new element is closer to
in role.

## 15. Animation & transitions

Covered in full in `01_DESIGN_SYSTEM.md` §8. Summary of the rules that matter most
day-to-day:
- Reuse `lib/motion.ts`'s shared variants (`fadeUp`, `fadeIn`, `staggerContainer`,
  `staggerItem`) and constants (`EASE`, `DURATION`) — never define a new easing
  curve or duration per component.
- `Button`'s tap-scale press animation is automatic — don't add a second one.
- Page transitions (`PageTransition`, wrapping every route's `<Outlet/>`) and each
  route's fresh `ErrorBoundary` are shell-level, not something a page opts into.
- Animation exists to communicate a state change, never as pure decoration.

## 16. Reduced motion

Any custom keyframe animation (e.g. `--animate-checkmark-pop`) must be applied with
the `motion-safe:` Tailwind variant so it's suppressed for users with
`prefers-reduced-motion: reduce`. `framer-motion`'s built-in transitions (page
transitions, dropdown fade-ins, the button tap-scale) should similarly respect this
preference where the library supports it — don't add a new large-motion effect
without checking it degrades gracefully.

## 17. Responsive rules

Structural responsive behavior (sidebar, topbar, content padding, table→card-stack)
is covered in `02_ADMIN_LAYOUT.md` §6 and `05_TABLE_GUIDELINES.md` §3. General rule:
every new page/component must be checked at mobile (<640px), tablet (640–1023px),
and desktop (≥1024px) widths before being considered done — see the review checklist
in `10_UI_REVIEW_CHECKLIST.md`.

## 18. Progressive disclosure

Two established patterns, both real:
- **Settings' jump-nav + flat cards** (`06_SETTINGS_GUIDELINES.md` §1) — content is
  organized so the admin's attention expands to one section at a time via
  scroll/jump, not via expand/collapse.
- **Inline "create related entity" sub-flow** — e.g. `ProductCreatePage.tsx`'s
  Category `Select` swapping to an inline mini-form when "+ New category" is chosen,
  rather than opening a separate dialog or navigating away. Use this shape (swap the
  control in place, with its own Confirm/Cancel) when a form needs to let the admin
  create a small, related entity without leaving the current form.

Both exist specifically to avoid showing every possible input at once — apply the
same instinct (reveal detail on demand, in place, rather than navigating away or
using an accordion) to new forms/pages with a similar shape.

## 19. Information hierarchy

- **Page** → **Section** (`CardTitle`/`text-sm font-semibold` sub-header) →
  **Field/row** (`text-sm`/`text-xs`, `ink`/`ink-soft`/`ink-faint` per emphasis
  level) — never skip a level (e.g. a page with no section headers dumping every
  field into one flat list once the field count is more than a handful).
- The most important number/status on a card or page is always the visually
  largest and highest-contrast element (`font-display text-2xl`/`text-3xl`,
  `text-ink`); supporting detail is smaller and `text-ink-soft`/`text-ink-faint`.
- A dashboard orders sections by the three-question priority in
  `07_DASHBOARD_GUIDELINES.md` §1; a CRUD page orders sections by the fixed
  hierarchy in `02_ADMIN_LAYOUT.md` §4. Don't reorder either without a documented,
  strong reason.
