/**
 * Two-option ($/Rp) display-currency switcher (Task 5) — shared by Navbar.tsx
 * (desktop, beside the language link), MobileDrawer.tsx (a drawer row) and
 * SettingsPage.tsx's new "Preferences" card. `currency`/`fx` are read by the
 * caller off the same `["context"]` query every chrome piece already
 * consumes (Layout.tsx's `ctx`, prop-drilled exactly like `lang`/`otherLang`
 * — see Navbar/MobileDrawer's existing convention); only the switching
 * mutation lives in this component, via `useCurrencySwitch`.
 *
 * The USD option is disabled (never hidden — a visible, explained "why not"
 * beats a control that silently isn't there) whenever `fx` is null: picking
 * USD without a usable rate would leave `<Price/>` falling back to Rp anyway
 * (formatPriceFor's own rule), so the switch never lets a visitor choose a
 * currency they can't actually be priced in.
 */
import { useCurrencySwitch } from "../../lib/currency";
import { t } from "../../lib/i18n";

export default function CurrencyToggle({
  currency,
  fx,
  /** "desktop": compact pill, no inline note (Navbar has no room for one —
   * `title` on the disabled button still carries it for a pointer user).
   * "stacked": same pill plus a visible note beneath when USD is disabled —
   * MobileDrawer and SettingsPage, which both have room for it. */
  variant = "desktop",
}: {
  currency: "USD" | "IDR" | null;
  fx: string | null | undefined;
  variant?: "desktop" | "stacked";
}) {
  const { setCurrency, isPending } = useCurrencySwitch();
  const usdUnavailable = !fx;
  const idrActive = currency !== "USD";
  const usdActive = currency === "USD";
  const optionClass = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs font-semibold uppercase transition-colors ${
      active ? "bg-pine text-white" : "text-ink-soft hover:bg-sand"
    }`;

  return (
    <div className={variant === "stacked" ? "flex flex-col gap-1.5" : "flex flex-col gap-1"}>
      <div
        role="group"
        aria-label={t("web.currency_label")}
        className="flex items-center gap-1 rounded-lg border border-line p-0.5"
      >
        <button
          type="button"
          onClick={() => setCurrency("IDR")}
          disabled={isPending}
          aria-pressed={idrActive}
          className={optionClass(idrActive)}
        >
          {t("currency.idr")}
        </button>
        <button
          type="button"
          onClick={() => setCurrency("USD")}
          disabled={isPending || usdUnavailable}
          aria-pressed={usdActive}
          title={usdUnavailable ? t("web.currency_unavailable_hint") : undefined}
          className={`${optionClass(usdActive)} disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {t("currency.usd")}
        </button>
      </div>
      {variant === "stacked" && usdUnavailable && (
        <p className="text-xs text-ink-faint">{t("web.currency_unavailable_hint")}</p>
      )}
    </div>
  );
}
