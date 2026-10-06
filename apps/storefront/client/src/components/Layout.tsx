/**
 * Shop chrome — composition root. Renders <Navbar/>, the mobile nav drawer,
 * <main><Outlet/></main>, <Footer/> and the mobile bottom <MobileTabBar/>, and
 * owns the drawer open/close state.
 *
 * The chrome was one 661-line file until Task 5 split it into
 * src/components/layout/{Navbar,Footer,MobileDrawer,MobileTabBar,SearchForm}.
 * `useShopContext` is implemented in lib/useShopContext.ts (Task 5) and only
 * re-exported here, so the 25+ files that import it from this path keep
 * working; Layout's own call is the one context query whose result is passed
 * down to each chrome piece as props.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useSearchParams } from "react-router-dom";
import { currentLang, t } from "../lib/i18n";
import { useShopContext } from "../lib/useShopContext";
import { PageTransition } from "./PageTransition";
import Toast from "./shop/Toast";
import Navbar from "./layout/Navbar";
import Footer from "./layout/Footer";
import MobileDrawer from "./layout/MobileDrawer";
import MobileTabBar, { isTabBarHidden } from "./layout/MobileTabBar";
import { SearchOverlayProvider } from "./shop/SearchOverlay";

/** Re-exported for callers that historically imported it from Layout (25+
 * existing sites) — the implementation itself lives in lib/useShopContext.ts
 * now (Task 5), so a lean consumer can use it without pulling in this whole
 * chrome subtree; see that file's doc comment for why. */
export { useShopContext };

/** Re-exported for callers that historically imported it from Layout. */
export { FOOTER_LINKS } from "./layout/Footer";

export default function Layout() {
  const { data: ctx } = useShopContext();
  const location = useLocation();
  const lang = currentLang();
  const otherLang = lang === "id" ? "en" : "id";
  const backPath = location.pathname + location.search;
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Stable identities: MobileDrawer's focus-trap effect lists onClose in its
  // deps, and its cleanup restores focus to the trigger — a new closure each
  // render would re-run that effect (and steal focus back) on every parent
  // re-render while the drawer is open.
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // T5: RegisterPage's success redirect is a full page load (fresh CSRF
  // token), so no in-memory Toast state on that page could survive to be seen
  // — it marks its landing URL with `?welcome=1` instead, and this shared
  // chrome is what turns that into the confirmation the visitor sees. Read
  // once on mount, then strip the param so a later refresh doesn't replay it.
  const [searchParams, setSearchParams] = useSearchParams();
  const [showWelcomeToast, setShowWelcomeToast] = useState(false);
  useEffect(() => {
    if (searchParams.get("welcome") !== "1") return;
    setShowWelcomeToast(true);
    const next = new URLSearchParams(searchParams);
    next.delete("welcome");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The bottom tab bar is hidden on the full-funnel screens; the footer then
  // needs no extra bottom runway either. One source of truth for both.
  const tabBarHidden = isTabBarHidden(location.pathname);

  return (
    <SearchOverlayProvider fx={ctx?.fx}>
      {/* T14: first focusable element in the document. Off-screen until it
          receives keyboard focus, at which point a keyboard user can jump
          straight past the header to the page content. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-pine focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lift"
      >
        {t("web.skip_to_content")}
      </a>

      <Toast
        text={showWelcomeToast ? t("web.register_welcome") : null}
        onDismiss={() => setShowWelcomeToast(false)}
        kind="success"
      />

      <Navbar ctx={ctx} drawerOpen={drawerOpen} onOpenDrawer={openDrawer} triggerRef={triggerRef} />

      <MobileDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        triggerRef={triggerRef}
        ctx={ctx}
        lang={lang}
        otherLang={otherLang}
        backPath={backPath}
      />

      {/* tabIndex=-1: RouteEffects.tsx moves focus here on every client-side
          navigation (T15); id is also the skip link's target (T14). */}
      <main id="main-content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 lg:px-6" tabIndex={-1}>
        <PageTransition>
          <Outlet />
        </PageTransition>
      </main>

      <Footer ctx={ctx} clearBottomNav={!tabBarHidden} />

      <MobileTabBar cartCount={ctx?.cart_count ?? 0} isSignedIn={Boolean(ctx?.customer)} />
    </SearchOverlayProvider>
  );
}
