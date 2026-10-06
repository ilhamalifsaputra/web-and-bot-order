import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AccountPage, { guestMenuGroups, type MenuGroup } from "./AccountPage";
import { apiGet, apiPost } from "../api/client";
import type { AccountData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const account: AccountData = {
  name: "Alice",
  order_count: 4,
  referral_code: "ALICE01",
  wallet_idr: "50000",
  wallet_usdt: "1.5",
};

function renderAccount(respond: () => unknown = () => account) {
  (apiGet as Mock).mockImplementation(async () => respond());
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/account" element={<AccountPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Guest checkout (Task 6): a guest has a real session, so they reach this
 * page — but no password, referral code, reviews or tickets sit behind it.
 * The marker rides on the context payload the page already fetches. */
function renderGuestAccount() {
  (apiGet as Mock).mockImplementation(async (path: string) =>
    path === "/api/v1/pages/context"
      ? { lang: "en", fx: null, customer: { username: null, email: null, telegram_linked: false }, is_guest: true }
      : { ...account, referral_code: "", wallet_idr: "0", wallet_usdt: "0" },
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/account" element={<AccountPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AccountPage", () => {
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    originalLocation = Object.getOwnPropertyDescriptor(window, "location");
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  });

  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, "location", originalLocation);
  });

  it("renders the name, order count and both wallet balances exactly once", async () => {
    renderAccount();
    expect(await screen.findByRole("heading", { name: "My account" })).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    // Task 11: the desktop-only "Ringkasan saldo" and Referral panels that
    // used to restate these values were removed, so each now renders exactly
    // once (in the summary grid) — getByText throws on more than one match.
    expect(screen.getByText("ALICE01")).toBeInTheDocument();
    expect(screen.getByText("Rp50,000")).toBeInTheDocument();
    expect(screen.getByText("1.5 USDT")).toBeInTheDocument();
  });

  // Task 16: the logout button now opens an AlertDialog first — it must not
  // touch the session until the shopper confirms. The full-reload-on-success
  // (window.location.assign("/")) is unchanged; it just now fires from the
  // dialog's confirm rather than the trigger's own onClick.
  describe("logout confirmation dialog", () => {
    it("clicking Sign out opens the dialog and does NOT post to /api/v1/auth/logout", async () => {
      renderAccount();
      await screen.findByRole("heading", { name: "My account" });
      (apiPost as Mock).mockResolvedValue({ ok: true });
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(screen.getByText("Sign out?")).toBeInTheDocument();
      expect(apiPost).not.toHaveBeenCalled();
    });

    it("confirming posts to /api/v1/auth/logout then assigns / on success", async () => {
      const assign = vi.fn();
      Object.defineProperty(window, "location", { configurable: true, writable: true, value: { assign } });
      renderAccount();
      await screen.findByRole("heading", { name: "My account" });
      (apiPost as Mock).mockResolvedValue({ ok: true });
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      fireEvent.click(await screen.findByRole("button", { name: "Yes, sign out" }));
      await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/auth/logout", {}));
      await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    });

    it("cancelling closes the dialog without posting to /api/v1/auth/logout", async () => {
      renderAccount();
      await screen.findByRole("heading", { name: "My account" });
      (apiPost as Mock).mockResolvedValue({ ok: true });
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(apiPost).not.toHaveBeenCalled();
    });
  });

  it("renders the account-menu links", async () => {
    renderAccount();
    await screen.findByRole("heading", { name: "My account" });
    // Orders is deliberately reachable two ways — the top summary card (which
    // also shows the order count) and the grouped-menu row — so keep the
    // tolerant "some" check for it. Task 11 removed the Quick Actions row,
    // which used to duplicate Reviews/Settings/Support against the same
    // grouped-menu rows, so those three now resolve to exactly one link each.
    const hasLinkTo = (name: RegExp, href: string) =>
      screen.getAllByRole("link", { name }).some((el) => el.getAttribute("href") === href);
    expect(hasLinkTo(/My orders/, "/account/orders")).toBe(true);
    expect(screen.getByRole("link", { name: /My reviews/ })).toHaveAttribute("href", "/account/reviews");
    expect(screen.getByRole("link", { name: /Help & support/ })).toHaveAttribute("href", "/account/support");
    expect(screen.getByRole("link", { name: /Settings/ })).toHaveAttribute("href", "/account/settings");
  });

  it("renders the referral summary card as a copy button alongside the grouped menu link", async () => {
    renderAccount();
    await screen.findByRole("heading", { name: "My account" });
    // The summary card is a button (tap-to-copy); the grouped menu below still
    // has its own "Referral" link to /account/referral — exactly one of each.
    expect(screen.getByRole("button", { name: /Referral/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Referral/ })).toHaveAttribute("href", "/account/referral");
  });

  it("copies the referral code and shows a confirmation toast when the referral card is tapped", async () => {
    renderAccount();
    await screen.findByRole("heading", { name: "My account" });
    fireEvent.click(screen.getByRole("button", { name: /Referral/ }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ALICE01");
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("groups the destinations into labelled navigation sections", async () => {
    renderAccount();
    await screen.findByRole("heading", { name: "My account" });
    const orders = screen.getByRole("navigation", { name: "Orders & purchases" });
    expect(within(orders).getByRole("link", { name: /My orders/ })).toBeInTheDocument();
    expect(within(orders).getByRole("link", { name: /My reviews/ })).toBeInTheDocument();
    const profile = screen.getByRole("navigation", { name: "Profile & security" });
    expect(within(profile).getByRole("link", { name: /Settings/ })).toBeInTheDocument();
    const help = screen.getByRole("navigation", { name: "Help & rewards" });
    expect(within(help).getByRole("link", { name: /Referral/ })).toBeInTheDocument();
    expect(within(help).getByRole("link", { name: /Help & support/ })).toBeInTheDocument();
  });

  it("derives the avatar initial from the name and keeps it out of the a11y tree", async () => {
    renderAccount();
    await screen.findByRole("heading", { name: "My account" });
    const avatar = screen.getByText("A");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
  });

  // A single-character name is the shortest thing the server accepts, and a
  // name that starts outside the BMP would be cut in half by `name[0]`.
  it("takes one whole glyph for the avatar of an emoji-led name", async () => {
    renderAccount(() => ({ ...account, name: "🐉 Dragon" }));
    await screen.findByRole("heading", { name: "My account" });
    expect(screen.getByText("🐉")).toBeInTheDocument();
  });

  // E2 (Task 6): this panel's empty state used to render title + action only,
  // while OrdersPage's "no orders yet" empty state also has a description —
  // same underlying state, two different renderings. `bare` still applies
  // (this panel already has its own card chrome) but the description now
  // matches OrdersPage's.
  describe("recent orders panel (desktop dashboard)", () => {
    // The panel only fetches/renders at the `lg` split; jsdom has no
    // matchMedia by default, so stub it to force the desktop arm.
    beforeEach(() => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("shows the no-orders description alongside the title in the empty recent-orders panel", async () => {
      (apiGet as Mock).mockImplementation(async (path: string) => {
        if (path === "/api/v1/account/orders") return { orders: [] };
        if (path === "/api/v1/pages/context") {
          return { lang: "en", fx: null, customer: { username: "alice", email: null, telegram_linked: false } };
        }
        return account;
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/account"]}>
            <Routes>
              <Route path="/account" element={<AccountPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await screen.findByRole("heading", { name: "My account" });
      expect(await screen.findByText("No orders yet — your purchases will show up here.")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Once you buy something it lands here, with its delivery status and your credentials.",
        ),
      ).toBeInTheDocument();
    });

    // Task 5 fix pass: a recent order's `total` is its OWN settlement amount in
    // its own `currency` — never re-converted through the viewer's display
    // preference (9.88 USDT pushed through IDR→USD would print "$0.01").
    it.each([["USD" as const], ["IDR" as const], [null]])(
      "shows each recent order's native total (viewer preference %s)",
      async (currency) => {
        (apiGet as Mock).mockImplementation(async (path: string) => {
          if (path === "/api/v1/account/orders") {
            return {
              orders: [
                { code: "ORD-USDT", status: "delivered", currency: "USDT", total: "9.88", created_at_display: "2026-07-01 10:00", items: "Netflix" },
                { code: "ORD-IDR", status: "delivered", currency: "IDR", total: "158000", created_at_display: "2026-07-02 09:00", items: "Spotify" },
              ],
            };
          }
          if (path === "/api/v1/pages/context") {
            return { lang: "en", fx: "16000", currency, customer: { username: "alice", email: null, telegram_linked: false } };
          }
          return account;
        });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={["/account"]}>
              <Routes>
                <Route path="/account" element={<AccountPage />} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>,
        );
        expect(await screen.findByText("9.88 USDT")).toBeInTheDocument();
        expect(screen.getByText("Rp158,000")).toBeInTheDocument();
        expect(screen.queryByText("$0.01")).not.toBeInTheDocument();
        expect(screen.queryByText("$9.88")).not.toBeInTheDocument();
        expect(screen.queryByText(/≈ \$/)).not.toBeInTheDocument();
      },
    );
  });

  describe("guest account", () => {
    it("shows a guest only their orders — no referral, reviews, tickets or settings", async () => {
      renderGuestAccount();
      await screen.findByRole("heading", { name: "My account" });

      // The summary tile and the menu row both point there — that's the point.
      const orderLinks = screen.getAllByRole("link", { name: /My orders/ });
      expect(orderLinks.length).toBeGreaterThan(0);
      for (const link of orderLinks) expect(link).toHaveAttribute("href", "/account/orders");
      for (const name of [/My reviews/, /Settings/, /Referral/, /Help & support/]) {
        expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
      }
      // The wallet and referral summary cards go too: a guest account has no
      // balance to spend and no referral code to share.
      expect(screen.queryByText("IDR credit balance")).not.toBeInTheDocument();
      expect(screen.queryByText("USDT credit balance")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Referral/ })).not.toBeInTheDocument();
    });

    it("keeps every destination for a registered customer (regression)", async () => {
      renderAccount();
      await screen.findByRole("heading", { name: "My account" });
      for (const name of [/My orders/, /My reviews/, /Settings/, /Referral/, /Help & support/]) {
        expect(screen.getAllByRole("link", { name }).length).toBeGreaterThan(0);
      }
    });

    // Signing out of a guest session is not the reversible thing it is for a
    // registered customer — there is no password to sign back in with.
    it("spells out what signing out costs a guest", async () => {
      renderGuestAccount();
      await screen.findByRole("heading", { name: "My account" });
      expect(screen.getByRole("button", { name: /Sign out/ })).toBeInTheDocument();
      expect(screen.getByText(/you'll need your order code to get back in/)).toBeInTheDocument();
    });

    // The guest menu used to be built by filtering MENU_GROUPS[0], which only
    // works while Orders happens to live in the first group. Moving it — a
    // plausible reshuffle of an account menu — would have left a guest with an
    // empty nav and no way to reach the one thing they have, silently.
    describe("guestMenuGroups is position-independent", () => {
      const item = (href: string) => ({ href, icon: (() => null) as never, labelKey: href, descriptionKey: href });

      it("finds the orders destination wherever its group sits", () => {
        const reshuffled: MenuGroup[] = [
          { headingKey: "web.account_group_help", items: [item("/account/support")] },
          { headingKey: "web.account_group_profile", items: [item("/account/settings")] },
          { headingKey: "web.account_group_orders", items: [item("/account/orders"), item("/account/reviews")] },
        ];
        const result = guestMenuGroups(reshuffled);
        expect(result.flatMap((g) => g.items.map((i) => i.href))).toEqual(["/account/orders"]);
        expect(result.map((g) => g.headingKey)).toEqual(["web.account_group_orders"]);
      });

      it("drops groups that keep nothing rather than rendering an empty heading", () => {
        const groups: MenuGroup[] = [
          { headingKey: "web.account_group_orders", items: [item("/account/orders")] },
          { headingKey: "web.account_group_help", items: [item("/account/support")] },
        ];
        expect(guestMenuGroups(groups)).toHaveLength(1);
      });
    });
  });
});
