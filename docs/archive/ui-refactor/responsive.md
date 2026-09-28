# Responsive Findings

Tested viewports: **Desktop** 1440×900 (full crawl of every route),
**Tablet** 768×1024 (Dashboard incl. drawer-open state, Orders),
**Mobile** 375×812 (Dashboard, Orders, Catalog, Stock, Settings, Product
Detail, and the topbar's nav-closed state specifically).

The app is built with Tailwind's default breakpoints; the sidebar's own
source (`Sidebar.tsx`) confirms the collapse happens at `lg` (1024px):
`hidden w-56 flex-shrink-0 lg:block` for the static desktop sidebar, and a
`fixed ... lg:hidden` off-canvas drawer version for anything narrower.

## Desktop (1440×900)

No layout issues observed across the full crawl (every route in `App.tsx`
except Order Detail / Ticket Detail, which had no data to open — see
`overview.md` coverage-gap note). Screenshots: all `*-desktop*.png` files
under `screenshots/`.

## Tablet (768×1024)

- **Sidebar correctly collapses** to an off-canvas drawer below the `lg`
  (1024px) breakpoint — at 768px the static sidebar disappears and a
  hamburger ("Open navigation") button appears in the topbar instead.
  Confirmed both closed (`screenshots/dashboard-tablet.png`) and open
  (`screenshots/dashboard-tablet-drawer-open.png`) states — the drawer opens
  as an overlay with a backdrop, and items are all reachable/tappable.
- **Orders table** (`screenshots/orders-list-tablet.png`) renders without
  visibly breaking layout — column set is the same as desktop (Code,
  Customer, Status, Total, Payment Method, Date, actions). No populated-row
  data was available to check whether 7 columns stay comfortably readable at
  768px with real content (this DB has zero orders) — **flag as a coverage
  gap for phase 2**: re-check with seeded order rows whether the table needs
  horizontal scroll or column trimming at tablet width once real data exists.
- No dashboard KPI card overflow or clipping observed at 768px.

## Mobile (375×812)

- **No page-level horizontal overflow detected** on any tested page.
  Confirmed programmatically on Orders:
  `document.documentElement.scrollWidth === document.documentElement.clientWidth === 375`.
  This means any wide tables are (at minimum) not breaking the outer page
  layout — they likely scroll internally, though again this DB has no
  populated Orders/Stock rows with long real-world values (long product
  names, long customer names) to stress-test at 375px. **Flag as a coverage
  gap**: re-verify table internal horizontal scroll behavior with realistic
  (long) string content once seeded data exists in phase 2.
- **Dashboard** (`screenshots/dashboard-mobile.png`): KPI cards stack to a
  single column correctly; Operation Center tiles, Critical Stock, Sales
  Analytics chart, and Business Health list all reflow to full-width without
  clipping.
- **Sales Analytics chart** on mobile drops one x-axis date label
  (`07-13`) that is present at desktop width — see Finding F-018 in
  `findings.md`; flagged as needing verification against the charting
  library's own responsive tick behavior before treating as a bug.
- **TopBar at mobile width** (`screenshots/dashboard-mobile-nav-closed.png`):
  the "Search..." text label and "Ctrl+K" kbd hint are both hidden (Tailwind
  `hidden sm:inline` / `sm:inline-block`), leaving an icon-only search
  button. This is both a **discoverability** regression (sighted mobile users
  lose the "this is search, and there's a shortcut" affordance) and an
  **accessibility** regression (the button has no `aria-label`, so it also
  loses its accessible name for screen readers at this width) — see Finding
  F-009 in `findings.md` and `accessibility.md`.
- **Settings** (`screenshots/settings-mobile.png`): the already-long
  single-column scroll (F-012) is proportionally worse on mobile — same
  content, taller effective scroll distance relative to viewport height. No
  new mobile-specific breakage beyond the general layout issue already
  flagged at desktop.
- **Catalog / Stock / Product Detail on mobile**
  (`screenshots/catalog-list-mobile.png`, `screenshots/stock-list-mobile.png`,
  `screenshots/product-detail-mobile.png`): all reflow to single-column
  card-like presentation without clipping or overflow in the (single-row)
  data available.
- **Sidebar drawer on mobile**: not separately screenshotted open (tablet's
  open-drawer screenshot covers the same underlying component/breakpoint
  behavior below `lg`), but the same hamburger control was present and
  functional in the mobile nav-closed screenshot.

## Coverage gaps to close in phase 2

1. Re-test Orders/Stock/Payments/Reviews/Support tables at tablet and mobile
   width **with realistic populated + long-string data** (this audit's DB
   only ever had 0-1 rows per table) to confirm horizontal-scroll containment
   holds up, not just page-level non-overflow.
2. Re-verify the Sales Analytics chart's x-axis label-thinning behavior
   (F-018) is intentional library behavior, not a bug.
3. No laptop-width (e.g. ~1280px) breakpoint was separately tested — only
   1440 (desktop), 768 (tablet), 375 (mobile) per the audit brief's exact
   three viewports. If a laptop-specific breakpoint exists in the CSS between
   1024 and 1440, it wasn't exercised.
