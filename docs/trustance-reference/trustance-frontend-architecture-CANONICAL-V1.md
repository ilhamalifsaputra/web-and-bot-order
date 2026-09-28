# Trustance --- Frontend Architecture

## FRONTEND-ARCHITECTURE-V1 --- Canonical Storefront & Web Admin Architecture

**Status:** CANONICAL\
**Scope:** Storefront Web + Web Admin\
**Runtime:** Node.js + TypeScript\
**Frontend:** React / Next.js\
**Backend:** Trustance Application/API\
**Database:** PostgreSQL + Prisma (frontend never accesses Prisma
directly)\
**Channels:** Storefront Web, Web Admin\
**Shared UI:** `packages/web-ui`\
**Purpose:** Menjadi single source of truth arsitektur frontend
Trustance yang selaras dengan backend modular monolith,
PostgreSQL/Prisma, Telegram Bot, commerce flow, multi-currency,
fulfillment, security, dan reliability architecture.

------------------------------------------------------------------------

# 0. Source of Truth

Dokumen ini harus dibaca bersama:

-   Trustance Master Implementation Architecture
-   Trustance Backend Architecture
-   Trustance Prisma + PostgreSQL + Docker Database Architecture
-   Trustance Telegram Bot Architecture FINAL v3.2

Frontend bukan business enginedf  `1              1ff `cd. Backend/Application Layer tetap menjadi
source of truth untuk:

-   product availability
-   price
-   stock
-   inventory reservation
-   nickname validity
-   order status
-   payment status
-   fulfillment status
-   refund
-   ownership
-   financial values
-   authorization
-   provider state

Website dan Telegram hanya berbeda pada transport/presentation. Business
command, domain state, validation contract, error taxonomy, capability
contract, dan status contract harus tetap sama.

------------------------------------------------------------------------

# 1. Architecture Principles

## 1.1 Shared Commerce Core

Trustance mengikuti:

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

Storefront harus mengonsumsi application/API contract yang sama dengan
Telegram Bot dan Admin.

Tidak boleh:

``` text
Storefront → business logic A
Telegram   → business logic B
Admin      → business logic C
```

Yang benar:

``` text
Storefront ─────┐
Telegram Bot ───┼──→ Trustance Application
Web Admin ──────┘
```

## 1.2 Backend Is the Source of Truth

Frontend tidak menghitung atau menetapkan business truth secara
permanen.

Frontend boleh:

-   melakukan client-side validation untuk UX
-   menampilkan harga
-   menampilkan stock
-   menghitung preview/subtotal untuk UX
-   mengelola form state
-   mengelola loading/error state
-   melakukan optimistic UI hanya jika aman

Frontend tidak boleh:

-   menentukan harga final
-   menentukan discount final
-   menentukan stock final
-   membuat reservation sendiri
-   menentukan payment sebagai PAID
-   menentukan fulfillment sebagai DELIVERED
-   memanggil provider secara langsung
-   mengakses database
-   mengimplementasikan ledger
-   mengimplementasikan provider fallback

Final validation dan mutation selalu dilakukan server-side.

------------------------------------------------------------------------

# 2. Target Repository Structure

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

Domain packages remain backend-owned:

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

Frontend must not duplicate these domain implementations.

------------------------------------------------------------------------

# 3. Frontend Layer Architecture

Frontend uses the following layers:

``` text
Route / Page
    ↓
Feature UI
    ↓
Application Client
    ↓
API Contract
    ↓
Trustance Server
    ↓
Application Use Case
    ↓
Domain
    ↓
Infrastructure
    ↓
PostgreSQL / External Providers
```

## 3.1 Route Layer

Responsibilities:

-   URL routing
-   route params
-   search params
-   page composition
-   metadata
-   server/client boundary
-   authentication gate where appropriate

Must not contain business transaction logic.

## 3.2 Feature Layer

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

-   UI composition
-   feature-specific hooks
-   feature-specific forms
-   API calls through application client
-   loading states
-   error presentation
-   local interaction state

It does not own database or provider logic.

## 3.3 Shared UI Layer

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

Shared UI must remain domain-light.

For example:

``` text
MoneyDisplay
```

may format:

``` text
amount + currency + exponent
```

but must not decide exchange rates.

------------------------------------------------------------------------

# 4. Storefront Architecture

## 4.1 Storefront Responsibilities

Storefront provides:

-   landing page
-   catalog
-   category
-   product detail
-   variant selection
-   cart
-   buy now
-   checkout
-   customer authentication
-   game input
-   nickname verification
-   payment selection
-   payment status
-   order history
-   order detail
-   fulfillment information
-   account/profile
-   tickets/support
-   notifications

## 4.2 Storefront Folder Structure

``` text
apps/storefront/src/
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── (shop)/
│   │   ├── products/
│   │   ├── categories/
│   │   └── games/
│   ├── cart/
│   ├── checkout/
│   ├── payment/
│   ├── orders/
│   ├── account/
│   ├── support/
│   └── auth/
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
├── forms/
├── schemas/
├── hooks/
├── stores/
├── providers/
├── lib/
└── tests/
```

------------------------------------------------------------------------

# 5. Web Admin Architecture

Admin is a separate presentation surface but uses the same backend
application/domain layer.

## 5.1 Admin Responsibilities

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

## 5.2 Admin Folder Structure

``` text
apps/web-admin/src/
├── app/
│   ├── layout.tsx
│   ├── dashboard/
│   ├── catalog/
│   ├── products/
│   ├── orders/
│   ├── payments/
│   ├── fulfillment/
│   ├── inventory/
│   ├── games/
│   ├── providers/
│   ├── customers/
│   ├── tickets/
│   ├── notifications/
│   ├── finance/
│   ├── audit/
│   └── settings/
│
├── features/
│   ├── dashboard/
│   ├── catalog/
│   ├── orders/
│   ├── payments/
│   ├── fulfillment/
│   ├── inventory/
│   ├── providers/
│   ├── tickets/
│   ├── finance/
│   └── audit/
│
├── components/
├── services/
├── forms/
├── schemas/
├── hooks/
├── stores/
├── providers/
├── lib/
└── tests/
```

Admin authorization is always server-side.

Frontend route hiding is UX only, not a security boundary.

------------------------------------------------------------------------

# 6. API / Application Boundary

Preferred storefront flow:

``` text
Browser
  ↓
Next.js Route / Server Action / API Client
  ↓
Trustance Server API
  ↓
Customer Resolution
  ↓
Authorization
  ↓
Application Use Case
  ↓
Domain
```

Admin:

``` text
Browser
  ↓
Admin Session
  ↓
RBAC / Permission
  ↓
Admin API
  ↓
Application Use Case
  ↓
Domain
```

Frontend must never:

``` text
Browser
  ↓
Prisma
```

and never:

``` text
Browser
  ↓
Provider API
```

------------------------------------------------------------------------

# 7. Shared API Contract

Storefront, Admin, and Telegram must share the same semantic contracts.

Shared contracts include:

``` text
Domain DTO
Validation schema
Command shape
Response shape
Error taxonomy
Status enum
Capability enum
Money representation
Pagination
Idempotency contract
```

Recommended package:

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

Contracts must not expose Prisma models directly.

------------------------------------------------------------------------

# 8. Money and Multi-Currency Frontend Rules

The PostgreSQL architecture uses exact Decimal values. API boundaries
therefore use decimal strings.

Canonical:

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
API Decimal String
      ↓
Money Value Object / Decimal-aware formatter
      ↓
UI
```

Do not use JavaScript `number` for authoritative financial calculations.

A frontend preview calculation may be performed for UX, but the server
response remains authoritative.

## 8.1 Currency Display

The frontend must receive or resolve:

``` text
currency code
currency name
symbol
exponent
amount
```

Examples:

``` text
IDR 100000
USDT 6.493506
```

Currency conversion must be explicit.

Historical exchange rates must not be reconstructed from current rates.

------------------------------------------------------------------------

# 9. Product Capability Architecture

Product UI must be driven by server capability.

Example:

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

Frontend should render flow based on capability.

Do not hardcode:

``` text
if product.name === "Alight Motion"
```

Use:

``` text
product.capability.deliveryMode
product.capability.requiresUserInfo
product.capability.requiresNickname
```

------------------------------------------------------------------------

# 10. Commerce Flows

## 10.1 Standard Premium Product

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

## 10.2 Manual User Info

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

## 10.3 Manual Account

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

## 10.4 Instant Premium

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

## 10.5 Game Top-Up

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

The UI may share primitives, but the state machine differs according to
capability.

------------------------------------------------------------------------

# 11. Checkout Architecture

Checkout must be server-authoritative.

Frontend flow:

``` text
Cart
 ↓
Start Checkout
 ↓
Fetch / Validate Current State
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

At final mutation:

``` text
Frontend State
      ↓
Command
      ↓
Server Validation
      ↓
Expected-State / Idempotent Mutation
      ↓
Authoritative Response
```

Frontend must handle:

``` text
STOCK_CHANGED
RESERVATION_EXPIRED
PRICE_CHANGED
NICKNAME_INVALID
CHECKOUT_EXPIRED
```

Do not assume data validated earlier is still valid when the order is
created.

------------------------------------------------------------------------

# 12. Cart Architecture

Cart is server-backed.

Frontend may cache cart data for rendering, but server state is
authoritative.

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

Do not store the canonical cart only in localStorage.

Local state may be used for temporary UI state.

------------------------------------------------------------------------

# 13. Payment Architecture

Payment lifecycle is separate from fulfillment lifecycle.

Frontend must represent:

``` text
Payment:
PENDING
PAID
EXPIRED
FAILED
CANCELLED
```

and separately:

``` text
Fulfillment:
WAITING_FOR_INFO
INFO_SUBMITTED
PROCESSING
DELIVERED
FAILED
```

Critical invariant:

``` text
PAYMENT = PAID
```

does not imply:

``` text
FULFILLMENT = DELIVERED
```

Payment rail changes must follow the server contract.

A single order must not expose multiple simultaneously payable PENDING
payments.

------------------------------------------------------------------------

# 14. Order Architecture

Order status is domain-owned.

Frontend must not create a parallel status enum.

Use shared status:

``` text
PENDING
PAID
PROCESSING
COMPLETED / DELIVERED
CANCELLED
EXPIRED
FAILED
```

Exact values must come from the canonical backend contract.

Order detail should render:

``` text
Order
├── Order Number
├── Items
├── Pricing Currency
├── Payment
├── Payment Currency
├── Payment Status
├── Fulfillment per Order Item
├── Delivery
└── Support
```

Because fulfillment belongs to `OrderItem`, the frontend must not assume
a single fulfillment state for a mixed order.

------------------------------------------------------------------------

# 15. Fulfillment UI

Fulfillment is rendered per order item.

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

The frontend reads fulfillment truth from the server.

Do not infer delivery from payment success.

------------------------------------------------------------------------

# 16. Notification Architecture

Frontend-originated business events must not directly send
Telegram/email notifications.

Canonical:

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

Storefront may display notification state, but notification delivery
remains backend-owned.

------------------------------------------------------------------------

# 17. Authentication

Customer and Admin sessions are separate domains.

``` text
Customer Session
Admin Session
```

Web session requirements:

``` text
HttpOnly
Secure
SameSite
```

Do not store sensitive session credentials in localStorage.

Frontend authentication responsibilities:

-   login UI
-   registration UI
-   session-aware rendering
-   logout interaction
-   expired-session handling
-   authentication loading state

Server responsibilities:

-   credential validation
-   session creation
-   session validation
-   authorization
-   permission evaluation

------------------------------------------------------------------------

# 18. Authorization and RBAC

Frontend route guards are not security.

Admin permission must be enforced server-side:

``` text
Admin Session
  ↓
Role
  ↓
Permission
  ↓
Application Command
```

Frontend may use permission information to:

-   hide buttons
-   disable actions
-   hide navigation
-   improve UX

But the API must reject unauthorized mutations regardless of UI state.

------------------------------------------------------------------------

# 19. CSRF and Request Security

For cookie-based mutation:

``` text
Origin Validation
+
CSRF Protection
+
SameSite Cookie Policy
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

Never put credentials or secrets in URLs.

------------------------------------------------------------------------

# 20. Idempotency

Client mutations that can be retried must support server-defined
idempotency semantics.

Examples:

``` text
Create Order
Create Payment
Submit Fulfillment Info
```

Recommended:

``` text
Idempotency-Key
```

The frontend must preserve the same idempotency key when retrying the
same logical operation.

It must not generate a new key merely because the HTTP request timed
out.

------------------------------------------------------------------------

# 21. Error Architecture

Frontend consumes shared error taxonomy.

Examples:

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

Presentation mapping belongs to frontend.

Example:

``` text
NICKNAME_INVALID
→ "Nickname tidak valid. Silakan periksa kembali ID game."
```

Do not create different semantic errors for web and Telegram.

------------------------------------------------------------------------

# 22. Data Fetching and Cache

Use a server-state library where appropriate.

Recommended separation:

``` text
Server State
→ API query/cache layer

UI State
→ local component state / lightweight store

Form State
→ form library / controlled state

Session State
→ server/session boundary
```

Do not place all API data into one global client store.

Recommended query keys:

``` text
catalog
product
cart
checkout
order
payment
notifications
tickets
profile
```

Mutation should invalidate or update affected server-state queries.

------------------------------------------------------------------------

# 23. SSR / CSR Boundary

Prefer server rendering for:

-   public catalog pages
-   product pages
-   SEO metadata
-   static content
-   authenticated page shells where practical

Use client components for:

-   interactive forms
-   cart interactions
-   checkout
-   nickname checking
-   payment selection
-   dialogs
-   dynamic UI state

Avoid making the entire application client-rendered without a concrete
reason.

------------------------------------------------------------------------

# 24. URL and Navigation Rules

URLs should represent navigable resources.

Examples:

``` text
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

Admin:

``` text
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

Do not put secrets, credentials, or sensitive fulfillment data in query
strings.

------------------------------------------------------------------------

# 25. Form Architecture

Forms should have three levels:

``` text
UI validation
    ↓
API schema validation
    ↓
Domain validation
```

Client validation improves UX but never replaces server validation.

Game input should be generated from the shared game input schema:

``` ts
type GameInputField = {
  key: string;
  label: string;
  type: "text" | "number";
  required: boolean;
};
```

Frontend renderer:

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

------------------------------------------------------------------------

# 26. Nickname Check UI

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

Frontend must not call VIPReseller, Kokinpay, Melostore, or any other
provider directly.

Provider routing remains backend-owned.

The UI displays normalized result only.

------------------------------------------------------------------------

# 27. Provider Isolation

Frontend must never depend on provider-specific implementation.

Do not expose:

``` text
DigiflazzClient
VIPResellerClient
KokinpayClient
MelostoreClient
```

to browser code.

Instead expose domain concepts:

``` text
NicknameService
PaymentService
FulfillmentService
```

Provider selection, fallback, capability, retry, reconciliation, and
cost remain backend concerns.

------------------------------------------------------------------------

# 28. Observability

Frontend should attach:

``` text
correlation ID
request ID
route
user/customer context where safe
```

Do not log:

``` text
password
payment secret
provider API key
inventory credential
raw account credential
sensitive PII
```

Client telemetry must be sanitized.

Error reporting must not leak secrets.

------------------------------------------------------------------------

# 29. Accessibility

All customer-facing UI should support:

-   keyboard navigation
-   semantic HTML
-   visible focus state
-   labels for form fields
-   accessible error messages
-   sufficient contrast
-   responsive layout
-   reduced-motion consideration

Checkout and payment flows require especially clear error and status
communication.

------------------------------------------------------------------------

# 30. Responsive Design

Storefront:

``` text
Mobile-first
Tablet
Desktop
```

Admin:

``` text
Desktop-first
Tablet support
Mobile fallback for operationally useful screens
```

Critical commerce actions must remain usable on mobile.

------------------------------------------------------------------------

# 31. Performance

Priorities:

``` text
Fast initial render
Minimal client JavaScript
Image optimization
Route-level code splitting
Query caching
Avoid unnecessary global state
Avoid duplicate API requests
```

Do not sacrifice transactional correctness for optimistic performance.

For example:

``` text
"Buy Now"
```

must always resolve current server state before final order creation.

------------------------------------------------------------------------

# 32. Testing Architecture

Tests should exist at multiple levels.

``` text
Unit
Integration
Component
Route
E2E
Contract
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
Retry with same Idempotency-Key
```

Financial display tests must include:

``` text
IDR exponent 0
USDT exponent 6
Decimal strings
Large values
Trailing zero preservation where required
```

------------------------------------------------------------------------

# 33. Frontend Anti-Patterns

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
Frontend calculates final price
Frontend decides stock
Frontend marks order PAID
Frontend marks fulfillment DELIVERED
Frontend owns reservation
Frontend implements provider fallback
Frontend stores authoritative cart only in localStorage
```

Never duplicate:

``` text
OrderStatus
PaymentStatus
FulfillmentStatus
ProductCapability
GameInputSchema
Money Contract
Error Taxonomy
```

across applications.

------------------------------------------------------------------------

# 34. Shared Contract Boundary

The canonical relationship is:

``` text
                    ┌─────────────────────┐
                    │ Shared Contracts    │
                    │                     │
                    │ DTO                │
                    │ Validation         │
                    │ Status             │
                    │ Error Taxonomy     │
                    │ Capability         │
                    │ Money              │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ↓                ↓                ↓
         Storefront        Telegram           Admin
              │                │                │
              └────────────────┼────────────────┘
                               ↓
                     Trustance Application
                               ↓
                            Domain
                               ↓
                       Infrastructure
                               ↓
                         PostgreSQL
```

UI remains channel-specific.

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

------------------------------------------------------------------------

# 35. Runtime Architecture

Production target:

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
                         Trustance Server/API
                                    ↓
                    Application / Domain Modules
                                    ↓
                     Repository / Infrastructure
                                    ↓
                         PostgreSQL + Prisma
                                    │
             ┌──────────────────────┼─────────────────────┐
             ↓                      ↓                     ↓
       Provider APIs          Notification Outbox      Workers
```

Frontend has no direct database boundary.

------------------------------------------------------------------------

# 36. PostgreSQL Alignment

The frontend must align with the canonical PostgreSQL architecture:

``` text
PostgreSQL
→ Decimal exact-value money
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
→ string API representation
→ Decimal-aware presentation
```

Do not reintroduce floating-point semantics at the browser boundary.

------------------------------------------------------------------------

# 37. Deployment

Recommended:

``` text
Internet
   ↓
Reverse Proxy / CDN
   ↓
Storefront / Server
   ↓
Internal Application Network
   ↓
PostgreSQL
```

Admin should use a protected route/domain and server-side authorization.

Static assets should be cacheable.

Authenticated and transactional responses must use appropriate cache
controls.

------------------------------------------------------------------------

# 38. Frontend Environment Variables

Only public configuration may be exposed to browser bundles.

Safe examples:

``` text
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_PUBLIC_API_URL
NEXT_PUBLIC_ANALYTICS_ID
```

Never expose:

``` text
DATABASE_URL
PRISMA credentials
payment secrets
provider API keys
webhook secrets
encryption keys
session signing secrets
```

Server-only environment variables must remain on the server.

------------------------------------------------------------------------

# 39. Definition of Done

Frontend architecture is considered compliant when:

``` text
[ ] Storefront uses Trustance Application/API
[ ] Admin uses Trustance Application/API
[ ] No browser-to-Prisma access
[ ] No browser-to-provider access
[ ] Shared domain status contracts
[ ] Shared error taxonomy
[ ] Shared product capability contract
[ ] Shared game input contract
[ ] Money represented as decimal strings
[ ] Currency always explicit
[ ] IDR exponent handled as 0
[ ] USDT exponent handled as 6
[ ] Checkout revalidates server state
[ ] Cart is server-backed
[ ] Payment and fulfillment states are separate
[ ] Fulfillment rendered per OrderItem
[ ] Idempotency supported for retryable mutations
[ ] Customer authorization enforced server-side
[ ] Admin RBAC enforced server-side
[ ] CSRF policy implemented for cookie mutations
[ ] No sensitive credential in localStorage
[ ] No provider secret in frontend
[ ] Notification delivery remains outbox-driven
[ ] Game nickname check uses application API
[ ] Provider routing remains backend-owned
[ ] E2E checkout flows covered
[ ] Mixed-order fulfillment covered
[ ] Decimal/multi-currency display tested
[ ] Accessibility baseline tested
[ ] Responsive storefront tested
```

------------------------------------------------------------------------

# 40. Final Architectural Principle

Trustance frontend is a **channel/presentation system**, not a second
commerce backend.

The canonical dependency direction is:

``` text
UI
 ↓
Feature
 ↓
Application Client
 ↓
API Contract
 ↓
Trustance Server
 ↓
Application Use Case
 ↓
Domain
 ↓
Infrastructure
 ↓
PostgreSQL / Providers
```

The canonical commerce flow remains:

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

The frontend is responsible for presenting and collecting information.

The backend is responsible for deciding what is true.

PostgreSQL is the transactional persistence source of truth.

Providers remain infrastructure adapters.

Telegram and Web are different channels over the same Trustance
application/domain contract.

Any future frontend change must preserve these boundaries unless
explicitly introduced as a versioned architecture change.
