import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CartPage from "./CartPage";
import { apiGet, apiPost } from "../api/client";
import type { CartPageData, ShopContext } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const context: ShopContext = {
  lang: "en",
  fx: "16000",
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 4,
  customer: null,
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  tzname: "Asia/Jakarta",
};

const cartData: CartPageData = {
  items: [
    {
      key: 10,
      denomination_id: 1,
      product_slug: "netflix-premium",
      name: "Netflix Premium - 1 Month",
      image: "/img/netflix.jpg",
      unit_price: "79000",
      qty: 2,
      line_total: "158000",
      available: 5,
    },
  ],
  subtotal: "158000",
};

function renderCart(respond: (path: string) => unknown) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    return respond(path);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/cart"]}>
        <Routes>
          <Route path="/cart" element={<CartPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CartPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders lines + subtotal with the header cart count", async () => {
    renderCart(() => cartData);
    expect(await screen.findByRole("heading", { name: "Cart (4)" })).toBeInTheDocument();
    expect(screen.getByText("Netflix Premium - 1 Month")).toBeInTheDocument();
    expect(screen.getAllByText("Rp158.000").length).toBeGreaterThan(0);
  });

  it("editing qty then clicking update posts the new qty and re-renders from the response", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    const row = screen.getByText("Netflix Premium - 1 Month").closest("div.p-4") as HTMLElement;
    const qtyInput = within(row).getByLabelText("Quantity") as HTMLInputElement;
    expect(qtyInput.value).toBe("2");
    fireEvent.change(qtyInput, { target: { value: "3" } });
    expect(qtyInput.value).toBe("3");

    const updated: CartPageData = {
      items: [{ ...cartData.items[0]!, qty: 3, line_total: "237000" }],
      subtotal: "237000",
    };
    (apiPost as Mock).mockResolvedValue(updated);

    fireEvent.click(within(row).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/cart/update", { key: 10, qty: 3 }));
    expect(await screen.findAllByText("Rp237.000")).not.toHaveLength(0);
  });

  it("removing a line posts remove and empties the cart", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    (apiPost as Mock).mockResolvedValue({ items: [], subtotal: "0" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/cart/remove", { key: 10 }));
    expect(await screen.findByText("Your cart is empty — browse the products.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse products" })).toHaveAttribute("href", "/");
  });

  it("renders the empty-cart branch when the cart starts empty", async () => {
    renderCart(() => ({ items: [], subtotal: "0" }));
    expect(await screen.findByText("Your cart is empty — browse the products.")).toBeInTheDocument();
    expect(screen.queryByText("Summary")).not.toBeInTheDocument();
  });

  it("shows the login-to-checkout hint for a guest", async () => {
    renderCart(() => cartData);
    expect(await screen.findByText("You'll sign in with Telegram at checkout — your cart comes along.")).toBeInTheDocument();
  });
});
