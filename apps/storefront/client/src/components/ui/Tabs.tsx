/**
 * Tabs (Segmented control) — `components.md` "Segmented control / tabs":
 * a row of pill buttons, `radius-full`, `12–14px/600`, padding
 * `~0.375rem 0.75rem`. Active = `pine-tint` fill + `pine-dark` text (the
 * `.btn-soft` pattern); inactive = `ink-soft` text on `sand`.
 *
 * Full ARIA tabs pattern: `role="tablist"` / `role="tab"` / `aria-selected`,
 * roving `tabIndex`, Left/Right (and Up/Down) arrow navigation with wrap,
 * Home/End. Activation follows focus (automatic activation) — the right model
 * for a segmented control.
 *
 * Controlled (`value` + `onValueChange`) and uncontrolled (`defaultValue`).
 * Two modes:
 *   - pass `panels` → Tabs also renders the active `role="tabpanel"`, wired
 *     with `aria-labelledby` / `aria-controls`;
 *   - omit `panels` → pure segmented control ("controlled, no panel"); the
 *     caller filters its own sibling content off `onValueChange`.
 *
 * Business-agnostic: `items` carry plain `label` nodes and string values.
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "./cn";

export interface TabItem {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  /** Controlled selected value. */
  value?: string;
  /** Uncontrolled initial value (defaults to the first enabled item). */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** value → panel content. When set, Tabs renders the active panel itself. */
  panels?: Record<string, ReactNode>;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
}

export default function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  panels,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: TabsProps) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const isControlled = value !== undefined;
  const [internal, setInternal] = useState(
    () => defaultValue ?? items.find((i) => !i.disabled)?.value ?? items[0]?.value ?? "",
  );
  const active = isControlled ? value : internal;

  const tabId = (v: string) => `${baseId}-tab-${v}`;
  const panelId = (v: string) => `${baseId}-panel-${v}`;

  function select(next: string) {
    if (next === active) return;
    if (!isControlled) setInternal(next);
    onValueChange?.(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const enabled = items.filter((i) => !i.disabled);
    if (enabled.length === 0) return;
    const currentIdx = Math.max(
      0,
      enabled.findIndex((i) => i.value === active),
    );
    let nextIdx: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIdx = (currentIdx + 1) % enabled.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIdx = (currentIdx - 1 + enabled.length) % enabled.length;
        break;
      case "Home":
        nextIdx = 0;
        break;
      case "End":
        nextIdx = enabled.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextValue = enabled[nextIdx]!.value;
    select(nextValue);
    const nodes = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    nodes?.forEach((node) => {
      if (node.dataset.value === nextValue) node.focus();
    });
  }

  return (
    <>
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        onKeyDown={onKeyDown}
        className={cn("inline-flex flex-wrap gap-1", className)}
      >
        {items.map((item) => {
          const selected = item.value === active;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={tabId(item.value)}
              data-value={item.value}
              aria-selected={selected}
              aria-controls={panels ? panelId(item.value) : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => select(item.value)}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine/35",
                selected ? "bg-pine-tint text-pine-dark" : "bg-sand text-ink-soft hover:text-ink",
                item.disabled && "cursor-not-allowed opacity-50",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {panels && active !== undefined && (
        <div
          role="tabpanel"
          id={panelId(active)}
          aria-labelledby={tabId(active)}
          tabIndex={0}
          className="mt-3 focus-visible:outline-none"
        >
          {panels[active]}
        </div>
      )}
    </>
  );
}
