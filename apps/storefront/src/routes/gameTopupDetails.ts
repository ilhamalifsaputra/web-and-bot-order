/**
 * Game top-up details for the buyer's pay page and order detail: the product
 * slug (retry/back link), the Game ID / Zone / Server the buyer typed and the
 * full Digiflazz serial number. Callers have already run the order's owner
 * check (404 otherwise), so everything here is for the owner only.
 */
import { orderGameTargets, type GameTarget } from "@app/core/playerInput";
import { decryptDeliveredContent } from "@app/core/credentialCrypto";
import { OrderStatus } from "@app/core/enums";
import { logger } from "@app/core/logger";

type DetailsOrder = {
  orderCode: string;
  status: string;
  inputConfigSnapshot: string | null;
  customerData: string | null;
  items: Array<{ product: { additionalFields: string | null; providerInputMapping: string | null; product: { slug: string } } }>;
};

export type GameTopupDetails = {
  product_slug: string | null;
  game_target: GameTarget[] | null;
  sn: string | null;
};

/** Decrypt a DELIVERED game top-up's serial number. A failure is never the
 * buyer's problem: the SN is left out and only the order code and the error's
 * class are logged (a message could echo part of the stored value). */
export function decryptGameSn(order: { id: number; orderCode: string; deliveredContent: string | null }): string | null {
  try {
    return decryptDeliveredContent(order.deliveredContent, order.id);
  } catch (error) {
    logger.warn({ orderCode: order.orderCode, errorName: error instanceof Error ? error.name : typeof error },
      "The serial number of a delivered game top-up could not be decrypted, so the buyer's page shows no SN line; the order itself is unaffected.");
    return null;
  }
}

/** `game_target` and `sn` stay null for anything but a GAME_TOPUP order.
 * `readSn` returns the plaintext delivered content and is only called for a
 * DELIVERED game top-up. Game ID / Zone / Server are read only through the
 * denomination's input mapping (`orderGameTargets`), never any other answer. */
export function gameTopupDetails(order: DetailsOrder, transactionType: string, readSn: () => string | null): GameTopupDetails {
  const first = order.items[0];
  const details: GameTopupDetails = { product_slug: first?.product.product.slug ?? null, game_target: null, sn: null };
  if (transactionType !== "GAME_TOPUP" || !first) return details;
  try {
    details.game_target = orderGameTargets(first.product, order.inputConfigSnapshot, order.customerData);
  } catch (error) {
    logger.warn({ orderCode: order.orderCode, errorName: error instanceof Error ? error.name : typeof error },
      "The saved input configuration of a game top-up could not be read, so the buyer's page shows no Game ID.");
  }
  if (order.status === OrderStatus.DELIVERED) details.sn = readSn()?.trim() || null;
  return details;
}
