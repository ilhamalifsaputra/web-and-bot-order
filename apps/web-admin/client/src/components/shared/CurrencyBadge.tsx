/**
 * Read-only badge showing a user's chosen DISPLAY currency (Task 6 — admin
 * stays IDR-native everywhere else; this is the one place admin surfaces the
 * bot/storefront preference). Never editable from here — no admin write path
 * exists for `User.preferredCurrency`. Same small-badge visual family as
 * `StatusBadge`/`PaymentMethodBadge` (pill shape, tint background), not the
 * shadcn `ui/badge.tsx` primitive.
 */
type CurrencyState = "USD" | "IDR" | "UNSET";

const TONE_CLASS: Record<CurrencyState, string> = {
  // Pine tint mirrors PaymentMethodBadge's "crypto" family — USD reads as the
  // non-native, foreign-currency choice here.
  USD: "bg-pine-tint text-pine-dark",
  IDR: "bg-grass-tint text-grass-dark",
  // Muted/secondary — deliberately the least visually prominent of the three,
  // since "no preference set" isn't a state worth drawing the eye to.
  UNSET: "bg-sand text-ink-soft",
};

const LABEL: Record<CurrencyState, string> = {
  USD: "USD",
  IDR: "IDR",
  UNSET: "Not set",
};

export interface CurrencyBadgeProps {
  currency: "USD" | "IDR" | null;
}

export function CurrencyBadge({ currency }: CurrencyBadgeProps): JSX.Element {
  const state: CurrencyState = currency ?? "UNSET";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[state]}`}>
      {LABEL[state]}
    </span>
  );
}
