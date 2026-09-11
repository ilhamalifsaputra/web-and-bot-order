/**
 * Card — the white surface panel (components.md "Card / surface panel":
 * `card` fill, 16px radius, 1px `line` border, `shadow-soft`; padding
 * 20px→24px; interactive cards step up to `shadow-lift`).
 *
 * Composes `.card` (+ `.card-pad`) from app.css. `interactive` only adds the
 * hover elevation — making the card focusable/role'd is the caller's job,
 * since only the caller knows whether it wraps a link, a button, or nothing.
 */
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "./cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Hover elevation (`shadow-soft` → `shadow-lift`). */
  interactive?: boolean;
  /** `.card-pad` internal padding. Default true. */
  padded?: boolean;
}

const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { interactive = false, padded = true, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "card",
        padded && "card-pad",
        interactive && "transition-shadow hover:shadow-lift",
        className,
      )}
      {...rest}
    />
  );
});

export default Card;
