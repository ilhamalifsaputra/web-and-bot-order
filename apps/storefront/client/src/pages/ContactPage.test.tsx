import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ContactPage from "./ContactPage";
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
    bot_username: null,
    wa_number: null,
    tzname: "Asia/Jakarta",
    ...overrides,
  } as ShopContext;
}

function renderPage(ctx: ShopContext) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return ctx;
    throw new Error(`unexpected path ${path}`);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ContactPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ContactPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("shows every configured business row and channel", async () => {
    renderPage(
      context({
        business: {
          legal_name: "PT Contoh Digital",
          address: "Jl. Mawar 1",
          phone: "+62 811 222",
          email: "cs@contoh.id",
          hours: "09.00 - 21.00",
        },
        wa_number: "62811222",
        bot_username: "tokobot",
      }),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Contact us" })).toBeInTheDocument();
    expect(await screen.findByText("PT Contoh Digital")).toBeInTheDocument();
    expect(screen.getByText("Jl. Mawar 1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "+62 811 222" })).toHaveAttribute("href", "tel:+62811222");
    expect(screen.getByRole("link", { name: "cs@contoh.id" })).toHaveAttribute(
      "href",
      "mailto:cs@contoh.id",
    );
    expect(screen.getByText("09.00 - 21.00")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /WhatsApp/ })).toHaveAttribute(
      "href",
      "https://wa.me/62811222",
    );
    expect(screen.getByRole("link", { name: /Telegram/ })).toHaveAttribute(
      "href",
      "https://t.me/tokobot",
    );
    expect(screen.getByRole("link", { name: /Open a support ticket/ })).toHaveAttribute(
      "href",
      "/help",
    );
  });

  it("shows only the intro and help link when nothing is configured", async () => {
    renderPage(context());
    expect(await screen.findByRole("heading", { level: 1, name: "Contact us" })).toBeInTheDocument();
    expect(screen.getByText(/who runs this shop/)).toBeInTheDocument();
    expect(screen.queryByText("Business name")).not.toBeInTheDocument();
    expect(screen.queryByText("Address")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /WhatsApp/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open a support ticket/ })).toBeInTheDocument();
  });
});
