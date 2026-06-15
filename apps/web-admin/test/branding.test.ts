import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, createCategory, setSetting, getSetting } from "@app/db";
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

describe("branding page", () => {
  it("GET /branding renders for an admin", async () => {
    const res = await app.inject({ method: "GET", url: "/branding", cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Branding");
  });

  it("GET /branding requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/branding" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("favicon upload (PNG) sets web_favicon_url", async () => {
    const mp = multipart({ csrf_token: csrf }, { field: "favicon", filename: "f.png", contentType: "image/png", content: PNG });
    const res = await postMultipart("/branding/favicon", cookie, mp);
    expect(res.statusCode).toBe(303);
    const v = await getSetting(prisma, "web_favicon_url");
    expect(v).toMatch(/^\/uploads\/branding\/favicon-[0-9a-f]+\.png$/);
  });

  it("favicon upload rejects a non-image MIME", async () => {
    const mp = multipart({ csrf_token: csrf }, { field: "favicon", filename: "f.txt", contentType: "text/plain", content: Buffer.from("nope") });
    const res = await postMultipart("/branding/favicon", cookie, mp);
    expect(res.statusCode).toBe(303);
    expect(await getSetting(prisma, "web_favicon_url")).toBeNull();
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
    const res = await app.inject({
      method: "POST", url: "/branding/banner/clear",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      cookies: { [COOKIE]: cookie }, payload: new URLSearchParams({ csrf_token: csrf }).toString(),
    });
    expect(res.statusCode).toBe(303);
    expect(await getSetting(prisma, "banner_image")).toBeNull();
    expect(await getSetting(prisma, "banner_image_fileid")).toBeNull();
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
});
