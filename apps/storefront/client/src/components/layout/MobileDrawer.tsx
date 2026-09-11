/**
 * Mobile nav drawer — slide-in left panel, retained as the SECONDARY "more"
 * navigation now that the bottom tab bar carries the five primary
 * destinations (business-adaptation.md → Navigation → "Mobile navigation
 * behavior"). It still holds the long tail: account/cart/orders/track,
 * Home/Products/Categories, Flash sale (when live), language, Help, trust
 * footer.
 *
 * Moved verbatim from the old single-file Layout.tsx (Task 5 chrome split).
 * The a11y contract is preserved exactly: role="dialog" + aria-modal, focus
 * trap (DRAWER_FOCUSABLE), Esc-to-close, scrim, body-scroll lock, and focus
 * restore to the hamburger trigger on close. prefers-reduced-motion is
 * honoured by the app-wide <MotionConfig reducedMotion="user"> in main.tsx.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Link, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CircleUser,
  Globe,
  House,
  LayoutGrid,
  LifeBuoy,
  LogIn,
  Package,
  PackageSearch,
  Shapes,
  ShieldCheck,
  ShoppingBag,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { ShopContext } from "../../api/types";
import { t } from "../../lib/i18n";
import { scrim, slideInLeft } from "../../lib/motion";

/** Row styling for the mobile nav drawer — hover/active both use the "pine"
 * token. Icons are `currentColor` (lucide-react), so tinting the row text also
 * tints its icon. 48px min height: the whole row is the tap target. */
function drawerRowClass(active: boolean) {
  return `flex min-h-12 w-full items-center gap-2 rounded-xl px-3 py-2.5 text-[15px] font-medium transition-colors duration-[180ms] ${
    active ? "bg-pine-tint text-pine" : "text-ink-soft hover:bg-pine-tint/60"
  }`;
}

const DRAWER_FOCUSABLE = "a[href], button:not(:disabled)";

/** Every drawer icon renders at one size and one stroke weight. */
const DRAWER_ICON = { className: "h-5 w-5 shrink-0", strokeWidth: 1.75 } as const;

/**
 * One drawer row. Pass `to` for an in-app destination (client-side Link) or
 * `href` for a real navigation — the language switch is a server round-trip.
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

/** Build-time version, injected by vite.config.ts. Absent under vitest, in
 * which case the footer simply omits the line. */
const APP_VERSION = import.meta.env.VITE_APP_VERSION as string | undefined;

export default function MobileDrawer({
  open,
  onClose,
  triggerRef,
  ctx,
  lang,
  otherLang,
  backPath,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement>;
  ctx: ShopContext | undefined;
  lang: string;
  otherLang: string;
  backPath: string;
}) {
  const location = useLocation();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const shopName = ctx?.shop_name ?? "";
  const cartCount = ctx?.cart_count ?? 0;

  // Lock body scroll while the drawer is open, compensating for the
  // scrollbar's width so the page doesn't reflow/shift under the fixed panel.
  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  // Esc closes; Tab/Shift+Tab trap focus inside the panel; focus moves to the
  // close button on open and back to the hamburger trigger on close.
  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
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
  }, [open, onClose, triggerRef]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            variants={scrim}
            initial="initial"
            animate="animate"
            exit="exit"
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-ink/35 sm:hidden"
            onClick={onClose}
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
            <div className="flex items-center justify-between border-b border-black/[0.06] px-6 pb-5 pt-7">
              <span className="font-display text-lg font-semibold text-ink">{shopName}</span>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={onClose}
                aria-label={t("web.nav_close_menu")}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-sand hover:text-ink"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {/* Three groups, most-personal first: what's mine → what's for sale
                → everything else. Dividers only, no section headings. */}
            <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2 text-sm">
              {ctx?.customer ? (
                <DrawerRow
                  icon={CircleUser}
                  label={t("web.nav_account")}
                  to="/account"
                  active={location.pathname === "/account"}
                  onNavigate={onClose}
                />
              ) : (
                <DrawerRow icon={LogIn} label={t("web.nav_login")} to="/login" onNavigate={onClose} />
              )}
              <DrawerRow
                icon={ShoppingBag}
                label={t("web.nav_cart")}
                to="/cart"
                active={location.pathname === "/cart"}
                onNavigate={onClose}
                trailing={
                  cartCount > 0 ? (
                    <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-pine px-1 text-xs font-bold text-white">
                      {cartCount}
                    </span>
                  ) : undefined
                }
              />
              {/* Anonymous visitors land on /login?next=… from OrdersPage
                  itself, so the row stays reachable — the subtitle just says so
                  up front instead of letting the redirect surprise them. */}
              <DrawerRow
                icon={Package}
                label={t("web.nav_orders")}
                sub={ctx?.customer ? undefined : t("web.nav_login_required")}
                to="/account/orders"
                active={location.pathname.startsWith("/account/orders")}
                onNavigate={onClose}
              />
              {/* No-account counterpart to My orders — order-code lookup needs
                  neither a session nor an email. */}
              <DrawerRow
                icon={PackageSearch}
                label={t("web.nav_track")}
                to="/track"
                active={location.pathname === "/track"}
                onNavigate={onClose}
              />

              <DrawerDivider />

              <DrawerRow
                icon={House}
                label={t("web.nav_home")}
                to="/"
                active={location.pathname === "/"}
                onNavigate={onClose}
              />
              <DrawerRow
                icon={LayoutGrid}
                label={t("web.nav_products")}
                to="/products"
                active={location.pathname === "/products"}
                onNavigate={onClose}
              />
              <DrawerRow
                icon={Shapes}
                label={t("web.nav_categories")}
                to="/categories"
                active={location.pathname === "/categories"}
                onNavigate={onClose}
              />
              {/* Hidden entirely when nothing is on sale — a "Flash sale" entry
                  that opens an empty shelf is worse than no entry. */}
              {ctx?.flash_active && (
                <DrawerRow
                  icon={Zap}
                  label={t("web.nav_flash")}
                  to="/flash"
                  active={location.pathname === "/flash"}
                  onNavigate={onClose}
                />
              )}

              <DrawerDivider />

              {/* Shows the language in force; one tap switches to the other. */}
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
                to="/help"
                active={location.pathname === "/help"}
                onNavigate={onClose}
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
  );
}
