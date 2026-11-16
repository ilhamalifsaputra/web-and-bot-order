/**
 * The words of the Payments page's "Deliver anyway" override, per product family.
 *
 * Game Top Up and Premium Apps stay separate (AGENTS.md): a game top-up is forwarded to its supplier and
 * shows the player target; a Premium App delivers an account or goes to the manual queue and shows the
 * plan. The server decides the family from the category group and sends it on each underpaid row
 * (`overrideFamily` / `overrideProvider`); this module only maps those two values to copy, so no component
 * carries its own if/else chain. A row without them (an older server, or a readonly admin who cannot act)
 * gets neutral wording that names neither family.
 */
export type OverrideFamily = "GAME_TOPUP" | "PREMIUM_APPS";
export type OverrideProvider = "DIGIFLAZZ" | "MANUAL" | "STOCK";
export type OverrideOutcome = "delivered" | "forwarded_to_supplier" | "queued_manual";

export interface OverrideRowFields {
  orderCode?: string;
  overrideFamily?: OverrideFamily;
  overrideProvider?: OverrideProvider;
}

export interface OverrideCopy {
  /** Absent for a row whose server did not say which family it is. */
  family?: OverrideFamily;
  menuLabel: string;
  title: string;
  confirmLabel: string;
  /** What happens to the order, then the standing reminder that the payment is still short. */
  sentences: string[];
  /** The label of the line naming what is being fulfilled: a game product or a Premium App plan. */
  productLabel: "Product" | "Plan";
  /** Game Top Up only: whether the player target is shown. */
  showsTarget: boolean;
}

const PAYMENT_INCOMPLETE = "Payment remains incomplete.";

export function underpaidOverrideCopy(row: OverrideRowFields): OverrideCopy {
  if (row.overrideFamily === "GAME_TOPUP") {
    if (row.overrideProvider === "DIGIFLAZZ") {
      return {
        family: "GAME_TOPUP",
        menuLabel: "Forward to Digiflazz",
        title: "Forward this top-up to Digiflazz?",
        confirmLabel: "Forward to Digiflazz",
        sentences: ["The order was underpaid. Digiflazz will be charged from your supplier balance.", PAYMENT_INCOMPLETE],
        productLabel: "Product",
        showsTarget: true,
      };
    }
    const where = row.overrideProvider === "STOCK" ? "A code is taken from stock and sent now." : "The order goes to the manual queue.";
    return {
      family: "GAME_TOPUP",
      menuLabel: "Fulfil anyway",
      title: "Fulfil this top-up anyway?",
      confirmLabel: "Fulfil anyway",
      sentences: [`The order was underpaid. ${where}`, PAYMENT_INCOMPLETE],
      productLabel: "Product",
      showsTarget: true,
    };
  }
  if (row.overrideFamily === "PREMIUM_APPS") {
    const base = { family: "PREMIUM_APPS" as const, menuLabel: "Deliver account", title: "Deliver this account anyway?", confirmLabel: "Deliver account", productLabel: "Plan" as const, showsTarget: false };
    if (row.overrideProvider === "STOCK") {
      return { ...base, sentences: ["The order was underpaid. An account is taken from stock and sent now.", PAYMENT_INCOMPLETE] };
    }
    if (row.overrideProvider === "MANUAL") {
      return { ...base, sentences: ["The order was underpaid. The order goes to the manual queue.", PAYMENT_INCOMPLETE] };
    }
    return { ...base, sentences: ["The order was underpaid. The order is fulfilled the usual way.", PAYMENT_INCOMPLETE] };
  }
  // No family (an older server): wording that names neither family,.
  return {
    menuLabel: "Deliver anyway",
    title: "Deliver this order anyway?",
    confirmLabel: "Deliver anyway",
    sentences: [`Order ${row.orderCode} was underpaid. Accept the shortfall and fulfil this order.`, PAYMENT_INCOMPLETE],
    productLabel: "Product",
    showsTarget: false,
  };
}

/** The success toast, by what the server did with the order. An unknown or missing outcome reads as delivered. */
export function overrideSuccessMessage(outcome: string | undefined): string {
  if (outcome === "forwarded_to_supplier") return "Order sent to Digiflazz for fulfilment.";
  if (outcome === "queued_manual") return "Order queued for manual fulfilment.";
  return "Order delivered.";
}
