# Catalog — Create Product Flow

**Date:** 2026-06-30  
**Status:** Approved  
**Scope:** Add a working `/catalog/new` route and `POST /api/catalog/products` endpoint so admins can create a product shell (Category → Product tier) from the web admin SPA.

---

## Background

The "+ Add Product" button on `/catalog` navigates to `/catalog/new`. No such route existed in React Router, so the request fell through to `/catalog/:productId`, which called `getCatalogProductWithDenominations(prisma, NaN)` and crashed with a Prisma validation error. The backend guard (returning 404 for non-integer product IDs) was patched as an emergency fix. This spec delivers the complete, intended feature.

---

## Architecture

Three-layer change following existing patterns:

```
App.tsx  →  ProductCreatePage  →  POST /api/catalog/products
                                       ↓
                                createCatalogProduct (packages/db)
                                       ↓
                                logAdminAction (packages/db)
                                       ↓
                                navigate("/catalog/{newId}")
```

---

## 1. Backend — `POST /api/catalog/products`

**File:** `apps/web-admin/src/routes/api/catalog.ts`

**Request body:**
```json
{ "name": "string (required)", "categoryId": 1, "description": "string?", "emoji": "string?" }
```

**Validation:**
- `name`: non-empty string after trim → 400 `{ error: "Name is required." }` if missing
- `categoryId`: positive integer → 400 `{ error: "Category is required." }` if missing or non-integer

**Success (201):**
```json
{ "id": 42, "name": "CapCut Pro", "slug": "capcut-pro" }
```

**Side effects:**
- Calls `createCatalogProduct(prisma, { categoryId, name, emoji, description })`
- Calls `logAdminAction` with `action: "catalog_product_create"`, `targetType: "product"`, `targetId: newProduct.id`, `details: "Created product <name> in category <categoryName>."`

**Auth:** `csrfProtect` preHandler (same as all other mutating catalog routes).

---

## 2. Frontend — `ProductCreatePage`

**File:** `apps/web-admin/client/src/pages/ProductCreatePage.tsx`

**Route:** `/catalog/new`

**Data:**
- Reuses the `["catalog"]` React Query cache (same query as `CatalogPage`) to populate the category dropdown. No extra network call when navigating from the catalog list.

**Form fields:**

| Field | Component | Required | Notes |
|---|---|---|---|
| Category | `Select` | Yes | Options from `data.categories`; placeholder "Select category" |
| Name | `Input` | Yes | `placeholder="e.g. CapCut Pro"` |
| Emoji | `Input` | No | `placeholder="e.g. 🎬"` — single character/emoji |
| Description | `Textarea` | No | `rows={3}` |

**Behavior:**
- Submit button disabled when `name.trim()` is empty or `categoryId` is unset
- On submit: `apiPost<{ id: number }>("/api/catalog/products", { name, categoryId, emoji, description })`
- On success: `navigate("/catalog/" + newProduct.id)` — lands directly on the detail page
- On error: show error message below the form (same pattern as `AdminsPage`)
- Page header: title "New Product", breadcrumb `[{ label: "Catalog", href: "/catalog" }]`, Back button to `/catalog`

---

## 3. Router — `App.tsx`

Insert `/catalog/new` **before** `/catalog/:productId`:

```tsx
<Route path="/catalog/new" element={<ProductCreatePage />} />
<Route path="/catalog/:productId" element={<ProductDetailPage />} />
```

Import `ProductCreatePage` at top alongside existing page imports.

---

## 4. Tests

### Backend (`apps/web-admin/src/routes/api/catalog.test.ts` or similar)

- Happy path: POST with valid `name` + `categoryId` → 201, body contains `id` and `slug`
- Missing name → 400
- Missing / non-integer categoryId → 400
- No CSRF token → 403

### Frontend (`apps/web-admin/client/src/pages/ProductCreatePage.test.tsx`)

- Renders form fields
- Submit button disabled when name is empty
- Submit button disabled when no category selected
- On successful POST: navigates to `/catalog/:newId`
- On failed POST: shows error message

---

## Out of Scope

- Denomination creation on the same form (use the detail page or CSV import)
- Image upload (`webImageUrl`, `imageFileId`) — set via the edit flow on the detail page
- `sortOrder` field — defaults to 0; adjustable on the detail page
- Category creation from this form
