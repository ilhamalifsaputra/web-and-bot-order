// Follow-up to guest checkout: the recovery email that carries the order code.
//
// A guest's only two ways back into a paid order are the 30-day session cookie
// and `POST /api/v1/track` (order code + email). Before this feature the code
// existed ONLY on screen, so closing the tab and losing the cookie lost the
// order for good. These tests pin the three properties that make the email
// worth having AND safe to have:
//
//   1. it actually carries the order code, to the address the buyer gave;
//   2. it never carries delivered product content or credentials — email is
//      unencrypted and lives in an inbox forever;
//   3. it can never cost the buyer their order. Unconfigured SMTP, a throwing
//      transport — both still end in a normal 201.
//
// Pattern: guest-checkout-api.test.ts — app.inject() against an isolated temp
// DB. `@app/core/mailer` is mocked the same way storefront.test.ts mocks it for
// the password-reset path.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@app/core/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { sendMail } from "@app/core/mailer";
import { cleanupTestDb } from "./setup-env";
import { prisma, initDb, setSetting, createCatalogProduct, createDenomination, addToCart } from "@app/db";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";
import { CART_COOKIE, CART_COOKIE_VERSION } from "../src/shop";
import { SHOP_COOKIE_NAME } from "../src/auth";

let app: FastifyInstance;
let denomId: number;

/** The exact string sitting in every StockItem of the fixture product. If this
 * ever shows up in an email body, delivered content has leaked into an inbox. */
const STOCK_CREDENTIALS = "leaked-user@vendor.test:sup3r-secret-passphrase";

/** The versioned guest-cart cookie, encoded exactly as writeGuestCart writes it. */
function cartCookie(items: Array<{ p: number; q: number }>): string {
  return `${CART_COOKIE}=` + encodeURIComponent(JSON.stringify({ v: CART_COOKIE_VERSION, items }));
}

/** A distinct simulated client IP per test, so one test's guest-checkout quota
 * can never spill into another's (the limiter is process-wide). */
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

const mockedSendMail = sendMail as unknown as ReturnType<typeof vi.fn>;

/** The single `sendMail(creds, args)` call's `args`, asserted to exist. */
function onlyMailArgs(): { to: string; subject: string; text: string } {
  expect(mockedSendMail).toHaveBeenCalledTimes(1);
  return mockedSendMail.mock.calls[0]![1] as { to: string; subject: string; text: string };
}

/** One end-to-end anonymous checkout on a live gateway. Returns the raw reply. */
function guestCheckout(email: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { cookie: cartCookie([{ p: denomId, q: 1 }]), "x-forwarded-for": freshIp() },
    payload: { method: "bybit", guest_email: email },
  });
}

async function loginAs(identifier: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  expect(res.statusCode).toBe(200);
  const c = res.headers["set-cookie"];
  const cookie = Array.isArray(c) ? c.join("; ") : String(c);
  const shell = await app.inject({ method: "GET", url: "/spa-shell-probe", headers: { cookie } });
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(shell.body)![1]!;
  expect(csrf).not.toBe("");
  return { cookie, csrf };
}

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Mail Cat", slug: "mail-cat", emoji: "📮", sortOrder: 1 },
  });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Mail Product" });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "1 Month",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "40000",
  });
  denomId = denom.id;
  await prisma.stockItem.createMany({
    data: Array.from({ length: 20 }, () => ({
      productId: denomId,
      credentials: STOCK_CREDENTIALS,
      status: "AVAILABLE",
    })),
  });
  // One live gateway (bybit) so the happy path reaches performCheckout's success.
  await setSetting(prisma, "bybit_uid", "123456789");
  await setSetting(prisma, "bybit_api_key", "k");
  await setSetting(prisma, "bybit_api_secret", "s");
  await setSetting(prisma, "usd_idr_rate", "16000");
  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "Mail Test Shop");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

beforeEach(() => {
  mockedSendMail.mockReset();
  mockedSendMail.mockResolvedValue(undefined);
});

describe("guest checkout emails the order code when SMTP is configured", () => {
  it("sends exactly one mail, to the address the guest gave, carrying the order code and both recovery links", async () => {
    const res = await guestCheckout("Recovery.Guest@Example.COM");
    expect(res.statusCode).toBe(201);
    const orderCode = res.json().order_code as string;

    const args = onlyMailArgs();
    // Normalised the same way the guest row stores it — the mail must reach the
    // address on the order, not the raw casing typed into the form.
    expect(args.to).toBe("recovery.guest@example.com");
    expect(args.subject).toContain("Mail Test Shop");
    expect(args.text).toContain(orderCode);
    // The order page (direct way back) and /track (the way back once the cookie
    // is gone) — both absolute, because a mail client has no page to resolve
    // a relative path against.
    expect(args.text).toContain(`https://shop.test.invalid/checkout/${orderCode}/pay`);
    expect(args.text).toContain("https://shop.test.invalid/track");
  });

  it("writes the mail in English and Indonesian, like the password-reset mail", async () => {
    await guestCheckout("bilingual.guest@example.com");
    const { text } = onlyMailArgs();
    expect(text).toMatch(/order code/i);
    expect(text).toMatch(/kode pesanan/i);
  });

  it("never puts delivered product content or credentials in the mail", async () => {
    const res = await guestCheckout("nocreds.guest@example.com");
    const orderCode = res.json().order_code as string;

    const { text, subject } = onlyMailArgs();
    const body = `${subject}\n${text}`;
    expect(body).not.toContain(STOCK_CREDENTIALS);
    expect(body).not.toContain("sup3r-secret-passphrase");
    expect(body).not.toContain("leaked-user@vendor.test");
    // Nothing was delivered yet either way, but the assertion above is only
    // meaningful if the mail really is about this order.
    expect(text).toContain(orderCode);
  });

  it("reports email_sent: true on the guest 201, alongside the existing keys", async () => {
    const res = await guestCheckout("flagged.guest@example.com");
    expect(res.statusCode).toBe(201);
    expect(res.json().email_sent).toBe(true);
    expect(res.json().order_code).toEqual(expect.any(String));
    expect(typeof res.json().csrf_token).toBe("string");
  });
});

describe("the order survives every way the mail can fail", () => {
  it("skips the mail silently and reports email_sent: false when SMTP is unconfigured", async () => {
    const originalHost = config.SMTP_HOST;
    config.SMTP_HOST = undefined; // no DB smtp_host row either -> getSmtpCreds returns null
    try {
      const res = await guestCheckout("nosmtp.guest@example.com");
      expect(res.statusCode).toBe(201);
      expect(res.json().email_sent).toBe(false);
      expect(res.json().order_code).toEqual(expect.any(String));
      expect(mockedSendMail).not.toHaveBeenCalled();

      // The order is real, and it belongs to the guest row.
      const guest = await prisma.user.findFirst({ where: { guestEmail: "nosmtp.guest@example.com" } });
      const order = await prisma.order.findFirst({ where: { orderCode: res.json().order_code } });
      expect(order).not.toBeNull();
      expect(order!.userId).toBe(guest!.id);
    } finally {
      config.SMTP_HOST = originalHost;
    }
  });

  it("still creates the order and 201s with email_sent: false when sendMail throws, with no unhandled rejection", async () => {
    mockedSendMail.mockRejectedValue(new Error("smtp connection refused"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await guestCheckout("throwing.guest@example.com");
      expect(res.statusCode).toBe(201);
      expect(res.json().email_sent).toBe(false);
      expect(mockedSendMail).toHaveBeenCalledTimes(1);

      const guest = await prisma.user.findFirst({ where: { guestEmail: "throwing.guest@example.com" } });
      const order = await prisma.order.findFirst({ where: { orderCode: res.json().order_code } });
      expect(order).not.toBeNull();
      expect(order!.userId).toBe(guest!.id);

      // Give the rejection a full macrotask turn to surface if it was never caught.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("registered buyers are untouched", () => {
  it("sends no mail and keeps the signed-in 201 body exactly { order_code, pay_url }", async () => {
    const user = await prisma.user.create({
      data: {
        loginUsername: "mailregular",
        email: "mailregular@u.test",
        passwordHash: hashPassword("mailregular-pw-1"),
        referralCode: "MAILRG",
      },
    });
    const { cookie, csrf } = await loginAs("mailregular", "mailregular-pw-1");
    await addToCart(prisma, user.id, denomId, 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { method: "bybit" },
    });
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json()).sort()).toEqual(["order_code", "pay_url"]);
    expect(mockedSendMail).not.toHaveBeenCalled();
  });
});

describe("a guest whose first attempt failed still gets the mail on the retry", () => {
  // The retry after a failed guest checkout arrives WITH the session the failed
  // attempt minted, so the route takes its signed-in branch — but the buyer is
  // still a guest row with no account and no "My orders" page. Keying the mail
  // on the session's origin instead of the buyer's row would leave exactly the
  // shopper this feature exists for without a copy of their code.
  it("mails the code even though the request took the signed-in branch", async () => {
    // `qris` needs TokoPay creds this suite never sets: performCheckout throws,
    // but only after the guest user and session already exist.
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie: cartCookie([{ p: denomId, q: 1 }]), "x-forwarded-for": freshIp() },
      payload: { method: "qris", guest_email: "retrying.guest@example.com" },
    });
    expect(failed.statusCode).toBe(400);
    expect(mockedSendMail).not.toHaveBeenCalled(); // no order, nothing to recover

    const setCookie = failed.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    const session = cookies.find((c) => c.startsWith(`${SHOP_COOKIE_NAME}=`))!.split(";")[0]!;

    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/checkout",
      headers: { cookie: session, "x-csrf-token": failed.json().csrf_token },
      payload: { method: "bybit" },
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().email_sent).toBe(true);

    const args = onlyMailArgs();
    expect(args.to).toBe("retrying.guest@example.com");
    expect(args.text).toContain(retry.json().order_code);
  });
});
