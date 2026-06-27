# Spec: Group-aware Home & Search (storefront) + admin "Denominasi" wording

**Date:** 2026-06-18
**Status:** Approved (design)
**Branch (intended):** continues on `feature/admin-group-assign-dropdown` or a new `feature/group-aware-home-search`

## Problem

The product-denominations feature (Category → ProductGroup → Product) is live and
the storefront **category page** (`/c/:id`) already renders parent **group cards**
that drill into denominations (`/g/:id` → pick a denomination → `/p/:id` → order).

But two storefront surfaces still show **flat denominations**, defeating the
hierarchy:

- **Home "Latest products"** (`/`) lists individual products — e.g. "Capcut 1
  Month", "Netflix Premium Test" — instead of parent groups (Capcut →, Netflix →).
- **Search** (`/search`) returns flat product cards, with no group collapse.

Additionally, the **admin Catalog** page uses the English word "Group/Grup" for
the grouping feature; the shop owner wants Indonesian **"Denominasi"** wording
there (text only).

Screenshots confirming: Home shows flat denominations; the category page already
shows a correct "Netflix / 2 options / from Rp…" group card.

## Goal

Apply the established group-collapse pattern to **Home "Latest products"** and
**Search** so the customer flow is consistently:

> Product list (Home/Search/Category) → Parent group → Denomination → Order

while products without a group continue to render as normal product cards, and a
group with a single active denomination collapses to that product card.

Relabel the **admin** grouping UI strings from "Group/Grup" to "Denominasi" — no
structural change to the admin (it stays a flat, per-product management list).

## Non-goals

- No database schema change (the `ProductGroup` table and `Product.productGroupId`
  already exist). Display-layer only → existing data and past orders are untouched.
- No change to the bot (already group-aware) or to the storefront category page
  (already correct).
- No change to admin **structure** (no collapsing products behind group cards in
  admin). Admin row clustering by group is a possible future follow-up, out of
  scope here.
- No code-identifier / DB / route renames — "Denominasi" is a UI string change in
  the admin Nunjucks template only.

## Approach

Reuse the existing engine and macros:

- `CatalogEntry` discriminated type (`{kind:"group"} | {kind:"product"}`) from
  `packages/db/src/crud/catalog.ts`.
- The collapse rules already implemented in `listCatalogEntries`: active groups
  with ≥1 active member become group entries; a group with exactly one active
  member collapses to a product entry; empty/inactive groups are dropped; a
  `groupedIds` set prevents a grouped product from also appearing as its own card
  (no duplication).
- The storefront macros `shop.group_card(g, fx, lang)` and
  `shop.product_card(p, fx, low, lang)` in `apps/storefront/views/_shop.njk`
  (already used by `catalog.njk`).

### 1. Data layer — `packages/db/src/crud/catalog.ts`

Two new read functions, both returning `CatalogEntry[]` (bare `Product` in product
entries, matching the existing type — routes join category via a `categoryId→name`
map as the category route already does):

- **`listNewestCatalogEntries(db, limit = 12)`** — Home.
  - Build entries for the whole catalog (active groups with active members
    price-asc; active ungrouped products), applying the same collapse/hide rules
    as `listCatalogEntries`.
  - Order by **recency**: a group's key is `max(member.createdAt)` over its active
    members; a product's key is its own `createdAt`. Sort desc, then `take(limit)`.
  - Rationale: when a new denomination is added to "Capcut", the Capcut group
    rises to the top of "Latest products".

- **`searchCatalogEntries(db, query, limit = 24)`** — Search.
  - Empty/whitespace query → `[]`.
  - Match active products by name/description `contains q` **and** active groups by
    `name contains q`.
  - Collapse: any matched product belonging to an active group is represented by
    that **group** card (full active member set, from-price = cheapest); matched
    products with no active group render as product cards. A group matched by name
    is included even if no member name matched. Dedup groups; no product appears
    twice.
  - Single-member groups collapse to a product card (shared rule).
  - Sort by display name asc, `take(limit)`.

Both functions live beside `listCatalogEntries`; factor shared collapse logic into
a small internal helper if it reduces duplication, but keep `listCatalogEntries`
behavior unchanged.

### 2. Routes — `apps/storefront/src/routes/`

- **`home.ts`**: replace `listNewestActiveProducts(prisma, 12)` with
  `listNewestCatalogEntries(prisma, 12)`. Shape the result into `groups[]` and
  `products[]` exactly as the category route (`catalog.ts` `/c/:id`) does:
  group cards `{id, name, emoji, from_price, count, image}`; product cards via the
  existing `card(...)` shaper. Use the already-loaded `categories` to build a
  `categoryId→name` map for product image/category-name lookup (product entries
  carry a bare `Product`). Keep the existing stock/ratings/bulk maps for product
  cards. Group cards need no stock/rating.
- **`catalog.ts` `/search`**: replace `searchProductsWithCategory(...)` with
  `searchCatalogEntries(prisma, q, 24)` and shape `groups[]` + `products[]` the
  same way. Load `listActiveCategories` (or reuse) for the `categoryId→name` map.

### 3. Templates — `apps/storefront/views/`

- **`home.njk`** "Latest products" grid and **`search.njk`** results grid: render
  `{% for g in groups %}{{ shop.group_card(g, fx, lang) }}{% endfor %}` followed by
  `{% for p in products %}{{ shop.product_card(p, fx, low_threshold, lang) }}{% endfor %}`,
  mirroring `catalog.njk`. No new CSS or macros. Preserve each page's existing
  empty-state and section chrome.

### 4. Admin wording — `apps/web-admin/views/catalog.njk` (text only)

Replace the user-facing English "Group/Grup" strings with "Denominasi":

- Section heading "Product Groups (denominations)" → "Denominasi"
- Table header "Group" → "Denominasi"
- "+ Add a group" / "Add group" → "+ Tambah denominasi" / "Tambah denominasi"
- Delete confirm "Delete group? Products are kept." → "Hapus denominasi? Produk
  tetap ada."
- Helper line (line ~96) and the empty state "No product groups yet." →
  "Belum ada denominasi."
- Product Edit dropdown label "Group (optional)" → "Denominasi (opsional)";
  "— No group —" → "— Tanpa denominasi —"
- Product row badge "· Grup: {{ p.productGroup.name }}" → "· Denominasi:
  {{ p.productGroup.name }}"
- Page header subtitle "Group products into categories…" → keep meaning but drop
  "group" wording if it reads naturally.

Form field `name="product_group_id"`, routes (`/catalog/group/...`), and all code
identifiers stay unchanged.

## Edge cases

- **Single active denomination** in a group → renders as a product card (not a
  group card). Satisfies "products with one denomination still display fine."
- **Empty / fully-inactive group** → hidden everywhere.
- **Ungrouped product** → normal product card.
- **No duplication**: a product in a group never also appears as its own card
  (`groupedIds` guard).
- **Home limit vs collapse**: entries are built and recency-sorted before
  `take(limit)`, so the limit counts cards (groups + products), not raw products.
- **Search matches group name but no member name** (e.g. group "Capcut", members
  named "1 Month"): the group is still returned via group-name matching.
- **Search matches a denomination in a group**: collapses to the group card so the
  buyer picks the denomination next (consistent with category page).
- **from_price**: members are price-asc, so `members[0].price`; honor reseller
  pricing where the existing card shaping already does (group card shows public
  from-price, consistent with current category page behavior).

## Testing

- **crud unit tests** (`packages/db` test suite, beside existing catalog tests):
  - `listNewestCatalogEntries`: newest denomination lifts its group to the top;
    single-member group emitted as a product; empty group hidden; limit caps cards.
  - `searchCatalogEntries`: grouped denomination collapses to a group entry;
    ungrouped match stays a product; group matched by name returned; no duplicate
    product; single-member group collapses; empty query → [].
- **storefront route tests** (`app.inject`): Home and Search responses contain a
  `/g/:id` link for a grouped product and a `/p/:id` link for an ungrouped one.
- **admin**: existing web-admin tests stay green; wording change needs no new test
  (optionally assert the Catalog page renders "Denominasi").
- `pnpm -r typecheck` and the full `npx vitest run` suite must stay green.

## Deploy

No schema change → on the VPS: `git pull`, rebuild, restart (Docker:
`docker compose build && docker compose up -d`; non-Docker: `pnpm install &&
pnpm prisma:generate && pm2 restart …`). **No `prisma db push` needed.**
