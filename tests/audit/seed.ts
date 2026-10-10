// Disposable local fixtures only. Never run a bot, outbox worker or gateway.
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { createCategory, createCatalogProduct, createDenomination, bulkAddStock, createWebUser, markSetupComplete, setSetting } from "@app/db";
import { hashPassword } from "@app/core/password";

async function main() {
  const url = new URL(process.env.DATABASE_URL_PRISMA!);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/trustance_readiness_20261010" || url.searchParams.get("schema") !== "readiness_audit") {
    throw new Error("Refusing to seed outside the dedicated local audit database/schema.");
  }
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS "readiness_audit" CASCADE');
    execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", { stdio: "ignore", env: process.env });
    await markSetupComplete(db);
    for (const [key, value] of Object.entries({
      shop_name: "Trustance", shop_tagline: "", business_legal_name: "PT Contoh Audit Digital",
      business_address: "Alamat sintetis untuk pengujian lokal", business_email: "support@example.invalid",
      business_phone: "+62 812 0000 0000", business_hours: "Jam layanan uji lokal",
      bot_username: "", support_contact: "", support_whatsapp: "", web_logo_url: "",
      xendit_secret_key: "xnd_development_audit_placeholder", xendit_callback_token: "audit-placeholder",
      xendit_enabled: "true", xendit_qris_enabled: "true", xendit_card_enabled: "true",
    })) await setSetting(db, key, value);
    for (const [name, group] of [["Audit Apps", "PREMIUM_APPS"], ["Audit Games", "GAME_TOPUP"], ["Audit Legacy", null]] as const) {
      const category = await createCategory(db, { name, group });
      const game = group === "GAME_TOPUP";
      const product = await createCatalogProduct(db, {
        categoryId: category.id, name: game ? "Audit Game" : group ? "Audit Subscription" : "Audit Legacy App",
        description: "Produk sintetis lokal; tidak dijual di produksi.",
        ...(game ? { gameRegion: "Indonesia" } : {}),
      });
      const denom = await createDenomination(db, {
        productId: product.id, name: game ? "100 Diamonds" : "Monthly plan", type: "SHARED",
        durationLabel: game ? "" : "1 Month", price: "25000", warrantyDays: game ? 0 : 7,
        deliveryType: game ? "manual_with_info" : "auto",
        ...(game ? { qtyValue: 100, qtyUnit: "Diamonds", additionalFields: JSON.stringify([{ key: "player_id", label: { en: "Player ID", id: "ID Pemain" }, type: "text", required: true }]) } : {}),
      });
      if (!game) await bulkAddStock(db, denom.id, ["synthetic-deliverable-do-not-use"]);
    }
    await createWebUser(db, { loginUsername: "auditshopper", email: "audit@example.invalid", passwordHash: hashPassword("Audit-local-only-2026!"), fullName: "Audit Shopper" });
    console.log("Readiness audit fixtures seeded in the isolated local database.");
  } finally { await db.$disconnect(); }
}
main().catch(() => { console.error("Local audit fixture setup failed; check the dedicated database configuration."); process.exitCode = 1; });
