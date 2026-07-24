# Search Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the admin Search page (`apps/web-admin/client/src/pages/SearchPage.tsx`) up to the design-system's structural conventions — adopt the shared `FilterBar`/`SearchBar` instead of a hand-rolled `<Input>`+`<Button>` form, and give each result table (and the overall no-results state) a real `EmptyState` instead of the current guard-and-hide pattern — per `docs/audit-ui-ux-structural-2026-07-24.md`'s P1 finding.

**Architecture:** Purely frontend, no backend changes (`GET /api/search`'s 25-per-category cap and lack of pagination are deliberately out of scope — this is a bounded quick-lookup utility, not a primary growing list, per `docs/ui/04_CRUD_TEMPLATE.md`'s two-tier system). Replace the manual submit-only form with a debounced `SearchBar` inside a `FilterBar` (mirroring `PaymentsPage.tsx`'s exact 300ms debounce pattern), writing to the same `q` URL search param the page already uses. Remove the `data.users.length > 0 && (...)` / `data.products.length > 0 && (...)` guards around each `DataTable` and replace them with real `empty` props, so a partial match (e.g. products found, no users) now visibly shows a "No matching customers." message instead of silently hiding that section. Upgrade the top-level all-empty state from a title-only `EmptyState` to one with an icon and description.

**Tech Stack:** React + TanStack Query + shadcn/Tailwind (frontend), Vitest + React Testing Library (tests).

## Global Constraints

- No backend changes — `apps/web-admin/src/routes/api/search.ts` is untouched by this plan.
- No `Pagination` component added — this is a simple-tier page per `docs/ui/04_CRUD_TEMPLATE.md`, and the audit's own rubric warns against over-flagging small/bounded lists.
- UI reuses the shared `FilterBar`/`SearchBar`/`EmptyState` components — never hand-roll a new search input or empty-state pattern.
- The debounce pattern must mirror `apps/web-admin/client/src/pages/PaymentsPage.tsx`'s exact 300ms `useEffect`+`setTimeout` shape.
- Preserve unchanged: the `exactOrderId` auto-navigate-to-order side effect, the two-`DataTable` section layout (no tabs/consolidation), the bookmarkable `q` URL search param.
- `pnpm typecheck` and `pnpm test` must stay green after every task.

---

### Task 1: Replace the manual form with `FilterBar`+`SearchBar` (debounced)

**Files:**
- Modify: `apps/web-admin/client/src/pages/SearchPage.tsx`
- Modify: `apps/web-admin/client/src/pages/SearchPage.test.tsx`

**Interfaces:**
- Consumes: `SearchBar` (`apps/web-admin/client/src/components/shared/SearchBar.tsx`, props `{ value, onChange, placeholder?, className? }`), `FilterBar` (`apps/web-admin/client/src/components/shared/FilterBar.tsx`, props `{ children, onApply?, onClear?, className? }`).
- Produces: no new exports — internal page behavior only. The `q` URL search param and `useSearch(q)` hook signature are unchanged; only how `q` gets set changes (debounced typing instead of submit-only).

- [ ] **Step 1: Write the failing test**

Add to `SearchPage.test.tsx` (add `fireEvent` to the existing `@testing-library/react` import, and `vi` is already imported):

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
```

```tsx
  it("debounces typed input into the q URL param", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ q: "andi", exactOrderId: null, users: [], products: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SearchPage />, { wrapper: Wrapper });
    await vi.waitFor(() => expect(screen.getByText(/no results/i)).toBeInTheDocument());

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ q: "budi", exactOrderId: null, users: [], products: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const search = screen.getByPlaceholderText(/order code, username, or product/i);
    fireEvent.change(search, { target: { value: "budi" } });
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("q=budi")));
    vi.useRealTimers();
  });

  it("does not render a Search button — typing alone drives the query", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ q: "andi", exactOrderId: null, users: [], products: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SearchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no results/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/SearchPage.test.tsx -t "debounces typed input|does not render a Search button"`
Expected: FAIL — the current page has no `getByPlaceholderText(/order code, username, or product/i)` match via `SearchBar` (the current `<Input>` does match that placeholder, but the debounce timing test will fail since no debounce exists yet — `fetchSpy` gets called immediately or not at all), and the "no Search button" test fails since the button currently exists.

- [ ] **Step 3: Write minimal implementation**

In `apps/web-admin/client/src/pages/SearchPage.tsx`, add imports:

```ts
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
```

Remove the now-unused `Button`/`Input` imports if nothing else in the file uses them after this task (check — `Button` is not used elsewhere in this file; `Input` is not used elsewhere either, so both imports should be removed):

```ts
// Remove these two lines:
// import { Button } from "@/components/ui/button";
// import { Input } from "@/components/ui/input";
```

Replace the `input` state and `submit` function with debounced state, mirroring `PaymentsPage.tsx`'s exact pattern:

```ts
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get("q") ?? "";
  const [draft, setDraft] = useState(q);
  const { data, isError, isFetching } = useSearch(q);

  useEffect(() => { setDraft(q); }, [q]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = draft.trim();
      if (trimmed) setParams({ q: trimmed });
      else setParams({});
    }, 300);
    return () => clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    if (data?.exactOrderId) {
      navigate(`/orders/${data.exactOrderId}`);
    }
  }, [data?.exactOrderId, navigate]);

  return (
    <PageLayout title="Search">
      <PageHeader title="Search" />

      <FilterBar className="mb-6">
        <SearchBar
          value={draft}
          onChange={setDraft}
          placeholder="Order code, username, or product…"
          className="w-full sm:w-96"
        />
      </FilterBar>

      {isError && <p className="text-sm text-rust">Failed to load results.</p>}
      {isFetching && <p className="text-sm text-ink-soft">Searching…</p>}
```

(The rest of the component body — the `data && !isFetching` block and everything inside it — is untouched by this task; Task 2 modifies it.)

Note: the debounce effect setting `setParams({})` when `draft` is empty deliberately clears the URL param (matching the old form's behavior of doing nothing on an empty submit would have left stale results visible — the debounced version instead clears results as soon as the field is emptied, which is the correct live-search behavior and is what the "renders user and product results" pre-existing test's initial `q=andi` URL entry already relies on being present for `useSearch`'s `enabled: q.length > 0` gate).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/SearchPage.test.tsx`
Expected: PASS (all tests, including the 3 pre-existing ones — the pre-existing tests never interact with the search input, so they should be unaffected by the debounce/FilterBar swap)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/SearchPage.tsx apps/web-admin/client/src/pages/SearchPage.test.tsx
git commit -m "feat(web-admin-client): replace SearchPage's manual form with FilterBar+SearchBar"
```

---

### Task 2: Real per-table `empty` props (remove the length-guard hiding pattern)

**Files:**
- Modify: `apps/web-admin/client/src/pages/SearchPage.tsx`
- Modify: `apps/web-admin/client/src/pages/SearchPage.test.tsx`

**Interfaces:**
- Consumes: `DataTable`'s `empty?: ReactNode` prop (`apps/web-admin/client/src/components/shared/DataTable.tsx:60`), `EmptyState`'s `{ icon?, title?, description? }` props.
- Produces: no new exports — internal page behavior only.

- [ ] **Step 1: Write the failing test**

Add to `SearchPage.test.tsx`:

```tsx
  it("shows a per-table empty state for the category with no matches, while the other category still renders", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          q: "netflix",
          exactOrderId: null,
          users: [],
          products: [{ id: 10, name: "Netflix 1mo", product: { name: "Netflix" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SearchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Netflix 1mo")).toBeInTheDocument());

    expect(screen.getByText(/no matching customers/i)).toBeInTheDocument();
    expect(screen.queryByText(/no results for/i)).not.toBeInTheDocument();
  });

  it("shows a per-table empty state for products when only users match", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          q: "andi",
          exactOrderId: null,
          users: [{ id: 1, username: "andi", fullName: "Andi Santoso", telegramId: "111" }],
          products: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SearchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    expect(screen.getByText(/no matching products/i)).toBeInTheDocument();
  });

  it("shows an icon and description on the all-empty state, not just a title", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ q: "xyz", exactOrderId: null, users: [], products: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SearchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no results for/i)).toBeInTheDocument());
    expect(screen.getByText(/try an order code, username, or product name/i)).toBeInTheDocument();
  });
```

Note: this task changes the page's structure so that both `DataTable`s are ALWAYS rendered (each showing its own `empty` state when its category has zero hits) rather than being conditionally hidden — this means the existing "shows no-results message for empty results" test (line 37-46 of the current file) needs updating: with both tables always present, the top-level `EmptyState` should render only when BOTH are empty, and it should NOT also show two redundant per-table empty states at the same time. Decide via Step 3's implementation: when both are empty, show only the top-level all-empty `EmptyState` and skip rendering the two `DataTable`s entirely (this preserves the existing "shows no-results message for empty results" test's expectation of a single un-duplicated empty message, and matches the brief's design intent that the all-empty case has its own richer state, not two nested `DataTable` empties stacked under it).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/SearchPage.test.tsx -t "per-table empty state|icon and description"`
Expected: FAIL — the current guards hide the section entirely on zero hits (no "No matching customers."/"No matching products." text exists anywhere), and the top-level empty state has no description text.

- [ ] **Step 3: Write minimal implementation**

Add `Users` and `PackageSearch` (or similar) icons to a new `lucide-react` import, and `SearchX` for the top-level empty state:

```ts
import { Users, PackageSearch, SearchX } from "lucide-react";
```

Replace the entire `{data && !isFetching && (...)}` block with:

```tsx
      {data && !isFetching && (
        <>
          {data.users.length === 0 && data.products.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title={`No results for "${data.q}"`}
              description="Try an order code, username, or product name."
            />
          ) : (
            <>
              <section className="mb-6">
                <h2 className="text-sm font-semibold text-ink mb-3">
                  Customers ({data.users.length})
                </h2>
                <DataTable
                  columns={[
                    {
                      key: "name",
                      header: "Name",
                      render: u => u.fullName ?? "—",
                    },
                    {
                      key: "username",
                      header: "Username",
                      render: u => u.username ? `@${u.username}` : "—",
                    },
                    {
                      key: "tid",
                      header: "Telegram ID",
                      render: u => <span className="font-mono text-xs">{u.telegramId}</span>,
                    },
                  ]}
                  data={data.users}
                  keyExtractor={u => u.id}
                  onRowClick={u => navigate(`/users/${u.id}`)}
                  empty={<EmptyState icon={Users} title="No matching customers." description="Try a different search term." />}
                />
              </section>

              <section>
                <h2 className="text-sm font-semibold text-ink mb-3">
                  Products ({data.products.length})
                </h2>
                <DataTable
                  columns={[
                    {
                      key: "denom",
                      header: "Denomination",
                      render: p => p.name,
                    },
                    {
                      key: "product",
                      header: "Product",
                      render: p => p.product?.name ?? "—",
                    },
                  ]}
                  data={data.products}
                  keyExtractor={p => p.id}
                  onRowClick={p => navigate(`/catalog/${p.id}`)}
                  empty={<EmptyState icon={PackageSearch} title="No matching products." description="Try a different search term." />}
                />
              </section>
            </>
          )}
        </>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/SearchPage.test.tsx`
Expected: PASS (all tests — the 3 pre-existing tests plus the 2 new tests from Task 1 plus the 3 new tests from this task, 8 total)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/SearchPage.tsx apps/web-admin/client/src/pages/SearchPage.test.tsx
git commit -m "feat(web-admin-client): give each SearchPage result table a real empty state"
```

---

## Final verification (after Task 2)

- [ ] Run the full monorepo check:

```bash
pnpm typecheck
pnpm test
pnpm --filter @app/web-admin-client build
```

Expected: all exit 0.

- [ ] Manual check (`pnpm dev:web`, browse `http://127.0.0.1:8000/search`):
  1. Type a partial query (e.g. a username substring) and confirm results update ~300ms after typing stops, without pressing Enter or a button.
  2. Search a term matching only a product, confirm the Customers section shows "No matching customers." instead of disappearing.
  3. Search a term matching only a user, confirm the Products section shows "No matching products." instead of disappearing.
  4. Search a term matching nothing, confirm the single all-empty state (icon + title + description) renders, with no duplicate per-table empty states underneath it.
  5. Search an exact order code, confirm the existing auto-navigate-to-order behavior still works unchanged.
