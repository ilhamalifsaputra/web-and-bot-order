import "./setup-env";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, setSetting, getSetting, emailPolicyKey, upsertUser } from "@app/db";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeSession, newJti, sessionJtiKey, webRoleKey } from "../src/auth";
import { buildApp } from "../src/server";
let app: FastifyInstance, cookie: string, csrf: string, sample: SampleData;
beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => {
  await resetDb(prisma); sample = await buildSampleData(prisma);
  const admin = await upsertUser(prisma, { telegramId: 999, fullName: "Admin", username: "admin" });
  const jti = newJti(); await setSetting(prisma, sessionJtiKey(999), jti);
  const session = makeSession(admin.id, 999, jti); cookie = session.raw; csrf = session.data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});
const get = (path = "", authenticated = true) => app.inject({ method: "GET", url: `/api/settings/email-notifications${path}`, cookies: authenticated ? { [config.WEB_COOKIE_NAME]: cookie } : {} });
const post = (body: unknown, path = "", token = csrf) => app.inject({ method: "POST", url: `/api/settings/email-notifications${path}`, headers: { "x-csrf-token": token }, cookies: { [config.WEB_COOKIE_NAME]: cookie }, payload: body });

describe("email preferences API", () => {
  it("returns all 23 source events, locks recovery and preserves boolean values after refresh", async () => {
    expect((await get("", false)).statusCode).toBe(401);
    const initial = (await get()).json(); expect(initial.events).toHaveLength(23);
    expect(initial.events.find((row: { key: string }) => row.key === "account.password_reset.requested")).toEqual(expect.objectContaining({ mandatory: true, enabled: true }));
    expect((await post({ key: "order.received.customer", enabled: "true" })).statusCode).toBe(400);
    expect((await post({ key: "account.password_reset.requested", enabled: false })).statusCode).toBe(400);
    expect((await post({ key: "order.received.customer", enabled: true })).statusCode).toBe(200);
    expect((await get()).json().events.find((row: { key: string }) => row.key === "order.received.customer").enabled).toBe(true);
    expect(await getSetting(prisma, emailPolicyKey("order.received.customer"))).toBe("true");
    expect(await prisma.auditLog.count({ where: { action: "email_event_policy" } })).toBe(1);
  });
  it("previews all 23 source templates without creating business records or sending mail", async () => {
    const initial = (await get()).json();
    const before = await prisma.notificationOutbox.count();
    for (const event of initial.events) {
      const preview = await get(`/${event.key}/preview`);
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toEqual(expect.objectContaining({ preview: true, subject: expect.any(String), text: expect.any(String) }));
      expect(preview.json().text.length).toBeGreaterThan(30);
    }
    expect(await prisma.notificationOutbox.count()).toBe(before);
    expect(await prisma.passwordResetToken.count()).toBe(0);
    expect((await get("/unknown/preview")).statusCode).toBe(404);
    expect((await get("/order.received.customer/preview", false)).statusCode).toBe(401);
  });

  it("requires CSRF and authorized role for policy, schedule and inventory changes", async () => {
    expect((await post({ key: "order.received.customer", enabled: true }, "", "invalid")).statusCode).toBe(403);
    for (const role of ["support", "readonly"]) {
      await setSetting(prisma, webRoleKey(999), role);
      expect((await post({ key: "order.received.customer", enabled: true })).statusCode).toBe(403);
      expect((await post({ timezone: "UTC", dailyTime: "08:00", weeklyDay: 1, weeklyTime: "09:00" }, "/schedule")).statusCode).toBe(403);
      expect((await post({ critical: 2, recovery: 4 }, `/inventory/${sample.product.id}`)).statusCode).toBe(403);
    }
  });
  it("validates report times and does not reset an active report on duplicate enabled saves", async () => {
    expect((await post({ timezone: "Bad/Timezone", dailyTime: "25:00", weeklyDay: 8, weeklyTime: "00:00" }, "/schedule")).statusCode).toBe(400);
    const schedule = { timezone: "Asia/Jakarta", dailyTime: "08:30", weeklyDay: 1, weeklyTime: "09:30" };
    expect((await post(schedule, "/schedule")).statusCode).toBe(200);
    expect((await get()).json().schedule).toEqual(schedule);
    const key = "report.daily_sales_inventory", marker = `email_report_enabled_at:${key}`;
    expect((await post({ key, enabled: true })).statusCode).toBe(200);
    await setSetting(prisma, marker, "2026-10-01T00:00:00Z");
    expect((await post({ key, enabled: true })).statusCode).toBe(200);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: marker } })).value).toBe("2026-10-01T00:00:00Z");
  });
  it("accepts thresholds only for finite local stock and audits valid saves", async () => {
    const path = `/inventory/${sample.product.id}`;
    expect((await get(path)).json()).toEqual({ critical: 3, recovery: 4 });
    expect((await post({ critical: 3, recovery: 3 }, path)).statusCode).toBe(400);
    expect((await post({ critical: "2", recovery: 4 }, path)).statusCode).toBe(400);
    expect((await post({ critical: 2, recovery: 5 }, path)).statusCode).toBe(200);
    expect((await get(path)).json()).toEqual({ critical: 2, recovery: 5 });
    expect(await prisma.auditLog.count({ where: { action: "email_stock_thresholds" } })).toBe(1);
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { autoDeliverySource: "digiflazz" } });
    expect((await get(path)).statusCode).toBe(404);
    expect((await post({ critical: 2, recovery: 5 }, path)).statusCode).toBe(404);
  });
});
