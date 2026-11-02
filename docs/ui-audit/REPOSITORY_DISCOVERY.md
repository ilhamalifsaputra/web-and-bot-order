# Repository discovery

Only what was found in the repository is listed. See also
[docs/arsitektur](../arsitektur) and [docs/ui](../ui) for the existing
architecture and UI rules; this file does not repeat them.

## Stack

| Item | Found |
|---|---|
| Package manager | pnpm workspace (`pnpm-workspace.yaml`) |
| Frontends | React 19 SPAs built with Vite: `apps/web-admin/client`, `apps/storefront/client` |
| Backends | Fastify: `apps/web-admin/src/main.ts`, `apps/storefront/src/main.ts` |
| Data | Prisma + PostgreSQL (`prisma/schema.prisma`, `packages/db/src/crud/*`) |
| Server state in clients | TanStack Query v5 (`@tanstack/react-query` ^5.104) |
| Routing | react-router 7 (`App.tsx` in each client) |
| Icons | `lucide-react` 1.58 in both clients |
| Styling | Tailwind with per-app tokens in `client/src/index.css` |
| Motion | `motion/react`, `MotionConfig reducedMotion="user"` in both `main.tsx` |
| Tests | Vitest 4 (`vitest.config.ts`), Testing Library, jsdom; server tests use Fastify inject against an isolated Postgres |
| Static checks | `pnpm typecheck`, `pnpm lint` (eslint + React Doctor bugs), `pnpm doctor:full` |
| E2E | none configured; Playwright is available only as an MCP tool |
| Logging | Pino (`packages/core/src/logger.ts`), audit log `logAdminAction` |

## API clients

| App | File | Notes |
|---|---|---|
| Web admin | `apps/web-admin/client/src/api/client.ts` | `apiGet/apiPost`, `throwForResponse` (401 sets the session-expired flag, text 403 mapped to a permission message, CSRF 403 asks for a reload); no timeout |
| Web admin | `api/idempotency.ts`, `api/queryClient.ts`, `api/sessionExpiry.ts` | `useIdempotentPost`; retry policy (no retry on 401/403) |
| Storefront | `apps/storefront/client/src/api/client.ts` | CSRF from the meta tag, adopted from a GET's `csrf_token`; no timeout |
| Storefront | `api/idempotency.ts` | `useIdempotentPost`, `orderFailureOutcome` |

## Auth

- Admin: session cookie, `currentAdmin`, `roleGate`, `requireSuper`,
  `blockReadonlyReads`, `csrfProtect` (`apps/web-admin/src/plugins/auth.ts`).
  Roles: super, support, readonly.
- Storefront: customer session, guest-checkout session, order-recovery scoped
  session (`apps/storefront/src/plugins/auth.ts`), CSRF per session.

## Route inventory

Routes are read from each `App.tsx`. Module/API detail per route is in the two
surface audits.

**Storefront (35 paths including `*` and the dev-only `/__ui` gallery):**
`/`, `/products`, `/categories`, `/c/:slug`, `/g/:slug`, `/p/:slug`, `/flash`,
`/search`, `/cart`, `/checkout`, `/checkout/:code/pay`, `/wallet/topup`,
`/wallet/topup/:code/pay`, `/track`, `/login`, `/register`, `/forgot`,
`/reset/:token`, `/account`, `/account/orders`, `/account/orders/:code`,
`/account/support`, `/account/support/:id`, `/account/referral`,
`/account/reviews`, `/account/settings`, `/help`, `/about`, `/contact`,
`/how-to-order`, `/terms`, `/privacy`, `/refund`, `/__ui`, `*`.

**Web admin (43 paths including `*`):** `/`, `/orders`, `/orders/:orderId`,
`/payments`, `/settlements`, `/wallet-transactions`, `/users`, `/users/:userId`,
`/catalog`, `/catalog/new`, `/catalog/:productId`,
`/catalog/:productId/denominations/new`,
`/catalog/:productId/denominations/:denomId/edit`, `/catalog/digiflazz-sync`,
`/categories`, `/stock`, `/stock/:productId`, `/flash-sales`, `/vouchers`,
`/pricing`, `/reviews`, `/support`, `/support/:ticketId`, `/tasks`,
`/broadcast`, `/outbox`, `/reports`, `/audit`, `/search`, `/admins`,
`/settings`, `/email-notifications`, `/branding`, `/storage`, `/login`,
`/forgot`, `/reset`, `/bootstrap`, `/setup`, `/setup/owner`, `/setup/shop`,
`/setup/done`, `*`.

`report.json` counts 78 routes (35 + 43) and 14 modules: catalog, search,
cart/checkout, payments, wallet, orders, order recovery, customer account,
support/tickets, auth/session, admin operations (orders, payments,
settlements), admin catalog/stock/pricing, admin messaging (broadcast,
outbox), admin settings/setup.

## Baseline at the start of the branch

From the first task: typecheck, lint and React Doctor were clean at
`2ebb5de0`. The full test suite was not run (stopped for machine memory), so
there is no full-suite baseline.
