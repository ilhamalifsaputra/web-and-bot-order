import type { RefObject } from "react";
import { Menu, Search, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { logout } from "../../api/client";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";

interface TopBarProps {
  onMenuClick: () => void;
  onSearchOpen: () => void;
  menuRef?: RefObject<HTMLButtonElement | null>;
  sidebarOpen?: boolean;
}

const QUICK_ACTIONS = [
  { label: "Add Product", to: "/catalog", icon: true },
  { label: "Add Stock", to: "/stock", icon: true },
  { label: "Broadcast", to: "/broadcast", icon: true },
  { label: "Add Customer", to: "/users", icon: true },
  { label: "Reports", to: "/reports", icon: false },
] as const;

export function TopBar({ onMenuClick, onSearchOpen, menuRef, sidebarOpen = false }: TopBarProps): React.JSX.Element {
  const navigate = useNavigate();
  async function handleLogout() {
    try { await logout(); } finally { navigate("/login", { replace: true }); }
  }
  return (
    <header className="sticky top-0 z-40 flex h-14 flex-shrink-0 items-center gap-2 border-b border-line bg-card px-3 sm:px-4">
      <button ref={menuRef} type="button" onClick={onMenuClick}
        className="flex h-11 w-11 items-center justify-center rounded-md text-ink-soft transition-colors duration-150 hover:bg-sand hover:text-ink lg:hidden"
        aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={sidebarOpen}>
        <Menu aria-hidden="true" className="h-5 w-5" />
      </button>
      <button type="button" onClick={onSearchOpen} aria-label="Search" aria-haspopup="dialog"
        className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md border border-input bg-card px-3 py-1.5 text-sm text-ink-faint transition-colors duration-150 hover:bg-sand hover:text-ink-soft">
        <Search aria-hidden="true" className="h-4 w-4 flex-shrink-0" />
        <span className="hidden sm:inline">Search...</span>
        <kbd className="hidden rounded border border-line bg-sand px-1 py-0.5 text-xs sm:inline-block">Ctrl+K</kbd>
      </button>
      <div className="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Quick actions"
            className="flex h-11 w-11 items-center justify-center rounded-md border border-line text-ink-soft transition-colors duration-150 hover:bg-sand hover:text-ink">
            <Plus aria-hidden="true" className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44 bg-card">
          {QUICK_ACTIONS.map(({ label, to, icon }) => (
            <DropdownMenuItem key={to} className="min-h-11" onSelect={() => navigate(to)}>
              {icon && <Plus aria-hidden="true" className="h-4 w-4" />}
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Admin menu" className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md p-1 transition-colors duration-150 hover:bg-sand">
            <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-pine-tint text-xs font-semibold text-pine">AD</span>
            <span className="hidden text-sm font-medium text-ink md:inline">Admin</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36 bg-card">
          <DropdownMenuItem className="min-h-11" variant="destructive" onSelect={() => { void handleLogout(); }}>Logout</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
