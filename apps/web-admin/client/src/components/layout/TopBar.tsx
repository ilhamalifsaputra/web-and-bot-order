import { useState } from "react";
import { Menu, Search, Plus, Sun, Moon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "./ThemeProvider";

interface TopBarProps {
  onMenuClick: () => void;
  onSearchOpen: () => void;
}

const QUICK_ACTIONS = [
  { label: "+ Add Product", to: "/catalog" },
  { label: "+ Add Stock", to: "/stock" },
  { label: "+ Broadcast", to: "/broadcast" },
  { label: "+ Add Customer", to: "/users" },
  { label: "Reports", to: "/reports" },
] as const;

export function TopBar({ onMenuClick, onSearchOpen }: TopBarProps): JSX.Element {
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);

  function closeAll() {
    setActionsOpen(false);
    setUserOpen(false);
  }

  return (
    <header className="sticky top-0 z-40 flex h-14 flex-shrink-0 items-center gap-2 border-b border-line bg-card px-3 sm:px-4">
      {/* Hamburger — mobile only */}
      <button
        type="button"
        onClick={onMenuClick}
        className="rounded-md p-2 text-ink-soft hover:bg-sand hover:text-ink lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Search button */}
      <button
        type="button"
        onClick={onSearchOpen}
        className="flex items-center gap-2 rounded-md border border-line bg-paper px-3 py-1.5 text-sm text-ink-faint hover:bg-sand hover:text-ink-soft"
      >
        <Search className="h-4 w-4 flex-shrink-0" />
        <span className="hidden sm:inline">Search...</span>
        <kbd className="hidden rounded border border-line bg-sand px-1 py-0.5 text-xs sm:inline-block">
          Ctrl+K
        </kbd>
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Quick Actions */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setActionsOpen((o) => !o);
            setUserOpen(false);
          }}
          className="flex items-center rounded-md border border-line p-2 text-ink-soft hover:bg-sand hover:text-ink"
          aria-label="Quick actions"
        >
          <Plus className="h-4 w-4" />
        </button>
        {actionsOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={closeAll} />
            <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-line bg-card shadow-lift">
              {QUICK_ACTIONS.map(({ label, to }) => (
                <button
                  key={to}
                  type="button"
                  className="block w-full px-4 py-2 text-left text-sm text-ink-soft hover:bg-sand hover:text-ink"
                  onClick={() => {
                    navigate(to);
                    setActionsOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Theme toggle */}
      <button
        type="button"
        onClick={toggleTheme}
        className="rounded-md p-2 text-ink-soft hover:bg-sand hover:text-ink"
        aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        {theme === "dark" ? (
          <Sun className="h-4 w-4" />
        ) : (
          <Moon className="h-4 w-4" />
        )}
      </button>

      {/* User avatar */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setUserOpen((o) => !o);
            setActionsOpen(false);
          }}
          className="flex items-center gap-2 rounded-md p-1 hover:bg-sand"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-pine-tint text-xs font-semibold text-pine">
            AD
          </div>
          <span className="hidden text-sm font-medium text-ink md:inline">
            Admin
          </span>
        </button>
        {userOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={closeAll} />
            <div className="absolute right-0 z-20 mt-1 w-36 rounded-md border border-line bg-card shadow-lift">
              <a
                href="/logout"
                className="block px-4 py-2 text-sm text-rust hover:bg-sand"
              >
                Logout
              </a>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
