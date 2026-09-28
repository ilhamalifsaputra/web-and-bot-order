# Navigation Analysis

## Current sidebar structure

Read directly from `apps/web-admin/client/src/components/layout/Sidebar.tsx`
(`NAV_GROUPS`):

```
(ungrouped)
 └ Dashboard

Sales
 ├ Orders
 ├ Awaiting Fulfillment      ← same page as Orders, pre-filtered
 └ Payments

Products
 ├ Catalog
 ├ Stock
 └ Vouchers

Customers
 └ Customers

Support
 ├ Tickets
 ├ Broadcast
 └ Reviews

Reports
 ├ Reports
 ├ Audit Log
 └ Outbox

Administration
 ├ Admins
 ├ Settings
 └ Branding
```

Plus two global entry points not in the sidebar tree: the topbar search
(`Ctrl+K`) and Quick Actions dropdown (Add Product, Add Stock, Broadcast, Add
Customer, Reports).

## Issue: duplicate page (Finding F-001)

"Orders" and "Awaiting Fulfillment" are two sidebar entries for **one**
resource (`OrdersPage.tsx`), the second just a deep link to
`/orders?status=PROCESSING`. This is precisely the anti-pattern described in
the audit brief's Navigation Guidelines. The Orders page already has a full
`Status` filter dropdown (all 13 statuses — see F-003), so the dedicated nav
item adds a second, redundant way to reach a subset of the same list, at the
cost of one more line in an already-long sidebar.

**Recommendation:** collapse to a single "Orders" entry. Move "Awaiting
Fulfillment" to a quick-filter/tab inside Orders (All / Awaiting Payment /
Paid / Awaiting Fulfillment / Processing / Completed / Cancelled, per the
brief's canonical example — see F-003 for the fuller status-label cleanup this
should be paired with). Preserve the existing badge-count behavior
(`fulfillmentBadge`) by moving it onto the in-page filter/tab, or keeping a
combined badge on "Orders" itself.

## Other IA observations

- **Sales / Products / Customers / Support / Reports / Administration** is a
  reasonable top-level grouping and matches how a shop admin would think about
  the resources (this is not a finding — it's working well and should be
  preserved).
- **"Customers" group contains one item** ("Customers", linking to `/users`).
  A single-item group adds a header label with no grouping benefit. Low-value
  to fix on its own, but if Settings gets sectioned (F-012) and any other
  single-item groups emerge, consider whether ungrouped top-level items (like
  "Dashboard" already is) read cleaner than a group header over one link.
- **"Reports" group name collides with the "Reports" item inside it** — the
  group header "Reports" and the first child link "Reports" are the same word
  stacked directly on top of each other (confirmed in every sidebar snapshot
  captured, e.g. `screenshots/audit-log-desktop.png`). Minor but genuinely
  confusing on first read — visually reads as a duplicated label.
  **Recommendation:** rename the group header to something like "Insights" or
  "Reports & Logs", or drop the redundant inner "Reports" link's label
  ambiguity by renaming the leaf item (e.g. "Sales Reports").
- **Two logout entry points** exist (sidebar footer link, topbar user-avatar
  dropdown) and both are currently broken (F-002). Once fixed, having both is
  reasonable (persistent sidebar affordance + conventional avatar-menu
  affordance) — no need to remove either, just fix the underlying POST issue
  in one shared place both call.
- **No breadcrumbs above the sidebar-level pages** (Orders, Catalog, Stock,
  etc. — the top-level list pages) — not an issue, since the sidebar itself
  communicates location for one level deep. Breadcrumbs only start appearing
  on nested pages (Catalog → Product → New Denomination), which is
  appropriate, though see F-007 and F-008 for bugs/redundancy in those
  breadcrumbs specifically.
- **Discoverability of search/quick actions:** `Ctrl+K` search and the "+"
  Quick Actions button are both good power-user affordances and were
  confirmed working (search modal opens, quick actions dropdown lists Add
  Product / Add Stock / Broadcast / Add Customer / Reports). No navigation
  issue here beyond F-009's accessibility gap (icon-only search button loses
  its label below the `sm` breakpoint) and F-017 (search returned no results
  for an existing product — likely backend).

## Summary recommendation for phase 2

1. Remove "Awaiting Fulfillment" from `Sidebar.tsx`; add status quick-filters
   inside `OrdersPage.tsx` (pairs with F-003's label cleanup).
2. Rename the "Reports" group header to avoid the header/item label collision.
3. Fix the shared logout mechanism once (F-002), used by both existing entry
   points — no structural navigation change needed there beyond the bug fix.
