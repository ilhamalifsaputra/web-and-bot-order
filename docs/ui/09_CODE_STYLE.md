# 09 — Code Style

**Scope:** how admin-client code is organized and written — folder structure,
naming, composition, state management, CSS strategy, and animation strategy.
Grounded in the actual structure of `apps/web-admin/client/src`.

---

## 1. Folder structure

```
apps/web-admin/client/src/
├── components/
│   ├── ui/            shadcn/Radix primitives (Button, Dialog, Table, Select, ...)
│   ├── shared/         app-level composites built on ui/ (DataTable, PageHeader,
│   │                    FilterBar, StatusBadge, ConfirmDialog, Pagination, ...)
│   ├── dashboard/       dashboard-only composites (KpiRow, OrdersKpiCard,
│   │                    OperationCenter, SalesAnalyticsCard, ...)
│   └── layout/         the shell (AppShell, Sidebar, TopBar)
├── pages/               one file per route (OrdersPage.tsx, StockPage.tsx, ...),
│                        plus create/edit/detail variants as separate files
│                        (ProductCreatePage.tsx, DenominationEditPage.tsx,
│                        OrderDetailPage.tsx)
├── hooks/               data-fetching hooks (useDashboardKpis, useInventory,
│                        useOperations, useAdmins, ...) — one per query/domain
├── lib/                 non-component utilities (utils.ts/cn(), motion.ts,
│                        errorMessages.ts, additionalFields.ts)
└── api/                 client.ts — the fetch wrapper (apiPost, etc.)
```

**Where a new file goes:**
- A generic, app-wide, reusable primitive with no domain knowledge → `components/
  ui/` (rare to add — most needs are already covered by shadcn primitives already
  present).
- A reusable piece with light domain awareness, used across ≥2 pages/features →
  `components/shared/`.
- A component only ever used on the dashboard → `components/dashboard/`.
- A component only ever used within one page and not reused elsewhere → colocate it
  as a local component inside that page's file (see `CategoryEditDialog` inside
  `CatalogPage.tsx`) rather than creating a new file for a one-off.
- A new route → `pages/`, named `<Noun><Verb?>Page.tsx` (§2).
- A new data-fetching concern → `hooks/`, named `use<Noun>.ts`.

## 2. Naming conventions

- **Components/files**: `PascalCase.tsx`, matching the exported component name
  exactly (`StatusBadge.tsx` exports `StatusBadge`).
- **Pages**: `<Noun><Optional Verb>Page.tsx` — `OrdersPage.tsx` (list),
  `ProductCreatePage.tsx` (create), `DenominationEditPage.tsx` (edit),
  `OrderDetailPage.tsx` (detail). Follow this suffix convention exactly so a new
  page's purpose is legible from its filename alone.
- **Hooks**: `use<Noun>.ts`, exporting a single primary hook of the same name
  (`useDashboardKpis.ts` exports `useDashboardKpis`).
- **Test files**: colocated, `<SameName>.test.tsx`/`.test.ts` next to the file under
  test — every shared component and page has one.
- **Props interfaces**: `<ComponentName>Props`.
- **cva variant maps**: `<componentName>Variants` (e.g. `alertVariants`,
  `badgeVariants`, `tabsListVariants`).

## 3. Composition patterns

- **Compound components** for anything with a fixed internal structure —
  `Card`/`CardHeader`/`CardTitle`/`CardContent`/`CardFooter`,
  `Dialog`/`DialogHeader`/`DialogTitle`/`DialogFooter`,
  `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableCell`. When adding a new
  composite with multiple fixed sub-parts, follow this same pattern rather than a
  single component with many boolean/render props.
- **`asChild` (Radix `Slot`)** where a component's semantics need to attach to a
  different underlying element — e.g. a `Button` that's actually a `<Link>`. Use it
  instead of duplicating the styling classes onto the other element by hand.
- **Render props for table cells**: `DataTable`'s `Column.render(row)` is the
  established shape for "customize this one cell's content" — follow it for any
  similar per-row customization need rather than inventing a different callback
  shape.
- **Small, composable variant props** over new components: `Card`'s `size` prop,
  `Button`'s `variant`/`size`, `TabsList`'s `variant` — extend an existing
  component's `cva` variants when a new visual flavor is needed, rather than
  creating `CardCompact`/`SmallButton`/etc.

## 4. State management

Two, and only two, places state lives:

- **Server state** (anything that comes from the API) → **TanStack Query**
  (`useQuery`/`useMutation`), one hook per concern in `hooks/`. Invalidate the
  relevant query key(s) after a successful mutation
  (`queryClient.invalidateQueries(...)`) rather than manually patching cached data,
  unless there's a specific optimistic-update need.
- **Local UI/form state** (draft filter values, dialog open/closed, form field
  values, selection sets) → plain `useState` in the component that owns it.

There is **no global client-state library** (no Redux/Zustand/Jotai/Context-as-
global-store) in this app. Don't introduce one for a single feature's state — if
state genuinely needs to be shared across distant components, prefer lifting it to
the nearest common ancestor or deriving it from a shared React Query cache entry
over adding a new state-management dependency.

## 5. Design tokens in code

- Reference tokens only via their Tailwind utility (`bg-pine`, `text-ink-soft`,
  `rounded-xl`, `shadow-soft`) or, where a raw CSS var is genuinely needed (e.g.
  inside a `recharts` `stroke`/`fill` prop), `var(--color-pine)` etc. — never a
  hardcoded hex, rem, or px value for anything covered by `01_DESIGN_SYSTEM.md`.
- If a value you need isn't a token yet, that's a signal to re-check the token
  tables, not to freehand a value — see `00_AI_RULES.md` §5.

## 6. CSS strategy

- **Tailwind v4, CSS-first.** All theme configuration lives in `@theme` blocks in
  `apps/web-admin/client/src/index.css` — there is no `tailwind.config.*` file and
  none should be added; new tokens are added as new CSS custom properties inside the
  existing `@theme static` block, following the naming convention already used there
  (`--color-<name>`, `--shadow-<name>`, `--radius-<name>`).
- **`cva` (`class-variance-authority`)** for every component with a `variant`/`size`
  axis — follow the existing pattern in `button.tsx`/`badge.tsx`/`alert.tsx`
  (a `cva()` call exporting `<name>Variants`, consumed by the component and
  optionally exported for reuse).
- **`cn()`** (`lib/utils.ts`, wrapping `tailwind-merge` + `clsx`) for combining
  conditional class strings — always use it instead of manual string
  concatenation/template literals when a className is conditional, so conflicting
  Tailwind classes resolve correctly (last-wins on the same property).
- No CSS-in-JS, no CSS Modules, no separate `.css` files per component — Tailwind
  utility classes directly in JSX is the only styling mechanism, aside from the
  handful of custom keyframes/utilities declared once in `index.css`.

## 7. Animation strategy

- **`framer-motion`** for interactive/state-driven animation (press feedback,
  dropdown panels, page transitions, staggered lists) — reuse the shared variants
  and constants from `lib/motion.ts` (`EASE`, `DURATION`, `fadeUp`, `fadeIn`,
  `staggerContainer`, `staggerItem`, `pressable`). Never define a new easing curve
  or duration constant inline in a component — add it to `lib/motion.ts` if a
  genuinely new one is needed, so it's available for reuse.
- **Tailwind/CSS keyframes** (`tw-animate-css`, the one custom
  `--animate-checkmark-pop`) for simple, non-interactive animations that don't need
  JS-driven state.
- Every custom animation is `motion-safe:`-gated (see `08_UX_RULES.md` §16).

## 8. Reusable components — don't duplicate

Before writing a new component, check `components/ui/` and `components/shared/` for
something that already does the job (`03_COMPONENT_LIBRARY.md` is the indexed
catalog). If two components in the repo end up doing nearly the same thing, that's a
bug to consolidate, not a precedent for a third. See `00_AI_RULES.md` §3 for the
specific list of components that must never be re-implemented locally
(`Button`/`DataTable`/`Switch`/`StatusBadge`/`ConfirmDialog`).

## 9. Verification before considering a change done

Per the root `CLAUDE.md`'s fast-workflow conventions, scoped to this client:
`pnpm --filter @app/web-admin-client build` (required after any change under
`apps/web-admin/client/`, since the built SPA output is gitignored and served
directly), plus the repo-wide `pnpm typecheck` and `pnpm test` before calling a UI
change complete — see `10_UI_REVIEW_CHECKLIST.md` for the full pre-merge checklist.
