/**
 * TSX port of `denomination_card(d, fx, low, lang)` in
 * apps/storefront/views/_shop.njk (design.md §4.2) — a selectable plan/variant
 * card on the product detail page. The NJK version used a bare radio input
 * plus vanilla JS to read the `data-*` attributes on click; here the product
 * page's picker logic controls selection via the `checked`/`onChange` props,
 * so the `<input type="radio">` + `has-[:checked]:` styling contract is kept
 * so the same CSS drives the selected look either way.
 *
 * Design-system migration (Task 11, `components.md` "Denomination / package
 * card"): the surface is composed from token utilities instead of the shared
 * `.card` class so it takes the spec's `radius 8px` (`rounded-lg`) rather than
 * `.card`'s 16px. Selected state is a `2px solid pine` border + a translucent
 * pine focus ring and NO fill (the old `bg-pine-tint/40` wash is dropped —
 * spec: "never a solid colour fill on the whole card"). The resting border is
 * 2px `line` (not the spec's literal 1px) so selection is a colour swap with
 * zero layout reflow when clicking through a grid of cards.
 *
 * `iconKind` (Fase 12) adds an optional small currency chip (diamond/coin/
 * key/card/voucher) to the leading content block — resolved once per PRODUCT
 * (apps/storefront/src/denomIcon.ts) and passed down identically to every
 * denomination of that product, since they all share one in-game currency.
 * It is a per-render prop, not part of `DenominationCardData` (the per-SKU
 * shape), and its rendering must never touch the `<input type="radio">`,
 * the `has-[:checked]:` classes, or any `data-*` attribute on the outer
 * `<label>` — those are read by the product page's picker logic.
 */
import { Gem, Coins, KeyRound, CreditCard, Ticket, type LucideIcon } from "lucide-react";
import StockBadge from "./StockBadge";
import Price from "./Price";
import FlashBadge, { FlashWasPrice, type FlashInfo } from "./FlashBadge";

/** Mirrors the server's DenomIconKind union (apps/storefront/src/denomIcon.ts)
 * and the client's own local alias (api/types.ts) verbatim. */
export type DenomIconKind = "diamond" | "coin" | "key" | "card" | "voucher";

const ICON_KIND_ICONS: Record<DenomIconKind, LucideIcon> = {
  diamond: Gem,
  coin: Coins,
  key: KeyRound,
  card: CreditCard,
  voucher: Ticket,
};

export interface DenominationCardData {
  id: number;
  name: string;
  duration_label: string | null;
  /** Already the flash price when `flash` is set (pageData.ts). */
  price: string;
  /** Live flash sale on this plan, or null when none is running. */
  flash?: FlashInfo | null;
  available: number;
  in_stock: boolean;
  /** "auto" | "manual" | "manual_with_info" (DeliveryType). */
  delivery_type: string;
}

/** Bug B fix (Task 6): the radio used to be disabled={!d.in_stock}, which
 * permanently disabled selecting ANY manual/manual_with_info plan (they
 * never have stock rows by design — Task 2 skips stock reservation for
 * them). Mirrors ProductPage.tsx's `purchasable`. */
function purchasable(d: DenominationCardData): boolean {
  return d.delivery_type !== "auto" || d.in_stock;
}

export interface DenominationCardProps {
  d: DenominationCardData;
  fx: string | null | undefined;
  lowThreshold: number;
  checked: boolean;
  onChange: () => void;
  /** Resolved once per product (apps/storefront/src/denomIcon.ts), shared by
   * every denomination of that product — null/undefined renders no chip. */
  iconKind?: DenomIconKind | null;
}

export default function DenominationCard({ d, fx, lowThreshold, checked, onChange, iconKind }: DenominationCardProps) {
  const buyable = purchasable(d);
  const Icon = iconKind ? ICON_KIND_ICONS[iconKind] : null;
  return (
    <label
      className={`denom-card cursor-pointer flex items-center justify-between gap-3 rounded-lg border-2 border-line bg-card p-4 shadow-soft transition-all duration-150 hover:shadow-lift has-[:checked]:border-pine has-[:checked]:ring-2 has-[:checked]:ring-pine/35 ${!buyable ? "opacity-60" : ""}`}
      data-denom-id={d.id}
      data-price={d.price}
      data-available={d.available}
      data-label={d.name}
    >
      <div className="flex items-center gap-3 min-w-0">
        <input
          type="radio"
          name="denomination_id"
          value={d.id}
          form="buy-form"
          className="denom-radio accent-pine shrink-0"
          disabled={!buyable}
          checked={checked}
          onChange={onChange}
        />
        {Icon && (
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-pine-tint"
            aria-hidden="true"
          >
            <Icon className="h-4 w-4 text-pine" />
          </span>
        )}
        <div className="min-w-0">
          <div className="font-display text-sm font-semibold text-ink leading-snug">
            {d.duration_label || d.name}
          </div>
          {/* Non-auto (provider-backed, e.g. Digiflazz) plans have no real
              stock count — a number would be misleading, but rendering
              nothing left the buyer with no "purchasable" cue at all. Show
              the plain "Available" pill (StockBadge's allNonAuto branch,
              identical markup to the catalog card's). */}
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {d.delivery_type === "auto" ? (
              <StockBadge available={d.available} lowThreshold={lowThreshold} />
            ) : (
              <StockBadge available={d.available} lowThreshold={lowThreshold} allNonAuto />
            )}
            {d.flash && <FlashBadge percent={d.flash.discount_percent} endsAt={d.flash.ends_at} />}
          </div>
        </div>
      </div>
      <div className="text-right shrink-0">
        <Price value={d.price} fx={fx} size="text-sm" />
        {/* `price` is already the sale price — this is the pre-sale figure. */}
        {d.flash && (
          <div>
            <FlashWasPrice value={d.flash.base_price} endsAt={d.flash.ends_at} />
          </div>
        )}
      </div>
    </label>
  );
}
