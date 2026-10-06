# Dynamic Game Input — Repository Audit and Design

## Audit

### Architecture
pnpm 9 monorepo (`pnpm-workspace.yaml`), Node 22, TypeScript. React/Vite SPAs in `apps/storefront/client` and `apps/web-admin/client`; Fastify routes in `apps/storefront/src` and `apps/web-admin/src`; GramMY bot in `apps/order-bot`; shared business rules in `packages/core`; Prisma CRUD in `packages/db`; PostgreSQL schema/migrations in `prisma`; combined entry point in `apps/server`; Docker deployment at repository root. Vitest, Testing Library and Playwright already exist. Environment handling is in `packages/core/src/config.ts`; no secrets belong in this report.

### Relevant Files
- `packages/core/src/deliveryFields.ts`: bilingual dynamic schema, parsing and validation.
- `packages/core/src/nickname/{gameCatalog,fieldMapping,kokinpayProvider,service}.ts`: nickname catalog, positional mappings and provider abstraction.
- `packages/db/src/crud/{catalog,nickname,orders,digiflazz}.ts`: catalog, gate, order creation and fulfillment.
- `apps/storefront/src/{pageData,routes/api,routes/apiTopup,routes/checkout}.ts`: public DTOs, direct and cart checkout.
- `apps/storefront/client/src/{pages/InstantBuyPage,pages/CheckoutPage,components/shop/DeliveryFieldInput,lib/deliveryFields}.tsx`: existing dynamic form (library file is `.ts`).
- `apps/order-bot/src/{handlers/checkout,handlers/customer,conversations/customerInfo,conversations/nicknameCheck,util/gameInfo}.ts`: selection, state, collectors and lookup.
- `apps/web-admin/src/routes/api/catalog.ts` and `apps/web-admin/client/src/components/shared/DeliveryTypeSection.tsx`: field configuration.

### Existing Data Model
Category → Product (game/display group) → Denomination (sellable SKU). Each SKU has `additionalFields` JSON in TEXT, `nicknameCheckGameCode`, `supplierSku`, `autoDeliverySource` and delivery type. No reusable game metadata table exists. Orders already store `customerData` JSON in TEXT containing one string-valued answer map per unit. Order items reference denominations; old identifiers and answer keys must remain readable.

### Existing Product Flow
Digiflazz import groups brands/regions/types into Products and creates inactive Denominations. New SKUs receive the same generic user ID plus optional server template. SKUs added automatically by the hourly/manual sync are ACTIVE and copy the input configuration of the product's existing SKUs, while wizard imports still land inactive. Re-sync preserves admin field edits. Game SKUs may have independently edited fields, making SKU-level configuration the smallest compatible scope.

### Existing Web Flow
Product data contains parsed `additional_fields`. InstantBuyPage renders DeliveryFieldInput and clears answers when SKU changes, but renders/checks inputs only for manual_with_info and sends nickname lookup using hardcoded user_id/server_id keys. Direct checkout drops AUTO answers. Cart checkout similarly gates field validation by delivery type.

### Existing Telegram Bot Flow
`/start` resets scratch state; menu/category/product callbacks lead to showOrderConfirmation. customerInfo already collects arbitrary fields sequentially and validates each answer. nicknameCheck separately collects target/zone/server from catalog flags, then maps them positionally into the SKU schema. Cancellation returns through the checkout gate; stale scratch data needs ownership by SKU/config/quantity.

### Existing Order Flow
Direct and cart creation calculate authoritative price and look up the SKU. Payment rails settle the persisted order; the Digiflazz worker dispatches one supplier unit using server SKU and customerData. Existing idempotency, gateway callbacks and payment status reconciliation must be preserved. Nickname lookup is advisory and failures permit continuing; retain that policy while enforcing input validity.

### Existing Validation
Zod validates configured field keys, labels, types, options and uniqueness. Shared runtime validation trims strings and validates required/number/email/url/select. It currently strips unknown keys and lacks length constraints. Order creation revalidates only manual_with_info. IDs remain strings, preserving leading zeros.

### KokinPay Integration
Server-only credentials; NicknameService normalizes results and errors. Adapter currently forwards server but loses zone. resolveNicknameGate uses an override or fuzzy brand/name matching against a static catalog. Requirement flags diverge from additionalFields.

### Digiflazz Integration
Server supplierSku, credentials, reference IDs and idempotent dispatch already exist. buildDigiflazzCustomerNo joins configured answers with spaces, documented as an assumption. Required fields are not revalidated there. Orders use current field definitions at dispatch, so config edits can change pending order targets.

### Existing Dynamic/Metadata Mechanism
Reuse `additionalFields`, `customerData`, bilingual labels, the field renderer and customerInfo collector. Keep public `additional_fields` and `customer_data`; introduce no second form schema or client game list.

### Current Architectural Problems
Name-based gate; duplicate bot collection rules; permissive unknown input; AUTO validation gap; missing zone forwarding; stale configuration changes; no explicit provider target format or snapshot.

## Design / Recommended Implementation
Source of truth remains Denomination.additionalFields. Extend field constraints with bounded length and safe predefined numeric pattern; reject unknown answers except the legacy display-only nickname (strip it). Add nullable server-only `providerInputMapping` JSON in TEXT, separating input rules from KokinPay parameter keys and Digiflazz target key order/separator. Absent mapping retains legacy field-order formatting; explicit mappings are validated against the configured keys. Nickname service selection uses stored nicknameCheckGameCode only; fuzzy detection is restricted to a one-time dry-run/apply backfill. Backfill reuses known mappings, preserves admin fields, corrects only the exact old generic template, and reports unrecognized cases. Import defaults to a single user ID (no unsupported server guess), inactive as before.

Enforce configured fields on all delivery types before order creation and lookup. Preserve identifiers as trimmed strings. Reuse the generic bot collector for nickname-enabled products so every field, including select/optional, is collected before lookup. Tie scratch answers to SKU/quantity/config. Web sends the complete configured answer map for lookup and resets on configuration changes. Persist an additive order snapshot containing field schema and provider mapping; dispatch uses this snapshot for new orders and current metadata for historical orders. No provider mapping enters public DTOs. Add migration/config documentation and meaningful unit, API, bot and component regressions.

User authorization: execute the supplied specification end to end. No deployment or live provider transaction is requested. Existing unrelated icon deletions and `.audit-data/` are left untouched.

## Spec v2 reconciliation (`...-enhanced-v2.md`)

v2 adds provider findings and three test cases; it does not change the architecture.

- **Digiflazz publishes no input schema.** Its price list has no `requires_zone_id` or `input_fields`, and `desc` is free text. This repository's price-list type (`DigiflazzPriceListItem`) does not ingest `desc` at all, so no runtime path can depend on it. Name text may only drive the one-time, dry-run-first backfill (`playerInputBackfill.ts`), which writes explicit configuration.
- **Scope.** Input configuration already lives on the sellable SKU (`Denomination`), the finest grain. Two variants of one game therefore never inherit from each other (v2 §42.1, Case 17).
- **Unmapped new products (Case 15).** A newly imported SKU lands inactive with one neutral `Game ID` field and no mapping, so an admin must configure and activate it. SKUs added automatically by the hourly/manual sync are ACTIVE and copy the input configuration of the product's existing SKUs, while wizard imports still land inactive. A Digiflazz SKU with no input field at all is refused at checkout.
- **Provider text changes (Case 16).** A re-sync rewrites price, cost, name and status only; an admin-configured profile is never touched.
- **Provenance (§8.3)** is optional in v2 and is not stored. The backfill's dry-run report is the review record.
- **Residual risk.** The backfill decides "needs a zone" for generic Mobile Legends-style SKUs by catalog brand match. v2 warns a brand can hold variants with different requirements, so the dry-run output must be reviewed before `--apply` on any real database.
