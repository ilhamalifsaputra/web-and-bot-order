import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Price from "./Price";
import { apiGet } from "../../api/client";
import type { ShopContext } from "../../api/types";

// Price now reads the viewer's display-currency preference off the shared
// ["context"] query (Layout.tsx's useShopContext) itself — see lib/currency
// design note in the Task 5 report — rather than taking it as a prop. Every
// test therefore needs the same QueryClientProvider + mocked ../../api/client
// wrapper the page tests already use (see CartPage.test.tsx).
vi.mock("../../api/client", () => ({
  apiGet: vi.fn(),
}));

const baseContext: ShopContext = {
  lang: "en",
  fx: "16000",
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 0,
  customer: null,
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  wa_number: null,
  tzname: "Asia/Jakarta",
  currency: null,
};

function renderPrice(
  ctxOverrides: Partial<ShopContext>,
  props: Partial<React.ComponentProps<typeof Price>> = {},
) {
  const ctx: ShopContext = { ...baseContext, ...ctxOverrides };
  (apiGet as Mock).mockResolvedValue(ctx);
  // Price's own `fx` prop mirrors the same value the caller reads from ctx —
  // "fx" in ctxOverrides (not `??`) so an explicit `fx: null` override isn't
  // silently replaced by the "16000" default.
  const fx = "fx" in ctxOverrides ? ctxOverrides.fx : "16000";
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the ["context"] cache directly (same key Layout.tsx's useShopContext
  // uses) so the very first render already has `ctx`, instead of racing the
  // mocked apiGet's async resolution — findByText("Rp79.000") would otherwise
  // pass trivially on the pre-load default (currency undefined → null-like
  // behavior), masking a currency-specific assertion made right after it.
  queryClient.setQueryData(["context"], ctx);
  return render(
    <QueryClientProvider client={queryClient}>
      <Price value="79000" fx={fx} {...props} />
    </QueryClientProvider>,
  );
}

describe("Price", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("currency null + fx set: renders the IDR figure and the derived USDT hint (today's default)", async () => {
    renderPrice({ currency: null, fx: "16000" });
    expect(await screen.findByText("Rp79.000")).toBeInTheDocument();
    expect(screen.getByText("≈ $4.94")).toBeInTheDocument();
  });

  it("currency null + fx null: hides the USDT hint", async () => {
    renderPrice({ currency: null, fx: null });
    expect(await screen.findByText("Rp79.000")).toBeInTheDocument();
    expect(screen.queryByText(/≈ \$/)).not.toBeInTheDocument();
  });

  it('currency "IDR" + fx set: Rp figure only, no ≈ hint (IDR user → Rp only)', async () => {
    renderPrice({ currency: "IDR", fx: "16000" });
    expect(await screen.findByText("Rp79.000")).toBeInTheDocument();
    expect(screen.queryByText(/≈ \$/)).not.toBeInTheDocument();
  });

  it('currency "IDR" + fx null: still just Rp, no hint', async () => {
    renderPrice({ currency: "IDR", fx: null });
    expect(await screen.findByText("Rp79.000")).toBeInTheDocument();
    expect(screen.queryByText(/≈ \$/)).not.toBeInTheDocument();
  });

  it('currency "USD" + fx set: shows the converted $ figure as the primary, no hint', async () => {
    renderPrice({ currency: "USD", fx: "16000" });
    expect(await screen.findByText("$4.94")).toBeInTheDocument();
    expect(screen.queryByText(/≈ \$/)).not.toBeInTheDocument();
    expect(screen.queryByText("Rp79.000")).not.toBeInTheDocument();
  });

  it('currency "USD" + fx null: falls back to the IDR string — never a bare/invented $', async () => {
    renderPrice({ currency: "USD", fx: null });
    expect(await screen.findByText("Rp79.000")).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('uses text-pine for the figure by default, and text-white with tone="light" for on-dark surfaces', async () => {
    const ctx: ShopContext = { ...baseContext, currency: null, fx: "16000" };
    (apiGet as Mock).mockResolvedValue(ctx);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["context"], ctx);
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <Price value="79000" fx="16000" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Rp79.000")).toHaveClass("text-pine");
    expect(screen.getByText("≈ $4.94")).toHaveClass("text-ink-faint");

    rerender(
      <QueryClientProvider client={queryClient}>
        <Price value="79000" fx="16000" tone="light" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Rp79.000")).toHaveClass("text-white");
    expect(screen.getByText("Rp79.000")).not.toHaveClass("text-pine");
    expect(screen.getByText("≈ $4.94")).toHaveClass("text-white/70");
  });
});
