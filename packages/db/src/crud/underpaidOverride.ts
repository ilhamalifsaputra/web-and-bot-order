/**
 * The Payments page's underpaid-orders list, with what an admin needs to decide "Deliver anyway" for the
 * order's own product family: which family it is, who fulfils it, the product the buyer chose and, for a
 * game top-up, the target the supplier will receive.
 *
 * The family comes from `orderTransactionFamily` (the category group, the same rule the buyer's progress
 * message uses) and never from a product name. The target comes from the buyer's stored answers, which are
 * encrypted at rest: the order is read with the display-only decrypting reader, so an unreadable value
 * yields no target (plus a warning naming only the order) rather than failing the whole list. The raw
 * column is stripped from every row; only the one display string leaves this function.
 */
import { orderTransactionFamily, fulfillmentProviderFor, type FulfillmentProvider } from "@app/core/orderFulfillment";
import { OrderStatus } from "@app/core/enums";
import { tryDecryptCustomerData } from "@app/core/credentialCrypto";
import type { Db } from "./_types";
import { ORDER_USER_SELECT, withoutDeliveredContent } from "./orders";
import { buildDigiflazzCustomerNo } from "./digiflazz";

export interface UnderpaidOverrideInfo {
  family: "GAME_TOPUP" | "PREMIUM_APPS";
  provider: FulfillmentProvider;
  productName: string;
  /** The player id / target, for a game top-up only; null when none is stored or it cannot be read. */
  target: string | null;
}

export async function listUnderpaidOrdersForAdmin(db: Db, opts: { limit?: number } = {}) {
  const orders = await db.order.findMany({
    where: { status: OrderStatus.UNDERPAID },
    include: {
      user: { select: ORDER_USER_SELECT },
      items: { include: { product: { include: { product: { include: { category: true } } } } } },
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
  });
  return orders.map((order) => {
    const family = orderTransactionFamily(order);
    let override: UnderpaidOverrideInfo | null = null;
    if (family !== "WALLET_TOPUP") {
      const item = order.items[0];
      let target: string | null = null;
      if (family === "GAME_TOPUP" && item) {
        const answers = tryDecryptCustomerData(order.customerData, { orderId: order.id, purpose: "the underpaid-order override screen" });
        try {
          target = buildDigiflazzCustomerNo(item.product, answers, order.inputConfigSnapshot) || null;
        } catch {
          target = null;
        }
      }
      override = { family, provider: fulfillmentProviderFor(order), productName: item?.product.name ?? "", target };
    }
    return { ...withoutDeliveredContent(order), override };
  });
}
