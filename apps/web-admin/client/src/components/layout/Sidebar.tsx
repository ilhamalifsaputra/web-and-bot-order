import type { ComponentType } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  ShoppingCart,
  CreditCard,
  Package,
  Boxes,
  Tag,
  Users,
  MessageCircle,
  Megaphone,
  Star,
  BarChart2,
  ClipboardList,
  Send,
  Shield,
  Settings,
  Palette,
  X,
} from "lucide-react";
import { useOperations } from "../../hooks/useOperations";
import { useInventory } from "../../hooks/useInventory";

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

interface NavItemConfig {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  badge?: "orders" | "stock";
}

interface NavGroup {
  header?: string;
  items: NavItemConfig[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
    ],
  },
  {
    header: "Sales",
    items: [
      { to: "/orders", label: "Orders", icon: ShoppingCart, badge: "orders" },
      { to: "/payments", label: "Payments", icon: CreditCard },
    ],
  },
  {
    header: "Products",
    items: [
      { to: "/catalog", label: "Catalog", icon: Package },
      { to: "/stock", label: "Stock", icon: Boxes, badge: "stock" },
      { to: "/vouchers", label: "Vouchers", icon: Tag },
    ],
  },
  {
    header: "Customers",
    items: [{ to: "/users", label: "Customers", icon: Users }],
  },
  {
    header: "Support",
    items: [
      { to: "/support", label: "Tickets", icon: MessageCircle },
      { to: "/broadcast", label: "Broadcast", icon: Megaphone },
      { to: "/reviews", label: "Reviews", icon: Star },
    ],
  },
  {
    header: "Reports",
    items: [
      { to: "/reports", label: "Reports", icon: BarChart2 },
      { to: "/audit", label: "Audit Log", icon: ClipboardList },
      { to: "/outbox", label: "Outbox", icon: Send },
    ],
  },
  {
    header: "Administration",
    items: [
      { to: "/admins", label: "Admins", icon: Shield },
      { to: "/settings", label: "Settings", icon: Settings },
      { to: "/branding", label: "Branding", icon: Palette },
    ],
  },
];

function SidebarContent({ onClose }: { onClose: () => void }) {
  const { data: operations } = useOperations();
  const { data: inventory } = useInventory();

  const ordersBadge = operations
    ? (operations.pendingPayments + operations.manualReviews) || 0
    : 0;

  const stockBadge = inventory
    ? inventory.filter((row) => row.available < row.threshold).length
    : 0;

  function getBadgeValue(badge?: "orders" | "stock"): number {
    if (badge === "orders") return ordersBadge;
    if (badge === "stock") return stockBadge;
    return 0;
  }

  return (
    <div className="flex h-full flex-col border-r border-line bg-card">
      {/* Logo row */}
      <div className="flex items-center justify-between px-4 py-5">
        <span className="font-display text-lg font-semibold text-ink">
          Shop Admin
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-ink-faint hover:text-ink lg:hidden"
          aria-label="Close navigation"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex flex-1 flex-col overflow-y-auto px-2 pb-4">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={gi > 0 ? "mt-4" : ""}>
            {group.header && (
              <div className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-ink-soft">
                {group.header}
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items.map(({ to, label, icon: Icon, end, badge }) => {
                const badgeValue = getBadgeValue(badge);
                return (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    onClick={() => {
                      if (window.innerWidth < 1024) onClose();
                    }}
                    className={({ isActive }) =>
                      `flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                        isActive
                          ? "bg-pine-tint text-pine"
                          : "text-ink-soft hover:bg-sand hover:text-ink"
                      }`
                    }
                  >
                    <Icon className="mr-2 h-4 w-4 flex-shrink-0" />
                    <span className="flex-1">{label}</span>
                    {badgeValue > 0 && (
                      <span
                        className={`ml-auto rounded-full px-1.5 py-0.5 text-xs font-semibold text-white ${
                          badge === "orders" ? "bg-rust" : "bg-amberx"
                        }`}
                      >
                        {badgeValue}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-line px-4 py-3">
        <a href="/logout" className="text-xs text-ink-soft hover:text-rust">
          Logout
        </a>
      </div>
    </div>
  );
}

export function Sidebar({ open, onClose }: SidebarProps): JSX.Element {
  return (
    <>
      {/* Desktop: always-visible fixed-width sidebar */}
      <aside className="hidden w-56 flex-shrink-0 lg:block">
        <SidebarContent onClose={onClose} />
      </aside>

      {/* Mobile: drawer + backdrop */}
      <div
        className={`fixed inset-0 z-30 bg-ink/40 lg:hidden transition-opacity duration-200 ${open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-56 lg:hidden transition-transform duration-200 ease-in-out ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <SidebarContent onClose={onClose} />
      </aside>
    </>
  );
}
