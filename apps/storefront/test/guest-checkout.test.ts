// Task 2 (guest checkout): computeTotals/checkoutView must be able to price
// an anonymous visitor's cookie cart with the SAME math as a signed-in
// buyer's DB cart — one implementation, two sources of cart lines. The HTTP
// auth gate on /api/v1/checkout stays `requireCustomer` for this task (a
// later task opens it), so the guest path here is exercised by calling
// checkoutView directly with a hand-built FastifyRequest carrying the guest
// cart cookie, exactly the shape readGuestCart (src/shop.ts) reads.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  createCatalogProduct,
  createDenomination,
  updateDenomination,
  createVoucher,
  addToCart,
  getUserWithPasswordHash,
} from "@app/db";
import { VoucherType } from "@app/core/enums";
import { checkoutView } from "../src/routes/checkout";
import { CART_COOKIE, CART_COOKIE_VERSION } from "../src/shop";
import type { Customer } from "../src/plugins/auth";

let categoryId: number;

/** Minimal stand-in for a FastifyRequest — checkoutView/computeTotals only
 * read `req.cookies` on the guest branch (via readGuestCart), so that's all
 * this needs to provide. */
function guestReq(cookie?: string): FastifyRequest {
  return { cookies: cookie !== undefined ? { [CART_COOKIE]: cookie } : {} } as unknown as FastifyRequest;
}

/** Builds the versioned guest-cart cookie payload shop.ts's readGuestCart expects. */
function cartCookie(items: Array<{ p: number; q: number }>): string {
  return JSON.stringify({ v: CART_COOKIE_VERSION, items });
}

beforeAll(async () => {
  await initDb();
  const cat = await prisma.category.create({
    data: { name: "Guest Checkout Cat", slug: "guest-checkout-cat", emoji: "🛒", sortOrder: 1 },
  });
  categoryId = cat.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanupTestDb();
});

describe("checkoutView — guest visitor (Task 2)", () => {
  it("computes totals from the guest cart cookie at everyone pricing, not reseller pricing", async () => {
    const product = await createCatalogProduct(prisma, { categoryId, name: `Guest Product ${Math.random()}` });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "40000",
      resellerPrice: "10000", // deliberately far below the everyone price
    });

    const view = await checkoutView(guestReq(cartCookie([{ p: denom.id, q: 2 }])), null, null, null);

    expect(view.items_empty).toBe(false);
    expect(view.subtotal).toBe("80000"); // 2 x 40000 everyone price, never the 10000 reseller price
    expect(view.total).toBe("80000");
    expect(view.is_guest).toBe(true);
    expect(view.wallet_idr).toBe("0");
    expect(view.wallet_usdt).toBe("0");
    expect(view.wallet_idr_enabled).toBe(false);
    expect(view.wallet_usdt_enabled).toBe(false);
  });

  it("treats a missing or empty cart cookie as an empty cart", async () => {
    const noCookie = await checkoutView(guestReq(undefined), null, null, null);
    expect(noCookie.items_empty).toBe(true);
    expect(noCookie.items).toHaveLength(0);

    const emptyCookie = await checkoutView(guestReq(cartCookie([])), null, null, null);
    expect(emptyCookie.items_empty).toBe(true);
  });

  it("ignores a guest cart line pointing at an inactive denomination", async () => {
    const product = await createCatalogProduct(prisma, { categoryId, name: `Guest Inactive ${Math.random()}` });
    const activeDenom = await createDenomination(prisma, {
      productId: product.id,
      name: "Active",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
    });
    const inactiveDenom = await createDenomination(prisma, {
      productId: product.id,
      name: "Inactive",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "99999",
    });
    await updateDenomination(prisma, inactiveDenom.id, { isActive: false });

    const view = await checkoutView(
      guestReq(
        cartCookie([
          { p: activeDenom.id, q: 1 },
          { p: inactiveDenom.id, q: 1 },
        ]),
      ),
      null,
      null,
      null,
    );

    expect(view.items).toHaveLength(1);
    expect(view.items[0]!.denomination_id).toBe(activeDenom.id);
    expect(view.subtotal).toBe("10000"); // the inactive line's 99999 never counted
  });

  it("applies a valid voucher's discount to a guest cart", async () => {
    const product = await createCatalogProduct(prisma, { categoryId, name: `Guest Voucher ${Math.random()}` });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "50000",
    });
    await createVoucher(prisma, { code: "GUEST10", type: VoucherType.PERCENT, value: "10" });

    const view = await checkoutView(guestReq(cartCookie([{ p: denom.id, q: 1 }])), null, "GUEST10", null);

    expect(view.voucher_discount).toBe("5000");
    expect(view.total).toBe("45000");
    expect(view.error_key).toBeNull();
  });
});

describe("checkoutView — signed-in customer (Task 2 regression)", () => {
  it("keeps the exact same totals math and wallet fields for a signed-in buyer's DB cart", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const user = await prisma.user.create({
      data: {
        loginUsername: `regbuyer${suffix}`,
        email: `regbuyer${suffix}@u.test`,
        referralCode: `REG${suffix.toUpperCase()}`,
        walletBalance: "50000",
        walletBalanceUsdt: "12.5",
      },
    });
    const product = await createCatalogProduct(prisma, { categoryId, name: `Reg Product ${Math.random()}` });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "40000",
    });
    await addToCart(prisma, user.id, denom.id, 2);

    const userRow = await getUserWithPasswordHash(prisma, user.id);
    const customer: Customer = { userId: user.id, telegramId: null, jti: "test-jti", csrf: "test-csrf", user: userRow! };

    const view = await checkoutView(guestReq(undefined), customer, null, null);

    expect(view.items_empty).toBe(false);
    expect(view.subtotal).toBe("80000"); // 2 x 40000, unchanged by the guest-aware refactor
    expect(view.total).toBe("80000");
    expect(view.is_guest).toBe(false);
    expect(view.wallet_idr).toBe("50000");
    expect(view.wallet_usdt).toBe("12.5");
    expect(view.wallet_idr_enabled).toBe(true);
    expect(view.wallet_usdt_enabled).toBe(true);
  });
});
