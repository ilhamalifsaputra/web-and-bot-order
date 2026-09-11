/**
 * Tooltip — a lightweight hover/focus label. `components.md` has no tooltip
 * spec and §8.1 only lists it as a primitive, so this is the SIMPLER of the
 * two sanctioned options: a minimal JS popover (no positioning library, no
 * collision detection — CSS-anchored above the trigger). It shows on
 * `mouseenter` / `focus`, hides on `mouseleave` / `blur` / Esc, and the popup
 * is `role="tooltip"` wired to the trigger via `aria-describedby`.
 *
 * Keyboard-operable per §8.2: the trigger inside must be focusable (an
 * `<IconButton>`, `<button>`, `<a>`), and focusing it reveals the label.
 * Purely visual reinforcement — never put text here that is not available some
 * other accessible way.
 *
 * Business-agnostic: `label` + `children` are plain nodes.
 */
import { useId, useState, type ReactNode } from "react";
import { cn } from "./cn";

export interface TooltipProps {
  /** The tooltip text. */
  label: ReactNode;
  /** The trigger — a single focusable element. */
  children: ReactNode;
  className?: string;
}

export default function Tooltip({ label, children, className }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <span className="inline-flex" aria-describedby={open ? id : undefined}>
        {children}
      </span>
      {open && (
        <span
          role="tooltip"
          id={id}
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-xs font-medium text-card shadow-lift"
        >
          {label}
        </span>
      )}
    </span>
  );
}
