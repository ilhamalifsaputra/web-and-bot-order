# Dashboard SPA Full Migration (Phase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate every Nunjucks admin page to the React SPA that Phase 2 introduced at `GET /`. When this plan is complete, `apps/web-admin/views/` is empty (except `login.njk`, `forgot.njk`, `reset.njk`, and the four setup-wizard pages, which remain in Nunjucks permanently — they are pre-auth flows the SPA cannot serve), and the React SPA handles all authenticated admin routes via React Router client-side navigation.

**Architecture:** The `spaShell.ts` route is promoted from `GET /` to a wildcard `GET /*` catch-all, registered **last** in `server.ts`. Specific Nunjucks route handlers are retired one page at a time; when a handler is removed, Fastify falls through to the wildcard and serves the SPA. React Router (client-side) renders the correct page. Each page migration adds a new JSON API under `GET /api/<resource>` (+ any `POST /api/<resource>/*` mutations) so the React component never calls a Nunjucks HTML endpoint. The SPA never receives the JSON response of a removed Nunjucks route — it calls its own `/api/*` endpoints.

**Tech Stack:** React Router v7 DOM (`react-router-dom@^7`), existing React 18 + TanStack Query + shadcn/ui + Tailwind (Phases 2-3), Fastify for the JSON API, Vitest + `@testing-library/react` + `jsdom` for frontend, Vitest + `app.inject` for backend.

## Global Constraints

- **Never blend IDR and USDT** — all existing `CurrencyStack`/`formatCurrencyDisplay` rules from Phases 2-3 apply to every migrated page.
- **No money arithmetic in the browser** — backend returns pre-computed strings.
- **CSRF for all mutations** — every `POST`/`PUT`/`DELETE` endpoint uses the `csrfProtect` preHandler; the React client uses the existing `apiPost` (`apps/web-admin/client/src/api/client.ts`) which attaches `X-CSRF-Token`.
- **Auth unchanged** — every API endpoint keeps `currentAdmin` preHandler; the SPA catch-all also keeps `currentAdmin`. Anonymous requests still 303 → `/login`.
- **Pre-auth pages stay Nunjucks forever** — `login.njk`, `forgot.njk`, `reset.njk`, `setup_*.njk`, `bootstrap.njk` are not touched in this plan.
- **No raw SQL / no bare `prisma.*` in routes** — all data access goes through `packages/db/src/crud/*`.
- **`pnpm typecheck` and `pnpm test` must stay green after every task.**
- **Rebuild the client** (`pnpm --filter @app/web-admin-client build`) before running backend tests that check the SPA shell, since `spaShell.ts` reads the built file from disk.

---

## Migration Pattern (applied to every page)

Each page migration follows this 6-step pattern. Tasks below reference it by name instead of repeating all steps.

### PATTERN: Migrate `/<page>` to React

1. **Add JSON API endpoint(s)** in `apps/web-admin/src/routes/api/dashboard.ts` (or a new `apps/web-admin/src/routes/api/<page>.ts` registered in `server.ts`):
   - `GET /api/<page>` — returns the data the Nunjucks template currently receives as view-context variables. Guard: `currentAdmin`.
   - `POST /api/<page>/*` — any mutating action. Guard: `csrfProtect` (which includes `currentAdmin`). Log via `logAdminAction`.
   - Write `app.inject` tests: anon redirect + happy path.

2. **Add a TanStack Query hook** in `apps/web-admin/client/src/hooks/use<Page>.ts` — one `useQuery` per GET endpoint, one `useMutation` per POST endpoint.

3. **Build the React page component** in `apps/web-admin/client/src/pages/<Page>.tsx` — data from the hook, mutations via `apiPost`, re-uses shared primitives (`StatusBadge`, `EmptyState`, `CurrencyStack`, etc.). Write a `<Page>.test.tsx` beside it (mock `fetch`, assert key content, not pixel-level).

4. **Register the route in React Router** — add a `<Route path="/<page>" element={<Page />}>` in `apps/web-admin/client/src/App.tsx`.

5. **Retire the Nunjucks handler** — remove the `GET /<page>` handler block from `apps/web-admin/src/routes/<page>.ts`. Leave mutation POST handlers untouched for now (they still work — the React frontend calls the new `/api/*` endpoints instead). Run `pnpm vitest run apps/web-admin/test/web.test.ts` to confirm nothing breaks.

6. **Verify** — rebuild client, start the app, navigate to `/<page>` and confirm the React page renders real data; confirm anon redirect still works.

### Notes on the pattern
- A page with both a list AND a detail view (e.g. `/orders` + `/orders/:id`) is two React routes, both in the same task.
- Existing `POST` endpoints (approve, reject, etc.) are **not** removed — they still work via Fastify's route matching and the React `apiPost` calls them directly.
- The Nunjucks view file (`.njk`) for the migrated page is deleted once its handler is removed.
- `pnpm typecheck && pnpm test` after every task.

---

## File Structure

### Foundation additions
- Modify `apps/web-admin/client/package.json` — add `react-router-dom@^7`
- Modify `apps/web-admin/client/src/main.tsx` — wrap in `BrowserRouter`
- Modify `apps/web-admin/client/src/App.tsx` — introduce `<Routes>` with existing dashboard at `/`, stubs for all other pages
- Create `apps/web-admin/client/src/pages/` — one file per migrated page
- Create `apps/web-admin/client/src/components/shared/PageLayout.tsx` — shared sidebar + topbar shell that wraps every page (replaces `_sidebar.njk` / `_topbar.njk`)
- Modify `apps/web-admin/src/routes/spaShell.ts` — change `GET /` to wildcard `GET /*`
- Modify `apps/web-admin/src/server.ts` — move `spaShell` registration to last position

### Per-page JSON API files
New files under `apps/web-admin/src/routes/api/`:
- `orders.ts` — Orders list + detail + mutations
- `catalog.ts` — Catalog list + product detail + import
- `stock.ts` — Stock list + product stock management
- `users.ts` — Users list + detail
- `vouchers.ts` — Vouchers CRUD
- `admins.ts` — Admins CRUD
- `payments.ts` — Payments ledger
- `outbox.ts` — Outbox list
- `reports.ts` — Reports data
- `reviews.ts` — Reviews list + moderation
- `audit.ts` — Audit log
- `broadcast.ts` — Broadcast compose + history
- `support.ts` — Support tickets + detail
- `settings.ts` (extend or replace) — Settings read + update
- `branding.ts` — Branding read + update
- `search.ts` — Search endpoint

---

## Task 1: React Router foundation + SPA wildcard catch-all

**Files:**
- Modify: `apps/web-admin/client/package.json`
- Modify: `apps/web-admin/client/src/main.tsx`
- Modify: `apps/web-admin/client/src/App.tsx`
- Modify: `apps/web-admin/src/routes/spaShell.ts`
- Modify: `apps/web-admin/src/server.ts`
- Modify: `apps/web-admin/test/web.test.ts`

**Interfaces:**
- Produces: React Router running in the SPA; `GET /*` wildcard in Fastify serving the SPA for every authenticated path that doesn't match a more specific route; existing `GET /` dashboard still works.

- [ ] **Step 1: Add react-router-dom**

```bash
pnpm add react-router-dom@^7 --filter @app/web-admin-client
```

- [ ] **Step 2: Wrap the app in BrowserRouter**

Replace `apps/web-admin/client/src/main.tsx`:

```tsx
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const queryClient = new QueryClient();

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
```

- [ ] **Step 3: Add `<Routes>` to App.tsx with a stub for each page**

Replace `apps/web-admin/client/src/App.tsx`:

```tsx
import { Routes, Route } from "react-router-dom";
import { QuickActionsBar } from "./components/dashboard/QuickActionsBar";
import { KpiRow } from "./components/dashboard/KpiRow";
import { OperationCenter } from "./components/dashboard/OperationCenter";
import { InventoryMonitoringCard } from "./components/dashboard/InventoryMonitoringCard";
import { ExpirationsTable } from "./components/dashboard/ExpirationsTable";
import { SalesAnalyticsCard } from "./components/dashboard/SalesAnalyticsCard";
import { RecentOrdersTable } from "./components/dashboard/RecentOrdersTable";
import { BusinessHealthGrid } from "./components/dashboard/BusinessHealthGrid";
import { TopProductsList } from "./components/dashboard/TopProductsList";

function Dashboard() {
  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-10 flex flex-col gap-3 border-b border-line bg-paper/90 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Shop Admin</h1>
        <QuickActionsBar />
      </header>
      <main className="flex flex-col gap-6 p-4 sm:p-6">
        <KpiRow />
        <OperationCenter />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <InventoryMonitoringCard />
          <ExpirationsTable />
        </div>
        <SalesAnalyticsCard />
        <RecentOrdersTable />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <BusinessHealthGrid />
          <TopProductsList />
        </div>
      </main>
    </div>
  );
}

function ComingSoon({ page }: { page: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper">
      <p className="text-ink-soft">{page} — migrating to React…</p>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/orders" element={<ComingSoon page="Orders" />} />
      <Route path="/orders/:orderId" element={<ComingSoon page="Order Detail" />} />
      <Route path="/catalog" element={<ComingSoon page="Catalog" />} />
      <Route path="/catalog/:productId" element={<ComingSoon page="Product Detail" />} />
      <Route path="/stock" element={<ComingSoon page="Stock" />} />
      <Route path="/stock/:productId" element={<ComingSoon page="Stock — Product" />} />
      <Route path="/users" element={<ComingSoon page="Users" />} />
      <Route path="/users/:userId" element={<ComingSoon page="User Detail" />} />
      <Route path="/vouchers" element={<ComingSoon page="Vouchers" />} />
      <Route path="/admins" element={<ComingSoon page="Admins" />} />
      <Route path="/payments" element={<ComingSoon page="Payments" />} />
      <Route path="/outbox" element={<ComingSoon page="Outbox" />} />
      <Route path="/reports" element={<ComingSoon page="Reports" />} />
      <Route path="/reviews" element={<ComingSoon page="Reviews" />} />
      <Route path="/audit" element={<ComingSoon page="Audit" />} />
      <Route path="/broadcast" element={<ComingSoon page="Broadcast" />} />
      <Route path="/support" element={<ComingSoon page="Support" />} />
      <Route path="/support/:ticketId" element={<ComingSoon page="Ticket Detail" />} />
      <Route path="/settings" element={<ComingSoon page="Settings" />} />
      <Route path="/branding" element={<ComingSoon page="Branding" />} />
      <Route path="/search" element={<ComingSoon page="Search" />} />
      <Route path="*" element={<ComingSoon page="Page not found" />} />
    </Routes>
  );
}
```

- [ ] **Step 4: Promote spaShell to wildcard catch-all**

Replace `apps/web-admin/src/routes/spaShell.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { currentAdmin } from "../plugins/auth";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.STATIC_DIR ?? join(HERE, "..", "..", "static");
const SPA_INDEX_PATH = join(STATIC_DIR, "dashboard-app", "index.html");

export default async function spaShellRoutes(app: FastifyInstance): Promise<void> {
  // Catch-all: any authenticated GET that didn't match a more specific route
  // (Nunjucks or otherwise) lands here and gets the React SPA. As Nunjucks
  // route handlers are removed task by task, their paths fall through to this
  // wildcard. Must be registered LAST in server.ts.
  app.get("/*", { preHandler: currentAdmin }, async (req, reply) => {
    const html = readFileSync(SPA_INDEX_PATH, "utf-8").replace("__CSRF_TOKEN__", req.admin?.csrf ?? "");
    return reply.type("text/html").send(html);
  });
}
```

- [ ] **Step 5: Move spaShell registration to LAST in server.ts**

In `apps/web-admin/src/server.ts`, move `await app.register(spaShellRoutes);` to after `await app.register(brandingRoutes);` — last in the chain, after all Nunjucks routes. The dashboardApiRoutes (GET `/api/*`) stay before it; they match `/api/*` paths, which are more specific than `/*` and win.

- [ ] **Step 6: Write the failing test, then verify it passes**

Add to `apps/web-admin/test/web.test.ts`:

```ts
it("a non-/ authenticated path falls through to the SPA shell", async () => {
  // /orders still has a Nunjucks handler — this test uses a path that doesn't.
  // Use a made-up path that never matches a real route.
  const res = await get("/this-path-does-not-exist", seed.cookie);
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/html");
  expect(res.body).toContain(`name="csrf-token" content="${seed.csrf}"`);
});

it("the wildcard falls through to /login for anon requests", async () => {
  const res = await get("/this-path-does-not-exist", null);
  expect(res.statusCode).toBe(303);
  expect(res.headers.location).toBe("/login");
});
```

Run: `pnpm vitest run apps/web-admin/test/web.test.ts`
Expected: PASS on the new tests AND all pre-existing tests — the `GET /` (SPA shell) test still passes because the old handler is now the wildcard `/*`, which also matches `/`.

- [ ] **Step 7: Build + full suite**

Run: `pnpm --filter @app/web-admin-client build`
Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web-admin/client apps/web-admin/src/routes/spaShell.ts apps/web-admin/src/server.ts apps/web-admin/test/web.test.ts
git commit -m "feat(web-admin): add React Router + wildcard SPA catch-all for incremental Nunjucks retirement"
```

---

## Task 2: Shared `PageLayout` (sidebar + topbar shell)

**Files:**
- Create: `apps/web-admin/client/src/components/shared/PageLayout.tsx` + `.test.tsx`

**Interfaces:**
- Produces: `PageLayout({ title, children })` — a full-page wrapper with a left sidebar (links to all admin pages via React Router `<Link>`), a top bar (shop name, logout link), and a `<main>` content area. Used by every migrated page. Replaces `_sidebar.njk` / `_topbar.njk`.

- [ ] **Step 1: Write the failing test**

Create `apps/web-admin/client/src/components/shared/PageLayout.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PageLayout } from "./PageLayout";

describe("PageLayout", () => {
  it("renders the page title and navigation links", () => {
    render(
      <MemoryRouter>
        <PageLayout title="Orders"><p>content</p></PageLayout>
      </MemoryRouter>,
    );
    expect(screen.getByText("Orders")).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /catalog/i })).toHaveAttribute("href", "/catalog");
    expect(screen.getByRole("link", { name: /logout/i })).toHaveAttribute("href", "/logout");
  });
});
```

- [ ] **Step 2: Run it (fails), then implement**

Run → FAIL. Create `apps/web-admin/client/src/components/shared/PageLayout.tsx`:

```tsx
import { Link, NavLink } from "react-router-dom";
import type { ReactNode } from "react";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/orders", label: "Orders" },
  { href: "/catalog", label: "Catalog" },
  { href: "/stock", label: "Stock" },
  { href: "/users", label: "Customers" },
  { href: "/vouchers", label: "Vouchers" },
  { href: "/admins", label: "Admins" },
  { href: "/payments", label: "Payments" },
  { href: "/outbox", label: "Outbox" },
  { href: "/reports", label: "Reports" },
  { href: "/reviews", label: "Reviews" },
  { href: "/audit", label: "Audit" },
  { href: "/broadcast", label: "Broadcast" },
  { href: "/support", label: "Support" },
  { href: "/settings", label: "Settings" },
  { href: "/branding", label: "Branding" },
  { href: "/search", label: "Search" },
];

export function PageLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-paper">
      <aside className="hidden w-56 flex-col border-r border-line bg-card lg:flex">
        <div className="px-4 py-5">
          <span className="font-display text-lg font-semibold text-ink">Shop Admin</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2 pb-4">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.href}
              to={item.href}
              end={item.href === "/"}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? "bg-pine-tint text-pine" : "text-ink-soft hover:bg-sand hover:text-ink"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line px-4 py-3">
          <a href="/logout" className="text-xs text-ink-faint hover:text-rust">
            Logout
          </a>
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-line bg-card px-4 py-3 sm:px-6">
          <h1 className="font-display text-xl font-semibold text-ink">{title}</h1>
        </header>
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
```

Run → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web-admin/client/src/components/shared/PageLayout.tsx apps/web-admin/client/src/components/shared/PageLayout.test.tsx
git commit -m "feat(web-admin): add PageLayout — the shared sidebar/topbar shell for migrated pages"
```

---

## Task 3: Migrate `/audit`

**Why first:** Read-only, no mutations, no pagination — simplest possible page. Validates the migration pattern end-to-end before touching complex pages.

**Backend:**
- New file: `apps/web-admin/src/routes/api/audit.ts`
- `GET /api/audit?page=&since=&until=` → `{ rows: AuditRow[], total: number, page: number }` — calls the existing `listAuditLog` / `countAuditLog` in `packages/db/src/crud/audit.ts`.
- Register in `server.ts`: `await app.register(auditApiRoutes);` before `spaShell`.

**Frontend:**
- `apps/web-admin/client/src/hooks/useAudit.ts` — `useQuery` against `/api/audit`
- `apps/web-admin/client/src/pages/AuditPage.tsx` + `.test.tsx`
- Register `<Route path="/audit" element={<AuditPage />}>` in `App.tsx`

**Retire:**
- Remove `app.get("/audit", ...)` handler from `apps/web-admin/src/routes/audit.ts`
- Delete `apps/web-admin/views/audit.njk`

Apply the PATTERN. Commit: `"feat(web-admin): migrate /audit to React"`

---

## Task 4: Migrate `/outbox`

**Backend:** `GET /api/outbox?page=` → `{ rows: OutboxRow[], total: number }` — calls existing `listOutbox` / `countOutbox` in `packages/db/src/crud/notifications.ts`.

**Frontend:** `useOutbox` hook + `OutboxPage.tsx`.

**Retire:** Remove `GET /outbox` Nunjucks handler. Delete `outbox.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /outbox to React"`

---

## Task 5: Migrate `/reports`

**Backend:** `GET /api/reports?since=&until=` → existing report data (revenue summary, order counts by status, top products). Reuses the same crud functions as `/api/dashboard/*` (already tested in Phase 1) — no new crud, only a new route.

**Frontend:** `useReports` hook + `ReportsPage.tsx`. The page shows the same Decimal-safe strings the backend already returns.

**Retire:** Remove `GET /reports` handler. Delete `reports.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /reports to React"`

---

## Task 6: Migrate `/reviews`

**Backend:**
- `GET /api/reviews?page=` → `{ rows: ReviewRow[], total: number }` — calls existing `listReviews` in `packages/db/src/crud/reviews.ts`.
- `POST /api/reviews/:reviewId/approve` — calls existing `approveReview`.
- `POST /api/reviews/:reviewId/reject` — calls existing `rejectReview`.

**Frontend:** `useReviews` / `useReviewMutation` hooks + `ReviewsPage.tsx`.

**Retire:** Remove `GET /reviews` handler. DELETE + approve/reject POST handlers **stay** (the React frontend calls `/api/reviews/:id/approve` etc., not the old Nunjucks form paths `/reviews/:id/approve`). Delete `reviews.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /reviews to React"`

---

## Task 7: Migrate `/payments`

**Backend:**
- `GET /api/payments?outcome=&page=` → `{ rows: PaymentRow[], total: number }` — calls existing ledger query in `packages/db/src/crud/binance_internal.ts` / related tables.
- `POST /api/payments/:txId/match` — calls `manualMatchTx`.
- `POST /api/payments/:txId/credit` — calls `creditOrderToBalance` for unmatched.

**Frontend:** `usePayments` + `PaymentsPage.tsx`.

**Retire:** Remove `GET /payments` Nunjucks handler. Delete `payments.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /payments to React"`

---

## Task 8: Migrate `/search`

**Backend:**
- `GET /api/search?q=` → `{ orders: ..., users: ..., products: ... }` — calls existing search helpers.

**Frontend:** `useSearch` (driven by `?q=` URL param via React Router `useSearchParams`) + `SearchPage.tsx`.

**Retire:** Remove `GET /search` handler. Delete `search.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /search to React"`

---

## Task 9: Migrate `/vouchers`

**Backend:**
- `GET /api/vouchers?page=` → list of vouchers.
- `POST /api/vouchers` — create.
- `POST /api/vouchers/:id/toggle` — enable/disable.
- `DELETE /api/vouchers/:id` — delete (or deactivate).
Calls existing helpers in `packages/db/src/crud/vouchers.ts`.

**Frontend:** `useVouchers` / `useVoucherMutations` + `VouchersPage.tsx` (inline create form, toggle switch per row).

**Retire:** Remove `GET /vouchers` handler. Delete `vouchers.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /vouchers to React"`

---

## Task 10: Migrate `/admins`

**Backend:**
- `GET /api/admins` → admin list.
- `POST /api/admins` — add admin (Telegram ID + role).
- `DELETE /api/admins/:adminId` — remove.
Calls existing helpers in `packages/db/src/crud/admins.ts`.

**Frontend:** `useAdmins` + `AdminsPage.tsx`.

**Retire:** Remove `GET /admins` handler. Delete `admins.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /admins to React"`

---

## Task 11: Migrate `/users` + `/users/:userId`

**Backend:**
- `GET /api/users?page=&q=` → paginated user list.
- `GET /api/users/:userId` → user detail (orders, wallet balance, referrals).
- `POST /api/users/:userId/adjust-wallet` — wallet credit/debit.
- `POST /api/users/:userId/ban` / `unban`.
Calls existing helpers in `packages/db/src/crud/users.ts`.

**Frontend:** `useUsers` / `useUserDetail` hooks + `UsersPage.tsx` + `UserDetailPage.tsx`.

**Retire:** Remove `GET /users` and `GET /users/:userId` handlers. Delete `users.njk`, `user_detail.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /users to React"`

---

## Task 12: Migrate `/broadcast`

**Backend:**
- `GET /api/broadcast` → recent broadcast history.
- `POST /api/broadcast` — enqueue broadcast (calls `enqueueBroadcast` in `packages/db/src/crud/broadcasts.ts`).

**Frontend:** `useBroadcast` + `BroadcastPage.tsx` — textarea + send button, history list below.

**Retire:** Remove `GET /broadcast` handler. Delete `broadcast.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /broadcast to React"`

---

## Task 13: Migrate `/support` + `/support/:ticketId`

**Backend:**
- `GET /api/support?status=&page=` → ticket list.
- `GET /api/support/:ticketId` → ticket + replies.
- `POST /api/support/:ticketId/reply` — admin reply (enqueues to `notification_outbox` — never sends Telegram directly from web).
- `POST /api/support/:ticketId/close` — close ticket.
Calls existing helpers in `packages/db/src/crud/support.ts`.

**Frontend:** `useSupportTickets` / `useTicketDetail` + `SupportPage.tsx` + `TicketDetailPage.tsx`.

**Retire:** Remove `GET /support` and `GET /support/:ticketId` handlers. Delete `support.njk`, `ticket_detail.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /support to React"`

---

## Task 14: Migrate `/settings`

**Backend:**
- `GET /api/settings` → all settings as `{ key: string; value: string; type: "text"|"secret"|"boolean" }[]` (whitelist-filtered, same as the existing Nunjucks route — secrets shown as `***`).
- `POST /api/settings` — update one or many settings. Same whitelist guard as the existing POST handler (`apps/web-admin/src/routes/settings.ts`).

**Frontend:** `useSettings` / `useSettingsMutation` + `SettingsPage.tsx` — grouped sections (payments, general, thresholds), inline edit per field, save button.

**Retire:** Remove `GET /settings` handler. Delete `settings.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /settings to React"`

---

## Task 15: Migrate `/branding`

**Backend:**
- `GET /api/branding` → current branding settings (shop name, logo URL, colors).
- `POST /api/branding` — update branding.
- `POST /api/branding/logo` — upload logo (multipart; calls existing upload helper).

**Frontend:** `useBranding` / `useBrandingMutation` + `BrandingPage.tsx` — live preview of the shop name/colors, logo upload via `<input type="file">`.

**Retire:** Remove `GET /branding` handler. Delete `branding.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /branding to React"`

---

## Task 16: Migrate `/catalog` + `/catalog/:productId`

**Backend:**
- `GET /api/catalog?page=&q=` → category/product tree + list.
- `GET /api/catalog/:productId` → product detail + denominations.
- `POST /api/catalog` — create product.
- `POST /api/catalog/:productId` — update product.
- `DELETE /api/catalog/:productId` — archive product.
- `POST /api/catalog/import` — multipart CSV import (calls existing `importCatalog`).
Calls existing helpers in `packages/db/src/crud/catalog.ts`.

**Frontend:** `useCatalog` / `useCatalogDetail` / `useCatalogMutations` + `CatalogPage.tsx` + `ProductDetailPage.tsx`.

**Retire:** Remove `GET /catalog`, `GET /catalog/:productId` handlers. Delete `catalog.njk`, `catalog_import_preview.njk`, `product_detail.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /catalog to React"`

---

## Task 17: Migrate `/stock` + `/stock/:productId`

**Backend:**
- `GET /api/stock?page=&q=` → stock list by denomination with counts.
- `GET /api/stock/:productId` → stock items for one denomination.
- `POST /api/stock/:productId/bulk-add` — calls existing `bulkAddStock(prisma, productId, credentials)`.
- `DELETE /api/stock/:productId/item/:itemId` — remove one stock item.
Calls existing helpers in `packages/db/src/crud/stock.ts`.

**Frontend:** `useStock` / `useStockDetail` / `useStockMutations` + `StockPage.tsx` + `StockProductPage.tsx` — credential textarea for bulk-add, table of existing items.

**Retire:** Remove `GET /stock`, `GET /stock/:productId` handlers. Delete `stock.njk`, `stock_product.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /stock to React"`

---

## Task 18: Migrate `/orders` + `/orders/:orderId`

**Backend:**
- `GET /api/orders?status=&q=&page=&since=&until=` → paginated order list. Calls existing `listOrders` / `countOrders`.
- `GET /api/orders/:orderId` → order detail. Calls existing `getOrder` (already returns `orderStatusHistory` after Phase 1's planned extension).
- Leave all existing POST handlers (`/orders/:orderId/approve`, `/reject`, `/credit-balance`, `/cancel-failed`) — the React client calls these unchanged.

**Frontend:** `useOrders` / `useOrderDetail` hooks + `OrdersPage.tsx` + `OrderDetailPage.tsx`.

`OrderDetailPage` highlights:
- Order status timeline from `order.orderStatusHistory`.
- Blockchain tracking section for Bybit BSC orders (`network`, `confirmations`, `requiredConfirmations`).
- Action cards: `can_act` (approve/reject), `can_credit`, `can_resolve_failed` — derived client-side from `order.status`, same logic as the current Nunjucks template.

**Retire:** Remove `GET /orders` and `GET /orders/:orderId` handlers from `apps/web-admin/src/routes/orders.ts`. Delete `orders.njk`, `order_detail.njk`.

Apply the PATTERN. Commit: `"feat(web-admin): migrate /orders to React"`

---

## Task 19: Final Nunjucks cleanup

Once all 16 page migrations above are done:

- [ ] **Step 1: Verify no more Nunjucks `.get()` handlers** (except auth/setup routes):

```bash
grep -rn 'reply\.view' apps/web-admin/src/routes/
```
Expected: Only `auth.ts` and `setup.ts` hits remain.

- [ ] **Step 2: Remove all retired route files** that now have no handlers (or only dead imports):
  - Delete any empty route file whose only `reply.view` calls were removed.
  - Remove their `import` + `app.register(...)` lines from `server.ts`.

- [ ] **Step 3: Remove the Nunjucks plugin (if no Nunjucks routes remain except auth/setup)**

If `auth.ts` and `setup.ts` still use Nunjucks: keep the `viewsPlugin` registration in `server.ts` and keep `_flash.njk` / `base.njk` / `_sidebar.njk` / `_topbar.njk` (or delete the last two since they're replaced by `PageLayout`).

- [ ] **Step 4: Delete retired view files**

All `.njk` files from migrated pages should be deleted by this point. Confirm with:
```bash
ls apps/web-admin/views/
```
Expected: only `base.njk`, `_flash.njk`, `login.njk`, `forgot.njk`, `reset.njk`, `setup_bot.njk`, `setup_done.njk`, `setup_owner.njk`, `setup_shop.njk`, `bootstrap.njk`, `error.njk`.

- [ ] **Step 5: Full suite**

```bash
pnpm --filter @app/web-admin-client build
pnpm typecheck && pnpm test
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web-admin
git commit -m "chore(web-admin): final Nunjucks cleanup — all migrated page views retired"
```

---

## Verification (end-to-end, after all tasks)

1. `pnpm typecheck && pnpm test` green from repo root.
2. Start the app (`pnpm dev:web` after rebuilding the client). Navigate via the React sidebar to every migrated page — confirm real data renders, no "Coming Soon" stubs remain.
3. **Auth guard:** Open an incognito window and visit `/orders`, `/catalog`, etc. — all must 303 → `/login`. Log in → redirect back to the SPA, which renders the correct page.
4. **Mutations:** On `/orders`, approve or reject an order; on `/stock/:id`, bulk-add a credential; on `/vouchers`, create a voucher. Confirm they persist and the list refreshes.
5. **CSRF:** Mutations without a session or with a wrong `X-CSRF-Token` must return 403.
6. **Pre-auth pages unchanged:** `/login`, `/forgot`, `/reset`, `/setup/*` still render their Nunjucks templates normally.
7. **React Router navigation:** Clicking sidebar links and order-code links changes the URL and the page without a full-page reload.
8. **Currency display:** No page ever renders "Rp137 + 20.25 USDT" — every multi-currency display uses `CurrencyStack`.

## Out of scope (future work)

- Migrating `/login`, `/forgot`, `/reset`, `/setup/*` to React (these work fine in Nunjucks and have no benefit from SPA routing).
- File upload progress indicators for catalog CSV import and stock bulk-add.
- Real-time WebSocket updates on Orders/Support pages.
- Mobile-responsive sidebar drawer (hamburger menu) — current layout hides sidebar on small screens via `hidden lg:flex`.
