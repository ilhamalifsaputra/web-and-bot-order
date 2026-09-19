export const RESTOCK_REQUESTS_TIP = "Customers who asked to be notified when this SKU is back in stock";

/** "—" when nobody is waiting or the SKU already has stock (a request only
 * matters while the SKU is out); otherwise the request count. */
export function formatRestockRequests(count: number | undefined, available: number | undefined): string {
  if (!count || (available ?? 0) > 0) return "—";
  return String(count);
}
