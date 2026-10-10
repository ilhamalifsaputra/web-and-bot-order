import "@testing-library/jest-dom";
import { lazy } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Layout from "./Layout";
import { apiGet, apiPost } from "../api/client";
import type { ShopContext } from "../api/types";

/** Exposes the router's current search string so a test can confirm Layout's
 * `?welcome=1` marker (T5) actually gets stripped after being read, not just
 * that the toast rendered once. */
function LocationSearchProbe() {
  return <span data-testid="location-search">{useLocation().search}</span>;
}

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
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
  support_telegram_url: "https://t.me/shopsupport",
  wa_number: null,
  tzname: "Asia/Jakarta",
  currency: null,
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
            <Route path="cart" element={<div>cart content</div>} />
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

  it("lets the constrained desktop container use the available width", async () => {
    renderLayout();
    await screen.findByText("home content");
    expect(screen.getByRole("main")).toHaveClass("w-full", "max-w-6xl");
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

  // Task 12 removed the mobile secondary header row (it held a full search
  // field + a language link). The language switcher's mobile home is now the
  // drawer (covered by the drawer tests below); the search affordance is an
  // icon button in the top bar that opens the SearchOverlay.
  it("replaces the mobile header search row with an icon button opening the search overlay (Task 12)", async () => {
    const user = userEvent.setup();
    renderLayout();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await screen.findByText("home content");

    const banner = screen.getByRole("banner");
    // The old secondary row rendered an <input type="search"> in the header.
    expect(within(banner).queryByRole("searchbox")).not.toBeInTheDocument();

    const searchIcon = within(banner).getByRole("button", { name: "Search" });
    await user.click(searchIcon);
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeInTheDocument();
  });

  describe("mobile nav drawer", () => {
    it("groups account, catalog and support destinations into one panel", async () => {
      const { drawer } = await openDrawer();
      const nav = within(drawer);
      // Rows carrying a subtitle fold it into their accessible name, so those
      // two are matched on their leading label rather than the whole string.
      for (const name of ["Sign in", "Cart", /^My orders/, "Track order", "Home", "Browse products", "Categories", /^Language/, "Help center"]) {
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
      expect(within(drawer).getByText("Automatic delivery where available")).toBeInTheDocument();
      expect(within(drawer).getByText("Warranty per plan")).toBeInTheDocument();
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

  describe("mobile bottom tab bar", () => {
    it("mounts on a standard route, as a distinct nav landmark from the header", async () => {
      renderLayout();
      await waitFor(() => expect(apiGet).toHaveBeenCalled());
      await screen.findByText("home content");
      const tabBar = screen.getByRole("navigation", { name: "Quick navigation" });
      expect(within(tabBar).getAllByRole("link")).toHaveLength(5);
      // Header and footer landmarks are untouched by its arrival.
      expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
      expect(screen.getByRole("navigation", { name: "Footer navigation" })).toBeInTheDocument();
    });

    it("is absent on the full-funnel /cart route (it owns the bottom edge with a sticky bar)", async () => {
      renderLayout({}, "/cart");
      await waitFor(() => expect(apiGet).toHaveBeenCalled());
      await screen.findByText("cart content");
      expect(screen.queryByRole("navigation", { name: "Quick navigation" })).not.toBeInTheDocument();
    });
  });

  it("lists the footer nav links in order, including Track order", async () => {
    renderLayout();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const footerNav = screen.getByRole("navigation", { name: "Footer navigation" });
    const hrefs = within(footerNav)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/products",
      "/categories",
      "/track",
      "/help",
      "/about",
      "/contact",
      "/how-to-order",
      "/terms",
      "/privacy",
      "/refund",
    ]);
  });

  it("shows the shop name, tagline and Quick Links/Contact headings in the 4-column footer", async () => {
    renderLayout({ shop_tagline: "Serba ada, serba cepat" });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await screen.findByText("home content");

    expect(screen.getByText("Serba ada, serba cepat")).toBeInTheDocument();
    expect(screen.getByText("Quick Links")).toBeInTheDocument();
    expect(screen.getByText("Contact")).toBeInTheDocument();
    // Copyright/trust bar still renders beneath the columns.
    expect(screen.getByText("Automatic delivery where available · QRIS & USDT payments")).toBeInTheDocument();
  });

  it("hides the whole contact column when neither WhatsApp nor Telegram is configured", async () => {
    renderLayout({ wa_number: null, support_telegram_url: null });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await screen.findByText("home content");

    expect(screen.queryByRole("link", { name: /whatsapp/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /telegram/i })).not.toBeInTheDocument();
  });

  it("links the footer's WhatsApp entry to wa.me/<wa_number> only when it's set", async () => {
    renderLayout({ wa_number: "6281234567890" });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await screen.findByText("home content");

    expect(screen.getByRole("link", { name: /whatsapp/i })).toHaveAttribute(
      "href",
      "https://wa.me/6281234567890",
    );
  });

  it("links the footer's Telegram entry to the support_contact link, never the bot username", async () => {
    renderLayout({ support_telegram_url: "https://t.me/shopsupport" });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await screen.findByText("home content");

    expect(screen.getByRole("link", { name: /telegram/i })).toHaveAttribute(
      "href",
      "https://t.me/shopsupport",
    );
  });

  it("offers Track order in the desktop header, separate from the drawer's copy", async () => {
    renderLayout();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("link", { name: "Track order" })).toHaveAttribute("href", "/track");
  });

  // Task 5: display-currency switcher. An XHR + re-render (never a full
  // navigation like the language link) — POSTs the Task-4 endpoint, then
  // invalidates the shared ["context"] query so <Price/> et al. re-render
  // from the fresh value on their very next paint.
  describe("currency switcher", () => {
    it("desktop Navbar: clicking USD posts the preference and refetches the context query", async () => {
      const user = userEvent.setup();
      (apiPost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ currency: "USD" });
      renderLayout({ currency: null, fx: "16000" });
      await waitFor(() => expect(apiGet).toHaveBeenCalled());
      await screen.findByText("home content");
      const callsBefore = (apiGet as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

      const header = within(screen.getByRole("banner"));
      await user.click(header.getByRole("button", { name: "USD ($)" }));

      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith("/api/v1/preferences/currency", { currency: "USD" }),
      );
      await waitFor(() =>
        expect((apiGet as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore),
      );
    });

    it("desktop Navbar: clicking IDR posts the preference too", async () => {
      const user = userEvent.setup();
      (apiPost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ currency: "IDR" });
      renderLayout({ currency: "USD", fx: "16000" });
      await waitFor(() => expect(apiGet).toHaveBeenCalled());
      await screen.findByText("home content");

      const header = within(screen.getByRole("banner"));
      await user.click(header.getByRole("button", { name: "IDR (Rp)" }));

      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith("/api/v1/preferences/currency", { currency: "IDR" }),
      );
    });

    // Task 5 fix pass (review Minor #2): a failed switch used to be silent.
    // It now surfaces an error toast, and the toggle stays on the currency
    // the server still holds — no optimistic flip, no context refetch.
    it("a failed switch shows an error toast and leaves the toggle on its prior currency", async () => {
      const user = userEvent.setup();
      (apiPost as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("/api/v1/preferences/currency responded 500"));
      renderLayout({ currency: "IDR", fx: "16000" });
      await waitFor(() => expect(apiGet).toHaveBeenCalled());
      await screen.findByText("home content");
      const callsBefore = (apiGet as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

      const header = within(screen.getByRole("banner"));
      await user.click(header.getByRole("button", { name: "USD ($)" }));

      expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
      expect(header.getByRole("button", { name: "IDR (Rp)" })).toHaveAttribute("aria-pressed", "true");
      expect(header.getByRole("button", { name: "USD ($)" })).toHaveAttribute("aria-pressed", "false");
      expect((apiGet as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    });

    // Follow-up fix: a null preference renders as "Rp + ≈$ hint", which is
    // not an explicit IDR choice — neither option may claim to be pressed.
    it.each([
      [null, "false", "false"],
      ["IDR", "true", "false"],
      ["USD", "false", "true"],
    ] as const)("currency %s: IDR pressed=%s, USD pressed=%s", async (currency, idrPressed, usdPressed) => {
      renderLayout({ currency, fx: "16000" });
      await waitFor(() => expect(apiGet).toHaveBeenCalled());
      await screen.findByText("home content");
      const header = within(screen.getByRole("banner"));
      expect(header.getByRole("button", { name: "IDR (Rp)" })).toHaveAttribute("aria-pressed", idrPressed);
      expect(header.getByRole("button", { name: "USD ($)" })).toHaveAttribute("aria-pressed", usdPressed);
    });

    it("disables the USD option (never hides it) when no exchange rate is set", async () => {
      renderLayout({ fx: null });
      await waitFor(() => expect(apiGet).toHaveBeenCalled());
      await screen.findByText("home content");
      const header = within(screen.getByRole("banner"));
      expect(header.getByRole("button", { name: "USD ($)" })).toBeDisabled();
      expect(header.getByRole("button", { name: "IDR (Rp)" })).not.toBeDisabled();
    });

    it("offers the same toggle as a row in the mobile drawer", async () => {
      const { drawer } = await openDrawer({ currency: "IDR", fx: "16000" });
      const row = within(drawer);
      expect(row.getByText("Currency")).toBeInTheDocument();
      expect(row.getByRole("button", { name: "USD ($)" })).toBeInTheDocument();
      expect(row.getByRole("button", { name: "IDR (Rp)" })).toBeInTheDocument();
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
