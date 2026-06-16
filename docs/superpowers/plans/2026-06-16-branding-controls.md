# Branding Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web-admin **Branding** page where the owner uploads a favicon, hero image, and bot banner, and edits shop name / tagline / welcome — all consumed by the storefront and the bot.

**Architecture:** A new `branding.ts` route module in web-admin handles multipart uploads (mirroring the existing product-photo pattern), writing files to `data/uploads/branding/` and paths to the shared `settings` table. The storefront reads `web_favicon_url` / `web_hero_url`; the bot reads `banner_image` (now an upload path or legacy Telegram file_id) and sends it via `InputFile`, caching the resulting file_id. SVG uploads are made inert with CSP/nosniff headers on the `/uploads/` route.

**Tech Stack:** Fastify + `@fastify/multipart` + Nunjucks (web-admin), grammY + `InputFile` (bot), Prisma/SQLite settings, Vitest.

Spec: `docs/superpowers/specs/2026-06-16-branding-controls-design.md`

---

## File Structure

- **Create** `apps/web-admin/src/routes/branding.ts` — GET page + favicon/hero/banner upload POSTs + banner clear + text edit. Owns the multipart-upload helper.
- **Create** `apps/web-admin/views/branding.njk` — the Branding page (3 image cards + text form).
- **Modify** `apps/web-admin/src/server.ts` — register `brandingRoutes`; add CSP/nosniff `setHeaders` to the `/uploads/` static registration.
- **Modify** `apps/web-admin/views/base.njk` — add the Branding nav link.
- **Modify** `apps/web-admin/src/routes/settings.ts` — remove moved keys from the Website/Bot-message UI groups (keep them in `EDITABLE`).
- **Create** `apps/order-bot/src/util/banner.ts` — pure banner-value resolver + photo-arg builder + setting-key constants.
- **Modify** `apps/order-bot/src/handlers/customer.ts` — use the new banner helpers; cache the sent file_id.
- **Modify** `apps/order-bot/src/util/chat.ts` — widen `renderMenu` photo param to `string | InputFile`; add `onPhotoSent` callback.
- **Modify** `apps/storefront/src/shop.ts` — expose `favicon_url` on every page.
- **Modify** `apps/storefront/views/base.njk` — `<link rel="icon">`.
- **Create** `apps/storefront/static/favicon.svg` — default favicon.
- **Modify** `apps/storefront/src/routes/home.ts` — use `web_hero_url` when set.
- **Modify** `apps/storefront/src/server.ts` — CSP/nosniff `setHeaders` on `/uploads/`.
- **Test** `apps/web-admin/test/branding.test.ts`, additions to `apps/storefront/test/storefront.test.ts`, new `apps/order-bot/test/banner.test.ts`.

---

## Task 1: Bot banner resolver (pure)

**Files:**
- Create: `apps/order-bot/src/util/banner.ts`
- Test: `apps/order-bot/test/banner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/order-bot/test/banner.test.ts`:

```ts
import "./setup-env"; // FIRST import — sets env before @app/* load
import { describe, it, expect } from "vitest";
import { InputFile } from "grammy";
import { resolveBannerValue, bannerPhotoArg } from "../src/util/banner";

describe("resolveBannerValue", () => {
  it("empty / null → none", () => {
    expect(resolveBannerValue(null, null)).toEqual({ kind: "none" });
    expect(resolveBannerValue("   ", null)).toEqual({ kind: "none" });
  });

  it("legacy Telegram file_id → fileId passthrough", () => {
    expect(resolveBannerValue("AgACAgQ_legacy", null)).toEqual({ kind: "fileId", fileId: "AgACAgQ_legacy" });
  });

  it("upload path without cache → upload", () => {
    expect(resolveBannerValue("/uploads/branding/banner-abc.png", null)).toEqual({
      kind: "upload",
      relPath: "branding/banner-abc.png",
    });
  });

  it("upload path with cached file_id → fileId (cache wins)", () => {
    expect(resolveBannerValue("/uploads/branding/banner-abc.png", "CACHED_ID")).toEqual({
      kind: "fileId",
      fileId: "CACHED_ID",
    });
  });
});

describe("bannerPhotoArg", () => {
  it("none → undefined", () => {
    expect(bannerPhotoArg(null, null)).toBeUndefined();
  });

  it("fileId → string photo, no caching", () => {
    expect(bannerPhotoArg("FILEID", null)).toEqual({ photo: "FILEID", needsCache: false });
  });

  it("upload without cache → InputFile, needsCache true", () => {
    const arg = bannerPhotoArg("/uploads/branding/banner-x.png", null);
    expect(arg?.needsCache).toBe(true);
    expect(arg?.photo).toBeInstanceOf(InputFile);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/order-bot exec vitest run test/banner.test.ts`
Expected: FAIL — cannot find module `../src/util/banner`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/order-bot/src/util/banner.ts`:

```ts
/**
 * Banner-image resolution. The `banner_image` setting may hold a web-admin
 * upload path (`/uploads/branding/…`, shared filesystem) or a legacy Telegram
 * file_id (set by sending a photo to the bot). Uploads are sent via InputFile
 * and the resulting file_id is cached in `banner_image_fileid` so the bot
 * re-uploads at most once per banner.
 */
import { join } from "node:path";
import { InputFile } from "grammy";

export const BANNER_IMAGE_KEY = "banner_image";
export const BANNER_FILEID_KEY = "banner_image_fileid";

const UPLOADS_ROOT = process.env.UPLOADS_DIR ?? join(process.cwd(), "data", "uploads");

export type BannerValue =
  | { kind: "none" }
  | { kind: "fileId"; fileId: string }
  | { kind: "upload"; relPath: string };

export function resolveBannerValue(
  bannerImage: string | null | undefined,
  cachedFileId: string | null | undefined,
): BannerValue {
  const v = (bannerImage ?? "").trim();
  if (!v) return { kind: "none" };
  if (v.startsWith("/uploads/")) {
    const cached = (cachedFileId ?? "").trim();
    if (cached) return { kind: "fileId", fileId: cached };
    return { kind: "upload", relPath: v.replace(/^\/uploads\//, "") };
  }
  return { kind: "fileId", fileId: v };
}

/** Build the photo argument for `renderMenu`, or undefined when no banner. */
export function bannerPhotoArg(
  bannerImage: string | null | undefined,
  cachedFileId: string | null | undefined,
): { photo: string | InputFile; needsCache: boolean } | undefined {
  const r = resolveBannerValue(bannerImage, cachedFileId);
  if (r.kind === "none") return undefined;
  if (r.kind === "fileId") return { photo: r.fileId, needsCache: false };
  return { photo: new InputFile(join(UPLOADS_ROOT, r.relPath)), needsCache: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/order-bot exec vitest run test/banner.test.ts`
Expected: PASS (7 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/order-bot/src/util/banner.ts apps/order-bot/test/banner.test.ts
git commit -m "feat(bot): banner resolver — upload path, file_id cache, legacy passthrough"
```

---

## Task 2: renderMenu accepts InputFile + onPhotoSent callback

**Files:**
- Modify: `apps/order-bot/src/util/chat.ts` (the `renderMenu` function, ~line 121-153)

- [ ] **Step 1: Widen the signature**

In `apps/order-bot/src/util/chat.ts`, change the import to include `InputFile`:

```ts
import { InlineKeyboard, InputFile, type Keyboard } from "grammy";
```

(If `InlineKeyboard`/`Keyboard` are already imported as types, keep them; just ensure `InputFile` is a value import.)

Change the `renderMenu` signature and the fresh-send block. Replace the parameter list:

```ts
export async function renderMenu(
  ctx: MyContext,
  text: string,
  replyMarkup?: Markup,
  photo?: string | InputFile,
  onPhotoSent?: (fileId: string) => void | Promise<void>,
): Promise<void> {
  ctx.session.awaitingQtyProductId = undefined;
  const body = truncateText(text);

  if (photo && body.length <= MAX_CAPTION_LEN) {
```

Rename the inner `photoFileId` reference: the `if (photoFileId && …)` guard becomes `if (photo && …)` (done above). The edit-caption branch is unchanged. In the **fresh photo send** block, capture the file_id and fire the callback:

```ts
    const prev = ctx.session.menuMsgId ?? ctx.callbackQuery?.message?.message_id;
    const msg = await ctx.replyWithPhoto(photo, { caption: body, parse_mode: "HTML", reply_markup: replyMarkup });
    if (prev !== undefined && prev !== msg.message_id) await retireKeyboard(ctx, prev);
    ctx.session.menuMsgId = msg.message_id;
    if (onPhotoSent && msg.photo?.length) await onPhotoSent(msg.photo[msg.photo.length - 1]!.file_id);
    return;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @app/order-bot typecheck`
Expected: PASS (no remaining references to the old `photoFileId` param name; existing callers still pass a `string`, which is assignable to `string | InputFile`).

- [ ] **Step 3: Run the bot test suite (no behavior change expected)**

Run: `pnpm --filter @app/order-bot exec vitest run test/chat.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/order-bot/src/util/chat.ts
git commit -m "feat(bot): renderMenu accepts InputFile photo + onPhotoSent callback"
```

---

## Task 3: Wire customer.ts to the new banner helpers + caching

**Files:**
- Modify: `apps/order-bot/src/handlers/customer.ts` (lines ~71-78 helper; call sites 107, 152, 157, 210)

- [ ] **Step 1: Replace the banner helper**

In `apps/order-bot/src/handlers/customer.ts`, find the existing block (lines ~71-78):

```ts
const BANNER_IMAGE_KEY = "banner_image";
async function bannerImage(): Promise<string | undefined> {
  return (await getSetting(prisma, BANNER_IMAGE_KEY)) || undefined;
}
```

Replace it with:

```ts
// Optional banner shown above the main menu and product list. The value is a
// web-admin upload path or a legacy Telegram file_id; uploads are sent via
// InputFile and the resulting file_id is cached (util/banner.ts).
async function bannerArg(): Promise<{ photo: string | InputFile; needsCache: boolean } | undefined> {
  const [value, cached] = await Promise.all([
    getSetting(prisma, BANNER_IMAGE_KEY),
    getSetting(prisma, BANNER_FILEID_KEY),
  ]);
  return bannerPhotoArg(value, cached);
}

const cacheBannerFileId = async (fileId: string): Promise<void> => {
  await setSetting(prisma, BANNER_FILEID_KEY, fileId);
};

/** renderMenu with the configured banner (if any) + file_id caching. */
async function renderMenuBanner(ctx: MyContext, text: string, replyMarkup: Markup): Promise<void> {
  const b = await bannerArg();
  await renderMenu(ctx, text, replyMarkup, b?.photo, b?.needsCache ? cacheBannerFileId : undefined);
}
```

Add the imports near the top of the file (alongside the existing grammY / db imports):

```ts
import { InputFile } from "grammy";
import { BANNER_IMAGE_KEY, BANNER_FILEID_KEY, bannerPhotoArg } from "../util/banner";
```

Ensure `setSetting` is in the `@app/db` import list (add it if missing) and that the `Markup` type used by `renderMenu` is imported/visible (it is exported from `../util/chat`; import the type if not already: `import type { Markup } from "../util/chat";` — only if `Markup` isn't already in scope. If `renderMenu`'s param type isn't exported, type `replyMarkup` as the same type the call sites already pass, e.g. `Parameters<typeof renderMenu>[2]`). Note: `InputFile` may already be imported (line 10) — do not duplicate it.

- [ ] **Step 2: Update the four call sites**

Replace each `renderMenu(ctx, text, <kb>, await bannerImage())` with `renderMenuBanner(ctx, text, <kb>)`:

- Line ~107: `await renderMenuBanner(ctx, text, ckb.mainPersistentKb(ctx.session.lang));`
- Line ~152: `await renderMenuBanner(ctx, text, ckb.mainPersistentKb(ctx.session.lang));`
- Line ~157: `await renderMenuBanner(ctx, text, ckb.mainPersistentKb(ctx.session.lang));`
- Lines ~202-211 (browseProductsFlat): collapse the multi-line call to

```ts
  await renderMenuBanner(
    ctx,
    text,
    ckb.productsPersistentKb(pageProducts.length, lang, {
      showPrev: page > 0,
      showNext: page < totalPages - 1,
      showBack: false,
    }),
  );
```

- [ ] **Step 3: Typecheck + tests**

Run: `pnpm --filter @app/order-bot typecheck && pnpm --filter @app/order-bot exec vitest run`
Expected: PASS. (If `InputFile` becomes an unused import because all uses are typed via the helper, remove the duplicate import to satisfy the linter.)

- [ ] **Step 4: Commit**

```bash
git add apps/order-bot/src/handlers/customer.ts
git commit -m "feat(bot): render banner from upload path with file_id caching"
```

---

## Task 4: web-admin branding route — GET page + upload helper + favicon

**Files:**
- Create: `apps/web-admin/src/routes/branding.ts`
- Create: `apps/web-admin/views/branding.njk`
- Modify: `apps/web-admin/src/server.ts` (register the route)
- Test: `apps/web-admin/test/branding.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web-admin/test/branding.test.ts`. Reuse the auth/seed harness conventions from `web.test.ts` (copy the imports/`beforeAll`/`beforeEach`/`get`/`post` helpers it uses, or import the helpers if exported — `web.test.ts` keeps them local, so duplicate the minimal harness here):

```ts
import "./setup-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import {
  prisma, initDb, resetDb, upsertUser, createCategory, setSetting, getSetting,
} from "@app/db";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;

beforeAll(async () => { await initDb(); app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

beforeEach(async () => {
  await resetDb(prisma);
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  await createCategory(prisma, "Seed");
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw; csrf = data.csrf;
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
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
    ));
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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @app/web-admin exec vitest run test/branding.test.ts`
Expected: FAIL — `/branding` returns 404 (route not registered).

- [ ] **Step 3: Create the route module**

Create `apps/web-admin/src/routes/branding.ts`:

```ts
/**
 * Branding — favicon, hero, and bot banner uploads plus shop identity text.
 * Image uploads follow the product-photo pattern (catalog.ts): multipart parsed
 * manually, CSRF checked against req.admin.csrf, role gated with canMutate,
 * audited. Files land in data/uploads/branding and the path is saved to settings.
 */
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma, getSetting, setSetting, deleteSetting, logAdminAction } from "@app/db";
import { currentAdmin, csrfProtect, canMutate } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

const BRANDING_DIR = join(process.env.UPLOADS_DIR ?? join(process.cwd(), "data", "uploads"), "branding");

const FAVICON_MIME: Record<string, string> = {
  "image/png": "png",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/svg+xml": "svg",
};
const RASTER_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const TEXT_KEYS = new Set(["shop_name", "shop_tagline", "welcome"]);

/** Delete a previous branding upload (ignore legacy file_ids / missing files). */
async function deleteOldUpload(oldValue: string | null): Promise<void> {
  if (oldValue && oldValue.startsWith("/uploads/branding/")) {
    await unlink(join(BRANDING_DIR, basename(oldValue))).catch(() => undefined);
  }
}

/** Shared multipart image upload: CSRF + role gate + MIME + size, then save. */
async function handleUpload(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: {
    kind: string;
    field: string;
    allowed: Record<string, string>;
    maxBytes: number;
    settingKey: string;
    auditAction: string;
    afterSave?: () => Promise<void>;
  },
): Promise<FastifyReply> {
  if (!canMutate(req.admin!.role, req.url)) {
    return reply.code(403).type("text/plain").send("Insufficient permissions for this action.");
  }
  let csrfField: string | null = null;
  let fileBuffer: Buffer | null = null;
  let mimetype = "";
  for await (const part of req.parts({ limits: { fileSize: opts.maxBytes } })) {
    if (part.type === "field" && part.fieldname === "csrf_token") {
      csrfField = part.value as string;
    } else if (part.type === "file" && part.fieldname === opts.field) {
      mimetype = part.mimetype;
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk);
      if (chunks.length > 0) fileBuffer = Buffer.concat(chunks);
    }
  }
  if (!csrfField || csrfField !== req.admin!.csrf) {
    return reply.code(403).type("text/plain").send("CSRF check failed");
  }
  if (!fileBuffer || fileBuffer.length === 0) {
    return redirectWithFlash(reply, "/branding", "No file selected.", "error");
  }
  const ext = opts.allowed[mimetype];
  if (!ext) {
    return redirectWithFlash(reply, "/branding", "That file type is not allowed.", "error");
  }
  const filename = `${opts.kind}-${randomBytes(8).toString("hex")}.${ext}`;
  await mkdir(BRANDING_DIR, { recursive: true });
  await writeFile(join(BRANDING_DIR, filename), fileBuffer);
  await deleteOldUpload(await getSetting(prisma, opts.settingKey));
  await setSetting(prisma, opts.settingKey, `/uploads/branding/${filename}`);
  if (opts.afterSave) await opts.afterSave();
  await logAdminAction(prisma, {
    adminId: req.admin!.userId,
    action: opts.auditAction,
    targetType: "setting",
    details: `filename=${filename}`,
  });
  return redirectWithFlash(reply, "/branding", "Saved.", "success");
}

export default async function brandingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/branding", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const [favicon, hero, banner, shopName, shopTagline, welcome] = await Promise.all([
      getSetting(prisma, "web_favicon_url"),
      getSetting(prisma, "web_hero_url"),
      getSetting(prisma, "banner_image"),
      getSetting(prisma, "shop_name"),
      getSetting(prisma, "shop_tagline"),
      getSetting(prisma, "welcome"),
    ]);
    const bannerIsUpload = Boolean(banner && banner.startsWith("/uploads/"));
    return reply.view("branding.njk", {
      admin: req.admin,
      active_nav: "/branding",
      favicon_url: favicon ?? "",
      hero_url: hero ?? "",
      banner_url: bannerIsUpload ? banner : "",
      banner_is_legacy: Boolean(banner) && !bannerIsUpload,
      shop_name: shopName ?? "",
      shop_tagline: shopTagline ?? "",
      welcome: welcome ?? "",
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  app.post("/branding/favicon", { preHandler: currentAdmin }, (req, reply) =>
    handleUpload(req, reply, {
      kind: "favicon", field: "favicon", allowed: FAVICON_MIME, maxBytes: 1 * 1024 * 1024,
      settingKey: "web_favicon_url", auditAction: "branding_favicon_upload",
    }),
  );

  app.post("/branding/hero", { preHandler: currentAdmin }, (req, reply) =>
    handleUpload(req, reply, {
      kind: "hero", field: "hero", allowed: RASTER_MIME, maxBytes: 5 * 1024 * 1024,
      settingKey: "web_hero_url", auditAction: "branding_hero_upload",
    }),
  );

  app.post("/branding/banner", { preHandler: currentAdmin }, (req, reply) =>
    handleUpload(req, reply, {
      kind: "banner", field: "banner", allowed: RASTER_MIME, maxBytes: 5 * 1024 * 1024,
      settingKey: "banner_image", auditAction: "branding_banner_upload",
      afterSave: () => deleteSetting(prisma, "banner_image_fileid").then(() => undefined),
    }),
  );

  app.post("/branding/banner/clear", { preHandler: csrfProtect }, async (req, reply) => {
    if (!canMutate(req.admin!.role, req.url)) {
      return reply.code(403).type("text/plain").send("Insufficient permissions for this action.");
    }
    await deleteOldUpload(await getSetting(prisma, "banner_image"));
    await deleteSetting(prisma, "banner_image");
    await deleteSetting(prisma, "banner_image_fileid");
    await logAdminAction(prisma, {
      adminId: req.admin!.userId, action: "branding_banner_clear", targetType: "setting",
    });
    return redirectWithFlash(reply, "/branding", "Banner cleared.", "success");
  });

  app.post("/branding/text", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const key = body.key ?? "";
    if (!TEXT_KEYS.has(key)) {
      return redirectWithFlash(reply, "/branding", "That field is not editable here.", "error");
    }
    const value = (body.value ?? "").trim();
    await setSetting(prisma, key, value);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId, action: "setting_set", targetType: "setting",
      details: `${key}=${value.slice(0, 80)}${value.length > 80 ? "…" : ""}`,
    });
    return redirectWithFlash(reply, "/branding", `Setting '${key}' updated.`, "success");
  });
}
```

- [ ] **Step 4: Register the route**

In `apps/web-admin/src/server.ts`, import and register alongside the other route modules (mirror how `catalogRoutes`/`settingsRoutes` are registered):

```ts
import brandingRoutes from "./routes/branding";
// …
await app.register(brandingRoutes);
```

- [ ] **Step 5: Create the view**

Create `apps/web-admin/views/branding.njk` (model the card/`field`/`btn` classes on `settings.njk` / `catalog.njk`):

```njk
{% extends "base.njk" %}
{% block content %}
<h1 class="text-2xl font-display font-semibold text-pine mb-6">Branding</h1>

{% if msg %}<div class="mb-4 rounded-lg px-4 py-2 text-sm {% if kind == 'error' %}bg-rust-tint text-rust{% else %}bg-pine-tint text-pine-dark{% endif %}">{{ msg }}</div>{% endif %}

<div class="grid gap-6 sm:grid-cols-2">
  {# ---- Favicon ---- #}
  <section class="card p-5">
    <h2 class="font-semibold text-ink mb-1">Favicon</h2>
    <p class="text-xs text-ink-faint mb-3">Recommended 512×512 px, square. PNG, ICO, or SVG. Max 1 MB.</p>
    {% if favicon_url %}<img src="{{ favicon_url }}" alt="favicon" class="w-12 h-12 rounded mb-3 border border-line">{% endif %}
    <form method="post" action="/branding/favicon" enctype="multipart/form-data" class="space-y-2">
      <input type="hidden" name="csrf_token" value="{{ admin.csrf }}">
      <input type="file" name="favicon" accept="image/png,image/x-icon,image/svg+xml" class="field" required>
      <button type="submit" class="btn btn-primary">Upload favicon</button>
    </form>
  </section>

  {# ---- Hero ---- #}
  <section class="card p-5">
    <h2 class="font-semibold text-ink mb-1">Website hero image</h2>
    <p class="text-xs text-ink-faint mb-3">Recommended 1600×900 px (16:9), landscape. JPG, PNG, or WebP. Max 5 MB.</p>
    {% if hero_url %}<img src="{{ hero_url }}" alt="hero" class="w-full max-w-xs rounded mb-3 border border-line">{% endif %}
    <form method="post" action="/branding/hero" enctype="multipart/form-data" class="space-y-2">
      <input type="hidden" name="csrf_token" value="{{ admin.csrf }}">
      <input type="file" name="hero" accept="image/jpeg,image/png,image/webp" class="field" required>
      <button type="submit" class="btn btn-primary">Upload hero</button>
    </form>
  </section>

  {# ---- Bot banner ---- #}
  <section class="card p-5 sm:col-span-2">
    <h2 class="font-semibold text-ink mb-1">Bot banner</h2>
    <p class="text-xs text-ink-faint mb-3">Shown above the bot's main menu and product list. Recommended 1280×720 px (16:9). JPG, PNG, or WebP. Max 5 MB.</p>
    {% if banner_url %}<img src="{{ banner_url }}" alt="banner" class="w-full max-w-md rounded mb-3 border border-line">{% endif %}
    {% if banner_is_legacy %}<p class="text-xs text-amber-600 mb-3">A banner is currently set from the bot (Telegram image). Uploading here replaces it.</p>{% endif %}
    <form method="post" action="/branding/banner" enctype="multipart/form-data" class="space-y-2 inline-block mr-3">
      <input type="hidden" name="csrf_token" value="{{ admin.csrf }}">
      <input type="file" name="banner" accept="image/jpeg,image/png,image/webp" class="field" required>
      <button type="submit" class="btn btn-primary">Upload banner</button>
    </form>
    {% if banner_url or banner_is_legacy %}
    <form method="post" action="/branding/banner/clear" class="inline-block">
      <input type="hidden" name="csrf_token" value="{{ admin.csrf }}">
      <button type="submit" class="btn btn-ghost">Remove banner</button>
    </form>
    {% endif %}
  </section>

  {# ---- Identity text ---- #}
  <section class="card p-5 sm:col-span-2">
    <h2 class="font-semibold text-ink mb-3">Shop identity</h2>
    {% for f in [["shop_name", "Shop name", shop_name], ["shop_tagline", "Shop tagline", shop_tagline], ["welcome", "Bot welcome message", welcome]] %}
    <form method="post" action="/branding/text" class="flex items-end gap-2 mb-3">
      <input type="hidden" name="csrf_token" value="{{ admin.csrf }}">
      <input type="hidden" name="key" value="{{ f[0] }}">
      <label class="flex-1 text-sm">{{ f[1] }}
        <input type="text" name="value" value="{{ f[2] }}" class="field mt-1">
      </label>
      <button type="submit" class="btn btn-primary">Save</button>
    </form>
    {% endfor %}
  </section>
</div>
{% endblock %}
```

> If `card`/`field`/`btn`/`btn-primary`/`btn-ghost` class names differ in `_theme.njk`, match the names actually used in `settings.njk`. Verify by opening `apps/web-admin/views/settings.njk` and copying its form/button classes.

- [ ] **Step 6: Run the branding tests**

Run: `pnpm --filter @app/web-admin exec vitest run test/branding.test.ts`
Expected: PASS (all favicon + page cases).

- [ ] **Step 7: Commit**

```bash
git add apps/web-admin/src/routes/branding.ts apps/web-admin/views/branding.njk apps/web-admin/src/server.ts apps/web-admin/test/branding.test.ts
git commit -m "feat(web): Branding page — favicon/hero/banner uploads + identity text"
```

---

## Task 5: web-admin branding — hero, banner, text, clear tests

**Files:**
- Modify: `apps/web-admin/test/branding.test.ts` (add cases)

- [ ] **Step 1: Add the failing tests**

Append inside the `describe("branding page", …)` block:

```ts
  it("hero upload (JPG) sets web_hero_url and replaces the old file", async () => {
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
```

- [ ] **Step 2: Run**

Run: `pnpm --filter @app/web-admin exec vitest run test/branding.test.ts`
Expected: PASS (Task 4 route code already satisfies these — no new implementation needed).

- [ ] **Step 3: Commit**

```bash
git add apps/web-admin/test/branding.test.ts
git commit -m "test(web): branding hero/banner/clear/text coverage"
```

---

## Task 6: Settings page — drop moved keys from the UI groups

**Files:**
- Modify: `apps/web-admin/src/routes/settings.ts` (lines ~69-70)
- Test: `apps/web-admin/test/web.test.ts` (existing settings tests must still pass)

- [ ] **Step 1: Narrow the groups and exclude branding keys from the leftover guard**

In `apps/web-admin/src/routes/settings.ts`, change:

```ts
const WEBSITE_KEYS = new Set(["shop_name", "shop_tagline", "support_whatsapp"]);
const BOT_MESSAGE_KEYS = new Set(["welcome", "banner_image", "support_contact"]);
```

to:

```ts
// shop_name / shop_tagline / welcome / banner_image now live on the Branding
// page; only support_whatsapp (contact) stays here. They remain in EDITABLE so
// the read-only "all options" table and the generic /settings/edit fallback
// still work, but BRANDING_KEYS keeps them out of the editable Settings form.
const WEBSITE_KEYS = new Set(["support_whatsapp"]);
const BOT_MESSAGE_KEYS = new Set(["support_contact"]);
const BRANDING_KEYS = new Set(["shop_name", "shop_tagline", "welcome", "banner_image"]);
```

Then add `...BRANDING_KEYS` to the `grouped` set in the GET handler so the
leftover guard does NOT re-add them to the Website tab. Find (~line 118):

```ts
    const grouped = new Set([
      ...WEBSITE_KEYS, ...BOT_MESSAGE_KEYS, ...BOT_TOKEN_FIELD_KEYS,
      ...PAY_BINANCE_KEYS, ...PAY_RATE_KEYS, ...PAY_QRIS_KEYS, ...PAY_BYBIT_KEYS,
    ]);
```

and change it to include branding keys:

```ts
    const grouped = new Set([
      ...WEBSITE_KEYS, ...BOT_MESSAGE_KEYS, ...BOT_TOKEN_FIELD_KEYS,
      ...PAY_BINANCE_KEYS, ...PAY_RATE_KEYS, ...PAY_QRIS_KEYS, ...PAY_BYBIT_KEYS,
      ...BRANDING_KEYS,
    ]);
```

This marks them "grouped" (so the leftover filter skips them) while no `pick()`
call renders them — they vanish from the editable Settings form but stay in
`EDITABLE` and the read-only options table.

- [ ] **Step 2: Add a test that the moved keys are gone from the Settings form**

In `apps/web-admin/test/web.test.ts`, find the settings `describe` block and add:

```ts
  it("shop identity + banner fields no longer render an editable input on /settings", async () => {
    const res = await get("/settings", seed.cookie);
    expect(res.statusCode).toBe(200);
    // The editable form posts name="key" value="<key>"; branding keys must not.
    expect(res.body).not.toContain('value="shop_name"');
    expect(res.body).not.toContain('value="banner_image"');
    // support_whatsapp still has its editable field here.
    expect(res.body).toContain('value="support_whatsapp"');
  });
```

(`get` and `seed` are the existing helpers in `web.test.ts`. If the settings
form uses a different field shape than `value="<key>"`, adjust the assertions to
match how `settings.njk` emits the editable key — open it to confirm.)

- [ ] **Step 3: Run the existing settings suite + new test**

Run: `pnpm --filter @app/web-admin exec vitest run test/web.test.ts -t settings`
Expected: PASS — the `/settings/edit` route is unchanged; only UI grouping changed.

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/src/routes/settings.ts
git commit -m "refactor(web): move shop identity + banner editing to Branding page"
```

---

## Task 7: web-admin nav link + uploads CSP/nosniff headers

**Files:**
- Modify: `apps/web-admin/views/base.njk` (Settings dropdown, ~lines 64-75)
- Modify: `apps/web-admin/src/server.ts` (the `/uploads/` static registration, ~line 53)

- [ ] **Step 1: Add the nav link**

In `apps/web-admin/views/base.njk`, inside the Settings dropdown `<div>` (after the `/settings` link, before/around the `/admins` link), add:

```njk
          <a href="/branding"
             class="flex items-center gap-2.5 px-4 py-2 text-sm transition-colors hover:bg-sand {% if active_nav == '/branding' %}text-pine font-semibold bg-pine-tint{% else %}text-ink-soft{% endif %}">
            <i data-lucide="image" class="w-4 h-4 {% if active_nav == '/branding' %}{% else %}text-sky-500{% endif %}"></i> Branding
          </a>
```

Also extend the dropdown's active highlight: change `{% set settings_active = active_nav == '/settings' or active_nav == '/admins' %}` to include `'/branding'`:

```njk
      {% set settings_active = active_nav == '/settings' or active_nav == '/admins' or active_nav == '/branding' %}
```

- [ ] **Step 2: Add CSP/nosniff headers to /uploads/**

In `apps/web-admin/src/server.ts`, find the uploads static registration:

```ts
await app.register(fastifyStatic, { root: UPLOADS_DIR, prefix: "/uploads/", decorateReply: false });
```

Replace with:

```ts
await app.register(fastifyStatic, {
  root: UPLOADS_DIR,
  prefix: "/uploads/",
  decorateReply: false,
  // Make user-uploaded SVGs inert: no script execution if opened directly.
  setHeaders: (res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  },
});
```

- [ ] **Step 3: Add a header test**

Append to `apps/web-admin/test/branding.test.ts`:

```ts
  it("uploaded files are served with CSP + nosniff headers", async () => {
    const mp = multipart({ csrf_token: csrf }, { field: "favicon", filename: "f.png", contentType: "image/png", content: PNG });
    await postMultipart("/branding/favicon", cookie, mp);
    const url = await getSetting(prisma, "web_favicon_url");
    const res = await app.inject({ method: "GET", url: url! });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["content-security-policy"])).toContain("default-src 'none'");
  });
```

- [ ] **Step 4: Run**

Run: `pnpm --filter @app/web-admin exec vitest run test/branding.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/views/base.njk apps/web-admin/src/server.ts apps/web-admin/test/branding.test.ts
git commit -m "feat(web): Branding nav link + inert SVG headers on /uploads"
```

---

## Task 8: Storefront favicon

**Files:**
- Create: `apps/storefront/static/favicon.svg`
- Modify: `apps/storefront/src/shop.ts` (`shopContext`, ~lines 79-101)
- Modify: `apps/storefront/views/base.njk` (`<head>`, ~line 6)
- Modify: `apps/storefront/src/server.ts` (the `/uploads/` static registration, ~line 41)
- Test: `apps/storefront/test/storefront.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/storefront/test/storefront.test.ts` a new block:

```ts
describe("favicon", () => {
  it("renders the default favicon link when none is configured", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain('rel="icon"');
    expect(res.body).toContain("/static/favicon.svg");
  });

  it("renders the configured favicon when web_favicon_url is set", async () => {
    await setSetting(prisma, "web_favicon_url", "/uploads/branding/favicon-deadbeef.png");
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain("/uploads/branding/favicon-deadbeef.png");
    await deleteSetting(prisma, "web_favicon_url");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @app/storefront exec vitest run -t favicon`
Expected: FAIL — no `rel="icon"` in the body.

- [ ] **Step 3: Create the default favicon**

Create `apps/storefront/static/favicon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2f6f5e"/><path d="M9 12h14l-1.4 9.2a2 2 0 0 1-2 1.7H12.4a2 2 0 0 1-2-1.7L9 12Zm3-2a4 4 0 0 1 8 0" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>
```

- [ ] **Step 4: Expose favicon_url from shopContext**

In `apps/storefront/src/shop.ts`, add `web_favicon_url` to the parallel reads and the returned context. Update the `Promise.all` destructuring and the call:

```ts
  const [fxRate, shopName, shopTagline, cartCount, favicon] = await Promise.all([
    getUsdIdrRate(prisma),
    getSetting(prisma, "shop_name"),
    getSetting(prisma, "shop_tagline"),
    customer
      ? prisma.cartItem
          .aggregate({ where: { userId: customer.userId }, _sum: { quantity: true } })
          .then((r) => r._sum.quantity ?? 0)
      : Promise.resolve(readGuestCart(req).reduce((n, l) => n + l.q, 0)),
    getSetting(prisma, "web_favicon_url"),
  ]);
```

In the returned object add:

```ts
    favicon_url: favicon || "/static/favicon.svg",
```

Also add `favicon_url: string;` to the `ShopContext` interface (find the interface near the top of `shop.ts` and add the field).

- [ ] **Step 5: Render the link in base.njk**

In `apps/storefront/views/base.njk`, inside `<head>` (after the `<title>` / `{% block meta %}`), add:

```njk
  <link rel="icon" href="{{ favicon_url }}">
```

- [ ] **Step 6: Add CSP/nosniff headers to /uploads/ (storefront)**

In `apps/storefront/src/server.ts`, replace:

```ts
await app.register(fastifyStatic, { root: UPLOADS_DIR, prefix: "/uploads/", decorateReply: false });
```

with:

```ts
await app.register(fastifyStatic, {
  root: UPLOADS_DIR,
  prefix: "/uploads/",
  decorateReply: false,
  setHeaders: (res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  },
});
```

- [ ] **Step 7: Run**

Run: `pnpm --filter @app/storefront exec vitest run -t favicon`
Expected: PASS.

> Note: the error/404 handlers in `server.ts` render `error.njk` without a `favicon_url`. That's fine (Nunjucks renders an empty `href`), but if you want the icon on those pages too, pass `favicon_url: "/static/favicon.svg"` in both handler view contexts. Optional — not required by the tests.

- [ ] **Step 8: Commit**

```bash
git add apps/storefront/static/favicon.svg apps/storefront/src/shop.ts apps/storefront/views/base.njk apps/storefront/src/server.ts apps/storefront/test/storefront.test.ts
git commit -m "feat(storefront): editable favicon with default fallback + inert SVG headers"
```

---

## Task 9: Storefront hero

**Files:**
- Modify: `apps/storefront/src/routes/home.ts` (the `reply.view("home.njk", …)` call, ~line 83)
- Test: `apps/storefront/test/storefront.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/storefront/test/storefront.test.ts`:

```ts
describe("hero image", () => {
  it("uses the configured hero when web_hero_url is set", async () => {
    await setSetting(prisma, "web_hero_url", "/uploads/branding/hero-cafe01.jpg");
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain("/uploads/branding/hero-cafe01.jpg");
    await deleteSetting(prisma, "web_hero_url");
  });

  it("falls back to the default hero when unset", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain("images.unsplash.com");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @app/storefront exec vitest run -t "hero image"`
Expected: FAIL — first test fails (hero is the hardcoded Unsplash URL).

- [ ] **Step 3: Read the hero setting in home.ts**

In `apps/storefront/src/routes/home.ts`, add `getSetting(prisma, "web_hero_url")` to the `Promise.all` (extend the existing array + destructuring — it already calls `getSetting(prisma, "support_whatsapp")`):

```ts
    const [categories, products, stock, ratings, bulk, reviews, rating, fulfil, waNumber, heroUrl] =
      await Promise.all([
        listActiveCategories(prisma),
        listNewestActiveProducts(prisma, 12),
        stockStatusCounts(prisma),
        productRatingSummaries(prisma),
        activeBulkPricingByProduct(prisma),
        featuredReviews(prisma, 4),
        overallRating(prisma),
        shopFulfilmentStats(prisma),
        getSetting(prisma, "support_whatsapp"),
        getSetting(prisma, "web_hero_url"),
      ]);
```

Change the view line from `hero_image: HERO_IMAGE,` to:

```ts
      hero_image: heroUrl || HERO_IMAGE,
```

(`HERO_IMAGE` is still imported from `../images` as the default.)

- [ ] **Step 4: Run**

Run: `pnpm --filter @app/storefront exec vitest run -t "hero image"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/src/routes/home.ts apps/storefront/test/storefront.test.ts
git commit -m "feat(storefront): home hero uses uploaded image when set"
```

---

## Task 10: Full green + spec doc commit

**Files:** none (verification)

- [ ] **Step 1: Typecheck everything**

Run: `pnpm -r typecheck`
Expected: PASS across all workspaces.

- [ ] **Step 2: Full test run**

Run: `pnpm test`
Expected: PASS (web-admin branding, storefront favicon/hero, bot banner, and all pre-existing suites).

- [ ] **Step 3: Commit the design + plan docs (if not already tracked)**

```bash
git add docs/superpowers/specs/2026-06-16-branding-controls-design.md docs/superpowers/plans/2026-06-16-branding-controls.md
git commit -m "docs: branding controls spec + implementation plan"
```

---

## Notes for the implementer

- **Deploy**: no schema change — only `settings` rows and files. No `prisma db push` needed. New upload dir `data/uploads/branding/` is created on first upload.
- **Guardrails honored**: no raw SQL (all via `getSetting`/`setSetting`/`logAdminAction`); no Telegram from the web (the bot reads `banner_image` and sends); settings edits stay whitelist-bound (`TEXT_KEYS` here, `EDITABLE` on Settings); every change is audited.
- **Class names**: `branding.njk` assumes the theme classes used elsewhere (`card`, `field`, `btn`, `btn-primary`, `btn-ghost`). Confirm against `apps/web-admin/views/settings.njk` and adjust if the project uses different names.
- **Bundle**: if `scripts/build-bundle.ts` enumerates static dirs or view dirs explicitly, ensure `apps/storefront/static/favicon.svg` and `branding.njk` are picked up (they live in already-bundled directories, so normally automatic — verify if the bundle test fails).
```
