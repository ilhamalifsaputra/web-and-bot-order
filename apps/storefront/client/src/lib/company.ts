import type { ShopContext } from "../api/types";

/**
 * The `{company}` value for policy copy: the owner-set legal entity name, or
 * the shop name when none is configured. Must match the crawler shell's
 * fallback in apps/storefront/src/routes/spaShell.ts (staticPageArgs).
 */
export function companyName(ctx: ShopContext | undefined): string {
  const legal = ctx?.business?.legal_name?.trim();
  return legal || (ctx?.shop_name ?? "");
}
