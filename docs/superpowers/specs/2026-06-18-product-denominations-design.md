# Product Denominations (Product Groups) — Design

**Date:** 2026-06-18
**Status:** Approved for planning

## Problem

A product like "Capcut" is sold in several durations ("Capcut 1 Month",
"Capcut 7 day"). Today each duration is a separate flat `Product` row, so the
catalog shows them as unrelated entries. We want to group denominations under a
single parent ("Capcut → 1 Month / 7 day") across the bot, the storefront, and
the web-admin panel.

## Decisions (from brainstorming)

- **Parent + variant via a new table** — introduce `ProductGroup` (the parent).
- **Product stays the stock holder.** Each denomination remains a `Product` row
  with its own price, `durationLabel`, and stock. Grouping is a pure
  display/navigation layer. **No changes** to `StockItem`, `OrderItem`,
  `CartItem`, `Review`, `RestockSubscription` — they keep pointing at
  `productId`. This avoids a production data migration and respects the
  single-writer SQLite constraint.
- **Grouping is optional.** A product may have no group and continues to render
  flat exactly as today. No backfill of existing products.
- **A group lives in exactly one category.** All member products must share that
  category. The denomination picker labels each option by the product's
  `durationLabel` (fallback to `name`).
- **Collapse single-member groups.** A group with exactly one active member
  renders as that product directly (skip the picker).
- **Delete group = unlink members** (`productGroupId = null`), never delete the
  underlying products.

## Non-goals

- No move of stock/orders/cart to a variant id (explicitly rejected — option A).
- No mandatory grouping; existing flat products are untouched.
- No cross-category groups.
- Cart/keranjang flow changes are out of scope beyond what grouping navigation
  requires.

## Schema

New model, mapped to a new table. Additive migration only.

```prisma
model ProductGroup {
  id          Int      @id @default(autoincrement())
  categoryId  Int      @map("category_id")
  name        String
  emoji       String?
  description String?
  webImageUrl String?  @map("web_image_url")   // storefront card image
  imageFileId String?  @map("image_file_id")   // bot banner image
  sortOrder   Int      @default(0) @map("sort_order")
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at")

  category Category  @relation(fields: [categoryId], references: [id], onUpdate: NoAction)
  products Product[]

  @@index([categoryId], map: "ix_product_groups_category_id")
  @@map("product_groups")
}
```

`Product` gains a nullable back-reference:

```prisma
productGroupId Int?          @map("product_group_id")
productGroup   ProductGroup? @relation(fields: [productGroupId], references: [id], onUpdate: NoAction)
@@index([productGroupId], map: "ix_products_product_group_id")
```

`Category` gains `groups ProductGroup[]` (relation back-reference only).

**Invariant:** `product.categoryId == group.categoryId` for any grouped product,
enforced in `assignProductToGroup`.

**Deploy order (CLAUDE.md):** apply the migration / `pnpm prisma db push` to the
live DB and restart order-bot **before** the new code runs, to avoid
`P2022 column … does not exist`.

## CRUD helpers (`packages/db/src/crud/catalog.ts`)

No raw SQL in routes/handlers — all logic lands here with Vitest coverage.

- `listAllGroups(db)` — admin list (active + inactive), with category + member count.
- `getGroup(db, groupId)` / `getGroupWithActiveProducts(db, groupId)` — members
  filtered to `isActive`, ordered by `price asc`.
- `createGroup(db, { categoryId, name, emoji?, description?, webImageUrl?, imageFileId?, sortOrder? })`.
- `updateGroup(db, groupId, fields)` — whitelisted fields only.
- `deleteGroup(db, groupId)` — unlink members (`productGroupId = null`) then
  delete the group, in one short `$transaction`.
- `assignProductToGroup(db, productId, groupId | null)` — when `groupId` set,
  validate the product and group share `categoryId`; throw a typed error on
  mismatch. `null` unlinks.
- `listCatalogEntries(db, categoryId?)` → ordered union used by every customer
  surface:
  ```ts
  type CatalogEntry =
    | { kind: "group"; group: ProductGroup; members: Product[] }
    | { kind: "product"; product: Product };
  ```
  Rules:
  - Include active groups whose category matches (or all when `categoryId`
    omitted) **with ≥1 active member**; drop empty/inactive groups.
  - A group with exactly one active member is emitted as
    `{ kind: "product", product }` (collapse).
  - Include active products that have no group (or whose group is inactive) as
    `{ kind: "product" }`.
  - Sort: groups and products interleaved by a stable key (group `sortOrder`
    then `name`; product `name`). Exact ordering defined in the plan; tested.

## Surfaces

### Web-admin (`apps/web-admin`)

New "Groups" area within catalog management:

- List groups (category, member count, active toggle).
- Create / edit group (name, emoji, description, images, sort order, category).
- Delete group (confirms; unlinks members).
- Assign / unassign products to a group — multi-select limited to products in
  the group's category.

Every mutating route uses the `csrfProtect` preHandler and `currentAdmin`;
each new route gets the happy / auth-fail / bad-csrf test trio and calls
`logAdminAction` with the acting admin id. Settings whitelist untouched.

### Bot (`apps/order-bot`)

`browseProductsFlat` becomes group-aware via `listCatalogEntries`:

- Rendered numbered list mixes group entries and ungrouped product entries.
- The render snapshot (currently `browseProductIds`) is extended to record
  entry kind + id so a tapped number resolves to either a group or a product,
  stable across catalog changes between render and tap.
- Tapping a **group** edits the bubble into a denomination picker keyboard —
  one button per active member labeled by `durationLabel` (fallback `name`) +
  price — plus Back. Selecting a denomination calls the existing
  `browseProduct(productId)`; product detail/checkout are unchanged.
- Tapping a **product** entry behaves exactly as today.
- All new customer strings go through `t(ctx, key, args)` with identical key
  sets and matched placeholders in `packages/core/locales/{en,id}.json`
  (e.g. `browse.choose_denomination`, group caption).

### Storefront (`apps/storefront`)

- Category / catalog listing renders group cards alongside ungrouped product
  cards (driven by `listCatalogEntries`).
- A group card links to a group view showing the denomination selector; picking
  a denomination routes to the existing product detail / checkout.
- Uses the `money` filter for prices and `localdt` where dates appear.

## Edge cases

- **Empty group** — hidden from all customer surfaces; visible in admin.
- **Inactive group** — its members fall back to flat individual listing (still
  buyable while the product is active).
- **Single active member** — collapsed to the product directly (no picker).
- **Out-of-stock denomination** — still shown, marked as today on product detail.
- **Member product deactivated** — excluded from picker and member count for
  customer surfaces.
- **Delete category containing groups** — treated like products: blocked while
  members/groups exist (mirror existing category-delete guard).
- **Reassigning a product across categories** — must clear or revalidate its
  group membership (assign helper enforces the category invariant).

## Testing

- crud unit (Vitest):
  - `listCatalogEntries` — mix + ordering, hides empty/inactive groups, collapses
    single-member group, ungrouped products included.
  - `assignProductToGroup` — rejects cross-category, unlinks on `null`.
  - `deleteGroup` — members unlinked, products survive.
- Web-admin route trio (happy / auth-fail / bad-csrf) for each new mutating route.
- Bot handler test: group tap → denomination picker; product tap unchanged.
- `pnpm -r typecheck` and `pnpm test` stay green.
