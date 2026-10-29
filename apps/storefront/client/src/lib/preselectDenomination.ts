/**
 * The denomination a product page opens on. A flash card links to
 * `/p/<slug>?d=<denominationId>` so the buyer lands on the discounted plan;
 * the id is honoured only when it names a plan that exists on the product and
 * can be bought. Anything else (missing, malformed, unknown, sold out) falls
 * back to the usual default: the first purchasable plan, else the first plan.
 */
export function preselectedDenomination<D extends { id: number; purchasable: boolean }>(
  denominations: readonly D[],
  requested: string | null,
): D | undefined {
  const id = requested !== null && /^\d{1,9}$/.test(requested) ? Number(requested) : null;
  const wanted = id === null ? undefined : denominations.find((d) => d.id === id && d.purchasable);
  return wanted ?? denominations.find((d) => d.purchasable) ?? denominations[0];
}
