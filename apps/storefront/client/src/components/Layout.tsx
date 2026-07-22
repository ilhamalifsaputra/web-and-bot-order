/**
 * Shop chrome — 1:1 TSX port of apps/storefront/views/base.njk (header with
 * brand / search / language / account / cart, main column, footer). Markup and
 * classes are copied verbatim apart from the mechanical Tailwind v3→v4 renames
 * (backdrop-blur → backdrop-blur-sm) documented in
 * docs/REACT_STOREFRONT_MIGRATION.md.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CircleUser,
  Globe,
  House,
  LayoutGrid,
  LifeBuoy,
  LogIn,
  Menu,
  Package,
  Shapes,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Search,
  Store,
  User,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { apiGet } from "../api/client";
import type { ShopContext } from "../api/types";
import { currentLang, t } from "../lib/i18n";
import { PageTransition } from "./PageTransition";
import { scrim, slideInLeft } from "../lib/motion";

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

/** Footer link row — keep in step with App.tsx's routes and with
 * STATIC_PAGES in apps/storefront/src/routes/spaShell.ts. */
const FOOTER_LINKS = [
  // The browse-all shelves are otherwise only linked from the mobile nav
  // drawer — this row is how a desktop visitor (and a crawler) reaches them.
  { to: "/products", key: "web.products_title" },
  { to: "/categories", key: "web.categories_page_title" },
  { to: "/about", key: "web.about_title" },
  { to: "/how-to-order", key: "web.hto_title" },
  { to: "/terms", key: "web.terms_title" },
  { to: "/privacy", key: "web.privacy_title" },
  { to: "/refund", key: "web.refund_title" },
];

/** Row styling for the mobile nav drawer — hover/active both use the "pine"
 * token, which is already blue (#2563eb / #e6effe tint), so this reads as
 * the requested primary-blue state without touching brand colors. Icons are
 * `currentColor` by default (lucide-react), so tinting the row text also
 * tints its icon. 48px min height: the whole row is the tap target, not just
 * its label. */
function drawerRowClass(active: boolean) {
  return `flex min-h-12 w-full items-center gap-2 rounded-xl px-3 py-2.5 text-[15px] font-medium transition-colors duration-[180ms] ${
    active ? "bg-pine-tint text-pine" : "text-ink-soft hover:bg-pine-tint/60"
  }`;
}

const DRAWER_FOCUSABLE = 'a[href], button:not(:disabled)';

/** Every drawer icon renders at one size and one stroke weight — mixing them
 * is what makes an icon column look assembled rather than designed. */
const DRAWER_ICON = { className: "h-5 w-5 shrink-0", strokeWidth: 1.75 } as const;

/**
 * One drawer row. Pass `to` for an in-app destination (client-side Link) or
 * `href` for a real navigation — the language switch is a server round-trip,
 * not a route.
 */
function DrawerRow({
  icon: Icon,
  label,
  sub,
  to,
  href,
  active = false,
  trailing,
  onNavigate,
}: {
  icon: LucideIcon;
  label: string;
  sub?: string;
  to?: string;
  href?: string;
  active?: boolean;
  trailing?: ReactNode;
  onNavigate?: () => void;
}) {
  const body = (
    <>
      <Icon {...DRAWER_ICON} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate">{label}</span>
        {sub && <span className="block text-xs font-normal text-ink-faint">{sub}</span>}
      </span>
      {trailing}
    </>
  );
  const className = drawerRowClass(active);
  // aria-current tells a screen reader which row is the page being viewed —
  // the blue tint alone only says it to people who can see it.
  if (href) {
    return (
      <a href={href} className={className}>
        {body}
      </a>
    );
  }
  return (
    <Link to={to!} onClick={onNavigate} className={className} aria-current={active ? "page" : undefined}>
      {body}
    </Link>
  );
}

/** Subtle in-panel section rule. */
function DrawerDivider() {
  return <div className="my-2 border-t border-black/[0.06]" />;
}

/** Build-time version, injected by vite.config.ts from the repo's package.json.
 * Absent under vitest (no Vite define), in which case the footer simply omits
 * the line rather than inventing a number. */
const APP_VERSION = import.meta.env.VITE_APP_VERSION as string | undefined;

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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = () => setDrawerOpen(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Lock body scroll while the drawer is open, compensating for the
  // scrollbar's width so the page doesn't reflow/shift under the fixed
  // panel. `overflow: hidden` (vs. `position: fixed`) means the page's
  // scroll position is preserved automatically once it's lifted.
  useEffect(() => {
    if (!drawerOpen) return;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const { overflow, paddingRight } = document.body.style;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
    return () => {
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
    };
  }, [drawerOpen]);

  // Esc closes; Tab/Shift+Tab trap focus inside the panel; focus moves to
  // the close button on open and back to the hamburger trigger on close.
  useEffect(() => {
    if (!drawerOpen) return;
    closeButtonRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      triggerRef.current?.focus();
    };
  }, [drawerOpen]);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-card/90 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 lg:px-6">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={t("web.nav_menu")}
            aria-expanded={drawerOpen}
            aria-controls="mobile-nav-drawer"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-sand hover:text-ink sm:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>

          <Link to="/" className="flex shrink-0 items-center gap-2 text-pine">
            {ctx?.logo_url ? (
              // object-contain, so the logo keeps its own ratio; the declared
              // box just stops the header reflowing while it loads.
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

        {/* Mobile secondary row — search plus the language switcher (STO-004:
            the switcher itself is `hidden sm:flex` above, so mobile visitors
            need it here or they can never reach it). */}
        <div className="sm:hidden border-t border-line px-4 py-2 bg-card flex items-center gap-2">
          <div className="flex-1">
            <SearchForm inputAriaLabel={t("web.search_placeholder")} />
          </div>
          <a
            href={`/lang?to=${otherLang}&back=${encodeURIComponent(backPath)}`}
            className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-2 text-sm text-ink-soft hover:bg-sand uppercase"
            aria-label={t("web.lang_label")}
          >
            <Globe className="h-4 w-4" /> {otherLang}
          </a>
        </div>
      </header>

      {/* Mobile nav drawer — labeled duplicates of the icon-only header links,
          reachable via the hamburger button above (sm:hidden). */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              variants={scrim}
              initial="initial"
              animate="animate"
              exit="exit"
              aria-hidden="true"
              className="fixed inset-0 z-40 bg-[rgba(15,23,42,0.35)] sm:hidden"
              onClick={() => setDrawerOpen(false)}
            />
            <motion.div
              ref={panelRef}
              variants={slideInLeft}
              initial="initial"
              animate="animate"
              exit="exit"
              id="mobile-nav-drawer"
              role="dialog"
              aria-modal="true"
              aria-label={t("web.nav_menu")}
              style={{
                paddingTop: "env(safe-area-inset-top)",
                paddingBottom: "env(safe-area-inset-bottom)",
              }}
              className="fixed inset-y-0 left-0 z-50 flex w-80 max-w-[85vw] flex-col bg-card sm:hidden"
            >
              <div className="flex items-center justify-between border-b border-black/[0.06] px-6 pt-7 pb-5">
                <span className="font-display text-lg font-semibold text-ink">{shopName}</span>
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label={t("web.nav_close_menu")}
                  className="flex h-10 w-10 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-sand hover:text-ink"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              {/* Three groups, most-personal first: what's mine → what's for
                  sale → everything else. Dividers only, no section headings:
                  the grouping is legible without adding a second type scale. */}
              <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2 text-sm">
                {ctx?.customer ? (
                  <DrawerRow
                    icon={CircleUser}
                    label={t("web.nav_account")}
                    to="/account"
                    active={location.pathname === "/account"}
                    onNavigate={closeDrawer}
                  />
                ) : (
                  <DrawerRow icon={LogIn} label={t("web.nav_login")} to="/login" onNavigate={closeDrawer} />
                )}
                <DrawerRow
                  icon={ShoppingBag}
                  label={t("web.nav_cart")}
                  to="/cart"
                  active={location.pathname === "/cart"}
                  onNavigate={closeDrawer}
                  trailing={
                    cartCount > 0 ? (
                      <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-pine px-1 text-xs font-bold text-white">
                        {cartCount}
                      </span>
                    ) : undefined
                  }
                />
                {/* Anonymous visitors land on /login?next=… from OrdersPage
                    itself, so the row stays reachable — the subtitle just says
                    so up front instead of letting the redirect surprise them. */}
                <DrawerRow
                  icon={Package}
                  label={t("web.nav_orders")}
                  sub={ctx?.customer ? undefined : t("web.nav_login_required")}
                  to="/account/orders"
                  active={location.pathname.startsWith("/account/orders")}
                  onNavigate={closeDrawer}
                />

                <DrawerDivider />

                <DrawerRow
                  icon={House}
                  label={t("web.nav_home")}
                  to="/"
                  active={location.pathname === "/"}
                  onNavigate={closeDrawer}
                />
                <DrawerRow
                  icon={LayoutGrid}
                  label={t("web.nav_products")}
                  to="/products"
                  active={location.pathname === "/products"}
                  onNavigate={closeDrawer}
                />
                <DrawerRow
                  icon={Shapes}
                  label={t("web.nav_categories")}
                  to="/categories"
                  active={location.pathname === "/categories"}
                  onNavigate={closeDrawer}
                />
                {/* Hidden entirely when nothing is on sale — a "Flash sale"
                    entry that opens an empty shelf is worse than no entry. */}
                {ctx?.flash_active && (
                  <DrawerRow
                    icon={Zap}
                    label={t("web.nav_flash")}
                    to="/flash"
                    active={location.pathname === "/flash"}
                    onNavigate={closeDrawer}
                  />
                )}

                <DrawerDivider />

                {/* Shows the language in force; one tap switches to the other.
                    With exactly two languages a disclosure chevron would
                    promise a menu that doesn't exist, so the target language
                    is named on the right instead. */}
                <DrawerRow
                  icon={Globe}
                  label={t("web.lang_label")}
                  sub={t(`web.lang_name_${lang}`)}
                  href={`/lang?to=${otherLang}&back=${encodeURIComponent(backPath)}`}
                  trailing={
                    <span className="text-xs font-semibold uppercase text-ink-faint">{otherLang}</span>
                  }
                />
                <DrawerRow
                  icon={LifeBuoy}
                  label={t("web.nav_help")}
                  to="/account/support"
                  active={location.pathname.startsWith("/account/support")}
                  onNavigate={closeDrawer}
                />
              </nav>

              {/* Trust footer — muted on purpose: reassurance at the bottom of
                  the panel, not a third thing competing for the tap. */}
              <div className="mt-auto border-t border-black/[0.06] px-6 py-5 text-xs text-ink-faint">
                <p className="flex items-center gap-2 font-medium text-ink-soft">
                  <ShieldCheck className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                  {t("web.trust_badge")}
                </p>
                <ul className="mt-2 space-y-1">
                  <li className="flex items-center gap-2">
                    <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                    {t("web.trust_instant")}
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                    {t("web.trust_warranty")}
                  </li>
                </ul>
                {APP_VERSION && (
                  <p className="mt-3">{t("web.trust_version", { version: APP_VERSION })}</p>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <main className="max-w-6xl mx-auto px-4 py-8 lg:px-6 flex-1">
        <PageTransition>
          <Outlet />
        </PageTransition>
      </main>

      <footer className="mt-16 border-t border-line bg-card">
        {/* The informational pages live here and nowhere else — this row is
            both how a visitor finds the policies and the only internal link
            that lets a crawler reach them at all. */}
        <nav
          className="mx-auto max-w-6xl px-4 pt-6 lg:px-6"
          aria-label={t("web.about_title")}
        >
          <ul className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm sm:justify-start">
            {FOOTER_LINKS.map(({ to, key }) => (
              <li key={to}>
                <Link to={to} className="text-ink-soft transition-colors hover:text-pine">
                  {t(key)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="mx-auto mt-4 flex max-w-6xl flex-col items-center justify-between gap-3 border-t border-line px-4 py-6 text-sm sm:flex-row lg:px-6">
          <span className="flex items-center gap-2 font-display font-semibold text-pine">
            <Store className="h-5 w-5" /> {shopName}
          </span>
          <span className="text-ink-faint text-xs sm:text-sm">{t("web.footer_note")}</span>
        </div>
      </footer>
    </>
  );
}
