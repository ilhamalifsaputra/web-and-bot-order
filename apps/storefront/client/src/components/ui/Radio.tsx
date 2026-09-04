/**
 * Radio — styled native `<input type="radio">`. Same rationale as <Checkbox>:
 * global `accent-color` supplies the brand fill, this fixes a consistent 16px
 * control. Group behaviour comes from a shared `name`; the visible label is
 * the caller's / <FormField>'s job.
 */
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "./cn";

export type RadioProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio({ className, ...rest }, ref) {
  return <input ref={ref} type="radio" className={cn("h-4 w-4", className)} {...rest} />;
});

export default Radio;
