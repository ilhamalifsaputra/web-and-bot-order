/**
 * Accordion (FAQ) — `components.md` "Accordion (FAQ)": full-width rows on a
 * white `.card` surface with a `1px line` divider between rows. Trigger is a
 * native `<button>` — question `14–15px/500` `ink` on the left, chevron
 * (`ink-soft`) on the right that rotates on open.
 *
 * ARIA: `<button>` with `aria-expanded` + `aria-controls`; the content region
 * is `role="region"` + `aria-labelledby`. Single-open (`type="single"`, with
 * `collapsible` to allow closing the open row) and multi-open
 * (`type="multiple"`). Controlled (`value` + `onValueChange`) and
 * uncontrolled (`defaultValue`).
 *
 * The expand is a CSS `grid-template-rows` 0fr→1fr transition guarded by
 * `motion-reduce:transition-none`; the collapsed panel goes `invisible`
 * (visibility:hidden) so its controls leave the tab order. No JS height
 * measurement, no animation library.
 *
 * A "show more" affordance is the caller's job (render fewer `items`).
 * Business-agnostic: `items` carry plain nodes.
 */
import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./cn";

export interface AccordionItem {
  value: string;
  trigger: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface AccordionProps {
  items: AccordionItem[];
  type?: "single" | "multiple";
  defaultValue?: string | string[];
  value?: string | string[];
  onValueChange?: (value: string | string[]) => void;
  /** `type="single"` only: allow closing the open row by clicking it again. Default true. */
  collapsible?: boolean;
  className?: string;
}

const toArray = (v: string | string[] | undefined): string[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

export default function Accordion({
  items,
  type = "single",
  defaultValue,
  value,
  onValueChange,
  collapsible = true,
  className,
}: AccordionProps) {
  const baseId = useId();
  const isControlled = value !== undefined;
  const [internal, setInternal] = useState<string[]>(() => toArray(defaultValue));
  const open = isControlled ? toArray(value) : internal;

  function emit(next: string[]) {
    if (!isControlled) setInternal(next);
    onValueChange?.(type === "multiple" ? next : (next[0] ?? ""));
  }

  function toggle(v: string) {
    const isOpen = open.includes(v);
    if (type === "multiple") {
      emit(isOpen ? open.filter((x) => x !== v) : [...open, v]);
    } else {
      emit(isOpen ? (collapsible ? [] : [v]) : [v]);
    }
  }

  return (
    <div className={cn("card divide-y divide-line overflow-hidden", className)}>
      {items.map((item) => {
        const isOpen = open.includes(item.value);
        const triggerId = `${baseId}-trigger-${item.value}`;
        const regionId = `${baseId}-region-${item.value}`;
        return (
          <div key={item.value}>
            <h3 className="m-0">
              <button
                type="button"
                id={triggerId}
                aria-expanded={isOpen}
                aria-controls={regionId}
                disabled={item.disabled}
                onClick={() => toggle(item.value)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-5 py-4 text-left text-sm font-medium text-ink",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-pine/35",
                  item.disabled ? "cursor-not-allowed opacity-50" : "hover:bg-sand/60",
                )}
              >
                <span className="min-w-0">{item.trigger}</span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "h-4 w-4 shrink-0 text-ink-soft transition-transform duration-200 motion-reduce:transition-none",
                    isOpen && "rotate-180",
                  )}
                />
              </button>
            </h3>
            <div
              id={regionId}
              role="region"
              aria-labelledby={triggerId}
              className={cn(
                "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
                isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
              )}
            >
              <div className={cn("overflow-hidden", !isOpen && "invisible")}>
                <div className="px-5 pb-4 text-sm leading-relaxed text-ink-soft">{item.content}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
