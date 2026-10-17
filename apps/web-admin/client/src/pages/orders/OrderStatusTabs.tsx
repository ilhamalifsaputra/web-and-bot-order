import { cn } from "@/lib/utils";
import { useOrdersKpis } from "../../hooks/useOrdersKpis";
import { STATUS_TABS, StatusTabKey } from "./OrderStatusTabs.helpers";

interface OrderStatusTabsProps {
  active: StatusTabKey;
  onChange: (key: StatusTabKey) => void;
}

export function OrderStatusTabs({ active, onChange }: OrderStatusTabsProps): React.JSX.Element {
  const { data: kpis } = useOrdersKpis();

  // Only tabs whose status set maps 1:1 onto a single /api/orders/kpis field
  // get a count badge. "Awaiting" spans 5 payment statuses + PROCESSING (no
  // single KPI field covers that combination) and "Refunded" has no KPI
  // field at all — both render without a badge rather than a fabricated
  // number, per the plan's "don't invent a new endpoint field" call.
  const counts: Partial<Record<StatusTabKey, number>> = kpis
    ? { all: kpis.totalOrders, processing: kpis.processing, delivered: kpis.delivered, cancelled: kpis.cancelled }
    : {};

  return (
    <div className="mb-4 -mx-1 overflow-x-auto px-1">
      <div className="flex w-fit flex-nowrap items-center gap-1 rounded-lg bg-muted p-1">
        {STATUS_TABS.map((tab) => {
          const isActive = tab.key === active;
          const count = counts[tab.key];
          return (
            <button
              key={tab.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange(tab.key)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                isActive ? "bg-primary text-primary-foreground" : "text-ink-soft hover:text-ink",
              )}
            >
              {tab.label}
              {count != null && (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-xs",
                    isActive ? "bg-primary-foreground/20" : "bg-sand text-ink-soft",
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
