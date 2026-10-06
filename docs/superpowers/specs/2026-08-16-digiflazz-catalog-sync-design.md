# Digiflazz catalog auto-sync (Import Wizard) — design

## Context

The approved plan at `C:\Users\ilham\.claude\plans\abundant-coalescing-parnas.md`
(Storefront Top Up Game / Digiflazz pilot) originally had admin catalog setup
as fully manual: for every game and every denomination, the admin creates a
Product and Denomination by hand and copies the `buyer_sku_code` from
Digiflazz's own dashboard into a Supplier SKU text field (Task 4 of that
plan). Task 1 (schema fields `Denomination.supplierSku`,
`Category.checkoutFlow`, `Order.digiflazzDispatchedAt`, plus the pure
`packages/core/src/suppliers/digiflazz.ts` client) is complete; Task 2
(dispatch poller + fulfillment) was mid-implementation when this pivot was
requested.

The user has previously operated a rented top-up storefront where, after
entering Digiflazz credentials, products appeared in the catalog
automatically rather than being typed in one at a time — and asked to bring
that capability into this project **ahead of** finishing the remaining
manual-entry admin UI tasks. This document designs that capability: a
one-click **Import Wizard** that pulls Digiflazz's price list, groups it by
game, and lets the admin bulk-create Products/Denominations from it, plus a
recurring job that keeps already-imported items' price/status current
without ever overwriting what the admin has hand-edited.

This does not replace the original plan — Tasks 1, 2, 3, and 5 all stay as
designed. This is an additional task inserted before the original Task 4
(which becomes a secondary/override surface instead of the primary
onboarding path), with Task 3's existing hourly cost-refresh cron gaining
wider scope (documented below).

## Confirmed API shape

Fetched from Digiflazz's own technical documentation
(`developer.digiflazz.com/api/buyer/daftar-harga/`) rather than assumed. A
prepaid price-list item:

```json
{
  "product_name": "Mobile Legends 100 Diamond",
  "category": "Game",
  "brand": "Mobile Legends",
  "type": "Umum",
  "seller_name": "PT. ABC",
  "price": 15000,
  "buyer_sku_code": "ml100",
  "buyer_product_status": true,
  "seller_product_status": true,
  "unlimited_stock": true,
  "stock": 0,
  "multi": true,
  "start_cut_off": "00:00",
  "end_cut_off": "23:59",
  "desc": "..."
}
```

`brand` is the field that groups every SKU of one game together — confirmed
as "Merek produk pada Digiflazz" in the docs, and it separates region
variants automatically: if Digiflazz lists "Mobile Legends" and "Mobile
Legends (Region Lain)" as different brand strings, they surface as two
separate groups in the wizard with no special-casing needed. `category`
lets the wizard filter to `"Game"` for this pilot's scope, leaving room for
Pulsa/PPOB (different `category` values) to reuse the same mechanism later
without new code, matching the original plan's phased rollout.
`buyer_product_status` is the per-SKU active flag the re-sync job mirrors
into `Denomination.isActive`.

## Data model additions

Beyond Task 1's three fields:

- **`Product.digiflazzBrand String?`** — the exact Digiflazz `brand` string
  this Product was imported from. This is the re-sync matching key, chosen
  over matching by `Product.name` specifically so the admin can freely
  rename the display name after import without breaking future syncs.
- **`Denomination.priceOverridden Boolean @default(false)`** — set to
  `true` the moment an admin manually edits a Denomination's `price` after
  import (whether via the wizard's pre-import price field or a later
  catalog edit). The re-sync job checks this flag and skips price
  recalculation for any row where it's `true`, so a deliberate manual price
  change is never silently clobbered by the next sync.
- **Two `Setting` rows for the global markup rule** —
  `digiflazz_markup_type` (`"percent" | "flat"`) and
  `digiflazz_markup_value` — read by both the wizard (to suggest a sell
  price per row) and the re-sync job (to recompute price on rows that
  aren't `priceOverridden`). Lives in the same Settings surface as the
  Digiflazz credentials from the original plan's Task 5.

No other schema changes. `Denomination.supplierSku`/`autoDeliverySource`
from Task 1 are populated by the wizard exactly the same way the original
plan's Task 4 would have populated them by hand — the wizard is a new way
to *fill* those fields in bulk, not a new mechanism.

## Import Wizard flow

New admin page (e.g. `DigiflazzSyncPage.tsx`, linked from the existing
Catalog page), following this codebase's established admin conventions
(hand-rolled `useState` forms, TanStack Query mutations, shadcn
components — no new form library):

1. Admin clicks **"Sync dari Digiflazz"**. Server calls `getPriceList`
   (Task 1's client), filters `category === "Game"`, groups remaining rows
   by `brand`.
2. Review screen lists each brand as an expandable group with a text
   filter/search (price lists run into the thousands of rows across all
   categories — the Game-only slice is still large enough to need this).
   Each group is tagged:
   - **"Baru"** — no existing `Product.digiflazzBrand` matches this brand.
     Expandable to show its SKUs as checkboxes (all checked by default),
     each row showing the computed sell price
     (`costPrice + digiflazz_markup_*`), editable inline before import.
     Checking this row's price as `priceOverridden` happens automatically
     the moment the admin edits it in this screen.
   - **"Sudah ada"** — already imported (matched via `digiflazzBrand`).
     Shown read-only as a preview of what the next re-sync tick will
     change (price/status deltas); no checkbox here, since updates to
     already-imported brands flow through the recurring job (below), not
     through re-running the wizard.
3. For "Baru" groups: admin picks a target `Category` (existing categories
   only, via the same picker pattern already used elsewhere — this design
   does not add category auto-creation), selects which brands/SKUs to
   bring in, adjusts any suggested prices, and clicks **"Impor
   Terpilih"**.
4. One submit = one DB transaction: creates the Product
   (`name = brand`, `digiflazzBrand = brand`) and one Denomination per
   checked SKU (`supplierSku = buyer_sku_code`,
   `autoDeliverySource: "digiflazz"`, `deliveryType: "manual_with_info"`,
   `additionalFields` = the same Game ID + Server template the original
   plan's Task 4 specified), all-or-nothing.
5. Imported Products/Denominations are created **inactive**. Making them
   live is a separate, explicit activation step (on the post-import
   confirmation screen or via the existing Catalog page) — this is what
   satisfies "review before it goes live": the import itself is bulk and
   automatic, but publishing to the storefront is still a deliberate admin
   action.

## Re-sync behavior (recurring update, not the wizard)

Task 3's existing hourly cost-refresh cron (originally scoped to just
`costPrice`) is extended to also drive this, for every Denomination with a
non-null `supplierSku`:

- `costPrice` updates from the fresh price list, as originally planned.
- `price` recomputes from `costPrice + digiflazz_markup_*` **unless**
  `priceOverridden` is `true` on that row, in which case price is left
  untouched.
- `Denomination.isActive` flips off when Digiflazz deactivates the SKU. It
  flips back on only for a SKU this job itself switched off (remembered under
  the `digiflazz_auto_deactivated_ids` setting) — never one an admin turned
  off or a fresh wizard import. Never affects `Product`/Category-level active
  state.
- Never renames. **Updated 2026-10-06:** it now also creates the new SKUs
  Digiflazz lists under a brand that already has a Product — active and
  priced by the markup, at most 100 per run, never when the markup is
  unreadable or the circuit breaker aborts. Brand-new brands still enter only
  through the wizard, with the admin reviewing first.
- The same run happens hourly (cron) and on demand when an admin presses
  the wizard's Sync button (`POST /api/catalog/digiflazz/sync/run`); a
  short-lived lease (`digiflazz_catalog_sync_lease`, 10 minutes) keeps the
  two from running at the same time.
- Idempotent by construction (matches on `supplierSku`, and auto-add skips a
  SKU already present on any denomination), so a re-run never duplicates rows.

## Error handling

- **Digiflazz fetch/credential failure** (wizard or re-sync job): surfaced
  with a clear message, no partial state written. Wizard reuses the same
  "Test Connection"-style error presentation already used for other
  payment gateways in Settings.
- **Nonsensical computed price** (zero, negative, or below cost from a
  misconfigured markup): that row is flagged and cannot be checked for
  import until the admin fixes the number manually.
- **Import submit** is one transaction — no half-created Product without
  its Denominations, ever.
- **Concurrent sync** (two admins, or the hourly job firing mid-review):
  safe by construction since both paths match on `supplierSku`/
  `digiflazzBrand` — a wizard submit touching a row the recurring job just
  updated updates that row again rather than duplicating it.
- **Large price lists**: the review screen's brand search/filter is a
  hard requirement, not a nice-to-have, given real Digiflazz catalogs run
  into the thousands of SKUs.

## Relationship to the existing plan's tasks

- **Task 1** (schema + core client) — unchanged, this design only adds to
  it (two new fields, two new Setting keys).
- **Task 2** (dispatch poller + fulfillment) — unchanged.
- **Task 3** (webhook + cron) — the existing hourly cost-refresh cron
  gains the price/status re-sync responsibility described above; the
  webhook route and dispatch-poller cron are untouched.
- **Task 4** (manual Denomination Supplier SKU + Auto delivery source
  fields) — still built, but demoted from primary onboarding path to an
  override/edit surface: fixing a bad wizard mapping, or hand-adding a
  single denomination outside any sync.
- **Task 5** (Category checkout-flow toggle, Digiflazz Settings
  credentials) — unchanged; the markup-rule setting rides in the same
  Settings surface.
- **Tasks 6/7** (storefront `InstantBuyPage`, account nickname check) —
  unaffected; they read Denominations regardless of how those rows were
  created.

## Out of scope (this design)

- Category auto-creation — the wizard requires an existing target
  Category; creating one still goes through the existing Category flow.
- Pulsa/PPOB — the wizard's `category === "Game"` filter is a pilot-scope
  choice; the mechanism generalizes to other categories later with no new
  code, per the original plan's phased rollout, but that switch is not
  built now.
- Handling a Digiflazz brand *rename* (the same game reappearing under a
  different `brand` string) — would look like a new, unmatched brand.
  Acceptable, known limitation for the pilot; not solved here.
- Per-brand or per-category markup rules — one global rule only, per the
  brainstorm decision; admin can still hand-edit any individual price
  after import (which then becomes `priceOverridden`).

## Verification

- `pnpm typecheck` and `pnpm test` stay green, including new unit tests
  for: brand-grouping from a raw price-list response, `digiflazzBrand`
  matching on re-sync (new vs. already-imported), the `priceOverridden`
  skip path, and the `isActive` mirroring of `buyer_product_status`.
- Manual browser walk: first sync shows brand groups → import one game →
  confirm Product+Denominations exist with the Game ID + Server template
  pre-filled → trigger the recurring job again → confirm no duplicates and
  price/status update → hand-edit one Denomination's price → trigger the
  job again → confirm that price is left alone → deactivate a SKU
  (simulated) → confirm the matching Denomination goes inactive
  automatically.
- Confirm `InstantBuyPage` renders imported-and-activated products
  identically to hand-created ones (regression check against Tasks 6/7).
