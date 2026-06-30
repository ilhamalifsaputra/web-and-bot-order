# Catalog — Create Product Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a working `POST /api/catalog/products` JSON endpoint and a `ProductCreatePage` React SPA page at `/catalog/new` so admins can create a product shell from the web admin panel without crashing the server.

**Architecture:** New JSON API endpoint added to the existing `apps/web-admin/src/routes/api/catalog.ts` file. New `ProductCreatePage` React component added as a dedicated page following the established SPA pattern. React Router registers `/catalog/new` before `/:productId` to prevent the wild-card catch.

**Tech Stack:** Fastify (backend route), Prisma via `@app/db` helpers, React + TanStack Query + shadcn/ui (frontend), Vitest + RTL (tests).

## Global Constraints

- All mutating routes must use `csrfProtect` preHandler; the client sends the token via `X-CSRF-Token` header (handled by `apiPost`).
- Audit every state change: call `logAdminAction` with `adminId: req.admin!.userId`, the action string, `targetType`, `targetId`, and a natural-language `details` sentence.
- Never log secrets. Never send Telegram messages directly from web routes — use `notification_outbox`.
- `pnpm typecheck` and `pnpm test` must stay green after every task.
- Follow existing naming: `createCatalogProduct` and `logAdminAction` are both exported from `@app/db` via `export * from "./crud/catalog"` and `export * from "./crud/audit"` — import from `@app/db`.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `apps/web-admin/src/routes/api/catalog.ts` | Modify | Add `POST /api/catalog/products` JSON endpoint |
| `apps/web-admin/test/web.test.ts` | Modify | Add backend integration tests for new endpoint |
| `apps/web-admin/client/src/pages/ProductCreatePage.tsx` | Create | New React page at `/catalog/new` |
| `apps/web-admin/client/src/pages/ProductCreatePage.test.tsx` | Create | RTL unit tests for `ProductCreatePage` |
| `apps/web-admin/client/src/App.tsx` | Modify | Register `/catalog/new` route before `/:productId` |

---

## Task 1: Backend — `POST /api/catalog/products` + integration tests

**Files:**
- Modify: `apps/web-admin/src/routes/api/catalog.ts`
- Modify: `apps/web-admin/test/web.test.ts`

**Interfaces:**
- Produces: `POST /api/catalog/products` → `201 { id: number, name: string, slug: string }` | `400 { error: string }` | `401 redirect` | `403 { error: "forbidden" }`
- Body: `{ name: string, categoryId: number, emoji?: string, description?: string }`

- [ ] **Step 1: Write the failing integration tests**

Add a new describe block in `apps/web-admin/test/web.test.ts`, after the existing `describe("catalog", ...)` block:

```ts
// ---- catalog JSON API — create product (acceptance #5b) -------------------

describe("catalog JSON API — create product", () => {
  function postProductJson(cookie: string | null, csrf: string | null, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }

  it("happy path: creates product and logs audit", async () => {
    const before = await prisma.product.count();
    const res = await postProductJson(seed.cookie, seed.csrf, {
      name: "Netflix Premium",
      categoryId: seed.categoryId,
      emoji: "🎬",
      description: "Streaming service",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number; name: string; slug: string };
    expect(body.name).toBe("Netflix Premium");
    expect(typeof body.slug).toBe("string");
    expect(body.slug.length).toBeGreaterThan(0);
    expect(await prisma.product.count()).toBe(before + 1);
    const audit = await prisma.auditLog.findMany({
      where: { action: "catalog_product_create", targetId: body.id },
    });
    expect(audit.length).toBe(1);
  });

  it("rejects missing name with 400", async () => {
    const res = await postProductJson(seed.cookie, seed.csrf, { categoryId: seed.categoryId });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects missing categoryId with 400", async () => {
    const res = await postProductJson(seed.cookie, seed.csrf, { name: "X" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects non-integer categoryId with 400", async () => {
    const res = await postProductJson(seed.cookie, seed.csrf, { name: "X", categoryId: "abc" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects missing auth (anon → 303 /login)", async () => {
    const res = await postProductJson(null, "x", { name: "X", categoryId: seed.categoryId });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF with 403", async () => {
    const res = await postProductJson(seed.cookie, "bad-token", { name: "X", categoryId: seed.categoryId });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
pnpm test --filter @app/web-admin -- --reporter=verbose 2>&1 | grep -E "FAIL|catalog JSON API"
```

Expected: 6 failing tests in "catalog JSON API — create product".

- [ ] **Step 3: Implement the endpoint**

In `apps/web-admin/src/routes/api/catalog.ts`, add the new import (`createCatalogProduct` is already imported at line 5) and register the route **before** the `app.get("/api/catalog/:productId", ...)` handler to avoid Fastify matching `/products` as a productId:

```ts
// Add after the existing imports — createCatalogProduct is already imported from "@app/db"

  app.post("/api/catalog/products", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = (typeof body.name === "string" ? body.name : "").trim();
    const categoryId = Number(body.categoryId);
    if (!name) return reply.code(400).send({ error: "Name is required." });
    if (!Number.isInteger(categoryId) || categoryId <= 0)
      return reply.code(400).send({ error: "A valid category is required." });

    const product = await createCatalogProduct(prisma, {
      categoryId,
      name,
      emoji: typeof body.emoji === "string" ? body.emoji.trim() || null : null,
      description: typeof body.description === "string" ? body.description.trim() || null : null,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "catalog_product_create",
      targetType: "product",
      targetId: product.id,
      details: `Created product "${name}".`,
    });
    return reply.code(201).send({ id: product.id, name: product.name, slug: product.slug });
  });
```

Insert this block immediately **after** the `app.get("/api/catalog", ...)` handler and **before** the `app.get("/api/catalog/:productId", ...)` handler so Fastify's static-first routing matches `/api/catalog/products` before the wildcard `/:productId`.

- [ ] **Step 4: Run tests to confirm they pass**

```
pnpm test --filter @app/web-admin -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|catalog JSON API"
```

Expected: 6 passing in "catalog JSON API — create product".

- [ ] **Step 5: Typecheck**

```
pnpm typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web-admin/src/routes/api/catalog.ts apps/web-admin/test/web.test.ts
git commit -m "feat(api): add POST /api/catalog/products JSON endpoint"
```

---

## Task 2: Frontend — `ProductCreatePage` + unit tests

**Files:**
- Create: `apps/web-admin/client/src/pages/ProductCreatePage.tsx`
- Create: `apps/web-admin/client/src/pages/ProductCreatePage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/catalog` → `{ categories: Array<{ id: number; name: string; isActive: boolean }>, products: unknown[] }` (same shape and React Query key `["catalog"]` as `CatalogPage`)
- Consumes: `POST /api/catalog/products` → `{ id: number; name: string; slug: string }` (Task 1)
- Produces: React component `ProductCreatePage` exported as named export

- [ ] **Step 1: Write the failing unit tests**

Create `apps/web-admin/client/src/pages/ProductCreatePage.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProductCreatePage } from "./ProductCreatePage";

const CATALOG_DATA = {
  categories: [{ id: 2, name: "Apps", isActive: true }],
  products: [],
};

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/catalog/new"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/catalog/new" element={children} />
          <Route path="/catalog/:productId" element={<div>product-detail-page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  // apiPost reads CSRF from meta tag — provide empty string
  Object.defineProperty(document, "querySelector", {
    writable: true,
    value: (sel: string) =>
      sel === 'meta[name="csrf-token"]' ? { getAttribute: () => "" } : null,
  });
});

describe("ProductCreatePage", () => {
  it("renders name input and submit button after categories load", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(CATALOG_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/capcut pro/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /create product/i })).toBeInTheDocument();
  });

  it("submit button is disabled when name is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(CATALOG_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));
    expect(screen.getByRole("button", { name: /create product/i })).toBeDisabled();
  });

  it("navigates to product detail page on successful create", async () => {
    // First call: GET /api/catalog for categories
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(CATALOG_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      // Second call: POST /api/catalog/products
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42, name: "Netflix", slug: "netflix" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )
      // Third call: invalidateQueries triggers a re-fetch of ["catalog"]
      .mockResolvedValueOnce(
        new Response(JSON.stringify(CATALOG_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));

    // Select a category via the Radix combobox
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Apps" }));
    fireEvent.click(screen.getByRole("option", { name: "Apps" }));

    // Fill in the name
    fireEvent.change(screen.getByPlaceholderText(/capcut pro/i), {
      target: { value: "Netflix" },
    });

    // Submit
    const btn = screen.getByRole("button", { name: /create product/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    // Should navigate to /catalog/42
    await waitFor(() =>
      expect(screen.getByText("product-detail-page")).toBeInTheDocument(),
    );
  });

  it("shows error message when create fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(CATALOG_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Category not found." }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));

    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Apps" }));
    fireEvent.click(screen.getByRole("option", { name: "Apps" }));

    fireEvent.change(screen.getByPlaceholderText(/capcut pro/i), {
      target: { value: "Netflix" },
    });

    const btn = screen.getByRole("button", { name: /create product/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    await waitFor(() =>
      expect(screen.getByText(/400/i)).toBeInTheDocument(),
    );
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
pnpm test --filter @app/web-admin-client -- --reporter=verbose 2>&1 | grep -E "FAIL|ProductCreatePage"
```

Expected: 4 failing tests — `ProductCreatePage` module not found.

- [ ] **Step 3: Implement `ProductCreatePage`**

Create `apps/web-admin/client/src/pages/ProductCreatePage.tsx`:

```tsx
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { apiPost } from "../api/client";

interface CategoryRow {
  id: number;
  name: string;
  isActive: boolean;
}

interface CatalogData {
  categories: CategoryRow[];
  products: unknown[];
}

function useCatalog() {
  return useQuery<CatalogData>({
    queryKey: ["catalog"],
    queryFn: async () => {
      const res = await fetch("/api/catalog");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<CatalogData>;
    },
  });
}

export function ProductCreatePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data } = useCatalog();
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [emoji, setEmoji] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      apiPost<{ id: number; name: string; slug: string }>("/api/catalog/products", {
        name: name.trim(),
        categoryId: categoryId!,
        ...(emoji.trim() ? { emoji: emoji.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onSuccess: (product) => {
      void qc.invalidateQueries({ queryKey: ["catalog"] });
      navigate(`/catalog/${product.id}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const canSubmit = name.trim().length > 0 && categoryId !== null;

  return (
    <PageLayout title="New Product">
      <PageHeader
        title="New Product"
        breadcrumb={[{ label: "Catalog", href: "/catalog" }]}
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate("/catalog")}>
            ← Back
          </Button>
        }
      />

      <div className="max-w-lg flex flex-col gap-4">
        <div>
          <label className="text-sm font-medium text-ink">
            Category <span className="text-rust">*</span>
          </label>
          <Select onValueChange={(v) => setCategoryId(Number(v))}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select category" />
            </SelectTrigger>
            <SelectContent>
              {(data?.categories ?? []).map((cat) => (
                <SelectItem key={cat.id} value={String(cat.id)}>
                  {cat.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-sm font-medium text-ink">
            Name <span className="text-rust">*</span>
          </label>
          <Input
            className="mt-1"
            placeholder="e.g. CapCut Pro"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Emoji</label>
          <Input
            className="mt-1 w-24"
            placeholder="e.g. 🎬"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
          />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Description</label>
          <Textarea
            className="mt-1"
            rows={3}
            placeholder="Short description shown on the storefront."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {error && <p className="text-sm text-rust">{error}</p>}

        <Button
          disabled={!canSubmit || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Creating…" : "Create Product"}
        </Button>
      </div>
    </PageLayout>
  );
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
pnpm test --filter @app/web-admin-client -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|ProductCreatePage"
```

Expected: 4 passing in "ProductCreatePage".

> **If the Radix Select tests (steps 3 and 4 of the test suite) fail** because `screen.getByRole("option", { name: "Apps" })` isn't found: Radix Select may need pointer events for its portal. Add `{ pointerEventsCheck: 0 }` to the fireEvent.click call on the combobox, or install `@testing-library/user-event` (`pnpm --filter @app/web-admin-client add -D @testing-library/user-event`) and replace `fireEvent.click` with `await userEvent.click(...)` throughout the Select interaction steps in the test.

- [ ] **Step 5: Typecheck**

```
pnpm typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web-admin/client/src/pages/ProductCreatePage.tsx apps/web-admin/client/src/pages/ProductCreatePage.test.tsx
git commit -m "feat(web-admin): add ProductCreatePage at /catalog/new"
```

---

## Task 3: Register `/catalog/new` route in App.tsx + full suite run

**Files:**
- Modify: `apps/web-admin/client/src/App.tsx:5,51`

**Interfaces:**
- Consumes: `ProductCreatePage` exported from `./pages/ProductCreatePage` (Task 2)
- Produces: `/catalog/new` resolves to `ProductCreatePage`; `/catalog/123` still resolves to `ProductDetailPage`

- [ ] **Step 1: Add the import and route**

In `apps/web-admin/client/src/App.tsx`:

Add the import on line 6 (after the `ProductDetailPage` import):
```ts
import { ProductCreatePage } from "./pages/ProductCreatePage";
```

Add the route at line 51, **before** the existing `<Route path="/catalog/:productId" ...>` line:
```tsx
        <Route path="/catalog/new" element={<ProductCreatePage />} />
        <Route path="/catalog/:productId" element={<ProductDetailPage />} />
```

The file section around line 50-52 should look like:
```tsx
        <Route path="/catalog" element={<CatalogPage />} />
        <Route path="/catalog/new" element={<ProductCreatePage />} />
        <Route path="/catalog/:productId" element={<ProductDetailPage />} />
```

- [ ] **Step 2: Run full test suite**

```
pnpm test 2>&1 | tail -20
```

Expected: all tests pass, no regressions.

- [ ] **Step 3: Typecheck**

```
pnpm typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/client/src/App.tsx
git commit -m "feat(router): register /catalog/new before /:productId to fix URL crash"
```

---

## Self-Review

**Spec coverage:**
- ✅ `POST /api/catalog/products` endpoint with validation (Task 1)
- ✅ `logAdminAction` with `catalog_product_create` action (Task 1)
- ✅ `csrfProtect` preHandler (Task 1)
- ✅ `ProductCreatePage` with category Select, name Input, emoji Input, description Textarea (Task 2)
- ✅ Submit disabled when name empty or category unset (Task 2)
- ✅ Navigate to `/catalog/:id` on success (Task 2)
- ✅ Error displayed on failure (Task 2)
- ✅ `/catalog/new` registered before `/:productId` (Task 3)
- ✅ Backend tests: happy path, missing name, missing categoryId, non-integer categoryId, no auth, bad CSRF (Task 1)
- ✅ Frontend tests: renders, disabled, navigation, error (Task 2)

**Placeholder scan:** No TBDs or incomplete steps.

**Type consistency:** 
- `apiPost<{ id: number; name: string; slug: string }>` → `product.id` used in `navigate(\`/catalog/${product.id}\`)` ✅
- `categoryId: number | null` → `categoryId!` only called when `canSubmit` is true (categoryId is non-null) ✅
- Backend returns `reply.code(201).send({ id: product.id, name: product.name, slug: product.slug })` → matches frontend type ✅
