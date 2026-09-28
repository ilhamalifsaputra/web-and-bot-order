# Trustance — Frontend Architecture

## FRONTEND-ARCHITECTURE-V2 — Canonical React SPA Storefront & Web Admin Architecture

**Status:** CANONICAL
**Document type:** Engineering source of truth (not a tutorial, not a style guide)
**Scope:** Storefront Web + Web Admin
**Runtime:** Node.js + TypeScript
**Frontend:** React SPA + TypeScript
**Routing:** React Router
**Styling:** Tailwind CSS
**Testing:** Vitest + React Testing Library
**E2E:** Playwright
**Backend:** Fastify + TypeScript (Trustance Application/API)
**Database:** PostgreSQL + Prisma (backend only — the frontend never accesses Prisma)
**Channels:** Storefront Web, Web Admin, Telegram Bot
**Shared UI:** `packages/web-ui`
**Shared contracts:** `packages/api-contracts`, `packages/validation`

**Purpose:** This document is the single source of truth for Trustance frontend
architecture. It defines how the Storefront and Web Admin presentation surfaces
are structured, how they depend on the Fastify application/API, and which rules
must never be violated. It is aligned with the backend modular monolith, the
PostgreSQL/Prisma data architecture, the Telegram Bot channel, and the commerce,
multi-currency, fulfillment, security, and reliability architectures.

**Rendering model:** The Storefront and Web Admin are browser-rendered React
single-page applications. There is no SSR, no server component boundary, and no
server-action boundary in this architecture. Every reference to server rendering
in this document appears only to state that it is explicitly out of scope.

---

## Table of Contents

| # | Section |
|---|---------|
| 0 | Source of Truth |
| 1 | Architecture Principles |
| 2 | Architectural Boundaries and Dependency Direction |
| 3 | Target Repository Structure |
| 4 | Frontend Layer Architecture |
| 5 | Directory Responsibility Model |
| 6 | Storefront Architecture |
| 7 | Web Admin Architecture |
| 8 | Storefront vs Web Admin Boundary |
| 9 | React Router Architecture |
| 10 | State Architecture: Server / UI / Form / Session |
| 11 | API Client Architecture (`services/`) |
| 12 | Fastify API Boundary |
| 13 | Shared API Contract Architecture |
| 14 | Money and Multi-Currency Rules |
| 15 | Product Capability Architecture |
| 16 | Commerce Flows |
| 17 | Cart Architecture |
| 18 | Checkout Architecture |
| 19 | Payment and Fulfillment State Machines |
| 20 | Order Architecture |
| 21 | Fulfillment UI |
| 22 | Idempotency |
| 23 | Error Architecture |
| 24 | Form and Validation Architecture |
| 25 | Nickname Check UI |
| 26 | Provider Isolation |
| 27 | Notification Architecture |
| 28 | Authentication and Session Architecture |
| 29 | Authorization and RBAC |
| 30 | Security |
| 31 | Tailwind and Styling Architecture |
| 32 | Accessibility |
| 33 | Responsive Design |
| 34 | Performance |
| 35 | Observability |
| 36 | Testing Architecture |
| 37 | E2E Test Architecture |
| 38 | Deployment |
| 39 | Environment Variables |
| 40 | PostgreSQL Alignment |
| 41 | Frontend Anti-Patterns |
| 42 | Architectural DO / DO NOT |
| 43 | Architectural Invariants |
| 44 | Decision Guide for Engineers and Coding Agents |
| 45 | Definition of Done |
| 46 | Final Architectural Principle |
| A | Appendix: Canonical Terminology |

---

## 0. Source of Truth

This document must be read together with:

- Trustance Master Implementation Architecture
- Trustance Backend Architecture
- Trustance Prisma + PostgreSQL + Docker Database Architecture
- Trustance Telegram Bot Architecture FINAL v3.2

The frontend is not a business engine. The backend Application layer remains the
source of truth for:

- product availability
- price
- discount and promotion outcome
- stock
- inventory reservation
- nickname validity
- order status
- payment status
- fulfillment status
- refund
- ownership
- financial values
- authorization
- provider state

Web and Telegram differ only in transport and presentation. Business commands,
domain state, validation contracts, error taxonomy, capability contracts, and
status contracts remain identical across channels.

When this document and an implementation disagree, this document wins until it is
amended. When this document and the backend architecture disagree, the backend
architecture wins for domain semantics, and this document must be corrected.

---

## 1. Architecture Principles

### 1.1 Canonical Frontend Stack

``` text
Runtime       Node.js + TypeScript
Frontend      React SPA
Routing       React Router
Styling       Tailwind CSS
Testing       Vitest + React Testing Library
E2E           Playwright
Backend       Fastify + TypeScript
API           Fastify HTTP API
Database      PostgreSQL + Prisma (backend only)
```

The Storefront and Web Admin are browser-rendered React applications. The Fastify
API is the only application/server boundary the frontend is permitted to use.

No alternative frontend framework, meta-framework, server-rendering runtime, or
server-action mechanism may be introduced without a versioned architecture change
to this document.

### 1.2 Shared Commerce Core

Trustance follows a single canonical commerce flow:

``` text
Customer
  ↓
Catalog
  ↓
Cart / Buy Now
  ↓
Checkout
  ↓
Order
  ↓
Payment
  ↓
Fulfillment
  ↓
Delivery
  ↓
Support / Refund
```

The Storefront must consume the same application/API contract as the Telegram Bot
and the Web Admin.

Forbidden:

``` text
Storefront → business logic A
Telegram   → business logic B
Web Admin  → business logic C
```

Correct:

``` text
Storefront ─────┐
Telegram Bot ───┼──→ Trustance Application (Fastify API)
Web Admin ──────┘
```

### 1.3 The Backend Is the Source of Truth

The frontend never computes or permanently establishes business truth.

The frontend may:

- perform client-side validation for UX
- display price
- display stock
- compute preview subtotals for UX only
- manage form state
- manage loading and error state
- apply optimistic UI only where it is provably safe to reverse

The frontend must not:

- determine the final price
- determine the final discount
- determine final stock
- create its own inventory reservation
- mark a payment as `PAID`
- mark a fulfillment as `DELIVERED`
- call provider APIs directly
- access the database
- implement ledger logic
- implement provider routing or fallback

Final validation and mutation always happen server-side.

### 1.4 Frontend Posture

The frontend is a **channel/presentation system**. Its responsibilities are:

``` text
Present server truth
Collect customer/operator intent
Send well-formed commands
Render authoritative responses
Handle failure states clearly
```

Anything beyond that list is a candidate for the backend, not the browser.

---

## 2. Architectural Boundaries and Dependency Direction

This section is normative. If any other section of this document appears to
contradict it, this section wins.

### 2.1 Canonical Execution Model

``` text
Browser
  ↓
React SPA
  ↓
React Router
  ↓
Feature UI
  ↓
Application Client (services/)
  ↓
Fastify API
  ↓
Application Use Case
  ↓
Domain
  ↓
Infrastructure
  ↓
PostgreSQL / External Providers
```

Everything above the Fastify API line executes in the browser. Everything below it
executes on the server. The browser never executes backend business logic; it only
issues commands and queries across the HTTP boundary.

### 2.2 The Dependency Rule

Dependencies point in one direction only:

``` text
Route
  ↓
Feature
  ↓
UI Component / Application Hook
  ↓
Application Client
  ↓
API Contract
  ↓
Fastify API
```

Rules:

- A layer may depend on the layer directly beneath it.
- A layer must never depend upward.
- `components/` and `packages/web-ui` must never import from `features/`.
- `services/` must never import from `features/` or `app/`.
- A feature must never import another feature's internals; cross-feature reuse
  goes through `packages/web-ui`, `components/`, `hooks/`, `lib/`, or the shared
  contracts.
- Route modules must never contain commerce transaction logic.

### 2.3 Allowed Frontend Dependencies

For backend interaction, frontend code may depend on:

``` text
API contracts          packages/api-contracts
DTOs                   packages/api-contracts
Validation schemas     packages/validation
Status enums           packages/api-contracts/status.ts
Error taxonomy         packages/api-contracts/errors.ts
Capability definitions packages/api-contracts (product capability)
Money representation   packages/api-contracts/money.ts
Pagination contract    packages/api-contracts/pagination.ts
Shared UI primitives   packages/web-ui
```

### 2.4 Forbidden Frontend Dependencies

Frontend code must never depend on:

``` text
Prisma models
Prisma Client
repository implementations
domain service implementations
provider clients
provider credentials
queue/worker internals
outbox internals
backend infrastructure modules
server-only environment variables
```

If a piece of frontend code needs one of these, the requirement is wrong: the
capability belongs behind an application use case exposed through the API.

### 2.5 Boundary Enforcement

Boundary enforcement is an architectural requirement. The mechanism is an
implementation decision, but at minimum the repository must enforce:

- import-boundary linting between `apps/*` and backend-only packages
- a build that fails if browser bundles resolve Prisma or provider packages
- TypeScript project references or path restrictions that make forbidden imports
  unresolvable rather than merely discouraged
- review rules for any new dependency added to a frontend `package.json`

This document does not prescribe a specific lint plugin. It prescribes that the
boundary must be mechanically enforced, not only documented.

### 2.6 Rendering Boundary

The React SPA is entirely browser-rendered.

``` text
No SSR
No server components
No server actions
No server-side data loading inside React
```

All React code is client code. Public catalog and product pages are ordinary
navigable SPA routes. If SEO requires pre-rendered HTML, it must be solved with an
explicit prerendering/SSG or edge-prerender strategy documented as a versioned
change — it must never be solved by introducing a server-rendering framework or by
moving business logic into a rendering layer.

Fastify remains the only server boundary for API operations and authoritative
state.

---

## 3. Target Repository Structure

``` text
apps/
├── server/
│   └── src/
│       ├── composition.ts
│       ├── http/
│       ├── webhooks/
│       ├── workers/
│       └── bootstrap/
│
├── storefront/
│   └── src/
│       ├── app/
│       ├── components/
│       ├── features/
│       ├── layouts/
│       ├── lib/
│       ├── hooks/
│       ├── stores/
│       ├── services/
│       ├── forms/
│       ├── schemas/
│       ├── providers/
│       ├── styles/
│       └── tests/
│
├── web-admin/
│   └── src/
│       ├── app/
│       ├── components/
│       ├── features/
│       ├── layouts/
│       ├── lib/
│       ├── hooks/
│       ├── stores/
│       ├── services/
│       ├── forms/
│       ├── schemas/
│       ├── providers/
│       ├── styles/
│       └── tests/
│
└── order-bot/

packages/
├── core/
├── web-ui/
├── api-contracts/
└── validation/
```

Domain packages remain backend-owned and must never be imported by browser code:

``` text
packages/
├── customer/
├── catalog/
├── cart/
├── checkout/
├── orders/
├── payments/
├── fulfillment/
├── inventory/
├── game/
├── nickname/
├── pricing/
├── promotions/
├── ledger/
├── wallet/
├── tickets/
├── support/
├── notifications/
├── tasks/
├── providers/
├── webhooks/
├── audit/
├── security/
└── observability/
```

The frontend must not duplicate these domain implementations. If the Storefront
appears to need pricing logic, promotions logic, or reservation logic, the correct
resolution is a new or extended application use case, not a browser reimplementation.

---

## 4. Frontend Layer Architecture

The frontend uses the following layers:

``` text
Route / Page
    ↓
Feature UI
    ↓
Application Client
    ↓
API Contract
    ↓
Fastify API
    ↓
Application Use Case
    ↓
Domain
    ↓
Infrastructure
    ↓
PostgreSQL / External Providers
```

### 4.1 Route Layer

Responsibilities:

- URL routing
- route params
- search params
- page composition
- authentication gating for UX purposes
- route-level loading and error boundaries
- route-level code splitting

Routing is handled in the browser by React Router. Route modules must not contain
business transaction logic, price computation, or direct HTTP calls; they compose
features.

### 4.2 Feature Layer

Feature modules represent user-facing capabilities:

``` text
catalog/
product/
cart/
checkout/
payments/
orders/
fulfillment/
account/
support/
notifications/
auth/
admin/
```

Feature code owns:

- UI composition for the feature
- feature-specific hooks
- feature-specific forms
- feature-specific schemas
- API queries/mutations issued through the Application Client
- loading states
- error presentation
- local interaction state

Feature code does not own database access, provider logic, authoritative pricing,
or authorization decisions.

### 4.3 Shared UI Layer

`packages/web-ui` contains reusable visual primitives:

``` text
Button
Input
Select
Dialog
Modal
Card
Badge
Table
Tabs
Toast
Pagination
MoneyDisplay
StatusBadge
ProductCard
PriceDisplay
FormField
EmptyState
ErrorState
LoadingState
```

Shared UI must remain domain-light. For example, `MoneyDisplay` may format:

``` text
amount + currency + exponent
```

but must never decide exchange rates, never fetch data, and never contain
checkout rules. Shared UI components receive data through props; they do not call
the Application Client.

---

## 5. Directory Responsibility Model

Both `apps/storefront/src` and `apps/web-admin/src` use the same directory model.
Each directory has exactly one responsibility.

``` text
src/
├── app/          application composition and bootstrap
├── features/     feature/domain-facing UI orchestration
├── components/   cross-feature reusable presentation components
├── layouts/      page/shell composition
├── services/     application infrastructure for talking to the API/session/query systems
├── hooks/        cross-feature reusable hooks
├── stores/       shared client/UI state only
├── forms/        shared form infrastructure and primitives
├── schemas/      client-side validation and API contract integration
├── providers/    React context providers (query, auth/session, theme, toast)
├── lib/          pure utilities and formatters
├── styles/       Tailwind entry, tokens, global CSS
└── tests/        test setup, factories, harnesses
```

### 5.1 `app/`

Application composition only:

``` text
app/
├── App.tsx        root composition
├── router.tsx     route table, lazy route imports, error boundaries
└── providers.tsx  provider composition (query client, session, theme, toast)
```

`app/` wires things together. It must not contain commerce business logic, API
calls, or feature-specific rules.

### 5.2 `features/`

Feature-facing orchestration. A typical feature module:

``` text
features/checkout/
├── components/     feature-scoped components
├── hooks/          feature-scoped hooks (query/mutation orchestration)
├── api/            feature queries and mutations built on the Application Client
├── forms/          feature forms
├── schemas/        feature-specific client validation
├── state/          feature-local state (only where genuinely needed)
└── index.ts        the feature's public surface
```

Rules:

- A feature exposes a deliberate public surface through `index.ts`.
- A feature must not import another feature's internal files.
- A feature must not contain business truth; it orchestrates server truth.
- Feature `api/` modules must call the Application Client, never `fetch` directly.

### 5.3 `components/`

Cross-feature reusable presentation components that are app-specific (Storefront
navigation, admin data-table shells) but not tied to one feature. Components in
this directory:

- receive data through props
- do not call the Application Client
- do not import from `features/`

Anything reusable across both apps belongs in `packages/web-ui` instead.

### 5.4 `layouts/`

Page and shell composition: headers, sidebars, footers, authenticated shells,
checkout shells, admin shells. Layouts compose navigation and slots. They must not
own feature data fetching beyond shell-level concerns (for example, session-aware
rendering through the session provider).

### 5.5 `services/`

Application infrastructure for talking to the backend, session, and query systems.
See section 11 for the full contract. `services/` must not become a dumping ground
for business logic: it owns transport, not meaning.

### 5.6 `hooks/`

Cross-feature reusable hooks with no domain semantics: debouncing, media queries,
clipboard, pagination controls, interval/timer helpers. Domain hooks live in the
owning feature.

### 5.7 `stores/`

Only client/UI state that genuinely needs to be shared across distant parts of the
tree and persist across route changes. Examples:

``` text
UI theme
sidebar open/collapsed
active admin workspace filter
toast queue
transient checkout wizard step (UI only)
```

Rules:

- Do not use one giant global store for all server data.
- Server data belongs in the query/cache layer, not in `stores/`.
- Canonical commerce state (cart contents, order status, payment status) is never
  owned by a client store.

### 5.8 `forms/`

Shared form infrastructure: form primitives, field wiring, error rendering
helpers, submit-state handling. Feature-specific forms live in the feature.

### 5.9 `schemas/`

Client-side validation and API contract integration. Schemas here should be
derived from or aligned with `packages/api-contracts` and `packages/validation`
rather than reinvented. When a client schema is stricter than the server schema,
it is a UX affordance only and must never be treated as authoritative.

### 5.10 `providers/`

React context providers and their composition units: query client provider,
session provider, theme provider, toast provider, error boundary providers.

### 5.11 `lib/`

Pure utilities: date formatting, decimal-aware money formatting helpers, string
helpers, query-key builders, type guards. Functions here must be side-effect free
and independently testable.

### 5.12 `styles/`

Tailwind entry file, design tokens, global CSS, and font declarations. See
section 31.

### 5.13 `tests/`

Test setup, shared factories, MSW-style API harnesses or equivalent, and test
utilities. Tests themselves live next to what they test; `tests/` holds the
scaffolding that makes them consistent. See section 36.

---

## 6. Storefront Architecture

### 6.1 Storefront Responsibilities

The Storefront provides:

- landing page
- catalog
- category browsing
- product detail
- variant selection
- cart
- buy now
- checkout
- customer authentication
- game input
- nickname verification
- payment selection
- payment status
- order history
- order detail
- fulfillment information per order item
- account/profile
- tickets/support
- notification display

### 6.2 Storefront Folder Structure

``` text
apps/storefront/src/
├── app/
│   ├── App.tsx
│   ├── router.tsx
│   └── providers.tsx
│
├── components/
│   ├── navigation/
│   ├── commerce/
│   ├── checkout/
│   ├── payment/
│   ├── orders/
│   └── account/
│
├── features/
│   ├── catalog/
│   ├── cart/
│   ├── checkout/
│   ├── game-topup/
│   ├── payments/
│   ├── orders/
│   ├── fulfillment/
│   ├── account/
│   └── support/
│
├── services/
│   ├── api-client.ts
│   ├── auth-client.ts
│   └── query-client.ts
│
├── layouts/
├── forms/
├── schemas/
├── hooks/
├── stores/
├── providers/
├── lib/
├── styles/
└── tests/
```

---

## 7. Web Admin Architecture

The Web Admin is a separate presentation surface that uses the same backend
application/domain layer through the same Fastify API.

### 7.1 Admin Responsibilities

``` text
Dashboard
Catalog Management
Product / Variant Management
Pricing
Promotions
Orders
Payments
Fulfillment
Inventory
Game Configuration
Nickname Provider Configuration
Provider Monitoring
Tickets
Customers
Notifications
Tasks
Ledger / Finance
Audit
System Operations
```

Admin surfaces operate on the same domain state as the Storefront. Admin actions
are application commands with elevated permissions — they are not a separate
domain model and never bypass the application layer.

### 7.2 Admin Folder Structure

``` text
apps/web-admin/src/
├── app/
│   ├── App.tsx
│   ├── router.tsx
│   └── providers.tsx
│
├── features/
│   ├── dashboard/
│   ├── catalog/
│   ├── orders/
│   ├── payments/
│   ├── fulfillment/
│   ├── inventory/
│   ├── providers/
│   ├── customers/
│   ├── tickets/
│   ├── finance/
│   ├── audit/
│   └── settings/
│
├── components/
├── layouts/
├── services/
├── forms/
├── schemas/
├── hooks/
├── stores/
├── providers/
├── lib/
├── styles/
└── tests/
```

---

## 8. Storefront vs Web Admin Boundary

The Storefront and Web Admin are separate presentation applications with separate
bundles, separate sessions, and separate authorization semantics.

``` text
Storefront ─────┐
                ├── Fastify Application/API
Web Admin ──────┤
                │
Telegram Bot ───┘
```

### 8.1 What They Share

``` text
backend application and domain
Fastify API
API contracts
validation contracts
status contracts
error taxonomy
money contract
capability contract
pagination contract
idempotency contract
shared UI primitives (packages/web-ui) where appropriate
shared pure utilities (packages/core) where appropriate
```

### 8.2 What They Must Not Share

``` text
customer and admin authorization semantics
sessions and session cookies
admin-only assumptions inside customer UI
customer-only assumptions inside admin UI
presentation-specific state
feature state belonging to the other surface
route tables
navigation models
```

### 8.3 Rules

- Shared code moves into `packages/web-ui` or `packages/core` deliberately, never
  by importing across `apps/storefront` and `apps/web-admin`.
- A shared component must not branch on "is this admin or storefront?". If it
  needs to, it is two components.
- The Admin must not be reachable by a customer session, and the Storefront must
  not accept an admin session as a customer identity. This is enforced server-side
  (section 29), not by the bundle split.

---

## 9. React Router Architecture

### 9.1 Composition

``` text
app/
├── App.tsx        mounts providers + router
├── router.tsx     route definitions, lazy imports, error elements
└── providers.tsx  query client, session, theme, toast
```

Routes are defined in one place per application so that the navigable surface is
auditable. Route components are lazily imported for route-level code splitting
(section 34).

### 9.2 Route Semantics

Routes represent navigable resources. Storefront:

``` text
/
/products
/products/:productSlug
/games/:gameSlug
/cart
/checkout
/payment/:paymentId
/orders
/orders/:orderId
/account
/support
```

Web Admin:

``` text
/
/dashboard
/products
/orders
/payments
/fulfillment
/inventory
/providers
/customers
/tickets
/finance
/audit
/settings
```

Rules:

- URLs must not carry secrets, credentials, session tokens, or raw fulfillment
  payloads in query strings.
- Route params identify resources; they never carry authorization claims.
- Deep links must resolve from a cold load: any state a route needs is either in
  the URL or fetched from the API.

### 9.3 Route Guards Are UX, Not Security

``` text
Frontend route guard = UX
Backend authorization = security
```

A route guard may redirect an unauthenticated visitor to a login screen, hide
admin navigation, or render an "insufficient permission" screen. It provides no
security guarantee. Every protected read and every mutation must be independently
authorized by the Fastify API, and the frontend must render correctly when the API
rejects a request that the guard allowed.

Do not encode permission logic into route definitions as though the route table
were an access control list. Permission data received from the server may be used
for rendering decisions only.

---

## 10. State Architecture: Server / UI / Form / Session

State is classified before it is stored. Misclassification is the most common
source of frontend architectural drift.

``` text
Server State
→ query/cache layer (canonical commerce data fetched from the API)

UI State
→ component state / lightweight client store

Form State
→ form state library / local form state

Session State
→ server-backed authentication/session model
```

### 10.1 Server State

Server state is data owned by the backend: catalog, product, cart, checkout,
order, payment, fulfillment, tickets, notifications, profile, admin lists.

Rules:

- Server data must not automatically become global client state.
- The query cache is a cache, not UI state and not a store of record.
- Mutations invalidate or update the affected queries; they do not hand-patch a
  global store.
- Stale server data must be revalidated before any authoritative action
  (section 18).

Recommended query key roots:

``` text
catalog
product
cart
checkout
order
payment
fulfillment
notifications
tickets
profile
admin:*
```

Query keys are built through a helper in `lib/` so that invalidation is consistent
and greppable.

### 10.2 UI State

Ephemeral interaction state: open dialogs, selected tab, expanded row, wizard step,
sidebar collapse. Prefer component state. Promote to `stores/` only when the state
must be shared across distant components or survive route changes.

### 10.3 Form State

Managed by a form state library or local controlled state. Form state is draft
input, not committed truth. It becomes truth only after the server accepts the
command and returns an authoritative response.

### 10.4 Session State

Session state is server-backed. The browser holds only a session-aware view — for
example "authenticated: true", a display name, and permission flags used for
rendering — obtained from a session endpoint.

Storage rules:

``` text
localStorage / sessionStorage
→ may hold non-sensitive UI preferences
→ must NOT hold session tokens, credentials, or secrets
→ must NOT be the canonical source of commerce state (cart, order, payment)
```

Authentication credentials belong in `HttpOnly`, `Secure`, `SameSite` cookies
managed by the backend (section 28).

---

## 11. API Client Architecture (`services/`)

### 11.1 Structure

``` text
services/
├── api-client.ts    HTTP transport and error normalization
├── auth-client.ts   session lifecycle operations against the backend contract
└── query-client.ts  query/cache configuration
```

### 11.2 `api-client.ts` Responsibilities

``` text
HTTP transport
base URL resolution from public configuration
request/response serialization and deserialization
standard headers
correlation ID / request ID propagation
idempotency headers where the operation requires them
credential mode according to the backend session contract
timeout and abort handling
retry policy for safe (idempotent) requests only
error normalization into the shared error taxonomy
```

Every feature request goes through this client. Direct `fetch` or ad-hoc HTTP
libraries inside features are forbidden, because that is how correlation IDs,
idempotency, and error normalization get silently lost.

### 11.3 What the API Client Must Not Do

``` text
calculate authoritative prices
apply discounts or promotions
create or extend reservations locally
decide stock availability
implement provider selection or fallback
implement business workflows owned by application use cases
mutate domain state locally on failure
interpret domain meaning beyond mapping to the shared error taxonomy
```

### 11.4 Error Normalization

The client converts every non-success response into a typed error carrying:

``` text
error code (shared taxonomy)
HTTP status
correlation/request ID
field-level validation details where provided
retryability signal
```

Features handle typed errors; they never parse raw response bodies.

### 11.5 `auth-client.ts`

Owns login, logout, session refresh/probe, and expired-session signalling against
the backend session contract. It does not store credentials in browser storage and
does not make authorization decisions.

### 11.6 `query-client.ts`

Owns cache configuration: default stale times, retry behaviour, refetch policy,
and global query error handling (for example, routing `AUTH_REQUIRED` to the
session-expired flow). Commerce-critical queries must use conservative staleness
so that checkout never renders long-stale price or stock.

---

## 12. Fastify API Boundary

``` text
Browser
  ↓
HTTP
  ↓
Fastify
  ↓
Route
  ↓
Request Validation
  ↓
Application Use Case
  ↓
Domain
  ↓
Infrastructure
```

### 12.1 What Belongs to the Fastify HTTP Adapter Layer

``` text
routing
request parsing
schema-based request validation
response serialization
authentication hooks/middleware
authorization integration
rate limiting
HTTP error mapping (domain error → HTTP status + error code)
request IDs and correlation
observability hooks
transport-specific concerns (CORS, compression, caching headers)
```

### 12.2 What Does Not Belong There

Fastify route handlers must not become the domain layer. A handler validates
input, resolves the caller, delegates to an application use case, and maps the
result to an HTTP response. Business rules, transaction orchestration, pricing,
reservation, provider routing, and state transitions live in application and
domain code.

### 12.3 Storefront Request Path

``` text
Browser
  ↓
Application Client
  ↓
Fastify API
  ↓
Customer Resolution
  ↓
Authorization
  ↓
Application Use Case
  ↓
Domain
```

### 12.4 Admin Request Path

``` text
Browser
  ↓
Application Client (admin)
  ↓
Fastify API
  ↓
Admin Session Resolution
  ↓
RBAC / Permission Evaluation
  ↓
Application Use Case
  ↓
Domain
```

### 12.5 Forbidden Paths

``` text
Browser
  ↓
Prisma
```

``` text
Browser
  ↓
Provider API
```

Neither path may exist in any environment, including local development and
demos.

---

## 13. Shared API Contract Architecture

The Storefront, Web Admin, and Telegram Bot share the same semantic contracts.
Contracts are the semantic boundary between channels.

Shared contracts include:

``` text
Domain DTO
Validation schema
Command shape
Response shape
Error taxonomy
Status enum
Capability contract
Money representation
Pagination
Idempotency contract
```

Canonical package:

``` text
packages/api-contracts/
├── catalog.ts
├── customer.ts
├── cart.ts
├── checkout.ts
├── order.ts
├── payment.ts
├── fulfillment.ts
├── game.ts
├── nickname.ts
├── ticket.ts
├── notification.ts
├── errors.ts
├── status.ts
├── money.ts
└── pagination.ts
```

### 13.1 Contract Rules

- Contracts define semantic agreements between the Storefront, Web Admin,
  Telegram Bot, and the Fastify API.
- Contracts must not expose Prisma models. Persistence models are an
  implementation detail of infrastructure; API DTOs are the published surface.
- A status value, error code, or capability flag has exactly one definition, in
  `packages/api-contracts`. Channels import it; they never redeclare it.
- Contract changes are backend-led. A frontend need may motivate a contract
  change, but the change is made in the contract package and adopted by all
  channels.
- Additive changes are preferred. Removals and renames require a versioned change
  and a migration plan across all three channels.

### 13.2 Contract Ownership Table

| Concern | Owner | Consumed by |
|---|---|---|
| Domain meaning of a status | Backend domain | All channels |
| Error code semantics | Backend domain | All channels |
| Error message presentation | Each channel | — |
| Product capability values | Backend | All channels |
| Money representation | Contract package | All channels |
| Validation rules (authoritative) | Backend | All channels |
| Validation rules (UX pre-check) | Each channel | — |
| Pagination shape | Contract package | All channels |

---

## 14. Money and Multi-Currency Rules

The PostgreSQL architecture stores exact decimal values. API boundaries therefore
use decimal strings.

Canonical representation:

``` json
{
  "amount": "10.500000",
  "currency": "USDT"
}
```

Never rely on:

``` json
{
  "amount": 10.5
}
```

Frontend rule:

``` text
API decimal string
      ↓
Money value object / decimal-aware formatter
      ↓
UI
```

### 14.1 Rules

- API money is represented as exact decimal strings with an explicit currency.
- Authoritative financial calculation happens server-side.
- JavaScript `number` must not be used for authoritative financial calculation.
- The UI may compute an approximate preview (for example, a running cart subtotal)
  and must present the server response as authoritative once received.
- Currency is always explicit; there is no implicit default currency.
- Currency exponent is always explicit.
- Historical FX data must never be reconstructed from current rates. Historical
  values come from stored FX snapshots served by the backend.

### 14.2 Currency Display

The frontend must receive or resolve:

``` text
currency code
currency name
symbol
exponent
amount
```

Canonical exponents:

``` text
IDR exponent = 0
USDT exponent = 6
```

Examples:

``` text
IDR 100000
USDT 6.493506
```

Formatting must preserve exponent semantics, including trailing zeros where the
currency requires them. Currency conversion is always explicit and always
server-provided; the UI never derives a converted amount on its own.

---

## 15. Product Capability Architecture

Product UI is driven by server-provided capability, not by product names.

``` ts
type ProductCapability = {
  requiresUserInfo: boolean;
  requiresNickname: boolean;
  supportsCart: boolean;
  supportsBuyNow: boolean;
  deliveryMode:
    | "MANUAL_USER_INFO"
    | "MANUAL_ACCOUNT"
    | "INSTANT"
    | "GAME_TOPUP";
};
```

Bad:

``` ts
if (product.name === "Alight Motion") {
  // forbidden: product-name conditional
}
```

Good:

``` ts
if (product.capability.requiresNickname) {
  // capability-driven behaviour
}
```

### 15.1 Rules

- Flow selection, required inputs, cart eligibility, and buy-now eligibility are
  read from `product.capability`.
- New product behaviour is introduced by extending the capability contract in
  `packages/api-contracts`, not by adding UI conditionals.
- Unknown or unsupported capability values must degrade safely: the UI blocks the
  action and surfaces a clear message rather than guessing a flow.
- Capability is presentation input, not authorization. The server still validates
  every command against the product's real capability.

---

## 16. Commerce Flows

The UI may share primitives across flows, but the state machine differs according
to capability.

### 16.1 Standard Premium Product

``` text
Catalog
  ↓
Product
  ↓
Variant
  ↓
Requirements if needed
  ↓
Review
  ↓
Create Order
  ↓
Payment
  ↓
Order Status
  ↓
Fulfillment
  ↓
Delivery
```

### 16.2 Manual User Info (`MANUAL_USER_INFO`)

``` text
Product
  ↓
Variant
  ↓
Input Customer Requirement
  ↓
Review
  ↓
Create Order
  ↓
Payment
  ↓
WAITING_FOR_INFO / INFO_SUBMITTED
  ↓
Manual Fulfillment
  ↓
DELIVERED
```

### 16.3 Manual Account (`MANUAL_ACCOUNT`)

``` text
Product
  ↓
Variant
  ↓
Review
  ↓
Create Order
  ↓
Payment
  ↓
Reservation / Allocation
  ↓
Manual Fulfillment
  ↓
DELIVERED
```

### 16.4 Instant Premium (`INSTANT`)

``` text
Product
  ↓
Variant
  ↓
Review
  ↓
Create Order
  ↓
Payment
  ↓
Instant Fulfillment
  ↓
DELIVERED
```

### 16.5 Game Top-Up (`GAME_TOPUP`)

``` text
Game
  ↓
Denomination
  ↓
Game Input
  ↓
Nickname Check
  ↓
Confirm Nickname
  ↓
Review
  ↓
Create Order
  ↓
Payment
  ↓
GAME_TOPUP Fulfillment
  ↓
Provider
  ↓
DELIVERED / PROCESSING / FAILED
```

---

## 17. Cart Architecture

The cart is server-backed. The frontend may cache cart data for rendering, but
server state is authoritative.

``` text
UI
 ↓
Cart Application API
 ↓
Server Cart
```

Operations:

``` text
getCart
addCartItem
updateCartItem
removeCartItem
clearCart
validateCart
```

Rules:

- The canonical cart must never live only in `localStorage`.
- Local state may hold transient UI concerns (pending quantity input, optimistic
  row state) that reconcile against the server response.
- Cart totals rendered before checkout are previews; checkout re-resolves them
  server-side.
- Cart eligibility follows `capability.supportsCart`.

---

## 18. Checkout Architecture

Checkout is server-authoritative.

``` text
Cart
 ↓
Start Checkout
 ↓
Validate Current State
 ↓
Collect Requirements
 ↓
Nickname Check if required
 ↓
Resolve Current Price
 ↓
Review
 ↓
Create Order
 ↓
Create / Select Payment
```

### 18.1 Staleness Rule

Previously fetched data may become stale between steps. Therefore the final
mutation must be:

``` text
Frontend Command
  ↓
Server Validation
  ↓
Expected-State / Idempotent Mutation
  ↓
Authoritative Response
```

Never assume that data validated at an earlier step is still valid when the order
is created. The server re-validates price, stock, reservation, and nickname at the
moment of mutation.

### 18.2 Required Error Handling

The checkout UI must handle at least:

``` text
STOCK_CHANGED
RESERVATION_EXPIRED
PRICE_CHANGED
NICKNAME_INVALID
CHECKOUT_EXPIRED
```

Each of these must produce a recoverable UX path: show what changed, show the new
authoritative value, and require explicit customer confirmation before retrying.
Silent auto-retry with new values is forbidden — the customer must never be
charged against a price they did not see.

---

## 19. Payment and Fulfillment State Machines

Payment and fulfillment are separate state machines with separate lifecycles.

### 19.1 Payment

``` text
PENDING
PAID
EXPIRED
FAILED
CANCELLED
```

### 19.2 Fulfillment

``` text
WAITING_FOR_INFO
INFO_SUBMITTED
PROCESSING
DELIVERED
FAILED
```

### 19.3 Critical Invariant

``` text
PAYMENT = PAID
≠
FULFILLMENT = DELIVERED
```

The frontend must never infer one domain state from another. It renders payment
state from payment data and fulfillment state from fulfillment data.

### 19.4 Payment Rules

- Payment rail selection and changes follow the server contract.
- A single order must not expose multiple simultaneously payable `PENDING`
  payments.
- Payment status transitions are observed, never asserted, by the frontend.
- Expired payments must present a clear, server-driven recovery path.

### 19.5 Mixed Orders

An order may contain multiple `OrderItem`s with different fulfillment states and
different delivery modes. The UI must never collapse them into a single order-level
fulfillment status.

---

## 20. Order Architecture

Order status is domain-owned. The frontend must not create a parallel status enum.

Shared status values:

``` text
PENDING
PAID
PROCESSING
COMPLETED / DELIVERED
CANCELLED
EXPIRED
FAILED
```

Exact values always come from the canonical backend contract in
`packages/api-contracts/status.ts`.

Order detail should render:

``` text
Order
├── Order Number
├── Items
├── Pricing Currency
├── Payment
├── Payment Currency
├── Payment Status
├── Fulfillment per OrderItem
├── Delivery
└── Support
```

Because fulfillment belongs to `OrderItem`, the frontend must not assume a single
fulfillment state for a mixed order.

---

## 21. Fulfillment UI

Fulfillment is rendered per `OrderItem`.

``` text
Order
 ├── Item A
 │    └── INSTANT → DELIVERED
 │
 ├── Item B
 │    └── MANUAL_ACCOUNT → PROCESSING
 │
 └── Item C
      └── GAME_TOPUP → DELIVERED
```

Rules:

- The frontend reads fulfillment truth from the server.
- Delivery must never be inferred from payment success.
- Order-level summaries (for example, "2 of 3 items delivered") are derived from
  per-item states for display only and must not be treated as a domain status.
- Fulfillment payloads (delivered credentials, codes, account data) are sensitive:
  they are rendered on demand, never logged, and never placed in URLs.

---

## 22. Idempotency

Client mutations that can be retried must support server-defined idempotency
semantics.

Retryable operations include:

``` text
Create Order
Create Payment
Submit Fulfillment Info
other retry-sensitive mutations defined by the API contract
```

Mechanism:

``` text
Idempotency-Key
```

Rule:

``` text
same logical operation
+
same idempotency key
=
safe retry
```

### 22.1 Client Rules

- The key is generated once when the logical operation begins and is kept for the
  lifetime of that operation, including across component re-renders and route
  changes within the flow.
- A timeout must not cause a new idempotency key. A timed-out request has unknown
  outcome; retrying with the same key is precisely how the outcome is resolved.
- A new key is generated only when the customer starts a genuinely new logical
  operation (for example, after an explicit cancel, or after confirming changed
  price/stock in checkout).
- The key must be attached by the Application Client (section 11), not assembled
  ad hoc in feature code.
- The frontend treats the idempotent replay response as authoritative, exactly like
  a first response.

---

## 23. Error Architecture

The frontend consumes one shared semantic error taxonomy.

``` text
AUTH_REQUIRED
FORBIDDEN
VALIDATION_ERROR
NOT_FOUND
STOCK_CHANGED
RESERVATION_EXPIRED
PRICE_CHANGED
NICKNAME_INVALID
PAYMENT_EXPIRED
PAYMENT_FAILED
FULFILLMENT_FAILED
PROVIDER_UNAVAILABLE
RATE_LIMITED
CONFLICT
INTERNAL_ERROR
```

### 23.1 Ownership

``` text
Backend  → semantic meaning of the error
Frontend → presentation mapping of the error
```

Presentation mapping example:

``` text
NICKNAME_INVALID
→ "Nickname tidak valid. Silakan periksa kembali ID game."
```

Localized copy is a presentation concern and may differ per channel and per
locale. The code behind it must not.

### 23.2 Rules

- Do not create web-specific semantic errors when a domain error already exists.
- Do not create different semantic errors for Web and Telegram.
- Unknown error codes must render a safe generic failure state with the
  correlation ID available for support, never a raw payload dump.
- Validation errors map to field-level messages using the contract's field paths.
- `AUTH_REQUIRED` routes to the session-expired flow; `FORBIDDEN` renders an
  insufficient-permission state and never silently hides the failure.

---

## 24. Form and Validation Architecture

Validation exists at three levels:

``` text
UI validation
    ↓
API schema validation
    ↓
Domain validation
```

Client validation improves UX but never replaces server validation. The server
validates every command regardless of what the client checked.

Game input is generated from the shared game input schema:

``` ts
type GameInputField = {
  key: string;
  label: string;
  type: "text" | "number";
  required: boolean;
};
```

Renderer flow:

``` text
GameInputSchema
 ↓
Form
 ↓
Values
 ↓
Application API
 ↓
Server Validation
```

Rules:

- Form fields for dynamic domains (game input, product requirements) are rendered
  from server-provided schema, not hardcoded per product or per game.
- Client schemas are derived from shared contracts where possible.
- Server field errors are mapped back onto the corresponding form fields.

---

## 25. Nickname Check UI

Nickname checking is an application operation.

``` text
Game Input
 ↓
Nickname Check API
 ↓
Nickname Result
 ↓
Customer Confirmation
 ↓
Checkout / Create Order
```

Rules:

- The frontend must never call a nickname or top-up provider directly.
- Provider routing, fallback, and retry remain backend-owned.
- The UI displays the normalized result only.
- A confirmed nickname is revalidated server-side at order creation; a stale
  confirmation yields `NICKNAME_INVALID` and a recoverable UX path.

---

## 26. Provider Isolation

The frontend must never depend on provider-specific implementation details.

Never exposed to browser code:

``` text
DigiflazzClient
VIPResellerClient
KokinpayClient
MelostoreClient
provider credentials
provider-specific status codes
provider-specific payload shapes
```

Exposed instead as domain concepts through the API:

``` text
NicknameService
PaymentService
FulfillmentService
```

Provider selection, fallback, capability, retry, reconciliation, and cost remain
backend concerns. Admin provider-monitoring screens display backend-normalized
provider state; they do not talk to providers.

---

## 27. Notification Architecture

Frontend-originated business events must not directly send Telegram or email
notifications.

Canonical flow:

``` text
Business State Change
      ↓
Domain Event
      ↓
notification_outbox
      ↓
Notification Service / Worker
      ↓
Channel Adapter
      ↓
Customer
```

The Storefront and Web Admin may display notification state and read notification
history through the API. Notification delivery remains backend and outbox-driven.

---

## 28. Authentication and Session Architecture

Customer and admin authentication are separate security domains.

``` text
Customer Session
Admin Session
```

They use separate cookies, separate session lifetimes, and separate authorization
models. A customer session must never satisfy an admin authorization check, and an
admin session must never be treated as a customer identity.

### 28.1 Browser Session Model

``` text
HttpOnly
Secure
SameSite
```

Sensitive session credentials must not be stored in `localStorage`,
`sessionStorage`, or any other browser storage readable by scripts.

### 28.2 Responsibility Split

``` text
Frontend:
- login UI
- registration UI
- session-aware rendering
- logout UX
- expired-session handling
- authentication loading state

Backend:
- credential validation
- session creation
- session validation
- session revocation
- authorization
- permission evaluation
```

### 28.3 Expired Session Handling

An `AUTH_REQUIRED` response is the authoritative signal that a session has ended.
The frontend clears cached user-scoped server state, routes to the login flow, and
preserves the intended destination for post-login return. Cached user data must
not survive a session change.

---

## 29. Authorization and RBAC

Frontend route guards are not security (section 9.3). Admin permission is enforced
server-side:

``` text
Admin Session
  ↓
Role
  ↓
Permission
  ↓
Application Command
```

The frontend may use permission information to:

- hide buttons
- disable actions
- hide navigation entries
- shape UX

The API must reject unauthorized reads and mutations regardless of UI state, and
the UI must render a correct failure state when it does. Permission flags in the
browser are hints for rendering; they are never a grant.

---

## 30. Security

This section states requirements. Where an implementation choice has not yet been
made, the requirement is described rather than a specific library assumed.

### 30.1 CSRF and Request Security

For cookie-authenticated mutations:

``` text
Origin validation
+
CSRF protection
+
SameSite cookie policy
```

Sensitive endpoints include:

``` text
login
checkout
create order
create payment
refund
admin mutation
account mutation
```

### 30.2 Requirements Checklist

``` text
CSRF protection for cookie-authenticated mutations
Origin/Referer validation on state-changing requests
SameSite cookie policy for customer and admin sessions
Rate limiting on authentication, checkout, and provider-backed operations
Secure response headers (CSP, HSTS, frame-ancestors, referrer policy, nosniff)
Server-side input validation on every command
Server-side authorization on every protected read and mutation
Strict separation of public and server-only configuration (section 39)
No credential or secret in URLs, query strings, or route params
Redaction of sensitive data in logs and telemetry (section 35)
Request correlation across browser, API, and workers
```

### 30.3 Frontend-Specific Rules

- Never place credentials, tokens, or fulfillment payloads in query strings.
- Never render untrusted HTML without sanitization.
- Never log request/response bodies of authentication, payment, or fulfillment
  endpoints.
- Treat all provider- and payment-related data received by the browser as
  display-only and already redacted by the backend.

---

## 31. Tailwind and Styling Architecture

Tailwind CSS is the styling system. Styling is a presentation concern and must
never carry business meaning.

### 31.1 Token Layer

Design tokens are defined once and consumed through Tailwind theme configuration:

``` text
color tokens (semantic, not literal)
spacing scale
typography scale
radius scale
shadow scale
z-index scale
breakpoints
motion durations
```

Semantic color naming is required, so that themes and status rendering stay
consistent:

``` text
surface / surface-muted
foreground / foreground-muted
border
primary / primary-foreground
success / warning / danger / info
status tokens mapped to domain status groups
```

### 31.2 Rules

- Prefer semantic tokens over literal values: use a `danger` token, not a raw hex
  or an arbitrary class.
- Avoid uncontrolled arbitrary values (`w-[437px]`, `text-[#3a3a3a]`). Arbitrary
  values are acceptable only for genuinely one-off layout constraints and should be
  reviewed.
- Reusable visual primitives live in `packages/web-ui`; feature-level styling stays
  near the feature.
- Variants are expressed through a single, consistent variant approach per
  primitive rather than ad-hoc class concatenation scattered across features.
- Status colors are mapped from the shared status contract to tokens in one place.
  A component must not decide "PAID is green" independently in five files.
- Tailwind classes must never encode business logic. Class selection may depend on
  domain state, but the domain state itself is never derived from styling code.
- Dark mode, if enabled, is implemented through the token layer (class strategy),
  not by duplicating component trees.

### 31.3 Responsiveness

Breakpoints are defined once in the token layer and used consistently
(section 33).

---

## 32. Accessibility

All customer-facing UI must support:

- keyboard navigation
- semantic HTML
- visible focus state
- labels for form fields
- accessible error messages associated with their fields
- sufficient contrast
- responsive layout
- reduced-motion consideration

Checkout, payment, and fulfillment flows require especially clear error and status
communication, including programmatically announced status changes.

---

## 33. Responsive Design

Storefront:

``` text
Mobile-first
Tablet
Desktop
```

Web Admin:

``` text
Desktop-first
Tablet support
Mobile fallback for operationally useful screens
```

Critical commerce actions must remain usable on mobile.

---

## 34. Performance

Priorities:

``` text
Fast initial load
Route-level code splitting
Lazy loading where useful
Query caching
Avoid duplicate API requests
Optimized images
Minimal unnecessary client state
Efficient re-rendering
```

Rules:

- Route-level code splitting is the default; large admin modules and rarely used
  flows are lazily loaded.
- Caching improves perceived performance but never overrides authoritative
  validation. `Buy Now` must always resolve current server state before final
  order creation.
- Do not sacrifice transactional correctness for optimistic performance.
- SSR optimization is not a requirement of this architecture and must not be
  introduced as one (section 2.6).

---

## 35. Observability

The frontend attaches:

``` text
correlation ID
request ID
route
safe customer/operator context
```

Never logged or transmitted:

``` text
password
payment secret
provider API key
inventory credential
raw account credential
sensitive PII
fulfillment payload contents
```

Rules:

- Correlation IDs originate or propagate through the Application Client so that a
  browser action can be traced to an API request, an application use case, and a
  worker job.
- Client telemetry must be sanitized before transmission; sanitization happens at
  the source, not at the collector.
- Error reporting must not leak secrets, tokens, or fulfillment content.
- User-visible failure states should surface the correlation ID so support can
  trace an incident without asking for screenshots of raw payloads.

---

## 36. Testing Architecture

Testing uses the canonical stack.

``` text
Unit          → Vitest
Component     → Vitest + React Testing Library
Integration   → Vitest + Fastify test app / application test environment
Route         → Vitest + React Router test utilities
Contract      → Shared API contract validation + Vitest
E2E           → Playwright
```

### 36.1 Which Level Owns What

| Behaviour | Test level |
|---|---|
| Pure formatting, money/decimal helpers | Unit |
| Capability-driven rendering decisions | Component |
| Form validation and error mapping | Component |
| Query/mutation orchestration and cache invalidation | Component/Integration |
| API client transport, headers, idempotency, error normalization | Integration |
| Contract compatibility between channels and API | Contract |
| Full commerce flows across browser, SPA, and API | E2E |

### 36.2 Critical Test Areas

``` text
catalog
product
buy now
cart
checkout
game top-up
nickname valid / invalid
stock changed
payment pending
payment expired
payment success
fulfillment pending
fulfillment delivered
mixed-order fulfillment
unauthorized customer
unauthorized admin
session expiry
retry with the same idempotency key
decimal/money formatting
multi-currency display
```

### 36.3 Financial Display Tests

``` text
IDR exponent 0
USDT exponent 6
Decimal strings preserved end to end
Large values
Trailing zero preservation where required
No floating-point rounding in displayed values
```

---

## 37. E2E Test Architecture

Playwright is the E2E framework. E2E tests validate behaviour across:

``` text
Browser
→ React SPA
→ Fastify API
→ Application
```

Critical E2E scenarios:

``` text
Catalog → Product → Buy Now
Catalog → Cart → Checkout
Premium Manual User Info
Premium Manual Account
Premium Instant
Game Top-Up
Nickname Invalid
Nickname Valid
Stock Changed
Payment Pending
Payment Expired
Payment Success
Fulfillment Pending
Fulfillment Delivered
Mixed Order
Customer Unauthorized
Admin Unauthorized
Session Expired
Retry with the same Idempotency-Key
```

Rules:

- Use stable, deterministic test data seeded through backend-owned fixtures.
- Assert on user-visible behaviour and stable test identifiers, not on React
  component internals, class names, or implementation details.
- External providers are simulated at the backend boundary, never by intercepting
  provider calls in the browser — the browser never calls providers at all.
- E2E covers flows; it does not replace contract or component tests for edge
  cases.

---

## 38. Deployment

Canonical deployment model:

``` text
Internet
   ↓
CDN / Reverse Proxy
   ↓
React SPA static assets

Browser
   ↓
HTTPS
   ↓
Fastify API
   ↓
Internal Application Network
   ↓
PostgreSQL / Providers / Workers
```

Rules:

- SPA static assets are immutable, fingerprinted, and CDN-cacheable; the HTML
  entry document uses a short or revalidating cache policy so deployments take
  effect.
- Authenticated and transactional API responses must use appropriate no-store /
  private cache controls and must never be cached by a shared CDN.
- The Web Admin is served from a protected route or dedicated host and is
  protected by server-side authentication and authorization, not by obscurity.
- The browser never receives backend secrets in any bundle, source map, or
  runtime configuration payload.
- Client-side routing requires the static host to fall back to the SPA entry
  document for unknown paths, without proxying API paths.

---

## 39. Environment Variables

Two classes of configuration exist:

``` text
PUBLIC_* / VITE_* style variables
→ browser-safe configuration, embedded in the client bundle

SERVER_* / secret environment variables
→ server-only configuration, never bundled
```

Browser-safe examples:

``` text
PUBLIC_APP_URL
PUBLIC_API_URL
PUBLIC_ANALYTICS_ID
```

Exact variable names follow whatever the repository has already established; this
document does not invent new naming. What is fixed is the classification rule:
anything reachable by the browser is public by definition.

Never exposed to the browser:

``` text
DATABASE_URL
Prisma credentials
payment secrets
provider API keys
webhook secrets
encryption keys
session signing secrets
admin bootstrap credentials
```

Server-only environment variables remain in the Fastify/backend runtime and must
never be bundled into the React SPA. Any variable prefixed for browser exposure
must be reviewed as though it were published on a public page, because it is.

---

## 40. PostgreSQL Alignment

The frontend must align with the canonical PostgreSQL architecture:

``` text
PostgreSQL
→ exact decimal money
→ explicit currency
→ currency exponent
→ historical FX snapshots
→ atomic inventory reservation
→ expected-state transitions
→ idempotency
→ immutable ledger
→ audit
```

Frontend implication:

``` text
Decimal
→ decimal-string API representation
→ decimal-aware presentation
```

Floating-point semantics must not be reintroduced at the browser boundary. The
frontend also inherits the consequences of expected-state transitions: a mutation
may fail because the world changed, and that is a normal, designed outcome to be
handled in the UI (section 18).

---

## 41. Frontend Anti-Patterns

Never:

``` text
Browser → Prisma
```

Never:

``` text
Browser → Digiflazz
Browser → VIPReseller
Browser → Kokinpay
Browser → Melostore
```

Never:

``` text
Frontend calculates the final price
Frontend decides stock
Frontend marks an order PAID
Frontend marks fulfillment DELIVERED
Frontend owns reservation
Frontend implements provider fallback
Frontend stores the authoritative cart only in localStorage
Frontend infers fulfillment state from payment state
Frontend branches on product names instead of capability
Frontend treats route guards as authorization
```

Never duplicate across applications:

``` text
OrderStatus
PaymentStatus
FulfillmentStatus
ProductCapability
GameInputSchema
Money contract
Error taxonomy
Pagination contract
```

---

## 42. Architectural DO / DO NOT

``` text
DO:
- use shared API contracts
- use server state for canonical commerce data
- use feature-based React modules
- use capability-driven UI
- use idempotency for retryable mutations
- treat backend responses as authoritative
- route every request through the Application Client
- classify state before storing it
- render fulfillment per OrderItem
- keep presentation mapping in the frontend and semantics in the backend
- enforce boundaries mechanically, not just by convention

DO NOT:
- access Prisma from browser code
- call providers from browser code
- store the canonical cart only in localStorage
- calculate authoritative financial values in JavaScript
- duplicate backend status enums
- infer fulfillment from payment status
- use product-name conditionals
- treat frontend authorization as security
- put server data into a global client store by default
- generate a new idempotency key after a timeout
- introduce SSR, server components, or server actions
- reconstruct historical FX from current rates
```

---

## 43. Architectural Invariants

These invariants are non-negotiable. Any change to them requires a versioned
architecture change to this document, reviewed against the backend architecture.

``` text
1.  The browser never accesses Prisma.
2.  The browser never accesses provider APIs.
3.  The browser never determines authoritative price.
4.  The browser never determines authoritative stock.
5.  The browser never marks a payment PAID.
6.  The browser never marks a fulfillment DELIVERED.
7.  The cart remains server-backed.
8.  Payment and fulfillment remain separate state machines.
9.  Fulfillment is evaluated per OrderItem.
10. Retryable mutations preserve idempotency semantics.
11. Authorization is server-enforced; route guards are UX only.
12. Shared contracts are the semantic boundary between channels.
13. Product behaviour is capability-driven, never name-driven.
14. Money crosses the API as exact decimal strings with explicit currency.
15. Provider routing, fallback, and reconciliation remain backend-owned.
16. Telegram and Web share application/domain semantics.
17. The frontend remains a channel/presentation system, not a second commerce backend.
18. Session credentials live in HttpOnly cookies, never in browser storage.
19. Notification delivery remains backend/outbox-driven.
20. The React SPA is browser-rendered; no SSR, server component, or server action boundary exists.
```

---

## 44. Decision Guide for Engineers and Coding Agents

This section exists so that a developer or coding agent can resolve common
questions without guessing.

### 44.1 Where should this code live?

| The code is... | It belongs in... |
|---|---|
| Route table, providers, bootstrap | `app/` |
| Feature UI, feature hooks, feature queries/mutations | `features/<feature>/` |
| Reusable presentation used by several features in one app | `components/` |
| Reusable visual primitive used by both apps | `packages/web-ui` |
| Page shell, header, sidebar, authenticated shell | `layouts/` |
| HTTP transport, session client, query configuration | `services/` |
| Pure helper with no React and no domain rules | `lib/` |
| Shared DTO, status, error code, capability, money type | `packages/api-contracts` |
| Business rule, pricing, reservation, provider routing | Backend application/domain — not the frontend |

### 44.2 Can this feature call the API directly?

A feature calls the API only through the Application Client in `services/`. Raw
`fetch` in a feature is an architecture violation.

### 44.3 Should this state be local, server state, or a global store?

| Question | Answer |
|---|---|
| Does the backend own the truth? | Server state (query/cache layer) |
| Is it draft input in a form? | Form state |
| Is it ephemeral interaction state? | Component state |
| Is it UI state shared across distant components and routes? | `stores/` |
| Is it authentication truth? | Server-backed session; browser holds a session-aware view only |

### 44.4 Which layer owns this rule?

| Rule | Owner |
|---|---|
| Price, discount, stock, reservation | Backend domain |
| Order/payment/fulfillment transitions | Backend domain |
| Provider selection, fallback, retry | Backend infrastructure |
| Authorization and permissions | Backend |
| Request validation (authoritative) | Fastify + application layer |
| Input validation (UX) | Frontend |
| Presentation of errors and statuses | Frontend |
| Navigation and URL structure | Frontend |

### 44.5 Which package owns this contract?

Any type crossing the HTTP boundary belongs in `packages/api-contracts`. Any
validation schema shared across channels belongs in `packages/validation`. If a
type is needed in two channels, it is a contract, not an app-local type.

### 44.6 Where should validation happen?

Both sides, with different authority: the client validates for UX, the server
validates for truth. A rule that exists only on the client is not a rule.

### 44.7 Who owns price and stock truth?

The backend, always, including at the moment of the final mutation.

### 44.8 How should a retry behave?

Same logical operation → same idempotency key → safe retry. A timeout does not
create a new operation. A customer-confirmed change after `PRICE_CHANGED` or
`STOCK_CHANGED` does.

### 44.9 Which test level should cover this behaviour?

See the table in section 36.1. Default: the lowest level that can observe the
behaviour honestly.

### 44.10 A requirement seems to need forbidden access. What now?

Stop and escalate. The correct resolution is a new or extended application use
case exposed through the API and its contract — never a browser-side workaround,
a direct provider call, or a local reimplementation of a domain rule.

---

## 45. Definition of Done

Frontend architecture is considered compliant when:

``` text
[ ] Storefront uses the Trustance Application/API only
[ ] Web Admin uses the Trustance Application/API only
[ ] No browser-to-Prisma access
[ ] No browser-to-provider access
[ ] Import boundaries are mechanically enforced
[ ] Shared domain status contracts are used
[ ] Shared error taxonomy is used
[ ] Shared product capability contract is used
[ ] Shared game input contract is used
[ ] Money is represented as decimal strings
[ ] Currency is always explicit
[ ] IDR exponent handled as 0
[ ] USDT exponent handled as 6
[ ] Checkout revalidates server state before mutation
[ ] Cart is server-backed
[ ] Payment and fulfillment states are separate
[ ] Fulfillment is rendered per OrderItem
[ ] Idempotency is supported for retryable mutations
[ ] Customer authorization is enforced server-side
[ ] Admin RBAC is enforced server-side
[ ] CSRF policy is implemented for cookie-authenticated mutations
[ ] No sensitive credential in browser storage
[ ] No provider secret in the frontend bundle
[ ] Notification delivery remains outbox-driven
[ ] Nickname check goes through the application API
[ ] Provider routing remains backend-owned
[ ] All requests go through the Application Client
[ ] Route-level code splitting is in place
[ ] E2E checkout flows are covered by Playwright
[ ] Mixed-order fulfillment is covered
[ ] Decimal/multi-currency display is tested
[ ] Accessibility baseline is tested
[ ] Responsive storefront is tested
```

---

## 46. Final Architectural Principle

The Trustance frontend is a **channel/presentation system**, not a second commerce
backend.

Canonical dependency direction:

``` text
UI
 ↓
Feature
 ↓
Application Client
 ↓
API Contract
 ↓
Fastify API
 ↓
Application Use Case
 ↓
Domain
 ↓
Infrastructure
 ↓
PostgreSQL / Providers
```

Canonical commerce flow:

``` text
Customer
→ Catalog
→ Cart / Buy Now
→ Checkout
→ Order
→ Payment
→ Fulfillment
→ Delivery
→ Support / Refund
→ Ledger / Audit
```

Runtime relationship:

``` text
                         ┌─────────────────────┐
                         │      Customer       │
                         └──────────┬──────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ↓                     ↓                     ↓
        Storefront Web        Telegram Bot          Web Admin
              │                     │                     │
              └─────────────────────┼─────────────────────┘
                                    ↓
                            Fastify API
                                    ↓
                    Application / Domain Modules
                                    ↓
                     Repository / Infrastructure
                                    ↓
                         PostgreSQL + Prisma
                                    │
             ┌──────────────────────┼─────────────────────┐
             ↓                      ↓                     ↓
       Provider APIs        Notification Outbox        Workers
```

Shared contract relationship:

``` text
                    ┌──────────────────────┐
                    │   Shared Contracts   │
                    │                      │
                    │   DTO                │
                    │   Validation         │
                    │   Status             │
                    │   Error Taxonomy     │
                    │   Capability         │
                    │   Money              │
                    │   Pagination         │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              ↓                ↓                ↓
         Storefront        Telegram           Web Admin
              │                │                │
              └────────────────┼────────────────┘
                               ↓
                          Fastify API
                               ↓
                            Domain
                               ↓
                        Infrastructure
                               ↓
                          PostgreSQL
```

UI remains channel-specific:

``` text
Web:
card
form
modal
table
dropdown
page

Telegram:
message
keyboard
conversation
callback
```

The frontend is responsible for presenting and collecting information.
The backend is responsible for deciding what is true.
PostgreSQL is the transactional persistence source of truth.
Providers remain infrastructure adapters.
Telegram and Web are different channels over the same Trustance
application/domain contract.

Any future frontend change must preserve these boundaries unless explicitly
introduced as a versioned architecture change to this document.

---

## Appendix A. Canonical Terminology

Use these terms consistently across code, documentation, and commit messages.

| Term | Meaning |
|---|---|
| **Storefront** | The customer-facing React SPA (`apps/storefront`) |
| **Web Admin** | The operator-facing React SPA (`apps/web-admin`) |
| **Telegram Bot** | The Telegram channel (`apps/order-bot`) |
| **Fastify API** | The HTTP adapter layer exposing the Trustance application |
| **Application Client** | The frontend `services/api-client.ts` boundary to the Fastify API |
| **Application Use Case** | A backend application-layer operation invoked by the API |
| **Domain** | Backend business rules, entities, and state machines |
| **Infrastructure** | Repositories, provider adapters, queues, outbox, persistence |
| **API Contract** | Shared DTO/status/error/capability/money definitions in `packages/api-contracts` |
| **Server State** | Backend-owned data cached in the query layer |
| **UI State** | Ephemeral or shared presentation state owned by the browser |
| **Form State** | Draft user input prior to server acceptance |
| **Session State** | Server-backed authentication state, surfaced to the browser as a session-aware view |
| **Payment** | The payment state machine attached to an order |
| **Fulfillment** | The fulfillment state machine attached to an `OrderItem` |
| **OrderItem** | The unit that owns fulfillment state within an order |
| **Product Capability** | Server-provided flags and delivery mode that drive product UI behaviour |
