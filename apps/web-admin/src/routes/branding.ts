/**
 * Branding — favicon, hero, and bot banner uploads plus shop identity text.
 * Image uploads follow the product-photo pattern (catalog.ts): multipart parsed
 * manually, CSRF checked against req.admin.csrf, role gated with canMutate,
 * audited. Files land in data/uploads/branding and the path is saved to settings.
 */
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { prisma, getSetting, deleteSetting, setSetting, logAdminAction } from "@app/db";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash } from "../flash";
import { UPLOADS_DIR } from "../paths";
import { handleUpload, deleteOldUpload } from "../lib/upload";
// Banner and favicon deliberately get no WebP siblings: the banner is uploaded
// to Telegram by the bot, and the favicon is an ICO/SVG. See webpVariants.ts.
import { HERO_WIDTHS, LOGO_WIDTHS } from "../lib/webpVariants";

export const BRANDING_DIR = join(UPLOADS_DIR, "branding");
export const BRANDING_URL_PREFIX = "/uploads/branding";

/** Per-field config for "reset to default" (`POST /api/branding/image/clear`). */
export const BRANDING_IMAGE_FIELDS: Record<string, {
  settingKey: string;
  webVariants?: number[];
  extraKeys?: string[];
  auditAction: string;
}> = {
  favicon: { settingKey: "web_favicon_url", auditAction: "branding_favicon_clear" },
  logo: { settingKey: "web_logo_url", webVariants: LOGO_WIDTHS, auditAction: "branding_logo_clear" },
  hero: { settingKey: "web_hero_url", webVariants: HERO_WIDTHS, auditAction: "branding_hero_clear" },
  banner: { settingKey: "banner_image", extraKeys: ["banner_image_fileid"], auditAction: "branding_banner_clear" },
};

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
  // GET /branding retired — now served by React SPA via GET /api/branding.

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
      details: (filename) => `Uploaded a new favicon image (${filename}).`,
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
      webVariants: LOGO_WIDTHS,
      auditAction: "branding_logo_upload",
      details: (filename) => `Uploaded a new logo image (${filename}).`,
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
      webVariants: HERO_WIDTHS,
      auditAction: "branding_hero_upload",
      details: (filename) => `Uploaded a new hero image (${filename}).`,
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
      details: (filename) => `Uploaded a new banner image (${filename}).`,
      afterSave: () => deleteSetting(prisma, "banner_image_fileid").then(() => undefined),
    }),
  );

  // POST /branding/banner/clear retired — superseded by the JSON
  // POST /api/branding/image/clear (apps/web-admin/src/routes/api/branding.ts).
  // The old route 303-redirected to the now-unregistered /branding, which fell
  // through to the SPA shell's HTML 200 — fetch()'s res.json() on that body
  // always threw, so this route was already broken from the frontend's side.

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
