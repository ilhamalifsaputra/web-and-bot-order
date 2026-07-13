/**
 * TSX port of `denomination_card(d, fx, low, lang)` in
 * apps/storefront/views/_shop.njk (design.md §4.2) — a selectable plan/variant
 * card on the product detail page. The NJK version used a bare radio input
 * plus vanilla JS to read the `data-*` attributes on click; here the product
 * page's picker logic controls selection via the `checked`/`onChange` props,
 * so the `<input type="radio">` + `has-[:checked]:` styling contract is kept
 * so the same CSS drives the selected look either way.
 */
import StockBadge from "./StockBadge";
import Price from "./Price";

export interface DenominationCardData {
  id: number;
  name: string;
  duration_label: string | null;
  price: string;
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
}

export default function DenominationCard({ d, fx, lowThreshold, checked, onChange }: DenominationCardProps) {
  const buyable = purchasable(d);
  return (
    <label
      className={`denom-card card card-pad cursor-pointer flex items-center justify-between gap-3 transition-all duration-150 hover:shadow-lift has-[:checked]:ring-2 has-[:checked]:ring-pine has-[:checked]:bg-pine-tint/40 ${!buyable ? "opacity-60" : ""}`}
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
        <div className="min-w-0">
          <div className="font-display text-sm font-semibold text-ink leading-snug">
            {d.duration_label || d.name}
          </div>
          {/* Non-auto plans have no stock concept — showing a stock badge
              (even a false "in stock") would be misleading, so omit it. */}
          {d.delivery_type === "auto" && (
            <div className="mt-0.5">
              <StockBadge available={d.available} lowThreshold={lowThreshold} />
            </div>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <Price value={d.price} fx={fx} size="text-sm" />
      </div>
    </label>
  );
}
