/**
 * Switch — an accessible on/off toggle (no design-system "switch" row exists;
 * built from the token vocabulary: `pine` track when on, `sand` when off,
 * white knob with `shadow-soft`).
 *
 * It is a real `<button role="switch">`, so Space and Enter toggle it for
 * free and `aria-checked` reports state. Controlled only: the caller owns
 * `checked` and updates it from `onCheckedChange`. Pass an accessible name
 * via `aria-label` / `aria-labelledby`.
 */
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export interface SwitchProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "type" | "role" | "aria-checked" | "onChange" | "value"
  > {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, disabled = false, className, onClick, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!disabled) onCheckedChange(!checked);
      }}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-pine" : "bg-sand",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block h-5 w-5 rounded-full bg-card shadow-soft transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
});

export default Switch;
