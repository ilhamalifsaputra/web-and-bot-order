import { useId } from "react";
import type { ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { buttonNameBudget, nameAfterProductPrefix, PLAN_LABEL_MAX_CHARS, visualWidth, type ButtonNameBudgetOptions, type ButtonNameKind } from "../../lib/buttonLimits";

/**
 * A text input whose value ends up on a Telegram inline-keyboard button. Under the field it shows where the text
 * appears, the character budget, and a live `used/budget` counter measured in cells (an emoji or a CJK character
 * counts 2, like Telegram's rendering). The limit is SOFT: it never blocks saving, truncates, or sets `maxLength`
 * (supplier names are legitimately long; the bot spells out full names in the message body). Over the budget the
 * counter turns amber (the warning tone), never red. Only the warning is a live region, so a screen reader hears
 * it when the limit is crossed, not every keystroke.
 *
 * Budgets come from `lib/buttonLimits.ts` (a copy of packages/core/src/buttonLimits.ts, the same module the bot
 * enforces). Use this component for every field whose text is shown on a button; do not copy the hint per page.
 *
 * Game Top-Up denomination names (`kind="denominationGame"`): pass the product's name as `productName`, because the
 * bot drops it from the start of the name (the list header already names the product), and `builtFromQuantity` when
 * the quantity and the unit are both filled in, because then the button is built from them instead of the name.
 */

const COPY: Record<ButtonNameKind, { where: string; over: string; fit?: string }> = {
  productList: {
    where: "Shown on the Telegram search and popular-product buttons",
    over: "the bot cuts the end of the name with “…” on the button",
  },
  category: {
    where: "Shown on the Telegram category button, two per row",
    over: "the bot cuts the end of the name with “…” on the button",
  },
  gameVariant: {
    where: "Shown on the Telegram variant button, two per row",
    over: "Telegram clips the end of it on a phone",
  },
  gameRegion: {
    where: "Shown on the Telegram region button, two per row",
    over: "Telegram clips the end of it on a phone",
  },
  denominationPlan: {
    where: "Shown on the Telegram plan button, two per row",
    fit: "so two buttons fit side by side",
    over: `two buttons may no longer fit side by side, and the bot cuts the label with “…” beyond ${PLAN_LABEL_MAX_CHARS} characters`,
  },
  denominationGame: {
    where: "Shown on the Telegram Game Top Up button next to the price when no quantity and unit are set",
    over: "the bot shortens it or switches to a numbered button, and the full name is written in the message",
  },
  qtyUnit: {
    where: "Shown on the Telegram Game Top Up button between the quantity and the price",
    over: "the bot swaps it for its icon or abbreviation when it knows one, otherwise shortens it or switches to a numbered button",
  },
};

/** The bot collapses repeated whitespace and trims a name before it reaches a button. */
const buttonText = (value: string) => value.replace(/\s+/g, " ").trim();

export interface ButtonLabelInputProps extends Omit<ComponentProps<typeof Input>, "kind">, ButtonNameBudgetOptions {
  kind: ButtonNameKind;
  value: string;
  /** `denominationGame` only: the product's name. The bot drops it from the start of the name, so it is not counted. */
  productName?: string;
  /** `denominationGame` only: quantity and unit are both filled in, so the bot builds the button from them and the name is not measured. */
  builtFromQuantity?: boolean;
}

export function ButtonLabelInput({ kind, currency, emoji, value, productName, builtFromQuantity, "aria-describedby": describedBy, ...inputProps }: ButtonLabelInputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const warningId = `${id}-warning`;
  const noteId = `${id}-note`;
  const isGame = kind === "denominationGame";
  const dropsProductName = isGame && !!productName?.trim();
  const fromQuantity = isGame && !!builtFromQuantity;
  const budget = buttonNameBudget(kind, { currency, emoji });
  const used = visualWidth(dropsProductName ? nameAfterProductPrefix(value, productName!) : buttonText(value));
  const over = fromQuantity ? 0 : used - budget;
  const { where, over: overCopy, fit = "so it fits on a phone" } = COPY[kind];
  return (
    <div className="flex flex-col gap-1">
      <Input
        {...inputProps}
        value={value}
        aria-describedby={[describedBy, hintId, fromQuantity ? noteId : null, over > 0 ? warningId : null].filter(Boolean).join(" ")}
      />
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5 text-xs">
        <p id={hintId} className="min-w-0 flex-1 text-ink-soft">
          {where}. Aim for {budget} characters or fewer {fit} (an emoji counts as 2).
          {dropsProductName && " The game name at the start is not counted."}
        </p>
        {!fromQuantity && (
          <span
            data-testid="button-label-counter"
            data-state={over > 0 ? "over" : "ok"}
            className={`shrink-0 tabular-nums ${over > 0 ? "font-medium text-amberx" : "text-ink-soft"}`}
          >
            {used}/{budget}
          </span>
        )}
      </div>
      {fromQuantity && (
        <p id={noteId} data-testid="button-label-note" className="text-xs text-ink-soft">
          The button is built from the quantity and unit below, so this name is not measured. Words in it beyond those are added after them.
        </p>
      )}
      <div aria-live="polite" data-testid="button-label-announcer">
        {over > 0 && (
          <p id={warningId} data-testid="button-label-warning" className="text-xs text-amberx">
            {over} over: {overCopy}. You can still save it.
          </p>
        )}
      </div>
    </div>
  );
}
