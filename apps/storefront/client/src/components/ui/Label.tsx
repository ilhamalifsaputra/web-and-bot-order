/**
 * Label — `<label>` with `.field-label` styling (app.css: ~11px/600
 * uppercase, 0.05em tracking, `ink-soft` — components.md "Text field →
 * Label"). `required` appends a `rust` `*` that is `aria-hidden`, plus an
 * `sr-only` " (required)" so the requirement is announced but not read twice.
 */
import { forwardRef, type LabelHTMLAttributes } from "react";
import { cn } from "./cn";

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

const Label = forwardRef<HTMLLabelElement, LabelProps>(function Label(
  { required = false, className, children, ...rest },
  ref,
) {
  return (
    <label ref={ref} className={cn("field-label", className)} {...rest}>
      {children}
      {required && (
        <>
          <span aria-hidden="true" className="text-rust">
            {" *"}
          </span>
          <span className="sr-only"> (required)</span>
        </>
      )}
    </label>
  );
});

export default Label;
