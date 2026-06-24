/**
 * Branding — favicon, hero, and bot banner uploads plus shop identity text.
 * Image uploads follow the product-photo pattern (catalog.ts): multipart parsed
 * manually, CSRF checked against req.admin.csrf, role gated with canMutate,
 * audited. Files land in data/uploads/branding and the path is saved to settings.
 */
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { prisma, getSetting, deleteSetting, setSetting, logAdminAction } from "@app/db";
import { currentAdmin, csrfProtect, canMutate } from "../plugins/auth";
import { redirectWithFlash } from "../flash";
import { UPLOADS_DIR } from "../paths";
import { handleUpload, deleteOldUpload } from "../lib/upload";

const BRANDING_DIR = join(UPLOADS_DIR, "branding");
const BRANDING_URL_PREFIX = "/uploads/branding";

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
      destDir: BRANDING_DIR,
      urlPrefix: BRANDING_URL_PREFIX,
      settingKey: "web_favicon_url",
      auditAction: "branding_favicon_upload",
      redirectPath: "/branding",
    }),
  );

  app.post("/branding/logo", { preHandler: currentAdmin }, (req, reply) =>
    handleUpload(req, reply, {
      kind: "logo",
      field: "logo",
      allowed: LOGO_MIME,
      maxBytes: 1 * 1024 * 1024,
      destDir: BRANDING_DIR,
      urlPrefix: BRANDING_URL_PREFIX,
      settingKey: "web_logo_url",
      auditAction: "branding_logo_upload",
      redirectPath: "/branding",
    }),
  );

  app.post("/branding/hero", { preHandler: currentAdmin }, (req, reply) =>
    handleUpload(req, reply, {
      kind: "hero",
      field: "hero",
      allowed: RASTER_MIME,
      maxBytes: 5 * 1024 * 1024,
      destDir: BRANDING_DIR,
      urlPrefix: BRANDING_URL_PREFIX,
      settingKey: "web_hero_url",
      auditAction: "branding_hero_upload",
      redirectPath: "/branding",
    }),
  );

  app.post("/branding/banner", { preHandler: currentAdmin }, (req, reply) =>
    handleUpload(req, reply, {
      kind: "banner",
      field: "banner",
      allowed: RASTER_MIME,
      maxBytes: 5 * 1024 * 1024,
      destDir: BRANDING_DIR,
      urlPrefix: BRANDING_URL_PREFIX,
      settingKey: "banner_image",
      auditAction: "branding_banner_upload",
      redirectPath: "/branding",
      afterSave: () => deleteSetting(prisma, "banner_image_fileid").then(() => undefined),
    }),
  );

  app.post("/branding/banner/clear", { preHandler: csrfProtect }, async (req, reply) => {
    if (!canMutate(req.admin!.role, req.url)) {
      return reply.code(403).type("text/plain").send("Insufficient permissions for this action.");
    }
    await deleteOldUpload(BRANDING_URL_PREFIX, BRANDING_DIR, await getSetting(prisma, "banner_image"));
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
      details: `Changed setting "${key}" to "${value.slice(0, 80)}${value.length > 80 ? "…" : ""}".`,
    });
    return redirectWithFlash(reply, "/branding", `Setting '${key}' updated.`, "success");
  });
}
