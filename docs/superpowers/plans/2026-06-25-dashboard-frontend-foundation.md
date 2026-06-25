# Dashboard Frontend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the React+Vite+Tailwind+Shadcn pilot page on top of the existing Fastify app — replacing the Nunjucks dashboard at `/` — with one working section (Revenue KPI card) proving the whole stack end to end: build pipeline, session-auth reuse, CSRF header bridging, and live data from `/api/dashboard/kpis` (shipped in the prior backend plan).

**Architecture:** A new Vite-built React SPA lives in `apps/web-admin/client/`, building into `apps/web-admin/static/dashboard-app/` (served by the Fastify static plugin already registered for `/static/`). A new thin Fastify route serves that built `index.html` at `GET /`, guarded by the existing `currentAdmin` preHandler, with the session's real CSRF token substituted into a placeholder baked into the build. The existing Nunjucks dashboard route is removed; its SLA-fragment route is left in place (orphaned, not deleted — out of scope). TanStack Query handles data fetching against the already-shipped `/api/dashboard/kpis` endpoint.

**Tech Stack:** Vite, React 18, TypeScript, Tailwind CSS v3, shadcn/ui CLI, lucide-react, @tanstack/react-query, Vitest + jsdom + @testing-library/react.

## Global Constraints

- **Never blend currencies into one string** — `CurrencyStack` always renders each currency on its own line; this is the literal bug-fix this whole project exists for.
- **No money arithmetic in the browser** — the backend already returns final, server-computed Decimal-derived strings (e.g. `"10000"`, `"20.25"`). The frontend's `formatCurrencyDisplay` only adds display grouping/prefix (Rp + dotted thousands for IDR; 2dp + suffix for USDT/USD) — it does no rounding, no fx conversion, no precision-sensitive math.
- **Auth/session reuse, no separate frontend auth model** — every route this plan touches is guarded by the existing `currentAdmin` preHandler; the SPA never implements its own login state.
- **`pnpm typecheck` and `pnpm test` must stay green after every task.**
- **One-time setup precedent:** after this plan, a fresh checkout needs `pnpm --filter @app/web-admin-client build` before `pnpm test`/`pnpm dev:web` will fully work — the built `apps/web-admin/static/dashboard-app/index.html` is gitignored (Vite output) and the new `GET /` route reads it from disk. This is the same category of required one-time step as `pnpm exec prisma generate` already is in this repo.

---

## File Structure

- Create `apps/web-admin/client/` — new pnpm workspace package: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`.
- Modify `pnpm-workspace.yaml` — register the new package.
- Modify `.gitignore` — ignore the Vite build output directory.
- Modify `apps/web-admin/src/routes/dashboard.ts` — remove the `GET /` handler (keep `/partials/dashboard-sla`).
- Create `apps/web-admin/src/routes/spaShell.ts` — new `GET /` handler serving the built SPA shell.
- Modify `apps/web-admin/src/server.ts` — swap the route registration.
- Modify `apps/web-admin/src/plugins/auth.ts` — extend `csrfCheck` to accept an `X-CSRF-Token` header.
- Modify `apps/web-admin/test/web.test.ts` — add the SPA-shell-serving test and the CSRF-header test.
- Modify `vitest.config.ts` (root) — add a jsdom environment match for the client package.
- Create `apps/web-admin/client/src/api/client.ts` (+ test), `apps/web-admin/client/src/api/types.ts`.
- Create `apps/web-admin/client/src/components/shared/CurrencyAmount.tsx` (+ test).
- Create `apps/web-admin/client/src/hooks/useDashboardKpis.ts` (+ test).
- Create `apps/web-admin/client/src/components/dashboard/RevenueKpiCard.tsx` (+ test).
- shadcn CLI generates `apps/web-admin/client/components.json`, `src/lib/utils.ts`, `src/components/ui/card.tsx`, `src/components/ui/badge.tsx`.

---

### Task 1: Vite + React + TypeScript scaffold

**Files:**
- Create: `apps/web-admin/client/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`
- Modify: `pnpm-workspace.yaml`, `.gitignore`

**Interfaces:**
- Produces: a buildable, typecheckable Vite app at `apps/web-admin/client/`, building into `apps/web-admin/static/dashboard-app/`.

- [ ] **Step 1: Register the new workspace package**

Replace `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
  - "apps/web-admin/client"
```

- [ ] **Step 2: Ignore the Vite build output**

Add to `.gitignore` (near the existing `dist/` entry):

```
apps/web-admin/static/dashboard-app/
```

- [ ] **Step 3: Create the client package**

Create `apps/web-admin/client/package.json`:

```json
{
  "name": "@app/web-admin-client",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vite": "^6.0.3"
  }
}
```

Create `apps/web-admin/client/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "rootDir": "src",
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]
}
```

Create `apps/web-admin/client/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/static/dashboard-app/",
  build: {
    outDir: "../static/dashboard-app",
    emptyOutDir: true,
  },
});
```

Create `apps/web-admin/client/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="csrf-token" content="__CSRF_TOKEN__" />
    <title>Shop Admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `apps/web-admin/client/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

Create `apps/web-admin/client/src/App.tsx`:

```tsx
export default function App() {
  return <div>Shop Admin dashboard is loading…</div>;
}
```

- [ ] **Step 4: Install and verify**

Run: `pnpm install`
Expected: resolves the new workspace package with no errors.

Run: `pnpm --filter @app/web-admin-client typecheck`
Expected: PASS, no errors.

Run: `pnpm --filter @app/web-admin-client build`
Expected: build succeeds; `apps/web-admin/static/dashboard-app/index.html` and an `assets/` directory with a hashed `.js` file now exist on disk.

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml .gitignore apps/web-admin/client
git commit -m "feat(web-admin): scaffold the Vite+React client package"
```

---

### Task 2: shadcn/ui CLI init + Card/Badge + ported theme tokens

**Files:**
- shadcn CLI creates: `apps/web-admin/client/components.json`, `src/lib/utils.ts`, `src/components/ui/card.tsx`, `src/components/ui/badge.tsx`, and modifies `tailwind.config.ts` (new), `postcss.config.js` (new), `src/index.css` (new), `tsconfig.json` (path aliases), `vite.config.ts` (path alias resolution)
- Modify (by hand, after the CLI runs): `apps/web-admin/client/tailwind.config.ts` — extend with the ported theme tokens
- Modify: `apps/web-admin/client/src/main.tsx` — import the new global stylesheet

**Interfaces:**
- Produces: `Card`, `CardHeader`, `CardContent` from `src/components/ui/card.tsx`; `Badge` from `src/components/ui/badge.tsx` (shadcn's standard exports — Task 8 consumes `Card`/`CardHeader`/`CardContent`).

- [ ] **Step 1: Run the shadcn CLI**

From `apps/web-admin/client/`, run:

```bash
npx shadcn@latest init -d -y
npx shadcn@latest add card badge -y
```

The `-d`/`--defaults` and `-y`/`--yes` flags should make this fully non-interactive (default style, slate base color, CSS variables enabled). **If either command still prompts interactively and hangs, stop and report BLOCKED with the exact prompt text** — do not guess an answer.

Expected: `components.json`, `src/lib/utils.ts`, `src/components/ui/card.tsx`, `src/components/ui/badge.tsx` now exist. `tailwind.config.ts` (or `.js`), `postcss.config.js`, and a global CSS file (commonly `src/index.css` or `src/globals.css`) were created or modified. `tsconfig.json` gained a `@/*` path alias, and `vite.config.ts` gained a matching `resolve.alias`.

- [ ] **Step 2: Port the existing app's theme tokens alongside shadcn's**

Read the CLI-generated `tailwind.config.ts` (or `.js`) and `src/index.css`/`src/globals.css` first — do not overwrite shadcn's own CSS-variable-based tokens (`background`, `foreground`, `primary`, `border`, etc.) or its `darkMode`/`content`/plugin setup. **Add** the following to the `theme.extend` block (merge into whatever shadcn generated, alongside its own `colors`/`fontFamily`/`borderRadius`/`boxShadow` entries — do not replace them):

```js
colors: {
  paper: "#f6f8fb",
  card:  "#ffffff",
  sand:  "#eef1f6",
  line:  "#e3e8ef",
  ink:   { DEFAULT: "#1b2330", soft: "#5a6473", faint: "#97a1b1" },
  pine:  { DEFAULT: "#2563eb", dark: "#1d4ed8", tint: "#e6effe" },
  grass: { DEFAULT: "#16a34a", dark: "#15803d", tint: "#e7f6ec" },
  amberx:{ DEFAULT: "#b45c0a", tint: "#fdedcf" },
  rust:  { DEFAULT: "#dc2626", dark: "#b91c1c", tint: "#fde7e7" },
},
fontFamily: {
  display: ['Outfit', 'system-ui', 'sans-serif'],
  sans: ['Manrope', 'system-ui', 'sans-serif'],
  mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
},
boxShadow: {
  soft: "0 1px 2px rgba(16,24,40,.04), 0 8px 24px -14px rgba(16,24,40,.12)",
  lift: "0 2px 4px rgba(16,24,40,.06), 0 16px 36px -18px rgba(16,24,40,.18)",
},
borderRadius: { xl2: "1.25rem" },
```

These match `packages/web-ui/views/_theme.njk` byte-for-byte (the Nunjucks pages' existing token source of truth) so the React page reads as the same visual family, not a bolted-on look.

- [ ] **Step 3: Import the global stylesheet**

In `apps/web-admin/client/src/main.tsx`, add the import the CLI's global CSS file (whatever it's actually named — `./index.css` or `./globals.css`) as the first line:

```tsx
import "./index.css"; // or "./globals.css" — match whatever shadcn's init created
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @app/web-admin-client typecheck`
Expected: PASS.

Run: `pnpm --filter @app/web-admin-client build`
Expected: build succeeds; the built CSS in `apps/web-admin/static/dashboard-app/assets/*.css` contains both shadcn's base styles and the ported custom tokens (spot-check by grepping the built CSS file for `#2563eb`, the `pine` color).

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client
git commit -m "feat(web-admin): init shadcn/ui (Card, Badge) and port the existing theme tokens"
```

---

### Task 3: Vitest jsdom environment for the client package

**Files:**
- Modify: `vitest.config.ts` (root)
- Modify: `apps/web-admin/client/package.json` — add test deps
- Create: `apps/web-admin/client/src/smoke.test.tsx` (temporary proof, deleted in Step 5 once a real component test exists in a later task — see note)

**Interfaces:**
- Produces: `pnpm test` (run from repo root) now also discovers and runs `.test.tsx` files under `apps/web-admin/client/` in a jsdom environment, while every other package keeps its existing `node` environment.

- [ ] **Step 1: Add test dependencies**

Add to `apps/web-admin/client/package.json`'s `devDependencies`:

```json
"@testing-library/jest-dom": "^6.6.3",
"@testing-library/react": "^16.0.1",
"jsdom": "^25.0.1"
```

Run: `pnpm install`

- [ ] **Step 2: Broaden the root Vitest config**

Replace `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    environmentMatchGlobs: [["apps/web-admin/client/**", "jsdom"]],
    // `node:sqlite` is a recent built-in not yet in Vite's auto-externalised
    // builtins list — externalise it so vite-node leaves the import alone.
    server: { deps: { external: [/^node:sqlite$/] } },
  },
});
```

- [ ] **Step 3: Write a temporary smoke test to prove the jsdom path works**

Create `apps/web-admin/client/src/smoke.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

describe("jsdom environment smoke test", () => {
  it("renders a React element into a jsdom document", () => {
    render(<div>hello from jsdom</div>);
    expect(screen.getByText("hello from jsdom")).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run it**

Run: `pnpm vitest run apps/web-admin/client/src/smoke.test.tsx`
Expected: PASS (1 test) — confirms jsdom + React Testing Library resolve correctly for this package via the new `environmentMatchGlobs` entry.

Run: `pnpm test` (full repo)
Expected: PASS, including the new smoke test, with every other existing test file still using `node` (no environment regression elsewhere).

- [ ] **Step 5: Delete the smoke test**

It was only there to prove the wiring; Task 6 adds the first real component test (`CurrencyAmount.test.tsx`), which supersedes it.

```bash
rm apps/web-admin/client/src/smoke.test.tsx
```

Run: `pnpm test` once more to confirm removal doesn't break anything (no other file references it).

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts apps/web-admin/client/package.json
git commit -m "test(web-admin): add a jsdom Vitest environment for the React client package"
```

---

### Task 4: serve the SPA shell at `GET /`, replacing the Nunjucks dashboard

**Files:**
- Modify: `apps/web-admin/src/routes/dashboard.ts` — remove the `GET /` handler
- Create: `apps/web-admin/src/routes/spaShell.ts`
- Modify: `apps/web-admin/src/server.ts` — swap registration
- Modify: `apps/web-admin/test/web.test.ts`

**Interfaces:**
- Consumes: `currentAdmin` (`../plugins/auth`).
- Produces: `GET /` now returns the built React SPA shell (200, `text/html`) for an authenticated admin, with the session's real CSRF token substituted into the page; still 303-redirects an anonymous request to `/login` (unchanged behavior from the reader's point of view).

- [ ] **Step 1: Write the failing test**

Add to `apps/web-admin/test/web.test.ts`, in the existing `describe("auth", ...)` block, right after the existing `"anon is redirected to /login"` test:

```ts
it("serves the dashboard SPA shell with the real CSRF token baked in, not the build-time placeholder", async () => {
  const res = await get("/", seed.cookie);
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/html");
  expect(res.body).toContain(`name="csrf-token" content="${seed.csrf}"`);
  expect(res.body).not.toContain("__CSRF_TOKEN__");
});
```

- [ ] **Step 2: Build the client so the test has a real file to read**

Run: `pnpm --filter @app/web-admin-client build`
Expected: `apps/web-admin/static/dashboard-app/index.html` exists (from Task 1; rebuild here just to be certain it's current).

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/web-admin/test/web.test.ts`
Expected: FAIL — the new test gets a 200 with the OLD dashboard.njk's HTML (no `csrf-token` meta tag at all), not the SPA shell.

- [ ] **Step 4: Remove the old `GET /` handler**

In `apps/web-admin/src/routes/dashboard.ts`, delete the entire `app.get("/", { preHandler: currentAdmin }, async (req, reply) => { ... });` block (the one that calls `reply.view("dashboard.njk", ...)`). **Leave the `app.get("/partials/dashboard-sla", ...)` handler and the `slaContext`/`shapeRevenue` helper functions untouched** — they're orphaned by this change but out of scope to clean up here (a future plan that finishes migrating the dashboard's operational widgets will retire them).

- [ ] **Step 5: Create the new route**

Create `apps/web-admin/src/routes/spaShell.ts`:

```ts
/**
 * Serves the React dashboard's built SPA shell at "/", replacing the
 * Nunjucks dashboard.njk render. The built index.html (Vite output, with a
 * `__CSRF_TOKEN__` placeholder baked in at apps/web-admin/client/index.html)
 * is read and the placeholder substituted with this session's real CSRF
 * token before sending — Vite's build never sees a real token, so its
 * output is a safe, cacheable static artifact.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { currentAdmin } from "../plugins/auth";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.STATIC_DIR ?? join(HERE, "..", "..", "static");
const SPA_INDEX_PATH = join(STATIC_DIR, "dashboard-app", "index.html");

export default async function spaShellRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", { preHandler: currentAdmin }, async (req, reply) => {
    const html = readFileSync(SPA_INDEX_PATH, "utf-8").replace("__CSRF_TOKEN__", req.admin?.csrf ?? "");
    return reply.type("text/html").send(html);
  });
}
```

- [ ] **Step 6: Register it in server.ts**

In `apps/web-admin/src/server.ts`, add the import next to the other route imports:

```ts
import spaShellRoutes from "./routes/spaShell";
```

And register it in place of where `dashboardRoutes` used to cover `/` — register it right before `await app.register(dashboardRoutes);` (order matters: if `spaShellRoutes` registers after `dashboardRoutes`, and `dashboardRoutes` no longer has a `/` handler post-Step-4, the order no longer actually conflicts — but register `spaShellRoutes` first for clarity, since it's now the owner of `/`):

```ts
  await app.register(spaShellRoutes);
  await app.register(dashboardRoutes);
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run apps/web-admin/test/web.test.ts`
Expected: PASS — including the new test AND every pre-existing test in this file (the login-flow test that does `get("/", cookie)` and checks `statusCode === 200` must still pass, now against the SPA shell instead of dashboard.njk).

- [ ] **Step 8: Commit**

```bash
git add apps/web-admin/src/routes/dashboard.ts apps/web-admin/src/routes/spaShell.ts apps/web-admin/src/server.ts apps/web-admin/test/web.test.ts
git commit -m "feat(web-admin): serve the React SPA shell at / with the real CSRF token baked in"
```

---

### Task 5: CSRF header bridging

**Files:**
- Modify: `apps/web-admin/src/plugins/auth.ts:90-95` (`csrfCheck`)
- Modify: `apps/web-admin/test/web.test.ts`
- Create: `apps/web-admin/client/src/api/client.ts`
- Create: `apps/web-admin/client/src/api/client.test.ts`

**Interfaces:**
- Produces: `csrfCheck` now accepts the CSRF token via `req.body.csrf_token` (existing, unchanged precedence) OR the `X-CSRF-Token` header (new) — either is sufficient.
- Produces: `apiGet<T>(path): Promise<T>` and `apiPost<T>(path, body): Promise<T>` in `apps/web-admin/client/src/api/client.ts` — the latter attaches the page's CSRF token (read from the `<meta name="csrf-token">` tag) as the `X-CSRF-Token` header. No current caller uses `apiPost` yet (this dashboard has no mutating action in this plan) — it exists as foundational plumbing per design decision, ready for the first future mutating endpoint.

- [ ] **Step 1: Write the failing test**

Add to `apps/web-admin/test/web.test.ts`, in the same describe block as the existing `"approve rejects bad CSRF (403)"` test, immediately after it:

```ts
it("approve accepts the CSRF token via an X-CSRF-Token header, with no body field at all", async () => {
  const orderId = await makePendingOrder();
  setBotIdentity({ publicChannelId: -100123456789 });
  const res = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/approve`,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": seed.csrf },
    cookies: { [COOKIE]: seed.cookie },
    payload: form({}),
  });
  expect(res.statusCode).toBe(303);
  expect((await getOrder(prisma, orderId))!.status).toBe("DELIVERED");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/web-admin/test/web.test.ts`
Expected: FAIL with 403 — `csrfCheck` doesn't look at the header yet.

- [ ] **Step 3: Extend `csrfCheck`**

Replace in `apps/web-admin/src/plugins/auth.ts`:

```ts
const csrfCheck: preHandlerHookHandler = async (req, reply) => {
  const bodyToken = (req.body as Record<string, unknown> | undefined)?.csrf_token;
  const headerToken = req.headers["x-csrf-token"];
  const token = bodyToken ?? (typeof headerToken === "string" ? headerToken : undefined);
  if (!token || token !== req.admin?.csrf) {
    return reply.code(403).type("text/plain").send("CSRF check failed");
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/web-admin/test/web.test.ts`
Expected: PASS — including every pre-existing CSRF-related test in this file (the body-field path is unchanged, since `bodyToken ?? ...` still prefers it when present).

- [ ] **Step 5: Write the failing frontend test**

Create `apps/web-admin/client/src/api/client.test.ts`:

```ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { apiGet, apiPost } from "./client";

beforeEach(() => {
  document.head.insertAdjacentHTML("beforeend", '<meta name="csrf-token" content="test-token">');
});
afterEach(() => {
  document.head.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("apiGet", () => {
  it("sends credentials and parses the JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ hello: "world" }) })));
    const result = await apiGet<{ hello: string }>("/api/dashboard/kpis");
    expect(result).toEqual({ hello: "world" });
    expect(fetch).toHaveBeenCalledWith("/api/dashboard/kpis", expect.objectContaining({ credentials: "include" }));
  });

  it("throws when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));
    await expect(apiGet("/api/dashboard/kpis")).rejects.toThrow("403");
  });
});

describe("apiPost", () => {
  it("attaches the CSRF token read from the meta tag as an X-CSRF-Token header", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/api/dashboard/something", { foo: "bar" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("test-token");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ foo: "bar" });
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm vitest run apps/web-admin/client/src/api/client.test.ts`
Expected: FAIL — `client.ts` doesn't exist yet.

- [ ] **Step 7: Add the frontend fetch wrapper**

Create `apps/web-admin/client/src/api/client.ts`:

```ts
/** Read fresh on every call (not cached at module-load time) — this is what
 * makes the CSRF token testable independent of when this module happens to
 * be imported relative to the meta tag existing in the DOM. */
function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.json() as Promise<T>;
}

/** No caller yet in this plan — foundational plumbing for the first future
 * mutating dashboard action. Attaches the page's CSRF token as a header
 * (see apps/web-admin/src/plugins/auth.ts's csrfCheck, which accepts this
 * header as an alternative to the form-field token HTML forms use). */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.json() as Promise<T>;
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm vitest run apps/web-admin/client/src/api/client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Run the full backend test file once more**

Run: `pnpm vitest run apps/web-admin/test/web.test.ts`
Expected: PASS (full file, no regressions).

- [ ] **Step 10: Commit**

```bash
git add apps/web-admin/src/plugins/auth.ts apps/web-admin/test/web.test.ts apps/web-admin/client/src/api/client.ts apps/web-admin/client/src/api/client.test.ts
git commit -m "feat(web-admin): accept CSRF token via X-CSRF-Token header alongside the form field"
```

---

### Task 6: `CurrencyStack` + `formatCurrencyDisplay`

**Files:**
- Create: `apps/web-admin/client/src/components/shared/CurrencyAmount.tsx`
- Create: `apps/web-admin/client/src/components/shared/CurrencyAmount.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function formatCurrencyDisplay(value: string, currency: "IDR" | "USDT" | "USD"): string
  export interface CurrencyAmount { currency: "IDR" | "USDT" | "USD"; value: string }
  export function CurrencyStack({ amounts }: { amounts: CurrencyAmount[] }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/web-admin/client/src/components/shared/CurrencyAmount.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { formatCurrencyDisplay, CurrencyStack } from "./CurrencyAmount";

describe("formatCurrencyDisplay", () => {
  it("formats IDR with a Rp prefix and dotted thousands, no decimals", () => {
    expect(formatCurrencyDisplay("1250000", "IDR")).toBe("Rp1.250.000");
  });

  it("formats USDT/USD with 2 decimals and a currency suffix", () => {
    expect(formatCurrencyDisplay("20.25", "USDT")).toBe("20.25 USDT");
    expect(formatCurrencyDisplay("5", "USD")).toBe("5.00 USD");
  });
});

describe("CurrencyStack", () => {
  it("renders each currency on its own line, never concatenated into one string", () => {
    render(
      <CurrencyStack
        amounts={[
          { currency: "IDR", value: "137" },
          { currency: "USDT", value: "20.25" },
        ]}
      />,
    );
    expect(screen.getByText("Rp137")).toBeInTheDocument();
    expect(screen.getByText("20.25 USDT")).toBeInTheDocument();
    // The exact reported bug shape — must never appear as one joined string.
    expect(screen.queryByText(/Rp137.*\+.*20\.25/)).not.toBeInTheDocument();
  });

  it("renders a single currency with no extra row", () => {
    render(<CurrencyStack amounts={[{ currency: "IDR", value: "50000" }]} />);
    expect(screen.getByText("Rp50.000")).toBeInTheDocument();
    expect(screen.queryByText(/USDT|USD/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/web-admin/client/src/components/shared/CurrencyAmount.test.tsx`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `apps/web-admin/client/src/components/shared/CurrencyAmount.tsx`:

```tsx
/**
 * Pure display formatting only — the backend (packages/db/src/crud) already
 * did every Decimal-precision money computation; these values are final.
 * Mirrors packages/core/src/formatters.ts's formatIdr/formatPrice OUTPUT
 * SHAPE exactly, without re-doing any of their arithmetic.
 */
export function formatCurrencyDisplay(value: string, currency: "IDR" | "USDT" | "USD"): string {
  const n = Number(value);
  if (currency === "IDR") {
    const whole = Math.round(n);
    const grouped = Math.abs(whole).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return `${whole < 0 ? "-" : ""}Rp${grouped}`;
  }
  return `${n.toFixed(2)} ${currency}`;
}

export interface CurrencyAmount {
  currency: "IDR" | "USDT" | "USD";
  value: string;
}

/**
 * Renders each currency on its own line — this component exists specifically
 * so a card can never render "Rp137 + 20.25 USDT" as one joined string (the
 * bug this whole dashboard redesign fixes).
 */
export function CurrencyStack({ amounts }: { amounts: CurrencyAmount[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      {amounts.map((a) => (
        <div key={a.currency} className="flex items-baseline gap-1.5">
          <span className="text-xs font-medium text-ink-soft w-12">{a.currency}</span>
          <span className="font-mono text-sm">{formatCurrencyDisplay(a.value, a.currency)}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/web-admin/client/src/components/shared/CurrencyAmount.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/components/shared/CurrencyAmount.tsx apps/web-admin/client/src/components/shared/CurrencyAmount.test.tsx
git commit -m "feat(web-admin): add CurrencyStack — the component that fixes the mixed-currency display bug"
```

---

### Task 7: TanStack Query + `useDashboardKpis`

**Files:**
- Modify: `apps/web-admin/client/package.json` — add `@tanstack/react-query`
- Create: `apps/web-admin/client/src/api/types.ts`
- Create: `apps/web-admin/client/src/hooks/useDashboardKpis.ts`
- Create: `apps/web-admin/client/src/hooks/useDashboardKpis.test.tsx`
- Modify: `apps/web-admin/client/src/main.tsx` — wrap `<App />` in a `QueryClientProvider`

**Interfaces:**
- Consumes: `apiGet` (`../api/client`, Task 5).
- Produces: `DashboardKpis` type; `useDashboardKpis(): UseQueryResult<DashboardKpis>`.

- [ ] **Step 1: Add the dependency**

Add to `apps/web-admin/client/package.json`'s `dependencies`:

```json
"@tanstack/react-query": "^5.59.16"
```

Run: `pnpm install`

- [ ] **Step 2: Define the response type**

Create `apps/web-admin/client/src/api/types.ts`:

```ts
export interface CurrencyProfit {
  netProfit: string;
  marginPct: string | null;
  excludedItemCount: number;
}

export interface DashboardKpis {
  revenue: {
    idr: string | null;
    usdt: string | null;
    usd: string | null;
    trendPct: { idr: string | null; usdt: string | null };
  };
  profit: { idr: CurrencyProfit | null; usdt: CurrencyProfit | null };
  orders: { total: number; delivered: number; pending: number; failed: number };
  pendingActions: {
    toReview: number;
    refundDecisions: number;
    failedDeliveries: number;
    manualApprovals: number;
  };
}
```

This mirrors the exact response shape `apps/web-admin/src/routes/api/dashboard.ts`'s `/kpis` handler returns.

- [ ] **Step 3: Write the failing test**

Create `apps/web-admin/client/src/hooks/useDashboardKpis.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useDashboardKpis } from "./useDashboardKpis";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useDashboardKpis", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          revenue: { idr: "10000", usdt: null, usd: null, trendPct: { idr: null, usdt: null } },
          profit: { idr: null, usdt: null },
          orders: { total: 1, delivered: 1, pending: 0, failed: 0 },
          pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
        }),
      })),
    );
  });

  it("fetches /api/dashboard/kpis with credentials and returns the parsed response", async () => {
    const { result } = renderHook(() => useDashboardKpis(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.revenue.idr).toBe("10000");
    expect(fetch).toHaveBeenCalledWith("/api/dashboard/kpis", expect.objectContaining({ credentials: "include" }));
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run apps/web-admin/client/src/hooks/useDashboardKpis.test.tsx`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 5: Write the implementation**

Create `apps/web-admin/client/src/hooks/useDashboardKpis.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { DashboardKpis } from "../api/types";

export function useDashboardKpis() {
  return useQuery({
    queryKey: ["dashboard", "kpis"],
    queryFn: () => apiGet<DashboardKpis>("/api/dashboard/kpis"),
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run apps/web-admin/client/src/hooks/useDashboardKpis.test.tsx`
Expected: PASS.

- [ ] **Step 7: Wire up the QueryClientProvider**

Replace `apps/web-admin/client/src/main.tsx`:

```tsx
import "./index.css"; // match whatever Task 2's shadcn init actually named this file
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const queryClient = new QueryClient();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 8: Verify the build still works**

Run: `pnpm --filter @app/web-admin-client build`
Expected: succeeds.

- [ ] **Step 9: Commit**

```bash
git add apps/web-admin/client/package.json apps/web-admin/client/src/api/types.ts apps/web-admin/client/src/hooks apps/web-admin/client/src/main.tsx
git commit -m "feat(web-admin): add TanStack Query and the useDashboardKpis hook"
```

---

### Task 8: `RevenueKpiCard`, final wiring, and full verification

**Files:**
- Create: `apps/web-admin/client/src/components/dashboard/RevenueKpiCard.tsx`
- Create: `apps/web-admin/client/src/components/dashboard/RevenueKpiCard.test.tsx`
- Modify: `apps/web-admin/client/src/App.tsx`

**Interfaces:**
- Consumes: `Card`/`CardHeader`/`CardContent` (shadcn-generated, Task 2), `CurrencyStack`/`CurrencyAmount` (Task 6), `useDashboardKpis` (Task 7).
- Produces: `RevenueKpiCard(): JSX.Element` — the first complete, real dashboard section, rendered inside `App`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web-admin/client/src/components/dashboard/RevenueKpiCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RevenueKpiCard } from "./RevenueKpiCard";

function renderWithQuery() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RevenueKpiCard />
    </QueryClientProvider>,
  );
}

describe("RevenueKpiCard", () => {
  it("renders each currency on its own line once data loads, never joined into one string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          revenue: { idr: "137", usdt: "20.25", usd: "20.25", trendPct: { idr: null, usdt: null } },
          profit: { idr: null, usdt: null },
          orders: { total: 0, delivered: 0, pending: 0, failed: 0 },
          pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
        }),
      })),
    );
    renderWithQuery();
    await waitFor(() => expect(screen.getByText("Rp137")).toBeInTheDocument());
    expect(screen.getByText("20.25 USDT")).toBeInTheDocument();
    expect(screen.queryByText(/Rp137.*\+.*20\.25/)).not.toBeInTheDocument();
  });

  it("shows a no-revenue message when every currency is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          revenue: { idr: null, usdt: null, usd: null, trendPct: { idr: null, usdt: null } },
          profit: { idr: null, usdt: null },
          orders: { total: 0, delivered: 0, pending: 0, failed: 0 },
          pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
        }),
      })),
    );
    renderWithQuery();
    await waitFor(() => expect(screen.getByText("No revenue yet today.")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/web-admin/client/src/components/dashboard/RevenueKpiCard.test.tsx`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `apps/web-admin/client/src/components/dashboard/RevenueKpiCard.tsx`:

```tsx
import { Card, CardContent, CardHeader } from "../ui/card";
import { CurrencyStack, type CurrencyAmount } from "../shared/CurrencyAmount";
import { useDashboardKpis } from "../../hooks/useDashboardKpis";

export function RevenueKpiCard() {
  const { data, isLoading, isError } = useDashboardKpis();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>Revenue Today</CardHeader>
        <CardContent>Loading…</CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <CardHeader>Revenue Today</CardHeader>
        <CardContent>Couldn't load revenue.</CardContent>
      </Card>
    );
  }

  const amounts: CurrencyAmount[] = [];
  if (data.revenue.idr) amounts.push({ currency: "IDR", value: data.revenue.idr });
  if (data.revenue.usdt) amounts.push({ currency: "USDT", value: data.revenue.usdt });
  if (data.revenue.usd) amounts.push({ currency: "USD", value: data.revenue.usd });

  return (
    <Card>
      <CardHeader>Revenue Today</CardHeader>
      <CardContent>
        {amounts.length > 0 ? (
          <CurrencyStack amounts={amounts} />
        ) : (
          <p className="text-sm text-ink-soft">No revenue yet today.</p>
        )}
      </CardContent>
    </Card>
  );
}
```

**Note:** if Task 2's shadcn CLI generated `Card`'s exports under different names or a different file path than `../ui/card` (e.g. it's common for shadcn to export only `Card`, `CardHeader`, `CardTitle`, `CardContent` — no bare-text header support), adjust the import and usage to match what was actually generated — check `apps/web-admin/client/src/components/ui/card.tsx`'s actual exports first, and use `CardTitle` inside `CardHeader` if that's the real shape (e.g. `<CardHeader><CardTitle>Revenue Today</CardTitle></CardHeader>`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/web-admin/client/src/components/dashboard/RevenueKpiCard.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire it into App**

Replace `apps/web-admin/client/src/App.tsx`:

```tsx
import { RevenueKpiCard } from "./components/dashboard/RevenueKpiCard";

export default function App() {
  return (
    <div className="min-h-screen bg-paper p-6">
      {/* Matches .page-title's computed style from packages/web-ui/views/
          _theme.njk (Outfit, 1.875rem/600/-0.025em, ink) as literal Tailwind
          utilities — that CSS class lives in the Nunjucks pages' stylesheet,
          not this bundle, so it can't be referenced by name here. */}
      <h1 className="mb-6 font-display text-3xl font-semibold tracking-tight text-ink">Shop Admin</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <RevenueKpiCard />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Full verification**

Run: `pnpm --filter @app/web-admin-client build`
Expected: succeeds.

Run: `pnpm typecheck` (repo root)
Expected: PASS, all 9 workspace projects (the new client package included).

Run: `pnpm test` (repo root)
Expected: PASS — the only acceptable failures are the 2 pre-existing, already-flagged `notifications.test.ts` failures (unrelated to this plan, documented in PR #22's notes); nothing else should fail.

- [ ] **Step 7: Manual browser verification**

Per this repo's UI-change convention, start the app and actually look at it before calling this done:

```bash
pnpm --filter @app/web-admin-client build
pnpm dev:web
```

Log in as an admin in a browser, confirm:
- `/` now shows the new React page (page title "Shop Admin", one Revenue Today card).
- The Revenue Today card shows real numbers if any orders were delivered today in the dev DB, or "No revenue yet today." otherwise — never a concatenated "Rp137 + 20.25 USDT"-style string.
- View page source (or DevTools Elements) and confirm the `<meta name="csrf-token">` tag has a real-looking token value, not `__CSRF_TOKEN__`.
- Logging out and hitting `/` directly redirects to `/login` (auth guard still works).

- [ ] **Step 8: Commit**

```bash
git add apps/web-admin/client/src/components/dashboard apps/web-admin/client/src/App.tsx
git commit -m "feat(web-admin): add RevenueKpiCard and wire it into the dashboard SPA shell"
```

---

## Verification

- After Task 8, `pnpm typecheck && pnpm test` from the repo root must be green (modulo the 2 pre-existing unrelated `notifications.test.ts` failures).
- `/` serves the new React SPA shell for an authenticated admin and 303-redirects an anonymous request to `/login`, exactly as the old Nunjucks dashboard did from an auth standpoint.
- The Revenue Today card never renders two currencies joined into one string — this is the single most important thing to eyeball-check in the browser per Step 7 above.
- Every other admin page is unaffected — this plan touches only `dashboard.ts`'s `/` handler (removed), `server.ts` (one new registration), `auth.ts`'s `csrfCheck` (additive), and net-new files.
