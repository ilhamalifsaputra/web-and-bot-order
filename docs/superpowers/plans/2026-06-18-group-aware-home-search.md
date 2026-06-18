# Group-aware Home & Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the storefront Home "Latest products" and Search show parent denomination groups (drill → denomination → order) instead of flat product variants, and relabel the admin grouping UI from "Group/Grup" to "Denominasi".

**Architecture:** Reuse the existing `CatalogEntry` engine and `_shop.njk` macros (already powering the category page). Add two read-only crud functions (`listNewestCatalogEntries`, `searchCatalogEntries`) that return the same `CatalogEntry[]` discriminated stream; add one shared storefront card-shaper (`cards.ts`); switch the Home and Search routes/templates to render group + product cards; rename admin Catalog UI strings (text only). No schema change.

**Tech Stack:** TypeScript, Prisma 5.22 over SQLite, Fastify + Nunjucks (storefront & web-admin), Vitest, pnpm workspaces.

## Global Constraints

- **No schema change** — `ProductGroup` table and `Product.productGroupId` already exist; display-layer only. No `prisma db push` on deploy.
- **No raw SQL in routes** — all data access goes through `packages/db/src/crud/*` helpers.
- **Money is Decimal** — never float; prices render via the storefront `idr`/`usdt(fx)` Nunjucks filters (already used by the existing macros). Do not introduce new price formatting.
- **Reuse existing macros** — `shop.group_card(g, fx, lang)` and `shop.product_card(p, fx, low, lang)` in `apps/storefront/views/_shop.njk`. No new card markup or CSS.
- **Collapse rules (already in `listCatalogEntries`)** — active group with ≥2 active members → group entry; group with exactly 1 active member → collapse to that product; empty/inactive group → hidden/flat; a grouped product never also appears as its own card.
- **Admin "Denominasi" is a UI-string change only** — do NOT rename the `product_group_id` form field, the `/catalog/group/*` routes, or any code identifier / DB column.
- `pnpm -r typecheck` and the full `npx vitest run` suite must stay green.
- Spec: `docs/superpowers/specs/2026-06-18-group-aware-home-search-design.md`.

---

### Task 1: crud `listNewestCatalogEntries`

**Files:**
- Modify: `packages/db/src/crud/catalog.ts` (add function after `listCatalogEntries`, end of file ~line 420)
- Test: `packages/db/src/crud/product_groups.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: existing `CatalogEntry` type and `Db` type from this file; Prisma `productGroup`/`product` models (each `Product` has a `createdAt: Date`).
- Produces: `listNewestCatalogEntries(db: Db, limit?: number): Promise<CatalogEntry[]>` — newest-first stream of group + product entries for the whole active catalog, capped at `limit` (default 12).

- [ ] **Step 1: Write the failing tests**

Append to `packages/db/src/crud/product_groups.test.ts`. First add the import (extend the existing import block from `./catalog`):

```ts
import {
  createGroup,
  deleteGroup,
  assignProductToGroup,
  listCatalogEntries,
  listNewestCatalogEntries,
  searchCatalogEntries,
  CategoryMismatchError,
} from "./catalog";
```

Then append at the end of the file (these new functions scan the whole catalog, so assert relative order / hard limits rather than absolute counts — the shared test DB holds rows from earlier tests):

```ts
describe("listNewestCatalogEntries", () => {
  it("ranks a group by its newest active member, above an older loose product", async () => {
    const cat = await makeCategory();
    const old = await makeProduct(cat.id, "Older Loose", "1 Month", "5");
    const group = await createGroup(prisma, { categoryId: cat.id, name: "Capcut" });
    const wk = await makeProduct(cat.id, "Capcut 7 day", "7 day", "10");
    const mo = await makeProduct(cat.id, "Capcut 1 Month", "1 Month", "30");
    await assignProductToGroup(prisma, wk.id, group.id);
    await assignProductToGroup(prisma, mo.id, group.id);

    const entries = await listNewestCatalogEntries(prisma, 50);
    const groupIdx = entries.findIndex((e) => e.kind === "group" && e.group.id === group.id);
    const looseIdx = entries.findIndex((e) => e.kind === "product" && e.product.id === old.id);
    expect(groupIdx).toBeGreaterThanOrEqual(0);
    expect(looseIdx).toBeGreaterThanOrEqual(0);
    expect(groupIdx).toBeLessThan(looseIdx); // group (newer member) ranks first
  });

  it("collapses a single-member group and honours the limit", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "Solo" });
    const only = await makeProduct(cat.id, "Solo 1 Month", "1 Month", "5");
    await assignProductToGroup(prisma, only.id, group.id);

    const entries = await listNewestCatalogEntries(prisma, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("product"); // newest row is the just-created Solo product
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @app/db exec vitest run src/crud/product_groups.test.ts`
Expected: FAIL — `listNewestCatalogEntries is not a function` / `searchCatalogEntries` import error.

- [ ] **Step 3: Implement `listNewestCatalogEntries`**

Append to `packages/db/src/crud/catalog.ts` (after `listCatalogEntries`):

```ts
/**
 * Newest catalog rows (groups + ungrouped products) for the storefront home
 * "latest" grid. Same collapse rules as listCatalogEntries, but ordered by
 * recency: a group ranks by its newest active member's createdAt, a product by
 * its own createdAt. Newest first, capped at `limit` cards.
 */
export async function listNewestCatalogEntries(db: Db, limit = 12): Promise<CatalogEntry[]> {
  const groups = await db.productGroup.findMany({
    where: { isActive: true },
    include: { products: { where: { isActive: true }, orderBy: { price: "asc" } } },
  });

  const groupedIds = new Set<number>();
  const ranked: Array<{ entry: CatalogEntry; recency: number }> = [];
  for (const g of groups) {
    const { products: members, ...group } = g;
    for (const m of members) groupedIds.add(m.id);
    if (members.length === 0) continue; // hide empty group
    const recency = Math.max(...members.map((m) => m.createdAt.getTime()));
    if (members.length === 1) ranked.push({ entry: { kind: "product", product: members[0]! }, recency });
    else ranked.push({ entry: { kind: "group", group, members }, recency });
  }

  const ungrouped = await db.product.findMany({
    where: { isActive: true, id: { notIn: [...groupedIds] } },
  });
  for (const p of ungrouped) {
    ranked.push({ entry: { kind: "product", product: p }, recency: p.createdAt.getTime() });
  }

  ranked.sort((a, b) => b.recency - a.recency);
  return ranked.slice(0, limit).map((r) => r.entry);
}
```

(`searchCatalogEntries` is added in Task 2; the test import references it, so Task 1's test run stays red on that symbol until Task 2 — that is expected. If you prefer a green Task 1 in isolation, temporarily drop `searchCatalogEntries` from the import and the `searchCatalogEntries` describe until Task 2. Simpler: do Step 1 of Task 2 now so both functions are imported together, then implement Task 1's function, then Task 2's.)

- [ ] **Step 4: Run the `listNewestCatalogEntries` tests**

Run: `pnpm --filter @app/db exec vitest run src/crud/product_groups.test.ts -t "listNewestCatalogEntries"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/catalog.ts packages/db/src/crud/product_groups.test.ts
git commit -m "feat(db): listNewestCatalogEntries for group-aware home"
```

---

### Task 2: crud `searchCatalogEntries`

**Files:**
- Modify: `packages/db/src/crud/catalog.ts` (add function after `listNewestCatalogEntries`)
- Test: `packages/db/src/crud/product_groups.test.ts` (append a new `describe`; import already extended in Task 1)

**Interfaces:**
- Consumes: `CatalogEntry`, `Db`; Prisma `product` (has `productGroupId: number | null`, `name`, `description`) and `productGroup`.
- Produces: `searchCatalogEntries(db: Db, query: string, limit?: number): Promise<CatalogEntry[]>` — search results where grouped matches collapse to group cards, ungrouped matches stay product cards, groups also match by name; sorted by display name asc, capped at `limit` (default 24); empty query → `[]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/db/src/crud/product_groups.test.ts`:

```ts
describe("searchCatalogEntries", () => {
  it("collapses a grouped denomination match into a group card", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "ZorroBrand" });
    const a = await makeProduct(cat.id, "ZorroBrand 1 Month", "1 Month", "30");
    const b = await makeProduct(cat.id, "ZorroBrand 7 day", "7 day", "10");
    await assignProductToGroup(prisma, a.id, group.id);
    await assignProductToGroup(prisma, b.id, group.id);

    const entries = await searchCatalogEntries(prisma, "ZorroBrand", 24);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("group");
    if (entries[0]!.kind !== "group") throw new Error("unreachable");
    expect(entries[0]!.group.id).toBe(group.id);
    expect(entries[0]!.members).toHaveLength(2);
  });

  it("keeps an ungrouped match as a product card", async () => {
    const cat = await makeCategory();
    const loose = await makeProduct(cat.id, "LonelyUnique", "1 Month", "5");
    const entries = await searchCatalogEntries(prisma, "LonelyUnique", 24);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("product");
    if (entries[0]!.kind !== "product") throw new Error("unreachable");
    expect(entries[0]!.product.id).toBe(loose.id);
  });

  it("matches a group by its name even when members don't match the query", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "QuokkaPack" });
    const a = await makeProduct(cat.id, "QuokkaBasic", "1 Month", "30");
    const b = await makeProduct(cat.id, "QuokkaPro", "7 day", "10");
    await assignProductToGroup(prisma, a.id, group.id);
    await assignProductToGroup(prisma, b.id, group.id);

    const entries = await searchCatalogEntries(prisma, "QuokkaPack", 24);
    expect(entries.some((e) => e.kind === "group" && e.group.id === group.id)).toBe(true);
  });

  it("returns [] for an empty query", async () => {
    expect(await searchCatalogEntries(prisma, "   ", 24)).toEqual([]);
  });
});
```

Note: the group-name test uses product names (`QuokkaBasic`/`QuokkaPro`) that all contain the query substring `Quokka` but NOT the full query `QuokkaPack`, so the match comes via the group name — keep the query as the full `QuokkaPack`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @app/db exec vitest run src/crud/product_groups.test.ts -t "searchCatalogEntries"`
Expected: FAIL — `searchCatalogEntries is not a function`.

- [ ] **Step 3: Implement `searchCatalogEntries`**

Append to `packages/db/src/crud/catalog.ts`:

```ts
/**
 * Search the catalog and return group + product rows. Matches active products by
 * name/description and active groups by name; a matched product that belongs to
 * an active group is shown as that group's card (full active members), so the
 * buyer picks the denomination next. Ungrouped matches (and members of an
 * inactive group) stay product cards. Single-member groups collapse to a
 * product. Sorted by display name asc, capped at `limit`.
 */
export async function searchCatalogEntries(db: Db, query: string, limit = 24): Promise<CatalogEntry[]> {
  const q = query.trim();
  if (!q) return [];

  const matchedProducts = await db.product.findMany({
    where: { isActive: true, OR: [{ name: { contains: q } }, { description: { contains: q } }] },
  });
  const groupsByName = await db.productGroup.findMany({
    where: { isActive: true, name: { contains: q } },
    select: { id: true },
  });

  // Active group ids to render as group cards: matched products' groups + name hits.
  const groupIds = new Set<number>();
  for (const p of matchedProducts) if (p.productGroupId != null) groupIds.add(p.productGroupId);
  for (const g of groupsByName) groupIds.add(g.id);

  const groups = groupIds.size
    ? await db.productGroup.findMany({
        where: { id: { in: [...groupIds] }, isActive: true },
        include: { products: { where: { isActive: true }, orderBy: { price: "asc" } } },
      })
    : [];

  const groupedIds = new Set<number>();
  const entries: CatalogEntry[] = [];
  for (const g of groups) {
    const { products: members, ...group } = g;
    for (const m of members) groupedIds.add(m.id);
    if (members.length === 0) continue;
    if (members.length === 1) entries.push({ kind: "product", product: members[0]! });
    else entries.push({ kind: "group", group, members });
  }

  // Matched products not represented by a shown group → product cards (no dupes).
  for (const p of matchedProducts) {
    if (groupedIds.has(p.id)) continue;
    entries.push({ kind: "product", product: p });
  }

  const nameOf = (e: CatalogEntry) => (e.kind === "group" ? e.group.name : e.product.name).toLowerCase();
  entries.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  return entries.slice(0, limit);
}
```

- [ ] **Step 4: Run the full crud test file**

Run: `pnpm --filter @app/db exec vitest run src/crud/product_groups.test.ts`
Expected: PASS (all existing + 4 new search + 2 new newest tests).

- [ ] **Step 5: Typecheck the db package**

Run: `pnpm --filter @app/db typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/crud/catalog.ts packages/db/src/crud/product_groups.test.ts
git commit -m "feat(db): searchCatalogEntries collapses grouped matches"
```

---

### Task 3: Shared storefront card shaper

**Files:**
- Create: `apps/storefront/src/cards.ts`

**Interfaces:**
- Consumes: `CatalogEntry` from `@app/db`; `productImage` from `./images`.
- Produces:
  - `type GroupCard = { id: number; name: string; emoji: string | null; from_price: string; count: number; image: string }`
  - `type ProductCard = { id: number; name: string; category_name: string; price: string; image: string; available: number; rating: number | null; rating_count: number; bulk_discount: string | null; bulk_min_qty: number | null }`
  - `shapeEntries(entries, catName, stock, ratings, bulk?): { groups: GroupCard[]; products: ProductCard[] }`
    - `catName: Map<number, string>` (categoryId → name)
    - `stock: Record<number, { available: number }>`
    - `ratings: Map<number, { avg: number | null; count: number }>`
    - `bulk: Record<number, { minQuantity: number; discountPercent: string }>` (optional, default `{}`)

- [ ] **Step 1: Create `apps/storefront/src/cards.ts`**

```ts
/**
 * Shared card-context shapers for the grid pages (home, category, search). A
 * storefront grid renders parent "group" cards (which drill into denominations
 * via /g/:id) plus plain "product" cards (/p/:id), both derived from the
 * CatalogEntry stream. Centralising the shaping keeps the three grids identical.
 */
import type { CatalogEntry } from "@app/db";
import { productImage } from "./images";

export type GroupCard = {
  id: number;
  name: string;
  emoji: string | null;
  from_price: string;
  count: number;
  image: string;
};

export type ProductCard = {
  id: number;
  name: string;
  category_name: string;
  price: string;
  image: string;
  available: number;
  rating: number | null;
  rating_count: number;
  bulk_discount: string | null;
  bulk_min_qty: number | null;
};

type StockMap = Record<number, { available: number }>;
type RatingMap = Map<number, { avg: number | null; count: number }>;
type BulkMap = Record<number, { minQuantity: number; discountPercent: string }>;

/** Split a CatalogEntry stream into the group + product card contexts a grid renders. */
export function shapeEntries(
  entries: CatalogEntry[],
  catName: Map<number, string>,
  stock: StockMap,
  ratings: RatingMap,
  bulk: BulkMap = {},
): { groups: GroupCard[]; products: ProductCard[] } {
  const groups: GroupCard[] = [];
  const products: ProductCard[] = [];
  for (const e of entries) {
    if (e.kind === "group") {
      const first = e.members[0]!; // members are price-asc → cheapest is "from"
      groups.push({
        id: e.group.id,
        name: e.group.name,
        emoji: e.group.emoji,
        from_price: first.price.toString(),
        count: e.members.length,
        image: e.group.webImageUrl ?? productImage(first, catName.get(first.categoryId) ?? ""),
      });
    } else {
      const p = e.product;
      const cn = catName.get(p.categoryId) ?? "";
      products.push({
        id: p.id,
        name: p.name,
        category_name: cn,
        price: p.price.toString(),
        image: productImage(p, cn),
        available: stock[p.id]?.available ?? 0,
        rating: ratings.get(p.id)?.avg ?? null,
        rating_count: ratings.get(p.id)?.count ?? 0,
        bulk_discount: bulk[p.id]?.discountPercent ?? null,
        bulk_min_qty: bulk[p.id]?.minQuantity ?? null,
      });
    }
  }
  return { groups, products };
}
```

- [ ] **Step 2: Typecheck the storefront package**

Run: `pnpm --filter @app/storefront typecheck`
Expected: no errors (the module is not yet imported anywhere — this just confirms it compiles).

- [ ] **Step 3: Commit**

```bash
git add apps/storefront/src/cards.ts
git commit -m "feat(storefront): shared shapeEntries card helper"
```

---

### Task 4: Home route + template group-aware

**Files:**
- Modify: `apps/storefront/src/routes/home.ts` (the `GET /` handler)
- Modify: `apps/storefront/views/home.njk` (section "produk", ~lines 152-160)
- Test: `apps/storefront/test/storefront.test.ts` (append to the `denomination groups` describe or add a new one)

**Interfaces:**
- Consumes: `listNewestCatalogEntries` (Task 1), `shapeEntries` (Task 3).
- Produces: the home view now receives `groups: GroupCard[]` in addition to `products: ProductCard[]`.

- [ ] **Step 1: Write the failing test**

Append to `apps/storefront/test/storefront.test.ts` inside `describe("denomination groups", …)` (after the existing group tests):

```ts
  it("home 'latest' shows a group card linking to /g/:id, not the denominations flat", async () => {
    const group = await prisma.productGroup.create({ data: { categoryId, name: "HomeBrand", isActive: true } });
    const d1 = await prisma.product.create({
      data: { categoryId, name: "HomeBrand 7 day", type: "SHARED", durationLabel: "7 day", price: "9000", productGroupId: group.id },
    });
    const d2 = await prisma.product.create({
      data: { categoryId, name: "HomeBrand 1 Month", type: "SHARED", durationLabel: "1 Month", price: "29000", productGroupId: group.id },
    });

    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`/g/${group.id}`);   // group card present
    expect(res.body).toContain("HomeBrand");
    expect(res.body).not.toContain(`/p/${d1.id}`);  // denominations are NOT shown flat on home
    expect(res.body).not.toContain(`/p/${d2.id}`);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @app/storefront exec vitest run test/storefront.test.ts -t "home 'latest' shows a group card"`
Expected: FAIL — body contains `/p/<id>` (home still flat) and no `/g/<id>`.

- [ ] **Step 3: Update the home route**

In `apps/storefront/src/routes/home.ts`:

1. Replace the `listNewestActiveProducts` import with `listNewestCatalogEntries` in the `@app/db` import block:

```ts
  listNewestCatalogEntries,
```

(remove the `listNewestActiveProducts,` line) and add the shaper import below the `images` import:

```ts
import { shapeEntries } from "../cards";
```

2. In the `GET /` handler, change the second Promise.all entry from `listNewestActiveProducts(prisma, 12)` to `listNewestCatalogEntries(prisma, 12)`, and rename the destructured `products` to `entries`:

```ts
    const [categories, entries, stock, ratings, bulk, reviews, rating, fulfil, waNumber, heroUrl] =
      await Promise.all([
        listActiveCategories(prisma),
        listNewestCatalogEntries(prisma, 12),
        stockStatusCounts(prisma),
        productRatingSummaries(prisma),
        activeBulkPricingByProduct(prisma),
        featuredReviews(prisma, 4),
        overallRating(prisma),
        shopFulfilmentStats(prisma),
        getSetting(prisma, "support_whatsapp"),
        getSetting(prisma, "web_hero_url"),
      ]);
```

3. Replace the `ratingByProduct` line and the `products: products.map(...)` block in the `reply.view("home.njk", …)` call. Build a `catName` map and shape the entries:

```ts
    const ratingByProduct = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
    const catName = new Map(categories.map((c) => [c.id, c.name]));
    const cards = shapeEntries(entries, catName, stock, ratingByProduct, bulk);
```

and in the `reply.view` context, replace the whole `products: products.map((p) => ({ … })),` block with:

```ts
      groups: cards.groups,
      products: cards.products,
```

Leave `categories`, `stats`, `testimonials`, `low_threshold`, `bot_username`, `wa_number`, `hero_image` unchanged. (The `testimonials` block still uses `reviews`/`rating` — keep it; `ratingByProduct` shape now exposes `.avg`/`.count`, which the home page no longer reads directly, so it is only consumed by `shapeEntries`.)

- [ ] **Step 4: Update the home template**

In `apps/storefront/views/home.njk`, replace the products grid (currently lines ~152-160):

```html
  {% if products.length %}
  <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
    {% for p in products %}
    {{ shop.product_card(p, fx, low_threshold, lang) }}
    {% endfor %}
  </div>
  {% else %}
  <div class="card card-pad text-center text-ink-faint py-14">{{ t('web.catalog_empty', lang) }}</div>
  {% endif %}
```

with (group cards first, then product cards — mirrors `catalog.njk`):

```html
  {% if groups.length or products.length %}
  <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
    {% for g in groups %}
    {{ shop.group_card(g, fx, lang) }}
    {% endfor %}
    {% for p in products %}
    {{ shop.product_card(p, fx, low_threshold, lang) }}
    {% endfor %}
  </div>
  {% else %}
  <div class="card card-pad text-center text-ink-faint py-14">{{ t('web.catalog_empty', lang) }}</div>
  {% endif %}
```

- [ ] **Step 5: Run the storefront home tests**

Run: `pnpm --filter @app/storefront exec vitest run test/storefront.test.ts -t "home"`
Expected: PASS — including the existing "renders the catalog with IDR prices" (ungrouped Netflix still shows as a product card) and the new group-card test.

- [ ] **Step 6: Typecheck the storefront package**

Run: `pnpm --filter @app/storefront typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/storefront/src/routes/home.ts apps/storefront/views/home.njk apps/storefront/test/storefront.test.ts
git commit -m "feat(storefront): group-aware home latest products"
```

---

### Task 5: Search route + template group-aware

**Files:**
- Modify: `apps/storefront/src/routes/catalog.ts` (the `GET /search` handler + imports)
- Modify: `apps/storefront/views/search.njk`
- Test: `apps/storefront/test/storefront.test.ts` (append to `describe("search + language", …)`)

**Interfaces:**
- Consumes: `searchCatalogEntries` (Task 2), `shapeEntries` (Task 3), `listActiveCategories`, `CatalogEntry` (type).
- Produces: the search view now receives `groups: GroupCard[]` in addition to `products: ProductCard[]`.

- [ ] **Step 1: Write the failing test**

Append inside `describe("search + language", …)` in `apps/storefront/test/storefront.test.ts`:

```ts
  it("collapses grouped denominations into a group card in search results", async () => {
    const group = await prisma.productGroup.create({ data: { categoryId, name: "SearchBrand", isActive: true } });
    const d1 = await prisma.product.create({
      data: { categoryId, name: "SearchBrand 7 day", type: "SHARED", durationLabel: "7 day", price: "9000", productGroupId: group.id },
    });
    await prisma.product.create({
      data: { categoryId, name: "SearchBrand 1 Month", type: "SHARED", durationLabel: "1 Month", price: "29000", productGroupId: group.id },
    });

    const res = await app.inject({ method: "GET", url: "/search?q=SearchBrand" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`/g/${group.id}`);  // group card
    expect(res.body).not.toContain(`/p/${d1.id}`); // not flat denominations
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @app/storefront exec vitest run test/storefront.test.ts -t "collapses grouped denominations into a group card in search"`
Expected: FAIL — body has `/p/<id>` and no `/g/<id>`.

- [ ] **Step 3: Update the search route**

In `apps/storefront/src/routes/catalog.ts`:

1. In the `@app/db` import block, add `searchCatalogEntries` and the `CatalogEntry` type; you may leave `searchProductsWithCategory` (still unused elsewhere) but prefer removing it if no longer referenced:

```ts
  searchCatalogEntries,
  type CatalogEntry,
```

2. Add the shaper import near the top (below the `shopContext` import):

```ts
import { shapeEntries } from "../cards";
```

3. Replace the `GET /search` handler body:

```ts
  // Search.
  app.get<{ Querystring: { q?: string } }>("/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    const ctx = await shopContext(req, "/search");
    const [entries, categories, stock, ratings, bulk] = await Promise.all([
      q ? searchCatalogEntries(prisma, q, 24) : Promise.resolve([] as CatalogEntry[]),
      listActiveCategories(prisma),
      stockStatusCounts(prisma),
      productRatingSummaries(prisma),
      activeBulkPricingByProduct(prisma),
    ]);
    const ratingByProduct = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
    const catName = new Map(categories.map((c) => [c.id, c.name]));
    const cards = shapeEntries(entries, catName, stock, ratingByProduct, bulk);
    return reply.view("search.njk", {
      ...ctx,
      q,
      groups: cards.groups,
      products: cards.products,
      low_threshold: config.LOW_STOCK_THRESHOLD,
    });
  });
```

(`listActiveCategories` is already imported in this file; `searchProductsWithCategory` and the `card(...)` helper may become unused — remove `searchProductsWithCategory` from the import if so. Leave the `card()` helper if the category route still uses it.)

- [ ] **Step 4: Update the search template**

Replace the body of `apps/storefront/views/search.njk` results section:

```html
{% if groups.length or products.length %}
<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
  {% for g in groups %}
  {{ shop.group_card(g, fx, lang) }}
  {% endfor %}
  {% for p in products %}
  {{ shop.product_card(p, fx, low_threshold, lang) }}
  {% endfor %}
</div>
{% else %}
<div class="card card-pad text-center py-14">
  <div class="text-ink-faint">{{ t('web.search_empty', lang) }}</div>
  <a href="/" class="btn btn-soft mt-4">{{ t('web.back_home', lang) }}</a>
</div>
{% endif %}
```

- [ ] **Step 5: Run the storefront search tests**

Run: `pnpm --filter @app/storefront exec vitest run test/storefront.test.ts -t "search"`
Expected: PASS — existing "finds products by name" (ungrouped Netflix still found as a product card), "empty state", and the new collapse test.

- [ ] **Step 6: Typecheck the storefront package**

Run: `pnpm --filter @app/storefront typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/storefront/src/routes/catalog.ts apps/storefront/views/search.njk apps/storefront/test/storefront.test.ts
git commit -m "feat(storefront): group-aware search results"
```

---

### Task 6: Admin "Denominasi" wording

**Files:**
- Modify: `apps/web-admin/views/catalog.njk` (text-only string changes)

**Interfaces:**
- Consumes: nothing new. No route, field, or identifier changes.
- Produces: admin Catalog UI reads "Denominasi" instead of "Group/Grup". No new exports.

- [ ] **Step 1: Apply the wording changes**

Make these exact replacements in `apps/web-admin/views/catalog.njk` (the `name="product_group_id"` field, `/catalog/group/*` actions, and `{% for g in groups %}` loops stay unchanged):

Line 6:
```html
{{ ui.page_header('Products', 'Group products into categories and set their prices.', 'package', 'products') }}
```
→
```html
{{ ui.page_header('Products', 'Atur produk per kategori, denominasi, dan harganya.', 'package', 'products') }}
```

Line 52:
```html
    <h2 class="section-title mb-3">Product Groups (denominations)</h2>
```
→
```html
    <h2 class="section-title mb-3">Denominasi</h2>
```

Line 56:
```html
        <tr><th>Group</th><th>Category</th><th>Members</th><th>Active</th><th></th></tr>
```
→
```html
        <tr><th>Denominasi</th><th>Category</th><th>Members</th><th>Active</th><th></th></tr>
```

Line 67:
```html
                  onsubmit="return confirm('Delete group? Products are kept.');">
```
→
```html
                  onsubmit="return confirm('Hapus denominasi? Produk tetap ada.');">
```

Line 74:
```html
        {{ ui.empty_row(5, 'No product groups yet.') }}
```
→
```html
        {{ ui.empty_row(5, 'Belum ada denominasi.') }}
```

Line 81:
```html
    <summary class="cursor-pointer font-medium text-sm text-pine">+ Add a group</summary>
```
→
```html
    <summary class="cursor-pointer font-medium text-sm text-pine">+ Tambah denominasi</summary>
```

Line 91:
```html
      <button class="btn btn-primary">Add group</button>
```
→
```html
      <button class="btn btn-primary">Tambah denominasi</button>
```

Line 96:
```html
  <p class="text-xs text-ink-faint">Untuk memasukkan produk ke grup: buka produk di <b>Items for sale</b> → <b>Edit</b> → pilih <b>Group</b>.</p>
```
→
```html
  <p class="text-xs text-ink-faint">Untuk memasukkan produk ke denominasi: buka produk di <b>Items for sale</b> → <b>Edit</b> → pilih <b>Denominasi</b>.</p>
```

Line 173:
```html
            {% if p.productGroup %}<span class="text-pine text-xs">· Grup: {{ p.productGroup.name }}</span>{% endif %}
```
→
```html
            {% if p.productGroup %}<span class="text-pine text-xs">· Denominasi: {{ p.productGroup.name }}</span>{% endif %}
```

Line 201:
```html
            <div><label class="field-label">Group (optional)</label>
```
→
```html
            <div><label class="field-label">Denominasi (opsional)</label>
```

Line 203:
```html
                <option value="">— No group —</option>
```
→
```html
                <option value="">— Tanpa denominasi —</option>
```

Line 208:
```html
              <p class="text-xs text-ink-faint mt-0.5">Kelompokkan denominasi (mis. semua varian Capcut) di bawah satu grup.</p></div>
```
→
```html
              <p class="text-xs text-ink-faint mt-0.5">Kelompokkan varian/denominasi (mis. semua varian Capcut) di bawah satu denominasi.</p></div>
```

- [ ] **Step 2: Typecheck web-admin (template-only, but confirm nothing else broke)**

Run: `pnpm --filter @app/web-admin typecheck`
Expected: no errors.

- [ ] **Step 3: Run the web-admin tests**

Run: `npx vitest run apps/web-admin/test/web.test.ts`
Expected: PASS (no test asserts the old wording; the dropdown/group behavior tests still pass).

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/views/catalog.njk
git commit -m "i18n(web-admin): label denominations 'Denominasi' in Catalog"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Whole-repo typecheck**

Run: `pnpm -r typecheck`
Expected: all 8 workspaces pass, no errors.

- [ ] **Step 2: Whole-repo test suite**

Run: `npx vitest run`
Expected: PASS — previous green count (513) + 6 new db crud tests + 2 new storefront tests = ~521. Zero failures.

- [ ] **Step 3: Manual smoke (optional, document result)**

Start the storefront dev server (`pnpm --filter @app/storefront dev`) and confirm:
- Home "Latest products" shows a **group card** (e.g. "Capcut · N options · from Rp…") linking to `/g/:id`, and ungrouped products still show as product cards.
- `/search?q=capcut` shows the Capcut group card, not flat denominations.
- `/c/:id` (category) unchanged.
- Admin `/catalog` reads "Denominasi" throughout.

No commit for this task.

---

## Self-Review

**1. Spec coverage:**
- Home group-aware → Task 1 (crud) + Task 4 (route/template/test). ✓
- Search group-aware, collapse to group card, match by group name → Task 2 + Task 5. ✓
- Newest ordering by group's newest member → Task 1 `listNewestCatalogEntries` recency. ✓
- Single-member group collapses; empty/inactive hidden/flat; no duplication → reused engine + covered in Task 1/2 tests. ✓
- Admin "Denominasi" wording, text only, no structural/identifier change → Task 6. ✓
- No schema change; deploy without `prisma db push` → Global Constraints + Task 7 note. ✓
- Tests + typecheck green → Task 7. ✓
- DRY shaping across home/search → Task 3 `shapeEntries`. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**3. Type consistency:**
- `listNewestCatalogEntries(db, limit?) → Promise<CatalogEntry[]>` — defined Task 1, consumed Task 4. ✓
- `searchCatalogEntries(db, query, limit?) → Promise<CatalogEntry[]>` — defined Task 2, consumed Task 5. ✓
- `shapeEntries(entries, catName, stock, ratings, bulk?) → { groups, products }` — defined Task 3, consumed Tasks 4 & 5 with matching arg types (`ratings` is `Map<number,{avg,count}>` built identically in both routes). ✓
- `CatalogEntry` imported from `@app/db` (re-exported via `export * from "./crud/catalog"`). ✓
- Group card context `{id,name,emoji,from_price,count,image}` matches `shop.group_card` expectations; product card context matches `shop.product_card`. ✓
