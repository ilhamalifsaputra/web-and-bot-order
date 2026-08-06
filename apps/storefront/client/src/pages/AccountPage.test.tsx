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

  it("renders the name, order count and both wallet balances", async () => {
    renderAccount();
    expect(await screen.findByRole("heading", { name: "My account" })).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    // Referral code and both wallet balances now also appear in the
    // (CSS-hidden below `lg`) desktop dashboard widgets, so each can match
    // twice in the DOM — assert presence rather than a single match.
    expect(screen.getAllByText("ALICE01").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Rp50.000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.5 USDT").length).toBeGreaterThan(0);
  });

  it("logout posts to /api/v1/auth/logout then assigns / on success", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { assign } });
    renderAccount();
    await screen.findByRole("heading", { name: "My account" });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: /Sign out/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/auth/logout", {}));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  it("renders the account-menu links", async () => {
    renderAccount();
    await screen.findByRole("heading", { name: "My account" });
    // Reviews/Settings/Support each appear twice now — once as a Quick
    // Actions shortcut, once in the grouped menu below — so assert at least
    // one accessible link per destination points at the right href, rather
    // than requiring exactly one match.
    const hasLinkTo = (name: RegExp, href: string) =>
      screen.getAllByRole("link", { name }).some((el) => el.getAttribute("href") === href);
    expect(hasLinkTo(/My orders/, "/account/orders")).toBe(true);
    expect(hasLinkTo(/My reviews/, "/account/reviews")).toBe(true);
    expect(hasLinkTo(/Help & support/, "/account/support")).toBe(true);
    expect(hasLinkTo(/Settings/, "/account/settings")).toBe(true);
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
      expect(screen.getByText(/you'll need your order code and email to get back in/)).toBeInTheDocument();
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
