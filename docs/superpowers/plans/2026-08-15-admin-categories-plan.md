# Implementation plan — admin category & product management

## Context

In the admin SPA, "Manage categories" is a ghost button in the Catalog page header
(`CatalogPage.tsx:430-436`) that toggles local state into an inline chip strip
(`:464-505`). It has no route, no sidebar entry, cannot be bookmarked, and loses its
state on navigation. It also has no create button — the only way to create a category is
the `+ New category` sentinel in the *Add Product* dropdown. Worse, a product's category
is immutable after creation: `PATCH /api/catalog/products/:id` never reads `categoryId`,
and the bulk toolbar only offers Activate/Deactivate/Archive. Category deletion does not
exist at any layer.

This plan gives categories a real page reachable from the sidebar, lets admins
create/edit/reorder/delete categories there, and lets products — new and existing — be
moved between categories individually and in bulk.

## Global Constraints

These bind every task. Copy them into each implementer and reviewer dispatch.

- **Workspace:** repo root is
  `C:\Users\ilham\Documents\web-and-bot-order\.claude\worktrees\admin-categories`, branch
  `worktree-admin-categories`. Never `git checkout`/`switch` to another branch, never
  `git stash` (the stash is shared across worktrees), never `git reset --hard`, never
  force-push. Commit your own work on this branch.
- **Tests:** `pnpm typecheck` and `pnpm test` must stay green. For targeted runs use
  `pnpm exec vitest run <path>` — `pnpm --filter <pkg> test` exits 0 without running
  anything in this repo. Add tests with every behavior change (TDD: write the failing
  test first).
- **No raw SQL in routes or handlers.** All database access goes through helpers in
  `packages/db/src/crud/*`, covered by colocated Vitest tests.
- **Audit every state change** via `logAdminAction` with the acting admin id. The
  `details` string is read by shop admins, not developers: write a short natural-language
  English sentence (`Moved 12 products to category "Games".`), never `key=value`
  shorthand, and never interpolate a truncated id list — summarize by count.
- **Category `slug` is frozen.** It is generated once at creation and must never be
  rewritten, including on rename — storefront URLs (`/c/:slug`) and the sitemap depend on
  it. No task may touch `slug` on update.
- **Keep every `$transaction` short** — the SQLite database is single-writer.
- **Do not change RBAC.** Catalog mutations already sit behind `csrfProtect`, which
  restricts them to the `super` role via `CONFIG_PREFIXES` in
  `apps/web-admin/src/plugins/auth.ts`. Do not add, widen, or narrow that.
- **Reuse existing UI primitives** — `PageLayout`, `PageHeader`, `DataTable`, `Card`,
  `Button`, `Switch`, `Select`, `Input`, `Textarea`, and
  `components/shared/ConfirmDialog.tsx`. Do not add a new npm dependency; in particular
  there is no drag-and-drop library and none may be introduced.
- **UI copy stays in English**, matching the rest of the admin panel.

---

## Task 1: Database helpers for category delete, bulk move, and reorder

**File:** `packages/db/src/crud/catalog.ts`
**Tests:** `packages/db/src/crud/catalog.test.ts`

Add three exported helpers. Match the surrounding style — the existing category helpers
sit at lines 49-111 and the product bulk helpers at 211-245.

1. `deleteCategory(db: Db, categoryId: number): Promise<void>`
   Place it after `countProductsInCategory` (line 109). Guard exactly like
   `deleteCatalogProduct` (line 231) does for denominations: call the existing
   `countProductsInCategory`, and if the count is greater than zero throw
   `new Error("category not empty: move or delete its products first")`. Otherwise
   `db.category.delete`. Do not cascade — `Product.categoryId` has no `onDelete` rule, so
   deleting a non-empty category must be impossible at this layer.

2. `bulkSetCatalogProductsCategory(db: Db, ids: number[], categoryId: number): Promise<number>`
   Place it next to `bulkSetCatalogProductsActive` (line 212) and mirror it exactly:
   return `0` for an empty `ids` array, otherwise a single `updateMany` returning
   `res.count`.

3. `reorderCategories(db: PrismaClient, ids: number[]): Promise<void>`
   Takes category ids in the desired display order and writes `sortOrder = index` for
   each. Use one short `$transaction` (see `deleteCatalogProductCascade` at line 240 for
   the shape). A no-op for an empty array.

**Tests to add** (the file already has a `makeCategory` helper at line 55):
- `deleteCategory` removes an empty category.
- `deleteCategory` throws when the category still has a product, and the category is
  still present afterwards.
- `bulkSetCatalogProductsCategory` moves several products and returns the count; returns
  `0` for an empty id list.
- `reorderCategories` makes `listAllCategories` return the given order (that list orders
  by `sortOrder` then `name`, so pick names whose alphabetical order differs from the
  requested order — otherwise the test would pass without the code).

Do not modify `updateCategory`; its untyped passthrough is what makes the partial patch
in Task 2 possible.

---

## Task 2: Category and product-move endpoints

**File:** `apps/web-admin/src/routes/api/catalog.ts`
**Also:** `apps/web-admin/client/src/pages/AuditPage.tsx` (action labels only)
**Tests:** `apps/web-admin/test/web.test.ts`

Depends on Task 1's helpers. Every route below keeps `preHandler: csrfProtect`.

1. **`POST /api/catalog/categories`** (line 102) — currently accepts `name` only and
   silently drops everything else. Accept optional `emoji`, `description` and
   `sortOrder` too, passing them to `createCategory` (which already supports them).
   Trim strings; empty string becomes `null`. Keep the 201 `{ category }` response and
   the existing `category_create` audit entry.

2. **`PATCH /api/catalog/categories/:id`** (line 118) — currently a full replace: lines
   128-133 always write all four fields, so omitting `emoji` or `description` nulls the
   stored value and omitting `sortOrder` resets it to `0`. Make it a true partial patch:
   build the update object from only the keys actually present in the request body.
   `name` stays validated when present (non-empty after trimming) but is no longer
   required for a patch that does not include it. Never touch `slug`. Audit as today.

3. **`DELETE /api/catalog/categories/:id`** — new. 400 on a non-integer id, 404 when the
   category does not exist. Call `countProductsInCategory`; when it is greater than zero
   reply `409` with `{ error, productCount }` where `error` is a sentence the admin can
   act on, e.g. `Cannot delete: move or delete its 3 product(s) first.`. Otherwise call
   `deleteCategory`, audit `category_delete` with `Deleted category "Streaming".`, and
   reply `{ ok: true }`.

4. **`POST /api/catalog/categories/reorder`** — new. Body `{ ids: number[] }` in display
   order. Reject a non-array or a list containing a non-integer with 400. Call
   `reorderCategories`, audit `category_reorder` with `Reordered categories.`, reply
   `{ ok: true }`.

5. **`PATCH /api/catalog/products/:id`** (line 242) — accept an optional `categoryId`.
   When present, validate it is an integer naming an existing category (mirror the
   validation already at lines 79-83 in the create route) and return 400 otherwise. Pass
   it through to `updateCatalogProduct` alongside the existing fields. When the category
   actually changes, the audit sentence must name both ends, e.g.
   `Moved product "PUBG UC" from "Games" to "E-Wallet".`; when it does not change, keep
   the existing update wording.

6. **`POST /api/catalog/products/bulk-category`** — new. Body `{ ids: number[], categoryId }`,
   modelled on `bulk-active` at line 288. Validate the target category exists (400
   otherwise). Call `bulkSetCatalogProductsCategory`, reply `{ ok: true, count }`, and
   audit once with a counted sentence: `Moved 12 products to category "Games".` — never a
   list of ids.

Then add the new action labels (`category_delete`, `category_reorder`, and whatever key
you use for the bulk move) to the label map in `AuditPage.tsx:58-60`, matching the
existing entries' style.

**Tests to add** in `apps/web-admin/test/web.test.ts`, alongside the existing catalog API
tests (create category at :1525, update/toggle at :1942+, RBAC matrix at :5133):
- `DELETE` an empty category succeeds; `DELETE` a category holding products returns 409
  with the product count and the category survives.
- **Regression:** `PATCH` a category with only `{ name }` leaves a previously stored
  `emoji`, `description` and `sortOrder` untouched. This is the bug being fixed — the
  test must fail against the current code.
- `POST /categories` persists `emoji` and `description`.
- `reorder` changes the order returned by `GET /api/catalog`.
- `PATCH` a product with `categoryId` moves it; an unknown `categoryId` returns 400.
- `bulk-category` returns the right `count` and moves every listed product.
- The new endpoints reject a `support`-role session with 403, like their neighbours.

---

## Task 3: Shared catalog query hook and a create-or-edit category dialog

**New files:**
- `apps/web-admin/client/src/api/catalog.ts`
- `apps/web-admin/client/src/components/catalog/CategoryDialog.tsx`

**Edited:** `apps/web-admin/client/src/pages/CatalogPage.tsx`

This task is a refactor: no user-visible behaviour changes except the dialog gaining a
create mode. `CatalogPage.test.tsx` must still pass unchanged.

1. Move `useCatalog()` and the `CategoryRow` / `ProductRow` / `CatalogData` types out of
   `CatalogPage.tsx` (lines 59-109) into `api/catalog.ts`, exporting them. Keep the query
   key `["catalog"]` exactly as it is so every consumer shares one cache entry. Keep using
   `apiGet` from `api/client.ts`. `CatalogPage.tsx` imports them instead of declaring them.

2. Move `CategoryEditDialog` (`CatalogPage.tsx:125-194`) into
   `components/catalog/CategoryDialog.tsx`, renamed `CategoryDialog`, and extend it to
   handle both modes:
   - `category` prop present → edit mode, `PATCH /api/catalog/categories/:id`, title
     "Edit category".
   - `category` prop absent/null → create mode, `POST /api/catalog/categories`, title
     "New category".
   - Fields: Name (required), Emoji, Description. **Remove the raw `sortOrder` number
     input** (`:181`) — ordering moves to the up/down buttons in Task 4.
   - In edit mode, display the category's `slug` as read-only helper text with a short
     note that it is fixed because storefront links depend on it.
   - Keep the existing error display and disabled-while-saving behaviour.
   - On success call the existing `onSaved` callback so the caller can invalidate
     `["catalog"]`.

3. `CatalogPage.tsx` imports `CategoryDialog` in place of its local component. Its
   existing edit affordance keeps working exactly as before.

Add a focused test file for the dialog covering: create mode POSTs and calls `onSaved`;
edit mode PATCHes only the fields shown; the save button stays disabled while the name is
empty.

---

## Task 4: The Categories page, its route, and the sidebar entry

**New files:**
- `apps/web-admin/client/src/pages/CategoriesPage.tsx`
- `apps/web-admin/client/src/pages/CategoriesPage.test.tsx`

**Edited:** `apps/web-admin/client/src/App.tsx`,
`apps/web-admin/client/src/components/layout/Sidebar.tsx`

Depends on Tasks 2 and 3.

1. **Route `/categories`** registered in `App.tsx` near the catalog routes (lines 56-60).
   Deliberately **not** nested under `/catalog`: the sidebar's `NavLink` uses prefix
   matching (`Sidebar.tsx:157-173`; only Dashboard passes `end: true`), so a nested URL
   would highlight both "Catalog" and "Categories" at once, and adding `end: true` to
   Catalog would break its highlight on `/catalog/:productId`.

2. **Sidebar:** add `{ to: "/categories", label: "Categories", icon: FolderTree }`
   directly after the Catalog item in the Products group (`Sidebar.tsx:63-69`). Import
   the icon from `lucide-react` alongside the existing ones.

3. **The page** uses `useCatalog()` from Task 3, so product counts come from the same
   data the Catalog page shows. Layout:
   - `PageHeader` titled "Categories" with a short description and a primary
     `+ New category` button opening `CategoryDialog` in create mode.
   - A `DataTable` with columns: order (an up and a down icon button per row, disabled at
     the ends, each sending the full reordered id list to
     `POST /api/catalog/categories/reorder`), name (emoji + name, with the slug beneath in
     muted text), description, product count rendered as a link to
     `/catalog?categoryId=<id>`, an Active `Switch` calling the existing
     `POST /api/catalog/categories/:id/active`, and a row action menu with Edit and
     Delete. Follow the row-action pattern already used in `CatalogPage.tsx:774-817`.
   - Delete goes through `ConfirmDialog`. When the API answers 409, surface its `error`
     sentence in place of the confirmation and offer a link to that category's products
     instead of a retry — do not let the admin click delete again into the same error.
   - An empty state that explains what categories are for and repeats the create button,
     replacing the current dead-end `"No categories yet."` text.
   - Every mutation invalidates the `["catalog"]` query on success and surfaces failures
     inline; never leave a row in a half-toggled state.

**Tests** (`CategoriesPage.test.tsx`), following the conventions in `CatalogPage.test.tsx`:
renders categories with their product counts; create opens the dialog; the up/down buttons
post the expected id order and are disabled at the ends; deleting an empty category calls
`DELETE`; a 409 shows the returned message rather than a generic failure; the empty state
renders its create button.

---

## Task 5: Retire the inline panel and add bulk "Move to category"

**File:** `apps/web-admin/client/src/pages/CatalogPage.tsx`
**Tests:** `apps/web-admin/client/src/pages/CatalogPage.test.tsx`

Depends on Task 4 (the page it links to must exist).

1. **Remove** the "Manage categories" ghost button (`:430-436`), the `showCategories`
   state (`:203`), the inline categories `Card` (`:464-505`), the `editingCategory` state
   and its `CategoryDialog` usage (`:507-513`), and the now-unused
   `toggleCategoryActive` helper (`:242-254`) — that behaviour now lives on
   `/categories`. Leave the category *filter* (`:522-537`), the category-aware search
   (`:385-391`) and the category sort (`:552-564`) alone.

2. In place of the removed button, put a plain link/button in the header actions that
   navigates to `/categories`, and make the "Categories" `StatTile` (`:458`) navigate
   there too so the count is a way in rather than a dead number.

3. **Bulk move:** add a "Move to category…" control to the bulk toolbar
   (`:672-688`), beside Activate/Deactivate/Archive. Picking a category posts
   `{ ids, categoryId }` to `POST /api/catalog/products/bulk-category`, then invalidates
   `["catalog"]` and clears the selection, matching how `bulkSetActive` (`:296`) and
   `bulkSetArchived` (`:311`) already behave — including their disabled-while-acting
   handling.

4. **Deep link:** initialise the existing category filter from a `?categoryId=` search
   param using `useSearchParams` from `react-router-dom`, so the product-count links on
   `/categories` land on a filtered list. Keep the filter working normally afterwards.

**Tests:** update the two tests that pin the removed UI (`CatalogPage.test.tsx:206-260`)
so they assert the new link instead; add coverage for the bulk move posting the selected
ids and for `?categoryId=` pre-filtering the table.

---

## Task 6: Move an existing product, and polish the new-product picker

**Files:** `apps/web-admin/client/src/pages/ProductDetailPage.tsx`,
`apps/web-admin/client/src/pages/ProductCreatePage.tsx`
**Tests:** the colocated test files for both pages.

Depends on Tasks 2 and 3.

1. **`ProductDetailPage.tsx`** — the header card currently prints the category as dead
   text (`:184`). Make it a link to `/catalog?categoryId=<id>`. Then add a **Category**
   `Select` as the first field of the "Edit storefront details" card (`:213-266`),
   populated from `useCatalog()`, defaulting to the product's current category;
   `saveProduct()` (`:92-110`) sends `categoryId` along with the fields it already
   PATCHes. Consider renaming the button/card heading if "storefront details" no longer
   describes what it edits.

   Note for context, no code change required: moving a product implicitly re-parents its
   denominations, which keeps `assignDenominationToProduct`'s `CategoryMismatchError`
   guard (`packages/db/src/crud/catalog.ts:248-259`) self-consistent.

2. **`ProductCreatePage.tsx`** — keep the `+ New category` sentinel flow as it is, it
   works well. Two fixes: replace the raw `fetch("/api/catalog")` (`:35-37`) with the
   shared `useCatalog()` hook from Task 3, and group the dropdown options (`:137-158`)
   so inactive categories appear under a separate, clearly labelled group — today they
   are mixed in with active ones and an admin can file a new product into a dead
   category without noticing.

**Tests:** changing the category on the detail page PATCHes `categoryId`; the create
page's dropdown separates active from inactive categories.
