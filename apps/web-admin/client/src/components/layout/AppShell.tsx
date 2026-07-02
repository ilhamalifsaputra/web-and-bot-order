import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { ThemeProvider } from "./ThemeProvider";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { SearchModal } from "./SearchModal";
import { Toaster } from "@/components/ui/sonner";

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
          <main className="flex flex-1 flex-col overflow-y-auto bg-paper">
            <div className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-4 sm:px-5 sm:py-6 lg:px-6 xl:px-8">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      <Toaster />
    </ThemeProvider>
  );
}
