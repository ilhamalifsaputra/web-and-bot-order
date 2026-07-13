import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createCategory, createCatalogProduct, createDenomination, bulkAddStock, createOrderDirect } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;

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
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

async function seedDenomination() {
  const category = await createCategory(prisma, "Cat");
  const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent" });
  const denom = await createDenomination(prisma, { productId: parent.id, name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "10000" });
  return denom.id;
}

/** Same as seedDenomination but also returns the category/product ids, needed
 * by the re-parenting tests to build a sibling (same-category) or
 * cross-category product to move the denomination to/from. */
async function seedDenominationWithContext() {
  const category = await createCategory(prisma, "Cat");
  const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent" });
  const denom = await createDenomination(prisma, { productId: parent.id, name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "10000" });
  return { denomId: denom.id, productId: parent.id, categoryId: category.id };
}

function patchJson(url: string, c: string | null, csrfToken: string, body: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
    payload: JSON.stringify(body),
  });
}
function del(url: string, c: string | null, csrfToken: string) {
  return app.inject({
    method: "DELETE",
    url,
    headers: { "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
  });
}

describe("PATCH /api/catalog/denominations/:id", () => {
  it("happy path: updates the denomination and audits", async () => {
    const id = await seedDenomination();
    const res = await patchJson(`/api/catalog/denominations/${id}`, cookie, csrf, {
      name: "1 Month Plus",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "12000",
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.denomination.findUnique({ where: { id } });
    expect(row!.name).toBe("1 Month Plus");
    expect(row!.price.toString()).toBe("12000");
    const audit = await prisma.auditLog.findFirst({ where: { action: "denomination_update", targetId: id } });
    expect(audit).toBeTruthy();
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const id = await seedDenomination();
    const res = await patchJson(`/api/catalog/denominations/${id}`, null, csrf, { name: "Hacked", type: "SHARED", durationLabel: "1 Month", price: "1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.denomination.findUnique({ where: { id } }))!.name).toBe("1 Month");
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const id = await seedDenomination();
    const res = await patchJson(`/api/catalog/denominations/${id}`, cookie, "bad", { name: "Hacked", type: "SHARED", durationLabel: "1 Month", price: "1" });
    expect(res.statusCode).toBe(403);
    expect((await prisma.denomination.findUnique({ where: { id } }))!.name).toBe("1 Month");
  });
});

describe("PATCH /api/catalog/denominations/:id — deliveryType/additionalFields", () => {
  it("updates a SKU's delivery type to manual (no fields required)", async () => {
    const id = await seedDenomination();
    const res = await patchJson(`/api/catalog/denominations/${id}`, cookie, csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      deliveryType: "manual",
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.denomination.findUnique({ where: { id } });
    expect(row!.deliveryType).toBe("manual");
    expect(row!.additionalFields).toBeNull();
  });

  it("updates a SKU to manual_with_info with valid fields and round-trips additionalFields through GET /api/catalog/:productId", async () => {
    const { denomId, productId } = await seedDenominationWithContext();
    const fields = [
      {
        key: "email",
        label: { id: "Email", en: "Email" },
        type: "email",
        required: true,
        options: [],
        placeholder: "you@example.com",
      },
    ];
    const res = await patchJson(`/api/catalog/denominations/${denomId}`, cookie, csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      deliveryType: "manual_with_info",
      additionalFields: fields,
    });
    expect(res.statusCode).toBe(200);

    const detail = await app.inject({ method: "GET", url: `/api/catalog/${productId}`, cookies: { [COOKIE]: cookie } });
    const body = detail.json() as {
      product: { denominations: { id: number; deliveryType: string; additionalFields: string | null }[] };
    };
    const denom = body.product.denominations.find((d) => d.id === denomId)!;
    expect(denom.deliveryType).toBe("manual_with_info");
    expect(JSON.parse(denom.additionalFields!)).toEqual(fields);
  });

  it("rejects updating to manual_with_info with zero fields (400) and leaves the row unchanged", async () => {
    const id = await seedDenomination();
    const res = await patchJson(`/api/catalog/denominations/${id}`, cookie, csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      deliveryType: "manual_with_info",
      additionalFields: [],
    });
    expect(res.statusCode).toBe(400);
    const row = await prisma.denomination.findUnique({ where: { id } });
    expect(row!.deliveryType).toBe("auto");
  });

  it("rejects an invalid deliveryType with 400", async () => {
    const id = await seedDenomination();
    const res = await patchJson(`/api/catalog/denominations/${id}`, cookie, csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      deliveryType: "bogus",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects updating to manual_with_info when additionalFields is a pre-stringified JSON string instead of an array (400) and leaves the row unchanged", async () => {
    // Pins the client/server contract from the server side, mirroring the
    // equivalent POST test in web.test.ts: the route expects additionalFields
    // to already be a decoded array (zAdditionalFields = z.array(...)). A
    // caller that JSON.stringify()s the array before sending it — the bug
    // that made the real admin edit form double-encode this field and fail
    // every manual_with_info save with a 400 — must be rejected here too.
    const id = await seedDenomination();
    const fields = [
      { key: "email", label: { id: "Email", en: "Email" }, type: "email", required: true, options: [], placeholder: "" },
    ];
    const res = await patchJson(`/api/catalog/denominations/${id}`, cookie, csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      deliveryType: "manual_with_info",
      additionalFields: JSON.stringify(fields),
    });
    expect(res.statusCode).toBe(400);
    const row = await prisma.denomination.findUnique({ where: { id } });
    expect(row!.deliveryType).toBe("auto");
  });

  it("a partial PATCH that omits deliveryType leaves the existing delivery config in place instead of resetting it to auto", async () => {
    // Regression test for the secondary review finding: deliveryType/
    // additionalFields must follow the same partial-update convention as
    // warrantyDays/sortOrder (only touched when the request actually
    // provides a value) so a future partial-update caller (e.g. a bulk-edit
    // tool) can't silently wipe a SKU's delivery configuration.
    const { denomId } = await seedDenominationWithContext();
    const fields = [
      { key: "email", label: { id: "Email", en: "Email" }, type: "email", required: true, options: [], placeholder: "" },
    ];
    const setup = await patchJson(`/api/catalog/denominations/${denomId}`, cookie, csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      deliveryType: "manual_with_info",
      additionalFields: fields,
    });
    expect(setup.statusCode).toBe(200);

    // A partial update that touches only sortOrder — same shape a bulk-edit
    // tool would send — omits deliveryType/additionalFields entirely.
    const res = await patchJson(`/api/catalog/denominations/${denomId}`, cookie, csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      sortOrder: "3",
    });
    expect(res.statusCode).toBe(200);

    const row = await prisma.denomination.findUnique({ where: { id: denomId } });
    expect(row!.sortOrder).toBe(3);
    expect(row!.deliveryType).toBe("manual_with_info");
    expect(JSON.parse(row!.additionalFields!)).toEqual(fields);
  });
});

describe("DELETE /api/catalog/denominations/:id", () => {
  it("happy path: deletes the denomination and audits", async () => {
    const id = await seedDenomination();
    const res = await del(`/api/catalog/denominations/${id}`, cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(await prisma.denomination.findUnique({ where: { id } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "denomination_delete", targetId: id } });
    expect(audit).toBeTruthy();
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const id = await seedDenomination();
    const res = await del(`/api/catalog/denominations/${id}`, null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect(await prisma.denomination.findUnique({ where: { id } })).not.toBeNull();
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const id = await seedDenomination();
    const res = await del(`/api/catalog/denominations/${id}`, cookie, "bad");
    expect(res.statusCode).toBe(403);
    expect(await prisma.denomination.findUnique({ where: { id } })).not.toBeNull();
  });

  it("refuses to delete a denomination with order history (409) and writes nothing", async () => {
    const id = await seedDenomination();
    await bulkAddStock(prisma, id, ["cred1"]);
    const buyer = await upsertUser(prisma, { telegramId: 12345, username: "buyer", fullName: "Buyer" });
    await createOrderDirect(prisma, { user: buyer, productId: id, quantity: 1 });
    const res = await del(`/api/catalog/denominations/${id}`, cookie, csrf);
    expect(res.statusCode).toBe(409);
    expect(await prisma.denomination.findUnique({ where: { id } })).not.toBeNull();
  });
});

describe("PATCH /api/catalog/products/:id", () => {
  it("happy path: updates the product's name/description and audits", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Old Name" });
    const res = await patchJson(`/api/catalog/products/${product.id}`, cookie, csrf, {
      name: "New Name",
      description: "New description",
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.product.findUnique({ where: { id: product.id } });
    expect(row!.name).toBe("New Name");
    expect(row!.description).toBe("New description");
    const audit = await prisma.auditLog.findFirst({ where: { action: "product_update", targetId: product.id } });
    expect(audit).toBeTruthy();
  });

  it("rejects an empty name with 400", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Old Name" });
    const res = await patchJson(`/api/catalog/products/${product.id}`, cookie, csrf, { name: "  " });
    expect(res.statusCode).toBe(400);
    expect((await prisma.product.findUnique({ where: { id: product.id } }))!.name).toBe("Old Name");
  });

  it("404s for a non-existent product", async () => {
    const res = await patchJson(`/api/catalog/products/999999`, cookie, csrf, { name: "X" });
    expect(res.statusCode).toBe(404);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Old Name" });
    const res = await patchJson(`/api/catalog/products/${product.id}`, null, csrf, { name: "Hacked" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.product.findUnique({ where: { id: product.id } }))!.name).toBe("Old Name");
  });

  it("rejects bad CSRF (403)", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Old Name" });
    const res = await patchJson(`/api/catalog/products/${product.id}`, cookie, "bad", { name: "Hacked" });
    expect(res.statusCode).toBe(403);
    expect((await prisma.product.findUnique({ where: { id: product.id } }))!.name).toBe("Old Name");
  });
});

describe("PATCH /api/catalog/denominations/:id — re-parenting and sortOrder", () => {
  it("moving to a sibling product in the SAME category succeeds", async () => {
    const { denomId, productId, categoryId } = await seedDenominationWithContext();
    const sibling = await createCatalogProduct(prisma, { categoryId, name: "Sibling" });

    const res = await patchJson(`/api/catalog/denominations/${denomId}`, cookie, csrf, {
      name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "10000",
      productId: sibling.id,
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.denomination.findUnique({ where: { id: denomId } });
    expect(row!.productId).toBe(sibling.id);
    expect(row!.productId).not.toBe(productId);
  });

  it("moving to a product in a DIFFERENT category is rejected (422), productId unchanged", async () => {
    const { denomId, productId } = await seedDenominationWithContext();
    const otherCategory = await createCategory(prisma, "Other Cat");
    const otherProduct = await createCatalogProduct(prisma, { categoryId: otherCategory.id, name: "Cross-category" });

    const res = await patchJson(`/api/catalog/denominations/${denomId}`, cookie, csrf, {
      name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "10000",
      productId: otherProduct.id,
    });
    expect(res.statusCode).toBe(422);
    const row = await prisma.denomination.findUnique({ where: { id: denomId } });
    expect(row!.productId).toBe(productId);
  });

  it("accepts sortOrder and persists it, changing the product-detail list order", async () => {
    const { denomId, productId } = await seedDenominationWithContext();
    const other = await createDenomination(prisma, {
      productId, name: "OtherDenom", type: "SHARED", durationLabel: "1 Month", price: "5000", sortOrder: 0,
    });

    const res = await patchJson(`/api/catalog/denominations/${denomId}`, cookie, csrf, {
      name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "10000", sortOrder: "10",
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.denomination.findUnique({ where: { id: denomId } });
    expect(row!.sortOrder).toBe(10);

    const detail = await app.inject({ method: "GET", url: `/api/catalog/${productId}`, cookies: { [COOKIE]: cookie } });
    const body = detail.json() as { product: { denominations: { id: number }[] } };
    const ids = body.product.denominations.map((d) => d.id);
    expect(ids.indexOf(other.id)).toBeLessThan(ids.indexOf(denomId));
  });
});
