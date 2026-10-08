import { formatMoneyOrCode } from "../components/shared/CurrencyAmount";

export interface TicketOrderInput {
  items: { id: number; quantity: number; unitPrice: string; product: { id: number; name: string } }[];
  totalAmount: string;
  currency: string;
}

export interface TicketOrderLine {
  name: string;
  units: number;
  /** "Rp18.000" for one unit, "2 units · Rp18.000 each" for more. */
  unitPriceText: string;
}

export interface TicketOrderSummary {
  lines: TicketOrderLine[];
  totalText: string;
}

/** Collapses an order's items into one line per product + unit price, product-agnostic. */
export function summarizeTicketOrder(order: TicketOrderInput): TicketOrderSummary {
  const groups = new Map<string, { name: string; units: number; unitPrice: string }>();
  for (const item of order.items) {
    const key = `${item.product.id}|${item.unitPrice}`;
    const group = groups.get(key);
    if (group) group.units += item.quantity;
    else groups.set(key, { name: item.product.name, units: item.quantity, unitPrice: item.unitPrice });
  }
  const lines = [...groups.values()].map((g) => {
    const price = formatMoneyOrCode(g.unitPrice, order.currency);
    return {
      name: g.name,
      units: g.units,
      unitPriceText: g.units === 1 ? price : `${g.units} units · ${price} each`,
    };
  });
  return { lines, totalText: formatMoneyOrCode(order.totalAmount, order.currency) };
}
