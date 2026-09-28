# Trustance — Prisma + PostgreSQL + Docker Database Architecture
## POSTGRESQL-DOCKER-V1 — Production Multi-Currency Architecture

**Status:** Canonical architecture specification  
**Database:** PostgreSQL  
**ORM:** Prisma  
**Runtime:** Node.js / TypeScript  
**Primary currencies:** IDR, USDT  
**Money representation:** Decimal exact-value money  
**Architecture:** PostgreSQL primary, Dockerized on VPS, pooled connections, short transactions  
**Document purpose:** Canonical database architecture for Trustance commerce, payments, fulfillment, provider integrations, inventory, ticketing, ledger, and multi-currency settlement.

---

# 1. Executive Summary

Trustance uses PostgreSQL as its primary transactional database, running in Docker on the production VPS.

The database must support:

- digital product commerce
- game top-up
- premium application delivery
- manual account inventory
- instant provider fulfillment
- nickname checking
- customer accounts
- carts
- mixed orders
- payments
- IDR and USDT settlement
- exchange-rate snapshots
- provider idempotency
- provider balance monitoring
- inventory reservation
- ticketing
- outbox/event delivery
- background tasks
- audit logs
- double-entry accounting
- cost/HPP tracking
- PII protection
- encryption-key rotation
- operational backup and recovery

The architecture is intentionally PostgreSQL-first. PostgreSQL-native concurrency, indexing, constraints, and transaction patterns may be used where they improve correctness and reliability.

The canonical source of truth is the complete `schema.prisma` described by this document. Any generated ERD/DBML must be derived from the canonical schema rather than maintained independently.

---

# 2. Non-Negotiable Financial Invariants

The following invariants are mandatory.

1. Money is never stored as floating point.
2. Every monetary amount has an explicit currency.
3. Every currency has an explicit exponent.
4. IDR uses exponent 0.
5. USDT uses exponent 6.
6. Payment provider external references are unique per provider.
7. Provider request IDs are deterministic and unique.
8. Webhook events are idempotently deduplicated.
9. Ledger entries are immutable.
10. Double-entry ledger groups balance per currency.
11. A currency conversion is represented explicitly.
12. Historical exchange rates are snapshotted.
13. Provider cost/HPP is stored at execution time.
14. Order state transitions use expected-state conditional updates.
15. Payment state transitions use expected-state conditional updates.
16. Fulfillment state transitions use expected-state conditional updates.
17. Inventory reservation is atomic.
18. Background tasks are deduplicated.
19. Outbox consumers are idempotent.
20. Database backups are PostgreSQL-safe and restore-tested.
21. Production PostgreSQL is isolated behind the private Docker network unless deliberate external access is required.

---

# 3. PostgreSQL Operational Model

PostgreSQL is a server database. The production deployment uses a dedicated PostgreSQL container with a persistent Docker volume.

Trustance therefore uses:

- one PostgreSQL primary instance
- Docker Compose-managed PostgreSQL container
- persistent Docker volume for data
- pooled application connections
- short transactions
- multiple application/worker processes may connect concurrently
- read replicas or analytics databases when necessary

The architecture supports concurrent application and worker connections through PostgreSQL. High availability remains a separate deployment concern and is not provided automatically by a single PostgreSQL container.

PostgreSQL is the canonical production database for Trustance. Scaling limits should be evaluated using connection count, transaction throughput, query latency, storage, and operational requirements rather than a single-writer model.

---

# 4. PostgreSQL Connection Configuration

Required operational configuration:

```env
DATABASE_URL=postgresql://trustance:<password>@postgres:5432/trustance

# Example pool settings via connection URL where supported:
# ?connection_limit=10&pool_timeout=10&connect_timeout=5
```

PostgreSQL enforces foreign keys and transactional integrity natively. PostgreSQL WAL is managed by PostgreSQL itself and is not configured through application-level database PRAGMAs.

For Prisma ORM, use the PostgreSQL datasource provider and keep the connection URL in environment configuration.

Connection pooling must be configured deliberately. The Prisma PostgreSQL connector supports connection limits and pool timeouts through the connection URL.

Do not expose PostgreSQL directly to the public internet when application containers can reach it over the private Docker network.

Use strong database credentials and keep them outside source control.

---

# 5. PostgreSQL Write Transactions

PostgreSQL supports concurrent transactions, but transaction scope must still be tightly controlled.

Transactions should perform the minimum set of reads/writes required for an atomic state transition.

Use PostgreSQL row-level locking or conditional updates where required. For contention-sensitive flows, prefer patterns such as `SELECT ... FOR UPDATE`, unique constraints, `UPDATE ... WHERE expected_state`, and atomic `INSERT ... ON CONFLICT` operations.

Long-running work must never occur inside a write transaction.

Never call:

- provider APIs
- payment APIs
- Telegram APIs
- HTTP APIs
- external webhooks
- email delivery

while holding a PostgreSQL transaction open.

---

# 6. Prisma Transaction Configuration

Prisma transaction settings must be explicitly configured for the workload.

Recommended baseline:

```ts
transactionOptions: {
  maxWait: 5000,
  timeout: 10000,
}
```

These values are operational defaults, not permission to perform long transactions.

The architecture still requires transactions to be short.

A transaction should normally:

1. validate local state
2. update local state
3. insert ledger/outbox/task records
4. commit

External work happens afterward.

---

# 7. Money Representation

All monetary values use Prisma `Decimal` / exact decimal arithmetic.

Never use:

- JavaScript `number`
- SQL REAL
- floating-point exchange rates
- binary floating-point arithmetic

for persisted money.

A monetary value is:

```text
(amount, currency)
```

Example:

```text
IDR 17,127
amount = 17127
currency = IDR
```

```text
USD 10.50
amount = 1050
currency = USD
```

```text
USDT 10.50
amount = 10.500000
currency = USDT
```

---

# 7A. PostgreSQL Decimal Storage Policy

PostgreSQL is the production database specifically so financial Decimal values have a native exact numeric representation.

Recommended Prisma mapping for Trustance monetary/rate fields:

```prisma
Decimal @db.Decimal(38, 18)
```

`NUMERIC/DECIMAL` is exact in PostgreSQL. The database precision/scale is a storage boundary; the business-level currency exponent still controls how many fractional digits are valid for a specific currency. citeturn382252search2turn382252search5

Use `Decimal` in Prisma and never convert persisted financial values through JavaScript `number`.

For example:

```text
IDR 100000
USDT 6.493506
FX rate 15400.000000
```

The application remains responsible for currency-specific validation and deterministic rounding. PostgreSQL provides the exact numeric storage and arithmetic substrate.

---

# 8. Currency Exponent

The currency master table must contain the exponent.

Example:

| Currency | Type | Exponent |
|---|---|---:|
| IDR | FIAT | 0 |
| USD | FIAT | 2 |
| USDT | CRYPTO | 6 |

The exponent is not inferred at runtime.

The application must use the currency's configured exponent to validate the allowed fractional precision of a human-readable decimal amount. The persisted value remains a Decimal, not an integer atomic-unit count.

---

# 9. Currency Master

Canonical model:

```prisma
model Currency {
  id          String   @id
  code        String   @unique
  name        String
  type        String   // FIAT | CRYPTO
  exponent    Int
  symbol      String?
  isActive    Boolean  @default(true)

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  pricingOrders       Order[]        @relation("OrderPricingCurrency")
  payments            Payment[]      @relation("PaymentCurrency")
  settlementPayments  Payment[]      @relation("PaymentSettlementCurrency")
  ledgerEntries       LedgerEntry[]
  exchangeBaseRates   ExchangeRateSnapshot[] @relation("ExchangeRateBase")
  exchangeQuoteRates  ExchangeRateSnapshot[] @relation("ExchangeRateQuote")
}
```

Seed:

```text
IDR / Indonesian Rupiah / FIAT / exponent 0
USD / US Dollar / FIAT / exponent 2
USDT / Tether USD / CRYPTO / exponent 6
```

Currency rows should not be deleted after they have been used by financial records.

Use `isActive=false` instead.

---

# 10. Decimal JSON Serialization

Prisma Decimal values must not be converted to JavaScript `number` before crossing an API boundary.

Financial API contracts should serialize money as decimal strings together with currency.

Example:

```json
{
  "amount": "10.500000",
  "currency": "USDT"
}
```

Do not serialize financial values as binary floating-point JSON numbers such as:

```json
{
  "amount": 10.5
}
```

because clients may parse the value as an IEEE-754 number and lose exact decimal semantics.

Use a centralized serializer/mapper at API, Telegram, webhook, admin, and logging boundaries.

---

# 11. Decimal Money Parser

All user-entered monetary values must be parsed from strings into exact Decimal values.

Never do:

```ts
const amount = Number(input);
```

or:

```ts
const amount = parseFloat(input);
```

Instead:

```text
"10.50 USDT"
      ↓
currency exponent = 6
      ↓
Decimal("10.500000")
```

The parser must:

- reject invalid decimal syntax
- reject negative values when not permitted
- enforce the currency's maximum fractional precision
- avoid JavaScript floating-point arithmetic
- return a Decimal value
- normalize scale only where the domain requires it

---

# 12. Currency Conversion

Currency conversion is explicit.

Never silently convert between currencies.

A conversion requires:

```text
sourceCurrency
targetCurrency
sourceAmount
rate
rate timestamp
rate source
```

Historical financial records must not depend on today's rate.

---

# 13. Exchange Rate Snapshot

Canonical model:

```prisma
model ExchangeRateSnapshot {
  id              String   @id

  baseCurrencyId  String
  quoteCurrencyId String

  rate            Decimal

  source          String
  capturedAt      DateTime
  expiresAt       DateTime?

  createdAt       DateTime @default(now())

  baseCurrency    Currency @relation(
    "ExchangeRateBase",
    fields: [baseCurrencyId],
    references: [id]
  )

  quoteCurrency   Currency @relation(
    "ExchangeRateQuote",
    fields: [quoteCurrencyId],
    references: [id]
  )
}
```

Use Decimal for exchange rates. Do not convert exchange rates to JavaScript `number`.

Example:

```text
1 USDT = 15400.000000 IDR

rate = Decimal("15400.000000")
```

The exact quote precision and rounding policy must be defined by the application.

---

# 14. Commercial Pricing Currency vs Payment Currency

Do not assume:

```text
Order.currency == Payment.currency
```

Example:

```text
Product price:
Rp100,000

Customer payment:
6.493506 USDT
```

The order has a commercial/pricing currency.

The payment has its settlement currency.

This separation is mandatory for multi-currency checkout.

---

# 15. Order Monetary Fields

Recommended order structure:

```prisma
model Order {
  id                  String @id

  orderNumber         String @unique

  pricingCurrencyId   String
  subtotalAmount      Decimal
  discountAmount      Decimal
  feeAmount           Decimal
  totalAmount         Decimal

  channel             String
  status              String

  expiresAt           DateTime?
  paidAt              DateTime?
  fulfilledAt         DateTime?

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  pricingCurrency     Currency @relation(
    "OrderPricingCurrency",
    fields: [pricingCurrencyId],
    references: [id]
  )

  items               OrderItem[]
  payments            Payment[]
  fulfillments        Fulfillment[]
  idempotencyRecords  IdempotencyRecord[]
}
```

Invariant:

```text
totalAmount =
subtotalAmount
- discountAmount
+ feeAmount
```

Use application validation plus database CHECK constraints where possible.

---

# 16. Payment Currency

Canonical Payment concept:

```prisma
model Payment {
  id                     String @id

  orderId                String

  amount                 Decimal
  currencyId             String

  settlementAmount       Decimal?
  settlementCurrencyId   String?

  exchangeRateSnapshotId String?

  provider               String
  externalReference      String

  status                 String

  paidAt                 DateTime?

  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  order                  Order @relation(
    fields: [orderId],
    references: [id]
  )

  currency               Currency @relation(
    "PaymentCurrency",
    fields: [currencyId],
    references: [id]
  )

  settlementCurrency     Currency? @relation(
    "PaymentSettlementCurrency",
    fields: [settlementCurrencyId],
    references: [id]
  )

  exchangeRateSnapshot   ExchangeRateSnapshot? @relation(
    fields: [exchangeRateSnapshotId],
    references: [id]
  )

  cryptoPayment          CryptoPayment?
}
```

Payment uniqueness:

```prisma
@@unique([provider, externalReference])
```

This prevents a payment gateway reference from being credited twice.

---

# 17. Payment Example — IDR

```text
Order:
pricingCurrency = IDR
totalAmount     = 100000

Payment:
currency        = IDR
amount          = 100000
```

No conversion is necessary.

---

# 18. Payment Example — USDT

```text
Order:
pricingCurrency = IDR
totalAmount     = 100000

Payment:
currency        = USDT
amount          = 6.493506

Exchange snapshot:
1 USDT = 15400 IDR
```

The exact conversion/rounding policy must be deterministic.

The exchange snapshot remains attached to the payment permanently.

---

# 19. Payment Methods

Payment method is separate from currency.

Examples:

```text
IDR
 ├── QRIS
 ├── BANK_TRANSFER
 └── E_WALLET

USDT
 ├── TRC20
 ├── ERC20
 └── BEP20
```

Canonical concept:

```prisma
model PaymentMethod {
  id          String @id
  currencyId  String

  methodType  String
  network     String?

  isActive    Boolean @default(true)

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  currency    Currency @relation(
    fields: [currencyId],
    references: [id]
  )
}
```

`network` is mandatory for network-specific crypto settlement.

---

# 20. Crypto Payment

If Trustance accepts actual on-chain USDT payments, add:

```prisma
model CryptoPayment {
  id              String @id

  paymentId       String @unique

  assetCode       String
  network         String

  depositAddress  String
  fromAddress     String?
  toAddress       String?

  txHash          String?
  logIndex        Int?

  amount          Decimal

  confirmations   Int @default(0)

  status          String

  detectedAt      DateTime?
  confirmedAt     DateTime?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  payment         Payment @relation(
    fields: [paymentId],
    references: [id]
  )

  @@unique([network, txHash, logIndex])
}
```

If a network has no log index concept, use a network-specific deterministic transaction identity.

Never identify a crypto payment only by `txHash` if the chain's transaction can contain multiple token transfers relevant to the system.

---

# 21. Crypto Payment Confirmation

A blockchain payment should not become `PAID` merely because a transaction was detected.

Typical state flow:

```text
PENDING
  ↓
DETECTED
  ↓
CONFIRMING
  ↓
CONFIRMED
  ↓
PAID
```

The required confirmation threshold is network-specific.

Do not hardcode one global confirmation number.

---

# 22. Provider Request Idempotency

Every provider execution must have a deterministic request ID.

Canonical field:

```text
providerRequestId
```

Recommended source:

```text
FULFILL:{orderItemId}
```

or another stable versioned identifier.

ProviderAttempt must enforce:

```prisma
@@unique([providerId, providerRequestId])
```

This is mandatory for Digiflazz, VIPReseller, and similar H2H providers.

Retrying the same OrderItem must reuse the same provider request ID.

A retry must never generate a fresh reference accidentally.

---

# 23. Provider Attempt

Canonical concept:

```prisma
model ProviderAttempt {
  id                 String @id

  orderItemId        String
  providerId         String

  providerRequestId  String
  providerReference  String?

  costAmount         Decimal
  costCurrencyId     String

  status             String

  attemptNumber      Int

  requestedAt        DateTime?
  completedAt        DateTime?

  errorCode          String?
  errorMessage       String?

  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  orderItem          OrderItem @relation(
    fields: [orderItemId],
    references: [id]
  )

  provider            Provider @relation(
    fields: [providerId],
    references: [id]
  )

  costCurrency        Currency @relation(
    fields: [costCurrencyId],
    references: [id]
  )

  @@unique([providerId, providerRequestId])
  @@index([orderItemId])
}
```

Actual provider cost belongs here because provider selection and execution determine actual HPP.

---

# 24. Cost / HPP

Every financially meaningful fulfillment must preserve actual cost.

Example:

```text
Sale:
100,000 IDR

Provider:
Digiflazz

Actual HPP:
87,500 IDR

Gross margin:
12,500 IDR
```

If the provider charges USDT:

```text
Sale:
100,000 IDR

HPP:
5.700000 USDT
```

The cost currency must be stored.

Never assume HPP uses the order currency.

---

# 25. OrderItem Cost Snapshot

For fast reporting, OrderItem may also snapshot the finalized cost:

```text
costAmount
costCurrencyId
```

The authoritative execution cost remains the ProviderAttempt that actually fulfilled the item.

---

# 26. Provider Balance

Provider balance monitoring is required.

Canonical concept:

```prisma
model ProviderBalanceSnapshot {
  id             String @id

  providerId     String
  currencyId     String

  availableAmount Decimal
  capturedAt      DateTime

  source          String

  createdAt      DateTime @default(now())
}
```

Use it for:

- low balance alerts
- provider health
- fulfillment protection
- operational dashboards
- historical provider liquidity analysis

---

# 27. Multi-Currency Ledger

Ledger entries must carry currency.

```prisma
model LedgerEntry {
  id            String @id

  entryGroupId  String
  accountId     String

  currencyId    String
  amount        Decimal

  direction     String // DEBIT | CREDIT

  referenceType String
  referenceId   String

  description   String?

  createdAt     DateTime @default(now())

  account       LedgerAccount @relation(
    fields: [accountId],
    references: [id]
  )

  currency      Currency @relation(
    fields: [currencyId],
    references: [id]
  )

  @@index([entryGroupId])
  @@index([accountId, currencyId])
}
```

---

# 28. Double-Entry Ledger

Each financial transaction has an `entryGroupId`.

Example:

```text
Entry Group A

Debit:
Cash IDR        100,000

Credit:
Revenue IDR     100,000
```

For an explicit FX conversion:

```text
Entry Group B

Debit:
Cash USDT        6.493506 USDT

Credit:
Cash IDR         100,000 IDR
```

The FX conversion must be modeled as a defined accounting event rather than pretending different currencies numerically balance.

---

# 29. Ledger Balance Invariant

The invariant is:

```text
For every entryGroupId + currency:
    total debit == total credit
```

Do not enforce:

```text
total debit across all currencies
==
total credit across all currencies
```

because IDR and USDT are different units.

Ledger entries are immutable.

---

# 30. Chart of Accounts

Ledger requires explicit accounts.

Examples:

```text
1000 Cash IDR
1001 Cash USDT
1100 Customer Receivable IDR
1101 Customer Receivable USDT
2000 Customer Liability IDR
2001 Customer Liability USDT
4000 Sales Revenue IDR
4001 Sales Revenue USDT
5000 COGS IDR
5001 COGS USDT
6000 Payment Fees
7000 FX Gain/Loss
```

The exact chart may evolve.

Account identity must never depend solely on display names.

---

# 31. Currency Conversion and FX Gain/Loss

If Trustance buys/sells/holds assets across currencies, exchange differences must not disappear.

Example:

```text
Customer paid:
6.50 USDT

Recorded commercial value:
Rp100,000

Later valuation:
6.50 USDT = Rp101,000
```

The Rp1,000 difference is not a silent mutation of the original transaction.

It is an accounting/valuation event.

---

# 32. Customer

Customer must contain operationally searchable fields.

Recommended:

```prisma
model Customer {
  id          String @id

  email       String?
  displayName String?
  phone       String?

  status      String @default("ACTIVE")

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  identities  CustomerIdentity[]
  carts       Cart[]
  orders      Order[]
  tickets     Ticket[]
  nicknameChecks NicknameCheck[]
}
```

Sensitive fields must follow the PII policy.

Telegram identity must not be buried only inside arbitrary metadata.

---

# 33. Guest Checkout

If guest checkout is supported:

```text
Cart.customerId
```

must be nullable.

Guest identity can be represented by:

```text
guestSessionId
```

or an equivalent controlled mechanism.

Do not force a registered Customer record solely to create a cart.

---

# 34. Customer Identity

Platform identities are separate from the core Customer.

Examples:

```text
TELEGRAM
EMAIL
WEB
```

Identity records may include external IDs.

PII rules must specify:

- encryption
- indexing
- retention
- deletion/anonymization
- access control

---

# 35. Nickname Check

`NicknameCheck.customerId` must have a real Prisma relation.

```prisma
model NicknameCheck {
  id          String @id

  customerId  String?

  providerId  String

  gameCode    String
  target      String

  nickname    String?
  status      String

  createdAt   DateTime @default(now())

  customer    Customer? @relation(
    fields: [customerId],
    references: [id]
  )

  provider    Provider @relation(
    fields: [providerId],
    references: [id]
  )
}
```

Nullable customer supports guest checks if required.

---

# 36. Catalog

Required catalog models:

```text
Category
Product
ProductVariant
ProviderMapping
```

`Category` must be defined explicitly.

Example:

```prisma
model Category {
  id          String @id
  slug        String @unique
  name        String

  isActive    Boolean @default(true)

  products    Product[]

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

---

# 37. Product

```prisma
model Product {
  id          String @id

  categoryId  String
  slug        String @unique
  name        String

  fulfillmentType String
  isActive    Boolean @default(true)

  category    Category @relation(
    fields: [categoryId],
    references: [id]
  )

  variants    ProductVariant[]
  mappings    ProviderMapping[]
}
```

ProviderMapping must have the matching `Product.mappings` relation.

---

# 38. Product Variants

ProductVariant is the canonical commercial variant.

Do not create an orphan `GameVariant` table that duplicates ProductVariant.

If game-specific metadata is required, attach it to Product/ProductVariant or create a clearly scoped game catalog entity with explicit ownership.

A model with no domain references must not remain in the canonical schema.

---

# 39. OrderItem

OrderItem must reference the product variant and preserve price snapshots.

Recommended fields:

```text
quantity
unitPriceAmount
unitPriceCurrencyId
subtotalAmount
costAmount
costCurrencyId
fulfillmentType
```

Prices are snapshots.

Catalog price changes must not mutate historical orders.

---

# 40. Fulfillment

Fulfillment must have a direct Order relation if Order declares `fulfillments`.

Example:

```prisma
model Fulfillment {
  id          String @id

  orderId     String
  orderItemId String

  status      String

  deliveryData String?

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  order       Order @relation(
    fields: [orderId],
    references: [id]
  )

  orderItem   OrderItem @relation(
    fields: [orderItemId],
    references: [id]
  )
}
```

This fixes the missing Prisma back-relation.

---

# 41. Fulfillment Units

For manual account products with quantity > 1, a single Fulfillment row is insufficient.

Two valid choices:

1. Force `quantity = 1` for manual account products.
2. Introduce `FulfillmentUnit`.

Recommended architecture:

```text
OrderItem
  quantity = 3

Fulfillment
  ├── Unit 1
  ├── Unit 2
  └── Unit 3
```

Use FulfillmentUnit when a product's individual delivered units need separate inventory, credentials, status, or retry tracking.

---

# 42. Inventory

Inventory supports:

- manual account
- license key
- redeem code
- credential delivery
- other finite stock

Inventory payloads containing secrets must be encrypted.

---

# 43. Inventory Encryption

Encrypted inventory payload must include:

```text
algorithm
keyVersion
ciphertext
nonce/iv
authentication tag
```

At minimum the database needs a `keyVersion`.

Without key versioning, future key rotation becomes unsafe.

---

# 44. Inventory Reservation

Inventory must be reserved atomically.

Use conditional update patterns:

```text
UPDATE inventory_item
SET status = 'RESERVED'
WHERE id = ?
AND status = 'AVAILABLE';
```

Check affected row count.

Do not:

```text
SELECT AVAILABLE
then
UPDATE
```

as two unrelated operations.

---

# 45. PostgreSQL Partial Indexes

PostgreSQL supports partial indexes.

Use Prisma schema/index support where available and migration SQL for PostgreSQL-specific indexes or constraints when needed.

Examples:

```sql
CREATE UNIQUE INDEX idx_inventory_one_active_reservation
ON inventory_reservations(inventory_item_id)
WHERE status = 'ACTIVE';
```

and:

```sql
CREATE UNIQUE INDEX idx_one_paid_payment_per_order
ON payments(order_id)
WHERE status = 'PAID';
```

These are PostgreSQL capabilities and should be treated as database-level correctness mechanisms.

---

# 46. Optimistic State Transitions

All important state transitions must include expected state.

Example:

```ts
await prisma.order.updateMany({
  where: {
    id,
    status: "PENDING_PAYMENT",
  },
  data: {
    status: "PAID",
    paidAt: new Date(),
  },
});
```

Then check:

```text
count === 1
```

If count is zero, the transition lost the race or the order is already in another state.

Apply the same pattern to:

- Payment
- Fulfillment
- Inventory
- Task
- Ticket where appropriate

---

# 47. Idempotency Record

`IdempotencyRecord` must have a real relationship with its target domain.

If it is order-scoped:

```prisma
model IdempotencyRecord {
  id             String @id

  customerId     String?
  orderId        String?

  key            String
  requestHash    String

  responseStatus Int
  responseData  String?

  expiresAt      DateTime

  createdAt      DateTime @default(now())

  order          Order? @relation(
    fields: [orderId],
    references: [id]
  )

  @@unique([customerId, key])
}
```

If response data can contain credentials, it must not be stored as plaintext indefinitely.

Use encryption and strict TTL.

---

# 48. Webhook Event

Provider ID must not be nullable for a provider webhook.

```prisma
model WebhookEvent {
  id              String @id

  providerId      String
  externalEventId String

  payload         String
  status          String

  receivedAt      DateTime @default(now())
  processedAt     DateTime?

  provider        Provider @relation(
    fields: [providerId],
    references: [id]
  )

  @@unique([providerId, externalEventId])
}
```

Never rely on nullable uniqueness for webhook deduplication.

---

# 49. Webhook Processing

Webhook processing is at-least-once.

Correct flow:

```text
Receive webhook
      ↓
Insert WebhookEvent
      ↓
If unique conflict:
    already processed/received
      ↓
Return success
```

Then processing must be idempotent.

Never assume a webhook arrives exactly once.

---

# 50. Outbox

Outbox guarantees durable intent to publish external events.

Canonical fields:

```text
id
eventType
aggregateType
aggregateId
payload
status
attempts
maxAttempts
availableAt
lockedAt
lockedBy
lockExpiresAt
createdAt
publishedAt
```

Outbox processing is at-least-once.

Consumers must be idempotent.

---

# 51. Outbox Ordering

If ordering matters, store:

```text
aggregateType
aggregateId
sequence
```

Consumers must not assume global ordering.

Ordering is defined per aggregate where required.

---

# 52. Task Queue

Tasks need:

```text
status
attempts
maxAttempts
lockedAt
lockedBy
lockExpiresAt
availableAt
dedupeKey
```

`dedupeKey` should be unique.

Example:

```text
FULFILL_ORDER_ITEM:{orderItemId}
```

---

# 53. Task Claiming

Claim flow:

```text
READY
 ↓
atomic claim
 ↓
PROCESSING
 ↓
SUCCESS / FAILED
```

A crashed worker must not permanently strand the task.

Reaper logic:

```text
PROCESSING
AND lockExpiresAt < now
        ↓
READY
```

`lockedBy` identifies the worker.

---

# 54. Provider Calls

Provider calls must happen outside DB transactions.

Correct:

```text
DB transaction
  create/update attempt
  commit

provider API call

DB transaction
  persist result
  create ledger/outbox/task effects
  commit
```

Never hold a PostgreSQL transaction open during provider HTTP latency.

---

# 55. Payment Processing

Payment processing must be idempotent.

Flow:

```text
Webhook
  ↓
Deduplicate event
  ↓
Load Payment
  ↓
Expected-state transition
  ↓
Create ledger event
  ↓
Create fulfillment task
  ↓
Commit
```

No duplicate webhook may create a second financial credit.

---

# 56. Payment External Reference

Mandatory:

```prisma
@@unique([provider, externalReference])
```

Do not use only:

```prisma
@@index([externalReference])
```

A gateway reference is a financial identity.

---

# 57. Order Number Generator

Order number must not depend on:

```text
SELECT MAX(orderNumber)
```

Use an atomic counter.

Example:

```text
TRX-20260825-000123
```

The date boundary must use:

```text
Asia/Jakarta
```

The counter update must be atomic.

Sequence gaps are acceptable.

Duplicate order numbers are not acceptable.

---

# 58. Admin User

Admin identity must have a real security model.

Required concepts:

```text
AdminUser
AdminRole
AdminPermission
AdminUserRole
```

Admin credentials should include:

```text
passwordHash
status
lastLoginAt
twoFactorEnabled
twoFactorSecret / external 2FA reference
```

Secrets must be encrypted or protected appropriately.

Never store plaintext passwords.

---

# 59. Ticketing

Ticketing is a first-class domain.

Minimum relations:

```text
Customer
  ↓
Ticket
  ↓
TicketMessage
```

Tickets may reference:

```text
Order
OrderItem
Payment
Fulfillment
```

Ticket state transitions should also be conditional.

---

# 60. Audit Log

Audit logs are immutable.

Recommended fields:

```text
actorType
actorId
action
entityType
entityId
beforeData
afterData
ipAddress
userAgent
createdAt
```

Sensitive fields must be redacted.

---

# 61. Database Triggers for Immutability

Application-level immutability is not sufficient for financial records.

PostgreSQL triggers may protect:

```text
ledger_entries
audit_logs
```

Example concept:

```sql
CREATE TRIGGER prevent_ledger_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger entries are immutable');
END;
```

Similarly for delete.

Use migration SQL.

---

# 62. CHECK Constraints

Use PostgreSQL CHECK constraints for local invariants where appropriate.

Examples:

```sql
CHECK(amount >= 0)
```

and:

```sql
CHECK(total_amount = subtotal_amount - discount_amount + fee_amount)
```

Do not rely exclusively on application validation for financial invariants.

---

# 63. PII Protection

Potential PII includes:

- email
- phone
- Telegram identifiers
- game targets
- account delivery information
- ticket content
- IP address
- user agent

Database security must include:

- disk encryption
- restricted filesystem access
- encrypted secret payloads
- application authorization
- retention policy
- secure backups

If threat requirements justify it, evaluate SQLCipher.

This must be aligned with applicable Indonesian privacy requirements, including UU PDP No. 27/2022.

---

# 64. Encryption Key Rotation

Every encrypted payload must have:

```text
keyVersion
algorithm
```

Example:

```text
keyVersion = 3
algorithm  = AES-256-GCM
```

Rotation process:

```text
read old key
decrypt
encrypt with new key
set new keyVersion
```

Never rotate by overwriting the key without migrating ciphertext.

---

# 65. Secret Storage

Provider credentials must never be stored as plaintext.

Use:

```text
encryptedPayload
keyVersion
algorithm
```

The same principle applies to:

- inventory credentials
- account passwords
- provider API keys
- crypto private material

---

# 66. PostgreSQL Database Backups

PostgreSQL backups must use PostgreSQL-aware mechanisms.

Accepted approaches include:

- `pg_dump` / `pg_restore`
- `pg_basebackup` where physical backups are required
- WAL archiving for PITR
- managed/object-storage backup workflows

Do not copy the live PostgreSQL data directory using arbitrary filesystem copy and treat it as a guaranteed consistent backup. Use PostgreSQL-aware logical or physical backup tooling.

---

# 67. PostgreSQL WAL / PITR

For production durability, evaluate PostgreSQL WAL archiving and point-in-time recovery (PITR).

The production recovery design should define:

```text
RPO
RTO
backup retention
replica location
restore procedure
restore verification
```

A daily backup alone may produce an RPO close to 24 hours.

For financial operations, this should be considered unacceptable unless explicitly approved.

---

# 68. Restore Testing

A backup that has never been restored is not a proven backup.

Schedule restore tests.

Test:

```text
database restore
Prisma startup
foreign keys
PostgreSQL WAL recovery
application startup
payment reads
ledger reads
inventory reads
```

Verify checksums/integrity as part of the recovery procedure.

---

# 69. Docker Deployment

Docker production deployment uses a PostgreSQL service with persistent storage. Application containers may be replaced or scaled independently from PostgreSQL as long as they use the same DATABASE_URL and compatible migrations.

The PostgreSQL container must never be treated as disposable application state. Upgrades and redeployments must preserve the persistent volume and follow the PostgreSQL major-version upgrade procedure.

If multiple application instances are deployed, they must use the same PostgreSQL database through controlled connection pooling and transaction boundaries.

---

# 70. PostgreSQL Single-Node Consequence

A single PostgreSQL container means:

```text
VPS / PostgreSQL node failure
    ↓
Database unavailable
    ↓
Application unavailable
```

Therefore the architecture must explicitly define:

- RTO
- RPO
- backup location
- recovery node
- failover procedure

PostgreSQL is not automatically highly available merely because it uses WAL. HA requires replication/failover architecture beyond a single container.

---

# 71. Reporting and Analytics

Heavy reporting should not run indefinitely against the primary writable database.

Large analytics queries can:

- hold long read transactions
- increase WAL growth
- interfere with checkpointing
- increase disk usage

Use:

```text
PostgreSQL primary
      ↓
backup / replication
      ↓
read-only reporting copy
```

or an analytical database when scale justifies it.

---

# 72. Retention Policy

Retention must have concrete values.

Recommended starting point:

```text
WebhookEvent       90 days
ProviderHealth     30 days
Task records       90 days
Outbox published   30 days
Audit logs         1–7 years depending on requirement
Payment records    long-term
Order records      long-term
Ledger entries     long-term
Ticket records     1–3 years
Provider balance   1 year
```

Actual retention must be reviewed against legal, accounting, operational, and privacy requirements.

Financial records should not be deleted merely because application UI no longer needs them.

---

# 73. Provider Health

Provider health records should support:

```text
latency
successRate
failureCount
errorRate
balance
lastSuccessAt
lastFailureAt
```

`errorRate` should use a simple numeric representation appropriate to reporting needs; Decimal is acceptable when fractional precision is required.

---

# 74. Inventory Reservation State Machine

Example:

```text
AVAILABLE
   ↓
RESERVED
   ↓
ALLOCATED
   ↓
DELIVERED
```

Failure:

```text
RESERVED
   ↓
RELEASED
```

Reservation expiry must be recoverable.

---

# 75. Order State Machine

Example:

```text
PENDING_PAYMENT
      ↓
PAID
      ↓
PROCESSING
      ↓
PARTIALLY_FULFILLED
      ↓
FULFILLED
```

Failure states:

```text
PAYMENT_FAILED
FULFILLMENT_FAILED
CANCELLED
EXPIRED
```

Transitions are conditional.

---

# 76. Payment State Machine

Example:

```text
PENDING
 ↓
PROCESSING
 ↓
PAID
```

Failure:

```text
FAILED
EXPIRED
CANCELLED
```

A payment must not move backward from PAID to PENDING through a normal retry.

---

# 77. Fulfillment State Machine

Example:

```text
PENDING
 ↓
QUEUED
 ↓
PROCESSING
 ↓
SUCCESS
```

Failure:

```text
RETRYABLE
FAILED
MANUAL_REVIEW
```

Provider retry must preserve the same deterministic providerRequestId when the operation itself is the same logical fulfillment.

---

# 78. Mixed Orders

A single order can contain:

```text
Premium App
+
Game Top Up
+
Manual Account
```

Each OrderItem has its own:

- fulfillment type
- provider mapping
- cost
- provider attempt
- inventory requirement
- ticket context

Order status is derived from item/payment state.

---

# 79. Manual Delivery

Manual delivery may require:

```text
email from customer
```

or:

```text
admin-delivered account
```

The database must distinguish:

```text
MANUAL_EMAIL
MANUAL_ACCOUNT
INSTANT_PROVIDER
```

Do not encode fulfillment behavior solely through UI logic.

---

# 80. Provider Mapping

ProviderMapping determines which provider product/service corresponds to a Product/ProductVariant.

It should support:

```text
provider
externalProductCode
externalVariantCode
cost
currency
priority
active
```

Never assume provider product codes equal internal product IDs.

---

# 81. Game Top-Up

Game top-up requires explicit target data.

Example:

```text
gameCode
server
playerId
nickname
region
```

Only fields required by the game/provider should be populated.

Sensitive target data should follow the PII/security policy.

---

# 82. Game Variant Cleanup

Do not maintain both:

```text
GameVariant
ProductVariant
```

unless there is a clear semantic distinction.

Recommended:

```text
Product
  ↓
ProductVariant
  ↓
ProviderMapping
```

Game-specific metadata belongs to the appropriate domain object.

---

# 83. Idempotency Across System Boundaries

Idempotency exists at multiple boundaries:

```text
Customer → API
API → Payment
Payment Gateway → Trustance
Trustance → Provider
Worker → Fulfillment
Outbox → Consumer
Blockchain → Payment
```

Every boundary must define its idempotency identity.

---

# 84. Provider Idempotency Example

For OrderItem:

```text
orderItemId = oi_123
```

Generate:

```text
FULFILL:oi_123:v1
```

Use the same value for every retry of that logical operation.

If provider requires a maximum length, hash a canonical representation.

---

# 85. Blockchain Idempotency

For on-chain deposits:

```text
network
+
transaction hash
+
transfer/log index
```

should identify a token transfer event.

The same blockchain event must never create two customer credits.

---

# 86. Customer Balance

If Trustance eventually provides a stored-value wallet, do not represent wallet balance as only:

```text
Customer.balance
```

Use ledger-backed balances.

Example:

```text
Customer
  ↓
Wallet
  ↓
WalletAccount
  ↓
LedgerEntry
```

Balance is derived or materialized from immutable ledger state.

---

# 87. USDT Wallet

If customer USDT balances are supported:

```text
Wallet
 ├── currency = USDT
 └── ledger-backed balance
```

Do not mix USDT wallet balance with IDR wallet balance.

Each wallet account has exactly one currency.

---

# 88. Crypto Network Risk

USDT network selection must be validated.

Never allow a customer to select:

```text
USDT
```

without selecting/implicitly fixing:

```text
TRC20
ERC20
BEP20
...
```

A wrong-network transfer can be unrecoverable.

The payment method shown to the user must correspond exactly to the deposit address/network.

---

# 89. Payment Expiration

Crypto payment quotes should expire.

Store:

```text
expiresAt
quotedAmount
exchangeRateSnapshot
```

After expiration:

```text
payment quote invalid
```

Late transfers must enter manual review/reconciliation rather than silently becoming a new payment.

---

# 90. Rounding Policy

Rounding must be deterministic.

The system must define:

- rounding mode
- minimum payment unit
- maximum quote precision
- customer-facing decimal precision
- provider-facing precision

Never use language such as “round normally”.

Use an explicit policy such as:

```text
ROUND_HALF_UP
```

or another selected mode.

---

# 91. Pricing Example

Product:

```text
IDR 100,000
```

USDT checkout:

```text
Rate:
1 USDT = 15,400 IDR

Raw:
100000 / 15400
= 6.493506...
```

The application applies the configured quote precision and rounding policy.

The resulting customer amount and rate snapshot are persisted.

---

# 92. Fee Handling

Payment processing fees must be explicit.

Example:

```text
Product subtotal:
100,000 IDR

Payment fee:
2,500 IDR

Customer total:
102,500 IDR
```

If the fee is charged in USDT:

```text
pricing amount
+
fee converted using snapshot
```

must be calculated deterministically.

---

# 93. FX Conversion Must Be Auditable

Every conversion must preserve:

```text
source amount
source currency
target amount
target currency
rate
rate source
timestamp
rounding
```

Never reconstruct historical conversion from a current rate.

---

# 94. Financial Audit Example

A completed USDT order should be explainable as:

```text
Order:
TRX-20260825-000123

Commercial value:
100,000 IDR

Payment:
6.493506 USDT

Rate snapshot:
1 USDT = 15,400 IDR

Payment provider:
Crypto gateway

Blockchain:
TRC20

Transaction:
0x...

Provider fulfillment:
Digiflazz

Provider request:
FULFILL:order-item-id:v1

Actual HPP:
87,500 IDR

Gross margin:
12,500 IDR
```

All of these facts must remain reconstructable from the database.

---

# 95. Schema Relationship Corrections

The canonical schema must explicitly fix:

1. Missing Category model.
2. Missing Fulfillment → Order relation.
3. Missing IdempotencyRecord → Order relation.
4. Missing Ticket → OrderItem back relation.
5. Missing ProviderMapping → Product back relation.
6. Missing NicknameCheck → Customer relation.
7. Orphan GameVariant.

Prisma must pass:

```bash
prisma validate
prisma generate
```

before the architecture is considered valid.

---

# 96. Canonical Schema Rule

The final implementation must contain one complete canonical:

```text
prisma/schema.prisma
```

Do not maintain disconnected model fragments in documentation as the source of truth.

Documentation describes the schema.

The actual schema file is authoritative.

ERD and DBML are generated artifacts.

---

# 97. Migration SQL

Prisma migrations may contain PostgreSQL-specific SQL for:

- partial indexes
- immutable triggers
- CHECK constraints
- special indexes
- operational tables
- compatibility workarounds

These manual SQL migrations must be version-controlled.

---

# 98. Testing Requirements

Before production, test:

```text
duplicate payment webhook
duplicate provider webhook
duplicate provider request
concurrent inventory reservation
concurrent order payment
concurrent fulfillment claim
worker crash
task lock expiry
outbox retry
provider timeout
provider timeout after provider-side success
crypto duplicate transaction
wrong network
expired USDT quote
exchange-rate change after payment
ledger imbalance attempt
audit mutation attempt
```

---

# 99. Financial Invariant Tests

Automated tests must verify:

```text
Payment(provider, externalReference) is unique
ProviderAttempt(provider, providerRequestId) is unique
WebhookEvent(provider, externalEventId) is unique
Ledger group balances per currency
Immutable ledger cannot be updated
Immutable audit log cannot be deleted
Order total formula is valid
Inventory cannot be reserved twice
One paid payment per order where applicable
```

---

# 100. PostgreSQL Operational Tests

Test under:

- concurrent requests
- slow provider APIs
- long-running reports
- worker crashes
- process restarts
- WAL generation and checkpoints
- backup during active transactions
- restore from backup
- disk-full behavior
- locked database behavior

---

# 101. PostgreSQL Production Architecture

PostgreSQL is the canonical production database for Trustance.

The production topology uses Docker on the VPS:

```text
                    ┌──────────────────────────┐
                    │          VPS              │
                    │       Docker Host         │
                    │                          │
                    │  ┌────────────────────┐  │
Internet ──────────►│  │ Reverse Proxy      │  │
                    │  └─────────┬──────────┘  │
                    │            │             │
                    │   ┌────────┴────────┐    │
                    │   │ Web / API       │    │
                    │   │ Telegram Bot    │    │
                    │   │ Workers         │    │
                    │   └────────┬────────┘    │
                    │            │             │
                    │      Private network     │
                    │            │             │
                    │   ┌────────▼────────┐    │
                    │   │ PostgreSQL      │    │
                    │   │ container       │    │
                    │   └────────┬────────┘    │
                    │            │             │
                    │   ┌────────▼────────┐    │
                    │   │ Persistent      │    │
                    │   │ Docker volume   │    │
                    │   └─────────────────┘    │
                    └──────────────────────────┘
```

The domain model should remain portable, but PostgreSQL-native features are allowed when they directly enforce important invariants or improve operational reliability.

Do not embed business rules in ad-hoc SQL when equivalent domain logic can remain in the application layer. Keep database-specific migrations version-controlled.

---

# 102. PostgreSQL-Specific Features and Portability Notes

The following are PostgreSQL-specific or deployment-specific concerns:

- partial indexes
- PostgreSQL constraints
- PostgreSQL row-level locking
- `FOR UPDATE` / `FOR UPDATE SKIP LOCKED` where appropriate
- PostgreSQL `jsonb`
- native `numeric(p,s)` / `decimal(p,s)`
- PostgreSQL backup/restore tooling
- Docker volume lifecycle
- `pg_dump` / `pg_restore`
- WAL archiving / PITR when implemented

Database-specific SQL must be isolated in Prisma migrations or infrastructure configuration and must not leak arbitrary SQL assumptions into the domain layer.

---

# 103. Recommended Architecture

```text
                    ┌──────────────────────┐
                    │      Customer        │
                    └──────────┬───────────┘
                               │
                               ↓
                    ┌──────────────────────┐
                    │        Cart          │
                    └──────────┬───────────┘
                               │
                               ↓
                    ┌──────────────────────┐
                    │        Order         │
                    │  Pricing Currency    │
                    └───────┬───────┬──────┘
                            │       │
                   ┌────────┘       └─────────┐
                   ↓                          ↓
             OrderItem                     Payment
                   │                    ┌─────┴─────┐
                   ↓                    ↓           ↓
              Fulfillment          Currency    CryptoPayment
                   │                    │
                   ↓                    ↓
             ProviderAttempt     ExchangeRate
                   │
                   ↓
              Provider
                   │
                   ↓
             Provider Balance

Order / Payment / Fulfillment
             │
             ↓
       Ledger / COGS / FX
             │
             ↓
       Outbox / Tasks
             │
             ↓
       External Services
```

---

# 104. Operational Architecture

```text
                    ┌──────────────────────────┐
                    │ Docker VPS               │
                    │                          │
                    │  Web / API               │
                    │  Telegram Bot            │
                    │  Worker(s)               │
                    └────────────┬─────────────┘
                                 │
                          Docker private network
                                 │
                                 ↓
                    ┌──────────────────────────┐
                    │ PostgreSQL container     │
                    └────────────┬─────────────┘
                                 │
                                 ↓
                    ┌──────────────────────────┐
                    │ Persistent volume        │
                    └────────────┬─────────────┘
                                 │
                  ┌──────────────┼──────────────┐
                  ↓              ↓              ↓
              pg_dump       WAL / PITR     Read Replica
                  │              │              │
                  ↓              ↓              ↓
           Backup Storage     Recovery      Analytics
```

---

# 105. Production Checklist

Before production:

```text
[ ] prisma validate passes
[ ] prisma generate passes
[ ] complete schema is canonical
[ ] all relations have back-relations
[ ] Category exists
[ ] GameVariant ambiguity removed
[ ] currency master exists
[ ] IDR exponent = 0
[ ] USDT exponent = 6
[ ] PostgreSQL Decimal mappings are explicit where required
[ ] Decimal JSON serializer exists
[ ] exchange snapshots exist
[ ] payment external reference is unique
[ ] provider request ID is unique
[ ] webhook identity is unique
[ ] provider cost is persisted
[ ] provider balance monitoring exists
[ ] task dedupe exists
[ ] task lock expiry exists
[ ] outbox retry exists
[ ] inventory reservation is atomic
[ ] optimistic state transitions exist
[ ] ledger is double-entry
[ ] ledger is immutable
[ ] audit is immutable
[ ] PostgreSQL connection configuration is verified
[ ] PostgreSQL pool limits are verified
[ ] transaction timeouts configured
[ ] row-level locking strategy is verified
[ ] partial indexes are verified
[ ] PostgreSQL backup is automated
[ ] restore test completed
[ ] RTO documented
[ ] RPO documented
[ ] Docker persistent volume is verified
[ ] PostgreSQL healthcheck is configured
[ ] PostgreSQL port is not publicly exposed by default
[ ] database credentials are stored outside Git
[ ] analytics does not overload primary
[ ] crypto network is explicit
[ ] crypto transaction dedupe exists
[ ] expired crypto quotes are handled
[ ] PII retention is documented
[ ] encryption key rotation exists
[ ] retention values are documented
```

---

# 105A. Docker Compose Production Baseline

The PostgreSQL service is managed by Docker Compose on the VPS. The exact PostgreSQL major version must be pinned intentionally and upgraded through a controlled procedure.

Example baseline:

```yaml
services:
  postgres:
    image: postgres:<approved-major-version>
    restart: unless-stopped
    environment:
      POSTGRES_DB: trustance
      POSTGRES_USER: trustance
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U trustance -d trustance"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

Application containers should connect through the Docker private network:

```env
DATABASE_URL=postgresql://trustance:<password>@postgres:5432/trustance
```

Production rules:

- Do not publish PostgreSQL `5432` publicly by default.
- Do not commit database passwords or `DATABASE_URL` secrets to Git.
- Keep PostgreSQL data on a persistent Docker volume.
- Do not delete the PostgreSQL volume during normal application deployments.
- Run Prisma migrations as an explicit deployment step; do not make destructive migrations an implicit container-startup side effect.
- Ensure the application handles temporary PostgreSQL unavailability during startup/restarts.
- Size the Prisma connection pool according to the number of API/worker replicas and PostgreSQL capacity.
- Back up outside the PostgreSQL container and preferably outside the VPS.
- Test restores against a clean PostgreSQL instance.

---

# 105B. SQLite → PostgreSQL Migration Plan

The migration must be performed as a controlled data migration. Do not try to make the existing SQLite file itself become a PostgreSQL database.

Recommended sequence:

```text
1. Freeze application writes
        ↓
2. Back up the current SQLite database
        ↓
3. Create PostgreSQL container + persistent volume
        ↓
4. Change Prisma datasource: sqlite → postgresql
        ↓
5. Define PostgreSQL native Decimal mappings
        ↓
6. Create/validate PostgreSQL migrations
        ↓
7. Apply schema to empty PostgreSQL database
        ↓
8. Transform and import existing data
        ↓
9. Rebuild/verify indexes and constraints
        ↓
10. Run financial invariant checks
        ↓
11. Run reconciliation against SQLite source
        ↓
12. Switch DATABASE_URL to PostgreSQL
        ↓
13. Start application/workers
        ↓
14. Monitor errors, latency, payments, fulfillment, and ledger
```

Migration requirements:

- Preserve every order, payment, provider attempt, webhook identity, inventory item, ledger entry, and audit record required for historical reconstruction.
- Do not reinterpret historical monetary values using current exchange rates.
- Preserve currency and exchange-rate snapshots exactly.
- Convert SQLite Decimal-compatible values into PostgreSQL `numeric` without passing them through JavaScript floating-point `number`.
- Prefer string-based extraction/import for Decimal values.
- Verify row counts by critical entity before cutover.
- Recalculate derived reporting values only when the existing domain explicitly defines them as derived.
- Do not mutate immutable ledger history during migration.
- Keep the SQLite backup as a read-only rollback/reference artifact until PostgreSQL has passed production reconciliation.

Cutover must be treated as a deployment event, not an ordinary schema migration. The final DATABASE_URL must point to the PostgreSQL service name on the Docker private network, for example:

```env
DATABASE_URL=postgresql://trustance:<password>@postgres:5432/trustance
```

For production, database migrations must be version-controlled and executed explicitly as part of deployment. Do not run destructive schema operations automatically during container startup.

---

# 106. Final Architecture Principles

Trustance's database architecture follows these principles:

1. **PostgreSQL-first production architecture.**
2. **Money uses exact Decimal values.**
3. **Currency is a first-class domain entity.**
4. **IDR and USDT are separate accounting units.**
5. **Commercial pricing and payment settlement are separate concepts.**
6. **Exchange rates are snapshotted.**
7. **Crypto networks are explicit.**
8. **Provider requests are idempotent.**
9. **Payment references are unique.**
10. **Webhooks are at-least-once and idempotent.**
11. **Tasks and outbox events are recoverable.**
12. **Ledger is double-entry and immutable.**
13. **Actual HPP is persisted.**
14. **Provider liquidity is monitored.**
15. **Inventory allocation is atomic.**
16. **State transitions use optimistic concurrency.**
17. **PII and secrets are protected.**
18. **Backups are operationally tested.**
19. **Single-container/single-node HA limitations are explicit.**
20. **The canonical Prisma schema is the source of truth.**

---

# 107. Required Next Implementation Order

Implement in this order:

```text
PHASE 1 — Financial correctness
1. Currency
2. Money/exponent
3. Payment uniqueness
4. Provider request idempotency
5. ExchangeRateSnapshot
6. Multi-currency ledger
7. Cost/HPP

PHASE 2 — Schema correctness
8. Category
9. Fulfillment relations
10. Idempotency relations
11. Ticket relations
12. ProviderMapping relations
13. NicknameCheck relation
14. Remove/resolve GameVariant

PHASE 3 — PostgreSQL correctness
15. PostgreSQL datasource/provider
16. connection URL and secrets
17. connection pool limits
18. transaction timeouts
19. row-level locking / conditional updates
20. partial indexes
21. immutable triggers where needed
22. CHECK constraints
23. PostgreSQL-specific migration SQL where needed

PHASE 4 — Reliability
24. Task locking/reaper
25. Task dedupe
26. Outbox retry
27. Provider balance
28. PostgreSQL backup (`pg_dump`)
29. WAL/PITR when required
30. Restore testing
31. Docker restart policy
32. PostgreSQL healthcheck

PHASE 5 — Crypto
33. PaymentMethod
34. USDT networks
35. CryptoPayment
36. confirmation handling
37. blockchain idempotency
38. expired quote/reconciliation

PHASE 6 — Security
39. PII
40. encrypted payloads
41. keyVersion
42. key rotation
43. admin RBAC
44. 2FA
45. immutable audit

PHASE 7 — Verification
46. canonical schema
47. Prisma validate
48. Prisma generate
49. concurrency tests
50. financial invariant tests
51. backup restore test
52. production readiness review
```

---

# 108. Canonical Status

This document supersedes the previous SQLite database architecture.

Any older schema containing:

- nullable provider webhook identity
- non-unique payment external references
- provider attempts without deterministic request IDs
- floating-point money
- currency-less ledger entries
- orphan Prisma relations
- missing Category
- orphan GameVariant
- non-recoverable tasks
- SQLite-only deployment assumptions that conflict with the PostgreSQL production model

must be considered obsolete.

**Canonical target:** `trustance-prisma-database-architecture-POSTGRESQL-DOCKER-V1.md`
