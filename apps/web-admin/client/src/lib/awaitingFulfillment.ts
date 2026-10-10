/**
 * One wording for the "Awaiting Fulfillment" counter wherever it appears
 * (Operation Center card, Orders KPI tile). Both read
 * `countAwaitingManualFulfillment`, which leaves provider (Digiflazz) orders
 * that are still in flight out of the number.
 */
export const AWAITING_FULFILLMENT_HINT =
  "Orders that need a manual hand-off. Orders still being processed by the provider are not counted here.";
