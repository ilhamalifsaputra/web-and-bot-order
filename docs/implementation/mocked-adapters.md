# Mocked adapters register (§11)

> Every adapter that is **not** backed by a real endpoint is listed here with
> its expected contract, so nothing ships silently faked (prompt §11).

---

## Status: **none**

This storefront rebuild introduced **zero mocked adapters**.

### Why there are none

The storefront was already a fully wired React SPA before this redesign
began (migrated from Nunjucks+HTMX on 2026-07-05, see
`docs/REACT_STOREFRONT_MIGRATION.md`). Every page fetches through
`apps/storefront/client/src/api/client.ts` against real
`/api/v1/*` endpoints served by the Fastify app in `apps/storefront/src`,
which in turn read the Postgres database through `packages/db`. The
redesign was a **presentation-layer re-skin** (§2: "KEEP business logic,
CHANGE the visual language") — it did not add a single new screen, data
requirement, or backend call, so there was never a missing endpoint to
stand in for.

Every Fase 7 task carried an explicit hard boundary forbidding changes to
mutation payloads, endpoint strings, query keys, and data-fetching logic;
the money-critical tasks (13/14) were reviewed line-by-line to confirm the
API surface was untouched. New UI state that the redesign *did* add is all
client-local and needs no backend:

| New client-only state | Where | Backing |
|---|---|---|
| Search overlay open/query | `SearchOverlayProvider` (Task 12) | React context; hits the **existing** `GET /api/v1/pages/search?q=` |
| Recent searches | `src/lib/recentSearches.ts` (Task 12) | `localStorage` (was already localStorage-backed on the old `SearchPage`) |
| Logout / cancel-order confirmation dialogs | `AlertDialog` on AccountPage / PayPage (Tasks 14, 16) | none — the dialog gates the **existing** `logoutMutation` / `cancelMutation`, which are unchanged |
| OrdersPage client-side filter | `OrdersPage` local state (Task 16) | none — filters the already-fetched `data.orders` array; the `GET /api/v1/account/orders` call is unchanged |
| `/search` redirect | `SearchRedirect` (Task 12) | none — pure client route → opens the overlay |

### Test doubles are not adapters

The `vi.mock("../api/client")` calls and `src/test/fakeXhr.ts` in the test
suite are test infrastructure, not shipped code — they do not appear in
the production bundle and are out of scope for this register.

---

_Last reviewed: end of Fase 7 (all 32 routes migrated)._
