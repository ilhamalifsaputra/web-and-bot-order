import * as m from "motion/react-m";
/**
 * TSX port of `product_card(p, fx, low, lang)` in apps/storefront/views/_shop.njk
 * (design.md §4.2) — the grid card used by home/category/search. Links to the
 * product detail page.
 */
import { Tag, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import { t, tCount } from "../../lib/i18n";
import { pressable } from "../../lib/motion";
import DefaultThumb, { type ThumbnailKind } from "./DefaultThumb";
import FlashBadge, { FlashWasPrice } from "./FlashBadge";
import Price from "./Price";
import Stars from "./Stars";
import StockBadge from "./StockBadge";
;

const MotionLink = m.create(Link);

/** Client-side twin of the server's ProductCard shape (apps/storefront/src/cards.ts)
 * — the JSON a grid endpoint returns for one card. Decimals arrive as strings. */
export interface ProductCardData {
  slug: string;
  name: string;
  category_name: string;
  from_price: string;
  variant_count: number;
  /** The admin's real photo, or null (Fase 12: no more stock-photo
   * fallback) — a null renders DefaultThumb, keyed by `image_kind`. */
  image: string | null;
  /** WebP `srcset` for `image` (apps/storefront/src/images.ts webpSrcset).
   * Null/absent — an upload predating the derivatives, or no real photo at
   * all — means render the plain <img>, never a broken <source>. */
  image_srcset?: string | null;
  /** Which DefaultThumb icon to show when `image` is null — see
   *  defaultThumbKind() in apps/storefront/src/images.ts. Optional so an
   *  older/mocked payload still type-checks (falls back to "generic"). */
  image_kind?: ThumbnailKind | null;
  available: number;
  rating: number | null;
  rating_count: number;
  /** Best volume-tier saving across the product's plans, as a percent string. */
  bulk_discount: string | null;
  bulk_min_qty: number | null;
  /** True when that percent was derived from a fixed-amount/fixed-price tier
   * (server-rounded down) — the badge and hint then say "up to". Optional so
   * older payloads and fixtures still type-check. */
  bulk_up_to?: boolean;
  /** Live flash discount on the plan behind `from_price`, or null/absent.
   * `from_price` ALREADY reflects it — this only drives the ⚡ badge. Optional
   * so a payload predating flash sales still type-checks. */
  flash_discount?: string | null;
  /** That plan's exact pre-sale price, for the strike-through. Never derive
   * this from the percent: the discount and the headline price must describe
   * the same plan or the struck figure is one no plan ever had. */
  from_base_price?: string | null;
  /** ISO end of the sale behind `flash_discount` — the badge retires itself
   * when it passes. */
  flash_ends_at?: string | null;
  /** True when no active denomination draws from local inventory (provider
   * SKUs such as auto + Digiflazz, and manual ones) — these never carry a
   * real stock count and are always purchasable (STO-001). Server verdict. */
  all_non_auto: boolean;
  /** True when every active denomination draws from local inventory — only
   * then is `available` the product's stock. A mixed product must not show
   * its partial local count as the product's badge. Optional only so older
   * fixtures type-check; the server always sends it. */
  all_local_inventory?: boolean;
  /** Product created within the last 14 days — drives the "New" badge. */
  is_new?: boolean;
  /** Flash cards only: the promo denomination the card represents (its id
   * preselects it via `?d=`), its display name, and how many OTHER
   * denominations of the product are on sale too. Null/0 on a normal card. */
  promo_denomination_id?: number | null;
  promo_denomination_name?: string | null;
  other_promo_count?: number;
}

export interface ProductCardProps {
  p: ProductCardData;
  fx: string | null | undefined;
  lowThreshold: number;
}

export default function ProductCard({ p, fx, lowThreshold }: ProductCardProps) {
  // Rounded DOWN for display: a 12.5% tier is shown as 12%, never 13% — the
  // badge must not claim more than checkout takes off.
  const bulkPercent = p.bulk_discount ? Math.floor(Number(p.bulk_discount)) : null;
  const preSale = p.flash_discount ? (p.from_base_price ?? null) : null;
  return (
    <MotionLink
      to={p.promo_denomination_id ? `/p/${p.slug}?d=${p.promo_denomination_id}` : `/p/${p.slug}`}
      {...pressable}
      className="group h-full overflow-hidden rounded-2xl border border-line bg-card shadow-soft transition hover:shadow-lift hover:border-pine-tint flex flex-col"
    >
      <ProductCardImage p={p} bulkPercent={bulkPercent} />
      <ProductCardDetails p={p} fx={fx} preSale={preSale} lowThreshold={lowThreshold} bulkPercent={bulkPercent} />
    </MotionLink>
  );
}

function ProductCardImage({ p, bulkPercent }: {
  p: ProductCardData;
  bulkPercent: number | null;
}) {
  return (<div className="relative flex h-44 items-center justify-center bg-sand overflow-hidden shrink-0">
    {p.image ? (
      <picture className="block w-full h-full">
        {/* block + full size: <picture> is inline by default, which would
                drop the w-full/h-full the <img> relies on in this flex well. */}
        {p.image_srcset && (
          // Two cards per row on phones, a ~300px column on desktop.
          <source
            type="image/webp"
            srcSet={p.image_srcset}
            sizes="(max-width: 640px) 50vw, 300px"
          />
        )}
        <img
          src={p.image}
          alt={p.name}
          loading="lazy"
          decoding="async"
          // Intrinsic size for the card's 11rem-tall well. object-cover still
          // decides the crop, but without these the browser can't reserve
          // space before the image loads — the row jumps as each card fills
          // in (layout shift), and an auditor comparing natural to displayed
          // dimensions reports the image as distorted.
          width={400}
          height={176}
          className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
        />
      </picture>
    ) : (
      <DefaultThumb kind={p.image_kind ?? "generic"} name={p.name} />
    )}

    {/* Flash badge above the bulk badge in one stacked column — they can
            both be live on the same product, and two absolutely-positioned
            badges at top-3 left-3 would sit on top of each other. */}
    {(p.flash_discount || p.bulk_discount || p.is_new) && (
      <div className="absolute top-2 left-2 sm:top-3 sm:left-3 flex max-w-2/3 flex-col items-start gap-1.5">
        {p.is_new && (
          <span className="inline-flex items-center rounded-full bg-pine px-2.5 py-1 text-xs font-medium text-white shadow-xs">
            {t("web.badge_new")}
          </span>
        )}
        {p.flash_discount && (
          <FlashBadge percent={p.flash_discount} endsAt={p.flash_ends_at ?? null} tone="solid" showEnded />
        )}
        {p.bulk_discount && (
          <span className="inline-flex items-center rounded-full bg-grass-tint px-2.5 py-1 text-xs font-medium text-grass-dark shadow-xs">
            {p.bulk_up_to ? t("shop.bulk_badge_up_to", { percent: bulkPercent ?? 0 }) : `−${bulkPercent}%`}
          </span>
        )}
      </div>
    )}
    {/* "instant delivery" is a positive capability → an opaque grass chip:
            solid bg-grass-dark + white text stays legible over BOTH a real
            photo and the light DefaultThumb well Fase 12 introduced. The old
            bg-black/40 + text-grass computed to ~2.3:1 over that pale
            placeholder (fails WCAG AA); white on bg-grass-dark is ~5:1.
            Still the grass family (positive capability), never off-palette
            amber. Deliberately distinct from the sibling bulk-discount badge
            above (a savings pill: bg-grass-tint + text-grass-dark): this one
            is a solid bg-grass-dark + white capability pill.
            Gated on !all_non_auto AND available > 0: when no denomination draws
            from local stock nothing is delivered from inventory, and a local
            product with no stock has nothing to deliver — either way the pill
            would mislead the buyer. (`available` counts local-inventory
            denominations only, so `available > 0` also proves a local plan is
            in stock on a mixed product.) */}
    {!p.all_non_auto && p.available > 0 && (
      <span className="absolute right-2 bottom-2 sm:right-3 sm:bottom-3 inline-flex items-center gap-1 rounded-full bg-grass-dark px-2.5 py-1 text-xs font-medium text-white">
        <Zap className="w-3 h-3" /> {t("web.badge_instant")}
      </span>
    )}
  </div>);
}

/** Flash cards: the discounted plan's own display name (already a plan or
 * denomination label, so no family-specific vocabulary is added here) and how
 * many other plans of the product are on sale too. */
function PromoLine({ name, otherCount }: { name: string | null | undefined; otherCount: number }) {
  if (!name) return null;
  return (
    <p className="mt-1 text-sm font-medium text-ink line-clamp-1 break-words">
      {name}
      {otherCount > 0 && (
        <span className="ml-1.5 text-xs font-normal text-rust-dark">{tCount("web.flash_more_deals", otherCount)}</span>
      )}
    </p>
  );
}

function ProductCardDetails({ p, fx, preSale, lowThreshold, bulkPercent }: {
  p: ProductCardData;
  fx: string | null | undefined;
  preSale: string | null;
  lowThreshold: number;
  bulkPercent: number | null;
}) {
  return (<div className="p-3 sm:p-4 flex flex-col flex-1 min-w-0">
    <h3 className="font-semibold text-ink line-clamp-1 break-words">{p.name}</h3>
    <p className="text-sm text-ink-faint">
      {p.category_name}
      {p.variant_count > 1 && (
        <>
          {" "}
          <span className="text-ink-soft">·</span>{" "}
          <span className="text-pine">{t("web.group_options", { count: p.variant_count })}</span>
        </>
      )}
    </p>

    <PromoLine name={p.promo_denomination_name} otherCount={p.other_promo_count ?? 0} />

    {p.rating_count > 0 && (
      <div className="flex items-center gap-1.5 text-xs text-ink-soft mt-1">
        <Stars rating={p.rating ?? 0} /> <span>{String(Math.round((p.rating ?? 0) * 10) / 10)}</span>
        <span className="text-ink-faint">· {tCount("web.review_count", p.rating_count)}</span>
      </div>
    )}

    <div className="mt-auto pt-3 flex items-center justify-between gap-2 flex-wrap">
      <p className="min-w-0 text-sm text-ink-soft inline-flex items-baseline gap-1 flex-wrap">
        {t("web.from_price")}
        <Price value={p.from_price} fx={fx} size="text-base" />
        {/* The card payload carries no base price (cards.ts), so the
                pre-sale figure is reconstructed from the percent — display
                only, and it never feeds a total. */}
        {preSale !== null && <FlashWasPrice value={preSale} endsAt={p.flash_ends_at ?? null} />}
      </p>
      {/* A count badge only when every plan is local stock; a mixed
              product is purchasable through its provider/manual plans
              whatever its partial local count says. */}
      <StockBadge
        available={p.available}
        lowThreshold={lowThreshold}
        allNonAuto={p.all_non_auto || p.all_local_inventory === false}
      />
    </div>

    {p.bulk_discount && p.bulk_min_qty && (
      <div className="text-xs text-grass-dark font-medium flex items-center gap-1 mt-2">
        <Tag className="w-3 h-3" />
        {t(p.bulk_up_to ? "shop.bulk_hint_up_to" : "web.bulk_hint", { qty: p.bulk_min_qty, percent: bulkPercent ?? 0 })}
      </div>
    )}
  </div>);
}
