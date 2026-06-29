import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { ThemeProvider } from "./ThemeProvider";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { SearchModal } from "./SearchModal";

export function AppShell(): JSX.Element {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Ctrl+K / Cmd+K shortcut to open search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ThemeProvider>
      <div className="flex h-screen overflow-hidden bg-paper">
        <Sidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <TopBar
            onMenuClick={() => setSidebarOpen((o) => !o)}
            onSearchOpen={() => setSearchOpen(true)}
          />
          <main className="flex flex-col flex-1 overflow-y-auto bg-paper p-4 sm:p-6">
            <Outlet />
          </main>
        </div>
      </div>
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </ThemeProvider>
  );
}
