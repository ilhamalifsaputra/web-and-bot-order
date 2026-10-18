import { canonicalProduct, type CanonicalProduct, type CanonicalProductContext, type CanonicalProductInput } from "@app/core/canonicalProduct";

/**
 * The storefront never shows the Game Server level (only the Telegram bot does),
 * so every canonical product the storefront builds passes through here and has
 * `gameServer` nulled: neither `qualifiers` nor `product.gameServer` carries it.
 */
export function storefrontCanonicalProduct(input: CanonicalProductInput, context: CanonicalProductContext): CanonicalProduct {
  return canonicalProduct({ ...input, product: { ...input.product, gameServer: null } }, context);
}
