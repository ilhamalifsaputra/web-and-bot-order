/**
 * Fase 0 acceptance check: Node can read the existing shared SQLite DB through
 * @app/db, and @app/core (config/money/i18n) works. Read-only.
 */
import { prisma, initDb } from "@app/db";
import { config, isAdmin } from "@app/core/config";
import { money, fmtMoney } from "@app/core/money";
import { t } from "@app/core/i18n";
import { OrderStatus } from "@app/core/enums";

async function main() {
  await initDb();

  const [users, settings, pending, orders] = await Promise.all([
    prisma.user.count(),
    prisma.setting.count(),
    prisma.notificationOutbox.count({ where: { status: "pending" } }),
    prisma.order.count(),
  ]);

  console.log("=== @app/db read check ===");
  console.log("users:", users);
  console.log("settings:", settings);
  console.log("orders:", orders);
  console.log("pending notifications:", pending);

  const sample = await prisma.user.findFirst({
    select: { id: true, telegramId: true, role: true, walletBalance: true },
  });
  console.log("sample user:", JSON.stringify(sample));

  console.log("\n=== @app/core check ===");
  console.log("CURRENCY:", config.CURRENCY, "| TIMEZONE:", config.TIMEZONE);
  console.log("ADMIN_IDS:", config.ADMIN_IDS, "| isAdmin(111):", isAdmin(111));
  console.log("money(5.00071):", fmtMoney(money("5.00071")));
  console.log("OrderStatus.DELIVERED:", OrderStatus.DELIVERED);
  console.log("i18n en:", t("start.welcome", "en"));
  console.log("i18n id:", t("start.welcome", "id"));

  await prisma.$disconnect();
  console.log("\nOK: Fase 0 verification passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
