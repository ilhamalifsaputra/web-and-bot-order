import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, createCategory, setSetting, getSetting, deleteSetting } from "@app/db";
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
  await createCategory(prisma, "Seed");
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function multipart(
  fields: Record<string, string>,
  file?: { field: string; filename: string; contentType: string; content: Buffer },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----vitest" + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
      ),
    );
    chunks.push(file.content, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

function postMultipart(url: string, c: string | null, mp: ReturnType<typeof multipart>) {
  return app.inject({ method: "POST", url, headers: mp.headers, cookies: c ? { [COOKIE]: c } : {}, payload: mp.payload });
}

function postJson(url: string, c: string | null, csrfToken: string, body: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
    payload: JSON.stringify(body),
  });
}

describe("branding page", () => {
  it("GET /api/branding returns branding data for an admin", async () => {
    const res = await app.inject({ method: "GET", url: "/api/branding", cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { shopName: string };
    expect(typeof data.shopName).toBe("string");
  });

  it("GET /branding requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/branding" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("favicon upload (PNG) sets web_favicon_url", async () => {
    const mp = multipart({ csrf_token: csrf }, { field: "favicon", filename: "f.png", contentType: "image/png", content: PNG });
    const res = await postMultipart("/branding/favicon", cookie, mp);
    expect(res.statusCode).toBe(200);
    const v = await getSetting(prisma, "web_favicon_url");
    expect(v).toMatch(/^\/uploads\/branding\/favicon-[0-9a-f]+\.png$/);
  });

  it("logo upload (PNG) sets web_logo_url", async () => {
    const mp = multipart({ csrf_token: csrf }, { field: "logo", filename: "l.png", contentType: "image/png", content: PNG });
    const res = await postMultipart("/branding/logo", cookie, mp);
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "web_logo_url")).toMatch(/^\/uploads\/branding\/logo-[0-9a-f]+\.png$/);
  });

  it("logo upload rejects JPEG (logos need transparency)", async () => {
    const mp = multipart({ csrf_token: csrf }, { field: "logo", filename: "l.jpg", contentType: "image/jpeg", content: PNG });
    const res = await postMultipart("/branding/logo", cookie, mp);
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "web_logo_url")).toBeNull();
  });

  it("favicon upload rejects a non-image MIME", async () => {
    const mp = multipart({ csrf_token: csrf }, { field: "favicon", filename: "f.txt", contentType: "text/plain", content: Buffer.from("nope") });
    const res = await postMultipart("/branding/favicon", cookie, mp);
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "web_favicon_url")).toBeNull();
  });

  // A file over the route's maxBytes (favicon: 1MB) must be a clean 400, not
  // an uncaught RequestFileTooLargeError falling through to the app's blanket
  // 500 handler (the bug this test guards against).
  it("favicon upload over the size limit is a clean 400, not a 500", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0xff);
    const mp = multipart({ csrf_token: csrf }, { field: "favicon", filename: "f.png", contentType: "image/png", content: big });
    const res = await postMultipart("/branding/favicon", cookie, mp);
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "web_favicon_url")).toBeNull();
  });

  // M-6 (execution/01): the dangerous case the header-only allowlist missed — a
  // valid image MIME header (image/png) on bytes that are NOT an image. The
  // magic-byte sniff must reject it (content doesn't match the claimed type).
  it("favicon upload rejects a spoofed MIME (image/png header, non-image bytes)", async () => {
    const mp = multipart(
      { csrf_token: csrf },
      { field: "favicon", filename: "evil.png", contentType: "image/png", content: Buffer.from("GIF89a not really a png <?php ?>") },
    );
    const res = await postMultipart("/branding/favicon", cookie, mp);
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "web_favicon_url")).toBeNull();
  });

  it("favicon upload accepts a real SVG (text magic, no binary signature)", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>');
    const mp = multipart({ csrf_token: csrf }, { field: "favicon", filename: "f.svg", contentType: "image/svg+xml", content: svg });
    const res = await postMultipart("/branding/favicon", cookie, mp);
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "web_favicon_url")).toMatch(/^\/uploads\/branding\/favicon-[0-9a-f]+\.svg$/);
  });

  it("favicon upload fails bad CSRF", async () => {
    const mp = multipart({ csrf_token: "bad" }, { field: "favicon", filename: "f.png", contentType: "image/png", content: PNG });
    const res = await postMultipart("/branding/favicon", cookie, mp);
    expect(res.statusCode).toBe(403);
  });

  it("favicon upload requires auth", async () => {
    const mp = multipart({ csrf_token: csrf }, { field: "favicon", filename: "f.png", contentType: "image/png", content: PNG });
    const res = await postMultipart("/branding/favicon", null, mp);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("hero upload (PNG) sets web_hero_url and replaces the old file", async () => {
    const mp1 = multipart({ csrf_token: csrf }, { field: "hero", filename: "h.png", contentType: "image/png", content: PNG });
    await postMultipart("/branding/hero", cookie, mp1);
    const first = await getSetting(prisma, "web_hero_url");
    const mp2 = multipart({ csrf_token: csrf }, { field: "hero", filename: "h2.png", contentType: "image/png", content: PNG });
    await postMultipart("/branding/hero", cookie, mp2);
    const second = await getSetting(prisma, "web_hero_url");
    expect(second).toMatch(/^\/uploads\/branding\/hero-[0-9a-f]+\.png$/);
    expect(second).not.toBe(first);
  });

  it("banner upload sets banner_image and clears banner_image_fileid", async () => {
    await setSetting(prisma, "banner_image_fileid", "STALE");
    const mp = multipart({ csrf_token: csrf }, { field: "banner", filename: "b.png", contentType: "image/png", content: PNG });
    await postMultipart("/branding/banner", cookie, mp);
    expect(await getSetting(prisma, "banner_image")).toMatch(/^\/uploads\/branding\/banner-/);
    expect(await getSetting(prisma, "banner_image_fileid")).toBeNull();
  });

  it("banner clear removes both keys", async () => {
    await setSetting(prisma, "banner_image", "/uploads/branding/banner-x.png");
    await setSetting(prisma, "banner_image_fileid", "ID");
    const res = await postJson("/api/branding/image/clear", cookie, csrf, { field: "banner" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, cleared: true });
    expect(await getSetting(prisma, "banner_image")).toBeNull();
    expect(await getSetting(prisma, "banner_image_fileid")).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "branding_banner_clear" } });
    expect(audit).toBeTruthy();
  });

  it("favicon/logo/hero clear each nulls its own setting", async () => {
    await setSetting(prisma, "web_favicon_url", "/uploads/branding/favicon-x.png");
    await setSetting(prisma, "web_logo_url", "/uploads/branding/logo-x.png");
    await setSetting(prisma, "web_hero_url", "/uploads/branding/hero-x.png");

    const favicon = await postJson("/api/branding/image/clear", cookie, csrf, { field: "favicon" });
    expect(favicon.statusCode).toBe(200);
    expect(await getSetting(prisma, "web_favicon_url")).toBeNull();

    const logo = await postJson("/api/branding/image/clear", cookie, csrf, { field: "logo" });
    expect(logo.statusCode).toBe(200);
    expect(await getSetting(prisma, "web_logo_url")).toBeNull();

    const hero = await postJson("/api/branding/image/clear", cookie, csrf, { field: "hero" });
    expect(hero.statusCode).toBe(200);
    expect(await getSetting(prisma, "web_hero_url")).toBeNull();
  });

  it("clearing an already-empty image field is a no-op, not an error", async () => {
    const res = await postJson("/api/branding/image/clear", cookie, csrf, { field: "favicon" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, cleared: false });
  });

  it("image clear rejects an unknown field", async () => {
    const res = await postJson("/api/branding/image/clear", cookie, csrf, { field: "background" });
    expect(res.statusCode).toBe(400);
  });

  it("image clear requires auth", async () => {
    const res = await postJson("/api/branding/image/clear", null, csrf, { field: "favicon" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("image clear rejects bad CSRF", async () => {
    const res = await postJson("/api/branding/image/clear", cookie, "bad", { field: "favicon" });
    expect(res.statusCode).toBe(403);
  });

  it("text reset clears a whitelisted key and rejects others", async () => {
    await setSetting(prisma, "shop_name", "My Shop");
    const ok = await postJson("/api/branding/text/reset", cookie, csrf, { key: "shop_name" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(await getSetting(prisma, "shop_name")).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "setting_clear" } });
    expect(audit).toBeTruthy();

    const bad = await postJson("/api/branding/text/reset", cookie, csrf, { key: "bot_token" });
    expect(bad.statusCode).toBe(400);
  });

  it("text reset requires auth", async () => {
    const res = await postJson("/api/branding/text/reset", null, csrf, { key: "shop_name" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("text reset rejects bad CSRF", async () => {
    const res = await postJson("/api/branding/text/reset", cookie, "bad", { key: "shop_name" });
    expect(res.statusCode).toBe(403);
  });

  it("text edit updates a whitelisted key and rejects others", async () => {
    const ok = await app.inject({
      method: "POST", url: "/branding/text",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      cookies: { [COOKIE]: cookie }, payload: new URLSearchParams({ csrf_token: csrf, key: "shop_name", value: "My Shop" }).toString(),
    });
    expect(ok.statusCode).toBe(303);
    expect(await getSetting(prisma, "shop_name")).toBe("My Shop");

    const bad = await app.inject({
      method: "POST", url: "/branding/text",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      cookies: { [COOKIE]: cookie }, payload: new URLSearchParams({ csrf_token: csrf, key: "bot_token", value: "x" }).toString(),
    });
    expect(bad.statusCode).toBe(303);
    expect(await getSetting(prisma, "bot_token")).toBeNull();
  });

  it("uploaded files are served with CSP + nosniff headers", async () => {
    const mp = multipart({ csrf_token: csrf }, { field: "favicon", filename: "f.png", contentType: "image/png", content: PNG });
    await postMultipart("/branding/favicon", cookie, mp);
    const url = await getSetting(prisma, "web_favicon_url");
    const res = await app.inject({ method: "GET", url: url! });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["content-security-policy"])).toContain("default-src 'none'");
  });

  it("injects default or configured web_favicon_url into HTML shell <head>", async () => {
    await deleteSetting(prisma, "web_favicon_url");
    const resDefault = await app.inject({ method: "GET", url: "/login" });
    expect(resDefault.statusCode).toBe(200);
    expect(resDefault.body).toContain('<link rel="icon" href="/static/favicon.svg">');

    await setSetting(prisma, "web_favicon_url", "/uploads/branding/favicon-test.png");
    const resCustom = await app.inject({ method: "GET", url: "/login" });
    expect(resCustom.statusCode).toBe(200);
    expect(resCustom.body).toContain('<link rel="icon" href="/uploads/branding/favicon-test.png">');

    const resAuthCustom = await app.inject({ method: "GET", url: "/", cookies: { [COOKIE]: cookie } });
    expect(resAuthCustom.statusCode).toBe(200);
    expect(resAuthCustom.body).toContain('<link rel="icon" href="/uploads/branding/favicon-test.png">');

    await deleteSetting(prisma, "web_favicon_url");
  });

  // The 10 new owner-email design-system Settings keys (Global Constraints
  // table): brand color/support address plus the 4-field copy sets for the
  // two owner-email templates this plan touches.
  const NEW_TEXT_VALUES: Record<string, string> = {
    email_brand_color: "#112233",
    email_support_address: "support@example.com",
    email_order_paid_subject: "New order!",
    email_order_paid_title: "You've got a sale",
    email_order_paid_subtitle: "Ka-ching.",
    email_order_paid_message: "Go check the order details.",
    email_reset_password_subject: "{shop_name} — reset your password",
    email_reset_password_title: "Reset it",
    email_reset_password_subtitle: "We got a request.",
    email_reset_password_message: "Click the button below.",
  };

  it("saves each of the 10 new email design-system keys via POST /api/branding/text and reads them back via GET /api/branding", async () => {
    for (const [key, value] of Object.entries(NEW_TEXT_VALUES)) {
      const res = await postJson("/api/branding/text", cookie, csrf, { key, value });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    }

    const getRes = await app.inject({ method: "GET", url: "/api/branding", cookies: { [COOKIE]: cookie } });
    expect(getRes.statusCode).toBe(200);
    const data = getRes.json() as Record<string, string>;
    expect(data.emailBrandColor).toBe("#112233");
    expect(data.emailSupportAddress).toBe("support@example.com");
    expect(data.emailOrderPaidSubject).toBe("New order!");
    expect(data.emailOrderPaidTitle).toBe("You've got a sale");
    expect(data.emailOrderPaidSubtitle).toBe("Ka-ching.");
    expect(data.emailOrderPaidMessage).toBe("Go check the order details.");
    expect(data.emailResetPasswordSubject).toBe("{shop_name} — reset your password");
    expect(data.emailResetPasswordTitle).toBe("Reset it");
    expect(data.emailResetPasswordSubtitle).toBe("We got a request.");
    expect(data.emailResetPasswordMessage).toBe("Click the button below.");
  });

  it("GET /api/branding returns \"\" for the 10 new keys when unset, same fallback as shop_name", async () => {
    const res = await app.inject({ method: "GET", url: "/api/branding", cookies: { [COOKIE]: cookie } });
    const data = res.json() as Record<string, string>;
    for (const key of Object.keys(NEW_TEXT_VALUES)) {
      const field = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      expect(data[field]).toBe("");
    }
  });

  it("saving a new email design-system field records an audit log entry, same as shop_name", async () => {
    const res = await postJson("/api/branding/text", cookie, csrf, { key: "email_brand_color", value: "#4f46e5" });
    expect(res.statusCode).toBe(200);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "setting_set" },
      orderBy: { id: "desc" },
    });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("email_brand_color");
  });

  it("email_brand_color rejects a non-hex value with 400", async () => {
    for (const bad of ["blue", "#GGG", "112233", "#1122"]) {
      const res = await postJson("/api/branding/text", cookie, csrf, { key: "email_brand_color", value: bad });
      expect(res.statusCode).toBe(400);
    }
    expect(await getSetting(prisma, "email_brand_color")).toBeNull();
  });

  it("email_brand_color accepts clearing to an empty value", async () => {
    await setSetting(prisma, "email_brand_color", "#112233");
    const res = await postJson("/api/branding/text", cookie, csrf, { key: "email_brand_color", value: "" });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "email_brand_color")).toBe("");
  });

  it("email_support_address rejects a non-email value with 400", async () => {
    for (const bad of ["not-an-email", "missing-at-sign.com", "@no-local.com"]) {
      const res = await postJson("/api/branding/text", cookie, csrf, { key: "email_support_address", value: bad });
      expect(res.statusCode).toBe(400);
    }
    expect(await getSetting(prisma, "email_support_address")).toBeNull();
  });

  it("rejects each copy-text key over its documented length cap with 400, and accepts exactly at the cap", async () => {
    const caps: Array<[string, number]> = [
      ["email_order_paid_subject", 150],
      ["email_order_paid_title", 150],
      ["email_order_paid_subtitle", 200],
      ["email_order_paid_message", 1000],
      ["email_reset_password_subject", 150],
      ["email_reset_password_title", 150],
      ["email_reset_password_subtitle", 200],
      ["email_reset_password_message", 1000],
    ];
    for (const [key, max] of caps) {
      const tooLong = await postJson("/api/branding/text", cookie, csrf, { key, value: "x".repeat(max + 1) });
      expect(tooLong.statusCode).toBe(400);
      expect(await getSetting(prisma, key)).toBeNull();

      const atCap = await postJson("/api/branding/text", cookie, csrf, { key, value: "x".repeat(max) });
      expect(atCap.statusCode).toBe(200);
      expect(await getSetting(prisma, key)).toBe("x".repeat(max));
    }
  });

  it("POST /api/branding/text for a new key requires auth, same as shop_name", async () => {
    const res = await postJson("/api/branding/text", null, csrf, { key: "email_brand_color", value: "#112233" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("POST /api/branding/text for a new key rejects bad CSRF, same as shop_name", async () => {
    const res = await postJson("/api/branding/text", cookie, "bad", { key: "email_brand_color", value: "#112233" });
    expect(res.statusCode).toBe(403);
  });
});
