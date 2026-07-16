import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

function renderLayout() {
  const client = new QueryClient();
  (apiGet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(context);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<div>home content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
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
});
