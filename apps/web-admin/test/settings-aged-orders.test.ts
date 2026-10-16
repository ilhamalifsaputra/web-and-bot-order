import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import {
  prisma,
  initDb,
  upsertUser,
  setSetting,
  getSetting,
  UNDERPAID_AUTO_RESOLVE_HOURS_KEY,
  FAILED_ORDER_ALERT_HOURS_KEY,
} from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

/**
 * Backend audit A4: the owner sets the aged-UNDERPAID auto-refund limit and
 * the FAILED-order alert window through the ordinary settings route, as a
 * non-negative whole number of hours, audited like every other setting.
 */

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
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
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  adminId = admin.id;
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

const edit = (key: string, value: string) =>
  app.inject({
    method: "POST",
    url: "/api/settings/edit",
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    cookies: { [COOKIE]: cookie },
    payload: JSON.stringify({ key, value }),
  });

describe.each([UNDERPAID_AUTO_RESOLVE_HOURS_KEY, FAILED_ORDER_ALERT_HOURS_KEY])("POST /api/settings/edit — %s", (key) => {
  it.each([
    ["72", "72"],
    ["072", "72"],
    ["0", "0"],
    ["", ""],
  ])("accepts %j and stores %j, with an audit line naming the setting", async (typed, stored) => {
    const res = await edit(key, typed);
    expect(res.statusCode, res.body).toBe(200);
    expect(await getSetting(prisma, key)).toBe(stored);
    const audit = await prisma.auditLog.findMany({ where: { adminId, action: "setting_set" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toBe(`Changed setting "${key}" to "${stored}".`);
  });

  it.each(["-1", "1.5", "abc", "72h", "1e3"])("refuses %j and keeps the stored value", async (typed) => {
    await setSetting(prisma, key, "24");
    const res = await edit(key, typed);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("whole number of hours");
    expect(await getSetting(prisma, key)).toBe("24");
    expect(await prisma.auditLog.count({ where: { action: "setting_set" } })).toBe(0);
  });

  it("is listed by GET /api/settings so the owner can see it", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings", cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().fields.some((f: { key: string }) => f.key === key)).toBe(true);
  });
});
