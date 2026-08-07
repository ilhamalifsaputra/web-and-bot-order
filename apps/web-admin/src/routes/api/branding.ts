import type { FastifyInstance } from "fastify";
import { prisma, getSetting, setSetting, deleteSetting, logAdminAction, OWNER_EMAIL_RE } from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { deleteOldUpload } from "../../lib/upload";
import { BRANDING_DIR, BRANDING_URL_PREFIX, BRANDING_IMAGE_FIELDS } from "../branding";

const TEXT_KEYS = new Set([
  "shop_name",
  "shop_tagline",
  "welcome",
  // Owner-email design system: brand accent color + support contact, shared
  // across every HTML-upgraded owner email.
  "email_brand_color",
  "email_support_address",
  // Per-template copy overrides — see the plan's Global Constraints table for
  // the documented defaults these fall back to when unset (resolved in
  // packages/outbox-dispatcher/src/emailTemplates.ts).
  "email_order_paid_subject",
  "email_order_paid_title",
  "email_order_paid_subtitle",
  "email_order_paid_message",
  "email_reset_password_subject",
  "email_reset_password_title",
  "email_reset_password_subtitle",
  "email_reset_password_message",
]);

// Accent color for the owner-email design system's buttons/badges/header rule.
const BRAND_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Per-key character caps for the 8 free-text email copy fields (Global
// Constraints table): subject/title stay short enough for a mail client's
// preview pane, subtitles get a little more room, and the intro-paragraph
// "message" fields are the most generous since they're the template's body copy.
const TEXT_KEY_MAX_LENGTH: Record<string, number> = {
  email_order_paid_subject: 150,
  email_order_paid_title: 150,
  email_order_paid_subtitle: 200,
  email_order_paid_message: 1000,
  email_reset_password_subject: 150,
  email_reset_password_title: 150,
  email_reset_password_subtitle: 200,
  email_reset_password_message: 1000,
};

export default async function brandingApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/branding", { preHandler: currentAdmin }, async (_req, reply) => {
    const [
      favicon,
      logo,
      hero,
      banner,
      shopName,
      shopTagline,
      welcome,
      emailBrandColor,
      emailSupportAddress,
      emailOrderPaidSubject,
      emailOrderPaidTitle,
      emailOrderPaidSubtitle,
      emailOrderPaidMessage,
      emailResetPasswordSubject,
      emailResetPasswordTitle,
      emailResetPasswordSubtitle,
      emailResetPasswordMessage,
    ] = await Promise.all([
      getSetting(prisma, "web_favicon_url"),
      getSetting(prisma, "web_logo_url"),
      getSetting(prisma, "web_hero_url"),
      getSetting(prisma, "banner_image"),
      getSetting(prisma, "shop_name"),
      getSetting(prisma, "shop_tagline"),
      getSetting(prisma, "welcome"),
      getSetting(prisma, "email_brand_color"),
      getSetting(prisma, "email_support_address"),
      getSetting(prisma, "email_order_paid_subject"),
      getSetting(prisma, "email_order_paid_title"),
      getSetting(prisma, "email_order_paid_subtitle"),
      getSetting(prisma, "email_order_paid_message"),
      getSetting(prisma, "email_reset_password_subject"),
      getSetting(prisma, "email_reset_password_title"),
      getSetting(prisma, "email_reset_password_subtitle"),
      getSetting(prisma, "email_reset_password_message"),
    ]);
    return reply.send({
      faviconUrl: favicon ?? "",
      logoUrl: logo ?? "",
      heroUrl: hero ?? "",
      bannerUrl: banner?.startsWith("/uploads/") ? banner : "",
      bannerIsLegacy: Boolean(banner) && !banner?.startsWith("/uploads/"),
      shopName: shopName ?? "",
      shopTagline: shopTagline ?? "",
      welcome: welcome ?? "",
      emailBrandColor: emailBrandColor ?? "",
      emailSupportAddress: emailSupportAddress ?? "",
      emailOrderPaidSubject: emailOrderPaidSubject ?? "",
      emailOrderPaidTitle: emailOrderPaidTitle ?? "",
      emailOrderPaidSubtitle: emailOrderPaidSubtitle ?? "",
      emailOrderPaidMessage: emailOrderPaidMessage ?? "",
      emailResetPasswordSubject: emailResetPasswordSubject ?? "",
      emailResetPasswordTitle: emailResetPasswordTitle ?? "",
      emailResetPasswordSubtitle: emailResetPasswordSubtitle ?? "",
      emailResetPasswordMessage: emailResetPasswordMessage ?? "",
    });
  });

  app.post("/api/branding/text", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const key = body.key ?? "";
    if (!TEXT_KEYS.has(key)) return reply.code(400).send({ error: "That field is not editable here." });
    const value = (body.value ?? "").trim();

    // Format validation for the two structured keys — empty is always allowed
    // to be SAVED here (clears the override), same as every other text field.
    // For email_brand_color and the two email_*_subject keys specifically,
    // an empty/invalid stored value is neutralized back to the coded default
    // at RENDER time instead (packages/core/src/email/theme.ts's
    // resolveAccentColor; the `subject?.trim() || default` fallback in
    // emailTemplates.ts / apiAuth.ts) — not here at save time — so a
    // half-migrated deploy or a future write path that bypasses this
    // endpoint still gets the same safe fallback.
    if (key === "email_brand_color" && value !== "" && !BRAND_COLOR_RE.test(value)) {
      return reply.code(400).send({ error: "Enter a 6-digit hex color, e.g. #4F46E5." });
    }
    if (key === "email_support_address" && value !== "" && !OWNER_EMAIL_RE.test(value)) {
      return reply.code(400).send({ error: "That doesn't look like a valid email address, e.g. support@example.com." });
    }
    const maxLength = TEXT_KEY_MAX_LENGTH[key];
    if (maxLength !== undefined && value.length > maxLength) {
      return reply.code(400).send({ error: `Keep this under ${maxLength} characters (currently ${value.length}).` });
    }

    await setSetting(prisma, key, value);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "setting_set",
      targetType: "setting",
      details: `Changed setting "${key}" to "${value.slice(0, 80)}${value.length > 80 ? "…" : ""}".`,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/branding/image/clear", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const field = body.field ?? "";
    const cfg = BRANDING_IMAGE_FIELDS[field];
    if (!cfg) return reply.code(400).send({ error: "That field is not editable here." });
    const oldValue = await getSetting(prisma, cfg.settingKey);
    if (!oldValue) return reply.send({ ok: true, cleared: false });
    await deleteOldUpload(BRANDING_URL_PREFIX, BRANDING_DIR, oldValue, cfg.webVariants);
    await deleteSetting(prisma, cfg.settingKey);
    for (const key of cfg.extraKeys ?? []) await deleteSetting(prisma, key);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: cfg.auditAction,
      targetType: "setting",
      details: `Cleared setting "${cfg.settingKey}" to its default value.`,
    });
    return reply.send({ ok: true, cleared: true });
  });

  app.post("/api/branding/text/reset", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const key = body.key ?? "";
    if (!TEXT_KEYS.has(key)) return reply.code(400).send({ error: "That field is not editable here." });
    await deleteSetting(prisma, key);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "setting_clear",
      targetType: "setting",
      details: `Cleared setting "${key}" to its default value.`,
    });
    return reply.send({ ok: true });
  });
}
