# Storefront: Top Up Game / Pulsa / PPOB support (Pilot: Top Up Game via Digiflazz)

## Context

The storefront (`apps/storefront`) currently sells manually/pre-stocked digital
goods (VPN, streaming, gift cards). The homepage already has a static,
backend-less "Layanan mendatang" (coming soon) placeholder literally named
`web.topup_title` (Game Top Up) and `web.sosmed_title` — confirming the team
already anticipated this expansion.

The user wants the storefront to support **top up game, PPOB, and pulsa**,
matching the UX pattern of a reference site (topup.karuhundeveloper.com /
github.com/karuhun-developer/webtopup — Digiflazz + API Games backed), while
keeping the current "Trustance" trust-forward branding (pine-blue palette,
trust badges, warranty language) completely unchanged — this is a catalog +
flow addition, not a re-skin.

Two scope decisions were made during brainstorming:
- **Fulfillment**: integrate a real supplier — **Digiflazz only** (covers
  pulsa, PPOB, and many game top-ups with one API/credential — API Games is
  explicitly deferred, not part of this plan).
- **Rollout**: build **one pilot category end-to-end first — Top Up Game**
  (e.g. Mobile Legends, Free Fire — Digiflazz's largest, highest-demand SKU
  catalog), verify it works in production, *then* extend the same framework
  to Pulsa and PPOB. This plan covers **only the Top Up Game pilot**. Pulsa
  and PPOB are explicitly out of scope here (see "Future extension" at the
  end) — they're simpler (single-field, no account/server pair), so the
  framework built here covers them with no new mechanism, only new category/
  denomination data.

The user also chose a **new single-page "instant buy" flow** for this
category (account field → pick denomination → contact → pay, all on one
page, no visible Cart step) over reusing the existing multi-page
Product→Cart→Checkout flow as-is — while still reusing the existing
Cart/Checkout *backend* logic under the hood (money handling, payment
method selection, order creation) rather than building a parallel order
pipeline.

## Key existing mechanisms this plan reuses (no reinvention)

- `Denomination.additionalFields` + `deliveryType: "manual_with_info"` +
  `DeliveryFieldInput`/`deliveryFields.ts` (`apps/storefront/client/src/...`)
  already collect and validate custom buyer input (e.g. a game ID + server)
  per order line, as a list of fields (not just one) — this is exactly what
  a game top-up purchase needs (confirmed against the reference site's own
  "Masukkan Data Akun" step, which is just an Id + Server text-input pair).
  **No new field schema needed for this.**
- `Denomination.autoDeliverySource` (`prisma/schema.prisma:190`) already
  exists ("Source key for auto-fulfilment... Null = manual") but is **not
  read anywhere yet** — confirmed via grep, it's only ever written by
  `createDenomination`/`updateDenomination`. This is the intended hook: set
  it to `"digiflazz"` on a denomination to mark it Digiflazz-fulfilled.
- The **manual fulfilment lane** (`deliveryType: "manual_with_info"` →
  `settlePaidOrder` → `PENDING_VERIFICATION→PROCESSING` → admin alert DM →
  `fulfillManualOrder` pastes content → `PROCESSING→DELIVERED`,
  `packages/db/src/crud/orders.ts:1289-1409`) is the safe substrate to build
  on. Digiflazz becomes an **automated actor that fulfils orders in this
  same lane**, instead of a human typing content — we do **not** touch the
  sensitive stock-allocation `approveOrder`/AUTO branch at all.
- The **webhook callback pattern** (`apps/storefront/src/routes/checkout.ts`
  `POST /pay/tokopay/callback` etc., lines 703-875: rate-limit → load creds
  → verify signature → look up order → re-confirm → deliver → 200) is the
  template for a new `POST /pay/digiflazz/callback` route.
- The **Settings whitelist secret-pair pattern** (`bybit_api_key`/
  `bybit_api_secret` in `apps/web-admin/src/routes/api/settings.ts`
  `EDITABLE`/`SECRET_KEYS`, resolved via a `getXCreds` helper in
  `packages/db/src/crud/*`) is the template for storing Digiflazz creds.
- The **cron job pattern** (`apps/order-bot/src/jobs/index.ts`, `croner`
  `Cron`, plus `scheduleFxRefresh()` which runs independent of the bot `Api`
  for web-only boot) is the template for a periodic Digiflazz sync job.
- **Money**: `Denomination.costPrice` already exists as a nullable Decimal
  sibling to `price` — this is where Digiflazz's base cost goes; markup is
  simply `price - costPrice`, set by the admin when creating the
  denomination (no auto-pricing logic needed for the pilot).
- **Buy-now-skips-visible-cart** is already an established pattern —
  `ProductPage.tsx`'s `buyMutation` already does add-to-cart then
  immediately navigates to `/checkout` for every product today. The new
  "instant" page follows the same shape, just collapsed onto one screen and
  skipping the separate `/checkout` page navigation too (payment method
  picker embeds directly).

## Design

### 1. Schema changes (`prisma/schema.prisma`)

- `Denomination.supplierSku String?` — the Digiflazz `buyer_sku_code` this
  denomination maps to. Set together with `autoDeliverySource = "digiflazz"`.
- `Category.checkoutFlow String @default("catalog")` — `"catalog"` (current
  multi-page behavior, untouched) or `"instant"` (new single-page flow).
  Migrate with a default so every existing category is unaffected.
- No change to `DeliveryType` enum (`packages/core/src/enums.ts`) — Digiflazz
  denominations use the existing `manual_with_info` value.

### 2. Digiflazz client (`packages/core/src/suppliers/digiflazz.ts`, new file)

Pure functions, raw `fetch`, no retry logic, creds passed in as an argument
(never read from env inside) — mirrors `packages/core/src/payments/tokopay.ts`
exactly (same shape as its `TokopayCreds` param, same MD5-signature style,
same "throw on non-ok/malformed" error handling). Exposes:
- `getPriceList(creds)` — fetch Digiflazz's full SKU/price list.
- `createTransaction(creds, { refId, buyerSkuCode, customerNo })` — place a
  top-up order; returns status `Sukses` (with a serial number/receipt),
  `Pending` (await webhook), or `Gagal` (with a reason).
- `verifyCallback(secretKey, body)` — validates the inbound webhook.
Add `digiflazz.test.ts` alongside it, following `tokopay.test.ts`'s
`vi.stubGlobal("fetch", ...)` pattern. Add the subpath export
`"./suppliers/digiflazz"` to `packages/core/package.json`.

### 3. Credentials & admin settings

- `apps/web-admin/src/routes/api/settings.ts`: add `digiflazz_username` /
  `digiflazz_api_key` to `EDITABLE` + `SECRET_KEYS`, following the
  `bybit_api_key`/`bybit_api_secret` pattern exactly.
- `packages/db/src/crud/digiflazz.ts` (new file): `getDigiflazzCreds(db)`
  mirroring `getTokopayCreds`.
- Reuse the existing `PAYMENT_METHODS`-style "test connection" route pattern
  for a `/api/settings/digiflazz/test` route (calls `getPriceList`, reports
  SKU count) so the admin can confirm credentials work before mapping any
  product.

### 4. Catalog admin UI (`apps/web-admin/client/src/pages/`)

- `DenominationCreatePage.tsx` / `DenominationEditPage.tsx`: add two
  optional fields — **Supplier SKU** (text) and an **Auto delivery source**
  select (None / Digiflazz). Selecting Digiflazz nudges `deliveryType` to
  `manual_with_info` and pre-fills `additionalFields` with a two-field
  template — required `user_id` ("Game ID") + optional-by-default
  `server_id` ("Server / Zone") — the admin can delete the second field for
  ID-only games (e.g. Free Fire) or adjust labels per title.
- Category create/edit: add a **Checkout flow** toggle (Catalog / Instant).
- SKU lookup itself (browsing Digiflazz's price list in-UI) is **not**
  built in the pilot — the admin copies `buyer_sku_code` values from
  Digiflazz's own dashboard/docs. A browsable picker is a natural v1.1, not
  required to prove the pilot out.

### 5. Fulfillment wiring (`packages/db/src/crud/orders.ts`, `digiflazz.ts`)

No change to `settlePaidOrder`'s branch condition — a Digiflazz denomination
is `manual_with_info`, so it already takes the existing MANUAL branch
(`PENDING_VERIFICATION→PROCESSING`, buyer "sedang diproses" DM, admin alert
enqueued) untouched.

New: `dispatchPendingDigiflazzOrders(db)` in `packages/db/src/crud/digiflazz.ts`
— a poller (**not** inline in the payment webhook handler, so a slow/flaky
Digiflazz call never delays a payment-gateway callback response):
1. Finds `PROCESSING` orders whose item's denomination has
   `autoDeliverySource === "digiflazz"` and hasn't been dispatched yet (a
   `digiflazzDispatchedAt`-style guard, or reuse `OrderStatusHistory` meta
   to avoid double-dispatch — pick one during implementation).
2. Reads the buyer's Game ID (+ Server, if the SKU has one) from that
   order/item's stored `additionalFields` answer (the same JSON
   `validateCustomerData` already writes at checkout — confirm exact
   column, `Order.customerData` vs `OrderItem.customerData`, while
   implementing) and formats them into Digiflazz's expected `customer_no`
   string for that SKU (format varies per game/SKU — e.g. some games want
   `"<id> <server>"` combined, others just the id; confirm the exact
   convention per mapped SKU against Digiflazz's docs during
   implementation, not assumed here).
3. Calls `digiflazz.createTransaction`.
4. `Sukses` → `fulfillDigiflazzOrder(db, orderId, { sn })` — a twin of
   `fulfillManualOrder` (same atomic `PROCESSING→DELIVERED` claim, same
   `finalizeDeliverySideEffects` + buyer DM), content = formatted SN
   receipt, `logAdminAction` action `"order.auto_fulfill_digiflazz"`
   instead of `"order.manual_fulfill"`.
5. `Pending` → leave as `PROCESSING`; the new `POST /pay/digiflazz/callback`
   webhook route (built exactly like the tokopay/nowpayments callbacks —
   rate-limit, verify signature, look up order by `refId`, re-check) calls
   the same `fulfillDigiflazzOrder` once Digiflazz reports the final result.
6. `Gagal` (invalid game ID/server / insufficient Digiflazz balance) →
   **do not** auto-fail or auto-refund in the pilot. Enqueue a distinct
   `ADMIN_MANUAL_ORDER_QUEUED`-style alert ("Digiflazz gagal — perlu
   ditangani manual") so a human finishes it via the existing
   `fulfillManualOrder` path. Automatic refund/cancel is future work.

Cron registration: `apps/order-bot/src/jobs/index.ts`, following
`scheduleFxRefresh()`'s shape (runs without the bot `Api`, since this job
only needs `db` + the Digiflazz HTTP client — buyer notification still goes
through the existing outbox, not a direct Telegram call). Interval: every
1–2 minutes, matching `binancePollWatchdog`'s cadence.

A separate lower-frequency job (e.g. hourly) refreshes `costPrice` on
denominations that already have a `supplierSku` set, by matching against a
fresh `getPriceList()` call — keeps margin reporting honest without any
catalog auto-provisioning (the admin still owns which products/denominations
exist; the sync only touches cost, never creates/deletes catalog rows in
the pilot).

### 6. Frontend: instant-buy page (`apps/storefront/client/src/pages/`)

- `ProductPageData` (backend `apps/storefront/src/pageData.ts`) gains
  `checkout_flow: "catalog" | "instant"` sourced from `product.category`.
- `ProductPage.tsx` branches at the top: `checkout_flow === "instant"` →
  render a new `InstantBuyPage` component instead of the current body.
  (`catalog` products are 100% unaffected — same component, same code path.)
- New `InstantBuyPage.tsx` (or `components/shop/InstantBuySection.tsx`),
  one continuous page, reusing existing pieces:
  1. Product header (name/image/trust chips — same visual language as
     `ProductPage`'s existing trust markers).
  2. Account field(s) — `DeliveryFieldInput` for the denomination's
     `additionalFields` (Game ID + Server), shown up top so it reads like
     TopupWok's "Masukkan Data Akun" step, using the same client-side
     `fieldError`/`allFieldsValid` pre-check from `deliveryFields.ts`. No
     live account/nickname validation in the pilot (the reference site's
     own game brand pages don't show one either — plain text inputs) —
     a "check account" nickname-lookup call is a clearly-scoped future
     enhancement, not required to match the reference UX.
  3. Denomination grid — reuse `DenominationCard`.
  4. Contact details — reuse whatever `CheckoutPage.tsx` already collects
     for guest/contact info.
  5. Payment method selector — reuse `CheckoutPage.tsx`'s existing payment
     method UI (extract into a shared component if it isn't already
     standalone).
  6. One "Beli Sekarang" button: the submit handler calls the existing
     `POST /api/v1/cart` then `POST /api/v1/checkout` in sequence (same two
     calls `buyMutation` already makes today, just chained under one
     button/one loading state instead of a page navigation in between), then
     routes straight to the existing `PayPage` (payment instructions) —
     **never** surfacing `/cart` or `/checkout` as separate screens. No new
     backend endpoint required.

### 7. Homepage polish (`HomePage.tsx`)

Once the Top Up Game category has active products, it already appears in
the existing dynamic "Kategori" grid (`categories.map(...)`,
`HomePage.tsx:358-384`) with **zero code change** — that section already
reads from real API data. The only edit needed: drop the "Top Up Game"
(`web.topup_title`) card from the static "Layanan mendatang" section
(`HomePage.tsx:422-457`, `HomePage.tsx:448` specifically) once it's live —
it's the exact placeholder this pilot fulfils, and leaving it up alongside
real Top Up Game products would read as a bug. Leave the `web.sosmed_title`
(social media services) placeholder as-is — unrelated to this work.

## Critical files

- `prisma/schema.prisma` — `Denomination.supplierSku`, `Category.checkoutFlow`.
- `packages/core/src/suppliers/digiflazz.ts` (new) + `.test.ts`.
- `packages/db/src/crud/digiflazz.ts` (new) — creds, dispatch poller, cost sync.
- `packages/db/src/crud/orders.ts` — new `fulfillDigiflazzOrder` twin of
  `fulfillManualOrder` (~line 1366).
- `apps/storefront/src/routes/checkout.ts` — new `POST /pay/digiflazz/callback`,
  modeled on the tokopay/paydisini/nowpayments callbacks (lines 703-875).
- `apps/order-bot/src/jobs/index.ts` — new cron entry (poller + cost sync).
- `apps/web-admin/src/routes/api/settings.ts` — Digiflazz `EDITABLE`/`SECRET_KEYS`.
- `apps/web-admin/client/src/pages/DenominationCreatePage.tsx`,
  `DenominationEditPage.tsx` — Supplier SKU + auto delivery source fields.
- `apps/storefront/client/src/pages/ProductPage.tsx` — instant-flow branch.
- `apps/storefront/client/src/pages/InstantBuyPage.tsx` (new).
- `apps/storefront/client/src/pages/HomePage.tsx` — drop stale placeholder.

## Verification

- `pnpm typecheck` and `pnpm test` (Vitest) stay green, including new
  `digiflazz.test.ts` (mocked `fetch`, success/pending/failure/bad-signature
  cases) and a `crud/digiflazz.test.ts` for the dispatch poller against a
  test DB.
- Rebuild the storefront client (`pnpm --filter @app/storefront-client build`)
  and manually walk the pilot end-to-end in a browser: admin creates a
  "Top Up Game" category (`checkoutFlow: instant`) + one product (e.g.
  Mobile Legends) + a denomination with a real/sandbox `supplierSku` and
  Digiflazz test credentials in Settings → storefront
  `/p/<mobile-legends-slug>` renders the instant-buy layout → submit with a
  test Game ID + Server → order reaches `PayPage` → after confirming
  payment (or via the sandbox webhook), the order transitions
  `PROCESSING→DELIVERED` automatically and the buyer receives the DM with
  the SN — without any admin manually typing content.
- Confirm a `catalog`-flow product (e.g. an existing VPN product) is
  completely unaffected — same `ProductPage` rendering, same Cart/Checkout
  navigation as before.

## Future extension (explicitly not in this plan)

- **Pulsa** (Telkomsel, XL, Indosat, etc.): same framework, simpler than
  the pilot — a single `additionalFields` entry (phone number) instead of
  the Game ID + Server pair. New categories with `checkoutFlow: instant`,
  denominations with `autoDeliverySource: digiflazz` + `supplierSku`. No
  new schema or fulfillment code expected.
- **PPOB** (PLN, BPJS, PDAM, etc.): same framework — `additionalFields`
  swapped for a meter/customer ID. No new schema or fulfillment code
  expected.
- **Account/nickname validation**: a "check account" button on the
  instant-buy page that calls Digiflazz's nickname-lookup for supported
  games before the buyer commits — deferred, not present on the reference
  site's own pages either.
- API Games (or another dedicated game-topup supplier) integration, if
  Digiflazz's own game catalog proves too thin — deferred per the
  brainstorming decision to start with one supplier only.
