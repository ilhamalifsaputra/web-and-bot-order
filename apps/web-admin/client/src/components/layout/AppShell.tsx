import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { SearchModal } from "./SearchModal";
import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { PageTransition } from "../shared/PageTransition";

export function AppShell(): JSX.Element {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchSession, setSearchSession] = useState(0);
  const location = useLocation();
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const openSearch = useCallback(() => {
    setSearchSession((current) => current + 1);
    setSearchOpen(true);
  }, []);

  // Ctrl+K / Cmd+K shortcut to open search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        if (searchOpen) closeSearch();
        else openSearch();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [searchOpen, closeSearch, openSearch]);

  return (
    <>
      <div className="flex h-screen overflow-hidden bg-paper">
        <Sidebar
          open={sidebarOpen}
          onClose={closeSidebar}
          triggerRef={menuRef}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <TopBar
            onMenuClick={() => setSidebarOpen((o) => !o)}
            onSearchOpen={openSearch}
            menuRef={menuRef}
            sidebarOpen={sidebarOpen}
          />
          <main className="flex flex-1 flex-col overflow-y-auto bg-paper">
            <div className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-4 sm:px-5 sm:py-6 lg:px-6 xl:px-8">
              <PageTransition>
                <ErrorBoundary key={location.pathname}>
                  <Outlet />
                </ErrorBoundary>
              </PageTransition>
            </div>
          </main>
        </div>
      </div>
      <SearchModal open={searchOpen} onClose={closeSearch} session={searchSession} />
      <Toaster />
    </>
  );
}
