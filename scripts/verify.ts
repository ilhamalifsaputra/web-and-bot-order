import { PrismaClient } from "@prisma/client";

const p = new PrismaClient({ datasourceUrl: "file:../data/bot.db" });

async function main() {
  // Exact path that was crashing: registeredUser -> upsertUser(findUnique).
  const u = await p.user.findUnique({ where: { telegramId: 5840513237n } });
  console.log("findUnique(tg=5840513237):", u ? `OK user#${u.id} created=${u.createdAt.toISOString()}` : "null (would be created)");

  // Dashboard reads.
  const itemsSold = await p.orderItem.aggregate({ where: { order: { status: "DELIVERED" } }, _sum: { quantity: true } });
  const users = await p.user.count();
  console.log("botOverallStats: itemsSold=", itemsSold._sum.quantity, "users=", users);

  const products = await p.product.findMany({ where: { isActive: true } });
  console.log("active products:", products.length);

  // Heaviest read: a full order with items+user+voucher (all have converted datetimes).
  const order = await p.order.findFirst({ include: { items: { include: { product: true, stockItem: true } }, user: true, voucher: true } });
  console.log("getOrder:", order ? `OK ${order.orderCode} status=${order.status} items=${order.items.length} created=${order.createdAt.toISOString()} expires=${order.expiresAt?.toISOString() ?? "—"}` : "(no orders)");

  // A pending-verification queue read (admin path).
  const pend = await p.order.findMany({ where: { status: "PENDING_VERIFICATION" }, include: { user: true } });
  console.log("pending verifications:", pend.length);
}
main().then(() => p.$disconnect()).catch((e) => { console.error("ERR", e.message ?? e); process.exit(1); });
