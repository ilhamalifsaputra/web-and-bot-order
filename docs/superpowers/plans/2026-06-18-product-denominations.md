# Product Denominations (Product Groups) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group product denominations (e.g. Capcut → 1 Month / 7 day) under an optional parent across the web-admin, bot, and storefront, without moving stock off `Product`.

**Architecture:** A new `ProductGroup` table is the parent; `Product` gains a nullable `productGroupId` and stays the stock-holding sellable unit (one denomination = one `Product`). Grouping is a pure display/navigation layer — a single crud helper `listCatalogEntries` returns a mixed list of group entries and ungrouped product entries that every customer surface renders. No changes to `StockItem`/`OrderItem`/`CartItem`/`Review`.

**Tech Stack:** TypeScript monorepo (pnpm workspaces), Prisma 5 over shared SQLite, Fastify + Nunjucks (web-admin, storefront), grammY (order-bot), Vitest.

## Global Constraints

- **Decimal for all money** (`@app/core/money`) — never float. Web uses the `money` Nunjucks filter; bot uses `formatPrice`.
- **No raw SQL in routes/handlers** — all DB logic lives in `packages/db/src/crud/*` with Vitest coverage.
- **Audit every state change** via `logAdminAction(prisma, { adminId, action, targetType, targetId, details })`.
- **Keep each `$transaction` short** (shared SQLite is single-writer).
- **CSRF**: every mutating web route uses the `csrfProtect` preHandler; reads use `currentAdmin`. Every new mutating route gets the happy / auth-fail / bad-csrf test trio.
- **No leaked English in the bot** — customer strings go through `t(ctx, key, args)` against `packages/core/locales/{en,id}.json`; keep both files' key sets identical with matched `{placeholders}`.
- **Schema change on deploy**: apply migration (`pnpm prisma db push`) and restart order-bot **before** new code runs (avoids `P2022`).
- **DO NOT rename existing columns/types** — the SQLite schema is shared byte-for-byte. New table/columns only.
- `pnpm -r typecheck` and `pnpm test` must stay green.

---

### Task 1: Schema — `ProductGroup` table + `Product.productGroupId`

**Files:**
- Modify: `prisma/schema.prisma` (add `ProductGroup` model; add fields/relation to `Product`; add back-relation to `Category`)

**Interfaces:**
- Produces: Prisma models `ProductGroup` (table `product_groups`) and `Product.productGroupId` / `Product.productGroup`, available to all later tasks via the generated client.

- [ ] **Step 1: Add the `ProductGroup` model**

In `prisma/schema.prisma`, after the `Category` model (around line 113), add:

```prisma
/// Optional parent for product denominations (e.g. "Capcut" → 1 Month / 7 day).
/// Display/navigation only — each member Product keeps its own price & stock.
/// A group lives in exactly one category; all members must share that category.
model ProductGroup {
  id          Int      @id @default(autoincrement())
  categoryId  Int      @map("category_id")
  name        String
  emoji       String?
  description String?
  webImageUrl String?  @map("web_image_url")
  imageFileId String?  @map("image_file_id")
  sortOrder   Int      @default(0) @map("sort_order")
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at")

  category Category  @relation(fields: [categoryId], references: [id], onUpdate: NoAction)
  products Product[]

  @@index([categoryId], map: "ix_product_groups_category_id")
  @@map("product_groups")
}
```

- [ ] **Step 2: Add the back-relation on `Category`**

In the `Category` model, alongside `products Product[]` (line ~110), add:

```prisma
  groups   ProductGroup[]
```

- [ ] **Step 3: Add the nullable FK on `Product`**

In the `Product` model, after `bulkPricing BulkPricing?` (line ~139), add the relation field, and after the `createdAt` scalar add the FK column:

```prisma
  // scalar column (place with the other @map scalars, after createdAt):
  productGroupId Int?     @map("product_group_id")
```
```prisma
  // relation (place with the other relations, after bulkPricing):
  productGroup ProductGroup? @relation(fields: [productGroupId], references: [id], onUpdate: NoAction)
```
And add the index inside the `Product` block, next to the existing `@@index([categoryId], ...)`:
```prisma
  @@index([productGroupId], map: "ix_products_product_group_id")
```

- [ ] **Step 4: Regenerate the client and push to a scratch DB to validate**

Run: `pnpm prisma generate`
Expected: "Generated Prisma Client" with no schema errors.

Run: `pnpm prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀"

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): add ProductGroup model + Product.productGroupId (denominations)"
```

> **Deploy note (record in PR description, do not run here):** before deploying the new code, run `pnpm prisma db push` against the live DB and restart order-bot first.

---

### Task 2: CRUD helpers + `listCatalogEntries`

**Files:**
- Modify: `packages/db/src/crud/catalog.ts` (append a "Product groups" section)
- Test: `packages/db/src/crud/product_groups.test.ts` (create)

**Interfaces:**
- Consumes: Prisma models from Task 1; existing `Db` type from `./_types`; `quantizeMoney` is not needed (no money fields here).
- Produces (all exported from the `@app/db` barrel via `crud/catalog`):
  - `type CatalogEntry = { kind: "group"; group: ProductGroup; members: Product[] } | { kind: "product"; product: Product }`
  - `class CategoryMismatchError extends Error`
  - `createGroup(db, args: { categoryId: number; name: string; emoji?: string | null; description?: string | null; webImageUrl?: string | null; imageFileId?: string | null; sortOrder?: number }): Promise<ProductGroup>`
  - `updateGroup(db, groupId: number, fields: Record<string, unknown>): Promise<void>`
  - `deleteGroup(db, groupId: number): Promise<void>`
  - `assignProductToGroup(db, productId: number, groupId: number | null): Promise<void>`
  - `listAllGroups(db): Promise<Array<ProductGroup & { category: Category; _count: { products: number } }>>`
  - `getGroupWithActiveProducts(db, groupId: number): Promise<(ProductGroup & { products: Product[] }) | null>`
  - `listCatalogEntries(db, categoryId?: number): Promise<CatalogEntry[]>`

- [ ] **Step 1: Write the failing test file**

Create `packages/db/src/crud/product_groups.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  createGroup,
  deleteGroup,
  assignProductToGroup,
  listCatalogEntries,
  CategoryMismatchError,
} from "./catalog";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

async function makeCategory() {
  return prisma.category.create({ data: { name: `c${Math.random()}` } });
}
async function makeProduct(categoryId: number, name: string, duration: string, price: string) {
  return prisma.product.create({
    data: { categoryId, name, type: "SHARED", durationLabel: duration, price },
  });
}

describe("assignProductToGroup", () => {
  it("links a product whose category matches the group", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "Capcut" });
    const p = await makeProduct(cat.id, "Capcut 1 Month", "1 Month", "5");
    await assignProductToGroup(prisma, p.id, group.id);
    const fresh = await prisma.product.findUnique({ where: { id: p.id } });
    expect(fresh!.productGroupId).toBe(group.id);
  });

  it("rejects a product from a different category", async () => {
    const catA = await makeCategory();
    const catB = await makeCategory();
    const group = await createGroup(prisma, { categoryId: catA.id, name: "G" });
    const p = await makeProduct(catB.id, "X", "1 Month", "5");
    await expect(assignProductToGroup(prisma, p.id, group.id)).rejects.toBeInstanceOf(
      CategoryMismatchError,
    );
  });

  it("unlinks when groupId is null", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "G2" });
    const p = await makeProduct(cat.id, "Y", "1 Month", "5");
    await assignProductToGroup(prisma, p.id, group.id);
    await assignProductToGroup(prisma, p.id, null);
    const fresh = await prisma.product.findUnique({ where: { id: p.id } });
    expect(fresh!.productGroupId).toBeNull();
  });
});

describe("deleteGroup", () => {
  it("unlinks members but keeps the products", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "G3" });
    const p = await makeProduct(cat.id, "Z", "1 Month", "5");
    await assignProductToGroup(prisma, p.id, group.id);
    await deleteGroup(prisma, group.id);
    expect(await prisma.productGroup.findUnique({ where: { id: group.id } })).toBeNull();
    const fresh = await prisma.product.findUnique({ where: { id: p.id } });
    expect(fresh).not.toBeNull();
    expect(fresh!.productGroupId).toBeNull();
  });
});

describe("listCatalogEntries", () => {
  it("emits a group with >=2 active members, sorted by member price asc", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "Capcut" });
    const month = await makeProduct(cat.id, "Capcut 1 Month", "1 Month", "30");
    const week = await makeProduct(cat.id, "Capcut 7 day", "7 day", "10");
    await assignProductToGroup(prisma, month.id, group.id);
    await assignProductToGroup(prisma, week.id, group.id);

    const entries = await listCatalogEntries(prisma, cat.id);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.kind).toBe("group");
    if (e.kind !== "group") throw new Error("unreachable");
    expect(e.group.name).toBe("Capcut");
    expect(e.members.map((m) => m.id)).toEqual([week.id, month.id]); // 10 before 30
  });

  it("collapses a single-active-member group to a product entry", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "Solo" });
    const only = await makeProduct(cat.id, "Solo 1 Month", "1 Month", "5");
    await assignProductToGroup(prisma, only.id, group.id);

    const entries = await listCatalogEntries(prisma, cat.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("product");
  });

  it("hides empty/inactive groups and lists ungrouped active products", async () => {
    const cat = await makeCategory();
    const empty = await createGroup(prisma, { categoryId: cat.id, name: "Empty" });
    expect(empty).toBeTruthy();
    const loose = await makeProduct(cat.id, "Loose", "1 Month", "5");
    void loose;

    const entries = await listCatalogEntries(prisma, cat.id);
    expect(entries.map((e) => e.kind)).toEqual(["product"]); // empty group hidden, loose product shown
  });

  it("treats members of an inactive group as ungrouped (flat fallback)", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "Off" });
    const a = await makeProduct(cat.id, "Off A", "1 Month", "5");
    const b = await makeProduct(cat.id, "Off B", "7 day", "3");
    await assignProductToGroup(prisma, a.id, group.id);
    await assignProductToGroup(prisma, b.id, group.id);
    await prisma.productGroup.update({ where: { id: group.id }, data: { isActive: false } });

    const entries = await listCatalogEntries(prisma, cat.id);
    expect(entries.every((e) => e.kind === "product")).toBe(true);
    expect(entries).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @app/db test product_groups`
Expected: FAIL — `createGroup`/`listCatalogEntries`/etc. are not exported from `./catalog`.

- [ ] **Step 3: Implement the helpers**

Append to `packages/db/src/crud/catalog.ts` (after the bulk-pricing section). Add the type imports at the top of the file (the file currently imports only value modules):

```ts
import type { Category, Product, ProductGroup } from "@prisma/client";
```

Then append:

```ts
// ---- Product groups (denominations) ----

/** Discriminated catalog row used by every customer surface. */
export type CatalogEntry =
  | { kind: "group"; group: ProductGroup; members: Product[] }
  | { kind: "product"; product: Product };

/** Thrown when assigning a product to a group in a different category. */
export class CategoryMismatchError extends Error {
  constructor() {
    super("product and group must share the same category");
    this.name = "CategoryMismatchError";
  }
}

export function createGroup(
  db: Db,
  args: {
    categoryId: number;
    name: string;
    emoji?: string | null;
    description?: string | null;
    webImageUrl?: string | null;
    imageFileId?: string | null;
    sortOrder?: number;
  },
) {
  return db.productGroup.create({
    data: {
      categoryId: args.categoryId,
      name: args.name,
      emoji: args.emoji ?? null,
      description: args.description ?? null,
      webImageUrl: args.webImageUrl ?? null,
      imageFileId: args.imageFileId ?? null,
      sortOrder: args.sortOrder ?? 0,
    },
  });
}

export async function updateGroup(db: Db, groupId: number, fields: Record<string, unknown>) {
  if (Object.keys(fields).length === 0) return;
  await db.productGroup.update({ where: { id: groupId }, data: fields });
}

/** Delete a group, unlinking its members first (products survive). */
export async function deleteGroup(db: Db, groupId: number): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.product.updateMany({ where: { productGroupId: groupId }, data: { productGroupId: null } });
    await tx.productGroup.delete({ where: { id: groupId } });
  });
}

/**
 * Link a product to a group (or unlink when groupId is null). Enforces the
 * invariant that a grouped product shares the group's category.
 */
export async function assignProductToGroup(
  db: Db,
  productId: number,
  groupId: number | null,
): Promise<void> {
  if (groupId !== null) {
    const [product, group] = await Promise.all([
      db.product.findUnique({ where: { id: productId } }),
      db.productGroup.findUnique({ where: { id: groupId } }),
    ]);
    if (!product || !group) throw new Error("product or group not found");
    if (product.categoryId !== group.categoryId) throw new CategoryMismatchError();
  }
  await db.product.update({ where: { id: productId }, data: { productGroupId: groupId } });
}

/** All groups (active + inactive) with category + member count — admin list. */
export function listAllGroups(db: Db) {
  return db.productGroup.findMany({
    include: { category: true, _count: { select: { products: true } } },
    orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
}

/** A group with its active members ordered by price asc (denomination picker). */
export function getGroupWithActiveProducts(db: Db, groupId: number) {
  return db.productGroup.findUnique({
    where: { id: groupId },
    include: { products: { where: { isActive: true }, orderBy: { price: "asc" } } },
  });
}

/**
 * Mixed, ordered catalog rows for a category (or the whole catalog when
 * categoryId is omitted). Rules:
 *  - active groups with >=1 active member; empty/inactive groups dropped
 *  - a group with exactly one active member is emitted as that product (collapse)
 *  - active products with no group (or in an inactive group) are emitted as products
 * Final order: by display name, case-insensitive ascending (group.name / product.name).
 */
export async function listCatalogEntries(db: Db, categoryId?: number): Promise<CatalogEntry[]> {
  const groups = await db.productGroup.findMany({
    where: { isActive: true, ...(categoryId != null ? { categoryId } : {}) },
    include: { products: { where: { isActive: true }, orderBy: { price: "asc" } } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  const groupedIds = new Set<number>();
  const entries: CatalogEntry[] = [];
  for (const g of groups) {
    const { products: members, ...group } = g;
    for (const m of members) groupedIds.add(m.id);
    if (members.length === 0) continue; // hide empty group
    if (members.length === 1) entries.push({ kind: "product", product: members[0]! }); // collapse
    else entries.push({ kind: "group", group, members });
  }

  const ungrouped = await db.product.findMany({
    where: {
      isActive: true,
      ...(categoryId != null ? { categoryId } : {}),
      id: { notIn: [...groupedIds] },
    },
    orderBy: { name: "asc" },
  });
  for (const p of ungrouped) entries.push({ kind: "product", product: p });

  const nameOf = (e: CatalogEntry) => (e.kind === "group" ? e.group.name : e.product.name).toLowerCase();
  entries.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  return entries;
}
```

Note: the unused `Category` import is consumed by the `listAllGroups` return type inference; keep it.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @app/db test product_groups`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck the package**

Run: `pnpm --filter @app/db typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/crud/catalog.ts packages/db/src/crud/product_groups.test.ts
git commit -m "feat(db): product-group crud + listCatalogEntries (denominations)"
```

---

### Task 3: Web-admin — manage groups & assign products

**Files:**
- Modify: `apps/web-admin/src/routes/catalog.ts` (add group routes + pass groups to the catalog view)
- Modify: `apps/web-admin/views/catalog.njk` (add a "Groups" section)
- Test: `apps/web-admin/test/web.test.ts` (add a `describe("product groups", …)` block)

**Interfaces:**
- Consumes: `createGroup`, `updateGroup`, `deleteGroup`, `assignProductToGroup`, `listAllGroups`, `CategoryMismatchError` from Task 2; existing `currentAdmin`, `csrfProtect`, `redirectWithFlash`, `logAdminAction`.
- Produces: POST routes `/catalog/group`, `/catalog/group/:groupId/update`, `/catalog/group/:groupId/delete`, `/catalog/group/:groupId/assign`.

- [ ] **Step 1: Write the failing route tests**

In `apps/web-admin/test/web.test.ts`, add after the `describe("catalog", …)` block (ends ~line 457):

```ts
describe("product groups", () => {
  it("create group happy + audit", async () => {
    const product = await prisma.product.findUnique({ where: { id: seed.productId } });
    const res = await post("/catalog/group", seed.cookie, {
      csrf_token: seed.csrf,
      category_id: String(product!.categoryId),
      name: "Capcut",
      emoji: "🎬",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const groups = await prisma.productGroup.findMany({ where: { name: "Capcut" } });
    expect(groups.length).toBe(1);
    const audit = await prisma.auditLog.findMany({ where: { action: "group_create" } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("assign product to a same-category group", async () => {
    const product = await prisma.product.findUnique({ where: { id: seed.productId } });
    const group = await prisma.productGroup.create({
      data: { categoryId: product!.categoryId, name: "Grp" },
    });
    const res = await post(`/catalog/group/${group.id}/assign`, seed.cookie, {
      csrf_token: seed.csrf,
      ids: String(seed.productId),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const fresh = await prisma.product.findUnique({ where: { id: seed.productId } });
    expect(fresh!.productGroupId).toBe(group.id);
  });

  it("assign rejects a cross-category product with a flash error", async () => {
    const otherCat = await prisma.category.create({ data: { name: `Other${counter++}` } });
    const group = await prisma.productGroup.create({ data: { categoryId: otherCat.id, name: "XCat" } });
    const res = await post(`/catalog/group/${group.id}/assign`, seed.cookie, {
      csrf_token: seed.csrf,
      ids: String(seed.productId),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    const fresh = await prisma.product.findUnique({ where: { id: seed.productId } });
    expect(fresh!.productGroupId).toBeNull();
  });

  it("delete group unlinks members", async () => {
    const product = await prisma.product.findUnique({ where: { id: seed.productId } });
    const group = await prisma.productGroup.create({ data: { categoryId: product!.categoryId, name: "Del" } });
    await prisma.product.update({ where: { id: seed.productId }, data: { productGroupId: group.id } });
    const res = await post(`/catalog/group/${group.id}/delete`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect(await prisma.productGroup.findUnique({ where: { id: group.id } })).toBeNull();
    const fresh = await prisma.product.findUnique({ where: { id: seed.productId } });
    expect(fresh!.productGroupId).toBeNull();
  });

  it("create group requires auth", async () => {
    const res = await post("/catalog/group", null, { csrf_token: "x", name: "Nope", category_id: "1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("create group rejects bad CSRF", async () => {
    const res = await post("/catalog/group", seed.cookie, { csrf_token: "bad", name: "Nope", category_id: "1" });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm --filter @app/web-admin test -- -t "product groups"`
Expected: FAIL — routes return 404 / not registered.

- [ ] **Step 3: Add the imports and group routes**

In `apps/web-admin/src/routes/catalog.ts`, extend the `@app/db` import block (lines 12-29) with:

```ts
  listAllGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  assignProductToGroup,
  CategoryMismatchError,
```

In the `GET /catalog` handler, fetch groups and pass them to the view. After `const rules = await listBulkPricingRules(prisma);` (line 142) add:

```ts
    const groups = await listAllGroups(prisma);
```
and add `groups,` to the `reply.view("catalog.njk", { … })` object (after `rules_by_product: rulesByProduct,`).

Then add these routes inside `catalogRoutes`, before the final closing brace (after the bulk-pricing route ~line 495):

```ts
  // ---- Product groups (denominations) ----
  app.post("/catalog/group", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const name = (body.name ?? "").trim();
    const categoryId = Number(body.category_id);
    if (!name || !Number.isInteger(categoryId) || categoryId <= 0) {
      return redirectWithFlash(reply, "/catalog", "Group name and category are required.", "error");
    }
    const group = await createGroup(prisma, {
      categoryId,
      name,
      emoji: (body.emoji ?? "").trim() || null,
      description: (body.description ?? "").trim() || null,
      webImageUrl: (body.web_image_url ?? "").trim() || null,
      sortOrder: Number(body.sort_order) || 0,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "group_create",
      targetType: "product_group",
      targetId: group.id,
      details: `name=${name}`,
    });
    return redirectWithFlash(reply, "/catalog", `Group '${name}' created.`, "success");
  });

  app.post("/catalog/group/:groupId/update", { preHandler: csrfProtect }, async (req, reply) => {
    const groupId = Number((req.params as { groupId: string }).groupId);
    const body = (req.body ?? {}) as Record<string, string>;
    const name = (body.name ?? "").trim();
    if (!name) return redirectWithFlash(reply, "/catalog", "Group name is required.", "error");
    await updateGroup(prisma, groupId, {
      name,
      emoji: (body.emoji ?? "").trim() || null,
      description: (body.description ?? "").trim() || null,
      webImageUrl: (body.web_image_url ?? "").trim() || null,
      sortOrder: Number(body.sort_order) || 0,
      isActive: truthy(body.is_active),
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "group_update",
      targetType: "product_group",
      targetId: groupId,
      details: `name=${name}`,
    });
    return redirectWithFlash(reply, "/catalog", "Group updated.", "success");
  });

  app.post("/catalog/group/:groupId/delete", { preHandler: csrfProtect }, async (req, reply) => {
    const groupId = Number((req.params as { groupId: string }).groupId);
    await deleteGroup(prisma, groupId);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "group_delete",
      targetType: "product_group",
      targetId: groupId,
    });
    return redirectWithFlash(reply, "/catalog", "Group deleted (products kept).", "success");
  });

  // Assign/unassign products to a group. `ids` is the comma-separated selection;
  // products NOT in the list are unlinked from this group, so the form is the
  // full membership state. Cross-category picks are rejected as a group.
  app.post("/catalog/group/:groupId/assign", { preHandler: csrfProtect }, async (req, reply) => {
    const groupId = Number((req.params as { groupId: string }).groupId);
    const body = (req.body ?? {}) as Record<string, string>;
    const ids = parseIds(body.ids);
    try {
      // Unlink anything currently in the group but not re-selected.
      const current = await prisma.product.findMany({ where: { productGroupId: groupId }, select: { id: true } });
      for (const c of current) {
        if (!ids.includes(c.id)) await assignProductToGroup(prisma, c.id, null);
      }
      for (const id of ids) await assignProductToGroup(prisma, id, groupId);
    } catch (err) {
      if (err instanceof CategoryMismatchError) {
        return redirectWithFlash(reply, "/catalog", "All products must be in the group's category.", "error");
      }
      throw err;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "group_assign",
      targetType: "product_group",
      targetId: groupId,
      details: `ids=${ids.join("|").slice(0, 180)}`,
    });
    return redirectWithFlash(reply, "/catalog", "Group membership updated.", "success");
  });
```

- [ ] **Step 4: Add the Groups UI to the catalog view**

In `apps/web-admin/views/catalog.njk`, add a section (place it near the categories/products sections — match the file's existing card/table markup and CSRF hidden-field pattern). Minimum functional markup:

```html
<section class="card">
  <h2>Product Groups (denominations)</h2>
  <table>
    <thead><tr><th>Group</th><th>Category</th><th>Members</th><th>Active</th></tr></thead>
    <tbody>
      {% for g in groups %}
        <tr>
          <td>{{ g.emoji }} {{ g.name }}</td>
          <td>{{ g.category.name }}</td>
          <td>{{ g._count.products }}</td>
          <td>{{ "yes" if g.isActive else "no" }}</td>
          <td>
            <form method="post" action="/catalog/group/{{ g.id }}/delete"
                  onsubmit="return confirm('Delete group? Products are kept.');">
              <input type="hidden" name="csrf_token" value="{{ admin.csrf }}">
              <button type="submit">Delete</button>
            </form>
          </td>
        </tr>
      {% endfor %}
    </tbody>
  </table>

  <h3>New group</h3>
  <form method="post" action="/catalog/group">
    <input type="hidden" name="csrf_token" value="{{ admin.csrf }}">
    <input name="name" placeholder="e.g. Capcut" required>
    <input name="emoji" placeholder="emoji (optional)">
    <select name="category_id" required>
      {% for c in categories %}<option value="{{ c.id }}">{{ c.name }}</option>{% endfor %}
    </select>
    <input name="sort_order" type="number" value="0">
    <button type="submit">Create group</button>
  </form>

  <h3>Assign products</h3>
  <form method="post" action="" id="assign-group-form"
        onsubmit="this.action='/catalog/group/' + this.group_id.value + '/assign';">
    <input type="hidden" name="csrf_token" value="{{ admin.csrf }}">
    <select name="group_id" required>
      {% for g in groups %}<option value="{{ g.id }}">{{ g.name }} ({{ g.category.name }})</option>{% endfor %}
    </select>
    <p>Comma-separated product ids in this group's category:</p>
    <input name="ids" placeholder="e.g. 12,13,14">
    <button type="submit">Save membership</button>
  </form>
</section>
```

(The `ids` text field mirrors the existing bulk-select hidden-field convention parsed by `parseIds`. A richer multi-select can replace it later without route changes.)

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `pnpm --filter @app/web-admin test -- -t "product groups"`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @app/web-admin typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web-admin/src/routes/catalog.ts apps/web-admin/views/catalog.njk apps/web-admin/test/web.test.ts
git commit -m "feat(web): manage product groups + assign products (denominations)"
```

---

### Task 4: Bot — group-aware browse + denomination picker

**Files:**
- Modify: `apps/order-bot/src/keyboards/customer.ts` (add `groupDenominationsKb`)
- Modify: `apps/order-bot/src/handlers/customer.ts` (group-aware `browseProductsFlat`, snapshot, `browseGroup`)
- Modify: `apps/order-bot/src/handlers/callbacks.ts` (route `browse:group:<id>`)
- Modify: `packages/core/locales/en.json` and `packages/core/locales/id.json` (new browse keys)
- Test: `apps/order-bot/test/handlers.test.ts` (group browse + picker)

**Interfaces:**
- Consumes: `listCatalogEntries`, `getGroupWithActiveProducts` from Task 2; existing `browseProduct`, `smartEdit`, `renderMenuBanner`, `cb`, `formatPrice`.
- Produces: `groupDenominationsKb(members, lang)` keyboard; `browseGroup(ctx, groupId)` handler; extended `BrowseScratch.browseEntries`.

- [ ] **Step 1: Add locale keys (both files, identical keys)**

In `packages/core/locales/en.json`, add to the `browse.*` block:

```json
  "browse.choose_denomination": "<b>{name}</b>\n\nChoose a plan:",
  "browse.denomination_btn": "{duration} — {price}",
```

In `packages/core/locales/id.json`, add the same keys with Indonesian copy:

```json
  "browse.choose_denomination": "<b>{name}</b>\n\nPilih paket:",
  "browse.denomination_btn": "{duration} — {price}",
```

- [ ] **Step 2: Write the failing keyboard + handler tests**

In `apps/order-bot/test/handlers.test.ts`, add a new `describe` block (after the existing browse tests, ~line 140). It builds a group with two members and asserts the picker:

```ts
import { groupDenominationsKb } from "../src/keyboards/customer";

describe("denomination groups", () => {
  async function makeGroupWithTwo() {
    const cat = await prisma.category.create({ data: { name: `gc${Math.random()}` } });
    const group = await prisma.productGroup.create({ data: { categoryId: cat.id, name: "Capcut" } });
    const m1 = await prisma.product.create({
      data: { categoryId: cat.id, name: "Capcut 7 day", type: "SHARED", durationLabel: "7 day", price: "10", productGroupId: group.id },
    });
    const m2 = await prisma.product.create({
      data: { categoryId: cat.id, name: "Capcut 1 Month", type: "SHARED", durationLabel: "1 Month", price: "30", productGroupId: group.id },
    });
    return { group, m1, m2 };
  }

  it("groupDenominationsKb renders one button per member + back", () => {
    const kb = groupDenominationsKb(
      [
        { id: 1, name: "A", durationLabel: "7 day", price: "10" },
        { id: 2, name: "B", durationLabel: "1 Month", price: "30" },
      ],
      "en",
    );
    const flat = kb.inline_keyboard.flat();
    expect(flat.some((b) => b.callback_data === "v1:browse:prod:1")).toBe(true);
    expect(flat.some((b) => b.callback_data === "v1:browse:prod:2")).toBe(true);
    expect(flat.some((b) => b.callback_data === "v1:browse:prods")).toBe(true); // back
  });

  it("browseGroup shows the denomination picker for the group", async () => {
    const { group, m1 } = await makeGroupWithTwo();
    const { ctx, sink } = customerCtx();
    await customer.browseGroup(ctx, group.id);
    expect(sentIncludes(sink, "Capcut")).toBe(true);
    // members reachable via browse:prod buttons
    const sent = sink as SentCall[];
    const markup = JSON.stringify(sent.map((c) => c.other?.reply_markup ?? {}));
    expect(markup).toContain(`v1:browse:prod:${m1.id}`);
  });

  it("browseProductsFlat records a group entry and the number opens the picker", async () => {
    const { group } = await makeGroupWithTwo();
    const { ctx } = customerCtx();
    await customer.browseProductsFlat(ctx);
    const entries = (ctx.session.scratch as { browseEntries?: Array<{ kind: string; id: number }> }).browseEntries ?? [];
    expect(entries.some((e) => e.kind === "group" && e.id === group.id)).toBe(true);
  });
});
```

(If `customerCtx`/`sink` differ in arity, mirror the existing browse tests at lines 99-136 of the same file.)

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `pnpm --filter @app/order-bot test -- -t "denomination groups"`
Expected: FAIL — `groupDenominationsKb` / `browseGroup` not defined.

- [ ] **Step 4: Add the `groupDenominationsKb` keyboard**

In `apps/order-bot/src/keyboards/customer.ts`, after `productDetailKb` (~line 257), add:

```ts
interface DenominationLike {
  id: number;
  name: string;
  durationLabel: string;
  price: Decimal.Value;
}

/** Picker shown when a customer taps a product group: one button per member. */
export function groupDenominationsKb(members: DenominationLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = members.map((m) => [
    {
      text: coreT("browse.denomination_btn", lang, {
        duration: m.durationLabel || m.name,
        price: formatPrice(m.price),
      }),
      data: cb("browse", "prod", m.id),
    },
  ]);
  rows.push([{ text: coreT("menu.back", lang), data: cb("browse", "prods") }]);
  return ik(rows);
}
```

- [ ] **Step 5: Make browse group-aware in the handler**

In `apps/order-bot/src/handlers/customer.ts`:

(a) Extend the scratch interface (lines 56-60):

```ts
interface BrowseScratch {
  browsePage?: number;
  browseProductIds?: number[];
  browseEntries?: Array<{ kind: "group" | "product"; id: number }>;
  viewingProductId?: number;
}
```

(b) Add imports near the existing `@app/db` imports: `listCatalogEntries`, `getGroupWithActiveProducts`, and the keyboard `groupDenominationsKb` (from `ckb`, already imported as a namespace — use `ckb.groupDenominationsKb`).

(c) Replace the body of `browseProductsFlat` (lines 190-229) so it pages over catalog entries:

```ts
export async function browseProductsFlat(ctx: MyContext, page = 0): Promise<void> {
  const lang = ctx.session.lang;

  const entries = await listCatalogEntries(prisma);
  if (!entries.length) {
    await smartEdit(ctx, t(ctx, "browse.no_products"), ckb.backToMain(lang));
    return;
  }

  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const start = page * PAGE_SIZE;
  const pageEntries = entries.slice(start, start + PAGE_SIZE);

  sc(ctx).browsePage = page;
  sc(ctx).browseEntries = pageEntries.map((e) =>
    e.kind === "group" ? { kind: "group" as const, id: e.group.id } : { kind: "product" as const, id: e.product.id },
  );
  delete sc(ctx).browseProductIds;
  delete sc(ctx).viewingProductId;

  const itemLines = pageEntries.map((e, i) => {
    const label = e.kind === "group" ? `${e.group.name} ›` : e.product.name;
    return `${i + 1}. ${esc(label)}`;
  });

  const text = t(ctx, "browse.list_decorated", {
    page: page + 1,
    total: totalPages,
    items: itemLines.join("\n"),
  });

  await renderMenuBanner(
    ctx,
    text,
    ckb.productsPersistentKb(pageEntries.length, lang, {
      showPrev: page > 0,
      showNext: page < totalPages - 1,
      showBack: false,
    }),
  );
}
```

(d) Replace the number-resolution branch in `handleProductNumber` (lines 286-316) to resolve against `browseEntries`:

```ts
  // Number buttons — entry selection. Only short digit strings.
  if (!/^\d+$/.test(text) || text.length > 4) return;

  // Resolve against the SNAPSHOT captured when the list was rendered, so a
  // catalog change between render and tap can't shift the numbering.
  let entries = sc(ctx).browseEntries ?? [];
  if (!entries.length) {
    const all = await listCatalogEntries(prisma);
    const page = sc(ctx).browsePage ?? 0;
    const startIdx = page * PAGE_SIZE;
    entries = all.slice(startIdx, startIdx + PAGE_SIZE).map((e) =>
      e.kind === "group" ? { kind: "group" as const, id: e.group.id } : { kind: "product" as const, id: e.product.id },
    );
    sc(ctx).browseEntries = entries;
  }

  if (!entries.length) {
    await smartEdit(ctx, t(ctx, "browse.no_products"), ckb.backToMain(lang));
    return;
  }

  const idx = parseInt(text, 10);
  if (idx < 1 || idx > entries.length) {
    await smartEdit(ctx, t(ctx, "browse.invalid_number", { max: entries.length }), ckb.backToMain(lang));
    return;
  }

  const entry = entries[idx - 1]!;
  logger.debug(`handle_product_number: user selected idx=${idx} ${entry.kind}=${entry.id}`);
  if (entry.kind === "group") await browseGroup(ctx, entry.id);
  else await browseProduct(ctx, entry.id);
}
```

(e) Add the `browseGroup` handler after `browseProduct` (after line 376):

```ts
export async function browseGroup(ctx: MyContext, groupId: number): Promise<void> {
  const lang = ctx.session.lang;
  const group = await getGroupWithActiveProducts(prisma, groupId);
  if (!group || group.products.length === 0) {
    // Group emptied/deactivated between render and tap — don't strand the user.
    await smartEdit(ctx, t(ctx, "browse.no_products"), ckb.backToMain(lang));
    return;
  }
  if (group.products.length === 1) {
    await browseProduct(ctx, group.products[0]!.id);
    return;
  }
  const text = t(ctx, "browse.choose_denomination", { name: esc(group.name) });
  await smartEdit(ctx, text, ckb.groupDenominationsKb(group.products, lang));
}
```

- [ ] **Step 6: Route the `browse:group:<id>` callback (deep-link/robustness)**

In `apps/order-bot/src/handlers/callbacks.ts`, extend `dispatchBrowse` (lines 42-47):

```ts
const dispatchBrowse: DomainDispatcher = async (ctx, parts) => {
  const action = parts[2];
  if (action === "prods") await customer.browseProductsFlat(ctx);
  else if (action === "page") await customer.browseProductsFlat(ctx, parseInt(parts[3]!, 10));
  else if (action === "prod") await customer.browseProduct(ctx, parseInt(parts[3]!, 10));
  else if (action === "group") await customer.browseGroup(ctx, parseInt(parts[3]!, 10));
};
```

- [ ] **Step 7: Run the tests to confirm they pass**

Run: `pnpm --filter @app/order-bot test -- -t "denomination groups"`
Expected: PASS.

Then run the full bot suite to catch regressions in the existing browse tests (which referenced `browseProductIds`):

Run: `pnpm --filter @app/order-bot test`
Expected: PASS. If the legacy tests at lines 99-136 assert `browseProductIds`, update them to assert `browseEntries` (the snapshot field changed): replace `browseProductIds` expectations with the equivalent `browseEntries` shape, e.g. `[{ kind: "product", id: sample.product.id }]`, and any seeded `scratch: { browseProductIds: [...] }` with `scratch: { browseEntries: [{ kind: "product", id: ... }] }`.

- [ ] **Step 8: Typecheck core + bot**

Run: `pnpm --filter @app/core typecheck && pnpm --filter @app/order-bot typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/order-bot/src/keyboards/customer.ts apps/order-bot/src/handlers/customer.ts apps/order-bot/src/handlers/callbacks.ts packages/core/locales/en.json packages/core/locales/id.json apps/order-bot/test/handlers.test.ts
git commit -m "feat(bot): group-aware browse + denomination picker"
```

---

### Task 5: Storefront — group cards + group detail page

**Files:**
- Modify: `apps/storefront/src/routes/catalog.ts` (use `listCatalogEntries` on `/c/:id`; add `/g/:id`)
- Create: `apps/storefront/views/group.njk` (denomination selector page)
- Modify: `apps/storefront/views/catalog.njk` (render group cards alongside product cards)
- Test: `apps/storefront/test/storefront.test.ts` (group card + group page)

**Interfaces:**
- Consumes: `listCatalogEntries`, `getGroupWithActiveProducts` from Task 2; existing `getCategory`, `listActiveCategories`, `stockStatusCounts`, `productRatingSummaries`, `activeBulkPricingByProduct`, `productImage`, `shopContext`, `card()`.
- Produces: a `/g/:id` route and a `groups` array in the catalog view context.

- [ ] **Step 1: Write the failing storefront tests**

In `apps/storefront/test/storefront.test.ts`, add a `describe("denomination groups", …)` block. Seed a group in `beforeAll` is awkward (it uses module-level ids); instead create rows inside the test:

```ts
describe("denomination groups", () => {
  it("category page shows a group card linking to /g/:id", async () => {
    const group = await prisma.productGroup.create({ data: { categoryId, name: "Capcut", isActive: true } });
    await prisma.product.create({
      data: { categoryId, name: "Capcut 7 day", type: "SHARED", durationLabel: "7 day", price: "10000", productGroupId: group.id },
    });
    await prisma.product.create({
      data: { categoryId, name: "Capcut 1 Month", type: "SHARED", durationLabel: "1 Month", price: "30000", productGroupId: group.id },
    });

    const res = await app.inject({ method: "GET", url: `/c/${categoryId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`/g/${group.id}`);
    expect(res.body).toContain("Capcut");
  });

  it("group page lists each denomination linking to /p/:id", async () => {
    const group = await prisma.productGroup.create({ data: { categoryId, name: "Splice", isActive: true } });
    const wk = await prisma.product.create({
      data: { categoryId, name: "Splice 7 day", type: "SHARED", durationLabel: "7 day", price: "9000", productGroupId: group.id },
    });
    const mo = await prisma.product.create({
      data: { categoryId, name: "Splice 1 Month", type: "SHARED", durationLabel: "1 Month", price: "29000", productGroupId: group.id },
    });

    const res = await app.inject({ method: "GET", url: `/g/${group.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`/p/${wk.id}`);
    expect(res.body).toContain(`/p/${mo.id}`);
  });

  it("unknown group id is 404", async () => {
    const res = await app.inject({ method: "GET", url: "/g/999999" });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm --filter @app/storefront test -- -t "denomination groups"`
Expected: FAIL — `/g/:id` is 404 and the category page has no group card.

- [ ] **Step 3: Update `/c/:id` to render entries and add `/g/:id`**

In `apps/storefront/src/routes/catalog.ts`:

(a) Extend the `@app/db` import block (lines 8-22) with `listCatalogEntries` and `getGroupWithActiveProducts`.

(b) In the `/c/:id` handler, after building `ratingByProduct`, build group cards and ungrouped product cards from entries. Replace the `products: products.map(...)` view payload with both lists. Add before `return reply.view(...)`:

```ts
    const entries = await listCatalogEntries(prisma, category.id);
    const groupCards = entries
      .filter((e): e is Extract<typeof entries[number], { kind: "group" }> => e.kind === "group")
      .map((e) => ({
        id: e.group.id,
        name: e.group.name,
        emoji: e.group.emoji,
        from_price: e.members[0]!.price.toString(), // members are price-asc
        count: e.members.length,
        image: e.group.webImageUrl ?? productImage(e.members[0]!, category.name),
      }));
    const productEntryIds = new Set(
      entries.filter((e) => e.kind === "product").map((e) => (e as { product: { id: number } }).product.id),
    );
    const productCards = products
      .filter((p) => productEntryIds.has(p.id))
      .map((p) => card(p, stock, ratingByProduct, bulk));
```

and change the view call to pass both:

```ts
    return reply.view("catalog.njk", {
      ...ctx,
      category,
      categories,
      groups: groupCards,
      products: productCards,
      low_threshold: config.LOW_STOCK_THRESHOLD,
    });
```

(c) Add the `/g/:id` route after the `/c/:id` handler:

```ts
  // Group (denomination) detail.
  app.get<{ Params: { id: string } }>("/g/:id", async (req, reply) => {
    const groupId = Number(req.params.id);
    const ctx = await shopContext(req, "/g");
    const group = Number.isInteger(groupId) ? await getGroupWithActiveProducts(prisma, groupId) : null;
    if (!group || !group.isActive || group.products.length === 0) {
      return reply.code(404).view("error.njk", {
        ...ctx,
        status_code: 404,
        message: t("web.not_found", ctx.lang),
      });
    }
    const category = await getCategory(prisma, group.categoryId);
    return reply.view("group.njk", {
      ...ctx,
      group: { id: group.id, name: group.name, emoji: group.emoji, description: group.description },
      denominations: group.products.map((p) => ({
        id: p.id,
        duration_label: p.durationLabel,
        name: p.name,
        price: p.price.toString(),
        image: group.webImageUrl ?? productImage(p, category ? category.name : ""),
      })),
    });
  });
```

- [ ] **Step 4: Create `group.njk`**

Create `apps/storefront/views/group.njk` (extend the storefront's base layout; mirror `product.njk`'s `{% extends %}`/block structure — inspect that file for the exact base path and block name). Functional content:

```html
{% extends "base.njk" %}
{% block content %}
<section class="group">
  <h1>{{ group.emoji }} {{ group.name }}</h1>
  {% if group.description %}<p>{{ group.description }}</p>{% endif %}
  <ul class="denominations">
    {% for d in denominations %}
      <li>
        <a href="/p/{{ d.id }}">
          <span class="dn-label">{{ d.duration_label or d.name }}</span>
          <span class="dn-price">{{ d.price | money }}</span>
        </a>
      </li>
    {% endfor %}
  </ul>
</section>
{% endblock %}
```

(If the base template name/block differ, copy the wrapper from `apps/storefront/views/product.njk`.)

- [ ] **Step 5: Render group cards in `catalog.njk`**

In `apps/storefront/views/catalog.njk`, add a group-cards loop above the existing product grid, matching the existing card markup. Minimum:

```html
{% for g in groups %}
  <a class="card" href="/g/{{ g.id }}">
    <img src="{{ g.image }}" alt="{{ g.name }}">
    <h3>{{ g.emoji }} {{ g.name }}</h3>
    <p>{{ g.count }} options · from {{ g.from_price | money }}</p>
  </a>
{% endfor %}
```

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `pnpm --filter @app/storefront test -- -t "denomination groups"`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @app/storefront typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/storefront/src/routes/catalog.ts apps/storefront/views/group.njk apps/storefront/views/catalog.njk apps/storefront/test/storefront.test.ts
git commit -m "feat(storefront): group cards + denomination detail page"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck everything**

Run: `pnpm -r typecheck`
Expected: no errors across all workspaces.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all suites pass (db, web-admin, order-bot, storefront, core).

- [ ] **Step 3: Confirm no leaked locale drift**

Verify `packages/core/locales/en.json` and `id.json` have identical key sets for the new `browse.choose_denomination` and `browse.denomination_btn` keys with matched `{placeholders}`.

- [ ] **Step 4: Final commit (if any fixups were needed)**

```bash
git add -A
git commit -m "test: green typecheck + suite for product denominations"
```

> If executing in an isolated worktree, hand back to `superpowers:finishing-a-development-branch` to decide merge/PR.

---

## Self-Review

**Spec coverage:**
- Schema `ProductGroup` + nullable `Product.productGroupId`, category invariant → Task 1, Task 2 (`assignProductToGroup`).
- CRUD `createGroup/updateGroup/deleteGroup/assignProductToGroup/listAllGroups/getGroupWithActiveProducts/listCatalogEntries` → Task 2.
- Optional grouping, collapse single-member, hide empty/inactive, inactive-group flat fallback → Task 2 tests.
- Web-admin CRUD + assign + CSRF + audit + test trio → Task 3.
- Bot group-aware browse + denomination picker + locale parity → Task 4.
- Storefront group cards + group detail page → Task 5.
- `pnpm -r typecheck` + `pnpm test` green → Task 6.
- Deploy `db push` + restart-before-code note → Task 1 deploy note + Global Constraints.

**Placeholder scan:** No TBD/TODO; every code step shows the code. Template steps note the one place (base-layout name/block) the engineer must copy from a sibling file rather than guess.

**Type consistency:** `CatalogEntry`, `CategoryMismatchError`, `groupDenominationsKb`, `browseGroup`, `browseEntries`, and the `browse:group:<id>`/`v1:browse:prod:<id>` callback shapes are used identically across Tasks 2-5.
