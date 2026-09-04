/**
 * Checkbox — styled native `<input type="checkbox">`. `accent-color` is set
 * globally in app.css (`input, select, textarea, button { accent-color }`),
 * so the brand tick colour comes for free; this just fixes a consistent
 * 16px box. The visible label is the caller's / <FormField>'s job.
 * Controlled + uncontrolled both work (native input).
 */
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "./cn";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} type="checkbox" className={cn("h-4 w-4", className)} {...rest} />;
});

export default Checkbox;
