import "@testing-library/jest-dom";
import { lazy } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Layout from "./Layout";
import { apiGet } from "../api/client";
import type { ShopContext } from "../api/types";

/** Exposes the router's current search string so a test can confirm Layout's
 * `?welcome=1` marker (T5) actually gets stripped after being read, not just
 * that the toast rendered once. */
function LocationSearchProbe() {
  return <span data-testid="location-search">{useLocation().search}</span>;
}

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
}));

const context: ShopContext = {
  lang: "en",
  fx: "16000",
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 0,
  customer: null,
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  tzname: "Asia/Jakarta",
};

function renderLayout(overrides: Partial<ShopContext> = {}, path = "/") {
  const client = new QueryClient();
  (apiGet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ...context, ...overrides });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route
              index
              element={
                <>
                  <div>home content</div>
                  <LocationSearchProbe />
                </>
              }
            />
            <Route path="products" element={<div>products content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Open the mobile drawer and hand back its dialog element. */
async function openDrawer(overrides: Partial<ShopContext> = {}, path = "/") {
  const user = userEvent.setup();
  renderLayout(overrides, path);
  await waitFor(() => expect(apiGet).toHaveBeenCalled());
  await user.click(screen.getByRole("button", { name: "Menu" }));
  return { user, drawer: await screen.findByRole("dialog", { name: "Menu" }) };
}

describe("Layout", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("shows the post-registration welcome toast when the URL carries ?welcome=1, then strips the param (T5)", async () => {
    renderLayout({}, "/?welcome=1");
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(await screen.findByText("Account created — welcome aboard!")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent(""));
  });

  it("shows no welcome toast on an ordinary visit", async () => {
    renderLayout();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await screen.findByText("home content");
    expect(screen.queryByText("Account created — welcome aboard!")).not.toBeInTheDocument();
  });

  it("labels the header and footer nav landmarks distinctly (T12)", async () => {
    renderLayout();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await screen.findByText("home content");

    const header = screen.getByRole("navigation", { name: "Main navigation" });
    const footer = screen.getByRole("navigation", { name: "Footer navigation" });
    expect(header).toBeInTheDocument();
    expect(footer).toBeInTheDocument();
    // The footer nav holds the informational-page links; it must not carry
    // "About us" as its landmark name even though "About us" is one of the
    // seven links inside it.
    expect(within(footer).getByRole("link", { name: "About us" })).toBeInTheDocument();
  });

  it("only points aria-controls at the drawer while it exists in the DOM (T13)", async () => {
    renderLayout();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const trigger = screen.getByRole("button", { name: "Menu" });
    expect(trigger).not.toHaveAttribute("aria-controls");

    const user = userEvent.setup();
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Menu" });
    expect(trigger).toHaveAttribute("aria-controls", "mobile-nav-drawer");
    expect(document.getElementById("mobile-nav-drawer")).not.toBeNull();
  });

  it("renders a skip link targeting #main-content as the first focusable element (T14)", async () => {
    renderLayout();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await screen.findByText("home content");

    const skipLink = screen.getByRole("link", { name: "Skip to content" });
    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(document.getElementById("main-content")).not.toBeNull();

    // First Tab from the top of the document lands on the skip link, not
    // the hamburger button or anything else in the header.
    await userEvent.setup().tab();
    expect(skipLink).toHaveFocus();
  });

  it("exposes a language switcher reachable on mobile, not only the desktop nav (STO-004)", async () => {
    const { container } = renderLayout();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await screen.findByText("home content");

    // Two language links must exist: the desktop one (hidden ... sm:flex)
    // and a second one folded into the mobile secondary row (sm:hidden) —
    // otherwise mobile visitors can never reach the switcher (STO-004).
    const langLinks = container.querySelectorAll('a[href^="/lang?to=id"]');
    expect(langLinks.length).toBeGreaterThanOrEqual(2);
  });

  describe("mobile nav drawer", () => {
    it("groups account, catalog and support destinations into one panel", async () => {
      const { drawer } = await openDrawer();
      const nav = within(drawer);
      // Rows carrying a subtitle fold it into their accessible name, so those
      // two are matched on their leading label rather than the whole string.
      for (const name of ["Sign in", "Cart", /^My orders/, "Home", "Browse products", "Categories", /^Language/, "Help center"]) {
        expect(nav.getByRole("link", { name })).toBeInTheDocument();
      }
    });

    it("marks the page being viewed, and only that one", async () => {
      const { drawer } = await openDrawer({}, "/");
      const current = within(drawer)
        .getAllByRole("link")
        .filter((el) => el.getAttribute("aria-current") === "page");
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveAccessibleName(/home/i);
    });

    it("tells anonymous visitors that My orders needs an account", async () => {
      const { drawer } = await openDrawer({ customer: null });
      expect(within(drawer).getByText("Sign in required")).toBeInTheDocument();
    });

    it("drops that hint once the visitor is signed in, and offers Account instead of Sign in", async () => {
      const { drawer } = await openDrawer({
        customer: { username: "budi", email: null, telegram_linked: false },
      });
      expect(within(drawer).queryByText("Sign in required")).not.toBeInTheDocument();
      expect(within(drawer).getByRole("link", { name: /account/i })).toBeInTheDocument();
    });

    // A "Flash sale" entry that opens an empty shelf is worse than no entry,
    // so the row is driven by the context flag rather than always shown.
    it("shows Flash sale only while a sale is running", async () => {
      const { drawer } = await openDrawer({ flash_active: false });
      expect(within(drawer).queryByRole("link", { name: /flash sale/i })).not.toBeInTheDocument();
    });

    it("shows Flash sale when the context says one is live", async () => {
      const { drawer } = await openDrawer({ flash_active: true });
      expect(within(drawer).getByRole("link", { name: /flash sale/i })).toHaveAttribute("href", "/flash");
    });

    it("names the language in force and links to the other one", async () => {
      const { drawer } = await openDrawer();
      const link = within(drawer).getByRole("link", { name: /language/i });
      expect(link).toHaveTextContent("English");
      expect(link).toHaveAttribute("href", expect.stringContaining("/lang?to=id"));
    });

    it("carries the trust footer", async () => {
      const { drawer } = await openDrawer();
      expect(within(drawer).getByText("Trusted digital marketplace")).toBeInTheDocument();
      expect(within(drawer).getByText("Instant delivery")).toBeInTheDocument();
      expect(within(drawer).getByText("Warranty included")).toBeInTheDocument();
    });

    it("closes on Escape and returns focus to the hamburger button", async () => {
      const { user, drawer } = await openDrawer();
      expect(drawer).toBeInTheDocument();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Menu" })).toHaveFocus();
    });

    it("closes when a destination is chosen", async () => {
      const { user, drawer } = await openDrawer();
      await user.click(within(drawer).getByRole("link", { name: /browse products/i }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument());
      expect(await screen.findByText("products content")).toBeInTheDocument();
    });
  });

  // Task 12: App.tsx lazy-loads most routes rendered through Layout's
  // <Outlet/>. PageTransition.tsx now puts a <Suspense> *inside*
  // AnimatePresence's animated container specifically so a pending chunk
  // doesn't blank the header/footer chrome or skip the transition. These use
  // a `React.lazy` whose import we control by hand instead of a real dynamic
  // import, so the pending state can be asserted on before resolving it.
  describe("a lazily-loaded route (T-task-12)", () => {
    function renderWithLazyRoute(lazyElement: JSX.Element, initialEntries: string[]) {
      const client = new QueryClient();
      (apiGet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(context);
      return render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={initialEntries}>
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<Link to="/products">Go to products</Link>} />
                <Route path="products" element={lazyElement} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    }

    it("shows the route-loading fallback on a hard load of a lazy route (deep link/refresh) without losing the chrome, then swaps in the real page once the chunk resolves", async () => {
      // Mounting straight onto "/products" — not a client-side <Link> nav —
      // mirrors visiting the URL directly: the very first commit is not
      // wrapped in React Router's navigation `startTransition` (see the
      // other test below), so this is the one path where Suspense's fallback
      // is actually shown rather than deferred.
      let resolveImport!: (mod: { default: () => JSX.Element }) => void;
      const importPromise = new Promise<{ default: () => JSX.Element }>((resolve) => {
        resolveImport = resolve;
      });
      const LazyProducts = lazy(() => importPromise);

      renderWithLazyRoute(<LazyProducts />, ["/products"]);

      // Layout's own chrome — header/nav/skip-link — isn't part of the
      // suspended Outlet subtree, so it's already there on this very first
      // render, fallback or not.
      expect(screen.getByRole("link", { name: "Skip to content" })).toBeInTheDocument();
      expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();

      // The chunk hasn't resolved: the shared route-loading fallback shows,
      // matching the same aria-busy/aria-label vocabulary every data-loading
      // skeleton in this app uses (see RouteFallback.tsx).
      const fallback = await screen.findByLabelText("Loading…");
      expect(fallback).toHaveAttribute("aria-busy", "true");

      await act(async () => {
        resolveImport({ default: () => <div>products lazy content</div> });
        await importPromise;
      });

      expect(await screen.findByText("products lazy content")).toBeInTheDocument();
      expect(screen.queryByLabelText("Loading…")).not.toBeInTheDocument();
      // Still there — the fallback resolving didn't take the chrome with it.
      expect(screen.getByRole("link", { name: "Skip to content" })).toBeInTheDocument();
    });

    it("keeps the previous page fully visible — no blank frame, no fallback flash — while a client-side <Link> navigation's chunk is pending, then completes the transition once it resolves", async () => {
      // React Router v7 wraps every navigation's state update in
      // `React.startTransition` (confirmed in its own source: `chunk-*.js`
      // calls `React.startTransition(() => setStateImpl(newState))` for a
      // PUSH). Suspending inside a transition does NOT show the nearest
      // Suspense fallback — React keeps the current UI on screen until the
      // suspended work is ready, then commits directly to the resolved
      // result. So a real in-app click to a lazy route never shows
      // RouteFallback at all; it just looks like the click "took a moment."
      // This is the scenario the brief's worry about "a permanently blank
      // frame" or "double-fired transition" is really about, so it's worth
      // asserting explicitly rather than assuming it from the deep-link case
      // above.
      let resolveImport!: (mod: { default: () => JSX.Element }) => void;
      const importPromise = new Promise<{ default: () => JSX.Element }>((resolve) => {
        resolveImport = resolve;
      });
      const LazyProducts = lazy(() => importPromise);

      renderWithLazyRoute(<LazyProducts />, ["/"]);
      await waitFor(() => expect(apiGet).toHaveBeenCalled());
      await screen.findByRole("link", { name: "Go to products" });

      const user = userEvent.setup();
      await user.click(screen.getByRole("link", { name: "Go to products" }));

      // Give the transition's microtask queue a turn, then confirm: the old
      // page is still fully there (not blanked, not swapped for a
      // fallback), and the chrome never budged.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole("link", { name: "Go to products" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Loading…")).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Skip to content" })).toBeInTheDocument();

      await act(async () => {
        resolveImport({ default: () => <div>products lazy content</div> });
        await importPromise;
      });

      // One transition, straight through to the resolved page — not two.
      expect(await screen.findByText("products lazy content")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Go to products" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Loading…")).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Skip to content" })).toBeInTheDocument();
    });

    it("does not suspend past Layout: an eagerly-resolved route renders straight through with no fallback flash", async () => {
      renderWithLazyRoute(<div>eager products content</div>, ["/"]);
      await waitFor(() => expect(apiGet).toHaveBeenCalled());
      const user = userEvent.setup();
      await user.click(await screen.findByRole("link", { name: "Go to products" }));

      expect(await screen.findByText("eager products content")).toBeInTheDocument();
      expect(screen.queryByLabelText("Loading…")).not.toBeInTheDocument();
    });
  });
});
