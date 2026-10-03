import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti, webRoleKey } from "../src/auth";
import { buildApp } from "../src/server";

/**
 * Every admin route that takes a numeric id in its path must answer a
 * malformed id with a 400 and the usual `{ error }` body — never let NaN,
 * a fraction or a negative number reach Prisma, where it throws and the
 * request ends as a 500.
 */

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
  await setSetting(prisma, webRoleKey(ADMIN_TG), "super");
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

type Method = "GET" | "POST" | "DELETE";
const ROUTES: [Method, string][] = [
  ["GET", "/api/orders/:id"],
  ["POST", "/api/orders/:id/reveal"],
  ["POST", "/api/orders/:id/approve"],
  ["POST", "/api/orders/:id/resend"],
  ["POST", "/api/orders/:id/reject"],
  ["POST", "/api/orders/:id/credit-balance"],
  ["POST", "/api/orders/:id/fulfill"],
  ["POST", "/api/orders/:id/cancel"],
  ["POST", "/api/payments/order/:id/deliver"],
  ["POST", "/api/payments/order/:id/refund"],
  ["POST", "/api/payments/order/:id/credit-anyway"],
  ["POST", "/api/payments/order/:id/cancel"],
  ["GET", "/api/users/:id"],
  ["POST", "/api/users/:id/role"],
  ["POST", "/api/users/:id/ban"],
  ["POST", "/api/users/:id/wallet"],
  ["GET", "/api/stock/:id"],
  ["POST", "/api/stock/:id/bulk-add"],
  ["POST", "/api/stock/:id/broadcast"],
  ["POST", "/api/stock/:id/bulk-dead"],
  ["POST", "/api/stock/:id/bulk-delete"],
  ["POST", "/api/stock/item/:id/dead"],
  ["POST", "/api/stock/item/:id/delete"],
  ["POST", "/api/stock/item/:id/note"],
  ["GET", "/api/stock/item/:id/history"],
  ["POST", "/api/stock/item/:id/reveal"],
  ["GET", "/api/stock/:id/download"],
  ["POST", "/api/reviews/:id/hide"],
  ["POST", "/api/reviews/:id/reply"],
  ["DELETE", "/api/reviews/:id/reply"],
  ["POST", "/api/reviews/:id/status"],
  ["DELETE", "/api/reviews/:id"],
  ["GET", "/api/support/:id"],
  ["POST", "/api/support/:id/reply"],
  ["POST", "/api/support/:id/close"],
  ["POST", "/api/support/:id/assign"],
  ["POST", "/api/support/:id/priority"],
  ["POST", "/api/support/:id/resolve"],
  ["POST", "/api/support/:id/reopen"],
  ["POST", "/api/support/:id/classify"],
  ["POST", "/api/vouchers/:id/update"],
  ["POST", "/api/vouchers/:id/toggle"],
  ["POST", "/api/vouchers/:id/delete"],
  ["POST", "/api/broadcast/:id/cancel"],
  ["POST", "/api/broadcast/:id/queue"],
  ["POST", "/api/broadcast/:id/delete"],
  ["POST", "/api/admins/:id/role"],
  ["POST", "/api/admins/:id/logout"],
  ["POST", "/api/outbox/:id/retry"],
  ["POST", "/api/orders/:id/credit-overpayment"],
  ["POST", "/api/orders/:id/items/1/replace"],
  ["POST", "/api/orders/1/items/:id/replace"],
  ["POST", "/api/orders/:id/replacements/1/retry"],
  ["POST", "/api/orders/1/replacements/:id/retry"],
  ["POST", "/api/orders/:id/replacements/1/refund"],
  ["POST", "/api/orders/1/replacements/:id/refund"],
];

const BAD_IDS = ["abc", "1.5", "-1", "0", "1e3", "99999999999"];

describe("admin routes reject malformed path ids with 400", () => {
  for (const [method, pattern] of ROUTES) {
    it(`${method} ${pattern}`, async () => {
      // Telegram ids legitimately exceed the 32-bit DB id ceiling.
      const bads = pattern.startsWith("/api/admins/") ? BAD_IDS.filter((b) => b !== "99999999999") : BAD_IDS;
      for (const bad of bads) {
        const url = pattern.replace(":id", encodeURIComponent(bad));
        const res = await app.inject({
          method,
          url,
          headers:
            method === "GET"
              ? {}
              : { "content-type": "application/json", "x-csrf-token": csrf },
          cookies: { [COOKIE]: cookie },
          ...(method === "GET" ? {} : { payload: "{}" }),
        });
        expect({ bad, status: res.statusCode }).toEqual({ bad, status: 400 });
        expect(typeof res.json().error).toBe("string");
      }
    });
  }
});
