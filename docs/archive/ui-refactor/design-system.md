# Design System / Component Consistency

Concrete inconsistencies found during the crawl, with file references under
`apps/web-admin/client/src/components` and `apps/web-admin/client/src/pages`.
This is not a request for a new component library — per the audit
constraints, the existing component library (`components/ui/*` — Radix-based
`button.tsx`, `select.tsx`, `dialog.tsx`, `input.tsx`, `label.tsx`, etc.) and
current branding/colors/typography are preserved. These are inconsistencies
in *how existing components are used*, not proposals for new ones.

## 1. Three different "create a new record" patterns (Finding F-006)

| Pattern | Where used | Files |
|---|---|---|
| Dedicated full page | Product, Denomination | `apps/web-admin/client/src/pages/ProductCreatePage.tsx`, `apps/web-admin/client/src/pages/DenominationCreatePage.tsx` |
| Inline expand-in-place section (replaces the trigger button with a form + Cancel) | Voucher | `apps/web-admin/client/src/pages/VouchersPage.tsx` |
| Bare inline table row (single field, no `Label` components) | Admin | `apps/web-admin/client/src/pages/AdminsPage.tsx` |

The Product/Denomination pattern consistently uses `Label` + `Input`/`Select`
from `components/ui/` with a "Field Name *" + helper-text-below convention.
The Voucher and Admin patterns do not follow this — Voucher's inline form
uses placeholder-only fields with no `Label` components at all (confirmed via
accessibility snapshot: fields expose only placeholder-derived accessible
names, e.g. `textbox "Code"` had no separate label element), and Admin's row
is a single unlabeled `Input` + button.

**Recommendation:** standardize on two tiers — dedicated page for
multi-field/complex records, inline-expand (Voucher's existing structural
pattern, since it doesn't need a page navigation) for simple ones — and bring
both Voucher and Admin's fields up to the same `Label`-wrapped pattern
Product/Denomination already use.

## 2. Breadcrumb + Back button redundancy (Finding F-008)

Every create/detail page under Catalog (`ProductCreatePage.tsx`,
`DenominationCreatePage.tsx`, and presumably `ProductDetailPage.tsx`,
`DenominationEditPage.tsx`, `StockProductPage.tsx`, `UserDetailPage.tsx` —
same visual pattern observed on all of them in the crawl) renders a
breadcrumb-style `<nav>` link at top-left *and* a separate "← Back" button at
top-right. These appear to share a common structural pattern — likely a
shared header composition (check `apps/web-admin/client/src/components/shared/PageHeader.tsx`
and/or `PageLayout.tsx`, both of which exist in the codebase and are the
natural place this would be centralized) rather than each page re-implementing
it. **Recommendation:** fix once in the shared component if confirmed, rather
than per-page.

## 3. Breadcrumb label bug (Finding F-007)

`DenominationCreatePage.tsx`'s breadcrumb hardcodes (or fails to interpolate)
the literal string "Product" instead of the loaded product's actual `name`.
Worth checking `DenominationEditPage.tsx` for the same bug since it shares the
same nested-route shape (`/catalog/:productId/denominations/:denomId/edit`).

## 4. Raw backend strings surfaced without a label map

Two distinct instances of the same underlying pattern:
- Order status enum values shown verbatim in the Orders status filter
  (`apps/web-admin/client/src/pages/OrdersPage.tsx`) — Finding F-003.
- Audit Log's Action column shows raw snake_case action codes
  (`apps/web-admin/client/src/pages/AuditPage.tsx`) — Finding F-005; the
  Admin column shows a raw numeric ID instead of a name — Finding F-004.

**Recommendation:** a single shared labeling utility (see `ux.md` §2) so this
class of bug doesn't recur as new enum values / action codes are added on the
backend.

## 5. Table column header clarity

`AdminsPage.tsx`'s Admins table uses the abbreviation "Pwd" as a column
header (Finding F-015) where every other table in the app
(Orders/Catalog/Stock/Vouchers/Customers/Payments/Outbox/Audit) uses full
words for headers ("Code", "Customer", "Status", "Total", "Payment Method",
etc.). This is the one abbreviated header found in the crawl — an outlier
against the app's own established convention.

## 6. Empty-state copy: contextual vs. generic

Most empty states follow a good, consistent two-line pattern (bold headline +
a specific, actionable subline):
- Catalog: "No products yet" / "Add your first product to start selling."
- Vouchers: "No vouchers found" / "Create your first voucher to offer discounts."
- Stock (item level): "No stock items" / "Add credentials above to stock this denomination."

`OrdersPage.tsx` breaks this convention with a generic, filter-assuming
message regardless of whether a filter is actually active (Finding F-016).
This is the one page in the crawl that doesn't follow the app's own
already-established empty-state convention — fixing it means matching a
pattern the codebase already demonstrates elsewhere, not inventing a new one.

## 7. Settings "Enabled" toggle + "not configured" label pairing

`SettingsPage.tsx`'s payment-gateway sections pair a switch labeled "Enabled"
(on by default) with separate "not configured" text, read together as
contradictory (Finding F-013). No other toggle+status pairing in the app was
observed doing this (e.g. Product's "Active" switch on `ProductDetailPage.tsx`
does not have an accompanying "not configured"-style caveat — it's a single,
unambiguous signal). Settings is the outlier here too.

## What's consistent and should be preserved

- The `+`-prefixed primary-action button convention ("+ Add Product", "+ New
  Voucher", "+ Add Admin", "+ Add Denomination", "+ Add Stock" in Quick
  Actions) is used uniformly across the app — keep this.
- Disabled-until-valid submit buttons are consistent across every create form
  checked (Product, Denomination, Voucher, Broadcast).
- The custom `Select`/`combobox` component (`components/ui/select.tsx`)
  renders identically (role="combobox" + listbox popup) everywhere it's used
  (Orders status filter, Denomination Account Type/Delivery Type, Voucher
  Type) — no inconsistency found here, this is a genuinely reused shared
  component.
- Status badges (`components/shared/StatusBadge.tsx`) appear visually
  consistent across Stock ("Out Of Stock"), Vouchers (Active), and other
  tables — not flagged as an inconsistency.
