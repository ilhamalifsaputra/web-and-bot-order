import { NavLink } from "react-router-dom";
import type { ReactNode } from "react";

interface NavItem { to: string; label: string; end?: boolean }

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/orders", label: "Orders" },
  { to: "/catalog", label: "Catalog" },
  { to: "/stock", label: "Stock" },
  { to: "/users", label: "Customers" },
  { to: "/vouchers", label: "Vouchers" },
  { to: "/admins", label: "Admins" },
  { to: "/payments", label: "Payments" },
  { to: "/outbox", label: "Outbox" },
  { to: "/reports", label: "Reports" },
  { to: "/reviews", label: "Reviews" },
  { to: "/audit", label: "Audit" },
  { to: "/broadcast", label: "Broadcast" },
  { to: "/support", label: "Support" },
  { to: "/settings", label: "Settings" },
  { to: "/branding", label: "Branding" },
  { to: "/search", label: "Search" },
];

export function PageLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-paper">
      <aside className="hidden w-56 flex-col border-r border-line bg-card lg:flex">
        <div className="px-4 py-5">
          <span className="font-display text-lg font-semibold text-ink">Shop Admin</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2 pb-4">
          {NAV_ITEMS.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-pine-tint text-pine"
                    : "text-ink-soft hover:bg-sand hover:text-ink"
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line px-4 py-3">
          <a href="/logout" className="text-xs text-ink-faint hover:text-rust">
            Logout
          </a>
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-line bg-card px-4 py-3 sm:px-6">
          <h1 className="font-display text-xl font-semibold text-ink">{title}</h1>
        </header>
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
