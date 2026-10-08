import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";

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

type KnownCurrency = Parameters<typeof formatCurrencyDisplay>[1];

function money(value: string, currency: string): string {
  if (currency === "IDR" || currency === "USDT" || currency === "USD") {
    return formatCurrencyDisplay(value, currency as KnownCurrency);
  }
  return `${value} ${currency}`;
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
    const price = money(g.unitPrice, order.currency);
    return {
      name: g.name,
      units: g.units,
      unitPriceText: g.units === 1 ? price : `${g.units} units · ${price} each`,
    };
  });
  return { lines, totalText: money(order.totalAmount, order.currency) };
}
