import "./setup-env";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createHmac, createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { prisma, initDb, setSetting, createTicket } from "@app/db";
import { mintGuestOrderAccess } from "@app/core/guestOrderAccess";
import { config } from "@app/core/config";
import { setAdminIds } from "@app/core/runtime";
import { buildApp } from "../src/server";
import { buildApp as buildAdmin } from "../../web-admin/src/server";
import { makeSession, sessionJtiKey } from "../../web-admin/src/auth";
import { makeCustomerSession, SHOP_COOKIE_NAME, shopSessionJtiKey, verifyTelegramLoginResult } from "../src/auth";
import { TICKET_DIR, writeAttachments } from "../src/lib/ticketAttachments";
import { supportRateLimited } from "../src/rateLimit";

vi.mock("@app/core/mailer", () => ({ sendMail: vi.fn() }));
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Awaited<ReturnType<typeof buildAdmin>>;
let sequence = 0;
const files: string[] = [];
async function customer(guest = false) {
  const id = ++sequence;
  const user = await prisma.user.create({ data: { referralCode: `SEC${id}`, isGuest: guest, guestEmail: guest ? `dummy${id}@example.invalid` : null } });
  const session = makeCustomerSession(user.id, null, `security-jti-${id}`);
  await setSetting(prisma, shopSessionJtiKey(user.id), session.data.jti);
  return { user, cookie: `${SHOP_COOKIE_NAME}=${session.raw}`, csrf: session.data.csrf };
}
async function order(userId: number) {
  return prisma.order.create({ data: { userId, orderCode: `ORD-20261008-S${++sequence}`, subtotalAmount: "1000", totalAmount: "1000", status: "PENDING_PAYMENT" } });
}
beforeAll(async () => {
  await initDb();
  await setSetting(prisma, "setup_completed", "true");
  app = await buildApp();
  admin = await buildAdmin();
});
afterAll(async () => {
  await app?.close(); await admin?.close();
  await Promise.all(files.map(f => unlink(join(TICKET_DIR, basename(f))).catch(() => {})));
  await prisma.$disconnect();
});

describe("hardening boundary", () => {
  it("kode pendek saja gagal; token valid hanya membuka satu order dan tidak mengubah akun", async () => {
    const a = await customer(true);
    const own = await order(a.user.id);
    const other = await order(a.user.id);
    const headers = { "x-forwarded-for": "198.18.0.1" };
    expect((await app.inject({ method: "POST", url: "/api/v1/track", headers, payload: { order_code: own.orderCode } })).statusCode).toBe(404);
    const result = await app.inject({ method: "POST", url: "/api/v1/track", headers, payload: { order_code: own.orderCode, access_token: mintGuestOrderAccess(own.orderCode) } });
    expect(result.statusCode).toBe(200);
    const cookie = String(result.headers["set-cookie"]).split(";")[0]!;
    expect((await app.inject({ url: `/api/v1/account/orders/${own.orderCode}`, headers: { cookie } })).statusCode).toBe(200);
    for (const url of [`/api/v1/account/orders/${other.orderCode}`, "/api/v1/account/orders", "/api/v1/account/settings", "/api/v1/account/support"]) {
      expect((await app.inject({ url, headers: { cookie } })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "POST", url: "/api/v1/account/settings/credentials", headers: { cookie, "x-csrf-token": result.json().csrf_token }, payload: { role: "ADMIN" } })).statusCode).toBe(404);
  });

  it("attachment privat di kedua host: owner/admin boleh, anonim/akun B tidak", async () => {
    const a = await customer(); const b = await customer();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const url = (await writeAttachments([{ buffer: png, ext: "png" }]))!; files.push(url);
    const ticket = await createTicket(prisma, a.user.id, "<svg onload=alert(1)>", null, url);
    const ownerFile = await app.inject({ url, headers: { cookie: a.cookie } });
    expect(ownerFile.statusCode).toBe(200);
    expect(ownerFile.headers["cache-control"]).toContain("no-store");
    expect(ownerFile.headers["x-content-type-options"]).toBe("nosniff");
    for (const cookie of ["", b.cookie]) {
      const res = await app.inject({ url, headers: { cookie } });
      expect(res.statusCode).toBe(404); expect(res.headers["cache-control"]).toContain("no-store");
    }
    expect((await admin.inject({ url })).statusCode).toBe(404);
    for (const alias of [url.replace("/tickets/", "/%74ickets/"), url.replace("/tickets/", "/TICKETS/"), url.replace("/tickets/", "/x/../tickets/"), url.replace("/tickets/", "/tickets%2f"), url.replace("/tickets/", "/tickets%5c")]) {
      expect((await app.inject({ url: alias })).statusCode).not.toBe(200);
      expect((await admin.inject({ url: alias })).statusCode).not.toBe(200);
    }
    const signed = makeSession(1, 999, "sec-admin");
    await setSetting(prisma, sessionJtiKey(999), "sec-admin");
    const adminFile = await admin.inject({ url, headers: { cookie: `${config.WEB_COOKIE_NAME}=${signed.raw}` } });
    expect(adminFile.statusCode).toBe(200);
    expect(adminFile.headers["cache-control"]).toContain("no-store");
    expect((await app.inject({ url: `/api/v1/account/support/${ticket.id}`, headers: { cookie: b.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/v1/account/support/${ticket.id}/reply`, headers: { cookie: b.cookie, "x-csrf-token": b.csrf }, payload: { message: "forged" } })).statusCode).toBe(404);
    expect(await prisma.ticketMessage.count({ where: { ticketId: ticket.id, content: "forged" } })).toBe(0);
    setAdminIds([1000]);
    expect((await admin.inject({ url, headers: { cookie: `${config.WEB_COOKIE_NAME}=${signed.raw}` } })).statusCode).toBe(404);
    setAdminIds([999, 1000]);
  });

  it("ticket spam dibatasi sebelum write; mass assignment dan tipe invalid ditolak", async () => {
    const a = await customer();
    const headers = { cookie: a.cookie, "x-csrf-token": a.csrf, "x-forwarded-for": "198.18.0.2" };
    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ method: "POST", url: "/api/v1/account/support", headers, payload: { message: `test ${i}` } })).statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "POST", url: "/api/v1/account/support/new", headers, payload: { message: "spam" } });
    expect(limited.statusCode).toBe(429); expect(limited.headers["retry-after"]).toBe("60");
    expect(await prisma.supportTicket.count({ where: { userId: a.user.id } })).toBe(3);
    const b = await customer();
    for (const payload of [{ message: "x", ownerId: a.user.id, role: "ADMIN" }, { message: { html: "x" } }]) {
      expect((await app.inject({ method: "POST", url: "/api/v1/account/support", headers: { cookie: b.cookie, "x-csrf-token": b.csrf, "x-forwarded-for": "198.18.0.3" }, payload })).statusCode).toBe(400);
    }
  });

  it("header palsu dari peer non-proxy tidak mengganti IP limiter", async () => {
    const a = await customer();
    for (let i = 0; i < 9; i++) {
      const user = i === 0 ? a : await customer();
      const res = await app.inject({ method: "POST", url: "/api/v1/account/support", remoteAddress: "198.18.2.1", headers: { cookie: user.cookie, "x-csrf-token": user.csrf, "x-forwarded-for": `203.0.113.${i}`, "cf-connecting-ip": `203.0.113.${i}` }, payload: { message: "x" } });
      expect(res.statusCode).toBe(200);
    }
    const b = await customer();
    const res = await app.inject({ method: "POST", url: "/api/v1/account/support", remoteAddress: "198.18.2.1", headers: { cookie: b.cookie, "x-csrf-token": b.csrf, "x-forwarded-for": "203.0.113.100" }, payload: { message: "x" } });
    expect(res.statusCode).toBe(429);
  });

  it("IPv6 /64 dan identitas terverifikasi tidak mendapat kuota baru dengan rotasi alamat", () => {
    for (let i = 0; i < 3; i++) expect(supportRateLimited("create", 900000, `2001:db8:1234:5678::${i}`)).toBe(false);
    expect(supportRateLimited("create", 900000, "2001:db8:9999::1")).toBe(true);
  });

  it("payload besar ditolak 413 dan JSON invalid ditolak 400 tanpa detail internal", async () => {
    const large = await app.inject({ method: "POST", url: "/api/v1/track", payload: { order_code: "x".repeat(1024 * 1024 + 1) } });
    expect(large.statusCode).toBe(413);
    expect(large.json()).toEqual({ error: "payload_too_large" });
    const malformed = await app.inject({ method: "POST", url: "/api/v1/track", headers: { "content-type": "application/json" }, payload: "{" });
    expect(malformed.statusCode).toBe(400);
  });

  it("Telegram menolak hash palsu, expired, future; signature sah tetap diterima", () => {
    const now = Date.now();
    function signed(ts: number) {
      const fields = { auth_date: String(ts), id: "12345" };
      const hash = createHmac("sha256", createHash("sha256").update(config.BOT_TOKEN!).digest()).update(`auth_date=${fields.auth_date}\nid=${fields.id}`).digest("hex");
      return { ...fields, hash };
    }
    expect(verifyTelegramLoginResult(signed(Math.floor(now / 1000)), config.BOT_TOKEN, now).ok).toBe(true);
    for (const ts of [Math.floor(now / 1000) - 1000, Math.floor(now / 1000) + 3600]) expect(verifyTelegramLoginResult(signed(ts), config.BOT_TOKEN, now).ok).toBe(false);
    expect(verifyTelegramLoginResult({ ...signed(Math.floor(now / 1000)), id: "999" }, config.BOT_TOKEN, now).ok).toBe(false);
  });
});
