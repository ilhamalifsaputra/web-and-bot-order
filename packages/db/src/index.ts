export { prisma, initDb } from "./client";
export type { PrismaClient, Tx } from "./client";
export type { Db } from "./crud/_types";

// CRUD repositories (ported per-domain from Python crud.py).
export * from "./crud/users";
export * from "./crud/catalog";
export * from "./crud/stock";
export * from "./crud/cart";
export * from "./crud/vouchers";
export * from "./crud/orders";
export * from "./crud/referrals";
export * from "./crud/reviews";
export * from "./crud/support";
export * from "./crud/settings";
export * from "./crud/audit";
export * from "./crud/reports";
export * from "./crud/notifications";
export * from "./crud/binance_internal";
export * from "./crud/broadcasts";
export * from "./crud/pricing";
export * from "./crud/tokopay";
export * from "./crud/credentials";
