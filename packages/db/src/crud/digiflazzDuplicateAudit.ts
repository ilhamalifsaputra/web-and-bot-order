import type { Db } from "./_types";

export interface DuplicateAuditProduct {
  id: number; name: string; slug: string; categoryId: number;
  source: string | null; region: string | null; variant: string | null;
  active: boolean; archived: boolean; image: string | null;
  denominations: Array<{
    id: number; sku: string | null; provider?: string | null; archived: boolean; active: boolean;
    price: string; cost: string | null; priceOverridden: boolean;
    inventory: number; orders: number; mappings: unknown;
    metadata: unknown;
  }>;
}

/** Name normalization is ONLY a candidate signal, never merge evidence. */
export function duplicateCandidateName(name: string) {
  return name.normalize("NFKC").toLowerCase().replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
}

export function classifyDigiflazzDuplicates(products: DuplicateAuditProduct[]) {
  const candidates = [];
  for (let i = 0; i < products.length; i++) {
    for (const right of products.slice(i + 1)) {
      const left = products[i]!;
      const leftSkus = new Set(left.denominations.filter(d => !d.provider || d.provider === "digiflazz").map(d => d.sku).filter((s): s is string => !!s));
      const rightSkus = new Set(right.denominations.filter(d => !d.provider || d.provider === "digiflazz").map(d => d.sku).filter((s): s is string => !!s));
      const overlap = [...leftSkus].filter(sku => rightSkus.has(sku)).sort();
      const sameName = duplicateCandidateName(left.name) === duplicateCandidateName(right.name);
      if (!overlap.length && !sameName && (!left.source || left.source !== right.source)) continue;
      const differentScope = left.categoryId !== right.categoryId ||
        (!!left.region && !!right.region && left.region !== right.region) ||
        (!!left.variant && !!right.variant && left.variant !== right.variant);
      const classification = differentScope ? "legitimate_separate_product" :
        overlap.length && overlap.length === leftSkus.size && overlap.length === rightSkus.size ? "exact_overlap" :
        overlap.length ? "partial_overlap" : "name_only_similarity";
      candidates.push({ leftId: left.id, rightId: right.id, classification, exactSkuOverlap: overlap,
        requiresReview: true, scopeConflict: differentScope && overlap.length > 0 });
    }
  }
  const ownership = new Map<string, { provider: string; supplierSku: string; owners: Array<{ productId: number; denominationId: number }> }>();
  for (const product of products) for (const denomination of product.denominations) {
    if (!denomination.sku || denomination.archived) continue;
    const provider = denomination.provider ?? "digiflazz";
    const key = `${provider}\u0000${denomination.sku}`;
    const entry = ownership.get(key) ?? { provider, supplierSku: denomination.sku, owners: [] };
    entry.owners.push({ productId: product.id, denominationId: denomination.id });
    ownership.set(key, entry);
  }
  const identityConflicts = [...ownership.values()].filter(entry => entry.owners.length > 1);
  return { products, candidates, identityConflicts };
}

/** Read-only and compatible with pre-migration databases. No credentials,
 * customer answers or stock contents are selected. */
export async function auditDigiflazzDuplicates(db: Db) {
  const products = await db.$queryRaw<DuplicateAuditProduct[]>`
    SELECT p.id, p.name, p.slug, p.category_id AS "categoryId",
      p.digiflazz_brand AS source, p.game_region AS region, p.game_variant AS variant,
      p.is_active AS active, p.is_archived AS archived,
      COALESCE(p.web_image_url, p.image_file_id) AS image,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', d.id, 'sku', d.supplier_sku, 'provider', d.auto_delivery_source, 'active', d.is_active,
        'archived', COALESCE((to_jsonb(d)->>'is_archived')::boolean, false),
        'price', d.price::text, 'cost', d.cost_price::text, 'priceOverridden', d.price_overridden,
        'inventory', (SELECT count(*) FROM stock_items s WHERE s.product_id = d.id),
        'orders', (SELECT count(*) FROM order_items o WHERE o.product_id = d.id),
        'mappings', (SELECT jsonb_agg(jsonb_build_object('provider', m.provider, 'sku', m.provider_sku, 'enabled', m.enabled)) FROM product_provider_mappings m WHERE m.product_id = d.id),
        'metadata', jsonb_build_object('name', d.name, 'slug', d.slug, 'type', d.type, 'deliveryType', d.delivery_type,
          'resellerPrice', d.reseller_price::text, 'additionalFields', d.additional_fields, 'providerInputMapping', d.provider_input_mapping)
      ) ORDER BY d.id) FROM denominations d WHERE d.product_id = p.id), '[]'::jsonb) AS denominations
    FROM products p ORDER BY p.id`;
  return classifyDigiflazzDuplicates(products);
}
