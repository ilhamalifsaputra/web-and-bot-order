/**
 * Select — styled native `<select>`. Composes `.field`; `select.field` in
 * app.css keeps the platform caret (`appearance: auto`). `invalid` → `rust`
 * border + `aria-invalid`, matching <Input>. Callers pass `<option>` children.
 */
import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "./cn";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Error styling: `rust` border + `aria-invalid`. */
  invalid?: boolean;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid = false, className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn("field", invalid && "border-rust", className)}
      {...rest}
      aria-invalid={rest["aria-invalid"] ?? (invalid || undefined)}
    >
      {children}
    </select>
  );
});

export default Select;
