import { useId } from "react";
import type { ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { buttonNameBudget, visualWidth, type ButtonNameBudgetOptions, type ButtonNameKind } from "../../lib/buttonLimits";

/**
 * A text input whose value ends up on a Telegram inline-keyboard button. Under the field it shows where the text
 * appears, the character budget, and a live `used/budget` counter measured in cells (an emoji or a CJK character
 * counts 2, like Telegram's rendering). The limit is SOFT: it never blocks saving, truncates, or sets `maxLength`
 * (supplier names are legitimately long; the bot spells out full names in the message body). Over the budget the
 * counter turns amber (the warning tone), never red.
 *
 * Budgets come from `lib/buttonLimits.ts` (a copy of packages/core/src/buttonLimits.ts, the same module the bot
 * enforces). Use this component for every field whose text is shown on a button; do not copy the hint per page.
 */

const COPY: Record<ButtonNameKind, { where: string; over: string }> = {
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
    over: "the bot cuts the end of the label with “…” on the button",
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
}

export function ButtonLabelInput({ kind, currency, emoji, value, "aria-describedby": describedBy, ...inputProps }: ButtonLabelInputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const warningId = `${id}-warning`;
  const budget = buttonNameBudget(kind, { currency, emoji });
  const used = visualWidth(buttonText(value));
  const over = used - budget;
  const { where, over: overCopy } = COPY[kind];
  return (
    <div className="flex flex-col gap-1">
      <Input
        {...inputProps}
        value={value}
        aria-describedby={[describedBy, hintId, over > 0 ? warningId : null].filter(Boolean).join(" ")}
      />
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5 text-xs">
        <p id={hintId} className="min-w-0 flex-1 text-ink-soft">
          {where}. Aim for {budget} characters or fewer so it fits on a phone (an emoji counts as 2).
        </p>
        <span
          data-testid="button-label-counter"
          data-state={over > 0 ? "over" : "ok"}
          aria-live="polite"
          className={`shrink-0 tabular-nums ${over > 0 ? "font-medium text-amberx" : "text-ink-soft"}`}
        >
          {used}/{budget}
        </span>
      </div>
      {over > 0 && (
        <p id={warningId} data-testid="button-label-warning" className="text-xs text-amberx">
          {over} over: {overCopy}. You can still save it.
        </p>
      )}
    </div>
  );
}
