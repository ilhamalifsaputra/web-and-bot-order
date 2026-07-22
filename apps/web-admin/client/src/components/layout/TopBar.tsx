import { useState } from "react";
import { Menu, Search, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { logout } from "../../api/client";
import { fadeIn } from "@/lib/motion";

interface TopBarProps {
  onMenuClick: () => void;
  onSearchOpen: () => void;
}

const QUICK_ACTIONS = [
  { label: "Add Product", to: "/catalog", icon: true },
  { label: "Add Stock", to: "/stock", icon: true },
  { label: "Broadcast", to: "/broadcast", icon: true },
  { label: "Add Customer", to: "/users", icon: true },
  { label: "Reports", to: "/reports", icon: false },
] as const;

export function TopBar({ onMenuClick, onSearchOpen }: TopBarProps): JSX.Element {
  const navigate = useNavigate();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);

  function closeAll() {
    setActionsOpen(false);
    setUserOpen(false);
  }

  async function handleLogout() {
    try {
      await logout();
    } finally {
      navigate("/login", { replace: true });
    }
  }

  return (
    <header className="sticky top-0 z-40 flex h-14 flex-shrink-0 items-center gap-2 border-b border-line bg-card px-3 sm:px-4">
      {/* Hamburger — mobile only */}
      <button
        type="button"
        onClick={onMenuClick}
        className="flex h-10 w-10 items-center justify-center rounded-md text-ink-soft transition-colors duration-150 hover:bg-sand hover:text-ink lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Search button */}
      <button
        type="button"
        onClick={onSearchOpen}
        aria-label="Search"
        className="flex items-center gap-2 rounded-md border border-line bg-paper px-3 py-1.5 text-sm text-ink-faint transition-colors duration-150 hover:bg-sand hover:text-ink-soft"
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
          className="flex h-10 w-10 items-center justify-center rounded-md border border-line text-ink-soft transition-colors duration-150 hover:bg-sand hover:text-ink"
          aria-label="Quick actions"
        >
          <Plus className="h-4 w-4" />
        </button>
        <AnimatePresence>
          {actionsOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={closeAll} />
              <motion.div
                variants={fadeIn}
                initial="initial"
                animate="animate"
                exit="exit"
                className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-line bg-card shadow-lift"
              >
                {QUICK_ACTIONS.map(({ label, to, icon }) => (
                  <button
                    key={to}
                    type="button"
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-ink-soft transition-colors duration-150 hover:bg-sand hover:text-ink"
                    onClick={() => {
                      navigate(to);
                      setActionsOpen(false);
                    }}
                  >
                    {icon && <Plus className="h-4 w-4" />}
                    {label}
                  </button>
                ))}
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      {/* User avatar */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setUserOpen((o) => !o);
            setActionsOpen(false);
          }}
          className="flex items-center gap-2 rounded-md p-1 transition-colors duration-150 hover:bg-sand"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-pine-tint text-xs font-semibold text-pine">
            AD
          </div>
          <span className="hidden text-sm font-medium text-ink md:inline">
            Admin
          </span>
        </button>
        <AnimatePresence>
          {userOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={closeAll} />
              <motion.div
                variants={fadeIn}
                initial="initial"
                animate="animate"
                exit="exit"
                className="absolute right-0 z-20 mt-1 w-36 rounded-md border border-line bg-card shadow-lift"
              >
                <button
                  type="button"
                  onClick={handleLogout}
                  className="block w-full px-4 py-2 text-left text-sm text-rust transition-colors duration-150 hover:bg-sand"
                >
                  Logout
                </button>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    </header>
  );
}
