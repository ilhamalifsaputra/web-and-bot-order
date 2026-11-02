# Encrypt buyer-submitted answers at rest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Order.customerData` and `BotSession.data` are stored as AES-256-GCM envelopes instead of plain text, with every reader decrypting through one of a few known paths and existing orders migrated by a backfill.

**Architecture:** Reuse `packages/core/src/credentialCrypto.ts` (envelope, key, legacy-plaintext rules). Encrypt at the three order write sites and in the bot session adapter. Decrypt in the existing `getOrder` / `getOrderByCodeFull` / `getOrderByCodeFullForDisplay` choke points, and explicitly at the six places that read a raw row. Strip the column from list/ticket responses. An AST guard test fails when new code passes `order.customerData` to a reader without decrypting.

**Tech Stack:** TypeScript, Prisma (PostgreSQL, TEXT column, **no schema change**), Vitest, grammY, Fastify.

**Spec:** `docs/superpowers/specs/2026-11-02-customer-data-encryption-design.md` (read it first).

## Global Constraints

- **No schema change.** `Order.customerData` stays `String?` TEXT; `BotSession.data` stays `String`.
- Key: env `CREDENTIAL_ENCRYPTION_KEY` (64 hex chars). Algorithm AES-256-GCM via `encryptCredentials` / `decryptCredentials`. Vitest already sets a test key (`vitest.config.ts`).
- AAD strings are part of the stored data's key and must be exactly: `orders.customer_data:{orderId}` and `bot_sessions.data:{sessionKey}`.
- (Superseded by the whole-branch review, see the note under Task 1.) At order **INSERT** the id does not exist: write a **v1 envelope (no AAD) regardless of `CREDENTIAL_ENVELOPE_WRITE_V2`**; v1 decrypts without a context. `updateOrderCustomerData` (id known) follows the flag.
- A plaintext value is a JSON **array** (`[{"game_id":"123"}]`); an envelope is a JSON **object**. Legacy plaintext passes through `decryptCredentials` while `ALLOW_LEGACY_PLAINTEXT` is not false, and throws `LegacyPlaintextCredentialError` when it is false.
- Fulfillment paths **throw** on an unreadable value (the order goes to "needs manual review"; nothing is ever sent to the supplier with an empty target). Display paths return `null` plus a warning that names the order id, never the content.
- `parseCustomerData` lives in `packages/core/src/deliveryFields.ts`, which is **bundled into the browser clients**: it must NOT import `credentialCrypto` (Node `crypto`). Envelope detection there is inline.
- Never log answers, ciphertext, or a context string. Warnings carry only `orderId` and the error class name.
- Never decrypt a value twice: the choke points return plaintext, so callers of `getOrder` / `getOrderByCodeFull` / `getOrderByCodeFullForDisplay` must NOT decrypt again (it would throw when `ALLOW_LEGACY_PLAINTEXT=false`). Only readers of raw rows decrypt.
- Premium Apps and Game Top Up both store answers in this column in the same shape; every task's tests must not assume one family.
- Money, audit and logging rules in `AGENTS.md` apply. No raw SQL in routes. Pino messages are full English sentences.
- Tests: run only the touched files with `pnpm exec vitest run <path> --maxWorkers=2`; typecheck the package you touched (`pnpm --filter <pkg> typecheck`); never run the full suite inside a task. `pnpm --filter <pkg> test` runs nothing in this repo.
- Stage files by exact name (never `git add -A`, `-a` or `.`). `graphify-out/` noise must not be committed. Never `git stash`, `git reset --hard`, or switch branch.
- Commit message ends with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- If a step needs a schema change, a money-flow behaviour change or a product decision, STOP and report BLOCKED.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/credentialCrypto.ts` | AAD helpers, `encryptCustomerData*`, `decryptCustomerData`, `tryDecryptCustomerData`, bot-session wrappers, `forceV1` option |
| `packages/core/src/deliveryFields.ts` | `EncryptedCustomerDataError`; `parseCustomerData` throws on an envelope |
| `packages/db/src/crud/orders.ts` | encrypt at 3 write sites; decrypt in the two choke-point wrappers; `withoutDeliveredContent` also drops `customerData` |
| `packages/db/src/crud/digiflazz.ts` | decrypt at 3 raw reads |
| `apps/storefront/src/routes/checkout.ts`, `apiCheckout.ts` | decrypt at 2 raw reads |
| `packages/outbox-dispatcher/src/fulfillmentMessages.ts` | decrypt at 1 raw read |
| `apps/order-bot/src/util/prismaSessionStorage.ts` | encrypt/decrypt the session blob |
| `scripts/backfill-encrypt-customer-data.ts` | backfill of existing orders |
| `scripts/reencrypt-credentials-v2.ts` | new column added |
| `tests/customer-data-guard.test.ts` | AST guard |

---

### Task 0: Worktree runtime setup (controller, before any subagent)

A fresh worktree has no `.env`, no generated client, no build and no database. Do this once.

- [ ] **Step 1: Copy `.env` and pick isolated ports/DB**

From the worktree root (`C:\Users\ilham\Documents\web-and-bot-order\.claude\worktrees\customerdata-encryption`):

```bash
cp ../../../.env .env
grep -n -E '^(POSTGRES_|DATABASE_URL_PRISMA|WEB_PORT|STOREFRONT_PORT)' .env | sed -E 's/(PASSWORD=|:\/\/[^@]*@).*/\1…/'
```

Edit `.env` in the worktree: `WEB_PORT=8329`, `STOREFRONT_PORT=8330`, `POSTGRES_PORT=5611`, and point `DATABASE_URL_PRISMA` at `localhost:5611` (same user/password/db name, only the port changes). Ports already in use by other worktrees: 5433, 5441, 5545, 5561, 5571, 5591, 5602.

- [ ] **Step 2: Start this worktree's Postgres (Docker Desktop must be running)**

```bash
docker compose -f docker-compose.postgres.yml up -d
until [ "$(docker inspect -f '{{.State.Health.Status}}' customerdata-encryption-postgres-1)" = healthy ]; do sleep 2; done; echo healthy
```

- [ ] **Step 3: Install, generate, build, push schema**

```bash
CI=true pnpm install
pnpm prisma:generate
pnpm -r build
pnpm exec prisma db push --skip-generate
```

Expected: build exits 0; `db push` says the database is in sync. (`packages/db/src/crud/integrity.test.ts` needs the `public` schema tables, which this creates.)

- [ ] **Step 4: Baseline the three suites this plan touches**

```bash
pnpm exec vitest run packages/core/src/credentialCrypto.test.ts packages/db/src/crud/orders.test.ts scripts/backfill-encrypt-delivered-content.test.ts --maxWorkers=2
```

Expected: all pass. Record the counts in the task report.

---

### Task 1: Crypto primitives and `EncryptedCustomerDataError`

> **Superseded by the whole-branch review:** the v1-at-INSERT wording (`encryptCustomerDataForInsert`, `forceV1`) no longer holds. New orders are created with `customerData: null` and encrypted with `encryptCustomerData(…, order.id)` in the same transaction's final-totals update; `forceV1` and `encryptCustomerDataForInsert` were removed.

**Files:**
- Modify: `packages/core/src/credentialCrypto.ts` (`encryptCredentials` ~line 189; new helpers after the `deliveredContent` section, ~line 387)
- Modify: `packages/core/src/deliveryFields.ts` (`parseCustomerData`, ~line 87)
- Test: `packages/core/src/credentialCrypto.test.ts` (append), create `packages/core/src/customerData.test.ts`

**Interfaces:**
- Produces (from `@app/core/credentialCrypto`):
  - `customerDataAad(orderId: number): string`
  - `botSessionAad(sessionKey: string): string`
  - `encryptCustomerData(plaintext: string, orderId: number): string`
  - `encryptCustomerDataForInsert(plaintext: string): string` (always v1)
  - `decryptCustomerData(stored: string | null, orderId: number): string | null` (throws)
  - `tryDecryptCustomerData(stored: string | null, ctx: { orderId: number; purpose: string }): string | null`
  - `encryptBotSession(plaintext: string, sessionKey: string): string`
  - `decryptBotSession(stored: string, sessionKey: string): string`
  - `encryptCredentials(plaintext, aad, opts?: { forceV1?: boolean })`
- Produces (from `@app/core/deliveryFields`): `class EncryptedCustomerDataError extends Error`, and `parseCustomerData` that throws it for an envelope.

- [ ] **Step 1: Write the failing tests for `parseCustomerData`**

Create `packages/core/src/customerData.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EncryptedCustomerDataError, parseCustomerData } from "./deliveryFields";

const ENVELOPE = JSON.stringify({ keyVersion: 1, iv: "aXY=", ciphertext: "Y3Q=", authTag: "dGFn" });

describe("parseCustomerData", () => {
  it("parses stored plaintext answers", () => {
    expect(parseCustomerData('[{"game_id":"12345","zone":"7"}]')).toEqual([{ game_id: "12345", zone: "7" }]);
  });

  it("returns [] for null, blank, invalid JSON and the wrong shape", () => {
    expect(parseCustomerData(null)).toEqual([]);
    expect(parseCustomerData("")).toEqual([]);
    expect(parseCustomerData("not json")).toEqual([]);
    expect(parseCustomerData('{"a":"b"}')).toEqual([]);
    expect(parseCustomerData('[1,2]')).toEqual([]);
  });

  it("throws EncryptedCustomerDataError for an encrypted envelope instead of returning []", () => {
    expect(() => parseCustomerData(ENVELOPE)).toThrow(EncryptedCustomerDataError);
  });

  it("does not mistake an ordinary object that lacks the envelope fields for an envelope", () => {
    expect(parseCustomerData(JSON.stringify({ keyVersion: 1, iv: "x" }))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run packages/core/src/customerData.test.ts --maxWorkers=2`
Expected: FAIL — `EncryptedCustomerDataError` is not exported.

- [ ] **Step 3: Implement in `deliveryFields.ts`**

Replace the existing `parseCustomerData` with:

```ts
/** Thrown by parseCustomerData when it is handed an encrypted envelope: the
 * caller forgot to decrypt first. Returning [] there would show an empty admin
 * panel or build an empty supplier target without any error. */
export class EncryptedCustomerDataError extends Error {
  constructor() {
    super(
      "Order.customerData is an encrypted envelope; decrypt it with decryptCustomerData (or read the order through getOrder) before parsing it.",
    );
    this.name = "EncryptedCustomerDataError";
  }
}

/** Structural envelope check, inline on purpose: this module is bundled into
 * the browser clients and must not import the Node-only credentialCrypto. */
function looksLikeEncryptedEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.keyVersion === "number" &&
    typeof v.iv === "string" &&
    typeof v.ciphertext === "string" &&
    typeof v.authTag === "string"
  );
}

/** Parse stored buyer answers (already decrypted); returns [] on null/blank/invalid.
 * Throws EncryptedCustomerDataError when given an encrypted envelope. */
export function parseCustomerData(json: string | null | undefined): CustomerData {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (looksLikeEncryptedEnvelope(raw)) throw new EncryptedCustomerDataError();
  const parsed = zCustomerData.safeParse(raw);
  return parsed.success ? parsed.data : [];
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm exec vitest run packages/core/src/customerData.test.ts --maxWorkers=2`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing tests for the crypto helpers**

Append to `packages/core/src/credentialCrypto.test.ts` (extend the existing import list with `customerDataAad`, `botSessionAad`, `encryptCustomerData`, `encryptCustomerDataForInsert`, `decryptCustomerData`, `tryDecryptCustomerData`, `encryptBotSession`, `decryptBotSession`):

```ts
describe("Order.customerData and BotSession helpers", () => {
  const ANSWERS = '[{"game_id":"12345","zone":"7"}]';
  const ORIGINAL_WRITE_FLAG = process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
  const ORIGINAL_LEGACY_FLAG = process.env.ALLOW_LEGACY_PLAINTEXT;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    delete process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
    delete process.env.ALLOW_LEGACY_PLAINTEXT;
  });
  afterEach(() => {
    warn.mockRestore();
    if (ORIGINAL_WRITE_FLAG === undefined) delete process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
    else process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = ORIGINAL_WRITE_FLAG;
    if (ORIGINAL_LEGACY_FLAG === undefined) delete process.env.ALLOW_LEGACY_PLAINTEXT;
    else process.env.ALLOW_LEGACY_PLAINTEXT = ORIGINAL_LEGACY_FLAG;
  });

  it("context strings are exactly the documented ones (changing one orphans every v2 value)", () => {
    expect(customerDataAad(42)).toBe("orders.customer_data:42");
    expect(botSessionAad("chat-1")).toBe("bot_sessions.data:chat-1");
    expect(() => customerDataAad(0)).toThrow(CredentialEnvelopeError);
    expect(() => botSessionAad("")).toThrow(CredentialEnvelopeError);
  });

  it("round-trips as a v1 envelope while the write flag is off, and never stores the answers", () => {
    const stored = encryptCustomerData(ANSWERS, 7);
    expect(credentialEnvelopeVersion(stored)).toBe(1);
    expect(stored).not.toContain("12345");
    expect(decryptCustomerData(stored, 7)).toBe(ANSWERS);
  });

  it("with the write flag on, an update envelope is v2 and bound to its own order", () => {
    process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = "true";
    const stored = encryptCustomerData(ANSWERS, 7);
    expect(credentialEnvelopeVersion(stored)).toBe(2);
    expect(decryptCustomerData(stored, 7)).toBe(ANSWERS);
    expect(() => decryptCustomerData(stored, 8)).toThrow(CredentialEnvelopeError);
  });

  it("the INSERT variant is v1 even with the write flag on, and decrypts under any order id", () => {
    process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = "true";
    const stored = encryptCustomerDataForInsert(ANSWERS);
    expect(credentialEnvelopeVersion(stored)).toBe(1);
    expect(decryptCustomerData(stored, 999)).toBe(ANSWERS);
  });

  it("null stays null", () => {
    expect(decryptCustomerData(null, 1)).toBeNull();
    expect(tryDecryptCustomerData(null, { orderId: 1, purpose: "test" })).toBeNull();
  });

  it("a legacy plaintext array passes through while the flag is on and throws when it is off", () => {
    expect(decryptCustomerData(ANSWERS, 7)).toBe(ANSWERS);
    process.env.ALLOW_LEGACY_PLAINTEXT = "false";
    expect(() => decryptCustomerData(ANSWERS, 7)).toThrow(LegacyPlaintextCredentialError);
  });

  it("a tampered envelope throws for delivery and becomes null plus a warning without content for display", () => {
    const good = JSON.parse(encryptCustomerData(ANSWERS, 7)) as Record<string, unknown>;
    const tampered = JSON.stringify({ ...good, authTag: Buffer.alloc(16).toString("base64") });
    expect(() => decryptCustomerData(tampered, 7)).toThrow();
    expect(tryDecryptCustomerData(tampered, { orderId: 7, purpose: "a test page" })).toBeNull();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("7");
    expect(logged).not.toContain("12345");
  });

  it("a missing key is not swallowed by the display variant", () => {
    const stored = encryptCustomerData(ANSWERS, 7);
    const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    try {
      expect(() => tryDecryptCustomerData(stored, { orderId: 7, purpose: "test" })).toThrow(CredentialKeyConfigError);
    } finally {
      if (key === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CREDENTIAL_ENCRYPTION_KEY = key;
    }
  });

  it("bot sessions round-trip bound to their key", () => {
    const stored = encryptBotSession('{"scratch":{"customerData":"[{\\"game_id\\":\\"12345\\"}]"}}', "chat-1");
    expect(isEncryptedCredentialEnvelope(stored)).toBe(true);
    expect(stored).not.toContain("12345");
    expect(decryptBotSession(stored, "chat-1")).toContain("12345");
  });
});
```

- [ ] **Step 6: Run and confirm failure**

Run: `pnpm exec vitest run packages/core/src/credentialCrypto.test.ts --maxWorkers=2`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 7: Implement in `credentialCrypto.ts`**

(a) Change `encryptCredentials` to take the option:

```ts
export function encryptCredentials(plaintext: string, aad: string, opts: { forceV1?: boolean } = {}): string {
  if (!aad) throw new CredentialEnvelopeError("encryptCredentials needs a non-empty context (AAD).");
  const version = opts.forceV1 ? 1 : credentialEnvelopeWriteVersion();
```

(keep the rest of the function unchanged) and add `forceV1` to its doc comment: "`forceV1` writes a v1 envelope whatever the flag says, for a row whose id does not exist yet."

(b) Add next to `deliveredContentAad` (~line 146):

```ts
/** AAD for Order.customerData of one order. */
export function customerDataAad(orderId: number): string {
  return `orders.customer_data:${rowId(orderId)}`;
}

/** AAD for the whole serialized BotSession.data of one session key. */
export function botSessionAad(sessionKey: string): string {
  if (sessionKey === "") throw new CredentialEnvelopeError("A bot session credential context needs a non-empty key.");
  return `bot_sessions.data:${sessionKey}`;
}
```

(c) Append after `tryDecryptDeliveredContent` (~line 387):

```ts
// ── Order.customerData and BotSession.data ─────────────────────────────────
// The buyer's answers to a product's additional fields (Game ID / Zone / Server,
// an account e-mail, free text an admin may have labelled "Password"). Same
// envelope, key and legacy-plaintext rules as the columns above; a row written
// before this change stays plaintext until scripts/backfill-encrypt-customer-data.ts
// rewrites it.

/** An UPDATE of an existing order's answers (the id is known, so a v2 envelope binds to it). */
export function encryptCustomerData(plaintext: string, orderId: number): string {
  return encryptCredentials(plaintext, customerDataAad(orderId));
}

/** The INSERT of a new order: its id does not exist yet, so the value is a v1
 * envelope (no AAD) whatever CREDENTIAL_ENVELOPE_WRITE_V2 says. v1 decrypts
 * without a context, and scripts/reencrypt-credentials-v2.ts binds it later. */
export function encryptCustomerDataForInsert(plaintext: string): string {
  return encryptCredentials(plaintext, "orders.customer_data:insert", { forceV1: true });
}

/** Fulfillment-path read: throws on an unreadable value so nothing is sent to a
 * supplier with an empty target. Null means the order carries no answers. */
export function decryptCustomerData(stored: string | null, orderId: number): string | null {
  return stored === null ? null : decryptCredentials(stored, customerDataAad(orderId));
}

/** DISPLAY-ONLY twin: an unreadable value becomes null plus a warning that
 * names the order and the error class, never the content. */
export function tryDecryptCustomerData(
  stored: string | null,
  ctx: { orderId: number; purpose: string },
): string | null {
  if (stored === null) return null;
  try {
    return decryptCustomerData(stored, ctx.orderId);
  } catch (err) {
    if (err instanceof CredentialKeyConfigError) throw err;
    logger.warn(
      { orderId: ctx.orderId, errorName: err instanceof Error ? err.name : typeof err },
      `Could not decrypt the buyer's answers of order ${ctx.orderId} for ${ctx.purpose}; they are shown as empty there. They are corrupted, tampered with, or were encrypted under a different key.`,
    );
    return null;
  }
}

/** The grammY session JSON of one chat (contains in-flight checkout answers). */
export function encryptBotSession(plaintext: string, sessionKey: string): string {
  return encryptCredentials(plaintext, botSessionAad(sessionKey));
}

export function decryptBotSession(stored: string, sessionKey: string): string {
  return decryptCredentials(stored, botSessionAad(sessionKey));
}
```

- [ ] **Step 8: Run and confirm everything passes**

Run: `pnpm exec vitest run packages/core/src/credentialCrypto.test.ts packages/core/src/customerData.test.ts --maxWorkers=2 && pnpm --filter @app/core typecheck`
Expected: all pass; typecheck clean. (The existing `encryptCredentials` callers pass two arguments and are unaffected.)

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/credentialCrypto.ts packages/core/src/deliveryFields.ts packages/core/src/credentialCrypto.test.ts packages/core/src/customerData.test.ts
git commit -m "feat(core): encrypt and decrypt helpers for buyer answers and bot sessions

parseCustomerData now throws on an encrypted envelope instead of returning [].

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Order write sites and the two decrypting choke points

> **Superseded by the whole-branch review:** the v1-at-INSERT wording (`encryptCustomerDataForInsert`, `forceV1`) no longer holds. New orders are created with `customerData: null` and encrypted with `encryptCustomerData(…, order.id)` in the same transaction's final-totals update; `forceV1` and `encryptCustomerDataForInsert` were removed.

**Files:**
- Modify: `packages/db/src/crud/orders.ts` (imports ~line 58; `withDecryptedStockCredentials` ~620; `StockCredentialsOrder` ~721; `withDisplayStockCredentials` ~734; create sites ~975 and ~1292; `updateOrderCustomerData` ~3512)
- Test: `packages/db/src/crud/orders.test.ts` (append a describe block)

**Interfaces:**
- Consumes (Task 1): `encryptCustomerData`, `encryptCustomerDataForInsert`, `decryptCustomerData`, `tryDecryptCustomerData`.
- Produces: `getOrder`, `getOrderByCodeFull` return `customerData` as **plaintext**; `getOrderByCodeFullForDisplay` returns plaintext or `null`; `getOrderRaw`, `getOrderByCode` and bare `db.order.find*` return the stored envelope.

- [ ] **Step 1: Write the failing tests**

Append to `packages/db/src/crud/orders.test.ts`. Extend the file's existing import from `"./orders"` with `getOrder, getOrderRaw, getOrderByCodeFullForDisplay, updateOrderCustomerData` (add any that are missing) and add `import { isEncryptedCredentialEnvelope, credentialEnvelopeVersion, decryptCustomerData } from "@app/core/credentialCrypto";`.

```ts
describe("Order.customerData is encrypted at rest", () => {
  let sample: SampleData;

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
  });

  const ANSWERS = JSON.stringify([{ game_id: "12345" }]);

  async function infoDenomination(name: string) {
    const category = await createCategory(prisma, `cat-${Math.random()}`);
    const catalogProduct = await createCatalogProduct(prisma, { categoryId: category.id, name });
    const fields = [
      { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
    ];
    return createDenomination(prisma, {
      productId: catalogProduct.id,
      name: `${name} Denom`,
      type: "SHARED",
      durationLabel: "1 Month",
      price: "5.00",
      deliveryType: "manual_with_info",
      additionalFields: JSON.stringify(fields),
    });
  }

  const rawCustomerData = async (orderId: number) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerData: true } })).customerData;

  async function directOrder(name: string) {
    const denom = await infoDenomination(name);
    return (await createOrderDirect(prisma, {
      channel: "bot", user: sample.user, productId: denom.id, quantity: 1, customerData: ANSWERS,
    }))!;
  }

  it("createOrderFromCart stores an envelope, never the answers, and getOrder reads them back", async () => {
    const denom = await infoDenomination("Cart Info");
    await addToCart(prisma, sample.user.id, denom.id, 1);

    const order = await createOrderFromCart(prisma, { channel: "bot", user: sample.user, customerData: ANSWERS });

    const stored = await rawCustomerData(order!.id);
    expect(isEncryptedCredentialEnvelope(stored!)).toBe(true);
    expect(stored).not.toContain("12345");
    expect(order!.customerData).toBe(ANSWERS);
    expect((await getOrder(prisma, order!.id))!.customerData).toBe(ANSWERS);
  });

  it("createOrderDirect stores an envelope, never the answers, and getOrder reads them back", async () => {
    const order = await directOrder("Direct Info");

    const stored = await rawCustomerData(order.id);
    expect(isEncryptedCredentialEnvelope(stored!)).toBe(true);
    expect(stored).not.toContain("12345");
    expect((await getOrder(prisma, order.id))!.customerData).toBe(ANSWERS);
  });

  it("writes a v1 envelope at INSERT even when CREDENTIAL_ENVELOPE_WRITE_V2 is on (the id does not exist yet)", async () => {
    const saved = process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
    process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = "true";
    try {
      const order = await directOrder("Flag On Info");
      expect(credentialEnvelopeVersion((await rawCustomerData(order.id))!)).toBe(1);
      expect((await getOrder(prisma, order.id))!.customerData).toBe(ANSWERS);
    } finally {
      if (saved === undefined) delete process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
      else process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = saved;
    }
  });

  it("an order without answers keeps customerData null", async () => {
    const order = await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 });
    expect(await rawCustomerData(order!.id)).toBeNull();
    expect((await getOrder(prisma, order!.id))!.customerData).toBeNull();
  });

  it("updateOrderCustomerData stores a fresh envelope for the new answers", async () => {
    const order = await directOrder("Edit Info");
    await prisma.order.update({ where: { id: order.id }, data: { status: "PROCESSING" } });
    const next = [{ game_id: "99999" }];

    await updateOrderCustomerData(prisma, order.id, next);

    const stored = await rawCustomerData(order.id);
    expect(isEncryptedCredentialEnvelope(stored!)).toBe(true);
    expect(stored).not.toContain("99999");
    expect(JSON.parse((await getOrder(prisma, order.id))!.customerData!)).toEqual(next);
  });

  it("with the write flag on, an edit is bound to its own order (v2)", async () => {
    const saved = process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
    process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = "true";
    try {
      const order = await directOrder("Edit V2 Info");
      await prisma.order.update({ where: { id: order.id }, data: { status: "PROCESSING" } });
      const next = [{ game_id: "99999" }];
      await updateOrderCustomerData(prisma, order.id, next);

      const stored = (await rawCustomerData(order.id))!;
      expect(credentialEnvelopeVersion(stored)).toBe(2);
      expect(decryptCustomerData(stored, order.id)).toBe(JSON.stringify(next));
      expect(() => decryptCustomerData(stored, order.id + 1)).toThrow();
    } finally {
      if (saved === undefined) delete process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
      else process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = saved;
    }
  });

  it("raw readers return the stored envelope and the display reader returns plaintext", async () => {
    const order = await directOrder("Readers Info");

    expect(isEncryptedCredentialEnvelope((await getOrderRaw(prisma, order.id))!.customerData!)).toBe(true);
    const display = await getOrderByCodeFullForDisplay(prisma, order.orderCode);
    expect(display!.customerData).toBe(ANSWERS);
  });

  it("a legacy plaintext row is still readable through getOrder", async () => {
    const order = await directOrder("Legacy Info");
    await prisma.order.update({ where: { id: order.id }, data: { customerData: ANSWERS } });

    expect((await getOrder(prisma, order.id))!.customerData).toBe(ANSWERS);
  });

  it("an unreadable envelope throws from getOrder (a delivery must not run on empty answers) and is null for display", async () => {
    const order = await directOrder("Corrupt Info");
    const good = JSON.parse((await rawCustomerData(order.id))!) as Record<string, unknown>;
    await prisma.order.update({
      where: { id: order.id },
      data: { customerData: JSON.stringify({ ...good, authTag: Buffer.alloc(16).toString("base64") }) },
    });

    await expect(getOrder(prisma, order.id)).rejects.toThrow();
    const display = await getOrderByCodeFullForDisplay(prisma, order.orderCode);
    expect(display!.customerData).toBeNull();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run packages/db/src/crud/orders.test.ts -t "encrypted at rest" --maxWorkers=2`
Expected: FAIL — the stored column is plaintext (`isEncryptedCredentialEnvelope` false).

- [ ] **Step 3: Implement — imports**

In `orders.ts`, add to the existing `@app/core/credentialCrypto` import (~line 58-60): `encryptCustomerData, encryptCustomerDataForInsert, decryptCustomerData, tryDecryptCustomerData,`.

- [ ] **Step 4: Implement — the three write sites**

At the two `db.order.create` sites (~975 and ~1292) replace `customerData: customerDataToStore,` with:

```ts
        customerData: customerDataToStore ? encryptCustomerDataForInsert(customerDataToStore) : customerDataToStore,
```

In `updateOrderCustomerData` (~3512) replace the `data` line with:

```ts
    data: { customerData: encryptCustomerData(JSON.stringify(normalized), orderId) },
```

- [ ] **Step 5: Implement — the choke points**

`withDecryptedStockCredentials` (~620): add `customerData: string | null;` to the generic constraint and the decrypted field:

```ts
function withDecryptedStockCredentials<
  T extends {
    id: number;
    deliveredContent: string | null;
    customerData: string | null;
    items: Array<{ stockItem: { id: number; credentials: string } | null }>;
  },
>(order: T): T {
  return {
    ...order,
    deliveredContent: decryptDeliveredContent(order.deliveredContent, order.id),
    customerData: decryptCustomerData(order.customerData, order.id),
    items: order.items.map((item) =>
      item.stockItem
        ? {
            ...item,
            stockItem: { ...item.stockItem, credentials: decryptStockCredentials(item.stockItem.credentials, item.stockItem.id) },
          }
        : item,
    ),
  } as T;
}
```

Update its doc comment: "`Order.customerData` (encrypted since the buyer-answers change) is decrypted here too, throwing on an unreadable value."

`StockCredentialsOrder` (~721): add `customerData: string | null;`. `withDisplayStockCredentials` (~734): add after the `deliveredContent` property:

```ts
    customerData: tryDecryptCustomerData(order.customerData, {
      orderId: order.id,
      purpose: "a buyer's order detail page",
    }),
```

- [ ] **Step 6: Run and confirm everything passes**

Run: `pnpm exec vitest run packages/db/src/crud/orders.test.ts --maxWorkers=2 && pnpm --filter @app/db typecheck`
Expected: the whole file passes (the existing "persists customerData … unchanged" test still passes because `createOrderFromCart` returns `getOrder(...)`); typecheck clean.

If the typecheck reports an order type that lacks `customerData` at a `getOrder`-style call, the type is missing the column in its `select`; fix the select (do not cast).

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/crud/orders.ts packages/db/src/crud/orders.test.ts
git commit -m "feat(db): encrypt Order.customerData at the three write sites

getOrder, getOrderByCodeFull and getOrderByCodeFullForDisplay decrypt it.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Answers never reach list and ticket responses

**Files:**
- Modify: `packages/db/src/crud/orders.ts` (`withoutDeliveredContent`, ~line 1448)
- Test: `packages/db/src/crud/orders.test.ts` (append)

`withoutDeliveredContent` is already applied by `listUserOrders`, the second list reader (~1508), `listOrders` (~3745), `getTicketWithOrder` (`support.ts:131`) and `binance_internal.ts:407`. Making it drop `customerData` too removes the column from every one of them, and from the admin `GET /api/orders` and `/api/payments` responses that spread those rows. The admin order detail response is unaffected: it spreads a `getOrder` row (plaintext) and then overrides `customerData` with the parsed array (`routes/api/orders.ts` ~303 then ~331).

**Interfaces:**
- Produces: `withoutDeliveredContent<T extends { deliveredContent: string | null }>(order: T): Omit<T, "deliveredContent" | "customerData">`.

- [ ] **Step 1: Write the failing tests**

Append to the Task 2 describe block's file (new describe is fine):

```ts
describe("list and ticket rows carry neither delivered content nor buyer answers", () => {
  it("withoutDeliveredContent drops customerData as well", () => {
    const row = { id: 1, orderCode: "A", deliveredContent: "secret", customerData: '{"keyVersion":1}' };
    expect(withoutDeliveredContent(row)).toEqual({ id: 1, orderCode: "A" });
  });

  it("tolerates a row that has no customerData", () => {
    expect(withoutDeliveredContent({ id: 2, deliveredContent: null })).toEqual({ id: 2 });
  });

  it("listUserOrders rows have no customerData key", async () => {
    await resetDb(prisma);
    const sample = await buildSampleData(prisma);
    await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 });

    const rows = await listUserOrders(prisma, sample.user.id);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("customerData");
      expect(Object.keys(row)).not.toContain("deliveredContent");
    }
  });
});
```

Add `withoutDeliveredContent` and `listUserOrders` to the file's import from `"./orders"` if missing.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run packages/db/src/crud/orders.test.ts -t "carry neither" --maxWorkers=2`
Expected: FAIL — `customerData` is still present.

- [ ] **Step 3: Implement**

```ts
/**
 * List/summary rows are spread straight into admin JSON, so they never carry
 * the delivered secret or the buyer's (encrypted) answers; only getOrder's
 * detail/reveal/resend paths read them.
 */
export function withoutDeliveredContent<T extends { deliveredContent: string | null }>(
  order: T,
): Omit<T, "deliveredContent" | "customerData"> {
  const { deliveredContent: _deliveredContent, customerData: _customerData, ...rest } = order as T & { customerData?: unknown };
  return rest;
}
```

- [ ] **Step 4: Run, typecheck every package that imports it**

Run: `pnpm exec vitest run packages/db/src/crud/orders.test.ts --maxWorkers=2 && pnpm --filter @app/db typecheck && pnpm --filter @app/web-admin typecheck && pnpm --filter @app/storefront typecheck && pnpm --filter @app/order-bot typecheck`
Expected: tests pass. If a typecheck now fails because some code reads `.customerData` from a list or ticket row, that code was reading ciphertext after Task 2: switch it to read through `getOrder` / `getOrderByCodeFullForDisplay` (do not re-add the column to the list).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/orders.ts packages/db/src/crud/orders.test.ts
git commit -m "fix(db): list and ticket rows no longer carry the buyer's answers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The six readers of a raw order row

These code paths fetch an order without a choke point, so they would hand ciphertext to the answer readers. Each decrypts explicitly. **Do not touch** the readers that go through `getOrder` / `getOrderByCodeFullForDisplay` (admin order detail `routes/api/orders.ts:255`, buyer order page `apiAccount.ts:291`, bot `customer.ts:2561` and `editCustomerInfo.ts:106`) or `gameTopupDetails.ts` itself: they already receive plaintext, and decrypting again would throw when `ALLOW_LEGACY_PLAINTEXT=false`.

**Files:**
- Modify: `packages/db/src/crud/digiflazz.ts` (~969, ~1167, ~1658-1659 and its import from `@app/core/credentialCrypto`)
- Modify: `apps/storefront/src/routes/checkout.ts` (~1822 and its import)
- Modify: `apps/storefront/src/routes/apiCheckout.ts` (~124 and its import)
- Modify: `packages/outbox-dispatcher/src/fulfillmentMessages.ts` (~55 and its import)
- Test: `packages/db/src/crud/digiflazz.test.ts`, `apps/storefront/test/game-topup-details.test.ts`, `packages/outbox-dispatcher/src/fulfillmentMessages.test.ts`

**Interfaces:**
- Consumes (Task 1): `decryptCustomerData`, `tryDecryptCustomerData`.

- [ ] **Step 1: Write the failing tests**

(a) `packages/db/src/crud/digiflazz.test.ts` — find the existing test titled `"[MONEY-CRITICAL] a unit built the way nicknameCheck.ts now builds it (via the shared buildCustomerDataUnit) round-trips into a NON-EMPTY customerNo containing the target"` (~line 537) and the dispatch tests in the same file that create a Digiflazz game top-up order with `customerData` and assert the `customerNo` / `customer_no` sent to the supplier. Add two tests next to the dispatch test that already asserts the sent target, copying its arrangement exactly:

```ts
it("[MONEY-CRITICAL] dispatches the identical customer number for an order whose answers are stored encrypted", async () => {
  // Arrange exactly as the neighbouring dispatch test does, then assert the raw column is an envelope:
  //   expect(isEncryptedCredentialEnvelope((await prisma.order.findUniqueOrThrow({ where: { id } })).customerData!)).toBe(true);
  // and that the supplier request body's customer_no equals the value the plaintext-fixture test expects.
});

it("[MONEY-CRITICAL] an unreadable answers envelope sends nothing to the supplier and routes the order to manual review", async () => {
  // Same arrangement; before dispatch overwrite the column with a tampered envelope
  //   (parse the stored envelope, replace authTag with Buffer.alloc(16).toString("base64"), stringify).
  // Expect: no supplier createTransaction call, and the order recorded as needing manual review
  //   (the same assertion the existing "Invalid player input configuration or answers; needs manual review" test makes).
});
```

Fill the arrangement and assertions in by reading the neighbouring test; the two assertions above (envelope in the column; identical `customer_no`; no supplier call plus manual review on a tampered envelope) are the contract.

(b) `apps/storefront/test/game-topup-details.test.ts` — in the existing pay-page/detail tests (`body.game_target` at ~94) add, in the test that creates the order with `customerData`, a check that the stored column is an envelope, while `body.game_target` still equals `[{ game_id: "12345678", zone_id: "2201" }]` on **both** the pay endpoint (`/orders/:code/pay`, raw `getOrderByCode`) and the account order detail endpoint (`getOrderByCodeFullForDisplay`).

(c) `packages/outbox-dispatcher/src/fulfillmentMessages.test.ts` — in the existing test that asserts the game receipt lists Game ID / Zone / Server, assert the order's stored column is an envelope and the receipt text still contains the same Game ID, Zone and Server lines; add one test where the envelope is tampered and the receipt simply omits those lines and does not throw.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run packages/db/src/crud/digiflazz.test.ts apps/storefront/test/game-topup-details.test.ts packages/outbox-dispatcher/src/fulfillmentMessages.test.ts --maxWorkers=2 -t "encrypted|envelope|unreadable"`
Expected: FAIL — target built from ciphertext / `game_target` empty.

- [ ] **Step 3: Implement the decrypting reads**

`digiflazz.ts` — add `decryptCustomerData` to the `@app/core/credentialCrypto` import (create the import if the file has none) and change:

```ts
// ~969, inside the existing try { … } catch { structuralProblem = … }
      customerNo = buildDigiflazzCustomerNo(resolution.product, decryptCustomerData(order.customerData, order.id), order.inputConfigSnapshot);
```

```ts
// ~1167, inside computeAccountDiagnosticNote's existing try/catch that returns null
    const unit = parseCustomerData(decryptCustomerData(order.customerData, order.id))[0] ?? {};
```

```ts
// ~1658-1659: select the id too, keep the existing try/catch
  const submittedInput = await db.order.findUniqueOrThrow({ where: { id: order.id }, select: { id: true, customerData: true, inputConfigSnapshot: true } });
  try { customerNo = buildDigiflazzCustomerNo(resolution.product, decryptCustomerData(submittedInput.customerData, submittedInput.id), submittedInput.inputConfigSnapshot); }
```

`apps/storefront/src/routes/checkout.ts` (~1822, inside the existing try whose catch replies `{ status: "unmatched" }`; add `decryptCustomerData` to the credentialCrypto import):

```ts
      try { customerNo = buildDigiflazzCustomerNo(resolution.product, decryptCustomerData(order.customerData, order.id), order.inputConfigSnapshot); }
```

`apps/storefront/src/routes/apiCheckout.ts` (~124; add `tryDecryptCustomerData` to the credentialCrypto import). `gameTopupDetails` must keep receiving plaintext, so decrypt here, where the row is raw:

```ts
      ...gameTopupDetails(
        { ...order, customerData: tryDecryptCustomerData(order.customerData, { orderId: order.id, purpose: "the buyer's pay page" }) },
        view.presentation.transactionType,
        () => decryptGameSn(order),
      ),
```

`packages/outbox-dispatcher/src/fulfillmentMessages.ts` (~55; add `tryDecryptCustomerData` to the credentialCrypto import, or create one):

```ts
      const answers = tryDecryptCustomerData(order.customerData, { orderId: order.id, purpose: "the order status message" });
      const targets = orderGameTargets(first.product, order.inputConfigSnapshot, answers);
```

- [ ] **Step 4: Run and confirm everything passes**

Run: `pnpm exec vitest run packages/db/src/crud/digiflazz.test.ts apps/storefront/test/game-topup-details.test.ts packages/outbox-dispatcher/src/fulfillmentMessages.test.ts --maxWorkers=2 && pnpm --filter @app/db typecheck && pnpm --filter @app/storefront typecheck && pnpm --filter @app/outbox-dispatcher typecheck`
Expected: pass; typecheck clean. The storefront and the dispatcher tests need Postgres (the worktree DB from Task 0).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/digiflazz.ts packages/db/src/crud/digiflazz.test.ts apps/storefront/src/routes/checkout.ts apps/storefront/src/routes/apiCheckout.ts apps/storefront/test/game-topup-details.test.ts packages/outbox-dispatcher/src/fulfillmentMessages.ts packages/outbox-dispatcher/src/fulfillmentMessages.test.ts
git commit -m "fix: the six raw-row readers of buyer answers decrypt them

Fulfillment throws on an unreadable value; the pay page and the status
message leave the answers out.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Encrypt the bot session blob

**Files:**
- Modify: `apps/order-bot/src/util/prismaSessionStorage.ts` (`read`/`write` in `prismaSessionStorage()`, ~line 140; imports)
- Test: `apps/order-bot/test/prisma-session-storage.test.ts` (append; it already imports `./setup-db` first, `prisma`, `prismaSessionStorage`, `initialSession`)

**Interfaces:**
- Consumes (Task 1): `encryptBotSession`, `decryptBotSession`, `isEncryptedCredentialEnvelope`, `CredentialKeyConfigError`.
- Behaviour: a stored value that is an envelope is decrypted; anything else is a session written before this change and is read as-is (it expires within 24 h); an envelope that cannot be decrypted is treated as no session.

- [ ] **Step 1: Write the failing tests**

Append to `apps/order-bot/test/prisma-session-storage.test.ts` (extend its imports with `isEncryptedCredentialEnvelope` from `"@app/core/credentialCrypto"`):

```ts
describe("prismaSessionStorage — encryption at rest", () => {
  const checkoutSession = (): SessionData => ({
    ...initialSession(),
    scratch: { customerData: '[{"game_id":"12345"}]' },
  });
  const rawData = async (key: string) => (await prisma.botSession.findUniqueOrThrow({ where: { key } })).data;

  it("stores an envelope, never the typed answers, and reads the session back", async () => {
    const storage = prismaSessionStorage();
    await storage.write("chat-enc", checkoutSession());

    const stored = await rawData("chat-enc");
    expect(isEncryptedCredentialEnvelope(stored)).toBe(true);
    expect(stored).not.toContain("12345");
    expect((await storage.read("chat-enc"))?.scratch?.customerData).toBe('[{"game_id":"12345"}]');
  });

  it("still reads a plaintext session written before encryption (it expires on its own)", async () => {
    const storage = prismaSessionStorage();
    await prisma.botSession.create({
      data: { key: "chat-old", data: JSON.stringify(checkoutSession()), kind: "checkout", expiresAt: new Date(Date.now() + 60_000) },
    });

    expect((await storage.read("chat-old"))?.scratch?.customerData).toBe('[{"game_id":"12345"}]');
  });

  it("treats a session copied onto another key as no session (the envelope is bound to its key)", async () => {
    process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = "true";
    try {
      const storage = prismaSessionStorage();
      await storage.write("chat-a", checkoutSession());
      await prisma.botSession.create({
        data: { key: "chat-b", data: await rawData("chat-a"), kind: "checkout", expiresAt: new Date(Date.now() + 60_000) },
      });

      expect(await storage.read("chat-b")).toBeUndefined();
    } finally {
      delete process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
    }
  });

  it("treats a tampered envelope as no session instead of crashing the update", async () => {
    const storage = prismaSessionStorage();
    await storage.write("chat-bad", checkoutSession());
    const good = JSON.parse(await rawData("chat-bad")) as Record<string, unknown>;
    await prisma.botSession.update({
      where: { key: "chat-bad" },
      data: { data: JSON.stringify({ ...good, authTag: Buffer.alloc(16).toString("base64") }) },
    });

    expect(await storage.read("chat-bad")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run apps/order-bot/test/prisma-session-storage.test.ts -t "encryption at rest" --maxWorkers=2`
Expected: FAIL — the stored data is plain JSON.

- [ ] **Step 3: Implement**

Add imports at the top of `prismaSessionStorage.ts`:

```ts
import {
  CredentialKeyConfigError,
  decryptBotSession,
  encryptBotSession,
  isEncryptedCredentialEnvelope,
} from "@app/core/credentialCrypto";
import { logger } from "@app/core/logger";
```

Replace `read` and `write` inside `prismaSessionStorage()`:

```ts
    async read(key) {
      const stored = await readBotSession(prisma, key);
      if (stored === undefined) return undefined;
      let raw: string;
      if (isEncryptedCredentialEnvelope(stored)) {
        try {
          raw = decryptBotSession(stored, key);
        } catch (err) {
          // A missing key is a deployment fault the boot check already refuses; never hide it as a miss.
          if (err instanceof CredentialKeyConfigError) throw err;
          // Class name only: a message could echo part of the stored value.
          logger.warn(
            { errorName: err instanceof Error ? err.name : typeof err },
            "A saved bot session could not be decrypted, so this chat starts a fresh session. It is corrupted, tampered with, or was encrypted under a different key.",
          );
          return undefined;
        }
      } else {
        // Written before sessions were encrypted; such a row expires within the 24 h navigation TTL.
        raw = stored;
      }
      try {
        return JSON.parse(raw) as SessionData;
      } catch {
        // A corrupt/foreign row (should never happen from this adapter's own
        // writes) — treat it like a miss so session() falls back to `initial`
        // instead of crashing the update on a parse error.
        return undefined;
      }
    },
    async write(key, value) {
      const kind = classifySessionKind(value);
      const ttlMs = kind === "checkout" ? CHECKOUT_TTL_MS : NAV_TTL_MS;
      await writeBotSession(prisma, key, encryptBotSession(JSON.stringify(value), key), kind, new Date(Date.now() + ttlMs));
    },
```

Update the file's header comment: add a paragraph "The whole session JSON is encrypted at rest because it carries the buyer's in-flight checkout answers (`scratch.customerData`) and the messages typed into a conversation."

- [ ] **Step 4: Run and confirm the whole session suites pass**

Run: `pnpm exec vitest run apps/order-bot/test/prisma-session-storage.test.ts apps/order-bot/test/prisma-session-storage-external-audit.test.ts apps/order-bot/test/prisma-session-storage-e2e-conversation.test.ts --maxWorkers=2 && pnpm --filter @app/order-bot typecheck`
Expected: all pass. If an existing test reads `prisma.botSession` `data` as JSON, change it to read through `prismaSessionStorage().read(key)`.

- [ ] **Step 5: Commit**

```bash
git add apps/order-bot/src/util/prismaSessionStorage.ts apps/order-bot/test/prisma-session-storage.test.ts
git commit -m "feat(bot): encrypt the grammY session blob at rest

An undecryptable session is treated as no session; plaintext sessions
written before the change are still read and expire on their own.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(Stage any of the other two session test files too if Step 4 required editing them.)

---

### Task 6: Backfill of existing orders, v2 re-encryption, deploy docs

**Files:**
- Create: `scripts/backfill-encrypt-customer-data.ts`, `scripts/backfill-encrypt-customer-data.test.ts`
- Modify: `scripts/reencrypt-credentials-v2.ts`, `scripts/reencrypt-credentials-v2.test.ts`
- Modify: `package.json` (scripts), `.env.example` (~lines 126-146), `DOCS.md` (the rollout checklist section "Checklist rollout: traceability stok + enkripsi credential")

**Interfaces:**
- Produces: `backfillEncryptCustomerData(db: PrismaClient, opts?: { dryRun?: boolean }): Promise<BackfillCustomerDataReport>` with the same report fields as the delivered-content backfill; `ReencryptReport` gains `customerData: ReencryptColumnReport`.

- [ ] **Step 1: Write the failing backfill test**

Create `scripts/backfill-encrypt-customer-data.test.ts`:

```ts
/**
 * The customer-data backfill must encrypt every legacy plaintext row, leave
 * encrypted rows alone (idempotent), count but never rewrite a corrupt
 * envelope, write nothing on a dry run, and never print the answers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  credentialEnvelopeVersion,
  decryptCustomerData,
  encryptCustomerData,
  isEncryptedCredentialEnvelope,
} from "@app/core/credentialCrypto";
import { makeTestDb, type TestDb } from "../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../tests/helpers/sampleData";
import { createOrderDirect } from "../packages/db/src/crud/orders";
import { backfillEncryptCustomerData } from "./backfill-encrypt-customer-data";
import { useEnvelopeWriteV2, encryptLegacyV1 } from "../tests/helpers/envelopeFlag";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

async function orderWithStored(stored: string | null): Promise<number> {
  const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1, channel: "bot" }))!;
  await prisma.order.update({ where: { id: order.id }, data: { customerData: stored } });
  return order.id;
}

function corruptEnvelope(): string {
  const good = JSON.parse(encryptLegacyV1('[{"game_id":"Corrupt9"}]')) as Record<string, unknown>;
  return JSON.stringify({ ...good, authTag: Buffer.alloc(16).toString("base64") });
}

async function rawAnswers(id: number) {
  return (await prisma.order.findUniqueOrThrow({ where: { id } })).customerData;
}

describe("backfillEncryptCustomerData", () => {
  it("encrypts plaintext rows, skips encrypted and null rows, and counts a corrupt envelope without touching it", async () => {
    const legacyA = await orderWithStored('[{"game_id":"111"}]');
    const legacyB = await orderWithStored('[{"email":"buyer@example.com"},{"email":"two@example.com"}]');
    const already = encryptLegacyV1('[{"game_id":"222"}]');
    const alreadyId = await orderWithStored(already);
    const corrupt = corruptEnvelope();
    const corruptId = await orderWithStored(corrupt);
    const nullId = await orderWithStored(null);

    const report = await backfillEncryptCustomerData(prisma);

    expect(report).toEqual({ scanned: 4, plaintext: 2, encrypted: 2, alreadyEncrypted: 1, corrupt: 1, changedDuringRun: 0 });
    for (const [id, plain] of [[legacyA, '[{"game_id":"111"}]'], [legacyB, '[{"email":"buyer@example.com"},{"email":"two@example.com"}]']] as const) {
      const stored = await rawAnswers(id);
      expect(isEncryptedCredentialEnvelope(stored!)).toBe(true);
      expect(decryptCustomerData(stored, id)).toBe(plain);
    }
    expect(await rawAnswers(alreadyId)).toBe(already);
    expect(await rawAnswers(corruptId)).toBe(corrupt);
    expect(await rawAnswers(nullId)).toBeNull();
  });

  it("is idempotent: a second run rewrites nothing", async () => {
    const id = await orderWithStored('[{"game_id":"333"}]');
    await backfillEncryptCustomerData(prisma);
    const afterFirst = await rawAnswers(id);

    const second = await backfillEncryptCustomerData(prisma);

    expect(second).toEqual({ scanned: 1, plaintext: 0, encrypted: 0, alreadyEncrypted: 1, corrupt: 0, changedDuringRun: 0 });
    expect(await rawAnswers(id)).toBe(afterFirst);
  });

  it("dry run counts plaintext rows but writes nothing", async () => {
    const id = await orderWithStored('[{"game_id":"444"}]');

    const report = await backfillEncryptCustomerData(prisma, { dryRun: true });

    expect(report).toMatchObject({ scanned: 1, plaintext: 1, encrypted: 0 });
    expect(await rawAnswers(id)).toBe('[{"game_id":"444"}]');
  });

  it("never prints the answers", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await orderWithStored('[{"game_id":"SECRET-ANSWER-555"}]');
      await backfillEncryptCustomerData(prisma);
      expect(JSON.stringify([log.mock.calls, error.mock.calls])).not.toContain("SECRET-ANSWER-555");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe.each([false, true])("backfillEncryptCustomerData with CREDENTIAL_ENVELOPE_WRITE_V2 %s", (on) => {
  useEnvelopeWriteV2(on);

  it("writes the flag's envelope version bound to the order, and counts an envelope bound to its own order as encrypted", async () => {
    const legacyId = await orderWithStored('[{"game_id":"666"}]');
    const boundId = await orderWithStored(null);
    await prisma.order.update({ where: { id: boundId }, data: { customerData: encryptCustomerData('[{"game_id":"777"}]', boundId) } });

    const report = await backfillEncryptCustomerData(prisma);

    expect(report).toMatchObject({ plaintext: 1, encrypted: 1, alreadyEncrypted: 1, corrupt: 0 });
    const stored = (await rawAnswers(legacyId))!;
    expect(credentialEnvelopeVersion(stored)).toBe(on ? 2 : 1);
    expect(decryptCustomerData(stored, legacyId)).toBe('[{"game_id":"666"}]');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run scripts/backfill-encrypt-customer-data.test.ts --maxWorkers=2`
Expected: FAIL — module `./backfill-encrypt-customer-data` not found.

- [ ] **Step 3: Implement the backfill**

Create `scripts/backfill-encrypt-customer-data.ts`:

```ts
/**
 * One-time offline backfill: encrypt every `Order.customerData` (the buyer's
 * answers to a product's additional fields) still stored as plaintext from
 * before the column was encrypted at rest. Same shape as
 * scripts/backfill-encrypt-delivered-content.ts: idempotent (a row already
 * holding an encrypted envelope is left alone), safe to re-run after an
 * interrupted run, and it reports counts only.
 *
 * Run it with `DATABASE_URL_PRISMA` and `CREDENTIAL_ENCRYPTION_KEY` set to the
 * same values the app uses:
 *
 *   pnpm backfill-encrypt-customer-data --dry-run   # count only, write nothing
 *   pnpm backfill-encrypt-customer-data
 *
 * An envelope that no longer decrypts (tampered, or encrypted under another
 * key) is counted as corrupt and left untouched — rewriting it cannot recover
 * the answers. Once `plaintext` and `corrupt` both report 0 here AND for the
 * three other credential backfills, ALLOW_LEGACY_PLAINTEXT can be turned off.
 *
 * NEVER logs the answers, plaintext or encrypted — only counts.
 */
import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { prisma, initDb } from "@app/db";
import {
  CredentialKeyConfigError,
  decryptCustomerData,
  encryptCustomerData,
  isEncryptedCredentialEnvelope,
} from "@app/core/credentialCrypto";

const BATCH_SIZE = 500;

export interface BackfillCustomerDataReport {
  /** Orders that carry any answers. */
  scanned: number;
  /** Plaintext rows found (rewritten unless dry-run). */
  plaintext: number;
  encrypted: number;
  alreadyEncrypted: number;
  /** Envelope-shaped rows that fail to decrypt; never rewritten. */
  corrupt: number;
  /** Plaintext rows that changed between the read and the rewrite; left for a re-run. */
  changedDuringRun: number;
}

export async function backfillEncryptCustomerData(
  db: PrismaClient,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillCustomerDataReport> {
  const report: BackfillCustomerDataReport = {
    scanned: 0,
    plaintext: 0,
    encrypted: 0,
    alreadyEncrypted: 0,
    corrupt: 0,
    changedDuringRun: 0,
  };
  let afterId = 0;
  for (;;) {
    // Paged by id only; the null check happens here, not as a query filter on the column.
    const rows = await db.order.findMany({
      where: { id: { gt: afterId } },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      select: { id: true, customerData: true },
    });
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      const stored = row.customerData;
      if (stored === null || stored === "") continue;
      report.scanned++;
      if (isEncryptedCredentialEnvelope(stored)) {
        try {
          decryptCustomerData(stored, row.id);
          report.alreadyEncrypted++;
        } catch (err) {
          if (err instanceof CredentialKeyConfigError) throw err;
          report.corrupt++;
        }
        continue;
      }
      report.plaintext++;
      if (opts.dryRun) continue;
      // Compare-and-set on the value just read, so a concurrent buyer edit is never overwritten.
      const { count } = await db.order.updateMany({
        where: { id: row.id, customerData: stored },
        data: { customerData: encryptCustomerData(stored, row.id) },
      });
      if (count === 1) report.encrypted++;
      else report.changedDuringRun++;
    }
  }
  return report;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  await initDb();

  const r = await backfillEncryptCustomerData(prisma, { dryRun });

  console.log(
    `[backfill-encrypt-customer-data]${dryRun ? " (dry run, nothing written)" : ""} ` +
      `${r.scanned} order(s) with buyer answers scanned: ${r.plaintext} plaintext, ` +
      `${r.encrypted} encrypted now, ${r.alreadyEncrypted} already encrypted, ` +
      `${r.corrupt} corrupt envelope(s) left untouched, ${r.changedDuringRun} changed during the run (re-run to pick them up).`,
  );
  await prisma.$disconnect();
}

// Guarded so importing this file (the test does) never opens the app's own
// database connection or runs the backfill as a side effect.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(async (e) => {
    // Name and code only: a Prisma validation message can echo query arguments, i.e. the answers.
    const code = (e as { code?: unknown } | null)?.code;
    console.error(
      `[backfill-encrypt-customer-data] failed with ${e instanceof Error ? e.name : typeof e}${code ? ` (${String(code)})` : ""}; nothing after the failing row was changed. Re-run once the cause is fixed.`,
    );
    if (e instanceof CredentialKeyConfigError) console.error(e.message);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
```

Add to `package.json` `scripts`, next to `backfill-encrypt-delivered-content`:

```json
    "backfill-encrypt-customer-data": "tsx scripts/backfill-encrypt-customer-data.ts",
```

- [ ] **Step 4: Run and confirm the backfill passes**

Run: `pnpm exec vitest run scripts/backfill-encrypt-customer-data.test.ts --maxWorkers=2`
Expected: PASS (6 tests: 4 + 2 from the `describe.each`).

- [ ] **Step 5: Add the column to the v2 re-encrypt script (test first)**

In `scripts/reencrypt-credentials-v2.test.ts`, find where the report is compared (`report.stock` `toEqual({ … })` at ~line 102, and any `toEqual` on the whole report) and add a test:

```ts
it("re-encrypts a v1 customerData envelope as v2 bound to its order and leaves plaintext to the backfill", async () => {
  // Arrange with the same helpers the deliveredContent test in this file uses:
  //   an order whose column holds encryptLegacyV1('[{"game_id":"123"}]'), another holding plain '[{"game_id":"456"}]'.
  // Run with CREDENTIAL_ENVELOPE_WRITE_V2 on (the file's existing pattern), then expect:
  //   report.customerData toMatchObject({ scanned: 2, v1: 1, reencrypted: 1, notEncrypted: 1 })
  //   credentialEnvelopeVersion(rawColumn(order1)) === 2 and decryptCustomerData(rawColumn(order1), order1.id) === '[{"game_id":"123"}]'
  //   the plain row is unchanged.
});
```

Write it by copying the arrangement of the existing deliveredContent test in that file; the assertions above are the contract. Update any existing `toEqual` on the full report object to include `customerData: expect.any(Object)` (or the explicit empty report shape) so it stays meaningful.

Run: `pnpm exec vitest run scripts/reencrypt-credentials-v2.test.ts --maxWorkers=2` — Expected: FAIL (`report.customerData` undefined).

Then in `scripts/reencrypt-credentials-v2.ts`:
- Import `customerDataAad` from `@app/core/credentialCrypto` (next to `deliveredContentAad`).
- Add `customerData: ReencryptColumnReport;` to `ReencryptReport` and `customerData: emptyReport(),` in `reencryptCredentialsV2`'s report.
- Add after `reencryptDeliveredContent`:

```ts
async function reencryptCustomerData(db: PrismaClient, dryRun: boolean, report: ReencryptColumnReport): Promise<void> {
  let afterId = 0;
  for (;;) {
    const rows = await db.order.findMany({
      where: { id: { gt: afterId } },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      select: { id: true, customerData: true },
    });
    if (rows.length === 0) return;
    afterId = rows[rows.length - 1]!.id;
    for (const row of rows) {
      const stored = row.customerData;
      if (stored === null) continue;
      const aad = customerDataAad(row.id);
      const c = classify(stored, aad);
      if (!tally(report, c) || dryRun) continue;
      const { count } = await db.order.updateMany({
        where: { id: row.id, customerData: stored },
        data: { customerData: sealV2(c.plaintext, aad) },
      });
      if (count === 1) report.reencrypted++;
      else report.changedDuringRun++;
    }
  }
}
```

- Call it after `reencryptDeliveredContent(...)` in `reencryptCredentialsV2`, and add a log line in `main()`: `console.log(\`${tag} ${describeColumn("Order buyer answers", r.customerData, dryRun)}\`);`
- Update the header comment to say four encrypted columns, adding `Order.customerData (\`orders.customer_data:{orderId}\`)`.

Run: `pnpm exec vitest run scripts/reencrypt-credentials-v2.test.ts --maxWorkers=2` — Expected: PASS.

- [ ] **Step 6: Update the operator docs**

`.env.example` (the `ALLOW_LEGACY_PLAINTEXT` block, ~126-140): change "all three backfills" wording to four and name the new one. Open the block, replace the sentence that lists the three backfills with: `pnpm backfill-encrypt-stock-credentials`, `pnpm backfill-encrypt-delivered-content`, `pnpm backfill-encrypt-settings-secrets` and `pnpm backfill-encrypt-customer-data`, and state: "Order answers (`Order.customerData`) and bot sessions are encrypted since the buyer-answers change; after the code is deployed, roll back only to a version that can still decrypt."

`DOCS.md`: in "Checklist rollout: traceability stok + enkripsi credential" add a step for `pnpm backfill-encrypt-customer-data --dry-run` then for real, with the same `plaintext = 0` / `corrupt = 0` exit criterion, before `ALLOW_LEGACY_PLAINTEXT=false`; add the rollback warning from the spec ("Rollback warning" paragraph) in Indonesian, matching the section's language.

- [ ] **Step 7: Verify and commit**

Run: `pnpm exec vitest run scripts/backfill-encrypt-customer-data.test.ts scripts/reencrypt-credentials-v2.test.ts scripts/backfill-encrypt-delivered-content.test.ts --maxWorkers=2`
Expected: all pass.

```bash
git add scripts/backfill-encrypt-customer-data.ts scripts/backfill-encrypt-customer-data.test.ts scripts/reencrypt-credentials-v2.ts scripts/reencrypt-credentials-v2.test.ts package.json .env.example DOCS.md
git commit -m "feat(scripts): backfill and v2 re-encrypt for the buyer answers column

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: AST guard test

**Files:**
- Create: `tests/customer-data-guard.test.ts`
- Modify: `package.json` (`test:guards`)

**Rule:** In non-test source under `apps/*/src` and `packages/*/src` (excluding `/client/`), a call to `parseCustomerData(`, `buildDigiflazzCustomerNo(`, `orderGameTargets(` or `orderGameTargetLabels(` whose customer-data argument is a bare property access `<expr>.customerData` is a violation, unless the receiver is a bot `scratch` object, or the file is in the allow-list of files whose order comes from a decrypting reader. An argument that is a call to `decryptCustomerData(` / `tryDecryptCustomerData(` is always fine.

**Interfaces:** pure file scan; imports only `node:fs`, `node:path`, `typescript`, `vitest` (no DB).

- [ ] **Step 1: Write the guard test with its self-test**

Create `tests/customer-data-guard.test.ts`:

```ts
/**
 * Guard for buyer answers (`Order.customerData`) stored encrypted at rest. The
 * readers that turn the stored string into answers (parseCustomerData,
 * buildDigiflazzCustomerNo, orderGameTargets, orderGameTargetLabels) must be
 * handed PLAINTEXT. An order read through getOrder / getOrderByCode(Full) /
 * getOrderByCodeFullForDisplay is already decrypted; a raw row (getOrderRaw,
 * getOrderByCode, a bare findUnique/findMany, a `select`) is ciphertext and
 * must go through decryptCustomerData / tryDecryptCustomerData first.
 *
 * It scans source with the TypeScript AST and fails when one of those readers
 * is called with a bare `<something>.customerData` outside an allow-listed
 * file. Add a file to ALLOWED_DECRYPTED_SOURCES only after confirming its
 * order comes from a decrypting reader, and say which one. Decrypting twice is
 * also a bug (it throws when ALLOW_LEGACY_PLAINTEXT=false), so do not wrap a
 * value that is already plaintext.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

/** Answer readers whose customer-data argument must be plaintext, and its argument index. */
const READERS: Record<string, number> = {
  parseCustomerData: 0,
  buildDigiflazzCustomerNo: 1,
  orderGameTargets: 2,
  orderGameTargetLabels: 2,
};

/** Files whose `order` is read through a decrypting reader (the choke points in packages/db/src/crud/orders.ts). */
const ALLOWED_DECRYPTED_SOURCES: Record<string, string> = {
  "apps/web-admin/src/routes/api/orders.ts": "admin order detail reads through getOrder",
  "apps/storefront/src/routes/apiAccount.ts": "buyer order page reads through getOrderByCodeFullForDisplay",
  "apps/storefront/src/routes/gameTopupDetails.ts": "callers pass an already decrypted order (see apiCheckout.ts)",
  "apps/order-bot/src/handlers/customer.ts": "bot order detail reads through getOrder",
  "apps/order-bot/src/conversations/editCustomerInfo.ts": "the edit flow reads through getOrder",
};

const isSource = (p: string) => /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !p.includes(`${sep}client${sep}`) && !p.includes("node_modules");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "static") continue;
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (isSource(full)) yield full;
  }
}

const calleeName = (call: ts.CallExpression): string | null => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
};

/** `x.customerData` where the receiver is not a bot `scratch` object. */
const isBareCustomerDataAccess = (expr: ts.Expression): boolean => {
  const e = ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== "customerData") return false;
  const receiver = e.expression.getText();
  return !/(^|\.)scratch$/.test(receiver);
};

/** Violations in one file's source text (exported shape so the self-test can use it). */
export function customerDataViolations(fileName: string, code: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && name in READERS) {
        const arg = node.arguments[READERS[name]!];
        if (arg && isBareCustomerDataAccess(arg)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          found.push(`${fileName}:${line}: ${name}(${arg.getText()}) reads a possibly encrypted column — decrypt it with decryptCustomerData / tryDecryptCustomerData, or read the order through getOrder`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("customer-data guard", () => {
  it("flags a reader handed a bare order.customerData", () => {
    const bad = `import { parseCustomerData } from "@app/core/deliveryFields"; const a = parseCustomerData(order.customerData);`;
    expect(customerDataViolations("x.ts", bad)).toHaveLength(1);
    const bad2 = `const n = buildDigiflazzCustomerNo(product, row.customerData, snapshot);`;
    expect(customerDataViolations("x.ts", bad2)).toHaveLength(1);
    const bad3 = `const t = orderGameTargets(product, snapshot, order.customerData);`;
    expect(customerDataViolations("x.ts", bad3)).toHaveLength(1);
  });

  it("accepts a decrypted argument and a bot scratch string", () => {
    expect(customerDataViolations("x.ts", `parseCustomerData(decryptCustomerData(order.customerData, order.id));`)).toEqual([]);
    expect(customerDataViolations("x.ts", `orderGameTargets(p, s, tryDecryptCustomerData(order.customerData, { orderId: 1, purpose: "x" }));`)).toEqual([]);
    expect(customerDataViolations("x.ts", `parseCustomerData(ctx.session.scratch.customerData);`)).toEqual([]);
  });

  it("no source file passes a possibly encrypted customerData to an answer reader", () => {
    const violations: string[] = [];
    for (const top of ["apps", "packages"]) {
      for (const file of walk(join(ROOT, top))) {
        const rel = relative(ROOT, file).split(sep).join("/");
        if (rel in ALLOWED_DECRYPTED_SOURCES) continue;
        violations.push(...customerDataViolations(rel, readFileSync(file, "utf8")));
      }
    }
    expect(violations).toEqual([]);
  });

  it("every allow-listed file still exists (a stale entry hides a real violation)", () => {
    for (const rel of Object.keys(ALLOWED_DECRYPTED_SOURCES)) {
      expect(() => statSync(join(ROOT, rel))).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm exec vitest run tests/customer-data-guard.test.ts --maxWorkers=2`
Expected: PASS on a tree where Tasks 1-5 are done. As a sanity check that the guard can fail, temporarily revert one fix from Task 4 (for example change `decryptCustomerData(order.customerData, order.id)` in `packages/db/src/crud/digiflazz.ts` back to `order.customerData`), re-run, expect FAIL naming that file and line, then restore the fix and re-run to PASS. Record this in the report.

- [ ] **Step 3: Add the guard to `test:guards`**

In `package.json` `test:guards`, add `tests/customer-data-guard.test.ts` after `tests/no-fake-claims.test.ts`. Run `pnpm test:guards` — Expected: all guard tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/customer-data-guard.test.ts package.json
git commit -m "test: guard against handing ciphertext to the buyer-answer readers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Whole-branch verification (controller, not a subagent)

- [ ] **Step 1: Sync and gate.** `git fetch`; if `master` moved, merge it into this branch (never rebase a pushed branch). Run `pnpm typecheck`, `pnpm run pretest`, then the full `pnpm exec vitest run --maxWorkers=2` (about 80 minutes on this machine; if a file fails only in the full run, re-run it alone before calling it a regression). `pnpm test` does not accept `--maxWorkers`.
- [ ] **Step 2: Strict-mode and v2 runs.** `ALLOW_LEGACY_PLAINTEXT=false pnpm exec vitest run packages/db/src/crud/orders.test.ts packages/db/src/crud/digiflazz.test.ts apps/storefront/test/game-topup-details.test.ts apps/order-bot/test/prisma-session-storage.test.ts scripts/backfill-encrypt-customer-data.test.ts --maxWorkers=2` (legacy-plaintext tests that deliberately write plain rows may be adjusted to set the flag themselves; no other failure is acceptable). Then `pnpm test:envelope-v2` and compare its failure count with the known 27 pre-existing: it must not grow.
- [ ] **Step 3: Runtime proof with dummy data** (Playwright, the same method as the UI-states audit, in a throwaway schema): place an order on a product with an additional field, read the raw column with `psql` and confirm it starts with `{"keyVersion"` and contains no answer text; open the admin order detail and confirm the answers still show; confirm a Digiflazz-routed dummy order dispatches the same `customer_no`; confirm a bot session row in `bot_sessions` has no answer text. Drop the schema and stop the servers afterwards.
- [ ] **Step 4: Full-branch Opus review** focused on: any reader of a raw row not covered (grep `customerData` in `apps` and `packages`), double decryption, a path that sends an empty target to a supplier, ciphertext reaching a browser, plaintext in logs, and test files that were weakened. Fix every Important finding in new commits and re-run Steps 1-2.
- [ ] **Step 5: Record and hand off.** Write the result in `docs/superpowers/plans/` progress note or the PR description: counts, the strict-mode run, the browser proof, the deploy order and the rollback warning. Do not merge without the user's go-ahead; run `pnpm typecheck && pnpm test` once more after merging into `master` per `AGENTS.md`.
