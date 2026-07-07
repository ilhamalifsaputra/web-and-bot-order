import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting } from "@app/db";
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

describe("broadcastPhoto upload", () => {
  it("happy path: upload PNG and receive URL", async () => {
    const mp = multipart({ csrf_token: csrf }, { field: "photo", filename: "broadcast.png", contentType: "image/png", content: PNG });
    const res = await postMultipart("/broadcast/photo", cookie, mp);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url?: string };
    expect(typeof body.url).toBe("string");
    expect(body.url).toMatch(/^\/uploads\/broadcasts\/broadcast-[0-9a-f]+\.png$/);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const mp = multipart({ csrf_token: csrf }, { field: "photo", filename: "broadcast.png", contentType: "image/png", content: PNG });
    const res = await postMultipart("/broadcast/photo", null, mp);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF token (403)", async () => {
    const mp = multipart({ csrf_token: "bad" }, { field: "photo", filename: "broadcast.png", contentType: "image/png", content: PNG });
    const res = await postMultipart("/broadcast/photo", cookie, mp);
    expect(res.statusCode).toBe(403);
  });
});
