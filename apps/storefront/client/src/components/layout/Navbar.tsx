/**
 * Desktop / top bar — sticky, 1px line bottom border, paper backdrop-blur.
 * Extracted from the old single-file Layout.tsx (Task 5 chrome split); markup
 * and classes are unchanged apart from the split.
 *
 * Structure/content authority: business-adaptation.md → Navigation → "Main
 * navigation". This shop's real controls only — logo · persistent search ·
 * language toggle · Track-order (icon) · Account / Sign in · Cart pill. No
 * "Semua Produk" mega-menu, no loyalty-coin chip (business-adaptation.md
 * overrides components.md there).
 */
import type { RefObject } from "react";
import { Link, useLocation } from "react-router-dom";
import { Globe, LogIn, Menu, PackageSearch, Search, ShoppingCart, Store, User } from "lucide-react";
import type { ShopContext } from "../../api/types";
import { currentLang, t } from "../../lib/i18n";
import { useSearchOverlay } from "../shop/SearchOverlay";
import { SearchForm } from "./SearchForm";
import CurrencyToggle from "./CurrencyToggle";

export default function Navbar({
  ctx,
  drawerOpen,
  onOpenDrawer,
  triggerRef,
}: {
  ctx: ShopContext | undefined;
  drawerOpen: boolean;
  onOpenDrawer: () => void;
  triggerRef: RefObject<HTMLButtonElement>;
}) {
  const location = useLocation();
  const lang = currentLang();
  const otherLang = lang === "id" ? "en" : "id";
  const backPath = location.pathname + location.search;
  const shopName = ctx?.shop_name ?? "";
  const cartCount = ctx?.cart_count ?? 0;
  const { open: openSearch } = useSearchOverlay();

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-card/90 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 lg:px-6">
        <button
          ref={triggerRef}
          type="button"
          onClick={onOpenDrawer}
          aria-label={t("web.nav_menu")}
          aria-expanded={drawerOpen}
          // T13: "mobile-nav-drawer" only exists in the DOM while the drawer is
          // rendered (AnimatePresence unmounts it on close) — a dangling
          // aria-controls reference when closed is worse than none.
          aria-controls={drawerOpen ? "mobile-nav-drawer" : undefined}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-sand hover:text-ink sm:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        <Link to="/" className="flex shrink-0 items-center gap-2 text-pine">
          {ctx?.logo_url ? (
            // object-contain, so the logo keeps its own ratio; the declared box
            // just stops the header reflowing while it loads.
            <img
              src={ctx.logo_url}
              alt={shopName}
              width={160}
              height={28}
              className="h-7 w-auto max-w-[10rem] object-contain"
            />
          ) : (
            <Store className="h-6 w-6" />
          )}
          <span className="text-lg font-display font-semibold text-ink">{shopName}</span>
        </Link>

        <div className="relative mx-4 hidden max-w-xl flex-1 sm:block">
          <SearchForm inputAriaLabel={t("web.search_placeholder")} />
        </div>

        <nav
          className="ml-auto flex items-center gap-1 text-sm text-ink-soft sm:ml-0"
          aria-label={t("web.nav_main")}
        >
          {/* Mobile-only: the desktop search pill is `hidden ... sm:block`, so
              mobile opens the same SearchOverlay from this icon (§10). The
              secondary header row that used to hold a full search field is
              gone — Task 12. */}
          <button
            type="button"
            onClick={() => openSearch()}
            aria-label={t("web.nav_search")}
            aria-haspopup="dialog"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-sand hover:text-ink sm:hidden"
          >
            <Search className="h-5 w-5" />
          </button>

          {/* T21: shows the language IN FORCE (not the target you'd switch to). */}
          <a
            href={`/lang?to=${otherLang}&back=${encodeURIComponent(backPath)}`}
            className="hidden items-center gap-1 rounded-lg px-2.5 py-2 uppercase hover:bg-sand sm:flex"
            aria-label={t("web.lang_label")}
          >
            <Globe className="h-4 w-4" /> {lang}
          </a>

          {/* Task 5: display-currency switcher — an XHR + re-render (never a
              full navigation like the language link above), so it lives
              beside it rather than folded into the same control. */}
          <div className="hidden sm:flex">
            <CurrencyToggle currency={ctx?.currency ?? null} fx={ctx?.fx} />
          </div>

          {/* Desktop-only by design: the mobile header row is already three
              items wide plus the hamburger, so mobile reaches /track via the
              drawer / the bottom tab bar's "Pesanan" instead. */}
          <Link
            to="/track"
            aria-label={t("web.nav_track")}
            title={t("web.nav_track")}
            className={`hidden items-center gap-1 rounded-lg px-2.5 py-2 hover:bg-sand sm:flex ${location.pathname === "/track" ? "text-pine" : ""}`}
          >
            <PackageSearch className="h-4 w-4" />
          </Link>

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
            className="relative flex items-center gap-1.5 rounded-full bg-pine-tint px-3 py-2 font-medium text-pine-dark hover:bg-pine-tint/80"
            aria-label={t("web.nav_cart")}
          >
            <ShoppingCart className="h-4 w-4" /> <span className="hidden sm:inline">{t("web.nav_cart")}</span>
            {cartCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-pine px-1 text-[0.65rem] font-bold text-white">
                {cartCount}
              </span>
            )}
          </Link>
        </nav>
      </div>
    </header>
  );
}
