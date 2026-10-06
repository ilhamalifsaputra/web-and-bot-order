/**
 * Make orders Digiflazz-routed in tests, so they settle into PROCESSING (provider DIGIFLAZZ) instead of being
 * delivered from stock. Used by the per-rail tests that check each payment rail starts the instant Digiflazz
 * dispatch (`triggerDigiflazzDispatch`) once the payment commits.
 */
import type { PrismaClient } from "@prisma/client";

/** Route one already-created (still unpaid) order to Digiflazz. `settlePaidOrder` reads the order's own
 * `fulfillmentProvider` before anything else, so the denomination can stay a plain stock SKU. */
export async function routeOrderToDigiflazz(db: PrismaClient, orderId: number): Promise<void> {
  await db.order.update({ where: { id: orderId }, data: { fulfillmentProvider: "DIGIFLAZZ" } });
}

/** Buyer answers for the one input field {@link routeDenominationToDigiflazz} adds, in the stored JSON shape. */
export const DIGIFLAZZ_CUSTOMER_DATA = JSON.stringify([{ user_id: "123456789" }]);
/** The same answers in the shape a storefront request body carries them (not pre-stringified). */
export const DIGIFLAZZ_CUSTOMER_DATA_RAW = [{ user_id: "123456789" }];

/** Route a denomination to Digiflazz, for flows that create and settle the order in one call. Order creation
 * refuses a Digiflazz SKU with no input fields, so this adds one (`user_id`); pass
 * {@link DIGIFLAZZ_CUSTOMER_DATA} as the order's customer data. */
export async function routeDenominationToDigiflazz(db: PrismaClient, denominationId: number, supplierSku = "ml100"): Promise<void> {
  await db.denomination.update({
    where: { id: denominationId },
    data: {
      autoDeliverySource: "digiflazz",
      supplierSku,
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
      ]),
    },
  });
}
