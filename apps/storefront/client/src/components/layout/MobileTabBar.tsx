/**
 * Fixed mobile bottom tab bar — the PRIMARY mobile navigation (the left drawer
 * is now secondary "more" nav). Five destinations mapped to this shop's real
 * IA, per docs/archive/implementation/assumptions.md ASSUMPTION 1 and
 * gogogo-frontend/design-system/business-adaptation.md → Navigation → "Mobile
 * navigation behavior":
 *
 *   Beranda (/) · Cari (/search) · Keranjang (/cart) ·
 *   Pesanan (/account/orders when signed in, else /track) ·
 *   Akun (/account when signed in, else /login)
 *
 * NOT the reference's Home/Transaksi/Promo/Bantuan/Akun — flash sale is
 * conditional here and Support is auth-gated, so both stay in the drawer.
 *
 * Visible only < sm (matches the hamburger's `sm:hidden`). Height comes from
 * the --spacing-bottom-nav theme token (mirrors --gg-bottom-nav-height, 56px).
 */
import type { LucideIcon } from "lucide-react";
import { CircleUser, House, Package, Search, ShoppingBag } from "lucide-react";
import { Link, matchPath, useLocation } from "react-router-dom";
import { t } from "../../lib/i18n";

/**
 * Routes where the bar is HIDDEN: the six full-funnel screens that already
 * dock a sticky action bar at the bottom edge. Two fixed bottom elements must
 * never coexist on one screen (docs/archive/FRONTEND_IMPLEMENTATION_PROMPT_v3.md §15).
 * Keep this list in step with business-adaptation.md → Navigation (a).
 */
export const TAB_BAR_HIDDEN_ROUTES = [
  "/p/:slug",
  "/cart",
  "/checkout",
  "/checkout/:code/pay",
  "/wallet/topup",
  "/wallet/topup/:code/pay",
] as const;

/** True when `pathname` is one of the sticky-action-bar funnel screens. */
export function isTabBarHidden(pathname: string): boolean {
  return TAB_BAR_HIDDEN_ROUTES.some((pattern) => matchPath(pattern, pathname) !== null);
}

interface Tab {
  key: string;
  label: string;
  icon: LucideIcon;
  to: string;
  isActive: (pathname: string) => boolean;
  badge?: number;
}

export default function MobileTabBar({
  cartCount,
  isSignedIn,
}: {
  cartCount: number;
  isSignedIn: boolean;
}) {
  const { pathname } = useLocation();
  if (isTabBarHidden(pathname)) return null;

  const tabs: Tab[] = [
    { key: "home", label: t("web.nav_home"), icon: House, to: "/", isActive: (p) => p === "/" },
    {
      key: "search",
      label: t("web.nav_search"),
      icon: Search,
      to: "/search",
      isActive: (p) => p === "/search" || p.startsWith("/search?"),
    },
    {
      key: "cart",
      label: t("web.nav_cart"),
      icon: ShoppingBag,
      to: "/cart",
      isActive: (p) => p === "/cart",
      badge: cartCount,
    },
    {
      key: "orders",
      label: t("web.nav_orders_tab"),
      icon: Package,
      to: isSignedIn ? "/account/orders" : "/track",
      isActive: (p) => p.startsWith("/account/orders") || p === "/track",
    },
    {
      key: "account",
      label: t("web.nav_account"),
      icon: CircleUser,
      to: isSignedIn ? "/account" : "/login",
      isActive: (p) =>
        p === "/account" ||
        p === "/login" ||
        (p.startsWith("/account/") && !p.startsWith("/account/orders")),
    },
  ];

  return (
    <nav
      aria-label={t("web.nav_primary")}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card sm:hidden"
      // Device geometry (iOS home indicator) — no token expresses it. No px/rem
      // literal, so the token-only ESLint gate does not flag it.
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex h-bottom-nav max-w-6xl">
        {tabs.map((tab) => {
          const active = tab.isActive(pathname);
          const Icon = tab.icon;
          return (
            <li key={tab.key} className="flex-1">
              <Link
                to={tab.to}
                aria-current={active ? "page" : undefined}
                className={`relative flex h-full min-h-11 flex-col items-center justify-center gap-0.5 px-1 text-xs transition-colors ${
                  active ? "font-semibold text-pine" : "font-medium text-ink-soft"
                }`}
              >
                {/* Active state is signalled three ways, not by colour alone:
                    aria-current, the bolder label weight, and this top bar. */}
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-pine"
                  />
                )}
                <span className="relative">
                  <Icon className="h-5 w-5" strokeWidth={active ? 2 : 1.75} aria-hidden="true" />
                  {tab.badge && tab.badge > 0 ? (
                    <span className="absolute -right-2 -top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-pine px-1 text-[0.65rem] font-bold text-white">
                      {tab.badge > 99 ? "99+" : tab.badge}
                    </span>
                  ) : null}
                </span>
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
