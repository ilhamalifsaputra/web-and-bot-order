/**
 * Volume ("bulk") tier display: the ladder on a plan, the price at the chosen
 * quantity, and the per-line note in the cart and the checkout summary.
 *
 * Display only. Every figure arrives from the server's volume-tier engine
 * (pageData's `tier_ladder`, GET /api/v1/pricing/quote, a cart line's or a
 * summary item's `pricing`) and is formatted here; nothing in this file
 * multiplies, subtracts or applies a tier, so these rows cannot disagree with
 * what checkout charges. Wording is product-family neutral ("items"), so the
 * same rows serve Premium Apps and Game Top Up.
 */
import { Tag } from "lucide-react";
import type { LinePricing, TierLadderStep } from "../../api/types";
import { formatPriceFor } from "../../lib/format";
import { t } from "../../lib/i18n";
import type { LineQuoteState } from "../../lib/useLineQuote";
import { useShopContext } from "../../lib/useShopContext";
import { cn } from "../ui/cn";
import { tierApplies } from "./TierPricing.helpers";

function useMoney() {
  const { data: ctx } = useShopContext();
  return (value: string) => formatPriceFor(value, ctx?.currency ?? null, ctx?.fx);
}

/** A struck-through pre-tier price, read out to assistive tech as "Was …". */
function WasPrice({ value }: { value: string }) {
  return (
    <span className="text-xs text-ink-faint">
      <span className="sr-only">{t("web.flash_was", { price: value })}</span>
      <span aria-hidden="true" className="line-through">{value}</span>
    </span>
  );
}

/** The plan's tier ladder: "3+ items — Rp8,000 each", the rung in effect highlighted. */
export function TierLadder({ steps, activeMinQuantity }: { steps: readonly TierLadderStep[]; activeMinQuantity: number | null }) {
  const money = useMoney();
  if (steps.length === 0) return null;
  return (
    <div className="mt-3" data-testid="tier-ladder">
      <p className="flex items-center gap-1.5 text-xs font-medium text-grass-dark">
        <Tag className="h-3 w-3 shrink-0" aria-hidden="true" />
        {t("shop.tier_ladder_title")}
      </p>
      <ul className="mt-1.5 grid gap-1 text-sm">
        {steps.map((step) => {
          const active = step.min_quantity === activeMinQuantity;
          return (
            <li
              key={step.min_quantity}
              className={cn(
                "flex items-baseline justify-between gap-3 rounded-lg px-2 py-1",
                active ? "bg-grass-tint text-grass-dark font-medium" : "text-ink-soft",
              )}
              aria-current={active ? "true" : undefined}
            >
              <span>{t("shop.tier_ladder_row", { qty: step.min_quantity })}</span>
              <span className="whitespace-nowrap">{t("shop.tier_ladder_price", { price: money(step.unit_price) })}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The price at the typed quantity, from GET /api/v1/pricing/quote. While a
 * quote for THIS quantity is not in hand the block keeps its height and says
 * it is updating, so the previous quantity's figures are never shown under
 * the new one.
 */
export function QuantityQuote({ state, qty }: { state: LineQuoteState; qty: number }) {
  const money = useMoney();
  const { quote, failed } = state;
  return (
    <div className="mt-3 min-h-[3.25rem] text-sm" aria-live="polite" data-testid="quantity-quote">
      {quote ? (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-ink-soft">{t("shop.tier_qty_total", { qty: quote.quantity })}</span>
            <span className="font-display text-base font-semibold text-ink">{money(quote.final_subtotal)}</span>
          </div>
          <div className="flex flex-wrap items-baseline justify-end gap-2 text-xs text-ink-soft">
            {tierApplies(quote) && <WasPrice value={money(quote.base_unit_price)} />}
            <span>{t("shop.tier_unit_each", { price: money(quote.final_unit_price) })}</span>
          </div>
          {tierApplies(quote) && (
            <p className="mt-1 text-xs font-medium text-grass-dark">{t("shop.tier_savings", { amount: money(quote.savings) })}</p>
          )}
        </>
      ) : failed ? (
        <p className="text-xs text-rust-dark">{t("shop.tier_price_unavailable")}</p>
      ) : (
        <p className="text-xs text-ink-faint" data-qty={qty}>{t("shop.tier_price_updating")}</p>
      )}
    </div>
  );
}

/**
 * One line's tier note for the cart and the checkout summary:
 * "5 × Rp6,000  ~~Rp10,000~~ · Rp30,000" and "Quantity deal: you save Rp20,000".
 * Renders nothing when no tier took money off the line.
 */
export function TierLineNote({ pricing, className }: { pricing: LinePricing | null | undefined; className?: string }) {
  const money = useMoney();
  if (!tierApplies(pricing)) return null;
  return (
    <div className={cn("text-xs", className)} data-testid="tier-line-note">
      <div className="flex flex-wrap items-baseline gap-x-2 text-ink-soft">
        <span>{t("shop.tier_line_unit", { qty: pricing.quantity, price: money(pricing.final_unit_price) })}</span>
        <WasPrice value={money(pricing.base_unit_price)} />
        <span aria-hidden="true">·</span>
        <span className="font-semibold text-ink">{money(pricing.final_subtotal)}</span>
      </div>
      <p className="font-medium text-grass-dark">{t("shop.tier_savings", { amount: money(pricing.savings) })}</p>
    </div>
  );
}

/** "Rp6,000 × 5  ~~Rp10,000~~" — a tier-priced line's unit and quantity. */
export function TierQtyLine({ pricing }: { pricing: LinePricing }) {
  const money = useMoney();
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-pine">
      <span>{money(pricing.final_unit_price)} × {pricing.quantity}</span>
      <WasPrice value={money(pricing.base_unit_price)} />
    </p>
  );
}

/** A plan's discounted unit price with its pre-tier price struck through. */
export function TierUnitPrice({ pricing }: { pricing: LinePricing }) {
  const money = useMoney();
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span className="text-sm font-semibold text-pine">{t("shop.tier_unit_each", { price: money(pricing.final_unit_price) })}</span>
      <WasPrice value={money(pricing.base_unit_price)} />
    </span>
  );
}
