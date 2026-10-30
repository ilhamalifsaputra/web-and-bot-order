/**
 * Mirror of MIN_CATEGORY_SECTION_PRODUCTS in packages/core/src/productGroups.ts:
 * a Premium Apps category needs this many active products for its own section
 * on the website home page. The admin client may not import @app/core
 * (scripts/check-frontend-boundaries.ts), so the number is copied here and
 * packages/core/src/productGroups.test.ts fails if the two ever differ.
 */
export const MIN_PREMIUM_SECTION_PRODUCTS = 3;
