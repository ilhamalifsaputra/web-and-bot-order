import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Layout from "./Layout";
import { apiGet } from "../api/client";
import type { ShopContext } from "../api/types";

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
            <Route index element={<div>home content</div>} />
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
});
