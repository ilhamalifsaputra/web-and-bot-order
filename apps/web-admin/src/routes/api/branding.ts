import type { FastifyInstance } from "fastify";
import { prisma, getSetting, setSetting, logAdminAction } from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";

const TEXT_KEYS = new Set(["shop_name", "shop_tagline", "welcome"]);

export default async function brandingApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/branding", { preHandler: currentAdmin }, async (_req, reply) => {
    const [favicon, logo, hero, banner, shopName, shopTagline, welcome] = await Promise.all([
      getSetting(prisma, "web_favicon_url"),
      getSetting(prisma, "web_logo_url"),
      getSetting(prisma, "web_hero_url"),
      getSetting(prisma, "banner_image"),
      getSetting(prisma, "shop_name"),
      getSetting(prisma, "shop_tagline"),
      getSetting(prisma, "welcome"),
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
    });
  });

  app.post("/api/branding/text", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const key = body.key ?? "";
    if (!TEXT_KEYS.has(key)) return reply.code(400).send({ error: "That field is not editable here." });
    const value = (body.value ?? "").trim();
    await setSetting(prisma, key, value);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "setting_set",
      targetType: "setting",
      details: `Changed setting "${key}" to "${value.slice(0, 80)}${value.length > 80 ? "…" : ""}".`,
    });
    return reply.send({ ok: true });
  });
}
