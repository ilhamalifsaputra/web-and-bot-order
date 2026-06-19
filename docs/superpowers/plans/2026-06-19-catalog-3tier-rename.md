# Refactor catalog to Category → Product → Denomination

## Context

The shop (Telegram bot + web admin + storefront, one SQLite DB, one process via
`apps/server`) needs a clean, scalable 3-level catalog: **Category → Product →
Denomination (SKU)**, with **price, cost, stock, and auto-delivery living only at
the denomination level**.

The codebase already has a *loose* 3-level shape, but named inversely and
implemented optionally:

| Target tier | Current model / table | Notes |
|---|---|---|
| **Category** | `Category` / `categories` | keep |
| **Product** | `ProductGroup` / `product_groups` | currently **optional** parent |
| **Denomination** | `Product` / `products` | currently the sellable SKU (holds price; stock via `StockItem`) |

Because the parent is optional, the code carries "ungrouped product" and
"single-member group collapse" branches, and the word *Product* means the SKU
everywhere. We will perform a **physical rename** so the schema, code, API, and
UI all speak Category → Product → Denomination consistently, expose a real JSON
API, and deliver it in **ordered phases** that each keep `pnpm typecheck` +
`pnpm test` green.

Decisions locked with the user: physical DB rename · build a real JSON API ·
phased delivery · orphan SKUs each get a 1:1 wrapper Product. `cost_price` and
`auto_delivery_source` are nullable (null = unknown / manual fulfilment).

Key naming hazard throughout: **"Product" inverts meaning.** Old `products`
rows become `denominations`; the table named `products` afterwards holds the old
`product_groups`. Every existing crud function with "Product" in its name today
operates on the future Denomination.

---

## Phase 1 — Database schema + migration + crud (foundation)

### 1a. Prisma schema (`prisma/schema.prisma`)

Three catalog models (table names: `categories`, `products` = old
`product_groups`, `denominations` = old `products`):

- **Category** — add `slug` (unique), `description`, `image`; keep `emoji`,
  `sortOrder`, `isActive`. Drop the old `groups` relation; `products` relation
  now points at the new Product.
- **Product** (was ProductGroup) — mandatory mid-tier; carries old
  `product_groups` columns + new `slug` (unique). **No price, no stock.**
  Relation `denominations Denomination[]`.
- **Denomination** (was Product) — the SKU/leaf. `product_id` becomes
  **mandatory**. Add `slug` (unique), `costPrice Decimal? @map("cost_price")`,
  `autoDeliverySource String? @map("auto_delivery_source")`, `sortOrder`. Keep
  `price`, `type`, `durationLabel`, `resellerPrice`, `warrantyDays`,
  `isActive`. **Drop `category_id`** — category is reached via `product →
  category`.
- **Dependent models** (`StockItem`, `OrderItem`, `CartItem`, `BulkPricing`,
  `Review`, `RestockSubscription`): **keep the physical `product_id` column**
  (avoids 6 column renames + app churn), only retarget the FK to `denominations`
  and rename the Prisma relation field to `denomination`. Add a `///` comment
  noting the column holds a denomination id.

### 1b. Migration (`prisma/migrations/<ts>_catalog_rename/migration.sql` + cutover scripts)

Hand-written `.sql` delta (NOT `db push` — it can't do the data-preserving
backfill). Whole delta wrapped in `PRAGMA foreign_keys=OFF; BEGIN; … COMMIT;
PRAGMA foreign_keys=ON; PRAGMA foreign_key_check;`. Ordered steps:

0. **Reconcile dangling `product_groups`** — schema declares it but no migration
   ever created it; live DB state depends on whether someone ran `db push`.
   Detect + create defensively; document the one non-idempotent spot in the
   runbook.
1. **Create `denominations`** from old `products`, **preserving `id`** (all six
   dependent FKs point at these ids). Copy `product_group_id → product_id`
   (nulls fixed in step 3).
2. **Rename**: `products → products_old`, then `product_groups → products`; add
   `slug` column; re-create index as `ix_products_category_id`.
3. **Backfill mandatory parent (1:1 wrapper per orphan)** — for each old
   ungrouped SKU, insert one wrapper Product (carry category/name/images), link
   via a temporary `legacy_denom_id` column, then drop it. Assert
   `COUNT(*) WHERE product_id IS NULL = 0`.
4. **Retarget dependent FKs** to `denominations` via table-rebuild
   (`<t>_new` → copy → drop → rename → recreate indices). Preserve onDelete
   (CASCADE for stock/bulk/reviews/restock, RESTRICT for order_items) and the
   `order_items.stock_item_id` / `stock_items.order_id` FKs.
5. **Slugs** — `scripts/backfill-catalog-slugs.ts` (TS; SQLite core has no regex)
   fills `categories/products/denominations.slug` from name, dedupe with
   `-<id>` suffix; then add UNIQUE indices + NOT NULL.
6. **Drop `products_old`.**
7. **Integrity gate** — `foreign_key_check` empty, row-count parity, no null
   `product_id`/`slug`.

**Deploy ordering (P2022 hazard):** stop server+notifier → **backup
`data/bot.db` + WAL** → apply delta → run slug script + add indices →
`pnpm prisma generate` → start new code. There is **no valid overlap window**
(stop-the-world cutover); backward compat is source-level only.

### 1c. crud refactor (`packages/db/src/crud/`)

- **catalog.ts** — split into Category / Product / Denomination CRUD:
  - Category: `createCategory`/`updateCategory` gain `slug`/`description`/`image`.
  - Product (promoted from group helpers): `createProduct`/`updateProduct`/
    `listProducts`/`getProductWithDenominations`/`deleteProduct` (**refuse delete
    unless empty**; separate explicit cascade path), `assignDenominationToProduct`.
  - Denomination (repointed to `db.denomination`, join category via
    `product.category`): `createDenomination`(needs `productId`),
    `updateDenomination`(+`costPrice`/`autoDeliverySource`), `getDenomination`,
    `searchDenominations`, `bulkSetPrices`, `lowStockDenominations`, etc.
  - **Remove** `CatalogEntry` union + collapse/ungrouped logic. Replace with
    `listCatalogProducts(categoryId?)`, `listNewestCatalogProducts(limit)`,
    `searchCatalog(query, limit)` — each returns Products with active
    denominations (price asc). Add a slug generator with collision-dedupe used by
    all create helpers.
- **stock.ts / cart.ts** — rename param `productId → denominationId`, relation
  include `product → denomination`; physical column unchanged so queries are
  structurally identical (purely a rename + include change).
- **orders.ts** — `item.product.* → item.denomination.*`;
  `createOrderDirect`/`CartLine` use `denominationId`; `allocateOneAvailableStock`
  receives the denomination id; `getBulkPricingForProduct → ...ForDenomination`.
  Money flow unchanged.
- **Backward-compat shim:** keep old export names (`listCatalogEntries`,
  `listActiveProducts`, `createGroup`, …) as `@deprecated` thin wrappers that
  adapt to the new functions, so apps keep compiling between phases. **Exception:**
  `createProduct`/`updateProduct`/`getProduct` collide in meaning and cannot be
  cleanly aliased — their old SKU call sites migrate in lockstep with this phase.
- **Tests (colocated vitest):** rewrite `product_groups.test.ts` →
  `catalog.test.ts` (flat hierarchy, no collapse); update
  `order_creation`/`stock_deduction`/`stock_admin`/`purchase_flow`/`bulk_pricing`/
  `credentials` to seed Product+Denomination; add **migration parity test**
  (fixture old DB → delta+slug → assert FK integrity, row counts, no nulls,
  orphans wrapped, id preservation); add slug-generator unit test.

---

## Phase 2 — Admin panel (`apps/web-admin`)

Restructure catalog management into three explicit sections:

- **Category Management** — CRUD, sort order, active/inactive (add slug /
  description / image fields to forms).
- **Product Management** — products belong to a category; page holds image,
  description, sort order, active/inactive (**no price/stock**).
- **Denomination Management** — inside Product detail, a table per the spec
  (`Name | Price | Cost Price | Stock | Status`) with create / edit / delete /
  reorder / active-toggle / stock management / auto-delivery source.

Routes: `apps/web-admin/src/routes/catalog.ts` (split product vs denomination
handlers; product create no longer takes price/type/duration), `stock.ts`
(stock keyed by denomination). Views: rework `catalog.njk`, `product_detail.njk`
(General/Photos/Discounts + new Denominations tab), `stock.njk`,
`stock_product.njk`, `catalog_import_preview.njk` (CSV now
category|product|denomination|price|cost|…). Each mutating route keeps the
`csrfProtect` + happy/auth-fail/bad-csrf test trio; settings whitelist untouched.

---

## Phase 3 — Storefront (`apps/storefront`)

Enforce flow Home → Category → Product list → Product detail → choose
Denomination → cart → checkout.

- **Product lists never show denomination rows.** Category page
  (`routes/catalog.ts` `/c/:slug`) shows product cards (image, name, **starting
  price**, short description).
- **Product detail** (`/p/:slug`): breadcrumb (Home > Category > Product),
  image, description, features, and **denomination cards** (not dropdowns).
  Selecting a card updates price / stock / checkout data (HTMX or small JS).
  Buttons: **Buy Now**, **Add To Cart**.
- **Search** (`/search`): products only (matching "CapCut" → "CapCut Pro", never
  the plans). Variants chosen only inside product detail.
- **Cart / checkout**: line format `Product - Denomination ×qty` (e.g.
  `CapCut Pro - 1 Month ×1`). Guest cart cookie stores a **denomination id** —
  **version/namespace the cookie and invalidate old cookies at cutover** (old ids
  could otherwise resolve to wrong rows). `loadCartLines`/`computeTotals` and
  `createOrderFromCart` already key off the SKU = denomination, so mostly include
  + label changes.
- Switch routes/cards to `slug`-based URLs; update `_shop.njk` macros
  (`product_card`, new `denomination_card`, breadcrumb), `cards.ts` shaping.
  Add empty/loading states; keep responsive grid.

---

## Phase 4 — Telegram bot (`apps/order-bot`)

Simpler flow, **no category browsing**: Products list → Product → Denomination →
Checkout. Search is product names only.

- Replace the mixed `listCatalogEntries` rendering with a flat **product list**
  (`browseProductsFlat`), then product → **denomination picker**
  (`groupDenominationsKb` becomes the denomination chooser), then a detail bubble
  showing Product / Plan / Price / Stock with **Buy** + **Back**.
- Files: `handlers/customer.ts` (`browseProductsFlat`/`browseProduct`/
  `browseGroup` → product/denomination handlers), `handlers/callbacks.ts`
  (callback data `v1:browse:prod|denom|...`), `keyboards/customer.ts`,
  `util/format.ts`. Honor CLAUDE.md bot-UX rules (single-bubble edits,
  `smartEdit`, retire stale keyboards, toast vs alert, no leaked English — add/rename
  i18n keys in `packages/core/locales/{en,id}.json` keeping both key sets identical).

---

## Phase 5 — JSON API + final cleanup

- **New versioned JSON API** (e.g. `apps/storefront/src/routes/api.ts` under
  `/api/v1`, reusing the centralized crud — no duplicated business logic):
  `GET /categories`, `GET /categories/:slug/products`, `GET /products`,
  `GET /products/:slug`, `GET /products/:slug/denominations`, `POST /cart`,
  `POST /checkout`. Response shapes per spec (product includes `category` +
  `denominations[]`; denomination = `{id,name,price,stock,status}`). Add
  happy/validation/auth tests.
- **Remove old-architecture remnants**: delete the `@deprecated` crud wrappers
  and `CatalogEntry` shim once `grep` shows zero consumers; remove collapse /
  ungrouped logic, stale i18n keys, and any `reports.ts` query filtering
  denominations by a (now-removed) `category_id` directly (join via product).
- Final audit pass across pages / components / repositories / services / APIs /
  bot callbacks / stock + auto-delivery to confirm consistent
  Category → Product → Denomination everywhere.

---

## Verification

- **Per phase:** `pnpm typecheck` (`pnpm -r typecheck` + `tsc -p
  tsconfig.test.json`) and `pnpm test` (`vitest run`) must stay green. The
  `item.product → item.denomination` type churn will surface miswired call sites
  at compile time — lean on it.
- **Migration:** run the delta + slug script against a copy of `data/bot.db`;
  assert `PRAGMA foreign_key_check` empty, row-count parity, no null
  `product_id`/`slug`, every orphan wrapped, and a clean `prisma db push` dry-run
  (no diff vs schema). Confirm in-flight PENDING orders still resolve stock via
  `approveOrder`.
- **Admin/storefront:** boot `apps/server`, walk Category→Product→Denomination
  CRUD; place a storefront order end-to-end (add `Product - Denomination ×1`,
  checkout, verify stock decremented at approval). Use the `run`/`verify` skills.
- **Bot:** drive Products → Product → Denomination → Buy; confirm single-bubble
  edits and EN/ID parity.
- **API:** curl each endpoint; assert documented JSON shapes and that logic is
  the same crud used by HTML routes.
- **Deploy runbook:** stop process → backup DB+WAL → apply delta → slug script +
  indices → `prisma generate` → restart, in that exact order.

---

## Implementation note (deviation accepted 2026-06-19)

Phase 1b's migration was realized as a **TypeScript runner**
(`packages/db/src/migrate/catalogRename.ts`, executed by
`scripts/migrate-catalog-rename.ts`) operating on a `node:sqlite` DatabaseSync,
rather than a raw `prisma/migrations/<ts>_catalog_rename/migration.sql`. This
satisfies the plan's intent (hand-written, data-preserving, NOT `db push`) and
adds what a raw `.sql` file cannot have: a colocated parity test
(`catalogRename.test.ts`, 10 cases). Deploy runbook step "apply delta" becomes
`pnpm migrate-catalog-rename` followed by `pnpm backfill-catalog-slugs`.
