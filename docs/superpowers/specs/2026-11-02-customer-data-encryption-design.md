# Encrypt buyer-submitted answers at rest (`Order.customerData`, `BotSession.data`)

## Problem

A buyer's answers to a product's additional fields (Game ID / Zone / Server
for Game Top Up; an account e-mail, username or other free text for Premium
Apps) are stored as plain text:

- `Order.customerData` (`prisma/schema.prisma:711`, `String?`, TEXT) holds
  `[{fieldKey: "answer"}, ...]`, one map per unit.
- `BotSession.data` holds the grammY session JSON, which contains
  `scratch.customerData` and, through `@grammyjs/conversations`, the messages
  the buyer typed, for about 35 minutes per checkout (24 h for navigation
  sessions).

Field types are only `text | email | number | url | select`
(`packages/core/src/deliveryFields.ts:16`). There is no secret field type and
no sensitivity flag, and an admin can label a `text` field "Password". So
every answer must be treated as sensitive. A database leak, a backup dump or a
SQL-injection read of the table currently exposes all of it.

The owner's rule (2026-11-01): sensitive data is protected at rest (hash or
encryption), never plain text.

## Goal

After this change, a copy of the database (dump, backup, read-only SQL access)
shows neither order answers nor in-flight bot checkout answers in plain text.
Admins, buyers, the bot and the supplier dispatch keep working exactly as
today.

## Decisions already made (owner, 2026-11-02)

1. **Scope:** `Order.customerData` for all orders (both product families) and
   `BotSession.data`.
2. **Admin display is unchanged.** The server decrypts when an admin opens an
   order, as it does today. No mask or reveal step. Role gating stays as it is
   (`readonly` is already blocked from these reads).
3. **Not in scope, accepted:** `FulfillmentMessage.lastText` (the receipt text
   with Game ID / Zone / Server, already delivered to the buyer's Telegram
   chat).

## Non-goals

- Per-field sensitivity flags or masking in the UI.
- Key rotation beyond what `credentialCrypto` already supports.
- Data that must leave the system in plain text: the `customer_no` sent to the
  Digiflazz API, and text sent to Telegram.
- Changing `Order.inputConfigSnapshot`, `Denomination.additionalFields` or
  `providerInputMapping`. They hold only the field specification, not answers.
- Any schema change. The column is already TEXT.

## Approach

A **single decrypting read path** in the DB layer, encryption at the write
sites, a guard test that fails when other code reads the raw column. Rejected:
a Prisma extension that encrypts and decrypts transparently, because it
collides with the raw readers the order state machine depends on
(`getOrderRaw`, `updateMany` with status guards) and hides where plain text
exists.

### 1. Format and key

Reuse `packages/core/src/credentialCrypto.ts`: AES-256-GCM envelope
`{keyVersion, iv, ciphertext, authTag}`, key from `CREDENTIAL_ENCRYPTION_KEY`.
Add, next to the `deliveredContent` helpers:

- `customerDataAad(orderId)` = `orders.customer_data:{orderId}`
- `botSessionAad(sessionKey)` = `bot_sessions.data:{sessionKey}`
- `encryptCustomerData(plaintext, orderId?)`, `decryptCustomerData(stored,
  orderId)` (throws, for fulfillment) and `tryDecryptCustomerData` (display:
  `null` plus a warning that names the order id, never the content).

Plain text and envelope cannot be confused: valid plain text is a JSON
**array**, an envelope is a JSON **object**. `decryptCredentials` already
passes a non-envelope value through as legacy plain text while
`ALLOW_LEGACY_PLAINTEXT` is true, and throws `LegacyPlaintextCredentialError`
when it is false.

**The id does not exist at insert.** `createOrderFromCart` and
`createOrderDirect` write the column inside `db.order.create`. At those two
sites the value is written as a **v1 envelope (no AAD) regardless of
`CREDENTIAL_ENVELOPE_WRITE_V2`**, and v1 must decrypt without an AAD.
`updateOrderCustomerData` knows the id and uses the flag like the other
columns. `scripts/reencrypt-credentials-v2.ts` gains this column so a later
v2 rollout binds every value to its row. (The implementation plan must verify
the exact writer behaviour when the flag is on and no AAD is supplied.)

### 2. Write sites

Encrypt after the existing `validateCustomerData` / `JSON.stringify`, before
persisting:

- `createOrderFromCart` (`packages/db/src/crud/orders.ts` ~975)
- `createOrderDirect` (~1292)
- `updateOrderCustomerData` (~3512), keeping its status guard
  (`PROCESSING`, not dispatched / `NEEDS_REVIEW`) and the Digiflazz claim
  ordering (the dispatcher re-reads `customerData` after the claim, so an edit
  that won the lock is honoured; encryption must not change that order).

Forwarders that pass the JSON string through (`wallet_checkout.ts`,
`binance_internal.ts`, `bybit_deposit.ts`, `bybit_bsc_deposit.ts`, storefront
`checkout.ts`, `api.ts`, `apiTopup.ts`, bot `checkout.ts`) are **not** changed:
they hand plain JSON to the `crud/orders.ts` functions, which encrypt.

### 3. Read path

One accessor in `crud/orders.ts`:

- `readOrderCustomerData(order)` returns the plaintext JSON string or `null`;
  throws on a bad envelope, a wrong key or a missing key.
- `tryReadOrderCustomerData(order)` returns `null` and logs a warning.

`parseCustomerData`, `buildDigiflazzCustomerNo`, `orderGameTargets` and
`computeAccountDiagnosticNote` keep taking a plaintext string, so
`packages/core` stays free of DB concerns. Their **callers** decrypt first:

| Reader | Variant |
|---|---|
| `digiflazz.ts` poller (~969), `fulfillDigiflazzOrder` post-claim re-read (~1659), `computeAccountDiagnosticNote` (~1167) | throwing |
| storefront `checkout.ts` Digiflazz callback re-verification (~1822) | throwing |
| admin order detail (`orders.ts` ~255) | try |
| buyer order detail (`apiAccount.ts` ~291/297), pay page (`apiCheckout.ts` ~124), `gameTopupDetails.ts` | try |
| `fulfillmentMessages.ts` (~55) | try (already inside try/catch) |
| bot buyer order detail (`handlers/customer.ts` ~2561), `editCustomerInfo.ts` (~106) | try |

Failure behaviour:

- **Fulfillment (Digiflazz):** a decrypt error is thrown, the existing catch
  turns it into "needs manual review", and nothing is sent to the supplier. An
  empty target is never dispatched.
- **Display:** the answers render as empty and a warning is logged. No page
  crashes.
- `parseCustomerData` throws `EncryptedCustomerDataError` when it is handed an
  envelope instead of returning `[]`. Today it returns `[]` silently, which
  would show an empty admin panel or build an empty supplier target. A reader
  that was missed now fails loudly in tests.

### 4. Never send ciphertext to the browser

These routes spread the whole order row, so the raw column currently reaches
the client:

- admin `GET /api/orders` for non-readonly roles (`{...o}`, `routes/api/orders.ts`
  ~172-198) and `/api/payments` (UNDERPAID list via `listOrders`)
- admin `GET /api/orders/:orderId` (`...masked`, ~261)
- `getTicketWithOrder` (`packages/db/src/crud/support.ts:121-131`)

The raw `customerData` property is removed from those responses (a
`withoutCustomerData` next to `withoutDeliveredContent`). The detail route
already returns the parsed `customerData` array and `customerDataFields`, so
the admin UI does not change. The readonly allow-lists
(`readonlyOrders.ts`) never included the column.

### 5. Bot sessions

`apps/order-bot/src/util/prismaSessionStorage.ts` encrypts the whole
`JSON.stringify(value)` in `write` and decrypts in `read`, with
`botSessionAad(key)`. This covers `scratch.customerData` and the conversation
plugin's persisted `wait()` messages. A session written before the deploy is
plain text, is read through the legacy path and disappears within 24 h. A
session that cannot be decrypted is treated as no session (the buyer restarts
the flow), never as a crash, and never logs content.

### 6. Backfill of existing orders

`scripts/backfill-encrypt-customer-data.ts` plus a `pnpm
backfill-encrypt-customer-data` entry, copying
`backfill-encrypt-delivered-content.ts`:

- pages by id, 500 rows; skips `null`;
- `isEncryptedCredentialEnvelope` and a successful decrypt count as already
  encrypted; an envelope that fails to decrypt counts as corrupt and is left
  alone (a missing key aborts);
- plaintext is replaced with a compare-and-set
  `updateMany({where: {id, customerData: stored}})`, so a concurrent buyer
  edit is never overwritten (`changedDuringRun` is counted);
- `--dry-run`; prints counts only, never values; safe to re-run.

`BotSession` needs no backfill (short-lived).

### 7. Guard test

`tests/customer-data-guard.test.ts` (next to `tests/no-fake-claims.test.ts`;
AST, not regex, following `apps/order-bot/test/money-input-guard.test.ts`;
added to `test:guards`, no database setup). It fails when non-test source outside an explicit allow-list reads the
`customerData` property of an `Order` row. The allow-list is the accessor
module and the three write sites. Bot `scratch.customerData` is a different
object and is not flagged.

## Tests

- `credentialCrypto`: round-trip, v1 without AAD, v2 with AAD, wrong order id
  fails, missing key, tampered envelope, legacy plain text with the flag on and
  off, `EncryptedCustomerDataError`.
- `crud/orders`: create (cart and direct) stores an envelope, never the plain
  answers; `updateOrderCustomerData` re-encrypts and keeps its status guard;
  concurrent edit versus claim ordering.
- Digiflazz: the `customer_no` sent to the supplier is identical before and
  after for both an encrypted and a legacy plain order; a corrupt envelope
  routes to manual review and sends nothing.
- Admin routes: list, detail and ticket responses contain no `customerData`
  string and the parsed array is unchanged; `readonly` unchanged.
- Storefront and bot: buyer order detail, edit flow, pay page, receipt.
- Bot sessions: round-trip, legacy plain session, undecryptable session.
- Backfill: dry run, plaintext to envelope, idempotent re-run, corrupt row left
  alone, concurrent change.
- Guard test, plus a run with `ALLOW_LEGACY_PLAINTEXT=false` over the touched
  suites.
- About 50 existing test files mention `customerData`. Most write plain JSON
  straight into the column, which still reads through the legacy path. Only
  tests that assert on the raw column are rewritten to read through the
  accessor. `pnpm test:envelope-v2` is run for the new code to avoid adding to
  its known failures.
- Premium Apps and Game Top Up are both covered wherever a shared surface is
  touched.

## Deploy and rollback

1. `CREDENTIAL_ENCRYPTION_KEY` is set (all four processes already refuse to
   boot without it).
2. Deploy the code. It reads both plain text and envelopes. Nothing is
   encrypted yet except new orders and new bot sessions.
3. Run `pnpm backfill-encrypt-customer-data --dry-run`, then for real, until it
   reports `plaintext = 0` and `corrupt = 0`.
4. Only after **all four** backfills (stock credentials, delivered content,
   settings secrets, customer data) report zero, set
   `ALLOW_LEGACY_PLAINTEXT=false`.
5. `.env.example` and `DOCS.md` ("Checklist rollout") list the fourth
   backfill.

**Rollback warning.** Once any order is encrypted (new orders are, from step
2), the previous code reads an envelope as "no answers". Rolling back is only
safe to a version that still decrypts. Do not roll back past this change after
step 2.

The bot sessions have their own rollback trap: the previous
`prismaSessionStorage.read()` does `JSON.parse(raw)`, which succeeds on an
envelope and returns the envelope object as the session (not "no session").
Before any rollback past this change, run `DELETE FROM bot_sessions;`. That
loses only in-progress navigation and checkout state, which buyers restart in
seconds. `DOCS.md` carries the same instruction.

## Honest limits

This protects against a database leak, a backup dump or a read-only SQL
injection. It does not protect against an attacker who controls the
application server, because the key lives in that process's environment. It
does not remove plain text that must exist elsewhere: the supplier request,
Telegram messages, and the receipt text in `FulfillmentMessage.lastText`. It
reduces risk; it does not guarantee the site cannot be breached.

## Files expected to change

- `packages/core/src/credentialCrypto.ts`, `deliveryFields.ts`
- `packages/db/src/crud/orders.ts`, `digiflazz.ts`, `support.ts`
- `apps/storefront/src/routes/checkout.ts`, `apiAccount.ts`, `apiCheckout.ts`,
  `gameTopupDetails.ts`
- `apps/web-admin/src/routes/api/orders.ts` (and the `/api/payments` list path)
- `packages/outbox-dispatcher/src/fulfillmentMessages.ts`
- `apps/order-bot/src/handlers/customer.ts`,
  `conversations/editCustomerInfo.ts`, `util/prismaSessionStorage.ts`
- new: `scripts/backfill-encrypt-customer-data.ts` (+ test), guard test,
  `package.json` script, `scripts/reencrypt-credentials-v2.ts`, `.env.example`,
  `DOCS.md`
- tests in the files listed above
