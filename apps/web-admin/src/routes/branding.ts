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
// Logos want transparency (PNG/SVG) so JPG is excluded; WebP allowed.
const LOGO_MIME: Record<string, string> = {
  "image/png": "png",
  "image/svg+xml": "svg",
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
    const [favicon, logo, hero, banner, shopName, shopTagline, welcome] = await Promise.all([
      getSetting(prisma, "web_favicon_url"),
      getSetting(prisma, "web_logo_url"),
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
      logo_url: logo ?? "",
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
      kind: "favicon",
      field: "favicon",
      allowed: FAVICON_MIME,
      maxBytes: 1 * 1024 * 1024,
      settingKey: "web_favicon_url",
      auditAction: "branding_favicon_upload",
    }),
  );

  app.post("/branding/logo", { preHandler: currentAdmin }, (req, reply) =>
    handleUpload(req, reply, {
      kind: "logo",
      field: "logo",
      allowed: LOGO_MIME,
      maxBytes: 1 * 1024 * 1024,
      settingKey: "web_logo_url",
      auditAction: "branding_logo_upload",
    }),
  );

  app.post("/branding/hero", { preHandler: currentAdmin }, (req, reply) =>
    handleUpload(req, reply, {
      kind: "hero",
      field: "hero",
      allowed: RASTER_MIME,
      maxBytes: 5 * 1024 * 1024,
      settingKey: "web_hero_url",
      auditAction: "branding_hero_upload",
    }),
  );

  app.post("/branding/banner", { preHandler: currentAdmin }, (req, reply) =>
    handleUpload(req, reply, {
      kind: "banner",
      field: "banner",
      allowed: RASTER_MIME,
      maxBytes: 5 * 1024 * 1024,
      settingKey: "banner_image",
      auditAction: "branding_banner_upload",
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
      adminId: req.admin!.userId,
      action: "branding_banner_clear",
      targetType: "setting",
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
      adminId: req.admin!.userId,
      action: "setting_set",
      targetType: "setting",
      details: `${key}=${value.slice(0, 80)}${value.length > 80 ? "…" : ""}`,
    });
    return redirectWithFlash(reply, "/branding", `Setting '${key}' updated.`, "success");
  });
}
