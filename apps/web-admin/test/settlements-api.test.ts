/**
 * Task F1 — the admin API for provider settlement batches.
 *
 * The route is wiring: every amount check, every write and the audit row live in
 * `packages/db/src/crud/settlements.ts` and are covered by `settlements.test.ts`.
 * What is tested here is what only the route layer can get wrong — that the
 * whole four-write transaction really lands from an HTTP request, that a
 * `ValidationError` from the service surfaces as this app's 422 rather than a
 * 500, that a batch's date is read as UTC rather than the server's local
 * midnight, that money arrives as a Decimal string and never a float, and that
 * the RBAC placement chosen for this prefix is the one that actually took
 * effect.
 *
 * The RBAC block is the part worth having: `/api/settlements` is a NEW top-level
 * prefix, and this repo has been bitten before by a prefix list drifting away
 * from the live paths and silently changing who may mutate what (see
 * `CONFIG_PREFIXES`' own comment). Asserting the refusal AND the grant is what
 * makes "super only, on purpose" a fact rather than a comment.
 */
import "./setup-env";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { PaymentMethod, SettlementStatus } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { prisma, initDb, setSetting, createOrderDirect, getAccountBalance } from "@app/db";
import { resetDb, buildSampleData, type SampleData } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";
import { makeSession, sessionJtiKey, newJti, webRoleKey } from "../src/auth";

const ADMIN_TG = 999;
const COOKIE = config.WEB_COOKIE_NAME;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let sample: SampleData;
let adminId: number;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  const admin = await prisma.user.create({
    data: {
      telegramId: ADMIN_TG,
      username: "admin",
      fullName: "Admin",
      role: "ADMIN",
      referralCode: `a${Math.random()}`,
    },
  });
  adminId = admin.id;
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

function post(url: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url,
    payload: body as Record<string, unknown>,
    headers: { "x-csrf-token": csrf, ...headers },
    cookies: { [COOKIE]: cookie },
  });
}

function get(url: string) {
  return app.inject({ method: "GET", url, cookies: { [COOKIE]: cookie } });
}

/** A valid batch body, in the shape the admin form submits. */
const batchBody = {
  provider: PaymentMethod.TOKOPAY,
  batchReference: "STMT-2026-09-01",
  settlementDate: "2026-09-01",
  currency: "IDR",
  grossAmount: "1000000",
  feeAmount: "23500",
  netAmount: "976500",
};

/** Nothing was recorded and nothing was posted — the assertion every refusal
 *  below shares, because a half-written batch misstates the books silently. */
async function expectNothingRecorded() {
  expect(await prisma.settlement.count()).toBe(0);
  expect(await prisma.settlementTransaction.count()).toBe(0);
  expect(await prisma.financialTransaction.count({ where: { referenceType: "settlement" } })).toBe(0);
}

describe("POST /api/settlements", () => {
  it("records the batch, its lines, the ledger posting and one audit row", async () => {
    const res = await post("/api/settlements", { ...batchBody, lines: [{ amount: "1000000" }] });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; settlementId: number; posted: boolean };
    expect(body.ok).toBe(true);
    expect(body.posted).toBe(true);

    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { id: body.settlementId } });
    expect(settlement.provider).toBe(PaymentMethod.TOKOPAY);
    expect(settlement.status).toBe(SettlementStatus.RECORDED);
    expect(settlement.createdBy).toBe(adminId);
    // A date-only field is read as UTC midnight, never the server's own
    // midnight — a batch settled on the 1st must not book on the 31st.
    expect(settlement.settlementDate.toISOString()).toBe("2026-09-01T00:00:00.000Z");

    expect(await prisma.settlementTransaction.count({ where: { settlementId: settlement.id } })).toBe(1);

    const posting = await prisma.financialTransaction.findUniqueOrThrow({
      where: { idempotencyKey: `settlement:${settlement.id}` },
    });
    expect(posting.occurredAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");

    const rows = await prisma.auditLog.findMany({ where: { targetType: "settlement" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.adminId).toBe(adminId);
  });

  it("drains provider_clearing into cash and payment_fee by the reported amounts", async () => {
    const clearingBefore = await getAccountBalance(prisma, "provider_clearing.idr");
    const cashBefore = await getAccountBalance(prisma, "cash.idr");

    expect((await post("/api/settlements", batchBody)).statusCode).toBe(200);

    expect((await getAccountBalance(prisma, "cash.idr")).minus(cashBefore).toString()).toBe("976500");
    expect(
      (await getAccountBalance(prisma, "provider_clearing.idr")).minus(clearingBefore).toString(),
    ).toBe("-1000000");
    expect((await getAccountBalance(prisma, "payment_fee.idr")).toString()).toBe("23500");
  });

  it("keeps the ledger balanced within the batch's currency", async () => {
    const res = await post("/api/settlements", batchBody);
    const { settlementId } = res.json() as { settlementId: number };

    const posting = await prisma.financialTransaction.findUniqueOrThrow({
      where: { idempotencyKey: `settlement:${settlementId}` },
    });
    const entries = await prisma.ledgerEntry.findMany({
      where: { financialTransactionId: posting.id },
    });
    let debits = new Decimal(0);
    let credits = new Decimal(0);
    for (const entry of entries) {
      if (entry.direction === "DEBIT") debits = debits.plus(new Decimal(entry.amount));
      else credits = credits.plus(new Decimal(entry.amount));
      expect(entry.currency).toBe("IDR");
    }
    expect(debits.toString()).toBe(credits.toString());
  });

  it("matches a line to the payment whose provider transaction id it names", async () => {
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    const order = await createOrderDirect(prisma, {
      user: { id: buyer.id, role: buyer.role, walletBalance: buyer.walletBalance },
      productId: sample.product.id,
      quantity: 1,
    });
    const payment = await prisma.payment.create({
      data: {
        orderId: order!.id,
        method: PaymentMethod.TOKOPAY,
        amount: order!.totalAmount,
        currency: order!.currency,
        status: "PENDING",
        providerTransactionId: "TP-999",
      },
    });

    const res = await post("/api/settlements", {
      ...batchBody,
      lines: [{ amount: "1000000", providerTransactionId: "TP-999" }],
    });

    expect(res.statusCode).toBe(200);
    const line = await prisma.settlementTransaction.findFirstOrThrow({});
    expect(line.paymentId).toBe(payment.id);
    expect(line.matchedAt).not.toBeNull();
  });

  it("422s an inconsistent batch with the service's own error key, recording nothing", async () => {
    const res = await post("/api/settlements", { ...batchBody, netAmount: "900000" });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("error.settlement_amounts_inconsistent");
    await expectNothingRecorded();
  });

  // P2: the same refusal, read as the panel reads it. This key's copy is "does
  // not add up: {netAmount} net plus {feeAmount} fee is not {grossAmount} gross
  // {currency}" — four figures the service already attaches to the error and
  // this route used to drop, leaving the admin with a bare `error.` key and no
  // way to tell which of the three numbers they mistyped. `errorBody`
  // (@app/core/errorBody) is what puts them on the wire.
  it("sends the figures the refusal's own copy names, so the panel can print them", async () => {
    const res = await post("/api/settlements", { ...batchBody, netAmount: "900000" });

    expect(res.json()).toEqual({
      error: "error.settlement_amounts_inconsistent",
      error_args: {
        netAmount: "900000",
        feeAmount: "23500",
        grossAmount: "1000000",
        currency: "IDR",
      },
    });
  });

  // The other half of the contract: a body only grows `error_args` when the
  // sentence asked for something. `error.settlement_provider_unknown` names
  // `{provider}` and gets it; a placeholder-free key must stay a one-field body,
  // or every response reader and `toEqual` in this suite has to account for a
  // constant empty object.
  it("adds nothing to a refusal whose copy quotes no figure", async () => {
    const named = await post("/api/settlements", { ...batchBody, provider: "A_MAN_WITH_A_BRIEFCASE" });
    expect(named.json()).toEqual({
      error: "error.settlement_provider_unknown",
      error_args: { provider: "A_MAN_WITH_A_BRIEFCASE" },
    });

    // `error.settlement_amount_not_a_number` reads "The settlement amount in
    // {field} is not a valid, finite number" — so it too names one figure, and
    // the truly placeholder-free case is the route's own pre-service 400s, which
    // send an English sentence rather than a key at all.
    const missingDate = await post("/api/settlements", { ...batchBody, settlementDate: "" });
    expect(Object.keys(missingDate.json() as object)).toEqual(["error"]);
  });

  it("422s a non-finite amount rather than letting it reach a money column", async () => {
    for (const bad of ["NaN", "Infinity", "one million"]) {
      const res = await post("/api/settlements", { ...batchBody, grossAmount: bad });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { error: string }).error).toBe("error.settlement_amount_not_a_number");
    }
    await expectNothingRecorded();
  });

  it("422s a provider this shop does not use", async () => {
    const res = await post("/api/settlements", { ...batchBody, provider: "A_MAN_WITH_A_BRIEFCASE" });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("error.settlement_provider_unknown");
    await expectNothingRecorded();
  });

  it("400s a missing provider, currency or date before reaching the service", async () => {
    const noProvider = await post("/api/settlements", { ...batchBody, provider: "  " });
    const noCurrency = await post("/api/settlements", { ...batchBody, currency: "" });
    const noDate = await post("/api/settlements", { ...batchBody, settlementDate: "" });
    const badDate = await post("/api/settlements", { ...batchBody, settlementDate: "the ides of March" });

    expect([noProvider.statusCode, noCurrency.statusCode, noDate.statusCode, badDate.statusCode]).toEqual([
      400, 400, 400, 400,
    ]);
    await expectNothingRecorded();
  });

  it("treats an omitted fee as zero, which is a real answer for a hand-entered batch", async () => {
    const res = await post("/api/settlements", {
      ...batchBody,
      feeAmount: undefined,
      netAmount: "1000000",
    });

    expect(res.statusCode).toBe(200);
    const settlement = await prisma.settlement.findFirstOrThrow({});
    expect(new Decimal(settlement.feeAmount).isZero()).toBe(true);
  });

  it("rejects a request with no CSRF token, recording nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/settlements",
      payload: batchBody,
      cookies: { [COOKIE]: cookie },
    });

    expect(res.statusCode).toBe(403);
    await expectNothingRecorded();
  });

  it("rejects a request with a WRONG CSRF token, recording nothing", async () => {
    const res = await post("/api/settlements", batchBody, { "x-csrf-token": "not-the-token" });

    expect(res.statusCode).toBe(403);
    await expectNothingRecorded();
  });

  it("redirects an unauthenticated request to the login page", async () => {
    const res = await app.inject({ method: "POST", url: "/api/settlements", payload: batchBody });

    expect(res.statusCode).toBe(303);
    await expectNothingRecorded();
  });
});

/**
 * RBAC. `/api/settlements` is in `CONFIG_PREFIXES` (plugins/auth.ts), so only
 * `super` may record a batch — the same tier as adjusting a wallet by hand,
 * deliberately NOT the operational tier `support` shares for `/api/orders`.
 * Both the refusal and the grant are asserted: a prefix list that has drifted
 * away from the live paths looks identical to one that is right if only the
 * refusals are tested.
 *
 * The role is resolved per request from the `web_admin_role:<telegramId>`
 * Setting, so flipping it on the session already in hand is enough.
 */
describe("RBAC on recording a settlement", () => {
  const setRole = (role: string) => setSetting(prisma, webRoleKey(ADMIN_TG), role);

  it("403s a support admin — settling the books is not an operational action", async () => {
    await setRole("support");

    const res = await post("/api/settlements", batchBody);

    expect(res.statusCode).toBe(403);
    await expectNothingRecorded();
  });

  it("403s a readonly admin", async () => {
    await setRole("readonly");

    const res = await post("/api/settlements", batchBody);

    expect(res.statusCode).toBe(403);
    await expectNothingRecorded();
  });

  it("allows a super admin — the role this surface exists for", async () => {
    await setRole("super");

    const res = await post("/api/settlements", batchBody);

    expect(res.statusCode).toBe(200);
    expect(await prisma.settlement.count()).toBe(1);
  });

  it("lets every authenticated role READ the list, matching Payments and Wallet Ledger", async () => {
    expect((await post("/api/settlements", batchBody)).statusCode).toBe(200);

    for (const role of ["support", "readonly"]) {
      await setRole(role);
      const res = await get("/api/settlements");
      expect(res.statusCode, `role ${role} could not read the settlement list`).toBe(200);
      expect((res.json() as { settlements: unknown[] }).settlements).toHaveLength(1);
    }
  });
});

describe("GET /api/settlements", () => {
  async function record(overrides: Record<string, unknown>) {
    const res = await post("/api/settlements", { ...batchBody, ...overrides });
    expect(res.statusCode).toBe(200);
    return (res.json() as { settlementId: number }).settlementId;
  }

  it("sends amounts as Decimal strings with a display date, newest settlement first", async () => {
    const older = await record({ batchReference: "OLD", settlementDate: "2026-08-01" });
    const newer = await record({ batchReference: "NEW", settlementDate: "2026-09-15" });

    const res = await get("/api/settlements");

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      settlements: {
        id: number;
        grossAmount: string;
        feeAmount: string;
        netAmount: string;
        settlementDateDisplay: string;
        lineCount: number;
        postingId: number | null;
      }[];
      total: number;
      providers: string[];
      currencies: string[];
    };
    expect(body.total).toBe(2);
    expect(body.settlements.map((s) => s.id)).toEqual([newer, older]);
    expect(body.settlements[0]!.grossAmount).toBe("1000000");
    expect(body.settlements[0]!.netAmount).toBe("976500");
    expect(body.settlements[0]!.feeAmount).toBe("23500");
    expect(body.settlements[0]!.settlementDateDisplay).toEqual(expect.any(String));
    expect(body.settlements[0]!.postingId).not.toBeNull();
    expect(body.providers).toContain(PaymentMethod.TOKOPAY);
    expect(body.currencies).toEqual(["IDR", "USDT"]);
  });

  it("filters by provider and pages", async () => {
    await record({});
    await record({
      provider: PaymentMethod.NOWPAYMENTS,
      currency: "USDT",
      grossAmount: "100",
      feeAmount: "1",
      netAmount: "99",
    });

    const filtered = await get(`/api/settlements?provider=${PaymentMethod.NOWPAYMENTS}`);
    expect((filtered.json() as { total: number }).total).toBe(1);

    const paged = await get("/api/settlements?pageSize=20&page=2");
    expect((paged.json() as { settlements: unknown[]; hasNext: boolean }).settlements).toHaveLength(0);
    expect((paged.json() as { hasNext: boolean }).hasNext).toBe(false);
  });

  it("redirects an unauthenticated read to the login page", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settlements" });
    expect(res.statusCode).toBe(303);
  });
});
