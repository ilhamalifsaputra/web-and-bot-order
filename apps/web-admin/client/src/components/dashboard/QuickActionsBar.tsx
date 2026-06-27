import { Boxes, Megaphone, Package, Receipt, UserPlus, LineChart } from "lucide-react";
import type { ComponentType } from "react";

const ACTIONS: Array<{ label: string; href: string; Icon: ComponentType<{ className?: string }> }> = [
  { label: "Add Product", href: "/catalog", Icon: Package },
  { label: "Add Stock", href: "/stock", Icon: Boxes },
  { label: "Broadcast", href: "/broadcast", Icon: Megaphone },
  { label: "Add Customer", href: "/users", Icon: UserPlus },
  { label: "Reports", href: "/reports", Icon: LineChart },
  { label: "Orders", href: "/orders", Icon: Receipt },
];

export function QuickActionsBar() {
  return (
    <div className="flex flex-wrap gap-2">
      {ACTIONS.map(({ label, href, Icon }) => (
        <a
          key={href}
          href={href}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-sm font-medium text-ink shadow-soft transition-colors hover:bg-sand"
        >
          <Icon className="h-4 w-4 text-pine" />
          {label}
        </a>
      ))}
    </div>
  );
}
