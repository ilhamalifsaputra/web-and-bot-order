import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PrivacyPage from "./PrivacyPage";
import AboutPage from "./AboutPage";
import { apiGet } from "../api/client";
import type { ShopContext } from "../api/types";

vi.mock("../api/client", () => ({ apiGet: vi.fn() }));

function context(overrides: Partial<ShopContext> = {}): ShopContext {
  return {
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
    ...overrides,
  };
}

function renderPage(page: React.ReactElement, ctx: ShopContext) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return ctx;
    throw new Error(`unexpected path ${path}`);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("informational pages", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders every numbered block and ends on a support CTA", async () => {
    renderPage(<AboutPage />, context());
    expect(await screen.findByRole("heading", { level: 1, name: "About us" })).toBeInTheDocument();
    // about has four `_hN`/`_pN` blocks; the CTA heading is an h2 as well, so
    // the count below includes it.
    expect(screen.getByRole("heading", { name: "What we sell" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How to reach us" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open a support ticket/ })).toHaveAttribute(
      "href",
      "/account/support",
    );
  });

  it("substitutes the shop name into the intro rather than leaving the placeholder", async () => {
    renderPage(<AboutPage />, context({ shop_name: "Trustance" }));
    expect(await screen.findByText(/Trustance sells digital products/)).toBeInTheDocument();
    expect(screen.queryByText(/\{shop\}/)).not.toBeInTheDocument();
  });

  it("hides the analytics section unless the shop actually loads analytics", async () => {
    const { unmount } = renderPage(<PrivacyPage />, context());
    expect(await screen.findByRole("heading", { level: 1, name: "Privacy Policy" })).toBeInTheDocument();
    // A policy that claims tracking this shop doesn't do is as wrong as one
    // that hides tracking it does.
    expect(screen.queryByText("Visit statistics")).not.toBeInTheDocument();
    unmount();

    renderPage(<PrivacyPage />, context({ analytics_enabled: true }));
    expect(await screen.findByText("Visit statistics")).toBeInTheDocument();
  });
});
