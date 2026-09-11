/**
 * Input — styled native `<input>`. Composes `.field` (app.css: white card
 * fill, 1px `line` border, 12px radius, 44px min-height, 16px→14px text —
 * components.md "Text field"). The `invalid` prop swaps the border to `rust`
 * and sets `aria-invalid`, per "Text field → Error state".
 *
 * Dumb on purpose: no label, no hint, no error copy — that composition lives
 * in <FormField>. Controlled and uncontrolled both work (native input).
 */
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "./cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Error styling: `rust` border + `aria-invalid`. */
  invalid?: boolean;
}

const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      // `!border-rust`, not `border-rust`: `.field` (app.css) sets the `border`
      // SHORTHAND, and app.css is imported after `tailwindcss` in index.css, so
      // at equal specificity (0,1,0) the shorthand wins on source order and a
      // plain `border-rust` never rendered — verified in the built bundle,
      // where `.border-rust` sits ~40KB ahead of `.field`. Same root cause as
      // MyTicketsCard's `!pl-8`. The unit tests below assert the class is
      // present, which it was; only a computed-style check catches this.
      className={cn("field", invalid && "!border-rust", className)}
      {...rest}
      // After the spread so an explicit caller value still wins; falls back to
      // the `invalid` prop otherwise.
      aria-invalid={rest["aria-invalid"] ?? (invalid || undefined)}
    />
  );
});

export default Input;
