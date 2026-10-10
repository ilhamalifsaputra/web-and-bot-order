/**
 * Which product-page template the client renders: "game" is InstantBuyPage
 * (the top-up page), "catalog" is the Premium-style plan picker + cart page.
 * Decided here so the client never derives it. Every GAME_TOPUP category is
 * "game" whatever its checkoutFlow says; a non-game category still gets "game"
 * when it opted into the instant flow.
 */
export type ProductTemplate = "game" | "catalog";

export function productTemplate(category: {
  group: string | null;
  checkoutFlow: string;
}): ProductTemplate {
  if (category.group === "GAME_TOPUP") return "game";
  return category.checkoutFlow === "instant" ? "game" : "catalog";
}
