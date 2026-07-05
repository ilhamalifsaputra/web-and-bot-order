/**
 * Shop chrome — 1:1 TSX port of apps/storefront/views/base.njk (header with
 * brand / search / language / account / cart, main column, footer). Markup and
 * classes are copied verbatim apart from the mechanical Tailwind v3→v4 renames
 * (backdrop-blur → backdrop-blur-sm) documented in
 * docs/REACT_STOREFRONT_MIGRATION.md.
 */
import type { FormEvent } from "react";
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Globe, LogIn, Search, ShoppingCart, Store, User } from "lucide-react";
import { apiGet } from "../api/client";
import type { ShopContext } from "../api/types";
import { currentLang, t } from "../lib/i18n";

/** Header context, shared by every page under the shop chrome. staleTime
 * doesn't poll — it just permits TanStack to refetch on refocus/remount once
 * 30s have passed, so the cart badge catches up across tabs without
 * hammering the API on every render. */
export function useShopContext() {
  return useQuery({
    queryKey: ["context"],
    queryFn: () => apiGet<ShopContext>("/api/v1/pages/context"),
    staleTime: 30_000,
  });
}

function SearchForm({ inputAriaLabel }: { inputAriaLabel: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("q");
    navigate(`/search?q=${encodeURIComponent(typeof value === "string" ? value : "")}`);
  }

  return (
    <form onSubmit={onSubmit} className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
      <input
        type="search"
        name="q"
        key={q}
        defaultValue={q}
        placeholder={t("web.search_placeholder")}
        className="h-10 w-full rounded-full border border-line bg-paper pl-9 pr-4 text-sm focus:border-pine focus:bg-card focus:outline-none focus:ring-2 focus:ring-pine-tint"
        aria-label={inputAriaLabel}
      />
    </form>
  );
}

export default function Layout() {
  const { data: ctx } = useShopContext();
  const location = useLocation();
  const lang = currentLang();
  const otherLang = lang === "id" ? "en" : "id";
  const shopName = ctx?.shop_name ?? "";
  const cartCount = ctx?.cart_count ?? 0;
  const backPath = location.pathname + location.search;

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-card/90 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 lg:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2 text-pine">
            {ctx?.logo_url ? (
              <img src={ctx.logo_url} alt={shopName} className="h-7 w-auto max-w-[10rem] object-contain" />
            ) : (
              <Store className="h-6 w-6" />
            )}
            <span className="text-lg font-display font-semibold text-ink">{shopName}</span>
          </Link>

          <div className="relative hidden flex-1 sm:block mx-4 max-w-xl">
            <SearchForm inputAriaLabel={t("web.search_placeholder")} />
          </div>

          <nav className="ml-auto flex items-center gap-1 text-sm text-ink-soft sm:ml-0">
            <a
              href={`/lang?to=${otherLang}&back=${encodeURIComponent(backPath)}`}
              className="hidden items-center gap-1 rounded-lg px-2.5 py-2 hover:bg-sand sm:flex uppercase"
              aria-label={t("web.lang_label")}
            >
              <Globe className="h-4 w-4" /> {otherLang}
            </a>

            {ctx?.customer ? (
              <Link
                to="/account"
                className={`flex items-center gap-1 rounded-lg px-2.5 py-2 hover:bg-sand ${location.pathname.startsWith("/account") ? "text-pine" : ""}`}
              >
                <User className="h-4 w-4" /> <span className="hidden sm:inline">{t("web.nav_account")}</span>
              </Link>
            ) : (
              <Link to="/login" className="flex items-center gap-1 rounded-lg px-2.5 py-2 hover:bg-sand">
                <LogIn className="h-4 w-4" /> <span className="hidden sm:inline">{t("web.nav_login")}</span>
              </Link>
            )}

            <Link
              to="/cart"
              className="flex items-center gap-1.5 rounded-full bg-pine-tint px-3 py-2 font-medium text-pine-dark hover:bg-pine-tint/80 relative"
              aria-label={t("web.nav_cart")}
            >
              <ShoppingCart className="h-4 w-4" /> <span className="hidden sm:inline">{t("web.nav_cart")}</span>
              {cartCount > 0 && (
                <span className="absolute -top-1 -right-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-pine px-1 text-[0.65rem] font-bold text-white">
                  {cartCount}
                </span>
              )}
            </Link>
          </nav>
        </div>

        {/* Mobile search — second row below the brand bar. */}
        <div className="sm:hidden border-t border-line px-4 py-2 bg-card">
          <SearchForm inputAriaLabel={t("web.search_placeholder")} />
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8 lg:px-6 flex-1">
        <Outlet />
      </main>

      <footer className="mt-16 border-t border-line bg-card">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-sm sm:flex-row lg:px-6">
          <span className="flex items-center gap-2 font-display font-semibold text-pine">
            <Store className="h-5 w-5" /> {shopName}
          </span>
          <span className="text-ink-faint text-xs sm:text-sm">{t("web.footer_note")}</span>
        </div>
      </footer>
    </>
  );
}
